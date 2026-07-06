import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { DEFAULT_SIGNALING_SERVER_CONFIG, SignalingGateway, createSignalingHttpServer, type GatewayPeerConnection } from '../src/server';
import type { FileId, PeerId, SessionId } from '@ponswarp/core';

const sessionId = 'sess_1' as SessionId;
const ownerPeerId = 'owner' as PeerId;
const receiverPeerId = 'receiver' as PeerId;
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));


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
      allowedOrigins: [],
      serviceName: DEFAULT_SIGNALING_SERVER_CONFIG.serviceName,
      deploymentDomain: DEFAULT_SIGNALING_SERVER_CONFIG.deploymentDomain,
      legacyDomain: DEFAULT_SIGNALING_SERVER_CONFIG.legacyDomain,
      version: DEFAULT_SIGNALING_SERVER_CONFIG.version,
      commitSha: DEFAULT_SIGNALING_SERVER_CONFIG.commitSha,
      readinessChecks: {}
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

  it('accepts legacy and grid WebSocket upgrade paths with valid handshakes', async () => {
    const runtime = createSignalingHttpServer({ config: { host: '127.0.0.1', port: 0, publicBaseUrl: 'http://localhost:5173', heartbeatIntervalMs: 1000 } });
    await runtime.listen();
    const sockets: WebSocket[] = [];
    try {
      const address = runtime.server.address();
      if (!address || typeof address !== 'object') throw new Error('server address unavailable');

      for (const path of ['/ws', '/ws/grid']) {
        const socket = await openWebSocket(`ws://127.0.0.1:${address.port}${path}`);
        sockets.push(socket);
        expect(socket.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      await Promise.all(sockets.map(socket => closeWebSocket(socket)));
      await runtime.close();
    }
  });

  it('serves grid ICE configuration from /api/grid/v1/ice with configured TURN credentials', async () => {
    const runtime = createSignalingHttpServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        publicBaseUrl: 'http://localhost:5173',
        heartbeatIntervalMs: 1000,
        turnStaticAuthSecret: 'test-turn-secret',
        turnUrls: ['turn:turn.example.test:3478?transport=tcp'],
        turnTtlSeconds: 42
      }
    });
    await runtime.listen();
    try {
      const address = runtime.server.address();
      if (!address || typeof address !== 'object') throw new Error('server address unavailable');
      const before = Math.floor(Date.now() / 1000);

      const response = await fetch(`http://127.0.0.1:${address.port}/api/grid/v1/ice`);
      const after = Math.floor(Date.now() / 1000);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-cache');
      const body = await response.json() as { iceServers: Array<{ urls: string[]; username?: string; credential?: string }>; ttlSeconds: number; relayPolicyRecommended: boolean };
      const turnServer = body.iceServers.find(server => server.urls.includes('turn:turn.example.test:3478?transport=tcp'));
      expect(body.ttlSeconds).toBe(42);
      expect(body.relayPolicyRecommended).toBe(false);
      expect(turnServer).toBeDefined();
      const username = turnServer?.username ?? '';
      const expiresAt = Number(username.split(':')[0]);
      expect(username).toMatch(/^\d+:grid$/);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 42);
      expect(expiresAt).toBeLessThanOrEqual(after + 42);
      expect(turnServer?.credential).toBe(createHmac('sha1', 'test-turn-secret').update(username).digest('base64'));
    } finally {
      await runtime.close();
    }
  });

  it('returns structured not-implemented responses for unsupported coordinator share routes', async () => {
    const runtime = createSignalingHttpServer({ config: { host: '127.0.0.1', port: 0, publicBaseUrl: 'http://localhost:5173', heartbeatIntervalMs: 1000 } });
    await runtime.listen();
    try {
      const address = runtime.server.address();
      if (!address || typeof address !== 'object') throw new Error('server address unavailable');
      const cases = [
        { method: 'POST', path: '/api/grid/v1/workspaces/demo/shares', body: { fileId: 'file_1' } },
        { method: 'GET', path: '/api/grid/v1/shares/ABCD-1234' },
        { method: 'GET', path: '/api/grid/v1/shares/ABCD-1234/candidates' }
      ];

      for (const route of cases) {
        const response = await fetch(`http://127.0.0.1:${address.port}${route.path}`, {
          method: route.method,
          headers: route.body ? { 'content-type': 'application/json' } : undefined,
          body: route.body ? JSON.stringify(route.body) : undefined
        });
        expect(response.status).toBe(501);
        expect(await response.json()).toMatchObject({ error: 'not_implemented' });
      }
    } finally {
      await runtime.close();
    }
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
    await waitForSocketEvent(oversized, 'connect');
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
    await waitForSocketEvent(oversized, 'data');
    oversized.write(Buffer.from([0x81, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
    await waitForSocketEvent(oversized, 'close');

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', service: 'ponswarp-signaling' });

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { process: 'ok', websocket: 'ok' } });

    const version = await fetch(`http://127.0.0.1:${port}/version.json`);
    expect(version.status).toBe(200);
    expect(version.headers.get('cache-control')).toBe('no-cache');
    expect(await version.json()).toMatchObject({ service: 'ponswarp-signaling', legacyDomain: 'warp.ponslink.com' });
    await runtime.close();
  });
});
  it('returns not-ready when required readiness checks are degraded while health stays alive', async () => {
    const runtime = createSignalingHttpServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        publicBaseUrl: 'http://localhost:5173',
        heartbeatIntervalMs: 1000,
        readinessChecks: { db: 'degraded', migrations: 'ok', rateLimitStore: 'disabled' }
      }
    });
    await runtime.listen();
    const address = runtime.server.address();
    if (!address || typeof address !== 'object') throw new Error('server address unavailable');
    const port = address.port;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: 'not_ready', checks: { db: 'degraded', migrations: 'ok', rateLimitStore: 'disabled' } });

    await runtime.close();
  });
  it('allows only optional cleanupScheduler to be disabled in readiness checks', async () => {
    const runtime = createSignalingHttpServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        publicBaseUrl: 'http://localhost:5173',
        heartbeatIntervalMs: 1000,
        readinessChecks: { db: 'ok', migrations: 'ok', rateLimitStore: 'ok', cleanupScheduler: 'disabled' }
      }
    });
    await runtime.listen();
    const address = runtime.server.address();
    if (!address || typeof address !== 'object') throw new Error('server address unavailable');

    const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { cleanupScheduler: 'disabled' } });

    await runtime.close();
  });
