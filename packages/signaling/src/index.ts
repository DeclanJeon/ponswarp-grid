import type { FileId, FileManifest, PeerId, SessionId } from '@ponswarp/core';

export const SIGNALING_PROTOCOL = 'ponswarp-grid/signaling' as const;
export const TRANSFER_PROTOCOL = 'ponswarp-grid/transfer' as const;
export const PROTOCOL_VERSION = '1.0.0' as const;

type ProtocolVersion = string;

export type SignalingMessageType =
  | 'CREATE_SESSION'
  | 'SESSION_CREATED'
  | 'JOIN_SESSION'
  | 'SESSION_JOINED'
  | 'PEER_JOINED'
  | 'PEER_LEFT'
  | 'WEBRTC_OFFER'
  | 'WEBRTC_ANSWER'
  | 'ICE_CANDIDATE'
  | 'ERROR';

export type TransferMessageType =
  | 'HELLO'
  | 'MANIFEST'
  | 'PIECE_MAP'
  | 'PIECE_REQUEST'
  | 'PIECE_CANCEL'
  | 'PIECE_ACK'
  | 'PIECE_REJECT'
  | 'RESUME_STATE'
  | 'RESUME_ACCEPTED'
  | 'RESUME_REJECTED'
  | 'ERROR';

const SIGNALING_MESSAGE_TYPES = new Set<SignalingMessageType>([
  'CREATE_SESSION', 'SESSION_CREATED', 'JOIN_SESSION', 'SESSION_JOINED', 'PEER_JOINED', 'PEER_LEFT', 'WEBRTC_OFFER', 'WEBRTC_ANSWER', 'ICE_CANDIDATE', 'ERROR'
]);

const TRANSFER_MESSAGE_TYPES = new Set<TransferMessageType>([
  'HELLO', 'MANIFEST', 'PIECE_MAP', 'PIECE_REQUEST', 'PIECE_CANCEL', 'PIECE_ACK', 'PIECE_REJECT', 'RESUME_STATE', 'RESUME_ACCEPTED', 'RESUME_REJECTED', 'ERROR'
]);

export interface SignalingEnvelope<TPayload = unknown> {
  protocol: typeof SIGNALING_PROTOCOL;
  version: ProtocolVersion;
  messageId: string;
  type: SignalingMessageType;
  sessionId?: SessionId;
  fromPeerId?: PeerId;
  toPeerId?: PeerId;
  timestamp: number;
  payload: TPayload;
}

export interface TransferEnvelope<TPayload = unknown> {
  protocol: typeof TRANSFER_PROTOCOL;
  version: ProtocolVersion;
  messageId: string;
  type: TransferMessageType;
  sessionId: SessionId;
  fromPeerId: PeerId;
  toPeerId?: PeerId;
  timestamp: number;
  payload: TPayload;
}

export interface ProtocolWarning {
  code: 'protocol:unknown_message' | 'protocol:malformed_message';
  message: string;
  raw?: unknown;
}

export interface SessionFileSummary {
  fileId: FileId;
  name: string;
  size: number;
  pieceSize: number;
  pieceCount: number;
}

export type SessionFileDescriptor = SessionFileSummary | FileManifest;

export interface PeerSummary {
  peerId: PeerId;
  role: 'owner' | 'receiver';
}

interface MutableRoomRecord {
  sessionId: SessionId;
  ownerPeerId: PeerId;
  files: SessionFileDescriptor[];
  peers: Map<PeerId, PeerSummary>;
  createdAt: number;
  expiresAt: number;
}

