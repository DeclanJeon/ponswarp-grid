# PonsWarp Mesh Release QA Gates

문서 버전: v0.1
작성일: 2026-07-04
상태: release candidate 검증 템플릿, production-ready 선언 아님

## 1. 목적

이 문서는 mesh/coordinator 기능을 staging, private beta, public beta로 올리기 전에 실행해야 하는 release QA gate를 정의한다. 모든 항목은 실제 실행 결과, 로그/메트릭 스냅샷, rollback 판단 근거를 남기는 체크리스트로 사용한다.

## 2. 실행 전 전제

- 대상 환경: `staging` 또는 `beta`; production 공개 전에는 `PONSWARP_MESH_ENABLED=true`를 production 기본값으로 두지 않는다.
- 테스트 데이터는 실제 개인정보가 아닌 synthetic workspace, node, share, file metadata를 사용한다.
- 기존 non-mesh `/ws`, `/health`, `/ready` 경로는 mesh gate 중에도 별도 regression 관측 대상이다.
- 실패한 gate는 원인, 영향 범위, 재시도 결과가 기록되기 전까지 go로 처리하지 않는다.

## 3. Gate A: Mesh API load

| ID | Endpoint/Flow | Load shape | Pass criteria | Evidence |
|---|---|---:|---|---|
| L-01 | `POST /api/mesh/workspaces` or workspace ensure path | 10 rps for 5 min | p95 < 300 ms, error rate < 1%, duplicate ensure is idempotent | load report, API logs, DB row count |
| L-02 | `POST /api/mesh/nodes/register` | 50 rps for 10 min | p95 < 300 ms, no duplicate primary-key failures exposed as 5xx | load report, structured error sample |
| L-03 | heartbeat/presence update | 1,000 active nodes, 60s heartbeat for 30 min | error rate < 1%, stale presence count matches TTL policy | metrics graph, cleanup log |
| L-04 | publish file metadata | 25 rps for 10 min, mixed file sizes | p95 < 400 ms, manifest validation rejects malformed input with 4xx | request corpus, API status summary |
| L-05 | candidate/share resolve | 100 rps for 15 min | p95 < 300 ms, revoked/expired shares remain denied | load report, policy assertion log |
| L-06 | event/audit ingest | 200 rps for 10 min | no event loss beyond documented sampling policy, p95 < 500 ms | event count comparison, log sample |
| L-07 | existing signaling impact | run existing `/ws` smoke traffic during L-01 to L-06 | existing room signaling error/latency does not materially degrade | before/during metric snapshot |

### Gate A result

- Owner:
- Date/time:
- Environment/build SHA:
- Overall result: `PASS` / `FAIL` / `RETRY REQUIRED`
- Failed IDs and blocker links:
- Artifact paths:

## 4. Gate B: Rate-limit and abuse behavior

| ID | Scenario | Steps | Expected result | Evidence |
|---|---|---|---|---|
| R-01 | single IP burst | Send 10x normal request rate to workspace/node/share endpoints for 2 min. | Requests above quota receive documented 429/403 without process crash. | status distribution, rate-limit log |
| R-02 | per-workspace quota | Use multiple nodes under one workspace to exceed workspace quota. | Workspace is throttled while unrelated workspace remains healthy. | quota counters, control workspace results |
| R-03 | bad token/public key | Register/publish/resolve with missing, malformed, revoked, and wrong-scope credentials. | Denied with 401/403, no metadata leak in response body. | negative-case transcript |
| R-04 | share enumeration | Probe random/expired/revoked share codes at high rate. | Uniform denial shape, no valid-code oracle, throttling activates. | response sample set, log excerpt |
| R-05 | oversized payload | Send oversized manifest, tags, endpoint hints, and event bodies. | 413/422/400 as appropriate; no unbounded memory growth. | request corpus, memory metric |
| R-06 | reconnect storm | Restart 100 clients simultaneously after a network drop. | Server remains responsive, retries are bounded, reconnect logs are structured. | client log, server metric |

### Gate B result

- Owner:
- Date/time:
- Environment/build SHA:
- Overall result: `PASS` / `FAIL` / `RETRY REQUIRED`
- Abuse controls enabled:
- Exceptions approved by:
- Artifact paths:

## 5. Gate C: Cleanup and retention

