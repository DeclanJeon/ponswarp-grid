import type { BinaryFrame, PeerId, Transport, TransportMessage } from '@ponswarp/core';

function copyArrayBufferView(view: ArrayBufferView): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

export class DemoTransport implements Transport {
  private readonly peers = new Map<PeerId, DemoTransport>();
  private readonly messageHandlers = new Set<(peerId: PeerId, message: TransportMessage) => void>();
  private readonly binaryHandlers = new Set<(peerId: PeerId, frame: ArrayBuffer) => void>();

  constructor(readonly selfId: PeerId) {}

  link(peerId: PeerId, peer: DemoTransport): void { this.peers.set(peerId, peer); }
  async connect(): Promise<void> {}
  async send(peerId: PeerId, message: TransportMessage): Promise<void> { this.peers.get(peerId)?.messageHandlers.forEach(handler => handler(this.selfId, message)); }
  async sendBinary(peerId: PeerId, frame: BinaryFrame): Promise<void> { const data = frame instanceof ArrayBuffer ? frame : copyArrayBufferView(frame); this.peers.get(peerId)?.binaryHandlers.forEach(handler => handler(this.selfId, data)); }
  onMessage(handler: (peerId: PeerId, message: TransportMessage) => void): () => void { this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }
  onBinary(handler: (peerId: PeerId, frame: ArrayBuffer) => void): () => void { this.binaryHandlers.add(handler); return () => this.binaryHandlers.delete(handler); }
  async close(): Promise<void> {}
}

export class BroadcastDemoTransport implements Transport {
  private readonly channel: BroadcastChannel;
  private readonly messageHandlers = new Set<(peerId: PeerId, message: TransportMessage) => void>();
  private readonly binaryHandlers = new Set<(peerId: PeerId, frame: ArrayBuffer) => void>();

  constructor(readonly selfId: PeerId, sessionId: string) {
    this.channel = new BroadcastChannel(`ponswarp-grid-${sessionId}`);
    this.channel.onmessage = event => {
      const envelope = event.data as { to?: PeerId; from?: PeerId; kind?: 'message' | 'binary'; message?: TransportMessage; frame?: ArrayBuffer };
      if (envelope.to !== this.selfId || !envelope.from) return;
      if (envelope.kind === 'message') this.messageHandlers.forEach(handler => handler(envelope.from!, envelope.message));
      if (envelope.kind === 'binary' && envelope.frame) this.binaryHandlers.forEach(handler => handler(envelope.from!, envelope.frame!));
    };
  }

  async connect(): Promise<void> {}
  async send(peerId: PeerId, message: TransportMessage): Promise<void> { this.channel.postMessage({ to: peerId, from: this.selfId, kind: 'message', message }); }
  async sendBinary(peerId: PeerId, frame: BinaryFrame): Promise<void> { const data = frame instanceof ArrayBuffer ? frame : copyArrayBufferView(frame); this.channel.postMessage({ to: peerId, from: this.selfId, kind: 'binary', frame: data }); }
  onMessage(handler: (peerId: PeerId, message: TransportMessage) => void): () => void { this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }
  onBinary(handler: (peerId: PeerId, frame: ArrayBuffer) => void): () => void { this.binaryHandlers.add(handler); return () => this.binaryHandlers.delete(handler); }
  async close(): Promise<void> { this.channel.close(); }
}
