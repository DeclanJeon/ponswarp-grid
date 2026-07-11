#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_OUT = 'artifacts/g006-cross-network-matrix-report.json';

function parseArgs(argv) {
  const args = { artifactsDir: 'artifacts', out: DEFAULT_OUT, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    const value = argv[index + 1];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--artifacts-dir') { args.artifactsDir = required(flag, value); index += 1; }
    else if (flag === '--out') { args.out = required(flag, value); index += 1; }
    else if (flag === '--strict') args.strict = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function required(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function usage() {
  return `Usage: node scripts/network-matrix-qa.mjs [--artifacts-dir artifacts] [--out artifacts/g006-cross-network-matrix-report.json] [--strict]\n\nBuilds a machine-readable cross-network evidence matrix from existing QA artifacts. Non-strict mode records missing external-network evidence without failing CI; --strict fails unless every required real-network scenario has PASS evidence.`;
}

const SCENARIOS = [
  {
    id: 'NET-001',
    name: 'LAN direct CLI transfer',
    required: true,
    networkMeasured: true,
    topology: 'same-lan-direct',
    detector: detectLanDirect,
    requiredFields: ['topology', 'throughputBps', 'hashVerified']
  },
  {
    id: 'NET-002',
    name: 'NAT / split-network browser transfer',
    required: true,
    networkMeasured: true,
    topology: 'nat-or-split-network-direct',
    detector: detectNatSplitNetwork,
    requiredFields: ['topology', 'selectedPair', 'transferComplete', 'rttMs', 'payloadGoodputBps', 'runtimeWindow', 'terminalIntegrity', 'disposalEvidence']
  },
  {
    id: 'NET-003',
    name: 'LTE/5G mobile browser transfer',
    required: true,
    networkMeasured: true,
    topology: 'mobile-lte-5g',
    detector: detectMobileNetwork,
    requiredFields: ['deviceLabels', 'networkLabels', 'transferComplete', 'selectedPair', 'rttMs', 'payloadGoodputBps', 'runtimeWindow', 'terminalIntegrity', 'disposalEvidence']
  },
  {
    id: 'NET-004',
    name: 'TURN UDP relay transfer',
    required: true,
    networkMeasured: true,
    topology: 'turn-relay-udp',
    detector: detectTurnUdpRelay,
    requiredFields: ['selectedPair', 'relayProtocol', 'transferComplete']
  },
  {
    id: 'NET-005',
    name: 'TURN TCP/TLS diagnostic proof',
    required: true,
    networkMeasured: true,
    topology: 'turn-tcp-tls-diagnostic',
    detector: detectTurnTcpTls,
    requiredFields: ['relayProtocol', 'transferBytes', 'classification']
  },
  {
    id: 'NET-006',
    name: 'UDP-blocked TCP/TLS-only transfer',
    required: true,
    networkMeasured: true,
    topology: 'udp-blocked-turn-tcp-tls',
    detector: detectUdpBlockedTcpTls,
    requiredFields: ['udpBlockedProof', 'relayProtocol', 'throughputBps']
  },
  {
    id: 'NET-007',
    name: 'Synthetic multi-provider large-file grid',
    required: true,
    networkMeasured: false,
    topology: 'synthetic-fake-transport',
    detector: detectSyntheticMultiProvider,
    requiredFields: ['providerCount', 'hashVerified', 'memoryBytes', 'throughputBps']
  },
  {
    id: 'NET-008',
    name: 'Synthetic 500MiB bounded-memory perf',
    required: true,
    networkMeasured: false,
    topology: 'synthetic-memory-loop',
    detector: detectSyntheticPerf500,
    requiredFields: ['sizeBytes', 'throughputBps', 'boundedMemory']
  }
];

async function collectArtifacts(root) {
  const entries = [];
  await walk(root, entries);
  const artifacts = [];
  for (const path of entries) {
    if (!/\.(json|md)$/i.test(path)) continue;
    const raw = await readFile(path, 'utf8');
    let json;
    if (path.toLowerCase().endsWith('.json')) {
      try { json = JSON.parse(raw); } catch { json = undefined; }
    }
    if (json?.kind === 'cross-network-speed-matrix-report') continue;
    artifacts.push({ path, basename: path.split('/').pop() ?? path, raw, lower: raw.toLowerCase(), json });
  }
  return artifacts;
}

async function walk(path, entries) {
  let info;
  try { info = await stat(path); } catch { return; }
  if (!info.isDirectory()) { entries.push(path); return; }
  for (const child of await readdir(path)) await walk(join(path, child), entries);
}


function detectLanDirect(artifacts) {
  const candidate = artifacts.find(artifact => artifact.json?.kind === 'cli-lan-direct-report');
  if (!candidate) return missing('No LAN direct artifact found.');
  const report = candidate.json;
  const valid = exactKeys(report, ['schemaVersion', 'kind', 'topology', 'verdict', 'throughputBps', 'hashVerified'])
    && report.schemaVersion === 1 && report.kind === 'cli-lan-direct-report'
    && report.topology === 'same-lan-direct' && report.verdict === 'passed'
    && safePositiveNumber(report.throughputBps) && report.hashVerified === true;
  return {
    status: valid ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: valid ? { topology: report.topology, throughputBps: report.throughputBps, hashVerified: true } : {},
    notes: valid ? [] : ['LAN evidence must be the exact versioned CLI report schema with positive throughput and verified hash.']
  };
}

function detectNatSplitNetwork(artifacts) {
  const candidates = artifacts.filter(artifact => /nat|split-network/i.test(artifact.basename));
  if (candidates.length === 0) return missing('No NAT/split-network artifact found.');
  const candidate = candidates.find(artifact => strictBrowserTransferReport(artifact, 'nat-split-network')) ?? candidates[0];
  const contractValid = strictBrowserTransferReport(candidate, 'nat-split-network');
  return {
    status: contractValid ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: contractValid ? browserMetrics(candidate) : {},
    notes: contractValid ? [] : ['NAT/split-network evidence must be a strict browser transfer report with selected pair, RTT, payload goodput, runtime window, terminal integrity, and disposal evidence.']
  };
}

function detectMobileNetwork(artifacts) {
  const candidates = artifacts.filter(artifact => /lte|5g|mobile|hotspot/i.test(artifact.basename));
  if (candidates.length === 0) return missing('No LTE/5G/mobile artifact found.');
  const candidate = candidates.find(artifact => strictBrowserTransferReport(artifact, 'mobile-lte-5g')) ?? candidates[0];
  const contractValid = strictBrowserTransferReport(candidate, 'mobile-lte-5g');
  return {
    status: contractValid ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: contractValid ? browserMetrics(candidate) : {},
    notes: contractValid ? [] : ['Mobile evidence must be a strict browser transfer report with selected pair, RTT, payload goodput, runtime window, terminal integrity, and disposal evidence.']
  };
}


function strictBrowserTransferReport(artifact, expectedScenario) {
  const report = artifact.json;
  if (!report || report.schemaVersion !== 1 || report.kind !== 'browser-network-transfer-report'
    || report.scenario !== expectedScenario || report.verdict !== 'passed') return false;
  if (!exactKeys(report, ['schemaVersion', 'kind', 'scenario', 'verdict', 'sender', 'receiver', 'selectedPair', 'transfer', 'runtime', 'terminal'])
    || !exactKeys(report.sender, ['device', 'network'])
    || !exactKeys(report.receiver, ['device', 'network'])
    || !exactKeys(report.transfer, ['complete', 'bytes', 'rttMs', 'payloadGoodputBps'])
    || !exactKeys(report.runtime, ['window'])
    || !exactKeys(report.terminal, ['integrityVerified', 'disposalCompleted', 'outstandingRequests', 'activeTimers'])) return false;
  if (!isSafeLabel(report.sender?.device) || !isSafeLabel(report.sender?.network)
    || !isSafeLabel(report.receiver?.device) || !isSafeLabel(report.receiver?.network)) return false;
  if (typeof report.selectedPair !== 'string'
    || !/^(?:local|remote)=[a-z-]+\/(?:udp|tcp|tls)(?:\s+(?:local|remote)=[a-z-]+\/(?:udp|tcp|tls))$/i.test(report.selectedPair)
    || containsSensitiveAddress(report.selectedPair)) return false;
  const transfer = report.transfer;
  const runtime = report.runtime;
  const terminal = report.terminal;
  return transfer?.complete === true
    && safePositiveNumber(transfer.bytes)
    && safePositiveNumber(transfer.rttMs)
    && safePositiveNumber(transfer.payloadGoodputBps)
    && runtime?.window === 1
    && terminal?.integrityVerified === true
    && terminal?.disposalCompleted === true
    && terminal?.outstandingRequests === 0
    && terminal?.activeTimers === 0;
}

function browserMetrics(artifact) {
  const report = artifact.json;
  return {
    selectedPair: report.selectedPair,
    deviceLabels: [report.sender.device, report.receiver.device],
    networkLabels: [report.sender.network, report.receiver.network],
    transferComplete: report.transfer.complete,
    rttMs: report.transfer.rttMs,
    payloadGoodputBps: report.transfer.payloadGoodputBps,
    runtimeWindow: report.runtime.window,
    terminalIntegrity: report.terminal.integrityVerified,
    disposalEvidence: report.terminal.disposalCompleted
  };
}

function isSafeLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !containsSensitiveAddress(value);
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key));
}