export interface RoomSnapshot {
  readonly sessionId: SessionId;
  readonly ownerPeerId: PeerId;
  readonly files: readonly SessionFileDescriptor[];
  readonly peers: readonly PeerSummary[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RelayResult {
  sessionId: SessionId;
  fromPeerId: PeerId;
  toPeerId: PeerId;
  envelope: SignalingEnvelope;
}

export class RoomManager {
  private readonly rooms = new Map<SessionId, MutableRoomRecord>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  createSession(input: { sessionId: SessionId; ownerPeerId: PeerId; files: SessionFileDescriptor[]; ttlMs: number }): RoomSnapshot {
    if (this.rooms.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
    const createdAt = this.now();
    const record: MutableRoomRecord = {
      sessionId: input.sessionId,
      ownerPeerId: input.ownerPeerId,
      files: input.files.map(file => ({ ...file })),
      peers: new Map([[input.ownerPeerId, { peerId: input.ownerPeerId, role: 'owner' }]]),
      createdAt,
      expiresAt: createdAt + input.ttlMs
    };
    this.rooms.set(input.sessionId, record);
    return toRoomSnapshot(record);
  }

  joinSession(sessionId: SessionId, peerId: PeerId, role: 'receiver' = 'receiver'): RoomSnapshot {
    const room = this.getMutableLiveRoom(sessionId);
    room.peers.set(peerId, { peerId, role });
    return toRoomSnapshot(room);
  }

  leaveSession(sessionId: SessionId, peerId: PeerId): boolean {
    const room = this.rooms.get(sessionId);
    if (!room) return false;
    const deleted = room.peers.delete(peerId);
    if (peerId === room.ownerPeerId || room.peers.size === 0) this.rooms.delete(sessionId);
    return deleted;
  }

  relayWebRtc(envelope: SignalingEnvelope): RelayResult {
    if (!envelope.sessionId || !envelope.fromPeerId || !envelope.toPeerId) throw new Error('Relay envelope requires sessionId, fromPeerId, and toPeerId');
    if (!['WEBRTC_OFFER', 'WEBRTC_ANSWER', 'ICE_CANDIDATE'].includes(envelope.type)) throw new Error(`Cannot relay non-WebRTC message ${envelope.type}`);
    const room = this.getMutableLiveRoom(envelope.sessionId);
    if (!room.peers.has(envelope.fromPeerId)) throw new Error(`Unknown source peer: ${envelope.fromPeerId}`);
    if (!room.peers.has(envelope.toPeerId)) throw new Error(`Unknown target peer: ${envelope.toPeerId}`);
    return { sessionId: envelope.sessionId, fromPeerId: envelope.fromPeerId, toPeerId: envelope.toPeerId, envelope };
  }

  getLiveRoom(sessionId: SessionId): RoomSnapshot { return toRoomSnapshot(this.getMutableLiveRoom(sessionId)); }
  listPeers(sessionId: SessionId): PeerSummary[] { return this.getLiveRoom(sessionId).peers.map(peer => ({ ...peer })); }

  cleanupExpired(): number {
    let removed = 0;
    for (const [sessionId, room] of this.rooms) {
      if (room.expiresAt <= this.now()) { this.rooms.delete(sessionId); removed += 1; }
    }
    return removed;
  }

  private getMutableLiveRoom(sessionId: SessionId): MutableRoomRecord {
    const room = this.rooms.get(sessionId);
    if (!room) throw new Error(`Unknown session: ${sessionId}`);
    if (room.expiresAt <= this.now()) { this.rooms.delete(sessionId); throw new Error(`Expired session: ${sessionId}`); }
    return room;
  }
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: EventListener): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: EventListener): void;
}

export type SignalingConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closing' | 'closed' | 'failed';
export type WebSocketFactory = (url: string) => WebSocketLike;

export class SignalingClient {
  private messageListeners = new Set<(envelope: SignalingEnvelope) => void>();
  private warningListeners = new Set<(warning: ProtocolWarning) => void>();
  private errorListeners = new Set<(error: Error) => void>();

  constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener('message', this.handleMessage);
  }

  onMessage(listener: (envelope: SignalingEnvelope) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onWarning(listener: (warning: ProtocolWarning) => void): () => void { this.warningListeners.add(listener); return () => this.warningListeners.delete(listener); }
  onError(listener: (error: Error) => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }

  send(envelope: SignalingEnvelope): void {
    if (this.socket.readyState !== 1) throw new Error('Signaling socket is not open');
    this.socket.send(encodeSignaling(envelope));
  }

  dispose(): void {
    this.socket.removeEventListener('message', this.handleMessage);
    this.messageListeners.clear();
    this.warningListeners.clear();
    this.errorListeners.clear();
  }

  private readonly handleMessage = (event: Event): void => {
    const data = (event as MessageEvent).data;
    if (typeof data !== 'string') {
      this.emitError(new Error('Signaling message must be text JSON'));
      return;
    }
    try {
      const envelope = decodeSignaling(data);
      this.messageListeners.forEach(listener => listener(envelope));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Unknown signaling message type:')) {
        this.emitWarning({ code: 'protocol:unknown_message', message, raw: data });
        return;
      }
      this.emitError(error instanceof Error ? error : new Error(message));
    }
  };

