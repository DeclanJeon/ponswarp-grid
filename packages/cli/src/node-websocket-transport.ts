import { createHash } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { BinaryFrame, PeerId, Transport, TransportMessage, TransportMessageHandler, BinaryFrameHandler, Unsubscribe } from '@ponswarp/core';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_RAW_HANDSHAKE_BYTES = 16 * 1024;
const MAX_FRAME_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_RAW_FRAME_OVERHEAD_BYTES = 14;
const MAX_PENDING_RECEIVE_BYTES = MAX_FRAME_PAYLOAD_BYTES + MAX_RAW_FRAME_OVERHEAD_BYTES;
const MAX_OUTBOUND_QUEUE_BYTES = MAX_FRAME_PAYLOAD_BYTES + MAX_RAW_FRAME_OVERHEAD_BYTES;
const MAX_FRAME_PAYLOAD_BIGINT = BigInt(MAX_FRAME_PAYLOAD_BYTES);

export interface PeerEndpoint {
  peerId: PeerId;
  url: string;
}

export class NodePeerEndpointRegistry {
  private readonly endpoints = new Map<PeerId, string>();

  set(endpoint: PeerEndpoint): void {
    this.endpoints.set(endpoint.peerId, endpoint.url);
  }

  get(peerId: PeerId): string | undefined {
    return this.endpoints.get(peerId);
  }

  list(): PeerEndpoint[] {
    return [...this.endpoints].map(([peerId, url]) => ({ peerId, url }));
  }
}

interface SocketConnection {
  kind: 'socket';
  socket: Socket;
  open: boolean;
  writeQueue: Promise<void>;
  queuedBytes: number;
}

interface WebSocketConnection {
  kind: 'websocket';
  socket: WebSocket;
  writeQueue: Promise<void>;
  queuedBytes: number;
  pendingSends: Set<{ bytes: number; released: boolean }>;
}

type PeerConnection = SocketConnection | WebSocketConnection;

export interface TlsOptions {
  cert: string;
  key: string;
  ca?: string;
}

export interface NodeWebSocketTransportOptions {
  selfId: PeerId;
  host?: string;
  port?: number;
  registry?: NodePeerEndpointRegistry;
  tls?: TlsOptions;
}

export class NodeWebSocketTransport implements Transport {
  private readonly selfId: PeerId;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly registry: NodePeerEndpointRegistry;
  private readonly options: NodeWebSocketTransportOptions;
  private readonly messageHandlers = new Set<TransportMessageHandler>();
  private readonly binaryHandlers = new Set<BinaryFrameHandler>();
  private readonly errorHandlers = new Set<(peerId: PeerId, error: Error) => void>();
  private readonly connections = new Map<PeerId, PeerConnection>();
  private server: HttpServer | TcpServer | null = null;
  private endpointUrl: string | null = null;

  constructor(options: NodeWebSocketTransportOptions) {
    this.options = options;
    this.selfId = options.selfId;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.registry = options.registry ?? new NodePeerEndpointRegistry();
  }

