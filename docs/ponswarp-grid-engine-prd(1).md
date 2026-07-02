# PonsWarp Grid Engine PRD

## WebRTC 기반 오픈소스 P2P 대용량 데이터 전송 엔진

문서 버전: v0.1  
작성일: 2026-06-30  
프로젝트명: PonsWarp Grid  
분류: 자유과제 클라우드  
사회문제해결 분야: 생활 또는 교육

---

## 1. 문서 목적

이 PRD는 기존 **PonsWarp**의 대용량 파일 전송 기능을 확장하여, 브라우저 환경에서 동작하는 **P2P 데이터 그리드 엔진**으로 발전시키기 위한 제품 요구사항을 정의한다.

기존 PonsWarp가 “한 사용자가 파일을 보내고 다른 사용자가 받는 전송 기능”에 가까웠다면, PonsWarp Grid Engine은 이를 다음 단계로 확장한다.

> 여러 브라우저 피어가 파일 조각을 나누어 보유하고, 서로 교환하며, 끊김 이후에도 이어받을 수 있는 오픈소스 데이터 전송 엔진

---

## 2. 프로젝트 한 줄 설명

**PonsWarp Grid Engine은 WebRTC DataChannel을 기반으로 브라우저 간 대용량 파일을 chunk 단위로 안전하게 전송하고, 재전송, 이어받기, 무결성 검증, 다중 피어 분산 전송을 지원하는 오픈소스 P2P 데이터 그리드 엔진이다.**

---

## 3. 배경

대용량 파일 공유는 여전히 불편하다.

영상 파일, 연구 데이터, 디자인 에셋, 교육 자료, 백업 파일을 공유하려면 보통 다음 과정을 거친다.

1. 클라우드 서버에 업로드한다.
2. 링크를 공유한다.
3. 수신자가 다시 다운로드한다.
4. 업로드 용량, 다운로드 속도, 보관 기간, 비용, 개인정보 노출 문제를 감수한다.

이 방식은 단순하지만 비효율적이다. 특히 파일을 잠깐 전달하기 위해 서버에 원본 전체를 맡겨야 하는 구조는 불필요한 비용과 개인정보 부담을 만든다.

PonsWarp는 이 문제를 WebRTC 기반 P2P 전송으로 해결하려는 실험에서 출발했다. 이제 이 기능을 독립적인 엔진으로 분리하여, PonsLink뿐 아니라 다른 서비스에서도 사용할 수 있는 재사용 가능한 오픈소스 모듈로 발전시킨다.

---

## 4. 핵심 목표

### 4.1 제품 목표

| 목표 | 설명 |
|---|---|
| 서버 의존도 감소 | 원본 파일 전체를 서버에 저장하지 않고 브라우저 간 직접 전송한다. |
| 대용량 파일 안정 전송 | 파일을 piece 단위로 나누어 전송하고 실패 시 재전송한다. |
| 이어받기 지원 | 네트워크 끊김, 새로고침, 브라우저 재접속 이후에도 중단 지점부터 복구한다. |
| 다중 피어 확장 | 여러 수신자가 같은 파일을 받을 때 piece를 서로 교환할 수 있는 구조를 만든다. |
| 오픈소스 재사용성 | 특정 서비스에 종속되지 않고 라이브러리와 서버 패키지 형태로 공개한다. |
| 브라우저 우선 | 별도 앱 설치 없이 최신 브라우저에서 동작한다. |

---

## 5. 비목표

MVP에서 하지 않을 것을 명확히 자른다.

| 비목표 | 제외 이유 |
|---|---|
| 완전한 BitTorrent 대체 | MVP 범위를 초과한다. |
| 영구 분산 스토리지 | PonsWarp Grid v1은 전송 엔진이지 저장 네트워크가 아니다. |
| 블록체인 기반 보상 시스템 | 핵심 문제 해결과 직접 관련이 적다. |
| 계정 기반 SaaS | 대회 출품은 오픈소스 엔진 중심으로 간다. |
| 모바일 백그라운드 전송 | 브라우저 제약이 커서 v1에서 제외한다. |
| TB급 파일 완전 보장 | 구조는 고려하되 MVP 검증은 GB 단위로 한다. |
| E2E 그룹 권한 관리 | v1은 링크 기반 세션과 기본 암호화 구조까지만 다룬다. |

---

## 6. 기존 PonsWarp에서 Grid Engine으로 바뀌는 점

### 6.1 기존 PonsWarp

기존 PonsWarp의 중심은 다음에 가까웠다.

> 송신자 1명이 파일을 선택하고, 수신자 1명 또는 여러 명에게 직접 전송한다.

