import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

interface MatrixResult {
  code: number | null;
  stdout: string;
  stderr: string;
  report: {
    verdict: 'passed' | 'needs_external_evidence' | 'failed';
    summary: { missingCount: number; realNetworkPassedCount: number; syntheticPassedCount: number };
    scenarios: Array<{ id: string; status: string; networkMeasured: boolean; metrics: Record<string, unknown>; notes: string[] }>;
  };
}

describe('network matrix QA script', () => {
  it('builds a machine-readable matrix and separates synthetic speed from real network evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-grid-network-matrix-'));
    try {
      await writeNetworkFixtures(root, { includeUdpBlocked: false });
      const out = join(root, 'matrix.json');

      const result = await runMatrix(root, out, []);

      expect(result.code).toBe(0);
      expect(result.report.verdict).toBe('needs_external_evidence');
      expect(result.report.summary.missingCount).toBe(1);
      expect(result.report.summary.realNetworkPassedCount).toBe(5);
      expect(result.report.summary.syntheticPassedCount).toBe(2);
      expect(result.report.scenarios.find(item => item.id === 'NET-006')).toMatchObject({ status: 'missing' });
      expect(result.report.scenarios.find(item => item.id === 'NET-007')).toMatchObject({
        status: 'passed',
        networkMeasured: false,
        metrics: expect.objectContaining({ providerCount: 2, hashVerified: true })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails strict mode until UDP-blocked TCP/TLS transfer evidence exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-grid-network-matrix-strict-'));
    try {
      await writeNetworkFixtures(root, { includeUdpBlocked: false });
      const out = join(root, 'matrix.json');

      const result = await runMatrix(root, out, ['--strict']);

      expect(result.code).toBe(1);
      expect(result.report.verdict).toBe('needs_external_evidence');
      expect(result.report.scenarios.find(item => item.id === 'NET-006')?.notes.join('\n')).toContain('UDP-blocked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes strict mode when every required real-network and synthetic evidence row exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-grid-network-matrix-complete-'));
    try {
      await writeNetworkFixtures(root, { includeUdpBlocked: true });
      const out = join(root, 'matrix.json');

      const result = await runMatrix(root, out, ['--strict']);

      expect(result.code).toBe(0);
      expect(result.report.verdict).toBe('passed');
      expect(result.report.summary.missingCount).toBe(0);
      expect(result.report.scenarios.find(item => item.id === 'NET-006')).toMatchObject({
        status: 'passed',
        metrics: expect.objectContaining({ udpBlockedProof: true, throughputBps: 1234567 })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not promote CLI LTE measurements to browser mobile evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-grid-network-matrix-cli-lte-'));
    try {
      await writeFile(join(root, 'lte-cli-performance-report.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'cli-network-transfer-performance-report',
        verdict: 'passed',
        receiver: { device: 'laptop', network: 'LTE hotspot' },
        transfer: { complete: true }
      }));
      const result = await runMatrix(root, join(root, 'matrix.json'), []);
      const mobile = result.report.scenarios.find(item => item.id === 'NET-003');

      expect(mobile).toMatchObject({
        status: 'inconclusive',
        notes: expect.arrayContaining([expect.stringContaining('browser transfer')])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects malformed and privacy-sensitive browser reports without weakening the gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-network-matrix-browser-contract-'));
    try {
      await writeFile(join(root, 'nat-browser-report.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'browser-network-transfer-report',
        scenario: 'nat-split-network',
        verdict: 'passed',
        sender: { device: 'phone', network: 'lte' },
        receiver: { device: 'laptop', network: 'wifi' },
        selectedPair: 'local=192.0.2.1/udp remote=srflx/udp',
        transfer: { complete: true, bytes: 10485760, payloadGoodputBps: 1234 },
        runtime: { window: 2 },
        terminal: { integrityVerified: true, disposalCompleted: true, outstandingRequests: 0, activeTimers: 0 }
      }));
      const result = await runMatrix(root, join(root, 'matrix.json'), []);
      expect(result.report.scenarios.find(item => item.id === 'NET-002')).toMatchObject({ status: 'inconclusive' });
      expect(result.report.scenarios.find(item => item.id === 'NET-003')).toMatchObject({ status: 'missing' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not accept self-asserted Markdown for UDP-blocked TURN proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-network-matrix-udp-markdown-'));
    try {
      await writeFile(join(root, 'udp-blocked-tcp-tls-report.md'), [
        '# UDP-blocked TCP/TLS QA',
        'Result: PASS',
        'Firewall UDP blocked proof captured',
        'Relay protocol: tls',
        'Throughput: 1234567 bps'
      ].join('\n'));
      const result = await runMatrix(root, join(root, 'matrix.json'), []);
      expect(result.report.scenarios.find(item => item.id === 'NET-006')).toMatchObject({
        status: 'inconclusive',
        metrics: {}
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects adversarial strict TURN and synthetic provider reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-network-matrix-adversarial-'));
    try {
      await writeNetworkFixtures(root, { includeUdpBlocked: false });
      const turnPath = join(root, 'public-g001-turn-tcp-only-report.json');
      const turn = JSON.parse(await readFile(turnPath, 'utf8')) as Record<string, any>;
      turn.errors = ['unexpected failure'];
      await writeFile(turnPath, JSON.stringify(turn));
      let result = await runMatrix(root, join(root, 'matrix.json'), []);
      expect(result.report.scenarios.find(item => item.id === 'NET-005')).toMatchObject({ status: 'inconclusive', metrics: {} });

      await writeNetworkFixtures(root, { includeUdpBlocked: false });
      const validTurn = JSON.parse(await readFile(turnPath, 'utf8')) as Record<string, any>;
      validTurn.classification.relayOk = false;
      validTurn.classification.transferOk = false;
      validTurn.selectedCandidatePair.remoteProtocol = 'tcp';
      validTurn.transfer.receivedBytes -= 1;
      await writeFile(turnPath, JSON.stringify(validTurn));
      result = await runMatrix(root, join(root, 'matrix.json'), []);
      expect(result.report.scenarios.find(item => item.id === 'NET-005')).toMatchObject({ status: 'inconclusive', metrics: {} });
      await writeNetworkFixtures(root, { includeUdpBlocked: false });
      const pairContradiction = JSON.parse(await readFile(turnPath, 'utf8')) as Record<string, any>;
      pairContradiction.selectedCandidatePair.bytesSent = 1;
      pairContradiction.selectedCandidatePair.bytesReceived = 1;
      await writeFile(turnPath, JSON.stringify(pairContradiction));
      result = await runMatrix(root, join(root, 'matrix.json'), []);
      expect(result.report.scenarios.find(item => item.id === 'NET-005')).toMatchObject({ status: 'inconclusive', metrics: {} });

      const providerPath = join(root, 'public-g005-multi-provider-grid-report.json');
      const provider = JSON.parse(await readFile(providerPath, 'utf8')) as Record<string, any>;
      const providerCountsContradiction = JSON.parse(JSON.stringify(provider));
      providerCountsContradiction.metrics.providerCounts.peerA = 63;
      await writeFile(providerPath, JSON.stringify(providerCountsContradiction));
      result = await runMatrix(root, join(root, 'matrix.json'), []);
      expect(result.report.scenarios.find(item => item.id === 'NET-007')).toMatchObject({ status: 'inconclusive', metrics: {} });
      provider.scheduled[1].pieceIndex = provider.scheduled[0].pieceIndex;
      provider.qualitative = [{ malformed: true }];
      provider.metrics.providerCounts.peerA = 1;
      await writeFile(providerPath, JSON.stringify(provider));
      result = await runMatrix(root, join(root, 'matrix.json'), []);
      expect(result.report.scenarios.find(item => item.id === 'NET-007')).toMatchObject({ status: 'inconclusive', metrics: {} });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
function runMatrix(artifactsDir: string, out: string, flags: string[]): Promise<MatrixResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts/network-matrix-qa.mjs'), '--artifacts-dir', artifactsDir, '--out', out, ...flags], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.addListener('error', reject);
    child.addListener('close', (code: number | null) => {
      readFile(out, 'utf8')
        .then(raw => resolve({ code, stdout, stderr, report: JSON.parse(raw) }))
        .catch(reject);
    });
  });
}

async function writeNetworkFixtures(root: string, input: { includeUdpBlocked: boolean }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'lan-direct-qa-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'cli-lan-direct-report',
    topology: 'same-lan-direct',
    verdict: 'passed',
    throughputBps: 12000000,
    hashVerified: true
  }));
  await writeFile(join(root, 'public-staging-nat-qa-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'browser-network-transfer-report',
    scenario: 'nat-split-network',
    verdict: 'passed',
    sender: { device: 'workstation', network: 'home-wifi' },
    receiver: { device: 'laptop', network: 'phone-lte-hotspot' },
    selectedPair: 'local=srflx/udp remote=srflx/udp',
    transfer: { complete: true, bytes: 10485760, rttMs: 42, payloadGoodputBps: 1234567 },
    runtime: { window: 1 },
    terminal: { integrityVerified: true, disposalCompleted: true, outstandingRequests: 0, activeTimers: 0 }
  }));
  await writeFile(join(root, 'lte-mobile-turn-fix-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'browser-network-transfer-report',
    scenario: 'mobile-lte-5g',
    verdict: 'passed',
    sender: { device: 'phone', network: 'lte' },
    receiver: { device: 'laptop', network: 'home-wifi' },
    selectedPair: 'local=srflx/udp remote=srflx/udp',
    transfer: { complete: true, bytes: 10485760, rttMs: 55, payloadGoodputBps: 987654 },
    runtime: { window: 1 },
    terminal: { integrityVerified: true, disposalCompleted: true, outstandingRequests: 0, activeTimers: 0 }
  }));
  await writeFile(join(root, 'public-staging-turn-qa-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'turn-relay-transfer-report',
    verdict: 'passed',
    selectedCandidatePair: {
      localCandidateType: 'relay',
      localRelayProtocol: 'udp',
      remoteCandidateType: 'relay',
      remoteProtocol: 'udp'
    },
    transfer: { complete: true, receivedBytes: 10485760, throughputBps: 1111111 }
  }));
  await writeFile(join(root, 'public-g001-turn-tcp-only-report.json'), JSON.stringify({
    schemaVersion: 1, kind: 'turn-diagnostic-report',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000, mode: 'transfer', iceTransportPolicy: 'relay',
    candidateCounts: { pc1: 2, pc2: 2 }, candidates: { pc1: [], pc2: [] }, memory: { startedHeapBytes: null, finishedHeapBytes: null, heapDeltaBytes: null },
    connectionStates: { pc1: 'connected', pc2: 'connected' }, errors: [],
    selectedCandidatePair: {
      state: 'succeeded', nominated: true, bytesSent: 1048576, bytesReceived: 1048576,
      localCandidateType: 'relay', localProtocol: 'tls', localRelayProtocol: 'tls',
      localAddress: 'redacted', localPort: 1, remoteCandidateType: 'relay',
      remoteProtocol: 'tls', remoteRelayProtocol: 'tls'
    },
    transfer: { requestedBytes: 1048576, receivedBytes: 1048576, complete: true, durationMs: 1000, throughputBps: 222222 },
    classification: {
      expected: 'relay-tcp', observedProtocol: 'tls', observedRelayProtocol: 'tls',
      relayOk: true, transferOk: true, verdict: 'passed',
      productionInterpretation: 'Requested TURN path is validated for this environment.'
    },
    verdict: 'passed'
  }, null, 2));
  await writeFile(join(root, 'public-g005-multi-provider-grid-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'multi-provider-grid-qa-report',
    verdict: 'passed',
    file: { sizeBytes: 134217728, pieceSize: 1048576, pieceCount: 128 },
    metrics: {
      elapsedMs: 1000, throughputBps: 987654, providerCounts: { owner: 1, peerA: 64, peerB: 63 },
      nonOwnerPieces: 127, ownerPieces: 1, nonOwnerProviderCount: 2, churnApplied: true,
      finalHashMatch: true, receiverVerifiedPieces: 128, scheduledPieces: 128, heapUsedBytes: 123456
    },
    scheduled: Array.from({ length: 128 }, (_, index) => ({ pieceIndex: index, peerId: index === 0 ? 'owner' : index < 65 ? 'peerA' : 'peerB', reason: 'availability' })), qualitative: ['verified'], blockers: []
  }, null, 2));
  await writeFile(join(root, 'public-g005-500mb-bounded-memory-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'large-file-performance-report',
    sizeBytes: 524288000,
    pieceSize: 1048576,
    pieces: 500,
    durationMs: 1000,
    throughputBps: 4567890,
    maxHeapBytes: 1000000,
    maxRssBytes: 1000000,
    maxExternalBytes: 2000000,
    maxArrayBufferBytes: 2000000,
    checksum: 123,
    boundedMemory: true
  }, null, 2));
  if (input.includeUdpBlocked) {
    await writeFile(join(root, 'udp-blocked-tcp-tls-report.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'udp-blocked-turn-diagnostic-report',
      verdict: 'passed',
      udpBlockedProof: { kind: 'firewall-rule', verified: true, evidence: 'isolated QA host firewall rejected UDP during the run' },
      selectedCandidatePair: { localCandidateType: 'relay', localRelayProtocol: 'tls' },
      transfer: { requestedBytes: 1048576, receivedBytes: 1048576, complete: true, throughputBps: 1234567 },
      classification: { verdict: 'passed', observedRelayProtocol: 'tls' }
    }, null, 2));
  }
}
describe('direct-transfer evidence scripts', () => {
  it('HOLDs when the local run directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-direct-transfer-missing-'));
    try {
      const result = await runScript('scripts/validate-direct-transfer-runs.mjs', ['--runs-dir', join(root, 'missing'), '--manifest', join(repoRoot, 'qa/direct-transfer/run-manifest.v1.json')]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'direct-transfer-validation', verdict: 'HOLD' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aggregates validated records deterministically and emits HOLD for no evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-direct-transfer-aggregate-'));
    try {
      const input = join(root, 'validation.json');
      await writeFile(input, JSON.stringify({ verdict: 'PASS', runs: [] }));
      const a = await runScript('scripts/aggregate-direct-transfer-runs.mjs', ['--input', input]);
      const b = await runScript('scripts/aggregate-direct-transfer-runs.mjs', ['--input', input]);
      expect(a.code).toBe(2);
      expect(a.stdout).toBe(b.stdout);
      expect(JSON.parse(a.stdout)).toMatchObject({ schema: 'ponswarp-grid.direct-transfer-aggregation/v2', gate: 'HOLD' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('accepts a complete strict matrix and rejects unsafe mutations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-direct-transfer-contract-'));
    try {
      const manifestPath = join(root, 'manifest.json');
      const runsDir = join(root, 'runs');
      await mkdir(runsDir, { recursive: true });
      const fixture = strictContractFixture();
      await writeFile(manifestPath, JSON.stringify(fixture.manifest));
      await Promise.all(fixture.records.map(record =>
        writeFile(join(runsDir, `${record.runId}.json`), JSON.stringify(record))
      ));

      const valid = await runScript('scripts/validate-direct-transfer-runs.mjs', ['--runs', runsDir, '--manifest', manifestPath]);
      expect(JSON.parse(valid.stdout)).toMatchObject({
        verdict: 'PASS',
        runCount: 20,
        provenance: { suiteId: 'suite', buildSha: 'build' }
      });

      const missingRecord = fixture.records.at(-1)!;
      await rm(join(runsDir, `${missingRecord.runId}.json`));
      const missingPairHalf = await runScript('scripts/validate-direct-transfer-runs.mjs', ['--runs', runsDir, '--manifest', manifestPath]);
      expect(JSON.parse(missingPairHalf.stdout)).toMatchObject({ verdict: 'HOLD' });
      await writeFile(join(runsDir, `${missingRecord.runId}.json`), JSON.stringify(missingRecord));

      const record = fixture.records[0];
      const cases: Array<[string, (input: typeof record) => typeof record]> = [
        ['unknown root field', input => ({ ...input, extraRoot: true })],
        ['unknown event field', input => ({ ...input, events: [{ ...input.events[0], extraEvent: true }, input.events[1]] })],
        ['privacy field', input => ({ ...input, environment: { ...input.environment, peerId: 'forbidden' } })],
        ['privacy value', input => ({ ...input, environment: { ...input.environment, storageKind: 'https://private.example' } })],
        ['provenance mismatch', input => ({ ...input, buildSha: 'other-build' })],
        ['sequence mismatch', input => ({ ...input, events: [{ ...input.events[0], seq: 2 }, input.events[1]] })],
        ['count mismatch', input => ({ ...input, counts: { ...input.counts, lifecycleLeaks: 1 } })],
        ['window-1 cap overflow', input => ({
          ...input,
          events: [
            input.events[0],
            { seq: 2, atMs: 1, type: 'scheduled', requested: 0, outstandingAfter: 2 },
            { ...input.events[1], seq: 3 }
          ]
        }) as typeof record],
        ['outcome mismatch', input => ({ ...input, outcome: 'succeeded' })],
        ['invalid controller state', input => ({ ...input, events: [{ ...input.events[0], state: 'unknown' }, input.events[1]] })],
        ['unclassified lifecycle error', input => ({
          ...input,
          counts: { ...input.counts, lifecycleLeaks: 1 },
          events: [
            input.events[0],
            { seq: 2, atMs: 1, type: 'direct_lifecycle_error', phase: 'network', code: 'https://leak.example' },
            { ...input.events[1], seq: 3 }
          ]
        }) as typeof record],
        ['legacy terminal reason', input => ({
          ...input,
          events: [
            { seq: 1, atMs: 1, type: 'terminal', reason: 'timeout', retryCount: 0, willRetry: false },
            input.events[0],
            { ...input.events[1], seq: 3 }
          ]
        }) as typeof record],
        ['missing disposal', input => ({ ...input, events: input.events.slice(0, 1) })],
        ['dirty disposal', input => ({ ...input, events: [input.events[0], { ...input.events[1], activeTimers: 1 }] })],
        ['duplicate disposal', input => ({ ...input, events: [...input.events, { ...input.events[1], seq: 3 }] })]
      ];
      for (const [name, mutate] of cases) {
        await writeFile(join(runsDir, `${record.runId}.json`), JSON.stringify(mutate(record)));
        const invalidCase = await runScript('scripts/validate-direct-transfer-runs.mjs', ['--runs', runsDir, '--manifest', manifestPath]);
        expect(JSON.parse(invalidCase.stdout).verdict, name).toBe('HOLD');
        await writeFile(join(runsDir, `${record.runId}.json`), JSON.stringify(record));
      }
      const windowTwoRecord = fixture.records.find(item => item.window === 2)!;
      await writeFile(join(runsDir, `${windowTwoRecord.runId}.json`), JSON.stringify({
        ...windowTwoRecord,
        events: [
          windowTwoRecord.events[0],
          { seq: 2, atMs: 1, type: 'scheduled', requested: 0, outstandingAfter: 3 },
          { ...windowTwoRecord.events[1], seq: 3 }
        ]
      }));
      const windowTwoOverflow = await runScript('scripts/validate-direct-transfer-runs.mjs', ['--runs', runsDir, '--manifest', manifestPath]);
      expect(JSON.parse(windowTwoOverflow.stdout)).toMatchObject({ verdict: 'HOLD' });
      await writeFile(join(runsDir, `${windowTwoRecord.runId}.json`), JSON.stringify(windowTwoRecord));

      const duplicateAttemptManifest = {
        ...fixture.manifest,
        pairs: fixture.manifest.pairs.map((pair, index) => index === 1 ? { ...pair, attempt: 1 } : pair)
      };
      await writeFile(manifestPath, JSON.stringify(duplicateAttemptManifest));
      const duplicateAttempt = await runScript('scripts/validate-direct-transfer-runs.mjs', ['--runs', runsDir, '--manifest', manifestPath]);
      expect(JSON.parse(duplicateAttempt.stdout)).toMatchObject({ verdict: 'HOLD' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('HOLDs zero-baseline deltas and incomplete pair halves without fabricating a gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-direct-transfer-deltas-'));
    try {
      const manifest = join(root, 'manifest.json');
      const input = join(root, 'validation.json');
      await writeFile(manifest, JSON.stringify({
        suiteId: 'suite',
        requiredStrata: [{ stratum: 'external-direct', available: true }],
        pairs: [
          { pairId: 'pair', stratum: 'external-direct', attempt: 1, runs: { '1': 'pair-w1', '2': 'pair-w2' } }
        ]
      }));
      const validation = {
        verdict: 'PASS',
        runs: [aggregateRun(1, 0), aggregateRun(2, 0)]
      };
      await writeFile(input, JSON.stringify(validation));
      const zero = await runScript('scripts/aggregate-direct-transfer-runs.mjs', ['--input', input, '--manifest', manifest]);
      expect(JSON.parse(zero.stdout)).toMatchObject({ gate: 'HOLD', summary: { goodputDeltaBps: [null] } });

      await writeFile(input, JSON.stringify({
        verdict: 'PASS',
        runs: [aggregateRun(1, 0), aggregateRun(2, 1)]
      }));
      const nonzero = await runScript('scripts/aggregate-direct-transfer-runs.mjs', ['--input', input, '--manifest', manifest]);
      expect(JSON.parse(nonzero.stdout)).toMatchObject({ gate: 'HOLD', summary: { goodputDeltaBps: [10000] } });

      await writeFile(input, JSON.stringify({ verdict: 'PASS', runs: [aggregateRun(1, 0)] }));
      const missingHalf = await runScript('scripts/aggregate-direct-transfer-runs.mjs', ['--input', input, '--manifest', manifest]);
      expect(JSON.parse(missingHalf.stdout)).toMatchObject({ gate: 'HOLD', gates: { complete: false } });
      await writeFile(manifest, JSON.stringify({
        suiteId: 'two-direct',
        requiredStrata: [
          { stratum: 'external-a', available: true, paths: ['direct-host'] },
          { stratum: 'external-b', available: true, paths: ['direct-srflx'] }
        ],
        pairs: []
      }));
      const twoDirectOnly = await runScript('scripts/aggregate-direct-transfer-runs.mjs', ['--input', input, '--manifest', manifest]);
      expect(JSON.parse(twoDirectOnly.stdout)).toMatchObject({
        gate: 'HOLD',
        gates: { availableExternalRelay: false }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('ENABLEs only validator-bound complete paired evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-direct-transfer-enable-'));
    try {
      const manifestPath = join(root, 'manifest.json');
      const validationPath = join(root, 'validation.json');
      const runsDir = join(root, 'runs');
      await mkdir(runsDir, { recursive: true });
      const fixture = strictEnableFixture();
      await writeFile(manifestPath, JSON.stringify(fixture.manifest));
      await Promise.all(fixture.records.map(record =>
        writeFile(join(runsDir, `${record.runId}.json`), JSON.stringify(record))
      ));
      const validation = await runScript('scripts/validate-direct-transfer-runs.mjs', [
        '--manifest', manifestPath,
        '--runs', runsDir,
        '--out', validationPath
      ]);
      expect(validation.code).toBe(0);

      const aggregateArgs = [
        '--validation', validationPath,
        '--manifest', manifestPath,
        '--runs', runsDir,
        '--strict'
      ];
      const enabled = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(enabled.code).toBe(0);
      expect(JSON.parse(enabled.stdout)).toMatchObject({
        gate: 'ENABLE',
        gates: {
          strictValidation: true,
          complete: true,
          availableExternalRelay: true,
          clean: true,
          completion: true,
          reliability: true,
          goodput: true,
          unavailableApproved: true
        },
        summary: { goodputDeltaBps: [1110, 1110] }
      });

      const validationArtifact = JSON.parse(await readFile(validationPath, 'utf8'));
      await writeFile(validationPath, JSON.stringify({
        ...validationArtifact,
        provenance: { ...validationArtifact.provenance, buildSha: 'altered' }
      }));
      const alteredValidation = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(JSON.parse(alteredValidation.stdout)).toMatchObject({ gate: 'HOLD' });

      await writeFile(validationPath, JSON.stringify(validationArtifact));
      const changedRun = fixture.records[0];
      await writeFile(join(runsDir, `${changedRun.runId}.json`), JSON.stringify({ ...changedRun, outcome: 'failed' }));
      const alteredRuns = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(JSON.parse(alteredRuns.stdout)).toMatchObject({ gate: 'HOLD' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('accepts only exact unexpired unavailable approvals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-direct-transfer-approval-'));
    try {
      const manifestPath = join(root, 'manifest.json');
      const validationPath = join(root, 'validation.json');
      const approvalPath = join(root, 'approval.json');
      const runsDir = join(root, 'runs');
      await mkdir(runsDir, { recursive: true });
      const fixture = strictEnableFixture();
      const unavailablePairs = Array.from({ length: 10 }, (_, index) => {
        const attempt = index + 1;
        const pairId = `relay-tls-${attempt}`;
        return {
          pairId,
          stratum: 'relay-tls',
          attempt,
          browserFamilyMajor: 'chromium',
          storageKind: 'indexeddb',
          path: 'relay-tls',
          runs: { '1': `${pairId}-w1`, '2': `${pairId}-w2` }
        };
      });
      const manifest = {
        ...fixture.manifest,
        requiredStrata: [
          ...fixture.manifest.requiredStrata,
          { stratum: 'relay-tls', available: false, paths: ['relay-tls'] }
        ],
        pairs: [...fixture.manifest.pairs, ...unavailablePairs]
      };
      await writeFile(manifestPath, JSON.stringify(manifest));
      await Promise.all(fixture.records.map(record =>
        writeFile(join(runsDir, `${record.runId}.json`), JSON.stringify(record))
      ));
      const validation = await runScript('scripts/validate-direct-transfer-runs.mjs', [
        '--manifest', manifestPath,
        '--runs', runsDir,
        '--out', validationPath
      ]);
      expect(validation.code).toBe(0);

      const approvalEntry = {
        stratum: 'relay-tls',
        approved: true,
        approverRole: 'release-manager',
        approvedAt: '2026-07-11T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        reason: 'test environment unavailable',
        impact: 'relay TLS evidence excluded',
        rollbackCondition: 'restore hold-1 on any regression'
      };
      const aggregateArgs = [
        '--validation', validationPath,
        '--manifest', manifestPath,
        '--runs', runsDir,
        '--approval', approvalPath,
        '--strict'
      ];
      await writeFile(approvalPath, JSON.stringify({
        schema: 'ponswarp-grid.unavailable-approval/v1',
        suiteId: manifest.suiteId,
        entries: [approvalEntry]
      }));
      const approved = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(JSON.parse(approved.stdout)).toMatchObject({ gate: 'ENABLE', gates: { unavailableApproved: true } });

      await writeFile(approvalPath, JSON.stringify({
        schema: 'ponswarp-grid.unavailable-approval/v1',
        suiteId: manifest.suiteId,
        entries: [{ ...approvalEntry, expiresAt: '2020-01-01T00:00:00.000Z' }]
      }));
      const expired = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(JSON.parse(expired.stdout)).toMatchObject({ gate: 'HOLD', gates: { unavailableApproved: false } });
      await writeFile(approvalPath, JSON.stringify({
        schema: 'ponswarp-grid.unavailable-approval/v1',
        suiteId: manifest.suiteId,
        entries: [{ ...approvalEntry, approvedAt: '2098-01-01T00:00:00.000Z' }]
      }));
      const futureDated = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(JSON.parse(futureDated.stdout)).toMatchObject({ gate: 'HOLD', gates: { unavailableApproved: false } });

      await writeFile(approvalPath, JSON.stringify({
        schema: 'ponswarp-grid.unavailable-approval/v1',
        suiteId: manifest.suiteId,
        entries: [{ ...approvalEntry, approvedAt: '2099-02-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }]
      }));
      const inverted = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(JSON.parse(inverted.stdout)).toMatchObject({ gate: 'HOLD', gates: { unavailableApproved: false } });

      const { impact: _impact, ...incompleteEntry } = approvalEntry;
      void _impact;
      await writeFile(approvalPath, JSON.stringify({
        schema: 'ponswarp-grid.unavailable-approval/v1',
        suiteId: manifest.suiteId,
        entries: [incompleteEntry]
      }));
      const incomplete = await runScript('scripts/aggregate-direct-transfer-runs.mjs', aggregateArgs);
      expect(JSON.parse(incomplete.stdout)).toMatchObject({ gate: 'HOLD', gates: { unavailableApproved: false } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function strictContractFixture() {
  const pairs = Array.from({ length: 10 }, (_, index) => {
    const attempt = index + 1;
    return {
      pairId: `pair-${attempt}`,
      stratum: 'external-direct',
      attempt,
      browserFamilyMajor: 'chromium',
      storageKind: 'indexeddb',
      path: 'direct-srflx',
      runs: { '1': `pair-${attempt}-w1`, '2': `pair-${attempt}-w2` }
    };
  });
  const manifest = {
    schema: 'ponswarp-grid.direct-transfer-run-manifest/v1',
    suiteId: 'suite',
    buildSha: 'build',
    fixture: {
      fixtureId: 'fixture',
      fixtureSha256: '0'.repeat(64),
      fileBytes: 1,
      pieceBytes: 1,
      pieceCount: 1,
      hashMode: 'sha256'
    },
    windowPolicy: {
      allowed: [1, 2],
      default: 1,
      maxInFlight: { '1': 1, '2': 2 },
      controllerTimeoutMs: 300000
    },
    requiredStrata: [{ stratum: 'external-direct', available: true, paths: ['direct-srflx'] }],
    pairs
  };
  const records = pairs.flatMap(pair => ([1, 2] as const).map(window => ({
    schema: 'ponswarp-grid.direct-transfer-run/v2',
    runId: pair.runs[String(window) as '1' | '2'],
    suiteId: 'suite',
    fixtureId: 'fixture',
    fixtureSha256: '0'.repeat(64),
    pairId: pair.pairId,
    stratum: pair.stratum,
    attempt: pair.attempt,
    buildSha: 'build',
    window,
    startedAtMs: 0,
    endedAtMs: 2,
    outcome: 'failed',
    environment: { browserFamilyMajor: 'chromium', storageKind: 'indexeddb' },
    path: 'direct-srflx',
    transfer: { fileBytes: 1, pieceBytes: 1, pieceCount: 1, hashMode: 'sha256' },
    counts: {
      scheduled: 0,
      verified: 0,
      retries: 0,
      timeouts: 0,
      rejects: 0,
      sendFailures: 0,
      invalidChunks: 0,
      cancellations: 0,
      watermarkHigh: 0,
      watermarkLow: 0,
      storageWrites: 0,
      resumeValidations: 0,
      resumeFailures: 0,
      integrityFailures: 0,
      framingFailures: 0,
      lifecycleLeaks: 0
    },
    events: [
      { seq: 1, atMs: 1, type: 'controller', state: 'failed' },
      { seq: 2, atMs: 2, type: 'lifecycle', status: 'dispose_completed', outstandingDirect: 0, activeTimers: 0 }
    ]
  })));
  return { manifest, records };
}

function strictEnableFixture() {
  const strata = [
    { stratum: 'external-direct', available: true, paths: ['direct-srflx'] },
    { stratum: 'relay-udp', available: true, paths: ['relay-udp'] }
  ];
  const pairs = strata.flatMap(({ stratum, paths }) =>
    Array.from({ length: 10 }, (_, index) => {
      const attempt = index + 1;
      const pairId = `${stratum}-${attempt}`;
      return {
        pairId,
        stratum,
        attempt,
        browserFamilyMajor: 'chromium',
        storageKind: 'indexeddb',
        path: paths[0],
        runs: { '1': `${pairId}-w1`, '2': `${pairId}-w2` }
      };
    })
  );
  const manifest = {
    schema: 'ponswarp-grid.direct-transfer-run-manifest/v1',
    suiteId: 'enable-suite',
    buildSha: 'build',
    fixture: {
      fixtureId: 'fixture',
      fixtureSha256: '0'.repeat(64),
      fileBytes: 1000,
      pieceBytes: 1000,
      pieceCount: 1,
      hashMode: 'sha256'
    },
    windowPolicy: {
      allowed: [1, 2],
      default: 1,
      maxInFlight: { '1': 1, '2': 2 },
      controllerTimeoutMs: 300000
    },
    requiredStrata: strata,
    pairs
  };
  const records = pairs.flatMap(pair => ([1, 2] as const).map(window => {
    const endedAtMs = window === 1 ? 1000 : 900;
    return {
      schema: 'ponswarp-grid.direct-transfer-run/v2',
      runId: pair.runs[String(window) as '1' | '2'],
      suiteId: manifest.suiteId,
      fixtureId: manifest.fixture.fixtureId,
      fixtureSha256: manifest.fixture.fixtureSha256,
      pairId: pair.pairId,
      stratum: pair.stratum,
      attempt: pair.attempt,
      buildSha: manifest.buildSha,
      window,
      startedAtMs: 0,
      endedAtMs,
      outcome: 'succeeded',
      environment: { browserFamilyMajor: pair.browserFamilyMajor, storageKind: pair.storageKind },
      path: pair.path,
      transfer: { fileBytes: 1000, pieceBytes: 1000, pieceCount: 1, hashMode: 'sha256' },
      counts: {
        scheduled: 0,
        verified: 1,
        retries: 0,
        timeouts: 0,
        rejects: 0,
        sendFailures: 0,
        invalidChunks: 0,
        cancellations: 0,
        watermarkHigh: 0,
        watermarkLow: 0,
        storageWrites: 0,
        resumeValidations: 1,
        resumeFailures: 0,
        integrityFailures: 0,
        framingFailures: 0,
        lifecycleLeaks: 0
      },
      events: [
        { seq: 1, atMs: 0, type: 'controller', state: 'succeeded' },
        { seq: 2, atMs: 1, type: 'terminal', reason: 'verified', retryCount: 0, willRetry: false },
        { seq: 3, atMs: 2, type: 'resume_validation', verifiedPieces: 1, discardedPieces: 0, status: 'passed' },
        { seq: 4, atMs: endedAtMs, type: 'lifecycle', status: 'dispose_completed', outstandingDirect: 0, activeTimers: 0 }
      ]
    };
  }));
  return { manifest, records };
}

function runScript(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, script), ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.addListener('error', reject);
    child.addListener('close', code => resolve({ code, stdout, stderr }));
  });
}
function aggregateRun(window: 1 | 2, fileBytes: number): Record<string, unknown> {
  return {
    runId: `pair-w${window}`, pairId: 'pair', stratum: 'external-direct', window, attempt: 1,
    startedAtMs: 0, endedAtMs: 1000, outcome: 'succeeded',
    transfer: { fileBytes }, counts: { integrityFailures: 0, resumeFailures: 0, framingFailures: 0, lifecycleLeaks: 0 }
  };
}

function gateRun(
  pair: { pairId: string; stratum: string; attempt: number; runs: Record<string, string> },
  window: 1 | 2,
  fileBytes: number
): Record<string, unknown> {
  return {
    runId: pair.runs[String(window)],
    pairId: pair.pairId,
    stratum: pair.stratum,
    window,
    attempt: pair.attempt,
    startedAtMs: 0,
    endedAtMs: 1000,
    outcome: 'succeeded',
    transfer: { fileBytes },
    counts: { integrityFailures: 0, resumeFailures: 0, framingFailures: 0, lifecycleLeaks: 0 }
  };
}
