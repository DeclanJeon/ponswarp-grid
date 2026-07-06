# PonsWarp Grid 95% Completion Work Order

문서 버전: v0.1  
작성일: 2026-07-05  
상태: 실행 작업지시서  
관련 설계: `docs/16-grid-95-completion-design.md`

---

## 1. 작업 목표

`ponswarp-grid`를 현재 MVP engine/demo/CLI 상태에서 **95% 제품 완성도**로 올린다.

95% 완료의 operational definition:

- Core data-grid transfer is robust under chunking, retry, resume, provider churn, and storage constraints.
- Browser and CLI product flows can complete real share/get transfers with measured telemetry.
- Cross-network QA reports cover LAN, NAT, LTE/5G, relay-only, and TCP/TLS fallback.
- Coordinator product contract is implemented or explicitly integrated against the external production coordinator.
- Release docs, runbooks, and validation scripts match actual behavior.

Non-goals:

- GA launch approval.
- Unlimited relay bandwidth guarantee.
- Native desktop/mobile app rewrite.
- Hiding known network limits behind optimistic copy.

---

## 2. Execution rules

1. No production claim without a passing report.
2. No synthetic throughput number may be described as network speed.
3. Every user-visible feature needs at least one automated test or explicit manual QA artifact.
4. Every cross-network result must record topology, candidate pair/transport path, file size, speed, retry, memory, hash.
5. If external Rust `mesh_api` is required, write an integration contract and mark TS-only repo limitations clearly.
6. Public beta requires no open unwaived SEV-1.

---

## 3. Work packages overview

| ID | Package | Priority | Owner role | Main output |
|---|---|---:|---|---|
| G95-01 | Protocol chunking and engine robustness | P0 | Core engine engineer | Multi-chunk piece transfer and retry tests |
| G95-02 | Transfer telemetry and speed reporting | P0 | Performance engineer | Real transfer metrics and reports |
| G95-03 | Browser product share/get flow | P0 | Frontend/WebRTC engineer | Real coordinator resolve/connect E2E |
| G95-04 | CLI product completion | P0 | CLI engineer | status/clean/coordinator get completion |
| G95-05 | Coordinator contract and route alignment | P0 | Backend/API integrator | `/api/grid/v1/*` + `/ws/grid/*` contract tests |
| G95-06 | Cross-network matrix harness | P0 | QA/network engineer | LAN/NAT/LTE/TURN/TCP reports |
| G95-07 | Large-file and relay readiness | P1 | Performance/QA engineer | 100MiB+ relay, 500MiB+ CLI evidence |
| G95-08 | Production hardening validation | P1 | Security/ops engineer | auth/rate-limit/DB/metrics/cleanup gates |
| G95-09 | Docs and release gate alignment | P1 | Technical writer/release owner | README/user guide/runbook updates |
| G95-10 | Final 95% verification sweep | P0 | Verifier/release owner | Scorecard and go/no-go report |

---

## 4. Detailed work packages

## G95-01 — Protocol chunking and engine robustness

### Target files

- `packages/core/src/index.ts`
- `packages/core/test/bootstrap.test.ts`
- `packages/webrtc/src/index.ts`
- `packages/webrtc/test/flow-control.test.ts`
- `docs/04-protocol-spec.md`

### Current evidence

- `packages/core/src/index.ts:1167-1176` sends one binary frame per piece.
- `packages/webrtc/src/index.ts:14-27` has chunk/backpressure constants, but core does not split piece transfer by chunk.

### Required changes

1. Add chunk send policy to core transfer path.
2. Split outgoing piece data into chunks using a configured max chunk size.
3. Track inbound chunk assembly by `requestId`.
4. Add timeout cleanup for partial chunk buffers.
5. Validate chunk count, byte length, and descriptor size before hash verification.
6. Handle duplicate/out-of-order/missing chunks safely.
7. Update protocol docs for chunk semantics.

### Acceptance criteria

