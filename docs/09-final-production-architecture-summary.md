# PonsWarp Production Architecture Summary

문서 버전: v0.1  
작성일: 2026-07-03  
상태: 구현 전 최종 설계 요약  
상위 상세 설계: `docs/08-production-hardening-design.md`

최신 도메인 배포 설계: `docs/14-grid-ponslink-deployment-design.md`

## 1. 결론

현재 PonsWarp Grid/Web/CLI MVP는 동작하지만, `warp.ponslink.com` 운영 서버에 mesh 기능을 바로 공개 활성화하기에는 아직 부족하다. 최선의 운영 방향은 기존 운영 signaling 서버에 mesh 기능을 그대로 얹는 것이 아니라, **같은 Rust repo 안에서 mesh coordinator를 별도 binary/process로 분리**하는 것이다.

최종 권장 구조:

```text
warp.ponslink.com
  기존 PonsWarp signaling / cloud / billing / auth 유지
  기존 /ws, /health, /ready 운영 안정성 최우선

grid.ponslink.com
  PonsWarp Grid 전용 제품/API 도메인
  Web share UI
  Mesh Coordinator API
  Postgres persistence
  auth/RBAC/node token
  rate limit/quota
  metrics/logs/alerts
  cleanup/retention
  multi-device release gate

ponswarp-grid Web/CLI
  기본 coordinator: https://grid.ponslink.com
  기존 direct WebRTC signaling fallback은 필요 시 warp.ponslink.com 사용
```

## 2. 왜 분리해야 하는가

기존 `warp.ponslink.com`은 이미 운영 중인 서비스다. mesh coordinator는 기존 WebSocket room relay와 부하 특성이 다르다.

| 항목 | 기존 signaling | mesh coordinator |
|---|---|---|
| 주 역할 | WebSocket room, SDP/ICE relay | metadata index, share code, node discovery, candidates |
| 부하 형태 | connection/latency 중심 | DB read/write, heartbeat, candidate query 중심 |
| 장애 영향 | 연결 실패/전송 실패 | metadata 조회 실패, node discovery 실패 |
| 저장소 | 주로 runtime state | Postgres authoritative state 필요 |
| 보안 | room/session 중심 | RBAC, bearer capability, node token, quota 필요 |

같은 process에 넣으면 mesh DB 장애, cleanup, rate limit, candidate query 문제가 기존 `/ws` 운영에 영향을 줄 수 있다. 따라서 runtime failure domain을 분리한다.

## 3. Repo / process 전략

### 3.1 선택안

완전 별도 repo보다 **같은 Rust repo의 별도 binary/process**가 현재 최선이다.

```text
/home/declan/Documents/Develop/Project/ponswarp/ponswarp-signaling-rs
  src/main.rs              기존 warp signaling server
  src/bin/mesh_api.rs      신규 mesh coordinator server
  src/mesh/                mesh domain, repository, auth, quota, cleanup
  src/database/            shared DB/migration utilities
  src/auth/                기존 auth 재사용 가능 영역
```

### 3.2 이유

- 기존 auth/config/database 코드를 재사용할 수 있다.
- 운영 process는 분리되어 rollback이 쉽다.
- 기존 `warp.ponslink.com` 장애 위험이 낮다.
- 추후 규모가 커지면 별도 repo/service로 분리할 수 있다.

## 4. 서비스 경계

### 4.1 기존 signaling server

도메인:

```text
https://warp.ponslink.com
wss://warp.ponslink.com/ws
```

책임:

- 기존 WebSocket signaling 유지
- 기존 cloud/auth/billing 유지
- 기존 health/ready 유지
- mesh DB 장애와 무관하게 동작

금지:

- mesh DB dependency 때문에 `/ws` ready가 실패하면 안 된다.
- mesh cleanup/rate limit이 기존 room signaling을 막으면 안 된다.

### 4.2 Mesh coordinator

도메인:

```text
https://grid.ponslink.com
```

책임:

- workspace/node/file/share metadata
- node presence
- file availability
- share code resolve
- candidate discovery
- connect grant 발급
- rate limit/quota
- metrics/audit/cleanup

대표 API:

```text
GET  /health
GET  /ready
GET  /metrics
POST /api/mesh/v1/workspaces
POST /api/mesh/v1/workspaces/:workspace_id/nodes
POST /api/mesh/v1/workspaces/:workspace_id/files
PUT  /api/mesh/v1/workspaces/:workspace_id/files/:file_id/availability/:node_id
POST /api/mesh/v1/workspaces/:workspace_id/shares
GET  /api/mesh/v1/shares/:code
GET  /api/mesh/v1/shares/:code/candidates
POST /api/mesh/v1/shares/:code/connect
DELETE /api/mesh/v1/shares/:code
```

