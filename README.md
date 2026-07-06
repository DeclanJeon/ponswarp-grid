# PonsWarp Grid Engine

Reusable browser P2P file-transfer engine extracted from PonsWarp. The MVP target is piece-based file transfer over WebRTC DataChannel with WebSocket signaling, local resume state, and SHA-256 integrity checks.

## grid.ponslink.com quickstart

`https://grid.ponslink.com` is the public-beta product surface for PonsWarp Grid. It is intentionally separate from `https://warp.ponslink.com`: Grid uses its own web UI, coordinator API, signaling paths, database namespace, metrics, and rollback path.

### First-time Web use

Sender:

1. Open `https://grid.ponslink.com/`.
2. Choose **Share a file**, select the file, and create a share link.
3. Send the displayed code or link to the receiver.
4. Keep the sender tab open until the receiver finishes; the original file is served from the sender device, not uploaded to the coordinator.

Receiver:

1. Open the received `https://grid.ponslink.com/...` link, or open `https://grid.ponslink.com/` and paste the code.
2. Confirm the file metadata shown by the page.
3. Start the download. If direct WebRTC cannot connect, the client may use the configured TURN relay.

For large files, offline/resume-heavy transfers, or restrictive networks, use the CLI instead of relying on browser memory and tab lifetime.

### CLI install and use

Install dependencies and build this workspace from source:

```bash
pnpm install
pnpm build
```

The Grid coordinator default is:

```text
https://grid.ponslink.com
```

Product commands should use that coordinator by default; local development and staging may override it:

```bash
PONSWARP_COORDINATOR_URL=http://127.0.0.1:8787 node packages/cli/dist/cli.js node start --workspace my-workspace --node-id node-a --public-key ed25519:dev
```

Share metadata from the CLI and print a share code/link:
```bash
node packages/cli/dist/cli.js share ./file.zip --workspace my-workspace --node-id node-a
```

Receive from the CLI by share code or link:
```bash
node packages/cli/dist/cli.js get <share-code-or-link> --out ./downloads
```

The installed package exposes both `ponswarp` and `ponswarp-grid` bin names. From this source tree, use `node packages/cli/dist/cli.js ...`; after package installation/linking, the equivalent command is `ponswarp-grid get <share-code-or-link> --out ./downloads`.

Current coordinator `share/get` performs metadata registration, discovery, candidate planning, and direct-join execution only when an online provider advertises a direct transfer hint. Until coordinator-mediated provider byte transport is fully enabled for every provider, the direct `send`/`join` commands remain the reliable byte-transfer fallback for LAN/local QA and large-file engine validation.

Detailed operational docs:

- User guide: [`docs/15-grid-user-guide.md`](docs/15-grid-user-guide.md)
- Privacy and abuse policy: [`deploy/grid-privacy-abuse-policy.md`](deploy/grid-privacy-abuse-policy.md)
- Incident runbook: [`deploy/grid-ops-incident-runbook.md`](deploy/grid-ops-incident-runbook.md)

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

## Node CLI direct transfer

Build the CLI package and run a sender process:

```bash
pnpm build
node packages/cli/dist/cli.js send ./file.bin --listen 127.0.0.1:0
```

The sender prints a `ponswarp://join/...` descriptor containing the owner endpoint and manifest. In another terminal, join and write the verified file:

```bash
node packages/cli/dist/cli.js join 'ponswarp://join/...' --out ./downloads
```

The receiver writes pieces to disk through `NodeFileStorageAdapter`, resumes from the session state on rerun, streams final assembly to the output file, and verifies the final SHA-256 hash when the manifest includes one. For a CLI grid check, keep Receiver A online after completion and pass its printed peer descriptor to Receiver B:

```bash
node packages/cli/dist/cli.js join 'ponswarp://join/...' --out ./receiver-a --seed-after-complete
node packages/cli/dist/cli.js join 'ponswarp://join/...' --out ./receiver-b --peer 'ponswarp-peer://...'
```

