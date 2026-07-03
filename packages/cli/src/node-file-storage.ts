import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { FileId, FileManifest, PersistedSessionState, SaveFileResult, SessionId, StorageAdapter } from '@ponswarp/core';

const STATE_FILE = 'state.json';
const TMP_SUFFIX = '.tmp';

export interface NodeFileStorageOptions {
  rootDir?: string;
  safeAssembleBytes?: number;
}

export interface NodeFileSource {
  path: string;
  name: string;
  type: string;
  size: number;
  readPiece(offset: number, size: number): Promise<ArrayBuffer>;
  close(): Promise<void>;
}

export interface SaveAssembledFileOptions {
  deletePiecesAfterWrite?: boolean;
}

export interface OffsetOutputState {
  schemaVersion: 1;
  fileId: FileId;
  manifestSize: number;
  pieceSize: number;
  pieceCount: number;
  outputPath: string;
  pieceLayoutHash: string;
  verifiedPieces: number[];
  updatedAt: number;
}

export interface OutputStorageUsage {
  mode: 'piece-cache' | 'offset';
  outputBytes: number;
  verifiedPieces: number;
  totalPieces: number;
}

export class NodeFileStorageAdapter implements StorageAdapter {
  private sessionId: SessionId | null = null;
  private readonly rootDir: string;
  private readonly safeAssembleBytes: number;
  private readonly offsetOutputs = new Map<FileId, { manifest: FileManifest; outputPath: string; verifiedPieces: Set<number> }>();

  constructor(options: NodeFileStorageOptions = {}) {
    this.rootDir = options.rootDir ?? join(process.cwd(), '.ponswarp-grid');
    this.safeAssembleBytes = options.safeAssembleBytes ?? 256 * 1024 * 1024;
  }

  async init(sessionId: SessionId): Promise<void> {
    this.sessionId = sanitizePathSegment(sessionId, 'sessionId') as SessionId;
    await mkdir(this.sessionDir(), { recursive: true });
    await mkdir(join(this.sessionDir(), 'pieces'), { recursive: true });
    await mkdir(join(this.sessionDir(), 'output'), { recursive: true });
  }

