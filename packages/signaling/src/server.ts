import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  PROTOCOL_VERSION,
  SIGNALING_PROTOCOL,
  RoomManager,
  decodeSignaling,
  encodeSignaling,
  type PeerSummary,
  type RoomSnapshot,
  type SessionFileDescriptor,
  type SignalingEnvelope
} from './index.js';
import type { PeerId, SessionId } from '@ponswarp/core';

export interface SignalingServerConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  sessionTtlMs: number;
  peerTtlMs: number;
  maxPeersPerSession: number;
  maxSessions: number;
  heartbeatIntervalMs: number;
  stalePeerTimeoutMs: number;
  allowedOrigins: string[];
  serviceName: string;
  deploymentDomain: string;
  legacyDomain: string;
  version: string;
  commitSha: string;
  readinessChecks: Record<string, 'ok' | 'degraded' | 'disabled'>;
  turnStaticAuthSecret?: string;
  turnRealm: string;
  turnUrls: string[];
  turnTtlSeconds: number;
  sessionToken?: string;
}

export const DEFAULT_SIGNALING_SERVER_CONFIG: SignalingServerConfig = {
  host: '0.0.0.0',
  port: 8787,
  publicBaseUrl: process.env.PONSWARP_PUBLIC_BASE_URL ?? '',
  sessionTtlMs: 60 * 60 * 1000,
  peerTtlMs: 30 * 1000,
  maxPeersPerSession: 16,
  maxSessions: 1024,
  heartbeatIntervalMs: 10 * 1000,
  stalePeerTimeoutMs: 5 * 60 * 1000,
  allowedOrigins: [],
  serviceName: 'ponswarp-signaling',
  deploymentDomain: process.env.PONSWARP_DEPLOYMENT_DOMAIN ?? '',
  legacyDomain: 'warp.ponslink.com',
  version: process.env.npm_package_version ?? '0.1.0',
  commitSha: process.env.PONSWARP_BUILD_SHA ?? 'dev',
  readinessChecks: {},
  turnStaticAuthSecret: process.env.PONSWARP_TURN_STATIC_AUTH_SECRET,
  turnRealm: process.env.PONSWARP_TURN_REALM ?? 'ponslink.com',
  turnTtlSeconds: Number(process.env.PONSWARP_TURN_TTL_SECONDS ?? 600),
  turnUrls: (process.env.PONSWARP_TURN_URLS ?? '').split(',').map(url => url.trim()).filter(Boolean),
  sessionToken: process.env.PONSWARP_SESSION_TOKEN || undefined
};

export type SignalingGatewayEvent =
  | { type: 'sessionCreated'; session: RoomSnapshot }
  | { type: 'peerJoined'; sessionId: SessionId; peer: PeerSummary; peers: PeerSummary[] }
  | { type: 'peerLeft'; sessionId: SessionId; peerId: PeerId }
  | { type: 'relayed'; envelope: SignalingEnvelope };

export interface GatewayPeerConnection {
  readonly peerId?: PeerId;
  readonly sessionId?: SessionId;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface MutableGatewayPeerConnection extends GatewayPeerConnection {
  peerId?: PeerId;
  sessionId?: SessionId;
  lastSeenAt: number;
}

export class SignalingGateway {
  private readonly peers = new Set<MutableGatewayPeerConnection>();
  private readonly events = new Set<(event: SignalingGatewayEvent) => void>();

  constructor(
    private readonly roomManager = new RoomManager(),
    private readonly config: SignalingServerConfig = DEFAULT_SIGNALING_SERVER_CONFIG,
    private readonly now: () => number = () => Date.now()
  ) {}

  attach(connection: GatewayPeerConnection): void {
    const mutable = connection as MutableGatewayPeerConnection;
    mutable.lastSeenAt = this.now();
    this.peers.add(mutable);
  }

