import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeJoinDescriptor, runJoin } from './cli-runtime.js';
import { CliUsageError, type DownloadCommand, type FilesCommand, type GetCommand, type JoinCommand, type NodeStartCommand, type PublishCommand, type ShareCommand } from './index.js';

interface CoordinatorEnvelope<T> {
  ok: true;
  command: string;
  coordinator: string;
  workspace: string;
  dryRun?: boolean;
  data: T;
}

interface MeshNodeRegistration {
  nodeId: string;
  displayName: string;
  publicKey: string;
  capabilities: string[];
}

interface MeshManifestSummary {
  fileId: string;
  name: string;
  size: number;
  pieceSize: number;
  pieceCount: number;
}

interface MeshDownloadPlan {
  fileId: string;
  outDir: string;
  candidates: unknown;
  status: 'planned' | 'complete';
  discovery: 'dry-run-skipped' | 'coordinator';
  execution: 'planned' | 'direct-join' | 'unavailable';
  note: string;
  transferExitCode?: number;
}

interface MeshSharePlan {
  code: string;
  link: string;
  fileId: string;
  name: string;
  size: number;
  pieceSize: number;
  pieceCount: number;
  nodeId: string;
  status: 'ready' | 'planned';
  note: string;
}

interface MeshGetPlan {
  code: string;
  fileId?: string;
  name?: string;
  sizeBytes?: number;
  outDir: string;
  candidates: unknown;
  status: 'planned' | 'complete';
  discovery: 'dry-run-skipped' | 'coordinator';
  execution: 'planned' | 'direct-join' | 'unavailable';
  note: string;
  transferExitCode?: number;
}

interface DirectTransferHint {
  join: string;
  peer?: string;
}

const CLI_CAPABILITIES = ['node-cli', 'offset-storage', 'direct-transfer', 'coordinator-mediated-transfer'];
type DirectTransferRunner = (command: JoinCommand) => Promise<number>;
let directTransferRunner: DirectTransferRunner = runJoin;

export function setDirectTransferRunnerForTest(runner: DirectTransferRunner): () => void {
  const previous = directTransferRunner;
  directTransferRunner = runner;
  return () => { directTransferRunner = previous; };
}


function nodeEndpointHints(command: NodeStartCommand): unknown[] {
  return command.directJoin
    ? [{ kind: 'ponswarp-join', value: command.directJoin }]
    : [];
}

export async function runNodeStart(command: NodeStartCommand): Promise<void> {
  const registration: MeshNodeRegistration = {
    nodeId: command.nodeId,
    displayName: command.displayName,
    publicKey: command.publicKey,
    capabilities: CLI_CAPABILITIES
  };
  const endpointHints = nodeEndpointHints(command);

  if (command.dryRun) {
    printResult(command.json, {
      ok: true,
      command: command.command,
      coordinator: command.coordinator,
      workspace: command.workspace,
      dryRun: true,
      data: { workspace: { workspaceId: command.workspace, name: command.workspace }, registration, heartbeat: { status: 'online', endpointHints } }
    });
    return;
  }

  const workspace = await ensureWorkspace(command.coordinator, command.workspace);
  const node = await coordinatorRequest<unknown>(command.coordinator, `/api/grid/v1/workspaces/${encodeURIComponent(command.workspace)}/nodes`, {
    method: 'POST',
    body: registration
  });
  const heartbeat = await coordinatorRequest<unknown>(command.coordinator, `/api/grid/v1/workspaces/${encodeURIComponent(command.workspace)}/nodes/${encodeURIComponent(command.nodeId)}/heartbeat`, {
    method: 'POST',
    body: { status: 'online', endpointHints }
  });

  printResult(command.json, {
    ok: true,
    command: command.command,
    coordinator: command.coordinator,
    workspace: command.workspace,
    data: { workspace, node, heartbeat }
  });
}

export async function runPublish(command: PublishCommand): Promise<void> {
  const manifest = await createManifestSummary(command.file, command.pieceSize);
  const payload = createPublishPayload(manifest, command.nodeId);

  if (command.dryRun) {
    printResult(command.json, {
      ok: true,
      command: command.command,
      coordinator: command.coordinator,
      workspace: command.workspace,
      dryRun: true,
      data: payload
    });
    return;
  }

  const published = await coordinatorRequest<unknown>(command.coordinator, `/api/grid/v1/workspaces/${encodeURIComponent(command.workspace)}/files`, {
    method: 'POST',
    body: payload
  });
  printResult(command.json, {
    ok: true,
    command: command.command,
    coordinator: command.coordinator,
    workspace: command.workspace,
    data: published
  });
}

