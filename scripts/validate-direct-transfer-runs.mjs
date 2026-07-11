#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const COUNT_KEYS = [
  'scheduled', 'verified', 'retries', 'timeouts', 'rejects', 'sendFailures',
  'invalidChunks', 'cancellations', 'watermarkHigh', 'watermarkLow',
  'storageWrites', 'resumeValidations', 'resumeFailures', 'integrityFailures',
  'framingFailures', 'lifecycleLeaks'
];
const OUTCOMES = new Set(['succeeded', 'failed', 'cancelled']);
const PATHS = new Set(['direct-host', 'direct-srflx', 'relay-udp', 'relay-tcp', 'relay-tls', 'unknown', 'unavailable']);
const TERMINAL_REASONS = new Set(['verified', 'acknowledged', 'send_failed', 'request_timeout', 'cancelled', 'provider_reject', 'hash_mismatch', 'invalid_chunk']);
const CONTROLLER_STATES = new Set(['idle', 'starting', 'running', 'succeeded', 'failed', 'cancelled']);
const LIFECYCLE_PHASES = new Set(['send', 'receive', 'storage', 'persist', 'finalize']);
const LIFECYCLE_STATUSES = new Set(['flush_started', 'flush_completed', 'dispose_completed']);
const SYMBOLIC_CODE = /^[a-z][a-z0-9:_-]{0,79}$/;
const IDS = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const args = parseArgs(process.argv.slice(2));
const runsDir = resolve(args.runs ?? args['runs-dir'] ?? 'qa/direct-transfer/runs');
const manifestPath = resolve(args.manifest ?? 'qa/direct-transfer/run-manifest.v1.json');
const result = await main(runsDir, manifestPath);
const text = `${JSON.stringify(stable(result), null, 2)}\n`;
if (args.out) {
  await mkdir(resolve(args.out, '..'), { recursive: true });
  await writeFile(resolve(args.out), text);
}
process.stdout.write(text);
process.exitCode = result.verdict === 'PASS' ? 0 : 2;

async function main(directory, manifestPathname) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPathname, 'utf8'));
  } catch (error) {
    return hold(`manifest unavailable: ${error.message}`);
  }

  validateManifest(manifest, errors);
  const files = await jsonFiles(directory);
  if (!files.length) errors.push('run directory contains no run JSON files');

  const runs = [];
  for (const file of files) {
    let run;
    try {
      run = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      errors.push(`${file}: invalid JSON`);
      continue;
    }
    const checked = checkRun(run, manifest, file);
    errors.push(...checked.errors);
    if (checked.ok) runs.push(run);
  }

  const seenRunIds = new Set();
  for (const run of runs) {
    if (seenRunIds.has(run.runId)) errors.push(`duplicate runId ${run.runId}`);
    seenRunIds.add(run.runId);
  }
  validateRunCompleteness(runs, manifest, errors);


  return {
    schema: 'ponswarp-grid.direct-transfer-validation/v2',
    kind: 'direct-transfer-validation',
    verdict: errors.length ? 'HOLD' : 'PASS',
    provenance: {
      suiteId: manifest.suiteId,
      buildSha: manifest.buildSha,
      fixture: manifest.fixture
    },
    errors: [...new Set(errors)].sort(),
    runCount: runs.length,
    runs: runs.sort((left, right) => left.runId.localeCompare(right.runId))
  };
}

