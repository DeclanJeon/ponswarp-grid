# grid.ponslink.com Deployment Design

문서 버전: v1.0
작성일: 2026-07-04
상태: 배포 설계 / 작업지시 기준
대상 repo:
- `ponswarp-grid`
- `/home/declan/Documents/Develop/Project/ponswarp/ponswarp-signaling-rs`

## 1. 결론

PonsWarp Grid는 기존 운영 도메인 `warp.ponslink.com`에 바로 얹지 않는다. 새 제품/새 기능의 public beta 경계는 `grid.ponslink.com`으로 분리한다.

```text
warp.ponslink.com
  기존 PonsWarp 운영 서비스
  기존 signaling / room / ws / auth / cloud / billing 유지
  새 grid 기능으로 인한 장애 영향 금지

grid.ponslink.com
  PonsWarp Grid 전용 제품 표면
  Web share UI
  Node CLI 기본 coordinator endpoint
  mesh/coordinator API
  signaling bridge / WebRTC negotiation
  metrics / health / readiness
```

핵심 원칙은 **도메인, process, DB namespace, rollout, rollback을 분리**하는 것이다. 같은 물리 서버와 같은 Rust repo를 재사용할 수는 있지만, 운영 failure domain은 분리한다.

## 2. 목표

`grid.ponslink.com`은 다음 사용 경험을 제공한다.

1. 사용자는 브라우저 또는 CLI로 파일을 공유한다.
2. 파일은 서버에 업로드되지 않고, metadata/share code만 coordinator에 등록된다.
3. 수신자는 share code 또는 link를 입력한다.
4. coordinator는 살아있는 node/provider 후보를 반환한다.
5. Web/CLI client가 WebRTC 직접 연결 또는 TURN relay를 통해 piece 단위로 받는다.
6. 다중 provider가 있으면 grid scheduler가 여러 node에서 piece를 받아 조립한다.
7. 대용량 파일은 bounded-memory / resume-safe 방식으로 처리한다.

## 3. 비목표

초기 `grid.ponslink.com` 배포에서 하지 않는 것:

- 기존 `warp.ponslink.com` 기능 교체
- 기존 `/ws` signaling path 변경
- 기존 auth/billing/cloud flow 강제 migration
- 완전 공개 GA 선언
- anonymous 무제한 업로드/공유 허용
- 서버에 원본 파일 저장

## 4. 도메인/라우팅 설계

### 4.1 DNS

```text
grid.ponslink.com  A/AAAA 또는 CNAME -> ponslink 운영 서버
```

초기에는 같은 서버를 써도 된다. 단, reverse proxy에서 process와 route를 분리한다.

### 4.2 Reverse proxy

권장 route:

```text
https://grid.ponslink.com/
  -> ponswarp-grid web app static assets

https://grid.ponslink.com/api/grid/v1/*
  -> mesh coordinator HTTP API

wss://grid.ponslink.com/ws/grid/*
  -> grid signaling / coordinator websocket

https://grid.ponslink.com/healthz
  -> grid edge health

https://grid.ponslink.com/readyz
  -> grid app + DB readiness

https://grid.ponslink.com/metrics
  -> protected metrics endpoint or internal-only proxy
```

기존 운영 route는 건드리지 않는다.

```text
https://warp.ponslink.com/*
wss://warp.ponslink.com/ws
```

### 4.3 CORS / origin policy

`grid.ponslink.com` API는 기본적으로 다음 origin만 허용한다.

```text
https://grid.ponslink.com
http://localhost:<dev-port>   dev only
```

`warp.ponslink.com`에서 grid API를 호출하지 않는다. 두 제품 표면을 분리해 장애/권한/쿠키 혼선을 막는다.

## 5. Process 설계

### 5.1 기존 운영 process

```text
service: ponswarp-signaling
host: warp.ponslink.com
role: 기존 room signaling / auth / cloud / billing
mesh enabled: false 또는 기존 기능과 무관
```

### 5.2 Grid coordinator process

```text
service: ponswarp-grid-coordinator
host: grid.ponslink.com
binary: ponswarp-signaling-rs/src/bin/mesh_api.rs
role: workspace/node/file/share/candidate/connect/rate-limit/audit
```

환경변수 예시:

