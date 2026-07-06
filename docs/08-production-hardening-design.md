# PonsWarp Mesh Production Hardening Design

문서 버전: v0.2  
작성일: 2026-07-03  
대상 repo:

- `ponswarp-grid`
- `/home/declan/Documents/Develop/Project/ponswarp/ponswarp-signaling-rs`

## 1. 목적

현재 PonsWarp Mesh/share 기능은 Web-first/CLI MVP로 동작하지만, 운영 `warp.ponslink.com`에 바로 공개 활성화하기에는 다음 영역이 부족하다.

1. 메모리 기반 저장소
2. 인증/권한 모델
3. rate limit / abuse 방어
4. 운영 관측성
5. 데이터 수명 정책
6. 실제 멀티 디바이스 검증

이 문서는 위 6개 영역을 운영 배포 가능한 수준으로 보강하기 위한 구체 설계와 작업 단위를 정의한다.

## 2. 운영 배포 원칙

### 2.1 기본 원칙

- 기존 `warp.ponslink.com` 운영 기능(`/ws`, `/health`, `/ready`, cloud/auth/billing)은 절대 깨지면 안 된다.
- 새 mesh 기능은 feature flag 뒤에서만 활성화한다.
- 운영 서버 첫 배포는 반드시 `PONSWARP_MESH_ENABLED=false`로 진행한다.
- `PONSWARP_MESH_ENABLED=true`는 staging 또는 beta host에서 먼저 검증한다.
- mesh 기능은 저장소, 인증, rate limit, cleanup, observability가 들어간 뒤 운영 공개한다.

### 2.2 권장 rollout

```text
Phase 0. Code deployed, mesh disabled
  PONSWARP_MESH_ENABLED=false
  기존 서비스 health/ws/cloud/billing regression 확인

Phase 1. Staging mesh enabled
  mesh-beta.ponslink.com 또는 별도 process
  PONSWARP_MESH_ENABLED=true
  제한된 allowlist/test token으로 QA

Phase 2. Private beta
  실제 사용자/기기 5~20개 제한
  metrics/error/latency 관측
  rollback drill 완료

Phase 3. Public beta
  rate limit, abuse 방어, cleanup, retention 정책 활성화
  운영 dashboard/alert 활성화

Phase 4. General availability
  SLA/운영 runbook/incident 대응 문서 포함
```

## 3. 현재 MVP와 목표 상태 차이

| 영역 | 현재 상태 | 운영 목표 |
|---|---|---|
| 저장소 | `DashMap` 메모리 저장 | Postgres 영속 저장 + 재시작 복구 |
| 인증 | mesh API 대부분 공개/약한 경계 | user/session/API token 기반 RBAC |
| 권한 | workspace/share/node 소유권 경계 약함 | workspace membership, role, share capability |
| Rate limit | 없음 또는 미흡 | IP/user/workspace/node 단위 제한 |
| 관측성 | 기본 로그 중심 | metrics, structured logs, audit events, dashboard |
| cleanup | 일부 runtime 정리 | DB retention job + 삭제/익명화 정책 |
| 검증 | 로컬/자동화 중심 | 실제 NAT/mobile/long-run/multi-device 검증 |

## 4. 저장소 영속화 설계

### 4.1 목표

서버 재시작, rolling deploy, crash 이후에도 다음 데이터가 복구되어야 한다.

- workspace
- node registration
- node presence
- file metadata
- file availability
- share code
- share event/audit log

### 4.2 저장소 선택

기존 signaling 서버에 이미 `DATABASE_URL` / Postgres 설정이 있으므로 Postgres를 사용한다.

- runtime hot path는 DB + memory cache 조합 가능
- MVP hardening 단계에서는 DB를 authoritative source로 둔다
- presence처럼 TTL이 짧은 데이터도 DB에 저장하되, write coalescing은 후속 최적화로 둔다

### 4.3 테이블 설계

#### `mesh_workspaces`

```sql
CREATE TABLE mesh_workspaces (
  workspace_id TEXT PRIMARY KEY,
  owner_user_id TEXT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL
);
```

#### `mesh_workspace_members`

```sql
CREATE TABLE mesh_workspace_members (
  workspace_id TEXT NOT NULL REFERENCES mesh_workspaces(workspace_id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
```

#### `mesh_nodes`

```sql
CREATE TABLE mesh_nodes (
  workspace_id TEXT NOT NULL REFERENCES mesh_workspaces(workspace_id),
  node_id TEXT NOT NULL,
  owner_user_id TEXT NULL,
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'blocked', 'revoked')),
  capabilities JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, node_id)
);
```

#### `mesh_presence`

```sql
CREATE TABLE mesh_presence (
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  online BOOLEAN NOT NULL,
  endpoint_hints JSONB NOT NULL DEFAULT '{}',
  load JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, node_id),
  FOREIGN KEY (workspace_id, node_id) REFERENCES mesh_nodes(workspace_id, node_id)
);

CREATE INDEX mesh_presence_expires_at_idx ON mesh_presence(expires_at);
```

#### `mesh_files`

