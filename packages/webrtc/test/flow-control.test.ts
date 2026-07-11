import { describe, expect, it } from 'vitest';
import { DataChannelWrapper, PeerConnectionWrapper, SignalingBridge, WebRTCTransport, clampDataChannelChunkSize, shouldRequestMoreChunks, type DataChannelLike, type PeerConnectionLike, type SdpCapablePeerConnection, type SignalingRelay } from '../src/index';
import type { PeerId } from '@ponswarp/core';

class FakeDataChannel extends EventTarget implements DataChannelLike {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  incrementBufferedOnSend = 0;
  closeCalls = 0;

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(data);
    this.bufferedAmount += this.incrementBufferedOnSend;
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }

  drainTo(value: number): void {
    this.bufferedAmount = value;
    this.dispatchEvent(new Event('bufferedamountlow'));
  }
}

class FakePeerConnection extends EventTarget implements PeerConnectionLike {
  connectionState: RTCPeerConnectionState = 'new';
  readonly channels: FakeDataChannel[] = [];

  createDataChannel(): DataChannelLike {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel;
  }

  close(): void {
    this.connectionState = 'closed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  receiveChannel(channel = new FakeDataChannel()): FakeDataChannel {
    this.dispatchEvent(new MessageEvent('datachannel', { data: undefined }));
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel }));
    return channel;
  }
}

class RejectingSdpPeerConnection extends FakePeerConnection implements SdpCapablePeerConnection {
  createOffer(): Promise<unknown> { return Promise.reject(new Error('offer failed')); }
  createAnswer(): Promise<unknown> { return Promise.reject(new Error('answer failed')); }
  setLocalDescription(): Promise<void> { return Promise.resolve(); }
  setRemoteDescription(): Promise<void> { return Promise.reject(new Error('remote description failed')); }
  addIceCandidate(): Promise<void> { return Promise.reject(new Error('candidate failed')); }
}

