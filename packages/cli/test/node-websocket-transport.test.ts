import { connect, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { PeerId } from '@ponswarp/core';
import { NodePeerEndpointRegistry, NodeWebSocketTransport } from '../src/node-websocket-transport';

const peerA = 'peer_a' as PeerId;
const peerB = 'peer_b' as PeerId;

async function waitFor<T>(producer: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = producer();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for value');
}

function openRawSocket(endpoint: string): Promise<Socket> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise(resolve => socket.once('close', () => resolve()));
}

function upgrade(socket: Socket, endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  const response = new Promise<void>((resolve, reject) => {
    socket.once('data', data => data.includes(Buffer.from('101 Switching Protocols')) ? resolve() : reject(new Error('upgrade rejected')));
  });
  socket.write([
    `GET ${url.pathname}?from=${peerA} HTTP/1.1`,
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '\r\n'
  ].join('\r\n'));
  return response;
}
function rawFrame(fin: boolean, opcode: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  return Buffer.concat([header, payload]);
}

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: FakeWebSocket | undefined;
  readyState = 0;
  binaryType = 'blob';
  readonly sent: Array<string | Uint8Array> = [];
  throwOnSend = false;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string | Uint8Array): void {
    if (this.throwOnSend) {
      this.throwOnSend = false;
      throw new Error('fake send failed');
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

function installFakeWebSocket(): () => void {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return () => { globalThis.WebSocket = previous; };
}
describe('NodeWebSocketTransport', () => {
  it('round-trips JSON messages and binary frames over peer endpoints', async () => {
    const registry = new NodePeerEndpointRegistry();
    const a = new NodeWebSocketTransport({ selfId: peerA, registry });
    const b = new NodeWebSocketTransport({ selfId: peerB, registry });
    try {
      const endpointA = await a.listen();
      const endpointB = await b.listen();
      expect(endpointA.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/peer\/peer_a$/);
      expect(endpointB.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/peer\/peer_b$/);

      let messageFromA: unknown;
      let binaryFromB: ArrayBuffer | undefined;
      b.onMessage((peerId, message) => { messageFromA = { peerId, message }; });
      a.onBinary((peerId, frame) => { binaryFromB = frame; expect(peerId).toBe(peerB); });

      await a.connect(peerB);
      await a.send(peerB, { type: 'HELLO', value: 1 });
      expect(await waitFor(() => messageFromA)).toEqual({ peerId: peerA, message: { type: 'HELLO', value: 1 } });

      await b.sendBinary(peerA, new Uint8Array([7, 8, 9]));
      expect(Array.from(new Uint8Array(await waitFor(() => binaryFromB)))).toEqual([7, 8, 9]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('preserves the order of consecutive large binary frames', async () => {
    const registry = new NodePeerEndpointRegistry();
    const a = new NodeWebSocketTransport({ selfId: peerA, registry });
    const b = new NodeWebSocketTransport({ selfId: peerB, registry });
    try {
      await a.listen();
      await b.listen();
      const received: number[] = [];
      a.onBinary((_peerId, frame) => {
        received.push(new Uint8Array(frame)[0] ?? -1);
      });

      await a.connect(peerB);
      await Promise.all(Array.from({ length: 16 }, (_, index) => {
        const frame = new Uint8Array(256 * 1024);
        frame[0] = index;
        return b.sendBinary(peerA, frame);
      }));

      await waitFor(() => received.length === 16 ? received : undefined);
      expect(received).toEqual(Array.from({ length: 16 }, (_, index) => index));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('rejects sends before endpoint connection and allows unsubscribe', async () => {
    const registry = new NodePeerEndpointRegistry();
    const a = new NodeWebSocketTransport({ selfId: peerA, registry });
    const b = new NodeWebSocketTransport({ selfId: peerB, registry });
    try {
      await a.listen();
      await b.listen();
      await expect(a.send(peerB, { type: 'early' })).rejects.toThrow(/not connected/);
      let count = 0;
      const unsubscribe = b.onMessage(() => { count += 1; });
      unsubscribe();
      await a.connect(peerB);
      await a.send(peerB, { type: 'ignored' });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(count).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('fails fast when a peer endpoint is missing', async () => {
    const transport = new NodeWebSocketTransport({ selfId: peerA, registry: new NodePeerEndpointRegistry() });
    await expect(transport.connect(peerB)).rejects.toThrow(/No endpoint registered/);
  });

  it('closes raw sockets whose handshake exceeds the fixed limit', async () => {
    const transport = new NodeWebSocketTransport({ selfId: peerB });
    try {
      const endpoint = await transport.listen();
      const socket = await openRawSocket(endpoint.url);
      const closed = waitForClose(socket);
      socket.write(Buffer.alloc(16 * 1024 + 1, 0x41));
      await closed;
    } finally {
      await transport.close();
    }
  });

  it('closes peers that declare an oversized frame before payload allocation', async () => {
    const transport = new NodeWebSocketTransport({ selfId: peerB });
    try {
      const endpoint = await transport.listen();
      const socket = await openRawSocket(endpoint.url);
      await upgrade(socket, endpoint.url);
      const closed = waitForClose(socket);
      const header = Buffer.alloc(10);
      header[0] = 0x82;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(16 * 1024 * 1024 + 1), 2);
      socket.write(header);
      await closed;
    } finally {
      await transport.close();
    }
  });

  it('delivers a legal maximum payload split across fragmented frames', async () => {
    const transport = new NodeWebSocketTransport({ selfId: peerB });
    try {
      const endpoint = await transport.listen();
      const socket = await openRawSocket(endpoint.url);
      await upgrade(socket, endpoint.url);
      let received: ArrayBuffer | undefined;
      transport.onBinary((_peerId, frame) => { received = frame; });
      const first = Buffer.alloc(8 * 1024 * 1024, 0x41);
      const second = Buffer.alloc(8 * 1024 * 1024, 0x42);
      const delivered = waitFor(() => received, 10_000);
      socket.write(rawFrame(false, 0x2, first));
      await new Promise(resolve => setTimeout(resolve, 20));
      socket.write(rawFrame(true, 0x0, second));
      const frame = await delivered;
      expect(frame.byteLength).toBe(16 * 1024 * 1024);
      expect(new Uint8Array(frame)[0]).toBe(0x41);
      expect(new Uint8Array(frame)[frame.byteLength - 1]).toBe(0x42);
    } finally {
      await transport.close();
    }
  }, 15_000);

  it('accounts and orders bounded WHATWG WebSocket sends', async () => {
    const restore = installFakeWebSocket();
    const transport = new NodeWebSocketTransport({ selfId: peerB, registry: new NodePeerEndpointRegistry() });
    transport.registerEndpoint({ peerId: peerA, url: 'ws://fake.test/peer_a' });
    try {
      await transport.connect(peerA);
      const socket = FakeWebSocket.latest;
      expect(socket).toBeDefined();
      await transport.sendBinary(peerA, new Uint8Array(16 * 1024 * 1024));
      expect(socket?.sent).toHaveLength(1);
      expect((socket?.sent[0] as Uint8Array).byteLength).toBe(16 * 1024 * 1024);
      await Promise.all([
        transport.sendBinary(peerA, new Uint8Array([1])),
        transport.sendBinary(peerA, new Uint8Array([2])),
        transport.sendBinary(peerA, new Uint8Array([3]))
      ]);
      expect(Array.from(socket?.sent.slice(1).map(frame => (frame as Uint8Array)[0]) ?? [])).toEqual([1, 2, 3]);
    } finally {
      await transport.close();
      restore();
    }
  });

  it('rejects aggregate WHATWG overflow before buffering and reports it', async () => {
    const restore = installFakeWebSocket();
    const transport = new NodeWebSocketTransport({ selfId: peerB, registry: new NodePeerEndpointRegistry() });
    transport.registerEndpoint({ peerId: peerA, url: 'ws://fake.test/peer_a' });
    const errors: Error[] = [];
    transport.onError((_peerId, error) => errors.push(error));
    try {
      await transport.connect(peerA);
      const payload = new Uint8Array(16 * 1024 * 1024);
      const first = transport.sendBinary(peerA, payload);
      await expect(transport.sendBinary(peerA, payload)).rejects.toThrow('WebSocket outbound queue too large');
      await first;
      expect(errors.map(error => error.message)).toContain('WebSocket outbound queue too large');
      expect(FakeWebSocket.latest?.sent).toHaveLength(1);
    } finally {
      await transport.close();
      restore();
    }
  });

  it('reports WHATWG send throws and recovers accounting', async () => {
    const restore = installFakeWebSocket();
    const transport = new NodeWebSocketTransport({ selfId: peerB, registry: new NodePeerEndpointRegistry() });
    transport.registerEndpoint({ peerId: peerA, url: 'ws://fake.test/peer_a' });
    const errors: Error[] = [];
    transport.onError((_peerId, error) => errors.push(error));
    try {
      await transport.connect(peerA);
      FakeWebSocket.latest!.throwOnSend = true;
      await expect(transport.sendBinary(peerA, new Uint8Array([9]))).rejects.toThrow('fake send failed');
      await transport.sendBinary(peerA, new Uint8Array([10]));
      expect(errors.map(error => error.message)).toContain('fake send failed');
      expect((FakeWebSocket.latest!.sent[0] as Uint8Array)[0]).toBe(10);
    } finally {
      await transport.close();
      restore();
    }
  });

  it('releases queued WHATWG accounting when closed', async () => {
    const restore = installFakeWebSocket();
    const transport = new NodeWebSocketTransport({ selfId: peerB, registry: new NodePeerEndpointRegistry() });
    transport.registerEndpoint({ peerId: peerA, url: 'ws://fake.test/peer_a' });
    try {
      await transport.connect(peerA);
      const oldSocket = FakeWebSocket.latest!;
      const pending = transport.sendBinary(peerA, new Uint8Array(16 * 1024 * 1024));
      await transport.close(peerA);
      await expect(pending).rejects.toThrow(/not connected/);
      await transport.connect(peerA);
      await transport.sendBinary(peerA, new Uint8Array(16 * 1024 * 1024));
      expect(FakeWebSocket.latest).not.toBe(oldSocket);
      expect(FakeWebSocket.latest?.sent).toHaveLength(1);
    } finally {
      await transport.close();
      restore();
    }
  });
  it('reports and closes peers whose fragmented aggregate exceeds the receive cap', async () => {
    const transport = new NodeWebSocketTransport({ selfId: peerB });
    try {
      const endpoint = await transport.listen();
      const socket = await openRawSocket(endpoint.url);
      await upgrade(socket, endpoint.url);
      const errors: Error[] = [];
      transport.onError((_peerId, error) => { errors.push(error); });
      const closed = waitForClose(socket);
      socket.write(rawFrame(false, 0x2, Buffer.alloc(16 * 1024 * 1024)));
      socket.write(rawFrame(true, 0x0, Buffer.alloc(1)));
      await closed;
      expect(errors.map(error => error.message).join('\n')).toMatch(/WebSocket (message payload|receive buffer) too large/);
    } finally {
      await transport.close();
    }
  });

  it('reports outbound raw queue overflow while preserving the single-frame maximum', async () => {
    const transport = new NodeWebSocketTransport({ selfId: peerB });
    try {
      const endpoint = await transport.listen();
      const socket = await openRawSocket(endpoint.url);
      await upgrade(socket, endpoint.url);
      const errors: Error[] = [];
      transport.onError((_peerId, error) => { errors.push(error); });
      const payload = new Uint8Array(16 * 1024 * 1024);
      const first = transport.sendBinary(peerA, payload);
      const second = transport.sendBinary(peerA, payload);
      await expect(second).rejects.toThrow('WebSocket outbound queue too large');
      await first;
      expect(errors.map(error => error.message)).toContain('WebSocket outbound queue too large');
    } finally {
      await transport.close();
    }
  });
  it('contains malformed inbound text frames by closing the offending peer', async () => {
    const registry = new NodePeerEndpointRegistry();
    const b = new NodeWebSocketTransport({ selfId: peerB, registry });
    try {
      const endpoint = await b.listen();
      let called = false;
      b.onMessage(() => { called = true; });
      const socket = new WebSocket(`${endpoint.url}?from=${encodeURIComponent(peerA)}`);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('websocket open failed')), { once: true });
      });
      const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
      socket.send('{bad json');
      await closed;
      expect(called).toBe(false);
      await expect(b.send(peerA, { type: 'after-malformed' })).rejects.toThrow(/not connected/);
    } finally {
      await b.close();
    }
  });
});
