export type DirectRunOutcome = 'succeeded' | 'failed' | 'cancelled';
export type ControllerState = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type DirectRunPath = 'direct-host' | 'direct-srflx' | 'relay-udp' | 'relay-tcp' | 'relay-tls' | 'unknown' | 'unavailable';
export type Counts = {
  scheduled: number; verified: number; retries: number; timeouts: number; rejects: number;
  sendFailures: number; invalidChunks: number; cancellations: number; watermarkHigh: number;
  watermarkLow: number; storageWrites: number; resumeValidations: number; resumeFailures: number;
  integrityFailures: number; framingFailures: number; lifecycleLeaks: number;
};

type Common = { seq: number; atMs: number };
export type DirectRunEvent = Common & (
  | { type: 'controller'; state: ControllerState }
  | { type: 'scheduled'; requested: number; outstandingAfter: number }
  | { type: 'terminal'; reason: 'verified' | 'acknowledged' | 'send_failed' | 'request_timeout' | 'cancelled' | 'provider_reject' | 'hash_mismatch' | 'invalid_chunk'; retryCount: number; willRetry: boolean }
  | { type: 'window_exhausted' }
  | { type: 'watermark'; level: 'high' | 'low'; bufferedAmount: number; highWaterMark: number; lowWaterMark: number }
  | { type: 'storage_write'; bytes: number }
  | { type: 'resume_validation'; verifiedPieces: number; discardedPieces: number; status: 'passed' | 'failed' }
  | { type: 'lifecycle'; status: 'flush_started' | 'flush_completed' | 'dispose_completed'; outstandingDirect: number; activeTimers: number }
  | { type: 'direct_lifecycle_error'; phase: 'send' | 'receive' | 'storage' | 'persist' | 'finalize'; code: string }
);
type WithoutSequence<T> = T extends unknown ? Omit<T, 'seq'> : never;
export type DirectArtifactEventInput = WithoutSequence<DirectRunEvent>;

export type DirectRunArtifact = {
  schema: 'ponswarp-grid.direct-transfer-run/v2'; runId: string; suiteId: string; fixtureId: string; fixtureSha256: string;
  pairId: string; stratum: string; attempt: number; buildSha: string; window: 1 | 2;
  startedAtMs: number; endedAtMs: number; outcome: DirectRunOutcome;
  environment: { browserFamilyMajor: string; storageKind: string };
  path: DirectRunPath;
  transfer: { fileBytes: number; pieceBytes: number; pieceCount: number; hashMode: 'sha256' | 'none' };
  counts: Counts; events: DirectRunEvent[];
};

const COUNT_KEYS: (keyof Counts)[] = ['scheduled', 'verified', 'retries', 'timeouts', 'rejects', 'sendFailures', 'invalidChunks', 'cancellations', 'watermarkHigh', 'watermarkLow', 'storageWrites', 'resumeValidations', 'resumeFailures', 'integrityFailures', 'framingFailures', 'lifecycleLeaks'];
const terminalReasons = new Set(['verified', 'acknowledged', 'send_failed', 'request_timeout', 'cancelled', 'provider_reject', 'hash_mismatch', 'invalid_chunk']);
const phases = new Set(['send', 'receive', 'storage', 'persist', 'finalize']);
const states = new Set(['idle', 'starting', 'running', 'succeeded', 'failed', 'cancelled']);
const id = /^[A-Za-z0-9._:-]{1,128}$/;
const sha = /^[a-f0-9]{64}$/;
const emptyCounts = (): Counts => Object.fromEntries(COUNT_KEYS.map(key => [key, 0])) as Counts;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function createDirectRunArtifact(runId: string, provenance?: Partial<DirectRunArtifact>): DirectRunArtifact {
  if (!id.test(runId)) throw new Error('invalid run id');
  const now = Date.now();
  return {
    schema: 'ponswarp-grid.direct-transfer-run/v2', runId, suiteId: provenance?.suiteId ?? 'local', fixtureId: provenance?.fixtureId ?? 'direct',
    fixtureSha256: provenance?.fixtureSha256 ?? '0'.repeat(64), pairId: provenance?.pairId ?? 'local', stratum: provenance?.stratum ?? 'unavailable',
    attempt: provenance?.attempt ?? 1, buildSha: provenance?.buildSha ?? 'local', window: provenance?.window ?? 1, startedAtMs: provenance?.startedAtMs ?? now,
    endedAtMs: provenance?.endedAtMs ?? now, outcome: provenance?.outcome ?? 'failed', environment: provenance?.environment ?? { browserFamilyMajor: 'unknown', storageKind: 'unknown' },
    path: provenance?.path ?? 'unavailable', transfer: provenance?.transfer ?? { fileBytes: 0, pieceBytes: 0, pieceCount: 0, hashMode: 'none' }, counts: emptyCounts(), events: []
  };
}

