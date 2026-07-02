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
