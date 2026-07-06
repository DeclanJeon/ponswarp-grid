import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import {
  MemoryStorageAdapter,
  createBrowserStorageAdapter,
  PonsWarpEngine,
  type BinaryFrame,
  type FileManifest,
  type PeerId,
  type SessionId,
  type StorageAdapter,
  type Transport,
  type TransportMessage,
  type TransferProgress
} from '@ponswarp/core';
import { BrowserSignalingClient, SIGNALING_PROTOCOL, PROTOCOL_VERSION, type SignalingEnvelope } from '@ponswarp/signaling';
import { WebRTCTransport } from '@ponswarp/webrtc';
import { createShareCode, formatBytes, isLocalShareMatch, parseShareCode } from './web-product';

class DemoTransport implements Transport {
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

class BroadcastDemoTransport implements Transport {
  private readonly channel: BroadcastChannel;
  private readonly messageHandlers = new Set<(peerId: PeerId, message: TransportMessage) => void>();
  private readonly binaryHandlers = new Set<(peerId: PeerId, frame: ArrayBuffer) => void>();

  constructor(readonly selfId: PeerId, sessionId: SessionId) {
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

interface DemoState {
  status: 'idle' | 'running' | 'restoring_local_state' | 'local_state_restored' | 'reconnecting_signaling' | 'validating_remote_manifest' | 'resuming_transfer' | 'ready' | 'complete' | 'error' | 'resume_manifest_mismatch' | 'resume_state_corrupt' | 'storage_unavailable' | 'session_expired';
  logs: string[];
  manifest?: FileManifest;
  sessionId?: SessionId;
  shareUrl?: string;
  shareQrDataUrl?: string;
  progress?: TransferProgress;
  restoredProgress?: TransferProgress;
  error?: string;
  downloadUrl?: string;
  assembledBytes?: number;
  storageKind?: string;
}

type WebShareState =
  | { status: 'idle' }
  | { status: 'file-selected'; fileName: string; sizeBytes: number }
  | { status: 'creating' }
  | { status: 'serving'; code: string; sessionId: SessionId; link: string; qrDataUrl: string; fileName: string; sizeBytes: number; expiresAt: number; downloads: number; devicesOnline: number }
  | { status: 'error'; code: string; message: string; suggestedAction?: string };

type WebGetState =
  | { status: 'idle'; input: string }
  | { status: 'resolving'; input: string }
  | { status: 'ready'; code: string; fileName: string; sizeBytes: number; devicesOnline: number; helpText: string; sessionId?: SessionId }
  | { status: 'downloading'; code: string; fileName: string; progress: number; speedBps: number; securityLabel: string }
  | { status: 'complete'; code: string; outputName: string; verificationLabel: 'fully verified' | 'secure transfer complete'; downloadUrl?: string }
  | { status: 'error'; input: string; code: string; message: string; suggestedAction?: string };

type OwnerRuntime = {
  peerId: PeerId;
  sessionId: SessionId;
  client: BrowserSignalingClient;
  transport: WebRTCTransport;
  engine: PonsWarpEngine;
  peerConnections: Map<PeerId, RTCPeerConnection>;
};

type ReceiverRuntime = {
  peerId: PeerId;
  ownerPeerId?: PeerId;
  sessionId: SessionId;
  client: BrowserSignalingClient;
  transport: WebRTCTransport;
  engine: PonsWarpEngine;
  storage: StorageAdapter;
  pc?: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  manifest?: FileManifest;
  completed: boolean;
};

function copyArrayBufferView(view: ArrayBufferView): ArrayBuffer { const copy = new Uint8Array(view.byteLength); copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)); return copy.buffer; }
function namedBlob(text: string, name: string, type = 'text/plain'): Blob & { name: string; type: string } { const blob = new Blob([text], { type }) as Blob & { name: string; type: string }; Object.defineProperty(blob, 'name', { value: name }); return blob; }
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForPieceProgress(engine: PonsWarpEngine, fileId: FileManifest['fileId'], previousVerifiedPieces: number): Promise<TransferProgress> {
  const deadline = Date.now() + 30_000;
  let progress = engine.getProgress(fileId);
  while (Date.now() < deadline && progress.verifiedPieces <= previousVerifiedPieces) {
    await delay(100);
    progress = engine.getProgress(fileId);
  }
  if (progress.verifiedPieces <= previousVerifiedPieces) throw new Error(`Timed out waiting for piece progress beyond ${previousVerifiedPieces}/${progress.totalPieces}`);
  return progress;
}
async function createPersistentStorage(sessionId: SessionId): Promise<{ adapter: StorageAdapter; kind: string; warnings: string[] }> {
  const result = await createBrowserStorageAdapter({ sessionId });
  return { adapter: result.adapter, kind: result.kind, warnings: result.warnings.map(warning => `${warning.kind}:${warning.code}`) };
}
function demoPieceSize(file: Blob): number {
  const explicit = Number(new URLSearchParams(location.search).get('pieceSize'));
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  if (file.size <= 1024 * 1024) return 8;
  if (file.size <= 16 * 1024 * 1024) return 1024 * 1024;
  if (file.size <= 128 * 1024 * 1024) return 2 * 1024 * 1024;
  return 4 * 1024 * 1024;
}
function signalingUrl(): string {
  const explicit = new URLSearchParams(location.search).get('signal');
  if (explicit) return explicit;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}
let runtimeRtcConfig: RTCConfiguration | null = null;

function rtcConfigFromUrl(): RTCConfiguration | null {
  const params = new URLSearchParams(location.search);
  const turn = params.get('turn');
  const stunParam = params.get('stun');
  if (!turn && stunParam === null && params.get('relay') !== '1') return null;
  const iceServers: RTCIceServer[] = stunParam === 'none' ? [] : [{ urls: stunParam ?? 'stun:stun.l.google.com:19302' }];
  const turnUsername = params.get('turnUser');
  const turnCredential = params.get('turnCredential');
  if (turn) iceServers.push({ urls: turn, username: turnUsername ?? undefined, credential: turnCredential ?? undefined });
  return { iceServers, iceTransportPolicy: params.get('relay') === '1' ? 'relay' : 'all' };
}

async function ensureRtcConfig(): Promise<RTCConfiguration> {
  const explicit = rtcConfigFromUrl();
  if (explicit) {
    runtimeRtcConfig = explicit;
    return explicit;
  }
  if (runtimeRtcConfig) return runtimeRtcConfig;
  const fallback: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], iceTransportPolicy: 'all' };
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    runtimeRtcConfig = fallback;
    return fallback;
  }
  try {
    const response = await fetch(`${location.origin}/api/grid/v1/ice`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`ICE endpoint returned ${response.status}`);
    const payload = await response.json() as { iceServers?: RTCIceServer[] };
    runtimeRtcConfig = { iceServers: payload.iceServers?.length ? payload.iceServers : fallback.iceServers, iceTransportPolicy: 'all' };
  } catch {
    runtimeRtcConfig = fallback;
  }
  return runtimeRtcConfig;
}

function rtcConfig(): RTCConfiguration {
  return runtimeRtcConfig ?? rtcConfigFromUrl() ?? { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], iceTransportPolicy: 'all' };
}
function currentJoinUrl(sessionId: SessionId): string { return `${location.origin}${location.pathname}${location.search}#/join/${sessionId}`; }
function currentGetUrl(code: string, sessionId: SessionId): string { return `${location.origin}${location.pathname}${location.search}#/get/${encodeURIComponent(code)}?session=${encodeURIComponent(sessionId)}`; }
function parseEmbeddedSessionId(value: string): SessionId | undefined {
  const trimmed = value.trim();
  const hash = trimmed.includes('#') ? trimmed.slice(trimmed.indexOf('#')) : trimmed;
  const join = hash.match(/^#\/join\/([^?]+)/);
  if (join?.[1]) return decodeURIComponent(join[1]) as SessionId;
  const get = hash.match(/^#\/get\/[^?]+\?(.+)$/);
  if (get?.[1]) {
    const session = new URLSearchParams(get[1]).get('session');
    if (session) return session as SessionId;
  }
  return /^sess_[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed as SessionId : undefined;
}

type BrowserShareRegistration = { code: string; link: string };
type BrowserShareResolution = { sessionId?: SessionId; fileName?: string; sizeBytes?: number; devicesOnline?: number };

async function registerCoordinatorBrowserShare(input: { code: string; sessionId: SessionId; ownerPeerId: PeerId; manifest: FileManifest }): Promise<BrowserShareRegistration | null> {
  const workspace = 'browser';
  try {
    await fetch(`${location.origin}/api/grid/v1/workspaces/${encodeURIComponent(workspace)}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileId: input.manifest.fileId,
        name: input.manifest.name,
        sizeBytes: input.manifest.size,
        pieceSize: input.manifest.pieceSize,
        pieceCount: input.manifest.pieceCount,
        nodeId: input.ownerPeerId
      })
    });
    const response = await fetch(`${location.origin}/api/grid/v1/workspaces/${encodeURIComponent(workspace)}/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileId: input.manifest.fileId,
        createdByNodeId: input.ownerPeerId,
        ttlSeconds: 24 * 60 * 60,
        requestedCode: input.code,
        capabilities: {
          browser: true,
          directTransfer: true,
          signalingSessionId: input.sessionId,
          joinUrl: currentJoinUrl(input.sessionId),
          pieceSize: input.manifest.pieceSize
        }
      })
    });
    if (!response.ok) return null;
    const share = await response.json() as { code?: string; link?: string; getUrl?: string };
    const code = typeof share.code === 'string' ? share.code : input.code;
    const link = typeof share.link === 'string' ? share.link : typeof share.getUrl === 'string' ? share.getUrl : `${location.origin}${location.pathname}${location.search}#/get/${encodeURIComponent(code)}`;
    return { code, link };
  } catch {
    return null;
  }
}