```env
PONSWARP_MESH_ENABLED=true
PONSWARP_MESH_PUBLIC_BASE_URL=https://grid.ponslink.com
PONSWARP_MESH_DATABASE_URL=postgres://...
PONSWARP_MESH_DB_SCHEMA=grid
PONSWARP_MESH_RATE_LIMIT_BACKEND=postgres
PONSWARP_MESH_REQUIRE_NODE_TOKEN=true
PONSWARP_MESH_AUDIT_ENABLED=true
PONSWARP_MESH_METRICS_ENABLED=true
PONSWARP_TURN_ICE_ENDPOINT=https://grid.ponslink.com/api/grid/v1/ice
```

### 5.3 Web app process/static serving

`ponswarp-grid`의 browser app은 build artifact를 static으로 배포한다.

```text
apps/demo 또는 이후 apps/web
  build -> dist
  served at https://grid.ponslink.com/
```

초기에는 demo UI를 public beta UI로 사용할 수 있지만, developer QA controls는 기본 접힘/비공개 플래그가 필요하다.

## 6. DB / Persistence 설계

### 6.1 DB 분리 원칙

최소 권장:

```text
same Postgres cluster
  database/schema: ponswarp_grid
```

더 안전한 권장:

```text
separate database: ponswarp_grid_prod
separate db user: ponswarp_grid_app
least privilege: only required tables/schema
```

기존 `warp.ponslink.com` 운영 DB와 table/schema를 섞지 않는다.

### 6.2 필수 persistent data

```text
mesh_workspaces
mesh_workspace_members
mesh_nodes
mesh_node_tokens
mesh_presence
mesh_files
mesh_availability
mesh_shares
mesh_rate_limits
mesh_events
```

### 6.3 Retention / cleanup

운영 cleanup job:

| 대상 | 정책 |
|---|---|
| expired share | 만료 후 즉시 resolve/candidates 거부, N일 후 삭제 가능 |
| stale presence | heartbeat timeout 후 offline 처리 |
| revoked token | 즉시 거부, 감사 기록 보존 |
| rate limit bucket | expires_at 지난 row 삭제 |
| audit event | beta 기간 30~90일 보존, 이후 정책화 |
| file metadata | share 만료 + no active availability 후 cleanup 가능 |

## 7. API 경계

### 7.1 Public anonymous API

```text
GET  /api/grid/v1/shares/:code
GET  /api/grid/v1/shares/:code/candidates
POST /api/grid/v1/shares/:code/connect
GET  /api/grid/v1/ice
```

제약:

- share code가 유효하고 만료되지 않아야 한다.
- metadata는 최소 공개만 반환한다.
- 원본 file path, node private address, token, workspace internals는 노출하지 않는다.
- rate limit은 IP hash + share code hash 기준으로 적용한다.

### 7.2 Node API

```text
POST /api/grid/v1/workspaces/:workspace_id/nodes
POST /api/grid/v1/nodes/:node_id/heartbeat
POST /api/grid/v1/files
PUT  /api/grid/v1/files/:file_id/availability
POST /api/grid/v1/shares
DELETE /api/grid/v1/shares/:code
```

제약:

- node token 필수
- token hash만 DB 저장
- own-node scope만 허용
- revoke/share/delete는 owner/admin boundary 검증
- audit event 필수

### 7.3 Admin/internal API

```text
GET /api/grid/v1/admin/metrics-summary
GET /api/grid/v1/admin/audit
POST /api/grid/v1/admin/cleanup
POST /api/grid/v1/admin/revoke-node
```

초기 beta에서는 public internet에 직접 노출하지 않는다. VPN, allowlist, 또는 server-local admin만 허용한다.

## 8. TURN / ICE 설계

`grid.ponslink.com` client는 ICE config를 hardcode하지 않고 API에서 받아온다.

```text
GET https://grid.ponslink.com/api/grid/v1/ice
```

응답:

```json
{
  "iceServers": [
    { "urls": ["stun:..." ] },
    { "urls": ["turns:...:5349?transport=tcp"], "username": "...", "credential": "..." }
  ],
  "ttlSeconds": 600,
  "relayPolicyRecommended": false
}
```

운영 gate:

- LAN/Wi-Fi direct candidate 성공
- LTE/Wi-Fi NAT 환경 성공
- relay-only TURN/TLS 성공
- UDP-denied 조건에서 TCP/TLS relay 성공 또는 명확한 원인 분류

## 9. CLI 기본 설정

Node CLI 기본 endpoint는 `grid.ponslink.com`이다.

