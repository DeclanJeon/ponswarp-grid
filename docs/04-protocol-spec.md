# PonsWarp Grid Engine Protocol Specification

문서 버전: v0.1  
작성일: 2026-06-30  
대상 프로토콜 버전: `ponswarp-grid/1.0.0`

---

## 1. 목적

이 문서는 PonsWarp Grid Engine에서 사용하는 signaling message와 WebRTC DataChannel message의 형식을 정의한다.

프로토콜은 두 계층으로 나뉜다.

| 계층 | 전송 경로 | 역할 |
|---|---|---|
| Signaling Protocol | WebSocket | session 생성, peer join, SDP/ICE 전달 |
| Transfer Protocol | WebRTC DataChannel | manifest, piece request, binary chunk, ACK 전달 |

---

## 2. 공통 원칙

1. 모든 control message는 JSON이다.
2. 파일 데이터는 binary frame으로 전송한다.
3. 모든 message에는 protocol version을 포함한다.
4. 모든 message에는 correlation을 위한 `messageId`를 포함한다.
5. 수신자는 알 수 없는 message type을 무시하고 warning event를 발생시킨다.
6. protocol major version이 다르면 연결을 거부한다.

---

## 3. 공통 타입

```ts
type PeerId = string
type SessionId = string
type FileId = string
type MessageId = string

type ProtocolVersion = '1.0.0'
```

---

## 4. Signaling Protocol

## 4.1 Signaling Envelope

```ts
type SignalingEnvelope<TPayload> = {
  protocol: 'ponswarp-grid/signaling'
  version: '1.0.0'
  messageId: string
  type: string
  sessionId?: string
  fromPeerId?: string
  toPeerId?: string
  timestamp: number
  payload: TPayload
}
```

---

## 4.2 CREATE_SESSION

Sender가 signaling server에 session 생성을 요청한다.

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_001",
  "type": "CREATE_SESSION",
  "timestamp": 1780000000000,
  "payload": {
    "ownerPeerId": "peer_owner",
    "mode": "grid",
    "files": [
      {
        "fileId": "file_001",
        "name": "video.mp4",
        "size": 104857600,
        "pieceSize": 1048576,
        "pieceCount": 100
      }
    ]
  }
}
```

---

## 4.3 SESSION_CREATED

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_002",
  "type": "SESSION_CREATED",
  "sessionId": "sess_abc123",
  "timestamp": 1780000000100,
  "payload": {
    "ownerPeerId": "peer_owner",
    "expiresAt": 1780003600000,
    "shareUrl": "https://demo.example.com/join/sess_abc123"
  }
}
```

---

## 4.4 JOIN_SESSION

Receiver가 session에 참여한다.

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_003",
  "type": "JOIN_SESSION",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "timestamp": 1780000000200,
  "payload": {
    "role": "receiver",
    "client": {
      "name": "web-demo",
      "version": "0.1.0"
    }
  }
}
```

---

## 4.5 SESSION_JOINED

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_004",
  "type": "SESSION_JOINED",
  "sessionId": "sess_abc123",
  "timestamp": 1780000000300,
  "payload": {
    "selfPeerId": "peer_receiver",
    "ownerPeerId": "peer_owner",
    "peers": [
      {
        "peerId": "peer_owner",
        "role": "owner"
      }
    ],
    "files": []
  }
}
```

---

## 4.6 PEER_JOINED / PEER_LEFT

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_005",
  "type": "PEER_JOINED",
  "sessionId": "sess_abc123",
  "timestamp": 1780000000400,
  "payload": {
    "peerId": "peer_receiver",
    "role": "receiver"
  }
}
```

---

## 4.7 WEBRTC_OFFER

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_006",
  "type": "WEBRTC_OFFER",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "toPeerId": "peer_owner",
  "timestamp": 1780000000500,
  "payload": {
    "sdp": {
      "type": "offer",
      "sdp": "..."
    }
  }
}
```

---