구조는 대략 이렇다.

```text
Sender Browser
  └─ File
      └─ Chunk
          └─ WebRTC DataChannel
              └─ Receiver Browser
```

이 구조도 충분히 가치 있지만, 송신자가 모든 수신자에게 계속 데이터를 보내야 한다. 수신자가 많아지면 송신자의 업로드 대역폭이 병목이 된다.

### 6.2 PonsWarp Grid Engine

Grid Engine에서는 전송 단위를 “파일 전체”가 아니라 **piece ownership**으로 본다.

```text
File
  └─ Piece 0
  └─ Piece 1
  └─ Piece 2
  └─ Piece 3
  └─ ...
```

각 피어는 자신이 가진 piece 목록을 알고 있다.

```text
Peer A: 0, 1, 2, 3 보유
Peer B: 0, 1 보유
Peer C: 2, 3 보유
Peer D: 없음
```

이제 D는 반드시 A에게만 받을 필요가 없다.

```text
D는 B에게 0, 1을 받고
D는 C에게 2, 3을 받고
부족한 piece는 A에게 받는다
```

즉 PonsWarp는 이렇게 진화한다.

```text
기존 PonsWarp
송신자 중심 파일 전송

PonsWarp Grid
피어 중심 piece 교환 엔진
```

---

## 7. 핵심 개념 정의

### 7.1 Session

파일 전송을 위한 하나의 공유 공간이다.

예:

```text
sessionId: warp_abc123
```

하나의 session 안에는 하나 이상의 파일, 여러 peer, 전송 상태, manifest가 존재한다.

### 7.2 Peer

전송에 참여하는 브라우저 클라이언트다.

Peer는 다음 역할 중 하나를 가질 수 있다.

| 역할 | 설명 |
|---|---|
| Owner | 최초 파일을 가진 사용자 |
| Receiver | 파일을 받는 사용자 |
| Relay Peer | 일부 piece를 받아 다른 peer에게 다시 전달하는 사용자 |
| Coordinator | signaling server. 파일은 저장하지 않고 연결 정보만 중계 |

MVP에서는 Owner와 Receiver 중심으로 시작하되, 내부 데이터 구조는 Relay Peer를 고려해 설계한다.

### 7.3 Manifest

전송 대상 파일의 설계도다.

예:

```json
{
  "version": "1.0",
  "sessionId": "warp_abc123",
  "fileId": "file_001",
  "name": "lecture-video.mp4",
  "size": 2147483648,
  "mimeType": "video/mp4",
  "pieceSize": 1048576,
  "pieceCount": 2048,
  "fileHash": "sha256...",
  "pieces": [
    {
      "index": 0,
      "offset": 0,
      "size": 1048576,
      "hash": "sha256..."
    }
  ]
}
```

Manifest는 Grid Engine의 심장이다. 파일을 “하나의 큰 덩어리”가 아니라 “검증 가능한 작은 조각들의 지도”로 바꾼다.

### 7.4 Piece

전송, 저장, 재전송, 검증의 기본 단위다.

MVP 추천 크기:

```text
1MB 또는 4MB
```

브라우저 메모리와 전송 효율을 고려하면 처음에는 1MB가 안전하다. 추후 네트워크 상태에 따라 adaptive piece size를 도입할 수 있다.

### 7.5 Chunk와 Piece 구분

| 용어 | 의미 |
|---|---|
| Piece | 파일을 논리적으로 나눈 검증 단위 |
| Chunk | 네트워크로 실제 전송되는 더 작은 데이터 프레임 |
| Block | 내부 구현에서 chunk와 같은 의미로 쓸 수 있지만 v1 문서에서는 쓰지 않음 |

예:

```text
1개 Piece = 1MB
1개 Chunk = 16KB 또는 64KB
```

Piece는 해시 검증 단위이고, Chunk는 DataChannel 전송 단위다.

---

## 8. 사용자 유형

### 8.1 파일 송신자

대용량 파일을 빠르게 공유하고 싶은 사용자.

예:

- 영상 편집자
- 디자이너
- 연구자
- 학생
- 개발자
- 소규모 팀

주요 니즈:

- 서버에 원본을 올리고 싶지 않다.
- 파일을 빠르게 공유하고 싶다.
- 중간에 끊겨도 처음부터 다시 보내고 싶지 않다.

### 8.2 파일 수신자

링크를 받아 파일을 다운로드하는 사용자.

주요 니즈:

- 별도 앱 설치 없이 받고 싶다.
- 다운로드가 끊겨도 이어받고 싶다.
- 받은 파일이 손상되지 않았는지 확인하고 싶다.

