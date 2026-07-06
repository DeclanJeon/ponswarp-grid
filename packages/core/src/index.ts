export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type SessionId = Brand<string, 'SessionId'>;
export type PeerId = Brand<string, 'PeerId'>;
export type FileId = Brand<string, 'FileId'>;
export type MessageId = Brand<string, 'MessageId'>;

export type HashAlgorithm = 'SHA-256';
export type PieceStatus =
  | 'missing'
  | 'requested'
  | 'receiving'
  | 'received'
  | 'verified'
  | 'failed';

export interface PieceDescriptor {
  index: number;
  offset: number;
  size: number;
  hash?: string;
}

export interface FileManifest {
  version: '1.0.0';
  fileId: FileId;
  name: string;
  size: number;
  mimeType: string;
  pieceSize: number;
  pieceCount: number;
  fileHash?: string;
  fileHashUnavailableReason?: string;
  pieces: PieceDescriptor[];
}

export interface ManifestOptions {
  pieceSize: number;
  hashAlgorithm?: HashAlgorithm;
  includeFileHash?: boolean;
  maxFileHashBytes?: number;
  fileId?: FileId;
  fileHashPolicy?: FileHashPolicy;
  onPerformance?: (event: PerformanceEvent) => void;
}

export type FileHashPolicy =
  | { mode: 'piece-only' }
  | { mode: 'whole-file-if-safe'; maxBytes: number }
  | { mode: 'worker-incremental'; workerUrl: string };

export type PerformanceEvent =
  | { type: 'hash:progress'; fileId?: FileId; bytesProcessed: number; totalBytes: number }
  | { type: 'transfer:speed'; fileId: FileId; pieceIndex: number; peerId: PeerId; bytes: number; bps: number; windowMs: number }
  | { type: 'transfer:retry'; fileId: FileId; pieceIndex: number; peerId: PeerId; requestId: string; reason: string; retryCount: number; maxRetries: number }
  | { type: 'buffer:watermark'; peerId: PeerId; bufferedAmount: number }
  | { type: 'storage:write'; fileId: FileId; pieceIndex: number; bytes: number; durationMs: number }
  | { type: 'resume:restored'; fileId: FileId; verifiedPieces: number; discardedPieces: number; durationMs: number };

export interface PieceState {
  index: number;
  status: PieceStatus;
  size: number;
  receivedBytes: number;
  retryCount: number;
  requestedFrom?: PeerId;
  updatedAt: number;
  failureReason?: string;
}

export interface PieceMap {
  fileId: FileId;
  pieces: PieceState[];
  exportedAt: number;
}

export interface TransferProgress {
  progress: number;
  bytesTransferred: number;
  totalBytes: number;
  verifiedPieces: number;
  totalPieces: number;
}

export const CORE_PROTOCOL_VERSION = 'ponswarp-grid/1.0.0' as const;

const DEFAULT_TRANSFER_CHUNK_BYTES = 64 * 1024;

export interface PersistedPeerState {
  peerId: PeerId;
  role: 'owner' | 'receiver';
  updatedAt: number;
}

export interface PersistedSessionState {
  schemaVersion: 1;
  protocolVersion: typeof CORE_PROTOCOL_VERSION;
  sessionId: SessionId;
  ownerPeerId?: PeerId;
  mode: 'direct' | 'grid';
  manifests: FileManifest[];
  pieceMaps: PieceMap[];
  peers: PersistedPeerState[];
  updatedAt: number;
}

export type TransportMessage = unknown;
export type BinaryFrame = ArrayBuffer | ArrayBufferView;
export type TransportMessageHandler = (peerId: PeerId, message: TransportMessage) => void;
export type BinaryFrameHandler = (peerId: PeerId, frame: ArrayBuffer) => void;

export interface Transport {
  connect(peerId: PeerId): Promise<void>;
  send(peerId: PeerId, message: TransportMessage): Promise<void>;
  sendBinary(peerId: PeerId, frame: BinaryFrame): Promise<void>;
  onMessage(handler: TransportMessageHandler): Unsubscribe;
  onBinary(handler: BinaryFrameHandler): Unsubscribe;
  close(peerId?: PeerId): Promise<void>;
}
export interface TransferSession {
  sessionId: SessionId;
  manifests: FileManifest[];
  shareUrl?: string;
}

export interface CreateSessionInput {
  files: Array<Blob & { name?: string; type?: string }>;
  pieceSize: number;
  sessionId?: SessionId;
  includeFileHash?: boolean;
}

export interface PieceReceiveResult {
  type: 'PIECE_ACK' | 'PIECE_REJECT';
  fileId: FileId;
  pieceIndex: number;
  requestId: string;
  reason?: string;
  hash?: string;
}

export interface EngineEvents extends EventMap {
  progress: TransferProgress;
  pieceVerified: { fileId: FileId; pieceIndex: number };
  pieceRejected: { fileId: FileId; pieceIndex: number; reason: string };
  availabilityChanged: AvailabilityChangedEvent;
  requestTimedOut: { fileId: FileId; pieceIndex: number; peerId: PeerId; requestId: string };
  performance: PerformanceEvent;
}

export interface PieceRequestMessage {
  type: 'PIECE_REQUEST';
  fileId: FileId;
  pieceIndex: number;
  requestId: string;
  fromOffset: number;
}

export interface PieceChunkHeaderMessage {
  type: 'PIECE_CHUNK_HEADER';
  fileId: FileId;
  pieceIndex: number;
  chunkIndex: number;
  totalChunks: number;
  requestId: string;
  payloadSize: number;
}

export interface PieceAckMessage {
  type: 'PIECE_ACK';
  fileId: FileId;
  pieceIndex: number;
  requestId: string;
  status: 'verified';
  hash?: string;
}

export type PieceRejectReason = 'hash_mismatch' | 'missing_piece' | 'storage_read_failed' | 'unauthorized' | 'busy' | 'invalid_chunk';
export interface PieceRejectMessage {
  type: 'PIECE_REJECT';
  fileId: FileId;
  pieceIndex: number;
  requestId: string;
  reason: PieceRejectReason;
  expectedHash?: string;
  actualHash?: string;
}

export interface PieceMapBroadcast {
  type: 'PIECE_MAP';
  fileId: FileId;
  verifiedPieces: number[];
  totalPieces: number;
  generation: number;
  updatedAt: number;
}

export type ProviderRole = 'owner' | 'receiver' | 'relay';

export interface ProviderState {
  peerId: PeerId;
  role: ProviderRole;
  verified: true;
  advertisedAt: number;
  expiresAt: number;
  healthScore: number;
}

export interface RequestLease {
  peerId: PeerId;
  requestId: string;
  leasedAt: number;
  expiresAt: number;
}

export interface PieceAvailabilitySnapshot {
  fileId: FileId;
  pieceCount: number;
  pieces: Array<{
    pieceIndex: number;
    providers: ProviderState[];
    requestedBy?: RequestLease;
  }>;
}

export interface AvailabilityChangedEvent {
  peerId: PeerId;
  fileId: FileId;
  verifiedPieces: number[];
  generation: number;
}

export type PeerConnectionState = 'connected' | 'connecting' | 'disconnected' | 'failed';

export interface PeerHealth {
  peerId: PeerId;
  connectionState: PeerConnectionState;
  rttMs?: number;
  averageThroughputBps?: number;
  recentFailures: number;
  recentRejects: number;
  timeoutCount: number;
  successfulPieces: number;
  lastSuccessAt?: number;
  score: number;
}

export interface GridScheduleOptions {
  ownerPeerId: PeerId;
  candidatePeers?: PeerId[];
  maxRequestsPerPeer?: number;
  requestLeaseMs?: number;
  now?: number;
}

export interface PieceWindowOptions {
  maxInFlight?: number;
}

export type GridScheduleResult =
  | { type: 'scheduled'; pieceIndex: number; peerId: PeerId; requestId: string; reason: 'rarest_first' | 'fastest_peer' | 'owner_fallback' | 'resume_missing' | 'retry_after_reject' }
  | { type: 'idle'; reason: 'complete' | 'no_missing_piece' | 'no_available_peer' | 'parallel_limit' }
  | { type: 'exhausted'; pieceIndex: number; reason: 'retry_limit' | 'all_providers_failed' };

export type EngineTransferMessage =
  | PieceRequestMessage
  | PieceChunkHeaderMessage
  | PieceAckMessage
  | PieceRejectMessage
  | PieceMapBroadcast;

export interface PendingChunk {
  peerId: PeerId;
  header: PieceChunkHeaderMessage;
}

interface IncomingChunkAssembly {
  peerId: PeerId;
  header: PieceChunkHeaderMessage;
  chunks: Array<ArrayBuffer | undefined>;
  receivedBytes: number;
  receivedChunks: number;
}

export interface ResumeRestoreResult {
  manager: PieceManager;
  verifiedPieces: number[];
  missingPieces: number[];
  discardedPieces: number[];
}

export interface ScheduledPiece {
  piece: PieceState;
  peerId: PeerId;
}

export class PonsWarpError extends Error {
  readonly category: string;
  readonly recoverable: boolean;

  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown; category?: string; recoverable?: boolean } = {}
  ) {
    super(message);
    this.name = 'PonsWarpError';
    this.cause = options.cause;
    this.category = options.category ?? code.split(':')[0] ?? 'unknown';
    this.recoverable = options.recoverable ?? true;
  }
}

export type Unsubscribe = () => void;
export type EventMap = Record<string, unknown>;
export type EventHandler<T> = (event: T) => void;

export class EventBus<TEvents extends EventMap> {
  private readonly handlers = new Map<keyof TEvents, Set<EventHandler<TEvents[keyof TEvents]>>>();

  on<TType extends keyof TEvents>(type: TType, handler: EventHandler<TEvents[TType]>): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set<EventHandler<TEvents[keyof TEvents]>>();
    set.add(handler as EventHandler<TEvents[keyof TEvents]>);
    this.handlers.set(type, set);
    return () => this.off(type, handler);
  }

  off<TType extends keyof TEvents>(type: TType, handler: EventHandler<TEvents[TType]>): void {
    this.handlers.get(type)?.delete(handler as EventHandler<TEvents[keyof TEvents]>);
  }

  emit<TType extends keyof TEvents>(type: TType, event: TEvents[TType]): void {
    this.handlers.get(type)?.forEach(handler => handler(event));
  }

  clear(): void {
    this.handlers.clear();
  }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function calculateProgressPercent(bytesTransferred: number, totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  const safeBytes = Number.isFinite(bytesTransferred) ? Math.max(0, bytesTransferred) : 0;
  return clampPercent((safeBytes / totalBytes) * 100);
}

