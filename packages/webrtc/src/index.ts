import type { BinaryFrame, PeerId, Transport, TransportMessage, TransportMessageHandler, BinaryFrameHandler, Unsubscribe } from '@ponswarp/core';

const KIB = 1024;
const MIB = 1024 * KIB;

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
  const safeDefault = DEFAULT_FLOW_CONTROL_PROFILE.chunkSize;
  const protocolFloor = 16 * KIB;
  const reportedMax = typeof maxMessageSize === 'number' && maxMessageSize > 0 ? maxMessageSize : safeDefault;
  return Math.max(protocolFloor, Math.min(requestedBytes, reportedMax, safeDefault));
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

export type DataChannelEventMap = {
  open: void;
  close: void;
  error: Event;
  message: string | ArrayBuffer;
  drain: void;
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
  private sendQueue: Promise<void> = Promise.resolve();

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
  async sendText(value: string): Promise<void> { await this.enqueueSend(() => this.channel.send(value)); }
  async sendBinary(value: ArrayBuffer | ArrayBufferView): Promise<void> { await this.enqueueSend(() => this.channel.send(value)); }
  canSend(): boolean { return this.channel.readyState === 'open' && this.channel.bufferedAmount < this.flowControl.highWaterMark; }
  close(): void { this.channel.close(); }

  dispose(): void {
    this.channel.removeEventListener('open', this.handleOpen);
    this.channel.removeEventListener('close', this.handleClose);
    this.channel.removeEventListener('error', this.handleError);
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.removeEventListener('bufferedamountlow', this.handleDrain);
    this.rejectDrainWaiters(new Error(`DataChannel for ${this.peerId} disposed while waiting for backpressure drain`));
    this.emitter.clear();
  }

  private ensureOpen(): void { if (this.channel.readyState !== 'open') throw new Error(`DataChannel for ${this.peerId} is ${this.channel.readyState}`); }

  private enqueueSend(send: () => void): Promise<void> {
    const next = this.sendQueue.then(async () => {
      await this.waitForWritable();
      send();
    });
    this.sendQueue = next.catch(() => undefined);
    return next;
  }

  private async waitForWritable(): Promise<void> {
    this.ensureOpen();
    if (this.channel.bufferedAmount < this.flowControl.highWaterMark) return;
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
  private readonly handleClose = () => { this.rejectDrainWaiters(new Error(`DataChannel for ${this.peerId} closed while waiting for backpressure drain`)); this.emitter.emit('close', undefined); };
  private readonly handleError = (event: Event) => { this.rejectDrainWaiters(new Error(`DataChannel for ${this.peerId} errored while waiting for backpressure drain`)); this.emitter.emit('error', event); };
  private readonly handleDrain = () => { this.emitter.emit('drain', undefined); for (const waiter of [...this.drainWaiters]) waiter.resolveIfWritable(); };
  private rejectDrainWaiters(error: Error): void { for (const waiter of [...this.drainWaiters]) waiter.reject(error); this.drainWaiters.clear(); }

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
    this.channel?.dispose();
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
    channel.on('error', event => this.emitter.emit('error', { peerId, error: new Error(`DataChannel error for ${peerId}: ${event.type}`) }));
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
          conn?.addIceCandidate(candidate).catch(() => {});
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
          .catch(() => {});
        break;
      }
      case 'WEBRTC_ANSWER': {
        const peer = this.transport.getPeer(envelope.fromPeerId);
        const conn = this.getConnection(peer);
        if (conn) {
          const sdp = envelope.payload.sdp as RTCSessionDescriptionInit;
          conn.setRemoteDescription(sdp).catch(() => {});
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