### 8.3 개발자

PonsWarp Grid Engine을 자신의 서비스에 붙이고 싶은 사람.

주요 니즈:

- npm 패키지로 설치하고 싶다.
- signaling server를 Docker로 쉽게 띄우고 싶다.
- React, Next.js, Node.js 환경에서 쓰고 싶다.
- API가 단순해야 한다.

### 8.4 대회 심사자

출품작의 기술성, 오픈소스성, 완성도, 사회적 가치를 평가하는 사람.

주요 니즈:

- 실제 동작하는 시연을 보고 싶다.
- 코드 구조가 이해 가능해야 한다.
- 오픈소스 라이선스가 명확해야 한다.
- 기존 파일 공유 방식과의 차별점이 보여야 한다.

---

## 9. 핵심 사용자 시나리오

### 9.1 시나리오 A: 1명이 1명에게 파일 전송

```text
송신자 → 수신자
```

사용 흐름:

1. 송신자가 파일을 선택한다.
2. PonsWarp가 manifest를 생성한다.
3. 송신자가 공유 링크를 생성한다.
4. 수신자가 링크에 접속한다.
5. signaling server를 통해 WebRTC 연결을 만든다.
6. 송신자가 piece를 chunk 단위로 전송한다.
7. 수신자가 piece hash를 검증한다.
8. 전체 file hash를 검증한다.
9. 수신자가 파일을 저장한다.

MVP 필수 시나리오다.

### 9.2 시나리오 B: 1명이 여러 명에게 파일 전송

```text
송신자 → 수신자 A
송신자 → 수신자 B
송신자 → 수신자 C
```

MVP에서는 송신자가 각 수신자에게 직접 전송한다. 단, 내부적으로 각 수신자의 piece map을 관리해 v2에서 수신자 간 교환이 가능하도록 만든다.

### 9.3 시나리오 C: 수신자 간 piece 교환

```text
Owner → A
Owner → B
A → C
B → C
```

v1.5 또는 v2 목표다.

핵심은 다음이다.

1. 각 peer가 자신이 가진 piece map을 broadcast한다.
2. 다운로드 중인 peer는 필요한 piece를 가진 peer 목록을 확인한다.
3. scheduler가 가장 적절한 peer에게 piece를 요청한다.
4. 받은 piece를 검증한 후 local piece map에 반영한다.
5. 다른 peer에게도 해당 piece를 제공할 수 있다.

### 9.4 시나리오 D: 끊김 이후 이어받기

사용 흐름:

1. 수신자가 파일을 다운로드하다가 브라우저를 새로고침한다.
2. 이미 받은 piece는 OPFS 또는 IndexedDB에 남아 있다.
3. 수신자가 같은 session에 다시 접속한다.
4. engine이 local piece map을 복원한다.
5. 없는 piece만 다시 요청한다.
6. 최종 파일을 조립한다.

MVP에서 반드시 보여줘야 하는 시연 포인트다.

---

## 10. 기능 요구사항

### 10.1 MVP 필수 기능

| ID | 기능 | 설명 | 우선순위 |
|---|---|---|---|
| F001 | 파일 선택 | 브라우저에서 파일을 선택한다. | P0 |
| F002 | Manifest 생성 | 파일 크기, piece size, piece hash 정보를 생성한다. | P0 |
| F003 | Session 생성 | 전송 room을 생성하고 링크를 만든다. | P0 |
| F004 | Signaling | WebSocket 기반으로 peer 연결 정보를 교환한다. | P0 |
| F005 | WebRTC 연결 | RTCDataChannel을 생성한다. | P0 |
| F006 | Piece 전송 | 파일을 piece와 chunk 단위로 전송한다. | P0 |
| F007 | ACK 처리 | piece 또는 chunk 수신 확인을 처리한다. | P0 |
| F008 | 재전송 | 누락되거나 실패한 piece를 다시 요청한다. | P0 |
| F009 | Backpressure | DataChannel buffer 상태를 보고 전송 속도를 조절한다. | P0 |
| F010 | Local 저장 | 수신 piece를 브라우저 저장소에 기록한다. | P0 |
| F011 | 이어받기 | 새로고침 또는 재접속 후 기존 piece를 복원한다. | P0 |
| F012 | 해시 검증 | piece hash와 file hash를 검증한다. | P0 |
| F013 | 다운로드 저장 | 검증 완료 후 파일로 저장한다. | P0 |
| F014 | 진행률 표시 | 전체 진행률, 속도, 남은 piece 수를 표시한다. | P0 |
| F015 | 오류 표시 | 연결 실패, 검증 실패, 저장소 부족 등을 표시한다. | P0 |
| F016 | 오픈소스 문서화 | README, architecture, API 사용법을 제공한다. | P0 |

