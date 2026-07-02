import { describe, expect, it } from 'vitest';
import {
  CORE_PROTOCOL_VERSION,
  EventBus,
  IntegrityChecker,
  ManifestGenerator,
  createBrowserStorageAdapter,
  PonsWarpEngine,
  MemoryStorageAdapter,
  OwnerFirstScheduler,
  PieceManager,
  calculateProgressPercent,
  createPieceDescriptors,
  PieceAvailabilityTable,
  PeerHealthTable,
  restoreResumeState,
  validatePersistedSessionState,
  type BinaryFrame,
  type Transport,
  type TransportMessage,
  type FileId,
  type PeerId,
  type SessionId
} from '../src/index';

const fileId = 'file_1' as FileId;
const sessionId = 'sess_1' as SessionId;
const ownerPeerId = 'peer_owner' as PeerId;

class FakeTransport implements Transport {
  private readonly messageHandlers = new Set<(peerId: PeerId, message: TransportMessage) => void>();
  private readonly binaryHandlers = new Set<(peerId: PeerId, frame: ArrayBuffer) => void>();
  private readonly peers = new Map<PeerId, FakeTransport>();
  readonly sentMessages: TransportMessage[] = [];
  readonly sentBinary: ArrayBuffer[] = [];

  constructor(readonly selfId: PeerId) {}

  link(peerId: PeerId, peer: FakeTransport): void {
    this.peers.set(peerId, peer);
  }

  async connect(): Promise<void> {}

  async send(peerId: PeerId, message: TransportMessage): Promise<void> {
    this.sentMessages.push(message);
    this.peers.get(peerId)?.emitMessage(this.selfId, message);
  }

  async sendBinary(peerId: PeerId, frame: BinaryFrame): Promise<void> {
    const buffer = frame instanceof ArrayBuffer ? frame : frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    this.sentBinary.push(buffer);
    this.peers.get(peerId)?.emitBinary(this.selfId, buffer);
  }

