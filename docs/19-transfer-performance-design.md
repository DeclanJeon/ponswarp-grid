# Transfer Performance Design

Status: Active design for local implementation
Last updated: 2026-07-06

## Problem

Internal-network transfers and external/LTE/TURN transfers currently use the same receiver behavior: request one piece, wait until that piece is verified and persisted, then request the next piece. This makes same-LAN direct UDP look acceptable but makes external-network paths feel slow because every piece pays at least one request/response/verify/persist round trip.

Repository evidence:

- `apps/demo/src/main.tsx` `completeReceiverTransfer` loops over `requestNextPiece(...)` and `waitForPieceProgress(...)` one piece at a time.
- `packages/cli/src/cli-runtime.ts` `runJoin` uses the same one-piece-at-a-time loop.
- `packages/core/src/index.ts` already tracks outstanding requests and can mark multiple pieces as `requested`, but caller loops do not keep a request window full.
- `packages/core/src/index.ts` uses a control-message + binary-frame pair for each 64KiB chunk, and `pendingChunks` is keyed by peer. Multiple concurrent piece sends from the same peer can interleave headers and binaries unless provider-side sends are serialized per peer.

## Goal

Reduce avoidable per-piece latency for external-network transfers without changing the wire protocol or weakening integrity/resume behavior.

Success criteria:

1. Receiver can keep a bounded window of requested pieces in flight instead of waiting for each piece to fully verify before asking for the next one.
2. Provider serializes chunk streams per peer, so header/binary pairing remains valid even when several requests are outstanding.
3. Browser signaled receiver and CLI direct receiver both use the pipelined request window.
4. Existing piece hash verification, storage writes, resume state, and ACK/REJECT behavior remain unchanged.
5. Tests cover pipelined scheduling and provider send serialization.

## Non-goals

- No TURN server deployment or infrastructure change.
- No binary framing protocol migration in this patch.
- No storage format migration.
- No new dependency.
- No change to cryptographic verification.

## Design

### 1. Core request window helper

Add a public `requestPieceWindow(peerId, fileId, options)` helper to `PonsWarpEngine`.

Proposed shape:

```ts
interface PieceWindowOptions {
  maxInFlight?: number;
}

async requestPieceWindow(peerId: PeerId, fileId: FileId, options?: PieceWindowOptions): Promise<ScheduledPiece[]>;
```

Behavior:

- Clamp `maxInFlight` to a positive safe integer, defaulting to `1` for backward-compatible behavior.
- Count current outstanding requests for the same `fileId` and `peerId`.
- Schedule additional pieces with `requestNextPiece(...)` until the peer reaches `maxInFlight` or no missing piece remains.
- Return only newly scheduled pieces.

Why this belongs in core:

- Outstanding request state is private to `PonsWarpEngine`.
- External callers should not infer outstanding state by reading piece statuses.
- It keeps browser and CLI behavior consistent.

### 2. Provider-side per-peer send serialization

Add a private `pieceSendQueues` map inside `PonsWarpEngine`:

```ts
private readonly pieceSendQueues = new Map<PeerId, Promise<void>>();
```

Change `PIECE_REQUEST` handling from direct `await sendRequestedPiece(...)` to queued sending:

```ts
await this.queueRequestedPiece(peerId, request);
```

Behavior:

- Requests for the same peer are sent one complete piece stream at a time.
- Requests for different peers may still proceed independently.
- Queue cleanup removes settled queue tails to avoid leaks.
- Existing `sendRequestedPiece` implementation remains responsible for missing-piece rejects and chunk emission.

Why this is required:

- Current incoming chunk assembly stores only one pending chunk header per peer.
- If two same-peer piece streams interleave as `headerA, headerB, binaryA, binaryB`, the receiver rejects `binaryA` as invalid for `headerB`.
- Serializing full piece streams per peer preserves the current wire protocol while allowing multiple outstanding requests to hide request RTT.

### 3. Browser receiver window

The operational browser default is an exact request window of `1` (`hold-1`). Window `2` is experimental and is impossible unless the served runtime configuration sets `directTransfer.window: 2` with `hold:false`; release policy additionally requires the strict evidence gate to return `ENABLE`.