describe('PonsWarp backpressure extraction', () => {
  it('keeps chunk sizes within SCTP-safe bounds', () => {
    expect(clampDataChannelChunkSize(1024)).toBe(16 * 1024);
    expect(clampDataChannelChunkSize(64 * 1024, 32 * 1024)).toBe(16 * 1024);
  });

  it('requests more chunks only when active peers can accept data', () => {
    expect(shouldRequestMoreChunks({
      isProcessingBatch: false,
      isTransferring: true,
      workerReady: true,
      activePeerCount: 1,
      highestBufferedAmount: 0,
      highWaterMark: 128 * 1024,
      pausedPeerCount: 0
    })).toBe(true);

    expect(shouldRequestMoreChunks({
      isProcessingBatch: false,
      isTransferring: true,
      workerReady: true,
      activePeerCount: 1,
      highestBufferedAmount: 128 * 1024,
      highWaterMark: 128 * 1024,
      pausedPeerCount: 0
    })).toBe(false);
  });

  it('waits for bufferedamountlow before sending above high watermark', async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = 10;
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 1,
      highWaterMark: 10,
      lowWaterMark: 4,
      batchSize: 1,
      prefetchBufferSize: 0
    });

    const send = wrapper.sendText('queued');
    await Promise.resolve();
    expect(channel.sent).toEqual([]);

    channel.drainTo(4);
    await send;
    expect(channel.sent).toEqual(['queued']);
  });
  it('emits one high and one low watermark event for a blocked send episode', async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = 10;
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 1,
      highWaterMark: 10,
      lowWaterMark: 4,
      batchSize: 1,
      prefetchBufferSize: 0
    });
    const events = [];
    wrapper.on('watermark', event => events.push(event));

    const first = wrapper.sendText('first');
    const second = wrapper.sendText('second');
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      peerId: 'peer_1',
      phase: 'high',
      bufferedAmount: 10,
      highWaterMark: 10,
      lowWaterMark: 4
    });
    expect(events[0].timestamp).toEqual(expect.any(Number));

    channel.drainTo(4);
    await Promise.all([first, second]);
    expect(events.map(event => event.phase)).toEqual(['high', 'low']);
    expect(events[1]).toMatchObject({
      peerId: 'peer_1',
      phase: 'low',
      bufferedAmount: 4,
      highWaterMark: 10,
      lowWaterMark: 4
    });
  });

  it('does not emit watermark events for sends that remain below high watermark', async () => {
    const channel = new FakeDataChannel();
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 1,
      highWaterMark: 10,
      lowWaterMark: 4,
      batchSize: 1,
      prefetchBufferSize: 0
    });
    const events = [];
    wrapper.on('watermark', event => events.push(event));

    await wrapper.sendText('direct');
    channel.drainTo(0);
    expect(events).toEqual([]);
  });

  it('rejects queued sends when the channel closes before low watermark', async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = 10;
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 1,
      highWaterMark: 10,
      lowWaterMark: 4,
      batchSize: 1,
      prefetchBufferSize: 0
    });

    const send = wrapper.sendText('queued');
    await Promise.resolve();
    channel.close();

    await expect(send).rejects.toThrow(/closed/);
    expect(channel.sent).toEqual([]);
  });

  it('wraps peer connections and emits state/channel events', () => {
    const peer = new FakePeerConnection();
    const wrapper = new PeerConnectionWrapper('peer_1' as PeerId, peer);
    const states: RTCPeerConnectionState[] = [];
    const channels: DataChannelWrapper[] = [];
    wrapper.on('connectionState', state => states.push(state));
    wrapper.on('channel', channel => channels.push(channel));

    const channel = wrapper.createDataChannel();
    peer.setState('connected');

    expect(channel).toBeInstanceOf(DataChannelWrapper);
    expect(channels).toHaveLength(1);
    expect(states).toEqual(['connected']);
  });
  it('closes and disposes the superseded channel before publishing its replacement', () => {
    const peer = new FakePeerConnection();
    const wrapper = new PeerConnectionWrapper('peer_1' as PeerId, peer);
    const first = new FakeDataChannel();
    const second = new FakeDataChannel();

    wrapper.attachChannel(first);
    const replacement = wrapper.attachChannel(second);

    expect(first.closeCalls).toBe(1);
    expect(first.readyState).toBe('closed');
    expect(wrapper.getChannel()).toBe(replacement);
    expect(replacement.channel).toBe(second);
    expect(second.closeCalls).toBe(0);
  });

  it('reports signaling failures through the transport error callback', async () => {
    let receive: ((envelope: { type: string; fromPeerId: PeerId; payload: Record<string, unknown> }) => void) | undefined;
    const signaling: SignalingRelay = {
      sendRelay: () => {},
      onMessage: handler => {
        receive = handler;
        return () => {};
      }
    };
    const connection = new RejectingSdpPeerConnection();
    const transport = new WebRTCTransport();
    transport.ensurePeer('peer_1' as PeerId, connection);
    const errors: Error[] = [];
    transport.onError(event => errors.push(event.error));
    const bridge = new SignalingBridge({
      transport,
      signaling,
      sessionId: 'session',
      selfPeerId: 'self' as PeerId,
      createPeerConnection: () => connection
    });
    bridge.start();

    receive?.({ type: 'ICE_CANDIDATE', fromPeerId: 'peer_1' as PeerId, payload: { candidate: {} } });
    receive?.({ type: 'WEBRTC_ANSWER', fromPeerId: 'peer_1' as PeerId, payload: { sdp: {} } });
    await Promise.resolve();

    expect(errors.map(error => error.message)).toEqual(['candidate failed', 'remote description failed']);
  });

  it('routes JSON and binary frames through WebRTCTransport', async () => {
    const peerId = 'peer_1' as PeerId;
    const transport = new WebRTCTransport({ createPeerConnection: () => new FakePeerConnection() });
    const channel = new FakeDataChannel();
    const messages: unknown[] = [];
    const binaries: ArrayBuffer[] = [];
    transport.onMessage((_peerId, message) => messages.push(message));
    transport.onBinary((_peerId, data) => binaries.push(data));

    transport.attachChannel(peerId, channel);
    await transport.send(peerId, { type: 'HELLO' });
    await transport.sendBinary(peerId, new Uint8Array([1, 2, 3]));

    expect(JSON.parse(channel.sent[0] as string)).toEqual({ type: 'HELLO' });
    expect([...(new Uint8Array(channel.sent[1] as ArrayBuffer))]).toEqual([1, 2, 3]);

    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ACK' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([9]).buffer }));
    expect(messages).toEqual([{ type: 'ACK' }]);
    expect([...(new Uint8Array(binaries[0]))]).toEqual([9]);
  });

  it('serializes concurrent sends so one drain does not release a burst', async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = 0;
    channel.incrementBufferedOnSend = 10;
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 1,
      highWaterMark: 10,
      lowWaterMark: 4,
      batchSize: 1,
      prefetchBufferSize: 0
    });

    const first = wrapper.sendText('first');
    const second = wrapper.sendText('second');
    await first;
    await Promise.resolve();
    expect(channel.sent).toEqual(['first']);

    channel.drainTo(4);
    await second;
    expect(channel.sent).toEqual(['first', 'second']);
  });
  it('preserves ordering across a large concurrent send burst', async () => {
    const channel = new FakeDataChannel();
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 1,
      highWaterMark: 100,
      lowWaterMark: 40,
      batchSize: 1,
      prefetchBufferSize: 0
    });

    const sends = Array.from({ length: 32 }, (_, index) => wrapper.sendText(`chunk-${index}`));
    await Promise.all(sends);

    expect(channel.sent).toEqual(Array.from({ length: 32 }, (_, index) => `chunk-${index}`));
  });

  it('bounds queued payload bytes while backpressure is active', async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = 1;
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 64 * 1024,
      highWaterMark: 1,
      lowWaterMark: 0,
      batchSize: 1,
      prefetchBufferSize: 0
    });
    const queued = Array.from({ length: 4 }, () => wrapper.sendBinary(new Uint8Array(64 * 1024)).catch(error => error));

    await expect(wrapper.sendBinary(new Uint8Array(64 * 1024))).rejects.toThrow(/send queue.*exceeded/);
    channel.close();
    await Promise.all(queued);
  });
  it('rejects a blocked send when the channel errors', async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = 10;
    const wrapper = new DataChannelWrapper('peer_1' as PeerId, channel, {
      chunkSize: 1,
      highWaterMark: 10,
      lowWaterMark: 4,
      batchSize: 1,
      prefetchBufferSize: 0
    });

    const send = wrapper.sendText('errored');
    await Promise.resolve();
    channel.dispatchEvent(new Event('error'));

    await expect(send).rejects.toThrow(/errored/);
    expect(channel.sent).toEqual([]);
  });
});
