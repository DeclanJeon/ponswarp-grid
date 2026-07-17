import type { BinaryFrame, PeerId, Transport, TransportMessage, TransportMessageHandler, BinaryFrameHandler, Unsubscribe } from '@ponswarp/core';

const KIB = 1024;
const MIB = 1024 * KIB;
const MIN_PENDING_SEND_BYTES = 256 * KIB;
const TEXT_ENCODER = new TextEncoder();

export interface FlowControlProfile {
  chunkSize: number;
  highWaterMark: number;
  lowWaterMark: number;
  batchSize: number;
  prefetchBufferSize: number;
}

export const DEFAULT_FLOW_CONTROL_PROFILE: FlowControlProfile = {
  chunkSize: 16 * KIB,
  highWaterMark: 16 * MIB,
  lowWaterMark: 8 * MIB,
  batchSize: 1,
  prefetchBufferSize: 0
};

export function clampDataChannelChunkSize(requestedBytes: number, maxMessageSize?: number | null): number {
  const protocolFloor = 16 * KIB;
  // Hard ceiling keeps SCTP friendly; allow room above the historical 16 KiB default
  // when the peer reports a larger maxMessageSize (common browser values are 256 KiB+).
  const hardCap = 256 * KIB;
  const requested = Number.isFinite(requestedBytes) ? Math.floor(requestedBytes) : protocolFloor;
  const reportedMax = typeof maxMessageSize === 'number' && maxMessageSize > 0
    ? Math.floor(maxMessageSize)
    : hardCap;
  const upper = Math.min(hardCap, reportedMax);
  if (requested <= 0) return protocolFloor;
  // Prefer the requested size when it fits; never exceed the peer/protocol ceiling.
  // Floor at 16 KiB only when the caller asked for at least that much, otherwise
  // honor smaller diagnostic sizes that still fit under the ceiling.
  if (requested < protocolFloor) return Math.min(requested, upper);
  return Math.min(Math.max(requested, protocolFloor), upper);
}

/** ICE path kind used to pick bulk transfer watermarks / chunk targets. */
export type CandidatePathKind = 'host' | 'srflx' | 'relay' | 'unknown';

export interface TransferDiagnostics {
  candidatePathKind?: CandidatePathKind | null;
  availableOutgoingBitrateBps?: number | null;
  rttMs?: number | null;
}

export interface TransferTuningProfile {
  pathKind: CandidatePathKind;
  chunkSizeBytes: number;
  minInFlightBytes: number;
  initialInFlightBytes: number;
  maxInFlightBytes: number;
  lowWaterBytes: number;
}

export const DIRECT_HOST_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  pathKind: 'host',
  chunkSizeBytes: 64 * KIB,
  minInFlightBytes: 2 * MIB,
  initialInFlightBytes: 4 * MIB,
  maxInFlightBytes: 8 * MIB,
  lowWaterBytes: 1 * MIB
};

export const DIRECT_SRFLX_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  ...DIRECT_HOST_TRANSFER_TUNING_PROFILE,
  pathKind: 'srflx',
  maxInFlightBytes: 6 * MIB
};

export const RELAY_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  pathKind: 'relay',
  chunkSizeBytes: 32 * KIB,
  minInFlightBytes: 512 * KIB,
  initialInFlightBytes: 1 * MIB,
  maxInFlightBytes: 2 * MIB,
  lowWaterBytes: 256 * KIB
};

export const UNKNOWN_TRANSFER_TUNING_PROFILE: TransferTuningProfile = {
  ...DIRECT_HOST_TRANSFER_TUNING_PROFILE,
  pathKind: 'unknown',
  maxInFlightBytes: 4 * MIB
};

export function selectTransferTuningProfile(diagnostics?: Partial<TransferDiagnostics> | null): TransferTuningProfile {
  switch (diagnostics?.candidatePathKind) {
    case 'host':
      return DIRECT_HOST_TRANSFER_TUNING_PROFILE;
    case 'srflx':
      return DIRECT_SRFLX_TRANSFER_TUNING_PROFILE;
    case 'relay':
      return RELAY_TRANSFER_TUNING_PROFILE;
    default:
      return UNKNOWN_TRANSFER_TUNING_PROFILE;
  }
}

