# PonsWarp Grid 95% Completion Design

문서 버전: v0.1  
작성일: 2026-07-05  
상태: 실행 설계안  
대상: `ponswarp-grid` repo를 MVP engine/demo/CLI 상태에서 95% 제품 완성도로 올리기 위한 기술 설계

---

## 1. 목적

이 문서는 현재 `ponswarp-grid`의 완성도를 95% 이상으로 끌어올리기 위한 **제품/기술 완성 기준, 목표 아키텍처, 구현 범위, acceptance gate**를 정의한다.

현재 분석 기준:

- Core data-grid engine은 MVP 수준으로 동작한다.
- CLI direct/grid transfer는 localhost/LAN/direct endpoint 기준으로 동작한다.
- Browser WebRTC demo는 signaling + resume 시연이 가능하다.
- Public-production coordinator, real cross-network speed measurement/adaptation, production NAT/TURN proof, browser E2E automation은 부족하다.

이 문서의 목표는 단순 기능 추가가 아니라, 다음 문장을 repo가 증명할 수 있게 만드는 것이다.

> PonsWarp Grid는 Web/CLI에서 대용량 파일을 piece 단위로 전송·검증·재개하며, 같은 LAN/서로 다른 NAT/relay-only 네트워크에서 측정 가능한 성능과 실패 복구 동작을 제공하고, coordinator 기반 share/get product flow를 production-readiness gate까지 검증한 reusable data-grid product이다.

---

## 2. 95% 완성도 정의

95%는 “모든 미래 기능 완료”가 아니다. 다음 gate를 모두 통과하는 상태를 95%로 본다.

| 영역 | 95% 기준 | 현재 추정 | 목표 |
|---|---:|---:|---:|
| Core engine correctness | piece/hash/resume/grid/retry/chunk/backpressure가 자동 테스트로 검증됨 | 80–85% | 95% |
| Browser product flow | share link/code → real coordinator resolve → WebRTC/TURN transfer → resume/download E2E | 60–70% | 95% |
| CLI product flow | coordinator share/get로 metadata + candidates + byte transfer가 direct hint 없이도 운영 가능 | 70–80% direct, 낮음 coordinator byte | 95% |
| Cross-network behavior | LAN, NAT, LTE/5G, relay-only, UDP-blocked TCP/TLS에서 속도·성공률 측정 | 40–50% | 95% |
| Performance telemetry | 실제 transfer speed/RTT/buffer/retry/storage metrics가 수집·리포팅됨 | 50–60% | 95% |
| Production coordinator | `/api/grid/v1/*`, `/ws/grid/*`, auth, rate limit, persistence, readiness 검증 | 45–55% | 95% |
| Release QA automation | unit/integration/e2e/perf/network/soak gates가 재현 가능 | 65–70% | 95% |
| Documentation/user ops | user guide/runbook/checklist가 구현과 일치 | 70–75% | 95% |

95% completion gate:

1. `pnpm test`, `pnpm type-check`, `pnpm build` pass.
2. Browser E2E: local direct, signaled WebRTC, strict relay, resume, large-file-safe save pass.
3. CLI E2E: direct, coordinator `share/get`, multi-provider grid, resume, status/clean pass.
4. Cross-network matrix: same Wi-Fi, different Wi-Fi/NAT, LTE/5G, relay-only UDP, UDP-blocked TCP/TLS each has report with speed and candidate pair.
5. 100MiB+ browser relay and 500MiB+ CLI transfer have bounded memory and hash proof.
6. Coordinator API and deployment routes match docs and tests.
7. No known SEV-1/SEV-2 blocker remains open without explicit waiver.

---

## 3. Current-state evidence

### 3.1 Core grid exists

Evidence:

- `packages/core/src/index.ts:17-34` — `FileManifest` / `PieceDescriptor` model.
- `packages/core/src/index.ts:426-536` — `PieceManager` state/progress/retry.
- `packages/core/src/index.ts:625-737` — `PieceAvailabilityTable` provider map/lease.
- `packages/core/src/index.ts:739-795` — `PeerHealthTable` throughput/RTT/failure score.
- `packages/core/src/index.ts:929-988` — `requestNextGridPiece` scheduler.
- `packages/core/src/index.ts:1005-1036` — hash verification, write, ACK/REJECT, peer success.
- `packages/cli/test/cli-grid.integration.test.ts:44-83` — Receiver B fetches non-owner provider pieces.