```sql
CREATE TABLE mesh_files (
  workspace_id TEXT NOT NULL REFERENCES mesh_workspaces(workspace_id),
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  piece_size BIGINT NOT NULL CHECK (piece_size > 0),
  piece_count BIGINT NOT NULL CHECK (piece_count >= 0),
  manifest JSONB NOT NULL,
  tags JSONB NOT NULL DEFAULT '{}',
  created_by_node_id TEXT NOT NULL,
  created_by_user_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, file_id)
);

CREATE INDEX mesh_files_workspace_created_idx ON mesh_files(workspace_id, created_at DESC);
```

#### `mesh_availability`

```sql
CREATE TABLE mesh_availability (
  workspace_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT false,
  verified_ranges JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  advertise_until TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, file_id, node_id),
  FOREIGN KEY (workspace_id, file_id) REFERENCES mesh_files(workspace_id, file_id),
  FOREIGN KEY (workspace_id, node_id) REFERENCES mesh_nodes(workspace_id, node_id)
);

CREATE INDEX mesh_availability_file_idx ON mesh_availability(workspace_id, file_id, complete);
```

#### `mesh_shares`

```sql
CREATE TABLE mesh_shares (
  code TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_by_node_id TEXT NOT NULL,
  created_by_user_id TEXT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}',
  max_downloads INTEGER NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by_user_id TEXT NULL,
  FOREIGN KEY (workspace_id, file_id) REFERENCES mesh_files(workspace_id, file_id),
  FOREIGN KEY (workspace_id, created_by_node_id) REFERENCES mesh_nodes(workspace_id, node_id)
);

CREATE INDEX mesh_shares_workspace_file_idx ON mesh_shares(workspace_id, file_id);
CREATE INDEX mesh_shares_expires_at_idx ON mesh_shares(expires_at);
```

#### `mesh_events`

```sql
CREATE TABLE mesh_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NULL,
  share_code TEXT NULL,
  node_id TEXT NULL,
  user_id TEXT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  ip_hash TEXT NULL,
  user_agent_hash TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mesh_events_workspace_created_idx ON mesh_events(workspace_id, created_at DESC);
CREATE INDEX mesh_events_share_created_idx ON mesh_events(share_code, created_at DESC);
CREATE INDEX mesh_events_type_created_idx ON mesh_events(event_type, created_at DESC);
```

### 4.4 Repository layer

Rust signaling 서버에 storage trait을 둔다.

```rust
#[async_trait]
pub trait MeshRepository: Send + Sync {
    async fn create_workspace(&self, input: CreateWorkspaceInput) -> Result<MeshWorkspace>;
    async fn get_workspace(&self, workspace_id: &str) -> Result<Option<MeshWorkspace>>;
    async fn register_node(&self, input: RegisterNodeInput) -> Result<MeshNode>;
    async fn heartbeat(&self, input: HeartbeatInput) -> Result<MeshPresence>;
    async fn publish_file(&self, input: PublishFileInput) -> Result<MeshFile>;
    async fn update_availability(&self, input: AvailabilityInput) -> Result<MeshAvailability>;
    async fn create_share(&self, input: CreateShareInput) -> Result<MeshShare>;
    async fn resolve_share(&self, code: &str) -> Result<Option<MeshShare>>;
    async fn revoke_share(&self, code: &str, actor: Actor) -> Result<()>;
    async fn find_candidates(&self, workspace_id: &str, file_id: &str) -> Result<Vec<MeshCandidate>>;
    async fn record_event(&self, input: MeshEventInput) -> Result<()>;
}
```

구현체:

- `InMemoryMeshRepository`: 테스트/개발용
- `PostgresMeshRepository`: 운영용

설정:

```env
PONSWARP_MESH_ENABLED=true
PONSWARP_MESH_STORAGE=postgres # memory | postgres
DATABASE_URL=postgres://...
```

### 4.5 재시작 복구 조건

서버 재시작 후 다음이 성립해야 한다.

- unexpired share code resolve 가능
- expired share code resolve 거부
- approved node metadata 유지
- stale presence는 offline으로 간주
- file metadata/candidates 조회 가능
- revoked share는 계속 거부

## 5. 인증/권한 모델 설계

### 5.1 Actor 모델

모든 mesh API는 요청자를 `Actor`로 정규화한다.

```rust
pub enum Actor {
    Anonymous { ip_hash: String },
    User { user_id: String, session_id: String },
    Node { workspace_id: String, node_id: String, token_id: String },
    Admin { user_id: String },
}
```

### 5.2 인증 방식

| 클라이언트 | 인증 방식 | 용도 |
|---|---|---|
| Web user | 기존 session cookie / OAuth session | workspace/share 관리 |
| CLI node | node token 또는 API token | node 등록, heartbeat, publish |
| Anonymous receiver | share code capability | public get/resolve |
| Admin | existing admin auth | 운영/차단/감사 |

### 5.3 Node token

node 등록 시 서버가 node token을 발급한다.

```json
{
  "nodeId": "node_abc",
  "workspaceId": "ws_123",
  "nodeToken": "pw_node_...",
  "expiresAt": 1790000000
}
```