function containsSensitiveAddress(value) {
  return /(?:https?|wss?):\/\/|(?:\d{1,3}\.){3}\d{1,3}|(?:^|[\s=])(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]*|-----BEGIN|bearer\s|(?:token|secret|password|credential)\s*[:=]/i.test(value);
}

function safePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function detectTurnUdpRelay(artifacts) {
  const candidate = artifacts.find(artifact => artifact.json?.kind === 'turn-relay-transfer-report');
  if (!candidate) return missing('No TURN UDP relay artifact found.');
  const report = candidate.json;
  const valid = exactKeys(report, ['schemaVersion', 'kind', 'verdict', 'selectedCandidatePair', 'transfer'])
    && exactKeys(report.selectedCandidatePair, ['localCandidateType', 'localRelayProtocol', 'remoteCandidateType', 'remoteProtocol'])
    && exactKeys(report.transfer, ['complete', 'receivedBytes', 'throughputBps'])
    && report.schemaVersion === 1 && report.kind === 'turn-relay-transfer-report'
    && report.verdict === 'passed' && report.selectedCandidatePair.localCandidateType === 'relay'
    && report.selectedCandidatePair.localRelayProtocol === 'udp'
    && report.selectedCandidatePair.remoteCandidateType === 'relay'
    && report.selectedCandidatePair.remoteProtocol === 'udp'
    && report.transfer.complete === true && safePositiveNumber(report.transfer.receivedBytes)
    && safePositiveNumber(report.transfer.throughputBps);
  return {
    status: valid ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: valid ? { selectedPair: `local=relay/udp remote=relay/udp`, relayProtocol: 'udp', transferComplete: true } : {},
    notes: valid ? [] : ['TURN UDP evidence must be the exact versioned relay transfer schema with positive observed metrics.']
  };
}