/**
 * BDP-style in-flight target. Direct (host/srflx) paths use a more aggressive
 * multiple because Chrome's availableOutgoingBitrate is often pessimistic on LAN.
 * Ported from ponswarp transferFlowControl path profiles.
 */
export function selectInFlightTargetBytes(
  profile: TransferTuningProfile,
  diagnostics?: Partial<TransferDiagnostics> | null
): number {
  const direct = diagnostics?.candidatePathKind === 'host' || diagnostics?.candidatePathKind === 'srflx';
  const bitrate = diagnostics?.availableOutgoingBitrateBps;
  const rttMs = diagnostics?.rttMs;
  if (
    typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0
    && typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0
  ) {
    const bdp = Math.floor((bitrate / 8) * Math.max(rttMs, 10) / 1000 * (direct ? 16 : 4));
    return Math.max(profile.minInFlightBytes, Math.min(profile.maxInFlightBytes, Math.max(bdp, profile.initialInFlightBytes)));
  }
  return direct || diagnostics?.candidatePathKind === 'unknown'
    ? profile.maxInFlightBytes
    : profile.initialInFlightBytes;
}

export function calculateSendBudget(params: {
  targetInFlightBytes: number;
  bufferedAmountBytes: number;
  paused?: boolean;
}): number {
  if (params.paused) return 0;
  return Math.max(0, Math.floor(params.targetInFlightBytes) - Math.max(0, Math.floor(params.bufferedAmountBytes)));
}

export function flowControlProfileFromTuning(profile: TransferTuningProfile): FlowControlProfile {
  return {
    chunkSize: clampDataChannelChunkSize(profile.chunkSizeBytes),
    highWaterMark: profile.maxInFlightBytes,
    lowWaterMark: profile.lowWaterBytes,
    batchSize: 1,
    prefetchBufferSize: 0
  };
}

export function shouldRequestMoreChunks(params: {
  isProcessingBatch: boolean;
  isTransferring: boolean;
  workerReady: boolean;
  activePeerCount: number;
  highestBufferedAmount: number;
  highWaterMark: number;
  pausedPeerCount: number;
  pendingAckCount?: number;
}): boolean {
  return params.isTransferring && params.workerReady && !params.isProcessingBatch && params.activePeerCount > 0 && params.pausedPeerCount === 0 && (params.pendingAckCount ?? 0) === 0 && params.highestBufferedAmount < params.highWaterMark;
}

export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message' | 'bufferedamountlow', listener: EventListener): void;
  removeEventListener(type: 'open' | 'close' | 'error' | 'message' | 'bufferedamountlow', listener: EventListener): void;
}

export interface PeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState;
  createDataChannel(label: string, options?: RTCDataChannelInit): DataChannelLike;
  close(): void;
  addEventListener(type: 'connectionstatechange' | 'icecandidate' | 'datachannel', listener: EventListener): void;
  removeEventListener(type: 'connectionstatechange' | 'icecandidate' | 'datachannel', listener: EventListener): void;
}

export interface WatermarkEvent {
  peerId: PeerId;
  phase: 'high' | 'low';
  bufferedAmount: number;
  highWaterMark: number;
  lowWaterMark: number;
  timestamp: number;
}

export type DataChannelEventMap = {
  open: void;
  close: void;
  error: Event;
  message: string | ArrayBuffer;
  drain: void;
  watermark: WatermarkEvent;
};

export interface PeerConnectionEvents {
  channel: DataChannelWrapper;
  connectionState: RTCPeerConnectionState;
  iceCandidate: RTCIceCandidate | null;
  close: void;
}

export interface TransportEvents {
  message: { peerId: PeerId; message: unknown };
  binary: { peerId: PeerId; data: ArrayBuffer };
  peerState: { peerId: PeerId; state: RTCPeerConnectionState };
  error: { peerId: PeerId; error: Error };
  watermark: WatermarkEvent;
}

type DrainWaiter = { resolveIfWritable: () => void; reject: (reason: Error) => void };
type Handler<T> = (event: T) => void;

class Emitter<TEvents extends object> {
  private readonly handlers = new Map<keyof TEvents, Set<Handler<TEvents[keyof TEvents]>>>();

