# Adaptive Congestion Control Design

Status: Design only (phase-4)  
Last updated: 2026-07-17  
Related: finding H in `docs/20-logic-algorithm-audit-scorecard.md`  
Reference: ponswarp `networkAdaptiveController.ts`, `docs/21-path-aware-transfer-tuning-design.md`

---

## 1. Problem

Path-aware **static** profiles (doc 21) pick initial watermarks/chunk sizes from ICE kind. They do not react to:

- RTT inflation mid-transfer,
- availableOutgoingBitrate changes,
- sustained high `bufferedAmount`.

PonsWarp’s `NetworkAdaptiveController` implements a simple delay-based AIMD on an application cwnd and derives batch sizes. Grid lacks this loop.

---

## 2. Goals

1. Define a **UI-free** controller interface for Grid.
2. Integrate with `selectInFlightTargetBytes` / send budget rather than inventing a second parallel system.
3. Bound memory and update rate.
4. Keep optional — default off until validated.

---

## 3. Non-goals

- Replacing SCTP congestion control (cannot; only pace app sends).
- Per-chunk adaptive size thrashing every packet.
- Hybrid arm decisions (doc 22 uses observed throughput separately).

---

## 4. Interface

```ts
export interface AdaptiveCongestionSnapshot {
  cwndBytes: number;
  estimatedRttMs: number;
  estimatedBwBps: number;
  recommendedBatchChunks: number;
}

export interface AdaptiveCongestionController {
  start(): void;
  reset(): void;
  recordSend(bytes: number): void;
  updateFromCandidateStats(input: {
    rttMs?: number;
    availableOutgoingBitrateBps?: number;
  }): void;
  updateBufferState(bufferedAmountBytes: number): AdaptiveCongestionSnapshot;
  getSnapshot(): AdaptiveCongestionSnapshot;
}
```

### AIMD sketch (port of ponswarp behavior, cleaned)

- Initial cwnd: profile.initialInFlightBytes
- Min cwnd: profile.minInFlightBytes
- Max cwnd: profile.maxInFlightBytes
- On `rttMs / minRtt > 2` **or** `bufferedAmount > cwnd`: cwnd *= 0.7
- On clear path (`rtt ratio < 1.5` and buffer < 0.8 * cwnd): additive increase (LAN 256 KiB / WAN 64 KiB per ≥100 ms tick)
- recommendedBatchChunks = floor((cwnd * 0.2) / chunkSize) clamped to [1, 32]

---

## 5. Integration with path tuning

```text
path profile ──► bounds (min/max/initial)
getStats tick ──► updateFromCandidateStats
bufferedAmount ──► updateBufferState ──► cwnd
cwnd ──► calculateSendBudget / DataChannel highWaterMark target
```

Phase-4 should **not** rewrite highWaterMark every 100 ms on the RTCDataChannel threshold (browser cost). Prefer:

- app-level send budget gate before `enqueueSend`,
- or update `FlowControlProfile.highWaterMark` at most every 1 s.

---

## 6. Placement

| Piece | Package |
|---|---|
| Controller class | `@ponswarp/webrtc` |
| Optional engine hook | none required — callers own loop |
| Demo stats poll | `apps/demo` every 500–1000 ms on active transfer |

---

## 7. Tests

- Multiplicative decrease when buffer > cwnd.
- Additive increase when clear; respects max.
- Ignores rtt ≤ 0 or absurd rtt.
- Update rate throttle (< 100 ms no-op).

---

## 8. Rollout

1. Implement controller + unit tests behind export.
2. Demo diagnostic toggle `?adaptive=1`.
3. Collect local evidence; do not claim production default until soak.

---

## 9. Success criteria

- [ ] Pure controller tests without RTCPeerConnection.
- [ ] Demo optional path does not break hold-1.
- [ ] Document interaction with doc 21 profiles.

## Implementation status

Landed 2026-07-17 in monorepo unit tests. See package tests for `AdaptiveCongestionController`.