function detectTurnTcpTls(artifacts) {
  const candidate = artifacts.find(artifact => artifact.json?.kind === 'turn-diagnostic-report');
  if (!candidate) return missing('No TURN TCP/TLS diagnostic artifact found.');
  const valid = strictTurnDiagnosticReport(candidate.json, ['tcp', 'tls']);
  return {
    status: valid ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: valid ? { relayProtocol: candidate.json.classification.observedRelayProtocol, transferBytes: candidate.json.transfer.receivedBytes, classification: 'passed' } : {},
    notes: valid ? [] : ['TURN TCP/TLS evidence must be the exact versioned diagnostic schema with passed relay and transfer classification.']
  };
}

function strictTurnDiagnosticReport(report, protocols) {
  if (!report || report.schemaVersion !== 1 || report.kind !== 'turn-diagnostic-report'
    || !exactKeys(report, ['schemaVersion', 'kind', 'startedAt', 'finishedAt', 'durationMs', 'mode', 'iceTransportPolicy', 'candidateCounts', 'candidates', 'selectedCandidatePair', 'transfer', 'memory', 'connectionStates', 'errors', 'classification', 'verdict'])
    || !exactKeys(report.candidateCounts, ['pc1', 'pc2'])
    || !exactKeys(report.selectedCandidatePair, ['state', 'nominated', 'bytesSent', 'bytesReceived', 'localCandidateType', 'localProtocol', 'localRelayProtocol', 'localAddress', 'localPort', 'remoteCandidateType', 'remoteProtocol', 'remoteRelayProtocol'])
    || !exactKeys(report.transfer, ['requestedBytes', 'receivedBytes', 'complete', 'durationMs', 'throughputBps'])
    || !exactKeys(report.classification, ['expected', 'observedProtocol', 'observedRelayProtocol', 'relayOk', 'transferOk', 'verdict', 'productionInterpretation'])
    || !Array.isArray(report.candidates?.pc1) || !Array.isArray(report.candidates?.pc2)
    || !exactKeys(report.memory, ['startedHeapBytes', 'finishedHeapBytes', 'heapDeltaBytes'])
    || !exactKeys(report.connectionStates, ['pc1', 'pc2']) || !Array.isArray(report.errors)) return false;
  const pair = report.selectedCandidatePair;
  const classification = report.classification;
  const protocol = classification.observedRelayProtocol;
  const protocolSet = new Set(protocols);
  return typeof report.startedAt === 'string' && typeof report.finishedAt === 'string'
    && safePositiveInteger(report.durationMs) && report.mode === 'transfer' && report.iceTransportPolicy === 'relay'
    && safePositiveInteger(report.candidateCounts.pc1) && safePositiveInteger(report.candidateCounts.pc2)
    && report.errors.length === 0
    && pair.state === 'succeeded' && pair.nominated === true
    && safePositiveInteger(pair.bytesSent) && safePositiveInteger(pair.bytesReceived)
    && pair.localCandidateType === 'relay' && protocolSet.has(pair.localRelayProtocol)
    && pair.localRelayProtocol === protocol && pair.localProtocol === protocol
    && pair.remoteCandidateType === 'relay' && pair.remoteProtocol === protocol
    && pair.remoteRelayProtocol === protocol
    && pair.localAddress === 'redacted' && safePositiveInteger(pair.localPort)
    && report.transfer.complete === true && safePositiveInteger(report.transfer.requestedBytes)
    && safePositiveInteger(report.transfer.receivedBytes)
    && report.transfer.receivedBytes === report.transfer.requestedBytes
    && safePositiveInteger(report.transfer.durationMs)
    && pair.bytesSent >= report.transfer.requestedBytes
    && pair.bytesReceived >= report.transfer.receivedBytes
    && safePositiveNumber(report.transfer.throughputBps)
    && classification.expected === 'relay-tcp'
    && classification.observedProtocol === protocol
    && classification.relayOk === true && classification.transferOk === true
    && classification.verdict === 'passed' && report.verdict === 'passed';
}

