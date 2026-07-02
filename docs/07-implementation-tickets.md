# PonsWarp Grid Engine 구현 티켓 목록

문서 버전: v0.1  
작성일: 2026-06-30

---

## 1. 목적

이 문서는 PRD, SRS, SDD를 실제 개발 작업으로 쪼갠 구현 티켓 목록이다. 1인 개발 기준으로도 진행 순서를 잃지 않도록, 각 티켓은 목표, 작업, 완료 조건, 의존성을 포함한다.

우선순위 표기:

| 우선순위 | 의미 |
|---|---|
| P0 | MVP 필수 |
| P1 | 대회 완성도 강화 |
| P2 | 후순위 확장 |

작업 크기 표기:

| Size | 의미 |
|---|---|
| S | 작음 |
| M | 보통 |
| L | 큼 |
| XL | 쪼개야 함 |

---

## Epic 0. Repository 준비

## T-000. 새 repository 또는 monorepo 구조 결정

- Priority: P0
- Size: S
- Depends on: 없음

### 작업

- 기존 PonsWarp repo 안에서 진행할지, 새 repo `ponswarp-grid`로 분리할지 결정
- package manager 결정
- license 결정

### 완료 조건

- repo 생성 또는 monorepo branch 생성
- `README.md`, `LICENSE`, `.gitignore` 추가
- package manager lockfile 생성

---

## T-001. Workspace 구조 생성

- Priority: P0
- Size: M
- Depends on: T-000

### 작업

```text
packages/core
packages/webrtc
packages/signaling
packages/react
apps/demo
docs
```

### 완료 조건

- 각 package build 가능
- TypeScript config 공유
- root script 동작

---

## Epic 1. 기존 PonsWarp 코드 감사

## T-010. WebRTC 코드 위치 확인

- Priority: P0
- Size: S
- Depends on: T-000

### 작업

- `RTCPeerConnection` 검색
- `RTCDataChannel` 검색
- offer/answer/candidate 흐름 기록

### 완료 조건

- 현재 파일 경로 목록 작성
- 재사용 가능 함수 표시
- UI 의존성 표시

---

## T-011. Signaling 코드 위치 확인

- Priority: P0
- Size: S
- Depends on: T-000

### 작업

- WebSocket 연결 코드 찾기
- room create/join 흐름 찾기
- message type 목록화

### 완료 조건

- signaling flow diagram 작성
- 새 protocol과 차이점 기록

---

## T-012. File chunking 코드 위치 확인

- Priority: P0
- Size: S
- Depends on: T-000

### 작업

- `File.slice` 사용 위치 찾기
- chunk size 확인
- progress 계산 방식 확인

### 완료 조건

- 기존 chunking logic 요약
- core로 이식 가능한 부분 표시

---

## T-013. 코드 감사 결과 문서화

- Priority: P0
- Size: M
- Depends on: T-010, T-011, T-012

### 완료 조건

- `docs/code-audit-result.md` 작성
- reuse/refactor/delete/new 분류 완료

---

## Epic 2. Core Package

## T-020. Core type 정의

- Priority: P0
- Size: M
- Depends on: T-001

### 작업

- `SessionId`, `PeerId`, `FileId`
- `FileManifest`
- `PieceDescriptor`
- `PieceState`
- `TransferProgress`
- `PonsWarpError`

### 완료 조건

- type export
- type test 또는 compile 통과

---

## T-021. EventBus 구현

- Priority: P0
- Size: S
- Depends on: T-020

### 작업

- `on`, `off`, `emit`
- typed event 지원

### 완료 조건

- event subscribe/unsubscribe 테스트 통과

---

## T-022. ManifestGenerator 구현

- Priority: P0
- Size: L
- Depends on: T-020

### 작업

- File metadata 읽기
- piece count 계산
- piece descriptors 생성
- SHA-256 piece hash 계산
- optional file hash 계산

### 완료 조건

- 100MB 파일 manifest 생성 가능
- 마지막 piece size 정확
- unit test 통과

---

## T-023. PieceManager 구현

- Priority: P0
- Size: M
- Depends on: T-020

### 작업

- piece 상태 전이
- missing pieces 계산
- verified pieces 계산
- progress 계산
- retry count 관리

### 완료 조건

- 상태 전이 테스트 통과
- piece map export/import 가능

---

## T-024. IntegrityChecker 구현

- Priority: P0
- Size: S
- Depends on: T-020

### 작업

- Web Crypto API SHA-256 wrapper
- piece 검증
- file 검증 helper

### 완료 조건

- hash deterministic test 통과
- mismatch test 통과

---

## T-025. StorageAdapter interface 정의

- Priority: P0
- Size: S
- Depends on: T-020

### 작업

- storage interface 정의
- persisted state type 정의