### 3.2 Major incompleteness

Evidence:

- `packages/core/src/index.ts:1167-1176` — each piece is sent as one binary frame; no multi-chunk send/reassembly.
- `packages/core/src/index.ts:1270-1281` — persisted state hard-codes `mode: 'direct'`, `peers: []`.
- `packages/signaling/src/server.ts:336-379` — TypeScript server only exposes health/ready/version/ICE, not full coordinator API.
- `deploy/grid.ponslink.nginx.conf:51-65` — deployment expects `/api/grid/v1/` and `/ws/grid/`.
- `packages/cli/src/node-websocket-transport.ts:67-99` — CLI direct transport advertises/dials direct `ws://` endpoints; no NAT/TURN.
- `apps/demo/src/main.tsx:328-338` — one UI path displays hard-coded `speedBps: 18_400_000`.
- `packages/react/src/index.tsx:1-17` — React package only provides context/hook surface.

---

## 4. Target architecture

### 4.1 Components

```text
Browser Web App
  ├─ Share UI / Receive UI
  ├─ Coordinator API client
  ├─ Signaling client (/ws/grid/*)
  ├─ WebRTC session orchestrator
  ├─ Transfer telemetry collector
  └─ OPFS/IndexedDB/File System Access save adapter

CLI
  ├─ direct send/join primitive
  ├─ coordinator node/share/get commands
  ├─ coordinator-mediated byte transfer client
  ├─ resumable disk storage
  ├─ status/clean/session management
  └─ metrics/report output

Core Engine
  ├─ manifest + piece hashing
  ├─ multi-chunk transfer protocol
  ├─ piece map / availability / leases
  ├─ peer health + scheduler
  ├─ adaptive transfer policy hooks
  ├─ resume validation
  └─ performance events

Transport Layer
  ├─ browser WebRTC DataChannel transport
  ├─ Node direct WebSocket transport
  ├─ coordinator-assisted connect grants
  └─ transport capability abstraction

Coordinator
  ├─ workspace/node/file/share APIs
  ├─ candidates/connect grants
  ├─ signaling route /ws/grid/*
  ├─ persistence
  ├─ auth/RBAC/node token
  ├─ rate limit/quota
  ├─ metrics/audit
  └─ cleanup/retention

QA Harness
  ├─ unit/integration tests
  ├─ browser e2e
  ├─ CLI e2e
  ├─ perf benchmarks
  ├─ network matrix tests
  └─ release gate reports
```

### 4.2 Core principle

Data transfer behavior must be proven at three levels:

1. **Engine level** — deterministic fake transports, corrupt chunks, provider churn, owner fallback.
2. **Local real transport level** — Node WebSocket / browser DataChannel on same machine/LAN.
3. **Network level** — NAT/LTE/TURN/TCP-only with observed candidate pair, throughput, retry, completion, hash.

A speed number is valid only when its report records:

- topology,
- file size,
- piece size,
- chunk size,
- transport path,
- ICE candidate pair or CLI endpoint path,
- elapsed time,
- throughput,
- retry/reject/timeout count,
- memory usage,
- final hash result.

---

## 5. Required design changes

## 5.1 Multi-chunk piece transfer

### Problem

Core currently emits one `PIECE_CHUNK_HEADER` and one binary frame per piece.

Evidence: `packages/core/src/index.ts:1167-1176`.

This creates risk under WebRTC SCTP/TURN relay when piece size is larger than practical message size or relay path stalls on large frames.

### Design

Add chunked transfer state machine:

- `PIECE_REQUEST` remains piece-level.
- Sender splits a piece into chunks using transport policy:
  - browser default chunk: 16KiB or `clampDataChannelChunkSize()` result.
  - CLI direct may use larger chunk, but must still support configurable max.