| ID | Data class | Retention expectation | Check | Pass criteria |
|---|---|---|---|---|
| C-01 | presence | TTL-based expiry, default target 5 minutes after last heartbeat unless config says otherwise | Stop a node, wait past TTL, run/observe cleanup. | Node disappears from candidate results; cleanup count metric/log emitted. |
| C-02 | expired share | share denied after `expires_at` | Create short-lived share, wait for expiry, resolve before and after cleanup. | Resolve is denied after expiry; cleanup does not revive or delete active shares. |
| C-03 | revoked share | immediate deny, retained audit event | Revoke a share and attempt resolve/download. | 403/404 policy result, audit event present. |
| C-04 | soft-deleted file metadata | hidden from list/candidates before hard delete | Delete file metadata with retention grace active. | Normal list/candidate APIs exclude it; audit/debug can explain state. |
| C-05 | event/audit retention | retention job removes or anonymizes old rows only | Seed old/new events and run cleanup. | Old rows processed, new rows untouched, batch limit respected. |
| C-06 | batch safety | cleanup cannot monopolize API path | Seed cleanup backlog larger than one batch. | Job exits after batch limit, emits continuation metric, API stays healthy. |
| C-07 | cleanup lock | duplicate cleanup workers do not double-process | Start two workers or overlapping schedules. | One worker owns lock; duplicate exits/skips with log. |
| C-08 | failure isolation | cleanup failure does not break main API | Inject DB error or invalid row fixture in cleanup scope. | Main mesh read/write and existing `/ws` remain healthy; error alert/log emitted. |

### Gate C result

- Owner:
- Date/time:
- Retention config under test:
- Overall result: `PASS` / `FAIL` / `RETRY REQUIRED`
- Rows before/after by table:
- Cleanup logs/metrics paths:

## 6. Gate D: Restart persistence and disaster recovery

| ID | Scenario | Steps | Expected result | Evidence |
|---|---|---|---|---|
| D-01 | clean restart | Create workspace, node, file, share, availability; restart mesh/coordinator process. | Unexpired records are restored and resolve/list APIs work. | pre/post API transcript |
| D-02 | crash during active presence | Kill process during active heartbeat traffic and restart. | Presence recovers according to TTL; stale candidates are not served past expiry. | heartbeat/client log |
| D-03 | backup/restore | Take staging DB backup, restore into fresh DB/process. | Workspace, node token/key validation, unexpired share resolve, revoked/expired deny all match source. | restore log, API checks |
| D-04 | migration rollback drill | Apply migration to staging clone and run documented rollback/down strategy if supported. | Rollback path is documented and tested, or explicitly marked irreversible with restore procedure. | migration log, restore procedure |
| D-05 | feature flag rollback | Turn `PONSWARP_MESH_ENABLED=false` and restart/roll deploy. | Mesh APIs disabled safely; existing `/ws`, `/health`, `/ready` remain healthy. | config diff, smoke transcript |
| D-06 | coordinator isolation | Mesh DB unavailable while legacy signaling is checked. | Existing non-mesh signaling is not blocked by mesh DB dependency. | outage drill log |

### Gate D result

- Owner:
- Date/time:
- Backup artifact:
- Restore target:
- Overall result: `PASS` / `FAIL` / `RETRY REQUIRED`
- Rollback command/procedure exercised:
- Artifact paths:

## 7. Gate E: Metrics and logs

| ID | Required signal | Check | Pass criteria |
|---|---|---|---|
| M-01 | request count/latency/error by route | Inspect dashboard or metric export during load. | Route labels are bounded; p50/p95/p99 and status codes are visible. |
| M-02 | rate-limit decisions | Trigger R-01/R-02. | Allow/deny counters include limit dimension without leaking secrets. |
| M-03 | cleanup counters | Trigger C-01 to C-08. | Started/completed/failed/deleted/skipped/locked counters or logs exist. |
| M-04 | audit/security events | Trigger auth failure, revoke, expired share, admin delete. | Events include workspace/node/share identifiers needed for investigation, no token secrets. |
| M-05 | restart/ready state | Restart process and DB. | Readiness reflects dependencies; startup log includes build/version/config flags. |
| M-06 | alert routing | Force one safe synthetic alert. | Alert reaches configured channel with runbook link and severity. |

### Gate E result

- Owner:
- Date/time:
- Dashboard links:
- Alert links:
- Missing signals:
- Overall result: `PASS` / `FAIL` / `RETRY REQUIRED`