```text
ponswarp-grid login/setup
  default coordinator: https://grid.ponslink.com

ponswarp-grid share ./file.zip
  -> register node/file/share
  -> prints share code/link

ponswarp-grid get <code-or-link>
  -> resolve share
  -> connect candidates
  -> receive pieces
  -> verify hash
```

환경변수 override:

```env
PONSWARP_COORDINATOR_URL=https://grid.ponslink.com
PONSWARP_STORAGE_DIR=~/.ponswarp-grid
PONSWARP_NODE_TOKEN=...
```

## 10. Web UX 설계

`grid.ponslink.com` 첫 화면은 CLI를 몰라도 쓸 수 있어야 한다.

### 10.1 기본 화면

```text
PonsWarp
Share files directly.

[Share a file]
  Choose a file
  Create share link
  This device is online. Keep this tab open.

[Receive a file]
  Paste code or link
  Find file
  Download / Open app or CLI with this code
```

### 10.2 큰 파일 UX

브라우저만으로 가능한 크기와 CLI 권장 크기를 구분한다.

```text
Small/medium file:
  Browser download available

Large file:
  Open desktop app or CLI for best resume/offline support
  ponswarp-grid get DEMO-XXXX
```

### 10.3 Developer controls

`Developer and QA controls`는 production에서 기본 숨김 처리한다.

```env
PONSWARP_WEB_SHOW_QA_CONTROLS=false
```

## 11. 배포 단계

### Phase 0. 준비

작업:

1. DNS `grid.ponslink.com` 등록
2. TLS certificate 발급
3. reverse proxy route 추가
4. Postgres database/schema/user 생성
5. grid coordinator env 작성
6. web app build artifact 준비

통과 기준:

- `https://grid.ponslink.com/healthz` 200
- `https://grid.ponslink.com/readyz` 200
- 기존 `https://warp.ponslink.com` health/ws 회귀 없음

### Phase 1. Internal staging on production host

작업:

1. grid coordinator 별도 port로 실행
2. `grid.ponslink.com`에서만 proxy
3. admin/metrics는 allowlist 또는 local only
4. test workspace 생성
5. CLI/Web smoke

통과 기준:

- share create/resolve/candidates/connect 가능
- node heartbeat/presence 정상
- expired/revoked share 거부
- node token 없는 요청 거부
- rate limit 429 동작

### Phase 2. Private beta

작업:

1. 제한된 사용자/기기만 사용
2. 모바일 LTE ↔ Wi-Fi 테스트
3. TURN relay-only 테스트
4. 1시간 이상 soak
5. 서버 재시작 후 metadata 유지 검증

통과 기준:

- 기존 `warp.ponslink.com` 무영향
- grid error rate 허용치 이하
- cleanup/rate limit/audit 정상
- rollback 문서 검증

### Phase 3. Public beta

작업:

1. `grid.ponslink.com` 공개 안내
2. quota 기본값 보수적으로 적용
3. metrics/alerts 활성화
4. support/runbook 준비

통과 기준:

- 24h soak
- p95 API latency 목표 이내
- TURN failure rate 모니터링
- abuse 시나리오 방어 확인

## 12. Rollback 설계

### 12.1 즉시 rollback

```text
proxy에서 grid.ponslink.com upstream disable
또는 coordinator process stop
```

기대 효과:

- 기존 `warp.ponslink.com` 영향 없음
- grid 신규 요청만 중단
- 이미 연결된 P2P transfer는 client 상태에 따라 실패/재시도

### 12.2 DB rollback

원칙:

- migration은 forward-only 우선
- destructive migration 금지
- beta 전 DB snapshot 생성
- schema 변경 전 backup

### 12.3 Client rollback

CLI/Web은 coordinator URL override가 가능해야 한다.

```text
PONSWARP_COORDINATOR_URL=https://grid-staging.ponslink.com
```

## 13. 운영 관측성

필수 metrics:

| Metric | 목적 |
|---|---|
| active_nodes | 현재 online provider 수 |
| share_created_total | share 생성량 |
| share_resolved_total | share 조회량 |
| candidate_requests_total | candidate 조회량 |
| connect_grants_total | connect 요청량 |
| transfer_started_total | client-reported 시작 |
| transfer_completed_total | client-reported 완료 |
| rate_limit_hits_total | abuse/limit 감지 |
| auth_denied_total | 권한 실패 |
| turn_ice_failures_total | TURN/ICE 실패 |
| api_latency_ms | API latency |
| db_query_latency_ms | DB latency |
| cleanup_deleted_rows_total | cleanup 효과 |