## 5. 운영 배포 원칙

### 5.1 기존 production에는 바로 mesh public enable 금지

기존 production에 새 코드를 배포하더라도 첫 배포는 다음 상태여야 한다.

```env
PONSWARP_MESH_ENABLED=false
```

mesh 공개 활성화는 아래 조건을 만족한 뒤 별도 coordinator에서 한다.

### 5.2 Rollout 단계

```text
Phase 0. Existing production safe deploy
  - 기존 server에 mesh disabled 상태로 코드 배포 가능
  - /health, /ready, /ws, cloud/auth/billing regression 확인

Phase 1. Grid coordinator staging / private beta host
  - grid.ponslink.com
  - PONSWARP_MESH_ENABLED=true
  - Postgres, auth, rate limit, metrics, cleanup 활성화

Phase 2. Private beta
  - 제한된 사용자/기기
  - 실제 NAT/mobile/CLI/Web 테스트
  - metrics/error/latency 관측

Phase 3. Public beta
  - quota, abuse 방어, alerts 운영
  - 24h 이상 soak

Phase 4. GA
  - rollback/runbook/support 문서 포함
```

## 6. Persistence 설계 요약

현재 MVP의 가장 큰 문제는 `DashMap` 메모리 저장이다. 운영에서는 Postgres를 authoritative source로 둔다.

필수 table:

```text
mesh_workspaces
mesh_workspace_members
mesh_nodes
mesh_node_tokens
mesh_presence
mesh_files
mesh_availability
mesh_shares
mesh_events
```

복구 기준:

- 서버 재시작 후 unexpired share resolve 가능
- revoked/expired share는 계속 거부
- file metadata 유지
- approved node 유지
- stale presence는 offline 처리
- candidates는 DB metadata + fresh presence 기준으로 계산

Repository 구조:

```rust
#[async_trait]
pub trait MeshRepository: Send + Sync {
    async fn create_workspace(&self, input: CreateWorkspaceInput) -> Result<MeshWorkspace>;
    async fn register_node(&self, input: RegisterNodeInput) -> Result<MeshNode>;
    async fn heartbeat(&self, input: HeartbeatInput) -> Result<MeshPresence>;
    async fn publish_file(&self, input: PublishFileInput) -> Result<MeshFile>;
    async fn update_availability(&self, input: AvailabilityInput) -> Result<MeshAvailability>;
    async fn create_share(&self, input: CreateShareInput) -> Result<MeshShare>;
    async fn resolve_share(&self, code: &str) -> Result<Option<MeshShare>>;
    async fn find_candidates(&self, workspace_id: &str, file_id: &str) -> Result<Vec<MeshCandidate>>;
    async fn record_event(&self, input: MeshEventInput) -> Result<()>;
}
```

구현체:

```text
InMemoryMeshRepository   dev/test only
PostgresMeshRepository   staging/production
```

## 7. Auth / Authorization 설계 요약

모든 mesh API는 요청자를 `Actor`로 정규화한다.

```rust
pub enum Actor {
    Anonymous { ip_hash: String },
    User { user_id: String, session_id: String },
    Node { workspace_id: String, node_id: String, token_id: String },
    Admin { user_id: String },
}
```

인증 방식:

| Actor | 인증 | 사용 |
|---|---|---|
| Anonymous | share code capability | public resolve/get |
| User | 기존 session/OAuth | workspace/share 관리 |
| Node | bearer node token | heartbeat/publish/availability |
| Admin | existing admin auth | 운영/감사/차단 |

운영 기본값:

```env
PONSWARP_MESH_AUTO_APPROVE_NODES=false
```

Node enrollment flow:

```text
User login
→ create workspace
→ issue one-time enrollment token
→ CLI `ponswarp node enroll <token>`
→ server issues node token
→ node heartbeat/publish allowed
```

## 8. Share code / connect grant 설계 요약

Share code는 bearer capability다. 따라서 production에서는 짧은 code만으로 node 연결을 열면 안 된다.

### 8.1 Share code

권장:

```text
Human code: 8F3K-22Q9-7P4M
URL token: pwsh_<128-bit-url-safe-token>
```

기준:

- 최소 80-bit entropy
- raw code/token 로그 금지
- unknown/expired/revoked 응답 구분 최소화
- file name 공개는 opt-in

### 8.2 Connect grant

`candidates` 조회와 실제 연결 권한을 분리한다.

