#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const validation = await readJson(resolve(args.validation ?? args.input ?? 'qa/direct-transfer/validation.json'), {
  verdict: 'HOLD', errors: []
});
const manifest = await readJson(resolve(args.manifest ?? 'qa/direct-transfer/run-manifest.v1.json'), null);
const approval = args.approval ? await readJson(resolve(args.approval), null) : null;
const strictValidation = verifyStrictValidation(args, validation, manifest);
const result = validation.verdict !== 'PASS'
  ? hold(`validation verdict is ${validation.verdict ?? 'unknown'}`, validation.errors)
  : args.strict !== true
    ? aggregate(validation.runs, manifest, approval, false)
    : !strictValidation.ok
      ? hold(strictValidation.error)
      : aggregate(validation.runs, manifest, approval, true);
const text = `${JSON.stringify(stable(result), null, 2)}\n`;
if (args.out) {
  await mkdir(resolve(args.out, '..'), { recursive: true });
  await writeFile(resolve(args.out), text);
}
if (args['markdown-out']) {
  await mkdir(resolve(args['markdown-out'], '..'), { recursive: true });
  await writeFile(resolve(args['markdown-out']), markdown(result));
}
process.stdout.write(text);
process.exitCode = result.gate === 'ENABLE' ? 0 : 2;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (fallback && fallback.verdict === 'HOLD') {
      return { ...fallback, errors: [`validation unavailable: ${error.message}`] };
    }
    return fallback;
  }
}