### 10.2 v1.5 기능

| ID | 기능 | 설명 | 우선순위 |
|---|---|---|---|
| F101 | PieceMap 교환 | 각 peer가 보유 piece 목록을 공유한다. | P1 |
| F102 | 다중 peer 다운로드 | 여러 peer에게 필요한 piece를 나누어 요청한다. | P1 |
| F103 | Peer health 점수 | 지연시간, 실패율, 속도 기반으로 peer 품질을 계산한다. | P1 |
| F104 | 중복 요청 방지 | 같은 piece를 여러 peer에게 불필요하게 요청하지 않는다. | P1 |
| F105 | 전송 리포트 | 속도, 재전송 횟수, 실패율을 보여준다. | P1 |

### 10.3 v2 기능

| ID | 기능 | 설명 | 우선순위 |
|---|---|---|---|
| F201 | Rarest first scheduler | 희귀 piece를 우선 요청한다. | P2 |
| F202 | Optional relay storage | 송신자 이탈 대비 일부 piece를 임시 저장한다. | P2 |
| F203 | CLI 전송 | 브라우저 외 Node.js CLI에서 전송한다. | P2 |
| F204 | 암호화된 manifest | 링크를 가진 사람만 manifest를 해석하도록 한다. | P2 |
| F205 | 대역폭 제한 | 송신자와 수신자가 업로드 속도를 제한한다. | P2 |
| F206 | Service Worker 연동 | 장기 다운로드 안정성을 개선한다. | P2 |

---

## 11. 기술 요구사항

### 11.1 전체 구조

```text
packages
  ponswarp-core
    manifest
    piece-manager
    scheduler
    transport
    storage
    integrity
    events

  ponswarp-webrtc
    peer-connection
    data-channel
    signaling-client

  ponswarp-signaling
    websocket server
    room manager
    peer registry

  ponswarp-react
    hooks
    components
    demo UI

apps
  web-demo
  docs
```

### 11.2 아키텍처

```text
Browser A                              Browser B
Owner                                  Receiver

File                                   Empty Storage
 │                                      │
 ▼                                      ▼
Manifest Generator                     Session Join
 │                                      │
Piece Manager                          Piece Manager
 │                                      │
Storage Adapter                        Storage Adapter
 │                                      │
Scheduler                              Scheduler
 │                                      │
WebRTC Transport  ◀──── DataChannel ───▶ WebRTC Transport
 │                                      │
Signaling Client ◀──── WebSocket ─────▶ Signaling Server
```

---

## 12. 엔진 모듈 설계

### 12.1 Manifest Module

역할:

- 파일 메타데이터 생성
- piece 분할
- piece hash 계산
- file hash 계산
- manifest export/import

API 예시:

```ts
const manifest = await createManifest(file, {
  pieceSize: 1024 * 1024
})
```

### 12.2 Piece Manager

역할:

- piece 상태 관리
- 받은 piece 목록 추적
- 누락 piece 계산
- piece 검증 상태 저장
- 다운로드 완료 여부 판단

상태 예시:

```ts
type PieceStatus =
  | 'missing'
  | 'requested'
  | 'receiving'
  | 'received'
  | 'verified'
  | 'failed'
```

### 12.3 Storage Adapter

역할:

- 받은 piece를 브라우저 저장소에 저장
- 새로고침 이후 복원
- 최종 파일 조립

MVP 저장소 우선순위:

1. OPFS
2. IndexedDB fallback
3. Memory fallback

API 예시:

```ts
await storage.writePiece(fileId, pieceIndex, data)
const data = await storage.readPiece(fileId, pieceIndex)
const pieceMap = await storage.loadPieceMap(fileId)
```

### 12.4 Transport Module

역할:

- WebRTC DataChannel 추상화
- binary message 전송
- buffer 상태 감시
- 연결 상태 이벤트 제공

API 예시:

```ts
transport.send(peerId, {
  type: 'PIECE_CHUNK',
  fileId,
  pieceIndex,
  chunkIndex,
  payload
})
```

### 12.5 Scheduler

역할:

- 어떤 piece를 누구에게 요청할지 결정
- 중복 요청 방지
- 실패한 piece 재요청
- peer 상태 기반 요청 조정

MVP에서는 단순 scheduler로 시작한다.

```text
missing piece 중 가장 앞의 piece를 owner에게 요청
```

v1.5에서는 다음으로 확장한다.