- runtime config v1 is served from `/runtime-config.json`;
- browser default config: `apps/demo/public/runtime-config.json`;
- deployment example: `deploy/ponswarp-grid-runtime-config.json.example`;
- installed deployment path: `/etc/ponswarp-grid/web-runtime-config.json`;
- the only accepted experimental value is `2`; other values are rejected, not silently widened.

The URL override is not a release mechanism: `?transferWindow=2` MUST NOT enable window 2 unless the loaded config also has `qaBuild:true`, `allowDiagnosticWindow2:true`, and `hold:false`. Configuration is read once at startup; missing, malformed, held, or unauthorized configuration remains hold-1.

Loop shape:

1. Top up request window.
2. Wait for progress to advance.
3. Repeat until complete.

This keeps memory bounded because:

- pieces are still assembled and persisted independently;
- provider sends one full piece at a time per peer;
- max window is capped.

### 4. CLI receiver window

Add CLI option:

```text
ponswarp join <session-or-url> --transfer-window <count>
```

Default CLI transfer window: `1`.

Reasoning:

- CLI direct transfer keeps the historical safe behavior by default because the Node cross-process WebSocket transport still needs separate soak coverage before enabling a wider default.
- `--transfer-window <count>` remains available as an explicit opt-in for controlled CLI performance tests.
- Browser signaled transfer gets the default improvement first because it uses WebRTC DataChannel flow control and is the external-network product path that exposed the bottleneck.

### 5. Grid transfer interaction

This patch only applies the direct owner path (`requestNextPiece`). `requestNextGridPiece` already accepts `maxRequestsPerPeer`, but the CLI grid branch currently has single-peer handoff behavior and peer-provider setup constraints. Grid pipelining should be a follow-up once direct path behavior is verified.

### 6. Observability

No new telemetry event is required for this patch. Existing events remain valid:

- `transfer:speed`
- `storage:write`
- `transfer:retry`

Future follow-up: surface these events in browser QA logs and machine-readable network artifacts.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Same-peer chunk interleaving corrupts header/binary pairing | Provider-side per-peer piece send queue |
| Too many requested pieces increases memory or stale outstanding state | Small defaults, safe max, existing retry/lease behavior remains |
| Browser memory pressure | Hold-1 is the operational default; window 2 requires explicit `ENABLE` evidence and an authorized runtime configuration |
| CLI behavior changes unexpectedly | CLI option explicit, default remains 1 until Node transport soak coverage passes |
| Grid scheduler semantics change | Do not alter grid path in this patch |

## Acceptance tests

1. Core test: `requestPieceWindow` schedules multiple missing pieces and leaves them marked requested.
2. Core/webrtc transport test: multiple outstanding same-peer requests complete without invalid chunk rejects, proving provider serialization.
3. CLI parser test: `join --transfer-window` parses and rejects invalid values.
4. Existing CLI/browser/core tests continue passing for targeted packages.

## Expected effect

On direct owner transfers, the receiver no longer leaves the provider idle between pieces while waiting for a full request/response cycle. The improvement is most visible when piece transfer time is short relative to round-trip latency, such as small/medium files over LTE/TURN paths.

This does not remove TURN relay bandwidth limits. If selected ICE pair is `relay/udp`, `relay/tcp`, or `relay/tls`, the relay path still caps throughput. This patch removes avoidable application-layer latency on top of that path.
## Operational rollout contract

Runtime config v1 uses the exact root `{schema:"ponswarp-grid.runtime-config/v1",directTransfer:{window,hold,allowDiagnosticWindow2,qaBuild,rolloutId}}` and is hold-1 by default. `HOLD` and `ROLLBACK` require deploying the hold-1 object; only an evidence-gate `ENABLE` permits release management to deploy window 2 with `hold:false`. Rollback to hold-1 is required after a failed run, lifecycle error, missing disposal evidence, or unavailable evidence stratum. No benchmark or throughput gain is implied by this design.

