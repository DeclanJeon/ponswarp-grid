import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { PonsWarpEngine, type FileManifest, type PeerId, type SessionId, type TransferProgress } from '@ponswarp/core';
import { NodeFileStorageAdapter } from './node-file-storage.js';
import { NodePeerEndpointRegistry, NodeWebSocketTransport, type PeerEndpoint } from './node-websocket-transport.js';
import { BrowserSignalingClient, type SessionFileDescriptor } from '@ponswarp/signaling';
import type { JoinCommand, SendCommand } from './index.js';

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

export async function runSend(command: SendCommand): Promise<void> {
  const ownerPeerId = `peer_owner_${process.pid}` as PeerId;
  const registry = new NodePeerEndpointRegistry();
  const transport = new NodeWebSocketTransport({ selfId: ownerPeerId, host: parseListenHost(command.listen), port: parseListenPort(command.listen), registry });
  const ownerEndpoint = await transport.listen();
  const storage = new NodeFileStorageAdapter({ rootDir: join(process.cwd(), '.ponswarp-grid', 'owners', safeStorageKey(command.session ?? String(process.pid))) });
  const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
  const fileBytes = await readFile(command.file);
  const file = new Blob([fileBytes], { type: 'application/octet-stream' }) as Blob & { name: string; type: string };
  Object.defineProperty(file, 'name', { value: basename(command.file) });
  const session = await engine.createSession({
    sessionId: command.session as SessionId | undefined,
    files: [file],
    pieceSize: command.pieceSize,
    includeFileHash: true
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
  await waitForShutdown(async () => transport.close());
}

export async function runJoin(command: JoinCommand): Promise<number> {
  const descriptor = decodeJoinDescriptor(command.session);
  const receiverPeerId = `peer_receiver_${process.pid}` as PeerId;
  const registry = new NodePeerEndpointRegistry();
  registry.set(descriptor.ownerEndpoint);
  const transport = new NodeWebSocketTransport({ selfId: receiverPeerId, host: parseListenHost(command.listen), port: parseListenPort(command.listen), registry });
  const receiverEndpoint = await transport.listen();
  const storage = new NodeFileStorageAdapter({ rootDir: join(process.cwd(), '.ponswarp-grid', 'receivers', safeStorageKey(`${descriptor.sessionId}:${command.outDir}`)) });
  const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
  await engine.joinSession(descriptor.sessionId, descriptor.manifests);
  const manifest = descriptor.manifests[0];
  if (!manifest) throw new Error('Join descriptor does not contain a file manifest');
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
  await mkdir(command.outDir, { recursive: true });
  const outputName = basename(manifest.name);
  const outputPath = join(command.outDir, outputName);
  const tempOutputPath = join(command.outDir, `.${outputName}.${process.pid}.${Date.now()}.tmp`);
  try {
    const sink = Writable.toWeb(createWriteStream(tempOutputPath, { flags: 'wx' })) as WritableStream<Uint8Array>;
    await storage.saveAssembledFile(manifest.fileId, manifest, sink);
    if (manifest.fileHash) {
      const hash = createHash('sha256').update(await readFile(tempOutputPath)).digest('hex');
      if (hash !== manifest.fileHash) throw new Error(`Final hash mismatch: expected ${manifest.fileHash}, got ${hash}`);
    }
    await rename(tempOutputPath, outputPath);
  } catch (error) {
    await rm(tempOutputPath, { force: true });
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
    const client = new BrowserSignalingClient({ url: signalUrl, reconnectDelaysMs: [] });
    await client.connect();
    client.createSession({ sessionId, ownerPeerId, files, mode: 'grid' });
    await client.close();
  }, 250).catch(() => undefined);
}

async function bestEffortJoinSignalingRoom(signalUrl: string, sessionId: SessionId, peerId: PeerId): Promise<void> {
  await withTimeout(async () => {
    const client = new BrowserSignalingClient({ url: signalUrl, reconnectDelaysMs: [] });
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

function waitForProgress(engine: PonsWarpEngine, fileId: FileManifest['fileId'], before: number): Promise<TransferProgress> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for piece progress'));
    }, 10_000);
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
