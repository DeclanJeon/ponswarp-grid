import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
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
import { createShareCode, formatBytes, isLocalShareMatch, parseShareCode, resolveReceiveDisplayMetadata } from './web-product';
import { DirectTransferController } from './direct-transfer-controller';
import { loadRuntimeConfig, resolveBrowserTransferWindow, type RuntimeConfig } from './transfer-release-config';
import { DEFAULT_STUN_URL, SHARE_EXPIRY_MS, PIECE_PROGRESS_TIMEOUT_MS, PROGRESS_POLL_INTERVAL_MS, DEFAULT_SAMPLE_FILE_NAME, DEFAULT_SAMPLE_PAYLOAD, calculatePieceSize } from './constants';
import { DemoTransport, BroadcastDemoTransport } from './demo-transports';


interface AppState {
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
  | { status: 'ready'; code: string; fileName: string; sizeBytes?: number; devicesOnline: number; helpText: string; sessionId?: SessionId }
  | { status: 'downloading'; code: string; fileName: string; progress: number; speedBps: number; securityLabel: string }
  | { status: 'complete'; code: string; outputName: string; verificationLabel: 'fully verified' | 'secure transfer complete'; downloadUrl?: string }
  | { status: 'error'; input: string; code: string; message: string; suggestedAction?: string };

type OwnerRuntime = {
  generation: number;
  peerId: PeerId;
  sessionId: SessionId;
  client: BrowserSignalingClient;
  transport: WebRTCTransport;
  engine: PonsWarpEngine;
  peerConnections: Map<PeerId, RTCPeerConnection>;
};

type ReceiverRuntime = {
  generation: number;
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
  const deadline = Date.now() + PIECE_PROGRESS_TIMEOUT_MS;
  let progress = engine.getProgress(fileId);
  while (Date.now() < deadline && progress.verifiedPieces <= previousVerifiedPieces) {
    await delay(PROGRESS_POLL_INTERVAL_MS);
    progress = engine.getProgress(fileId);
  }
  if (progress.verifiedPieces <= previousVerifiedPieces) throw new Error(`Timed out waiting for piece progress beyond ${previousVerifiedPieces}/${progress.totalPieces}`);
  return progress;
}
async function createPersistentStorage(sessionId: SessionId): Promise<{ adapter: StorageAdapter; kind: string; warnings: string[] }> {
  const result = await createBrowserStorageAdapter({ sessionId });
  return { adapter: result.adapter, kind: result.kind, warnings: result.warnings.map(warning => `${warning.kind}:${warning.code}`) };
}
function signalingUrl(): string {
  const explicit = new URLSearchParams(location.search).get('signal');
  if (explicit) return explicit;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}

async function transferWindowSize(): Promise<number> {
  const configured = await ensureTransferWindowConfig();
  return Math.min(configured, 2);
}
let runtimeRtcConfig: RTCConfiguration | null = null;
let runtimeTransferConfig: RuntimeConfig | null = null;
let runtimeTransferConfigLoaded = false;
async function ensureTransferWindowConfig(): Promise<number> {
  if (!runtimeTransferConfigLoaded) {
    runtimeTransferConfigLoaded = true;
    runtimeTransferConfig = await loadRuntimeConfig({ fetch }, location.origin);
  }
  return resolveBrowserTransferWindow(runtimeTransferConfig);
}

function rtcConfigFromUrl(): RTCConfiguration | null {
  const params = new URLSearchParams(location.search);
  const turn = params.get('turn');
  const stunParam = params.get('stun');
  if (!turn && stunParam === null && params.get('relay') !== '1') return null;
  const iceServers: RTCIceServer[] = stunParam === 'none' ? [] : [{ urls: stunParam ?? DEFAULT_STUN_URL }];
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
  const fallback: RTCConfiguration = { iceServers: [{ urls: DEFAULT_STUN_URL }], iceTransportPolicy: 'all' };
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
  return runtimeRtcConfig ?? rtcConfigFromUrl() ?? { iceServers: [{ urls: DEFAULT_STUN_URL }], iceTransportPolicy: 'all' };
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

function pickShareSessionId(payload: Record<string, unknown>): SessionId | undefined {
  const caps = (payload.capabilities && typeof payload.capabilities === 'object')
    ? payload.capabilities as Record<string, unknown>
    : {};
  const data = (payload.data && typeof payload.data === 'object')
    ? payload.data as Record<string, unknown>
    : {};
  const share = (payload.share && typeof payload.share === 'object')
    ? payload.share as Record<string, unknown>
    : {};
  const nested = [payload, data, share, caps];
  for (const row of nested) {
    for (const key of ['sessionId', 'signalingSessionId', 'signaling_session_id'] as const) {
      const value = row[key];
      if (typeof value === 'string' && value.length > 0) return value as SessionId;
    }
    for (const key of ['joinUrl', 'join_url'] as const) {
      const value = row[key];
      if (typeof value === 'string') {
        const sessionId = parseEmbeddedSessionId(value);
        if (sessionId) return sessionId;
      }
    }
  }
  return undefined;
}

function pickShareMeta(payload: Record<string, unknown>): { fileName?: string; sizeBytes?: number; devicesOnline?: number } {
  const data = (payload.data && typeof payload.data === 'object') ? payload.data as Record<string, unknown> : {};
  const share = (payload.share && typeof payload.share === 'object') ? payload.share as Record<string, unknown> : {};
  const file = (payload.file && typeof payload.file === 'object') ? payload.file as Record<string, unknown> : {};
  const rows = [payload, data, share, file];
  let fileName: string | undefined;
  let sizeBytes: number | undefined;
  let devicesOnline: number | undefined;
  for (const row of rows) {
    for (const key of ['name', 'fileName', 'file_name'] as const) {
      const value = row[key];
      if (typeof value === 'string' && value && !fileName) fileName = value;
    }
    for (const key of ['sizeBytes', 'size', 'fileSize'] as const) {
      const value = row[key];
      if (typeof value === 'number' && Number.isFinite(value) && sizeBytes === undefined) sizeBytes = value;
    }
    for (const key of ['devicesOnline', 'devices_online', 'onlineDevices'] as const) {
      const value = row[key];
      if (typeof value === 'number' && Number.isFinite(value) && devicesOnline === undefined) devicesOnline = value;
    }
  }
  return { fileName, sizeBytes, devicesOnline };
}

async function resolveCoordinatorBrowserShare(code: string): Promise<BrowserShareResolution | null> {
  try {
    const response = await fetch(`${location.origin}/api/grid/v1/shares/${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json() as Record<string, unknown>;
    const meta = pickShareMeta(payload);
    return {
      sessionId: pickShareSessionId(payload),
      fileName: meta.fileName,
      sizeBytes: meta.sizeBytes,
      devicesOnline: meta.devicesOnline
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
  const [state, setState] = useState<AppState>({ status: 'idle', logs: ['Ready. Select a file or run the built-in sample.'] });
  const ownerRuntime = useRef<OwnerRuntime | null>(null);
  const receiverRuntime = useRef<ReceiverRuntime | null>(null);
  const ownerRuntimeGeneration = useRef(0);
  const receiverRuntimeGeneration = useRef(0);
  const isCurrentRuntime = (runtime: OwnerRuntime | ReceiverRuntime): boolean =>
    (runtime === ownerRuntime.current && runtime.generation === ownerRuntimeGeneration.current) ||
    (runtime === receiverRuntime.current && runtime.generation === receiverRuntimeGeneration.current);
  async function disposeOwnerRuntime(runtime: OwnerRuntime | null): Promise<void> {
    if (!runtime) return;
    if (ownerRuntime.current === runtime) ownerRuntime.current = null;
    await runtime.client.close().catch(() => undefined);
    for (const pc of runtime.peerConnections.values()) pc.close();
    runtime.peerConnections.clear();
    await runtime.engine.dispose().catch(() => undefined);
    await runtime.transport.close().catch(() => undefined);
  }
  async function disposeReceiverRuntime(runtime: ReceiverRuntime | null): Promise<void> {
    if (!runtime) return;
    if (receiverRuntime.current === runtime) receiverRuntime.current = null;
    await runtime.client.close().catch(() => undefined);
    runtime.pc?.close();
    runtime.pc = undefined;
    await runtime.engine.dispose().catch(() => undefined);
    await runtime.transport.close().catch(() => undefined);
  }
  const storageKinds = useRef(new Map<SessionId, string>());
  const crossTabRuntimes = useRef<Array<{ transport: Transport; engine: PonsWarpEngine; storage: StorageAdapter }>>([]);
  async function disposeCrossTabRuntime(runtime: { transport: Transport; engine: PonsWarpEngine; storage: StorageAdapter } | undefined): Promise<void> {
    if (!runtime) return;
    await runtime.engine.dispose().catch(() => undefined);
    await runtime.transport.close().catch(() => undefined);
  }
  const [webShare, setWebShare] = useState<WebShareState>({ status: 'idle' });
  const [webGet, setWebGet] = useState<WebGetState>({ status: 'idle', input: '' });
  const webShareFile = useRef<(Blob & { name?: string; type?: string }) | null>(null);
  const webDownloadUrl = useRef<string | null>(null);
  const autoJoinedSession = useRef<SessionId | null>(null);

  useEffect(() => { const downloadUrl = state.downloadUrl; if (!downloadUrl) return; return () => URL.revokeObjectURL(downloadUrl); }, [state.downloadUrl]);
  useEffect(() => () => { if (webDownloadUrl.current) URL.revokeObjectURL(webDownloadUrl.current); }, []);
  useEffect(() => () => {
    ownerRuntimeGeneration.current += 1;
    receiverRuntimeGeneration.current += 1;
    void disposeOwnerRuntime(ownerRuntime.current);
    void disposeReceiverRuntime(receiverRuntime.current);
    for (const runtime of crossTabRuntimes.current) {
      void runtime.engine.dispose();
      void runtime.transport.close();
    }
    crossTabRuntimes.current = [];
  }, []);
  useEffect(() => {
    const match = location.hash.match(/^#\/get\/(.+)$/);
    if (match?.[1]) setWebGet({ status: 'idle', input: `${location.origin}${location.pathname}${location.search}${location.hash}` });
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

  type RtcSnapshot = { bytes: number; pair?: { localCandidateType?: string; remoteCandidateType?: string; protocol?: string }; rttMs?: number };
  async function readRtcSnapshot(pc: RTCPeerConnection): Promise<RtcSnapshot> {
    const stats = await pc.getStats();
    let selected: RTCStats & { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number; bytesSent?: number; bytesReceived?: number } | undefined;
    stats.forEach(report => {
      if (!selected && report.type === 'candidate-pair') {
        const pair = report as RTCStats & { selected?: boolean; nominated?: boolean };
        if (pair.selected || pair.nominated) selected = pair;
      }
    });
    stats.forEach(report => {
      if (!selected && report.type === 'candidate-pair' && (report as RTCStats & { state?: string }).state === 'succeeded') selected = report as typeof selected;
    });
    if (!selected) return { bytes: 0 };
    const local = selected.localCandidateId ? stats.get(selected.localCandidateId) as (RTCStats & { candidateType?: string; protocol?: string }) | undefined : undefined;
    const remote = selected.remoteCandidateId ? stats.get(selected.remoteCandidateId) as (RTCStats & { candidateType?: string }) | undefined : undefined;
    return { bytes: (selected.bytesReceived ?? 0) + (selected.bytesSent ?? 0), pair: { localCandidateType: local?.candidateType, remoteCandidateType: remote?.candidateType, protocol: local?.protocol }, rttMs: typeof selected.currentRoundTripTime === 'number' ? Math.round(selected.currentRoundTripTime * 1000) : undefined };
  }
  async function logSelectedCandidatePair(label: string, pc: RTCPeerConnection): Promise<void> {
    const snapshot = await readRtcSnapshot(pc);
    if (!snapshot.pair) { pushLog(`${label} selected ICE pair: unavailable`); return; }
    pushLog(`${label} selected ICE pair: local=${snapshot.pair.localCandidateType ?? 'unknown'}/${snapshot.pair.protocol ?? 'unknown'} remote=${snapshot.pair.remoteCandidateType ?? 'unknown'}`);
  }
  async function recordRtcMetrics(pc: RTCPeerConnection | undefined, controller: DirectTransferController, payloadBytes: number, effectiveWindow: number, beforeWireBytes = 0): Promise<void> {
    if (!pc) return;
    const snapshot = await readRtcSnapshot(pc);
    controller.recordMetrics({ payloadBytes, wireBytes: Math.max(0, snapshot.bytes - beforeWireBytes), rttMs: snapshot.rttMs, effectiveWindow, selectedIcePair: snapshot.pair });
  }
  function exposeTransferMetrics(controller: DirectTransferController): void {
    window.dispatchEvent(new CustomEvent('ponswarp:direct-transfer-metrics', { detail: controller.getMetrics() }));
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
    const generation = ++ownerRuntimeGeneration.current;
    const file = selectedFile ?? namedBlob(DEFAULT_SAMPLE_PAYLOAD, DEFAULT_SAMPLE_FILE_NAME);
    setWebShare({ status: 'creating' });
    setState({ status: 'running', logs: ['Creating a phone-ready WebRTC share link.'] });
    let transport: WebRTCTransport | undefined;
    let engine: PonsWarpEngine | undefined;
    let runtime: OwnerRuntime | undefined;
    try {
      const ice = await ensureRtcConfig();
      if (generation !== ownerRuntimeGeneration.current) return;
      await disposeOwnerRuntime(ownerRuntime.current);
      if (generation !== ownerRuntimeGeneration.current) return;
      const ownerPeerId = `owner_${Date.now()}` as PeerId;
      const sessionId = `sess_signal_${Date.now()}` as SessionId;
      transport = new WebRTCTransport();
      const storage = new MemoryStorageAdapter();
      engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const session = await engine.createSession({ sessionId, files: [file], pieceSize: calculatePieceSize(file) });
      if (generation !== ownerRuntimeGeneration.current) {
        await engine.dispose().catch(() => undefined);
        await transport.close().catch(() => undefined);
        return;
      }
      const manifest = session.manifests[0];
      const client = new BrowserSignalingClient({ url: signalingUrl() });
      runtime = { generation, peerId: ownerPeerId, sessionId, client, transport, engine, peerConnections: new Map() };
      ownerRuntime.current = runtime;
      client.onMessage(envelope => {
        void handleOwnerSignal(runtime!, envelope).catch(error => {
          if (isCurrentRuntime(runtime!)) recordAsyncError('Sender signaling handler error', error);
        });
      });
      client.onState(value => { if (isCurrentRuntime(runtime!)) pushLog(`Sender signaling state: ${value}`); });
      client.onError(error => { if (isCurrentRuntime(runtime!)) pushLog(`Sender signaling error: ${error.message}`); });
      await client.connect();
      if (!isCurrentRuntime(runtime)) { await disposeOwnerRuntime(runtime); return; }
      pushLog(`ICE servers loaded: ${ice.iceServers?.length ?? 0}.`);
      client.createSession({ ownerPeerId, files: [manifest], sessionId, mode: 'direct' });
      const localCode = createShareCode();
      const coordinatorShare = await registerCoordinatorBrowserShare({ code: localCode, sessionId, ownerPeerId, manifest });
      if (!isCurrentRuntime(runtime)) { await disposeOwnerRuntime(runtime); return; }
      const code = coordinatorShare?.code ?? localCode;
      const link = coordinatorShare?.link ?? currentGetUrl(code, sessionId);
      const qrDataUrl = await createQrDataUrl(link);
      if (!isCurrentRuntime(runtime)) { await disposeOwnerRuntime(runtime); return; }
      webShareFile.current = file;
      setWebShare({
        status: 'serving',
        code,
        sessionId,
        link,
        qrDataUrl,
        fileName: file.name ?? DEFAULT_SAMPLE_FILE_NAME,
        sizeBytes: file.size,
        expiresAt: Date.now() + SHARE_EXPIRY_MS,
        downloads: 0,
        devicesOnline: 1
      });
      setState(current => ({ ...current, status: 'ready', sessionId, shareUrl: link, shareQrDataUrl: qrDataUrl, manifest, logs: [...current.logs, `Phone-ready sender online for ${manifest.name}.`, `Scan or open receiver link: ${link}`] }));
      setWebGet({ status: 'idle', input: '' });
    } catch (error) {
      await (runtime ? disposeOwnerRuntime(runtime) : Promise.all([engine?.dispose().catch(() => undefined), transport?.close().catch(() => undefined)]));
      if (generation === ownerRuntimeGeneration.current) {
        const message = error instanceof Error ? error.message : String(error);
        setWebShare({ status: 'error', code: 'share_failed', message, suggestedAction: 'Check signaling connectivity and try again.' });
        setState(current => ({ ...current, status: 'error', error: message, logs: [...current.logs, `Share link creation failed: ${message}`] }));
      }
    }
  }

  async function resolveWebGetInput(): Promise<void> {
    const input = webGet.status === 'idle' || webGet.status === 'resolving' || webGet.status === 'error' ? webGet.input : webGet.code;
    const code = parseShareCode(input);
    const embeddedSessionId = parseEmbeddedSessionId(input);
    if (!code && !embeddedSessionId) {
      setWebGet({ status: 'error', input, code: 'missing_code', message: 'Paste a share code or link.', suggestedAction: 'Paste an 8-character code or a grid.ponslink.com receive link.' });
      return;
    }
    setWebGet({ status: 'resolving', input });
    const localShare = webShare.status === 'serving' && code && isLocalShareMatch(webShare.code, code) ? webShare : null;
    let coordinatorShare = !localShare && code ? await resolveCoordinatorBrowserShare(code) : null;
    // Back-compat: older shares may be stored as XXXX-XXXX on the coordinator.
    if (!localShare && !coordinatorShare && code.length === 8) {
      const dashed = `${code.slice(0, 4)}-${code.slice(4)}`;
      coordinatorShare = await resolveCoordinatorBrowserShare(dashed);
    }
    const sessionId = embeddedSessionId ?? localShare?.sessionId ?? coordinatorShare?.sessionId;
    const metadata = resolveReceiveDisplayMetadata(localShare, coordinatorShare);
    const { fileName, sizeBytes } = metadata;
    const resolvedCode = code || (sessionId ? sessionId.slice(0, 8).toUpperCase() : '');
    const devicesOnline = localShare?.devicesOnline ?? coordinatorShare?.devicesOnline ?? (sessionId ? 1 : 0);

    if (sessionId) {
      // Start browser WebRTC download immediately — no extra confirm step.
      setWebGet({
        status: 'ready',
        code: resolvedCode,
        fileName,
        sizeBytes,
        devicesOnline,
        helpText: 'Connecting to sender for verified piece transfer…',
        sessionId
      });
      await runWebGetDownloadWith({ code: resolvedCode, fileName, sessionId });
      return;
    }

    if (localShare && webShareFile.current) {
      setWebGet({
        status: 'ready',
        code: resolvedCode,
        fileName,
        sizeBytes,
        devicesOnline,
        helpText: 'Starting local verified download…',
        sessionId: localShare.sessionId
      });
      await runWebGetDownloadWith({ code: resolvedCode, fileName, sessionId: localShare.sessionId });
      return;
    }

    setWebGet({
      status: 'error',
      input,
      code: 'sender_unreachable',
      message: 'Could not start a browser download for this code.',
      suggestedAction: 'Confirm the sender tab is still open and the code is correct. Same-network devices should connect automatically; try pasting the full link from the sender.'
    });
  }

  async function runWebGetDownload(): Promise<void> {
    if (webGet.status !== 'ready') return;
    const { code, fileName, sessionId } = webGet;
    await runWebGetDownloadWith({ code, fileName, sessionId });
  }

  async function runWebGetDownloadWith(input: { code: string; fileName: string; sessionId?: SessionId }): Promise<void> {
    const { code, fileName, sessionId } = input;
    if (sessionId) {
      const joinUrl = currentJoinUrl(sessionId);
      window.history.replaceState(null, '', joinUrl);
      setWebGet({ status: 'downloading', code, fileName, progress: 0, speedBps: 0, securityLabel: 'Connecting WebRTC receiver' });
      try {
        await joinSignaledReceiver(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWebGet({ status: 'error', input: code, code: 'transfer_failed', message, suggestedAction: 'Keep the sender tab open and try again.' });
      }
      return;
    }
    const localFile = webShare.status === 'serving' && isLocalShareMatch(webShare.code, code) ? webShareFile.current : null;
    if (!localFile) {
      setWebGet({ status: 'error', input: code, code: 'no_local_file', message: 'No downloadable file found for this code in this browser.', suggestedAction: 'Open the share link on a device that can reach the online sender.' });
      return;
    }
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
      await runEngineTransfer({ sessionId, ownerPeerId, receiverPeerId, ownerTransport, receiverTransport, file: selectedFile ?? namedBlob(DEFAULT_SAMPLE_PAYLOAD, DEFAULT_SAMPLE_FILE_NAME), logPrefix: 'Transferred', initialLog: 'Receiver joined session and loaded manifest.' });
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
      await runEngineTransfer({ sessionId, ownerPeerId, receiverPeerId, ownerTransport, receiverTransport, file: selectedFile ?? namedBlob(DEFAULT_SAMPLE_PAYLOAD, DEFAULT_SAMPLE_FILE_NAME), logPrefix: 'WebRTC transferred', initialLog: 'WebRTC DataChannel open; receiver joined WebRTC session and loaded manifest.' });
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function runLocalGridSchedulerDemo(): Promise<void> {
    setState({ status: 'running', logs: ['Creating owner, Receiver A, and Receiver B grid engines with in-memory transports.'] });
    let ownerTransport: DemoTransport | undefined;
    let receiverATransport: DemoTransport | undefined;
    let receiverBTransport: DemoTransport | undefined;
    let owner: PonsWarpEngine | undefined;
    let ownerStorage: StorageAdapter | undefined;
    let receiverAStorage: StorageAdapter | undefined;
    let receiverBStorage: StorageAdapter | undefined;
    let receiverA: PonsWarpEngine | undefined;
    let receiverB: PonsWarpEngine | undefined;
    let restoredReceiver: PonsWarpEngine | undefined;
    try {
      const ownerPeerId = 'peer_owner' as PeerId;
      const receiverAPeerId = 'peer_receiver_a' as PeerId;
      const receiverBPeerId = 'peer_receiver_b' as PeerId;
      const sessionId = `sess_grid_${Date.now()}` as SessionId;
      ownerTransport = new DemoTransport(ownerPeerId);
      receiverATransport = new DemoTransport(receiverAPeerId);
      receiverBTransport = new DemoTransport(receiverBPeerId);
      ownerTransport.link(receiverAPeerId, receiverATransport);
      ownerTransport.link(receiverBPeerId, receiverBTransport);
      receiverATransport.link(ownerPeerId, ownerTransport);
      receiverATransport.link(receiverBPeerId, receiverBTransport);
      receiverBTransport.link(ownerPeerId, ownerTransport);
      receiverBTransport.link(receiverAPeerId, receiverATransport);

      ownerStorage = new MemoryStorageAdapter();
      owner = new PonsWarpEngine(ownerStorage, undefined, undefined, undefined, ownerTransport);
      receiverAStorage = new MemoryStorageAdapter();
      receiverBStorage = new MemoryStorageAdapter();
      receiverA = new PonsWarpEngine(receiverAStorage, undefined, undefined, undefined, receiverATransport);
      receiverB = new PonsWarpEngine(receiverBStorage, undefined, undefined, undefined, receiverBTransport);
      const file = selectedFile ?? namedBlob(DEFAULT_SAMPLE_PAYLOAD, DEFAULT_SAMPLE_FILE_NAME);
      const session = await owner.createSession({ sessionId, files: [file], pieceSize: calculatePieceSize(file) });
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

      restoredReceiver = new PonsWarpEngine(receiverBStorage);
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
    finally {
      await restoredReceiver?.dispose().catch(() => undefined);
      await receiverA?.dispose().catch(() => undefined);
      await receiverB?.dispose().catch(() => undefined);
      await owner?.dispose().catch(() => undefined);
      await receiverBTransport?.close().catch(() => undefined);
      await receiverATransport?.close().catch(() => undefined);
      await ownerTransport?.close().catch(() => undefined);
    }
  }

  async function startCrossTabGridOwner(): Promise<void> {
    setState({ status: 'running', logs: ['Starting 3-browser-context grid owner.'] });
    let runtime: { transport: Transport; engine: PonsWarpEngine; storage: StorageAdapter } | undefined;
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
      const session = await engine.createSession({ sessionId, files: [file], pieceSize: calculatePieceSize(file) });
      const manifest = session.manifests[0];
      runtime = { transport, engine, storage };
      localStorage.setItem(CROSS_TAB_SESSION_KEY, JSON.stringify({ sessionId, ownerPeerId, receiverAPeerId: 'peer_receiver_a', receiverBPeerId: 'peer_receiver_b', manifest }));
      crossTabRuntimes.current.push(runtime);
      runtime = undefined;
      setState(current => ({ ...current, status: 'ready', sessionId, manifest, shareUrl: currentJoinUrl(sessionId), storageKind: 'memory', logs: [...current.logs, `Cross-tab owner ready with ${manifest.pieceCount} pieces for ${manifest.name}.`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
    finally {
      await disposeCrossTabRuntime(runtime);
    }
  }

  async function runCrossTabReceiverASeed(): Promise<void> {
    setState({ status: 'running', logs: ['Starting 3-browser-context Receiver A seed.'] });
    let runtime: { transport: Transport; engine: PonsWarpEngine; storage: StorageAdapter } | undefined;
    try {
      const setup = readCrossTabSetup();
      const transport = new BroadcastDemoTransport(setup.receiverAPeerId, setup.sessionId);
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      runtime = { transport, engine, storage };
      await engine.joinSession(setup.sessionId, [setup.manifest]);
      const scheduled = await engine.requestNextPiece(setup.ownerPeerId, setup.manifest.fileId);
      if (!scheduled) throw new Error('Receiver A could not request owner seed piece.');
      const progress = await waitForPieceProgress(engine, setup.manifest.fileId, 0);
      const broadcast = await engine.broadcastPieceMap(setup.manifest.fileId, [setup.receiverBPeerId]);
      localStorage.setItem(CROSS_TAB_PIECE_MAP_KEY, JSON.stringify({ sessionId: setup.sessionId, peerId: setup.receiverAPeerId, map: broadcast }));
      crossTabRuntimes.current.push(runtime);
      runtime = undefined;
      setState(current => ({ ...current, status: 'complete', sessionId: setup.sessionId, manifest: setup.manifest, progress, shareUrl: currentJoinUrl(setup.sessionId), storageKind: 'memory', logs: [...current.logs, `Receiver A seeded ${progress.verifiedPieces}/${progress.totalPieces} from owner.`, `Receiver A broadcast PIECE_MAP generation ${broadcast.generation} with pieces ${broadcast.verifiedPieces.join(',')}.`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
    finally {
      await disposeCrossTabRuntime(runtime);
    }
  }

  async function runCrossTabReceiverBGrid(): Promise<void> {
    setState({ status: 'running', logs: ['Starting 3-browser-context Receiver B grid scheduler.'] });
    let runtime: { transport: Transport; engine: PonsWarpEngine; storage: StorageAdapter } | undefined;
    try {
      const setup = readCrossTabSetup();
      const transport = new BroadcastDemoTransport(setup.receiverBPeerId, setup.sessionId);
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      runtime = { transport, engine, storage };
      await engine.joinSession(setup.sessionId, [setup.manifest]);
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
      crossTabRuntimes.current.push(runtime);
      runtime = undefined;
      setState(current => ({ ...current, status: 'complete', sessionId: setup.sessionId, manifest: setup.manifest, progress, restoredProgress: progress, shareUrl: currentJoinUrl(setup.sessionId), storageKind: 'memory', downloadUrl, assembledBytes: assembledFile.size, logs: [...current.logs, ...logs, `Cross-tab grid complete: Receiver B used ${nonOwnerPieces} non-owner provider piece(s).`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
    finally {
      await disposeCrossTabRuntime(runtime);
    }
  }

  async function runBrowserResumeQa(bytes: number, label: string): Promise<void> {
    setState({ status: 'running', storageKind: 'probing', logs: [`Starting ${label} browser transfer + reload resume QA.`] });
    let ownerTransport: DemoTransport = new DemoTransport('peer_owner' as PeerId);
    let receiverTransport: DemoTransport = new DemoTransport('peer_receiver' as PeerId);
    let owner: PonsWarpEngine | undefined;
    let receiver: PonsWarpEngine | undefined;
    let restoredReceiver: PonsWarpEngine | undefined;
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

      ownerTransport.link(receiverPeerId, receiverTransport);
      receiverTransport.link(ownerPeerId, ownerTransport);

      owner = new PonsWarpEngine(new MemoryStorageAdapter(), undefined, undefined, undefined, ownerTransport);
      const storageResult = await createPersistentStorage(sessionId);
      receiver = new PonsWarpEngine(storageResult.adapter, undefined, undefined, undefined, receiverTransport);
      restoredReceiver = undefined;
      const session = await owner!.createSession({ sessionId, files: [file], pieceSize, includeFileHash: false });
      const manifest = session.manifests[0];
      await receiver!.joinSession(sessionId, [manifest]);
      storageKinds.current.set(sessionId, storageResult.kind);

      let progress = receiver!.getProgress(manifest.fileId);
      const reloadAt = Math.max(1, Math.floor(progress.totalPieces * 0.4));
      let reloaded = false;
      while (progress.verifiedPieces < progress.totalPieces) {
        const before = progress.verifiedPieces;
        const scheduled = await receiver!.requestNextPiece(ownerPeerId, manifest.fileId);
        if (!scheduled) throw new Error('No piece scheduled during resume QA.');
        progress = await waitForPieceProgress(receiver!, manifest.fileId, before);
        if (progress.verifiedPieces % 50 === 0 || progress.verifiedPieces === reloadAt || progress.verifiedPieces === progress.totalPieces) {
          pushLog(`${label}: ${progress.verifiedPieces}/${progress.totalPieces} pieces verified.`);
        }
        if (!reloaded && progress.verifiedPieces >= reloadAt) {
          reloaded = true;
          await receiver?.dispose().catch(() => undefined);
          await receiverTransport.close().catch(() => undefined);
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

      restoredReceiver = new PonsWarpEngine(storageResult.adapter);
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
    } catch (error) {
      setState(current => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        logs: [...current.logs, `${label} QA failed.`]
      }));
    } finally {
      await restoredReceiver?.dispose().catch(() => undefined);
      await receiver?.dispose().catch(() => undefined);
      await owner?.dispose().catch(() => undefined);
      await receiverTransport.close().catch(() => undefined);
      await ownerTransport.close().catch(() => undefined);
    }
  }

  async function run10MiBReloadResumeQa(): Promise<void> {
    await runBrowserResumeQa(10 * 1024 * 1024, '10MiB-reload-resume');
  }

  async function run500MiBBrowserQa(): Promise<void> {
    await runBrowserResumeQa(500 * 1024 * 1024, '500MiB-browser');
  }

  async function startSignaledSender(): Promise<void> {
    const generation = ++ownerRuntimeGeneration.current;
    setState({ status: 'running', logs: ['Connecting sender to signaling server.'] });
    let transport: WebRTCTransport | undefined;
    let engine: PonsWarpEngine | undefined;
    let runtime: OwnerRuntime | undefined;
    try {
      const ice = await ensureRtcConfig();
      if (generation !== ownerRuntimeGeneration.current) return;
      await disposeOwnerRuntime(ownerRuntime.current);
      if (generation !== ownerRuntimeGeneration.current) return;
      const ownerPeerId = `owner_${Date.now()}` as PeerId;
      const sessionId = `sess_signal_${Date.now()}` as SessionId;
      transport = new WebRTCTransport();
      const storage = new MemoryStorageAdapter();
      engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const file = selectedFile ?? namedBlob(DEFAULT_SAMPLE_PAYLOAD, DEFAULT_SAMPLE_FILE_NAME);
      const session = await engine.createSession({ sessionId, files: [file], pieceSize: calculatePieceSize(file) });
      if (generation !== ownerRuntimeGeneration.current) {
        await engine.dispose().catch(() => undefined);
        await transport.close().catch(() => undefined);
        return;
      }
      const manifest = session.manifests[0];
      const client = new BrowserSignalingClient({ url: signalingUrl() });
      runtime = { generation, peerId: ownerPeerId, sessionId, client, transport, engine, peerConnections: new Map() };
      ownerRuntime.current = runtime;
      client.onMessage(envelope => {
        void handleOwnerSignal(runtime!, envelope).catch(error => {
          if (isCurrentRuntime(runtime!)) recordAsyncError('Sender signaling handler error', error);
        });
      });
      client.onState(value => { if (isCurrentRuntime(runtime!)) pushLog(`Sender signaling state: ${value}`); });
      client.onError(error => { if (isCurrentRuntime(runtime!)) pushLog(`Sender signaling error: ${error.message}`); });
      await client.connect();
      if (!isCurrentRuntime(runtime)) { await disposeOwnerRuntime(runtime); return; }
      pushLog(`ICE servers loaded: ${ice.iceServers?.length ?? 0}.`);
      client.createSession({ ownerPeerId, files: [manifest], sessionId, mode: 'direct' });
      const shareUrl = currentJoinUrl(sessionId);
      const shareQrDataUrl = await createQrDataUrl(shareUrl);
      if (!isCurrentRuntime(runtime)) { await disposeOwnerRuntime(runtime); return; }
      setState(current => ({ ...current, status: 'ready', sessionId, shareUrl, shareQrDataUrl, manifest, logs: [...current.logs, `Signaled sender ready for ${manifest.name}.`, `Open receiver link: ${shareUrl}`] }));
    } catch (error) {
      await (runtime ? disposeOwnerRuntime(runtime) : Promise.all([engine?.dispose().catch(() => undefined), transport?.close().catch(() => undefined)]));
      if (generation === ownerRuntimeGeneration.current) {
        setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  async function joinSignaledReceiver(sessionIdOverride?: SessionId): Promise<void> {
    const match = location.hash.match(/^#\/join\/(.+)$/);
    const sessionId = (sessionIdOverride ?? match?.[1] ?? state.sessionId) as SessionId | undefined;
    if (!sessionId) { setState(current => ({ ...current, status: 'error', error: 'No #/join/:sessionId route found.' })); return; }
    setState({ status: 'running', sessionId, storageKind: 'probing', logs: [`Connecting receiver to signaling server for ${sessionId}.`] });
    const generation = ++receiverRuntimeGeneration.current;
    let transport: WebRTCTransport | undefined;
    let engine: PonsWarpEngine | undefined;
    let runtime: ReceiverRuntime | undefined;
    try {
      const ice = await ensureRtcConfig();
      if (generation !== receiverRuntimeGeneration.current) return;
      await disposeReceiverRuntime(receiverRuntime.current);
      if (generation !== receiverRuntimeGeneration.current) return;
      const peerId = `receiver_${Date.now()}` as PeerId;
      transport = new WebRTCTransport();
      const storageResult = await createPersistentStorage(sessionId);
      if (generation !== receiverRuntimeGeneration.current) {
        await transport.close().catch(() => undefined);
        return;
      }
      storageKinds.current.set(sessionId, storageResult.kind);
      const storage = storageResult.adapter;
      engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const client = new BrowserSignalingClient({ url: signalingUrl() });
      runtime = { generation, peerId, sessionId, client, transport, engine, storage, pendingIce: [], completed: false };
      receiverRuntime.current = runtime;
      client.onMessage(envelope => {
        void handleReceiverSignal(runtime!, envelope).catch(error => {
          if (isCurrentRuntime(runtime!)) recordAsyncError('Receiver signaling handler error', error);
        });
      });
      client.onState(value => { if (isCurrentRuntime(runtime!)) pushLog(`Receiver signaling state: ${value}`); });
      client.onError(error => { if (isCurrentRuntime(runtime!)) pushLog(`Receiver signaling error: ${error.message}`); });
      await client.connect();
      if (!isCurrentRuntime(runtime)) { await disposeReceiverRuntime(runtime); return; }
      pushLog(`ICE servers loaded: ${ice.iceServers?.length ?? 0}.`);
      client.joinSession({ sessionId, peerId });
    } catch (error) {
      await (runtime ? disposeReceiverRuntime(runtime) : Promise.all([engine?.dispose().catch(() => undefined), transport?.close().catch(() => undefined)]));
      if (generation === receiverRuntimeGeneration.current) {
        setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  async function handleOwnerSignal(runtime: OwnerRuntime, envelope: SignalingEnvelope): Promise<void> {
    if (!isCurrentRuntime(runtime)) return;
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
    if (!isCurrentRuntime(runtime)) return;
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
    if (!isCurrentRuntime(runtime)) return;
    if (runtime.completed || !runtime.ownerPeerId) return;
    const controller = new DirectTransferController(runtime.engine, `run_${runtime.sessionId}`, {
      onTransportFatal: handler => {
        const removeError = runtime.transport.onError(event => handler({ peerId: event.peerId, error: event.error }));
        const removeState = runtime.transport.onPeerState(event => {
          if (event.state === 'failed' || event.state === 'disconnected') handler({ peerId: event.peerId, error: new Error(`WebRTC peer ${event.state}`) });
        });
        return () => { removeError(); removeState(); };
      }
    });
    let transferDownloadUrl: string | undefined;
    try {
      const manifest = runtime.manifest;
      if (!manifest) throw new Error('Receiver did not receive a manifest');
      controller.setTransfer({ fileBytes: manifest.size, pieceBytes: manifest.pieceSize, pieceCount: manifest.pieceCount, hashMode: 'sha256' });
      await runtime.engine.joinSession(runtime.sessionId, [manifest]);
      let progress = runtime.engine.getProgress(manifest.fileId);
      const transferWindow = await transferWindowSize();
      controller.beginTransferMetrics();
      const rtcStart = runtime.pc ? await readRtcSnapshot(runtime.pc) : { bytes: 0 };
      while (progress.verifiedPieces < progress.totalPieces) {
        const before = progress.verifiedPieces;
        const terminals = await controller.requestWindow(runtime.ownerPeerId, manifest.fileId, { controllerId: 'browser-direct', windowKey: `${runtime.sessionId}:${manifest.fileId}`, maxInFlight: transferWindow });
        const scheduled = Array.from({ length: terminals.length });
        if (scheduled.length === 0 && runtime.engine.getOutstandingRequestCount(manifest.fileId, runtime.ownerPeerId) === 0) throw new Error(`No provider scheduled piece after ${progress.verifiedPieces}/${progress.totalPieces} verified`);
        progress = await waitForPieceProgress(runtime.engine, manifest.fileId, before);
        pushLog(`Signaled WebRTC transferred piece ${progress.verifiedPieces}/${progress.totalPieces} verified (${scheduled.length} request(s) queued, window ${transferWindow}).`);
        if (globalThis.localStorage?.getItem('ponswarp-partial-resume') === '1' && progress.verifiedPieces >= Math.ceil(progress.totalPieces / 2)) {
          setState(current => ({ ...current, status: 'ready', manifest, progress, restoredProgress: progress, storageKind: storageKinds.current.get(runtime.sessionId), shareUrl: currentJoinUrl(runtime.sessionId), logs: [...current.logs, `Partial resume seed persisted at ${progress.verifiedPieces}/${progress.totalPieces} pieces.`] }));
          await controller.dispose('cancelled');
          return;
        }
      }
      controller.recordMetrics({ payloadBytes: manifest.size, pieceTiming: { count: progress.verifiedPieces } });
      controller.endTransferMetrics();
      const restoredReceiver = new PonsWarpEngine(runtime.storage);
      try {
        await restoredReceiver.joinSession(runtime.sessionId);
        const restoredProgress = restoredReceiver.getProgress(manifest.fileId);
        if (restoredProgress.verifiedPieces !== restoredProgress.totalPieces) throw new Error(`Cannot assemble incomplete file: ${restoredProgress.verifiedPieces}/${restoredProgress.totalPieces} pieces verified`);
        const assembledFile = await runtime.storage.assembleFile(manifest.fileId, manifest);
        const downloadUrl = URL.createObjectURL(assembledFile);
        transferDownloadUrl = downloadUrl;
        controller.recordResumeValidation(restoredProgress.verifiedPieces, 0, 'passed');
        await recordRtcMetrics(runtime.pc, controller, manifest.size, transferWindow, rtcStart.bytes);
        await controller.dispose('succeeded');
        exposeTransferMetrics(controller);
        runtime.completed = true;
        setState(current => ({ ...current, status: 'complete', manifest, progress, restoredProgress, downloadUrl, assembledBytes: assembledFile.size, storageKind: storageKinds.current.get(runtime.sessionId), shareUrl: currentJoinUrl(runtime.sessionId), logs: [...current.logs, `Signaled WebRTC resume restored ${restoredProgress.verifiedPieces}/${restoredProgress.totalPieces}; assembled ${assembledFile.size} bytes.`] }));
        setWebGet(current => current.status === 'downloading'
          ? { status: 'complete', code: current.code, outputName: manifest.name, verificationLabel: 'fully verified', downloadUrl }
          : current);
      } finally {
        await restoredReceiver.dispose().catch(() => undefined);
      }
      return;
    } catch (error) {
      runtime.completed = false;
      if (transferDownloadUrl) URL.revokeObjectURL(transferDownloadUrl);
      const message = error instanceof Error ? error.message : String(error);
      setWebGet(current => current.status === 'downloading'
        ? { status: 'error', input: current.code, code: 'transfer_failed', message, suggestedAction: 'Check the sender connection and retry the transfer.' }
        : current);
      try {
        await controller.dispose('failed');
        exposeTransferMetrics(controller);
      } catch (cleanupError) {
        pushLog(`Direct transfer cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      throw error;
    }
  }

  async function restoreLocalResumeState(): Promise<void> {
    const match = location.hash.match(/^#\/join\/(.+)$/);
    const sessionId = (match?.[1] ?? state.sessionId) as SessionId | undefined;
    if (!sessionId) { setState(current => ({ ...current, status: 'error', error: 'No sessionId available for local resume restore.' })); return; }
    setState({ status: 'restoring_local_state', sessionId, storageKind: 'probing', logs: [`Restoring local persisted state for ${sessionId}.`] });
    let storage: StorageAdapter | undefined;
    let engine: PonsWarpEngine | undefined;
    try {
      const storageResult = await createPersistentStorage(sessionId);
      storage = storageResult.adapter;
      setState(current => ({ ...current, status: 'local_state_restored', storageKind: storageResult.kind, logs: [...current.logs, `Local storage selected: ${storageResult.kind}.`] }));
      storageKinds.current.set(sessionId, storageResult.kind);
      engine = new PonsWarpEngine(storage);
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
    } finally {
      await engine?.dispose().catch(() => undefined);
    }
  }

  async function runEngineTransfer(input: { sessionId: SessionId; ownerPeerId: PeerId; receiverPeerId: PeerId; ownerTransport: Transport; receiverTransport: Transport; file: Blob & { name?: string; type?: string }; logPrefix: string; initialLog: string }): Promise<void> {
    const ownerStorage = new MemoryStorageAdapter();
    const receiverStorage = new MemoryStorageAdapter();
    const owner = new PonsWarpEngine(ownerStorage, undefined, undefined, undefined, input.ownerTransport);
    let receiver: PonsWarpEngine | undefined;
    let restoredReceiver: PonsWarpEngine | undefined;
    try {
      receiver = new PonsWarpEngine(receiverStorage, undefined, undefined, undefined, input.receiverTransport);
      const session = await owner.createSession({ sessionId: input.sessionId, files: [input.file], pieceSize: calculatePieceSize(input.file) });
      const manifest = session.manifests[0];
      pushLog(`Sender created ${manifest.pieceCount} pieces for ${manifest.name}.`);
      await receiver!.joinSession(session.sessionId, [manifest]);
      pushLog(input.initialLog);
      let progress = receiver!.getProgress(manifest.fileId);
      const transferWindow = await transferWindowSize();
      while (progress.verifiedPieces < progress.totalPieces) {
        const before = progress.verifiedPieces;
        const scheduled = await receiver!.requestPieceWindow(input.ownerPeerId, manifest.fileId, { maxInFlight: transferWindow });
        if (scheduled.length === 0 && receiver!.getOutstandingRequestCount(manifest.fileId, input.ownerPeerId) === 0) break;
        progress = await waitForPieceProgress(receiver!, manifest.fileId, before);
        pushLog(`${input.logPrefix} piece ${progress.verifiedPieces}/${progress.totalPieces} verified (${scheduled.length} request(s) queued, window ${transferWindow}).`);
      }
      restoredReceiver = new PonsWarpEngine(receiverStorage);
      await restoredReceiver.joinSession(session.sessionId);
      const restoredProgress = restoredReceiver.getProgress(manifest.fileId);
      const assembledFile = await receiverStorage.assembleFile(manifest.fileId, manifest);
      const downloadUrl = URL.createObjectURL(assembledFile);
      pushLog(`Resume restored ${restoredProgress.verifiedPieces}/${restoredProgress.totalPieces}; assembled ${assembledFile.size} bytes.`);
      setState(current => ({ ...current, status: 'complete', sessionId: session.sessionId, shareUrl: session.shareUrl, manifest, progress, restoredProgress, downloadUrl, assembledBytes: assembledFile.size }));
    } finally {
      await restoredReceiver?.dispose().catch(() => undefined);
      await receiver?.dispose().catch(() => undefined);
      await owner.dispose().catch(() => undefined);
      await input.receiverTransport.close().catch(() => undefined);
      await input.ownerTransport.close().catch(() => undefined);
    }
  }

  const showQA = import.meta.env.VITE_SHOW_QA_CONTROLS === 'true' || new URLSearchParams(location.search).has('qa');

  return (
    <main className="grid-shell">
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

        <div className="grid-noise" aria-hidden="true" />
        <section className="hero" aria-label="PonsWarp Grid intro">
          <p className="hero-kicker"><span className="hero-kicker-dot" aria-hidden="true" />Piece-based P2P · resume · verify</p>
          <h1>Files move device to device</h1>
          <p>No cloud upload of your payload. WebRTC pieces, local resume, SHA-256 checks — keep the sender tab open and share a link.</p>
          <div className="mesh-motif" aria-hidden="true">
            <svg viewBox="0 0 420 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M40 70 C 100 20, 160 120, 220 60 S 340 10, 380 55" stroke="url(#g)" strokeWidth="1.5" opacity="0.7" />
              <circle cx="40" cy="70" r="5" fill="#5ef0c0" />
              <circle cx="220" cy="60" r="6" fill="#8b7cff" />
              <circle cx="380" cy="55" r="5" fill="#5ef0c0" />
              <circle cx="140" cy="55" r="3" fill="#fff" opacity="0.5" />
              <circle cx="300" cy="45" r="3" fill="#fff" opacity="0.5" />
              <defs>
                <linearGradient id="g" x1="40" y1="70" x2="380" y2="55" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#5ef0c0" />
                  <stop offset="0.5" stopColor="#8b7cff" />
                  <stop offset="1" stopColor="#5ef0c0" />
                </linearGradient>
              </defs>
            </svg>
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
                <p><strong>Share code</strong></p>
                <p className="share-code">{webShare.code}</p>
                <p><strong>Link:</strong> <a href={webShare.link}>{webShare.link}</a></p>
                <div className="qr-frame">
                  <img src={webShare.qrDataUrl} alt={`QR code for ${webShare.code}`} width={128} height={128} />
                  <p>Scan on a phone to open receive instantly. Sender must stay online.</p>
                </div>
                <p><strong>This device is online.</strong> Downloads: {webShare.downloads}</p>
                <p className="live-hint">Keep this tab open while sharing.</p>
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
              <input aria-label="Paste share code or link" className="receive-input" placeholder="8-character code or link" value={webGet.status === 'idle' || webGet.status === 'resolving' || webGet.status === 'error' ? webGet.input : webGet.code} onChange={event => setWebGet({ status: 'idle', input: event.currentTarget.value })} />
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
                <p><strong>{webGet.fileName}</strong> · {typeof webGet.sizeBytes === 'number' ? formatBytes(webGet.sizeBytes) : 'size verifying with sender'}</p>
                <p className="live-hint">{webGet.devicesOnline} device online · secure transfer</p>
                <button onClick={() => void runWebGetDownload()} className="primary-button" style={{ width: '100%' }}>Download</button>
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

        {showQA && <details id="how-it-works" className="developer-panel">
          <summary>Developer and QA controls</summary>
          <section aria-label="Sender panel">
            <h2>Sender</h2>
            <p>Selected: {selectedFile?.name ?? 'No file selected'}</p>
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
        </details>}
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