```text
필요한 piece를 가진 peer 중 가장 빠르고 안정적인 peer에게 요청
```

### 12.6 Integrity Module

역할:

- piece hash 검증
- 전체 file hash 검증
- 검증 실패 시 해당 piece 폐기
- 재요청 이벤트 발생

MVP hash:

```text
SHA-256
```

### 12.7 Event System

엔진 외부에서 UI를 만들기 쉽게 이벤트를 제공한다.

예:

```ts
engine.on('peer:connected', callback)
engine.on('transfer:progress', callback)
engine.on('piece:verified', callback)
engine.on('transfer:completed', callback)
engine.on('transfer:error', callback)
```

---

## 13. 메시지 프로토콜

WebRTC DataChannel에서 오가는 메시지를 명확히 정의한다.

### 13.1 Control Message

JSON 기반.

```ts
type ControlMessage =
  | HelloMessage
  | ManifestMessage
  | PieceMapMessage
  | PieceRequestMessage
  | PieceAckMessage
  | ErrorMessage
```

### 13.2 Binary Message

실제 파일 데이터.

```ts
type BinaryChunkHeader = {
  type: 'PIECE_CHUNK'
  fileId: string
  pieceIndex: number
  chunkIndex: number
  totalChunks: number
}
```

MVP에서는 구현 단순화를 위해 control message와 binary payload를 분리한다.

### 13.3 주요 메시지

#### HELLO

```json
{
  "type": "HELLO",
  "peerId": "peer_a",
  "role": "receiver",
  "protocolVersion": "1.0.0"
}
```

#### MANIFEST

```json
{
  "type": "MANIFEST",
  "manifest": {}
}
```

#### PIECE_MAP

```json
{
  "type": "PIECE_MAP",
  "fileId": "file_001",
  "pieces": [0, 1, 2, 5, 8]
}
```

#### PIECE_REQUEST

```json
{
  "type": "PIECE_REQUEST",
  "fileId": "file_001",
  "pieceIndex": 12,
  "fromOffset": 0
}
```

#### PIECE_ACK

```json
{
  "type": "PIECE_ACK",
  "fileId": "file_001",
  "pieceIndex": 12,
  "status": "verified"
}
```

#### PIECE_REJECT

```json
{
  "type": "PIECE_REJECT",
  "fileId": "file_001",
  "pieceIndex": 12,
  "reason": "hash_mismatch"
}
```

---

## 14. API 요구사항

### 14.1 송신자 API

```ts
import { createPonsWarpEngine } from '@ponswarp/core'

const engine = createPonsWarpEngine({
  signalingUrl: 'wss://signal.example.com',
  storage: 'opfs'
})

const session = await engine.createSession({
  files: [file],
  mode: 'grid'
})

console.log(session.shareUrl)
```

### 14.2 수신자 API

```ts
const engine = createPonsWarpEngine({
  signalingUrl: 'wss://signal.example.com',
  storage: 'opfs'
})

await engine.joinSession(sessionId)

engine.on('transfer:progress', progress => {
  console.log(progress.percent)
})

await engine.download(fileId)
```

### 14.3 React Hook

```ts
const {
  createSession,
  joinSession,
  progress,
  peers,
  status,
  error
} = usePonsWarp()
```

---

## 15. UI 요구사항

대회 MVP demo UI는 복잡하면 안 된다. 엔진을 보여주는 실험실 패널처럼 간다.

### 15.1 송신자 화면

필수 요소:

- 파일 선택 버튼
- 파일명, 크기
- piece size
- piece count
- session link
- 연결된 peer 목록
- 업로드 속도
- 전송된 piece 수
- 로그 패널

### 15.2 수신자 화면

필수 요소:

- session join 상태
- 파일명, 크기
- 다운로드 진행률
- 받은 piece 수
- 검증 완료 piece 수
- 현재 연결 peer
- 다운로드 저장 버튼
- 이어받기 상태 표시

### 15.3 디버그 패널

대회 시연에서 중요하다. 눈에 보이는 기술이 설득력을 만든다.

표시 항목:

```text
Peer ID
Connection State
DataChannel State
Buffered Amount
Piece Map
Requested Pieces
Verified Pieces
Retry Count
Average Speed
```

---

## 16. 품질 요구사항

### 16.1 성능

| 항목 | 목표 |
|---|---|
| MVP 테스트 파일 크기 | 100MB, 500MB, 1GB |
| Piece size | 기본 1MB |
| Chunk size | 기본 64KB |
| 재접속 복구 | 5초 이내 local state 복원 |
| Hash 검증 | piece 단위 검증 |
| 메모리 사용량 | 전체 파일을 메모리에 올리지 않음 |