## 4.8 WEBRTC_ANSWER

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_007",
  "type": "WEBRTC_ANSWER",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_owner",
  "toPeerId": "peer_receiver",
  "timestamp": 1780000000600,
  "payload": {
    "sdp": {
      "type": "answer",
      "sdp": "..."
    }
  }
}
```

---

## 4.9 ICE_CANDIDATE

```json
{
  "protocol": "ponswarp-grid/signaling",
  "version": "1.0.0",
  "messageId": "msg_008",
  "type": "ICE_CANDIDATE",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_owner",
  "toPeerId": "peer_receiver",
  "timestamp": 1780000000700,
  "payload": {
    "candidate": {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0
    }
  }
}
```

---

## 5. Transfer Protocol

## 5.1 Control Envelope

DataChannel에서 JSON control message를 보낼 때 사용한다.

```ts
type TransferEnvelope<TPayload> = {
  protocol: 'ponswarp-grid/transfer'
  version: '1.0.0'
  messageId: string
  type: string
  sessionId: string
  fromPeerId: PeerId
  toPeerId?: PeerId
  timestamp: number
  payload: TPayload
}
```

---

## 5.2 HELLO

DataChannel open 이후 가장 먼저 교환한다.

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_101",
  "type": "HELLO",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "toPeerId": "peer_owner",
  "timestamp": 1780000001000,
  "payload": {
    "role": "receiver",
    "supports": {
      "resume": true,
      "pieceMap": true,
      "binaryFrameV1": true
    }
  }
}
```

---

## 5.3 MANIFEST

Owner가 receiver에게 manifest를 전달한다.

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_102",
  "type": "MANIFEST",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_owner",
  "toPeerId": "peer_receiver",
  "timestamp": 1780000001100,
  "payload": {
    "files": [
      {
        "version": "1.0",
        "fileId": "file_001",
        "name": "video.mp4",
        "size": 104857600,
        "mimeType": "video/mp4",
        "pieceSize": 1048576,
        "pieceCount": 100,
        "fileHash": "sha256:...",
        "pieces": [
          {
            "index": 0,
            "offset": 0,
            "size": 1048576,
            "hash": "sha256:..."
          }
        ]
      }
    ]
  }
}
```

---

## 5.4 PIECE_MAP

Peer가 자신이 보유한 piece 목록을 알린다.

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_103",
  "type": "PIECE_MAP",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "timestamp": 1780000001200,
  "payload": {
    "fileId": "file_001",
    "verifiedPieces": [0, 1, 2, 3],
    "pieceCount": 100
  }
}
```

MVP에서는 owner가 모든 piece를 가진 것으로 간주할 수 있다.

---

## 5.5 PIECE_REQUEST

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_104",
  "type": "PIECE_REQUEST",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "toPeerId": "peer_owner",
  "timestamp": 1780000001300,
  "payload": {
    "fileId": "file_001",
    "pieceIndex": 12,
    "requestId": "req_12_001",
    "fromOffset": 0
  }
}
```

---

## 5.6 PIECE_CANCEL

Receiver가 요청을 취소한다.

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_105",
  "type": "PIECE_CANCEL",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "toPeerId": "peer_owner",
  "timestamp": 1780000001350,
  "payload": {
    "fileId": "file_001",
    "pieceIndex": 12,
    "requestId": "req_12_001",
    "reason": "peer_switch"
  }
}
```

---

## 5.7 PIECE_ACK

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_106",
  "type": "PIECE_ACK",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "toPeerId": "peer_owner",
  "timestamp": 1780000002000,
  "payload": {
    "fileId": "file_001",
    "pieceIndex": 12,
    "requestId": "req_12_001",
    "status": "verified",
    "hash": "sha256:..."
  }
}
```

---

## 5.8 PIECE_REJECT

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_107",
  "type": "PIECE_REJECT",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "toPeerId": "peer_owner",
  "timestamp": 1780000002100,
  "payload": {
    "fileId": "file_001",
    "pieceIndex": 12,
    "requestId": "req_12_001",
    "reason": "hash_mismatch",
    "expectedHash": "sha256:...",
    "actualHash": "sha256:..."
  }
}
```

---

## 6. Binary Frame

실제 파일 데이터는 binary frame으로 전송한다.

MVP 구현 단순화를 위해 두 가지 방식 중 하나를 선택한다.

### Option A. Header JSON + Binary payload 분리

1. `PIECE_CHUNK_HEADER` control message 전송
2. 바로 다음 binary message로 payload 전송

장점:

- 구현이 쉽다.
- 디버깅이 쉽다.

단점:

- message pairing 관리가 필요하다.

---

### Option B. Binary frame에 header 포함

권장 v1 구조:

```text
[magic 4 bytes]
[version 1 byte]
[headerLength 4 bytes]
[header JSON bytes]
[payload bytes]
```

Header 예시:

```json
{
  "type": "PIECE_CHUNK",
  "sessionId": "sess_abc123",
  "fileId": "file_001",
  "pieceIndex": 12,
  "chunkIndex": 0,
  "totalChunks": 16,
  "requestId": "req_12_001",
  "payloadSize": 65536
}
```