export function appendDirectArtifactEvent(artifact: DirectRunArtifact, event: DirectArtifactEventInput): DirectRunArtifact {
  if (artifact.events.some(item => item.type === 'lifecycle' && item.status === 'dispose_completed')) throw new Error('artifact already disposed');
  const normalized = normalizeEvent(event, artifact.startedAtMs);
  const next: DirectRunEvent = { ...normalized, seq: artifact.events.length + 1 } as DirectRunEvent;
  if (!eventValid(next)) throw new Error('invalid artifact event');
  const events = [...artifact.events, next];
  return { ...artifact, endedAtMs: Math.max(artifact.endedAtMs, next.atMs), counts: deriveCounts(events), events };
}

function normalizeEvent(event: DirectArtifactEventInput, startedAtMs: number): WithoutSequence<DirectRunEvent> {
  const atMs = event.atMs < startedAtMs ? startedAtMs + event.atMs : event.atMs;
  return { ...event, atMs };
}

export type CleanupEvidence = { engineDisposed: boolean; flushCompleted: boolean; outstandingDirect: number; activeTimers: number };

export function completeDirectRunArtifact(artifact: DirectRunArtifact, evidence: CleanupEvidence, outcome: DirectRunOutcome = artifact.outcome, finalState: ControllerState = outcome): DirectRunArtifact {
  if (!evidence.engineDisposed || !evidence.flushCompleted || evidence.outstandingDirect !== 0 || evidence.activeTimers !== 0) throw new Error('direct cleanup evidence is not clean');
  if (outcome === 'succeeded' && (artifact.counts.verified !== artifact.transfer.pieceCount || !artifact.events.some(event => event.type === 'resume_validation' && event.status === 'passed' && event.verifiedPieces === artifact.transfer.pieceCount && event.discardedPieces === 0))) throw new Error('succeeded direct run requires verified pieces and clean resume validation');
  let next = artifact;
  const completionAt = Math.max(Date.now(), artifact.endedAtMs);
  if (!next.events.some(event => event.type === 'controller' && event.state === finalState)) next = appendDirectArtifactEvent(next, { type: 'controller', state: finalState, atMs: completionAt });
  next = appendDirectArtifactEvent(next, { type: 'lifecycle', status: 'dispose_completed', outstandingDirect: evidence.outstandingDirect, activeTimers: evidence.activeTimers, atMs: completionAt });
  return { ...next, outcome, endedAtMs: next.events[next.events.length - 1].atMs, counts: deriveCounts(next.events) };
}

function eventValid(event: DirectRunEvent): boolean {
  if (!integer(event.seq) || !integer(event.atMs) || typeof event.type !== 'string') return false;
  if (event.type === 'controller') return states.has(event.state);
  if (event.type === 'scheduled') return integer(event.requested) && integer(event.outstandingAfter);
  if (event.type === 'terminal') return terminalReasons.has(event.reason) && integer(event.retryCount) && typeof event.willRetry === 'boolean';
  if (event.type === 'window_exhausted') return true;
  if (event.type === 'watermark') return (event.level === 'high' || event.level === 'low') && integer(event.bufferedAmount) && integer(event.highWaterMark) && integer(event.lowWaterMark);
  if (event.type === 'storage_write') return integer(event.bytes);
  if (event.type === 'resume_validation') return integer(event.verifiedPieces) && integer(event.discardedPieces) && (event.status === 'passed' || event.status === 'failed');
  if (event.type === 'lifecycle') return ['flush_started', 'flush_completed', 'dispose_completed'].includes(event.status) && integer(event.outstandingDirect) && integer(event.activeTimers);
  if (event.type === 'direct_lifecycle_error') return phases.has(event.phase) && id.test(event.code);
  return false;
}

function deriveCounts(events: DirectRunEvent[]): Counts {
  const counts = emptyCounts();
  for (const event of events) {
    if (event.type === 'scheduled') counts.scheduled += event.requested;
    if (event.type === 'terminal') {
      if (event.reason === 'verified') counts.verified++;
      if (event.willRetry) counts.retries++;
      if (event.reason === 'request_timeout') counts.timeouts++;
      if (event.reason === 'provider_reject') counts.rejects++;
      if (event.reason === 'send_failed') counts.sendFailures++;
      if (event.reason === 'invalid_chunk') counts.invalidChunks++;
      if (event.reason === 'cancelled') counts.cancellations++;
      if (event.reason === 'hash_mismatch') counts.integrityFailures++;
    }
    if (event.type === 'watermark') counts[event.level === 'high' ? 'watermarkHigh' : 'watermarkLow']++;
    if (event.type === 'storage_write') counts.storageWrites++;
    if (event.type === 'resume_validation') { counts.resumeValidations++; if (event.status === 'failed') counts.resumeFailures++; }
    if (event.type === 'direct_lifecycle_error') { counts.lifecycleLeaks++; if (event.phase === 'receive') counts.framingFailures++; else if (event.phase === 'storage' || event.phase === 'persist') counts.integrityFailures++; }
  }
  const disposals = events.filter((event): event is Extract<DirectRunEvent, { type: 'lifecycle' }> => event.type === 'lifecycle' && event.status === 'dispose_completed');
  counts.lifecycleLeaks = counts.lifecycleLeaks > 0 || disposals.length !== 1 || disposals[0]?.outstandingDirect !== 0 || disposals[0]?.activeTimers !== 0 ? 1 : 0;
  return counts;
}