export function createPieceDescriptors(fileSize: number, pieceSize: number): PieceDescriptor[] {
  assertSafeNonNegativeInteger(fileSize, 'fileSize');
  assertPositiveSafeInteger(pieceSize, 'pieceSize');

  const pieceCount = Math.ceil(fileSize / pieceSize);
  return Array.from({ length: pieceCount }, (_, index) => {
    const offset = index * pieceSize;
    return {
      index,
      offset,
      size: Math.min(pieceSize, fileSize - offset)
    };
  });
}

export class IntegrityChecker {
  constructor(private readonly algorithm: HashAlgorithm = 'SHA-256') {}

  async hash(data: ArrayBuffer): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(this.algorithm, data);
    return bytesToHex(new Uint8Array(digest));
  }

  async verifyPiece(data: ArrayBuffer, descriptor: PieceDescriptor): Promise<boolean> {
    if (!descriptor.hash) return true;
    if (data.byteLength !== descriptor.size) return false;
    return (await this.hash(data)) === descriptor.hash;
  }

  async verifyFile(blob: Blob, manifest: FileManifest): Promise<boolean> {
    if (!manifest.fileHash) return true;
    return (await this.hash(await blob.arrayBuffer())) === manifest.fileHash;
  }
}

export class ManifestGenerator {
  constructor(private readonly integrity = new IntegrityChecker()) {}

  async create(file: Blob & { name?: string; type?: string }, options: ManifestOptions): Promise<FileManifest> {
    assertPositiveSafeInteger(options.pieceSize, 'pieceSize');
    const pieces = createPieceDescriptors(file.size, options.pieceSize);
    const hashedPieces: PieceDescriptor[] = [];
    let bytesProcessed = 0;

    for (const piece of pieces) {
      const data = await file.slice(piece.offset, piece.offset + piece.size).arrayBuffer();
      hashedPieces.push({ ...piece, hash: await this.integrity.hash(data) });
      bytesProcessed += piece.size;
      options.onPerformance?.({ type: 'hash:progress', fileId: options.fileId, bytesProcessed, totalBytes: file.size });
    }

    const hashPolicy = options.fileHashPolicy ?? (options.includeFileHash ? { mode: 'whole-file-if-safe', maxBytes: options.maxFileHashBytes ?? 256 * 1024 * 1024 } : { mode: 'piece-only' });
    const fileHash = await this.createWholeFileHash(file, hashPolicy);
    return {
      version: '1.0.0',
      fileId: options.fileId ?? createFileId(),
      name: file.name ?? 'unnamed',
      size: file.size,
      mimeType: file.type ?? '',
      pieceSize: options.pieceSize,
      pieceCount: pieces.length,
      fileHash,
      fileHashUnavailableReason: fileHash ? undefined : hashPolicy.mode === 'piece-only' ? 'piece-only policy' : undefined,
      pieces: hashedPieces
    };
  }

  private async createWholeFileHash(file: Blob, policy: FileHashPolicy): Promise<string | undefined> {
    if (policy.mode === 'piece-only') return undefined;
    if (policy.mode === 'worker-incremental') {
      throw new PonsWarpError('manifest:worker_hash_unavailable', 'Worker incremental whole-file hashing is not bundled; use piece-only or whole-file-if-safe policy', {
        category: 'manifest',
        recoverable: true
      });
    }
    return this.hashWholeFileWhenSafe(file, policy.maxBytes);
  }

  private async hashWholeFileWhenSafe(file: Blob, maxBytes = 256 * 1024 * 1024): Promise<string> {
    if (file.size > maxBytes) {
      throw new PonsWarpError('manifest:file_hash_too_large', 'Whole-file hashing is gated until an incremental large-file hashing strategy is available', {
        category: 'manifest',
        recoverable: true
      });
    }
    return this.integrity.hash(await file.arrayBuffer());
  }
}

export class PieceManager {
  private readonly states: PieceState[];

  constructor(readonly fileId: FileId, pieces: readonly PieceDescriptor[], private readonly now: () => number = () => Date.now()) {
    this.states = pieces.map(piece => ({
      index: piece.index,
      status: 'missing',
      size: piece.size,
      receivedBytes: 0,
      retryCount: 0,
      updatedAt: this.now()
    }));
  }

  markRequested(index: number, peerId: PeerId): void {
    const state = this.requirePiece(index);
    this.update(index, { status: 'requested', requestedFrom: peerId, receivedBytes: 0, failureReason: undefined });
  }

  markReceiving(index: number, receivedBytes: number): void {
    const state = this.requirePiece(index);
    this.update(index, { status: 'receiving', receivedBytes: clampBytes(receivedBytes, state.size) });
  }

  markReceived(index: number): void {
    const state = this.requirePiece(index);
    this.update(index, { status: 'received', receivedBytes: state.size });
  }

  markVerified(index: number): void {
    const state = this.requirePiece(index);
    this.update(index, { status: 'verified', receivedBytes: state.size, failureReason: undefined });
  }

  markFailed(index: number, reason: string): void {
    const state = this.requirePiece(index);
    this.update(index, {
      status: 'failed',
      receivedBytes: 0,
      retryCount: state.retryCount + 1,
      requestedFrom: undefined,
      failureReason: reason
    });
  }

  resetFailedToMissing(index: number): void {
    const state = this.requirePiece(index);
    if (state.status !== 'failed') return;
    this.update(index, { status: 'missing', failureReason: undefined });
  }

  getMissingPieces(): number[] {
    return this.states.filter(piece => piece.status === 'missing' || piece.status === 'failed').map(piece => piece.index);
  }

  getVerifiedPieces(): number[] {
    return this.states.filter(piece => piece.status === 'verified').map(piece => piece.index);
  }

  getPieceState(index: number): PieceState {
    return { ...this.requirePiece(index) };
  }

  exportPieceMap(): PieceMap {
    return {
      fileId: this.fileId,
      pieces: this.states.map(piece => ({ ...piece })),
      exportedAt: this.now()
    };
  }

  importPieceMap(pieceMap: PieceMap): void {
    if (pieceMap.fileId !== this.fileId) {
      throw new PonsWarpError('piece_map:file_mismatch', `Piece map is for ${pieceMap.fileId}, expected ${this.fileId}`);
    }
    for (const imported of pieceMap.pieces) {
      const status: PieceStatus = imported.status === 'requested' || imported.status === 'receiving' ? 'missing' : imported.status;
      this.update(imported.index, {
        status,
        retryCount: imported.retryCount,
        requestedFrom: status === 'missing' ? undefined : imported.requestedFrom,
        receivedBytes: status === 'missing' ? 0 : clampBytes(imported.receivedBytes, this.requirePiece(imported.index).size),
        failureReason: imported.failureReason
      });
    }
  }

  getProgress(): TransferProgress {
    const totalBytes = this.states.reduce((sum, piece) => sum + piece.size, 0);
    const bytesTransferred = this.states.reduce((sum, piece) => sum + (piece.status === 'verified' ? piece.size : clampBytes(piece.receivedBytes, piece.size)), 0);
    const verifiedPieces = this.getVerifiedPieces().length;
    return {
      progress: calculateProgressPercent(bytesTransferred, totalBytes),
      bytesTransferred,
      totalBytes,
      verifiedPieces,
      totalPieces: this.states.length
    };
  }

  private requirePiece(index: number): PieceState {
    const state = this.states[index];
    if (!state || state.index !== index) throw new PonsWarpError('piece:not_found', `Unknown piece index ${index}`);
    return state;
  }

  private update(index: number, patch: Partial<PieceState>): void {
    const current = this.requirePiece(index);
    this.states[index] = { ...current, ...patch, updatedAt: this.now() };
  }
}

export async function restoreResumeState(input: {
  storage: StorageAdapter;
  manifest: FileManifest;
  pieceMap: PieceMap;
  integrity?: IntegrityChecker;
}): Promise<ResumeRestoreResult> {
  validatePieceMapForManifest(input.manifest, input.pieceMap);
  const integrity = input.integrity ?? new IntegrityChecker();
  const manager = new PieceManager(input.manifest.fileId, input.manifest.pieces);
  manager.importPieceMap(input.pieceMap);
  const discardedPieces: number[] = [];

  for (const index of manager.getVerifiedPieces()) {
    const descriptor = input.manifest.pieces[index];
    const data = await input.storage.readPiece(input.manifest.fileId, index);
    if (!data || !(await integrity.verifyPiece(data, descriptor))) {
      await input.storage.deletePiece(input.manifest.fileId, index);
      manager.markFailed(index, data ? 'piece hash mismatch during resume' : 'piece missing during resume');
      manager.resetFailedToMissing(index);
      discardedPieces.push(index);
    }
  }

  return {
    manager,
    verifiedPieces: manager.getVerifiedPieces(),
    missingPieces: manager.getMissingPieces(),
    discardedPieces
  };
}

export function validatePersistedSessionState(state: unknown): asserts state is PersistedSessionState {
  if (!isRecord(state)) throwInvalidResumeState('state must be an object');
  if (state.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new PonsWarpError('resume:protocol_mismatch', 'Persisted session state protocol version is not supported', {
      category: 'resume',
      recoverable: true
    });
  }
  if (state.schemaVersion !== 1) throwInvalidResumeState('schemaVersion must be 1');
  if (typeof state.sessionId !== 'string' || state.sessionId.length === 0) throwInvalidResumeState('sessionId is required');
  if (!Array.isArray(state.manifests)) throwInvalidResumeState('manifests must be an array');
  if (!Array.isArray(state.pieceMaps)) throwInvalidResumeState('pieceMaps must be an array');
  if (state.mode !== 'direct' && state.mode !== 'grid') throwInvalidResumeState('mode is invalid');
  if (!Array.isArray(state.peers)) throwInvalidResumeState('peers must be an array');
  if (typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt)) throwInvalidResumeState('updatedAt must be a finite number');

  for (const manifest of state.manifests) validateManifestShape(manifest);
  for (const pieceMap of state.pieceMaps) validatePieceMapShape(pieceMap);
  for (const peer of state.peers) validatePersistedPeerShape(peer);
  const manifestIds = new Set(state.manifests.map(manifest => manifest.fileId));
  for (const pieceMap of state.pieceMaps) {
    if (!manifestIds.has(pieceMap.fileId)) throwInvalidResumeState(`piece map references unknown fileId ${pieceMap.fileId}`);
    const manifest = state.manifests.find(item => item.fileId === pieceMap.fileId);
    if (manifest) validatePieceMapForManifest(manifest, pieceMap);
  }
}

