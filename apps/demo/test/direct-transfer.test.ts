import { describe, expect, it, vi } from 'vitest';
import type { DirectLifecycleErrorEvent, DirectTerminalEvent, DirectWindowExhaustedEvent, FileId, PeerId, PerformanceEvent } from '@ponswarp/core';
import { DirectTransferController } from '../src/direct-transfer-controller';
import { appendDirectArtifactEvent, completeDirectRunArtifact, createDirectRunArtifact, directArtifactCounts, validateDirectRunArtifact } from '../src/direct-transfer-artifacts';
import { parseRuntimeConfig, resolveTransferWindow } from '../src/transfer-release-config';
import { calculatePieceSize, SMALL_FILE_PIECE_SIZE } from '../src/constants';

const valid = { schema: 'ponswarp-grid.runtime-config/v1', directTransfer: { window: 2, hold: false, qaBuild: true, allowDiagnosticWindow2: true, rolloutId: 'qa-1' } } as const;
const fileId = 'file' as FileId;
const peerId = 'peer' as PeerId;
const cleanCleanup = { engineDisposed: true, flushCompleted: true, outstandingDirect: 0, activeTimers: 0 } as const;

type EventName = 'requestTerminal' | 'requestWindowExhausted' | 'directLifecycleError' | 'performance';
type EventValue = DirectTerminalEvent | DirectWindowExhaustedEvent | DirectLifecycleErrorEvent | PerformanceEvent;
class FakeEngine {
  private readonly handlers = new Map<EventName, (event: EventValue) => void>();
  cancelled: Array<Record<string, string>> = [];
  flushes = 0;
  disposed = false;
  on(name: EventName, handler: (event: EventValue) => void): () => void { this.handlers.set(name, handler); return () => this.handlers.delete(name); }
  emit(name: EventName, event: EventValue): void { this.handlers.get(name)?.(event); }
  requestPieceWindow = vi.fn(async () => []);
  getOutstandingRequestCount = vi.fn(() => 0);
  cancelDirectRequests = (options: Record<string, string>): void => { this.cancelled.push(options); };
  flushDirectLifecycle = vi.fn(async () => { this.flushes++; });
  dispose = vi.fn(async () => { this.disposed = true; });
  getDirectLifecycleSnapshot = vi.fn(() => ({ outstandingDirect: 0, activeTimers: 0 }));
  getDirectWindowGeneration = vi.fn(() => 0);
  getProgress = vi.fn(() => ({ completedPieces: 0, totalPieces: 0, bytesReceived: 0, totalBytes: 0 }));
}