  detach(connection: GatewayPeerConnection): void {
    const mutable = connection as MutableGatewayPeerConnection;
    this.peers.delete(mutable);
    if (mutable.sessionId && mutable.peerId) {
      this.roomManager.leaveSession(mutable.sessionId, mutable.peerId);
      this.broadcastPeerLeft(mutable.sessionId, mutable.peerId);
      this.emit({ type: 'peerLeft', sessionId: mutable.sessionId, peerId: mutable.peerId });
    }
  }

  onEvent(handler: (event: SignalingGatewayEvent) => void): () => void {
    this.events.add(handler);
    return () => this.events.delete(handler);
  }

  handleText(connection: GatewayPeerConnection, data: string): void {
    const mutable = connection as MutableGatewayPeerConnection;
    mutable.lastSeenAt = this.now();
    let envelope: SignalingEnvelope;
    try {
      envelope = decodeSignaling(data);
      this.handleEnvelope(mutable, envelope);
    } catch (error) {
      this.sendError(mutable, undefined, undefined, error instanceof Error ? error.message : String(error), 'bad_request');
    }
  }

  cleanupStalePeers(): number {
    const cutoff = this.now() - this.config.stalePeerTimeoutMs;
    let removed = 0;
    for (const peer of [...this.peers]) {
      if (peer.lastSeenAt <= cutoff) {
        peer.close(4000, 'stale peer');
        this.detach(peer);
        removed += 1;
      }
    }
    removed += this.roomManager.cleanupExpired();
    return removed;
  }

  private handleEnvelope(connection: MutableGatewayPeerConnection, envelope: SignalingEnvelope): void {
    switch (envelope.type) {
      case 'CREATE_SESSION':
        this.handleCreateSession(connection, envelope);
        return;
      case 'JOIN_SESSION':
        this.handleJoinSession(connection, envelope);
        return;
      case 'WEBRTC_OFFER':
      case 'WEBRTC_ANSWER':
      case 'ICE_CANDIDATE':
        this.handleRelay(connection, envelope);
        return;
      case 'PEER_LEFT':
        if (envelope.sessionId && envelope.fromPeerId) this.handleLeave(connection, envelope.sessionId, envelope.fromPeerId);
        return;
      default:
        this.sendError(connection, envelope.sessionId, envelope.fromPeerId, `Unsupported client message ${envelope.type}`, 'unsupported_message');
    }
  }

  private handleCreateSession(connection: MutableGatewayPeerConnection, envelope: SignalingEnvelope): void {
    const payload = envelope.payload as { ownerPeerId: PeerId; files: SessionFileDescriptor[] };
    const sessionId = envelope.sessionId ?? (`sess_${randomUUID()}` as SessionId);
    const session = this.roomManager.createSession({ sessionId, ownerPeerId: payload.ownerPeerId, files: payload.files, ttlMs: this.config.sessionTtlMs });
    connection.peerId = payload.ownerPeerId;
    connection.sessionId = sessionId;
    const response: SignalingEnvelope = {
      protocol: SIGNALING_PROTOCOL,
      version: PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      type: 'SESSION_CREATED',
      sessionId,
      fromPeerId: payload.ownerPeerId,
      timestamp: this.now(),
      payload: {
        ownerPeerId: payload.ownerPeerId,
        expiresAt: session.expiresAt,
        shareUrl: `${this.config.publicBaseUrl.replace(/\/$/, '')}/#/join/${sessionId}`
      }
    };
    connection.send(encodeSignaling(response));
    this.emit({ type: 'sessionCreated', session });
  }

