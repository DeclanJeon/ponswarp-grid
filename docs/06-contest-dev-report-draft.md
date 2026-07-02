# PonsWarp Grid Engine 대회 개발보고서 초안

문서 버전: v0.1  
작성일: 2026-06-30  
용도: 오픈소스 개발자대회 제출용 개발보고서 작성 기반

---

## 1. 프로젝트명

PonsWarp Grid

---

## 2. 한 줄 소개

PonsWarp Grid는 브라우저에서 대용량 파일을 piece 단위로 나누고, WebRTC 기반 P2P 전송과 로컬 저장소 기반 이어받기를 제공하는 오픈소스 데이터 전송 엔진이다.

---

## 3. 개발 배경

대용량 파일 공유는 영상 창작자, 학생, 연구자, 개발자, 소규모 팀에게 자주 발생하는 문제다. 기존 방식은 파일을 클라우드 서버에 먼저 업로드한 뒤, 수신자가 다시 다운로드하는 구조가 일반적이다. 이 방식은 사용하기 쉽지만 다음과 같은 한계가 있다.

1. 파일 전체를 서버에 맡겨야 하므로 개인정보와 민감 자료 노출 부담이 있다.
2. 업로드와 다운로드가 분리되어 전송 시간이 늘어난다.
3. 대용량 파일일수록 저장 비용과 트래픽 비용이 증가한다.
4. 네트워크가 끊기면 처음부터 다시 전송해야 하는 경우가 많다.
5. 여러 수신자가 같은 파일을 받을 때 송신자 또는 서버에 병목이 생긴다.

PonsWarp Grid는 이러한 문제를 해결하기 위해 브라우저 간 직접 연결이 가능한 WebRTC DataChannel을 활용한다. 또한 파일을 piece 단위로 나누어 전송하고, 각 piece를 검증 및 저장함으로써 중단 이후에도 이어받을 수 있는 구조를 제공한다.

---

## 4. 개발 목적

본 프로젝트의 목적은 서버에 원본 파일을 저장하지 않고도 대용량 파일을 안정적으로 전송할 수 있는 오픈소스 엔진을 만드는 것이다.

구체적인 목표는 다음과 같다.

| 목표 | 설명 |
|---|---|
| 서버 의존도 감소 | 원본 파일 전체를 서버에 저장하지 않고 브라우저 간 직접 전송 |
| 대용량 안정 전송 | 파일을 piece와 chunk 단위로 나누어 전송 |
| 이어받기 지원 | 새로고침 또는 네트워크 중단 후 누락 piece만 재요청 |
| 무결성 검증 | SHA-256 기반 piece/file hash 검증 |
| 오픈소스 재사용성 | 특정 서비스가 아닌 엔진 형태로 공개 |
| Grid 확장성 | 여러 peer가 piece를 서로 교환할 수 있는 구조 준비 |

---

## 5. 프로젝트 범위

## 5.1 MVP 범위

- 파일 선택 및 manifest 생성
- WebSocket 기반 signaling
- WebRTC DataChannel 연결
- piece/chunk 단위 파일 전송
- ACK와 재전송
- DataChannel backpressure
- OPFS 또는 IndexedDB 기반 piece 저장
- 새로고침 이후 resume
- SHA-256 무결성 검증
- demo web app
- 오픈소스 문서화

## 5.2 향후 확장 범위

- 다중 peer piece 교환
- rarest-first scheduler
- optional relay storage
- encrypted manifest
- CLI 전송 도구
- React/Vue/Svelte adapter

---

## 6. 주요 기능

## 6.1 Manifest 생성

파일을 고정 크기 piece로 나누고, 각 piece의 offset, size, hash를 기록한다. Manifest는 전송과 resume의 기준점이 된다.

## 6.2 WebRTC P2P 전송

Signaling server를 통해 peer 간 연결 정보를 교환한 뒤, WebRTC DataChannel을 이용해 파일 데이터를 직접 전송한다. Signaling server는 파일 원본을 저장하지 않는다.