export function validatePieceMapForManifest(manifest: FileManifest, pieceMap: PieceMap): void {
  if (pieceMap.fileId !== manifest.fileId) {
    throw new PonsWarpError('resume:manifest_mismatch', 'Piece map fileId does not match manifest', {
      category: 'resume',
      recoverable: true
    });
  }
  if (pieceMap.pieces.length !== manifest.pieceCount) {
    throw new PonsWarpError('resume:manifest_mismatch', 'Piece map length does not match manifest piece count', {
      category: 'resume',
      recoverable: true
    });
  }
}

export class OwnerFirstScheduler {
  constructor(private readonly ownerPeerId: PeerId, private readonly maxRetries = 3) {}

  next(manager: PieceManager): ScheduledPiece | null {
    for (const index of manager.getMissingPieces()) {
      const piece = manager.getPieceState(index);
      if (piece.retryCount <= this.maxRetries) {
        return { piece, peerId: this.ownerPeerId };
      }
    }
    return null;
  }
}

export class PieceAvailabilityTable {
  private readonly files = new Map<FileId, {
    pieceCount: number;
    generations: Map<PeerId, number>;
    pieces: Map<number, { providers: Map<PeerId, ProviderState>; requestedBy?: RequestLease }>;
  }>();

  updatePeerPieceMap(input: {
    peerId: PeerId;
    role: ProviderRole;
    map: PieceMapBroadcast;
    healthScore?: number;
    expiresAt?: number;
  }): boolean {
    this.validateBroadcast(input.map);
    const file = this.ensureFile(input.map.fileId, input.map.totalPieces);
    const previousGeneration = file.generations.get(input.peerId);
    if (previousGeneration !== undefined && input.map.generation <= previousGeneration) return false;

    for (const piece of file.pieces.values()) piece.providers.delete(input.peerId);
    const provider: Omit<ProviderState, 'peerId'> = {
      role: input.role,
      verified: true,
      advertisedAt: input.map.updatedAt,
      expiresAt: input.expiresAt ?? input.map.updatedAt + 30_000,
      healthScore: input.healthScore ?? 50
    };
    for (const pieceIndex of input.map.verifiedPieces) {
      file.pieces.get(pieceIndex)!.providers.set(input.peerId, { ...provider, peerId: input.peerId });
    }
    file.generations.set(input.peerId, input.map.generation);
    return true;
  }

  getSnapshot(fileId: FileId): PieceAvailabilitySnapshot | undefined {
    const file = this.files.get(fileId);
    if (!file) return undefined;
    return {
      fileId,
      pieceCount: file.pieceCount,
      pieces: [...file.pieces.entries()].map(([pieceIndex, piece]) => ({
        pieceIndex,
        providers: [...piece.providers.values()].map(provider => ({ ...provider })),
        requestedBy: piece.requestedBy ? { ...piece.requestedBy } : undefined
      }))
    };
  }

  getProviders(fileId: FileId, pieceIndex: number, now = Date.now()): ProviderState[] {
    const piece = this.files.get(fileId)?.pieces.get(pieceIndex);
    if (!piece) return [];
    return [...piece.providers.values()].filter(provider => provider.expiresAt > now);
  }

  lease(fileId: FileId, pieceIndex: number, lease: RequestLease): void {
    const piece = this.files.get(fileId)?.pieces.get(pieceIndex);
    if (!piece) throw new PonsWarpError('availability:piece_not_found', `Unknown availability piece ${pieceIndex}`, { category: 'scheduler', recoverable: true });
    piece.requestedBy = { ...lease };
  }

  release(fileId: FileId, pieceIndex: number, requestId?: string): void {
    const piece = this.files.get(fileId)?.pieces.get(pieceIndex);
    if (!piece?.requestedBy) return;
    if (!requestId || piece.requestedBy.requestId === requestId) piece.requestedBy = undefined;
  }

  getLease(fileId: FileId, pieceIndex: number): RequestLease | undefined {
    const lease = this.files.get(fileId)?.pieces.get(pieceIndex)?.requestedBy;
    return lease ? { ...lease } : undefined;
  }

  expireLeases(now = Date.now()): RequestLease[] {
    const expired: RequestLease[] = [];
    for (const file of this.files.values()) {
      for (const piece of file.pieces.values()) {
        if (piece.requestedBy && piece.requestedBy.expiresAt <= now) {
          expired.push({ ...piece.requestedBy });
          piece.requestedBy = undefined;
        }
      }
    }
    return expired;
  }

  private ensureFile(fileId: FileId, pieceCount: number): {
    pieceCount: number;
    generations: Map<PeerId, number>;
    pieces: Map<number, { providers: Map<PeerId, ProviderState>; requestedBy?: RequestLease }>;
  } {
    const existing = this.files.get(fileId);
    if (existing) {
      if (existing.pieceCount !== pieceCount) throw new PonsWarpError('availability:piece_count_mismatch', 'Piece map totalPieces changed for file', { category: 'scheduler', recoverable: true });
      return existing;
    }
    const pieces = new Map<number, { providers: Map<PeerId, ProviderState>; requestedBy?: RequestLease }>();
    for (let index = 0; index < pieceCount; index += 1) pieces.set(index, { providers: new Map() });
    const file = { pieceCount, generations: new Map<PeerId, number>(), pieces };
    this.files.set(fileId, file);
    return file;
  }

  private validateBroadcast(map: PieceMapBroadcast): void {
    if (map.type !== 'PIECE_MAP') throw new PonsWarpError('availability:invalid_message', 'Expected PIECE_MAP broadcast', { category: 'scheduler', recoverable: true });
    if (!Number.isSafeInteger(map.totalPieces) || map.totalPieces < 0) throw new PonsWarpError('availability:invalid_total', 'Invalid totalPieces in piece map', { category: 'scheduler', recoverable: true });
    let previous = -1;
    for (const index of map.verifiedPieces) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= map.totalPieces || index <= previous) {
        throw new PonsWarpError('availability:invalid_piece_index', 'PIECE_MAP verifiedPieces must be sorted and in range', { category: 'scheduler', recoverable: true });
      }
      previous = index;
    }
  }
}

export class PeerHealthTable {
  private readonly peers = new Map<PeerId, PeerHealth>();

  set(peerId: PeerId, patch: Partial<PeerHealth>): PeerHealth {
    const current = this.peers.get(peerId) ?? this.createDefault(peerId);
    const next: PeerHealth = { ...current, ...patch, peerId };
    next.score = this.computeScore(next);
    this.peers.set(peerId, next);
    return { ...next };
  }

  get(peerId: PeerId): PeerHealth {
    return { ...(this.peers.get(peerId) ?? this.set(peerId, {})) };
  }

  markSuccess(peerId: PeerId, bytes: number, elapsedMs: number, now = Date.now()): void {
    const current = this.get(peerId);
    const throughput = elapsedMs > 0 ? (bytes / elapsedMs) * 1000 : current.averageThroughputBps;
    this.set(peerId, {
      successfulPieces: current.successfulPieces + 1,
      recentFailures: Math.max(0, current.recentFailures - 1),
      averageThroughputBps: throughput,
      lastSuccessAt: now,
      connectionState: 'connected'
    });
  }

  markReject(peerId: PeerId): void {
    const current = this.get(peerId);
    this.set(peerId, { recentRejects: current.recentRejects + 1 });
  }

  markTimeout(peerId: PeerId): void {
    const current = this.get(peerId);
    this.set(peerId, { timeoutCount: current.timeoutCount + 1, recentFailures: current.recentFailures + 1 });
  }

  private createDefault(peerId: PeerId): PeerHealth {
    return {
      peerId,
      connectionState: 'connected',
      recentFailures: 0,
      recentRejects: 0,
      timeoutCount: 0,
      successfulPieces: 0,
      score: 50
    };
  }

  private computeScore(health: PeerHealth): number {
    const throughputBonus = health.averageThroughputBps ? Math.max(0, Math.min(20, Math.log2(Math.max(1, health.averageThroughputBps) / 65_536))) : 0;
    const rttPenalty = health.rttMs ? Math.max(0, Math.min(10, health.rttMs / 100)) : 0;
    const failurePenalty = health.recentFailures * 10 + health.timeoutCount * 15 + health.recentRejects * 5;
    const statePenalty = health.connectionState === 'connected' ? 0 : health.connectionState === 'connecting' ? 15 : 40;
    return Math.max(0, Math.min(100, 50 + throughputBonus - rttPenalty - failurePenalty - statePenalty));
  }
}

export class PonsWarpEngine {
  private readonly manifests = new Map<FileId, FileManifest>();
  private readonly managers = new Map<FileId, PieceManager>();
  private readonly ownerSources = new Map<FileId, Blob>();
  private readonly pendingChunks = new Map<PeerId, PieceChunkHeaderMessage>();
  private readonly incomingChunks = new Map<string, IncomingChunkAssembly>();
  private readonly outstandingRequests = new Map<string, { fileId: FileId; pieceIndex: number; peerId: PeerId; requestedAt: number; gridOptions?: GridScheduleOptions }>();
  private readonly pieceSendQueues = new Map<PeerId, Promise<void>>();
  private readonly availability = new PieceAvailabilityTable();
  private readonly peerHealth = new PeerHealthTable();
  private readonly localPieceMapGenerations = new Map<FileId, number>();
  private readonly knownPeers = new Set<PeerId>();
  private sessionId: SessionId | null = null;
  private transportUnsubscribers: Unsubscribe[] = [];

  constructor(
    private readonly storage: StorageAdapter,
    private readonly manifestGenerator = new ManifestGenerator(),
    private readonly integrity = new IntegrityChecker(),
    private readonly events = new EventBus<EngineEvents>(),
    private transport?: Transport,
    private readonly maxRetries = 3
  ) {
    if (transport) this.bindTransport(transport);
  }

  on<T extends keyof EngineEvents>(type: T, handler: EventHandler<EngineEvents[T]>): Unsubscribe {
    return this.events.on(type, handler);
  }

  setTransport(transport: Transport): void {
    this.transportUnsubscribers.forEach(unsubscribe => unsubscribe());
    this.transportUnsubscribers = [];
    this.transport = transport;
    this.bindTransport(transport);
  }

  async createSession(input: CreateSessionInput): Promise<TransferSession> {
    const sessionId = input.sessionId ?? (`sess_${globalThis.crypto?.randomUUID?.() ?? Date.now()}` as SessionId);
    await this.storage.init(sessionId);
    this.sessionId = sessionId;
    const manifests: FileManifest[] = [];
    for (const file of input.files) {
      const manifest = await this.manifestGenerator.create(file, {
        pieceSize: input.pieceSize,
        includeFileHash: input.includeFileHash,
        fileId: `file_${manifests.length}` as FileId
      });
      this.registerManifest(manifest);
      this.ownerSources.set(manifest.fileId, file);
      manifests.push(manifest);
    }
    await this.persistState();
    return { sessionId, manifests, shareUrl: `#/join/${sessionId}` };
  }