export async function runFiles(command: FilesCommand): Promise<void> {
  const files = await coordinatorRequest<unknown>(command.coordinator, `/api/grid/v1/workspaces/${encodeURIComponent(command.workspace)}/files`, { method: 'GET' });
  printResult(command.json, {
    ok: true,
    command: command.command,
    coordinator: command.coordinator,
    workspace: command.workspace,
    data: files
  });
}

export async function runDownload(command: DownloadCommand): Promise<void> {
  if (command.dryRun) {
    const plan: MeshDownloadPlan = {
      fileId: command.fileId,
      outDir: command.outDir,
      candidates: { candidates: [], note: 'Dry-run skipped coordinator discovery and did not contact provider nodes.' },
      status: 'planned',
      discovery: 'dry-run-skipped',
      execution: 'planned',
      note: 'Dry run skipped candidate discovery. Run without --dry-run to discover providers and transfer.'
    };
    printResult(command.json, { ok: true, command: command.command, coordinator: command.coordinator, workspace: command.workspace, dryRun: true, data: plan });
    return;
  }
  const candidates = await coordinatorRequest<unknown>(command.coordinator, `/api/grid/v1/workspaces/${encodeURIComponent(command.workspace)}/files/${encodeURIComponent(command.fileId)}/candidates`, { method: 'GET' });
  const directTransfer = findDirectTransferHint(null, candidates);
  let transferExitCode: number | undefined;
  if (directTransfer) {
    transferExitCode = await directTransferRunner({
      command: 'join',
      session: directTransfer.join,
      signal: 'auto',
      listen: '127.0.0.1:0',
      outDir: command.outDir,
      peer: directTransfer.peer,
      seedAfterComplete: false,
      maxPeers: 8,
      transferWindow: 1,
      pathKind: 'unknown'
    });
    if (transferExitCode !== 0) throw new Error(`Direct join transfer failed with exit code ${transferExitCode}`);
  }
  const plan: MeshDownloadPlan = {
    fileId: command.fileId,
    outDir: command.outDir,
    candidates,
    status: directTransfer ? 'complete' : 'planned',
    discovery: 'coordinator',
    execution: directTransfer ? 'direct-join' : 'unavailable',
    note: directTransfer ? 'Coordinator discovered provider and direct join transfer completed.' : 'Coordinator discovered candidates, but no direct provider join hint is online yet.',
    transferExitCode
  };
  printResult(command.json, { ok: true, command: command.command, coordinator: command.coordinator, workspace: command.workspace, data: plan });
}

export async function runShare(command: ShareCommand): Promise<void> {
  const manifest = await createManifestSummary(command.file, command.pieceSize);
  const nodeId = command.nodeId ?? defaultNodeId(command.workspace);
  const code = dryRunShareCode(manifest.fileId);
  if (command.dryRun) {
    const plan: MeshSharePlan = {
      code,
      link: shareLink(command.coordinator, code),
      fileId: manifest.fileId,
      name: manifest.name,
      size: manifest.size,
      pieceSize: manifest.pieceSize,
      pieceCount: manifest.pieceCount,
      nodeId,
      status: 'planned',
      note: 'Dry run created local metadata only. Run without --dry-run to register the file metadata and share code with the coordinator.'
    };
    printResult(command.json, { ok: true, command: command.command, coordinator: command.coordinator, workspace: command.workspace, dryRun: true, data: plan });
    return;
  }

  await ensureWorkspace(command.coordinator, command.workspace);
  await coordinatorRequest<unknown>(command.coordinator, `/api/grid/v1/workspaces/${encodeURIComponent(command.workspace)}/files`, {
    method: 'POST',
    body: createPublishPayload(manifest, nodeId)
  });
  const share = await coordinatorRequest<Record<string, unknown>>(command.coordinator, `/api/grid/v1/workspaces/${encodeURIComponent(command.workspace)}/shares`, {
    method: 'POST',
    body: {
      fileId: manifest.fileId,
      createdByNodeId: nodeId,
      ttlSeconds: command.ttlSeconds,
      capabilities: { cli: true, directTransfer: true, pieceSize: manifest.pieceSize }
    }
  });
  const shareCode = String(share.code ?? code);
  const plan: MeshSharePlan = {
    code: shareCode,
    link: shareLink(command.coordinator, shareCode),
    fileId: manifest.fileId,
    name: manifest.name,
    size: manifest.size,
    pieceSize: manifest.pieceSize,
    pieceCount: manifest.pieceCount,
    nodeId,
    status: 'ready',
    note: 'Share code registered. Keep this node online and use direct send/join until coordinator-mediated provider transport is enabled.'
  };
  printResult(command.json, { ok: true, command: command.command, coordinator: command.coordinator, workspace: command.workspace, data: plan });
}