저장 시 token은 평문 저장 금지.

```sql
CREATE TABLE mesh_node_tokens (
  token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  FOREIGN KEY (workspace_id, node_id) REFERENCES mesh_nodes(workspace_id, node_id)
);
```

Authorization header:

```http
Authorization: Bearer pw_node_xxx
```

### 5.4 권한 매트릭스

| API | Anonymous | User viewer | User member | User admin/owner | Node approved | Admin |
|---|---:|---:|---:|---:|---:|---:|
| create workspace | no | no | yes, quota-limited | yes | no | yes |
| list workspace files | no | yes | yes | yes | scoped | yes |
| register node | no | no | yes | yes | no | yes |
| heartbeat | no | no | no | no | own node only | yes |
| publish file | no | no | yes | yes | own node only | yes |
| update availability | no | no | no | no | own node only | yes |
| create share | no | no | yes | yes | own file/node scoped | yes |
| resolve share | yes with valid code | yes | yes | yes | yes | yes |
| revoke share | no | no | own share | workspace admin/owner | own share if token scope allows | yes |
| candidates | valid share only | workspace-scoped | workspace-scoped | workspace-scoped | scoped | yes |
| record event | limited | yes | yes | yes | scoped | yes |

### 5.5 Share capability

Share code는 bearer capability처럼 동작한다. 단, code만으로 가능한 작업은 제한한다.

가능:

- share metadata resolve
- online source count 확인
- transfer connect request 생성

불가능:

- workspace file list 전체 조회
- 다른 file metadata 조회
- share revoke
- node registration
- 내부 event dump 조회

### 5.6 API별 인증 정책

#### Public allowed

```text
GET /api/mesh/shares/:code
GET /api/mesh/shares/:code/candidates
POST /api/mesh/shares/:code/events
```

조건:

- valid, unexpired, not revoked share만 허용
- response는 최소 metadata만 반환
- rate limit 강함

#### Auth required

```text
POST /api/mesh/workspaces
POST /api/mesh/workspaces/:workspace_id/nodes
POST /api/mesh/workspaces/:workspace_id/files
PUT /api/mesh/workspaces/:workspace_id/files/:file_id/availability/:node_id
POST /api/mesh/workspaces/:workspace_id/shares
DELETE /api/mesh/shares/:code
```

조건:

- user session 또는 node token 필요
- workspace role/scopes 검사

## 6. Rate Limit / Abuse 방어 설계

### 6.1 목표

다음 abuse를 막는다.

- share code 생성 남발
- workspace 무한 생성
- node 등록 남발
- heartbeat/event spam
- candidate 조회 scrape
- share code brute force

### 6.2 Rate limit key

```text
ip:<ip_hash>
user:<user_id>
workspace:<workspace_id>
node:<workspace_id>:<node_id>
share:<code>
route:<route_group>
```

### 6.3 기본 제한값

| Route group | Key | Limit |
|---|---|---:|
| create workspace | user/ip | 10/hour |
| register node | user/workspace/ip | 30/hour |
| heartbeat | node | 60/min |
| publish file | node/user | 120/hour |
| create share | user/node/ip | 60/hour |
| resolve share | ip/share | 120/min |
| candidates | ip/share | 60/min |
| share events | ip/share | 120/min |
| revoke share | user/node | 60/hour |

### 6.4 구현 방식

#### MVP hardening

- process-local token bucket
- Postgres persistence 없음
- single instance staging에서 먼저 사용

#### 운영 hardening

- Redis 또는 Postgres advisory/TTL table 기반 distributed limit
- `Retry-After` header 제공
- 초과 시 JSON error 반환

```json
{
  "error": "rate_limited",
  "retryAfterSeconds": 30
}
```

### 6.5 Abuse 이벤트

rate limit 초과 또는 의심 행위는 `mesh_events`에 기록한다.

Event types:

```text
rate_limit_exceeded
share_bruteforce_suspected
workspace_create_denied
node_register_denied
candidate_scrape_suspected
```

## 7. 운영 관측성 설계

### 7.1 Metrics

Prometheus 형식 `/metrics` 또는 기존 metrics endpoint에 추가한다.

#### Counters

```text
ponswarp_mesh_requests_total{route,status}
ponswarp_mesh_share_created_total{workspace}
ponswarp_mesh_share_resolved_total{result}
ponswarp_mesh_share_revoked_total{reason}
ponswarp_mesh_candidate_requests_total{result}
ponswarp_mesh_transfer_events_total{event_type}
ponswarp_mesh_rate_limited_total{route_group}
ponswarp_mesh_auth_denied_total{route_group,reason}
```

#### Gauges

```text
ponswarp_mesh_active_workspaces
ponswarp_mesh_active_nodes
ponswarp_mesh_online_nodes
ponswarp_mesh_active_shares
ponswarp_mesh_known_files
ponswarp_mesh_ws_connections
```

#### Histograms

```text
ponswarp_mesh_request_duration_seconds{route}
ponswarp_mesh_candidate_count{workspace}
ponswarp_mesh_share_resolve_duration_seconds
ponswarp_mesh_db_query_duration_seconds{query}
```

