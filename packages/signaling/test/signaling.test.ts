import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  BrowserSignalingClient,
  SignalingClient,
  decodeSignaling,
  decodeTransfer,
  encodeSignaling,
  encodeTransfer,
  RoomManager,
  SIGNALING_PROTOCOL,
  TRANSFER_PROTOCOL,
  PROTOCOL_VERSION,
  type SignalingEnvelope,
  type TransferEnvelope,
  type WebSocketLike
} from '../src/index';
import { SignalingGateway, createSignalingHttpServer, type GatewayPeerConnection } from '../src/server';
import type { FileId, PeerId, SessionId } from '@ponswarp/core';

const sessionId = 'sess_1' as SessionId;
const ownerPeerId = 'owner' as PeerId;
const receiverPeerId = 'receiver' as PeerId;

const signaling = (overrides: Partial<SignalingEnvelope> = {}): SignalingEnvelope => ({
  protocol: SIGNALING_PROTOCOL,
  version: PROTOCOL_VERSION,
  messageId: 'msg_1',
  type: 'JOIN_SESSION',
  sessionId,
  fromPeerId: receiverPeerId,
  timestamp: 1,
  payload: { role: 'receiver' },
  ...overrides
});

const transfer = (overrides: Partial<TransferEnvelope> = {}): TransferEnvelope => ({
  protocol: TRANSFER_PROTOCOL,
  version: PROTOCOL_VERSION,
  messageId: 'msg_2',
  type: 'HELLO',
  sessionId,
  fromPeerId: receiverPeerId,
  toPeerId: ownerPeerId,
  timestamp: 2,
  payload: { role: 'receiver', supports: { resume: true, pieceMap: true, binaryFrameV1: true } },
  ...overrides
});