  private handleJoinSession(connection: MutableGatewayPeerConnection, envelope: SignalingEnvelope): void {
    if (!envelope.sessionId || !envelope.fromPeerId) throw new Error('JOIN_SESSION requires sessionId and fromPeerId');
    const session = this.roomManager.joinSession(envelope.sessionId, envelope.fromPeerId, 'receiver');
    if (session.peers.length > this.config.maxPeersPerSession) {
      this.roomManager.leaveSession(envelope.sessionId, envelope.fromPeerId);
      throw new Error('Session peer limit exceeded');
    }
    connection.peerId = envelope.fromPeerId;
    connection.sessionId = envelope.sessionId;
    const response: SignalingEnvelope = {
      protocol: SIGNALING_PROTOCOL,
      version: PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      type: 'SESSION_JOINED',
      sessionId: envelope.sessionId,
      fromPeerId: envelope.fromPeerId,
      timestamp: this.now(),
      payload: {
        selfPeerId: envelope.fromPeerId,
        ownerPeerId: session.ownerPeerId,
        peers: session.peers,
        files: session.files
      }
    };
    connection.send(encodeSignaling(response));
    this.broadcastPeerJoined(envelope.sessionId, envelope.fromPeerId);
    this.emit({ type: 'peerJoined', sessionId: envelope.sessionId, peer: { peerId: envelope.fromPeerId, role: 'receiver' }, peers: [...session.peers] });
  }

  private handleRelay(connection: MutableGatewayPeerConnection, envelope: SignalingEnvelope): void {
    const relay = this.roomManager.relayWebRtc(envelope);
    const target = [...this.peers].find(peer => peer.peerId === relay.toPeerId && peer.sessionId === relay.sessionId);
    if (!target) throw new Error(`Target peer is not connected: ${relay.toPeerId}`);
    target.send(encodeSignaling(relay.envelope));
    this.emit({ type: 'relayed', envelope: relay.envelope });
  }

  private handleLeave(connection: MutableGatewayPeerConnection, sessionId: SessionId, peerId: PeerId): void {
    this.roomManager.leaveSession(sessionId, peerId);
    this.broadcastPeerLeft(sessionId, peerId);
    connection.sessionId = undefined;
    connection.peerId = undefined;
    this.emit({ type: 'peerLeft', sessionId, peerId });
  }

  private broadcastPeerJoined(sessionId: SessionId, peerId: PeerId): void {
    const envelope: SignalingEnvelope = {
      protocol: SIGNALING_PROTOCOL,
      version: PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      type: 'PEER_JOINED',
      sessionId,
      fromPeerId: peerId,
      timestamp: this.now(),
      payload: { peerId, role: 'receiver' }
    };
    this.broadcast(sessionId, envelope, peerId);
  }

  private broadcastPeerLeft(sessionId: SessionId, peerId: PeerId): void {
    const envelope: SignalingEnvelope = {
      protocol: SIGNALING_PROTOCOL,
      version: PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      type: 'PEER_LEFT',
      sessionId,
      fromPeerId: peerId,
      timestamp: this.now(),
      payload: { peerId }
    };
    this.broadcast(sessionId, envelope, peerId);
  }

  private broadcast(sessionId: SessionId, envelope: SignalingEnvelope, exceptPeerId?: PeerId): void {
    const encoded = encodeSignaling(envelope);
    for (const peer of this.peers) {
      if (peer.sessionId === sessionId && peer.peerId !== exceptPeerId) peer.send(encoded);
    }
  }

  private sendError(connection: MutableGatewayPeerConnection, sessionId: SessionId | undefined, toPeerId: PeerId | undefined, message: string, code: string): void {
    const envelope: SignalingEnvelope = {
      protocol: SIGNALING_PROTOCOL,
      version: PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      type: 'ERROR',
      sessionId,
      toPeerId,
      timestamp: this.now(),
      payload: { code, message }
    };
    connection.send(encodeSignaling(envelope));
  }