### 7.2 Structured logs

모든 mesh request 로그는 다음 필드를 포함한다.

```json
{
  "ts": "2026-07-03T00:00:00Z",
  "level": "info",
  "component": "mesh-api",
  "requestId": "req_...",
  "route": "resolve_share",
  "actorType": "anonymous|user|node|admin",
  "workspaceId": "ws_...",
  "shareCodeHash": "...",
  "nodeIdHash": "...",
  "status": 200,
  "durationMs": 12
}
```

PII/민감정보 원칙:

- share code는 raw logging 금지, hash만 기록
- node token logging 금지
- IP는 hash 또는 truncated form만 기록
- file name은 기본 로그에 남기지 않음, debug mode에서도 redaction

### 7.3 Dashboard

운영 dashboard 최소 패널:

1. request rate/error rate
2. p50/p95/p99 latency
3. active/online nodes
4. active shares
5. share resolve success/failure
6. candidates per share
7. rate limit events
8. auth denied events
9. DB query latency
10. 기존 `/ws` connection count와 mesh traffic 상관관계

### 7.4 Alerts

| Alert | 조건 |
|---|---|
| MeshHighErrorRate | 5xx > 2% for 10m |
| MeshHighLatency | p95 > 500ms for 10m |
| MeshRateLimitSpike | rate_limited_total 급증 |
| MeshDBLatencyHigh | db p95 > 200ms |
| MeshWsImpact | 기존 ws error/latency 동반 상승 |
| MeshShareResolveFailureSpike | share resolve failure 급증 |

## 8. 데이터 수명 정책 설계

### 8.1 기본 retention

| 데이터 | 기본 보관 | 삭제/익명화 |
|---|---:|---|
| presence | TTL + 1h | hard delete |
| share | expires_at + 30d | code hash만 audit에 남기고 삭제 가능 |
| events | 90d | PII hash 유지, payload redaction |
| file metadata | workspace 정책 | user 삭제 요청 시 삭제/익명화 |
| node | revoked + 180d | public_key/token 제거 |
| workspace | 삭제 요청 후 30d grace | hard delete |

### 8.2 Cleanup jobs

서버 background task 또는 별도 worker로 실행한다.

```text
mesh_cleanup_presence      every 5 minutes
mesh_cleanup_expired_share every 1 hour
mesh_cleanup_events        every 24 hours
mesh_cleanup_deleted_data  every 24 hours
```

### 8.3 Cleanup safety

- cleanup은 batch size 제한
- lock 또는 advisory lock으로 중복 실행 방지
- 삭제 전 count metric/log 기록
- 실패해도 서버 main path에 영향 없음

### 8.4 GDPR/삭제 요청

삭제 요청 시:

1. user/workspace 소유권 확인
2. workspace/file/share soft delete
3. node token revoke
4. public metadata 비노출
5. retention grace 후 hard delete
6. audit에는 최소 이벤트만 hash 형태로 유지

### 8.5 Response 정책

삭제/만료된 share:

```json
{
  "error": "share_not_found"
}
```

revoked와 expired 여부를 공개 응답에서 구분하지 않는다. brute force 방지를 위해 public response는 동일하게 둔다. Admin audit에서만 상세 확인 가능.

## 9. 실제 멀티 디바이스 검증 설계

### 9.1 Test matrix

| Case | Sender | Receiver | Network | 목적 |
|---|---|---|---|---|
| MD-01 | Desktop Chrome | Desktop Chrome | same LAN | 기본 Web share/get |
| MD-02 | Desktop Chrome | Mobile Safari/Chrome | same LAN | 모바일 receive UX |
| MD-03 | CLI Node | Web browser | same LAN | CLI share → Web get |
| MD-04 | Web browser | CLI Node | same LAN | Web share → CLI get |
| MD-05 | CLI Node A | CLI Node B | different NAT | 실제 NAT path |
| MD-06 | 1 sender + 4 receivers | mixed | same LAN | 5-process/5-device grid |
| MD-07 | long-run 2h | mixed | mixed | heartbeat/reconnect |
| MD-08 | server restart mid-session | mixed | same LAN | DB persistence/recovery |
| MD-09 | source node offline | mixed | same LAN | candidate disappearance |
| MD-10 | expired/revoked share | mixed | same LAN | policy enforcement |

### 9.2 Acceptance criteria

각 test는 다음을 기록한다.

- file size
- piece size
- piece count
- sender/receiver count
- network type
- duration
- average throughput
- p95 chunk latency, 가능 시
- reconnect count
- failed piece count
- retry count
- final hash match
- UI/CLI user-facing result
- server metrics snapshot
- logs/artifact path

### 9.3 최소 release gate

운영 mesh 공개 전 최소 통과 조건:

```text
MD-01 pass
MD-02 pass
MD-03 pass
MD-05 pass
MD-08 pass
MD-09 pass
MD-10 pass
24h staging soak with no Sev1/Sev2 issue
```

### 9.4 Large-file gate

브라우저/CLI 각각 다음을 분리 검증한다.