- Unit: 1MiB piece split into 16KiB chunks results in 64 binary chunk frames.
- Unit: missing chunk times out and retries.
- Unit: corrupt chunk leads to piece reject and retry.
- Unit: duplicate chunk cannot corrupt assembled piece.
- Integration: fake transport multi-provider grid still passes.
- WebRTC: high watermark wait still serializes sends.

### Verification commands

```bash
pnpm test packages/core/test/bootstrap.test.ts packages/webrtc/test/flow-control.test.ts
pnpm type-check
```

### Done when

- Core no longer assumes `totalChunks: 1` for every transfer.
- Tests prove chunking path and legacy small-piece path.

---

## G95-02 — Transfer telemetry and speed reporting

### Target files

- `packages/core/src/index.ts`
- `packages/webrtc/src/index.ts`
- `packages/cli/src/cli-runtime.ts`
- `packages/cli/src/coordinator-runtime.ts`
- `apps/demo/src/main.tsx`
- `scripts/perf-500mb.mjs`
- `scripts/multi-provider-grid-qa.mjs`

### Current evidence

- `packages/core/src/index.ts:52-57` declares `transfer:speed` and `buffer:watermark`.
- `apps/demo/src/main.tsx:328-338` contains hard-coded `speedBps: 18_400_000`.
- `scripts/perf-500mb.mjs:1-43` reports synthetic throughput.

### Required changes

1. Add telemetry collector for per-file and per-peer transfer windows.
2. Emit `transfer:speed` events every 1s and on completion.
3. Emit `buffer:watermark` from WebRTC wrapper into engine telemetry.
4. Record retry/reject/timeout counts in transfer summary.
5. Remove or relabel hard-coded UI speed.
6. Mark synthetic reports with `synthetic: true` and `networkMeasured: false`.
7. Add CLI `--json` transfer summary with speed, piece count, provider counts, retry counts.

### Acceptance criteria

- Core test observes `transfer:speed` after a real piece transfer.
- Browser UI speed is measured or hidden, never hard-coded.
- CLI direct transfer JSON includes `averageThroughputBps`, `peakThroughputBps`, `durationMs`, `retryCount`, `providerCounts`.
- Synthetic perf scripts include explicit metadata preventing misuse as network speed.

### Verification commands

```bash
pnpm test packages/core/test/bootstrap.test.ts packages/cli/test/cli-direct.integration.test.ts
pnpm perf:500mb
pnpm grid:multi-provider-qa -- --out /tmp/ponswarp-grid-g95-telemetry.json --size-mib 64 --piece-mib 1
```

### Done when

- Product/browser/CLI reports can distinguish synthetic, local, LAN, relay, and cross-network speed.

---

## G95-03 — Browser product share/get flow

### Target files

- `apps/demo/src/main.tsx`
- `apps/demo/src/web-product.ts`
- `apps/demo/test/web-product.test.ts`
- browser E2E test files to be added
- `docs/15-grid-user-guide.md`

### Current evidence

- `apps/demo/src/main.tsx:328-341` local object URL path simulates progress.
- `README.md:57-60` states coordinator `share/get` only direct-join executes when provider hint exists.

### Required changes

1. Separate UI modes:
   - local demo,
   - signaled direct session,
   - coordinator product mode.
2. Add coordinator client for:
   - resolve share,
   - fetch candidates,
   - request connect grant,
   - fetch ICE config.
3. Replace fake remote planning state with real unresolved/coordinator-unavailable/error states.
4. Wire product mode to WebRTC signaling route `/ws/grid/*` or explicit compatible route.
5. Persist receive state through OPFS/IndexedDB and support reload resume.
6. Add accessible status/error/success states.

### Acceptance criteria

- Pasting a code performs a real resolve request in product mode.
- Unknown/expired/revoked code shows safe error without leaking extra metadata.
- Browser E2E completes: share → resolve → connect → transfer → reload resume → download.
- Browser strict relay E2E completes at 10MiB minimum without manual piece-size override.
- UI copy clearly recommends CLI for large/restricted-network paths when browser safe-save is unavailable.

### Verification commands

```bash
pnpm test apps/demo/test/web-product.test.ts
pnpm --filter @ponswarp/demo build
# Add and run browser E2E command after harness exists.
```