```text
GET /api/mesh/v1/shares/:code/candidates
  → source summary만 반환

POST /api/mesh/v1/shares/:code/connect
  → share, receiver, source, file 검증
  → short-lived connect grant 반환

receiver/source handshake
  → connect grant 제출
  → 실제 direct/WebRTC 연결
```

Connect grant 조건:

- TTL 30~120초
- source node id, file id, share code, receiver fingerprint에 바인딩
- replay 제한
- raw grant logging 금지
- 실패/만료 audit event 기록

## 9. Rate limit / quota / abuse 방어 요약

### 9.1 Rate limit key

```text
ip:<ip_hash>
user:<user_id>
workspace:<workspace_id>
node:<workspace_id>:<node_id>
share:<code_hash>
route:<route_group>
```

기본 제한:

| Route group | Limit |
|---|---:|
| create workspace | 10/hour/user or IP |
| register node | 30/hour/workspace |
| heartbeat | 60/min/node |
| publish file | 120/hour/node |
| create share | 60/hour/user or node |
| resolve share | 120/min/IP/share |
| candidates | 60/min/IP/share |
| connect grant | 30/min/IP/share |
| share events | 120/min/IP/share |

### 9.2 Quota

| 항목 | Free/Beta 기본값 |
|---|---:|
| workspace per user | 5 |
| approved nodes per workspace | 20 |
| active shares per workspace | 100 |
| file metadata per workspace | 1,000 |
| event ingest per workspace | 10,000/day |
| max share TTL | 7 days |
| max advertised file size metadata | policy-based, default 1TB |

## 10. Observability 설계 요약

필수 metrics:

```text
ponswarp_mesh_requests_total{route,status}
ponswarp_mesh_share_created_total{workspace}
ponswarp_mesh_share_resolved_total{result}
ponswarp_mesh_candidate_requests_total{result}
ponswarp_mesh_connect_grants_total{result}
ponswarp_mesh_rate_limited_total{route_group}
ponswarp_mesh_auth_denied_total{route_group,reason}
ponswarp_mesh_active_workspaces
ponswarp_mesh_online_nodes
ponswarp_mesh_active_shares
ponswarp_mesh_request_duration_seconds{route}
ponswarp_mesh_db_query_duration_seconds{query}
```

필수 alert:

```text
MeshHighErrorRate
MeshHighLatency
MeshRateLimitSpike
MeshDBLatencyHigh
MeshWsImpact
MeshShareResolveFailureSpike
```

Structured log 원칙:

- requestId 포함
- actorType 포함
- raw token/share code/IP/file path 금지
- hash/HMAC 기반 redaction
- file name 기본 로그 금지

## 11. Cleanup / retention 설계 요약

Retention:

| 데이터 | 기본 보관 | 정리 |
|---|---:|---|
| presence | TTL + 1h | hard delete |
| share | expires_at + 30d | 삭제/익명화 |
| events | 90d | payload redaction |
| node | revoked + 180d | token/public_key 제거 |
| workspace | 삭제 요청 후 30d grace | hard delete |

Cleanup jobs:

```text
mesh_cleanup_presence      every 5 minutes
mesh_cleanup_expired_share every 1 hour
mesh_cleanup_events        every 24 hours
mesh_cleanup_deleted_data  every 24 hours
```

안전장치:

- batch limit
- advisory lock
- cleanup metrics/logs
- 실패해도 main API path 영향 없음

## 12. Browser / CORS / CSRF 설계 요약

운영 보안 기준:

- `CORS_ORIGINS=*` + credentials 금지
- production CORS는 정확한 origin allowlist만 허용
- cookie-auth write endpoint는 CSRF token 또는 SameSite 정책 필요
- bearer-token CLI endpoint와 cookie-auth Web endpoint 분리
- share link 생성 시 server-configured canonical public URL 사용

필수 test:

```text
[ ] production CORS wildcard disabled
[ ] cookie write endpoint CSRF test pass
[ ] share link public origin canonicalization test pass
```

## 13. Multi-device QA / release gate

운영 공개 전 최소 통과 matrix:

| Case | Sender | Receiver | Network | 목적 |
|---|---|---|---|---|
| MD-01 | Desktop Chrome | Desktop Chrome | same LAN | Web share/get |
| MD-02 | Desktop Chrome | Mobile Safari/Chrome | same LAN | mobile receive |
| MD-03 | CLI Node | Web browser | same LAN | CLI share → Web get |
| MD-05 | CLI Node A | CLI Node B | different NAT | NAT path |
| MD-08 | mixed | mixed | server restart | DB recovery |
| MD-09 | source node offline | receiver | same LAN | candidate disappearance |
| MD-10 | expired/revoked share | receiver | same LAN | policy enforcement |