  async listen(): Promise<PeerEndpoint> {
    if (this.server) return { peerId: this.selfId, url: this.requireEndpointUrl() };
    const handler = (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(404);
      response.end('PonsWarp peer data endpoint');
    };
    const server: HttpServer | TcpServer = this.options.tls
      ? createHttpsServer({
          cert: readFileSync(this.options.tls.cert, 'utf-8'),
          key: readFileSync(this.options.tls.key, 'utf-8'),
          ca: this.options.tls.ca ? readFileSync(this.options.tls.ca, 'utf-8') : undefined
        }, handler)
      : createTcpServer(socket => this.handleRawSocket(socket));
    if (this.options.tls) server.on('upgrade', (request, socket) => this.handleUpgrade(request, socket as Socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : this.requestedPort;
    const scheme = this.options.tls ? 'wss' : 'ws';
    this.endpointUrl = `${scheme}://${this.host}:${port}/peer/${encodeURIComponent(this.selfId)}`;
    this.registry.set({ peerId: this.selfId, url: this.endpointUrl });
    return { peerId: this.selfId, url: this.endpointUrl };
  }

  registerEndpoint(endpoint: PeerEndpoint): void {
    this.registry.set(endpoint);
  }

  async connect(peerId: PeerId): Promise<void> {
    const existing = this.connections.get(peerId);
    if (existing && isConnectionOpen(existing)) return;
    const endpoint = this.registry.get(peerId);
    if (!endpoint) throw new Error(`No endpoint registered for peer ${peerId}`);
    const separator = endpoint.includes('?') ? '&' : '?';
    const socket = new WebSocket(`${endpoint}${separator}from=${encodeURIComponent(this.selfId)}`);
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      const onOpen = (): void => { cleanup(); resolve(); };
      const onError = (): void => { cleanup(); reject(new Error(`Failed to connect to peer ${peerId}`)); };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
    socket.addEventListener('message', event => { void this.handleWebSocketMessage(peerId, event.data); });
    const connection: WebSocketConnection = {
      kind: 'websocket',
      socket,
      writeQueue: Promise.resolve(),
      queuedBytes: 0,
      pendingSends: new Set()
    };
    socket.addEventListener('close', () => {
      releaseWebSocketQueue(connection);
      if (this.connections.get(peerId) === connection) this.connections.delete(peerId);
    });
    this.connections.set(peerId, connection);
  }

  async send(peerId: PeerId, message: TransportMessage): Promise<void> {
    await this.sendRaw(peerId, JSON.stringify(message), 'text');
  }

  async sendBinary(peerId: PeerId, frame: BinaryFrame): Promise<void> {
    await this.sendRaw(peerId, toUint8Array(frame), 'binary');
  }

  onMessage(handler: TransportMessageHandler): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onBinary(handler: BinaryFrameHandler): Unsubscribe {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  async close(peerId?: PeerId): Promise<void> {
    if (peerId) {
      const connection = this.connections.get(peerId);
      if (connection) closeConnection(connection);
      this.connections.delete(peerId);
      return;
    }
    for (const connection of this.connections.values()) closeConnection(connection);
    this.connections.clear();
    if (this.server) {
      await new Promise<void>(resolve => this.server?.close(() => resolve()));
      this.server = null;
      this.endpointUrl = null;
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket): void {
    const from = readPeerIdFromRequest(request);
    const key = request.headers['sec-websocket-key'];
    if (!from || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    this.acceptSocketConnection(from, key, socket);
  }

  private handleRawSocket(socket: Socket): void {
    let pending = Buffer.alloc(0);
    const onHandshakeData = (chunk: Buffer): void => {
      const delimiter = chunk.indexOf('\r\n\r\n');
      const handshakeBytes = delimiter === -1
        ? pending.byteLength + chunk.byteLength
        : pending.byteLength + delimiter + 4;
      if (handshakeBytes > MAX_RAW_HANDSHAKE_BYTES ||
          pending.byteLength > MAX_PENDING_RECEIVE_BYTES ||
          chunk.byteLength > MAX_PENDING_RECEIVE_BYTES - pending.byteLength) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const headerEnd = pending.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      socket.removeListener('data', onHandshakeData);
      const handshake = parseRawUpgradeRequest(pending.subarray(0, headerEnd).toString('utf8'));
      if (!handshake.from || !handshake.key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      this.acceptSocketConnection(handshake.from, handshake.key, socket, pending.subarray(headerEnd + 4));
    };
    socket.on('data', onHandshakeData);
    socket.on('error', () => socket.destroy());
  }

  private acceptSocketConnection(from: PeerId, key: string, socket: Socket, initialData = Buffer.alloc(0)): void {
    if (initialData.byteLength > MAX_PENDING_RECEIVE_BYTES) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'));
    const connection: SocketConnection = {
      kind: 'socket',
      socket,
      open: true,
      writeQueue: Promise.resolve(),
      queuedBytes: 0
    };
    this.connections.set(from, connection);
    let pending = Buffer.from(initialData);
    let fragmentedOpcode: number | undefined;
    let fragmentedPayload: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const parsePending = (): void => {
      const parsed = parseFrames(pending);
      pending = Buffer.from(parsed.remaining);
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x0) {
          if (fragmentedOpcode === undefined) throw new Error('Unexpected WebSocket continuation frame');
          fragmentedPayload = Buffer.concat([fragmentedPayload, frame.payload]);
          if (fragmentedPayload.byteLength > MAX_FRAME_PAYLOAD_BYTES) throw new Error('WebSocket message payload too large');
          if (frame.fin) {
            this.dispatchFrame(from, fragmentedOpcode, fragmentedPayload);
            fragmentedOpcode = undefined;
            fragmentedPayload = Buffer.alloc(0);
          }
        } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          if (fragmentedOpcode !== undefined) throw new Error('WebSocket fragment already in progress');
          if (frame.fin) this.dispatchFrame(from, frame.opcode, frame.payload);
          else {
            fragmentedOpcode = frame.opcode;
            fragmentedPayload = frame.payload;
          }
        } else {
          this.dispatchFrame(from, frame.opcode, frame.payload);
        }
      }
    };
    socket.on('data', chunk => {
      try {
        if (pending.byteLength > MAX_PENDING_RECEIVE_BYTES || chunk.byteLength > MAX_PENDING_RECEIVE_BYTES - pending.byteLength) {
          throw new Error('WebSocket receive buffer too large');
        }
        pending = Buffer.concat([pending, chunk]);
        parsePending();
      } catch (error) {
        pending = Buffer.alloc(0);
        this.reportError(from, toError(error));
        void this.close(from);
      }
    });
    if (pending.byteLength > 0) {
      try {
        parsePending();
      } catch (error) {
        pending = Buffer.alloc(0);
        this.reportError(from, toError(error));
        void this.close(from);
      }
    }
    socket.on('close', () => {
      connection.open = false;
      if (this.connections.get(from) === connection) this.connections.delete(from);
    });
    socket.on('error', error => {
      connection.open = false;
      this.reportError(from, error);
      if (this.connections.get(from) === connection) this.connections.delete(from);
    });
  }

  private async sendRaw(peerId: PeerId, payload: string | Uint8Array, type: 'text' | 'binary'): Promise<void> {
    const connection = this.connections.get(peerId);
    if (!connection || !isConnectionOpen(connection)) throw new Error(`Peer ${peerId} is not connected`);
    if (connection.kind === 'websocket') {
      const payloadBytes = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.byteLength;
      const queuedBytes = payloadBytes + MAX_RAW_FRAME_OVERHEAD_BYTES;
      if (payloadBytes > MAX_FRAME_PAYLOAD_BYTES || connection.queuedBytes + queuedBytes > MAX_OUTBOUND_QUEUE_BYTES) {
        const error = new Error('WebSocket outbound queue too large');
        this.reportError(peerId, error);
        throw error;
      }
      const reservation = { bytes: queuedBytes, released: false };
      connection.queuedBytes += queuedBytes;
      connection.pendingSends.add(reservation);
      const write = connection.writeQueue.then(() => {
        if (!isConnectionOpen(connection)) throw new Error('Peer WebSocket is not connected');
        connection.socket.send(payload);
      });
      connection.writeQueue = write.catch(() => undefined);
      try {
        await write;
      } catch (error) {
        this.reportError(peerId, toError(error));
        throw error;
      } finally {
        releaseWebSocketSend(connection, reservation);
      }
      return;
    }
    const frame = encodeFrame(type === 'text' ? 0x1 : 0x2, typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload));
    if (frame.byteLength > MAX_OUTBOUND_QUEUE_BYTES || connection.queuedBytes + frame.byteLength > MAX_OUTBOUND_QUEUE_BYTES) {
      const error = new Error('WebSocket outbound queue too large');
      this.reportError(peerId, error);
      throw error;
    }
    connection.queuedBytes += frame.byteLength;
    const write = connection.writeQueue.then(() => writeSocketFrame(connection, frame));
    connection.writeQueue = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      this.reportError(peerId, toError(error));
      void this.close(peerId);
      throw error;
    } finally {
      connection.queuedBytes -= frame.byteLength;
    }
  }

  private async handleWebSocketMessage(peerId: PeerId, data: unknown): Promise<void> {
    if (typeof data === 'string') {
      this.dispatchText(peerId, data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.dispatchBinary(peerId, data);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.dispatchBinary(peerId, toOwnedArrayBuffer(toUint8Array(data)));
      return;
    }
    if (data instanceof Blob) {
      this.dispatchBinary(peerId, await data.arrayBuffer());
    }
  }


  private dispatchFrame(peerId: PeerId, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      void this.close(peerId);
      return;
    }
    if (opcode === 0x1) this.dispatchText(peerId, payload.toString('utf8'));
    if (opcode === 0x2) this.dispatchBinary(peerId, toOwnedArrayBuffer(toUint8Array(payload)));
  }

  private dispatchText(peerId: PeerId, text: string): void {
    try {
      const message = JSON.parse(text) as TransportMessage;
      this.messageHandlers.forEach(handler => handler(peerId, message));
    } catch (error) {
      this.reportError(peerId, toError(error));
      void this.close(peerId);
    }
  }

  private dispatchBinary(peerId: PeerId, frame: ArrayBuffer): void {
    this.binaryHandlers.forEach(handler => handler(peerId, frame));
  }
  private reportError(peerId: PeerId, error: Error): void {
    this.errorHandlers.forEach(handler => handler(peerId, error));
  }

  onError(handler: (peerId: PeerId, error: Error) => void): Unsubscribe {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  private requireEndpointUrl(): string {
    if (!this.endpointUrl) throw new Error('NodeWebSocketTransport.listen() must be called first');
    return this.endpointUrl;
  }
}
async function writeSocketFrame(connection: SocketConnection, frame: Buffer): Promise<void> {
  if (!connection.open || connection.socket.destroyed) throw new Error('Peer socket is not connected');
  if (connection.socket.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const socket = connection.socket;
    const cleanup = (): void => {
      socket.removeListener('drain', onDrain);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error('Peer socket closed while writing')); };
    socket.once('drain', onDrain);
    socket.once('error', onError);
    socket.once('close', onClose);
    if (socket.destroyed || !connection.open) onClose();
  });
}

