# PonsWarp 기존 코드 감사 및 Grid Engine 추출 계획서

문서 버전: v0.1  
작성일: 2026-06-30  
대상: 기존 PonsWarp repository  
목표 산출물: 추출 대상, 리팩터링 대상, 폐기 대상, 신규 작성 대상 확정

---

## 1. 문서 목적

이 문서는 기존 PonsWarp 코드베이스에서 **PonsWarp Grid Engine**으로 분리할 수 있는 기능을 식별하고, 어떤 코드를 재사용, 리팩터링, 폐기, 신규 작성할지 결정하기 위한 감사 계획서다.

핵심 질문은 네 가지다.

1. 기존 코드에서 바로 재사용할 수 있는 것은 무엇인가?
2. UI와 결합되어 있어 분리해야 하는 것은 무엇인가?
3. Grid Engine 구조에 맞지 않아 버릴 것은 무엇인가?
4. 기존에 없어서 새로 만들어야 하는 것은 무엇인가?

---

## 2. 코드 감사 원칙

### 2.1 UI와 Engine을 분리한다

Grid Engine의 core는 React, Next.js, DOM UI 상태를 몰라야 한다.

나쁜 예:

```ts
setProgress(percent)
setPeers([...peers])
showToast('transfer completed')
```

좋은 예:

```ts
engine.emit('transfer:progress', progress)
engine.emit('peer:connected', peer)
engine.emit('transfer:completed', result)
```

---

### 2.2 Core는 Transport를 몰라야 한다

Core는 WebRTC에 직접 의존하지 않는다. Core는 추상화된 transport interface만 사용한다.

```ts
interface Transport {
  send(peerId: PeerId, message: TransportMessage): Promise<void>
  onMessage(handler: MessageHandler): void
  close(peerId?: PeerId): Promise<void>
}
```

이렇게 해야 나중에 WebRTC 외에도 local test transport, WebSocket transport, Node CLI transport를 붙일 수 있다.

---

### 2.3 기존 코드는 복사보다 추출을 우선한다

기존 코드에서 기능은 가져오되, 구조는 새로 잡는다.

```text
기존 코드 그대로 복붙 → 앱의 임시 구조가 엔진으로 흘러들어올 위험
기능 단위로 추출 → 재사용 가능한 엔진으로 정리 가능
```

---

## 3. 감사 대상 영역

아래 영역을 기존 PonsWarp repository에서 찾는다.

| 영역 | 찾을 키워드 | 목표 |
|---|---|---|
| WebRTC 연결 | `RTCPeerConnection`, `RTCDataChannel`, `createOffer`, `createAnswer` | transport로 추출 |
| Signaling | `WebSocket`, `socket`, `offer`, `answer`, `candidate`, `room` | signaling client/server로 분리 |
| 파일 분할 | `slice`, `chunk`, `Blob`, `ArrayBuffer`, `FileReader` | manifest/piece module로 재구성 |
| 전송 상태 | `progress`, `sentBytes`, `receivedBytes`, `ack` | PieceManager로 이전 |
| 수신 저장 | `download`, `Blob`, `URL.createObjectURL` | StorageAdapter와 FileAssembler로 분리 |
| room/session | `roomId`, `sessionId`, `join`, `createRoom` | Session model로 정리 |
| UI 결합 | `useState`, `useEffect`, `setState`, `toast` | core에서 제거 |
| 임시 테스트 코드 | `console.log`, `TODO`, `mock`, `debug` | 문서화 후 삭제 또는 demo로 이동 |

---

## 4. 감사 실행 체크리스트

### 4.1 Repository 구조 파악

아래 정보를 채운다.

| 항목 | 실제 값 |
|---|---|
| repository 이름 | TODO |
| framework | TODO |
| package manager | TODO |
| 주요 app 경로 | TODO |
| WebRTC 관련 파일 | TODO |
| signaling 관련 파일 | TODO |
| 파일 전송 관련 파일 | TODO |
| 배포 환경 | TODO |