  onMessage(handler: (peerId: PeerId, message: TransportMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onBinary(handler: (peerId: PeerId, frame: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  async close(): Promise<void> {}

  private emitMessage(peerId: PeerId, message: TransportMessage): void {
    this.messageHandlers.forEach(handler => handler(peerId, message));
  }

  private emitBinary(peerId: PeerId, frame: ArrayBuffer): void {
    this.binaryHandlers.forEach(handler => handler(peerId, frame));
  }
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

describe('workspace bootstrap core reuse', () => {
  it('calculates progress with clamping semantics reused from PonsWarp', () => {
    expect(calculateProgressPercent(512, 1024)).toBe(50);
    expect(calculateProgressPercent(2048, 1024)).toBe(100);
    expect(calculateProgressPercent(1, 0)).toBe(0);
  });

  it('creates exact piece descriptors including trailing piece', () => {
    const pieces = createPieceDescriptors(10 * 1024 * 1024 + 123, 1024 * 1024);
    expect(pieces).toHaveLength(11);
    expect(pieces.at(-1)).toMatchObject({ index: 10, offset: 10 * 1024 * 1024, size: 123 });
  });

  it('supports typed subscribe, emit, and unsubscribe', () => {
    const bus = new EventBus<{ progress: { value: number } }>();
    const values: number[] = [];
    const unsubscribe = bus.on('progress', event => values.push(event.value));
    bus.emit('progress', { value: 1 });
    unsubscribe();
    bus.emit('progress', { value: 2 });
    expect(values).toEqual([1]);
  });
});

describe('core engine foundations', () => {
  it('hashes and verifies pieces deterministically', async () => {
    const checker = new IntegrityChecker();
    const data = new TextEncoder().encode('ponswarp').buffer;
    const hash = await checker.hash(data);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await checker.verifyPiece(data, { index: 0, offset: 0, size: data.byteLength, hash })).toBe(true);
    expect(await checker.verifyPiece(new TextEncoder().encode('wrong').buffer, { index: 0, offset: 0, size: data.byteLength, hash })).toBe(false);
  });

  it('generates manifests with piece hashes and optional file hash', async () => {
    const blob = new Blob(['abcde'], { type: 'text/plain' }) as Blob & { name?: string };
    blob.name = 'demo.txt';
    const manifest = await new ManifestGenerator().create(blob, { pieceSize: 2, includeFileHash: true, fileId });
    expect(manifest).toMatchObject({ fileId, name: 'demo.txt', size: 5, mimeType: 'text/plain', pieceSize: 2, pieceCount: 3 });
    expect(manifest.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.pieces.map(piece => piece.size)).toEqual([2, 2, 1]);
    expect(manifest.pieces.every(piece => piece.hash?.match(/^[a-f0-9]{64}$/))).toBe(true);
  });

  it('uses piece-only large-file hash policy and emits hash progress without whole-file allocation', async () => {
    const events: string[] = [];
    const manifest = await new ManifestGenerator().create(new Blob(['abcdef']), {
      pieceSize: 2,
      fileId,
      fileHashPolicy: { mode: 'piece-only' },
      onPerformance: event => {
        if (event.type === 'hash:progress') events.push(`${event.bytesProcessed}/${event.totalBytes}`);
      }
    });
    expect(manifest.fileHash).toBeUndefined();
    expect(manifest.fileHashUnavailableReason).toBe('piece-only policy');
    expect(events).toEqual(['2/6', '4/6', '6/6']);
  });

  it('tracks piece state, progress, retries, and resumable piece maps', () => {
    let now = 100;
    const manager = new PieceManager(fileId, createPieceDescriptors(5, 2), () => now++);
    manager.markRequested(0, ownerPeerId);
    manager.markReceiving(0, 1);
    manager.markReceived(0);
    manager.markVerified(0);
    manager.markFailed(1, 'hash mismatch');

    expect(manager.getVerifiedPieces()).toEqual([0]);
    expect(manager.getMissingPieces()).toEqual([1, 2]);
    expect(manager.getPieceState(1).retryCount).toBe(1);
    expect(manager.getProgress()).toMatchObject({ verifiedPieces: 1, totalPieces: 3, bytesTransferred: 2, totalBytes: 5, progress: 40 });

    const exported = manager.exportPieceMap();
    const restored = new PieceManager(fileId, createPieceDescriptors(5, 2), () => now++);
    restored.importPieceMap({
      ...exported,
      pieces: exported.pieces.map(piece => piece.index === 2 ? { ...piece, status: 'receiving', receivedBytes: 1 } : piece)
    });
    expect(restored.getPieceState(0).status).toBe('verified');
    expect(restored.getPieceState(2).status).toBe('missing');
  });

  it('schedules owner-first missing pieces and respects retry limits', () => {
    const manager = new PieceManager(fileId, createPieceDescriptors(5, 2));
    manager.markVerified(0);
    manager.markFailed(1, 'first');
    manager.markFailed(1, 'second');
    const scheduler = new OwnerFirstScheduler(ownerPeerId, 1);
    expect(scheduler.next(manager)).toMatchObject({ peerId: ownerPeerId, piece: { index: 2 } });
  });

  it('stores pieces, session state, and assembled files with defensive copies', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init(sessionId);
    const pieces = createPieceDescriptors(3, 2);
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3]);

    await storage.writePiece(fileId, 0, first.buffer);
    await storage.writePiece(fileId, 1, second.buffer);
    first[0] = 9;

    expect([...(new Uint8Array((await storage.readPiece(fileId, 0))!))]).toEqual([1, 2]);
    expect(await storage.hasPiece(fileId, 0)).toBe(true);

    const manifest = { version: '1.0.0' as const, fileId, name: 'demo.bin', size: 3, mimeType: 'application/octet-stream', pieceSize: 2, pieceCount: 2, pieces };
    await storage.saveState({ schemaVersion: 1, protocolVersion: CORE_PROTOCOL_VERSION, sessionId, mode: 'direct', manifests: [manifest], pieceMaps: [], peers: [], updatedAt: 1 });
    const loaded = await storage.loadState(sessionId);
    loaded!.manifests[0].name = 'mutated.bin';
    expect((await storage.loadState(sessionId))!.manifests[0].name).toBe('demo.bin');

    expect([...(new Uint8Array(await (await storage.assembleFile(fileId, manifest)).arrayBuffer()))]).toEqual([1, 2, 3]);
    await storage.deletePiece(fileId, 0);
    expect(await storage.hasPiece(fileId, 0)).toBe(false);
  });

  it('selects browser storage with OPFS-first fallback warnings', async () => {
    const result = await createBrowserStorageAdapter({ sessionId, preferred: ['opfs', 'memory'] });
    expect(result.kind).toBe('memory');
    expect(result.persistence).toBe('memory_only');
    expect(result.warnings.some(warning => warning.kind === 'opfs')).toBe(true);

    await result.adapter.writePiece(fileId, 0, new Uint8Array([7]).buffer);
    expect(await result.adapter.hasPiece(fileId, 0)).toBe(true);
  });

  it('validates persisted state and discards corrupt verified pieces on resume', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init(sessionId);
    const manifest = await new ManifestGenerator().create(new Blob(['abcd']), { pieceSize: 2, fileId });
    const manager = new PieceManager(fileId, manifest.pieces);
    manager.markVerified(0);
    manager.markVerified(1);
    await storage.writePiece(fileId, 0, new TextEncoder().encode('ab').buffer);
    await storage.writePiece(fileId, 1, new TextEncoder().encode('xx').buffer);

    const restored = await restoreResumeState({ storage, manifest, pieceMap: manager.exportPieceMap() });
    expect(restored.verifiedPieces).toEqual([0]);
    expect(restored.missingPieces).toEqual([1]);
    expect(restored.discardedPieces).toEqual([1]);
    expect(await storage.hasPiece(fileId, 1)).toBe(false);

    expect(() => validatePersistedSessionState({
      protocolVersion: 'old' as never,
      sessionId,
      manifests: [],
      pieceMaps: [],
      updatedAt: 1
    })).toThrow(/protocol/);

    expect(() => validatePersistedSessionState({
      protocolVersion: CORE_PROTOCOL_VERSION,
      schemaVersion: 1,
      sessionId,
      mode: 'direct',
      manifests: [{ version: '1.0.0', fileId, name: 'bad', size: 1, mimeType: '', pieceSize: 2, pieceCount: 2, pieces: [] }],
      pieceMaps: [],
      peers: [],
      updatedAt: 1
    })).toThrow(/pieces/);

    expect(() => validatePersistedSessionState({
      schemaVersion: 1,
      protocolVersion: CORE_PROTOCOL_VERSION,
      sessionId,
      mode: 'direct',
      manifests: [manifest],
      pieceMaps: [{ fileId: 'unknown_file' as FileId, pieces: [], exportedAt: 1 }],
      peers: [],
      updatedAt: 1
    })).toThrow(/unknown fileId/);
  });

  it('gates whole-file hashing for large blobs until incremental hashing lands', async () => {
    const oversized = new Blob([new Uint8Array(4)]);
    await expect(new ManifestGenerator().create(oversized, {
      pieceSize: 2,
      includeFileHash: true,
      maxFileHashBytes: 3
    })).rejects.toMatchObject({ code: 'manifest:file_hash_too_large', category: 'manifest' });
  });

  it('guards unsafe Blob assembly and exposes streaming save path', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init(sessionId);
    const manifest = {
      version: '1.0.0' as const,
      fileId,
      name: 'large.bin',
      size: 256 * 1024 * 1024 + 1,
      mimeType: 'application/octet-stream',
      pieceSize: 1,
      pieceCount: 1,
      pieces: [{ index: 0, offset: 0, size: 1 }]
    };
    await storage.writePiece(fileId, 0, new Uint8Array([1]).buffer);
    await expect(storage.assembleFile(fileId, manifest)).rejects.toMatchObject({ code: 'storage:assembly_too_large' });
    await expect(storage.saveAssembledFile(fileId, manifest)).resolves.toMatchObject({ type: 'unsupported' });
    const streamed: number[] = [];
    const sink = new WritableStream<Uint8Array>({ write(chunk) { streamed.push(...chunk); } });
    await expect(storage.saveAssembledFile(fileId, manifest, sink)).resolves.toMatchObject({ type: 'stream', bytes: manifest.size });
    expect(streamed).toEqual([1]);
  });

