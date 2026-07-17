# Path-Aware Transfer Tuning Design

Status: Ready for phase-1 implementation  
Last updated: 2026-07-17  
Depends on: `docs/20-logic-algorithm-audit-scorecard.md` (finding D), `docs/19-transfer-performance-design.md`  
Implements findings: D (partial), supports E without changing hold-1

---

## 1. Problem

Grid currently:

1. Sends piece payloads in fixed **64 KiB** application chunks (`DEFAULT_TRANSFER_CHUNK_BYTES` in `@ponswarp/core`).
2. Uses a single default DataChannel flow-control profile (high/low watermarks) regardless of ICE path.
3. Has **library helpers** in `@ponswarp/webrtc` for path profiles + BDP (`selectTransferTuningProfile`, `selectInFlightTargetBytes`, `flowControlProfileFromTuning`) that are **not wired** into engine send path or demo/CLI.

LAN host UDP and TURN relay need different in-flight bytes and chunk sizes. Using relay-sized queues on LAN starves throughput; using LAN-sized queues on relay inflates latency and memory.

---

## 2. Goals

1. Make engine transfer **chunk size configurable** (constructor / setter), default remains 64 KiB for compatibility.
2. Expose a pure **profile selection** path that maps ICE diagnostics → `TransferTuningProfile` → recommended chunk size + flow-control profile.
3. Allow demo/CLI to **apply** a profile without changing operational `directTransfer.window` hold-1 policy.
4. Keep wire protocol identical (still `PIECE_CHUNK_HEADER` + binary frame).
5. Unit tests for chunk selection and PeerHealth EMA (related P0).

---

## 3. Non-goals

- No automatic getStats polling loop in core (callers supply diagnostics or path kind).
- No hybrid HTTP assist (see `docs/22`).
- No AIMD controller (see `docs/24`).
- No window-2 default change.
- No storage/resume format change.

---

## 4. APIs

### 4.1 Already in `@ponswarp/webrtc` (do not duplicate)

```ts
type CandidatePathKind = 'host' | 'srflx' | 'relay' | 'unknown';

interface TransferDiagnostics {
  candidatePathKind?: CandidatePathKind | null;
  availableOutgoingBitrateBps?: number | null;
  rttMs?: number | null;
}

interface TransferTuningProfile {
  pathKind: CandidatePathKind;
  chunkSizeBytes: number;
  minInFlightBytes: number;
  initialInFlightBytes: number;
  maxInFlightBytes: number;
  lowWaterBytes: number;
}

selectTransferTuningProfile(diagnostics?: Partial<TransferDiagnostics> | null): TransferTuningProfile;
selectInFlightTargetBytes(profile: TransferTuningProfile, diagnostics?: Partial<TransferDiagnostics> | null): number;
calculateSendBudget(params: { targetInFlightBytes: number; bufferedAmountBytes: number; paused?: boolean }): number;
flowControlProfileFromTuning(profile: TransferTuningProfile): FlowControlProfile;
clampDataChannelChunkSize(requestedBytes: number, maxMessageSize?: number | null): number;
```

Default profiles (phase-1 constants):

| Path | chunkSizeBytes | maxInFlightBytes | lowWaterBytes |
|---|---:|---:|---:|
| host | 64 KiB | 8 MiB | 1 MiB |
| srflx | 64 KiB | 6 MiB | 1 MiB |
| relay | 32 KiB | 2 MiB | 256 KiB |
| unknown | 64 KiB | 4 MiB | 1 MiB |

### 4.2 Engine (`@ponswarp/core`)

```ts
interface EngineTransferOptions {
  /** Application chunk size for piece send loop. Default 65536. */
  transferChunkBytes?: number;
}

class PonsWarpEngine {
  constructor(
    storage: StorageAdapter,
    // existing args...
    options?: EngineTransferOptions
  );

  /** Runtime override; clamped to [1, 256 KiB] safe integers. */
  setTransferChunkBytes(bytes: number): void;
  getTransferChunkBytes(): number;

  /**
   * Apply a path tuning recommendation to engine chunk size.
   * Does not mutate transport; caller still sets DataChannel flowControl.
   */
  applyTransferTuning(input: {
    chunkSizeBytes: number;
    maxMessageSize?: number | null;
  }): { transferChunkBytes: number };
}
```