Receiver B prints `Non-owner provider pieces: N`; a value greater than zero proves it fetched at least one piece from Receiver A instead of only the owner. CLI mode is localhost/LAN oriented.

## Node CLI coordinator product surface

The direct `send`/`join` commands stay available as low-level transfer primitives and QA fallback. The product MVP command surface can also talk to a Workspace Coordinator that exposes `/api/grid/v1/*`:

```bash
node packages/cli/dist/cli.js node start \
  --coordinator http://127.0.0.1:8787 \
  --workspace my-workspace \
  --node-id node-a \
  --public-key ed25519:dev \
  --json

node packages/cli/dist/cli.js publish ./file.bin \
  --coordinator http://127.0.0.1:8787 \
  --workspace my-workspace \
  --node-id node-a \
  --json

node packages/cli/dist/cli.js files \
  --coordinator http://127.0.0.1:8787 \
  --workspace my-workspace \
  --json

node packages/cli/dist/cli.js download <file-id> \
  --coordinator http://127.0.0.1:8787 \
  --workspace my-workspace \
  --out ./downloads \
  --json --dry-run
```

`--dry-run` prints the exact coordinator registration/publish/download plan without mutating server state. `node start` ensures the named workspace exists before registering the node. `download` currently performs coordinator discovery and candidate planning; byte transfer execution remains on the direct `send`/`join` primitive until coordinator-mediated provider transport is enabled.

## Staging / production-readiness QA status

The current public staging path used for pre-production QA is isolated from the existing production `/ws` service:

- QA app: `https://warp.ponslink.com/grid-qa-1783162817/`
- QA signaling: `wss://warp.ponslink.com/grid-qa-ws`
- Existing production health remains `ponswarp-signaling-rs` on `https://warp.ponslink.com/health`
- Rollback backup on `ponslink`: `/home/declan/nginx-warp-ponslink-before-grid-qa-ws.conf`

Validated before production cutover:

- LTE-hotspot sender ↔ Wi-Fi `home` receiver over public staging.
- WebRTC strict relay with `stun=none`, `relay=1`, and TURN REST credentials.
- UDP TURN relay selected pair: `local=relay/udp remote=relay/udp`.
- 10MiB browser strict-relay transfer: `160/160` pieces verified, resume restored, assembled `10,485,760` bytes.
- CLI local/direct 64MiB capacity transfer with SHA-256 match.
- 240s staging soak with signaling reconnect recovery.
- QA service health, production health/readiness, Nginx syntax, and rollback artifacts.

Known limits before public production claims:

- TCP/TLS TURN URLs are valid and small transfers complete, but Chrome selected UDP relay candidates in testing. True TCP-only fallback still needs a UDP-blocked maintenance-window test.
- Browser TURN relay large-file behavior is currently bounded by relay throughput/coturn budget. Treat 10MiB as validated; route larger/offline/resume-heavy workflows to CLI/native paths until 100MiB+ relay tests pass.
- Coordinator-mediated provider byte transfer is still planned; current coordinator CLI covers metadata/planning, while direct `send`/`join` remains the byte-transfer primitive.

Pre-production QA evidence:

- `artifacts/predeploy-g001-turn-tcp-tls-report.md`
- `artifacts/predeploy-g002-capacity-report.md`
- `artifacts/predeploy-g003-soak-ops-report.md`
- `artifacts/remaining-network-qa-report.md`
## Production-hardening status

The current repo is an MVP engine/demo/CLI workspace, not a production-ready public mesh service. The coordinator-facing CLI surface can exercise `/api/grid/v1/*` planning and registration flows, but production enablement still depends on persistence, auth/authorization, rate limiting, observability, cleanup/retention jobs, restart/DR drills, and real multi-device release QA.

Operational hardening design is tracked in `docs/08-production-hardening-design.md` and `docs/09-final-production-architecture-summary.md`. Executable release checklists and report templates live in `docs/10-release-qa-gates.md` and `docs/11-multi-device-qa-report-template.md`; use those before staging/private-beta/public-beta decisions instead of treating local demo success as production readiness.

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