  async joinSession(sessionId: SessionId, manifests: FileManifest[] = []): Promise<TransferSession> {
    await this.storage.init(sessionId);
    this.sessionId = sessionId;
    const state = await this.storage.loadState(sessionId);
    if (state) validatePersistedSessionState(state);

    const mergedManifests = mergeManifests(state?.manifests ?? [], manifests);
    for (const manifest of mergedManifests) this.registerManifest(manifest);

    if (state) {
      for (const pieceMap of state.pieceMaps) {
        const manifest = this.manifests.get(pieceMap.fileId);
        if (manifest) {
          const restored = await restoreResumeState({ storage: this.storage, manifest, pieceMap, integrity: this.integrity });
          this.managers.set(pieceMap.fileId, restored.manager);
        }
      }
    }

    if (mergedManifests.length > 0) await this.persistState();
    return { sessionId, manifests: mergedManifests };
  }

  async requestNextPiece(peerId: PeerId, fileId: FileId): Promise<ScheduledPiece | null> {
    const manager = this.requireManager(fileId);
    const scheduled = new OwnerFirstScheduler(peerId, this.maxRetries).next(manager);
    if (!scheduled) return null;
    const requestId = this.createRequestId(fileId, scheduled.piece.index);
    manager.markRequested(scheduled.piece.index, peerId);
    this.outstandingRequests.set(requestId, { fileId, pieceIndex: scheduled.piece.index, peerId, requestedAt: Date.now() });
    await this.sendPieceRequest(peerId, fileId, scheduled.piece.index, requestId);
    await this.persistState();
    return scheduled;
  }

  async requestPieceWindow(peerId: PeerId, fileId: FileId, options: PieceWindowOptions = {}): Promise<ScheduledPiece[]> {
    const maxInFlight = options.maxInFlight ?? 1;
    assertPositiveSafeInteger(maxInFlight, 'maxInFlight');
    const scheduled: ScheduledPiece[] = [];
    while (this.countOutstandingRequests(fileId, peerId) < maxInFlight) {
      const next = await this.requestNextPiece(peerId, fileId);
      if (!next) break;
      scheduled.push(next);
    }
    return scheduled;
  }

  getOutstandingRequestCount(fileId: FileId, peerId?: PeerId): number {
    return this.countOutstandingRequests(fileId, peerId);
  }

  exportPieceMapBroadcast(fileId: FileId): PieceMapBroadcast {
    const manager = this.requireManager(fileId);
    const generation = (this.localPieceMapGenerations.get(fileId) ?? 0) + 1;
    this.localPieceMapGenerations.set(fileId, generation);
    const verifiedPieces = manager.getVerifiedPieces().sort((a, b) => a - b);
    return {
      type: 'PIECE_MAP',
      fileId,
      verifiedPieces,
      totalPieces: this.requireManifest(fileId).pieceCount,
      generation,
      updatedAt: Date.now()
    };
  }

  async broadcastPieceMap(fileId: FileId, peers: readonly PeerId[]): Promise<PieceMapBroadcast> {
    const map = this.exportPieceMapBroadcast(fileId);
    await Promise.all(peers.map(peerId => this.requireTransport().send(peerId, map)));
    return map;
  }

  updatePeerPieceMap(peerId: PeerId, map: PieceMapBroadcast, role: ProviderRole = 'receiver'): void {
    const changed = this.availability.updatePeerPieceMap({
      peerId,
      role,
      map,
      healthScore: this.peerHealth.get(peerId).score
    });
    if (changed) this.events.emit('availabilityChanged', { peerId, fileId: map.fileId, verifiedPieces: [...map.verifiedPieces], generation: map.generation });
  }

  getAvailability(fileId: FileId): PieceAvailabilitySnapshot {
    return this.availability.getSnapshot(fileId) ?? {
      fileId,
      pieceCount: this.requireManifest(fileId).pieceCount,
      pieces: Array.from({ length: this.requireManifest(fileId).pieceCount }, (_, pieceIndex) => ({ pieceIndex, providers: [] }))
    };
  }

  setPeerHealth(peerId: PeerId, patch: Partial<PeerHealth>): void {
    this.peerHealth.set(peerId, patch);
  }

  async requestNextGridPiece(fileId: FileId, options: GridScheduleOptions): Promise<GridScheduleResult> {
    const manager = this.requireManager(fileId);
    const missingPieces = manager.getMissingPieces();
    if (missingPieces.length === 0) return { type: 'idle', reason: 'complete' };
    const now = options.now ?? Date.now();
    this.expireRequestLeases(now);
    const candidates = new Set(options.candidatePeers ?? []);
    candidates.add(options.ownerPeerId);
    if (!this.availability.getSnapshot(fileId)) {
      const manifest = this.requireManifest(fileId);
      this.availability.updatePeerPieceMap({
        peerId: options.ownerPeerId,
        role: 'owner',
        map: {
          type: 'PIECE_MAP',
          fileId,
          verifiedPieces: manifest.pieces.map(piece => piece.index),
          totalPieces: manifest.pieceCount,
          generation: 1,
          updatedAt: now
        },
        healthScore: this.peerHealth.get(options.ownerPeerId).score
      });
    }
    const maxRequestsPerPeer = options.maxRequestsPerPeer ?? 1;
    const activePerPeer = new Map<PeerId, number>();
    for (const request of this.outstandingRequests.values()) activePerPeer.set(request.peerId, (activePerPeer.get(request.peerId) ?? 0) + 1);

    const ranked = missingPieces
      .map(index => {
        const retryCount = manager.getPieceState(index).retryCount;
        const providers = this.rankProviders(fileId, index, candidates, options.ownerPeerId, maxRequestsPerPeer, activePerPeer, now);
        return { index, retryCount, providers };
      })
      .filter(item => !this.availability.getLease(fileId, item.index))
      .sort((a, b) => {
        const aHasReceiver = a.providers.some(provider => provider.role !== 'owner') ? 1 : 0;
        const bHasReceiver = b.providers.some(provider => provider.role !== 'owner') ? 1 : 0;
        if (aHasReceiver !== bHasReceiver) return bHasReceiver - aHasReceiver;
        const rarity = a.providers.filter(provider => provider.role !== 'owner').length - b.providers.filter(provider => provider.role !== 'owner').length;
        if (rarity !== 0) return rarity;
        const retry = a.retryCount - b.retryCount;
        return retry !== 0 ? retry : a.index - b.index;
      });

    for (const item of ranked) {
      if (item.retryCount > this.maxRetries) return { type: 'exhausted', pieceIndex: item.index, reason: 'retry_limit' };
      const provider = item.providers[0];
      if (!provider) continue;
      const requestId = this.createRequestId(fileId, item.index);
      const leaseMs = options.requestLeaseMs ?? 15_000;
      this.availability.lease(fileId, item.index, { peerId: provider.peerId, requestId, leasedAt: now, expiresAt: now + leaseMs });
      manager.markRequested(item.index, provider.peerId);
      this.outstandingRequests.set(requestId, { fileId, pieceIndex: item.index, peerId: provider.peerId, requestedAt: now, gridOptions: options });
      await this.sendPieceRequest(provider.peerId, fileId, item.index, requestId);
      await this.persistState();
      const reason = provider.role === 'owner' ? 'owner_fallback' : item.providers.length === 1 ? 'rarest_first' : 'fastest_peer';
      return { type: 'scheduled', pieceIndex: item.index, peerId: provider.peerId, requestId, reason };
    }

    return { type: 'idle', reason: 'no_available_peer' };
  }

  expireRequestLeases(now = Date.now()): void {
    for (const request of this.availability.expireLeases(now)) {
      const outstanding = this.outstandingRequests.get(request.requestId);
      if (!outstanding) continue;
      this.outstandingRequests.delete(request.requestId);
      this.incomingChunks.delete(request.requestId);
      const manager = this.requireManager(outstanding.fileId);
      manager.markFailed(outstanding.pieceIndex, 'request_timeout');
      manager.resetFailedToMissing(outstanding.pieceIndex);
      this.peerHealth.markTimeout(outstanding.peerId);
      this.emitRetryPerformance({ fileId: outstanding.fileId, pieceIndex: outstanding.pieceIndex, peerId: outstanding.peerId, requestId: request.requestId, reason: 'request_timeout' });
      this.events.emit('requestTimedOut', { fileId: outstanding.fileId, pieceIndex: outstanding.pieceIndex, peerId: outstanding.peerId, requestId: request.requestId });
    }
  }

  private emitRetryPerformance(input: { fileId: FileId; pieceIndex: number; peerId: PeerId; requestId: string; reason: string }): void {
    const retryCount = this.managers.get(input.fileId)?.getPieceState(input.pieceIndex).retryCount ?? 0;
    this.events.emit('performance', {
      type: 'transfer:retry',
      fileId: input.fileId,
      pieceIndex: input.pieceIndex,
      peerId: input.peerId,
      requestId: input.requestId,
      reason: input.reason,
      retryCount,
      maxRetries: this.maxRetries
    });
  }