  on<TType extends keyof TEvents>(type: TType, handler: Handler<TEvents[TType]>): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set<Handler<TEvents[keyof TEvents]>>();
    set.add(handler as Handler<TEvents[keyof TEvents]>);
    this.handlers.set(type, set);
    return () => set.delete(handler as Handler<TEvents[keyof TEvents]>);
  }

  emit<TType extends keyof TEvents>(type: TType, event: TEvents[TType]): void {
    this.handlers.get(type)?.forEach(handler => handler(event));
  }

  clear(): void { this.handlers.clear(); }
}

export class DataChannelWrapper {
  private readonly emitter = new Emitter<DataChannelEventMap>();
  private readonly drainWaiters = new Set<DrainWaiter>();
  private readonly pendingSends: Array<{
    send: () => void;
    bytes: number;
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];
  private pendingSendBytes = 0;
  private pumpingSends = false;
  private watermarkBlocked = false;

  constructor(readonly peerId: PeerId, readonly channel: DataChannelLike, readonly flowControl: FlowControlProfile = DEFAULT_FLOW_CONTROL_PROFILE) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = flowControl.lowWaterMark;
    channel.addEventListener('open', this.handleOpen);
    channel.addEventListener('close', this.handleClose);
    channel.addEventListener('error', this.handleError);
    channel.addEventListener('message', this.handleMessage);
    channel.addEventListener('bufferedamountlow', this.handleDrain);
  }

  on<TType extends keyof DataChannelEventMap>(type: TType, handler: Handler<DataChannelEventMap[TType]>): Unsubscribe { return this.emitter.on(type, handler); }
  async sendJson(value: unknown): Promise<void> { await this.sendText(JSON.stringify(value)); }
  async sendText(value: string): Promise<void> { await this.enqueueSend(() => this.channel.send(value), TEXT_ENCODER.encode(value).byteLength); }
  async sendBinary(value: ArrayBuffer | ArrayBufferView): Promise<void> { await this.enqueueSend(() => this.channel.send(value), value.byteLength); }
  canSend(): boolean { return this.channel.readyState === 'open' && this.channel.bufferedAmount < this.flowControl.highWaterMark; }
  close(): void { this.channel.close(); }

  dispose(): void {
    this.channel.removeEventListener('open', this.handleOpen);
    this.channel.removeEventListener('close', this.handleClose);
    this.channel.removeEventListener('error', this.handleError);
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.removeEventListener('bufferedamountlow', this.handleDrain);
    const error = new Error(`DataChannel for ${this.peerId} disposed while waiting for backpressure drain`);
    this.rejectDrainWaiters(error);
    this.rejectPendingSends(error);
    this.emitter.clear();
  }

  private ensureOpen(): void { if (this.channel.readyState !== 'open') throw new Error(`DataChannel for ${this.peerId} is ${this.channel.readyState}`); }

  private enqueueSend(send: () => void, bytes: number): Promise<void> {
    const capacity = Math.max(this.flowControl.highWaterMark, MIN_PENDING_SEND_BYTES);
    if (bytes > capacity || this.pendingSendBytes + bytes > capacity) {
      return Promise.reject(new Error(`DataChannel send queue for ${this.peerId} exceeded ${capacity} bytes`));
    }
    this.pendingSendBytes += bytes;
    const promise = new Promise<void>((resolve, reject) => {
      this.pendingSends.push({ send, bytes, resolve, reject });
    });
    this.pumpSends();
    return promise;
  }

  private pumpSends(): void {
    if (this.pumpingSends) return;
    this.pumpingSends = true;
    void this.drainSendQueue();
  }

  private async drainSendQueue(): Promise<void> {
    try {
      while (this.pendingSends.length > 0) {
        const pending = this.pendingSends.shift()!;
        try {
          await this.waitForWritable();
          pending.send();
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        } finally {
          this.pendingSendBytes -= pending.bytes;
        }
      }
    } finally {
      this.pumpingSends = false;
      if (this.pendingSends.length > 0) this.pumpSends();
    }
  }

  private async waitForWritable(): Promise<void> {
    this.ensureOpen();
    if (this.channel.bufferedAmount < this.flowControl.highWaterMark) return;
    this.watermarkBlocked = true;
    this.emitter.emit('watermark', this.createWatermarkEvent('high'));
    await new Promise<void>((resolve, reject) => {
      const waiter: DrainWaiter = {
        resolveIfWritable: () => {
          if (this.channel.readyState !== 'open') { this.drainWaiters.delete(waiter); reject(new Error(`DataChannel for ${this.peerId} closed while waiting for backpressure drain`)); return; }
          if (this.channel.bufferedAmount <= this.flowControl.lowWaterMark) { this.drainWaiters.delete(waiter); resolve(); }
        },
        reject
      };
      this.drainWaiters.add(waiter);
    });
    this.ensureOpen();
  }

  private readonly handleOpen = () => this.emitter.emit('open', undefined);
  private readonly handleClose = () => {
    const error = new Error(`DataChannel for ${this.peerId} closed while waiting for backpressure drain`);
    this.rejectDrainWaiters(error);
    this.rejectPendingSends(error);
    this.emitter.emit('close', undefined);
  };
  private readonly handleError = (event: Event) => {
    const error = new Error(`DataChannel for ${this.peerId} errored while waiting for backpressure drain`);
    this.rejectDrainWaiters(error);
    this.rejectPendingSends(error);
    this.emitter.emit('error', event);
  };
  private readonly handleDrain = () => {
    this.emitter.emit('drain', undefined);
    if (this.watermarkBlocked && this.channel.bufferedAmount <= this.flowControl.lowWaterMark) {
      this.watermarkBlocked = false;
      this.emitter.emit('watermark', this.createWatermarkEvent('low'));
    }
    for (const waiter of [...this.drainWaiters]) waiter.resolveIfWritable();
  };
  private rejectDrainWaiters(error: Error): void { for (const waiter of [...this.drainWaiters]) waiter.reject(error); this.drainWaiters.clear(); }
  private rejectPendingSends(error: Error): void {
    const pending = this.pendingSends.splice(0);
    this.pendingSendBytes -= pending.reduce((total, item) => total + item.bytes, 0);
    for (const item of pending) item.reject(error);
  }
  private createWatermarkEvent(phase: WatermarkEvent['phase']): WatermarkEvent {
    return {
      peerId: this.peerId,
      phase,
      bufferedAmount: this.channel.bufferedAmount,
      highWaterMark: this.flowControl.highWaterMark,
      lowWaterMark: this.flowControl.lowWaterMark,
      timestamp: Date.now()
    };
  }

  private readonly handleMessage = (event: Event) => {
    const data = (event as MessageEvent).data;
    if (typeof data === 'string' || data instanceof ArrayBuffer) { this.emitter.emit('message', data); return; }
    if (ArrayBuffer.isView(data)) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.emitter.emit('message', copy.buffer);
    }
  };
}