class FakeSocket extends EventTarget implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  receive(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

describe('signaling protocol validation', () => {
  it('round-trips valid signaling envelopes', () => {
    expect(decodeSignaling(encodeSignaling(signaling()))).toMatchObject({ type: 'JOIN_SESSION' });
  });

  it('validates every signaling message family', () => {
    const validPayloads: Array<[SignalingEnvelope['type'], Record<string, unknown>]> = [
      ['CREATE_SESSION', { ownerPeerId: 'owner', mode: 'grid', files: [] }],
      ['SESSION_CREATED', { ownerPeerId: 'owner', expiresAt: 2, shareUrl: 'http://localhost/join/sess_1' }],
      ['JOIN_SESSION', { role: 'receiver', client: { name: 'test', version: '0.1.0' } }],
      ['SESSION_JOINED', { selfPeerId: 'receiver', ownerPeerId: 'owner', peers: [], files: [] }],
      ['PEER_JOINED', { peerId: 'receiver', role: 'receiver' }],
      ['PEER_LEFT', { peerId: 'receiver' }],
      ['WEBRTC_OFFER', { sdp: { type: 'offer', sdp: 'v=0' } }],
      ['WEBRTC_ANSWER', { sdp: { type: 'answer', sdp: 'v=0' } }],
      ['ICE_CANDIDATE', { candidate: { candidate: 'candidate:0', sdpMid: '0', sdpMLineIndex: 0 } }],
      ['ERROR', { code: 'bad_request', message: 'Bad request' }]
    ];

    for (const [type, payload] of validPayloads) {
      expect(decodeSignaling(encodeSignaling(signaling({ type, payload })))).toMatchObject({ type, payload });
    }

    expect(() => decodeSignaling(encodeSignaling(signaling({ type: 'CREATE_SESSION', payload: { files: [] } })))).toThrow(/ownerPeerId/);
    expect(() => decodeSignaling(encodeSignaling(signaling({ type: 'BOGUS' as never })))).toThrow(/Unknown/);
    expect(decodeSignaling(JSON.stringify({ ...signaling(), version: '1.1.0' }))).toMatchObject({ version: '1.1.0' });
    expect(() => decodeSignaling(JSON.stringify({ ...signaling(), version: '2.0.0' }))).toThrow(/major/);
    expect(() => decodeSignaling(encodeSignaling(signaling({ type: 'WEBRTC_OFFER', payload: { sdp: { type: 'answer', sdp: 'v=0' } } })))).toThrow(/invalid sdp/);
  });
});

describe('transfer protocol codec', () => {
  it('validates every transfer control message family', () => {
    const payloads: Array<[TransferEnvelope['type'], Record<string, unknown>]> = [
      ['HELLO', { role: 'receiver', supports: { resume: true, pieceMap: true, binaryFrameV1: true } }],
      ['MANIFEST', { files: [] }],
      ['PIECE_MAP', { fileId: 'file_1', verifiedPieces: [0], pieceCount: 2 }],
      ['PIECE_REQUEST', { fileId: 'file_1', pieceIndex: 1, requestId: 'req_1', fromOffset: 0 }],
      ['PIECE_CANCEL', { fileId: 'file_1', pieceIndex: 1, requestId: 'req_1', reason: 'peer_switch' }],
      ['PIECE_ACK', { fileId: 'file_1', pieceIndex: 1, requestId: 'req_1', status: 'verified', hash: 'abc' }],
      ['PIECE_REJECT', { fileId: 'file_1', pieceIndex: 1, requestId: 'req_1', reason: 'hash_mismatch' }],
      ['RESUME_STATE', { fileId: 'file_1', manifestHash: 'sha256:x', verifiedPieces: [0], missingCount: 1 }],
      ['RESUME_ACCEPTED', { fileId: 'file_1', nextStrategy: 'request_missing_only' }],
      ['RESUME_REJECTED', { fileId: 'file_1', reason: 'manifest_mismatch' }],
      ['ERROR', { code: 'missing_piece', message: 'missing', recoverable: true }]
    ];

    for (const [type, payload] of payloads) {
      expect(decodeTransfer(encodeTransfer(transfer({ type, payload })))).toMatchObject({ type, payload });
    }

    expect(() => decodeTransfer(encodeTransfer(transfer({ type: 'PIECE_REQUEST', payload: { fileId: 'file_1', pieceIndex: 1 } })))).toThrow(/requestId/);
    expect(() => decodeTransfer(JSON.stringify({ ...transfer(), type: 'BOGUS' }))).toThrow(/Unknown/);
    expect(decodeTransfer(JSON.stringify({ ...transfer(), version: '1.2.0' }))).toMatchObject({ version: '1.2.0' });
    expect(() => decodeTransfer(JSON.stringify({ ...transfer(), version: '2.0.0' }))).toThrow(/major/);
    expect(() => decodeTransfer(encodeTransfer(transfer({ type: 'HELLO', payload: { role: 'receiver', supports: { resume: true, pieceMap: 'yes', binaryFrameV1: true } } })))).toThrow(/supports.pieceMap/);
    expect(() => decodeTransfer(encodeTransfer(transfer({ type: 'PIECE_MAP', payload: { fileId: 'file_1', verifiedPieces: ['0'], pieceCount: 2 } })))).toThrow(/verifiedPieces/);
  });
});

describe('RoomManager lifecycle and relay', () => {
  it('returns immutable snapshots and protects internal state', () => {
    const manager = new RoomManager(() => 1000);
    const files = [{ fileId: 'file_1' as FileId, name: 'demo.bin', size: 1, pieceSize: 1, pieceCount: 1 }];
    const created = manager.createSession({ sessionId, ownerPeerId, files, ttlMs: 1000 });

    files[0].name = 'mutated.bin';
    expect(created.files[0].name).toBe('demo.bin');
    expect(Object.isFrozen(created.files)).toBe(true);

    manager.joinSession(sessionId, receiverPeerId);
    expect(created.peers).toHaveLength(1);
    expect(manager.listPeers(sessionId)).toHaveLength(2);
  });

  it('relays WebRTC messages only between live room peers', () => {
    const manager = new RoomManager(() => 1000);
    manager.createSession({ sessionId, ownerPeerId, files: [], ttlMs: 1000 });
    manager.joinSession(sessionId, receiverPeerId);
    const offer = signaling({ type: 'WEBRTC_OFFER', fromPeerId: receiverPeerId, toPeerId: ownerPeerId, payload: { sdp: { type: 'offer', sdp: 'v=0' } } });
    expect(manager.relayWebRtc(offer)).toMatchObject({ fromPeerId: receiverPeerId, toPeerId: ownerPeerId });
    expect(() => manager.relayWebRtc(signaling({ type: 'WEBRTC_OFFER', fromPeerId: 'unknown' as PeerId, toPeerId: ownerPeerId, payload: { sdp: { type: 'offer', sdp: 'v=0' } } }))).toThrow(/source/);
  });

  it('expires sessions deterministically', () => {
    let now = 1000;
    const manager = new RoomManager(() => now);
    manager.createSession({ sessionId, ownerPeerId, files: [], ttlMs: 10 });
    now = 1010;
    expect(() => manager.getLiveRoom(sessionId)).toThrow(/Expired/);
  });
});

describe('SignalingClient', () => {
  it('sends encoded envelopes, decodes valid messages, warns on unknown messages, and reports malformed input errors', () => {
    const socket = new FakeSocket();
    const client = new SignalingClient(socket);
    const received: SignalingEnvelope[] = [];
    const warnings: unknown[] = [];
    const errors: Error[] = [];
    client.onMessage(envelope => received.push(envelope));
    client.onWarning(warning => warnings.push(warning));
    client.onError(error => errors.push(error));
    const envelope = signaling();

    client.send(envelope);
    expect(JSON.parse(socket.sent[0])).toMatchObject({ protocol: SIGNALING_PROTOCOL, type: 'JOIN_SESSION' });

    socket.receive(encodeSignaling(envelope));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'JOIN_SESSION' });

    socket.receive(JSON.stringify({ ...envelope, type: 'UNKNOWN' }));
    expect(warnings).toHaveLength(1);
    expect(received).toHaveLength(1);

    socket.receive({ protocol: SIGNALING_PROTOCOL });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/text JSON/);
  });
});