  async receivePiece(input: { fileId: FileId; pieceIndex: number; requestId: string; data: ArrayBuffer }): Promise<PieceReceiveResult> {
    const manifest = this.requireManifest(input.fileId);
    const descriptor = manifest.pieces[input.pieceIndex];
    if (!descriptor) throw new PonsWarpError('piece:not_found', `Unknown piece ${input.pieceIndex}`, { category: 'piece', recoverable: true });
    const manager = this.requireManager(input.fileId);

    if (!(await this.integrity.verifyPiece(input.data, descriptor))) {
      const outstanding = this.outstandingRequests.get(input.requestId);
      this.availability.release(input.fileId, input.pieceIndex, input.requestId);
      this.outstandingRequests.delete(input.requestId);
      if (outstanding) this.peerHealth.markReject(outstanding.peerId);
      manager.markFailed(input.pieceIndex, 'hash_mismatch');
      if (outstanding) this.emitRetryPerformance({ fileId: input.fileId, pieceIndex: input.pieceIndex, peerId: outstanding.peerId, requestId: input.requestId, reason: 'hash_mismatch' });
      await this.storage.deletePiece(input.fileId, input.pieceIndex);
      this.events.emit('pieceRejected', { fileId: input.fileId, pieceIndex: input.pieceIndex, reason: 'hash_mismatch' });
      this.events.emit('progress', manager.getProgress());
      await this.persistState();
      return { type: 'PIECE_REJECT', fileId: input.fileId, pieceIndex: input.pieceIndex, requestId: input.requestId, reason: 'hash_mismatch', hash: descriptor.hash };
    }

    const writeStartedAt = Date.now();
    await this.storage.writePiece(input.fileId, input.pieceIndex, input.data);
    this.events.emit('performance', { type: 'storage:write', fileId: input.fileId, pieceIndex: input.pieceIndex, bytes: input.data.byteLength, durationMs: Math.max(0, Date.now() - writeStartedAt) });
    manager.markVerified(input.pieceIndex);
    const outstanding = this.outstandingRequests.get(input.requestId);
    this.availability.release(input.fileId, input.pieceIndex, input.requestId);
    this.outstandingRequests.delete(input.requestId);
    if (outstanding) {
      const windowMs = Math.max(1, Date.now() - outstanding.requestedAt);
      this.peerHealth.markSuccess(outstanding.peerId, input.data.byteLength, windowMs);
      this.events.emit('performance', {
        type: 'transfer:speed',
        fileId: input.fileId,
        pieceIndex: input.pieceIndex,
        peerId: outstanding.peerId,
        bytes: input.data.byteLength,
        bps: (input.data.byteLength / windowMs) * 1000,
        windowMs
      });
    }
    if (this.knownPeers.size > 0) await this.broadcastPieceMap(input.fileId, [...this.knownPeers]);
    this.events.emit('pieceVerified', { fileId: input.fileId, pieceIndex: input.pieceIndex });
    this.events.emit('progress', manager.getProgress());
    await this.persistState();
    return { type: 'PIECE_ACK', fileId: input.fileId, pieceIndex: input.pieceIndex, requestId: input.requestId, hash: descriptor.hash };
  }

  async resumeFile(fileId: FileId): Promise<ResumeRestoreResult> {
    const startedAt = Date.now();
    const manifest = this.requireManifest(fileId);
    const manager = this.requireManager(fileId);
    const restored = await restoreResumeState({ storage: this.storage, manifest, pieceMap: manager.exportPieceMap(), integrity: this.integrity });
    this.managers.set(fileId, restored.manager);
    await this.persistState();
    this.events.emit('performance', { type: 'resume:restored', fileId, verifiedPieces: restored.verifiedPieces.length, discardedPieces: restored.discardedPieces.length, durationMs: Math.max(0, Date.now() - startedAt) });
    if (this.knownPeers.size > 0) await this.broadcastPieceMap(fileId, [...this.knownPeers]);
    return restored;
  }

  getProgress(fileId: FileId): TransferProgress {
    return this.requireManager(fileId).getProgress();
  }

  getManifest(fileId: FileId): FileManifest {
    return this.requireManifest(fileId);
  }

  private bindTransport(transport: Transport): void {
    this.transportUnsubscribers.push(
      transport.onMessage((peerId, message) => {
        void this.handleTransportMessage(peerId, message).catch(error => {
          this.events.emit('pieceRejected', { fileId: '' as FileId, pieceIndex: -1, reason: error instanceof Error ? error.message : String(error) });
        });
      }),
      transport.onBinary((peerId, frame) => {
        void this.handleTransportBinary(peerId, frame).catch(error => {
          this.events.emit('pieceRejected', { fileId: '' as FileId, pieceIndex: -1, reason: error instanceof Error ? error.message : String(error) });
        });
      })
    );
  }