function parseRawUpgradeRequest(header: string): { from?: PeerId; key?: string } {
  const [requestLine = '', ...lines] = header.split('\r\n');
  const [, target = '/'] = requestLine.split(' ');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const host = headers.get('host') ?? '127.0.0.1';
  const url = new URL(target, `http://${host}`);
  const from = url.searchParams.get('from') as PeerId | null;
  return { from: from ?? undefined, key: headers.get('sec-websocket-key') };
}

function readPeerIdFromRequest(request: IncomingMessage): PeerId | undefined {
  const host = request.headers.host ?? '127.0.0.1';
  const url = new URL(request.url ?? '/', `http://${host}`);
  const from = url.searchParams.get('from');
  return from ? from as PeerId : undefined;
}

function parseFrames(buffer: Buffer): { frames: Array<{ opcode: number; fin: boolean; payload: Buffer }>; remaining: Buffer } {
  const frames: Array<{ opcode: number; fin: boolean; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > MAX_FRAME_PAYLOAD_BIGINT) throw new Error('WebSocket frame payload too large');
      length = Number(big);
      headerLength = 10;
    }
    if (length > MAX_FRAME_PAYLOAD_BYTES) throw new Error('WebSocket frame payload too large');
    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : undefined;
    const payload = Buffer.from(buffer.subarray(offset + headerLength + maskLength, frameEnd));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    frames.push({ fin, opcode, payload });
    offset = frameEnd;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function isConnectionOpen(connection: PeerConnection): boolean {
  if (connection.kind === 'socket') return connection.open && !connection.socket.destroyed;
  return connection.socket.readyState === WebSocket.OPEN;
}

function closeConnection(connection: PeerConnection): void {
  if (connection.kind === 'socket') {
    connection.open = false;
    connection.socket.destroy();
    return;
  }
  releaseWebSocketQueue(connection);
  connection.socket.close();
}

function releaseWebSocketSend(
  connection: WebSocketConnection,
  reservation: { bytes: number; released: boolean }
): void {
  if (reservation.released) return;
  reservation.released = true;
  connection.pendingSends.delete(reservation);
  connection.queuedBytes -= reservation.bytes;
}

function releaseWebSocketQueue(connection: WebSocketConnection): void {
  for (const reservation of connection.pendingSends) releaseWebSocketSend(connection, reservation);
}

function toUint8Array(frame: BinaryFrame): Uint8Array {
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