### 완료 조건

- MemoryStorageAdapter 구현 가능 상태

---

## T-026. MemoryStorageAdapter 구현

- Priority: P0
- Size: S
- Depends on: T-025

### 작업

- unit/integration test용 memory storage 구현

### 완료 조건

- write/read/delete/has 테스트 통과

---

## T-027. OPFSStorageAdapter 구현

- Priority: P0
- Size: L
- Depends on: T-025

### 작업

- session directory 생성
- piece write/read
- state save/load
- cleanup

### 완료 조건

- browser 환경에서 piece 저장 가능
- 새로고침 후 state 복원 가능

---

## T-028. Scheduler MVP 구현

- Priority: P0
- Size: M
- Depends on: T-023

### 작업

- owner-first missing piece scheduler
- retry queue
- timeout handling

### 완료 조건

- missing piece 순차 요청 가능
- failed piece 재요청 가능

---

## Epic 3. Protocol

## T-030. Protocol message type 정의

- Priority: P0
- Size: M
- Depends on: T-020

### 작업

- signaling envelope type
- transfer envelope type
- control message union
- error code type

### 완료 조건

- TypeScript compile 통과
- protocol spec와 타입 일치

---

## T-031. Protocol codec 구현

- Priority: P0
- Size: M
- Depends on: T-030

### 작업

- JSON encode/decode
- version validation
- unknown message handling

### 완료 조건

- invalid message test 통과
- version mismatch test 통과

---

## Epic 4. WebRTC Package

## T-040. SignalingClient 구현

- Priority: P0
- Size: M
- Depends on: T-030

### 작업

- WebSocket 연결
- createSession
- joinSession
- offer/answer/candidate send
- message handler

### 완료 조건

- signaling server mock과 통신 가능

---

## T-041. PeerConnection wrapper 구현

- Priority: P0
- Size: M
- Depends on: T-040

### 작업

- RTCPeerConnection 생성
- data channel 생성
- ICE candidate 이벤트 연결
- connection state event

### 완료 조건

- 두 peer 간 connection state connected 도달

---

## T-042. DataChannel wrapper 구현

- Priority: P0
- Size: M
- Depends on: T-041

### 작업

- JSON message send/receive
- binary send/receive
- close/error event

### 완료 조건

- 작은 binary payload 왕복 테스트 가능

---

## T-043. Backpressure 구현

- Priority: P0
- Size: M
- Depends on: T-042

### 작업

- bufferedAmount high/low watermark
- send queue 대기

### 완료 조건

- high watermark에서 send가 대기함
- low event 후 재개함

---

## T-044. WebRTCTransport 구현

- Priority: P0
- Size: L
- Depends on: T-040, T-041, T-042, T-043

### 작업

- core Transport interface 구현
- peer별 channel 관리
- message routing

### 완료 조건

- core engine에서 transport로 사용 가능

---

## Epic 5. Signaling Server

## T-050. Signaling server bootstrap

- Priority: P0
- Size: M
- Depends on: T-001

### 작업

- Node WebSocket server 생성
- health endpoint 또는 simple log

### 완료 조건

- local에서 server 실행 가능

---

## T-051. RoomManager 구현

- Priority: P0
- Size: M
- Depends on: T-050

### 작업

- session create
- session lookup
- peer join/leave
- expiration

### 완료 조건

- session lifecycle test 통과

---

## T-052. SDP/ICE relay 구현

- Priority: P0
- Size: M
- Depends on: T-051

### 작업

- offer relay
- answer relay
- candidate relay
- unknown peer error

### 완료 조건

- 두 브라우저 연결 성공

---

## Epic 6. Engine 통합

## T-060. createSession flow 연결

- Priority: P0
- Size: L
- Depends on: T-022, T-040, T-051

### 작업

- files → manifest
- signaling create session
- shareUrl 반환

### 완료 조건

- sender demo에서 session 생성 가능

---

## T-061. joinSession flow 연결

- Priority: P0
- Size: L
- Depends on: T-040, T-052

### 작업

- session join
- manifest 수신
- WebRTC 연결 시작

### 완료 조건

- receiver가 owner와 DataChannel 연결 가능

---

## T-062. piece transfer flow 구현

- Priority: P0
- Size: XL
- Depends on: T-023, T-027, T-028, T-044, T-061

### 작업

- PIECE_REQUEST
- file slice
- chunk send
- receiver reassembly
- storage write
- hash verify
- ACK/REJECT

### 완료 조건

- 100MB 파일 전송 성공
- hash verified

### 비고

XL이면 다음으로 쪼갠다.

- request/response control flow
- chunk sender
- chunk receiver
- storage write
- ack/retry

---

## T-063. resume flow 구현

