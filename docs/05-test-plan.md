# PonsWarp Grid Engine 테스트 계획서

문서 버전: v0.1  
작성일: 2026-06-30

---

## 1. 목적

이 문서는 PonsWarp Grid Engine의 안정성, 정확성, 대용량 전송 가능성, resume 기능, 대회 시연 가능성을 검증하기 위한 테스트 전략과 테스트 케이스를 정의한다.

핵심 검증 대상은 다음이다.

1. 파일이 정확히 piece로 분할되는가?
2. piece hash와 file hash가 정확한가?
3. WebRTC DataChannel로 binary가 안정적으로 전송되는가?
4. 수신한 piece가 로컬 저장소에 저장되는가?
5. 새로고침 후 resume이 가능한가?
6. DataChannel backpressure가 동작하는가?
7. 대회 시연 환경에서 실패 없이 동작하는가?

---

## 2. 테스트 레벨

| 레벨 | 대상 | 도구 후보 | 목적 |
|---|---|---|---|
| Unit | core module | Vitest | 순수 로직 검증 |
| Integration | core + storage + transport mock | Vitest | 모듈 간 상호작용 검증 |
| Browser E2E | demo app | Playwright | 실제 브라우저 동작 검증 |
| Manual | 시연 시나리오 | Chrome/Edge | 대회 제출 전 리허설 |
| Performance | 대용량 전송 | custom script | 속도, 메모리, 안정성 확인 |

---

## 3. 테스트 환경

## 3.1 Local

```text
OS: macOS 또는 Linux
Browser: Chrome latest
Node.js: LTS
Package manager: pnpm
Network: localhost 또는 같은 LAN
```

## 3.2 Browser matrix

| Browser | 우선순위 | 목표 |
|---|---|---|
| Chrome latest | P0 | 필수 통과 |
| Edge latest | P1 | 가능하면 통과 |
| Firefox latest | P1 | 기본 전송 통과 |
| Safari | P2 | 후순위 |
| Mobile Chrome | P2 | 후순위 |

---

## 4. 테스트 데이터

| 파일 크기 | 용도 |
|---|---|
| 1KB | edge case |
| 1MB | piece boundary 확인 |
| 10MB | 빠른 개발 테스트 |
| 100MB | 기본 성능 테스트 |
| 500MB | MVP 필수 검증 |
| 1GB | 대회 시연 후보 |

테스트 파일 생성 예시:

```bash
mkfile 100m test-100mb.bin
mkfile 500m test-500mb.bin
mkfile 1g test-1gb.bin
```

Linux:

```bash
fallocate -l 100M test-100mb.bin
fallocate -l 500M test-500mb.bin
fallocate -l 1G test-1gb.bin
```

---

## 5. Unit Test Cases

## UT-001. Manifest piece count 계산

### 목적

파일 크기와 piece size에 따라 piece count가 정확히 계산되는지 확인한다.

### 입력

```text
file size: 10MB
piece size: 1MB
```

### 기대 결과

```text
pieceCount = 10
```

---

## UT-002. 마지막 piece size 계산

### 입력

```text
file size: 10MB + 123 bytes
piece size: 1MB
```

### 기대 결과

```text
pieceCount = 11
lastPiece.size = 123
```

---

## UT-003. Piece hash 생성

### 목적

동일한 binary input에서 동일한 SHA-256 hash가 생성되는지 확인한다.

### 기대 결과

- hash deterministic
- hash format valid

---

## UT-004. PieceManager 상태 전이

### 시나리오

```text
missing → requested → receiving → received → verified
```

### 기대 결과

- 각 상태 전이가 정상 처리됨
- progress가 업데이트됨

---

## UT-005. 실패 piece 재시도

### 시나리오

```text
requested → failed → missing
```

### 기대 결과

- retryCount 증가
- missing list에 다시 포함

---

## UT-006. PieceMap export/import

### 목적

resume을 위한 piece map 저장과 복원이 정확한지 확인한다.

### 기대 결과

- verified pieces 유지
- requested/receiving 상태는 missing으로 복원 가능

---

## UT-007. StorageAdapter memory 구현

### 목적

storage interface의 기본 동작 검증

### 기대 결과

- writePiece 후 readPiece 가능
- hasPiece true
- deletePiece 후 false

---

## UT-008. Integrity mismatch 처리

### 시나리오

잘못된 binary를 piece descriptor hash와 비교한다.

### 기대 결과

- verifyPiece false
- piece status failed 또는 missing으로 전환

---

## 6. Integration Test Cases

## IT-001. Manifest 생성 후 piece 저장

### 흐름

```text
File 생성
→ manifest 생성
→ piece read
→ storage write
→ storage read
→ hash verify
```

### 기대 결과

- 저장 후 읽은 piece가 원본 piece와 동일

---

## IT-002. Mock transport로 piece 전송

### 목적

WebRTC 없이 core 전송 flow를 검증한다.

### 흐름

```text
sender engine
→ mock transport
→ receiver engine
→ storage
→ verify
```

### 기대 결과

- 모든 piece verified
- final progress 100%

---

## IT-003. Resume state 복원

### 흐름

```text
piece 0~4 저장
→ state 저장
→ engine 재생성
→ loadState
→ missing pieces 계산
```

### 기대 결과

- verifiedPieces = 0~4
- missingPieces = 나머지
- progress가 0에서 시작하지 않음

---

