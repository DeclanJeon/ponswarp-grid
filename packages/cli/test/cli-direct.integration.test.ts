import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCliCleanup, installCliShutdownHandlers } from '../src/cli-runtime.js';
import type { PonsWarpEngine } from '@ponswarp/core';
import type { NodeFileSource } from '../src/node-file-storage.js';
import type { NodeWebSocketTransport } from '../src/node-websocket-transport.js';
it('runs ordered cleanup after disposal failure and only once', async () => {
  const order: string[] = [];
  const disposeError = new Error('dispose failed');
  const engine = { dispose: async () => { order.push('engine'); throw disposeError; } } as unknown as PonsWarpEngine;
  const source = { close: async () => { order.push('source'); } } as unknown as NodeFileSource;
  const transport = { close: async () => { order.push('transport'); } } as unknown as NodeWebSocketTransport;
  const cleanup = createCliCleanup(() => engine, () => source, transport);

  await expect(cleanup()).rejects.toBe(disposeError);
  await expect(cleanup()).rejects.toBe(disposeError);

  expect(order).toEqual(['engine', 'source', 'transport']);
});
it('shares concurrent cleanup and preserves the primary failure', async () => {
  const order: string[] = [];
  const disposeError = new Error('dispose failed');
  const sourceError = new Error('source close failed');
  const transportError = new Error('transport close failed');
  let release!: () => void;
  const disposal = new Promise<void>(resolve => {
    release = resolve;
  });
  const engine = {
    dispose: async () => {
      order.push('engine');
      await disposal;
      throw disposeError;
    }
  } as unknown as PonsWarpEngine;
  const source = {
    close: async () => {
      order.push('source');
      throw sourceError;
    }
  } as unknown as NodeFileSource;
  const transport = {
    close: async () => {
      order.push('transport');
      throw transportError;
    }
  } as unknown as NodeWebSocketTransport;
  const cleanup = createCliCleanup(() => engine, () => source, transport);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    const firstCall = cleanup();
    const secondCall = cleanup();
    expect(secondCall).toBe(firstCall);
    expect(order).toEqual(['engine']);

    release();

    await expect(firstCall).rejects.toBe(disposeError);
    await expect(secondCall).rejects.toBe(disposeError);
    expect(order).toEqual(['engine', 'source', 'transport']);
    expect(errorSpy).toHaveBeenCalledWith(sourceError.stack ?? sourceError.message);
    expect(errorSpy).toHaveBeenCalledWith(transportError.stack ?? transportError.message);
  } finally {
    errorSpy.mockRestore();
  }
});

it('preserves an undefined first cleanup rejection and still attempts every close', async () => {
  const order: string[] = [];
  const sourceError = new Error('source close failed');
  const engine = { dispose: async () => { order.push('engine'); return Promise.reject(undefined); } } as unknown as PonsWarpEngine;
  const source = { close: async () => { order.push('source'); throw sourceError; } } as unknown as NodeFileSource;
  const transport = { close: async () => { order.push('transport'); } } as unknown as NodeWebSocketTransport;
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const cleanup = createCliCleanup(() => engine, () => source, transport);

  try {
    const rejection = await cleanup().then(
      () => 'resolved',
      error => error
    );
    expect(rejection).toBeUndefined();
    expect(order).toEqual(['engine', 'source', 'transport']);
    expect(errorSpy).toHaveBeenCalledWith(sourceError.stack ?? sourceError.message);
  } finally {
    errorSpy.mockRestore();
  }
});

it('keeps signal handlers active until shared cleanup settles', async () => {
  const handlers = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>([
    ['SIGINT', new Set()],
    ['SIGTERM', new Set()]
  ]);
  const exits: number[] = [];
  let release!: () => void;
  const cleanup = vi.fn(() => new Promise<void>(resolve => {
    release = resolve;
  }));
  const runtime = {
    on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => handlers.get(signal)?.add(listener),
    removeListener: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => handlers.get(signal)?.delete(listener),
    exit: (code: number) => { exits.push(code); }
  };
  installCliShutdownHandlers(cleanup, runtime);

  for (const listener of handlers.get('SIGTERM') ?? []) listener();
  for (const listener of handlers.get('SIGINT') ?? []) listener();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(handlers.get('SIGINT')?.size).toBe(1);
  expect(handlers.get('SIGTERM')?.size).toBe(1);

  release();
  await Promise.resolve();
  await Promise.resolve();

  expect(exits).toEqual([143]);
  expect(handlers.get('SIGINT')?.size).toBe(0);
  expect(handlers.get('SIGTERM')?.size).toBe(0);
});

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
      expect(sender.kill('SIGTERM')).toBe(true);
      expect(await waitForExit(sender)).toBe(143);
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
      expect(firstReceiver.kill('SIGTERM')).toBe(true);
      expect(await waitForExit(firstReceiver)).toBe(143);
      expect(firstOutput.stderr.join('')).toBe('');

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