필수 log/audit:

- request id
- workspace id
- node id hash
- share code hash
- actor type
- action
- decision allow/deny
- reason code
- latency

금지:

- raw token log
- raw TURN credential log
- full share code log
- user private file path log

## 14. 보안/Abuse 기본값

초기 public beta 기본값:

| Route group | Limit |
|---|---:|
| create_workspace | 10/hour/ip |
| register_node | 30/hour/workspace |
| heartbeat | 60/min/node |
| publish_file | 120/hour/node |
| create_share | 60/hour/node |
| resolve_share | 120/min/ip+share |
| candidates | 60/min/ip+share |
| connect | 60/min/ip+share |
| events | 120/min/node |

추가 정책:

- share code entropy 충분히 크게 유지
- share metadata minimal disclosure
- revoked/expired share는 candidates/connect 모두 deny
- node token rotation/revoke 지원
- repeated denied auth는 audit + rate limit 강화

## 15. QA 작업지시서

### 15.1 Pre-deploy local QA

```sh
pnpm build
pnpm test
pnpm type-check
pnpm grid:multi-provider-qa -- --out artifacts/grid-domain-multi-provider-report.json --size-mib 128 --piece-mib 1
node scripts/perf-500mb.mjs > artifacts/grid-domain-500mb-memory-report.json
```

Rust coordinator repo:

```sh
cargo test
node scripts/mesh-postgres-drill.mjs --database-url <staging-db> --out artifacts/grid-domain-postgres-drill.json
```

### 15.2 Staging host smoke

```text
1. GET https://grid.ponslink.com/healthz
2. GET https://grid.ponslink.com/readyz
3. GET https://grid.ponslink.com/api/grid/v1/ice
4. Web share demo create
5. Web receive by code
6. CLI share
7. CLI get
8. revoke share
9. expired share cleanup
10. server restart persistence
```

### 15.3 Real-device QA

Matrix:

| Sender | Receiver | Network | Expected |
|---|---|---|---|
| laptop browser | same laptop browser | localhost | pass |
| laptop browser | phone browser | LAN | pass |
| laptop CLI | other laptop CLI | LAN | pass |
| laptop LTE hotspot | home laptop Wi-Fi | NAT/mobile | pass or TURN relay pass |
| browser | CLI | NAT/mobile | pass |
| CLI | browser | NAT/mobile | pass |

### 15.4 Failure QA

| Scenario | Expected |
|---|---|
| invalid share code | safe 404/invalid response |
| expired share | deny resolve/candidates/connect |
| revoked share | deny resolve/candidates/connect |
| missing node token | 401/403 |
| wrong node token | 401/403 + audit |
| heartbeat spam | 429 |
| candidates spam | 429 |
| DB restart | readyz degraded then recovery |
| coordinator restart | persisted metadata remains |
| TURN UDP blocked | TCP/TLS relay success or classified failure |

## 16. 작업 단위

### T001 DNS/TLS/proxy

- `grid.ponslink.com` DNS 연결
- TLS certificate 발급
- proxy route 작성
- health/ready/metrics route 분리
- acceptance: `grid.ponslink.com` health 200, `warp.ponslink.com` 무영향

### T002 DB namespace

- grid 전용 DB/schema/user 생성
- migrations 적용
- backup/restore dry-run
- acceptance: Postgres drill 통과

### T003 Coordinator runtime config

- mesh coordinator service unit 작성
- env/secrets 분리
- systemd restart policy
- logs 위치 확정
- acceptance: process restart 후 ready 회복

### T004 Web app deployment

- production build
- static asset serve
- API base URL `https://grid.ponslink.com`
- QA controls production hidden
- acceptance: browser share/get smoke 통과

### T005 CLI default endpoint

- default coordinator URL `https://grid.ponslink.com`
- env override 유지
- install/use docs 갱신
- acceptance: CLI share/get smoke 통과

### T006 TURN/ICE endpoint

- `/api/grid/v1/ice` production response
- credential TTL/redaction
- relay-only diagnostic
- acceptance: TCP/TLS TURN gate report 통과

### T007 Auth/RBAC/rate-limit/audit production config

- node token required
- route group limits 적용
- audit redaction 검증
- acceptance: auth/rate-limit failure QA 통과

### T008 Metrics/alerts

- metrics endpoint protection
- dashboard or textual runbook
- alert thresholds
- acceptance: active nodes/share/rate-limit/db metrics visible