function verifyStrictValidation(args, validation, manifest) {
  if (args.strict !== true) return { ok: false, error: '--strict is required for ENABLE' };
  if (!args.manifest || !args.runs || !args.validation) {
    return { ok: false, error: 'strict aggregation requires --manifest, --runs, and --validation' };
  }
  if (validation.schema !== 'ponswarp-grid.direct-transfer-validation/v2'
    || validation.kind !== 'direct-transfer-validation'
    || validation.provenance?.suiteId !== manifest?.suiteId
    || validation.provenance?.buildSha !== manifest?.buildSha
    || JSON.stringify(stable(validation.provenance?.fixture)) !== JSON.stringify(stable(manifest?.fixture))) {
    return { ok: false, error: 'validation provenance does not match manifest' };
  }
  const replay = spawnSync(process.execPath, [
    resolve('scripts/validate-direct-transfer-runs.mjs'),
    '--manifest', resolve(args.manifest),
    '--runs', resolve(args.runs)
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (replay.status !== 0) return { ok: false, error: 'strict raw-run revalidation failed' };
  try {
    const replayed = JSON.parse(replay.stdout);
    if (JSON.stringify(stable(replayed)) !== JSON.stringify(stable(validation))) {
      return { ok: false, error: 'validation artifact is stale or altered' };
    }
  } catch {
    return { ok: false, error: 'strict raw-run revalidation output is invalid' };
  }
  return { ok: true };
}

function aggregate(runs, manifest, approval, strictValidation) {
  if (!manifest || !Array.isArray(runs) || !runs.length) return hold('manifest or validated runs unavailable');
  if (!runs.every(run => isValidatedRun(run))) return hold('validated runs malformed');

  const unavailable = (manifest.requiredStrata ?? []).filter(stratum => !stratum.available);
  const approved = approvedUnavailableStrata(approval, manifest.suiteId);
  const unavailableUnapproved = unavailable.filter(stratum => !approved.has(stratum.stratum));
  const available = (manifest.requiredStrata ?? []).filter(stratum => stratum.available);
  const rows = runs.map(addDerivedMetrics);
  const groups = buildGroups(rows, available, manifest.pairs ?? []);
  const complete = groups.every(group => group.complete);
  const clean = rows.every(row =>
    row.counts.integrityFailures === 0
    && row.counts.resumeFailures === 0
    && row.counts.framingFailures === 0
    && row.counts.lifecycleLeaks === 0
  );
  const goodputDeltas = groups.map(group => group.deltas.medianGoodputBps);
  const gates = {
    strictValidation,
    complete,
    availableExternalRelay: available.some(stratum => stratum.paths?.some(path => path === 'direct-host' || path === 'direct-srflx'))
      && available.some(stratum => stratum.paths?.some(path => path === 'relay-udp' || path === 'relay-tcp' || path === 'relay-tls')),
    clean,
    completion: groups.length > 0 && groups.every(group =>
      group.deltas.completionBps !== null && group.deltas.completionBps >= -200
    ),
    reliability: groups.length > 0 && groups.every(group =>
      group.deltas.reliabilityBps !== null && group.deltas.reliabilityBps <= 1000
    ),
    goodput: goodputDeltas.every(delta => delta !== null && delta >= -500)
      && goodputDeltas.filter(delta => delta !== null && delta >= 500).length >= 2,
    unavailableApproved: unavailableUnapproved.length === 0
  };
  const successful = rows.filter(row => row.outcome === 'succeeded').length;
  const attempts = rows.length;
  return {
    schema: 'ponswarp-grid.direct-transfer-aggregation/v2',
    localOnly: true,
    gate: Object.values(gates).every(Boolean) ? 'ENABLE' : 'HOLD',
    gates,
    errors: unavailableUnapproved.map(stratum => `unavailable stratum not approved: ${stratum.stratum}`),
    summary: {
      attempts,
      successes: successful,
      completionBps: attempts ? Math.floor(successful * 10000 / attempts) : null,
      reliabilityBps: attempts ? Math.floor((attempts - successful) * 10000 / attempts) : null,
      unavailableStrata: unavailable.map(stratum => stratum.stratum),
      goodputDeltaBps: goodputDeltas
    },
    groups
  };
}

function isValidatedRun(run) {
  return run
    && typeof run === 'object'
    && Number.isSafeInteger(run.startedAtMs)
    && Number.isSafeInteger(run.endedAtMs)
    && run.endedAtMs >= run.startedAtMs
    && run.transfer
    && Number.isSafeInteger(run.transfer.fileBytes)
    && run.transfer.fileBytes >= 0
    && run.counts
    && typeof run.counts === 'object'
    && typeof run.outcome === 'string'
    && typeof run.stratum === 'string'
    && Number.isSafeInteger(run.window)
    && typeof run.pairId === 'string';
}

function approvedUnavailableStrata(approval, suiteId) {
  if (!approval
    || !hasExactKeys(approval, ['schema', 'suiteId', 'entries'])
    || approval.schema !== 'ponswarp-grid.unavailable-approval/v1'
    || approval.suiteId !== suiteId
    || !Array.isArray(approval.entries)) return new Set();
  const approved = new Set();
  for (const entry of approval.entries) {
    if (!hasExactKeys(entry, ['stratum', 'approved', 'approverRole', 'approvedAt', 'expiresAt', 'reason', 'impact', 'rollbackCondition'])
      || entry.approved !== true
      || typeof entry.stratum !== 'string'
      || typeof entry.approverRole !== 'string'
      || entry.approverRole.length === 0
      || typeof entry.approvedAt !== 'string'
      || Number.isNaN(Date.parse(entry.approvedAt))
      || Date.parse(entry.approvedAt) > Date.now()
      || typeof entry.expiresAt !== 'string'
      || Number.isNaN(Date.parse(entry.expiresAt))
      || Date.parse(entry.expiresAt) <= Date.now()
      || Date.parse(entry.expiresAt) <= Date.parse(entry.approvedAt)
      || typeof entry.reason !== 'string'
      || entry.reason.length === 0
      || typeof entry.impact !== 'string'
      || entry.impact.length === 0
      || typeof entry.rollbackCondition !== 'string'
      || entry.rollbackCondition.length === 0) continue;
    approved.add(entry.stratum);
  }
  return approved;
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function addDerivedMetrics(run) {
  const elapsed = Math.max(0, run.endedAtMs - run.startedAtMs);
  return {
    ...run,
    goodputBps: run.outcome === 'succeeded' && elapsed > 0
      ? Math.floor(run.transfer.fileBytes * 1000 / elapsed)
      : null,
    elapsedMs: elapsed
  };
}

function buildGroups(rows, strata, pairs) {
  return [...strata]
    .sort((left, right) => left.stratum.localeCompare(right.stratum))
    .map(stratum => {
      const expectedPairs = pairs.filter(pair => pair.stratum === stratum.stratum);
      const baselineRows = rows.filter(row => row.stratum === stratum.stratum && row.window === 1);
      const candidateRows = rows.filter(row => row.stratum === stratum.stratum && row.window === 2);
      const baseline = stats(baselineRows);
      const candidate = stats(candidateRows);
      const complete = expectedPairs.length === 10
        && hasExpectedPairs(baselineRows, expectedPairs, 1)
        && hasExpectedPairs(candidateRows, expectedPairs, 2);
      return {
        stratum: stratum.stratum,
        complete,
        baseline,
        candidate,
        deltas: {
          completionBps: difference(candidate.completionBps, baseline.completionBps),
          reliabilityBps: difference(candidate.reliabilityBps, baseline.reliabilityBps),
          medianGoodputBps: relative(candidate.medianGoodputBps, baseline.medianGoodputBps)
        }
      };
    });
}

function hasExpectedPairs(rows, expectedPairs, window) {
  return rows.length === expectedPairs.length
    && expectedPairs.every(pair => rows.some(run =>
      run.pairId === pair.pairId
      && run.attempt === pair.attempt
      && run.runId === pair.runs?.[window]
    ));
}

function stats(rows) {
  const values = rows.filter(row => row.goodputBps !== null).map(row => row.goodputBps);
  const successes = rows.filter(row => row.outcome === 'succeeded').length;
  const failures = rows.length - successes;
  return {
    attempts: rows.length,
    successes,
    completionBps: rows.length ? Math.floor(successes * 10000 / rows.length) : null,
    reliabilityBps: rows.length ? Math.floor(failures * 10000 / rows.length) : null,
    medianGoodputBps: median(values),
    p25GoodputBps: rank(values, 0.25),
    p75GoodputBps: rank(values, 0.75),
    iqrGoodputBps: values.length ? rank(values, 0.75) - rank(values, 0.25) : null
  };
}

function rank(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] : null;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
}

function difference(candidate, baseline) {
  return candidate === null || baseline === null ? null : candidate - baseline;
}

function relative(candidate, baseline) {
  if (!Number.isSafeInteger(candidate) || candidate < 0 || !Number.isSafeInteger(baseline) || baseline < 0) return null;
  if (baseline === 0) return candidate === 0 ? null : 10000;
  const numerator = (candidate - baseline) * 10000;
  if (!Number.isSafeInteger(numerator)) return null;
  return Math.floor(numerator / baseline);
}
function hold(reason, errors = []) {
  return {
    schema: 'ponswarp-grid.direct-transfer-aggregation/v2', localOnly: true, gate: 'HOLD',
    gates: { strictValidation: false, complete: false, availableExternalRelay: false, clean: false, completion: false, reliability: false, goodput: false, unavailableApproved: false },
    errors: [reason, ...errors].sort(), groups: []
  };
}
function markdown(result) {
  return `# Direct-transfer evidence\n\nGate: **${result.gate}**\n\n${(result.errors ?? []).map(error => `- ${error}`).join('\n')}\n`;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
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
