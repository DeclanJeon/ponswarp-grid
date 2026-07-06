import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ponswarp-cli-direct-'));
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

async function waitForLine(chunks: string[], match: RegExp, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const line = chunks.join('').split(/\r?\n/).find(value => match.test(value));
    if (line) return line;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${match}; output=${chunks.join('')}`);
}

async function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs = 10000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('process exit timeout')), timeoutMs);
    process.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}


describe('ponswarp CLI direct transfer', () => {
  it('sends and joins one file with final hash verification', async () => {
    const root = await tempRoot();
    const repo = process.cwd();
    let sender: ChildProcessWithoutNullStreams | undefined;
    try {
      const source = join(root, 'source.bin');
      const outDir = join(root, 'downloads');
      const payload = Buffer.from('ponswarp-cli-direct-transfer-fixture');
      await writeFile(source, payload);

      sender = spawnCli(['send', source, '--listen', '127.0.0.1:0', '--piece-size', '8'], repo);
      const senderOutput = collect(sender);
      const joinLine = await waitForLine(senderOutput.stdout, /^Join: /);
      const joinUrl = joinLine.slice('Join: '.length).trim();
      expect(joinUrl).toMatch(/^ponswarp:\/\/join\//);

      const receiver = spawnCli(['join', joinUrl, '--out', outDir], repo);
      const receiverOutput = collect(receiver);
      const code = await waitForExit(receiver);
      expect(code).toBe(0);
      const output = receiverOutput.stdout.join('');
      expect(output).toContain('Complete: source.bin');
      expect(output).toContain('Hash: verified');
      expect(output).toContain('Provider peer_owner_');
      expect(await readFile(join(outDir, 'source.bin'))).toEqual(payload);
      expect(receiverOutput.stderr.join('')).toBe('');
    } finally {
      if (sender && sender.exitCode === null) sender.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
  it('resumes a receiver rerun from persisted pieces', async () => {
    const root = await tempRoot();
    const repo = process.cwd();
    let sender: ChildProcessWithoutNullStreams | undefined;
    let firstReceiver: ChildProcessWithoutNullStreams | undefined;
    try {
      const source = join(root, 'resume.bin');
      const outDir = join(root, 'resume-downloads');
      const payload = Buffer.from('ponswarp-cli-direct-resume-fixture-with-several-pieces');
      await writeFile(source, payload);

      sender = spawnCli(['send', source, '--listen', '127.0.0.1:0', '--piece-size', '8', '--session', 'sess_cli_direct_resume'], repo);
      const senderOutput = collect(sender);
      const joinLine = await waitForLine(senderOutput.stdout, /^Join: /);
      const joinUrl = joinLine.slice('Join: '.length).trim();

      firstReceiver = spawnCli(['join', joinUrl, '--out', outDir], repo);
      const firstOutput = collect(firstReceiver);
      await waitForLine(firstOutput.stdout, /^Progress: [1-9]\d*\//);
      firstReceiver.kill('SIGTERM');
      await waitForExit(firstReceiver).catch(() => null);

      const secondReceiver = spawnCli(['join', joinUrl, '--out', outDir], repo);
      const secondOutput = collect(secondReceiver);
      const code = await waitForExit(secondReceiver);
      expect(code).toBe(0);
      const output = secondOutput.stdout.join('');
      expect(output).toContain('Complete: resume.bin');
      expect(output).toContain('Hash: verified');
      expect(await readFile(join(outDir, 'resume.bin'))).toEqual(payload);
    } finally {
      if (firstReceiver && firstReceiver.exitCode === null) firstReceiver.kill('SIGTERM');
      if (sender && sender.exitCode === null) sender.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
