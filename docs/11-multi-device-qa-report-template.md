# PonsWarp Multi-Device QA Report Template

문서 버전: v0.1
작성일: 2026-07-04
상태: 실행 보고서 템플릿, production-ready 선언 아님

## 1. Report metadata

| Field | Value |
|---|---|
| Report ID | |
| Date/time window | |
| Tester(s) | |
| Environment | `local` / `staging` / `beta` |
| Build SHA/version | |
| Demo/CLI package version | |
| Coordinator/signaling URL | |
| Feature flags | |
| Browser matrix | |
| CLI Node version | |
| Known limitations before test | |
| Overall result | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` |

## 2. Device and network inventory

| Device ID | Type | OS/version | Browser/runtime | CPU/RAM class | Network | NAT/VPN/firewall notes | Role(s) |
|---|---|---|---|---|---|---|---|
| D1 | desktop/laptop | | Chrome/Firefox/Safari/Node | | same LAN / different network / mobile hotspot | | sender/receiver/seed |
| D2 | mobile/tablet | | Mobile Safari/Chrome | | same LAN / cellular / hotspot | | receiver/seed |
| D3 | desktop/laptop | | Chrome/Firefox/Node | | different NAT | | receiver/seed |
| D4 | optional | | | | | | |

## 3. Common quantitative fields

Record these fields for every scenario unless explicitly not applicable.

| Field | Value |
|---|---|
| File name/class | |
| File size bytes | |
| Piece size bytes | |
| Piece count | |
| Sender count | |
| Receiver count | |
| Non-owner seed count | |
| Start timestamp | |
| End timestamp | |
| Duration seconds | |
| Average throughput MiB/s | |
| p95 piece latency ms, if measured | |
| Reconnect count | |
| ICE restart count, if visible | |
| Failed/retried piece count | |
| Duplicate piece count, if measured | |
| Resume checkpoint count | |
| Final verified pieces | |
| Final SHA-256 match | `yes` / `no` / `not checked` |
| Peak sender memory, if available | |
| Peak receiver memory, if available | |
| Server 4xx/5xx count during scenario | |
| Artifact links | logs/screenshots/transcripts/metrics |

## 4. Common qualitative fields

| Field | Notes |
|---|---|
| User-visible status clarity | |
| Error/retry message clarity | |
| Progress smoothness | |
| Resume UX correctness | |
| Download/save UX correctness | |
| Mobile usability issues | |
| Accessibility or viewport issues noticed | |
| Operator/debug panel usefulness | |
| Unexpected behavior | |
| Tester verdict | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` |

## 5. Scenario MD-01: Desktop to desktop, same LAN

Purpose: prove the baseline Web sender to Web receiver path on the same LAN.

### Setup

- Sender: D1 desktop browser
- Receiver: D2 desktop browser
- Network: same LAN, no VPN unless recorded
- File set: small file (< 50 MiB) and medium/large file agreed for the release candidate

### Steps

1. Start signaling/coordinator and serve the demo from a hostname reachable by both devices.
2. Open the sender page on D1 and create a share/session.
3. Open the generated join URL on D2.
4. Start transfer and wait for completion.
5. Download/save the assembled file on D2.
6. Compare final hash or byte-equivalent checksum when available.
7. Capture browser console, debug panel, server logs, and metrics for the run.

### Result

| Field | Value |
|---|---|
| Quantitative record | link or paste completed Section 3 table |
| Qualitative record | link or paste completed Section 4 table |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 6. Scenario MD-02: Desktop to mobile, same LAN

Purpose: prove mobile receiver behavior and viewport/download constraints.

### Setup

- Sender: D1 desktop browser
- Receiver: D2 mobile Safari or Chrome
- Network: same LAN Wi-Fi
- File set: small file plus the largest file expected to be supported by the mobile browser's safe save path

### Steps

1. Create the session on desktop.
2. Join from mobile using QR/link/manual URL.
3. Keep the mobile screen awake or record when backgrounding is intentionally tested.
4. Complete transfer and attempt final save/download.
5. Rotate viewport once during or after transfer if relevant.
6. Capture mobile browser version, screenshots, logs available from remote debugging if possible, and server metrics.

### Result

