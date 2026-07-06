# PonsWarp Grid Engine 문서 인덱스

작성일: 2026-06-30  
대상 프로젝트: PonsWarp Grid Engine  
문서 상태: v0.1 초안

---

## 1. 목적

이 폴더는 기존 PonsWarp를 **브라우저 기반 P2P 대용량 파일 전송 앱**에서 **재사용 가능한 오픈소스 Grid Engine**으로 분리하기 위한 설계 문서 묶음이다.

핵심 방향은 다음과 같다.

> 기존 PonsWarp의 WebRTC 전송 기능을 UI와 서비스 로직에서 분리하고, 파일을 piece 단위로 관리하는 core engine, WebRTC transport, signaling server, demo app으로 재구성한다.

---

## 2. 문서 목록

| 파일 | 문서명 | 목적 |
|---|---|---|
| `ponswarp-grid-engine-prd.md` | PRD | 제품 방향, 목표, 범위, 로드맵 정의 |
| `01-code-audit-extraction-plan.md` | 기존 코드 감사 및 추출 계획서 | PonsWarp에서 무엇을 가져오고 버릴지 결정 |
| `02-srs.md` | SRS 기능 명세서 | 기능별 동작, 입력, 출력, 예외, 완료 기준 정의 |
| `03-sdd-architecture.md` | SDD 아키텍처 설계서 | 패키지 구조, 모듈 의존성, 클래스, 데이터 흐름 정의 |
| `04-protocol-spec.md` | 프로토콜 명세서 | WebRTC DataChannel과 signaling 메시지 형식 정의 |
| `05-test-plan.md` | 테스트 계획서 | 단위, 통합, E2E, 시연 테스트 전략 정의 |
| `06-contest-dev-report-draft.md` | 대회 개발보고서 초안 | 오픈소스 개발자대회 제출용 서술 구조 |
| `07-implementation-tickets.md` | 구현 티켓 목록 | 실제 개발 작업 단위와 우선순위 정의 |
| `08-production-hardening-design.md` | 운영 보강 설계서 | Postgres 영속화, 인증/권한, rate limit, 관측성, cleanup, 멀티 디바이스 release gate 정의 |
| `09-final-production-architecture-summary.md` | 최종 운영 아키텍처 요약 | mesh coordinator 분리형 최종 구조, 구현 순서, production enable blockers 정리 |
| `10-release-qa-gates.md` | 릴리스 QA 게이트 | mesh API load, abuse/rate-limit, cleanup/retention, restart/DR, metrics/log, rollback/go/no-go 체크리스트 |
| `11-multi-device-qa-report-template.md` | 멀티 디바이스 QA 보고서 템플릿 | desktop/mobile, LAN/NAT, reconnect, restart, large-file/resume, 3+ peer grid 검증 기록 양식 |
| `12-public-production-readiness-design.md` | Public production readiness 설계 | TURN TCP/TLS, Postgres, RBAC/token/audit, rate limit, multi-provider 대용량 grid gate 설계 |
| `13-public-production-work-order.md` | Public production 작업지시서 | 운영 배포 전 gate별 구현·QA·checkpoint 작업 순서 |
| `14-grid-ponslink-deployment-design.md` | `grid.ponslink.com` 배포 설계 | 기존 `warp.ponslink.com` 운영과 분리된 Grid 전용 도메인, proxy, DB, rollout, QA 작업지시 |
| `16-grid-95-completion-design.md` | 95% 완성도 달성 설계서 | 현재 MVP 상태에서 제품 완성도 95% 이상으로 올리기 위한 목표 아키텍처, scorecard, gap closure 설계 |
| `17-grid-95-completion-work-order.md` | 95% 완성도 작업지시서 | core, browser, CLI, coordinator, network QA, production hardening, docs 정렬을 위한 실행 작업 패키지 |
| `18-external-network-qa-playbook.md` | 외부망 QA 플레이북 | strict network matrix를 통과하기 위해 필요한 실제 외부망/UDP 차단/TURN TCP-TLS 검증 절차와 artifact 형식 |
| `19-grid-public-ui-concept.md` | Public UI 콘셉트 | 공개 웹 화면을 Send file / Receive file 두 동작으로 단순화하기 위한 IA, copy, visual prompt |
| `20-grid-ui-reference-implementation-prompt.md` | UI reference 구현 프롬프트 | 승인된 콘셉트 이미지를 실제 React/Vite UI로 재현하기 위한 시각/상호작용/QA 기준 |

---

## 3. 현재 문서의 전제