각 테스트 기록 항목:

- file size
- piece size/count
- sender/receiver count
- network type
- duration
- throughput
- reconnect count
- failed/retried piece count
- final hash match
- UI/CLI result
- server metrics snapshot
- artifact path

## 14. Load / DR gate

### 14.1 Load gate

| Gate | 기준 |
|---|---|
| L-01 share resolve | 100 rps, p95 < 200ms |
| L-02 heartbeat | 1,000 nodes, 60s heartbeat, error < 1% |
| L-03 candidates | 50 rps, p95 < 300ms |
| L-04 event ingest | 200 rps, loss 없음 |
| L-05 existing `/ws` impact | mesh load 중 기존 ws error/latency 악화 없음 |

### 14.2 DR gate

```text
DR-01 staging DB backup 생성
DR-02 새 DB에 restore
DR-03 unexpired share resolve 확인
DR-04 revoked/expired share 거부 확인
DR-05 node token은 restore 후에도 검증 가능
DR-06 feature flag off rollback 확인
```

## 15. 구현 작업 단위

### Epic S. Service separation

```text
S1. src/bin/mesh_api.rs 생성
S2. mesh route/module을 기존 main.rs에서 분리 가능하게 정리
S3. mesh_api 전용 config/env prefix 정의
S4. mesh_api 전용 /health /ready /metrics 구현
S5. reverse proxy routing 설계
S6. deployment unit 분리
S7. 기존 warp server와 mesh server 독립 장애 테스트
```

### Epic A. Persistence

```text
A0. migration preflight / backup plan
A1. DB migration 작성
A2. MeshRepository trait 도입
A3. PostgresMeshRepository 구현
A4. storage config / boot validation
```

### Epic B. Auth / Authorization

```text
B0. secret/hash policy 구현
B1. Actor extractor 구현
B2. Node token 발급/검증
B2.5 node enrollment flow
B3. Workspace RBAC
B4. Public share capability hardening
B5. Connect grant authorization
```

### Epic C. Abuse defense

```text
C1. RateLimiter trait + in-memory token bucket
C2. distributed limiter
C3. abuse event logging
C4. quota enforcement
```

### Epic D. Observability

```text
D1. request id middleware
D2. metrics endpoint 확장
D3. dashboard/runbook/alert 문서
```

### Epic E. Cleanup / Retention

```text
E1. cleanup worker
E2. deletion/GDPR flow
```

### Epic F. QA / Release

```text
F1. staging environment
F2. multi-device QA report template
F3. multi-device release gate
F4. load/capacity gate
F5. backup/restore gate
```

## 16. 구현 순서

최종 권장 순서:

```text
0. S1-S7 service separation
1. A0 migration preflight/backup plan
2. A1 DB migration
3. A2 Repository trait
4. A3 Postgres repository
5. A4 boot config/fail-fast
6. B0 secret/hash policy
7. B1 Actor extractor
8. B2 Node token
9. B2.5 node enrollment flow
10. B3 Workspace RBAC
11. B4 Public share capability hardening
12. B5 connect grant authorization
13. C1 In-memory rate limiter
14. C3 Abuse audit logging
15. C4 quota enforcement
16. D1 Request id middleware
17. D2 Metrics
18. E1 Cleanup worker
19. F1 Staging environment
20. F2 QA report template
21. F3 Multi-device release gate
22. F4 load/capacity gate
23. F5 backup/restore gate
24. C2 Distributed limiter
25. E2 GDPR/delete flow
26. D3 Dashboard/runbook
```

## 17. Production enable blockers

아래 중 하나라도 미완료면 `PONSWARP_MESH_ENABLED=true`를 production public traffic에 적용하지 않는다.

```text
[ ] mesh coordinator separated from existing warp signaling runtime
[ ] existing /ws unaffected by mesh DB failure
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

## 18. 최종 판단

현재 설계의 최종 판단은 다음이다.

1. 기존 `warp.ponslink.com`에 mesh 기능을 바로 공개 활성화하지 않는다.
2. 기존 server에는 mesh disabled 상태로만 안전 배포할 수 있다.
3. production mesh는 `mesh.warp.ponslink.com` 별도 runtime으로 분리한다.
4. Postgres persistence, RBAC, node token, rate limit, quota, metrics, cleanup, connect grant가 들어가기 전까지는 MVP다.
5. 실제 멀티 디바이스/NAT/mobile/restart/load/DR gate를 통과해야 운영 공개 가능하다.

즉, 제품 방향은 유지하되 운영 구조는 **기존 signaling 확장형**이 아니라 **mesh coordinator 분리형**으로 가는 것이 최선이다.