## 6.3 Piece 단위 저장과 검증

수신한 piece는 로컬 저장소에 저장되며, SHA-256 hash로 검증된 piece만 완료 상태로 처리한다.

## 6.4 Resume

수신자가 다운로드 중 새로고침하거나 일시적으로 연결이 끊겨도, 이미 받은 piece를 복원하고 나머지 piece만 다시 요청한다.

## 6.5 Debug Panel

시연과 개발 검증을 위해 peer 상태, DataChannel 상태, piece map, retry count, transfer speed를 화면에서 확인할 수 있도록 한다.

---

## 7. 시스템 아키텍처

```text
Browser Sender
  ├─ File Source
  ├─ Manifest Generator
  ├─ Piece Manager
  ├─ WebRTC Transport
  └─ Signaling Client

Signaling Server
  ├─ Session Manager
  ├─ Peer Registry
  └─ SDP/ICE Relay

Browser Receiver
  ├─ WebRTC Transport
  ├─ Piece Manager
  ├─ Storage Adapter
  ├─ Integrity Checker
  └─ File Assembler
```

---

## 8. 기술 스택

| 영역 | 기술 |
|---|---|
| Language | TypeScript |
| Frontend Demo | React 또는 Next.js |
| P2P Transport | WebRTC DataChannel |
| Signaling | WebSocket |
| Browser Storage | OPFS, IndexedDB fallback |
| Hash | Web Crypto API SHA-256 |
| Package 구조 | pnpm workspace 기반 monorepo |
| Test | Vitest, Playwright |
| License | Apache-2.0 권장 |

---

## 9. 기존 PonsWarp와의 관계

기존 PonsWarp는 대용량 파일 전송 기능을 실험하고 구현한 출발점이다. PonsWarp Grid는 이 기능을 서비스 UI에서 분리하여, 다른 개발자도 재사용할 수 있는 엔진으로 발전시킨다.

추출 대상:

- WebRTC 연결 흐름
- DataChannel 송수신 흐름
- signaling room 구조
- 파일 chunk 전송 경험
- progress UI 경험

신규 작성 대상:

- ManifestGenerator
- PieceManager
- StorageAdapter
- ResumeManager
- IntegrityChecker
- Scheduler
- Protocol spec
- 테스트와 문서

---

## 10. 오픈소스 활용성과 기여

PonsWarp Grid는 특정 서비스에 종속된 기능이 아니라, 다른 개발자가 자신의 웹앱에 붙일 수 있는 오픈소스 엔진을 목표로 한다.

공개 예정 구성:

```text
@ponswarp/core
@ponswarp/webrtc
@ponswarp/signaling
@ponswarp/react
apps/demo
docs/protocol.md
docs/architecture.md
```

오픈소스 기여 가치:

1. 브라우저 P2P 대용량 전송 구현 예시 제공
2. WebRTC DataChannel 기반 binary transfer protocol 공개
3. OPFS 기반 resume 구조 제공
4. piece hash 검증과 재전송 구조 제공
5. 교육, 연구, 미디어 공유 서비스에서 재사용 가능

---

## 11. 사회문제 해결 기여

대용량 파일 공유는 교육 자료, 연구 데이터, 영상 파일, 공익 자료를 다루는 개인과 소규모 조직에게 실질적인 부담이 된다. 기존 클라우드 방식은 용량 제한, 비용, 업로드 대기 시간, 개인정보 노출 문제를 동반한다.

PonsWarp Grid는 브라우저 간 직접 전송과 resume 구조를 통해 서버 의존도를 줄이고, 불안정한 네트워크에서도 이어받기를 지원한다. 이를 통해 학생, 창작자, 연구자, 비영리 단체가 더 낮은 비용으로 대용량 자료를 공유할 수 있도록 돕는다.

---

## 12. 차별성

