# PonsWarp Grid Engine SRS

Software Requirements Specification  
문서 버전: v0.1  
작성일: 2026-06-30

---

## 1. 개요

### 1.1 목적

이 문서는 PonsWarp Grid Engine이 제공해야 하는 기능 요구사항과 비기능 요구사항을 정의한다.

PonsWarp Grid Engine은 브라우저에서 파일을 piece 단위로 분할하고, WebRTC DataChannel을 통해 P2P로 전송하며, 로컬 저장소 기반 resume과 SHA-256 검증을 제공하는 오픈소스 대용량 데이터 전송 엔진이다.

---

### 1.2 범위

MVP 범위는 다음이다.

```text
파일 선택
→ manifest 생성
→ session 생성
→ signaling
→ WebRTC 연결
→ piece 전송
→ piece 저장
→ hash 검증
→ resume
→ 최종 파일 저장
```

MVP에서 제외하는 항목:

- 완전한 swarm scheduler
- 영구 분산 스토리지
- 계정 시스템
- 결제 시스템
- 모바일 백그라운드 전송
- 블록체인 보상 구조

---

## 2. 용어 정의

| 용어 | 정의 |
|---|---|
| Session | 하나 이상의 파일 전송이 이루어지는 공유 공간 |
| Peer | session에 참여하는 브라우저 클라이언트 |
| Owner | 최초 파일을 보유한 peer |
| Receiver | 파일을 받는 peer |
| Manifest | 파일과 piece 정보를 담은 메타데이터 |
| Piece | 파일을 논리적으로 나눈 검증 단위 |
| Chunk | 네트워크로 실제 전송되는 작은 binary frame |
| PieceMap | peer가 보유한 piece 목록 |
| Resume | 중단 후 기존 piece를 복원하고 누락 piece만 다시 받는 동작 |
| Signaling | WebRTC 연결을 만들기 위해 SDP와 ICE candidate를 교환하는 과정 |
| Transport | 메시지 송수신 계층 추상화 |

---

## 3. 사용자 역할

| 역할 | 설명 |
|---|---|
| Sender Owner | 파일을 선택하고 session을 생성하는 사용자 |
| Receiver | 공유 링크로 접속해 파일을 받는 사용자 |
| Developer | 엔진을 자신의 앱에 붙이는 개발자 |
| Operator | signaling server를 배포하고 운영하는 사람 |

---

## 4. 기능 요구사항

## F001. 파일 선택

### 설명

사용자는 브라우저에서 하나 이상의 파일을 선택할 수 있어야 한다.

### 입력

- Browser `File` 객체
- 선택 옵션
  - piece size
  - storage type

### 출력

- 선택된 파일 목록
- 파일명
- 크기
- MIME type

### 완료 기준

- 1개 파일 선택 가능
- 100MB 이상 파일 선택 가능
- 파일 선택 취소 시 engine state가 깨지지 않음

### 예외

| 상황 | 동작 |
|---|---|
| 파일 없음 | `file:not_selected` error 발생 |
| 파일 크기 0 | 전송 대상에서 제외하거나 오류 표시 |
| 브라우저 File API 미지원 | 지원 불가 메시지 |

---

## F002. Manifest 생성

### 설명

엔진은 선택된 파일을 piece 단위로 나누고 manifest를 생성해야 한다.

### 입력

- `File`
- `pieceSize`

### 출력

- `FileManifest`

### 데이터 필드

```ts
type FileManifest = {
  version: string
  fileId: string
  name: string
  size: number
  mimeType: string
  pieceSize: number
  pieceCount: number
  fileHash?: string
  pieces: PieceDescriptor[]
}
```

### 완료 기준

- piece count가 정확히 계산됨
- 마지막 piece size가 정확히 계산됨
- 각 piece hash를 생성할 수 있음
- manifest JSON export 가능

### 예외

| 상황 | 동작 |
|---|---|
| hash 계산 실패 | `manifest:hash_failed` error |
| 파일 읽기 실패 | `file:read_failed` error |
| pieceSize가 0 이하 | validation error |

---

## F003. Session 생성

### 설명

Sender는 manifest를 포함한 전송 session을 생성할 수 있어야 한다.

### 입력

- manifest 목록
- sender peer metadata
- session options

### 출력

- `sessionId`
- `shareUrl`
- `ownerPeerId`

### 완료 기준

- sessionId는 예측하기 어려워야 함
- shareUrl은 수신자가 접속 가능한 형식이어야 함
- signaling server에 session이 등록되어야 함

### 예외

| 상황 | 동작 |
|---|---|
| signaling 연결 실패 | `session:create_failed` |
| manifest 누락 | validation error |

---

## F004. Session 참여

### 설명