  it('creates sessions, verifies received pieces, rejects corrupt pieces, and restores resume progress', async () => {
    const storage = new MemoryStorageAdapter();
    const engine = new PonsWarpEngine(storage);
    const session = await engine.createSession({ sessionId, files: [new Blob(['abcd'])], pieceSize: 2 });
    const manifest = session.manifests[0];
    const verified: number[] = [];
    const rejected: number[] = [];
    engine.on('pieceVerified', event => verified.push(event.pieceIndex));
    engine.on('pieceRejected', event => rejected.push(event.pieceIndex));

    const ack = await engine.receivePiece({
      fileId: manifest.fileId,
      pieceIndex: 0,
      requestId: 'req_0',
      data: new TextEncoder().encode('ab').buffer
    });
    expect(ack).toMatchObject({ type: 'PIECE_ACK', pieceIndex: 0 });
    expect(verified).toEqual([0]);
    expect(engine.getProgress(manifest.fileId).progress).toBe(50);

    const reject = await engine.receivePiece({
      fileId: manifest.fileId,
      pieceIndex: 1,
      requestId: 'req_1',
      data: new TextEncoder().encode('xx').buffer
    });
    expect(reject).toMatchObject({ type: 'PIECE_REJECT', reason: 'hash_mismatch' });
    expect(rejected).toEqual([1]);

    const resumedEngine = new PonsWarpEngine(storage);
    await resumedEngine.joinSession(sessionId, [manifest]);
    expect(resumedEngine.getProgress(manifest.fileId).progress).toBe(50);
    expect((await resumedEngine.resumeFile(manifest.fileId)).verifiedPieces).toEqual([0]);

    const emptyJoinEngine = new PonsWarpEngine(storage);
    const emptyJoin = await emptyJoinEngine.joinSession(sessionId);
    expect(emptyJoin.manifests).toHaveLength(1);
    expect(emptyJoinEngine.getProgress(manifest.fileId).progress).toBe(50);

    const mismatchedManifest = {
      ...manifest,
      pieces: manifest.pieces.map((piece, index) => index === 0 ? { ...piece, hash: 'different-hash' } : piece)
    };
    await expect(new PonsWarpEngine(storage).joinSession(sessionId, [mismatchedManifest])).rejects.toThrow(/Manifest mismatch/);
  });