---

### 4.2 검색 명령 예시

```bash
grep -R "RTCPeerConnection" -n .
grep -R "RTCDataChannel" -n .
grep -R "createOffer" -n .
grep -R "createAnswer" -n .
grep -R "icecandidate" -n .
grep -R "WebSocket" -n .
grep -R "chunk" -n .
grep -R "slice(" -n .
grep -R "FileReader" -n .
grep -R "progress" -n .
grep -R "room" -n .
grep -R "session" -n .
```

---

## 5. 재사용 후보

실제 코드 확인 후 아래 표를 업데이트한다.

| 기존 기능 | 현재 위치 | 재사용 방식 | 목표 패키지 | 상태 |
|---|---|---|---|---|
| WebRTC peer connection 생성 | `PonsWarp/src/services/singlePeerConnection.ts` | evented wrapper 구조, binary normalization, drain 이벤트 설계를 추출하되 `simple-peer` 결합은 제거 | `packages/webrtc` | 확인됨 |
| DataChannel open/send/onmessage | `PonsWarp/src/services/singlePeerConnection.ts`, `PonsWarp/src/utils/transferFlowControl.ts` | high/low watermark와 `bufferedamountlow` 대기 규칙을 Grid 전송 wrapper로 재구성 | `packages/webrtc` | 확인됨 |
| WebSocket signaling client | `PonsWarp/src/services/signaling-adapter.ts`, `PonsWarp/src/services/signaling.ts` | reconnect/send guard 교훈만 재사용하고 메시지명은 `04-protocol-spec.md`의 Grid protocol로 재정의 | `packages/webrtc` / `packages/signaling` | 확인됨 |
| room create/join | `ponswarp-signaling-rs/src/handlers/room.rs`, `PonsWarp/src/services/signaling-adapter.ts` | room lifecycle을 session create/join/expire DTO로 재작성 | `packages/signaling` | 확인됨 |
| 파일 slice 전송 | `PonsWarp/src/workers/file-sender.worker.ts`, `PonsWarp/src/services/cloudShareService.ts`, `PonsWarp/src/services/directFileWriter.ts` | byte chunk 전송 개념은 보존하되 Grid는 manifest piece 단위로 slice/hash/storage 경계를 재정의 | `packages/core` | 확인됨 |
| progress 계산 | `PonsWarp/src/utils/transferProgress.ts`, `PonsWarp/src/store/transferStore.ts` | UI와 store 의존성을 제거하고 순수 progress math 및 engine event로 이동 | `packages/core` | 확인됨 |
| demo UI | `PonsWarp/src/components/SenderView.tsx`, `PonsWarp/src/components/ReceiverView.tsx` | 화면 컨셉만 참고하고 엔진 public API를 소비하는 새 demo로 재작성 | `apps/demo` | 확인됨 |

---

## 6. 리팩터링 대상

| 대상 | 문제 | 개선 방향 |
|---|---|---|
| React state에 묶인 전송 상태 | core에서 재사용 불가 | PieceManager와 EventBus로 분리 |
| 파일 전체를 Blob으로 조립 | 대용량에서 메모리 위험 | OPFS 기반 piece 저장 후 조립 |
| room 중심 모델 | grid 확장에 약함 | session, file, peer, piece 모델로 재정의 |
| 단순 progress bar | 엔진 상태 노출 부족 | piece map, peer state, retry count 제공 |
| 임시 peer id | resume과 peer tracking에 약함 | session scoped peer id 발급 |

---

## 7. 폐기 후보

아래 코드는 발견 시 신규 엔진으로 가져오지 않는다.

| 코드 유형 | 폐기 이유 | 대체 방식 |
|---|---|---|
| UI toast 직접 호출 | core 오염 | event로 전달 |
| DOM 직접 조작 | 라이브러리 재사용성 저하 | app layer에서 처리 |
| 하드코딩된 signaling URL | 배포 환경 전환 어려움 | config로 주입 |
| 파일 전체 메모리 적재 | 대용량 전송 위험 | stream/piece 저장 |
| 단일 sender 가정 로직 | grid 확장 불가 | peer availability 기반 scheduler |
| 테스트용 console spam | 유지보수 저하 | logger abstraction |