Receiver는 공유 링크를 통해 session에 참여할 수 있어야 한다.

### 입력

- `sessionId`
- optional resume state

### 출력

- session metadata
- manifest 목록
- peer list

### 완료 기준

- 수신자가 session manifest를 받을 수 있음
- owner와 연결 시도 가능
- 만료된 session 접근 시 오류 처리

---

## F005. Signaling

### 설명

WebRTC 연결을 만들기 위해 signaling server를 통해 SDP offer, answer, ICE candidate를 교환한다.

### 완료 기준

- peer join broadcast
- offer 전달
- answer 전달
- ICE candidate 전달
- peer leave broadcast

### 예외

| 상황 | 동작 |
|---|---|
| WebSocket 연결 종료 | reconnect 시도 또는 오류 |
| unknown session | `session:not_found` |
| unknown peer | `peer:not_found` |

---

## F006. WebRTC DataChannel 연결

### 설명

Peer 간 RTCDataChannel 연결을 만든다.

### 완료 기준

- DataChannel open 이벤트 발생
- binary message 송수신 가능
- JSON control message 송수신 가능
- close/error 이벤트 제공

### 비고

MVP에서는 ordered reliable channel을 기본으로 사용한다.

---

## F007. Piece 전송

### 설명

Owner는 요청받은 piece를 chunk 단위로 나누어 전송한다.

### 입력

- `PieceRequest`
- file handle
- piece descriptor

### 출력

- binary chunk messages
- transfer progress events

### 완료 기준

- piece를 chunk로 나누어 전송
- 수신자가 piece를 재조립 가능
- 중복 chunk 수신 시 안전하게 처리
- chunk 순서가 달라도 piece 조립 가능하도록 설계

---

## F008. ACK 처리

### 설명

Receiver는 piece 수신 및 검증 결과를 sender에게 알려야 한다.

### ACK 종류

| ACK | 의미 |
|---|---|
| `received` | piece binary 수신 완료 |
| `verified` | hash 검증 완료 |
| `rejected` | 검증 실패 또는 손상 |

### 완료 기준

- verified ACK 후 sender는 해당 요청을 완료 처리
- rejected ACK 후 scheduler는 재요청 가능

---

## F009. 재전송

### 설명

누락되거나 검증 실패한 piece는 다시 요청되어야 한다.

### 완료 기준

- hash mismatch piece는 폐기 후 missing 상태로 되돌림
- timeout 발생 시 requested 상태를 missing으로 되돌림
- retry count가 기록됨
- retry limit 초과 시 사용자에게 오류 표시

---

## F010. Backpressure

### 설명

DataChannel의 bufferedAmount가 일정 기준을 넘으면 전송을 잠시 멈춰야 한다.

### 입력

- `RTCDataChannel.bufferedAmount`
- `bufferedAmountLowThreshold`

### 완료 기준

- buffer high watermark 초과 시 send 대기
- buffer low event 발생 후 전송 재개
- 메모리 폭주 방지

---

## F011. 로컬 저장

### 설명

Receiver는 수신한 piece를 브라우저 로컬 저장소에 기록해야 한다.

### 저장소 우선순위

1. OPFS
2. IndexedDB fallback
3. Memory fallback

### 완료 기준

- piece binary 저장 가능
- 저장된 piece 읽기 가능
- piece map 저장 가능
- session state 저장 가능

### 예외

| 상황 | 동작 |
|---|---|
| 저장 공간 부족 | `storage:quota_exceeded` |
| OPFS 미지원 | IndexedDB fallback |
| 저장 실패 | piece를 verified 처리하지 않음 |

---

## F012. Resume

### 설명

수신 중 브라우저 새로고침 또는 재접속 이후, 이미 받은 piece를 복원하고 누락 piece만 다시 받아야 한다.

### 입력

- `sessionId`
- local manifest
- local piece map
- saved piece binaries

### 출력

- resume status
- missing pieces
- verified pieces

### 완료 기준

- 새로고침 후 manifest 복원
- verified piece map 복원
- missing piece만 재요청
- 전체 progress가 복원된 값에서 시작

### 예외

| 상황 | 동작 |
|---|---|
| manifest mismatch | 새 다운로드 여부를 사용자에게 확인 |
| piece binary 손상 | 해당 piece 폐기 후 재요청 |
| session 만료 | local data 삭제 또는 export 안내 |

---

## F013. 무결성 검증

### 설명

각 piece와 최종 파일은 SHA-256으로 검증되어야 한다.

### 완료 기준

- piece hash 검증
- file hash 검증
- mismatch 발생 시 재요청 또는 오류

### 비고

MVP에서는 piece hash 필수, file hash는 가능하면 필수로 구현한다.

---