function validateManifest(manifest, errors) {
  if (!isObject(manifest)) {
    errors.push('invalid manifest');
    return;
  }
  exact(manifest, ['schema', 'suiteId', 'fixture', 'buildSha', 'windowPolicy', 'requiredStrata', 'pairs'], 'manifest', errors);
  if (manifest.schema !== 'ponswarp-grid.direct-transfer-run-manifest/v1'
    || !IDS.test(manifest.suiteId)
    || !IDS.test(manifest.buildSha)) errors.push('invalid manifest identity');

  exact(manifest.fixture, ['fixtureId', 'fixtureSha256', 'fileBytes', 'pieceBytes', 'pieceCount', 'hashMode'], 'manifest.fixture', errors);
  if (!IDS.test(manifest.fixture?.fixtureId)
    || !SHA256.test(manifest.fixture?.fixtureSha256)
    || !safe(manifest.fixture?.fileBytes)
    || !safe(manifest.fixture?.pieceBytes)
    || !safe(manifest.fixture?.pieceCount)
    || manifest.fixture?.hashMode !== 'sha256') errors.push('invalid manifest fixture');

  exact(manifest.windowPolicy, ['allowed', 'default', 'maxInFlight', 'controllerTimeoutMs'], 'manifest.windowPolicy', errors);
  exact(manifest.windowPolicy?.maxInFlight, ['1', '2'], 'manifest.windowPolicy.maxInFlight', errors);
  if (JSON.stringify(manifest.windowPolicy?.allowed) !== '[1,2]'
    || manifest.windowPolicy?.default !== 1
    || manifest.windowPolicy?.maxInFlight?.['1'] !== 1
    || manifest.windowPolicy?.maxInFlight?.['2'] !== 2
    || manifest.windowPolicy?.controllerTimeoutMs !== 300000) errors.push('invalid manifest window policy');

  if (!Array.isArray(manifest.requiredStrata) || !Array.isArray(manifest.pairs)) {
    errors.push('invalid manifest strata/pairs');
    return;
  }
  const strata = new Map();
  for (const stratum of manifest.requiredStrata) {
    exact(stratum, ['stratum', 'available', 'paths'], 'manifest.requiredStrata', errors);
    if (!IDS.test(stratum?.stratum)
      || typeof stratum?.available !== 'boolean'
      || !Array.isArray(stratum?.paths)
      || stratum.paths.length === 0
      || stratum.paths.some(path => !PATHS.has(path))) errors.push(`invalid stratum ${stratum?.stratum ?? 'unknown'}`);
    if (strata.has(stratum?.stratum)) errors.push(`duplicate stratum ${stratum?.stratum}`);
    strata.set(stratum?.stratum, stratum);
  }

  const pairIds = new Set();
  const runIds = new Set();
  const attemptsByStratum = new Map();
  for (const pair of manifest.pairs) {
    exact(pair, ['pairId', 'stratum', 'attempt', 'browserFamilyMajor', 'storageKind', 'path', 'runs'], 'manifest.pairs', errors);
    exact(pair?.runs, ['1', '2'], `manifest.pairs.${pair?.pairId}.runs`, errors);
    const stratum = strata.get(pair?.stratum);
    if (!IDS.test(pair?.pairId)
      || !stratum
      || !Number.isSafeInteger(pair?.attempt)
      || pair.attempt < 1
      || pair.attempt > 10
      || !IDS.test(pair?.browserFamilyMajor)
      || !IDS.test(pair?.storageKind)
      || !stratum?.paths?.includes(pair?.path)
      || !IDS.test(pair?.runs?.['1'])
      || !IDS.test(pair?.runs?.['2'])) errors.push(`invalid pair ${pair?.pairId ?? 'unknown'}`);
    if (pairIds.has(pair?.pairId)) errors.push(`duplicate pair ${pair?.pairId}`);
    pairIds.add(pair?.pairId);
    const attempts = attemptsByStratum.get(pair?.stratum) ?? new Set();
    if (attempts.has(pair?.attempt)) errors.push(`duplicate attempt ${pair?.attempt} in ${pair?.stratum}`);
    attempts.add(pair?.attempt);
    attemptsByStratum.set(pair?.stratum, attempts);
    for (const runId of [pair?.runs?.['1'], pair?.runs?.['2']]) {
      if (runIds.has(runId)) errors.push(`duplicate manifest runId ${runId}`);
      runIds.add(runId);
    }
  }
  for (const stratum of strata.keys()) {
    const attempts = [...(attemptsByStratum.get(stratum) ?? [])].sort((left, right) => left - right);
    if (JSON.stringify(attempts) !== '[1,2,3,4,5,6,7,8,9,10]') {
      errors.push(`stratum ${stratum} requires unique attempts 1 through 10`);
    }
  }
}

