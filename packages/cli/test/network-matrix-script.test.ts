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
  await writeFile(join(root, 'lan-direct-qa-report.md'), [
    '# LAN Direct QA',
    'Result: PASS',
    'Topology: same-lan-direct',
    '## CLI LAN result',
    '| Status | PASS |',
    'Throughput: 12000000 bps',
    'Hash verified',
    ''
  ].join('\n'));
  await writeFile(join(root, 'public-staging-nat-qa-report.md'), [
    '# NAT QA',
    'Result: PASS',
    'Sender: laptop on LTE hotspot',
    'Receiver: home Wi-Fi',
    'Selected pair local=srflx/udp remote=srflx/udp',
    'Transfer complete and verified',
    ''
  ].join('\n'));
  await writeFile(join(root, 'lte-mobile-turn-fix-report.md'), [
    '# LTE Mobile QA',
    'PASS mobile LTE transfer complete',
    'Sender: phone LTE',
    'Receiver: laptop Wi-Fi',
    ''
  ].join('\n'));
  await writeFile(join(root, 'public-staging-turn-qa-report.md'), [
    '# TURN UDP QA',
    'PASS strict-relay transfer complete',
    'ICE selected pair: local=relay/udp remote=relay/udp',
    ''
  ].join('\n'));
  await writeFile(join(root, 'public-g001-turn-tcp-only-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'turn-diagnostic-report',
    verdict: 'passed',
    selectedCandidatePair: { localCandidateType: 'relay', localRelayProtocol: 'tls' },
    transfer: { requestedBytes: 1048576, receivedBytes: 1048576, complete: true, throughputBps: 222222 },
    classification: { verdict: 'passed', observedRelayProtocol: 'tls' }
  }, null, 2));
  await writeFile(join(root, 'public-g005-multi-provider-grid-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'multi-provider-grid-qa-report',
    verdict: 'passed',
    metrics: { nonOwnerProviderCount: 2, finalHashMatch: true, heapUsedBytes: 123456, throughputBps: 987654 }
  }, null, 2));
  await writeFile(join(root, 'public-g005-500mb-bounded-memory-report.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'large-file-performance-report',
    boundedMemory: true,
    sizeBytes: 524288000,
    throughputBps: 4567890,
    maxRssBytes: 1000000,
    maxArrayBuffersBytes: 2000000
  }, null, 2));
  if (input.includeUdpBlocked) {
    await writeFile(join(root, 'udp-blocked-tcp-tls-report.md'), [
      '# UDP-blocked TCP/TLS QA',
      'Result: PASS',
      'Firewall UDP blocked proof captured',
      'Relay protocol: tls',
      'Throughput: 1234567 bps',
      ''
    ].join('\n'));
  }
}
