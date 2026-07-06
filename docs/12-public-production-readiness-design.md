# PonsWarp Public Production Readiness Design

문서 버전: v1.0
작성일: 2026-07-04
상태: 구현 지시 기준 설계
대상 repo:
- `ponswarp-grid`
- `/home/declan/Documents/Develop/Project/ponswarp/ponswarp-signaling-rs`

## 1. 목적

PonsWarp Grid를 private beta 수준에서 public production 후보 수준으로 올리기 위해 남은 5개 gate를 순차적으로 닫는다.

1. TURN TCP/TLS-only 검증
2. Postgres 운영 검증
3. RBAC/token/audit 완성
4. 분산 rate limit / abuse 방어
5. multi-provider 대용량 grid 검증

본 문서는 설계, 구현 경계, QA 증거, go/no-go 기준을 정의한다. 기존 운영 `warp.ponslink.com`의 `/ws`, `/health`, `/ready`, auth, billing, cloud 기능은 회귀되면 안 된다.

## 2. 최종 운영 구조

```text
warp.ponslink.com
  - 기존 signaling/cloud/auth/billing 운영
  - mesh 기능은 기본 disabled
  - legacy /ws 장애 격리 최우선

mesh.warp.ponslink.com 또는 staging mesh host
  - 별도 mesh coordinator process
  - Postgres authoritative persistence
  - node token + workspace RBAC
  - distributed quota/rate limit
  - metrics/audit/cleanup

ponswarp-grid CLI/Web
  - share/register/get/grid transfer client
  - coordinator endpoint 설정 가능
  - TURN relay policy/diagnostic harness 제공
```

## 3. Gate 1: TURN TCP/TLS-only 검증

### 3.1 문제

기존 증거는 UDP relay와 browser relay-only transfer는 통과했지만, UDP가 차단된 네트워크에서 selected candidate pair가 `relay/tcp` 또는 TLS relay로 고정되는지 증명하지 못했다.

### 3.2 설계

#### TURN diagnostic harness

`ponswarp-grid`에 TURN 진단 스크립트를 둔다.

```text
scripts/turn-diagnostics.mjs
```

입력:

```text
--ice-server-json <json-or-file>
--policy relay
--mode candidate|transfer
--expect relay-tcp|relay-udp|relay-any
--timeout-ms 30000
--out artifacts/<report>.json
```

출력 report:

```json
{
  "schemaVersion": 1,
  "kind": "turn-diagnostic-report",
  "mode": "candidate|transfer",
  "iceTransportPolicy": "relay",
  "selectedCandidatePair": {
    "localCandidateType": "relay",
    "localProtocol": "tcp|udp",
    "remoteCandidateType": "relay",
    "remoteProtocol": "tcp|udp"
  },
  "transfer": {
    "bytes": 30,
    "sha256Match": true
  },
  "verdict": "passed|failed|inconclusive"
}
```

#### UDP-denied test strategy

우선순위:

1. OS/firewall 또는 network namespace로 UDP egress 차단 후 TCP/TLS TURN 테스트
2. 별도 LTE/mobile network에서 UDP-denied APN/방화벽 조건 테스트
3. 운영 TURN 서버가 TCP/TLS listener를 실제 노출하는지 `turnutils_uclient` 또는 browser WebRTC stats로 확인

### 3.3 통과 기준

- UDP 차단 상태에서 browser 또는 Node WebRTC가 relay-only로 연결된다.
- selected candidate pair의 local protocol이 `tcp`이거나 TLS TURN URL에서 relay transfer가 성공한다.
- 실패 시 원인이 `TURN 서버 TCP/TLS listener 미노출`, `credential`, `network`, `browser limitation` 중 하나로 분류된다.
- `docs/10-release-qa-gates.md`가 실제 결과를 과장 없이 반영한다.

## 4. Gate 2: Postgres 운영 검증

### 4.1 문제

Memory repository는 서버 재시작 시 workspace/share/node/file/presence가 사라진다. Postgres repository가 구현되어도 운영 관점에서는 migration, restart, backup/restore, cleanup, feature flag rollback이 검증되어야 한다.

### 4.2 설계

#### Authoritative tables

기존 `202607040001_mesh_repository_foundation.sql` migration을 기준으로 한다.

필수 검증 데이터:

- workspace
- approved node
- node token hash
- file metadata
- availability
- unexpired share
- revoked share
- expired share
- audit event

#### Operational drill script

```text
scripts/mesh-postgres-drill.mjs
```

역할:

1. disposable Postgres URL 확인
2. migration 실행 또는 적용 상태 확인
3. mesh coordinator 실행
4. fixture 생성
5. process restart
6. pre/post API 비교
7. cleanup 실행
8. backup/restore 절차가 가능한 환경이면 dump/restore 수행

통과 report:

```json
{
  "kind": "postgres-operational-drill-report",
  "migration": "passed",
  "restartPersistence": "passed",
  "cleanup": "passed",
  "featureFlagRollback": "passed",
  "legacySignalingIsolation": "passed"
}
```

### 4.3 통과 기준