### Done when

- Demo-only UX cannot be mistaken for production share-code transfer.
- Product mode has automated browser proof.

---

## G95-04 — CLI product completion

### Target files

- `packages/cli/src/index.ts`
- `packages/cli/src/cli.ts`
- `packages/cli/src/cli-runtime.ts`
- `packages/cli/src/coordinator-runtime.ts`
- `packages/cli/src/node-file-storage.ts`
- `packages/cli/test/*`

### Current evidence

- `packages/cli/src/cli.ts:43-45` throws for `status` and `clean`.
- `packages/cli/src/coordinator-runtime.ts:255-276` executes only direct-join if hint exists; otherwise unavailable.

### Required changes

1. Implement `status` for direct/grid sessions.
2. Implement `clean` with safe filters:
   - `--completed`,
   - `--failed`,
   - `--older-than`,
   - `--dry-run`.
3. Add structured transfer reports for direct and grid paths.
4. Complete coordinator `get` behavior:
   - direct hint path,
   - coordinator-mediated path if available,
   - explicit unsupported remediation if not.
5. Add resumable 100MiB+ CLI integration test with process interruption.
6. Add `--report-json <path>` for QA artifacts.

### Acceptance criteria

- `status` exits 0 with active/completed session details.
- `clean --dry-run` never deletes files.
- `clean --completed` deletes only completed session cache.
- Interrupted CLI receiver rerun resumes verified pieces and produces hash match.
- Coordinator `get` test covers available, unavailable, expired, no-candidate, direct-hint, and grant paths.

### Verification commands

```bash
pnpm test packages/cli/test/parser.test.ts packages/cli/test/cli-storage.test.ts packages/cli/test/cli-direct.integration.test.ts packages/cli/test/cli-grid.integration.test.ts packages/cli/test/coordinator-runtime.test.ts
pnpm type-check
```

### Done when

- CLI is the recommended large-file path with session lifecycle UX, not only a low-level demo primitive.

---

## G95-05 — Coordinator contract and route alignment

### Target files

- `packages/cli/src/coordinator-runtime.ts`
- `packages/cli/test/coordinator-runtime.test.ts`
- `packages/signaling/src/server.ts` or new local dev coordinator package
- `apps/demo/src/main.tsx`
- `deploy/grid.ponslink.nginx.conf`
- `deploy/ponswarp-grid-coordinator.service`
- `scripts/validate-grid-deployment-config.mjs`
- `docs/04-protocol-spec.md`

### Current evidence

- TS server implements `/api/grid/v1/ice` only from coordinator API surface: `packages/signaling/src/server.ts:374-376`.
- Nginx proxies `/api/grid/v1/` and `/ws/grid/`: `deploy/grid.ponslink.nginx.conf:51-65`.
- Systemd points to external Rust `mesh_api`: `deploy/ponswarp-grid-coordinator.service:10-12`.

### Required changes

1. Write coordinator OpenAPI-like contract or JSON schema fixtures.
2. Make CLI/browser route constants derive from contract.
3. Decide local dev strategy:
   - external Rust coordinator required, or
   - minimal TS dev coordinator for local tests only.
4. Add contract test that validates every CLI/browser route against spec.
5. Align WebSocket route:
   - either clients use `/ws/grid/`, or nginx/server intentionally support `/ws` compatibility.
6. Update deployment validator to test route behavior, not string presence only.

### Acceptance criteria

- Contract lists every route used by CLI and browser.
- Tests fail if CLI calls a non-contract route.
- Deployment config and client default routes match.
- A local smoke test proves health/ready/ICE/share/resolve/candidates/connect route responses.
- Docs state whether coordinator runtime is external Rust or TS dev-only.

### Verification commands

```bash
pnpm test packages/cli/test/coordinator-runtime.test.ts packages/signaling/test/signaling.test.ts
pnpm deploy:validate-grid -- --out /tmp/ponswarp-grid-deploy-validation.json
```

### Done when

- There is no ambiguity about where production coordinator behavior lives.

---