- algorithmic sparse-file or generated-stream test: 25GB/50GB equivalent
- real disk-backed test: local disk 여유에 맞춰 1GB/5GB/10GB
- cross-device real transfer: 운영 네트워크에서 가능한 파일 크기부터 단계 상승

주의:

- 한 기기 로컬 loopback은 sender/receiver 저장 공간이 중복 필요하다.
- 실제 다른 기기 간 전송에서는 sender 원본과 receiver 결과물이 각 기기에 분산된다.
- single machine test에서 50GB는 원본 50GB + 수신 50GB + 임시/metadata 여유가 필요할 수 있다.

## 10. API 보강 설계

### 10.1 Error envelope

모든 mesh API error는 동일 형식을 사용한다.

```json
{
  "error": "share_not_found",
  "message": "Share code was not found or is no longer available.",
  "requestId": "req_..."
}
```

Public API는 security-sensitive reason을 숨긴다.

### 10.2 Request id

모든 요청에 request id를 부여한다.

- incoming `X-Request-Id`가 있으면 검증 후 사용
- 없으면 생성
- response header `X-Request-Id`로 반환
- logs/metrics/events에 포함

### 10.3 Versioning

Mesh API는 명시 버전을 둔다.

```text
/api/mesh/v1/...
```

기존 MVP route는 compatibility window 동안 유지하거나 301/alias 처리한다.

### 10.4 Feature flags

```env
PONSWARP_MESH_ENABLED=false
PONSWARP_MESH_STORAGE=postgres
PONSWARP_MESH_PUBLIC_SHARE_RESOLVE=true
PONSWARP_MESH_REQUIRE_AUTH_FOR_CREATE=true
PONSWARP_MESH_RATE_LIMIT_ENABLED=true
PONSWARP_MESH_METRICS_ENABLED=true
```

## 11. 작업 단위

### Epic A. Persistence

#### A1. DB migration 작성

- repo: `ponswarp-signaling-rs`
- 작업:
  - `mesh_workspaces`, `mesh_nodes`, `mesh_presence`, `mesh_files`, `mesh_availability`, `mesh_shares`, `mesh_events`, `mesh_node_tokens` migration 추가
  - rollback/down migration 정책 정의
- 완료 조건:
  - clean DB에서 migration 성공
  - 기존 non-mesh migration과 충돌 없음
  - `cargo test` 통과

#### A2. MeshRepository trait 도입

- 작업:
  - 현재 `DashMap` 직접 접근을 repository trait 뒤로 이동
  - `InMemoryMeshRepository`로 기존 테스트 유지
- 완료 조건:
  - API 동작 동일
  - 기존 21개 Rust 테스트 통과

#### A3. PostgresMeshRepository 구현

- 작업:
  - workspace/node/presence/file/availability/share/event CRUD 구현
  - transaction 경계 정의
  - 후보 조회 query 구현
- 완료 조건:
  - repository integration test 통과
  - 서버 재시작 시 share resolve 유지 테스트 통과

#### A4. Storage config/boot validation

- 작업:
  - `PONSWARP_MESH_STORAGE=postgres`일 때 `DATABASE_URL` 필수화
  - `memory`는 staging/dev 전용 warning log
- 완료 조건:
  - 잘못된 설정에서 startup fail-fast
  - 기존 mesh disabled 상태에서는 DB 없어도 기존 서버 부팅 가능

### Epic B. Auth / Authorization

#### B1. Actor extractor 구현

- 작업:
  - session cookie/user actor
  - node bearer token actor
  - anonymous actor
  - admin actor
- 완료 조건:
  - API handler가 raw header를 직접 읽지 않음
  - actor unit tests 통과

#### B2. Node token 발급/검증

- 작업:
  - token 생성, hash 저장, scope 검사
  - revoke endpoint 또는 admin action
- 완료 조건:
  - token 평문 DB 저장 없음
  - revoked/expired token 거부

#### B3. Workspace RBAC

- 작업:
  - role enum owner/admin/member/viewer
  - endpoint별 권한 middleware
- 완료 조건:
  - create/revoke/list/register 권한 테스트 통과
  - anonymous public share resolve는 유지

#### B4. Public share capability 제한

- 작업:
  - resolve/candidates 응답 최소화
  - workspace 내부 metadata 노출 차단
- 완료 조건:
  - share code만으로 workspace file list 접근 불가 테스트 통과

### Epic C. Rate limit / Abuse defense

#### C1. Rate limiter abstraction

- 작업:
  - `RateLimiter` trait
  - in-memory token bucket 구현
  - route group 정의
- 완료 조건:
  - limit 초과 시 429 + `Retry-After`

#### C2. Distributed limiter 설계/구현

- 작업:
  - Redis 또는 Postgres 기반 구현 결정
  - 운영 설정 추가
- 완료 조건:
  - multi-process에서 limit 공유 테스트

#### C3. Abuse event logging

- 작업:
  - limit 초과/권한 거부/share brute force 의심 event 기록
- 완료 조건:
  - `mesh_events`에 audit 남음
  - raw IP/token/share code 저장 없음

### Epic D. Observability