### 16.2 안정성

필수 처리:

- WebRTC 연결 실패
- DataChannel 닫힘
- 수신 중 새로고침
- 저장소 부족
- hash mismatch
- signaling server 연결 끊김
- peer 이탈
- 중복 piece 수신
- 오래된 session 접근

### 16.3 보안

MVP 기준:

- signaling server는 파일 원본을 저장하지 않는다.
- session id는 충분히 예측 불가능해야 한다.
- 파일 데이터는 WebRTC 암호화 채널을 통해 전송된다.
- manifest에 민감한 정보가 과도하게 담기지 않도록 한다.
- 다운로드 전 파일명, 크기, hash를 사용자에게 보여준다.

v2 고려:

- share link에 encryption key 포함
- manifest 암호화
- optional passphrase
- peer allowlist
- session expiration

---

## 17. 오픈소스 요구사항

### 17.1 라이선스

추천:

```text
Apache-2.0
```

이유:

- 기업과 개인 모두 사용하기 쉽다.
- 특허 관련 조항이 MIT보다 명확하다.
- 인프라성 오픈소스 엔진에 잘 맞는다.

### 17.2 Repository 구조

```text
ponswarp-grid
  README.md
  LICENSE
  CONTRIBUTING.md
  CODE_OF_CONDUCT.md
  SECURITY.md
  docs
    architecture.md
    protocol.md
    api.md
    demo-guide.md
  packages
    core
    webrtc
    signaling
    react
  apps
    demo
    docs
  examples
    nextjs
    vite-react
```

### 17.3 문서 필수 항목

| 문서 | 내용 |
|---|---|
| README | 프로젝트 개요, 설치, 빠른 시작 |
| architecture.md | 전체 구조 설명 |
| protocol.md | 메시지 프로토콜 |
| api.md | SDK API |
| demo-guide.md | 시연 방법 |
| security.md | 보안 모델 |
| roadmap.md | v1, v1.5, v2 계획 |

---

## 18. 성공 지표

### 18.1 MVP 성공 기준

MVP는 다음이 가능하면 성공이다.

1. 브라우저 A에서 파일 선택
2. session link 생성
3. 브라우저 B에서 접속
4. WebRTC DataChannel 연결
5. 500MB 이상 파일 전송
6. piece hash 검증
7. 중간 새로고침 후 이어받기
8. 최종 파일 저장
9. GitHub README만 보고 demo 실행 가능
10. Docker로 signaling server 실행 가능

### 18.2 대회 시연 성공 기준

3분 시연에서 다음을 보여준다.

```text
1. PonsWarp Grid 소개
2. 1GB 파일 선택
3. session link 생성
4. 다른 브라우저에서 접속
5. chunk 전송 진행률 표시
6. 수신 브라우저 새로고침
7. 이어받기 복구
8. hash 검증 완료
9. 다운로드 성공
10. 오픈소스 구조와 API 소개
```

---

## 19. MVP 개발 범위

### 19.1 반드시 만들 것

```text
@ponswarp/core
@ponswarp/webrtc
@ponswarp/signaling
demo web app
README
architecture 문서
protocol 문서
```

### 19.2 나중에 만들 것

```text
@ponswarp/react
CLI
R2 fallback
multi peer rarest first scheduler
encrypted manifest
mobile optimization
```

---

## 20. 구현 로드맵

### Phase 1: Core 추출

목표:

기존 PonsWarp 코드에서 파일 분할, hash, 전송 상태 관리를 UI와 분리한다.

작업:

- File chunker 분리
- Manifest generator 구현
- Piece manager 구현
- Event emitter 구현
- 단위 테스트 추가

완료 기준:

```text
브라우저 File 객체를 넣으면 manifest와 piece stream을 생성할 수 있다.
```

### Phase 2: WebRTC Transport 안정화

목표:

DataChannel을 안정적으로 열고 binary chunk를 전송한다.

작업:

- Signaling client 구현
- PeerConnection wrapper 구현
- DataChannel wrapper 구현
- bufferedAmount 기반 backpressure 구현
- reconnect 이벤트 처리

완료 기준:

```text
두 브라우저 간 100MB 파일을 끊김 없이 전송할 수 있다.
```

### Phase 3: Storage와 Resume 구현

목표:

새로고침 이후 이어받기를 가능하게 한다.

작업:

- OPFS storage adapter 구현
- IndexedDB fallback 검토
- piece map 저장
- session state 저장
- resume flow 구현

완료 기준:

```text
다운로드 중 새로고침 후 이미 받은 piece를 유지하고 나머지만 다시 받는다.
```

