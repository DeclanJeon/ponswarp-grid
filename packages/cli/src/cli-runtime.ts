import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PonsWarpEngine, type FileManifest, type PeerId, type SessionId, type TransferProgress } from '@ponswarp/core';
import { NodeFileStorageAdapter, openNodeFileSource, type NodeFileSource } from './node-file-storage.js';
import { NodePeerEndpointRegistry, NodeWebSocketTransport, type PeerEndpoint } from './node-websocket-transport.js';
import { BrowserSignalingClient, type SessionFileDescriptor } from '@ponswarp/signaling';
import type { CleanCommand, JoinCommand, SendCommand, StatusCommand } from './index.js';

export interface CliSessionDescriptor {
  schemaVersion: 1;
  sessionId: SessionId;
  ownerPeerId: PeerId;
  ownerEndpoint: PeerEndpoint;
  manifests: FileManifest[];
}

export interface CliPeerDescriptor {
  schemaVersion: 1;
  peerId: PeerId;
  endpoint: PeerEndpoint;
  fileId: FileManifest['fileId'];
  verifiedPieces: number[];
  totalPieces: number;
}

export function getCliStorageRoot(): string {
  const configured = process.env.PONSWARP_STORAGE_DIR?.trim();
  return configured && configured.length > 0 ? configured : join(process.cwd(), '.ponswarp-grid');
}

interface CliSessionStorageRecord {
  role: 'owner' | 'receiver';
  bucket: string;
  sessionDir: string;
  state: {
    sessionId: string;
    mode?: string;
    manifests?: Array<{ name?: string; size?: number; pieceCount?: number }>;
    pieceMaps?: Array<{ pieces?: Array<{ status?: string }> }>;
    updatedAt?: number;
  };
}

export async function runStatus(command: StatusCommand): Promise<void> {
  const records = await findSessionStorageRecords(command.session);
  if (records.length === 0) {
    console.log(`Session: ${command.session}`);
    console.log('Status: not_found');
    return;
  }

  console.log(`Session: ${command.session}`);
  console.log(`Status: found`);
  for (const record of records) {
    console.log(`Entry: ${record.role}/${record.bucket}`);
    console.log(`Path: ${record.sessionDir}`);
    console.log(`Mode: ${record.state.mode ?? 'unknown'}`);
    for (const manifest of record.state.manifests ?? []) {
      console.log(`File: ${manifest.name ?? 'unknown'} (${manifest.size ?? 0} bytes, ${manifest.pieceCount ?? 0} pieces)`);
    }
    for (const [index, map] of (record.state.pieceMaps ?? []).entries()) {
      const pieces = map.pieces ?? [];
      const verified = pieces.filter(piece => piece.status === 'verified').length;
      console.log(`Progress ${index + 1}: ${verified}/${pieces.length} verified`);
    }
    if (record.state.updatedAt) console.log(`Updated: ${new Date(record.state.updatedAt).toISOString()}`);
  }
}

export async function runClean(command: CleanCommand): Promise<void> {
  const records = await findSessionStorageRecords(command.session);
  for (const record of records) await rm(record.sessionDir, { recursive: true, force: true });
  console.log(`Session: ${command.session}`);
  console.log(`Cleaned: ${records.length}`);
}