  private async handleTransportMessage(peerId: PeerId, message: TransportMessage): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') return;
    this.knownPeers.add(peerId);
    const type = message.type;
    if (type === 'PIECE_REQUEST') {
      await this.queueRequestedPiece(peerId, this.parsePieceRequest(message));
      return;
    }
    if (type === 'PIECE_MAP') {
      this.updatePeerPieceMap(peerId, this.parsePieceMapBroadcast(message), peerId === 'owner' ? 'owner' : 'receiver');
      return;
    }
    if (type === 'PIECE_CHUNK_HEADER') {
      this.pendingChunks.set(peerId, this.parseChunkHeader(message));
      return;
    }
    if (type === 'PIECE_ACK') {
      const requestId = requireStringField(message, 'requestId');
      const outstanding = this.outstandingRequests.get(requestId);
      if (outstanding) {
        this.availability.release(outstanding.fileId, outstanding.pieceIndex, requestId);
        this.peerHealth.markSuccess(outstanding.peerId, 0, Math.max(1, Date.now() - outstanding.requestedAt));
      }
      this.outstandingRequests.delete(requestId);
      return;
    }
    if (type === 'PIECE_REJECT') {
      const requestId = requireStringField(message, 'requestId');
      const outstanding = this.outstandingRequests.get(requestId);
      this.outstandingRequests.delete(requestId);
      if (outstanding) {
        this.availability.release(outstanding.fileId, outstanding.pieceIndex, requestId);
        this.peerHealth.markReject(outstanding.peerId);
        const manager = this.requireManager(outstanding.fileId);
        const reason = requireStringField(message, 'reason');
        manager.markFailed(outstanding.pieceIndex, reason);
        this.emitRetryPerformance({ fileId: outstanding.fileId, pieceIndex: outstanding.pieceIndex, peerId: outstanding.peerId, requestId, reason });
        if (manager.getPieceState(outstanding.pieceIndex).retryCount <= this.maxRetries) {
          manager.resetFailedToMissing(outstanding.pieceIndex);
          if (outstanding.gridOptions) await this.requestNextGridPiece(outstanding.fileId, outstanding.gridOptions);
          else await this.requestNextPiece(outstanding.peerId, outstanding.fileId);
        }
      }
    }
  }

  private async handleTransportBinary(peerId: PeerId, frame: ArrayBuffer): Promise<void> {
    const header = this.pendingChunks.get(peerId);
    if (!header) throw new PonsWarpError('transport:unexpected_binary', `No chunk header for binary frame from ${peerId}`, { category: 'transport', recoverable: true });
    this.pendingChunks.delete(peerId);

    const assembled = await this.appendIncomingChunk(peerId, header, frame);
    if (!assembled) return;

    const outstanding = this.outstandingRequests.get(header.requestId);
    const result = await this.receivePiece({ fileId: header.fileId, pieceIndex: header.pieceIndex, requestId: header.requestId, data: assembled });
    const response: PieceAckMessage | PieceRejectMessage = result.type === 'PIECE_ACK'
      ? { type: 'PIECE_ACK', fileId: result.fileId, pieceIndex: result.pieceIndex, requestId: result.requestId, status: 'verified', hash: result.hash }
      : { type: 'PIECE_REJECT', fileId: result.fileId, pieceIndex: result.pieceIndex, requestId: result.requestId, reason: (result.reason === 'hash_mismatch' ? 'hash_mismatch' : 'missing_piece'), expectedHash: result.hash };
    await this.requireTransport().send(peerId, response);
    if (result.type === 'PIECE_REJECT') {
      const manager = this.requireManager(result.fileId);
      if (manager.getPieceState(result.pieceIndex).retryCount <= this.maxRetries) {
        manager.resetFailedToMissing(result.pieceIndex);
        if (outstanding?.gridOptions) await this.requestNextGridPiece(result.fileId, outstanding.gridOptions);
        else await this.requestNextPiece(peerId, result.fileId);
      }
    }
  }

  private async appendIncomingChunk(peerId: PeerId, header: PieceChunkHeaderMessage, frame: ArrayBuffer): Promise<ArrayBuffer | null> {
    const reject = async (): Promise<null> => {
      await this.rejectIncomingChunk(peerId, header);
      return null;
    };
    if (header.totalChunks <= 0 || !Number.isSafeInteger(header.totalChunks)) return reject();
    if (header.chunkIndex < 0 || header.chunkIndex >= header.totalChunks || !Number.isSafeInteger(header.chunkIndex)) return reject();
    if (header.payloadSize !== frame.byteLength) return reject();

    let assembly = this.incomingChunks.get(header.requestId);
    if (!assembly) {
      assembly = {
        peerId,
        header,
        chunks: Array.from({ length: header.totalChunks }),
        receivedBytes: 0,
        receivedChunks: 0
      };
      this.incomingChunks.set(header.requestId, assembly);
    }

    if (
      assembly.peerId !== peerId ||
      assembly.header.fileId !== header.fileId ||
      assembly.header.pieceIndex !== header.pieceIndex ||
      assembly.header.totalChunks !== header.totalChunks ||
      assembly.chunks[header.chunkIndex]
    ) return reject();

    assembly.chunks[header.chunkIndex] = frame;
    assembly.receivedBytes += frame.byteLength;
    assembly.receivedChunks += 1;
    if (assembly.receivedChunks < header.totalChunks) return null;

    this.incomingChunks.delete(header.requestId);
    const assembled = new Uint8Array(assembly.receivedBytes);
    let offset = 0;
    for (const chunk of assembly.chunks) {
      if (!chunk) return reject();
      assembled.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return assembled.buffer;
  }

  private async rejectIncomingChunk(peerId: PeerId, header: PieceChunkHeaderMessage): Promise<void> {
    const outstanding = this.outstandingRequests.get(header.requestId);
    this.incomingChunks.delete(header.requestId);
    this.outstandingRequests.delete(header.requestId);
    this.availability.release(header.fileId, header.pieceIndex, header.requestId);
    const manager = this.managers.get(header.fileId);
    if (manager) manager.markFailed(header.pieceIndex, 'invalid_chunk');
    this.peerHealth.markReject(peerId);
    if (manager) this.emitRetryPerformance({ fileId: header.fileId, pieceIndex: header.pieceIndex, peerId, requestId: header.requestId, reason: 'invalid_chunk' });
    await this.requireTransport().send(peerId, {
      type: 'PIECE_REJECT',
      fileId: header.fileId,
      pieceIndex: header.pieceIndex,
      requestId: header.requestId,
      reason: 'invalid_chunk'
    } satisfies PieceRejectMessage);
    this.events.emit('pieceRejected', { fileId: header.fileId, pieceIndex: header.pieceIndex, reason: 'invalid_chunk' });
    if (manager) {
      this.events.emit('progress', manager.getProgress());
      if (manager.getPieceState(header.pieceIndex).retryCount <= this.maxRetries) {
        manager.resetFailedToMissing(header.pieceIndex);
        if (outstanding?.gridOptions) await this.requestNextGridPiece(header.fileId, outstanding.gridOptions);
        else await this.requestNextPiece(peerId, header.fileId);
      }
    }
    await this.persistState();
  }

  private async queueRequestedPiece(peerId: PeerId, request: PieceRequestMessage): Promise<void> {
    const previous = this.pieceSendQueues.get(peerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.sendRequestedPiece(peerId, request));
    this.pieceSendQueues.set(peerId, next);
    try {
      await next;
    } finally {
      if (this.pieceSendQueues.get(peerId) === next) this.pieceSendQueues.delete(peerId);
    }
  }

  private async sendRequestedPiece(peerId: PeerId, request: PieceRequestMessage): Promise<void> {
    const manifest = this.requireManifest(request.fileId);
    const piece = manifest.pieces[request.pieceIndex];
    if (!piece) {
      await this.requireTransport().send(peerId, { type: 'PIECE_REJECT', fileId: request.fileId, pieceIndex: request.pieceIndex, requestId: request.requestId, reason: 'missing_piece' } satisfies PieceRejectMessage);
      return;
    }

    const source = this.ownerSources.get(request.fileId);
    let data: ArrayBuffer | null = null;
    if (source) {
      data = await source.slice(piece.offset + request.fromOffset, piece.offset + piece.size).arrayBuffer();
    } else {
      const manager = this.managers.get(request.fileId);
      if (manager?.getPieceState(request.pieceIndex).status === 'verified') {
        const stored = await this.storage.readPiece(request.fileId, request.pieceIndex);
        if (!stored) {
          await this.requireTransport().send(peerId, { type: 'PIECE_REJECT', fileId: request.fileId, pieceIndex: request.pieceIndex, requestId: request.requestId, reason: 'storage_read_failed' } satisfies PieceRejectMessage);
          return;
        }
        data = stored.slice(request.fromOffset);
      }
    }

    if (!data) {
      await this.requireTransport().send(peerId, { type: 'PIECE_REJECT', fileId: request.fileId, pieceIndex: request.pieceIndex, requestId: request.requestId, reason: 'missing_piece' } satisfies PieceRejectMessage);
      return;
    }

    const chunkSize = Math.min(DEFAULT_TRANSFER_CHUNK_BYTES, data.byteLength || DEFAULT_TRANSFER_CHUNK_BYTES);
    const totalChunks = Math.max(1, Math.ceil(data.byteLength / chunkSize));
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const offset = chunkIndex * chunkSize;
      const chunk = new Uint8Array(data, offset, Math.min(chunkSize, data.byteLength - offset));
      await this.requireTransport().send(peerId, {
        type: 'PIECE_CHUNK_HEADER',
        fileId: request.fileId,
        pieceIndex: request.pieceIndex,
        chunkIndex,
        totalChunks,
        requestId: request.requestId,
        payloadSize: chunk.byteLength
      } satisfies PieceChunkHeaderMessage);
      await this.requireTransport().sendBinary(peerId, chunk);
    }
  }

  private parsePieceRequest(message: Record<string, unknown>): PieceRequestMessage {
    return {
      type: 'PIECE_REQUEST',
      fileId: requireStringField(message, 'fileId') as FileId,
      pieceIndex: requireNumberField(message, 'pieceIndex'),
      requestId: requireStringField(message, 'requestId'),
      fromOffset: requireNumberField(message, 'fromOffset')
    };
  }

  private parseChunkHeader(message: Record<string, unknown>): PieceChunkHeaderMessage {
    return {
      type: 'PIECE_CHUNK_HEADER',
      fileId: requireStringField(message, 'fileId') as FileId,
      pieceIndex: requireNumberField(message, 'pieceIndex'),
      chunkIndex: requireNumberField(message, 'chunkIndex'),
      totalChunks: requireNumberField(message, 'totalChunks'),
      requestId: requireStringField(message, 'requestId'),
      payloadSize: requireNumberField(message, 'payloadSize')
    };
  }

  private parsePieceMapBroadcast(message: Record<string, unknown>): PieceMapBroadcast {
    const verifiedPieces = Array.isArray(message.verifiedPieces) ? message.verifiedPieces.map(value => {
      if (typeof value !== 'number') throw new PonsWarpError('availability:invalid_piece_index', 'PIECE_MAP verifiedPieces must be numbers', { category: 'scheduler', recoverable: true });
      return value;
    }) : [];
    return {
      type: 'PIECE_MAP',
      fileId: requireStringField(message, 'fileId') as FileId,
      verifiedPieces,
      totalPieces: requireNumberField(message, 'totalPieces'),
      generation: requireNumberField(message, 'generation'),
      updatedAt: requireNumberField(message, 'updatedAt')
    };
  }

  private rankProviders(
    fileId: FileId,
    pieceIndex: number,
    candidates: Set<PeerId>,
    ownerPeerId: PeerId,
    maxRequestsPerPeer: number,
    activePerPeer: Map<PeerId, number>,
    now: number
  ): ProviderState[] {
    const advertised = this.availability.getProviders(fileId, pieceIndex, now).filter(provider =>
      candidates.has(provider.peerId) &&
      this.peerHealth.get(provider.peerId).connectionState === 'connected' &&
      (activePerPeer.get(provider.peerId) ?? 0) < maxRequestsPerPeer
    );
    for (const provider of advertised) this.knownPeers.add(provider.peerId);
    const hasOwner = advertised.some(provider => provider.peerId === ownerPeerId);
    this.knownPeers.add(ownerPeerId);
    if (!hasOwner && candidates.has(ownerPeerId) && (activePerPeer.get(ownerPeerId) ?? 0) < maxRequestsPerPeer) {
      advertised.push({
        peerId: ownerPeerId,
        role: 'owner',
        verified: true,
        advertisedAt: now,
        expiresAt: now + 30_000,
        healthScore: this.peerHealth.get(ownerPeerId).score
      });
    }
    return advertised.sort((a, b) => {
      const aScore = this.peerHealth.get(a.peerId).score + (a.role === 'owner' ? -5 : 0);
      const bScore = this.peerHealth.get(b.peerId).score + (b.role === 'owner' ? -5 : 0);
      if (bScore !== aScore) return bScore - aScore;
      return (activePerPeer.get(a.peerId) ?? 0) - (activePerPeer.get(b.peerId) ?? 0);
    });
  }

  private async sendPieceRequest(peerId: PeerId, fileId: FileId, pieceIndex: number, requestId: string): Promise<void> {
    await this.requireTransport().send(peerId, {
      type: 'PIECE_REQUEST',
      fileId,
      pieceIndex,
      requestId,
      fromOffset: 0
    } satisfies PieceRequestMessage);
  }

  private createRequestId(fileId: FileId, pieceIndex: number): string {
    return `req_${fileId}_${pieceIndex}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  private countOutstandingRequests(fileId: FileId, peerId?: PeerId): number {
    let count = 0;
    for (const request of this.outstandingRequests.values()) {
      if (request.fileId === fileId && (!peerId || request.peerId === peerId)) count += 1;
    }
    return count;
  }

  private registerManifest(manifest: FileManifest): void {
    this.manifests.set(manifest.fileId, manifest);
    if (!this.managers.has(manifest.fileId)) this.managers.set(manifest.fileId, new PieceManager(manifest.fileId, manifest.pieces));
  }

  private async persistState(): Promise<void> {
    if (!this.sessionId || this.manifests.size === 0) return;
    await this.storage.saveState({
      schemaVersion: 1,
      protocolVersion: CORE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      mode: 'direct',
      manifests: [...this.manifests.values()],
      pieceMaps: [...this.managers.values()].map(manager => manager.exportPieceMap()),
      peers: [],
      updatedAt: Date.now()
    });
  }

  private requireManifest(fileId: FileId): FileManifest {
    const manifest = this.manifests.get(fileId);
    if (!manifest) throw new PonsWarpError('manifest:not_found', `Unknown manifest ${fileId}`, { category: 'manifest', recoverable: true });
    return manifest;
  }

  private requireManager(fileId: FileId): PieceManager {
    const manager = this.managers.get(fileId);
    if (!manager) throw new PonsWarpError('piece_map:not_found', `Unknown piece map ${fileId}`, { category: 'resume', recoverable: true });
    return manager;
  }

  private requireTransport(): Transport {
    if (!this.transport) throw new PonsWarpError('transport:not_configured', 'Engine transport is not configured', { category: 'transport', recoverable: true });
    return this.transport;
  }
}

export interface StorageAdapter {
  init(sessionId: SessionId): Promise<void>;
  writePiece(fileId: FileId, pieceIndex: number, data: ArrayBuffer): Promise<void>;
  readPiece(fileId: FileId, pieceIndex: number): Promise<ArrayBuffer | undefined>;
  hasPiece(fileId: FileId, pieceIndex: number): Promise<boolean>;
  deletePiece(fileId: FileId, pieceIndex: number): Promise<void>;
  saveState(state: PersistedSessionState): Promise<void>;
  loadState(sessionId: SessionId): Promise<PersistedSessionState | null>;
  assembleFile(fileId: FileId, manifest: FileManifest): Promise<Blob>;
  createReadablePieceStream(fileId: FileId, manifest: FileManifest): ReadableStream<Uint8Array>;
  saveAssembledFile(fileId: FileId, manifest: FileManifest, sink?: WritableStream<Uint8Array>): Promise<SaveFileResult>;
  cleanup(sessionId: SessionId): Promise<void>;
}

export type SaveFileResult =
  | { type: 'blob'; blob: Blob; bytes: number }
  | { type: 'stream'; bytes: number }
  | { type: 'unsupported'; reason: string };

const DEFAULT_SAFE_ASSEMBLE_BYTES = 256 * 1024 * 1024;

export type StorageKind = 'opfs' | 'indexeddb' | 'memory';
export type StoragePersistence = 'persistent' | 'best_effort' | 'memory_only';

export interface StorageWarning {
  kind: StorageKind;
  code: string;
  message: string;
}

export interface StorageFactoryOptions {
  preferred?: StorageKind[];
  sessionId?: SessionId;
  quotaProbeBytes?: number;
}

export interface StorageFactoryResult {
  kind: StorageKind;
  adapter: StorageAdapter;
  persistence: StoragePersistence;
  warnings: StorageWarning[];
}

export class MemoryStorageAdapter implements StorageAdapter {
  private sessionId: SessionId | null = null;
  private readonly pieces = new Map<string, ArrayBuffer>();
  private readonly states = new Map<SessionId, PersistedSessionState>();

  async init(sessionId: SessionId): Promise<void> {
    this.sessionId = sessionId;
  }

  async writePiece(fileId: FileId, pieceIndex: number, data: ArrayBuffer): Promise<void> {
    this.requireSession();
    this.pieces.set(this.key(fileId, pieceIndex), data.slice(0));
  }

  async readPiece(fileId: FileId, pieceIndex: number): Promise<ArrayBuffer | undefined> {
    this.requireSession();
    return this.pieces.get(this.key(fileId, pieceIndex))?.slice(0);
  }

  async hasPiece(fileId: FileId, pieceIndex: number): Promise<boolean> {
    this.requireSession();
    return this.pieces.has(this.key(fileId, pieceIndex));
  }

  async deletePiece(fileId: FileId, pieceIndex: number): Promise<void> {
    this.requireSession();
    this.pieces.delete(this.key(fileId, pieceIndex));
  }

  async saveState(state: PersistedSessionState): Promise<void> {
    validatePersistedSessionState(state);
    this.states.set(state.sessionId, cloneSessionState(state));
  }

  async loadState(sessionId: SessionId): Promise<PersistedSessionState | null> {
    const state = this.states.get(sessionId);
    return state ? cloneSessionState(state) : null;
  }

  async assembleFile(fileId: FileId, manifest: FileManifest): Promise<Blob> {
    assertSafeAssembleSize(manifest);
    const parts: BlobPart[] = [];
    for (const piece of manifest.pieces) {
      const data = await this.readPiece(fileId, piece.index);
      if (!data) throw new PonsWarpError('storage:missing_piece', `Missing piece ${piece.index} for ${fileId}`);
      parts.push(data);
    }
    return new Blob(parts, { type: manifest.mimeType });
  }

  createReadablePieceStream(fileId: FileId, manifest: FileManifest): ReadableStream<Uint8Array> {
    return createBackpressurePieceStream(this, fileId, manifest);
  }

  async saveAssembledFile(fileId: FileId, manifest: FileManifest, sink?: WritableStream<Uint8Array>): Promise<SaveFileResult> {
    return saveAssembledFileFromStorage(this, fileId, manifest, sink);
  }
  async cleanup(sessionId: SessionId): Promise<void> {
    this.states.delete(sessionId);
    for (const key of [...this.pieces.keys()]) this.pieces.delete(key);
    if (this.sessionId === sessionId) this.sessionId = null;
  }

  private key(fileId: FileId, index: number): string {
    return `${this.requireSession()}:${fileId}:${index}`;
  }

  private requireSession(): SessionId {
    if (!this.sessionId) throw new PonsWarpError('storage:not_initialized', 'Storage adapter is not initialized');
    return this.sessionId;
  }
}

export class OPFSStorageAdapter implements StorageAdapter {
  private root: FileSystemDirectoryHandle | null = null;
  private sessionId: SessionId | null = null;

  async init(sessionId: SessionId): Promise<void> {
    if (!globalThis.navigator?.storage?.getDirectory) {
      throw new PonsWarpError('storage:opfs_unavailable', 'Origin private file system is not available');
    }
    const storageRoot = await navigator.storage.getDirectory();
    const appRoot = await storageRoot.getDirectoryHandle('ponswarp-grid', { create: true });
    const sessionsRoot = await appRoot.getDirectoryHandle('sessions', { create: true });
    this.root = await sessionsRoot.getDirectoryHandle(sessionId, { create: true });
    this.sessionId = sessionId;
    await this.probe();
  }

  async writePiece(fileId: FileId, pieceIndex: number, data: ArrayBuffer): Promise<void> {
    const handle = await this.getPieceHandle(fileId, pieceIndex, true);
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async readPiece(fileId: FileId, pieceIndex: number): Promise<ArrayBuffer | undefined> {
    try {
      const handle = await this.getPieceHandle(fileId, pieceIndex, false);
      return await (await handle.getFile()).arrayBuffer();
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  async hasPiece(fileId: FileId, pieceIndex: number): Promise<boolean> {
    return (await this.readPiece(fileId, pieceIndex)) !== undefined;
  }

  async deletePiece(fileId: FileId, pieceIndex: number): Promise<void> {
    try {
      const dir = await this.getFileDirectory(fileId, false);
      await dir.removeEntry(`${pieceIndex}.piece`).catch(error => {
        if (!isNotFoundError(error)) throw error;
      });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  async saveState(state: PersistedSessionState): Promise<void> {
    const root = this.requireRoot();
    const handle = await root.getFileHandle('state.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(state));
    await writable.close();
  }

  async loadState(sessionId: SessionId): Promise<PersistedSessionState | null> {
    if (this.sessionId !== sessionId) await this.init(sessionId);
    try {
      const handle = await this.requireRoot().getFileHandle('state.json');
      const parsed: unknown = JSON.parse(await (await handle.getFile()).text());
      validatePersistedSessionState(parsed);
      return parsed;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async assembleFile(fileId: FileId, manifest: FileManifest): Promise<Blob> {
    assertSafeAssembleSize(manifest);
    const parts: BlobPart[] = [];
    for (const piece of manifest.pieces) {
      const data = await this.readPiece(fileId, piece.index);
      if (!data) throw new PonsWarpError('storage:missing_piece', `Missing piece ${piece.index} for ${fileId}`);
      parts.push(data);
    }
    return new Blob(parts, { type: manifest.mimeType });
  }

  createReadablePieceStream(fileId: FileId, manifest: FileManifest): ReadableStream<Uint8Array> {
    return createBackpressurePieceStream(this, fileId, manifest);
  }

  async saveAssembledFile(fileId: FileId, manifest: FileManifest, sink?: WritableStream<Uint8Array>): Promise<SaveFileResult> {
    return saveAssembledFileFromStorage(this, fileId, manifest, sink);
  }
  async cleanup(sessionId: SessionId): Promise<void> {
    if (!globalThis.navigator?.storage?.getDirectory) return;
    const storageRoot = await navigator.storage.getDirectory();
    const appRoot = await storageRoot.getDirectoryHandle('ponswarp-grid', { create: true });
    const sessionsRoot = await appRoot.getDirectoryHandle('sessions', { create: true });
    await sessionsRoot.removeEntry(sessionId, { recursive: true }).catch(error => {
      if (!isNotFoundError(error)) throw error;
    });
    if (this.sessionId === sessionId) {
      this.sessionId = null;
      this.root = null;
    }
  }

  private async getPieceHandle(fileId: FileId, pieceIndex: number, create: boolean): Promise<FileSystemFileHandle> {
    const dir = await this.getFileDirectory(fileId, create);
    return dir.getFileHandle(`${pieceIndex}.piece`, { create });
  }

  private async probe(): Promise<void> {
    const handle = await this.requireRoot().getFileHandle('.probe', { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array([1]));
    await writable.close();
    const data = await (await handle.getFile()).arrayBuffer();
    if (data.byteLength !== 1) throw new PonsWarpError('storage:probe_failed', 'OPFS probe read did not match write');
    await this.requireRoot().removeEntry('.probe');
  }
  private async getFileDirectory(fileId: FileId, create: boolean): Promise<FileSystemDirectoryHandle> {
    return this.requireRoot().getDirectoryHandle(fileId, { create });
  }

  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.root || !this.sessionId) throw new PonsWarpError('storage:not_initialized', 'OPFS storage adapter is not initialized');
    return this.root;
  }
}

export class IndexedDBStorageAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private sessionId: SessionId | null = null;

  constructor(private readonly dbName = 'ponswarp-grid-v1') {}

  async init(sessionId: SessionId): Promise<void> {
    if (!globalThis.indexedDB) throw new PonsWarpError('storage:indexeddb_unavailable', 'IndexedDB is not available');
    this.db = this.db ?? await openPonsWarpDatabase(this.dbName);
    this.sessionId = sessionId;
  }

  async writePiece(fileId: FileId, pieceIndex: number, data: ArrayBuffer): Promise<void> {
    await this.put('pieces', { sessionId: this.requireSession(), fileId, pieceIndex, data: data.slice(0) });
  }

  async readPiece(fileId: FileId, pieceIndex: number): Promise<ArrayBuffer | undefined> {
    const row = await this.get<{ data: ArrayBuffer }>('pieces', [this.requireSession(), fileId, pieceIndex]);
    return row?.data.slice(0);
  }

  async hasPiece(fileId: FileId, pieceIndex: number): Promise<boolean> {
    return (await this.readPiece(fileId, pieceIndex)) !== undefined;
  }

  async deletePiece(fileId: FileId, pieceIndex: number): Promise<void> {
    await this.delete('pieces', [this.requireSession(), fileId, pieceIndex]);
  }

  async saveState(state: PersistedSessionState): Promise<void> {
    validatePersistedSessionState(state);
    await this.put('sessions', { sessionId: state.sessionId, state: cloneSessionState(state) });
    await Promise.all(state.manifests.map(manifest => this.put('manifests', { sessionId: state.sessionId, fileId: manifest.fileId, manifest })));
  }

  async loadState(sessionId: SessionId): Promise<PersistedSessionState | null> {
    if (this.sessionId !== sessionId) await this.init(sessionId);
    const row = await this.get<{ state: PersistedSessionState }>('sessions', sessionId);
    return row ? cloneSessionState(row.state) : null;
  }

  async assembleFile(fileId: FileId, manifest: FileManifest): Promise<Blob> {
    assertSafeAssembleSize(manifest);
    const parts: BlobPart[] = [];
    for (const piece of manifest.pieces) {
      const data = await this.readPiece(fileId, piece.index);
      if (!data) throw new PonsWarpError('storage:missing_piece', `Missing piece ${piece.index} for ${fileId}`);
      parts.push(data);
    }
    return new Blob(parts, { type: manifest.mimeType });
  }

  createReadablePieceStream(fileId: FileId, manifest: FileManifest): ReadableStream<Uint8Array> {
    return createBackpressurePieceStream(this, fileId, manifest);
  }

  async saveAssembledFile(fileId: FileId, manifest: FileManifest, sink?: WritableStream<Uint8Array>): Promise<SaveFileResult> {
    return saveAssembledFileFromStorage(this, fileId, manifest, sink);
  }
  async cleanup(sessionId: SessionId): Promise<void> {
    await this.delete('sessions', sessionId);
    const db = this.requireDb();
    const pieceKeys = await requestToPromise<IDBValidKey[]>(db.transaction('pieces', 'readonly').objectStore('pieces').getAllKeys());
    const manifestKeys = await requestToPromise<IDBValidKey[]>(db.transaction('manifests', 'readonly').objectStore('manifests').getAllKeys());
    await Promise.all(pieceKeys.filter(key => Array.isArray(key) && key[0] === sessionId).map(key => this.delete('pieces', key)));
    await Promise.all(manifestKeys.filter(key => Array.isArray(key) && key[0] === sessionId).map(key => this.delete('manifests', key)));
    if (this.sessionId === sessionId) this.sessionId = null;
  }

  private async put(storeName: string, value: unknown): Promise<void> {
    await requestToPromise(this.requireDb().transaction(storeName, 'readwrite').objectStore(storeName).put(value));
  }

  private async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return requestToPromise<T | undefined>(this.requireDb().transaction(storeName, 'readonly').objectStore(storeName).get(key));
  }

  private async delete(storeName: string, key: IDBValidKey): Promise<void> {
    await requestToPromise(this.requireDb().transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
  }


  private requireSession(): SessionId {
    if (!this.sessionId) throw new PonsWarpError('storage:not_initialized', 'IndexedDB storage adapter is not initialized');
    return this.sessionId;
  }

  private requireDb(): IDBDatabase {
    if (!this.db) throw new PonsWarpError('storage:not_initialized', 'IndexedDB storage adapter is not initialized');
    return this.db;
  }
}

export async function createBrowserStorageAdapter(options: StorageFactoryOptions = {}): Promise<StorageFactoryResult> {
  const preferred = options.preferred ?? ['opfs', 'indexeddb', 'memory'];
  const sessionId = options.sessionId ?? (`storage_probe_${Date.now()}` as SessionId);
  const warnings: StorageWarning[] = [];

  for (const kind of preferred) {
    try {
      const adapter = kind === 'opfs'
        ? new OPFSStorageAdapter()
        : kind === 'indexeddb'
          ? new IndexedDBStorageAdapter()
          : new MemoryStorageAdapter();
      await adapter.init(sessionId);
      await probeStorageAdapter(adapter, options.quotaProbeBytes ?? 1);
      return {
        kind,
        adapter,
        persistence: kind === 'opfs' ? 'persistent' : kind === 'indexeddb' ? 'best_effort' : 'memory_only',
        warnings
      };
    } catch (error) {
      warnings.push({ kind, code: error instanceof PonsWarpError ? error.code : 'storage:init_failed', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const adapter = new MemoryStorageAdapter();
  await adapter.init(sessionId);
  return { kind: 'memory', adapter, persistence: 'memory_only', warnings };
}
async function probeStorageAdapter(adapter: StorageAdapter, bytes: number): Promise<void> {
  const probeFileId = '__probe__' as FileId;
  await adapter.writePiece(probeFileId, 0, new Uint8Array(Math.max(1, bytes)).buffer);
  const data = await adapter.readPiece(probeFileId, 0);
  if (!data || data.byteLength !== Math.max(1, bytes)) throw new PonsWarpError('storage:probe_failed', 'Storage probe read did not match write');
  await adapter.deletePiece(probeFileId, 0);
}

function openPonsWarpDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains('pieces')) db.createObjectStore('pieces', { keyPath: ['sessionId', 'fileId', 'pieceIndex'] });
      if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests', { keyPath: ['sessionId', 'fileId'] });
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error ?? new PonsWarpError('storage:indexeddb_open_failed', 'IndexedDB open failed'));
    request.onsuccess = () => resolve(request.result);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new PonsWarpError('storage:indexeddb_request_failed', 'IndexedDB request failed'));
    request.onsuccess = () => resolve(request.result);
  });
}

function validateManifestShape(value: unknown): void {
  if (!isRecord(value)) throwInvalidResumeState('manifest must be an object');
  if (value.version !== '1.0.0') throwInvalidResumeState('manifest version is invalid');
  if (typeof value.fileId !== 'string' || value.fileId.length === 0) throwInvalidResumeState('manifest fileId is required');
  if (typeof value.name !== 'string') throwInvalidResumeState('manifest name is required');
  if (typeof value.size !== 'number' || value.size < 0) throwInvalidResumeState('manifest size is invalid');
  if (typeof value.pieceSize !== 'number' || value.pieceSize <= 0) throwInvalidResumeState('manifest pieceSize is invalid');
  if (typeof value.pieceCount !== 'number' || value.pieceCount < 0) throwInvalidResumeState('manifest pieceCount is invalid');
  if (!Array.isArray(value.pieces) || value.pieces.length !== value.pieceCount) throwInvalidResumeState('manifest pieces are invalid');
  value.pieces.forEach(validatePieceDescriptorShape);
}

function validatePieceDescriptorShape(value: unknown): void {
  if (!isRecord(value)) throwInvalidResumeState('piece descriptor must be an object');
  if (typeof value.index !== 'number' || value.index < 0) throwInvalidResumeState('piece index is invalid');
  if (typeof value.offset !== 'number' || value.offset < 0) throwInvalidResumeState('piece offset is invalid');
  if (typeof value.size !== 'number' || value.size < 0) throwInvalidResumeState('piece size is invalid');
  if (value.hash !== undefined && typeof value.hash !== 'string') throwInvalidResumeState('piece hash is invalid');
}

function validatePieceMapShape(value: unknown): void {
  if (!isRecord(value)) throwInvalidResumeState('piece map must be an object');
  if (typeof value.fileId !== 'string' || value.fileId.length === 0) throwInvalidResumeState('piece map fileId is required');
  if (!Array.isArray(value.pieces)) throwInvalidResumeState('piece map pieces must be an array');
  if (typeof value.exportedAt !== 'number' || !Number.isFinite(value.exportedAt)) throwInvalidResumeState('piece map exportedAt is invalid');
  for (const piece of value.pieces) validatePieceStateShape(piece);
}

function validatePersistedPeerShape(value: unknown): void {
  if (!isRecord(value)) throwInvalidResumeState('peer state must be an object');
  if (typeof value.peerId !== 'string' || value.peerId.length === 0) throwInvalidResumeState('peerId is required');
  if (value.role !== 'owner' && value.role !== 'receiver') throwInvalidResumeState('peer role is invalid');
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) throwInvalidResumeState('peer updatedAt is invalid');
}
function validatePieceStateShape(value: unknown): void {
  if (!isRecord(value)) throwInvalidResumeState('piece state must be an object');
  if (typeof value.index !== 'number' || value.index < 0) throwInvalidResumeState('piece state index is invalid');
  if (!['missing', 'requested', 'receiving', 'received', 'verified', 'failed'].includes(String(value.status))) throwInvalidResumeState('piece state status is invalid');
  if (typeof value.size !== 'number' || value.size < 0) throwInvalidResumeState('piece state size is invalid');
  if (typeof value.receivedBytes !== 'number' || value.receivedBytes < 0) throwInvalidResumeState('piece state receivedBytes is invalid');
  if (typeof value.retryCount !== 'number' || value.retryCount < 0) throwInvalidResumeState('piece state retryCount is invalid');
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) throwInvalidResumeState('piece state updatedAt is invalid');
}

function throwInvalidResumeState(reason: string): never {
  throw new PonsWarpError('resume:state_invalid', `Persisted session state is invalid: ${reason}`, {
    category: 'resume',
    recoverable: true
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeManifests(persisted: FileManifest[], incoming: FileManifest[]): FileManifest[] {
  const merged = new Map<FileId, FileManifest>();
  for (const manifest of persisted) merged.set(manifest.fileId, manifest);
  for (const manifest of incoming) {
    const existing = merged.get(manifest.fileId);
    if (existing && !manifestsEquivalent(existing, manifest)) {
      throw new PonsWarpError('resume:manifest_mismatch', `Manifest mismatch for ${manifest.fileId}`, { category: 'resume', recoverable: true });
    }
    if (!existing) merged.set(manifest.fileId, manifest);
  }
  return [...merged.values()];
}

function manifestsEquivalent(a: FileManifest, b: FileManifest): boolean {
  return (
    a.version === b.version &&
    a.fileId === b.fileId &&
    a.name === b.name &&
    a.size === b.size &&
    a.mimeType === b.mimeType &&
    a.pieceSize === b.pieceSize &&
    a.pieceCount === b.pieceCount &&
    a.fileHash === b.fileHash &&
    a.pieces.length === b.pieces.length &&
    a.pieces.every((piece, index) => {
      const other = b.pieces[index];
      return other && piece.index === other.index && piece.offset === other.offset && piece.size === other.size && piece.hash === other.hash;
    })
  );
}

function requireStringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) throw new PonsWarpError('protocol:invalid_message', `Missing string field ${key}`, { category: 'protocol', recoverable: true });
  return field;
}

function requireNumberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) throw new PonsWarpError('protocol:invalid_message', `Missing number field ${key}`, { category: 'protocol', recoverable: true });
  return field;
}
function assertSafeAssembleSize(manifest: FileManifest): void {
  if (manifest.size > DEFAULT_SAFE_ASSEMBLE_BYTES) {
    throw new PonsWarpError('storage:assembly_too_large', 'File exceeds safe Blob assembly threshold; use saveAssembledFile with a stream sink', {
      category: 'storage',
      recoverable: true
    });
  }
}
function createBackpressurePieceStream(storage: Pick<StorageAdapter, 'readPiece'>, fileId: FileId, manifest: FileManifest): ReadableStream<Uint8Array> {
  let nextIndex = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (nextIndex >= manifest.pieces.length) {
        controller.close();
        return;
      }
      const piece = manifest.pieces[nextIndex++];
      const data = await storage.readPiece(fileId, piece.index);
      if (!data) throw new PonsWarpError('storage:missing_piece', `Missing piece ${piece.index} for ${fileId}`);
      controller.enqueue(new Uint8Array(data));
    }
  });
}

async function saveAssembledFileFromStorage(storage: StorageAdapter, fileId: FileId, manifest: FileManifest, sink?: WritableStream<Uint8Array>): Promise<SaveFileResult> {
  if (sink) {
    await storage.createReadablePieceStream(fileId, manifest).pipeTo(sink);
    return { type: 'stream', bytes: manifest.size };
  }
  if (manifest.size > DEFAULT_SAFE_ASSEMBLE_BYTES) return { type: 'unsupported', reason: 'file exceeds safe Blob assembly threshold' };
  const blob = await storage.assembleFile(fileId, manifest);
  return { type: 'blob', blob, bytes: blob.size };
}
function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PonsWarpError('validation:invalid_number', `${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PonsWarpError('validation:invalid_number', `${name} must be a positive safe integer`);
  }
}

function clampBytes(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function createFileId(): FileId {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `file_${random}` as FileId;
}

function cloneSessionState(state: PersistedSessionState): PersistedSessionState {
  return {
    schemaVersion: state.schemaVersion,
    protocolVersion: state.protocolVersion,
    sessionId: state.sessionId,
    ownerPeerId: state.ownerPeerId,
    mode: state.mode,
    manifests: state.manifests.map(manifest => ({ ...manifest, pieces: manifest.pieces.map(piece => ({ ...piece })) })),
    pieceMaps: state.pieceMaps.map(pieceMap => ({
      fileId: pieceMap.fileId,
      exportedAt: pieceMap.exportedAt,
      pieces: pieceMap.pieces.map(piece => ({ ...piece }))
    })),
    peers: state.peers.map(peer => ({ ...peer })),
    updatedAt: state.updatedAt
  };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
