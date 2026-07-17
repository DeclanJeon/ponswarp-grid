# Logic & Algorithm Audit Scorecard

Status: Accepted baseline for improvement program  
Date: 2026-07-17  
Scope: `ponswarp-grid` packages (`core`, `webrtc`, `signaling`, `cli`, `demo`) vs reference `ponswarp` (`origin/master`) and hybrid P2P industry practice (BitTorrent BEP-3, WebRTC bulk transfer)

Related:

- `docs/19-transfer-performance-design.md` — request window / provider serialization
- `docs/21-path-aware-transfer-tuning-design.md` — phase-1 implementation target
- `docs/22-hybrid-assist-port-design.md` — hybrid HTTP assist (later phase)
- `docs/23-grid-scheduler-endgame-design.md` — multi-peer / endgame
- `docs/24-adaptive-congestion-control-design.md` — RTT/AIMD

---

## 1. Executive score

| Dimension | Score | Notes |
|---|---:|---|
| Piece integrity & resume | 9/10 | Re-hash discard on restore is correct |
| Wire protocol efficiency | 5/10 | Control+binary pair; fixed chunk; per-peer serial send |
| Congestion / backpressure | 7/10 | DataChannel watermarks OK; adaptive AIMD missing |
| Multi-peer scheduling | 6.5/10 | Rarest-first + health present; endgame/pipelined grid thin |
| Path awareness (ICE) | 7/10 | Tuning helpers landed 2026-07-17; engine auto-wire pending |
| Hybrid fallback | 2/10 | Present in ponswarp, not in Grid |
| NAT traversal ops | 6/10 | UDP TURN validated; TCP-only strata incomplete |
| Security (auth, rate limit) | 5/10 | MVP surface; RS signaling more mature |
| Observability | 6/10 | speed/retry events; getStats loop weak |
| **Engine MVP overall** | **7.0/10** | |
| **Cross-network product** | **5.5/10** | Without hybrid + adaptive control |

---

## 2. Findings register

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| A | High | webrtc | `clampDataChannelChunkSize` capped at 16 KiB always | **Fixed** 2026-07-17 |
| B | High | core | `PeerHealth.markSuccess(0 bytes)` zeroed throughput | **Fixed** 2026-07-17 (skip 0-byte + EMA) |
| C | Med | core | Rarest-first used capacity-filtered providers | **Fixed** 2026-07-17 (full advertised count) |
| D | Med | core/webrtc | Fixed 64 KiB engine chunk; no path profile | Design `21`; phase-1 wire-up |
| E | Med | demo/cli | Operational window=1 + serial provider send → RTT not hidden | By design hold-1; wire change later |
| F | Med | core/cli | Grid multi-peer simultaneous fill thin | Design `23` |
| G | High (product) | hybrid | `shouldArmHybrid` path policy not ported | Design `22` |
| H | Med | webrtc | NetworkAdaptiveController not ported | Design `24` |
| I | Low | core | `fromOffset` always 0 | Design `23` |
| J | Low | core | No endgame multi-request + cancel | Design `23` |
| K | Ops | release | Coordinator byte path incomplete; TCP TURN evidence gaps | Ops docs / QA matrix |

---

## 3. Strengths (do not regress)

1. Piece-level SHA-256 + resume re-verify discard.
2. Outstanding request tracking, request leases, provider-side piece send queue.
3. Operational hold-1 transfer window with evidence-gated window 2.
4. PeerHealth score skeleton + grid schedule result taxonomy.
5. Tiered demo piece sizes (≥ 256 KiB small-file floor).
6. Safe assemble threshold for large files / stream save path.

---

## 4. Reference comparison

### 4.1 PonsWarp origin/master

| Source | Reuse for Grid |
|---|---|
| `transferFlowControl.ts` path profiles + BDP | Port math into `@ponswarp/webrtc` (helpers done); wire engine |
| `hybridBulkTransport.ts` `shouldArmHybrid` | Port policy first; HTTP object plane optional later |
| `networkAdaptiveController.ts` | Port as optional controller behind interface |
| `singlePeerConnection.ts` drain semantics | Already largely in `DataChannelWrapper` |
| signaling-rs abuse/auth | Later ops hardening, not phase-1 |

### 4.2 Industry

| Practice | Grid mapping |
|---|---|
| BitTorrent rarest-first | `requestNextGridPiece` rarity sort |
| Request pipelining | `requestPieceWindow` (hold-1 default) |
| Choke / optimistic unchoke | Not required for 1:1 share; optional for mesh fairness |
| Endgame + cancel | Design `23` |
| WebRTC bufferedAmountLow + BDP | Design `21` / `24` |
| Hybrid WebRTC+HTTP assist | Design `22` |

---

## 5. Acceptance matrix for improvement program

| Phase | Gate | Exit criteria |
|---|---|---|
| P0 | Fixes A–C stable | core + webrtc unit tests green; EMA/clamp tests present |
| P1 | Path-aware wiring | Engine chunk size configurable; profile → flowControl path; hold-1 unchanged; tests |
| P2 | Scheduler/endgame | Multi-peer window helper; endgame cancel; fromOffset optional |
| P3 | Hybrid assist MVP | Policy + caps exchange; no LAN force-arm; tests for arm decisions |
| P4 | Adaptive congestion | Controller updates cwnd from stats/buffer; bounded; tests |

---

## 6. Non-goals (program-wide)

- No wire protocol migration in P0–P1.
- No cryptographic weakening.
- No fabricated throughput claims.
- No automatic window-2 enable without evidence gate.
- No TURN infra redesign in this program.

---

## 7. Change log

| Date | Change |
|---|---|
| 2026-07-17 | Initial scorecard from full audit; P0 code fixes recorded |