---

## 8. 신규 작성 대상

기존 PonsWarp에서 부족할 가능성이 높은 영역이다.

| 신규 모듈 | 패키지 | 설명 | 우선순위 |
|---|---|---|---|
| ManifestGenerator | `core` | 파일 메타데이터, piece 목록, hash 생성 | P0 |
| PieceManager | `core` | piece 상태 관리와 progress 계산 | P0 |
| IntegrityChecker | `core` | SHA-256 piece/file 검증 | P0 |
| StorageAdapter | `core` | OPFS, IndexedDB, Memory 추상화 | P0 |
| ResumeManager | `core` | session state 복원과 missing piece 계산 | P0 |
| Scheduler | `core` | piece 요청 순서 결정 | P0 |
| PeerRegistry | `core` | peer 상태와 piece map 관리 | P1 |
| WebRTCTransport | `webrtc` | DataChannel 추상화 | P0 |
| SignalingServer | `signaling` | room/session 중계 | P0 |
| ProtocolCodec | `core` 또는 `webrtc` | 메시지 serialize/deserialize | P0 |

---

## 9. 추출 후 목표 구조

```text
ponswarp-grid
  packages
    core
      src
        manifest
        piece-manager
        storage
        integrity
        scheduler
        events
        types
    webrtc
      src
        peer-connection
        data-channel
        signaling-client
        transport
    signaling
      src
        server
        room-manager
        peer-registry
    react
      src
        usePonsWarp.ts
  apps
    demo
  docs
```

---

## 10. 단계별 추출 계획

### Phase 0. 코드 지도 만들기

완료 조건:

- WebRTC 관련 파일 목록 확보
- signaling 관련 파일 목록 확보
- file/chunk 관련 파일 목록 확보
- UI 의존성 있는 코드 표시
- 삭제 후보 표시

산출물:

```text
code-map.md
```

---

### Phase 1. Core 모델 정의

작업:

- `FileManifest` 타입 정의
- `PieceDescriptor` 타입 정의
- `PieceStatus` 타입 정의
- `TransferSession` 타입 정의
- `PeerState` 타입 정의

완료 조건:

- WebRTC 없이도 manifest 생성과 piece 상태 관리 테스트 가능

---

### Phase 2. 기존 file/chunk 로직 이식

작업:

- 기존 file slice 로직 확인
- `ManifestGenerator`로 재작성
- chunk와 piece 개념 분리
- Web Worker 도입 여부 검토

완료 조건:

- 100MB 이상 파일을 piece manifest로 변환 가능

---

### Phase 3. 기존 WebRTC 로직 이식

작업:

- peer connection wrapper 작성
- data channel wrapper 작성
- signaling client 작성
- 기존 signaling flow와 호환 여부 확인

완료 조건:

- core와 무관하게 transport 단독 연결 테스트 가능

---

### Phase 4. Storage와 Resume 추가

작업:

- OPFS adapter 작성
- IndexedDB fallback 여부 결정
- manifest 저장
- piece map 저장
- resume flow 구현

완료 조건:

- 수신 중 새로고침 후 기존 piece 복원 가능

---

### Phase 5. Demo app 재구성

작업:

- sender page
- receiver page
- debug panel
- progress panel
- resume demo button

완료 조건:

- README만 보고 local demo 실행 가능

---

## 11. 실제 감사 결과 기록 템플릿