describe('grid deployment validator', () => {
  it('passes when nginx, systemd, CLI, and coordinator server fixtures expose the grid route contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-grid-deploy-validator-'));
    try {
      await writeDeploymentFixture(root, { signalingServer: signalingServerFixture({ includeGridRoutes: true }) });

      const result = await runDeploymentValidator(root);

      expect(result.code).toBe(0);
      expect(result.report.verdict).toBe('passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when deployment config advertises grid routes that the coordinator server fixture does not expose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ponswarp-grid-deploy-validator-'));
    try {
      await writeDeploymentFixture(root, { signalingServer: signalingServerFixture({ includeGridRoutes: false }) });

      const result = await runDeploymentValidator(root);

      expect(result.code).toBe(1);
      expect(result.report.verdict).toBe('failed');
      const failures = result.report.checks.filter(check => check.status === 'failed').map(check => `${check.id}: ${check.evidence}`).join('\n');
      expect(failures).toContain('/ws/grid');
      expect(failures).toContain('/api/grid/v1/ice');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`WebSocket failed to open ${url}`)), { once: true });
  });
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolve => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.close();
  });
}

interface DeploymentValidatorReport {
  verdict: 'passed' | 'failed';
  checks: Array<{ id: string; status: 'passed' | 'failed'; evidence: string }>;
}

interface DeploymentValidatorResult {
  code: number | null;
  stdout: string;
  stderr: string;
  report: DeploymentValidatorReport;
}

async function runDeploymentValidator(cwd: string): Promise<DeploymentValidatorResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts/validate-grid-deployment-config.mjs'), '--out', 'validator-report.json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      readFile(join(cwd, 'validator-report.json'), 'utf8')
        .then(raw => {
          const report = JSON.parse(raw) as DeploymentValidatorReport;
          resolve({ code, stdout, stderr, report });
        })
        .catch(reject);
    });
  });
}