- Sender sends:
  - `PIECE_CHUNK_HEADER` for each chunk or one `PIECE_CHUNK_BATCH_HEADER` with chunk metadata.
  - binary chunk frames in order.
- Receiver buffers chunks by `{ peerId, requestId, fileId, pieceIndex }`.
- Receiver validates:
  - chunk count,
  - total payload size,
  - no duplicate/out-of-range chunks,
  - request lease still valid,
  - assembled byte length equals descriptor size.
- Receiver verifies piece hash after full assembly.
- Partial chunk buffer is discarded on timeout/peer close/reject.

### Acceptance criteria

- Unit test: 1MiB piece with 16KiB chunks produces 64 binary frames and assembles to one verified piece.
- Unit test: missing chunk causes timeout and retry.
- Unit test: duplicate/out-of-order chunk is rejected or safely ignored according to spec.
- WebRTC flow-control test proves sender waits when bufferedAmount crosses high watermark.
- Browser relay 100MiB test completes without single-message stall.

### Primary files

- `packages/core/src/index.ts`
- `packages/core/test/bootstrap.test.ts`
- `packages/webrtc/src/index.ts`
- `packages/webrtc/test/flow-control.test.ts`
- `docs/04-protocol-spec.md`

---

## 5.2 Real transfer telemetry

### Problem

`PerformanceEvent` declares `transfer:speed` and `buffer:watermark`, but transfer speed is not emitted as a first-class telemetry stream. Some UI speed is hard-coded.

Evidence:

- `packages/core/src/index.ts:52-57`
- `apps/demo/src/main.tsx:328-338`

### Design

Introduce `TransferTelemetry` model:

```ts
interface TransferTelemetrySample {
  sessionId: SessionId;
  fileId: FileId;
  peerId: PeerId;
  transport: 'webrtc-datachannel' | 'node-websocket' | 'coordinator-relay';
  path?: 'host' | 'srflx' | 'relay-udp' | 'relay-tcp' | 'relay-tls' | 'direct-ws' | 'unknown';
  bytesReceived: number;
  bytesSent: number;
  windowMs: number;
  throughputBps: number;
  rttMs?: number;
  bufferedAmount?: number;
  retryCount: number;
  rejectCount: number;
  timeoutCount: number;
  sampledAt: number;
}
```

Emit:

- `transfer:speed` every 1s window and on completion.
- `buffer:watermark` when WebRTC bufferedAmount crosses high/low marks.
- `peer:rtt` if ping/pong or RTC stats are available.
- `transfer:summary` on file/session completion.

Browser UI must display measured speed only. Placeholder speed must be removed or labeled demo-only.

### Acceptance criteria

- No production UI path uses hard-coded speed.
- Core tests assert `transfer:speed` event after piece transfer.
- Browser E2E report includes average/peak throughput and candidate pair.
- CLI JSON output includes throughput summary and retry counts.
- Historical synthetic scripts label output as `synthetic: true`.

### Primary files

- `packages/core/src/index.ts`
- `packages/webrtc/src/index.ts`
- `apps/demo/src/main.tsx`
- `packages/cli/src/cli-runtime.ts`
- `scripts/perf-500mb.mjs`
- `scripts/multi-provider-grid-qa.mjs`

---

## 5.3 Adaptive transfer policy

### Problem

Piece size is static by file size. Scheduler uses peer health, but there is no full network-aware policy.

Evidence:

- `apps/demo/src/main.tsx:127-133`
- `packages/core/src/index.ts:739-795`
- `packages/core/src/index.ts:1216-1248`

### Design

Add policy layer:

```ts
interface TransferPolicy {
  initialPieceSize(fileSize: number, context: TransferContext): number;
  chunkSize(peer: PeerHealth, transport: TransportCapabilities): number;
  maxParallelRequests(peer: PeerHealth, transport: TransportCapabilities): number;
  shouldPreferRelay(peer: PeerHealth, diagnostics: NetworkDiagnostics): boolean;
  shouldFallbackToOwner(peer: PeerHealth, pieceAvailability: PieceAvailabilitySnapshot): boolean;
}
```

