import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileId, FileManifest, PeerId, PersistedSessionState, SessionId } from '@ponswarp/core';
import { runClean, runStatus } from '../src/cli-runtime.js';
import { NodeFileStorageAdapter } from '../src/node-file-storage';

const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

afterEach(() => {
  consoleSpy.mockClear();
});

describe('CLI session storage commands', () => {
  it('reports persisted owner and receiver state from PONSWARP_STORAGE_DIR', async () => {
    await withStorageRoot(async storageRoot => {
      const sessionId = 'sess_cli_status' as SessionId;
      const otherSessionId = 'sess_cli_status_other' as SessionId;
      const ownerManifest = manifest('file_owner_status' as FileId, 'owner.bin', [4, 5]);
      const receiverManifest = manifest('file_receiver_status' as FileId, 'received.bin', [3, 3]);
      const ownerRoot = await seedEntry(storageRoot, 'owners', storageKey(sessionId), state(sessionId, 'direct', ownerManifest, [0, 1]));
      const receiverRoot = await seedEntry(storageRoot, 'receivers', storageKey(`${sessionId}:downloads/receiver-a`), state(sessionId, 'grid', receiverManifest, [0]));
      await seedEntry(storageRoot, 'owners', storageKey(otherSessionId), state(otherSessionId, 'direct', manifest('file_ignored' as FileId, 'ignored.bin', [1]), [0]));

      await runStatus({ command: 'status', session: sessionId });

      const output = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
      expect(output).toContain(`Session: ${sessionId}`);
      expect(output.match(/^Entry:/gm)).toHaveLength(2);
      expect(output).toContain('Entry: owner');
      expect(output).toContain(ownerRoot);
      expect(output).toContain('Mode: direct');
      expect(output).toContain('File: owner.bin');
      expect(output).toMatch(/Progress.*2\/2/);
      expect(output).toContain('Entry: receiver');
      expect(output).toContain(receiverRoot);
      expect(output).toContain('Mode: grid');
      expect(output).toContain('File: received.bin');
      expect(output).toMatch(/Progress.*1\/2/);
      expect(output).not.toContain('ignored.bin');
    });
  });

  it('cleans every owner and receiver entry for a session without knowing receiver outDir keys', async () => {
    await withStorageRoot(async storageRoot => {
      const sessionId = 'sess_cli_clean' as SessionId;
      const otherSessionId = 'sess_cli_clean_other' as SessionId;
      const ownerRoot = await seedEntry(storageRoot, 'owners', storageKey(sessionId), state(sessionId, 'direct', manifest('file_clean_owner' as FileId, 'owner.bin', [2]), [0]));
      const receiverARoot = await seedEntry(storageRoot, 'receivers', storageKey(`${sessionId}:downloads/a`), state(sessionId, 'grid', manifest('file_clean_a' as FileId, 'a.bin', [2, 2]), [0]));
      const receiverBRoot = await seedEntry(storageRoot, 'receivers', storageKey(`${sessionId}:different-output-dir`), state(sessionId, 'grid', manifest('file_clean_b' as FileId, 'b.bin', [3, 3]), [0, 1]));
      const untouchedRoot = await seedEntry(storageRoot, 'receivers', storageKey(`${otherSessionId}:downloads/a`), state(otherSessionId, 'grid', manifest('file_clean_other' as FileId, 'other.bin', [1]), [0]));

      await runClean({ command: 'clean', session: sessionId });

      expect(consoleSpy.mock.calls.map(call => String(call[0])).join('\n')).toContain('Cleaned: 3');
      await expect(stat(join(ownerRoot, 'sessions', sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(receiverARoot, 'sessions', sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(receiverBRoot, 'sessions', sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(join(untouchedRoot, 'sessions', otherSessionId))).isDirectory()).toBe(true);
    });
  });
});

async function withStorageRoot<T>(run: (storageRoot: string) => Promise<T>): Promise<T> {
  const previous = process.env.PONSWARP_STORAGE_DIR;
  const storageRoot = await mkdtemp(join(tmpdir(), 'ponswarp-cli-session-storage-'));
  process.env.PONSWARP_STORAGE_DIR = storageRoot;
  try {
    return await run(storageRoot);
  } finally {
    if (previous === undefined) delete process.env.PONSWARP_STORAGE_DIR;
    else process.env.PONSWARP_STORAGE_DIR = previous;
    await rm(storageRoot, { recursive: true, force: true });
  }
}

async function seedEntry(storageRoot: string, bucket: 'owners' | 'receivers', key: string, persistedState: PersistedSessionState): Promise<string> {
  const rootDir = join(storageRoot, bucket, key);
  const storage = new NodeFileStorageAdapter({ rootDir });
  await storage.init(persistedState.sessionId);
  await storage.saveState(persistedState);
  return rootDir;
}

function state(sessionId: SessionId, mode: PersistedSessionState['mode'], fileManifest: FileManifest, verifiedPieces: number[]): PersistedSessionState {
  return {
    schemaVersion: 1,
    protocolVersion: 'ponswarp-grid/1.0.0',
    sessionId,
    ownerPeerId: 'peer_owner_status' as PeerId,
    mode,
    manifests: [fileManifest],
    pieceMaps: [{
      fileId: fileManifest.fileId,
      exportedAt: 123,
      pieces: fileManifest.pieces.map(piece => ({
        index: piece.index,
        status: verifiedPieces.includes(piece.index) ? 'verified' : 'missing',
        size: piece.size,
        receivedBytes: verifiedPieces.includes(piece.index) ? piece.size : 0,
        retryCount: 0,
        updatedAt: 123 + piece.index
      }))
    }],
    peers: [
      { peerId: 'peer_owner_status' as PeerId, role: 'owner', updatedAt: 123 },
      { peerId: 'peer_receiver_status' as PeerId, role: 'receiver', updatedAt: 124 }
    ],
    updatedAt: 125
  };
}

function manifest(fileId: FileId, name: string, sizes: number[]): FileManifest {
  return {
    version: '1.0.0',
    fileId,
    name,
    size: sizes.reduce((sum, size) => sum + size, 0),
    mimeType: 'application/octet-stream',
    pieceSize: Math.max(...sizes),
    pieceCount: sizes.length,
    pieces: sizes.map((size, index) => ({
      index,
      offset: sizes.slice(0, index).reduce((sum, value) => sum + value, 0),
      size
    }))
  };
}

function storageKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