export class PeerConnectionWrapper {
  private readonly emitter = new Emitter<PeerConnectionEvents>();
  private channel: DataChannelWrapper | null = null;

  constructor(readonly peerId: PeerId, readonly connection: PeerConnectionLike, private readonly flowControl: FlowControlProfile = DEFAULT_FLOW_CONTROL_PROFILE) {
    connection.addEventListener('connectionstatechange', this.handleConnectionState);
    connection.addEventListener('icecandidate', this.handleIceCandidate);
    connection.addEventListener('datachannel', this.handleDataChannel);
  }

  on<TType extends keyof PeerConnectionEvents>(type: TType, handler: Handler<PeerConnectionEvents[TType]>): Unsubscribe { return this.emitter.on(type, handler); }

  createDataChannel(label = 'ponswarp-grid', options: RTCDataChannelInit = { ordered: true }): DataChannelWrapper {
    return this.attachChannel(this.connection.createDataChannel(label, options));
  }

  attachChannel(channel: DataChannelLike): DataChannelWrapper {
    const previous = this.channel;
    if (previous) {
      if (previous.channel.readyState !== 'closed' && previous.channel.readyState !== 'closing') previous.close();
      previous.dispose();
    }
    this.channel = new DataChannelWrapper(this.peerId, channel, this.flowControl);
    this.emitter.emit('channel', this.channel);
    return this.channel;
  }

  getChannel(): DataChannelWrapper | null { return this.channel; }
  getState(): RTCPeerConnectionState { return this.connection.connectionState; }

  close(): void {
    this.channel?.dispose();
    this.connection.removeEventListener('connectionstatechange', this.handleConnectionState);
    this.connection.removeEventListener('icecandidate', this.handleIceCandidate);
    this.connection.removeEventListener('datachannel', this.handleDataChannel);
    this.connection.close();
    this.emitter.emit('close', undefined);
    this.emitter.clear();
  }