  private emitWarning(warning: ProtocolWarning): void { this.warningListeners.forEach(listener => listener(warning)); }
  private emitError(error: Error): void { this.errorListeners.forEach(listener => listener(error)); }
}

export interface BrowserSignalingClientOptions {
  url: string;
  socketFactory?: WebSocketFactory;
  reconnectDelaysMs?: number[];
}

export class BrowserSignalingClient {
  private socket?: WebSocketLike;
  private client?: SignalingClient;
  private state: SignalingConnectionState = 'idle';
  private reconnectAttempt = 0;
  private readonly stateListeners = new Set<(state: SignalingConnectionState) => void>();
  private readonly messageListeners = new Set<(envelope: SignalingEnvelope) => void>();
  private readonly warningListeners = new Set<(warning: ProtocolWarning) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly reconnectDelaysMs: number[];

  constructor(private readonly options: BrowserSignalingClientOptions) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? [250, 500, 1000, 2000, 5000, 10000];
  }

  getState(): SignalingConnectionState { return this.state; }

  async connect(): Promise<void> {
    if (this.state === 'open' || this.state === 'connecting') return;
    await this.openSocket(this.state === 'failed' || this.state === 'closed' ? 'reconnecting' : 'connecting');
  }

  send(envelope: SignalingEnvelope): void {
    if (!this.client) throw new Error('Signaling client is not connected');
    this.client.send(envelope);
  }

  createSession(input: { ownerPeerId: PeerId; files: SessionFileDescriptor[]; sessionId?: SessionId; mode?: 'direct' | 'grid' }): void {
    this.send({
      protocol: SIGNALING_PROTOCOL,
      version: PROTOCOL_VERSION,
      messageId: `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type: 'CREATE_SESSION',
      sessionId: input.sessionId,
      fromPeerId: input.ownerPeerId,
      timestamp: Date.now(),
      payload: { ownerPeerId: input.ownerPeerId, mode: input.mode ?? 'grid', files: input.files }
    });
  }

  joinSession(input: { sessionId: SessionId; peerId: PeerId; role?: 'receiver' }): void {
    this.send({
      protocol: SIGNALING_PROTOCOL,
      version: PROTOCOL_VERSION,
      messageId: `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type: 'JOIN_SESSION',
      sessionId: input.sessionId,
      fromPeerId: input.peerId,
      timestamp: Date.now(),
      payload: { role: input.role ?? 'receiver' }
    });
  }

  sendRelay(envelope: SignalingEnvelope): void {
    if (!['WEBRTC_OFFER', 'WEBRTC_ANSWER', 'ICE_CANDIDATE'].includes(envelope.type)) throw new Error(`Cannot relay ${envelope.type}`);
    this.send(envelope);
  }

  onState(listener: (state: SignalingConnectionState) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  onMessage(listener: (envelope: SignalingEnvelope) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onWarning(listener: (warning: ProtocolWarning) => void): () => void { this.warningListeners.add(listener); return () => this.warningListeners.delete(listener); }
  onError(listener: (error: Error) => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }

  async close(): Promise<void> {
    this.setState('closing');
    this.client?.dispose();
    this.socket?.close();
    this.client = undefined;
    this.socket = undefined;
    this.setState('closed');
  }

  private openSocket(openingState: SignalingConnectionState): Promise<void> {
    this.setState(openingState);
    const socket = this.createSocket();
    this.socket = socket;
    this.client = new SignalingClient(socket);
    this.client.onMessage(envelope => this.messageListeners.forEach(listener => listener(envelope)));
    this.client.onWarning(warning => this.warningListeners.forEach(listener => listener(warning)));
    this.client.onError(error => this.errorListeners.forEach(listener => listener(error)));

    return new Promise((resolve, reject) => {
      let opened = false;
      const onOpen = (): void => {
        opened = true;
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        this.reconnectAttempt = 0;
        this.setState('open');
        resolve();
      };
      const onError = (): void => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        if (opened) {
          const error = new Error('Signaling socket error');
          this.errorListeners.forEach(listener => listener(error));
          return;
        }
        socket.removeEventListener('close', onClose);
        this.setState('failed');
        const error = new Error('Signaling socket failed to open');
        this.errorListeners.forEach(listener => listener(error));
        reject(error);
      };
      const onClose = (): void => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        if (this.state !== 'closing' && this.state !== 'closed') void this.scheduleReconnect();
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      if (socket.readyState === 1) onOpen();
    });
  }

  private async scheduleReconnect(): Promise<void> {
    this.client?.dispose();
    this.client = undefined;
    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.setState('reconnecting');
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await this.openSocket('reconnecting');
    } catch {
      if (this.state !== 'closed' && this.state !== 'closing') void this.scheduleReconnect();
    }
  }

  private createSocket(): WebSocketLike {
    if (this.options.socketFactory) return this.options.socketFactory(this.options.url);
    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!WebSocketCtor) throw new Error('WebSocket is not available in this runtime');
    return new WebSocketCtor(this.options.url);
  }

  private setState(state: SignalingConnectionState): void {
    this.state = state;
    this.stateListeners.forEach(listener => listener(state));
  }
}