### Phase 4: Grid 구조 도입

목표:

수신자도 piece provider가 될 수 있도록 내부 구조를 바꾼다.

작업:

- Peer piece map 교환
- Piece availability table 구현
- Peer별 request queue 구현
- 중복 요청 방지
- 다중 peer scheduler 초안 구현

완료 기준:

```text
Receiver A가 받은 piece를 Receiver B에게 전송할 수 있다.
```

### Phase 5: Demo와 문서화

목표:

대회 제출 가능한 상태로 정리한다.

작업:

- Demo UI 구현
- README 작성
- Architecture 문서 작성
- Protocol 문서 작성
- 3분 시연 시나리오 준비
- Docker Compose 작성

완료 기준:

```text
처음 보는 개발자가 README를 보고 10분 안에 로컬 demo를 실행할 수 있다.
```

---

## 21. 주요 기술 결정

### 21.1 OPFS 우선 사용

대용량 파일을 브라우저에서 다루려면 전체 파일을 메모리에 올리면 안 된다.

따라서 수신 piece는 OPFS에 저장한다.

```text
File → Piece → OPFS write → PieceMap update
```

IndexedDB는 fallback으로 둔다.

### 21.2 WebRTC DataChannel 사용

서버 업로드 없이 브라우저 간 직접 전송하려면 WebRTC DataChannel이 가장 적합하다.

DataChannel에서 반드시 다룰 것:

- ordered delivery
- bufferedAmount
- binary payload
- reconnect handling
- channel close handling

### 21.3 Signaling Server는 얇게 유지

signaling server는 다음만 한다.

- session 생성
- peer join
- SDP 교환
- ICE candidate 전달
- peer list 관리

하지 않는 것:

- 원본 파일 저장
- chunk 저장
- 사용자 계정 관리
- 파일 내용 분석

---

## 22. 위험 요소와 대응

| 위험 | 설명 | 대응 |
|---|---|---|
| 브라우저 저장소 제한 | 대용량 파일 저장 중 실패 가능 | OPFS 사용, 저장소 부족 안내 |
| NAT 환경 문제 | WebRTC 직접 연결 실패 가능 | STUN 기본, TURN 옵션 문서화 |
| 대용량 hash 계산 지연 | 파일이 클수록 manifest 생성이 느림 | Web Worker 도입 |
| 모바일 브라우저 제약 | 백그라운드 전송 어려움 | v1은 데스크톱 브라우저 우선 |
| 다중 peer 복잡도 | scheduler 구현 난이도 상승 | MVP는 owner 중심, v1.5에서 확장 |
| DataChannel buffer 폭주 | 메모리 증가 가능 | backpressure 필수 구현 |
| 시연 실패 | 네트워크 환경에 따라 불안정 | 로컬 네트워크 시연 플랜 준비 |

---

## 23. 대회용 포지셔닝

### 23.1 프로젝트 분류

추천 분류:

```text
자유과제 클라우드
사회문제해결 생활
```

### 23.2 심사자에게 전달할 핵심 메시지

> PonsWarp Grid는 클라우드 서버에 원본 파일을 업로드하지 않고도 대용량 파일을 브라우저 간 직접 전송할 수 있게 하는 오픈소스 엔진입니다. 단순 파일 전송 앱이 아니라, chunk 검증, 재전송, 이어받기, 다중 피어 확장이 가능한 브라우저 기반 데이터 그리드 구조를 제공합니다.

### 23.3 차별점

| 기존 방식 | PonsWarp Grid |
|---|---|
| 서버에 파일 전체 업로드 | 브라우저 간 직접 전송 |
| 끊기면 처음부터 재시도 | piece 단위 이어받기 |
| 수신자가 많으면 서버 비용 증가 | peer 간 분산 전송 가능 |
| 서비스 종속 | 오픈소스 엔진으로 재사용 |
| 파일 무결성 확인 어려움 | piece hash와 file hash 검증 |

---

## 24. MVP에서 보여줄 기술 데모

### Demo 1: 기본 P2P 전송

```text
브라우저 A에서 500MB 파일 선택
브라우저 B에서 링크 접속
WebRTC 연결
다운로드 완료
hash 검증
```

### Demo 2: 끊김 이후 이어받기

```text
다운로드 40퍼센트 진행
브라우저 B 새로고침
session 재접속
이미 받은 piece 복원
60퍼센트만 추가 다운로드
완료
```

### Demo 3: Grid 준비 구조

MVP에서 진짜 multi peer가 완성되지 않았더라도, 내부 상태를 보여주면 설득력이 있다.