function detectUdpBlockedTcpTls(artifacts) {
  const candidates = artifacts.filter(artifact => /udp-block|udp.*blocked|tcp-tls-only/i.test(artifact.basename));
  if (candidates.length === 0) return missing('No explicit UDP-blocked TCP/TLS-only network artifact found.');
  const candidate = candidates.find(strictUdpBlockedTcpTlsReport) ?? candidates[0];
  const valid = strictUdpBlockedTcpTlsReport(candidate);
  return {
    status: valid ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: valid ? {
      udpBlockedProof: true,
      relayProtocol: candidate.json.classification.observedRelayProtocol,
      throughputBps: candidate.json.transfer.throughputBps
    } : {},
    notes: valid ? [] : ['UDP-blocked evidence must be structured diagnostic JSON with verified firewall or network-namespace proof, a completed byte-exact transfer, and passed TCP/TLS classification.']
  };
}

function strictUdpBlockedTcpTlsReport(artifact) {
  const report = artifact.json;
  if (!report || report.schemaVersion !== 1 || report.kind !== 'udp-blocked-turn-diagnostic-report' || report.verdict !== 'passed') return false;
  if (!exactKeys(report, ['schemaVersion', 'kind', 'verdict', 'udpBlockedProof', 'selectedCandidatePair', 'transfer', 'classification'])
    || !exactKeys(report.udpBlockedProof, ['kind', 'verified', 'evidence'])
    || !exactKeys(report.selectedCandidatePair, ['localCandidateType', 'localRelayProtocol'])
    || !exactKeys(report.transfer, ['requestedBytes', 'receivedBytes', 'complete', 'throughputBps'])
    || !exactKeys(report.classification, ['verdict', 'observedRelayProtocol'])) return false;
  const protocol = report.classification.observedRelayProtocol;
  return (report.udpBlockedProof.kind === 'firewall-rule' || report.udpBlockedProof.kind === 'network-namespace')
    && report.udpBlockedProof.verified === true
    && isSafeLabel(report.udpBlockedProof.evidence)
    && report.selectedCandidatePair.localCandidateType === 'relay'
    && (report.selectedCandidatePair.localRelayProtocol === 'tcp' || report.selectedCandidatePair.localRelayProtocol === 'tls')
    && report.selectedCandidatePair.localRelayProtocol === protocol
    && report.transfer.complete === true
    && safePositiveNumber(report.transfer.requestedBytes)
    && report.transfer.receivedBytes === report.transfer.requestedBytes
    && safePositiveNumber(report.transfer.throughputBps)
    && report.classification.verdict === 'passed'
    && (protocol === 'tcp' || protocol === 'tls');
}