function toRoomSnapshot(record: MutableRoomRecord): RoomSnapshot {
  return Object.freeze({
    sessionId: record.sessionId,
    ownerPeerId: record.ownerPeerId,
    files: Object.freeze(record.files.map(file => Object.freeze({ ...file }))),
    peers: Object.freeze([...record.peers.values()].map(peer => Object.freeze({ ...peer }))),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  });
}

export function encodeSignaling<TPayload>(envelope: SignalingEnvelope<TPayload>): string { validateSignalingEnvelope(envelope); return JSON.stringify(envelope); }
export function decodeSignaling(value: string): SignalingEnvelope { const decoded = JSON.parse(value) as Partial<SignalingEnvelope>; validateSignalingEnvelope(decoded); return decoded as SignalingEnvelope; }
export function encodeTransfer<TPayload>(envelope: TransferEnvelope<TPayload>): string { validateTransferEnvelope(envelope); return JSON.stringify(envelope); }
export function decodeTransfer(value: string): TransferEnvelope { const decoded = JSON.parse(value) as Partial<TransferEnvelope>; validateTransferEnvelope(decoded); return decoded as TransferEnvelope; }

function validateSignalingEnvelope(envelope: Partial<SignalingEnvelope>): void {
  if (envelope.protocol !== SIGNALING_PROTOCOL) throw new Error('Invalid signaling protocol');
  validateCompatibleVersion(envelope.version, 'signaling');
  if (!envelope.messageId || typeof envelope.timestamp !== 'number' || typeof envelope.type !== 'string') throw new Error('Malformed signaling envelope');
  if (!SIGNALING_MESSAGE_TYPES.has(envelope.type as SignalingMessageType)) throw new Error(`Unknown signaling message type: ${envelope.type}`);
  if (!Object.prototype.hasOwnProperty.call(envelope, 'payload')) throw new Error('Malformed signaling envelope payload');
  validateSignalingPayload(envelope as SignalingEnvelope);
}

function validateTransferEnvelope(envelope: Partial<TransferEnvelope>): void {
  if (envelope.protocol !== TRANSFER_PROTOCOL) throw new Error('Invalid transfer protocol');
  validateCompatibleVersion(envelope.version, 'transfer');
  if (!envelope.messageId || typeof envelope.timestamp !== 'number' || typeof envelope.type !== 'string') throw new Error('Malformed transfer envelope');
  if (!envelope.sessionId || !envelope.fromPeerId) throw new Error('Malformed transfer routing');
  if (!TRANSFER_MESSAGE_TYPES.has(envelope.type as TransferMessageType)) throw new Error(`Unknown transfer message type: ${envelope.type}`);
  if (!Object.prototype.hasOwnProperty.call(envelope, 'payload')) throw new Error('Malformed transfer envelope payload');
  validateTransferPayload(envelope as TransferEnvelope);
}