  private readonly handleConnectionState = () => this.emitter.emit('connectionState', this.connection.connectionState);
  private readonly handleIceCandidate = (event: Event) => this.emitter.emit('iceCandidate', (event as RTCPeerConnectionIceEvent).candidate);
  private readonly handleDataChannel = (event: Event) => this.attachChannel((event as RTCDataChannelEvent).channel as unknown as DataChannelLike);
}

export interface WebRTCTransportOptions {
  createPeerConnection?: (peerId: PeerId) => PeerConnectionLike;
  flowControl?: FlowControlProfile;
}

export class WebRTCTransport implements Transport {
  private readonly emitter = new Emitter<TransportEvents>();
  private readonly peers = new Map<PeerId, PeerConnectionWrapper>();

  constructor(private readonly options: WebRTCTransportOptions = {}) {}

  onMessage(handler: TransportMessageHandler): Unsubscribe { return this.emitter.on('message', event => handler(event.peerId, event.message)); }
  onBinary(handler: BinaryFrameHandler): Unsubscribe { return this.emitter.on('binary', event => handler(event.peerId, event.data)); }
  onPeerState(handler: Handler<TransportEvents['peerState']>): Unsubscribe { return this.emitter.on('peerState', handler); }
  onError(handler: Handler<TransportEvents['error']>): Unsubscribe { return this.emitter.on('error', handler); }
  reportError(peerId: PeerId, error: unknown): void {
    this.emitter.emit('error', { peerId, error: error instanceof Error ? error : new Error(String(error)) });
  }
  onWatermark(handler: Handler<TransportEvents['watermark']>): Unsubscribe { return this.emitter.on('watermark', handler); }

  async connect(peerId: PeerId): Promise<void> {
    this.ensurePeer(peerId);
  }

  ensurePeer(peerId: PeerId, connection?: PeerConnectionLike): PeerConnectionWrapper {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const peer = new PeerConnectionWrapper(peerId, connection ?? this.createPeerConnection(peerId), this.options.flowControl);
    this.peers.set(peerId, peer);
    peer.on('channel', channel => this.bindChannel(peerId, channel));
    peer.on('connectionState', state => this.emitter.emit('peerState', { peerId, state }));
    peer.on('close', () => this.peers.delete(peerId));
    return peer;
  }

  attachChannel(peerId: PeerId, channel: DataChannelLike, connection?: PeerConnectionLike): DataChannelWrapper {
    const peer = this.ensurePeer(peerId, connection);
    return peer.attachChannel(channel);
  }

  async send(peerId: PeerId, message: TransportMessage): Promise<void> { await this.requireChannel(peerId).sendJson(message); }
  async sendBinary(peerId: PeerId, frame: BinaryFrame): Promise<void> { await this.requireChannel(peerId).sendBinary(frame); }

  getPeer(peerId: PeerId): PeerConnectionWrapper | undefined { return this.peers.get(peerId); }

  async close(peerId?: PeerId): Promise<void> {
    if (peerId) { this.peers.get(peerId)?.close(); this.peers.delete(peerId); return; }
    for (const peer of [...this.peers.values()]) peer.close();
    this.peers.clear();
    this.emitter.clear();
  }

  private bindChannel(peerId: PeerId, channel: DataChannelWrapper): void {
    channel.on('message', data => {
      if (typeof data === 'string') {
        try { this.emitter.emit('message', { peerId, message: JSON.parse(data) }); }
        catch (error) { this.emitter.emit('error', { peerId, error: error instanceof Error ? error : new Error(String(error)) }); }
      } else {
        this.emitter.emit('binary', { peerId, data });
      }
    });
    channel.on('error', event => this.reportError(peerId, new Error(`DataChannel error for ${peerId}: ${event.type}`)));
    channel.on('watermark', event => this.emitter.emit('watermark', event));
  }

  private requireChannel(peerId: PeerId): DataChannelWrapper {
    const channel = this.peers.get(peerId)?.getChannel();
    if (!channel) throw new Error(`No DataChannel for peer ${peerId}`);
    return channel;
  }

  private createPeerConnection(peerId: PeerId): PeerConnectionLike {
    if (!this.options.createPeerConnection) throw new Error(`No peer connection factory configured for ${peerId}`);
    return this.options.createPeerConnection(peerId);
  }
}