Phase 1 policy is conservative:

- Same-LAN/direct: 1–4MiB piece, 64KiB chunks.
- Relay/unknown: 64–256KiB piece or 16–64KiB chunks.
- Slow/high-retry path: reduce chunk size and parallelism.
- Good direct path: increase parallelism up to configured cap.
- Office UDP-blocked/TCP/TLS path: lower concurrency, longer timeout.

### Acceptance criteria

- Unit tests cover policy outputs for LAN/direct, relay, TCP/TLS relay, low throughput, high timeout.
- Browser URL override still works for QA.
- Runtime policy decisions are logged into transfer report.
- 10MiB strict relay does not rely on manual `?pieceSize=` to pass.

### Primary files

- `packages/core/src/index.ts`
- `packages/webrtc/src/index.ts`
- `apps/demo/src/main.tsx`
- `scripts/turn-diagnostics.mjs`

---

## 5.4 Coordinator product flow completion

### Problem

CLI expects full coordinator API, but this repo’s TypeScript signaling server does not implement most `/api/grid/v1/*` routes. Deployment points to external Rust `mesh_api`.

Evidence:

- CLI routes: `packages/cli/src/coordinator-runtime.ts:109-276`
- TS server routes: `packages/signaling/src/server.ts:336-379`
- Nginx routes: `deploy/grid.ponslink.nginx.conf:51-65`
- Systemd external binary: `deploy/ponswarp-grid-coordinator.service:10-12`

### Design decision

Use **separate production coordinator** as the canonical public product runtime, but this repo must contain:

1. a coordinator API contract package/spec,
2. integration tests against a local coordinator stub that matches the contract,
3. deploy route consistency checks,
4. browser/CLI clients that target the same `/api/grid/v1/*` and `/ws/grid/*` contract,
5. clear local dev fallback if the external Rust coordinator is absent.

Two viable options:

#### Option A — Implement TS coordinator in this repo

Pros:

- Single repo can run product flow end-to-end.
- Faster local iteration.

Cons:

- Duplicates external Rust `mesh_api` design.
- Production may diverge if Rust remains real deploy target.

#### Option B — Treat Rust `mesh_api` as source of truth and add contract/e2e harness here

Pros:

- Aligns with `deploy/ponswarp-grid-coordinator.service`.
- Avoids duplicate production server.
- Keeps TS repo focused on engine/clients/demo/QA.

Cons:

- Requires cross-repo local setup for full product tests.
- This repo alone cannot claim full coordinator implementation.

Chosen: **Option B**, with a minimal TS dev coordinator only if needed for local smoke tests and clearly marked non-production.

### Acceptance criteria

- `docs/04-protocol-spec.md` and new contract fixture define every route used by CLI/browser.
- `deploy/grid.ponslink.nginx.conf` route paths match client defaults.
- Browser and CLI use `/ws/grid/` for grid product, or nginx supports `/ws` compatibility intentionally.
- Coordinator contract test fails if CLI calls a route not in spec.
- `get <code>` can complete byte transfer via coordinator-mediated flow or returns explicit unsupported reason with remediation.
- No docs claim coordinator-mediated byte transfer until test proves it.

### Primary files

- `packages/cli/src/coordinator-runtime.ts`
- `packages/cli/test/coordinator-runtime.test.ts`
- `apps/demo/src/main.tsx`
- `packages/signaling/src/server.ts` or new dev coordinator package if chosen
- `docs/04-protocol-spec.md`
- `deploy/grid.ponslink.nginx.conf`
- `scripts/validate-grid-deployment-config.mjs`

---

## 5.5 Browser product share/get flow

### Problem

Current web share/get UI mixes local demo codes with signaled sessions. Remote product share-code resolution is mostly planning/placeholder behavior.

Evidence:

- `apps/demo/src/web-product.ts:1-20`
- `apps/demo/src/main.tsx:328-341`
- `README.md:57-60`

### Design

Promote demo app into a product-capable browser flow with explicit modes:

1. **Local demo mode**
   - In-memory/local share only.
   - Labels all synthetic speed/demo states.

