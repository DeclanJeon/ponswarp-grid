# PonsWarp Grid Engine

Reusable browser P2P file-transfer engine extracted from PonsWarp. The MVP target is piece-based file transfer over WebRTC DataChannel with WebSocket signaling, local resume state, and SHA-256 integrity checks.

## Workspace

- `packages/core`: UI-free manifest, piece, storage, scheduler, integrity, events, and protocol-domain types.
- `packages/webrtc`: browser WebRTC transport wrappers.
- `packages/signaling`: deployable WebSocket signaling server, browser signaling client, and room lifecycle helpers.
- `packages/react`: React adapter surface.
- `apps/demo`: local, WebRTC loopback, and signaled two-browser sender/receiver demo app.

## Local demo

```bash
pnpm install
pnpm build
pnpm --filter @ponswarp/demo dev
```

Open the printed Vite URL. The demo has sender, receiver, resume, download, and debug panels. It runs a local in-browser transfer simulation with `PonsWarpEngine`, `MemoryStorageAdapter`, and an in-memory transport so the engine API can be exercised without deploying a signaling server.

## Real two-browser direct transfer

Build the packages, start the signaling server, and serve the built demo from a host/port that both browsers can reach:

```bash
pnpm install
pnpm build
pnpm dev:signal
```

In another terminal:

```bash
python3 -m http.server 4176 --bind 0.0.0.0 --directory apps/demo/dist/app
```

Open `http://<host>:4176/index.html` in the sender browser and click **Start signaled sender**. Open the generated `#/join/<sessionId>` share link in a second browser/device and click **Join signaled receiver from URL**. The receiver should reach `Status: complete`, show verified pieces at 100%, restore resume state, show the selected storage backend, and expose a `Download assembled file` link. To validate reload resume, refresh the receiver page on the same `#/join/<sessionId>` URL and click **Restore local resume state from URL**; the receiver should restore the persisted manifest/piece map from OPFS/IndexedDB/Memory fallback and show the same verified-piece count.

The demo signaling client defaults to `ws://<demo-host>:8787/ws` or `wss://<demo-host>:8787/ws`; run the signaling server on the same host name used for the demo page. Use browser-safe LAN/firewall settings for multi-device testing.

## Large-file performance and operations

The core manifest path defaults to per-piece SHA-256 and `piece-only` whole-file policy for large files. This avoids whole-file `ArrayBuffer` allocation above the safe threshold while preserving per-piece integrity. Final assembly is guarded by `safeAssembleBytes` (default 256 MiB): small files can produce a Blob download, while larger files use `saveAssembledFile` with a writable stream when available or return an explicit unsupported result instead of risking a memory spike.

Run the reproducible 500 MiB memory-budget script:

```bash
pnpm perf:500mb
```

It iterates a 500 MiB transfer-shaped workload one piece at a time and fails if heap usage exceeds the bounded-memory threshold. Tune with `PONSWARP_PERF_BYTES` and `PONSWARP_PERF_PIECE_BYTES`.

Docker signaling server:

```bash
docker build --target signaling -t ponswarp-grid-signaling .
docker run --rm -p 8787:8787 ponswarp-grid-signaling
```

Multi-device LAN checklist:

1. Run `pnpm build` and `pnpm dev:signal` on the host.
2. Serve `apps/demo/dist/app` with `python3 -m http.server 4176 --bind 0.0.0.0 --directory apps/demo/dist/app`.
3. Open `http://<lan-host>:4176/index.html` on sender and receiver devices.
4. Use **Start signaled sender** then the generated `#/join/<sessionId>` URL.
5. For large files, watch the debug panel for progress and use the safe final-save behavior: Blob download below threshold, explicit unsupported/writable-stream result above threshold.

Troubleshooting:
- Receiver cannot connect: confirm demo URL hostname matches the signaling server hostname and port `8787` is reachable.
- Resume restores fewer pieces than expected: corrupt or missing verified pieces are intentionally discarded after re-hash and re-requested.
- Large final download unavailable: browser lacks a safe writable sink for a file above `safeAssembleBytes`; retry with a smaller file or a browser supporting File System Access writable streams.
- OPFS unavailable: the storage factory falls back to IndexedDB and then Memory while recording warnings in the selected storage backend/debug state.

## API quickstart

```ts
import { MemoryStorageAdapter, PonsWarpEngine } from '@ponswarp/core';

const sender = new PonsWarpEngine(new MemoryStorageAdapter());
const session = await sender.createSession({
  files: [file],
  pieceSize: 1024 * 1024
});

const receiver = new PonsWarpEngine(new MemoryStorageAdapter());
await receiver.joinSession(session.sessionId, session.manifests);
```

## Source reuse audit

The initial extraction compared `docs/07-implementation-tickets.md` and the existing `/home/declan/Documents/Develop/Project/ponswarp` codebase.

| Existing source | Reuse decision |
| --- | --- |
| `PonsWarp/src/utils/transferProgress.ts` | Reuse directly as UI-free progress math in `@ponswarp/core`. |
| `PonsWarp/src/utils/transferFlowControl.ts` | Reuse backpressure constants/calculations in `@ponswarp/webrtc`; keep browser queue behavior but remove sender UI coupling. |
| `PonsWarp/src/services/singlePeerConnection.ts` | Reuse evented peer wrapper design, binary normalization, and low-water drain behavior; replace `simple-peer` coupling with package-local WebRTC abstractions as the grid transport matures. |
| `PonsWarp/src/services/signaling-adapter.ts` | Reuse the reconnect/send guard lessons, but implement protocol messages from `docs/04-protocol-spec.md` instead of legacy message names. |
| `PonsWarp/src/services/swarmManager.ts` and `webRTCService.ts` | Mine transfer orchestration concepts only; do not copy because room/UI/worker state is tightly coupled to the old app. |
| `PonsWarp/src/services/directFileWriter.ts` and `reorderingBuffer.ts` | Reuse ordering, batching, and progress ideas for later storage/receiver flow; MVP core starts with piece-level storage boundaries. |
| `ponswarp-signaling-rs/src/handlers/room.rs` | Reuse room lifecycle semantics conceptually; new JS/TS signaling package owns the Grid protocol shape. |

## Development

```bash
pnpm install
pnpm build
pnpm test
```