  private emit(event: SignalingGatewayEvent): void {
    this.events.forEach(handler => handler(event));
  }
}

export interface SignalingHttpServer {
  server: HttpServer;
  gateway: SignalingGateway;
  shareRegistry: BrowserShareRegistry;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** In-memory browser share codes → signaling session (code/QR receive path). */
export type BrowserShareRecord = {
  code: string;
  sessionId: SessionId;
  fileId: string;
  fileName: string;
  sizeBytes: number;
  pieceSize: number;
  pieceCount: number;
  ownerPeerId: PeerId;
  joinUrl: string;
  expiresAt: number;
  createdAt: number;
};

export class BrowserShareRegistry {
  private readonly byCode = new Map<string, BrowserShareRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  normalizeCode(code: string): string {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  put(input: {
    code: string;
    sessionId: SessionId;
    fileId: string;
    fileName: string;
    sizeBytes: number;
    pieceSize: number;
    pieceCount: number;
    ownerPeerId: PeerId;
    joinUrl: string;
    ttlMs: number;
  }): BrowserShareRecord {
    this.cleanup();
    const code = this.normalizeCode(input.code);
    if (code.length < 6) throw new Error('Share code too short');
    const createdAt = this.now();
    const record: BrowserShareRecord = {
      code,
      sessionId: input.sessionId,
      fileId: input.fileId,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      pieceSize: input.pieceSize,
      pieceCount: input.pieceCount,
      ownerPeerId: input.ownerPeerId,
      joinUrl: input.joinUrl,
      createdAt,
      expiresAt: createdAt + Math.max(60_000, input.ttlMs)
    };
    this.byCode.set(code, record);
    return record;
  }

  get(code: string): BrowserShareRecord | undefined {
    this.cleanup();
    const normalized = this.normalizeCode(code);
    const record = this.byCode.get(normalized);
    if (!record) return undefined;
    if (record.expiresAt <= this.now()) {
      this.byCode.delete(normalized);
      return undefined;
    }
    return record;
  }

  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [code, record] of this.byCode) {
      if (record.expiresAt <= now) {
        this.byCode.delete(code);
        removed += 1;
      }
    }
    return removed;
  }
}


export function createSignalingHttpServer(input: { config?: Partial<SignalingServerConfig>; roomManager?: RoomManager; shareRegistry?: BrowserShareRegistry } = {}): SignalingHttpServer {
  const config = { ...DEFAULT_SIGNALING_SERVER_CONFIG, ...input.config };
  const gateway = new SignalingGateway(input.roomManager ?? new RoomManager(), config);
  const shareRegistry = input.shareRegistry ?? new BrowserShareRegistry();
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, config, shareRegistry);
  });
  const interval = setInterval(() => {
    gateway.cleanupStalePeers();
    shareRegistry.cleanup();
  }, config.heartbeatIntervalMs);
  interval.unref?.();

  server.on('upgrade', (request, socket) => {
    if (!isOriginAllowed(request.headers.origin, config.allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (config.sessionToken) {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (requestUrl.searchParams.get('token') !== config.sessionToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    if (!isGridWebSocketPath(request.url)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (typeof request.headers['sec-websocket-key'] !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const connection = acceptWebSocket(request, socket as Socket);
    gateway.attach(connection);
    connection.onText = text => gateway.handleText(connection, text);
    connection.onClose = () => gateway.detach(connection);
  });

  return {
    server,
    gateway,
    shareRegistry,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    }),
    close: () => new Promise((resolve, reject) => {
      clearInterval(interval);
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse, config: SignalingServerConfig, shareRegistry: BrowserShareRegistry): Promise<void> {
  if (request.url === '/healthz') {
    writeJson(response, 200, {
      status: 'ok',
      service: config.serviceName,
      version: config.version,
      commitSha: config.commitSha
    });
    return;
  }
  if (request.url === '/readyz') {
    const checks = {
      process: 'ok',
      websocket: 'ok',
      ...config.readinessChecks
    };
    const ready = Object.entries(checks).every(([name, status]) => status === 'ok' || (name === 'cleanupScheduler' && status === 'disabled'));
    writeJson(response, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not_ready',
      service: config.serviceName,
      version: config.version,
      commitSha: config.commitSha,
      domain: config.deploymentDomain,
      legacyDomain: config.legacyDomain,
      checks
    });
    return;
  }
  if (request.url === '/version.json') {
    writeJson(response, 200, {
      service: config.serviceName,
      version: config.version,
      commitSha: config.commitSha,
      domain: config.deploymentDomain,
      legacyDomain: config.legacyDomain
    }, { 'cache-control': 'no-cache' });
    return;
  }
  if (request.url === '/api/grid/v1/ice') {
    writeJson(response, 200, createIceResponse(config), { 'cache-control': 'no-cache' });
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Browser share registry (code → signaling session) for product receive path.
  if (request.method === 'POST' && path === '/api/grid/v1/workspaces/browser/files') {
    const body = await readJsonBody(request);
    if (!body || typeof body.fileId !== 'string') {
      writeJson(response, 400, { error: 'invalid_body', message: 'fileId required' });
      return;
    }
    writeJson(response, 200, { ok: true, fileId: body.fileId, published: true });
    return;
  }

  if (request.method === 'POST' && path === '/api/grid/v1/workspaces/browser/shares') {
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object') {
      writeJson(response, 400, { error: 'invalid_body' });
      return;
    }
    const caps = (body.capabilities && typeof body.capabilities === 'object') ? body.capabilities as Record<string, unknown> : {};
    const sessionId = String(caps.signalingSessionId ?? body.signalingSessionId ?? '');
    const joinUrl = String(caps.joinUrl ?? body.joinUrl ?? '');
    const codeRaw = String(body.requestedCode ?? body.code ?? '');
    const fileId = String(body.fileId ?? '');
    const ownerPeerId = String(body.createdByNodeId ?? body.ownerPeerId ?? '');
    if (!sessionId || !codeRaw || !fileId) {
      writeJson(response, 400, { error: 'invalid_body', message: 'requestedCode, fileId, capabilities.signalingSessionId required' });
      return;
    }
    const ttlSeconds = typeof body.ttlSeconds === 'number' && body.ttlSeconds > 0 ? body.ttlSeconds : 86_400;
    try {
      const record = shareRegistry.put({
        code: codeRaw,
        sessionId: sessionId as SessionId,
        fileId,
        fileName: String(body.fileName ?? caps.fileName ?? fileId),
        sizeBytes: Number(body.sizeBytes ?? caps.sizeBytes ?? 0) || 0,
        pieceSize: Number(caps.pieceSize ?? body.pieceSize ?? 0) || 0,
        pieceCount: Number(body.pieceCount ?? caps.pieceCount ?? 0) || 0,
        ownerPeerId: ownerPeerId as PeerId,
        joinUrl: joinUrl || `${config.publicBaseUrl.replace(/\/$/, '')}/#/join/${sessionId}`,
        ttlMs: ttlSeconds * 1000
      });
      const link = `${config.publicBaseUrl.replace(/\/$/, '')}/#/get/${encodeURIComponent(record.code)}?session=${encodeURIComponent(record.sessionId)}`;
      writeJson(response, 200, {
        code: record.code,
        link,
        getUrl: link,
        fileId: record.fileId,
        signalingSessionId: record.sessionId,
        joinUrl: record.joinUrl,
        expiresAt: record.expiresAt
      });
    } catch (error) {
      writeJson(response, 400, { error: 'share_failed', message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (request.method === 'GET' && path.startsWith('/api/grid/v1/shares/')) {
    const rest = path.slice('/api/grid/v1/shares/'.length);
    const [codePart, maybeCandidates] = rest.split('/');
    const code = decodeURIComponent(codePart ?? '');
    if (maybeCandidates === 'candidates') {
      const record = shareRegistry.get(code);
      if (!record) {
        writeJson(response, 404, { error: 'not_found' });
        return;
      }
      writeJson(response, 200, {
        providers: [{
          nodeId: record.ownerPeerId,
          online: true,
          endpointHints: [{ kind: 'ponswarp-join', value: record.joinUrl }]
        }]
      }, { 'cache-control': 'no-store' });
      return;
    }
    const record = shareRegistry.get(code);
    if (!record) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }
    writeJson(response, 200, {
      code: record.code,
      fileId: record.fileId,
      name: record.fileName,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      signalingSessionId: record.sessionId,
      sessionId: record.sessionId,
      joinUrl: record.joinUrl,
      capabilities: {
        browser: true,
        directTransfer: true,
        signalingSessionId: record.sessionId,
        joinUrl: record.joinUrl,
        pieceSize: record.pieceSize
      },
      expiresAt: record.expiresAt
    }, { 'cache-control': 'no-store' });
    return;
  }

  if (path.startsWith('/api/grid/v1/shares') || path.startsWith('/api/grid/v1/workspaces')) {
    writeJson(response, 501, {
      error: 'not_implemented',
      service: config.serviceName,
      message: 'Unsupported coordinator route on the TypeScript signaling server.',
      expectedExternalService: 'ponswarp-grid-coordinator'
    });
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) return null;
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function createIceResponse(config: SignalingServerConfig): { iceServers: RTCIceServerLike[]; ttlSeconds: number; relayPolicyRecommended: boolean } {
  const ttlSeconds = Number.isFinite(config.turnTtlSeconds) && config.turnTtlSeconds > 0 ? config.turnTtlSeconds : 600;
  const iceServers: RTCIceServerLike[] = [];
  const stunUrl = process.env.PONSWARP_STUN_URL ?? 'stun:turn.ponslink.com:3478';
  if (stunUrl) iceServers.push({ urls: [stunUrl] });
  if (config.turnStaticAuthSecret && config.turnUrls.length > 0) {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expiresAt}:grid`;
    const credential = createHmac('sha1', config.turnStaticAuthSecret).update(username).digest('base64');
    iceServers.push({ urls: config.turnUrls, username, credential });
  }
  return { iceServers, ttlSeconds, relayPolicyRecommended: false };
}

interface RTCIceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function isGridWebSocketPath(url: string | undefined): boolean {
  return url === '/ws' || url === '/ws/' || url === '/ws/grid' || url === '/ws/grid/';
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  return allowedOrigins.length === 0 || (origin !== undefined && allowedOrigins.includes(origin));
}

class MinimalWebSocketConnection implements MutableGatewayPeerConnection {
  peerId?: PeerId;
  sessionId?: SessionId;
  lastSeenAt = Date.now();
  onText?: (text: string) => void;
  onClose?: () => void;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on('data', chunk => this.handleData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', () => this.handleClose());
  }

  send(data: string): void {
    if (this.closed) return;
    const payload = Buffer.from(data, 'utf8');
    const header = createFrameHeader(payload.length, 0x1);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000, reason = 'closed'): void {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(Buffer.concat([createFrameHeader(payload.length, 0x8), payload]));
    this.socket.end();
    this.handleClose();
  }

  private handleData(chunk: Buffer): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 2) {
        const frame = readFrame(this.buffer);
        if (!frame) return;
        this.buffer = this.buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) { this.close(); return; }
        if (frame.opcode === 0x9) { this.socket.write(Buffer.concat([createFrameHeader(frame.payload.length, 0xA), frame.payload])); continue; }
        if (frame.opcode === 0x1) this.onText?.(frame.payload.toString('utf8'));
      }
    } catch {
      this.close(1002, 'protocol error');
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

function acceptWebSocket(request: IncomingMessage, socket: Socket): MinimalWebSocketConnection {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return new MinimalWebSocketConnection(socket);
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));
  return new MinimalWebSocketConnection(socket);
}

function createFrameHeader(length: number, opcode: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const bigLength = buffer.readBigUInt64BE(2);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
    length = Number(bigLength);
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, consumed: offset + length };
}
