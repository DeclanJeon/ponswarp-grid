import type { DirectLifecycleErrorEvent, DirectTerminalEvent, DirectWindowExhaustedEvent, FileId, PeerId, PerformanceEvent, PieceWindowOptions, PonsWarpEngine, TransferProgress } from '@ponswarp/core';
import { appendDirectArtifactEvent, completeDirectRunArtifact, createDirectRunArtifact, type DirectRunArtifact } from './direct-transfer-artifacts';

export type DirectRequestOptions = PieceWindowOptions & { timeoutMs?: number };
export type DirectLifecycleEvents = { requestTerminal: (event: DirectTerminalEvent) => void; requestWindowExhausted: (event: DirectWindowExhaustedEvent) => void; directLifecycleError: (event: DirectLifecycleErrorEvent) => void };
export type DirectControllerState = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type DeferredLifecycleEvent =
  | { kind: 'terminal'; event: DirectTerminalEvent }
  | { kind: 'exhausted'; event: DirectWindowExhaustedEvent }
  | { kind: 'error'; event: DirectLifecycleErrorEvent };
type Active = { fileId: FileId; peerId: PeerId; controllerId: string; generation?: number; scheduled: number; terminals: DirectTerminalEvent[]; deferred: DeferredLifecycleEvent[]; resolve: (value: DirectTerminalEvent[]) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
type Engine = Pick<PonsWarpEngine, 'requestPieceWindow' | 'getProgress' | 'getOutstandingRequestCount' | 'getDirectLifecycleSnapshot' | 'getDirectWindowGeneration' | 'on' | 'cancelDirectRequests' | 'flushDirectLifecycle' | 'dispose'>;
type EventHandler<K extends keyof DirectLifecycleEvents> = DirectLifecycleEvents[K];
type CleanupResult = { failed: boolean; error?: unknown };
type Options = { signal?: AbortSignal; onTransportFatal?: (handler: (error: { peerId?: PeerId; error: Error }) => void) => () => void };
export type DirectTransferMetrics = {
  startedAtMs: number;
  endedAtMs?: number;
  durationMs?: number;
  state: DirectControllerState;
  outcome?: DirectRunArtifact['outcome'];
  payloadBytes: number;
  wireBytes?: number;
  payloadGoodputBps?: number;
  selectedIcePair?: { localCandidateType?: string; remoteCandidateType?: string; protocol?: string };
  rttMs?: number;
  effectiveWindow?: number;
  pieceTiming?: { count: number; firstAtMs?: number; lastAtMs?: number; durationMs?: number };
  storageTiming?: { writes: number; bytes: number; durationMs?: number };
  disposed: boolean;
};

export type TransferMetricInput = {
  payloadBytes?: number;
  wireBytes?: number;
  payloadGoodputBps?: number;
  selectedIcePair?: DirectTransferMetrics['selectedIcePair'];
  rttMs?: number;
  effectiveWindow?: number;
  pieceTiming?: DirectTransferMetrics['pieceTiming'];
  storageTiming?: DirectTransferMetrics['storageTiming'];
};

export class DirectTransferController {
  private readonly subscriptions: Array<() => void> = [];
  private readonly listeners: Partial<DirectLifecycleEvents> = {};
  private readonly pending = new Map<string, Active>();
  private readonly controllerIds = new Set<string>(['browser-direct']);
  private disposed = false;
  private cleanupQueue: Promise<void> = Promise.resolve();
  private disposalPromise?: Promise<void>;
  private artifact: DirectRunArtifact;
  private state: DirectControllerState = 'idle';
  private readonly metricsStartedAtMs = Date.now();
  private transferStartedAtMs?: number;
  private metrics: DirectTransferMetrics = { startedAtMs: this.metricsStartedAtMs, state: 'idle', payloadBytes: 0, disposed: false };

  constructor(private readonly engine: Engine, runId = `run_${Date.now()}`, options: Options = {}) {
    this.artifact = appendDirectArtifactEvent(createDirectRunArtifact(runId), { type: 'controller', state: 'idle', atMs: Date.now() });
    this.subscriptions.push(engine.on('requestTerminal', event => this.handleTerminal(event)));
    this.subscriptions.push(engine.on('requestWindowExhausted', event => this.handleExhausted(event)));
    this.subscriptions.push(engine.on('directLifecycleError', event => this.handleError(event)));
    this.subscriptions.push(engine.on('performance', event => this.handlePerformance(event)));
    if (options.onTransportFatal) this.subscriptions.push(options.onTransportFatal(({ peerId, error }) => this.failPeer(peerId, error)));
    if (options.signal) {
      const abort = () => {
        this.setState('cancelled');
        for (const windowKey of [...this.pending.keys()]) void this.failWindow(windowKey, new Error('direct transfer aborted'), 'cancelled');
      };
      options.signal.addEventListener('abort', abort, { once: true });
      this.subscriptions.push(() => options.signal?.removeEventListener('abort', abort));
      if (options.signal.aborted) abort();
    }
  }
  on<K extends keyof DirectLifecycleEvents>(event: K, handler: EventHandler<K>): () => void { const previous = this.listeners[event]; this.listeners[event] = handler; return () => { if (this.listeners[event] === handler) this.listeners[event] = previous; }; }
  getState(): DirectControllerState { return this.state; }
  setTransfer(transfer: DirectRunArtifact['transfer']): void { this.artifact = { ...this.artifact, transfer }; }
  beginTransferMetrics(): void { if (!this.disposed && this.transferStartedAtMs === undefined) this.transferStartedAtMs = performance.now(); }
  endTransferMetrics(): void {
    if (this.disposed || this.transferStartedAtMs === undefined) return;
    const durationMs = Math.max(0, performance.now() - this.transferStartedAtMs);
    this.metrics = {
      ...this.metrics,
      pieceTiming: { ...(this.metrics.pieceTiming ?? { count: 0 }), durationMs },
      payloadGoodputBps: durationMs > 0 ? Math.round(this.metrics.payloadBytes * 1000 / durationMs) : undefined
    };
  }
  recordResumeValidation(verifiedPieces: number, discardedPieces: number, status: 'passed' | 'failed'): void { this.artifact = appendDirectArtifactEvent(this.artifact, { type: 'resume_validation', verifiedPieces, discardedPieces, status, atMs: Date.now() }); }
  recordMetrics(input: TransferMetricInput): void {
    if (this.disposed) return;
    const selectedIcePair = input.selectedIcePair ? {
      localCandidateType: input.selectedIcePair.localCandidateType,
      remoteCandidateType: input.selectedIcePair.remoteCandidateType,
      protocol: input.selectedIcePair.protocol
    } : this.metrics.selectedIcePair;
    this.metrics = {
      ...this.metrics,
      payloadBytes: input.payloadBytes ?? this.metrics.payloadBytes,
      wireBytes: input.wireBytes ?? this.metrics.wireBytes,
      payloadGoodputBps: input.payloadGoodputBps ?? this.metrics.payloadGoodputBps,
      selectedIcePair,
      rttMs: input.rttMs ?? this.metrics.rttMs,
      effectiveWindow: input.effectiveWindow ?? this.metrics.effectiveWindow,
      pieceTiming: input.pieceTiming ?? this.metrics.pieceTiming,
      storageTiming: input.storageTiming ?? this.metrics.storageTiming,
      state: this.state
    };
  }
  getMetrics(): DirectTransferMetrics { return JSON.parse(JSON.stringify(this.metrics)) as DirectTransferMetrics; }
  serializeMetrics(): string { return JSON.stringify(this.getMetrics()); }

  async requestWindow(peerId: PeerId, fileId: FileId, options: DirectRequestOptions = {}): Promise<DirectTerminalEvent[]> {
    this.assertActive();
    this.setState('starting');
    const controllerId = options.controllerId ?? 'browser-direct';
    this.controllerIds.add(controllerId);
    const windowKey = options.windowKey ?? `${String(fileId)}:${String(peerId)}:${controllerId}`;
    if (this.pending.has(windowKey)) throw new Error(`direct request window already active: ${windowKey}`);
    let resolve!: Active['resolve']; let reject!: Active['reject'];
    const result = new Promise<DirectTerminalEvent[]>((a, b) => { resolve = a; reject = b; }); void result.catch(() => undefined);
    const timer = setTimeout(() => { void this.failWindow(windowKey, new Error('direct request window timeout')); }, options.timeoutMs ?? 30_000);
    this.pending.set(windowKey, { fileId, peerId, controllerId, scheduled: 0, terminals: [], deferred: [], resolve, reject, timer });
    try {
      const scheduled = await this.engine.requestPieceWindow(peerId, fileId, { ...options, windowKey, controllerId, maxInFlight: options.maxInFlight ?? 1 });
      const active = this.pending.get(windowKey);
      if (active) {
        active.scheduled = scheduled.length;
        active.generation = this.engine.getDirectWindowGeneration(windowKey);
        const deferred = active.deferred.splice(0);
        for (const item of deferred) {
          if (item.kind === 'terminal') this.handleTerminal(item.event);
          else if (item.kind === 'exhausted') this.handleExhausted(item.event);
          else this.handleError(item.event);
        }
        this.completeWindowIfSettled(windowKey, active);
      }
      this.artifact = appendDirectArtifactEvent(this.artifact, { type: 'scheduled', requested: scheduled.length, outstandingAfter: this.engine.getOutstandingRequestCount(fileId, peerId), atMs: Date.now() });
      if (!scheduled.length && this.engine.getOutstandingRequestCount(fileId, peerId) === 0) {
        await this.engine.flushDirectLifecycle();
        const outstandingAfterFlush = this.engine.getOutstandingRequestCount(fileId, peerId);
        const pending = this.pending.get(windowKey);
        if (pending && outstandingAfterFlush > 0) pending.scheduled = outstandingAfterFlush;
        if (outstandingAfterFlush === 0) await this.failWindow(windowKey, new Error('direct request window exhausted'));
      }
      return await result;
    } catch (error) {
      const cleanup = await this.failWindow(windowKey, error);
      if (cleanup.failed) {
        throw new AggregateError([error, cleanup.error], 'direct request setup and cleanup failed', { cause: error });
      }
      throw error;
    }
  }
  async cancelDirectRequests(controllerId = 'browser-direct'): Promise<void> { this.engine.cancelDirectRequests({ controllerId }); await this.engine.flushDirectLifecycle(); }
  async flushDirectLifecycle(): Promise<void> { await this.engine.flushDirectLifecycle(); }
  async dispose(outcome: DirectRunArtifact['outcome'] = 'failed'): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposalPromise = this.disposeSerialized(outcome);
    return this.disposalPromise;
  }
  private async disposeSerialized(outcome: DirectRunArtifact['outcome']): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.setState(outcome === 'succeeded' ? 'succeeded' : outcome === 'cancelled' ? 'cancelled' : 'failed');
    const finalOutcome: DirectRunArtifact['outcome'] = this.state === 'succeeded' ? 'succeeded' : this.state === 'cancelled' ? 'cancelled' : 'failed';
    const endedAtMs = Date.now();
    const durationMs = Math.max(0, endedAtMs - this.metricsStartedAtMs);
    this.metrics = { ...this.metrics, endedAtMs, durationMs, state: this.state, outcome: finalOutcome, disposed: true };
    const controllerIds = [...this.controllerIds];
    for (const active of this.pending.values()) {
      clearTimeout(active.timer);
      active.reject(new Error('direct transfer disposed'));
    }
    this.pending.clear();

    let cleanupError: unknown;
    this.cleanupQueue = this.cleanupQueue.catch(() => undefined).then(async () => {
      try {
        for (const controllerId of controllerIds) this.engine.cancelDirectRequests({ controllerId });
      } catch (error) {
        cleanupError = error;
      }
      try {
        await this.engine.flushDirectLifecycle();
      } catch (error) {
        cleanupError ??= error;
      }

      const snapshot = this.engine.getDirectLifecycleSnapshot();
      try {
        await this.engine.dispose();
      } catch (error) {
        cleanupError ??= error;
      } finally {
        for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
      }

      if (cleanupError !== undefined) throw cleanupError;
      this.artifact = completeDirectRunArtifact(
        this.artifact,
        { engineDisposed: true, flushCompleted: true, ...snapshot },
        finalOutcome,
        this.state
      );
    });
    await this.cleanupQueue;
  }
  getRunArtifact(): DirectRunArtifact { return this.artifact; }
  getProgress(fileId: FileId): TransferProgress { return this.engine.getProgress(fileId); }
  private handlePerformance(event: PerformanceEvent): void {
    if (event.type !== 'storage:write') return;
    const current = this.metrics.storageTiming ?? { writes: 0, bytes: 0, durationMs: 0 };
    this.recordMetrics({
      storageTiming: {
        writes: current.writes + 1,
        bytes: current.bytes + event.bytes,
        durationMs: (current.durationMs ?? 0) + event.durationMs
      }
    });
  }
  private assertActive(): void { if (this.disposed || this.state === 'cancelled' || this.state === 'failed' || this.state === 'succeeded') throw new Error('direct transfer controller disposed or terminal'); }
  private setState(state: DirectControllerState): void {
    if (this.state === state) return;
    if (this.state === 'failed' || this.state === 'cancelled' || this.state === 'succeeded') return;
    this.state = state;
    this.metrics = { ...this.metrics, state };
    this.artifact = appendDirectArtifactEvent(this.artifact, { type: 'controller', state, atMs: Date.now() });
  }
  private async failWindow(windowKey: string, error: unknown, state: 'failed' | 'cancelled' = 'failed'): Promise<CleanupResult> {
    let result: CleanupResult = { failed: false };
    this.cleanupQueue = this.cleanupQueue.catch(() => undefined).then(async () => {
      const active = this.pending.get(windowKey);
      if (!active) return;
      clearTimeout(active.timer);
      this.pending.delete(windowKey);
      let rejection = error;
      try {
        this.engine.cancelDirectRequests({ windowKey });
      } catch (cancelError) {
        rejection = cancelError;
        result = { failed: true, error: cancelError };
      }
      try {
        await this.engine.flushDirectLifecycle();
      } catch (flushError) {
        rejection = flushError;
        result = { failed: true, error: flushError };
      }
      this.setState(state);
      active.reject(rejection);
    });
    await this.cleanupQueue;
    return result;
  }
  private failPeer(peerId: PeerId | undefined, error: Error): void { for (const [key, active] of this.pending) if (!peerId || active.peerId === peerId) void this.failWindow(key, error); }
  private handleTerminal(event: DirectTerminalEvent): void {
    const active = this.pending.get(event.windowKey);
    if (active && this.matchesActiveIdentity(active, event) && active.generation === undefined) {
      active.deferred.push({ kind: 'terminal', event });
      return;
    }
    this.emit('requestTerminal', event);
    if (!active || !this.matchesActive(active, event)) return;
    active.terminals.push(event);
    this.artifact = appendDirectArtifactEvent(this.artifact, { type: 'terminal', reason: event.reason, retryCount: event.retryCount, willRetry: event.willRetry, atMs: event.at });
    this.completeWindowIfSettled(event.windowKey, active);
  }
  private completeWindowIfSettled(windowKey: string, active: Active): void {
    const terminalCount = active.terminals.filter(item => !item.willRetry).length;
    if (active.scheduled === 0 || terminalCount < active.scheduled) return;
    clearTimeout(active.timer);
    this.pending.delete(windowKey);
    this.setState('running');
    active.resolve(active.terminals);
  }
  private handleExhausted(event: DirectWindowExhaustedEvent): void {
    const active = this.pending.get(event.windowKey);
    if (active && this.matchesActiveIdentity(active, event) && active.generation === undefined) {
      active.deferred.push({ kind: 'exhausted', event });
      return;
    }
    this.emit('requestWindowExhausted', event);
    if (!active || !this.matchesActive(active, event)) return;
    this.artifact = appendDirectArtifactEvent(this.artifact, { type: 'window_exhausted', atMs: event.at });
    void this.failWindow(event.windowKey, new Error(`direct window exhausted: ${event.reason}`));
  }
  private handleError(event: DirectLifecycleErrorEvent): void {
    const active = this.pending.get(event.windowKey);
    if (active && this.matchesActiveIdentity(active, event) && active.generation === undefined) {
      active.deferred.push({ kind: 'error', event });
      return;
    }
    this.emit('directLifecycleError', event);
    if (!active || !this.matchesActive(active, event)) return;
    this.artifact = appendDirectArtifactEvent(this.artifact, { type: 'direct_lifecycle_error', phase: event.phase, code: event.code, atMs: event.at });
    void this.failWindow(event.windowKey, new Error(event.message));
  }
  private matchesActiveIdentity(active: Active, event: { fileId: FileId; peerId: PeerId; controllerId?: string }): boolean {
    return event.fileId === active.fileId
      && event.peerId === active.peerId
      && event.controllerId === active.controllerId;
  }
  private matchesActive(active: Active, event: { fileId: FileId; peerId: PeerId; controllerId?: string; generation: number }): boolean {
    return this.matchesActiveIdentity(active, event)
      && active.generation !== undefined
      && event.generation === active.generation;
  }
  private emit<K extends keyof DirectLifecycleEvents>(event: K, value: Parameters<DirectLifecycleEvents[K]>[0]): void { const handler = this.listeners[event] as ((value: Parameters<DirectLifecycleEvents[K]>[0]) => void) | undefined; if (handler) handler(value); }
}