Implementation notes:

- Replace uses of module constant `DEFAULT_TRANSFER_CHUNK_BYTES` in `sendRequestedPiece` with instance field.
- `applyTransferTuning` uses the same clamp rules as webrtc (inline min/max or shared pure function duplicated carefully to avoid core→webrtc dependency). Core must **not** depend on webrtc. Duplicate a small clamp helper in core or export a pure clamp from core used by both.

**Dependency rule:** `@ponswarp/core` never imports `@ponswarp/webrtc`. Shared pure clamp:

- Prefer `clampTransferChunkBytes` in core, re-export/wrap from webrtc `clampDataChannelChunkSize` for DataChannel maxMessageSize cases.

### 4.3 Transport wiring (demo / CLI)

Callers that own `WebRTCTransport` / `DataChannelWrapper`:

```ts
const profile = selectTransferTuningProfile({ candidatePathKind: detectedKind, rttMs, availableOutgoingBitrateBps });
const flow = flowControlProfileFromTuning(profile);
// when creating transport:
new WebRTCTransport({ flowControl: flow });
// when ICE settles:
engine.applyTransferTuning({ chunkSizeBytes: profile.chunkSizeBytes });
// optional: recreate channel only if flowControl must change mid-session (phase-1: set at connect time)
```

Phase-1 minimum for demo:

- URL or runtime config key `?pathKind=host|srflx|relay|unknown` **or** auto from selected ICE pair when available.
- Log selected profile to debug panel.
- Do **not** change `transferWindow` resolution.

Phase-1 minimum for CLI:

- `--path-kind host|srflx|relay|unknown` optional; default `unknown`.
- Maps to chunk size via profile; Node WS transport still uses its own socket drain (chunk size still applies to engine piece framing).

---

## 5. Data flow

```text
ICE selected pair / operator override
        │
        ▼
TransferDiagnostics { candidatePathKind, rttMs, availableOutgoingBitrateBps }
        │
        ▼
selectTransferTuningProfile ──► TransferTuningProfile
        │                              │
        │                              ├─► flowControlProfileFromTuning ──► WebRTCTransport options
        │                              │
        └─► engine.applyTransferTuning(chunkSizeBytes)
                    │
                    ▼
           sendRequestedPiece loops with instance transferChunkBytes
```

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Core depends on webrtc | Pure clamp in core; webrtc keeps DC-specific clamp |
| Oversized chunks on relay | relay profile 32 KiB; hard cap 256 KiB |
| Mid-transfer profile flip thrash | Phase-1: set once at connect; document no mid-flight flip |
| Hold-1 confused with path tuning | Explicit: path tuning ≠ request window |

---

## 7. Tests

| Test | Package |
|---|---|
| `setTransferChunkBytes` / default 64 KiB used in send loop | core |
| `applyTransferTuning` clamps invalid sizes | core |
| PeerHealth EMA ignores 0-byte success; blends samples | core |
| Path profiles + BDP + send budget (existing) | webrtc |
| clamp honors peer max / hard cap (existing) | webrtc |

---

## 8. File touch list (phase-1)

- `packages/core/src/index.ts` — instance chunk size, apply API
- `packages/core/test/bootstrap.test.ts` — chunk + health tests
- `packages/cli/src/index.ts` / `cli-runtime.ts` — optional `--path-kind`
- `apps/demo/src/main.tsx` or small helper — apply profile at connect
- `docs/19-transfer-performance-design.md` — cross-link
- This document

---

## 9. Rollout

1. Land core API + tests (no behavior change if callers omit options).
2. Wire CLI flag (opt-in).
3. Wire demo pathKind (opt-in / ICE when cheap).
4. Operational default remains unknown/host-equivalent chunk 64 KiB and hold-1 window.

---

## 10. Success criteria

- [x] Engine chunk size is instance-scoped and test-covered.
- [x] Profile helpers remain pure and test-covered in webrtc.
- [x] At least one product surface (CLI) can select path profile without changing hold-1 (`--path-kind`).
- [x] No regression in core/webrtc unit suites (38 + 15).