| 기존 방식 | PonsWarp Grid |
|---|---|
| 서버에 파일 전체 업로드 | 브라우저 간 직접 전송 |
| 끊기면 처음부터 재시도 | piece 단위 이어받기 |
| 수신자가 많을수록 병목 증가 | peer 간 piece 교환 구조로 확장 가능 |
| 서비스 종속 | 오픈소스 엔진으로 재사용 가능 |
| 무결성 확인이 제한적 | piece/file hash 검증 |

---

## 13. 개발 일정 초안

대회 제출 일정에 맞춰 다음과 같이 진행한다.

| 단계 | 목표 | 산출물 |
|---|---|---|
| Phase 0 | 기존 PonsWarp 코드 감사 | code audit 문서 |
| Phase 1 | Core package 구현 | manifest, piece manager, integrity |
| Phase 2 | WebRTC transport 이식 | DataChannel 전송 |
| Phase 3 | Storage와 resume 구현 | OPFS adapter, resume demo |
| Phase 4 | Demo app 구현 | sender/receiver/debug UI |
| Phase 5 | 문서와 테스트 정리 | README, protocol, test report |
| Phase 6 | 대회 제출 준비 | 개발보고서, 시연 영상, 소스코드 |

---

## 14. 개인 역할

본 프로젝트는 1인 개발로 진행한다.

담당 역할:

- 제품 기획
- 기존 PonsWarp 코드 분석
- 엔진 아키텍처 설계
- TypeScript core 구현
- WebRTC transport 구현
- signaling server 구현
- demo UI 구현
- 테스트와 문서 작성
- 대회 제출 자료 제작

---

## 15. 위험 요소와 대응

| 위험 | 설명 | 대응 |
|---|---|---|
| WebRTC 연결 실패 | NAT 환경에 따라 직접 연결 실패 가능 | STUN 기본, TURN 옵션 문서화 |
| 브라우저 저장소 제한 | 대용량 piece 저장 실패 가능 | OPFS 우선, quota 오류 처리 |
| hash 계산 지연 | 대용량 파일에서 UI freeze 가능 | Web Worker 도입 검토 |
| DataChannel buffer 폭주 | 메모리 증가 가능 | backpressure 필수 구현 |
| 시연 네트워크 불안정 | 대회 영상 실패 가능 | localhost backup demo 준비 |
| 범위 과다 | multi peer까지 모두 구현 시 일정 위험 | v1은 owner 중심, v1.5로 grid 확장 |

---

## 16. 기대 효과

PonsWarp Grid는 대용량 파일을 공유해야 하는 사용자의 비용과 불편을 줄인다. 사용자는 파일 전체를 서버에 업로드하지 않고도 브라우저 간 직접 전송할 수 있으며, 네트워크가 끊겨도 받은 piece를 유지하고 이어받을 수 있다.

개발자 관점에서는 WebRTC 기반 대용량 전송, OPFS 저장, resume, hash 검증이 포함된 오픈소스 엔진을 활용할 수 있다. 이를 통해 교육 플랫폼, 연구 데이터 공유 도구, 미디어 협업 서비스, 사내 파일 전달 도구 등 다양한 서비스에서 재사용 가능하다.

---

## 17. 대회 시연 계획

3분 시연 구성:

```text
1. 문제 소개: 클라우드 업로드 기반 파일 공유의 한계
2. Sender: 500MB 또는 1GB 파일 선택
3. Manifest와 piece map 표시
4. Receiver: 공유 링크로 접속
5. WebRTC DataChannel 연결
6. Piece 단위 전송 진행률 표시
7. Receiver 새로고침
8. Resume으로 기존 piece 복원
9. SHA-256 검증 완료
10. 오픈소스 패키지 구조 소개
```

---

## 18. 결론

PonsWarp Grid는 기존 PonsWarp의 파일 전송 경험을 기반으로, 브라우저에서 동작하는 오픈소스 P2P 데이터 전송 엔진으로 확장하는 프로젝트다. 서버 의존도를 낮추고, 대용량 파일 전송의 안정성과 이어받기 경험을 개선하며, 향후 다중 peer grid 전송 구조로 확장할 수 있다.