| Field | Value |
|---|---|
| Quantitative record | |
| Qualitative record | |
| Mobile save behavior | Blob download / File System Access / unsupported with clear message |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 7. Scenario MD-03: Same LAN mixed CLI/Web

Purpose: prove the low-level CLI path remains a QA fallback and can interoperate with Web-facing release checks where supported.

### Setup

- Sender: CLI Node or Web browser
- Receiver: CLI Node or Web browser
- Network: same LAN
- File set: deterministic binary/text fixture with known SHA-256

### Steps

1. Start the sender/share flow on the selected surface.
2. Join from the opposite or fallback surface.
3. Complete transfer and verify output hash.
4. For CLI, preserve command transcript and output directory listing/checksum artifact.
5. For Web, preserve screenshot/debug panel and downloaded file checksum artifact.

### Result

| Field | Value |
|---|---|
| Surface combination | CLI→CLI / CLI→Web / Web→CLI / Web→Web |
| Quantitative record | |
| Qualitative record | |
| Hash artifact | |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 8. Scenario MD-04: Different network / NAT path

Purpose: expose NAT, firewall, TURN/STUN, and candidate-selection problems before beta.

### Setup

- Sender: D1 on LAN A
- Receiver: D3 on LAN B, cellular, or hotspot
- Optional third observer/seed: D2 on LAN A or LAN B
- Record whether TURN is enabled, disabled, or unavailable

### Steps

1. Verify both sides can reach the signaling/coordinator URL.
2. Start sender on LAN A and join from LAN B/cellular.
3. Record ICE candidate/connection state transitions visible in the app/debug logs.
4. Complete transfer or capture the exact failure phase.
5. Repeat once with VPN/hotspot disabled/enabled when relevant to isolate NAT behavior.

### Result

| Field | Value |
|---|---|
| NAT/network description | |
| TURN/STUN config | |
| Connection established | `yes` / `no` |
| Failure phase if any | signaling / ICE / DataChannel / transfer / final save |
| Quantitative record | |
| Qualitative record | |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 9. Scenario MD-05: NAT interruption and reconnect/resume

Purpose: prove interrupted network paths fail clearly and resume without corrupting verified pieces.

### Setup

- Sender and receiver may be same LAN or different network; prefer different network after MD-04 passes.
- File set: large enough to allow interruption before completion.

### Steps

1. Start a transfer and wait until 20-60% completion.
2. Interrupt receiver network for 15-60 seconds by toggling Wi-Fi/cellular, moving between networks, or blocking the connection in a controlled way.
3. Restore network and observe reconnect/retry behavior.
4. If automatic reconnect is not supported, reload/rejoin using the documented resume flow.
5. Complete transfer and verify final hash.
6. Record pieces retained, pieces retried, reconnect count, user-visible messages, and server logs.

### Result

| Field | Value |
|---|---|
| Interruption method/duration | |
| Automatic reconnect | `yes` / `no` / `manual resume required` |
| Verified pieces before interruption | |
| Verified pieces after resume | |
| Corrupt/discarded pieces | |
| Quantitative record | |
| Qualitative record | |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 10. Scenario MD-06: Server restart during session

Purpose: prove restart persistence expectations and user-visible recovery behavior.

### Setup

- Sender: Web or CLI
- Receiver: Web or CLI
- Coordinator/signaling server with persistence configuration under test
- File set: large enough for restart mid-transfer

### Steps

1. Start transfer and record session/share/workspace/node IDs.
2. Restart the signaling/coordinator process during active transfer.
3. Observe WebSocket/signaling disconnect, reconnect, and any transfer pause.
4. Rejoin or resume as documented.
5. Verify unexpired share/session metadata still resolves after restart.
6. Complete transfer and verify final hash.
7. Compare pre/post server logs, metrics, and DB state if applicable.

### Result

| Field | Value |
|---|---|
| Restart method | rolling restart / process kill / container restart |
| Persistence backend | memory / Postgres / other |
| Data expected to persist | workspace/node/file/share/availability/presence |
| Data actually persisted | |
| Recovery action required | none / reconnect / reload / manual restart |
| Quantitative record | |
| Qualitative record | |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 11. Scenario MD-07: Large-file transfer and resume