2. **Signaled direct mode**
   - `#/join/:sessionId` WebRTC path.
   - Useful for local/LAN QA.

3. **Coordinator product mode**
   - share code/link resolves through coordinator.
   - candidates retrieved from coordinator.
   - connect grant obtained.
   - WebRTC signaling uses `/ws/grid/*`.
   - fallback guidance if no provider/relay path.

### Acceptance criteria

- UI does not show fake remote file metadata for unresolved codes.
- Pasted code triggers real resolve request in product mode.
- If coordinator is absent, UI shows explicit “coordinator unavailable” state.
- Browser E2E covers share → resolve → connect → transfer → resume → download.
- Accessibility: status updates use `role="status"` or equivalent screen-reader semantics.

### Primary files

- `apps/demo/src/main.tsx`
- `apps/demo/src/web-product.ts`
- `apps/demo/test/web-product.test.ts`
- new browser E2E tests
- `README.md`
- `docs/15-grid-user-guide.md`

---

## 5.6 CLI completion

### Problem

CLI supports direct send/join and coordinator planning, but `status` and `clean` are unavailable and coordinator byte flow is partial.

Evidence:

- `packages/cli/src/cli.ts:43-45`
- `docs/15-grid-user-guide.md:73-95`

### Design

Complete CLI as the reliable large-file path:

- `status`: lists active sessions, verified pieces, output path, provider counts, last error, speed summary.
- `clean`: removes completed/expired/failed session cache safely.
- `share/get`: coordinator path attempts full product transfer if supported; otherwise returns structured unsupported reason.
- `report`: optional JSON report output for QA runs.
- `resume`: explicit resume command or auto-resume with clear logs.

### Acceptance criteria

- `ponswarp-grid status` exits 0 and shows direct/grid sessions.
- `ponswarp-grid clean --completed` removes only completed sessions.
- CLI integration tests cover partial resume after process interruption for 100MiB+ fixture.
- CLI coordinator get has tests for direct hint, no candidates, coordinator-mediated candidate, expired code.
- CLI speed summary is measured, not synthetic.

### Primary files

- `packages/cli/src/index.ts`
- `packages/cli/src/cli.ts`
- `packages/cli/src/cli-runtime.ts`
- `packages/cli/src/coordinator-runtime.ts`
- `packages/cli/src/node-file-storage.ts`
- `packages/cli/test/*`

---

## 5.7 Network matrix QA

### Problem

Historical artifacts prove some paths, but explicit speed matrix and TCP-only proof are incomplete.

Evidence:

- `artifacts/remaining-network-qa-report.md:28-36` — TCP/TLS URL tests completed but selected pair was relay/udp.
- `artifacts/remaining-network-qa-report.md:80-88` — next work is UDP-blocked network test and 100MiB+ relay/CLI tests.
- `docs/10-release-qa-gates.md:168-189` — warns not to claim TCP/TLS-only until selected relay/tcp or TLS proof exists.

### Design

Add reproducible network matrix:

| Matrix ID | Topology | Required proof |
|---|---|---|
| NET-001 | same machine loopback | baseline speed, hash, no relay |
| NET-002 | same Wi-Fi LAN | host/srflx candidate, speed, hash |
| NET-003 | different Wi-Fi/NAT | srflx or relay, speed, hash |
| NET-004 | LTE/5G receiver, Wi-Fi sender | candidate pair, speed, hash |
| NET-005 | strict relay UDP | relay/udp, speed, hash |
| NET-006 | UDP-blocked TCP/TLS | relay/tcp or relay/tls, speed, hash |
| NET-007 | unstable/reconnect | reconnect/retry/resume proof |
| NET-008 | 100MiB+ relay | large relay completion or explicit product limit |

Every network report must include:

- environment,
- command/browser flow,
- file size,
- piece/chunk size,
- candidate pair,
- avg/peak throughput,
- retries/rejects/timeouts,
- memory,
- final hash,
- artifacts/screenshots/logs.

### Acceptance criteria