function validateCompatibleVersion(version: unknown, protocol: string): void {
  if (typeof version !== 'string') throw new Error(`Malformed ${protocol} protocol version`);
  const [major] = version.split('.');
  const [expectedMajor] = PROTOCOL_VERSION.split('.');
  if (major !== expectedMajor) throw new Error(`Unsupported ${protocol} protocol major version`);
}

function validateSignalingPayload(envelope: SignalingEnvelope): void {
  const payload = requirePayloadRecord(envelope.payload, envelope.type);
  switch (envelope.type) {
    case 'CREATE_SESSION': requireString(payload, 'ownerPeerId', envelope.type); validateSessionFileDescriptors(requireArray(payload, 'files', envelope.type), envelope.type); break;
    case 'SESSION_CREATED': requireString(payload, 'ownerPeerId', envelope.type); requireNumber(payload, 'expiresAt', envelope.type); requireString(payload, 'shareUrl', envelope.type); break;
    case 'JOIN_SESSION': requireString(payload, 'role', envelope.type); break;
    case 'SESSION_JOINED': requireString(payload, 'selfPeerId', envelope.type); requireString(payload, 'ownerPeerId', envelope.type); validatePeers(requireArray(payload, 'peers', envelope.type), envelope.type); validateSessionFileDescriptors(requireArray(payload, 'files', envelope.type), envelope.type); break;
    case 'PEER_JOINED': case 'PEER_LEFT': requireString(payload, 'peerId', envelope.type); break;
    case 'WEBRTC_OFFER': validateSdp(requireRecord(payload, 'sdp', envelope.type), 'offer', envelope.type); break;
    case 'WEBRTC_ANSWER': validateSdp(requireRecord(payload, 'sdp', envelope.type), 'answer', envelope.type); break;
    case 'ICE_CANDIDATE': validateIceCandidate(requireRecord(payload, 'candidate', envelope.type), envelope.type); break;
    case 'ERROR': requireString(payload, 'code', envelope.type); requireString(payload, 'message', envelope.type); break;
  }
}

function validateTransferPayload(envelope: TransferEnvelope): void {
  const payload = requirePayloadRecord(envelope.payload, envelope.type);
  switch (envelope.type) {
    case 'HELLO': requireString(payload, 'role', envelope.type); validateSupports(requireRecord(payload, 'supports', envelope.type), envelope.type); break;
    case 'MANIFEST': validateManifests(requireArray(payload, 'files', envelope.type), envelope.type); break;
    case 'PIECE_MAP': requireString(payload, 'fileId', envelope.type); validateNumberArray(requireArray(payload, 'verifiedPieces', envelope.type), envelope.type, 'verifiedPieces'); requireNumber(payload, 'pieceCount', envelope.type); break;
    case 'PIECE_REQUEST': requirePieceRequestLike(payload, envelope.type); requireNumber(payload, 'fromOffset', envelope.type); break;
    case 'PIECE_CANCEL': requirePieceRequestLike(payload, envelope.type); requireString(payload, 'reason', envelope.type); break;
    case 'PIECE_ACK': requirePieceRequestLike(payload, envelope.type); requireString(payload, 'status', envelope.type); requireString(payload, 'hash', envelope.type); break;
    case 'PIECE_REJECT': requirePieceRequestLike(payload, envelope.type); requireString(payload, 'reason', envelope.type); break;
    case 'RESUME_STATE': requireString(payload, 'fileId', envelope.type); requireString(payload, 'manifestHash', envelope.type); validateNumberArray(requireArray(payload, 'verifiedPieces', envelope.type), envelope.type, 'verifiedPieces'); requireNumber(payload, 'missingCount', envelope.type); break;
    case 'RESUME_ACCEPTED': requireString(payload, 'fileId', envelope.type); requireString(payload, 'nextStrategy', envelope.type); break;
    case 'RESUME_REJECTED': requireString(payload, 'fileId', envelope.type); requireString(payload, 'reason', envelope.type); break;
    case 'ERROR': requireString(payload, 'code', envelope.type); requireString(payload, 'message', envelope.type); break;
  }
}