function validateRunCompleteness(runs, manifest, errors) {
  const availableStrata = new Set(
    (manifest?.requiredStrata ?? [])
      .filter(stratum => stratum?.available === true)
      .map(stratum => stratum.stratum)
  );
  for (const pair of manifest?.pairs ?? []) {
    if (!availableStrata.has(pair.stratum)) continue;
    if (!Number.isSafeInteger(pair.attempt) || pair.attempt < 1 || pair.attempt > 10) {
      errors.push(`invalid attempt for pair ${pair.pairId}`);
      continue;
    }
    for (const window of [1, 2]) {
      const matches = runs.filter(run =>
        run.pairId === pair.pairId
        && run.window === window
        && run.attempt === pair.attempt
      );
      if (matches.length !== 1) {
        errors.push(`pair ${pair.pairId} window ${window} requires exactly one run`);
      }
    }
  }
}

async function jsonFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(directory, entry.name)).sort();
  } catch {
    return [];
  }
}

function checkRun(run, manifest, file) {
  const errors = [];
  const requiredFields = [
    'schema', 'runId', 'suiteId', 'fixtureId', 'fixtureSha256', 'pairId', 'stratum',
    'attempt', 'buildSha', 'window', 'startedAtMs', 'endedAtMs', 'outcome',
    'environment', 'path', 'transfer', 'counts', 'events'
  ];
  if (!isObject(run)) {
    errors.push(`${file}: object required`);
    return { ok: false, errors };
  }
  exact(run, requiredFields, file, errors);
  if (run.schema !== 'ponswarp-grid.direct-transfer-run/v2') {
    errors.push(`${file}: invalid schema`);
  }
  if (
    !IDS.test(run.runId ?? '') || run.suiteId !== manifest?.suiteId ||
    run.fixtureId !== manifest?.fixture?.fixtureId ||
    run.fixtureSha256 !== manifest?.fixture?.fixtureSha256 || run.buildSha !== manifest?.buildSha
  ) {
    errors.push(`${file}: provenance mismatch`);
  }
  if (
    !Number.isSafeInteger(run.attempt) || run.attempt < 1 || run.attempt > 10 ||
    ![1, 2].includes(run.window) || !Number.isSafeInteger(run.startedAtMs) ||
    !Number.isSafeInteger(run.endedAtMs) || run.endedAtMs < run.startedAtMs
  ) {
    errors.push(`${file}: invalid timing/attempt/window`);
  }
  if (!OUTCOMES.has(run.outcome) || !PATHS.has(run.path)) {
    errors.push(`${file}: invalid outcome/path`);
  }
  exact(run.environment, ['browserFamilyMajor', 'storageKind'], `${file}.environment`, errors);
  exact(run.transfer, ['fileBytes', 'pieceBytes', 'pieceCount', 'hashMode'], `${file}.transfer`, errors);
  if (
    !safe(run.transfer?.fileBytes)
    || !safe(run.transfer?.pieceBytes)
    || !safe(run.transfer?.pieceCount)
    || run.transfer?.hashMode !== 'sha256'
    || run.transfer?.fileBytes !== manifest?.fixture?.fileBytes
    || run.transfer?.pieceBytes !== manifest?.fixture?.pieceBytes
    || run.transfer?.pieceCount !== manifest?.fixture?.pieceCount
    || run.transfer?.hashMode !== manifest?.fixture?.hashMode
  ) {
    errors.push(`${file}: invalid transfer/provenance`);
  }

  const pair = (manifest?.pairs ?? []).find(item => item.pairId === run.pairId);
  if (
    !pair || pair.stratum !== run.stratum ||
    pair.browserFamilyMajor !== run.environment?.browserFamilyMajor ||
    pair.storageKind !== run.environment?.storageKind || pair.path !== run.path ||
    run.runId !== pair.runs?.[run.window] ||
    run.attempt !== pair.attempt
  ) {
    errors.push(`${file}: pair/provenance mismatch`);
  }

  const counts = derive(run.events, errors, file, run, manifest.windowPolicy?.maxInFlight?.[String(run.window)]);
  validateCounts(run.counts, counts, file, errors);
  if (run.outcome === 'succeeded'
    && (counts.verified !== run.transfer.pieceCount
      || counts.resumeValidations < 1
      || counts.resumeFailures > 0)) {
    errors.push(`${file}: successful outcome requires all pieces verified and passed resume validation`);
  }
  privacy(run, file, errors);
  return { ok: errors.length === 0, errors };
}