export interface SignalingRelay {
  sendRelay(envelope: { type: string; sessionId: string; fromPeerId: PeerId; toPeerId: PeerId; payload: Record<string, unknown> }): void;
  onMessage(handler: (envelope: { type: string; fromPeerId: PeerId; payload: Record<string, unknown> }) => void): Unsubscribe;
}

export interface SdpCapablePeerConnection extends PeerConnectionLike {
  createOffer(): Promise<unknown>;
  createAnswer(): Promise<unknown>;
  setLocalDescription(desc: unknown): Promise<void>;
  setRemoteDescription(desc: unknown): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
}

export interface SignalingBridgeOptions {
  transport: WebRTCTransport;
  signaling: SignalingRelay;
  sessionId: string;
  selfPeerId: PeerId;
  createPeerConnection: () => SdpCapablePeerConnection;
}

export class SignalingBridge {
  private readonly transport: WebRTCTransport;
  private readonly signaling: SignalingRelay;
  private readonly sessionId: string;
  private readonly selfPeerId: PeerId;
  private readonly createPeerConnection: () => SdpCapablePeerConnection;
  private unsubscribe: Unsubscribe | null = null;

  constructor(options: SignalingBridgeOptions) {
    this.transport = options.transport;
    this.signaling = options.signaling;
    this.sessionId = options.sessionId;
    this.selfPeerId = options.selfPeerId;
    this.createPeerConnection = options.createPeerConnection;
  }

  start(): void {
    this.unsubscribe = this.signaling.onMessage(envelope => this.handleSignal(envelope));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async initiateOffer(remotePeerId: PeerId): Promise<void> {
    const connection = this.createPeerConnection();
    const peer = this.transport.ensurePeer(remotePeerId, connection);
    this.forwardIceCandidates(peer, remotePeerId);
    peer.createDataChannel();
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    this.signaling.sendRelay({
      type: 'WEBRTC_OFFER',
      sessionId: this.sessionId,
      fromPeerId: this.selfPeerId,
      toPeerId: remotePeerId,
      payload: { sdp: offer }
    });
  }

  private forwardIceCandidates(peer: PeerConnectionWrapper, remotePeerId: PeerId): void {
    peer.on('iceCandidate', candidate => {
      if (candidate) {
        this.signaling.sendRelay({
          type: 'ICE_CANDIDATE',
          sessionId: this.sessionId,
          fromPeerId: this.selfPeerId,
          toPeerId: remotePeerId,
          payload: { candidate: candidate.toJSON?.() ?? candidate }
        });
      }
    });
  }

  private handleSignal(envelope: { type: string; fromPeerId: PeerId; payload: Record<string, unknown> }): void {
    if (envelope.fromPeerId === this.selfPeerId) return;
    switch (envelope.type) {
      case 'ICE_CANDIDATE': {
        const peer = this.transport.getPeer(envelope.fromPeerId);
        const candidate = envelope.payload.candidate as RTCIceCandidateInit | undefined;
        if (peer && candidate) {
          const conn = this.getConnection(peer);
          conn?.addIceCandidate(candidate).catch(error => this.transport.reportError(envelope.fromPeerId, error));
        }
        break;
      }
      case 'WEBRTC_OFFER': {
        const connection = this.createPeerConnection();
        const peer = this.transport.ensurePeer(envelope.fromPeerId, connection);
        this.forwardIceCandidates(peer, envelope.fromPeerId);
        const sdp = envelope.payload.sdp as RTCSessionDescriptionInit;
        connection.setRemoteDescription(sdp)
          .then(async () => {
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            this.signaling.sendRelay({
              type: 'WEBRTC_ANSWER',
              sessionId: this.sessionId,
              fromPeerId: this.selfPeerId,
              toPeerId: envelope.fromPeerId,
              payload: { sdp: answer }
            });
          })
          .catch(error => this.transport.reportError(envelope.fromPeerId, error));
        break;
      }
      case 'WEBRTC_ANSWER': {
        const peer = this.transport.getPeer(envelope.fromPeerId);
        const conn = this.getConnection(peer);
        if (conn) {
          const sdp = envelope.payload.sdp as RTCSessionDescriptionInit;
          conn.setRemoteDescription(sdp).catch(error => this.transport.reportError(envelope.fromPeerId, error));
        }
        break;
      }
    }
  }

  private getConnection(peer: PeerConnectionWrapper | undefined): SdpCapablePeerConnection | null {
    if (!peer) return null;
    const pc = (peer as unknown as { connection?: SdpCapablePeerConnection }).connection;
    if (pc && typeof pc.createOffer === 'function') return pc;
    return null;
  }
}

/** Adaptive AIMD congestion controller (docs/24). App-layer pacing only. */
export interface AdaptiveCongestionSnapshot {
  cwndBytes: number;
  estimatedRttMs: number;
  estimatedBwBps: number;
  recommendedBatchChunks: number;
}

export class AdaptiveCongestionController {
  private cwndBytes: number;
  private minCwnd: number;
  private maxCwnd: number;
  private estimatedRttMs = 10;
  private estimatedBwBps = 0;
  private minRtt = Infinity;
  private lastUpdateTime = 0;
  private chunkSizeBytes: number;
  private started = false;
  private readonly direct: boolean;