## G95-06 — Cross-network matrix harness

### Target files

- `scripts/turn-diagnostics.mjs`
- new `scripts/network-matrix-qa.mjs`
- `docs/10-release-qa-gates.md`
- `docs/11-multi-device-qa-report-template.md`
- `README.md`
- `artifacts/`

### Current evidence

- `artifacts/remaining-network-qa-report.md:28-36` says TCP/TLS URL-form tests selected relay/udp.
- `docs/10-release-qa-gates.md:168-189` warns not to overclaim TCP/TLS-only fallback.

### Required changes

1. Add network matrix report schema.
2. Extend `turn-diagnostics` to emit speed and memory summary for configurable transfer size.
3. Add matrix runner that can record manual/automated results.
4. Add UDP-blocked TCP/TLS procedure.
5. Add LTE/5G test procedure.
6. Add report comparison script for baseline regressions.

### Matrix acceptance criteria

| ID | Required before 95% |
|---|---|
| NET-001 loopback | pass |
| NET-002 same Wi-Fi | pass |
| NET-003 different NAT/Wi-Fi | pass or documented unavailable with replacement evidence |
| NET-004 LTE/5G | pass |
| NET-005 relay-only UDP | pass |
| NET-006 UDP-blocked TCP/TLS | pass or explicit public-beta waiver |
| NET-007 reconnect/resume | pass |
| NET-008 100MiB+ relay | pass or explicit product size limit UX pass |

### Verification commands

```bash
pnpm turn:diagnose -- --ice-server-json artifacts/.turn-ice.json --mode transfer --expect relay-any --transfer-bytes 10485760 --out artifacts/net-005-relay-udp-report.json
pnpm turn:diagnose -- --ice-server-json artifacts/.turn-ice.json --mode transfer --expect relay-tcp --transfer-bytes 10485760 --out artifacts/net-006-relay-tcp-report.json
```

### Done when

- Speed by network topology is a measured report, not an inference.

---

## G95-07 — Large-file and relay readiness

### Target files

- `scripts/perf-500mb.mjs`
- `scripts/multi-provider-grid-qa.mjs`
- `packages/cli/test/*`
- `apps/demo/src/main.tsx`
- new large-file QA scripts

### Required changes

1. Add real disk-backed CLI 500MiB transfer QA script.
2. Add browser 100MiB relay QA scenario or explicit unsupported UX gate.
3. Add memory ceiling assertions for browser and CLI.
4. Add final hash proof for all large-file runs.
5. Record piece/chunk sizes and transfer path.

### Acceptance criteria

- CLI 500MiB direct transfer completes with SHA-256 match and bounded memory.
- CLI 500MiB resume after interruption completes with SHA-256 match.
- Browser 100MiB relay either passes or shows CLI recommendation before unsafe transfer.
- Synthetic 500MiB script remains but is labeled synthetic.

### Verification commands

```bash
pnpm perf:500mb
pnpm grid:multi-provider-qa -- --out artifacts/g95-multi-provider-128mib-report.json --size-mib 128 --piece-mib 1
# Add real disk-backed CLI large-file QA command after script is implemented.
```

### Done when

- Large-file readiness is proven on real transfer path, not only memory loop.

---

## G95-08 — Production hardening validation

### Target files

- `deploy/*`
- `scripts/validate-grid-db-readiness.mjs`
- `scripts/validate-grid-security-release.mjs`
- `scripts/mesh-postgres-drill.mjs`
- external coordinator repo if applicable
- `docs/08-production-hardening-design.md`
- `docs/09-final-production-architecture-summary.md`
- `docs/10-release-qa-gates.md`

### Required changes

1. Validate Postgres persistence with restart/DR drill.
2. Validate node tokens and workspace auth.
3. Validate share code entropy/revocation/expiry.
4. Validate rate limit/quota and abuse paths.
5. Validate metrics are present and access-controlled.
6. Validate cleanup/retention jobs.
7. Validate `/readyz` dependency failure behavior.

### Acceptance criteria