### T009 Real-device private beta QA

- LAN, NAT/mobile, browser/CLI matrix
- long session soak
- restart/reconnect
- acceptance: QA report 저장

### T010 Public beta release decision

- artifacts 검토
- rollback drill
- go/no-go 기록
- acceptance: public beta 승인 또는 blocker 기록

## 17. Go / No-Go 기준

### Go for private beta

- `grid.ponslink.com`이 기존 `warp.ponslink.com`과 분리되어 동작
- Postgres persistence/restart/cleanup 통과
- RBAC/token/rate-limit/audit 통과
- TURN TCP/TLS relay 검증 또는 명확한 제한 문서화
- real-device 최소 LAN + NAT/mobile smoke 통과
- rollback 절차 검증

### No-Go

- 기존 `warp.ponslink.com` 회귀
- DB 장애가 기존 signaling에 영향
- raw token/credential log 노출
- expired/revoked share가 candidates/connect 가능
- rate limit 우회 가능
- TURN 실패 원인 미분류
- rollback 불가

## 18. 추가 보완 항목

검토 결과 v1.0 설계의 큰 방향은 맞지만, 운영 배포 문서로 쓰려면 아래 항목이 빠져 있었다. 이 항목들은 `grid.ponslink.com` private beta 전에 필수로 닫는다.

### 18.1 Secrets / credential 운영

필수 secret:

```text
DATABASE_URL
NODE_TOKEN_SIGNING_SECRET 또는 token hash pepper
TURN_STATIC_AUTH_SECRET 또는 TURN credential issuer secret
ADMIN_API_TOKEN
METRICS_BASIC_AUTH 또는 internal auth
SESSION/JWT verification secret if user auth is enabled
```

운영 원칙:

- `.env`를 repo에 커밋하지 않는다.
- systemd `EnvironmentFile`, secret manager, 또는 서버 전용 root-readable file로 관리한다.
- secret rotation 절차를 문서화한다.
- TURN credential과 node token raw value는 log, metrics, audit, client error에 남기지 않는다.
- staging/prod secret은 분리한다.

작업 단위 추가:

```text
T011 Secrets and rotation
  - production/staging secret inventory 작성
  - secret file permission 0600 검증
  - token/TURN credential redaction 테스트
  - rotation runbook 작성
```

### 18.2 Web security headers / browser policy

`grid.ponslink.com` web surface에는 다음 header를 적용한다.

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; connect-src 'self' https://grid.ponslink.com wss://grid.ponslink.com <TURN/STUN endpoints>; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
```

주의:

- WebRTC는 `connect-src`에 signaling/TURN 관련 endpoint가 필요할 수 있다.
- file download URL은 `blob:`이 필요하면 CSP에 명시한다.
- HSTS preload는 beta 안정화 전에는 보류할 수 있다.

작업 단위 추가:

```text
T012 Web security headers
  - reverse proxy header 적용
  - browser share/get smoke에서 CSP violation 확인
  - file save/download 동작 확인