MVP에서는 Option A로 시작하고, v1 안정화 시 Option B로 바꿀 수 있다.

---

## 7. Resume Protocol

## 7.1 RESUME_STATE

Receiver가 재접속 후 자신이 가진 piece를 알린다.

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_201",
  "type": "RESUME_STATE",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_receiver",
  "toPeerId": "peer_owner",
  "timestamp": 1780000010000,
  "payload": {
    "fileId": "file_001",
    "manifestHash": "sha256:manifest...",
    "verifiedPieces": [0, 1, 2, 3, 4, 5],
    "missingCount": 94
  }
}
```

## 7.2 RESUME_ACCEPTED

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_202",
  "type": "RESUME_ACCEPTED",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_owner",
  "toPeerId": "peer_receiver",
  "timestamp": 1780000010100,
  "payload": {
    "fileId": "file_001",
    "nextStrategy": "request_missing_only"
  }
}
```

## 7.3 RESUME_REJECTED

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_203",
  "type": "RESUME_REJECTED",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_owner",
  "toPeerId": "peer_receiver",
  "timestamp": 1780000010200,
  "payload": {
    "fileId": "file_001",
    "reason": "manifest_mismatch"
  }
}
```

---

## 8. Error Message

```json
{
  "protocol": "ponswarp-grid/transfer",
  "version": "1.0.0",
  "messageId": "msg_900",
  "type": "ERROR",
  "sessionId": "sess_abc123",
  "fromPeerId": "peer_owner",
  "toPeerId": "peer_receiver",
  "timestamp": 1780000020000,
  "payload": {
    "code": "piece:not_available",
    "message": "Requested piece is not available on this peer",
    "recoverable": true,
    "context": {
      "fileId": "file_001",
      "pieceIndex": 12
    }
  }
}
```

---

## 9. 오류 코드

| 코드 | 설명 | 복구 가능 |
|---|---|---|
| `protocol:version_mismatch` | major version 불일치 | false |
| `session:not_found` | session 없음 | false |
| `session:expired` | session 만료 | false |
| `peer:not_found` | 대상 peer 없음 | true |
| `piece:not_available` | peer가 piece를 갖고 있지 않음 | true |
| `piece:hash_mismatch` | piece hash 불일치 | true |
| `storage:write_failed` | 저장 실패 | true |
| `storage:quota_exceeded` | 저장소 용량 부족 | false |
| `transport:send_failed` | 전송 실패 | true |
| `resume:manifest_mismatch` | resume manifest 불일치 | false |

---

## 10. Handshake Flow

```text
DataChannel open
→ HELLO 교환
→ MANIFEST 전달
→ PIECE_MAP 교환
→ RESUME_STATE 전송 또는 새 다운로드 시작
→ PIECE_REQUEST
→ PIECE_CHUNK
→ PIECE_ACK
```

---

## 11. Backpressure 규칙

Sender는 DataChannel의 `bufferedAmount`를 확인한다.

권장 기본값:

```text
highWaterMark: 16MB
lowWaterMark: 8MB
```

규칙:

1. `bufferedAmount >= highWaterMark`이면 전송 중지
2. `bufferedamountlow` 이벤트를 기다림
3. lowWaterMark 이하로 내려가면 전송 재개

---

## 12. Security Considerations

1. signaling server는 파일 binary를 받지 않는다.
2. sessionId는 cryptographic random으로 생성한다.
3. peer는 manifest hash를 비교해 resume mismatch를 방지한다.
4. file name은 UI에 표시하기 전 escape한다.
5. v2에서는 manifest encryption과 passphrase를 추가할 수 있다.

---

## 13. 호환성 정책

- patch version 변경은 backward compatible해야 한다.
- minor version 변경은 새로운 optional field를 추가할 수 있다.
- major version 변경은 handshake에서 연결을 거부할 수 있다.

---

## 14. MVP 메시지 최소 세트

MVP에서 반드시 구현할 메시지:

```text
CREATE_SESSION
SESSION_CREATED
JOIN_SESSION
SESSION_JOINED
WEBRTC_OFFER
WEBRTC_ANSWER
ICE_CANDIDATE
HELLO
MANIFEST
PIECE_REQUEST
PIECE_ACK
PIECE_REJECT
ERROR
RESUME_STATE
RESUME_ACCEPTED
```

v1.5에서 추가 구현:

```text
PIECE_MAP
PIECE_CANCEL
PEER_HEALTH
```