- `scripts/network-matrix-qa.mjs` or equivalent generates machine-readable JSON reports.
- Release gate refuses `PUBLIC BETA` if NET-004/005/006 are missing or waived.
- TCP/TLS proof includes selected relay protocol or accepted browser stats interpretation.
- README and user guide include measured limits instead of generic claims.

### Primary files

- `scripts/turn-diagnostics.mjs`
- new `scripts/network-matrix-qa.mjs`
- `docs/10-release-qa-gates.md`
- `docs/11-multi-device-qa-report-template.md`
- `README.md`
- `artifacts/*`

---

## 5.8 Production hardening

### Problem

Docs state production hardening remains: persistence, auth/authz, rate limit, observability, cleanup/retention, restart/DR.

Evidence:

- `README.md:225-229`
- `docs/09-final-production-architecture-summary.md:169-218`

### Design

Coordinator must expose hard production gates:

- Postgres authoritative metadata.
- Node token / workspace auth.
- Share code entropy and revocation.
- Candidate/connect grant separation.
- Rate limit/quota per actor/IP/workspace.
- Metrics: active sessions, transfer starts/completions, failure rates, relay usage, latency, DB errors.
- Audit log for share/node/admin events.
- Cleanup jobs for expired shares/stale presence.
- Backup/restore drill.
- Runbook-backed incident modes.

### Acceptance criteria

- DB readiness drill passes against staging database.
- Rate-limit abuse test passes.
- Share revoke/expired tests pass.
- `/readyz` fails when DB/rate-limit dependencies are degraded.
- `/metrics` exposes required counters and is restricted.
- Restart/DR drill proves unexpired share resolve survives restart.

### Primary files

- `deploy/*`
- `scripts/validate-grid-db-readiness.mjs`
- `scripts/validate-grid-security-release.mjs`
- `scripts/mesh-postgres-drill.mjs`
- external Rust coordinator repo if source of truth

---

## 6. Release readiness scorecard

A release candidate is >=95% only if this scorecard passes.

| Gate | Weight | Pass condition |
|---|---:|---|
| Core transfer correctness | 15 | unit/integration tests, corrupt chunk retry, multi-chunk transfer pass |
| CLI large-file path | 12 | 500MiB+ direct/resume/hash/status/clean pass |
| Browser product path | 12 | share/resolve/connect/transfer/resume/download E2E pass |
| Coordinator contract | 12 | API/ws routes match spec, persistence/auth/rate-limit readiness pass |
| Cross-network matrix | 15 | NET-001 through NET-006 pass or documented product limit + waiver |
| Performance telemetry | 10 | measured throughput/RTT/buffer/retry summaries generated |
| Large-file/relay behavior | 8 | 100MiB+ relay or explicit unsupported UX path verified |
| Docs/user/ops alignment | 8 | README/user guide/runbooks match implementation and reports |
| Security/abuse readiness | 8 | share entropy/revoke/rate-limit/audit tests pass |

Required score: 95/100 with no unwaived SEV-1.

---

## 7. ADR

### Decision

Raise completion through a **measured readiness program** rather than feature count alone: complete transfer correctness, coordinator product flow, telemetry, and network QA gates before claiming 95%.

### Drivers

1. User-visible reliability across real networks matters more than local demo success.
2. Speed claims must be measured on real transfer paths, not synthetic loops.
3. Coordinator product flow is the largest gap between MVP and production product.

### Alternatives considered

1. **Only polish demo/README** — rejected because it would inflate perceived readiness without fixing network/coordinator gaps.
2. **Implement everything in TS repo** — rejected as default because deploy points to external Rust `mesh_api`; duplication risk is high.
3. **Treat direct send/join as final product** — rejected because share-code/coordinator UX and NAT paths remain central product requirements.

### Consequences

- Work spans core, WebRTC, CLI, demo, coordinator contract, QA scripts, docs.
- Some work may need external Rust coordinator repo access.
- Completion percent becomes evidence-based and release-gated.

### Follow-ups

- Execute `docs/17-grid-95-completion-work-order.md`.
- Keep every gate report under `artifacts/`.
- Update docs only after the corresponding test/report exists.