- unexpired share는 restart 후 resolve 가능
- revoked/expired share는 restart 후에도 deny
- stale presence cleanup 후 candidates에서 제외
- mesh DB unavailable 상태에서도 legacy signaling server는 기존 `/ws` ready를 막지 않음
- rollback/restore 절차 문서화

## 5. Gate 3: RBAC / token / audit

### 5.1 Actor 모델

```text
Anonymous        public share resolve/candidates only
User             workspace role 기반 관리
Node             own-node heartbeat/publish/availability/share only
Admin            운영/감사/차단
```

### 5.2 Token 모델

- node 등록 시 node token 발급
- DB에는 token hash만 저장
- token scope: `heartbeat`, `publish_file`, `update_availability`, `create_share`, `revoke_own_share`
- revoke 시 즉시 사용 불가
- token raw value는 log/audit에 남기지 않음

### 5.3 권한 매트릭스

| Flow | Anonymous | Node own scope | Workspace member | Workspace admin | Admin |
|---|---:|---:|---:|---:|---:|
| resolve share | yes, valid code | yes | yes | yes | yes |
| candidates for share | yes, valid code | yes | yes | yes | yes |
| create workspace | no | no | yes quota | yes | yes |
| register node | no | no | yes | yes | yes |
| heartbeat | no | own node | no | no | yes |
| publish file | no | own node | yes | yes | yes |
| create share | no | own file/node | yes | yes | yes |
| revoke share | no | own share scope | own share | workspace | yes |
| list workspace files | no | scoped | yes | yes | yes |

### 5.4 Audit requirements

`mesh_events`에 반드시 남길 이벤트:

- workspace_created
- node_registered
- node_token_issued(hash only)
- node_token_revoked
- file_published
- share_created
- share_resolved
- share_revoked
- auth_denied
- rate_limit_exceeded
- cleanup_started/completed/failed

## 6. Gate 4: Distributed rate limit / abuse

### 6.1 Key dimensions

```text
ip:<hash>
user:<id>
workspace:<id>
node:<workspace>:<node>
share:<code_hash>
route:<route_group>
```

### 6.2 Storage

Production target: Postgres-backed rate limit buckets with row-level upsert and TTL cleanup. Redis is optional later; current repo already has Postgres dependency, so first production candidate uses Postgres.

Table:

```sql
CREATE TABLE mesh_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  capacity DOUBLE PRECISION NOT NULL,
  refill_per_second DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
```

### 6.3 Route groups and defaults

| Group | Key | Default |
|---|---|---:|
| create_workspace | ip/user | 10/hour |
| register_node | ip/workspace/user | 30/hour |
| heartbeat | node | 60/min |
| publish_file | node/user | 120/hour |
| create_share | node/user/ip | 60/hour |
| resolve_share | ip/share | 120/min |
| candidates | ip/share | 60/min |
| event | ip/share/node | 120/min |

### 6.4 Response

429 body:

```json
{
  "error": "rate_limited",
  "retryAfterSeconds": 30,
  "requestId": "req_..."
}
```

Headers:

```text
Retry-After: <seconds>
X-RateLimit-Limit: <capacity>
X-RateLimit-Remaining: <remaining>
X-RateLimit-Reset: <unix seconds>
```

## 7. Gate 5: Multi-provider large-file grid

### 7.1 Objective

단일 sender WebRTC와 다른, 실제 grid 가치를 증명한다.

필수 증명:

- owner + provider A/B/C 중 여러 provider에서 조각을 가져온다.
- provider offline/churn 발생 시 remaining provider 또는 owner fallback으로 완료한다.
- resume이 piece checksum 기준으로 정확하다.
- receiver는 전체 파일을 메모리에 올리지 않고 bounded storage로 조립한다.

### 7.2 Scheduler contract

```ts
interface ProviderCandidate {
  nodeId: string;
  priority: number;
  verifiedRanges: PieceRange[];
  load?: { inflightPieces?: number; estimatedMbps?: number };
}

interface PieceAssignment {
  pieceIndex: number;
  providerNodeId: string;
  reason: 'fastest' | 'least-loaded' | 'owner-fallback' | 'retry-after-failure';
}
```

### 7.3 QA matrix

| Case | Size | Providers | Expected |
|---|---:|---:|---|
| MP-01 | 64MiB | owner+2 | at least 2 non-owner pieces used |
| MP-02 | 128MiB | owner+3 | churn one provider mid-transfer; hash match |
| MP-03 | 500MiB simulated | owner+4 | bounded memory and scheduler report |
| MP-04 | available disk | 1GiB+ real | final hash match, throughput report |

## 8. Artifact/report requirements

Every gate writes:

```text
artifacts/public-g00X-*-report.json|md
artifacts/public-g00X-quality-gate.json
```

Each report must contain:

- command/invocation
- environment
- version/commit when available
- pass/fail/inconclusive verdict
- quantitative metrics
- qualitative observations
- blockers and next action

## 9. Public production go/no-go

Public production remains `NO-GO` until all five gates have passed with fresh evidence. Private beta can proceed only for explicitly passed surfaces and with release notes that name unvalidated fallback paths.