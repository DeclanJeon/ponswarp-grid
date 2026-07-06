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
    requiredFields: ['topology', 'selectedPair', 'transferComplete']
  },
  {
    id: 'NET-003',
    name: 'LTE/5G mobile browser transfer',
    required: true,
    networkMeasured: true,
    topology: 'mobile-lte-5g',
    detector: detectMobileNetwork,
    requiredFields: ['deviceLabels', 'networkLabels', 'transferComplete']
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

function passFromJson(artifact) {
  const verdict = String(artifact.json?.verdict ?? '').toLowerCase();
  return verdict === 'passed' || verdict === 'pass';
}

function passFromMarkdown(artifact) {
  return /\bpass(?:ed)?\b/i.test(artifact.raw) && !/\bfail(?:ed)?\b/i.test(artifact.raw.replace(/PASS(?:ED)?/gi, ''));
}

function detectLanDirect(artifacts) {
  const candidate = artifacts.find(artifact => /lan.*direct|direct.*lan/i.test(artifact.basename) || /cli lan result/i.test(artifact.raw));
  if (!candidate) return missing('No LAN direct artifact found.');
  const throughput = throughputBpsFromText(candidate.raw);
  const hashVerified = /hash.*(match|verified|ok|pass)/i.test(candidate.raw)
    || (/source sha-256/i.test(candidate.raw) && /remote output sha-256/i.test(candidate.raw))
    || Boolean(candidate.json?.metrics?.finalHashMatch);
  return {
    status: (/cli lan result[\s\S]*?status\s*\|\s*pass/i.test(candidate.raw) || passFromJson(candidate)) ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: { throughputBps: throughput, hashVerified },
    notes: throughput === null ? ['LAN artifact exists but throughput was not machine-extracted.'] : []
  };
}

function detectNatSplitNetwork(artifacts) {
  const candidate = artifacts.find(artifact => /nat|split-network/i.test(artifact.basename));
  if (!candidate) return missing('No NAT/split-network artifact found.');
  return {
    status: passFromMarkdown(candidate) || passFromJson(candidate) ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: { selectedPair: selectedPairText(candidate), transferComplete: /complete|verified|assembled|success/i.test(candidate.raw) },
    notes: []
  };
}

function detectMobileNetwork(artifacts) {
  const candidate = artifacts.find(artifact => /lte|5g|mobile|hotspot/i.test(artifact.basename));
  if (!candidate) return missing('No LTE/5G/mobile artifact found.');
  return {
    status: passFromMarkdown(candidate) || passFromJson(candidate) ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: {
      deviceLabels: labels(candidate.raw, /(sender|receiver)[^:\n]*:\s*([^\n]+)/gi),
      networkLabels: labels(candidate.raw, /(lte|5g|wi-fi|wifi|hotspot)/gi),
      transferComplete: /complete|verified|assembled|success|pass/i.test(candidate.raw)
    },
    notes: []
  };
}

function detectTurnUdpRelay(artifacts) {
  const candidates = artifacts.filter(artifact => /turn|relay/i.test(artifact.basename));
  const candidate = candidates.find(artifact => /relay\/udp|turn udp|udp relay|strict-relay/i.test(artifact.raw));
  if (!candidate) return missing('No TURN UDP relay artifact found.');
  return {
    status: passFromMarkdown(candidate) || passFromJson(candidate) ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: { selectedPair: selectedPairText(candidate), relayProtocol: 'udp', transferComplete: /complete|verified|assembled|success|pass/i.test(candidate.raw) },
    notes: []
  };
}

function detectTurnTcpTls(artifacts) {
  const candidate = artifacts.find(artifact => {
    const relayProtocol = String(artifact.json?.selectedCandidatePair?.localRelayProtocol ?? artifact.json?.classification?.observedRelayProtocol ?? '').toLowerCase();
    return relayProtocol === 'tcp' || relayProtocol === 'tls';
  }) ?? artifacts.find(artifact => /turn.*(tcp|tls)|tcp-only|tls/i.test(artifact.basename) && !/udp-block/i.test(artifact.basename));
  if (!candidate) return missing('No TURN TCP/TLS diagnostic artifact found.');
  const relayProtocol = String(candidate.json?.selectedCandidatePair?.localRelayProtocol ?? candidate.json?.classification?.observedRelayProtocol ?? '').toLowerCase() || textMatch(candidate.raw, /relayProtocol[^a-z]*(tcp|tls)/i);
  return {
    status: passFromJson(candidate) || passFromMarkdown(candidate) ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: {
      relayProtocol: relayProtocol || null,
      transferBytes: candidate.json?.transfer?.receivedBytes ?? null,
      classification: candidate.json?.classification?.verdict ?? candidate.json?.verdict ?? null
    },
    notes: relayProtocol ? [] : ['TCP/TLS artifact exists but relay protocol was not machine-extracted.']
  };
}

function detectUdpBlockedTcpTls(artifacts) {
  const candidate = artifacts.find(artifact => /udp-block|udp.*blocked|tcp-tls-only/i.test(artifact.basename));
  if (!candidate) return missing('No explicit UDP-blocked TCP/TLS-only network artifact found.');
  const throughput = throughputBpsFromText(candidate.raw);
  return {
    status: passFromMarkdown(candidate) || passFromJson(candidate) ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: { udpBlockedProof: /udp.*block|firewall/i.test(candidate.raw), relayProtocol: textMatch(candidate.raw, /(tcp|tls)/i), throughputBps: throughput },
    notes: throughput === null ? ['UDP-blocked artifact exists but throughput was not machine-extracted.'] : []
  };
}

function detectSyntheticMultiProvider(artifacts) {
  const candidate = artifacts.find(artifact => artifact.json?.kind === 'multi-provider-grid-qa-report' || /multi-provider-grid/i.test(artifact.basename));
  if (!candidate) return missing('No synthetic multi-provider grid report found.');
  const providerCount = candidate.json?.metrics?.nonOwnerProviderCount ?? null;
  return {
    status: passFromJson(candidate) || passFromMarkdown(candidate) ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: {
      providerCount,
      hashVerified: candidate.json?.metrics?.finalHashMatch ?? /hash.*match/i.test(candidate.raw),
      memoryBytes: candidate.json?.metrics?.heapUsedBytes ?? null,
      throughputBps: candidate.json?.metrics?.throughputBps ?? null
    },
    notes: ['Synthetic fake transport; do not use as real LAN/NAT/TURN network speed.']
  };
}

function detectSyntheticPerf500(artifacts) {
  const candidate = artifacts.find(artifact => artifact.json?.kind === 'large-file-performance-report' || /500mb|500mib|bounded-memory/i.test(artifact.basename));
  if (!candidate) return missing('No 500MiB bounded-memory performance report found.');
  return {
    status: passFromJson(candidate) || candidate.json?.boundedMemory === true ? 'passed' : 'inconclusive',
    evidence: [candidate.path],
    metrics: {
      sizeBytes: candidate.json?.sizeBytes ?? null,
      throughputBps: candidate.json?.throughputBps ?? null,
      boundedMemory: candidate.json?.boundedMemory ?? null,
      maxRssBytes: candidate.json?.maxRssBytes ?? null,
      maxArrayBuffersBytes: candidate.json?.maxArrayBuffersBytes ?? null
    },
    notes: ['Synthetic memory-loop benchmark; validates bounded memory, not network speed.']
  };
}

function missing(reason) {
  return { status: 'missing', evidence: [], metrics: {}, notes: [reason] };
}

function labels(text, regex) {
  const values = new Set();
  for (const match of text.matchAll(regex)) values.add((match[2] ?? match[1] ?? match[0]).trim());
  return [...values];
}

function numberMatch(text, regex) {
  const match = text.match(regex);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ''));
}

function throughputBpsFromText(text) {
  const mib = text.match(/throughput[^0-9]*(\d+(?:\.\d+)?)\s*MiB\/s/i);
  if (mib) return Math.round(Number(mib[1]) * 1024 * 1024);
  const mb = text.match(/throughput[^0-9]*(\d+(?:\.\d+)?)\s*MB\/s/i);
  if (mb) return Math.round(Number(mb[1]) * 1000 * 1000);
  const bps = text.match(/throughput[^0-9]*(\d[\d,]*)\s*(?:bps|B\/s)?/i);
  return bps ? Number(bps[1].replace(/,/g, '')) : null;
}

function textMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1].toLowerCase() : null;
}

function selectedPairText(artifact) {
  if (artifact.json?.selectedCandidatePair) return artifact.json.selectedCandidatePair;
  const match = artifact.raw.match(/local=([^\s]+)\s+remote=([^\s]+)/i);
  return match ? `local=${match[1]} remote=${match[2]}` : null;
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