export async function runGet(command: GetCommand): Promise<void> {
  const code = parseShareCode(command.code);
  if (!code) throw new CliUsageError('get requires a share code like ABCD-1234 or a /get/ABCD-1234 link');
  if (command.dryRun) {
    const plan: MeshGetPlan = {
      code,
      outDir: command.outDir,
      candidates: { candidates: [], note: 'Dry-run skipped coordinator discovery and did not contact provider nodes.' },
      status: 'planned',
      discovery: 'dry-run-skipped',
      execution: 'planned',
      note: 'Dry run parsed the share code only. Run without --dry-run to resolve metadata and candidates.'
    };
    printResult(command.json, { ok: true, command: command.command, coordinator: command.coordinator, workspace: command.workspace, dryRun: true, data: plan });
    return;
  }

  const resolved = await coordinatorRequest<Record<string, unknown>>(command.coordinator, `/api/grid/v1/shares/${encodeURIComponent(code)}`, { method: 'GET' });
  const candidates = await coordinatorRequest<unknown>(command.coordinator, `/api/grid/v1/shares/${encodeURIComponent(code)}/candidates`, { method: 'GET' });
  const directTransfer = findDirectTransferHint(resolved, candidates);
  if (directTransfer) assertDirectTransferMatchesResolvedShare(resolved, directTransfer);
  let transferExitCode: number | undefined;
  if (directTransfer) {
    transferExitCode = await directTransferRunner(createCoordinatorJoinCommand(command, directTransfer));
    if (transferExitCode !== 0) throw new Error(`Coordinator direct join failed with exit code ${transferExitCode}`);
  }
  const plan: MeshGetPlan = {
    code,
    fileId: typeof resolved.fileId === 'string' ? resolved.fileId : undefined,
    name: typeof resolved.name === 'string' ? resolved.name : undefined,
    sizeBytes: typeof resolved.sizeBytes === 'number' ? resolved.sizeBytes : undefined,
    outDir: command.outDir,
    candidates,
    status: directTransfer ? 'complete' : 'planned',
    discovery: 'coordinator',
    execution: directTransfer ? 'direct-join' : 'unavailable',
    transferExitCode,
    note: directTransfer ? 'Share resolved and direct join transfer completed.' : 'Share resolved and candidates discovered, but no direct provider join hint is online yet.'
  };
  printResult(command.json, { ok: true, command: command.command, coordinator: command.coordinator, workspace: command.workspace, data: plan });
}

async function ensureWorkspace(coordinator: string, workspace: string): Promise<unknown> {
  return coordinatorRequest<unknown>(coordinator, '/api/grid/v1/workspaces', {
    method: 'POST',
    body: { workspaceId: workspace, name: workspace }
  });
}

function createPublishPayload(manifest: MeshManifestSummary, nodeId: string): Record<string, unknown> {
  return {
    fileId: manifest.fileId,
    name: manifest.name,
    size: manifest.size,
    pieceSize: manifest.pieceSize,
    pieceCount: manifest.pieceCount,
    manifest,
    availability: {
      nodeId,
      complete: true,
      verifiedRanges: manifest.pieceCount > 0 ? [[0, manifest.pieceCount - 1]] : []
    }
  };
}

async function createManifestSummary(filePath: string, pieceSize: number): Promise<MeshManifestSummary> {
  const absolutePath = resolve(filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`publish requires a regular file: ${filePath}`);
  const name = basename(filePath);
  const pieceCount = Math.ceil(info.size / pieceSize);
  const fileId = `file_${createHash('sha256').update(`${absolutePath}:${info.size}:${info.mtimeMs}:${pieceSize}`).digest('hex').slice(0, 24)}`;
  return {
    fileId,
    name,
    size: info.size,
    pieceSize,
    pieceCount
  };
}

const COORDINATOR_REQUEST_TIMEOUT_MS = 15_000;
const COORDINATOR_MAX_RETRIES = 1;