function detectSyntheticMultiProvider(artifacts) {
  const candidate = artifacts.find(artifact => artifact.json?.kind === 'multi-provider-grid-qa-report');
  if (!candidate) return missing('No synthetic multi-provider grid report found.');
  const report = candidate.json;
  const metrics = report?.metrics;
  const scheduledProviderCounts = Array.isArray(report?.scheduled)
    ? report.scheduled.reduce((counts, entry) => {
      if (entry && typeof entry.peerId === 'string') counts[entry.peerId] = (counts[entry.peerId] ?? 0) + 1;
      return counts;
    }, {})
    : {};
  const providerKeys = metrics?.providerCounts && typeof metrics.providerCounts === 'object' && !Array.isArray(metrics.providerCounts)
    ? Object.keys(metrics.providerCounts)
    : [];
  const ownerKey = providerKeys.includes('owner') ? 'owner' : providerKeys.find(key => key.endsWith('_owner'));
  const valid = report?.schemaVersion === 1 && report?.kind === 'multi-provider-grid-qa-report'
    && exactKeys(report, ['schemaVersion', 'kind', 'verdict', 'file', 'metrics', 'scheduled', 'qualitative', 'blockers'])
    && exactKeys(report.file, ['sizeBytes', 'pieceSize', 'pieceCount'])
    && exactKeys(metrics, ['elapsedMs', 'throughputBps', 'providerCounts', 'nonOwnerPieces', 'ownerPieces', 'nonOwnerProviderCount', 'churnApplied', 'finalHashMatch', 'receiverVerifiedPieces', 'scheduledPieces', 'heapUsedBytes'])
    && report.verdict === 'passed' && safePositiveInteger(report.file.sizeBytes) && safePositiveInteger(report.file.pieceSize)
    && safePositiveInteger(report.file.pieceCount) && report.file.pieceCount === Math.ceil(report.file.sizeBytes / report.file.pieceSize)
    && safePositiveNumber(metrics.elapsedMs) && safePositiveNumber(metrics.throughputBps)
    && safePositiveInteger(metrics.nonOwnerProviderCount) && safePositiveInteger(metrics.nonOwnerPieces) && safePositiveInteger(metrics.ownerPieces)
    && metrics.churnApplied === true && metrics.finalHashMatch === true && metrics.receiverVerifiedPieces === report.file.pieceCount
    && metrics.scheduledPieces === report.file.pieceCount && safePositiveInteger(metrics.heapUsedBytes)
    && Array.isArray(report.blockers) && report.blockers.length === 0
    && Array.isArray(report.scheduled) && report.scheduled.length === report.file.pieceCount
    && report.scheduled.every(entry => exactKeys(entry, ['pieceIndex', 'peerId', 'reason'])
      && safeNonNegativeInteger(entry.pieceIndex) && entry.pieceIndex < report.file.pieceCount
      && typeof entry.peerId === 'string' && entry.peerId.length > 0
      && typeof entry.reason === 'string' && entry.reason.length > 0)
    && new Set(report.scheduled.map(entry => entry.pieceIndex)).size === report.file.pieceCount
    && report.scheduled.every((entry, index) => report.scheduled.some(item => item.pieceIndex === index))
    && Array.isArray(report.qualitative) && report.qualitative.length > 0
    && report.qualitative.every(entry => typeof entry === 'string' && entry.length > 0)
    && typeof metrics.providerCounts === 'object' && metrics.providerCounts !== null && !Array.isArray(metrics.providerCounts)
    && Object.keys(metrics.providerCounts).length > 0
    && Object.keys(metrics.providerCounts).every(key => key.length > 0)
    && Object.values(metrics.providerCounts).every(value => safePositiveInteger(value))
    && metrics.ownerPieces + metrics.nonOwnerPieces === report.file.pieceCount
    && metrics.providerCounts[ownerKey] === metrics.ownerPieces
    && providerKeys.length === Object.keys(scheduledProviderCounts).length
    && providerKeys.every(key => Object.prototype.hasOwnProperty.call(scheduledProviderCounts, key)
      && metrics.providerCounts[key] === scheduledProviderCounts[key])
    && Object.keys(scheduledProviderCounts).every(key => providerKeys.includes(key))
    && ownerKey !== undefined
    && Object.values(metrics.providerCounts).reduce((sum, value) => sum + value, 0) === report.file.pieceCount
    && providerKeys.filter(key => key !== ownerKey).length === metrics.nonOwnerProviderCount;
  return {
    status: valid ? 'passed' : 'inconclusive', evidence: [candidate.path],
    metrics: valid ? { providerCount: metrics.nonOwnerProviderCount, hashVerified: true, memoryBytes: metrics.heapUsedBytes, throughputBps: metrics.throughputBps } : {},
    notes: ['Synthetic fake transport; do not use as real LAN/NAT/TURN network speed.']
  };
}