```text
Peer A piece map
Peer B piece map
Missing pieces
Verified pieces
Requested pieces
```

---

## 25. 우선순위 결론

### v1에서 가장 중요한 것

```text
1. Core와 UI 분리
2. Manifest와 piece hash
3. WebRTC DataChannel 전송
4. OPFS 저장
5. Resume
6. Backpressure
7. Demo UI
8. 문서화
```

### v1에서 욕심내면 안 되는 것

```text
1. 완전한 swarm scheduler
2. 모바일 최적화
3. 클라우드 fallback
4. 계정 시스템
5. 암호화 키 관리 UI
6. 예쁜 디자인
```

---

## 26. 최종 제품 정의

PonsWarp Grid Engine v1은 다음 문장으로 정의한다.

> **PonsWarp Grid Engine v1은 브라우저에서 파일을 piece 단위로 분할하고, WebRTC DataChannel을 통해 P2P로 전송하며, OPFS 기반 로컬 저장과 SHA-256 검증을 통해 끊김 이후에도 이어받을 수 있는 오픈소스 대용량 파일 전송 엔진이다.**

v1.5부터는 다음 문장으로 확장한다.

> **PonsWarp Grid Engine v1.5는 여러 peer가 각자 보유한 piece 정보를 교환하고, 필요한 piece를 서로에게 요청함으로써 송신자 중심 전송을 분산형 데이터 그리드 구조로 확장한다.**

---

## 27. 바로 다음 액션

지금 바로 개발을 시작한다면 순서는 이게 좋다.

```text
1. 기존 PonsWarp 코드에서 UI와 전송 로직 분리
2. packages/core 생성
3. Manifest 타입 정의
4. PieceManager 구현
5. StorageAdapter 인터페이스 정의
6. OPFSStorage 구현
7. WebRTCTransport wrapper 구현
8. Signaling server 최소 구현
9. Demo app 연결
10. Resume 시나리오 완성
```

---

## 28. 첫 번째 구현 티켓 예시

### Ticket 1: Manifest 생성기 구현

설명:

브라우저 File 객체를 입력받아 파일명, 크기, MIME 타입, piece size, piece count, piece hash 목록을 포함한 manifest를 생성한다.

완료 조건:

- 100MB 파일 manifest 생성 가능
- piece size를 옵션으로 지정 가능
- 각 piece의 SHA-256 hash 생성
- 전체 file hash 생성
- manifest JSON export 가능

### Ticket 2: PieceManager 구현

설명:

파일별 piece 상태를 관리하고, 누락 piece, 검증 완료 piece, 요청 중 piece를 추적한다.

완료 조건:

- piece 상태 변경 가능
- missing pieces 조회 가능
- progress 계산 가능
- piece map export/import 가능
- resume 시 기존 상태 복원 가능

### Ticket 3: OPFS Storage Adapter 구현

설명:

수신한 piece를 OPFS에 저장하고, 새로고침 이후 복원할 수 있도록 한다.

완료 조건:

- piece write 가능
- piece read 가능
- piece exists 확인 가능
- piece map 저장 가능
- session state 복원 가능

### Ticket 4: WebRTC Transport 구현

설명:

RTCDataChannel을 통해 control message와 binary chunk를 전송하는 transport layer를 구현한다.

완료 조건:

- peer 연결 가능
- JSON control message 송수신 가능
- binary chunk 송수신 가능
- bufferedAmount 기반 전송 대기 가능
- 연결 종료 이벤트 제공

### Ticket 5: Resume Demo 구현

설명:

다운로드 중 새로고침 후 기존 piece를 복원하고 나머지 piece만 다시 요청하는 demo를 만든다.

완료 조건:

- 다운로드 중 새로고침 가능
- 받은 piece 유지
- 누락 piece만 재요청
- 최종 파일 hash 검증
- UI에서 resume 상태 표시

---

## 29. 요약

이 PRD의 핵심은 **PonsWarp를 제품 기능에서 엔진으로 끌어올리는 것**이다.

즉, 대회에서는 앱을 내는 것이 아니라 **브라우저 P2P 데이터 그리드의 재사용 가능한 기술 부품**을 제출한다.

PonsWarp Grid는 다음 세 가지를 증명해야 한다.

1. 서버에 파일 원본을 맡기지 않고도 대용량 파일을 전송할 수 있다.
2. 파일을 piece 단위로 검증하고, 실패하거나 끊긴 부분만 다시 받을 수 있다.
3. 장기적으로 여러 피어가 서로 piece를 교환하는 데이터 그리드 구조로 확장될 수 있다.