- Expired/revoked share cannot resolve/candidate/connect.
- Server restart preserves unexpired share metadata.
- Rate limit blocks scripted abuse without blocking normal transfer.
- Metrics include transfer start/complete/failure, relay usage, candidate errors, DB errors.
- Incident runbook maps every alert to an operator action.

### Verification commands

```bash
pnpm deploy:validate-db -- --out artifacts/g95-db-readiness-report.json
pnpm deploy:validate-security -- --out artifacts/g95-security-release-report.json
pnpm mesh:postgres-drill -- --out artifacts/g95-postgres-drill-report.json
```

### Done when

- Production hardening gates are executable and tied to artifacts.

---

## G95-09 — Docs and release gate alignment

### Target files

- `README.md`
- `docs/00-docs-index.md`
- `docs/04-protocol-spec.md`
- `docs/05-test-plan.md`
- `docs/10-release-qa-gates.md`
- `docs/11-multi-device-qa-report-template.md`
- `docs/15-grid-user-guide.md`
- `deploy/*runbook*.md`

### Required changes

1. Update docs only after implementation/report evidence exists.
2. Label synthetic/local/relay/network speed separately.
3. Remove or qualify stale claims that coordinator byte transfer is available.
4. Add 95% scorecard and gate links.
5. Add troubleshooting for product coordinator vs direct fallback.
6. Add operator runbook entries for TURN, coordinator, DB, quota, abuse, stale peers.

### Acceptance criteria

- README has a “validated matrix” table with artifact links.
- User guide does not instruct unavailable paths as primary success path.
- Release gates distinguish private beta, public beta, GA.
- Docs index includes new design/work-order docs.

### Verification commands

```bash
pnpm deploy:validate-onboarding -- --out /tmp/ponswarp-grid-onboarding-validation.json
pnpm deploy:validate-private-beta -- --out /tmp/ponswarp-grid-private-beta-validation.json
```

### Done when

- Docs cannot overclaim beyond available artifacts.

---

## G95-10 — Final 95% verification sweep

### Target files

- all changed packages
- `artifacts/g95-final-readiness-report.json`
- `artifacts/g95-final-readiness-report.md`

### Required checks

1. `pnpm test`
2. `pnpm type-check`
3. `pnpm build`
4. Core chunk/retry/resume test suite
5. CLI direct/grid/coordinator test suite
6. Browser E2E suite
7. 500MiB CLI large-file run
8. 100MiB+ browser relay or explicit unsupported UX pass
9. Network matrix NET-001 through NET-008
10. Deployment/security/db validators
11. Docs validation
12. Manual artifact inventory check

### Acceptance criteria

- Final scorecard >=95/100.
- No unwaived SEV-1.
- Every waiver has owner, expiration, user impact, rollback trigger.
- Final report states:
  - what is production-ready,
  - what is private-beta only,
  - what remains unsupported,
  - exact artifact links.

### Done when

- `artifacts/g95-final-readiness-report.md` says `Verdict: 95% READY` with evidence table.

---

## 5. Suggested execution sequence

### Phase 0 — Contract freeze

1. Confirm 95% scorecard.
2. Freeze coordinator route contract.
3. Freeze telemetry report schema.
4. Freeze network matrix schema.

Exit criteria:

- Contract docs merged.
- No implementation lane invents a second route/schema convention.

### Phase 1 — Core correctness

1. G95-01 chunked transfer.
2. G95-02 telemetry core events.
3. Regression tests.

Exit criteria:

- Core and WebRTC tests pass.
- Multi-provider fake transport still passes.

### Phase 2 — Product flows

1. G95-03 browser product flow.
2. G95-04 CLI completion.
3. G95-05 coordinator contract alignment.

Exit criteria:

- Browser and CLI can complete product transfer against contract target or dev coordinator.
- Direct fallback remains available and documented.

### Phase 3 — Network/performance gates

1. G95-06 network matrix.
2. G95-07 large-file/relay readiness.
3. G95-08 hardening validation.

Exit criteria:

- Artifact-backed speed matrix exists.
- 100MiB+/500MiB paths have real transfer evidence or explicit product limits.