  constructor(profile: TransferTuningProfile = DIRECT_HOST_TRANSFER_TUNING_PROFILE) {
    this.minCwnd = profile.minInFlightBytes;
    this.maxCwnd = profile.maxInFlightBytes;
    this.cwndBytes = profile.initialInFlightBytes;
    this.chunkSizeBytes = Math.max(1, profile.chunkSizeBytes);
    this.direct = profile.pathKind === 'host' || profile.pathKind === 'srflx';
  }

  start(): void {
    this.started = true;
    this.lastUpdateTime = 0;
  }

  reset(profile?: TransferTuningProfile): void {
    if (profile) {
      this.minCwnd = profile.minInFlightBytes;
      this.maxCwnd = profile.maxInFlightBytes;
      this.cwndBytes = profile.initialInFlightBytes;
      this.chunkSizeBytes = Math.max(1, profile.chunkSizeBytes);
    }
    this.estimatedRttMs = 10;
    this.estimatedBwBps = 0;
    this.minRtt = Infinity;
    this.lastUpdateTime = 0;
    this.started = false;
  }

  recordSend(_bytes: number): void {
    // Reserved for future throughput samples; buffer-based control is primary.
  }

  updateFromCandidateStats(input: { rttMs?: number; availableOutgoingBitrateBps?: number }): void {
    if (typeof input.rttMs === 'number' && Number.isFinite(input.rttMs) && input.rttMs > 0 && input.rttMs <= 10_000) {
      this.estimatedRttMs = input.rttMs;
      if (input.rttMs < this.minRtt) this.minRtt = input.rttMs;
    }
    if (typeof input.availableOutgoingBitrateBps === 'number' && Number.isFinite(input.availableOutgoingBitrateBps) && input.availableOutgoingBitrateBps > 0) {
      this.estimatedBwBps = input.availableOutgoingBitrateBps;
    }
  }

  updateBufferState(bufferedAmountBytes: number): AdaptiveCongestionSnapshot {
    const now = Date.now();
    if (this.started && this.lastUpdateTime > 0 && now - this.lastUpdateTime < 100) {
      return this.getSnapshot();
    }
    const baseline = this.minRtt === Infinity ? 10 : this.minRtt;
    const rttRatio = this.estimatedRttMs / Math.max(1, baseline);
    const buffer = Math.max(0, bufferedAmountBytes);
    if (rttRatio > 2.0 || buffer > this.cwndBytes) {
      this.cwndBytes = Math.max(this.minCwnd, Math.floor(this.cwndBytes * 0.7));
    } else if (rttRatio < 1.5 && buffer < this.cwndBytes * 0.8) {
      const increase = this.direct || this.estimatedRttMs < 10 ? 256 * 1024 : 64 * 1024;
      this.cwndBytes = Math.min(this.maxCwnd, this.cwndBytes + increase);
    }
    this.lastUpdateTime = now;
    return this.getSnapshot();
  }

  getSnapshot(): AdaptiveCongestionSnapshot {
    const recommendedBatchChunks = Math.max(1, Math.min(32, Math.floor((this.cwndBytes * 0.2) / this.chunkSizeBytes)));
    return {
      cwndBytes: this.cwndBytes,
      estimatedRttMs: this.estimatedRttMs,
      estimatedBwBps: this.estimatedBwBps,
      recommendedBatchChunks
    };
  }
}

