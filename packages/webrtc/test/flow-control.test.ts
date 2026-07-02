import { describe, expect, it } from 'vitest';
import { DataChannelWrapper, PeerConnectionWrapper, WebRTCTransport, clampDataChannelChunkSize, shouldRequestMoreChunks, type DataChannelLike, type PeerConnectionLike } from '../src/index';
import type { PeerId } from '@ponswarp/core';

class FakeDataChannel extends EventTarget implements DataChannelLike {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  incrementBufferedOnSend = 0;

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(data);
    this.bufferedAmount += this.incrementBufferedOnSend;
  }

  close(): void {
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
});