describe('direct transfer release seams', () => {
  it('fails closed and denies URL bypass without release authorization', () => {
    expect(parseRuntimeConfig({ ...valid, unknown: true })).toBeNull();
    expect(parseRuntimeConfig({ ...valid, directTransfer: { ...valid.directTransfer, rolloutId: '' } })).toBeNull();
    expect(resolveTransferWindow({ ...valid, directTransfer: { ...valid.directTransfer, hold: true } }, '?transferWindow=2')).toBe(1);
    expect(resolveTransferWindow({ ...valid, directTransfer: { ...valid.directTransfer, qaBuild: false } }, '?transferWindow=2')).toBe(1);
    expect(resolveTransferWindow(valid, '?transferWindow=2')).toBe(2);
  });

  it('uses bounded piece counts for files up to one MiB', () => {
    vi.stubGlobal('location', { search: '' });
    try {
      expect(SMALL_FILE_PIECE_SIZE).toBe(256 * 1024);
      expect(calculatePieceSize(new Blob([new Uint8Array(1024 * 1024)]))).toBe(256 * 1024);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('clamps diagnostic piece sizes below the operational minimum while preserving larger overrides', () => {
    vi.stubGlobal('location', { search: '?pieceSize=8' });
    try {
      const file = (size: number) => new Blob([new Uint8Array(size)]);
      expect(calculatePieceSize(file(8))).toBe(SMALL_FILE_PIECE_SIZE);
      vi.stubGlobal('location', { search: `?pieceSize=${SMALL_FILE_PIECE_SIZE - 1}` });
      expect(calculatePieceSize(file(8))).toBe(SMALL_FILE_PIECE_SIZE);
      vi.stubGlobal('location', { search: `?pieceSize=${SMALL_FILE_PIECE_SIZE}` });
      expect(calculatePieceSize(file(8))).toBe(SMALL_FILE_PIECE_SIZE);
      vi.stubGlobal('location', { search: `?pieceSize=${SMALL_FILE_PIECE_SIZE * 2}` });
      expect(calculatePieceSize(file(8))).toBe(SMALL_FILE_PIECE_SIZE * 2);
      vi.stubGlobal('location', { search: `?pieceSize=${SMALL_FILE_PIECE_SIZE * 32}` });
      expect(calculatePieceSize(file(8))).toBe(SMALL_FILE_PIECE_SIZE * 32);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('matches the validator v2 root, derived counts, monotonic seq, and clean final dispose', () => {
    let artifact = createDirectRunArtifact('run_1');
    artifact = appendDirectArtifactEvent(artifact, { type: 'direct_lifecycle_error', phase: 'send', code: 'timeout', atMs: 1 });
    artifact = completeDirectRunArtifact(artifact, cleanCleanup, 'failed', 'failed');
    expect(validateDirectRunArtifact(artifact)).toBe(true);
    expect(directArtifactCounts(artifact)).toMatchObject({ lifecycleLeaks: 1 });
    expect(artifact.events.map(event => event.seq)).toEqual([1, 2, 3]);
  });

  it('rejects unknown event fields at the artifact boundary', () => {
    let artifact = createDirectRunArtifact('run_unknown');
    artifact = appendDirectArtifactEvent(artifact, { type: 'controller', state: 'failed', atMs: 0 });
    artifact = completeDirectRunArtifact(artifact, cleanCleanup, 'failed', 'failed');
    const withUnknown = { ...artifact, events: artifact.events.map((event, index) => index === 0 ? { ...event, unexpected: true } : event) };
    expect(validateDirectRunArtifact(withUnknown)).toBe(false);
  });

  it.each(['failed', 'cancelled'] as const)('records final disposal evidence for %s runs', outcome => {
    const artifact = completeDirectRunArtifact(createDirectRunArtifact(`run_${outcome}`), cleanCleanup, outcome, outcome);
    expect(validateDirectRunArtifact(artifact)).toBe(true);
    expect(artifact.events.at(-1)).toMatchObject({ type: 'lifecycle', status: 'dispose_completed', outstandingDirect: 0, activeTimers: 0 });
  });
  it.each(['failed', 'cancelled'] as const)('rejects a %s artifact containing prior success', outcome => {
    let artifact = createDirectRunArtifact(`run_prior_success_${outcome}`);
    artifact = appendDirectArtifactEvent(artifact, { type: 'controller', state: 'succeeded', atMs: 0 });
    artifact = completeDirectRunArtifact(artifact, cleanCleanup, outcome, outcome);
    expect(validateDirectRunArtifact(artifact)).toBe(false);
  });
  it('rejects legacy terminal reason aliases', () => {
    const artifact = createDirectRunArtifact('run_legacy_reason');
    expect(() => appendDirectArtifactEvent(artifact, {
      type: 'terminal',
      reason: 'timeout',
      retryCount: 0,
      willRetry: false,
      atMs: 0
    } as never)).toThrow('invalid artifact event');
  });


  it('requires verified pieces and resume validation before successful disposal evidence', () => {
    let artifact = createDirectRunArtifact('run_succeeded', {
      transfer: { fileBytes: 1, pieceBytes: 1, pieceCount: 1, hashMode: 'sha256' }
    });
    artifact = appendDirectArtifactEvent(artifact, { type: 'terminal', reason: 'verified', retryCount: 0, willRetry: false, atMs: 1 });
    artifact = appendDirectArtifactEvent(artifact, { type: 'resume_validation', verifiedPieces: 1, discardedPieces: 0, status: 'passed', atMs: 2 });
    artifact = completeDirectRunArtifact(artifact, cleanCleanup, 'succeeded', 'succeeded');
    expect(validateDirectRunArtifact(artifact)).toBe(true);
  });
  it.each([
    ['missing verification', []],
    ['missing resume validation', [{ type: 'terminal', reason: 'verified', retryCount: 0, willRetry: false, atMs: 1 }]],
    ['failed resume', [{ type: 'terminal', reason: 'verified', retryCount: 0, willRetry: false, atMs: 1 }, { type: 'resume_validation', verifiedPieces: 1, discardedPieces: 0, status: 'failed', atMs: 2 }]],
    ['insufficient resume', [{ type: 'terminal', reason: 'verified', retryCount: 0, willRetry: false, atMs: 1 }, { type: 'resume_validation', verifiedPieces: 0, discardedPieces: 0, status: 'passed', atMs: 2 }]],
    ['discarded resume', [{ type: 'terminal', reason: 'verified', retryCount: 0, willRetry: false, atMs: 1 }, { type: 'resume_validation', verifiedPieces: 0, discardedPieces: 1, status: 'passed', atMs: 2 }]]
  ])('rejects successful artifact with %s evidence', (_label, events) => {
    let artifact = createDirectRunArtifact('run_negative', { transfer: { fileBytes: 1, pieceBytes: 1, pieceCount: 1, hashMode: 'sha256' } });
    for (const event of events) artifact = appendDirectArtifactEvent(artifact, event as never);
    expect(() => completeDirectRunArtifact(artifact, cleanCleanup, 'succeeded', 'succeeded')).toThrow();
  });

  it('rejects address-bearing and unexpected artifact metrics fields', async () => {
    const artifact = createDirectRunArtifact('run_privacy');
    const addressBearing = { ...artifact, environment: { ...artifact.environment, browserFamilyMajor: '192.168.1.4' } };
    const unexpectedMetrics = { ...artifact, counts: { ...artifact.counts, candidateAddress: '10.0.0.4' } };
    expect(validateDirectRunArtifact(addressBearing)).toBe(false);
    expect(validateDirectRunArtifact(unexpectedMetrics)).toBe(false);

    const controller = new DirectTransferController(new FakeEngine() as never, 'run_metrics_privacy');
    controller.recordMetrics({
      selectedIcePair: { localCandidateType: 'host', remoteCandidateType: 'srflx', protocol: 'udp', candidateAddress: '10.0.0.4' }
    } as never);
    expect(controller.serializeMetrics()).not.toMatch(/candidateAddress|10\.0\.0\.4/);
    await controller.dispose('failed');
  });

  it('rejects lifecycle errors and flushes keyed failed windows', async () => {
    const engine = new FakeEngine();
    engine.requestPieceWindow.mockImplementation(async () => {
      queueMicrotask(() => engine.emit('directLifecycleError', { phase: 'send', code: 'send_failed', message: 'send failed', fileId, pieceIndex: 0, peerId, controllerId: 'browser-direct', windowKey: 'window-1', generation: 0, at: Date.now() }));
      return [{ pieceIndex: 0 }] as never;
    });
    const controller = new DirectTransferController(engine as never, 'run_error');
    await expect(controller.requestWindow(peerId, fileId, { windowKey: 'window-1', timeoutMs: 100 })).rejects.toThrow('send failed');
    expect(engine.cancelled).toContainEqual({ windowKey: 'window-1' });
    expect(engine.flushes).toBeGreaterThan(0);
    await controller.dispose('failed');
    expect(validateDirectRunArtifact(controller.getRunArtifact())).toBe(true);
  });

  it('cancels timed out windows, flushes, and leaves clean disposal evidence', async () => {
    vi.useFakeTimers();
    try {
      const engine = new FakeEngine();
      engine.requestPieceWindow.mockResolvedValue([{ pieceIndex: 0 }] as never);
      const controller = new DirectTransferController(engine as never, 'run_timeout');
      const request = controller.requestWindow(peerId, fileId, { windowKey: 'window-timeout', timeoutMs: 10 });
      const rejection = expect(request).rejects.toThrow('timeout');
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      await controller.cancelDirectRequests('browser-direct');
      await controller.dispose('failed');
      expect(engine.cancelled).toContainEqual({ windowKey: 'window-timeout' });
      expect(engine.cancelled).toContainEqual({ controllerId: 'browser-direct' });
      expect(validateDirectRunArtifact(controller.getRunArtifact())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('lets AbortSignal win and cancels the active keyed window', async () => {
    const engine = new FakeEngine();
    engine.requestPieceWindow.mockResolvedValue([{ pieceIndex: 0 }] as never);
    const abort = new AbortController();
    const controller = new DirectTransferController(engine as never, 'run_abort', { signal: abort.signal });
    const request = controller.requestWindow(peerId, fileId, { windowKey: 'window-abort', timeoutMs: 100 });
    const rejection = expect(request).rejects.toThrow('aborted');
    await Promise.resolve();

    abort.abort();
    await rejection;

    expect(controller.getState()).toBe('cancelled');
    expect(engine.cancelled).toContainEqual({ windowKey: 'window-abort' });
    await controller.dispose('cancelled');
  });

  it('fails only the matching peer on a transport-fatal event', async () => {
    const engine = new FakeEngine();
    engine.requestPieceWindow.mockResolvedValue([{ pieceIndex: 0 }] as never);
    let fatal!: (event: { peerId?: PeerId; error: Error }) => void;
    const controller = new DirectTransferController(engine as never, 'run_transport', {
      onTransportFatal(handler) {
        fatal = handler;
        return () => undefined;
      }
    });
    const request = controller.requestWindow(peerId, fileId, { windowKey: 'window-transport', timeoutMs: 100 });
    const rejection = expect(request).rejects.toThrow('transport failed');
    await Promise.resolve();

    fatal({ peerId: 'peer_other' as PeerId, error: new Error('wrong peer') });
    fatal({ peerId, error: new Error('transport failed') });
    await rejection;

    expect(engine.cancelled).toContainEqual({ windowKey: 'window-transport' });
    await controller.dispose('failed');
  });

  it('ignores mismatched lifecycle generations before failing the matching generation', async () => {
    const engine = new FakeEngine();
    engine.requestPieceWindow.mockResolvedValue([{ pieceIndex: 0 }] as never);
    const controller = new DirectTransferController(engine as never, 'run_generation');
    const request = controller.requestWindow(peerId, fileId, { windowKey: 'window-generation', timeoutMs: 100 });
    const rejection = expect(request).rejects.toThrow('matching generation');
    await Promise.resolve();

    engine.emit('directLifecycleError', { phase: 'persist', code: 'persist_failed', message: 'wrong generation', fileId, pieceIndex: 0, peerId, controllerId: 'browser-direct', windowKey: 'window-generation', generation: 1, at: Date.now() });
    engine.emit('directLifecycleError', { phase: 'persist', code: 'persist_failed', message: 'matching generation', fileId, pieceIndex: 0, peerId, controllerId: 'browser-direct', windowKey: 'window-generation', generation: 0, at: Date.now() });
    await rejection;

    expect(engine.cancelled).toContainEqual({ windowKey: 'window-generation' });
    await controller.dispose('failed');
  });

  it('rechecks queued work after an empty initial fill', async () => {
    const engine = new FakeEngine();
    engine.requestPieceWindow.mockResolvedValue([]);
    engine.getOutstandingRequestCount
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    const controller = new DirectTransferController(engine as never, 'run_recheck');
    const request = controller.requestWindow(peerId, fileId, { windowKey: 'window-recheck', timeoutMs: 100 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    engine.emit('requestTerminal', {
      fileId,
      pieceIndex: 0,
      peerId,
      requestId: 'request-recheck',
      reason: 'verified',
      retryCount: 0,
      willRetry: false,
      at: Date.now(),
      generation: 0,
      controllerId: 'browser-direct',
      windowKey: 'window-recheck'
    });

    await expect(request).resolves.toHaveLength(1);
    await controller.dispose('failed');
  });

  it('always disposes the engine when lifecycle flush fails', async () => {
    const engine = new FakeEngine();
    engine.flushDirectLifecycle.mockRejectedValueOnce(new Error('flush failed'));
    const controller = new DirectTransferController(engine as never, 'run_flush_failure');

    await expect(controller.dispose('failed')).rejects.toThrow('flush failed');
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(engine.disposed).toBe(true);
  });

  it('cancels every controller identity used before disposal', async () => {
    const engine = new FakeEngine();
    engine.requestPieceWindow.mockRejectedValue(new Error('request failed'));
    const controller = new DirectTransferController(engine as never, 'run_custom_controller');

    await expect(controller.requestWindow(peerId, fileId, {
      controllerId: 'custom-controller',
      windowKey: 'custom-window'
    })).rejects.toThrow('request failed');
    await controller.dispose('failed');

    expect(engine.cancelled).toContainEqual({ controllerId: 'browser-direct' });
    expect(engine.cancelled).toContainEqual({ controllerId: 'custom-controller' });
  });

  it('does not record stale or foreign lifecycle events', async () => {
    const engine = new FakeEngine();
    engine.requestPieceWindow.mockResolvedValue([{ pieceIndex: 0 }] as never);
    const controller = new DirectTransferController(engine as never, 'run_foreign_event');
    const request = controller.requestWindow(peerId, fileId, { windowKey: 'window-current' });
    await Promise.resolve();

    engine.emit('requestWindowExhausted', {
      fileId,
      peerId: 'peer_foreign' as PeerId,
      controllerId: 'browser-direct',
      windowKey: 'window-current',
      generation: 0,
      reason: 'no_candidates',
      at: Date.now()
    });
    expect(controller.getRunArtifact().events.some(event => event.type === 'window_exhausted')).toBe(false);

    engine.emit('requestTerminal', {
      fileId,
      pieceIndex: 0,
      peerId,
      requestId: 'request-current',
      reason: 'verified',
      retryCount: 0,
      willRetry: false,
      at: Date.now(),
      generation: 0,
      controllerId: 'browser-direct',
      windowKey: 'window-current'
    });
    await expect(request).resolves.toHaveLength(1);
    await controller.dispose('failed');
  });
  it('settles a terminal that arrives before requestPieceWindow returns', async () => {
    const engine = new FakeEngine();
    engine.getDirectWindowGeneration.mockReturnValue(2);
    engine.requestPieceWindow.mockImplementation(async () => {
      engine.emit('requestTerminal', {
        fileId,
        pieceIndex: 0,
        peerId,
        requestId: 'request-early',
        reason: 'verified',
        retryCount: 0,
        willRetry: false,
        at: Date.now(),
        generation: 2,
        controllerId: 'browser-direct',
        windowKey: 'window-early'
      });
      return [{ pieceIndex: 0 }] as never;
    });
    const controller = new DirectTransferController(engine as never, 'run_early_terminal');

    await expect(controller.requestWindow(peerId, fileId, { windowKey: 'window-early' })).resolves.toHaveLength(1);
    await controller.dispose('failed');
  });

  it('preserves setup and cleanup failures together', async () => {
    const engine = new FakeEngine();
    const setupError = new Error('setup failed');
    const cleanupError = new Error('cleanup failed');
    engine.requestPieceWindow.mockRejectedValueOnce(setupError);
    engine.flushDirectLifecycle.mockRejectedValueOnce(cleanupError);
    const controller = new DirectTransferController(engine as never, 'run_dual_failure');

    const failure = await controller.requestWindow(peerId, fileId, { windowKey: 'window-dual' }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([setupError, cleanupError]);
    expect((failure as Error).cause).toBe(setupError);
    await controller.dispose('failed');
  });
  it('aggregates actual storage write timings from engine events', async () => {
    const engine = new FakeEngine();
    const controller = new DirectTransferController(engine as never, 'run_storage_metrics');

    engine.emit('performance', { type: 'storage:write', fileId, pieceIndex: 0, bytes: 512, durationMs: 3 });
    engine.emit('performance', { type: 'storage:write', fileId, pieceIndex: 1, bytes: 256, durationMs: 2 });

    expect(controller.getMetrics().storageTiming).toEqual({ writes: 2, bytes: 768, durationMs: 5 });
    await controller.dispose('failed');
  });
  it('computes payload goodput from the measured piece-transfer interval', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(1100);
    const controller = new DirectTransferController(new FakeEngine() as never, 'run_goodput');

    controller.beginTransferMetrics();
    controller.recordMetrics({ payloadBytes: 2048, pieceTiming: { count: 2 } });
    controller.endTransferMetrics();

    expect(controller.getMetrics()).toMatchObject({
      payloadBytes: 2048,
      payloadGoodputBps: 2048,
      pieceTiming: { count: 2, durationMs: 1000 }
    });
    now.mockRestore();
    await controller.dispose('failed');
  });
  it('serializes safe terminal metrics and keeps them after disposal', async () => {
    const controller = new DirectTransferController(new FakeEngine() as never, 'run_metrics');
    controller.recordMetrics({
      payloadBytes: 1024,
      wireBytes: 1400,
      effectiveWindow: 2,
      selectedIcePair: { localCandidateType: 'srflx', remoteCandidateType: 'host', protocol: 'udp' }
    });
    await controller.dispose('failed');
    const metrics = controller.getMetrics();
    expect(metrics).toMatchObject({ payloadBytes: 1024, wireBytes: 1400, state: 'failed', outcome: 'failed', disposed: true });
    expect(metrics.selectedIcePair).toEqual({ localCandidateType: 'srflx', remoteCandidateType: 'host', protocol: 'udp' });
    expect(controller.serializeMetrics()).not.toMatch(/candidateAddress|192\.168|10\./);
  });
});