### Phase 4 — Docs/final verification

1. G95-09 docs alignment.
2. G95-10 final sweep.

Exit criteria:

- Final readiness report generated.
- Completion score >=95.

---

## 6. Staffing guidance

Recommended parallel lanes:

| Lane | Role | Packages | Reason |
|---|---|---|---|
| Core protocol | Core engine engineer | `packages/core`, `packages/webrtc` | Chunking/retry correctness blocks all transfer paths |
| Product clients | Frontend/WebRTC engineer + CLI engineer | `apps/demo`, `packages/cli` | Browser/CLI UX and telemetry must align |
| Coordinator/API | Backend/API integrator | `coordinator-runtime`, deploy docs, external coordinator | Biggest production gap |
| QA/performance | QA/network/performance engineer | `scripts`, `artifacts`, e2e | Converts claims into measured gates |
| Docs/release | Technical writer/release owner | `README`, `docs`, `deploy` | Prevents overclaiming and keeps gates executable |

Do not run all lanes without a contract freeze. Route/schema drift is the main coordination risk.

---

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---:|---|
| Coordinator source-of-truth split between TS repo and Rust `mesh_api` | High | Freeze API contract and make tests consume contract fixtures |
| Chunking rewrite breaks existing direct transfer | High | Keep direct small-piece compatibility tests and CLI integration tests |
| Network tests become manual-only and non-repeatable | High | Add JSON schema and required fields; store artifacts with topology metadata |
| Synthetic throughput gets marketed as real speed | High | Add `synthetic: true`, update docs, forbid claim without topology report |
| Browser relay costs/performance make 100MiB+ unrealistic | Medium | Explicit product limit UX + CLI recommendation is acceptable if verified |
| External coordinator unavailable blocks repo-local testing | Medium | Provide dev coordinator stub or documented external setup with skip markers |
| More telemetry increases overhead | Medium | Sample windows, avoid per-byte events, benchmark overhead |

---

## 8. Definition of done for 95%

The project reaches 95% only when all are true:

- [ ] Scorecard in `docs/16-grid-95-completion-design.md` reaches >=95/100.
- [ ] `pnpm test`, `pnpm type-check`, `pnpm build` pass.
- [ ] Core multi-chunk tests pass.
- [ ] CLI status/clean/direct/grid/coordinator tests pass.
- [ ] Browser product E2E passes.
- [ ] Network matrix reports exist for required topologies.
- [ ] 500MiB CLI transfer or equivalent large-file report exists.
- [ ] 100MiB+ browser relay pass or explicit unsupported UX pass exists.
- [ ] Coordinator route contract and deployment routes match.
- [ ] Security/db/rate-limit/metrics/cleanup validators pass or have documented waivers.
- [ ] README/user guide/release gates match evidence.
- [ ] Final readiness report is written under `artifacts/`.

---

## 9. Immediate next command set after implementation starts

Baseline before first code change:

```bash
pnpm test
pnpm type-check
pnpm build
pnpm perf:500mb
pnpm grid:multi-provider-qa -- --out artifacts/g95-baseline-multi-provider-grid-report.json --size-mib 64 --piece-mib 1
```

After each major lane:

```bash
pnpm test
pnpm type-check
```

Before final 95% claim:

```bash
pnpm test
pnpm type-check
pnpm build
pnpm perf:500mb
pnpm grid:multi-provider-qa -- --out artifacts/g95-final-multi-provider-grid-report.json --size-mib 128 --piece-mib 1
pnpm deploy:validate-grid -- --out artifacts/g95-final-deployment-validation-report.json
pnpm deploy:validate-security -- --out artifacts/g95-final-security-validation-report.json
pnpm deploy:validate-db -- --out artifacts/g95-final-db-validation-report.json
pnpm deploy:validate-onboarding -- --out artifacts/g95-final-onboarding-validation-report.json
pnpm deploy:validate-private-beta -- --out artifacts/g95-final-private-beta-validation-report.json
```

Network commands depend on temporary TURN credentials and target devices. Store secret ICE credential files outside git and delete them after use.
