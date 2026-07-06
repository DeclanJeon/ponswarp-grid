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

Replace one-piece loop in `completeReceiverTransfer` with a bounded window:

- default browser transfer window: `2`
- optional URL override: `?transferWindow=<positive integer>`
- safe upper bound: `8`

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
| Browser mobile memory pressure | Browser default window 2 and cap 8 |
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