async function writeDeploymentFixture(root: string, input: { signalingServer: string }): Promise<void> {
  await mkdir(join(root, 'deploy'), { recursive: true });
  await mkdir(join(root, 'packages/cli/src'), { recursive: true });
  await mkdir(join(root, 'packages/signaling/src'), { recursive: true });
  await writeFile(join(root, 'deploy/grid.ponslink.env.example'), [
    'PONSWARP_MESH_PUBLIC_BASE_URL=https://grid.ponslink.com',
    'PONSWARP_MESH_LEGACY_BASE_URL=https://warp.ponslink.com',
    'PONSWARP_MESH_DB_SCHEMA=grid',
    'PONSWARP_WEB_SHOW_QA_CONTROLS=false',
    'PONSWARP_MESH_ADMIN_API_TOKEN=REPLACE_WITH_SECRET',
    'PONSWARP_NODE_TOKEN_PEPPER=REPLACE_WITH_SECRET',
    'PONSWARP_TURN_STATIC_AUTH_SECRET=REPLACE_WITH_SECRET',
    ''
  ].join('\n'));
  await writeFile(join(root, 'deploy/grid.ponslink.nginx.conf'), [
    'server {',
    '  server_name grid.ponslink.com;',
    '  add_header Strict-Transport-Security "max-age=31536000" always;',
    '  add_header Content-Security-Policy "default-src self" always;',
    '  add_header X-Content-Type-Options "nosniff" always;',
    '  add_header Referrer-Policy "no-referrer" always;',
    '  location /api/grid/v1/ { proxy_pass http://ponswarp_grid_coordinator/api/grid/v1/; add_header Cache-Control "no-cache" always; }',
    '  location /ws/grid/ { proxy_pass http://ponswarp_grid_coordinator/ws/grid/; }',
    '  location = /healthz { proxy_pass http://ponswarp_grid_coordinator/healthz; }',
    '  location = /readyz { proxy_pass http://ponswarp_grid_coordinator/readyz; }',
    '  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable" always; }',
    '}',
    ''
  ].join('\n'));
  await writeFile(join(root, 'deploy/ponswarp-grid-coordinator.service'), [
    '[Unit]',
    'Description=PonsWarp Grid Coordinator for grid.ponslink.com',
    '[Service]',
    'EnvironmentFile=/etc/ponswarp/grid.ponslink.env',
    'ExecStart=/opt/ponswarp/ponswarp-signaling-rs/target/release/mesh_api --host 127.0.0.1 --port 8788',
    'Restart=on-failure',
    'NoNewPrivileges=true',
    ''
  ].join('\n'));
  await writeFile(join(root, 'packages/cli/src/index.ts'), "const coordinator = process.env.PONSWARP_COORDINATOR_URL ?? 'https://grid.ponslink.com';\n");
  await writeFile(join(root, 'packages/cli/src/coordinator-runtime.ts'), [
    "const workspacePath = '/api/grid/v1/workspaces';",
    "const sharePath = '/api/grid/v1/shares';",
    ''
  ].join('\n'));
  await writeFile(join(root, 'packages/signaling/src/server.ts'), input.signalingServer);
}

function signalingServerFixture(input: { includeGridRoutes: boolean }): string {
  const gridRoutes = input.includeGridRoutes ? [
    "function isGridWebSocketPath(url) { return url === '/ws' || url === '/ws/grid'; }",
    "if (request.url === '/api/grid/v1/ice') return writeJson(response, 200, {});",
    "if (request.url?.startsWith('/api/grid/v1/shares')) return writeJson(response, 501, { error: 'not_implemented', expectedExternalService: 'ponswarp-grid-coordinator' });",
    "if (isGridWebSocketPath(request.url)) return acceptWebSocket(request, socket);",
    "return url === '/ws/grid';"
  ] : [];
  return [
    "if (request.url === '/healthz') return writeJson(response, 200, {});",
    "if (request.url === '/readyz') { const ready = true; return writeJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' }); }",
    "if (request.url === '/version.json') return writeJson(response, 200, { legacyDomain: 'warp.ponslink.com' });",
    "const metadata = { legacyDomain: 'warp.ponslink.com', status: ready ? 'ready' : 'not_ready' };",
    ...gridRoutes,
    ''
  ].join('\n');
}

function waitForSocketEvent(socket: Socket, event: 'connect' | 'data' | 'close'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once('error', reject);
  });
}

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
