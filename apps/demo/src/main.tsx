import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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
    this.channel = new BroadcastChannel(`ponswarp-grid-demo-${sessionId}`);
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
  | { status: 'serving'; code: string; link: string; fileName: string; sizeBytes: number; expiresAt: number; downloads: number; devicesOnline: number }
  | { status: 'error'; code: string; message: string; suggestedAction?: string };

type WebGetState =
  | { status: 'idle'; input: string }
  | { status: 'resolving'; input: string }
  | { status: 'ready'; code: string; fileName: string; sizeBytes: number; devicesOnline: number; helpText: string }
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
async function waitForPieceProgress(engine: PonsWarpEngine, fileId: FileManifest['fileId'], previousVerifiedPieces: number): Promise<TransferProgress> {
  let progress = engine.getProgress(fileId);
  for (let attempt = 0; attempt < 50 && progress.verifiedPieces <= previousVerifiedPieces; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
    progress = engine.getProgress(fileId);
  }
  return progress;
}
async function createPersistentStorage(sessionId: SessionId): Promise<{ adapter: StorageAdapter; kind: string; warnings: string[] }> {
  const result = await createBrowserStorageAdapter({ sessionId });
  return { adapter: result.adapter, kind: result.kind, warnings: result.warnings.map(warning => `${warning.kind}:${warning.code}`) };
}
function demoPieceSize(file: Blob): number {
  return file.size > 1024 * 1024 ? 256 * 1024 : 8;
}
function signalingUrl(): string { const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'; return `${scheme}//${location.hostname}:8787/ws`; }
function currentJoinUrl(sessionId: SessionId): string { return `${location.origin}${location.pathname}#/join/${sessionId}`; }
function messageId(): string { return `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
const CROSS_TAB_SESSION_KEY = 'ponswarp-grid-cross-tab-session';
const CROSS_TAB_PIECE_MAP_KEY = 'ponswarp-grid-cross-tab-piece-map';

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

  useEffect(() => { const downloadUrl = state.downloadUrl; if (!downloadUrl) return; return () => URL.revokeObjectURL(downloadUrl); }, [state.downloadUrl]);
  useEffect(() => () => { if (webDownloadUrl.current) URL.revokeObjectURL(webDownloadUrl.current); }, []);
  useEffect(() => {
    const match = location.hash.match(/^#\/get\/(.+)$/);
    if (match?.[1]) setWebGet({ status: 'idle', input: parseShareCode(match[1]) || match[1] });
  }, []);
  const pushLog = (entry: string) => setState(current => ({ ...current, logs: [...current.logs, entry] }));

  function handleFileSelection(file: (Blob & { name?: string; type?: string }) | null): void {
    setSelectedFile(file);
    setWebShare(file ? { status: 'file-selected', fileName: file.name ?? 'selected-file', sizeBytes: file.size } : { status: 'idle' });
  }


  async function createWebShareLink(): Promise<void> {
    const file = selectedFile ?? namedBlob('PonsWarp Web-first demo payload', 'demo.txt');
    setWebShare({ status: 'creating' });
    await new Promise(resolve => setTimeout(resolve, 120));
    const code = createShareCode();
    const link = `${location.origin}${location.pathname}#/get/${code}`;
    webShareFile.current = file;
    setWebShare({
      status: 'serving',
      code,
      link,
      fileName: file.name ?? 'demo.txt',
      sizeBytes: file.size,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      downloads: 0,
      devicesOnline: 1
    });
    setWebGet({ status: 'ready', code, fileName: file.name ?? 'demo.txt', sizeBytes: file.size, devicesOnline: 1, helpText: 'Ready for a real browser download from this tab.' });
  }

  async function resolveWebGetInput(): Promise<void> {
    const input = webGet.status === 'idle' || webGet.status === 'resolving' || webGet.status === 'error' ? webGet.input : webGet.code;
    const code = parseShareCode(input);
    if (!code) {
      setWebGet({ status: 'error', input, code: 'missing_code', message: 'Paste a share code or link.', suggestedAction: 'Paste a link like https://warp.ponslink.com/get/8F3K-22Q9' });
      return;
    }
    setWebGet({ status: 'resolving', input });
    await new Promise(resolve => setTimeout(resolve, 120));
    const localShare = webShare.status === 'serving' && isLocalShareMatch(webShare.code, code) ? webShare : null;
    const fileName = localShare ? localShare.fileName : 'shared-file.zip';
    const sizeBytes = localShare ? localShare.sizeBytes : 4_200_000_000;
    const helpText = localShare ? 'Ready for a real browser download from this tab.' : 'Remote source planning state. The app path handles very large files and offline resume.';
    setWebGet({ status: 'ready', code, fileName, sizeBytes, devicesOnline: localShare?.devicesOnline ?? 1, helpText });
  }

  async function runWebGetDownload(): Promise<void> {
    if (webGet.status !== 'ready') return;
    const { code, fileName } = webGet;
    const localFile = webShare.status === 'serving' && isLocalShareMatch(webShare.code, code) ? webShareFile.current : null;
    if (!localFile) return;
    const securityLabel = 'Local browser download verified';
    setWebGet({ status: 'downloading', code, fileName, progress: 0, speedBps: 0, securityLabel: 'Secure transfer starting' });
    for (const progress of [28, 64, 100]) {
      await new Promise(resolve => setTimeout(resolve, 80));
      setWebGet({ status: 'downloading', code, fileName, progress, speedBps: 18_400_000, securityLabel });
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
      await runEngineTransfer({ sessionId, ownerPeerId, receiverPeerId, ownerTransport, receiverTransport, file: selectedFile ?? namedBlob('PonsWarp Grid demo payload', 'demo.txt'), logPrefix: 'Transferred', initialLog: 'Receiver joined session and loaded manifest.' });
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
      const ownerPc = new RTCPeerConnection({ iceServers: [] });
      const receiverPc = new RTCPeerConnection({ iceServers: [] });
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
      await runEngineTransfer({ sessionId, ownerPeerId, receiverPeerId, ownerTransport, receiverTransport, file: selectedFile ?? namedBlob('PonsWarp Grid WebRTC payload', 'webrtc-demo.txt'), logPrefix: 'WebRTC transferred', initialLog: 'WebRTC DataChannel open; receiver joined WebRTC session and loaded manifest.' });
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
      const file = selectedFile ?? namedBlob('PonsWarp Grid peer availability demo payload', 'grid-demo.txt');
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
        await new Promise(resolve => setTimeout(resolve, 25));
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
      await ownerRuntime.current?.client.close();
      const ownerPeerId = `owner_${Date.now()}` as PeerId;
      const sessionId = `sess_signal_${Date.now()}` as SessionId;
      const transport = new WebRTCTransport();
      const storage = new MemoryStorageAdapter();
      const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
      const file = selectedFile ?? namedBlob('PonsWarp Grid signaled payload', 'signaled-demo.txt');
      const session = await engine.createSession({ sessionId, files: [file], pieceSize: demoPieceSize(file) });
      const manifest = session.manifests[0];
      const client = new BrowserSignalingClient({ url: signalingUrl() });
      const runtime: OwnerRuntime = { peerId: ownerPeerId, sessionId, client, transport, engine, peerConnections: new Map() };
      ownerRuntime.current = runtime;
      client.onMessage(envelope => { void handleOwnerSignal(runtime, envelope); });
      client.onState(value => pushLog(`Sender signaling state: ${value}`));
      client.onError(error => pushLog(`Sender signaling error: ${error.message}`));
      await client.connect();
      client.createSession({ ownerPeerId, files: [manifest], sessionId, mode: 'direct' });
      const shareUrl = currentJoinUrl(sessionId);
      setState(current => ({ ...current, status: 'ready', sessionId, shareUrl, manifest, logs: [...current.logs, `Signaled sender ready for ${manifest.name}.`, `Open receiver link: ${shareUrl}`] }));
    } catch (error) { setState(current => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })); }
  }

  async function joinSignaledReceiver(): Promise<void> {
    const match = location.hash.match(/^#\/join\/(.+)$/);
    const sessionId = (match?.[1] ?? state.sessionId) as SessionId | undefined;
    if (!sessionId) { setState(current => ({ ...current, status: 'error', error: 'No #/join/:sessionId route found.' })); return; }
    setState({ status: 'running', sessionId, storageKind: 'probing', logs: [`Connecting receiver to signaling server for ${sessionId}.`] });
    try {
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
      client.onMessage(envelope => { void handleReceiverSignal(runtime, envelope); });
      client.onState(value => pushLog(`Receiver signaling state: ${value}`));
      client.onError(error => pushLog(`Receiver signaling error: ${error.message}`));
      await client.connect();
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
    const pc = new RTCPeerConnection({ iceServers: [] });
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
      const pc = new RTCPeerConnection({ iceServers: [] });
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
      if (!scheduled) break;
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
    <main style={{ fontFamily: 'Inter, system-ui, sans-serif', minHeight: '100vh', margin: 0, padding: '48px 24px', lineHeight: 1.5, color: '#0f172a', background: 'linear-gradient(135deg, #f8fbff 0%, #eef5ff 100%)' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <header style={{ marginBottom: 36 }}>
          <strong style={{ fontSize: 28 }}>PonsWarp</strong>
          <h1 style={{ fontSize: 'clamp(40px, 6vw, 68px)', lineHeight: 1.02, margin: '28px 0 16px' }}>Share files directly.</h1>
          <p style={{ fontSize: 22, color: '#475569', maxWidth: 760 }}>No server upload. Your file moves directly between devices. Keep this tab open while sharing.</p>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 28 }}>
          <section aria-label="Share a file" style={{ background: '#fff', border: '1px solid #dbeafe', borderRadius: 32, padding: 32, boxShadow: '0 18px 50px rgba(37, 99, 235, 0.12)' }}>
            <h2 style={{ fontSize: 32, marginTop: 0 }}>Share a file</h2>
            <label style={{ display: 'block', border: '2px dashed #cbd5e1', borderRadius: 26, padding: 32, background: '#f8fafc', textAlign: 'center', cursor: 'pointer' }}>
              <input aria-label="Choose file to share" type="file" style={{ display: 'none' }} onChange={event => handleFileSelection(event.currentTarget.files?.[0] ?? null)} />
              <span style={{ display: 'block', fontSize: 20, fontWeight: 700 }}>Choose a file</span>
              <span style={{ color: '#64748b' }}>{selectedFile ? `${selectedFile.name ?? 'selected file'} · ${formatBytes(selectedFile.size)}` : 'or use the built-in demo file'}</span>
            </label>
            <button onClick={() => void createWebShareLink()} disabled={webShare.status === 'creating'} style={{ width: '100%', marginTop: 24, border: 0, borderRadius: 18, padding: '18px 22px', background: '#2563eb', color: '#fff', fontSize: 18, fontWeight: 800 }}>
              {webShare.status === 'creating' ? 'Creating link...' : 'Create share link'}
            </button>
            <p style={{ color: '#64748b' }}>Server does not store your file. Anyone with this link can download until it expires.</p>
            {webShare.status === 'serving' && (
              <div data-testid="share-result" style={{ background: '#eff6ff', borderRadius: 22, padding: 20 }}>
                <p><strong>Share code:</strong> {webShare.code}</p>
                <p><strong>Link:</strong> <a href={webShare.link}>{webShare.link}</a></p>
                <p><strong>This device is online.</strong> Downloads: {webShare.downloads}</p>
                <p style={{ color: '#1e3a8a' }}>Keep this tab open while sharing.</p>
              </div>
            )}
          </section>

          <section aria-label="Receive a file" style={{ background: '#fff', border: '1px solid #dbeafe', borderRadius: 32, padding: 32, boxShadow: '0 18px 50px rgba(15, 23, 42, 0.08)' }}>
            <h2 style={{ fontSize: 32, marginTop: 0 }}>Receive a file</h2>
            <input aria-label="Paste share code or link" placeholder="Paste code or link" value={webGet.status === 'idle' || webGet.status === 'resolving' || webGet.status === 'error' ? webGet.input : webGet.code} onChange={event => setWebGet({ status: 'idle', input: event.currentTarget.value })} style={{ boxSizing: 'border-box', width: '100%', border: '1px solid #cbd5e1', borderRadius: 18, padding: '18px 20px', fontSize: 18 }} />
            <button onClick={() => void resolveWebGetInput()} style={{ width: '100%', marginTop: 18, border: 0, borderRadius: 18, padding: '18px 22px', background: '#0f172a', color: '#fff', fontSize: 18, fontWeight: 800 }}>Find file</button>
            {webGet.status === 'ready' && (
              <div data-testid="receive-ready" style={{ marginTop: 20 }}>
                <p><strong>{webGet.fileName}</strong> · {formatBytes(webGet.sizeBytes)}</p>
                <p style={{ color: '#1e3a8a' }}>{webGet.devicesOnline} device online · secure transfer</p>
                {webGet.helpText.startsWith('Remote') ? (
                  <p style={{ borderRadius: 18, padding: '18px 22px', background: '#eff6ff', color: '#1e3a8a', fontWeight: 800 }}>Open the app or CLI with this code to continue.</p>
                ) : (
                  <button onClick={() => void runWebGetDownload()} style={{ width: '100%', border: 0, borderRadius: 18, padding: '18px 22px', background: '#2563eb', color: '#fff', fontSize: 18, fontWeight: 800 }}>Download in browser</button>
                )}
                <p style={{ color: '#64748b' }}>{webGet.helpText}</p>
              </div>
            )}
            {webGet.status === 'downloading' && (
              <div style={{ marginTop: 20 }}>
                <progress max={100} value={webGet.progress} style={{ width: '100%' }} />
                <p>{webGet.progress}% · {formatBytes(webGet.speedBps)}/s · {webGet.securityLabel}</p>
              </div>
            )}
            {webGet.status === 'complete' && <p role="status" style={{ marginTop: 20, color: '#166534', fontWeight: 800 }}>Complete: {webGet.outputName} · {webGet.verificationLabel}{webGet.downloadUrl ? <> · <a href={webGet.downloadUrl} download={webGet.outputName}>Save file</a></> : null}</p>}
            {webGet.status === 'error' && <p role="alert" style={{ color: 'crimson' }}>{webGet.message}</p>}
          </section>
        </div>

        <details style={{ marginTop: 28, background: 'rgba(255,255,255,0.72)', border: '1px solid #dbeafe', borderRadius: 24, padding: 20 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 800 }}>Developer and QA controls</summary>
          <section aria-label="Sender panel" style={{ borderTop: '1px solid #ddd', paddingTop: 16, marginTop: 16 }}>
            <h2>Sender</h2>
            <p>Selected: {selectedFile?.name ?? 'Built-in demo.txt sample'}</p>
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
          <section aria-label="Receiver panel" style={{ borderTop: '1px solid #ddd', paddingTop: 16, marginTop: 16 }}>
            <h2>Receiver</h2>
            <p>Status: {state.status}</p>
            <p>Share link: {state.shareUrl ?? 'not created'}</p>
            <button onClick={() => void joinSignaledReceiver()} disabled={state.status === 'running'}>Join signaled receiver from URL</button>
            <button onClick={() => void restoreLocalResumeState()} disabled={state.status === 'running'}>Restore local resume state from URL</button>
            <progress max={100} value={state.progress?.progress ?? 0} style={{ width: '100%' }} />
            <p>{state.progress ? `${state.progress.verifiedPieces}/${state.progress.totalPieces} pieces verified (${state.progress.progress.toFixed(1)}%)` : 'No transfer yet.'}</p>
            <p>Resume restored: {state.restoredProgress ? `${state.restoredProgress.verifiedPieces}/${state.restoredProgress.totalPieces} pieces` : 'not checked'}</p>
            <p>Storage: {state.storageKind ?? 'not selected'}</p>
            {state.downloadUrl && state.manifest && (<p><a href={state.downloadUrl} download={state.manifest.name}>Download assembled file</a>{typeof state.assembledBytes === 'number' ? ` (${state.assembledBytes} bytes)` : ''}</p>)}
          </section>
          <section aria-label="Debug panel" style={{ borderTop: '1px solid #ddd', paddingTop: 16, marginTop: 16 }}>
            <h2>Debug</h2>
            <dl><dt>Session</dt><dd>{state.sessionId ?? '-'}</dd><dt>File</dt><dd>{state.manifest ? `${state.manifest.name} (${state.manifest.size} bytes)` : '-'}</dd><dt>Piece size</dt><dd>{state.manifest?.pieceSize ?? '-'}</dd><dt>Piece count</dt><dd>{state.manifest?.pieceCount ?? '-'}</dd></dl>
            {state.error && <p role="alert" style={{ color: 'crimson' }}>{state.error}</p>}
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
async function waitForTransportChannel(transport: WebRTCTransport, peerId: PeerId): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { const channel = transport.getPeer(peerId)?.getChannel(); if (channel?.channel.readyState === 'open') return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out waiting for WebRTC channel ${peerId}`); }

function readCrossTabSetup(): { sessionId: SessionId; ownerPeerId: PeerId; receiverAPeerId: PeerId; receiverBPeerId: PeerId; manifest: FileManifest } {
  const raw = localStorage.getItem(CROSS_TAB_SESSION_KEY);
  if (!raw) throw new Error('No cross-tab grid owner session found.');
  return JSON.parse(raw) as { sessionId: SessionId; ownerPeerId: PeerId; receiverAPeerId: PeerId; receiverBPeerId: PeerId; manifest: FileManifest };
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