```

### 18.3 Static asset cache / release versioning

static asset 정책:

```text
/assets/* fingerprinted files
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache

/service-worker.js if introduced
  Cache-Control: no-cache
```

릴리즈 원칙:

- Web build version을 `/version.json` 또는 footer/debug payload에 노출한다.
- CLI와 coordinator API version compatibility를 확인한다.
- API breaking change는 `/api/grid/v1`을 유지하거나 `/v2`로 올린다.

작업 단위 추가:

```text
T013 Release versioning/cache
  - web build hash/version 노출
  - cache header smoke
  - CLI/coordinator version compatibility check
```

### 18.4 Health/readiness 상세 기준

`healthz`와 `readyz`를 분리한다.

```text
GET /healthz
  - process alive
  - DB 연결 불필요
  - 200 if process can serve static/simple response

GET /readyz
  - DB ping
  - migration version check
  - rate limit storage check
  - cleanup scheduler status
  - optional TURN credential issuer check
```

응답 예시:

```json
{
  "status": "ready",
  "version": "2026.07.04+gitsha",
  "checks": {
    "db": "ok",
    "migrations": "ok",
    "rateLimitStore": "ok",
    "turnCredentialIssuer": "ok"
  }
}
```

No-Go:

- DB down인데 `readyz`가 200을 반환
- process alive인데 `healthz`가 DB 때문에 실패
- migration mismatch를 감추고 serving 계속

### 18.5 Migration / backup / restore 세부 절차

배포 전 절차:

```text
1. current schema version 확인
2. DB snapshot 또는 pg_dump
3. migration dry-run on staging clone
4. migration apply
5. readyz migration check
6. rollback point 기록
```

운영 원칙:

- destructive migration 금지
- large table migration은 lock time 평가
- index creation은 가능하면 concurrently
- rollback은 DB downgrade보다 app rollback + forward-compatible schema 우선

작업 단위 추가:

```text
T014 Migration and backup drill
  - staging clone migration
  - backup artifact 생성
  - restore smoke
  - migration lock/runtime 기록
```

### 18.6 설치/온보딩 문서

`grid.ponslink.com`을 처음 보는 사용자를 위해 최소 문서가 필요하다.

필수 문서:

```text
README.md
  - grid.ponslink.com Web 사용법
  - CLI 설치
  - CLI share/get
  - coordinator URL override
  - 큰 파일은 CLI 권장 이유
  - 보안/프라이버시 설명

docs/15-grid-user-guide.md
  - Web sender flow
  - Web receiver flow
  - CLI sender flow
  - CLI receiver flow
  - troubleshooting: NAT/TURN/firewall
```

작업 단위 추가:

```text
T015 User onboarding docs
  - README quickstart 갱신
  - docs/15-grid-user-guide.md 작성
  - install smoke와 문서 명령어 일치 검증
```

### 18.7 Privacy / legal / abuse policy

서버가 원본 파일을 저장하지 않아도 metadata는 개인정보/민감정보가 될 수 있다.

명시할 것:

- 저장하는 metadata 종류
- 저장하지 않는 데이터: 원본 파일 내용
- share code 만료 정책
- audit log 보존 기간
- 삭제 요청 처리 방식
- abuse 신고/차단 방식
- IP hash 정책과 salt rotation 정책

작업 단위 추가:

```text
T016 Privacy and abuse policy
  - metadata inventory
  - retention table 확정
  - delete/revoke flow QA
  - abuse contact/runbook 작성
```

### 18.8 Cost / quota guardrail

TURN relay와 대용량 전송은 비용 리스크가 있다.

초기 beta guardrail:

```text
max active shares per node
max file metadata size
max candidates per share response
max relay-only session duration
max daily connect grants per IP/workspace
large-file warning threshold
```

운영 metric:

```text
turn_relay_sessions_total
turn_relay_bytes_estimated
grid_candidate_response_size
large_file_share_created_total
quota_denied_total
```

작업 단위 추가:

```text
T017 Cost guardrails
  - quota config 추가/확인
  - TURN relay abuse 시나리오 테스트
  - large-file warning UX 확인
```

### 18.9 Incident/runbook

운영 중 장애 대응 문서가 필요하다.

Runbook 항목:

```text
- grid coordinator down
- DB down / migration mismatch
- TURN down
- rate limit false positive
- token leak suspected
- abuse spike
- rollback grid.ponslink.com only
- verify warp.ponslink.com unaffected
```

작업 단위 추가:

```text
T018 Incident runbook
  - 장애별 탐지 metric
  - 즉시 완화 명령
  - rollback 명령
  - 사용자 공지 기준
```

### 18.10 최종 보완된 작업 순서

기존 T001~T010 뒤에 아래를 추가한다.

```text
T011 Secrets and rotation
T012 Web security headers
T013 Release versioning/cache
T014 Migration and backup drill
T015 User onboarding docs
T016 Privacy and abuse policy
T017 Cost guardrails
T018 Incident runbook
```

private beta 전 필수:

```text
T001~T014, T017, T018
```

public beta 전 필수:

```text
T001~T018 전체
```

GA 전 필수:

```text
24h+ soak, support process, privacy/abuse policy, rollback drill, cost guardrail 검증, real user beta feedback 반영
```
## 19. 최종 권장안

`grid.ponslink.com`으로 간다. 단, 의미는 즉시 GA가 아니라 **분리된 public-beta 후보 도메인**이다.

운영 순서:

```text
1. grid.ponslink.com DNS/TLS/proxy 구성
2. grid coordinator 별도 process + 별도 DB/schema 배포
3. 내부 smoke
4. real-device private beta
5. public beta
6. GA
```

기존 `warp.ponslink.com`은 계속 기존 서비스용으로 유지한다. PonsWarp Grid의 제품 정체성과 운영 안정성을 동시에 확보하려면 이 구조가 현재 최선이다.