function requirePieceRequestLike(payload: Record<string, unknown>, type: string): void { requireString(payload, 'fileId', type); requireNumber(payload, 'pieceIndex', type); requireString(payload, 'requestId', type); }
function requirePayloadRecord(value: unknown, type: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(`Malformed ${type} payload`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireString(payload: Record<string, unknown>, key: string, type: string): string { if (typeof payload[key] !== 'string' || payload[key] === '') throw new Error(`Malformed ${type} payload: missing ${key}`); return payload[key]; }
function requireNumber(payload: Record<string, unknown>, key: string, type: string): number { if (typeof payload[key] !== 'number' || !Number.isFinite(payload[key])) throw new Error(`Malformed ${type} payload: missing ${key}`); return payload[key]; }
function requireArray(payload: Record<string, unknown>, key: string, type: string): unknown[] { if (!Array.isArray(payload[key])) throw new Error(`Malformed ${type} payload: missing ${key}`); return payload[key]; }
function requireRecord(payload: Record<string, unknown>, key: string, type: string): Record<string, unknown> { if (!isRecord(payload[key])) throw new Error(`Malformed ${type} payload: missing ${key}`); return payload[key]; }

function validateSdp(value: Record<string, unknown>, expectedType: 'offer' | 'answer', type: string): void { if (value.type !== expectedType || typeof value.sdp !== 'string' || value.sdp === '') throw new Error(`Malformed ${type} payload: invalid sdp`); }
function validateIceCandidate(value: Record<string, unknown>, type: string): void { requireString(value, 'candidate', type); if (value.sdpMid !== null && value.sdpMid !== undefined && typeof value.sdpMid !== 'string') throw new Error(`Malformed ${type} payload: invalid sdpMid`); if (value.sdpMLineIndex !== null && value.sdpMLineIndex !== undefined && typeof value.sdpMLineIndex !== 'number') throw new Error(`Malformed ${type} payload: invalid sdpMLineIndex`); }
function validateSupports(value: Record<string, unknown>, type: string): void { for (const key of ['resume', 'pieceMap', 'binaryFrameV1']) if (typeof value[key] !== 'boolean') throw new Error(`Malformed ${type} payload: invalid supports.${key}`); }
function validateNumberArray(values: unknown[], type: string, key: string): void { if (!values.every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0)) throw new Error(`Malformed ${type} payload: invalid ${key}`); }
function validatePeers(values: unknown[], type: string): void { for (const value of values) { const peer = requirePayloadRecord(value, type); requireString(peer, 'peerId', type); requireString(peer, 'role', type); } }
function validateFileSummaries(values: unknown[], type: string): void { for (const value of values) { const file = requirePayloadRecord(value, type); requireString(file, 'fileId', type); requireString(file, 'name', type); requireNumber(file, 'size', type); requireNumber(file, 'pieceSize', type); requireNumber(file, 'pieceCount', type); } }
function validateSessionFileDescriptors(values: unknown[], type: string): void {
  for (const value of values) {
    const file = requirePayloadRecord(value, type);
    validateFileSummaries([file], type);
    if (Array.isArray(file.pieces)) {
      requireString(file, 'version', type);
      if (typeof file.mimeType !== 'string') throw new Error(`Malformed ${type} payload: invalid mimeType`);
      validatePieces(file.pieces, type);
    }
  }
}
function validateManifests(values: unknown[], type: string): void { for (const value of values) { const file = requirePayloadRecord(value, type); validateFileSummaries([file], type); requireString(file, 'version', type); if (typeof file.mimeType !== 'string') throw new Error(`Malformed ${type} payload: invalid mimeType`); validatePieces(requireArray(file, 'pieces', type), type); } }
function validatePieces(values: unknown[], type: string): void { for (const value of values) { const piece = requirePayloadRecord(value, type); requireNumber(piece, 'index', type); requireNumber(piece, 'offset', type); requireNumber(piece, 'size', type); if (piece.hash !== undefined && typeof piece.hash !== 'string') throw new Error(`Malformed ${type} payload: invalid piece hash`); } }