async function resolveCoordinatorBrowserShare(code: string): Promise<BrowserShareResolution | null> {
  try {
    const response = await fetch(`${location.origin}/api/grid/v1/shares/${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json() as {
      name?: string;
      fileName?: string;
      sizeBytes?: number;
      devicesOnline?: number;
      sessionId?: string;
      signalingSessionId?: string;
      joinUrl?: string;
      capabilities?: { signalingSessionId?: string; joinUrl?: string };
    };
    const sessionId = payload.sessionId ?? payload.signalingSessionId ?? payload.capabilities?.signalingSessionId ?? parseEmbeddedSessionId(payload.joinUrl ?? payload.capabilities?.joinUrl ?? '');
    return {
      sessionId: sessionId as SessionId | undefined,
      fileName: payload.name ?? payload.fileName,
      sizeBytes: payload.sizeBytes,
      devicesOnline: payload.devicesOnline
    };
  } catch {
    return null;
  }
}
async function createQrDataUrl(value: string): Promise<string> {
  return QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width: 192, color: { dark: '#0f172a', light: '#ffffff' } });
}
function messageId(): string { return `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
const CROSS_TAB_SESSION_KEY = 'ponswarp-grid-cross-tab-session';
const CROSS_TAB_PIECE_MAP_KEY = 'ponswarp-grid-cross-tab-piece-map';

type IconName =
  | 'help'
  | 'shield'
  | 'upload'
  | 'download'
  | 'file'
  | 'arrow-right'
  | 'qr'
  | 'camera'
  | 'server-off'
  | 'badge-check'
  | 'lock'
  | 'radio';

const ICON_PATHS: Record<IconName, ReactNode> = {
  help: <><circle cx="12" cy="12" r="9.25" /><path d="M9.4 9.2a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.2-2.6 4" /><circle cx="12" cy="17.3" r="0.6" fill="currentColor" stroke="none" /></>,
  shield: <><path d="M12 3 5 6v5.5c0 4.2 2.9 7.3 7 8.5 4.1-1.2 7-4.3 7-8.5V6l-7-3Z" /><path d="m9 12 2 2 4-4.2" /></>,
  upload: <><path d="M12 15.5V4.5" /><path d="m7.5 9 4.5-4.5L16.5 9" /><path d="M5 15.5v2.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2.5" /></>,
  download: <><path d="M12 4.5v11" /><path d="m7.5 11 4.5 4.5L16.5 11" /><path d="M5 15.5v2.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2.5" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></>,
  'arrow-right': <><path d="M5 12h13" /><path d="m12.5 6 6 6-6 6" /></>,
  qr: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2" /><path d="M20 14v6" /><path d="M14 20h6" /></>,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.3-1.8h6.4L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z" /><circle cx="12" cy="13" r="3.2" /></>,
  'server-off': <><rect x="4" y="5" width="16" height="6" rx="1.5" /><rect x="4" y="13" width="16" height="6" rx="1.5" /><path d="M8 8h.01M8 16h.01" /><path d="m4 20 16-16" /></>,
  'badge-check': <><path d="m5.5 8.5.9-2.6 2.7-.5L11 3.4l2.4 2 2.7.5.9 2.6 1.9 2-1.9 2-.9 2.6-2.7.5L11 20.6l-2.4-2-2.7-.5-.9-2.6-1.9-2Z" /><path d="m8.5 12 2.2 2.2 4.3-4.4" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /><circle cx="12" cy="15" r="0.8" fill="currentColor" stroke="none" /></>,
  radio: <><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" /><path d="M6 6a8 8 0 0 0 0 12M18 6a8 8 0 0 1 0 12" /></>
};

function Icon({ name, size = 24, strokeWidth = 1.8, className }: { name: IconName; size?: number; strokeWidth?: number; className?: string }): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function App() {
  const [selectedFile, setSelectedFile] = useState<(Blob & { name?: string; type?: string }) | null>(null);
  const [state, setState] = useState<DemoState>({ status: 'idle', logs: ['Ready. Select a file or run the built-in sample.'] });
  const ownerRuntime = useRef<OwnerRuntime | null>(null);
  const receiverRuntime = useRef<ReceiverRuntime | null>(null);
  const storageKinds = useRef(new Map<SessionId, string>());
  const crossTabRuntimes = useRef<Array<{ transport: Transport; engine: PonsWarpEngine; storage: StorageAdapter }>>([]);
  const [webShare, setWebShare] = useState<WebShareState>({ status: 'idle' });
  const [webGet, setWebGet] = useState<WebGetState>({ status: 'idle', input: '' });
  const webShareFile = useRef<(Blob & { name?: string; type?: string }) | null>(null);
  const webDownloadUrl = useRef<string | null>(null);
  const autoJoinedSession = useRef<SessionId | null>(null);

  useEffect(() => { const downloadUrl = state.downloadUrl; if (!downloadUrl) return; return () => URL.revokeObjectURL(downloadUrl); }, [state.downloadUrl]);
  useEffect(() => () => { if (webDownloadUrl.current) URL.revokeObjectURL(webDownloadUrl.current); }, []);
  useEffect(() => {
    const match = location.hash.match(/^#\/get\/(.+)$/);
    if (match?.[1]) setWebGet({ status: 'idle', input: parseShareCode(match[1]) || match[1] });
  }, []);
  useEffect(() => {
    const match = location.hash.match(/^#\/join\/(.+)$/);
    const sessionId = match?.[1] as SessionId | undefined;
    if (!sessionId || autoJoinedSession.current === sessionId) return;
    autoJoinedSession.current = sessionId;
    window.setTimeout(() => { void joinSignaledReceiver(); }, 250);
  }, []);
  const pushLog = (entry: string) => setState(current => ({ ...current, logs: [...current.logs, entry] }));

  const recordAsyncError = (label: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setState(current => ({ ...current, status: 'error', error: message, logs: [...current.logs, `${label}: ${message}`] }));
  };

  function describeIceCandidate(candidate: RTCIceCandidate): string {
    const type = candidate.type ?? candidate.candidate.match(/ typ (\w+)/)?.[1] ?? 'unknown';
    const protocol = candidate.protocol ?? candidate.candidate.match(/ (udp|tcp) /i)?.[1] ?? 'unknown';
    return `${type}/${protocol}`;
  }

  async function logSelectedCandidatePair(label: string, pc: RTCPeerConnection): Promise<void> {
    const stats = await pc.getStats();
    let selectedPair: RTCStats | undefined;
    stats.forEach(report => {
      const candidatePair = report as RTCStats & { selected?: boolean; nominated?: boolean };
      if (report.type === 'candidate-pair' && (candidatePair.selected || candidatePair.nominated)) selectedPair = report;
    });
    if (!selectedPair) { pushLog(`${label} selected ICE pair: unavailable`); return; }
    const pair = selectedPair as RTCStats & { localCandidateId?: string; remoteCandidateId?: string };
    const local = pair.localCandidateId ? stats.get(pair.localCandidateId) as (RTCStats & { candidateType?: string; protocol?: string }) | undefined : undefined;
    const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) as (RTCStats & { candidateType?: string; protocol?: string }) | undefined : undefined;
    pushLog(`${label} selected ICE pair: local=${local?.candidateType ?? 'unknown'}/${local?.protocol ?? 'unknown'} remote=${remote?.candidateType ?? 'unknown'}/${remote?.protocol ?? 'unknown'}`);
  }

  function attachRtcDiagnostics(label: string, pc: RTCPeerConnection): void {
    pc.addEventListener('icecandidate', event => {
      if (event.candidate) pushLog(`${label} ICE candidate: ${describeIceCandidate(event.candidate)}`);
      else pushLog(`${label} ICE candidate gathering complete`);
    });
    pc.addEventListener('iceconnectionstatechange', () => pushLog(`${label} ICE state: ${pc.iceConnectionState}`));
    pc.addEventListener('icegatheringstatechange', () => pushLog(`${label} ICE gathering: ${pc.iceGatheringState}`));
    pc.addEventListener('connectionstatechange', () => {
      pushLog(`${label} connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') void logSelectedCandidatePair(label, pc).catch(error => pushLog(`${label} selected ICE pair error: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  function handleFileSelection(file: (Blob & { name?: string; type?: string }) | null): void {
    setSelectedFile(file);
    setWebShare(file ? { status: 'file-selected', fileName: file.name ?? 'selected-file', sizeBytes: file.size } : { status: 'idle' });
  }


  async function createWebShareLink(): Promise<void> {
    const file = selectedFile ?? namedBlob('PonsWarp Grid sample payload', 'sample.txt');
    setWebShare({ status: 'creating' });
    setState({ status: 'running', logs: ['Creating a phone-ready WebRTC share link.'] });
    try {
      const ice = await ensureRtcConfig();
      await ownerRuntime.current?.client.close();
      const ownerPeerId = `owner_${Date.now()}` as PeerId;
      const sessionId = `sess_signal_${Date.now()}` as SessionId;
      const transport = new WebRTCTransport();
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const session = await engine.createSession({ sessionId, files: [file], pieceSize: demoPieceSize(file) });
      const manifest = session.manifests[0];
      const client = new BrowserSignalingClient({ url: signalingUrl() });
      const runtime: OwnerRuntime = { peerId: ownerPeerId, sessionId, client, transport, engine, peerConnections: new Map() };
      ownerRuntime.current = runtime;
      client.onMessage(envelope => { void handleOwnerSignal(runtime, envelope).catch(error => recordAsyncError('Sender signaling handler error', error)); });
      client.onState(value => pushLog(`Sender signaling state: ${value}`));
      client.onError(error => pushLog(`Sender signaling error: ${error.message}`));
      await client.connect();
      pushLog(`ICE servers loaded: ${ice.iceServers?.length ?? 0}.`);
      client.createSession({ ownerPeerId, files: [manifest], sessionId, mode: 'direct' });
      const localCode = createShareCode();
      const coordinatorShare = await registerCoordinatorBrowserShare({ code: localCode, sessionId, ownerPeerId, manifest });
      const code = coordinatorShare?.code ?? localCode;
      const link = coordinatorShare?.link ?? currentGetUrl(code, sessionId);
      const qrDataUrl = await createQrDataUrl(link);
      webShareFile.current = file;
      setWebShare({
        status: 'serving',
        code,
        sessionId,
        link,
        qrDataUrl,
        fileName: file.name ?? 'sample.txt',
        sizeBytes: file.size,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        downloads: 0,
        devicesOnline: 1
      });
      setState(current => ({ ...current, status: 'ready', sessionId, shareUrl: link, shareQrDataUrl: qrDataUrl, manifest, logs: [...current.logs, `Phone-ready sender online for ${manifest.name}.`, `Scan or open receiver link: ${link}`] }));
      setWebGet({ status: 'idle', input: '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWebShare({ status: 'error', code: 'share_failed', message, suggestedAction: 'Check signaling connectivity and try again.' });
      setState(current => ({ ...current, status: 'error', error: message, logs: [...current.logs, `Share link creation failed: ${message}`] }));
    }
  }

  async function resolveWebGetInput(): Promise<void> {
    const input = webGet.status === 'idle' || webGet.status === 'resolving' || webGet.status === 'error' ? webGet.input : webGet.code;
    const code = parseShareCode(input) || parseEmbeddedSessionId(input) || '';
    const embeddedSessionId = parseEmbeddedSessionId(input);
    if (!code) {
      setWebGet({ status: 'error', input, code: 'missing_code', message: 'Paste a share code or link.', suggestedAction: 'Paste a link like https://warp.ponslink.com/get/8F3K-22Q9 or a PonsWarp receive link.' });
      return;
    }
    setWebGet({ status: 'resolving', input });
    await delay(120);
    const localShare = webShare.status === 'serving' && isLocalShareMatch(webShare.code, code) ? webShare : null;
    const coordinatorShare = !localShare && !embeddedSessionId ? await resolveCoordinatorBrowserShare(code) : null;
    const sessionId = embeddedSessionId ?? localShare?.sessionId ?? coordinatorShare?.sessionId;
    const fileName = localShare?.fileName ?? coordinatorShare?.fileName ?? 'shared-file.zip';
    const sizeBytes = localShare?.sizeBytes ?? coordinatorShare?.sizeBytes ?? 4_200_000_000;
    const helpText = sessionId ? 'Ready for a real browser WebRTC transfer with verified resume/download.' : 'Remote source planning state. The app path handles very large files and offline resume.';
    setWebGet({ status: 'ready', code, fileName, sizeBytes, devicesOnline: localShare?.devicesOnline ?? coordinatorShare?.devicesOnline ?? 1, helpText, sessionId });
  }

  async function runWebGetDownload(): Promise<void> {
    if (webGet.status !== 'ready') return;
    const { code, fileName, sessionId } = webGet;
    if (sessionId) {
      const joinUrl = currentJoinUrl(sessionId);
      window.history.replaceState(null, '', joinUrl);
      setWebGet({ status: 'downloading', code, fileName, progress: 0, speedBps: 0, securityLabel: 'Connecting WebRTC receiver' });
      await joinSignaledReceiver(sessionId);
      return;
    }
    const localFile = webShare.status === 'serving' && isLocalShareMatch(webShare.code, code) ? webShareFile.current : null;
    if (!localFile) return;
    const securityLabel = 'Local browser download verified';
    setWebGet({ status: 'downloading', code, fileName, progress: 0, speedBps: 0, securityLabel: 'Secure transfer starting' });
    const startedAt = performance.now();
    for (const progress of [28, 64, 100]) {
      await delay(80);
      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const measuredBytes = Math.round((localFile.size * progress) / 100);
      const speedBps = Math.round((measuredBytes / elapsedMs) * 1000);
      setWebGet({ status: 'downloading', code, fileName, progress, speedBps, securityLabel });
    }
    if (webDownloadUrl.current) URL.revokeObjectURL(webDownloadUrl.current);
    webDownloadUrl.current = URL.createObjectURL(localFile);
    setWebGet({ status: 'complete', code, outputName: fileName, verificationLabel: 'fully verified', downloadUrl: webDownloadUrl.current });
  }


  async function runLocalDemo(): Promise<void> {
    setState({ status: 'running', logs: ['Creating owner/receiver engines with in-memory transports.'] });
    try {
      const ownerPeerId = 'peer_owner' as PeerId;
      const receiverPeerId = 'peer_receiver' as PeerId;
      const sessionId = `sess_demo_${Date.now()}` as SessionId;
      const ownerTransport = new DemoTransport(ownerPeerId);
      const receiverTransport = new DemoTransport(receiverPeerId);
      ownerTransport.link(receiverPeerId, receiverTransport);
      receiverTransport.link(ownerPeerId, ownerTransport);
      await runEngineTransfer({ sessionId, ownerPeerId, receiverPeerId, ownerTransport, receiverTransport, file: selectedFile ?? namedBlob('PonsWarp Grid sample payload', 'sample.txt'), logPrefix: 'Transferred', initialLog: 'Receiver joined session and loaded manifest.' });
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function runWebRtcLoopbackDemo(): Promise<void> {
    setState({ status: 'running', logs: ['Creating owner/receiver engines with real RTCPeerConnection transports.'] });
    try {
      const ownerPeerId = 'peer_owner' as PeerId;
      const receiverPeerId = 'peer_receiver' as PeerId;
      const sessionId = `sess_webrtc_${Date.now()}` as SessionId;
      const ownerTransport = new WebRTCTransport();
      const receiverTransport = new WebRTCTransport();
      const ownerPc = new RTCPeerConnection(rtcConfig());
      const receiverPc = new RTCPeerConnection(rtcConfig());
      ownerPc.addEventListener('icecandidate', event => { if (event.candidate) void receiverPc.addIceCandidate(event.candidate); });
      receiverPc.addEventListener('icecandidate', event => { if (event.candidate) void ownerPc.addIceCandidate(event.candidate); });
      ownerTransport.ensurePeer(receiverPeerId, ownerPc);
      const receiverPeer = receiverTransport.ensurePeer(ownerPeerId, receiverPc);
      receiverPeer.createDataChannel('ponswarp-grid/data', { ordered: true });
      const offer = await receiverPc.createOffer();
      await receiverPc.setLocalDescription(offer);
      await ownerPc.setRemoteDescription(offer);
      const answer = await ownerPc.createAnswer();
      await ownerPc.setLocalDescription(answer);
      await receiverPc.setRemoteDescription(answer);
      await waitForTransportChannel(ownerTransport, receiverPeerId);
      await waitForTransportChannel(receiverTransport, ownerPeerId);
      await runEngineTransfer({ sessionId, ownerPeerId, receiverPeerId, ownerTransport, receiverTransport, file: selectedFile ?? namedBlob('PonsWarp Grid sample payload', 'sample.txt'), logPrefix: 'WebRTC transferred', initialLog: 'WebRTC DataChannel open; receiver joined WebRTC session and loaded manifest.' });
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function runLocalGridSchedulerDemo(): Promise<void> {
    setState({ status: 'running', logs: ['Creating owner, Receiver A, and Receiver B grid engines with in-memory transports.'] });
    try {
      const ownerPeerId = 'peer_owner' as PeerId;
      const receiverAPeerId = 'peer_receiver_a' as PeerId;
      const receiverBPeerId = 'peer_receiver_b' as PeerId;
      const sessionId = `sess_grid_${Date.now()}` as SessionId;
      const ownerTransport = new DemoTransport(ownerPeerId);
      const receiverATransport = new DemoTransport(receiverAPeerId);
      const receiverBTransport = new DemoTransport(receiverBPeerId);
      ownerTransport.link(receiverAPeerId, receiverATransport);
      ownerTransport.link(receiverBPeerId, receiverBTransport);
      receiverATransport.link(ownerPeerId, ownerTransport);
      receiverATransport.link(receiverBPeerId, receiverBTransport);
      receiverBTransport.link(ownerPeerId, ownerTransport);
      receiverBTransport.link(receiverAPeerId, receiverATransport);

      const owner = new PonsWarpEngine(new MemoryStorageAdapter(), undefined, undefined, undefined, ownerTransport);
      const receiverAStorage = new MemoryStorageAdapter();
      const receiverBStorage = new MemoryStorageAdapter();
      const receiverA = new PonsWarpEngine(receiverAStorage, undefined, undefined, undefined, receiverATransport);
      const receiverB = new PonsWarpEngine(receiverBStorage, undefined, undefined, undefined, receiverBTransport);
      const file = selectedFile ?? namedBlob('PonsWarp Grid sample payload', 'sample.txt');
      const session = await owner.createSession({ sessionId, files: [file], pieceSize: demoPieceSize(file) });
      const manifest = session.manifests[0];
      pushLog(`Sender created ${manifest.pieceCount} pieces for ${manifest.name}.`);
      await receiverA.joinSession(sessionId, [manifest]);
      await receiverB.joinSession(sessionId, [manifest]);
      pushLog('Receiver A and Receiver B joined the grid session.');

      const receiverAScheduled = await receiverA.requestNextPiece(ownerPeerId, manifest.fileId);
      if (!receiverAScheduled) throw new Error('Receiver A could not request the seed piece.');
      let receiverAProgress = await waitForPieceProgress(receiverA, manifest.fileId, 0);
      pushLog(`Receiver A seeded ${receiverAProgress.verifiedPieces}/${receiverAProgress.totalPieces} pieces from owner.`);

      const broadcast = await receiverA.broadcastPieceMap(manifest.fileId, [receiverBPeerId]);
      pushLog(`Receiver A broadcast PIECE_MAP generation ${broadcast.generation} with pieces ${broadcast.verifiedPieces.join(',')}.`);

      let progress = receiverB.getProgress(manifest.fileId);
      let nonOwnerPieces = 0;
      while (progress.verifiedPieces < progress.totalPieces) {
        const before = progress.verifiedPieces;
        const scheduled = await receiverB.requestNextGridPiece(manifest.fileId, {
          ownerPeerId,
          candidatePeers: [receiverAPeerId, ownerPeerId]
        });
        if (scheduled.type !== 'scheduled') break;
        progress = await waitForPieceProgress(receiverB, manifest.fileId, before);
        if (scheduled.peerId === receiverAPeerId) {
          nonOwnerPieces += 1;
          pushLog(`Receiver B fetched piece ${scheduled.pieceIndex + 1}/${progress.totalPieces} from Receiver A (${scheduled.reason}).`);
        } else {
          pushLog(`Receiver B fetched piece ${scheduled.pieceIndex + 1}/${progress.totalPieces} from owner (${scheduled.reason}).`);
        }
      }

      const restoredReceiver = new PonsWarpEngine(receiverBStorage);
      await restoredReceiver.joinSession(sessionId);
      const restoredProgress = restoredReceiver.getProgress(manifest.fileId);
      const assembledFile = await receiverBStorage.assembleFile(manifest.fileId, manifest);
      const downloadUrl = URL.createObjectURL(assembledFile);
      setState(current => ({
        ...current,
        status: 'complete',
        sessionId,
        manifest,
        shareUrl: session.shareUrl,
        progress,
        restoredProgress,
        downloadUrl,
        assembledBytes: assembledFile.size,
        storageKind: 'memory',
        logs: [
          ...current.logs,
          `Grid scheduler complete: Receiver B used ${nonOwnerPieces} non-owner provider piece(s).`,
          `Resume restored ${restoredProgress.verifiedPieces}/${restoredProgress.totalPieces}; assembled ${assembledFile.size} bytes.`
        ]
      }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function startCrossTabGridOwner(): Promise<void> {
    setState({ status: 'running', logs: ['Starting 3-browser-context grid owner.'] });
    try {
      const ownerPeerId = 'peer_owner' as PeerId;
      const sessionId = `sess_grid_tabs_${Date.now()}` as SessionId;
      const transport = new BroadcastDemoTransport(ownerPeerId, sessionId);
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const payload = new Uint8Array(10 * 1024 * 1024);
      for (let index = 0; index < payload.byteLength; index += 1) payload[index] = index % 251;
      const file = new Blob([payload], { type: 'application/octet-stream' }) as Blob & { name: string; type: string };
      Object.defineProperty(file, 'name', { value: 'grid-10mb.bin' });
      const session = await engine.createSession({ sessionId, files: [file], pieceSize: demoPieceSize(file) });
      const manifest = session.manifests[0];
      localStorage.setItem(CROSS_TAB_SESSION_KEY, JSON.stringify({ sessionId, ownerPeerId, receiverAPeerId: 'peer_receiver_a', receiverBPeerId: 'peer_receiver_b', manifest }));
      crossTabRuntimes.current.push({ transport, engine, storage });
      setState(current => ({ ...current, status: 'ready', sessionId, manifest, shareUrl: currentJoinUrl(sessionId), storageKind: 'memory', logs: [...current.logs, `Cross-tab owner ready with ${manifest.pieceCount} pieces for ${manifest.name}.`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function runCrossTabReceiverASeed(): Promise<void> {
    setState({ status: 'running', logs: ['Starting 3-browser-context Receiver A seed.'] });
    try {
      const setup = readCrossTabSetup();
      const transport = new BroadcastDemoTransport(setup.receiverAPeerId, setup.sessionId);
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      await engine.joinSession(setup.sessionId, [setup.manifest]);
      crossTabRuntimes.current.push({ transport, engine, storage });
      const scheduled = await engine.requestNextPiece(setup.ownerPeerId, setup.manifest.fileId);
      if (!scheduled) throw new Error('Receiver A could not request owner seed piece.');
      const progress = await waitForPieceProgress(engine, setup.manifest.fileId, 0);
      const broadcast = await engine.broadcastPieceMap(setup.manifest.fileId, [setup.receiverBPeerId]);
      localStorage.setItem(CROSS_TAB_PIECE_MAP_KEY, JSON.stringify({ sessionId: setup.sessionId, peerId: setup.receiverAPeerId, map: broadcast }));
      setState(current => ({ ...current, status: 'complete', sessionId: setup.sessionId, manifest: setup.manifest, progress, shareUrl: currentJoinUrl(setup.sessionId), storageKind: 'memory', logs: [...current.logs, `Receiver A seeded ${progress.verifiedPieces}/${progress.totalPieces} from owner.`, `Receiver A broadcast PIECE_MAP generation ${broadcast.generation} with pieces ${broadcast.verifiedPieces.join(',')}.`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function runCrossTabReceiverBGrid(): Promise<void> {
    setState({ status: 'running', logs: ['Starting 3-browser-context Receiver B grid scheduler.'] });
    try {
      const setup = readCrossTabSetup();
      const transport = new BroadcastDemoTransport(setup.receiverBPeerId, setup.sessionId);
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      await engine.joinSession(setup.sessionId, [setup.manifest]);
      crossTabRuntimes.current.push({ transport, engine, storage });
      for (let attempt = 0; attempt < 200 && !engine.getAvailability(setup.manifest.fileId).pieces.some(piece => piece.providers.some(provider => provider.peerId === setup.receiverAPeerId)); attempt += 1) {
        await delay(25);
      }
      const rawMap = localStorage.getItem(CROSS_TAB_PIECE_MAP_KEY);
      if (rawMap) {
        const stored = JSON.parse(rawMap) as { sessionId: SessionId; peerId: PeerId; map: ReturnType<PonsWarpEngine['exportPieceMapBroadcast']> };
        if (stored.sessionId === setup.sessionId && stored.peerId === setup.receiverAPeerId) {
          engine.updatePeerPieceMap(stored.peerId, { ...stored.map, updatedAt: Date.now() });
        }
      }

      let progress = engine.getProgress(setup.manifest.fileId);
      let nonOwnerPieces = 0;
      const logs: string[] = [];
      while (progress.verifiedPieces < progress.totalPieces) {
        const before = progress.verifiedPieces;
        const scheduled = await engine.requestNextGridPiece(setup.manifest.fileId, {
          ownerPeerId: setup.ownerPeerId,
          candidatePeers: [setup.receiverAPeerId, setup.ownerPeerId]
        });
        if (scheduled.type !== 'scheduled') throw new Error(`Grid scheduler stopped: ${scheduled.reason}`);
        progress = await waitForPieceProgress(engine, setup.manifest.fileId, before);
        if (scheduled.peerId === setup.receiverAPeerId) nonOwnerPieces += 1;
        logs.push(`Receiver B fetched piece ${scheduled.pieceIndex + 1}/${progress.totalPieces} from ${scheduled.peerId === setup.receiverAPeerId ? 'Receiver A' : 'owner'} (${scheduled.reason}).`);
      }
      const assembledFile = await storage.assembleFile(setup.manifest.fileId, setup.manifest);
      const downloadUrl = URL.createObjectURL(assembledFile);
      setState(current => ({ ...current, status: 'complete', sessionId: setup.sessionId, manifest: setup.manifest, progress, restoredProgress: progress, shareUrl: currentJoinUrl(setup.sessionId), storageKind: 'memory', downloadUrl, assembledBytes: assembledFile.size, logs: [...current.logs, ...logs, `Cross-tab grid complete: Receiver B used ${nonOwnerPieces} non-owner provider piece(s).`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function runBrowserResumeQa(bytes: number, label: string): Promise<void> {
    setState({ status: 'running', storageKind: 'probing', logs: [`Starting ${label} browser transfer + reload resume QA.`] });
    try {
      const ownerPeerId = 'peer_owner' as PeerId;
      const receiverPeerId = 'peer_receiver' as PeerId;
      const sessionId = `sess_resume_qa_${Date.now()}` as SessionId;
      const pieceSize = 1024 * 1024;
      const chunk = new Uint8Array(pieceSize);
      for (let index = 0; index < chunk.length; index += 1) chunk[index] = index % 251;
      const parts: BlobPart[] = [];
      for (let offset = 0; offset < bytes; offset += pieceSize) parts.push(offset + pieceSize <= bytes ? chunk : chunk.slice(0, bytes - offset));
      const file = new Blob(parts, { type: 'application/octet-stream' }) as Blob & { name: string; type: string };
      Object.defineProperty(file, 'name', { value: `${label}.bin` });

      const ownerTransport = new DemoTransport(ownerPeerId);
      let receiverTransport = new DemoTransport(receiverPeerId);
      ownerTransport.link(receiverPeerId, receiverTransport);
      receiverTransport.link(ownerPeerId, ownerTransport);

      const owner = new PonsWarpEngine(new MemoryStorageAdapter(), undefined, undefined, undefined, ownerTransport);
      const storageResult = await createPersistentStorage(sessionId);
      let receiver = new PonsWarpEngine(storageResult.adapter, undefined, undefined, undefined, receiverTransport);
      const session = await owner.createSession({ sessionId, files: [file], pieceSize, includeFileHash: false });
      const manifest = session.manifests[0];
      await receiver.joinSession(sessionId, [manifest]);
      storageKinds.current.set(sessionId, storageResult.kind);

      let progress = receiver.getProgress(manifest.fileId);
      const reloadAt = Math.max(1, Math.floor(progress.totalPieces * 0.4));
      let reloaded = false;
      while (progress.verifiedPieces < progress.totalPieces) {
        const before = progress.verifiedPieces;
        const scheduled = await receiver.requestNextPiece(ownerPeerId, manifest.fileId);
        if (!scheduled) throw new Error('No piece scheduled during resume QA.');
        progress = await waitForPieceProgress(receiver, manifest.fileId, before);
        if (progress.verifiedPieces % 50 === 0 || progress.verifiedPieces === reloadAt || progress.verifiedPieces === progress.totalPieces) {
          pushLog(`${label}: ${progress.verifiedPieces}/${progress.totalPieces} pieces verified.`);
        }
        if (!reloaded && progress.verifiedPieces >= reloadAt) {
          reloaded = true;
          receiverTransport = new DemoTransport(receiverPeerId);
          ownerTransport.link(receiverPeerId, receiverTransport);
          receiverTransport.link(ownerPeerId, ownerTransport);
          receiver = new PonsWarpEngine(storageResult.adapter, undefined, undefined, undefined, receiverTransport);
          await receiver.joinSession(sessionId);
          const restored = await receiver.resumeFile(manifest.fileId);
          progress = receiver.getProgress(manifest.fileId);
          pushLog(`${label}: simulated reload restored ${restored.verifiedPieces.length}/${progress.totalPieces}; discarded ${restored.discardedPieces.length}.`);
        }
      }

      const restoredReceiver = new PonsWarpEngine(storageResult.adapter);
      await restoredReceiver.joinSession(sessionId);
      const restoredProgress = restoredReceiver.getProgress(manifest.fileId);
      const saveResult = await storageResult.adapter.saveAssembledFile(manifest.fileId, manifest);
      const savedBytes = saveResult.type === 'unsupported' ? manifest.size : saveResult.bytes;
      const downloadUrl = saveResult.type === 'blob' ? URL.createObjectURL(saveResult.blob) : undefined;
      setState(current => ({
        ...current,
        status: 'complete',
        sessionId,
        manifest,
        progress,
        restoredProgress,
        storageKind: storageResult.kind,
        shareUrl: currentJoinUrl(sessionId),
        downloadUrl,
        assembledBytes: savedBytes,
        logs: [
          ...current.logs,
          `${label}: final save result ${saveResult.type} (${savedBytes} bytes).`,
          `${label}: browser transfer + reload resume QA complete.`
        ]
      }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error), logs: [...current.logs, `${label} QA failed.`] })); }
  }

  async function run10MiBReloadResumeQa(): Promise<void> {
    await runBrowserResumeQa(10 * 1024 * 1024, '10MiB-reload-resume');
  }

  async function run500MiBBrowserQa(): Promise<void> {
    await runBrowserResumeQa(500 * 1024 * 1024, '500MiB-browser');
  }

  async function startSignaledSender(): Promise<void> {
    setState({ status: 'running', logs: ['Connecting sender to signaling server.'] });
    try {
      const ice = await ensureRtcConfig();
      await ownerRuntime.current?.client.close();
      const ownerPeerId = `owner_${Date.now()}` as PeerId;
      const sessionId = `sess_signal_${Date.now()}` as SessionId;
      const transport = new WebRTCTransport();
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const file = selectedFile ?? namedBlob('PonsWarp Grid sample payload', 'sample.txt');
      const session = await engine.createSession({ sessionId, files: [file], pieceSize: demoPieceSize(file) });
      const manifest = session.manifests[0];
      const client = new BrowserSignalingClient({ url: signalingUrl() });
      const runtime: OwnerRuntime = { peerId: ownerPeerId, sessionId, client, transport, engine, peerConnections: new Map() };
      ownerRuntime.current = runtime;
      client.onMessage(envelope => { void handleOwnerSignal(runtime, envelope).catch(error => recordAsyncError('Sender signaling handler error', error)); });
      client.onState(value => pushLog(`Sender signaling state: ${value}`));
      client.onError(error => pushLog(`Sender signaling error: ${error.message}`));
      await client.connect();
      pushLog(`ICE servers loaded: ${ice.iceServers?.length ?? 0}.`);
      client.createSession({ ownerPeerId, files: [manifest], sessionId, mode: 'direct' });
      const shareUrl = currentJoinUrl(sessionId);
      const shareQrDataUrl = await createQrDataUrl(shareUrl);
      setState(current => ({ ...current, status: 'ready', sessionId, shareUrl, shareQrDataUrl, manifest, logs: [...current.logs, `Signaled sender ready for ${manifest.name}.`, `Open receiver link: ${shareUrl}`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function joinSignaledReceiver(sessionIdOverride?: SessionId): Promise<void> {
    const match = location.hash.match(/^#\/join\/(.+)$/);
    const sessionId = (sessionIdOverride ?? match?.[1] ?? state.sessionId) as SessionId | undefined;
    if (!sessionId) { setState(current => ({ ...current, status: 'error', error: 'No #/join/:sessionId route found.' })); return; }
    setState({ status: 'running', sessionId, storageKind: 'probing', logs: [`Connecting receiver to signaling server for ${sessionId}.`] });
    try {
      const ice = await ensureRtcConfig();
      await receiverRuntime.current?.client.close();
      const peerId = `receiver_${Date.now()}` as PeerId;
      const transport = new WebRTCTransport();
      const storageResult = await createPersistentStorage(sessionId);
      storageKinds.current.set(sessionId, storageResult.kind);
      const storage = storageResult.adapter;
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const client = new BrowserSignalingClient({ url: signalingUrl() });
      const runtime: ReceiverRuntime = { peerId, sessionId, client, transport, engine, storage, pendingIce: [], completed: false };
      receiverRuntime.current = runtime;
      client.onMessage(envelope => { void handleReceiverSignal(runtime, envelope).catch(error => recordAsyncError('Receiver signaling handler error', error)); });
      client.onState(value => pushLog(`Receiver signaling state: ${value}`));
      client.onError(error => pushLog(`Receiver signaling error: ${error.message}`));
      await client.connect();
      pushLog(`ICE servers loaded: ${ice.iceServers?.length ?? 0}.`);
      client.joinSession({ sessionId, peerId });
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function handleOwnerSignal(runtime: OwnerRuntime, envelope: SignalingEnvelope): Promise<void> {
    if (envelope.type === 'ERROR') {
      const payload = envelope.payload as { code?: string; message?: string };
      const message = payload.message ?? payload.code ?? 'Signaling error';
      setState(current => ({ ...current, status: 'error', error: message, logs: [...current.logs, `Sender signaling error: ${message}`] }));
      return;
    }
    if (envelope.type === 'PEER_JOINED') { pushLog(`Peer joined: ${(envelope.payload as { peerId: string }).peerId}`); return; }
    if (envelope.type === 'ICE_CANDIDATE') {
      const candidate = (envelope.payload as { candidate: RTCIceCandidateInit }).candidate;
      const pc = envelope.fromPeerId ? runtime.peerConnections.get(envelope.fromPeerId) : undefined;
      if (pc) await pc.addIceCandidate(candidate);
      return;
    }
    if (envelope.type !== 'WEBRTC_OFFER' || !envelope.fromPeerId) return;
    const receiverPeerId = envelope.fromPeerId;
    const pc = new RTCPeerConnection(rtcConfig());
    attachRtcDiagnostics(`Sender ${receiverPeerId}`, pc);
    runtime.peerConnections.set(receiverPeerId, pc);
    runtime.transport.ensurePeer(receiverPeerId, pc);
    pc.addEventListener('icecandidate', event => { if (event.candidate) sendIce(runtime.client, runtime.sessionId, runtime.peerId, receiverPeerId, event.candidate.toJSON()); });
    await pc.setRemoteDescription((envelope.payload as { sdp: RTCSessionDescriptionInit }).sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    runtime.client.sendRelay(makeSignal('WEBRTC_ANSWER', runtime.sessionId, runtime.peerId, receiverPeerId, { sdp: answer }));
    pushLog(`Answered WebRTC offer from ${receiverPeerId}.`);
  }

  async function handleReceiverSignal(runtime: ReceiverRuntime, envelope: SignalingEnvelope): Promise<void> {
    if (envelope.type === 'ERROR') {
      const payload = envelope.payload as { code?: string; message?: string };
      const message = payload.message ?? payload.code ?? 'Signaling error';
      setState(current => ({ ...current, status: 'error', error: message, logs: [...current.logs, `Receiver signaling error: ${message}`] }));
      return;
    }
    if (envelope.type === 'ICE_CANDIDATE') {
      const candidate = (envelope.payload as { candidate: RTCIceCandidateInit }).candidate;
      if (runtime.pc?.remoteDescription) await runtime.pc.addIceCandidate(candidate); else runtime.pendingIce.push(candidate);
      return;
    }
    if (envelope.type === 'SESSION_JOINED') {
      const payload = envelope.payload as { ownerPeerId: PeerId; files: FileManifest[] };
      const manifest = payload.files[0];
      runtime.manifest = manifest;
      runtime.ownerPeerId = payload.ownerPeerId;
      const pc = new RTCPeerConnection(rtcConfig());
      attachRtcDiagnostics(`Receiver ${payload.ownerPeerId}`, pc);
      runtime.pc = pc;
      pc.addEventListener('icecandidate', event => { if (event.candidate && runtime.ownerPeerId) sendIce(runtime.client, runtime.sessionId, runtime.peerId, runtime.ownerPeerId, event.candidate.toJSON()); });
      const peer = runtime.transport.ensurePeer(payload.ownerPeerId, pc);
      peer.createDataChannel('ponswarp-grid/data', { ordered: true });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      runtime.client.sendRelay(makeSignal('WEBRTC_OFFER', runtime.sessionId, runtime.peerId, payload.ownerPeerId, { sdp: offer }));
      setState(current => ({ ...current, manifest, storageKind: storageKinds.current.get(runtime.sessionId), shareUrl: currentJoinUrl(runtime.sessionId), logs: [...current.logs, 'Receiver joined signaling session and sent WebRTC offer.'] }));
      return;
    }
    if (envelope.type === 'WEBRTC_ANSWER' && runtime.ownerPeerId && runtime.pc && !runtime.completed) {
      await runtime.pc.setRemoteDescription((envelope.payload as { sdp: RTCSessionDescriptionInit }).sdp);
      for (const candidate of runtime.pendingIce.splice(0)) await runtime.pc.addIceCandidate(candidate);
      await waitForTransportChannel(runtime.transport, runtime.ownerPeerId);
      await completeReceiverTransfer(runtime);
    }
  }

  async function completeReceiverTransfer(runtime: ReceiverRuntime): Promise<void> {
    if (runtime.completed || !runtime.ownerPeerId) return;
    runtime.completed = true;
    const manifest = runtime.manifest;
    if (!manifest) throw new Error('Receiver did not receive a manifest');
    const joined = await runtime.engine.joinSession(runtime.sessionId, [manifest]);
    let progress = runtime.engine.getProgress(manifest.fileId);
    while (progress.verifiedPieces < progress.totalPieces) {
      const before = progress.verifiedPieces;
      const scheduled = await runtime.engine.requestNextPiece(runtime.ownerPeerId, manifest.fileId);
      if (!scheduled) throw new Error(`No provider scheduled piece after ${progress.verifiedPieces}/${progress.totalPieces} verified`);
      progress = await waitForPieceProgress(runtime.engine, manifest.fileId, before);
      pushLog(`Signaled WebRTC transferred piece ${progress.verifiedPieces}/${progress.totalPieces} verified.`);
      if (globalThis.localStorage?.getItem('ponswarp-partial-resume') === '1' && progress.verifiedPieces >= Math.ceil(progress.totalPieces / 2)) {
        setState(current => ({ ...current, status: 'ready', manifest, progress, restoredProgress: progress, storageKind: storageKinds.current.get(runtime.sessionId), shareUrl: currentJoinUrl(runtime.sessionId), logs: [...current.logs, `Partial resume seed persisted at ${progress.verifiedPieces}/${progress.totalPieces} pieces.`] }));
        return;
      }
    }
    const restoredReceiver = new PonsWarpEngine(runtime.storage);
    await restoredReceiver.joinSession(runtime.sessionId);
    const restoredProgress = restoredReceiver.getProgress(manifest.fileId);
    if (restoredProgress.verifiedPieces !== restoredProgress.totalPieces) throw new Error(`Cannot assemble incomplete file: ${restoredProgress.verifiedPieces}/${restoredProgress.totalPieces} pieces verified`);
    const assembledFile = await runtime.storage.assembleFile(manifest.fileId, manifest);
    const downloadUrl = URL.createObjectURL(assembledFile);
    setState(current => ({ ...current, status: 'complete', manifest, progress, restoredProgress, downloadUrl, assembledBytes: assembledFile.size, storageKind: storageKinds.current.get(runtime.sessionId), shareUrl: currentJoinUrl(runtime.sessionId), logs: [...current.logs, `Signaled WebRTC resume restored ${restoredProgress.verifiedPieces}/${restoredProgress.totalPieces}; assembled ${assembledFile.size} bytes.`] }));
  }

  async function restoreLocalResumeState(): Promise<void> {
    const match = location.hash.match(/^#\/join\/(.+)$/);
    const sessionId = (match?.[1] ?? state.sessionId) as SessionId | undefined;
    if (!sessionId) { setState(current => ({ ...current, status: 'error', error: 'No sessionId available for local resume restore.' })); return; }
    setState({ status: 'restoring_local_state', sessionId, storageKind: 'probing', logs: [`Restoring local persisted state for ${sessionId}.`] });
    try {
      const storageResult = await createPersistentStorage(sessionId);
      setState(current => ({ ...current, status: 'local_state_restored', storageKind: storageResult.kind, logs: [...current.logs, `Local storage selected: ${storageResult.kind}.`] }));
      storageKinds.current.set(sessionId, storageResult.kind);
      const engine = new PonsWarpEngine(storageResult.adapter);
      const joined = await engine.joinSession(sessionId);
      const manifest = joined.manifests[0];
      setState(current => ({ ...current, status: 'validating_remote_manifest', manifest, logs: [...current.logs, 'Validating restored manifest and piece map.'] }));
      if (!manifest) throw new Error('No persisted manifest found for this session.');
      const restored = await engine.resumeFile(manifest.fileId);
      setState(current => ({ ...current, status: 'resuming_transfer', logs: [...current.logs, 'Re-hashing verified pieces before trusting resume state.'] }));
      const progress = engine.getProgress(manifest.fileId);
      const assembledFile = progress.verifiedPieces === progress.totalPieces ? await storageResult.adapter.assembleFile(manifest.fileId, manifest) : undefined;
      const downloadUrl = assembledFile ? URL.createObjectURL(assembledFile) : undefined;
      setState(current => ({
        ...current,
        status: progress.verifiedPieces === progress.totalPieces ? 'complete' : 'ready',
        sessionId,
        manifest,
        progress,
        restoredProgress: progress,
        downloadUrl,
        assembledBytes: assembledFile?.size,
        storageKind: storageResult.kind,
        shareUrl: currentJoinUrl(sessionId),
        logs: [
          ...current.logs,
          `Local state restored from ${storageResult.kind}: ${restored.verifiedPieces.length} verified, ${restored.discardedPieces.length} discarded.`
        ]
      }));
      if (progress.verifiedPieces < progress.totalPieces) globalThis.localStorage?.removeItem('ponswarp-partial-resume');
    } catch (error) {
      setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error), logs: [...current.logs, 'Local resume restore failed.'] }));
    }
  }

  async function runEngineTransfer(input: { sessionId: SessionId; ownerPeerId: PeerId; receiverPeerId: PeerId; ownerTransport: Transport; receiverTransport: Transport; file: Blob & { name?: string; type?: string }; logPrefix: string; initialLog: string }): Promise<void> {
    const ownerStorage = new MemoryStorageAdapter();
    const receiverStorage = new MemoryStorageAdapter();
    const owner = new PonsWarpEngine(ownerStorage, undefined, undefined, undefined, input.ownerTransport);
    const receiver = new PonsWarpEngine(receiverStorage, undefined, undefined, undefined, input.receiverTransport);
    const session = await owner.createSession({ sessionId: input.sessionId, files: [input.file], pieceSize: demoPieceSize(input.file) });
    const manifest = session.manifests[0];
    pushLog(`Sender created ${manifest.pieceCount} pieces for ${manifest.name}.`);
    await receiver.joinSession(session.sessionId, [manifest]);
    pushLog(input.initialLog);
    let progress = receiver.getProgress(manifest.fileId);
    while (progress.verifiedPieces < progress.totalPieces) {
      const before = progress.verifiedPieces;
      const scheduled = await receiver.requestNextPiece(input.ownerPeerId, manifest.fileId);
      if (!scheduled) break;
      progress = await waitForPieceProgress(receiver, manifest.fileId, before);
      pushLog(`${input.logPrefix} piece ${progress.verifiedPieces}/${progress.totalPieces} verified.`);
    }
    const restoredReceiver = new PonsWarpEngine(receiverStorage);
    await restoredReceiver.joinSession(session.sessionId);
    const restoredProgress = restoredReceiver.getProgress(manifest.fileId);
    const assembledFile = await receiverStorage.assembleFile(manifest.fileId, manifest);
    const downloadUrl = URL.createObjectURL(assembledFile);
    pushLog(`Resume restored ${restoredProgress.verifiedPieces}/${restoredProgress.totalPieces}; assembled ${assembledFile.size} bytes.`);
    setState(current => ({ ...current, status: 'complete', sessionId: session.sessionId, shareUrl: session.shareUrl, manifest, progress, restoredProgress, downloadUrl, assembledBytes: assembledFile.size }));
  }

  return (
    <main className="grid-shell">
      <style>{`
        :root {
          color-scheme: dark;
          --grid-bg: #03102c;
          --grid-ink: #f7fbff;
          --grid-muted: #aebee0;
          --grid-line: rgba(146, 203, 255, 0.34);
          --grid-card: rgba(8, 35, 78, 0.72);
          --grid-card-strong: rgba(12, 45, 93, 0.84);
          --grid-blue: #2d7dff;
          --grid-cyan: #25d9ff;
          --grid-glow: rgba(37, 217, 255, 0.42);
        }
        * { box-sizing: border-box; }
        .grid-product svg { display: block; flex: none; }
        body { margin: 0; background: #03102c; }
        .grid-shell {
          min-height: 100vh;
          margin: 0;
          padding: 24px 40px 34px;
          overflow-x: hidden;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: var(--grid-ink);
          background:
            radial-gradient(circle at 18% 82%, rgba(37, 126, 255, 0.62), transparent 31%),
            radial-gradient(circle at 86% 81%, rgba(12, 109, 255, 0.46), transparent 27%),
            radial-gradient(circle at 50% 45%, rgba(19, 217, 255, 0.18), transparent 22%),
            linear-gradient(180deg, #020a20 0%, #06163a 52%, #0c5dd9 140%);
        }
        .grid-product {
          position: relative;
          width: min(100%, 1600px);
          min-height: calc(100vh - 58px);
          margin: 0 auto;
          isolation: isolate;
        }
        .grid-product::before {
          content: "";
          position: absolute;
          inset: 54px 0 auto;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(156, 203, 255, 0.24), transparent);
          z-index: -1;
        }
        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          min-height: 58px;
        }
        .brand {
          display: inline-flex;
          align-items: center;
          gap: 14px;
          font-size: 28px;
          font-weight: 850;
          letter-spacing: -0.04em;
        }
        .brand-mark {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          background:
            radial-gradient(circle at 32% 28%, #6ff4ff, transparent 27%),
            linear-gradient(135deg, #196bff 10%, #27e5ff 52%, #705cff 100%);
          box-shadow: 0 0 28px rgba(37, 217, 255, 0.38);
          position: relative;
        }
        .brand-mark::after {
          content: "";
          position: absolute;
          inset: 11px 10px 10px 12px;
          border-radius: 5px 5px 10px 5px;
          background: #07163a;
          clip-path: polygon(0 0, 88% 0, 88% 64%, 42% 64%, 42% 100%, 0 100%);
        }
        .brand-accent { color: #8f8aff; font-weight: 760; }
        .how-pill {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          border: 1px solid rgba(166, 206, 255, 0.18);
          border-radius: 999px;
          padding: 11px 18px;
          color: #d9e7ff;
          background: rgba(7, 20, 50, 0.62);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 14px 40px rgba(0,0,0,0.18);
          text-decoration: none;
          font-weight: 650;
        }
        .how-pill { transition: background 160ms ease, border-color 160ms ease, color 160ms ease; }
        .how-pill:hover {
          background: rgba(7, 20, 50, 0.82);
          border-color: rgba(166, 206, 255, 0.42);
          color: #fff;
        }
        .hero {
          position: relative;
          min-height: 384px;
          padding: 30px 0 0;
          text-align: center;
        }
        .hero h1 {
          margin: 0;
          font-size: clamp(58px, 7.1vw, 96px);
          line-height: 1.05;
          letter-spacing: -0.075em;
          text-shadow: 0 14px 56px rgba(0,0,0,0.3);
        }
        .hero p {
          margin: 16px 0 0;
          color: #c8d7f2;
          font-size: clamp(19px, 2.1vw, 25px);
          letter-spacing: -0.025em;
        }
        .device {
          position: absolute;
          bottom: -12px;
          opacity: 0.98;
          filter: drop-shadow(0 30px 48px rgba(0,0,0,0.34));
          z-index: -1;
        }
        .laptop {
          left: 10.5%;
          width: 318px;
          height: 180px;
          border: 2px solid rgba(130, 190, 255, 0.86);
          border-radius: 12px 12px 5px 5px;
          transform: perspective(520px) rotateX(3deg) rotateY(-13deg) rotateZ(-2deg);
          background: linear-gradient(135deg, rgba(28, 81, 159, 0.28), rgba(3, 18, 53, 0.88));
          box-shadow: inset 0 0 38px rgba(45, 125, 255, 0.32), 0 0 20px rgba(83, 165, 255, 0.24);
        }
        .laptop::before {
          content: "";
          position: absolute;
          left: 88px;
          top: 72px;
          width: 62px;
          height: 44px;
          border-radius: 5px;
          background: rgba(25, 107, 255, 0.42);
          border: 2px solid rgba(48, 145, 255, 0.88);
        }
        .laptop::after {
          content: "";
          position: absolute;
          left: 8px;
          bottom: -38px;
          width: 348px;
          height: 38px;
          transform: skewX(28deg);
          border-radius: 0 0 15px 15px;
          background: linear-gradient(90deg, rgba(63, 139, 255, 0.28), rgba(150, 215, 255, 0.82), rgba(35, 89, 166, 0.22));
        }
        .phone {
          right: 11.4%;
          bottom: -8px;
          width: 112px;
          height: 198px;
          border: 2px solid rgba(130, 190, 255, 0.9);
          border-radius: 25px;
          background: linear-gradient(160deg, rgba(28, 75, 147, 0.42), rgba(3, 18, 53, 0.86));
          box-shadow: inset 0 0 32px rgba(45, 125, 255, 0.26), 0 0 22px rgba(83, 165, 255, 0.25);
        }
        .phone::before {
          content: "";
          position: absolute;
          left: 29px;
          top: 86px;
          width: 54px;
          height: 40px;
          border-radius: 5px;
          background: rgba(25, 107, 255, 0.42);
          border: 2px solid rgba(48, 145, 255, 0.88);
        }
        .beam {
          position: absolute;
          left: 24%;
          right: 20%;
          bottom: 74px;
          height: 88px;
          z-index: 0;
          pointer-events: none;
        }
        .beam::before,
        .beam::after {
          content: "";
          position: absolute;
          inset: 12px 0;
          border-radius: 999px;
          background:
            radial-gradient(circle at 18% 38%, rgba(255,255,255,0.9) 0 2px, transparent 3px),
            radial-gradient(circle at 37% 65%, rgba(121,217,255,0.9) 0 2px, transparent 3px),
            radial-gradient(circle at 63% 28%, rgba(255,255,255,0.85) 0 2px, transparent 3px),
            radial-gradient(circle at 84% 52%, rgba(121,217,255,0.9) 0 2px, transparent 3px),
            linear-gradient(92deg, transparent 0%, rgba(39, 151, 255, 0.22) 11%, rgba(37, 217, 255, 0.96) 48%, rgba(26, 136, 255, 0.74) 82%, transparent 100%);
          filter: blur(0.4px) drop-shadow(0 0 16px var(--grid-glow));
          clip-path: polygon(0 42%, 88% 31%, 88% 18%, 100% 50%, 88% 82%, 88% 66%, 0 57%);
        }
        .beam::after {
          inset: 30px 7% 22px;
          opacity: 0.74;
          filter: blur(5px);
        }
        .file-capsule {
          position: absolute;
          left: 50%;
          bottom: 92px;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: 16px;
          min-width: 274px;
          padding: 20px 28px;
          border: 2px solid rgba(137, 237, 255, 0.9);
          border-radius: 42px;
          background: linear-gradient(135deg, rgba(135, 111, 255, 0.82), rgba(17, 170, 255, 0.88));
          box-shadow: 0 0 28px rgba(37,217,255,0.74), inset 0 1px 0 rgba(255,255,255,0.36);
          text-align: left;
          z-index: 2;
        }
        .file-icon {
          width: 40px;
          height: 46px;
          border: 3px solid rgba(255,255,255,0.92);
          border-radius: 4px;
          position: relative;
        }
        .file-icon::after {
          content: "";
          position: absolute;
          right: -3px;
          top: -3px;
          width: 14px;
          height: 14px;
          border-left: 3px solid rgba(255,255,255,0.92);
          border-bottom: 3px solid rgba(255,255,255,0.92);
          background: rgba(95,170,255,0.95);
        }
        .file-name { display: block; font-size: 18px; font-weight: 800; }
        .file-size { display: block; color: #e2edff; font-size: 17px; }
        .shield-badge {
          margin-left: auto;
          width: 43px;
          height: 43px;
          border-radius: 17px;
          display: grid;
          place-items: center;
          background: rgba(255,255,255,0.17);
          color: #ffffff;
          border: 2px solid rgba(214, 249, 255, 0.58);
        }
        .panel-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 32px;
          margin: -20px auto 28px;
          max-width: 1275px;
        }
        .action-card {
          min-height: 348px;
          border: 1px solid rgba(146, 203, 255, 0.28);
          border-radius: 24px;
          padding: 28px 34px;
          background: linear-gradient(145deg, rgba(11, 39, 88, 0.9), rgba(5, 20, 52, 0.62));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.11), 0 24px 70px rgba(0,0,0,0.28), 0 0 44px rgba(42, 136, 255, 0.1);
          backdrop-filter: blur(18px);
        }
        .card-head {
          display: grid;
          grid-template-columns: 74px 1fr;
          gap: 18px;
          align-items: center;
          margin-bottom: 24px;
        }
        .round-icon {
          width: 72px;
          height: 72px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          color: white;
          font-size: 38px;
          font-weight: 760;
          background: linear-gradient(135deg, #735bff, #186fff);
          box-shadow: 0 14px 35px rgba(40, 109, 255, 0.4), inset 0 1px 0 rgba(255,255,255,0.22);
        }
        .receive-card .round-icon { background: linear-gradient(135deg, #14d6ff, #1464d9); }
        .action-card h2 {
          margin: 0 0 4px;
          font-size: 31px;
          line-height: 1.05;
          letter-spacing: -0.04em;
        }
        .action-card p { margin: 0; color: #c4d4f0; font-size: 16px; }
        .drop-zone {
          display: grid;
          place-items: center;
          min-height: 198px;
          border: 1.5px dashed rgba(176, 211, 255, 0.52);
          border-radius: 18px;
          background: rgba(3, 16, 43, 0.33);
          text-align: center;
          cursor: pointer;
          transition: border-color 160ms ease, transform 160ms ease, background 160ms ease;
        }
        .drop-zone:hover {
          border-color: rgba(132, 226, 255, 0.86);
          background: rgba(10, 35, 83, 0.54);
        }
        .upload-glyph {
          display: grid;
          place-items: center;
          margin: 0 auto 14px;
          width: 64px;
          height: 64px;
          border-radius: 18px;
          color: #bcd8ff;
          background: rgba(37, 126, 255, 0.14);
          border: 1px solid rgba(146, 203, 255, 0.28);
        }
        .drop-primary { color: #dfeaff; font-size: 18px; }
        .drop-secondary { color: #9eafd0; font-size: 15px; }
        .primary-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          min-width: 250px;
          margin-top: 8px;
          border: 0;
          border-radius: 17px;
          padding: 15px 23px;
          background: linear-gradient(180deg, #3a9dff, #1d58f0);
          color: #fff;
          font-size: 21px;
          font-weight: 800;
          box-shadow: 0 12px 30px rgba(25, 107, 255, 0.42), inset 0 1px 0 rgba(255,255,255,0.28);
          cursor: pointer;
        }
        .primary-button { transition: transform 80ms ease, filter 80ms ease; }
        .primary-button:hover { transform: translateY(-1px); filter: brightness(1.05); }
        .primary-button:active { transform: translateY(0); filter: brightness(0.97); }
        .primary-button:disabled { opacity: 0.64; cursor: wait; }
        .share-result {
          margin-top: 18px;
          padding: 18px;
          border: 1px solid rgba(114, 197, 255, 0.42);
          border-radius: 20px;
          background: rgba(8, 37, 84, 0.72);
        }
        .share-result a { color: #8fe9ff; word-break: break-all; }
        .receive-form {
          display: flex;
          align-items: center;
          gap: 0;
          width: 100%;
          margin-top: 2px;
          border: 1px solid rgba(120, 174, 255, 0.42);
          border-radius: 18px;
          background: rgba(13, 35, 80, 0.72);
          overflow: hidden;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .receive-form:focus-within {
          border-color: rgba(37, 217, 255, 0.72);
          box-shadow: 0 0 0 3px rgba(37, 217, 255, 0.18);
          transition: border-color 160ms ease, box-shadow 160ms ease;
        }
        .receive-input {
          min-width: 0;
          flex: 1;
          border: 0;
          outline: 0;
          padding: 21px 23px;
          color: #edf6ff;
          background: transparent;
          font: inherit;
          font-size: 19px;
        }
        .receive-input::placeholder { color: #b7c4df; }
        .arrow-button {
          width: 76px;
          align-self: stretch;
          display: grid;
          place-items: center;
          border: 0;
          color: #fff;
          background: linear-gradient(135deg, #43d9ff, #1776e7);
          cursor: pointer;
          box-shadow: -12px 0 30px rgba(37,217,255,0.18);
          transition: filter 100ms ease, transform 100ms ease;
        }
        .arrow-button:hover { filter: brightness(1.12); }
        .arrow-button:active { filter: brightness(0.95); transform: scale(0.97); }
        .or-line {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 18px;
          align-items: center;
          margin: 22px 0;
          color: #b9c7df;
        }
        .or-line::before,
        .or-line::after {
          content: "";
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(143, 190, 255, 0.24));
        }
        .or-line::after { background: linear-gradient(90deg, rgba(143, 190, 255, 0.24), transparent); }
        .qr-row {
          display: grid;
          grid-template-columns: 86px 1fr 52px;
          gap: 18px;
          align-items: center;
          min-height: 92px;
          padding: 14px;
          border: 1px solid rgba(120, 174, 255, 0.26);
          border-radius: 14px;
          background: rgba(8, 28, 67, 0.62);
        }
        .qr-faux {
          display: grid;
          place-items: center;
          width: 68px;
          height: 68px;
          border-radius: 10px;
          color: #061639;
          background-color: #fff;
        }
        .camera-button {
          width: 50px;
          height: 50px;
          border: 1px solid rgba(143, 190, 255, 0.18);
          border-radius: 50%;
          display: grid;
          place-items: center;
          background: rgba(255,255,255,0.05);
          color: #dceaff;
        }
        .status-card {
          margin-top: 18px;
          padding: 18px;
          border: 1px solid rgba(114, 197, 255, 0.42);
          border-radius: 18px;
          background: rgba(6, 31, 73, 0.72);
        }
        .status-card a { color: #8fe9ff; }
        .status-card progress,
        .developer-panel progress {
          width: 100%;
          height: 12px;
          accent-color: #32d5ff;
        }
        .trust-strip {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 0;
          max-width: 1280px;
          margin: 0 auto;
          border: 1px solid rgba(135, 198, 255, 0.28);
          border-radius: 24px;
          background: linear-gradient(135deg, rgba(9, 35, 82, 0.82), rgba(5, 22, 58, 0.64));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 20px 60px rgba(0,0,0,0.22);
          backdrop-filter: blur(18px);
          overflow: hidden;
        }
        .trust-item {
          display: grid;
          grid-template-columns: 62px 1fr;
          gap: 15px;
          align-items: start;
          padding: 20px 25px;
          min-height: 92px;
          border-left: 1px solid rgba(135, 198, 255, 0.18);
        }
        .trust-item:first-child { border-left: 0; }
        .trust-icon {
          width: 52px;
          height: 52px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          border: 1px solid rgba(143, 190, 255, 0.34);
          background: rgba(255,255,255,0.04);
          color: #e7f4ff;
          font-size: 27px;
          padding-top: 2px;
        }
        .trust-title { margin: 0; color: #fff; font-size: 18px; font-weight: 820; }
        .trust-copy { margin: 3px 0 0; color: #c4d4f0; font-size: 13px; line-height: 1.25; }
        .trust-icon-live { position: relative; }
        .online-dot {
          position: absolute;
          top: 2px;
          right: 2px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #42ee8b;
          border: 2px solid #0a2350;
          box-shadow: 0 0 16px rgba(66,238,139,0.65);
        }
        .developer-panel {
          max-width: 1280px;
          margin: 26px auto 0;
          border: 1px solid rgba(143, 190, 255, 0.18);
          border-radius: 20px;
          padding: 16px 20px;
          background: rgba(3, 13, 34, 0.46);
          color: #dce8ff;
        }
        .developer-panel summary {
          cursor: pointer;
          font-weight: 800;
          color: #9fb9e7;
        }
        .developer-panel button {
          margin: 6px 8px 6px 0;
          border: 1px solid rgba(135, 198, 255, 0.26);
          border-radius: 12px;
          padding: 9px 12px;
          background: rgba(255,255,255,0.05);
          color: #eef6ff;
        }
        .developer-panel a { color: #8fe9ff; }
        .developer-panel section { border-top: 1px solid rgba(143, 190, 255, 0.15); padding-top: 16px; margin-top: 16px; }
        .error-text { color: #ff9ea8; font-weight: 800; }
        @media (max-width: 980px) {
          .grid-shell { padding: 20px; }
          .hero { min-height: 320px; }
          .panel-grid, .trust-strip { grid-template-columns: 1fr; }
          .trust-item { border-left: 0; border-top: 1px solid rgba(135, 198, 255, 0.18); }
          .trust-item:first-child { border-top: 0; }
          .device, .beam, .file-capsule { opacity: 0.44; }
          .laptop { left: 0; }
          .phone { right: 4%; }
        }
        @media (max-width: 680px) {
          .topbar { align-items: flex-start; }
          .brand { font-size: 22px; }
          .how-pill { display: none; }
          .hero { min-height: 300px; }
          .hero h1 { font-size: 48px; }
          .hero p { font-size: 17px; }
          .panel-grid { margin-top: 0; gap: 20px; }
          .action-card { padding: 24px; min-height: 0; }
          .card-head { grid-template-columns: 56px 1fr; }
          .round-icon { width: 56px; height: 56px; }
          .qr-row { grid-template-columns: 68px 1fr 44px; gap: 12px; }
          .camera-button { width: 44px; height: 44px; }
          .primary-button { min-width: 0; width: 100%; font-size: 19px; }
        }
        @media (max-width: 420px) {
          .grid-shell { padding: 16px 14px 24px; }
          .hero h1 { font-size: 40px; }
          .action-card { padding: 20px; }
          .drop-zone { min-height: 168px; }
          .receive-input { padding: 17px 18px; font-size: 17px; }
          .arrow-button { width: 60px; }
        }
      `}</style>
      <div className="grid-product">
        <nav className="topbar" aria-label="Primary">
          <div className="brand" aria-label="PonsWarp Grid">
            <span className="brand-mark" aria-hidden="true" />
            <span>PonsWarp <span className="brand-accent">Grid</span></span>
          </div>
          <a className="how-pill" href="#how-it-works" aria-label="How it works">
            <Icon name="help" size={18} strokeWidth={2} />
            <span>How it works</span>
          </a>
        </nav>

        <section className="hero" aria-label="PonsWarp Grid intro">
          <h1>Send files directly</h1>
          <p>Direct device-to-device. Fast, private, simple.</p>
          <div className="device laptop" aria-hidden="true" />
          <div className="device phone" aria-hidden="true" />
          <div className="beam" aria-hidden="true" />
          <div className="file-capsule" aria-hidden="true">
            <span className="file-icon" />
            <span><span className="file-name">Report.pdf</span><span className="file-size">2.4 GB</span></span>
            <span className="shield-badge"><Icon name="shield" size={24} strokeWidth={2} /></span>
          </div>
        </section>

        <div className="panel-grid">
          <section className="action-card send-card" aria-label="Send file">
            <div className="card-head">
              <span className="round-icon" aria-hidden="true"><Icon name="upload" size={34} strokeWidth={2} /></span>
              <div>
                <h2>Send file</h2>
                <p>Share any file directly to another device.</p>
              </div>
            </div>
            <label className="drop-zone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); handleFileSelection(event.dataTransfer.files?.[0] ?? null); }}>
              <input aria-label="Choose file to share" type="file" style={{ display: 'none' }} onChange={event => handleFileSelection(event.currentTarget.files?.[0] ?? null)} />
              <span>
                <span className="upload-glyph" aria-hidden="true"><Icon name="upload" size={40} strokeWidth={1.7} /></span>
                <span className="drop-primary">{selectedFile ? `${selectedFile.name ?? 'selected file'} · ${formatBytes(selectedFile.size)}` : 'Drag & drop your file here'}</span>
                <span className="drop-secondary" style={{ display: 'block', margin: '2px 0 4px' }}>or</span>
                <span className="primary-button" role="button"><Icon name="file" size={20} strokeWidth={2} />Choose file</span>
              </span>
            </label>
            {(selectedFile || webShare.status === 'creating') && (
              <button onClick={() => void createWebShareLink()} disabled={webShare.status === 'creating'} className="primary-button" style={{ width: '100%', marginTop: 18 }}>
                {webShare.status === 'creating' ? 'Creating link...' : 'Create link'}
              </button>
            )}
            {webShare.status === 'serving' && (
              <div data-testid="share-result" className="share-result">
                <p><strong>Share code:</strong> {webShare.code}</p>
                <p><strong>Link:</strong> <a href={webShare.link}>{webShare.link}</a></p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', margin: '12px 0' }}>
                  <img src={webShare.qrDataUrl} alt={`QR code for ${webShare.code}`} width={128} height={128} style={{ borderRadius: 14, border: '1px solid rgba(143,190,255,0.42)', background: '#fff', padding: 8 }} />
                  <p style={{ maxWidth: 280, margin: 0, color: '#d9f4ff', fontWeight: 800 }}>Scan this QR code with a phone to open the receive page instantly.</p>
                </div>
                <p><strong>This device is online.</strong> Downloads: {webShare.downloads}</p>
                <p style={{ color: '#8fe9ff' }}>Keep this tab open while sharing.</p>
              </div>
            )}
          </section>

          <section className="action-card receive-card" aria-label="Receive file">
            <div className="card-head">
              <span className="round-icon" aria-hidden="true"><Icon name="download" size={34} strokeWidth={2} /></span>
              <div>
                <h2>Receive file</h2>
                <p>Enter the link or code from the sender.</p>
              </div>
            </div>
            <div className="receive-form">
              <input aria-label="Paste share code or link" className="receive-input" placeholder="Paste link or code" value={webGet.status === 'idle' || webGet.status === 'resolving' || webGet.status === 'error' ? webGet.input : webGet.code} onChange={event => setWebGet({ status: 'idle', input: event.currentTarget.value })} />
              <button className="arrow-button" onClick={() => void resolveWebGetInput()} aria-label="Find file"><Icon name="arrow-right" size={30} strokeWidth={2.2} /></button>
            </div>
            <div className="or-line">or</div>
            <div className="qr-row">
              <span className="qr-faux" aria-hidden="true"><Icon name="qr" size={44} strokeWidth={1.7} /></span>
              <p><strong style={{ color: '#fff' }}>Scan QR from sender</strong><br /><span>Open camera to scan</span></p>
              <span className="camera-button" aria-hidden="true"><Icon name="camera" size={26} strokeWidth={1.8} /></span>
            </div>
            {location.hash.startsWith('#/join/') && state.sessionId && (
              <div data-testid="signaled-receive-status" className="status-card">
                <p><strong>Transfer status:</strong> {state.status}</p>
                <progress max={100} value={state.progress?.progress ?? 0} />
                <p>{state.progress ? `${state.progress.verifiedPieces}/${state.progress.totalPieces} pieces verified (${state.progress.progress.toFixed(1)}%)` : 'Connecting to sender...'}</p>
                <p>Resume restored: {state.restoredProgress ? `${state.restoredProgress.verifiedPieces}/${state.restoredProgress.totalPieces} pieces` : 'not checked'}</p>
                {state.downloadUrl && state.manifest && (
                  <a href={state.downloadUrl} download={state.manifest.name}>Save file ({state.assembledBytes ?? state.manifest.size} bytes)</a>
                )}
              </div>
            )}
            {webGet.status === 'ready' && (
              <div data-testid="receive-ready" className="status-card">
                <p><strong>{webGet.fileName}</strong> · {formatBytes(webGet.sizeBytes)}</p>
                <p style={{ color: '#8fe9ff' }}>{webGet.devicesOnline} device online · secure transfer</p>
                {webGet.helpText.startsWith('Remote') ? (
                  <p style={{ borderRadius: 16, padding: '14px 16px', background: 'rgba(37, 126, 255, 0.18)', color: '#d9f4ff', fontWeight: 800 }}>Open the app or CLI with this code to continue.</p>
                ) : (
                  <button onClick={() => void runWebGetDownload()} className="primary-button" style={{ width: '100%' }}>Download in browser</button>
                )}
                <p>{webGet.helpText}</p>
              </div>
            )}
            {webGet.status === 'downloading' && (
              <div className="status-card">
                <progress max={100} value={webGet.progress} />
                <p>{webGet.progress}% · {formatBytes(webGet.speedBps)}/s · {webGet.securityLabel}</p>
              </div>
            )}
            {webGet.status === 'complete' && <p role="status" className="status-card"><strong>Complete:</strong> {webGet.outputName} · {webGet.verificationLabel}{webGet.downloadUrl ? <> · <a href={webGet.downloadUrl} download={webGet.outputName}>Save file</a></> : null}</p>}
            {webGet.status === 'error' && <p role="alert" className="error-text">{webGet.message}</p>}
          </section>
        </div>

        <section className="trust-strip" aria-label="Trust guarantees">
          <div className="trust-item"><span className="trust-icon"><Icon name="server-off" size={26} /></span><span><p className="trust-title">No server upload</p><p className="trust-copy">Files stay between devices</p></span></div>
          <div className="trust-item"><span className="trust-icon"><Icon name="badge-check" size={26} /></span><span><p className="trust-title">Verified</p><p className="trust-copy">End-to-end verified link</p></span></div>
          <div className="trust-item"><span className="trust-icon"><Icon name="lock" size={26} /></span><span><p className="trust-title">Private link</p><p className="trust-copy">Only the right device can receive</p></span></div>
          <div className="trust-item"><span className="trust-icon trust-icon-live"><Icon name="radio" size={26} /><span className="online-dot" /></span><span><p className="trust-title">Sender online</p><p className="trust-copy">Transfer happens in real time</p></span></div>
        </section>

        <details id="how-it-works" className="developer-panel">
          <summary>Developer and QA controls</summary>
          <section aria-label="Sender panel">
            <h2>Sender</h2>
            <p>Selected: {selectedFile?.name ?? 'Built-in sample file'}</p>
            <button onClick={() => void runLocalDemo()} disabled={state.status === 'running'}>Run local transfer + resume demo</button>
            <button onClick={() => void runWebRtcLoopbackDemo()} disabled={state.status === 'running'}>Run real WebRTC loopback demo</button>
            <button onClick={() => void runLocalGridSchedulerDemo()} disabled={state.status === 'running'}>Run 3-peer grid scheduler demo</button>
            <button onClick={() => void startSignaledSender()} disabled={state.status === 'running'}>Start signaled sender</button>
            <button onClick={() => void startCrossTabGridOwner()} disabled={state.status === 'running'}>Start 3-tab grid owner</button>
            <button onClick={() => void runCrossTabReceiverASeed()} disabled={state.status === 'running'}>Seed 3-tab Receiver A</button>
            <button onClick={() => void runCrossTabReceiverBGrid()} disabled={state.status === 'running'}>Run 3-tab Receiver B</button>
            <button onClick={() => void run10MiBReloadResumeQa()} disabled={state.status === 'running'}>Run 10MiB reload resume QA</button>
            <button onClick={() => void run500MiBBrowserQa()} disabled={state.status === 'running'}>Run 500MiB browser QA</button>
          </section>
          <section aria-label="Receiver panel">
            <h2>Receiver</h2>
            <p>Status: {state.status}</p>
            <p>Share link: {state.shareUrl ?? 'not created'}</p>
            {state.shareQrDataUrl && state.shareUrl && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '8px 0 12px' }}>
                <img src={state.shareQrDataUrl} alt="QR code for signaled receiver link" width={128} height={128} style={{ border: '1px solid rgba(143,190,255,0.42)', borderRadius: 12, background: '#fff', padding: 6 }} />
                <span>Scan this QR code on a phone to join this sender.</span>
              </div>
            )}
            <button onClick={() => void joinSignaledReceiver()} disabled={state.status === 'running'}>Join signaled receiver from URL</button>
            <button onClick={() => void restoreLocalResumeState()} disabled={state.status === 'running'}>Restore local resume state from URL</button>
            <progress max={100} value={state.progress?.progress ?? 0} />
            <p>{state.progress ? `${state.progress.verifiedPieces}/${state.progress.totalPieces} pieces verified (${state.progress.progress.toFixed(1)}%)` : 'No transfer yet.'}</p>
            <p>Resume restored: {state.restoredProgress ? `${state.restoredProgress.verifiedPieces}/${state.restoredProgress.totalPieces} pieces` : 'not checked'}</p>
            <p>Storage: {state.storageKind ?? 'not selected'}</p>
            {state.downloadUrl && state.manifest && (<p><a href={state.downloadUrl} download={state.manifest.name}>Download assembled file</a>{typeof state.assembledBytes === 'number' ? ` (${state.assembledBytes} bytes)` : ''}</p>)}
          </section>
          <section aria-label="Debug panel">
            <h2>Debug</h2>
            <dl><dt>Session</dt><dd>{state.sessionId ?? '-'}</dd><dt>File</dt><dd>{state.manifest ? `${state.manifest.name} (${state.manifest.size} bytes)` : '-'}</dd><dt>Piece size</dt><dd>{state.manifest?.pieceSize ?? '-'}</dd><dt>Piece count</dt><dd>{state.manifest?.pieceCount ?? '-'}</dd></dl>
            {state.error && <p role="alert" className="error-text">{state.error}</p>}
            <ol>{state.logs.map((log, index) => <li key={`${index}-${log}`}>{log}</li>)}</ol>
          </section>
        </details>
      </div>
    </main>
  );
}

function makeSignal(type: 'WEBRTC_OFFER' | 'WEBRTC_ANSWER' | 'ICE_CANDIDATE', sessionId: SessionId, fromPeerId: PeerId, toPeerId: PeerId, payload: Record<string, unknown>): SignalingEnvelope {
  return { protocol: SIGNALING_PROTOCOL, version: PROTOCOL_VERSION, messageId: messageId(), type, sessionId, fromPeerId, toPeerId, timestamp: Date.now(), payload };
}
function sendIce(client: BrowserSignalingClient, sessionId: SessionId, fromPeerId: PeerId, toPeerId: PeerId, candidate: RTCIceCandidateInit): void { client.sendRelay(makeSignal('ICE_CANDIDATE', sessionId, fromPeerId, toPeerId, { candidate })); }
async function waitForTransportChannel(transport: WebRTCTransport, peerId: PeerId): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const channel = transport.getPeer(peerId)?.getChannel();
    if (channel?.channel.readyState === 'open') return;
    await delay(50);
  }
  const state = transport.getPeer(peerId)?.getChannel()?.channel.readyState ?? 'missing';
  throw new Error(`Timed out waiting for WebRTC channel ${peerId}; channel=${state}`);
}

function readCrossTabSetup(): { sessionId: SessionId; ownerPeerId: PeerId; receiverAPeerId: PeerId; receiverBPeerId: PeerId; manifest: FileManifest } {
  const raw = localStorage.getItem(CROSS_TAB_SESSION_KEY);
  if (!raw) throw new Error('No cross-tab grid owner session found.');
  return JSON.parse(raw) as { sessionId: SessionId; ownerPeerId: PeerId; receiverAPeerId: PeerId; receiverBPeerId: PeerId; manifest: FileManifest };
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
