import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { FileId, FileManifest, PersistedSessionState, SessionId } from '@ponswarp/core';
import { NodeFileStorageAdapter, openNodeFileSource } from '../src/node-file-storage';

const sessionId = 'sess_node_storage' as SessionId;
const fileId = 'file_node_storage' as FileId;

function manifest(sizes: number[]): FileManifest {
  return {
    version: '1.0.0',
    fileId,
    name: 'demo.bin',
    size: sizes.reduce((sum, size) => sum + size, 0),
    mimeType: 'application/octet-stream',
    pieceSize: Math.max(...sizes),
    pieceCount: sizes.length,
    pieces: sizes.map((size, index) => ({ index, offset: sizes.slice(0, index).reduce((sum, value) => sum + value, 0), size }))
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ponswarp-cli-storage-'));
}

describe('NodeFileStorageAdapter', () => {
  it('writes, reads, detects, and deletes pieces atomically', async () => {
    const root = await tempRoot();
    try {
      const storage = new NodeFileStorageAdapter({ rootDir: root });
      await storage.init(sessionId);
      const data = new Uint8Array([1, 2, 3, 4]).buffer;
      await storage.writePiece(fileId, 0, data);
      expect(await storage.hasPiece(fileId, 0)).toBe(true);
      expect(Array.from(new Uint8Array((await storage.readPiece(fileId, 0))!))).toEqual([1, 2, 3, 4]);
      await storage.deletePiece(fileId, 0);
      expect(await storage.hasPiece(fileId, 0)).toBe(false);
      expect(await storage.readPiece(fileId, 0)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('saves and loads persisted session state', async () => {
    const root = await tempRoot();
    try {
      const storage = new NodeFileStorageAdapter({ rootDir: root });
      await storage.init(sessionId);
      const state: PersistedSessionState = {
        schemaVersion: 1,
        protocolVersion: 'ponswarp-grid/1.0.0',
        sessionId,
        mode: 'grid',
        manifests: [manifest([2])],
        pieceMaps: [],
        peers: [],
        updatedAt: 123
      };
      await storage.saveState(state);
      expect(await storage.loadState(sessionId)).toMatchObject({ sessionId, mode: 'grid', updatedAt: 123 });
      expect(await storage.loadState('sess_missing' as SessionId)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('streams final assembly without requiring Blob assembly', async () => {
    const root = await tempRoot();
    try {
      const storage = new NodeFileStorageAdapter({ rootDir: root, safeAssembleBytes: 4 });
      await storage.init(sessionId);
      await storage.writePiece(fileId, 0, new Uint8Array([1, 2, 3]).buffer);
      await storage.writePiece(fileId, 1, new Uint8Array([4, 5, 6]).buffer);
      const chunks: Buffer[] = [];
      const sink = Writable.toWeb(new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk as Uint8Array));
          callback();
        }
      })) as WritableStream<Uint8Array>;
      const result = await storage.saveAssembledFile(fileId, manifest([3, 3]), sink);
      expect(result).toEqual({ type: 'stream', bytes: 6 });
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
      await expect(storage.assembleFile(fileId, manifest([3, 3]))).rejects.toThrow(/safe Blob/);
      await expect(storage.saveAssembledFile(fileId, manifest([3, 3]))).resolves.toMatchObject({ type: 'unsupported' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes verified pieces directly into output offsets and seeds from output', async () => {
    const root = await tempRoot();
    try {
      const storage = new NodeFileStorageAdapter({ rootDir: root });
      await storage.init(sessionId);
      const target = join(root, 'download.bin');
      const testManifest = manifest([3, 2, 4]);
      await storage.prepareOutputFile(testManifest, target);
      await storage.writePiece(fileId, 2, new Uint8Array([6, 7, 8, 9]).buffer);
      await storage.writePiece(fileId, 0, new Uint8Array([1, 2, 3]).buffer);

      expect(await storage.hasPiece(fileId, 0)).toBe(true);
      expect(await storage.hasPiece(fileId, 1)).toBe(false);
      expect(await storage.hasPiece(fileId, 2)).toBe(true);
      expect(Array.from(new Uint8Array((await storage.readPiece(fileId, 2))!))).toEqual([6, 7, 8, 9]);

      const output = await readFile(target);
      expect(Array.from(output.subarray(0, 3))).toEqual([1, 2, 3]);
      expect(Array.from(output.subarray(3, 5))).toEqual([0, 0]);
      expect(Array.from(output.subarray(5, 9))).toEqual([6, 7, 8, 9]);

      const usage = await storage.getOutputStorageUsage(fileId);
      expect(usage).toMatchObject({ mode: 'offset', outputBytes: 9, verifiedPieces: 2, totalPieces: 3 });
      await expect(stat(join(root, 'sessions', sessionId, 'pieces', fileId, '000000.part'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores verified bitmap for offset output resume', async () => {
    const root = await tempRoot();
    try {
      const target = join(root, 'download.bin');
      const testManifest = manifest([2, 2]);
      const first = new NodeFileStorageAdapter({ rootDir: root });
      await first.init(sessionId);
      await first.prepareOutputFile(testManifest, target);
      await first.writePiece(fileId, 1, new Uint8Array([3, 4]).buffer);

      const resumed = new NodeFileStorageAdapter({ rootDir: root });
      await resumed.init(sessionId);
      await resumed.prepareOutputFile(testManifest, target);
      expect(await resumed.hasPiece(fileId, 0)).toBe(false);
      expect(await resumed.hasPiece(fileId, 1)).toBe(true);
      expect(Array.from(new Uint8Array((await resumed.readPiece(fileId, 1))!))).toEqual([3, 4]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not restore bitmap when manifest piece layout changes', async () => {
    const root = await tempRoot();
    try {
      const target = join(root, 'download.bin');
      const firstManifest = manifest([2, 2]);
      const changedManifest = manifest([1, 3]);
      const first = new NodeFileStorageAdapter({ rootDir: root });
      await first.init(sessionId);
      await first.prepareOutputFile(firstManifest, target);
      await first.writePiece(fileId, 1, new Uint8Array([3, 4]).buffer);

      const resumed = new NodeFileStorageAdapter({ rootDir: root });
      await resumed.init(sessionId);
      await resumed.prepareOutputFile(changedManifest, target);
      expect(await resumed.hasPiece(fileId, 1)).toBe(false);
      expect(await resumed.readPiece(fileId, 1)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans session directories', async () => {
    const root = await tempRoot();
    const storage = new NodeFileStorageAdapter({ rootDir: root });
    await storage.init(sessionId);
    await storage.writePiece(fileId, 0, new Uint8Array([1]).buffer);
    await storage.cleanup(sessionId);
    expect(await storage.loadState(sessionId)).toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects path traversal identifiers before filesystem mutation', async () => {
    const root = await tempRoot();
    try {
      const storage = new NodeFileStorageAdapter({ rootDir: root });
      await expect(storage.init('../outside' as SessionId)).rejects.toThrow(/safe path segment/);
      await storage.init(sessionId);
      await expect(storage.writePiece('../file' as FileId, 0, new Uint8Array([1]).buffer)).rejects.toThrow(/safe path segment/);
      await expect(storage.cleanup('../outside' as SessionId)).rejects.toThrow(/safe path segment/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('openNodeFileSource', () => {
  it('reads bounded pieces from a disk file', async () => {
    const root = await tempRoot();
    try {
      const path = join(root, 'source.bin');
      await writeFile(path, Buffer.from([9, 8, 7, 6, 5]));
      const source = await openNodeFileSource(path);
      try {
        expect(source.name).toBe('source.bin');
        expect(source.size).toBe(5);
        expect(Array.from(new Uint8Array(await source.readPiece(1, 3)))).toEqual([8, 7, 6]);
        expect(Array.from(new Uint8Array(await source.readPiece(3, 99)))).toEqual([6, 5]);
        expect(Array.from(new Uint8Array(await source.readPiece(999, 1024 * 1024 * 1024)))).toEqual([]);
      } finally {
        await source.close();
      }
      expect(await readFile(path)).toEqual(Buffer.from([9, 8, 7, 6, 5]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