```md
# PonsWarp Code Audit Result

## Repository
- URL: `/home/declan/Documents/Develop/Project/ponswarp`
- Branch: local working copy
- Commit: not recorded in this workspace snapshot
- Audit date: 2026-07-01

## Found modules

### WebRTC
- File: `PonsWarp/src/services/singlePeerConnection.ts`
- Functions/classes: `SinglePeerConnection`, `send`, `signal`, `getBufferedAmount`, `destroy`, channel `bufferedamountlow` handling
- Reuse decision: refactor into package-local WebRTC/DataChannel wrappers; preserve event-driven lifecycle and binary normalization, remove old app logging/UI assumptions and avoid exposing unsafe immediate sends as the default API.

### Signaling
- File: `PonsWarp/src/services/signaling-adapter.ts`, `PonsWarp/src/services/signaling.ts`, `ponswarp-signaling-rs/src/handlers/room.rs`
- Functions/classes: WebSocket connect/reconnect/send guard, room create/join/leave handlers, SDP/ICE relay names
- Reuse decision: reuse lifecycle lessons only; implement `ponswarp-grid/signaling` envelopes, runtime decode validation, and immutable room snapshots according to `04-protocol-spec.md`.

### File transfer
- File: `PonsWarp/src/workers/file-sender.worker.ts`, `PonsWarp/src/services/directFileWriter.ts`, `PonsWarp/src/services/reorderingBuffer.ts`, `PonsWarp/src/utils/transferProgress.ts`, `PonsWarp/src/utils/transferFlowControl.ts`
- Functions/classes: file chunk production, reordering buffer, progress math, conservative flow-control helpers
- Reuse decision: reuse progress and flow-control math directly where UI-free; rework chunk sender/receiver around Grid `PieceDescriptor`, storage adapters, and piece hash verification.

### UI coupling
- File: `PonsWarp/src/components/SenderView.tsx`, `PonsWarp/src/components/ReceiverView.tsx`, `PonsWarp/src/services/swarmManager.ts`, `PonsWarp/src/services/webRTCService.ts`
- Issue: transfer orchestration is coupled to React state, room-centric UI state, queue text, and legacy worker payloads.
- Refactor plan: keep orchestration concepts as design input only; Grid engine owns events/session/piece state, React/demo packages consume public APIs and never import private internals.

## Extraction decision

| Existing path | Target package | Action | Notes |
|---|---|---|---|
| `PonsWarp/src/utils/transferProgress.ts` | `packages/core` | reuse | Pure functions moved into core-style API and covered by bootstrap tests. |
| `PonsWarp/src/utils/transferFlowControl.ts` | `packages/webrtc` | reuse/refactor | Preserve conservative queue gating and align public defaults with protocol watermarks. |
| `PonsWarp/src/services/singlePeerConnection.ts` | `packages/webrtc` | refactor | Keep channel lifecycle concepts; remove direct app logging and old `simple-peer` public contract. |
| `PonsWarp/src/services/signaling-adapter.ts` | `packages/signaling` / `packages/webrtc` | refactor | Keep reconnect/send-guard lessons; replace legacy message names with Grid protocol envelopes. |
| `ponswarp-signaling-rs/src/handlers/room.rs` | `packages/signaling` | refactor | Keep room lifecycle semantics; TypeScript package returns immutable session snapshots. |
| `PonsWarp/src/services/swarmManager.ts` | `packages/core` / `packages/webrtc` | mine concepts | Too UI/room/worker coupled to copy; use only scheduler and retry concepts later. |
| `PonsWarp/src/services/directFileWriter.ts` | `packages/core` | mine concepts | Use ordering/progress lessons; reimplement piece storage and resume boundaries. |
```

---

## 12. 코드 추출 완료 기준

아래 조건을 모두 만족하면 기존 PonsWarp에서 Grid Engine 추출 1차 완료로 본다.

1. `packages/core`가 React와 WebRTC에 의존하지 않는다.
2. `packages/webrtc`가 UI에 의존하지 않는다.
3. 기존 PonsWarp의 전송 흐름이 demo app에서 재현된다.
4. 500MB 파일 전송이 가능하다.
5. 수신 중 새로고침 후 resume이 가능하다.
6. 기존 UI 코드 없이 core 단위 테스트가 통과한다.
7. README에 기존 PonsWarp에서 어떤 부분을 계승했는지 설명되어 있다.