async function coordinatorRequest<T>(coordinator: string, path: string, options: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const url = new URL(path, normalizeCoordinator(coordinator));
  let lastError: unknown;
  for (let attempt = 0; attempt <= COORDINATOR_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COORDINATOR_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const text = await response.text();
      const payload = text.length > 0 ? safeJsonParse(text) : null;
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : text;
        throw new Error(`Coordinator ${options.method} ${url.pathname} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return payload as T;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < COORDINATOR_MAX_RETRIES && (error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError'))) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function normalizeCoordinator(coordinator: string): string {
  return coordinator.endsWith('/') ? coordinator : `${coordinator}/`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function defaultNodeId(workspace: string): string {
  return `node_${createHash('sha256').update(workspace).digest('hex').slice(0, 12)}`;
}

function dryRunShareCode(fileId: string): string {
  const suffix = createHash('sha256').update(fileId).digest('hex').slice(0, 8).toUpperCase();
  return `${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

function shareLink(coordinator: string, code: string): string {
  const url = new URL('/get/', normalizeCoordinator(coordinator));
  url.pathname = `/get/${code}`;
  return url.toString();
}

function parseShareCode(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/(?:\/get\/|ponswarp:\/\/get\/)?([A-Z0-9]{4}-[A-Z0-9]{4})$/i);
  return match?.[1].toUpperCase() ?? '';
}


export function findDirectTransferHint(_resolved: unknown, candidates: unknown): DirectTransferHint | undefined {
  const collections = [
    (candidates as { providers?: unknown[] } | null)?.providers,
    (candidates as { candidates?: unknown[] } | null)?.candidates
  ].filter(Array.isArray) as unknown[][];
  for (const collection of collections) {
    for (const provider of collection) {
      if ((provider as { online?: boolean }).online === false) continue;
      const hint = findHintInValue((provider as { endpointHints?: unknown }).endpointHints);
      if (hint?.join) return hint;
    }
  }
  return undefined;
}

function findHintInValue(value: unknown): DirectTransferHint | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value.startsWith('ponswarp://join/') ? { join: value } : undefined;
  if (Array.isArray(value)) {
    let join: string | undefined;
    let peer: string | undefined;
    for (const item of value) {
      const nested = findHintInValue(item);
      join ??= nested?.join;
      peer ??= nested?.peer;
    }
    return join ? { join, peer } : undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind : undefined;
  const raw = [record.value, record.descriptor, record.join, record.directJoin, record.ponswarpJoin].find(candidate => typeof candidate === 'string') as string | undefined;
  if (raw?.startsWith('ponswarp://join/')) return { join: raw, peer: extractPeerHint(record) };
  if ((kind === 'ponswarp-peer' || kind === 'peer') && typeof raw === 'string' && raw.startsWith('ponswarp-peer://')) return { join: '', peer: raw };
  const nested = findHintInValue(record.directTransfer) ?? findHintInValue(record.endpointHints);
  if (nested?.join) return nested;
  return undefined;
}

function extractPeerHint(record: Record<string, unknown>): string | undefined {
  for (const value of [record.peer, record.peerDescriptor]) {
    if (typeof value === 'string' && value.startsWith('ponswarp-peer://')) return value;
  }
  return undefined;
}

function assertDirectTransferMatchesResolvedShare(resolved: Record<string, unknown>, hint: DirectTransferHint): void {
  const descriptor = decodeJoinDescriptor(hint.join);
  const manifest = descriptor.manifests[0];
  const resolvedFileId = typeof resolved.fileId === 'string' ? resolved.fileId : undefined;
  const resolvedSize = typeof resolved.sizeBytes === 'number' ? resolved.sizeBytes : undefined;
  if (resolvedFileId && manifest?.fileId !== resolvedFileId) {
    throw new Error(`Coordinator candidate descriptor file mismatch: expected ${resolvedFileId}, got ${manifest?.fileId ?? 'missing'}`);
  }
  if (resolvedSize !== undefined && manifest?.size !== resolvedSize) {
    throw new Error(`Coordinator candidate descriptor size mismatch: expected ${resolvedSize}, got ${manifest?.size ?? 'missing'}`);
  }
}

function createCoordinatorJoinCommand(command: GetCommand, hint: DirectTransferHint): JoinCommand {
  return {
    command: 'join',
    session: hint.join,
    signal: 'auto',
    listen: '127.0.0.1:0',
    outDir: command.outDir,
    peer: hint.peer,
    seedAfterComplete: false,
    maxPeers: 8,
    transferWindow: 1,
    pathKind: 'unknown'
  };
}
function printResult<T>(json: boolean, envelope: CoordinatorEnvelope<T>): void {
  if (json) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  console.log(`${envelope.command}: ok`);
  console.log(`Coordinator: ${envelope.coordinator}`);
  console.log(`Workspace: ${envelope.workspace}`);
  if (envelope.dryRun) console.log('Dry run: true');
  console.log(JSON.stringify(envelope.data, null, 2));
}