function detectSyntheticPerf500(artifacts) {
  const candidate = artifacts.find(artifact => artifact.json?.kind === 'large-file-performance-report');
  if (!candidate) return missing('No 500MiB bounded-memory performance report found.');
  const report = candidate.json;
  const valid = report?.schemaVersion === 1 && report?.kind === 'large-file-performance-report'
    && exactKeys(report, ['schemaVersion', 'kind', 'sizeBytes', 'pieceSize', 'pieces', 'durationMs', 'throughputBps', 'maxHeapBytes', 'maxRssBytes', 'maxExternalBytes', 'maxArrayBufferBytes', 'checksum', 'boundedMemory'])
    && report.sizeBytes === 500 * 1024 * 1024 && safePositiveNumber(report.pieceSize) && safePositiveNumber(report.pieces)
    && safePositiveNumber(report.durationMs) && safePositiveNumber(report.throughputBps) && safePositiveNumber(report.maxHeapBytes)
    && safePositiveNumber(report.maxRssBytes) && safePositiveNumber(report.maxExternalBytes) && safePositiveNumber(report.maxArrayBufferBytes)
    && Number.isInteger(report.checksum) && report.checksum >= 0 && report.boundedMemory === true
    && report.maxArrayBufferBytes < 64 * 1024 * 1024 && report.maxExternalBytes < 128 * 1024 * 1024
    && report.pieces === Math.ceil(report.sizeBytes / report.pieceSize);
  return {
    status: valid ? 'passed' : 'inconclusive', evidence: [candidate.path],
    metrics: valid ? { sizeBytes: report.sizeBytes, throughputBps: report.throughputBps, boundedMemory: true, maxRssBytes: report.maxRssBytes, maxArrayBuffersBytes: report.maxArrayBufferBytes } : {},
    notes: ['Synthetic memory-loop benchmark; validates bounded memory, not network speed.']
  };
}