function validateCounts(counts, derived, file, errors) {
  if (!isObject(counts)) {
    errors.push(`${file}: counts required`);
    return;
  }
  exact(counts, COUNT_KEYS, `${file}.counts`, errors);
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) {
      errors.push(`${file}: invalid count ${key}`);
    }
  }
  if (JSON.stringify(derived) !== JSON.stringify(counts)) {
    errors.push(`${file}: counts do not recompute`);
  }
}

function derive(events, errors, file, run, windowCap) {
  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  if (!Array.isArray(events)) {
    errors.push(`${file}: events must be array`);
    return counts;
  }
  let disposeCount = 0;
  let lastController;
  let previousSequence = 0;
  for (const [index, event] of events.entries()) {
    const path = `${file}.events[${index}]`;
    if (!isObject(event)) {
      errors.push(`${path}: object required`);
      continue;
    }
    if (event.seq !== ++previousSequence
      || !Number.isSafeInteger(event.atMs)
      || event.atMs < run.startedAtMs
      || event.atMs > run.endedAtMs) {
      errors.push(`${path}: sequence/timestamp invalid`);
    }
    deriveEvent(event, path, counts, errors, state => { lastController = state; }, () => { disposeCount++; }, windowCap);
  }
  if (disposeCount === 0) errors.push(`${file}: dispose event missing`);
  if (disposeCount > 1) errors.push(`${file}: duplicate dispose event`);
  const disposeEvent = events.find(event => isObject(event) && event.type === 'lifecycle' && event.status === 'dispose_completed');
  if (disposeCount === 1 && events.at(-1) !== disposeEvent) {
    errors.push(`${file}: dispose must be final`);
  }
  if (disposeCount === 1 && (disposeEvent.outstandingDirect !== 0 || disposeEvent.activeTimers !== 0)) {
    errors.push(`${file}: dispose must have zero outstanding work`);
  }
  if (lastController !== run.outcome) {
    errors.push(`${file}: outcome must match final controller state`);
  }
  return counts;
}