## F014. 최종 파일 저장

### 설명

모든 piece가 verified 상태가 되면 사용자는 최종 파일을 저장할 수 있어야 한다.

### 완료 기준

- verified piece 순서대로 조립
- 파일명 유지
- MIME type 유지
- 저장 완료 이벤트 발생

---

## F015. 진행률 표시 데이터 제공

### 설명

Engine은 UI가 progress를 표시할 수 있도록 이벤트를 제공해야 한다.

### 이벤트 예시

```ts
type TransferProgress = {
  fileId: string
  totalBytes: number
  receivedBytes: number
  verifiedPieces: number
  totalPieces: number
  percent: number
  speedBps?: number
  retryCount: number
}
```

### 완료 기준

- 전체 진행률 계산 가능
- verified 기준 progress와 received 기준 progress 구분 가능
- UI framework에 독립적

---

## F016. 오류 처리

### 설명

Engine은 주요 오류를 typed error로 제공해야 한다.

### 오류 카테고리

| 카테고리 | 예시 |
|---|---|
| `file` | read failed, invalid file |
| `manifest` | hash failed, invalid manifest |
| `session` | not found, expired |
| `peer` | disconnected, unavailable |
| `transport` | datachannel closed, send failed |
| `storage` | quota exceeded, write failed |
| `integrity` | hash mismatch |
| `resume` | state mismatch |

---

## F017. 개발자 API

### 설명

Engine은 npm package로 사용할 수 있는 API를 제공해야 한다.

### Sender 예시

```ts
const engine = createPonsWarpEngine({ signalingUrl })
const session = await engine.createSession({ files: [file] })
```

### Receiver 예시

```ts
const engine = createPonsWarpEngine({ signalingUrl })
await engine.joinSession(sessionId)
await engine.download(fileId)
```

---

## F018. Demo App

### 설명

대회와 개발 검증을 위한 demo app을 제공해야 한다.

### 필수 화면

- Sender page
- Receiver page
- Debug panel
- Progress panel
- Resume status panel

---

## 5. 비기능 요구사항

## NFR001. 성능

| 항목 | 목표 |
|---|---|
| MVP 검증 파일 크기 | 100MB, 500MB, 1GB |
| 기본 piece size | 1MB |
| 기본 chunk size | 64KB |
| 전체 파일 메모리 적재 | 금지 |
| resume state 복원 | 5초 이내 목표 |

---

## NFR002. 호환성

우선 지원:

- Chrome 최신 버전
- Edge 최신 버전
- Firefox 최신 버전은 best effort

후순위:

- Safari
- Mobile browser

---

## NFR003. 보안

- signaling server는 원본 파일을 저장하지 않는다.
- sessionId는 예측하기 어렵게 생성한다.
- 파일 데이터는 WebRTC DataChannel을 통해 전송한다.
- 사용자는 다운로드 전 파일명, 크기, hash 정보를 확인할 수 있어야 한다.
- manifest에는 불필요한 개인정보를 포함하지 않는다.

---

## NFR004. 오픈소스성

- 라이선스는 Apache-2.0을 권장한다.
- README만 보고 local demo 실행 가능해야 한다.
- protocol 문서를 공개한다.
- 핵심 모듈은 UI framework 독립적으로 설계한다.

---

## 6. 상태 모델

### 6.1 Transfer 상태

```text
idle
→ preparing
→ signaling
→ connecting
→ transferring
→ paused
→ resuming
→ verifying
→ completed
→ failed
```

### 6.2 Piece 상태

```text
missing
→ requested
→ receiving
→ received
→ verified

failed → missing
rejected → missing
```

---

## 7. MVP 완료 기준

MVP는 아래 조건을 만족해야 한다.

1. Sender가 500MB 이상 파일을 선택하고 session link를 생성할 수 있다.
2. Receiver가 link로 접속해 WebRTC로 연결된다.
3. 파일이 piece/chunk 단위로 전송된다.
4. Receiver가 piece를 로컬 저장소에 저장한다.
5. 다운로드 중 새로고침 후 resume이 가능하다.
6. piece hash 검증이 가능하다.
7. 최종 파일 저장이 가능하다.
8. demo app에서 debug panel로 piece 상태를 확인할 수 있다.
9. README를 통해 local 실행이 가능하다.

---

## 8. 추적성 매트릭스

| PRD 목표 | SRS 요구사항 |
|---|---|
| 서버 의존도 감소 | F003, F005, F006 |
| 대용량 안정 전송 | F002, F007, F008, F009, F010 |
| 이어받기 | F011, F012 |
| 무결성 검증 | F013 |
| 오픈소스 재사용성 | F017, NFR004 |
| 대회 시연성 | F018, MVP 완료 기준 |