- Priority: P0
- Size: L
- Depends on: T-027, T-062

### 작업

- local state 저장
- 새로고침 후 state load
- manifest mismatch 검사
- missing piece만 요청

### 완료 조건

- 다운로드 중 새로고침 후 이어받기 성공

---

## Epic 7. Demo App

## T-070. Sender page 구현

- Priority: P0
- Size: M
- Depends on: T-060

### 작업

- 파일 선택
- session 생성 버튼
- share link 표시
- owner debug panel

### 완료 조건

- 파일 선택 후 link 생성 가능

---

## T-071. Receiver page 구현

- Priority: P0
- Size: M
- Depends on: T-061

### 작업

- sessionId route
- manifest 표시
- download button
- progress 표시

### 완료 조건

- receiver가 다운로드 시작 가능

---

## T-072. Debug panel 구현

- Priority: P0
- Size: M
- Depends on: T-062

### 작업

- peer state
- datachannel state
- bufferedAmount
- piece map
- retry count
- speed

### 완료 조건

- 시연에서 엔진 내부 상태 확인 가능

---

## T-073. Resume demo UI 구현

- Priority: P0
- Size: M
- Depends on: T-063

### 작업

- resume detected 표시
- restored pieces 표시
- missing pieces 표시

### 완료 조건

- 새로고침 후 복원 상태가 UI에 표시됨

---

## Epic 8. Test와 문서

## T-080. Unit test 작성

- Priority: P0
- Size: M
- Depends on: T-022, T-023, T-024, T-026

### 완료 조건

- manifest, piece manager, integrity, memory storage test 통과

---

## T-081. Integration test 작성

- Priority: P0
- Size: M
- Depends on: T-062

### 완료 조건

- mock transport transfer test 통과
- resume integration test 통과

---

## T-082. Browser E2E test 작성

- Priority: P1
- Size: L
- Depends on: T-070, T-071, T-063

### 완료 조건

- 기본 전송 E2E 통과
- resume E2E 통과

---

## T-083. README 작성

- Priority: P0
- Size: M
- Depends on: T-070, T-071

### 내용

- 프로젝트 소개
- 설치
- local demo 실행
- API quickstart
- architecture overview
- license

### 완료 조건

- 처음 보는 개발자가 demo 실행 가능

---

## T-084. Protocol 문서 업데이트

- Priority: P0
- Size: S
- Depends on: T-030, T-031

### 완료 조건

- 실제 구현 message type과 문서 일치

---

## T-085. 대회 개발보고서 작성

- Priority: P0
- Size: M
- Depends on: T-063, T-083

### 완료 조건

- 문제 정의
- 개발 내용
- 구현 결과
- 기대 효과
- 오픈소스 활용성 작성 완료

---

## T-086. 3분 시연 영상 준비

- Priority: P0
- Size: M
- Depends on: T-073, T-085

### 완료 조건

- 기본 전송
- 새로고침 resume
- hash 검증
- docs/repo 소개 포함

---

## Epic 9. v1.5 Grid 확장

## T-090. Peer PieceMap 교환

- Priority: P1
- Size: M
- Depends on: T-062

### 완료 조건

- 각 peer가 verified pieces를 broadcast 가능

---

## T-091. Peer availability table 구현

- Priority: P1
- Size: M
- Depends on: T-090

### 완료 조건

- piece별 제공 가능한 peer 목록 계산 가능

---

## T-092. Multi-peer scheduler 초안

- Priority: P1
- Size: L
- Depends on: T-091

### 완료 조건

- receiver가 owner 외 peer에게 piece 요청 가능

---

## 2. 최단 MVP 경로

시간이 부족할 때는 아래 순서만 우선 수행한다.

```text
T-000 repo 준비
T-001 workspace
T-020 core types
T-022 manifest
T-023 piece manager
T-024 integrity
T-026 memory storage
T-027 OPFS storage
T-040 signaling client
T-050 signaling server
T-051 room manager
T-052 SDP ICE relay
T-041 peer connection
T-042 data channel
T-043 backpressure
T-060 create session
T-061 join session
T-062 piece transfer
T-063 resume
T-070 sender page
T-071 receiver page
T-072 debug panel
T-083 README
T-086 시연 영상
```

---

## 3. 대회 제출 전 체크리스트

```text
[ ] GitHub repository public
[ ] LICENSE 추가
[ ] README 작성
[ ] local demo 실행 방법 작성
[ ] architecture 문서 작성
[ ] protocol 문서 작성
[ ] 500MB 전송 성공
[ ] 새로고침 resume 성공
[ ] hash 검증 성공
[ ] 테스트 결과 정리
[ ] 개발보고서 작성
[ ] 3분 시연 영상 제작
[ ] 의존성 license 확인
```