function deriveEvent(event, path, counts, errors, setController, dispose, windowCap) {
  if (event.type === 'controller') {
    exact(event, ['seq', 'atMs', 'type', 'state'], path, errors);
    setController(event.state);
    if (!CONTROLLER_STATES.has(event.state)) errors.push(`${path}: invalid controller state`);
  } else if (event.type === 'scheduled') {
    exact(event, ['seq', 'atMs', 'type', 'requested', 'outstandingAfter'], path, errors);
    if (!safe(event.requested) || !safe(event.outstandingAfter)) errors.push(`${path}: invalid scheduled values`);
    if (safe(event.requested)) counts.scheduled += event.requested;
    if (safe(event.outstandingAfter) && event.outstandingAfter > windowCap) errors.push(`${path}: window cap exceeded`);
  } else if (event.type === 'terminal') {
    exact(event, ['seq', 'atMs', 'type', 'reason', 'retryCount', 'willRetry'], path, errors);
    if (!TERMINAL_REASONS.has(event.reason)) errors.push(`${path}: invalid terminal reason`);
    if (!safe(event.retryCount) || typeof event.willRetry !== 'boolean') errors.push(`${path}: invalid terminal values`);
    if (event.reason === 'verified') counts.verified++;
    if (event.willRetry) counts.retries++;
    if (event.reason === 'request_timeout') counts.timeouts++;
    if (event.reason === 'provider_reject') counts.rejects++;
    if (event.reason === 'send_failed') counts.sendFailures++;
    if (event.reason === 'invalid_chunk') counts.invalidChunks++;
    if (event.reason === 'cancelled') counts.cancellations++;
    if (event.reason === 'hash_mismatch') counts.integrityFailures++;
  } else if (event.type === 'window_exhausted') {
    exact(event, ['seq', 'atMs', 'type'], path, errors);
  } else if (event.type === 'watermark') {
    exact(event, ['seq', 'atMs', 'type', 'level', 'bufferedAmount', 'highWaterMark', 'lowWaterMark'], path, errors);
    if (!['high', 'low'].includes(event.level)
      || !safe(event.bufferedAmount)
      || !safe(event.highWaterMark)
      || !safe(event.lowWaterMark)) errors.push(`${path}: invalid watermark values`);
    if (event.level === 'high') counts.watermarkHigh++;
    if (event.level === 'low') counts.watermarkLow++;
  } else if (event.type === 'storage_write') {
    exact(event, ['seq', 'atMs', 'type', 'bytes'], path, errors);
    if (!safe(event.bytes)) errors.push(`${path}: invalid storage bytes`);
    counts.storageWrites++;
  } else if (event.type === 'resume_validation') {
    exact(event, ['seq', 'atMs', 'type', 'verifiedPieces', 'discardedPieces', 'status'], path, errors);
    if (!safe(event.verifiedPieces)
      || !safe(event.discardedPieces)
      || !['passed', 'failed'].includes(event.status)) errors.push(`${path}: invalid resume validation`);
    counts.resumeValidations++;
    if (event.status === 'failed') counts.resumeFailures++;
  } else if (event.type === 'lifecycle') {
    exact(event, ['seq', 'atMs', 'type', 'status', 'outstandingDirect', 'activeTimers'], path, errors);
    if (!LIFECYCLE_STATUSES.has(event.status)
      || !safe(event.outstandingDirect)
      || !safe(event.activeTimers)) errors.push(`${path}: invalid lifecycle event`);
    if (event.status === 'dispose_completed') {
      dispose();
      if (event.outstandingDirect !== 0 || event.activeTimers !== 0) counts.lifecycleLeaks++;
    }
  } else if (event.type === 'direct_lifecycle_error') {
    exact(event, ['seq', 'atMs', 'type', 'phase', 'code'], path, errors);
    if (!LIFECYCLE_PHASES.has(event.phase) || !SYMBOLIC_CODE.test(event.code)) {
      errors.push(`${path}: invalid lifecycle error`);
    }
    counts.lifecycleLeaks++;
    if (event.phase === 'receive') counts.framingFailures++;
    if (event.phase === 'storage' || event.phase === 'persist') counts.integrityFailures++;
  } else {
    errors.push(`${path}: unknown event type`);
  }
}

function privacy(value, path, errors) {
  if (typeof value === 'string') {
    if (value.length > 128
      || /(?:https?|wss?):\/\/|(?:\d{1,3}\.){3}\d{1,3}|(?:^|[\s=])(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]*|-----BEGIN|bearer\s|(?:token|secret|password|credential)\s*[:=]/i.test(value)) {
      errors.push(`${path}: privacy value`);
    }
    return;
  }
  if (!isObject(value) && !Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|credential|ip|address|peer|request|session|filename|mime|url|candidate|signaling|error|hash/i.test(key) && key !== 'fixtureSha256' && key !== 'hashMode') {
      errors.push(`${path}: privacy field ${key}`);
    }
    privacy(child, `${path}.${key}`, errors);
  }
}

function exact(value, keys, path, errors) {
  if (!isObject(value)) return;
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}: unexpected field ${key}`);
  for (const key of keys) if (!(key in value)) errors.push(`${path}: missing field ${key}`);
}

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function safe(value) { return Number.isSafeInteger(value) && value >= 0; }
function hold(reason, errors = []) {
  return { schema: 'ponswarp-grid.direct-transfer-validation/v2', kind: 'direct-transfer-validation', verdict: 'HOLD', errors: [reason, ...errors].sort(), runCount: 0, runs: [] };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    if (!values[index].startsWith('--')) continue;
    const key = values[index].slice(2);
    result[key] = values[index + 1]?.startsWith('--') ? true : values[index + 1] ?? true;
    if (result[key] !== true) index++;
  }
  return result;
}