#### D1. Request id middleware

- 완료 조건:
  - 모든 mesh response에 `X-Request-Id`
  - structured log에 request id 포함

#### D2. Metrics endpoint 확장

- 작업:
  - counters/gauges/histograms 추가
  - route/status label cardinality 제한
- 완료 조건:
  - `/metrics` 또는 기존 metrics path에서 scrape 가능

#### D3. Dashboard/runbook 초안

- 작업:
  - dashboard panel 목록
  - alert rule 목록
  - rollback 명령
- 완료 조건:
  - 운영자가 배포 후 확인할 checklist 존재

### Epic E. Cleanup / Retention

#### E1. Cleanup worker 구현

- 작업:
  - expired share
  - stale presence
  - old events
  - soft-deleted workspace/file hard delete
- 완료 조건:
  - batch limit/advisory lock 적용
  - cleanup metrics/log 존재

#### E2. Deletion/GDPR flow

- 작업:
  - workspace/file/share delete API 정책
  - audit minimal retention
- 완료 조건:
  - 삭제 후 public resolve/list 노출 없음
  - audit에는 hash/minimal event만 유지

### Epic F. Multi-device QA

#### F1. Staging environment 준비

- 작업:
  - beta host 또는 별도 port/process
  - mesh enabled
  - test CORS origins
- 완료 조건:
  - 기존 prod와 격리
  - health/ready/ws/mesh ready 확인

#### F2. QA runner/report template

- 작업:
  - multi-device matrix report template
  - throughput/latency/hash 기록 형식
- 완료 조건:
  - 각 MD case 결과가 정량/정성 모두 기록됨

#### F3. Release gate 실행

- 작업:
  - MD-01/02/03/05/08/09/10 수행
  - 24h soak
- 완료 조건:
  - Sev1/Sev2 issue 없음
  - report 저장
  - 운영 ON 여부 판단 가능

## 12. 구현 순서 추천

```text
1. A1 DB migration
2. A2 Repository trait
3. A3 Postgres repository
4. A4 boot config/fail-fast
5. B1 Actor extractor
6. B2 Node token
7. B3 Workspace RBAC
8. B4 Public share capability hardening
9. C1 In-memory rate limiter
10. C3 Abuse audit logging
11. D1 Request id middleware
12. D2 Metrics
13. E1 Cleanup worker
14. F1 Staging environment
15. F2 QA report template
16. F3 Multi-device release gate
17. C2 Distributed limiter
18. E2 GDPR/delete flow
19. D3 Dashboard/runbook
```

이 순서의 이유:

- persistence가 먼저 들어가야 auth와 cleanup이 정확해진다.
- auth가 들어간 뒤 rate limit을 actor 단위로 걸 수 있다.
- metrics/request id가 있어야 staging QA 결과를 믿을 수 있다.
- staging에서 실제 NAT/mobile/restart를 본 뒤 운영 공개 여부를 결정한다.

## 13. 운영 배포 체크리스트

### 13.1 Mesh disabled deploy checklist

```text
[ ] PONSWARP_MESH_ENABLED=false
[ ] cargo test pass
[ ] /health pass
[ ] /ready pass
[ ] /ws existing flow pass
[ ] cloud/auth/billing smoke pass
[ ] error rate unchanged for 30m
```

### 13.2 Mesh staging enabled checklist

```text
[ ] PONSWARP_MESH_ENABLED=true
[ ] PONSWARP_MESH_STORAGE=postgres
[ ] DATABASE_URL configured
[ ] rate limit enabled
[ ] metrics enabled
[ ] cleanup enabled
[ ] staging CORS only
[ ] MD release gate pass
[ ] rollback command tested
```

### 13.3 Production enable checklist

```text
[ ] staging 24h soak pass
[ ] no Sev1/Sev2 open
[ ] dashboard live
[ ] alerts live
[ ] rollback owner assigned
[ ] feature flag can disable mesh without redeploy
[ ] support/FAQ ready
```

## 14. Non-goals

이번 hardening 설계의 범위가 아닌 것:

- BitTorrent 호환 프로토콜
- 중앙 서버 파일 업로드 저장
- 완전한 enterprise admin console
- 결제/과금 정책 변경
- AI Agent 고급 자동 라우팅
- 모바일 native app

## 15. 설계 재검토 보완사항

초안 v0.1을 다시 검토한 결과, 큰 방향은 맞지만 운영 설계로는 아래 항목을 더 명시해야 한다. 이 보완사항은 구현 시 선행 조건 또는 acceptance criteria로 취급한다.

### 15.1 운영 DB migration 안전성

Postgres schema 설계에는 `gen_random_uuid()` 사용, FK, JSONB index가 포함되어 있으므로 migration 전제 조건을 명확히 둔다.

- `pgcrypto` extension 활성화 여부를 migration에서 보장한다.
- migration은 expand/contract 방식으로 작성한다.
- 기존 운영 table과 lock 경합을 피하기 위해 큰 table backfill은 별도 job으로 분리한다.
- 모든 FK에는 삭제 정책을 명시한다.
  - workspace soft delete가 기본이다.
  - hard delete 단계에서 `mesh_presence`, `mesh_availability`, `mesh_shares`, `mesh_node_tokens`를 먼저 정리한다.