async function findSessionStorageRecords(session: string): Promise<CliSessionStorageRecord[]> {
  if (!session || session === '.' || session === '..' || session.includes('/') || session.includes('\\')) throw new Error('session must be a single safe path segment');
  const storageRoot = getCliStorageRoot();
  const roots: Array<{ role: 'owner' | 'receiver'; path: string }> = [
    { role: 'owner', path: join(storageRoot, 'owners') },
    { role: 'receiver', path: join(storageRoot, 'receivers') }
  ];
  const records: CliSessionStorageRecord[] = [];
  for (const root of roots) {
    let buckets;
    try {
      buckets = await readdir(root.path, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const sessionDir = join(root.path, bucket.name, 'sessions', session);
      try {
        const state = parsePersistedCliSessionState(await readFile(join(sessionDir, 'state.json'), 'utf8'));
        records.push({ role: root.role, bucket: bucket.name, sessionDir, state });
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
    }
  }
  return records;
}

function parsePersistedCliSessionState(raw: string): CliSessionStorageRecord['state'] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('Invalid CLI session state: expected object');
  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
  const mode = typeof parsed.mode === 'string' ? parsed.mode : undefined;
  const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined;
  const manifests = Array.isArray(parsed.manifests)
    ? parsed.manifests.filter(isRecord).map(manifest => ({
      name: typeof manifest.name === 'string' ? manifest.name : undefined,
      size: typeof manifest.size === 'number' ? manifest.size : undefined,
      pieceCount: typeof manifest.pieceCount === 'number' ? manifest.pieceCount : undefined
    }))
    : undefined;
  const pieceMaps = Array.isArray(parsed.pieceMaps)
    ? parsed.pieceMaps.filter(isRecord).map(pieceMap => ({
      pieces: Array.isArray(pieceMap.pieces)
        ? pieceMap.pieces.filter(isRecord).map(piece => ({ status: typeof piece.status === 'string' ? piece.status : undefined }))
        : undefined
    }))
    : undefined;
  return { sessionId, mode, manifests, pieceMaps, updatedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}



export async function runSend(command: SendCommand): Promise<void> {
  const ownerPeerId = `peer_owner_${process.pid}` as PeerId;
  const registry = new NodePeerEndpointRegistry();
  const transport = new NodeWebSocketTransport({ selfId: ownerPeerId, host: parseListenHost(command.listen), port: parseListenPort(command.listen), registry });
  const ownerEndpoint = await transport.listen();
  let source: NodeFileSource | undefined;
  try {
    const storage = new NodeFileStorageAdapter({ rootDir: join(getCliStorageRoot(), 'owners', safeStorageKey(command.session ?? String(process.pid))) });
    const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
    source = await openNodeFileSource(command.file);
    const file = toBlobLikeFile(source);
    const session = await engine.createSession({
      sessionId: command.session as SessionId | undefined,
      files: [file],
      pieceSize: command.pieceSize,
      includeFileHash: source.size <= 256 * 1024 * 1024
    });
    const descriptor: CliSessionDescriptor = {
      schemaVersion: 1,
      sessionId: session.sessionId,
      ownerPeerId,
      ownerEndpoint: command.advertise ? { peerId: ownerPeerId, url: command.advertise } : ownerEndpoint,
      manifests: session.manifests
    };
    await bestEffortCreateSignalingRoom(command.signal, ownerPeerId, session.sessionId, session.manifests);
    console.log(`Session: ${session.sessionId}`);
    console.log(`Join: ${encodeJoinDescriptor(descriptor)}`);
    console.log(`Owner endpoint: ${descriptor.ownerEndpoint.url}`);
    console.log(`Serving ${session.manifests[0]?.name ?? command.file} with ${session.manifests[0]?.pieceCount ?? 0} pieces.`);
    await waitForShutdown(async () => {
      await source?.close();
      await transport.close();
    });
  } catch (error) {
    await source?.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw error;
  }
}

export async function runJoin(command: JoinCommand): Promise<number> {
  const descriptor = decodeJoinDescriptor(command.session);
  const receiverPeerId = `peer_receiver_${process.pid}` as PeerId;
  const registry = new NodePeerEndpointRegistry();
  registry.set(descriptor.ownerEndpoint);
  const transport = new NodeWebSocketTransport({ selfId: receiverPeerId, host: parseListenHost(command.listen), port: parseListenPort(command.listen), registry });
  const receiverEndpoint = await transport.listen();
  const storage = new NodeFileStorageAdapter({ rootDir: join(getCliStorageRoot(), 'receivers', safeStorageKey(`${descriptor.sessionId}:${command.outDir}`)) });
  const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
  await engine.joinSession(descriptor.sessionId, descriptor.manifests);
  const manifest = descriptor.manifests[0];
  if (!manifest) throw new Error('Join descriptor does not contain a file manifest');
  await mkdir(command.outDir, { recursive: true });
  const outputName = basename(manifest.name);
  const outputPath = join(command.outDir, outputName);
  const tempOutputPath = join(command.outDir, `.${outputName}.ponswarp-partial`);
  const activeOutputPath = command.seedAfterComplete ? outputPath : tempOutputPath;
  await storage.prepareOutputFile(manifest, activeOutputPath);
  await engine.resumeFile(manifest.fileId);
  await bestEffortJoinSignalingRoom(command.signal, descriptor.sessionId, receiverPeerId);
  const peerDescriptor = command.peer ? decodePeerDescriptor(command.peer) : undefined;
  if (peerDescriptor) {
    registry.set(peerDescriptor.endpoint);
    engine.updatePeerPieceMap(peerDescriptor.peerId, {
      type: 'PIECE_MAP',
      fileId: peerDescriptor.fileId,
      verifiedPieces: peerDescriptor.verifiedPieces,
      totalPieces: peerDescriptor.totalPieces,
      generation: 1,
      updatedAt: Date.now()
    });
    await transport.connect(peerDescriptor.peerId);
  }
  await transport.connect(descriptor.ownerPeerId);
  let progress = engine.getProgress(manifest.fileId);
  const providerPieces = new Map<string, number>();
  while (progress.verifiedPieces < progress.totalPieces) {
    const before = progress.verifiedPieces;
    let scheduledPeerId: PeerId;
    if (peerDescriptor) {
      const scheduled = await engine.requestNextGridPiece(manifest.fileId, { ownerPeerId: descriptor.ownerPeerId, candidatePeers: [peerDescriptor.peerId, descriptor.ownerPeerId] });
      if (scheduled.type !== 'scheduled') throw new Error(`No piece scheduled for CLI grid transfer: ${scheduled.reason}`);
      scheduledPeerId = scheduled.peerId;
    } else {
      const scheduled = await engine.requestNextPiece(descriptor.ownerPeerId, manifest.fileId);
      if (!scheduled) throw new Error('No piece scheduled for CLI direct transfer');
      scheduledPeerId = scheduled.peerId;
    }
    providerPieces.set(scheduledPeerId, (providerPieces.get(scheduledPeerId) ?? 0) + 1);
    progress = await waitForProgress(engine, manifest.fileId, before);
    renderProgress(progress);
  }
  try {
    const usage = await storage.getOutputStorageUsage(manifest.fileId);
    if (usage.mode !== 'offset' || usage.outputBytes !== manifest.size) {
      throw new Error(`Offset output storage was not prepared for ${manifest.name}`);
    }
    const completedPath = command.seedAfterComplete ? outputPath : tempOutputPath;
    if (manifest.fileHash) {
      const hash = createHash('sha256').update(await readFile(completedPath)).digest('hex');
      if (hash !== manifest.fileHash) throw new Error(`Final hash mismatch: expected ${manifest.fileHash}, got ${hash}`);
    }
    if (!command.seedAfterComplete) await rename(tempOutputPath, outputPath);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
  console.log(`Complete: ${outputName}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Verified: ${progress.verifiedPieces}/${progress.totalPieces}`);
  console.log(`Hash: ${manifest.fileHash ? 'verified' : 'piece-only'}`);
  for (const [peerId, count] of providerPieces) console.log(`Provider ${peerId}: ${count} pieces`);
  const nonOwnerPieces = [...providerPieces].filter(([peerId]) => peerId !== descriptor.ownerPeerId).reduce((sum, [, count]) => sum + count, 0);
  console.log(`Non-owner provider pieces: ${nonOwnerPieces}`);
  if (command.seedAfterComplete) {
    console.log(`Peer: ${encodePeerDescriptor({
      schemaVersion: 1,
      peerId: receiverPeerId,
      endpoint: command.advertise ? { peerId: receiverPeerId, url: command.advertise } : receiverEndpoint,
      fileId: manifest.fileId,
      verifiedPieces: manifest.pieces.map(piece => piece.index),
      totalPieces: manifest.pieceCount
    })}`);
    await waitForShutdown(async () => transport.close());
  }
  await transport.close();
  return 0;
}

export function encodeJoinDescriptor(descriptor: CliSessionDescriptor): string {
  return `ponswarp://join/${Buffer.from(JSON.stringify(descriptor)).toString('base64url')}`;
}

export function encodePeerDescriptor(descriptor: CliPeerDescriptor): string {
  return `ponswarp-peer://${Buffer.from(JSON.stringify(descriptor)).toString('base64url')}`;
}

export function decodePeerDescriptor(value: string): CliPeerDescriptor {
  const encoded = value.startsWith('ponswarp-peer://') ? value.slice('ponswarp-peer://'.length) : value;
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CliPeerDescriptor;
  if (parsed.schemaVersion !== 1 || !parsed.peerId || !parsed.endpoint?.url || !parsed.fileId || !Array.isArray(parsed.verifiedPieces)) {
    throw new Error('Invalid ponswarp peer descriptor');
  }
  return parsed;
}

export function decodeJoinDescriptor(value: string): CliSessionDescriptor {
  const encoded = value.startsWith('ponswarp://join/') ? value.slice('ponswarp://join/'.length) : value;
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CliSessionDescriptor;
  if (parsed.schemaVersion !== 1 || !parsed.sessionId || !parsed.ownerPeerId || !parsed.ownerEndpoint?.url || !Array.isArray(parsed.manifests)) {
    throw new Error('Invalid ponswarp join descriptor');
  }
  return parsed;
}

function toBlobLikeFile(source: NodeFileSource): Blob & { name: string; type: string } {
  return {
    name: source.name,
    type: source.type,
    size: source.size,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return source.readPiece(0, source.size);
    },
    slice(start = 0, end = source.size): Blob {
      const offset = Math.max(0, Number(start));
      const boundedEnd = Math.min(source.size, Math.max(offset, Number(end)));
      const length = boundedEnd - offset;
      return {
        size: length,
        type: source.type,
        async arrayBuffer(): Promise<ArrayBuffer> {
          return source.readPiece(offset, length);
        }
      } as Blob;
    }
  } as Blob & { name: string; type: string };
}

function parseListenHost(listen: string): string {
  return listen.split(':')[0] || '127.0.0.1';
}

function parseListenPort(listen: string): number {
  const raw = listen.split(':')[1] ?? '0';
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid listen port: ${listen}`);
  return port;
}

function safeStorageKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

async function bestEffortCreateSignalingRoom(signalUrl: string, ownerPeerId: PeerId, sessionId: SessionId, files: SessionFileDescriptor[]): Promise<void> {
  await withTimeout(async () => {
    const client = new BrowserSignalingClient({ url: resolveSignalUrl(signalUrl), reconnectDelaysMs: [] });
    await client.connect();
    client.createSession({ sessionId, ownerPeerId, files, mode: 'grid' });
    await client.close();
  }, 250).catch(() => undefined);
}

function resolveSignalUrl(signalUrl: string): string {
  if (signalUrl !== 'auto') return signalUrl;
  const coordinator = process.env.PONSWARP_COORDINATOR_URL ?? 'https://grid.ponslink.com';
  const url = new URL('/ws', coordinator);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function bestEffortJoinSignalingRoom(signalUrl: string, sessionId: SessionId, peerId: PeerId): Promise<void> {
  await withTimeout(async () => {
    const client = new BrowserSignalingClient({ url: resolveSignalUrl(signalUrl), reconnectDelaysMs: [] });
    await client.connect();
    client.joinSession({ sessionId, peerId, role: 'receiver' });
    await client.close();
  }, 250).catch(() => undefined);
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const PIECE_PROGRESS_TIMEOUT_MS = 300_000;

function waitForProgress(engine: PonsWarpEngine, fileId: FileManifest['fileId'], before: number): Promise<TransferProgress> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for piece progress'));
    }, PIECE_PROGRESS_TIMEOUT_MS);
    const unsubscribe = engine.on('progress', progress => {
      if (progress.verifiedPieces > before) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(progress);
      }
    });
    const current = engine.getProgress(fileId);
    if (current.verifiedPieces > before) {
      clearTimeout(timeout);
      unsubscribe();
      resolve(current);
    }
  });
}

function renderProgress(progress: TransferProgress): void {
  const percent = progress.totalPieces === 0 ? 100 : (progress.verifiedPieces / progress.totalPieces) * 100;
  console.log(`Progress: ${progress.verifiedPieces}/${progress.totalPieces} pieces (${percent.toFixed(1)}%)`);
}

async function waitForShutdown(close: () => Promise<void>): Promise<never> {
  return new Promise<never>(() => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      void close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
