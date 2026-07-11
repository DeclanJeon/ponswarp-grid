import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ponswarp-cli-grid-'));
}

function spawnCli(args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['packages/cli/dist/cli.js', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function collect(process: ChildProcessWithoutNullStreams): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.stdout.on('data', chunk => stdout.push(String(chunk)));
  process.stderr.on('data', chunk => stderr.push(String(chunk)));
  return { stdout, stderr };
}

async function waitForLine(chunks: string[], match: RegExp, timeoutMs = 10000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const line = chunks.join('').split(/\r?\n/).find(value => match.test(value));
    if (line) return line;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${match}; output=${chunks.join('')}`);
}

async function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs = 15000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('process exit timeout')), timeoutMs);
    process.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

describe('ponswarp CLI grid transfer', () => {
  it('lets receiver B fetch at least one piece from receiver A', async () => {
    const root = await tempRoot();
    const repo = process.cwd();
    let sender: ChildProcessWithoutNullStreams | undefined;
    let receiverA: ChildProcessWithoutNullStreams | undefined;
    try {
      const source = join(root, 'grid.bin');
      const outA = join(root, 'receiver-a');
      const outB = join(root, 'receiver-b');
      const payload = Buffer.from('ponswarp-cli-grid-fixture-with-enough-pieces-for-provider-path');
      await writeFile(source, payload);

      sender = spawnCli(['send', source, '--listen', '127.0.0.1:0', '--piece-size', '8', '--session', 'sess_cli_grid'], repo);
      const senderOutput = collect(sender);
      const joinUrl = (await waitForLine(senderOutput.stdout, /^Join: /)).slice('Join: '.length).trim();

      receiverA = spawnCli(['join', joinUrl, '--out', outA, '--listen', '127.0.0.1:0', '--seed-after-complete'], repo);
      const aOutput = collect(receiverA);
      const peerUrl = (await waitForLine(aOutput.stdout, /^Peer: /)).slice('Peer: '.length).trim();
      expect(peerUrl).toMatch(/^ponswarp-peer:\/\//);

      const receiverB = spawnCli(['join', joinUrl, '--out', outB, '--listen', '127.0.0.1:0', '--peer', peerUrl], repo);
      const bOutput = collect(receiverB);
      const code = await waitForExit(receiverB);
      expect(code).toBe(0);
      const output = bOutput.stdout.join('');
      expect(output).toContain('Complete: grid.bin');
      expect(output).toContain('Hash: verified');
      const nonOwnerLine = output.split(/\r?\n/).find(line => line.startsWith('Non-owner provider pieces: '));
      expect(nonOwnerLine).toBeTruthy();
      const nonOwnerPieces = Number(nonOwnerLine?.slice('Non-owner provider pieces: '.length));
      expect(nonOwnerPieces).toBeGreaterThan(0);
      expect(await readFile(join(outB, 'grid.bin'))).toEqual(payload);
      expect(bOutput.stderr.join('')).toBe('');
      expect(receiverA.kill('SIGTERM')).toBe(true);
      expect(await waitForExit(receiverA)).toBe(143);
    } finally {
      if (receiverA && receiverA.exitCode === null) receiverA.kill('SIGTERM');
      if (sender && sender.exitCode === null) sender.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