describe('BrowserSignalingClient runtime', () => {
  it('connects through a socket factory and sends create/join envelopes', async () => {
    const sockets: FakeSocket[] = [];
    const client = new BrowserSignalingClient({
      url: 'ws://localhost:8787/ws',
      socketFactory: () => {
        const socket = new FakeSocket();
        socket.readyState = 0;
        sockets.push(socket);
        return socket;
      },
      reconnectDelaysMs: [0]
    });
    const states: string[] = [];
    client.onState(state => states.push(state));

    const connected = client.connect();
    sockets[0].readyState = 1;
    sockets[0].dispatchEvent(new Event('open'));
    await connected;

    client.createSession({ ownerPeerId, files: [{ fileId: 'file_1' as FileId, name: 'demo.bin', size: 1, pieceSize: 1, pieceCount: 1 }], sessionId });
    client.joinSession({ sessionId, peerId: receiverPeerId });

    expect(states).toContain('connecting');
    expect(states).toContain('open');
    expect(sockets[0].sent.map(value => JSON.parse(value).type)).toEqual(['CREATE_SESSION', 'JOIN_SESSION']);

    sockets[0].readyState = 3;
    sockets[0].dispatchEvent(new Event('close'));
    expect(states).toContain('reconnecting');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(2);
    sockets[1].readyState = 1;
    sockets[1].dispatchEvent(new Event('open'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(states.at(-1)).toBe('open');
  });
});

class GatewayConnection implements GatewayPeerConnection {
  sent: SignalingEnvelope[] = [];
  closed = false;
  constructor(public peerId?: PeerId, public sessionId?: SessionId) {}
  send(data: string): void { this.sent.push(decodeSignaling(data)); }
  close(): void { this.closed = true; }
}

describe('SignalingGateway server runtime', () => {
  it('creates sessions, joins receivers, broadcasts peer events, and relays WebRTC envelopes', () => {
    const manager = new RoomManager(() => 1000);
    const gateway = new SignalingGateway(manager, {
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://localhost:5173',
      sessionTtlMs: 1000,
      peerTtlMs: 1000,
      maxPeersPerSession: 4,
      maxSessions: 10,
      heartbeatIntervalMs: 1000,
      stalePeerTimeoutMs: 1000,
      allowedOrigins: []
    }, () => 1000);
    const owner = new GatewayConnection();
    const receiver = new GatewayConnection();
    gateway.attach(owner);
    gateway.attach(receiver);

    gateway.handleText(owner, encodeSignaling(signaling({
      type: 'CREATE_SESSION',
      fromPeerId: ownerPeerId,
      sessionId,
      payload: { ownerPeerId, mode: 'grid', files: [{ fileId: 'file_1', name: 'demo.bin', size: 1, pieceSize: 1, pieceCount: 1 }] }
    })));
    expect(owner.sent.at(-1)).toMatchObject({ type: 'SESSION_CREATED', sessionId });

    gateway.handleText(receiver, encodeSignaling(signaling({
      type: 'JOIN_SESSION',
      fromPeerId: receiverPeerId,
      sessionId,
      payload: { role: 'receiver' }
    })));
    expect(receiver.sent.at(-1)).toMatchObject({ type: 'SESSION_JOINED' });
    expect(owner.sent.at(-1)).toMatchObject({ type: 'PEER_JOINED', payload: { peerId: receiverPeerId } });

    gateway.handleText(receiver, encodeSignaling(signaling({
      type: 'WEBRTC_OFFER',
      fromPeerId: receiverPeerId,
      toPeerId: ownerPeerId,
      sessionId,
      payload: { sdp: { type: 'offer', sdp: 'v=0' } }
    })));
    expect(owner.sent.at(-1)).toMatchObject({ type: 'WEBRTC_OFFER', fromPeerId: receiverPeerId, toPeerId: ownerPeerId });

    gateway.detach(receiver);
    expect(owner.sent.at(-1)).toMatchObject({ type: 'PEER_LEFT', payload: { peerId: receiverPeerId } });
  });

  it('rejects malformed WebSocket handshakes and oversized frames without killing health endpoint', async () => {
    const runtime = createSignalingHttpServer({ config: { host: '127.0.0.1', port: 0, publicBaseUrl: 'http://localhost:5173', heartbeatIntervalMs: 1000 } });
    await runtime.listen();
    const address = runtime.server.address();
    if (!address || typeof address !== 'object') throw new Error('server address unavailable');
    const port = address.port;

    const malformedHandshake = await rawSocketExchange(port, [
      'GET /ws HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      '',
      ''
    ].join('\r\n'));
    expect(malformedHandshake).toContain('400 Bad Request');

    const oversized = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>(resolve => oversized.once('connect', resolve));
    oversized.write([
      'GET /ws HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      ''
    ].join('\r\n'));
    await new Promise(resolve => oversized.once('data', resolve));
    oversized.write(Buffer.from([0x81, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
    await new Promise(resolve => oversized.once('close', resolve));

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    await runtime.close();
  });
});
function rawSocketExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let received = '';
    socket.on('data', chunk => { received += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => resolve(received));
    socket.on('connect', () => socket.end(payload));
  });
}