function missing(reason) {
  return { status: 'missing', evidence: [], metrics: {}, notes: [reason] };
}

function completeScenario(definition, result) {
  if (result.status === 'missing' || result.status === 'failed') return result;
  const missingFields = definition.requiredFields.filter(field => !hasMetric(result.metrics, field));
  if (missingFields.length === 0) return result;
  return {
    ...result,
    status: 'inconclusive',
    notes: [...result.notes, `Missing required machine-readable field(s): ${missingFields.join(', ')}`]
  };
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function hasMetric(metrics, field) {
  if (field === 'topology') return true;
  const value = metrics[field];
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'boolean') return value;
  return value !== null && value !== undefined && value !== '';
}

function classifyReport(scenarios) {
  const required = scenarios.filter(item => item.required);
  const missing = required.filter(item => item.status === 'missing');
  const inconclusive = required.filter(item => item.status === 'inconclusive');
  const failed = required.filter(item => item.status === 'failed');
  const passed = required.filter(item => item.status === 'passed');
  const realNetwork = required.filter(item => item.networkMeasured);
  const realPassed = realNetwork.filter(item => item.status === 'passed');
  const syntheticPassed = required.filter(item => !item.networkMeasured && item.status === 'passed');
  const verdict = failed.length > 0
    ? 'failed'
    : missing.length > 0 || inconclusive.length > 0
      ? 'needs_external_evidence'
      : 'passed';
  return {
    verdict,
    requiredCount: required.length,
    passedCount: passed.length,
    missingCount: missing.length,
    inconclusiveCount: inconclusive.length,
    realNetworkPassedCount: realPassed.length,
    syntheticPassedCount: syntheticPassed.length,
    blockers: [...missing, ...inconclusive, ...failed].map(item => ({ id: item.id, name: item.name, status: item.status, notes: item.notes }))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const artifacts = await collectArtifacts(args.artifactsDir);
  const scenarios = SCENARIOS.map(definition => {
    const result = completeScenario(definition, definition.detector(artifacts));
    return {
      id: definition.id,
      name: definition.name,
      topology: definition.topology,
      required: definition.required,
      networkMeasured: definition.networkMeasured,
      status: result.status,
      evidence: result.evidence,
      requiredFields: definition.requiredFields,
      metrics: result.metrics,
      notes: result.notes
    };
  });
  const summary = classifyReport(scenarios);
  const report = {
    schemaVersion: 1,
    kind: 'cross-network-speed-matrix-report',
    generatedAt: new Date().toISOString(),
    artifactsDir: args.artifactsDir,
    verdict: summary.verdict,
    summary,
    scenarios,
    commands: {
      matrix: 'pnpm grid:network-matrix -- --out artifacts/g006-cross-network-matrix-report.json',
      strictMatrix: 'pnpm grid:network-matrix -- --strict --out artifacts/g006-cross-network-matrix-report.json',
      turnFetchIce: 'pnpm turn:fetch-ice -- --out artifacts/.turn-ice.json --signal wss://warp.ponslink.com/ws',
      turnDiagnoseTcpTls: "pnpm turn:diagnose -- --ice-server-json artifacts/.turn-ice.json --policy relay --mode transfer --expect relay-tcp --transfer-bytes 1048576 --out artifacts/g006-turn-tcp-tls-report.json",
      multiProvider: 'pnpm grid:multi-provider-qa -- --out artifacts/g006-multi-provider-report.json --size-mib 128 --piece-mib 1',
      perf500mb: 'pnpm perf:500mb'
    }
  };
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (args.strict && report.verdict !== 'passed') process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