Purpose: prove bounded-memory transfer, safe final assembly/save behavior, and resume for large files.

### Setup

- Sender and receiver: desktop preferred, mobile optional after MD-02 passes.
- File sizes: at least one file above the default `safeAssembleBytes` threshold and one representative release target size.
- Record browser writable-stream/File System Access support.

### Steps

1. Start large-file transfer and capture initial manifest/piece size/count.
2. Monitor progress and memory indicators available from app/browser/process tools.
3. Refresh or restart receiver at 25-75% completion.
4. Restore local resume state and complete the transfer.
5. Attempt final save/download.
6. Verify whether the outcome is a completed save, a supported writable-stream save, or an explicit unsupported result above threshold.
7. Verify final hash for every saved output.

### Result

| Field | Value |
|---|---|
| File size category | below threshold / above threshold |
| Final save path | Blob / writable stream / explicit unsupported |
| Resume restored pieces | |
| Memory issue observed | `yes` / `no` |
| Quantitative record | |
| Qualitative record | |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 12. Scenario MD-08: 3+ peer grid / non-owner provider

Purpose: prove at least one receiver can fetch pieces from a non-owner provider when a third peer is present.

### Setup

- Owner/sender: D1
- Receiver/seed A: D2, remains online after completion
- Receiver B: D3, joins after A has complete or partial availability
- Optional Receiver C: D4 for additional fan-out
- Network: same LAN first; repeat different network only after baseline passes

### Steps

1. Start owner share/session from D1.
2. Join from Receiver A and complete or reach a high verified-piece percentage.
3. Keep Receiver A online and advertising availability.
4. Join from Receiver B using the same share/session and peer/provider hint flow under test.
5. Complete transfer on Receiver B.
6. Record owner-provided pieces, non-owner-provided pieces, duplicate pieces, provider switch count, and final hash.
7. Repeat with Receiver A taken offline mid-transfer to verify candidate disappearance handling.

### Result

| Field | Value |
|---|---|
| Peer count | 3 / 4+ |
| Non-owner provider pieces | |
| Owner provider pieces | |
| Provider switch count | |
| Receiver A offline subtest result | |
| Quantitative record | |
| Qualitative record | |
| Pass criteria met | `yes` / `no` |
| Notes/blockers | |

## 13. Scenario MD-09: Policy failures visible to users

Purpose: prove expired/revoked/unauthorized shares fail safely and explainably.

### Steps

1. Create a valid share and confirm it resolves.
2. Expire or revoke the share.
3. Attempt join/download from desktop and mobile if both are in scope.
4. Attempt access with wrong workspace/node identity where applicable.
5. Record HTTP status, UI/CLI message, and audit/security event.

### Result

| Field | Value |
|---|---|
| Expired share behavior | |
| Revoked share behavior | |
| Unauthorized behavior | |
| Metadata leaked | `yes` / `no` |
| User message acceptable | `yes` / `no` |
| Artifact links | |
| Pass criteria met | `yes` / `no` |

## 14. Summary matrix

| Scenario | Required before | Result | Blocking issues | Artifact links |
|---|---|---|---|---|
| MD-01 Desktop↔desktop same LAN | staging/private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-02 Desktop→mobile same LAN | staging/private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-03 Mixed CLI/Web same LAN | staging/private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-04 Different network/NAT | private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-05 NAT interruption/reconnect | private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-06 Server restart | staging/private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-07 Large-file/resume | staging/private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-08 3+ peer grid | private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |
| MD-09 Policy failures | staging/private beta | `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` | | |

## 15. Release recommendation

| Field | Value |
|---|---|
| Recommended release level | `NO-GO` / `STAGING ONLY` / `PRIVATE BETA` / `PUBLIC BETA` |
| Reasons | |
| Must-fix blockers | |
| Waived issues | |
| Waiver owner/expiration | |
| Rollback trigger summary | |
| Link to release gate record | `docs/10-release-qa-gates.md` instance |
| Approvers | |

A `PUBLIC BETA` recommendation requires passing the release gates in `docs/10-release-qa-gates.md`, passing the required multi-device scenarios above, and documenting every known unsupported browser/network/save path without presenting it as production-ready.