  it('emits storage write and resume performance events', async () => {
    const storage = new MemoryStorageAdapter();
    const engine = new PonsWarpEngine(storage);
    const events: string[] = [];
    engine.on('performance', event => {
      if (event.type === 'storage:write') events.push(`write:${event.pieceIndex}:${event.bytes}`);
      if (event.type === 'resume:restored') events.push(`resume:${event.verifiedPieces}:${event.discardedPieces}`);
    });
    const session = await engine.createSession({ sessionId, files: [new Blob(['abcd'])], pieceSize: 2 });
    const manifest = session.manifests[0];
    await engine.receivePiece({ fileId: manifest.fileId, pieceIndex: 0, requestId: 'req_perf', data: new TextEncoder().encode('ab').buffer });
    await engine.resumeFile(manifest.fileId);
    expect(events).toEqual(['write:0:2', 'resume:1:0']);
  });

  it('runs request, chunk, ACK, storage, and resume flow over a transport', async () => {
    const ownerTransport = new FakeTransport(ownerPeerId);
    const receiverPeerId = 'peer_receiver' as PeerId;
    const receiverTransport = new FakeTransport(receiverPeerId);
    ownerTransport.link(receiverPeerId, receiverTransport);
    receiverTransport.link(ownerPeerId, ownerTransport);

    const owner = new PonsWarpEngine(new MemoryStorageAdapter(), undefined, undefined, undefined, ownerTransport);
    const receiverStorage = new MemoryStorageAdapter();
    const receiver = new PonsWarpEngine(receiverStorage, undefined, undefined, undefined, receiverTransport);
    const session = await owner.createSession({ sessionId, files: [new Blob(['abcd'])], pieceSize: 2 });
    const manifest = session.manifests[0];
    await receiver.joinSession(sessionId, [manifest]);

    const scheduled = await receiver.requestNextPiece(ownerPeerId, manifest.fileId);
    expect(scheduled).toMatchObject({ peerId: ownerPeerId, piece: { index: 0 } });
    await flushAsync();

    expect(receiver.getProgress(manifest.fileId).progress).toBe(50);
    expect(await receiverStorage.hasPiece(manifest.fileId, 0)).toBe(true);
    expect(receiverTransport.sentMessages.some(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_REQUEST')).toBe(true);
    expect(ownerTransport.sentMessages.some(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_CHUNK_HEADER')).toBe(true);
    expect(receiverTransport.sentMessages.some(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_ACK')).toBe(true);

    const requestCountBeforeReject = receiverTransport.sentMessages.filter(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_REQUEST').length;
    await ownerTransport.send(receiverPeerId, {
      type: 'PIECE_CHUNK_HEADER',
      fileId: manifest.fileId,
      pieceIndex: 1,
      chunkIndex: 0,
      totalChunks: 1,
      requestId: 'req_corrupt',
      payloadSize: 2
    });
    await ownerTransport.sendBinary(receiverPeerId, new TextEncoder().encode('xx').buffer);
    await flushAsync();

    expect(receiverTransport.sentMessages.some(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_REJECT')).toBe(true);
    const requestCountAfterReject = receiverTransport.sentMessages.filter(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_REQUEST').length;
    expect(requestCountAfterReject).toBeGreaterThan(requestCountBeforeReject);
  });

  it('tracks availability generations, health penalties, leases, and receiver providers', async () => {
    const table = new PieceAvailabilityTable();
    const providerPeerId = 'peer_provider' as PeerId;
    const receiverPeerId = 'peer_receiver_b' as PeerId;
    table.updatePeerPieceMap({
      peerId: providerPeerId,
      role: 'receiver',
      map: { type: 'PIECE_MAP', fileId, verifiedPieces: [0, 2], totalPieces: 3, generation: 1, updatedAt: 100 }
    });
    expect(table.getProviders(fileId, 0, 101).map(provider => provider.peerId)).toEqual([providerPeerId]);
    expect(table.updatePeerPieceMap({
      peerId: providerPeerId,
      role: 'receiver',
      map: { type: 'PIECE_MAP', fileId, verifiedPieces: [1], totalPieces: 3, generation: 1, updatedAt: 101 }
    })).toBe(false);
    expect(() => table.updatePeerPieceMap({
      peerId: providerPeerId,
      role: 'receiver',
      map: { type: 'PIECE_MAP', fileId, verifiedPieces: [2, 1], totalPieces: 3, generation: 2, updatedAt: 102 }
    })).toThrow(/sorted/);

    table.lease(fileId, 0, { peerId: receiverPeerId, requestId: 'req_lease', leasedAt: 100, expiresAt: 110 });
    expect(table.getLease(fileId, 0)).toMatchObject({ requestId: 'req_lease' });
    expect(table.expireLeases(111)).toEqual([{ peerId: receiverPeerId, requestId: 'req_lease', leasedAt: 100, expiresAt: 110 }]);

    const health = new PeerHealthTable();
    const initial = health.get(providerPeerId).score;
    health.markReject(providerPeerId);
    health.markTimeout(providerPeerId);
    expect(health.get(providerPeerId).score).toBeLessThan(initial);
  });

  it('schedules a receiver-provided piece in a 3-peer fake transport grid', async () => {
    const ownerTransport = new FakeTransport(ownerPeerId);
    const receiverAPeerId = 'peer_receiver_a' as PeerId;
    const receiverBPeerId = 'peer_receiver_b' as PeerId;
    const receiverATransport = new FakeTransport(receiverAPeerId);
    const receiverBTransport = new FakeTransport(receiverBPeerId);

    ownerTransport.link(receiverAPeerId, receiverATransport);
    ownerTransport.link(receiverBPeerId, receiverBTransport);
    receiverATransport.link(ownerPeerId, ownerTransport);
    receiverATransport.link(receiverBPeerId, receiverBTransport);
    receiverBTransport.link(ownerPeerId, ownerTransport);
    receiverBTransport.link(receiverAPeerId, receiverATransport);

    const owner = new PonsWarpEngine(new MemoryStorageAdapter(), undefined, undefined, undefined, ownerTransport);
    const receiverAStorage = new MemoryStorageAdapter();
    const receiverBStorage = new MemoryStorageAdapter();
    const receiverA = new PonsWarpEngine(receiverAStorage, undefined, undefined, undefined, receiverATransport);
    const receiverB = new PonsWarpEngine(receiverBStorage, undefined, undefined, undefined, receiverBTransport);

    const session = await owner.createSession({ sessionId, files: [new Blob(['abcdefgh'])], pieceSize: 2 });
    const manifest = session.manifests[0];
    await receiverA.joinSession(sessionId, [manifest]);
    await receiverB.joinSession(sessionId, [manifest]);

    await receiverA.requestNextPiece(ownerPeerId, manifest.fileId);
    await flushAsync();
    expect(await receiverAStorage.hasPiece(manifest.fileId, 0)).toBe(true);

    const mapFromA = await receiverA.broadcastPieceMap(manifest.fileId, [receiverBPeerId]);
    await flushAsync();
    expect(mapFromA.verifiedPieces).toEqual([0]);
    expect(receiverB.getAvailability(manifest.fileId).pieces[0].providers.map(provider => provider.peerId)).toEqual([receiverAPeerId]);

    const scheduledFromReceiver = await receiverB.requestNextGridPiece(manifest.fileId, {
      ownerPeerId,
      candidatePeers: [receiverAPeerId, ownerPeerId],
      now: 1_000
    });
    expect(scheduledFromReceiver).toMatchObject({ type: 'scheduled', pieceIndex: 0, peerId: receiverAPeerId });
    await flushAsync();
    expect(await receiverBStorage.hasPiece(manifest.fileId, 0)).toBe(true);

    const scheduledFromOwner = await receiverB.requestNextGridPiece(manifest.fileId, {
      ownerPeerId,
      candidatePeers: [receiverAPeerId, ownerPeerId],
      now: 2_000
    });
    expect(scheduledFromOwner).toMatchObject({ type: 'scheduled', pieceIndex: 1, peerId: ownerPeerId, reason: 'owner_fallback' });
    await flushAsync();
    expect(receiverB.getProgress(manifest.fileId).verifiedPieces).toBe(2);
    expect(receiverATransport.sentMessages.some(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_CHUNK_HEADER')).toBe(true);
  });

  it('releases grid leases before retrying corrupt provider chunks', async () => {
    const providerPeerId = 'peer_provider' as PeerId;
    const receiverPeerId = 'peer_receiver_b' as PeerId;
    const providerTransport = new FakeTransport(providerPeerId);
    const receiverTransport = new FakeTransport(receiverPeerId);
    providerTransport.link(receiverPeerId, receiverTransport);
    receiverTransport.link(providerPeerId, providerTransport);

    const manifest = await new ManifestGenerator().create(new Blob(['abcd']), { pieceSize: 2, fileId });
    const receiver = new PonsWarpEngine(new MemoryStorageAdapter(), undefined, undefined, undefined, receiverTransport);
    await receiver.joinSession(sessionId, [manifest]);

    const scheduled = await receiver.requestNextGridPiece(manifest.fileId, {
      ownerPeerId: providerPeerId,
      candidatePeers: [providerPeerId],
      requestLeaseMs: 10_000,
      now: 1_000
    });
    expect(scheduled).toMatchObject({ type: 'scheduled', pieceIndex: 0, peerId: providerPeerId });

    const requestCountBeforeReject = receiverTransport.sentMessages.filter(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_REQUEST').length;
    if (scheduled.type !== 'scheduled') throw new Error('expected scheduled grid request');
    await providerTransport.send(receiverPeerId, {
      type: 'PIECE_CHUNK_HEADER',
      fileId: manifest.fileId,
      pieceIndex: scheduled.pieceIndex,
      chunkIndex: 0,
      totalChunks: 1,
      requestId: scheduled.requestId,
      payloadSize: 2
    });
    await providerTransport.sendBinary(receiverPeerId, new TextEncoder().encode('xx').buffer);
    await flushAsync();

    expect(receiver.getProgress(manifest.fileId).verifiedPieces).toBe(0);
    const requestCountAfterReject = receiverTransport.sentMessages.filter(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'PIECE_REQUEST').length;
    expect(requestCountAfterReject).toBeGreaterThan(requestCountBeforeReject);
  });
});