export function validateDirectRunArtifact(value: unknown): value is DirectRunArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as DirectRunArtifact;
  const rootKeys = ['schema', 'runId', 'suiteId', 'fixtureId', 'fixtureSha256', 'pairId', 'stratum', 'attempt', 'buildSha', 'window', 'startedAtMs', 'endedAtMs', 'outcome', 'environment', 'path', 'transfer', 'counts', 'events'];
  if (!exactKeys(artifact, rootKeys) || !exactKeys(artifact.environment, ['browserFamilyMajor', 'storageKind']) || !exactKeys(artifact.transfer, ['fileBytes', 'pieceBytes', 'pieceCount', 'hashMode']) || !exactKeys(artifact.counts, COUNT_KEYS) || !Array.isArray(artifact.events)) return false;
  if (artifact.events.some(event => !event || typeof event !== 'object' || !exactKeys(event, eventKeys(event)))) return false;
  if (artifact.schema !== 'ponswarp-grid.direct-transfer-run/v2' || !id.test(artifact.runId) || !id.test(artifact.suiteId) || !id.test(artifact.fixtureId) || !sha.test(artifact.fixtureSha256) || !id.test(artifact.pairId) || !id.test(artifact.stratum) || !id.test(artifact.buildSha) || ![1, 2].includes(artifact.window) || !integer(artifact.attempt) || artifact.attempt < 1 || artifact.attempt > 10 || !integer(artifact.startedAtMs) || !integer(artifact.endedAtMs) || artifact.endedAtMs < artifact.startedAtMs || !['succeeded', 'failed', 'cancelled'].includes(artifact.outcome)) return false;
  if (!artifact.environment || !id.test(artifact.environment.browserFamilyMajor) || !id.test(artifact.environment.storageKind) || !['direct-host', 'direct-srflx', 'relay-udp', 'relay-tcp', 'relay-tls', 'unknown', 'unavailable'].includes(artifact.path)) return false;
  if (!artifact.transfer || !integer(artifact.transfer.fileBytes) || !integer(artifact.transfer.pieceBytes) || !integer(artifact.transfer.pieceCount) || !['sha256', 'none'].includes(artifact.transfer.hashMode)) return false;
  if (!artifact.events.length || artifact.events.some((event, index) => !eventValid(event) || event.seq !== index + 1 || event.atMs < artifact.startedAtMs || event.atMs > artifact.endedAtMs)) return false;
  const disposals = artifact.events.filter((event): event is Extract<DirectRunEvent, { type: 'lifecycle' }> => event.type === 'lifecycle' && event.status === 'dispose_completed');
  const lastController = [...artifact.events].reverse().find(event => event.type === 'controller');
  const terminalControllerState = lastController?.type === 'controller' && (lastController.state === 'succeeded' || lastController.state === 'failed' || lastController.state === 'cancelled') ? lastController.state : undefined;
  if (disposals.length !== 1 || disposals[0] !== artifact.events[artifact.events.length - 1] || terminalControllerState === undefined || artifact.outcome !== terminalControllerState) return false;
  if (artifact.outcome !== 'succeeded' && artifact.events.some(event => event.type === 'controller' && event.state === 'succeeded')) return false;
  if (artifact.outcome === 'succeeded' && artifact.counts.resumeFailures + artifact.counts.integrityFailures + artifact.counts.framingFailures > 0) return false;
  if (artifact.outcome === 'succeeded' && (artifact.counts.verified !== artifact.transfer.pieceCount || !artifact.events.some(event => event.type === 'resume_validation' && event.status === 'passed' && event.verifiedPieces === artifact.transfer.pieceCount && event.discardedPieces === 0))) return false;
  return JSON.stringify(artifact.counts) === JSON.stringify(deriveCounts(artifact.events));
}

export function directArtifactCounts(artifact: DirectRunArtifact): Counts { return deriveCounts(artifact.events); }
function eventKeys(event: unknown): string[] {
  const type = event && typeof event === 'object' && 'type' in event ? (event as { type?: unknown }).type : undefined;
  const common = ['seq', 'atMs'];
  if (type === 'controller') return [...common, 'type', 'state'];
  if (type === 'scheduled') return [...common, 'type', 'requested', 'outstandingAfter'];
  if (type === 'terminal') return [...common, 'type', 'reason', 'retryCount', 'willRetry'];
  if (type === 'window_exhausted') return [...common, 'type'];
  if (type === 'watermark') return [...common, 'type', 'level', 'bufferedAmount', 'highWaterMark', 'lowWaterMark'];
  if (type === 'storage_write') return [...common, 'type', 'bytes'];
  if (type === 'resume_validation') return [...common, 'type', 'verifiedPieces', 'discardedPieces', 'status'];
  if (type === 'lifecycle') return [...common, 'type', 'status', 'outstandingDirect', 'activeTimers'];
  if (type === 'direct_lifecycle_error') return [...common, 'type', 'phase', 'code'];
  return [];
}
function exactKeys(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}