  async writePiece(fileId: FileId, pieceIndex: number, data: ArrayBuffer): Promise<void> {
    const offsetOutput = this.offsetOutputs.get(fileId);
    if (offsetOutput) {
      const piece = offsetOutput.manifest.pieces.find(candidate => candidate.index === pieceIndex);
      if (!piece) throw new Error(`Unknown piece ${pieceIndex} for ${offsetOutput.manifest.name}`);
      if (data.byteLength !== piece.size) throw new Error(`Piece ${pieceIndex} size mismatch: expected ${piece.size}, got ${data.byteLength}`);
      const handle = await open(offsetOutput.outputPath, 'r+');
      try {
        await handle.write(Buffer.from(data), 0, data.byteLength, piece.offset);
      } finally {
        await handle.close();
      }
      offsetOutput.verifiedPieces.add(pieceIndex);
      await this.saveOffsetOutputState(fileId);
      return;
    }

    const path = this.piecePath(fileId, pieceIndex);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}${TMP_SUFFIX}`;
    await writeFile(tmp, Buffer.from(data));
    await rename(tmp, path);
  }

  async readPiece(fileId: FileId, pieceIndex: number): Promise<ArrayBuffer | undefined> {
    const offsetOutput = this.offsetOutputs.get(fileId);
    if (offsetOutput) {
      if (!offsetOutput.verifiedPieces.has(pieceIndex)) return undefined;
      const piece = offsetOutput.manifest.pieces.find(candidate => candidate.index === pieceIndex);
      if (!piece) return undefined;
      const handle = await open(offsetOutput.outputPath, 'r');
      try {
        const buffer = Buffer.alloc(piece.size);
        const result = await handle.read(buffer, 0, piece.size, piece.offset);
        return toArrayBuffer(result.bytesRead === piece.size ? buffer : buffer.subarray(0, result.bytesRead));
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      } finally {
        await handle.close();
      }
    }

    try {
      const data = await readFile(this.piecePath(fileId, pieceIndex));
      return toArrayBuffer(data);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async hasPiece(fileId: FileId, pieceIndex: number): Promise<boolean> {
    const offsetOutput = this.offsetOutputs.get(fileId);
    if (offsetOutput) return offsetOutput.verifiedPieces.has(pieceIndex);

    try {
      await stat(this.piecePath(fileId, pieceIndex));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async deletePiece(fileId: FileId, pieceIndex: number): Promise<void> {
    const offsetOutput = this.offsetOutputs.get(fileId);
    if (offsetOutput) {
      offsetOutput.verifiedPieces.delete(pieceIndex);
      await this.saveOffsetOutputState(fileId);
      return;
    }

    await rm(this.piecePath(fileId, pieceIndex), { force: true });
  }

  async saveState(state: PersistedSessionState): Promise<void> {
    await mkdir(this.sessionDir(), { recursive: true });
    const path = join(this.sessionDir(), STATE_FILE);
    const tmp = `${path}.${process.pid}.${randomUUID()}${TMP_SUFFIX}`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, path);
  }

  async loadState(sessionId: SessionId): Promise<PersistedSessionState | null> {
    const previousSession = this.sessionId;
    this.sessionId = sanitizePathSegment(sessionId, 'sessionId') as SessionId;
    try {
      const data = await readFile(join(this.sessionDir(), STATE_FILE), 'utf8');
      return JSON.parse(data) as PersistedSessionState;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    } finally {
      this.sessionId = previousSession ?? sessionId;
    }
  }

  async prepareOutputFile(manifest: FileManifest, outputPath: string): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    const handle = await open(outputPath, 'a+');
    try {
      await handle.truncate(manifest.size);
    } finally {
      await handle.close();
    }

    const saved = await this.loadOffsetOutputState(manifest.fileId);
    const pieceLayoutHash = hashPieceLayout(manifest);
    const verifiedPieces = saved && saved.outputPath === outputPath && saved.manifestSize === manifest.size && saved.pieceSize === manifest.pieceSize && saved.pieceCount === manifest.pieceCount && saved.pieceLayoutHash === pieceLayoutHash
      ? new Set(saved.verifiedPieces)
      : new Set<number>();
    this.offsetOutputs.set(manifest.fileId, { manifest, outputPath, verifiedPieces });
    await this.saveOffsetOutputState(manifest.fileId);
  }

  async getOutputStorageUsage(fileId: FileId): Promise<OutputStorageUsage> {
    const offsetOutput = this.offsetOutputs.get(fileId);
    if (offsetOutput) {
      const info = await stat(offsetOutput.outputPath);
      return {
        mode: 'offset',
        outputBytes: info.size,
        verifiedPieces: offsetOutput.verifiedPieces.size,
        totalPieces: offsetOutput.manifest.pieceCount
      };
    }

    return { mode: 'piece-cache', outputBytes: 0, verifiedPieces: 0, totalPieces: 0 };
  }

  async assembleFile(fileId: FileId, manifest: FileManifest): Promise<Blob> {
    if (manifest.size > this.safeAssembleBytes) throw new Error('File exceeds safe Blob assembly threshold; pass a WritableStream sink to saveAssembledFile');
    const parts: BlobPart[] = [];
    for (const piece of manifest.pieces) {
      const data = await this.readPiece(fileId, piece.index);
      if (!data) throw new Error(`Missing piece ${piece.index} for ${manifest.name}`);
      parts.push(data);
    }
    return new Blob(parts, { type: manifest.mimeType });
  }

  createReadablePieceStream(fileId: FileId, manifest: FileManifest): ReadableStream<Uint8Array> {
    let nextPiece = 0;
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        if (nextPiece >= manifest.pieces.length) {
          controller.close();
          return;
        }
        const piece = manifest.pieces[nextPiece++];
        const data = await this.readPiece(fileId, piece.index);
        if (!data) throw new Error(`Missing piece ${piece.index} for ${manifest.name}`);
        controller.enqueue(new Uint8Array(data));
      }
    });
  }

  async saveAssembledFile(fileId: FileId, manifest: FileManifest, sink?: WritableStream<Uint8Array>, options: SaveAssembledFileOptions = {}): Promise<SaveFileResult> {
    if (sink) {
      const writer = sink.getWriter();
      try {
        for (const piece of manifest.pieces) {
          const data = await this.readPiece(fileId, piece.index);
          if (!data) throw new Error(`Missing piece ${piece.index} for ${manifest.name}`);
          await writer.write(new Uint8Array(data));
          if (options.deletePiecesAfterWrite) await this.deletePiece(fileId, piece.index);
        }
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => undefined);
        throw error;
      }
      return { type: 'stream', bytes: manifest.size };
    }
    if (manifest.size > this.safeAssembleBytes) return { type: 'unsupported', reason: 'file exceeds safe Blob assembly threshold' };
    const blob = await this.assembleFile(fileId, manifest);
    return { type: 'blob', blob, bytes: blob.size };
  }

  async cleanup(sessionId: SessionId): Promise<void> {
    const previousSession = this.sessionId;
    this.sessionId = sanitizePathSegment(sessionId, 'sessionId') as SessionId;
    try {
      await rm(this.sessionDir(), { recursive: true, force: true });
    } finally {
      this.sessionId = previousSession;
    }
  }

  outputPath(fileName: string): string {
    return join(this.sessionDir(), 'output', basename(fileName));
  }

  private sessionDir(): string {
    if (!this.sessionId) throw new Error('NodeFileStorageAdapter.init(sessionId) must be called first');
    return join(this.rootDir, 'sessions', sanitizePathSegment(this.sessionId, 'sessionId'));
  }

  private piecePath(fileId: FileId, pieceIndex: number): string {
    const padded = String(pieceIndex).padStart(6, '0');
    return join(this.sessionDir(), 'pieces', sanitizePathSegment(fileId, 'fileId'), `${padded}.part`);
  }

  private offsetStatePath(fileId: FileId): string {
    return join(this.sessionDir(), 'output', `${sanitizePathSegment(fileId, 'fileId')}.offset-state.json`);
  }

  private async loadOffsetOutputState(fileId: FileId): Promise<OffsetOutputState | null> {
    try {
      const data = await readFile(this.offsetStatePath(fileId), 'utf8');
      const parsed = JSON.parse(data) as OffsetOutputState;
      return parsed.schemaVersion === 1 ? parsed : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async saveOffsetOutputState(fileId: FileId): Promise<void> {
    const offsetOutput = this.offsetOutputs.get(fileId);
    if (!offsetOutput) return;
    await mkdir(dirname(this.offsetStatePath(fileId)), { recursive: true });
    const state: OffsetOutputState = {
      schemaVersion: 1,
      fileId,
      manifestSize: offsetOutput.manifest.size,
      pieceSize: offsetOutput.manifest.pieceSize,
      pieceCount: offsetOutput.manifest.pieceCount,
      pieceLayoutHash: hashPieceLayout(offsetOutput.manifest),
      outputPath: offsetOutput.outputPath,
      verifiedPieces: [...offsetOutput.verifiedPieces].sort((a, b) => a - b),
      updatedAt: Date.now()
    };
    const path = this.offsetStatePath(fileId);
    const tmp = `${path}.${process.pid}.${randomUUID()}${TMP_SUFFIX}`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, path);
  }
}

export async function openNodeFileSource(path: string, type = 'application/octet-stream'): Promise<NodeFileSource> {
  const handle = await open(path, 'r');
  const info = await handle.stat();
  return {
    path,
    name: basename(path),
    type,
    size: info.size,
    async readPiece(offset: number, size: number): Promise<ArrayBuffer> {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative safe integer');
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('size must be a non-negative safe integer');
      const remaining = Math.max(0, info.size - offset);
      const boundedSize = Math.min(size, remaining);
      const buffer = Buffer.alloc(boundedSize);
      const result = await handle.read(buffer, 0, boundedSize, offset);
      return toArrayBuffer(result.bytesRead === boundedSize ? buffer : buffer.subarray(0, result.bytesRead));
    },
    async close(): Promise<void> {
      await handle.close();
    }
  };
}

export function toArrayBuffer(buffer: Buffer | Uint8Array): ArrayBuffer {
  return new Uint8Array(buffer).slice().buffer;
}

function sanitizePathSegment(value: string, name: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error(`${name} must be a single safe path segment`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function hashPieceLayout(manifest: FileManifest): string {
  const hash = createHash('sha256');
  for (const piece of manifest.pieces) hash.update(`${piece.index}:${piece.offset}:${piece.size};`);
  return hash.digest('hex');
}