## 8. Rollback criteria

Rollback or keep mesh disabled when any of these are true:

- Existing `/ws`, `/health`, `/ready`, auth, billing, or cloud path regresses.
- Any mesh API load gate has sustained 5xx > 1% or p95 exceeds target by more than 2x after retry.
- Rate-limit/abuse tests expose metadata, token, workspace, or share-code leakage.
- Cleanup deletes active records, revives expired/revoked records, or blocks the main API path.
- Restart/restore loses unexpired shares, workspace membership, node authorization, or file metadata.
- Required metrics/logs are absent for a failing path.
- Rollback/feature-flag-off drill is untested for the candidate build.

## 9. Go / no-go record

| Field | Value |
|---|---|
| Release candidate/build SHA | |
| Environment | |
| Gate A Mesh API load | `PASS` / `FAIL` / `WAIVED` |
| Gate B Rate-limit/abuse | `PASS` / `FAIL` / `WAIVED` |
| Gate C Cleanup/retention | `PASS` / `FAIL` / `WAIVED` |
| Gate D Restart/DR | `PASS` / `FAIL` / `WAIVED` |
| Gate E Metrics/logs | `PASS` / `FAIL` / `WAIVED` |
| Multi-device QA report | link to `docs/11-multi-device-qa-report-template.md` instance |
| Open blockers | |
| Waivers and approver | |
| Rollback owner | |
| Decision | `NO-GO` / `STAGING ONLY` / `PRIVATE BETA` / `PUBLIC BETA` |
| Decision timestamp | |
| Approvers | |

A `PUBLIC BETA` or broader decision requires all non-waived gates to pass and every waiver to include owner, expiration date, user impact, and rollback trigger.

## 10. Current TURN release-gate evidence

Latest pre-production TURN check: `artifacts/production-g001-turn-release-gate-report.md`.

| Gate | Current result | Production interpretation |
|---|---|---|
| TURN UDP relay candidate | `PASS` | Private-beta relay path may be enabled with monitoring. |
| Browser relay-only transfer | `PASS` | Staging browser transfer completed with `iceTransportPolicy=relay`. |
| TCP TURN URL candidate | `SUPERSEDED BY TLS TRANSFER PASS` | Use `artifacts/public-g001-turn-tcp-only-report.json` as the current TCP/TLS-family evidence. |
| TLS TURN URL transfer | `PASS` | Chromium relay-only transfer completed through TURN/TLS; selected pair has `localCandidateType="relay"` and `localRelayProtocol="tls"`. |
| UDP-blocked TCP/TLS-only transfer | `PASS FOR TESTED TURN/TLS PATH` | The diagnostic used only TCP/TLS TURN URLs and completed a relay-only DataChannel transfer. Continue monitoring real user networks after beta enablement. |

Do not claim “TCP/TLS-only fallback fully validated” until a transfer artifact proves a selected `relay/tcp` or TLS relay candidate pair under UDP-denied conditions.

## 11. TURN TCP/TLS-only diagnostic procedure

Run the reusable credential fetcher and diagnostic harness before changing this gate from `REQUIRED BEFORE PUBLIC BETA`:

```sh
pnpm turn:fetch-ice -- --out artifacts/.turn-ice.json --signal wss://warp.ponslink.com/ws
pnpm turn:diagnose -- --ice-server-json artifacts/.turn-ice.json --mode transfer --expect relay-tcp --out artifacts/public-g001-turn-tcp-tls-report.json
rm artifacts/.turn-ice.json
```

`artifacts/.turn-ice.json` must contain only temporary TURN credentials and must not be committed. A public-production pass requires the generated report to show:

- `iceTransportPolicy: "relay"`
- `selectedCandidatePair.localCandidateType: "relay"`
- `selectedCandidatePair.localProtocol: "tcp"` or `selectedCandidatePair.localRelayProtocol: "tcp" | "tls"`
- `transfer.complete: true` for transfer mode
- `verdict: "passed"`
- `classification.observedRelayProtocol: "tls"` is accepted as TLS relay proof even when WebRTC exposes the relayed media candidate protocol as UDP.

A report with `verdict: "inconclusive"` may prove relay reachability, but it does not close the TCP/TLS-only gate. Keep this distinction in release notes and go/no-go decisions.