## IT-004. Retry flow

### 흐름

```text
piece 3 전송
→ hash mismatch 발생
→ reject
→ retry
→ 정상 piece 수신
```

### 기대 결과

- retryCount = 1
- 최종 verified

---

## IT-005. Backpressure mock

### 목적

buffer high watermark에서 send가 대기하는지 확인한다.

### 기대 결과

- bufferedAmount 초과 시 send queue 정지
- low event 후 재개

---

## 7. Browser E2E Test Cases

## E2E-001. 기본 파일 전송

### 환경

- Browser A: sender
- Browser B: receiver
- 파일: 100MB

### 절차

1. sender page 접속
2. 파일 선택
3. session 생성
4. receiver page에서 link 접속
5. 다운로드 시작
6. 완료 후 파일 저장

### 기대 결과

- progress 100%
- hash verified
- receiver file size 일치

---

## E2E-002. 500MB 파일 전송

### 목적

MVP 기준 대용량 전송 검증

### 기대 결과

- 전송 완료
- 브라우저 crash 없음
- 메모리 사용량이 비정상적으로 증가하지 않음

---

## E2E-003. 새로고침 resume

### 절차

1. 500MB 파일 다운로드 시작
2. 30~50% 지점에서 receiver 새로고침
3. 같은 session으로 재접속
4. resume 상태 확인
5. 나머지 piece만 다운로드
6. 완료

### 기대 결과

- progress가 0%로 돌아가지 않음
- 이미 받은 piece 재다운로드 최소화
- 최종 hash verified

---

## E2E-004. Sender 일시 연결 종료

### 절차

1. 전송 시작
2. sender browser network offline 또는 tab close
3. receiver 오류 확인
4. sender 재접속
5. 가능하면 재개

### 기대 결과

- receiver가 명확한 disconnected 상태 표시
- engine이 crash하지 않음

---

## E2E-005. 저장소 부족 시나리오

### 목적

storage quota 오류 처리 확인

### 기대 결과

- `storage:quota_exceeded` 오류 표시
- 잘못된 완료 상태로 가지 않음

---

## 8. Manual 시연 테스트

## DEMO-001. 3분 시연 리허설

### 목표

대회 제출용 3분 영상 흐름 검증

### 시나리오

```text
00:00 프로젝트 소개
00:20 sender에서 1GB 또는 500MB 파일 선택
00:40 session link 생성
01:00 receiver 접속
01:20 WebRTC 연결과 piece 전송 시작
01:50 receiver 새로고침
02:10 resume 상태 표시
02:30 hash 검증 완료
02:45 오픈소스 구조와 docs 소개
```

### 통과 기준

- 3분 안에 핵심 가치가 보임
- progress, piece map, resume status가 화면에 보임
- 실패 시 backup 시나리오 준비됨

---

## DEMO-002. 백업 시연 플랜

실제 네트워크가 불안정할 경우를 대비해 다음을 준비한다.

1. 100MB 파일 demo
2. localhost 두 브라우저 demo
3. 미리 녹화한 500MB resume 영상
4. debug panel screenshot
5. architecture diagram

---

## 9. 성능 테스트

## PERF-001. Manifest 생성 시간

| 파일 크기 | 목표 |
|---|---|
| 100MB | 허용 가능한 수준 |
| 500MB | UI freeze 최소화 |
| 1GB | Web Worker 필요 여부 판단 |

측정 항목:

- manifest 생성 시간
- piece hash 계산 시간
- memory usage

---

## PERF-002. 전송 속도

측정 항목:

- 평균 Bps
- peak Bps
- retry count
- dropped connection count
- DataChannel bufferedAmount max

---

## PERF-003. Resume 복원 시간

목표:

```text
local state load + piece map restore ≤ 5초
```

---

## 10. 보안 테스트

## SEC-001. 알 수 없는 session 접근

기대 결과:

- session not found
- 파일 정보 노출 없음

## SEC-002. Manifest mismatch resume

기대 결과:

- resume 거부
- 새 다운로드 안내

## SEC-003. 잘못된 message type

기대 결과:

- crash 없음
- warning event 발생

## SEC-004. 파일명 escape

입력:

```text
<script>alert(1)</script>.txt
```

기대 결과:

- UI에서 실행되지 않음

---

## 11. 테스트 완료 기준

MVP release candidate는 아래 조건을 만족해야 한다.

1. core unit tests 90% 이상 통과
2. manifest, piece manager, integrity tests 통과
3. storage adapter tests 통과
4. mock transport integration test 통과
5. browser E2E 기본 전송 통과
6. browser E2E resume 통과
7. 500MB 수동 전송 성공
8. 3분 시연 리허설 성공
9. 주요 오류 시나리오에서 crash 없음

---

## 12. 결함 관리

결함은 아래 형식으로 기록한다.

```md
## BUG-001

- 발견일:
- 환경:
- 재현 절차:
- 기대 결과:
- 실제 결과:
- 로그:
- 심각도: blocker/critical/major/minor
- 상태: open/fixed/verified
```

---

## 13. 우선순위

테스트 작성 우선순위:

```text
1. ManifestGenerator unit test
2. PieceManager unit test
3. StorageAdapter unit test
4. IntegrityChecker unit test
5. Mock transport integration test
6. Resume integration test
7. Browser E2E basic transfer
8. Browser E2E resume
9. Performance test
10. Multi peer test
```