The local QA run schema is v2 and local-only. Each run is stored below `artifacts/direct-transfer/<suiteId>/runs/`, is bound to manifest suite/build/fixture and selected window, and records its stratum, timestamps, outcome, observed transfer facts, lifecycle errors, and `dispose` evidence. `dispose` is mandatory for every succeeded, failed, or cancelled run. Unavailable strata are represented only by the separate approval file and never by a fabricated run.
Lifecycle errors are terminal run outcomes, not implicit passes: connection close, signaling loss, cancellation, timeout, storage failure, hash mismatch, and abort must be recorded with a symbolic error classification, then execute the same cleanup path. The sender and receiver must dispose listeners, timers, channel handlers, and outstanding requests in `finally`; only after clean disposal may a run be marked failed.

Use the strict validation-and-aggregate sequence; the second command is not run when validation fails:

```bash
node scripts/validate-direct-transfer-runs.mjs \
  --manifest qa/direct-transfer/run-manifest.v1.json \
  --approval qa/direct-transfer/unavailable-approval.v1.json \
  --runs artifacts/direct-transfer/<suiteId>/runs \
  --out artifacts/direct-transfer/<suiteId>/validation.json && \
node scripts/aggregate-direct-transfer-runs.mjs \
  --manifest qa/direct-transfer/run-manifest.v1.json \
  --approval qa/direct-transfer/unavailable-approval.v1.json \
  --validation artifacts/direct-transfer/<suiteId>/validation.json \
  --runs artifacts/direct-transfer/<suiteId>/runs \
  --out artifacts/direct-transfer/<suiteId>/result.json \
  --markdown-out artifacts/direct-transfer/<suiteId>/result.md \
  --strict
```

Unavailable strata require an entry in `qa/direct-transfer/unavailable-approval.v1.json` naming the stratum, reason, impact, approver, expiry, and rollback condition. Approval records evidence absence; it never converts unavailable into pass. Without valid approval, aggregation is `HOLD`.

## 2026-07-11 operational measurements

A workstation sender and Chrome receiver on an LTE hotspot completed ten paired 10 MiB direct WebRTC runs per window over a selected `srflx/udp` pair. Window 1 median payload goodput was 867,383 B/s, 20.4% above the earlier 0.687 MiB/s baseline. Window 2 median was 926,838.5 B/s, but its mean was 0.9% below Window 1 and it won only 6 of 10 pairs. The result is not stable enough to change the operational default; release remains `HOLD` at window 1.

The same hold-1 path completed a 100 MiB LTE transfer in 99.391 seconds at 1,055,001 B/s with 50/50 pieces verified, 50/50 pieces restored, clean disposal, and a selected `srflx/udp` pair. Browser heap rose by approximately one payload during Blob assembly, so larger browser transfers still require writable-stream evidence; use the CLI path when bounded-memory streaming is mandatory.

CLI window 1 completed three 32 MiB LTE/Tailscale runs at a 4.389 MiB/s median after streaming final hashing and drain-aware socket writes, compared with the prior 3.850 MiB/s median. These measurements are local operational evidence, not substitutes for the strict relay strata or authorization to enable window 2.

A final browser smoke run exposed an independent small-file bottleneck: files at or below 1 MiB were split into 8-byte pieces, causing 131,072 sequential hashes for a 1 MiB input before signaling began. The small-file piece size is now 256 KiB. After the final lifecycle fixes, a live two-tab Chromium transfer created the share link in 136 ms and completed the 1 MiB payload as 4/4 verified and resumed pieces; emitted metrics reported 3,668,915 B/s payload goodput, 1,127,324 wire bytes, 4 ms RTT, four storage writes totaling 1,048,576 bytes, and clean disposal. This local host-pair result validates the regression fix but does not replace LTE/NAT/TURN evidence.

After the final evidence hardening, the strict network matrix passes NET-001, NET-002, NET-003, NET-007, and NET-008. NET-004 and NET-006 remain missing, while NET-005 is inconclusive because the historical TURN artifacts are prose, omit current positive transfer fields, or do not prove UDP blocking. This conservative reclassification does not erase the observed transfers; it prevents legacy evidence from authorizing a release claim. The operational decision remains hold-1, with no Window 2 or full TURN-readiness claim.

Frozen non-goals are unchanged: no wire-protocol or storage-format migration, no TURN/infrastructure change, no cryptographic weakening, no fabricated benchmark or gain claim, and no grid-path pipelining.
