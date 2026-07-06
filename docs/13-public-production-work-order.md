# PonsWarp Public Production Work Order

문서 버전: v1.0
작성일: 2026-07-04
상위 설계: `docs/12-public-production-readiness-design.md`
Ultragoal brief: `artifacts/production-public-readiness-ultragoal-brief.md`

## 0. 공통 규칙

- 각 단계는 TDD 우선으로 실패 테스트 또는 진단 harness를 먼저 추가한다.
- 구현 후 해당 단계 focused test를 실행한다.
- 단계 완료 전 전체 회귀를 실행한다.
- 모든 QA 결과는 `artifacts/`에 저장한다.
- 기존 운영 signaling 기능은 mesh 작업 중에도 regression 대상이다.
- public production go는 모든 gate 통과 후에만 가능하다.

## G001. TURN TCP/TLS-only validation

### 작업 단위

1. TURN diagnostic script 추가
   - 파일: `scripts/turn-diagnostics.mjs`
   - 기능: relay-only RTCPeerConnection 생성, candidate 수집, selected pair stats 수집, optional datachannel transfer
   - 입력: ICE server JSON/file, expected protocol, mode, timeout, report path
   - 출력: structured JSON report

2. npm script 추가
   - 파일: `package.json`
   - script: `turn:diagnose`

3. 문서 업데이트
   - 파일: `docs/10-release-qa-gates.md`
   - TCP/TLS-only 검증 절차와 결과 기록란 추가

4. QA 실행
   - UDP 허용 환경: TCP/TLS-only proof가 되지 않음을 정확히 기록
   - UDP 차단 환경 또는 TURN TCP/TLS-only endpoint: selected pair가 relay/tcp 또는 TLS relay인지 확인
   - 결과: `artifacts/public-g001-turn-tcp-tls-report.json`

### 완료 조건

- script가 deterministic JSON report를 만든다.
- TCP/TLS-only 성공 또는 명확한 blocker 분류가 있다.
- release gate 문서가 과장 없이 업데이트된다.

## G002. Postgres operational persistence

### 작업 단위

1. Postgres drill test/harness 추가
   - 위치: `ponswarp-signaling-rs`
   - 테스트: migration, restart persistence, stale cleanup, feature-flag rollback, legacy isolation

2. Repository 보강
   - Postgres CRUD 누락 경로 확인
   - revoked/expired/unexpired share 상태 유지
   - cleanup 결과를 API candidate/resolve에 반영

3. 운영 runbook 작성
   - DB migration
   - backup/restore
   - rollback/feature flag off

4. QA 실행
   - `cargo test mesh::tests --lib`
   - `cargo test`
   - Postgres drill 가능 시 실제 DB drill

### 완료 조건

- restart 후 unexpired share/file/node metadata 유지
- stale/expired/revoked 데이터 정책 반영
- legacy `/ws` 경로가 mesh DB 실패와 격리됨

## G003. RBAC / token / audit

### 작업 단위

1. Node token lifecycle 구현
   - issue, hash storage, validate, revoke
   - raw token log 금지

2. Actor resolution 정교화
   - Anonymous public share capability
   - Node token actor
   - User/session actor, 가능 범위부터
   - Admin actor

3. Authorization enforcement
   - heartbeat/update availability는 own node only
   - publish/create share는 scope 검사
   - revoke는 own share 또는 admin/workspace admin만

4. Audit event 확장
   - auth_denied
   - token issued/revoked hash only
   - share/file/node actions

5. QA 실행
   - negative auth tests
   - scope boundary tests
   - no secret leakage tests

### 완료 조건

- 권한 매트릭스 주요 경로가 테스트로 고정된다.
- token raw value가 로그/응답/report에 노출되지 않는다.

## G004. Distributed rate limit / abuse

### 작업 단위

1. Postgres-backed token bucket migration 추가
2. rate limit repository/trait 구현
3. route group별 enforcement
4. 429 envelope + headers 추가
5. abuse audit event 기록
6. QA 실행
   - burst tests
   - per-workspace isolation
   - brute-force share code probing
   - heartbeat/event spam

### 완료 조건

- process-local 제한이 아닌 shared storage 기반 제한이 가능하다.
- quota 초과 시 429와 audit event가 발생한다.
- unrelated workspace/node는 격리된다.

## G005. Multi-provider large-file grid

### 작업 단위

1. Scheduler contract 테스트 작성
   - provider candidate ranking
   - verified range 기반 assignment
   - owner fallback
   - churn retry

2. CLI/Web transfer path 보강
   - coordinator candidates에서 복수 provider 사용
   - per-piece provider attribution report
   - provider failure 시 retry/fallback

3. Large-file QA harness
   - 64MiB/128MiB real transfer
   - 500MiB simulated bounded-memory
   - 가능 시 1GiB+ real disk-backed transfer

4. Report 작성
   - throughput
   - file size
   - piece count
   - provider count
   - non-owner piece count
   - retries/failures
   - final hash match

### 완료 조건

- 최소 2개 provider가 실제 piece source로 사용된 증거가 있다.
- provider churn 후 hash match 완료가 증명된다.
- bounded memory invariant가 증명된다.

## 최종 검증

- `pnpm build`
- `pnpm test`
- `pnpm type-check`
- `cargo test` in `ponswarp-signaling-rs`
- Gate별 artifact와 quality gate JSON
- `gjc ultragoal checkpoint`로 각 goal complete
- 모든 goal complete 후 public production readiness report 작성