아직 실제 PonsWarp repository 전체를 코드 레벨에서 직접 감사한 상태는 아니다. 따라서 이 문서 묶음은 다음 전제를 둔다.

1. 기존 PonsWarp에는 WebRTC 연결, room 생성, 파일 선택, chunk 전송, progress 표시 로직이 일부 존재한다.
2. 기존 구현은 앱 UI와 전송 로직이 어느 정도 결합되어 있을 가능성이 있다.
3. Grid Engine은 기존 코드를 그대로 옮기는 방식이 아니라, **재사용 가능한 모듈**로 재구성하는 방식을 따른다.
4. 코드 감사 후 실제 파일 경로, 함수명, 삭제 대상, 이식 대상은 `01-code-audit-extraction-plan.md`에 업데이트한다.

---

## 4. 추천 진행 순서

```text
1. PRD 확인
2. 기존 PonsWarp 코드 감사
3. 추출 대상과 폐기 대상 확정
4. core package 생성
5. manifest와 piece manager 구현
6. storage adapter 구현
7. WebRTC transport 이식
8. signaling server 정리
9. resume demo 완성
10. protocol과 test 문서 갱신
11. 대회 개발보고서 작성
```

---

## 5. 가장 먼저 해야 할 일

바로 구현에 들어가기 전에 다음 3가지를 먼저 확정한다.

### 5.1 Repository 전략

권장안:

```text
새 repo: ponswarp-grid
기존 repo: ponswarp 원본 참조용 유지
```

이유:

- 기존 앱 구조에 끌려가지 않는다.
- 대회 제출용 오픈소스 엔진으로 포장하기 쉽다.
- README, docs, demo, packages 구조를 처음부터 명확하게 잡을 수 있다.

대안:

```text
기존 PonsWarp repo를 monorepo로 전환
```

이 방식은 기존 배포와 history를 살릴 수 있으나, 리팩터링 중 앱이 깨질 가능성이 있다.

---

### 5.2 MVP 기준

MVP 성공 기준은 다음이다.

```text
브라우저 A에서 파일 선택
→ manifest 생성
→ session link 생성
→ 브라우저 B 접속
→ WebRTC DataChannel 연결
→ piece 단위 전송
→ OPFS 또는 IndexedDB 저장
→ 새로고침 후 resume
→ SHA-256 검증
→ 최종 파일 저장
```

다중 peer grid 전송은 v1.5로 미뤄도 된다. 단, **PieceMap, PeerMap, Scheduler 인터페이스**는 v1에서 미리 설계한다.

---

### 5.3 대회 시연 우선순위

대회 시연에서 가장 강한 장면은 다음이다.

```text
다운로드 중 브라우저 새로고침
→ 이미 받은 piece 복원
→ 나머지만 이어받기
→ hash 검증 완료
```

이 장면이 나오면 PonsWarp Grid가 단순 파일 전송 UI가 아니라 **전송 엔진**이라는 점이 선명해진다.

---

## 6. 문서 유지 규칙

문서는 구현과 함께 갱신한다.

| 이벤트 | 갱신 대상 |
|---|---|
| 기존 코드 경로 확인 | `01-code-audit-extraction-plan.md` |
| 기능 동작 변경 | `02-srs.md` |
| 패키지 구조 변경 | `03-sdd-architecture.md` |
| 메시지 타입 변경 | `04-protocol-spec.md` |
| 테스트 추가 | `05-test-plan.md` |
| 대회 제출 문안 변경 | `06-contest-dev-report-draft.md` |
| 작업 우선순위 변경 | `07-implementation-tickets.md` |
| 운영 보강 설계 변경 | `08-production-hardening-design.md` |
| 95% 완성도 계획 수립 | `16-grid-95-completion-design.md`, `17-grid-95-completion-work-order.md` |
| 최종 운영 구조 변경 | `09-final-production-architecture-summary.md`, `14-grid-ponslink-deployment-design.md`, `16-grid-95-completion-design.md`, `17-grid-95-completion-work-order.md` |
| 릴리스/운영 QA 기준 변경 | `10-release-qa-gates.md`, `11-multi-device-qa-report-template.md`, `13-public-production-work-order.md`, `14-grid-ponslink-deployment-design.md`, `16-grid-95-completion-design.md`, `17-grid-95-completion-work-order.md` |

---

## 7. 최종 목표 문장

> PonsWarp Grid Engine은 브라우저에서 파일을 piece 단위로 분할하고, WebRTC DataChannel을 통해 P2P로 전송하며, 로컬 저장소 기반 resume과 SHA-256 검증을 제공하는 오픈소스 대용량 데이터 전송 엔진이다.