- 운영 rollback은 schema down보다 feature flag off + forward fix를 우선한다.

추가 작업 단위:

```text
A0. Migration preflight
  - pgcrypto extension check
  - lock timeout 설정
  - dry-run migration
  - backup/restore drill
```

### 15.2 Secret/token/hash 정책

초안은 token 평문 저장 금지를 포함하지만, hash 기준이 부족하다.

- node token은 최소 256-bit random secret으로 생성한다.
- DB에는 `argon2id` 또는 운영 표준 password-hash로 저장한다.
- rate limit/log/event에 쓰는 IP/share/node hash는 HMAC-SHA256 + server-side pepper를 사용한다.
- pepper는 환경변수/secret manager로 관리하고 로그에 노출하지 않는다.
- share code 자체는 lookup key라 DB에 저장할 수 있지만, log/metrics/event에는 raw code를 남기지 않는다.
- event payload는 allowlist 필드만 저장하고 자유 JSON payload 저장은 production에서 제한한다.

필수 환경변수:

```env
PONSWARP_MESH_HASH_PEPPER=...
PONSWARP_MESH_NODE_TOKEN_SECRET=...
```

### 15.3 Share code 보안성

공개 share code가 bearer capability이므로 code entropy를 운영 기준으로 못 박는다.

- code는 최소 80-bit entropy 이상이어야 한다.
- 사람이 입력하는 짧은 code를 유지하려면 내부적으로 random slug + checksum 또는 긴 URL token을 병행한다.
- brute force 방지를 위해 unknown/expired/revoked 응답 시간을 가능한 균일하게 둔다.
- public resolve는 raw file name 노출 여부를 share capability 정책에 따라 제어한다.
- sensitive file name은 sender가 명시적으로 public 표시를 허용한 경우에만 공개한다.

권장 code 형식:

```text
Human code: 8F3K-22Q9-7P4M
URL token: pwsh_<128-bit-url-safe-token>
```

MVP compatibility로 기존 짧은 code를 유지하더라도 production public은 긴 token을 우선한다.

### 15.4 CSRF/CORS/Browser security

Web user session cookie를 사용하는 endpoint는 CSRF 방어가 필요하다.

- cookie-auth write endpoint는 CSRF token 또는 SameSite=Lax/Strict 정책을 적용한다.
- bearer-token CLI endpoint와 cookie-auth Web endpoint를 명확히 분리한다.
- `CORS_ORIGINS=*`와 `allow_credentials=true` 조합은 production에서 금지한다.
- production CORS는 정확한 origin allowlist만 허용한다.
- browser에서 표시하는 share link는 origin spoofing 방지를 위해 server-configured public URL만 사용한다.

추가 checklist:

```text
[ ] production CORS wildcard disabled
[ ] cookie write endpoint CSRF test pass
[ ] share link public origin canonicalization test pass
```

### 15.5 Node enrollment / trust bootstrap

초안의 node 등록 정책은 권한 매트릭스만 있고 실제 등록 흐름이 부족하다. 운영에서는 아래 중 하나를 선택한다.

#### Option A. User-owned node enrollment

```text
User login
→ create workspace
→ issue one-time node enrollment token
→ CLI `ponswarp node enroll <token>`
→ server issues node token
→ node heartbeat/publish allowed
```

#### Option B. Workspace invite enrollment

```text
Workspace admin creates invite
→ invite has scope, expiry, max uses
→ node uses invite
→ admin approval required unless auto-approve enabled for staging
```

운영 기본값:

```env
PONSWARP_MESH_AUTO_APPROVE_NODES=false
```

staging에서만 true를 허용한다.

### 15.6 Transfer connect authorization

`candidates` 조회만으로 실제 node 연결이 열리면 안 된다. 연결 시도에는 별도 짧은 수명의 connect grant를 둔다.

```text
GET /api/mesh/v1/shares/:code/candidates
→ returns source summaries only

POST /api/mesh/v1/shares/:code/connect
→ validates share, rate limit, candidate, source online
→ returns short-lived connect grant
→ receiver/source use grant in signaling/direct handshake
```

Connect grant 조건:

- TTL 30~120초
- share code, receiver fingerprint, source node id, file id에 바인딩
- 1회용 또는 replay 제한
- raw grant logging 금지
- 실패/만료 event 기록

### 15.7 Backward compatibility with current `/ws`

기존 운영 `/ws` signaling room과 새 mesh coordinator가 같은 서버에 있어도 장애 영역을 분리해야 한다.

- mesh DB 장애가 기존 `/ws` room signaling을 막으면 안 된다.
- `PONSWARP_MESH_ENABLED=false`면 mesh repository/database initialization을 skip하거나 lazy init한다.
- mesh enabled 상태에서도 DB 장애 시 `/health`와 `/ready`의 의미를 분리한다.
  - `/health`: process alive
  - `/ready`: core existing service ready
  - `/api/mesh/ready`: mesh dependency ready
- 기존 `/ws` p95 latency/error rate를 mesh rollout gate에 포함한다.

### 15.8 Quotas and product limits

Rate limit만으로는 비용/abuse를 완전히 막지 못한다. 계정/workspace quota가 필요하다.

초기 quota:

| 항목 | Free/Beta 기본값 |
|---|---:|
| workspace per user | 5 |
| approved nodes per workspace | 20 |
| active shares per workspace | 100 |
| file metadata per workspace | 1,000 |
| event ingest per workspace | 10,000/day |
| max share TTL | 7 days |
| max advertised file size metadata | policy-based, default 1TB |

초과 시:

```json
{
  "error": "quota_exceeded",
  "requestId": "req_..."
}
```

### 15.9 Privacy and metadata minimization

파일 자체를 서버에 업로드하지 않더라도 metadata는 민감할 수 있다.

- public resolve 응답은 기본적으로 file size, piece count, availability count만 제공한다.
- file name 공개는 share 생성 시 `publicName` 또는 `exposeFileName=true`일 때만 허용한다.
- user agent, IP, node endpoint hints는 raw 저장하지 않는다.
- endpoint hints는 후보 연결에 필요한 최소 정보만 반환한다.
- admin audit도 raw token/share code/file path를 표시하지 않는다.

### 15.10 Backup/restore and disaster recovery

Postgres를 authoritative source로 쓰면 backup/restore 검증이 release gate에 들어가야 한다.

필수 DR test:

```text
DR-01 staging DB backup 생성
DR-02 새 DB에 restore
DR-03 unexpired share resolve 확인
DR-04 revoked/expired share 거부 확인
DR-05 node token은 restore 후에도 검증 가능
DR-06 feature flag off rollback 확인
```

### 15.11 Load and capacity gate

운영 공개 전 최소 부하 테스트를 추가한다.

| Gate | 기준 |
|---|---|
| L-01 share resolve | 100 rps, p95 < 200ms |
| L-02 heartbeat | 1,000 nodes, 60s heartbeat, error < 1% |
| L-03 candidates | 50 rps, p95 < 300ms |
| L-04 event ingest | 200 rps, loss 없음 |
| L-05 existing `/ws` impact | mesh load 중 기존 ws error/latency 악화 없음 |

이 기준은 beta 시작 기준이며, GA 전에는 실제 트래픽 예측에 맞춰 상향한다.

### 15.12 Implementation order adjustment

v0.1 구현 순서에는 security/bootstrap 작업이 조금 늦다. 실제 순서는 아래처럼 조정한다.

```text
0. A0 migration preflight/backup plan
1. A1 DB migration
2. A2 Repository trait
3. A3 Postgres repository
4. A4 boot config/fail-fast
5. B0 secret/hash policy
6. B1 Actor extractor
7. B2 Node token
8. B2.5 node enrollment flow
9. B3 Workspace RBAC
10. B4 Public share capability hardening
11. B5 connect grant authorization
12. C1 In-memory rate limiter
13. C3 Abuse audit logging
14. C4 quota enforcement
15. D1 Request id middleware
16. D2 Metrics
17. E1 Cleanup worker
18. F1 Staging environment
19. F2 QA report template
20. F3 Multi-device release gate
21. G1 load/capacity gate
22. G2 backup/restore gate
23. C2 Distributed limiter
24. E2 GDPR/delete flow
25. D3 Dashboard/runbook
```

### 15.13 Revised release blockers

아래 중 하나라도 미완료면 production mesh public enable은 금지한다.

```text
[ ] Postgres persistence enabled
[ ] migration preflight and backup/restore drill passed
[ ] node token/enrollment implemented
[ ] workspace RBAC enforced
[ ] public share response minimized
[ ] connect grant implemented
[ ] CSRF/CORS production checks passed
[ ] rate limit and quota enforcement enabled
[ ] metrics/logs/alerts available
[ ] cleanup worker enabled
[ ] multi-device release gate passed
[ ] load/capacity gate passed
[ ] existing /ws impact gate passed
[ ] feature flag rollback tested
```

## 16. 최종 판단 기준

운영 공개 가능 판단은 다음이 모두 참일 때만 한다.

1. 서버 재시작 후 active unexpired share가 복구된다.
2. unauthorized actor가 workspace/file/share를 조작할 수 없다.
3. share code brute force와 request spam이 rate limit에 걸린다.
4. 운영자가 active node/share/error/latency를 dashboard에서 볼 수 있다.
5. expired/stale/deleted 데이터가 정책대로 정리된다.
6. 실제 멀티 디바이스/NAT/mobile/restart/reconnect 테스트가 통과한다.
7. mesh feature flag를 끄면 기존 `warp.ponslink.com` 운영 기능이 유지된다.
8. connect grant 없이는 source node 연결을 시작할 수 없다.
9. production CORS/CSRF 정책이 검증되어 cookie-auth write endpoint가 보호된다.
10. backup/restore와 load/capacity gate가 통과한다.

이 조건 전까지는 `PONSWARP_MESH_ENABLED=true`를 production public traffic에 적용하지 않는다.
