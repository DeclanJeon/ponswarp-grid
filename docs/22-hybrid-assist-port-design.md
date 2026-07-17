# Hybrid Assist Port Design

Status: Design only (phase-3)  
Last updated: 2026-07-17  
Source of truth for policy: ponswarp `origin/master` `PonsWarp/src/services/hybridBulkTransport.ts`  
Related: `docs/20-logic-algorithm-audit-scorecard.md` finding G

---

## 1. Problem

Cross-network (relay / high-RTT / low observed throughput) transfers on Grid rely solely on WebRTC DataChannel. Relay bandwidth and RTT make pure P2P feel slow. PonsWarp already implements **hybrid HTTP assist**: same ciphertext packets framed into a cloud object, uploaded in parallel, downloaded by receiver, while WebRTC remains primary on healthy direct paths.

Grid has **no** hybrid plane. Product score for hybrid fallback is 2/10.

---

## 2. Goals

1. Port **arming policy** as a pure function suitable for Grid (UI-free).
2. Define capability exchange messages that fit Grid signaling/session model.
3. Define phased MVP that can ship policy + dry-run without full cloud upload.
4. Never force hybrid on healthy LAN host/srflx paths.

---

## 3. Non-goals

- Replacing WebRTC as primary transport on host/srflx when healthy.
- Mandatory cloud dependency for open-source engine default builds.
- Changing piece hash algorithm or resume storage.
- TURN server replacement.
- Full re-implementation of PonsWarp cloud share billing/auth.

---

## 4. Arming policy (normative)

Port of `shouldArmHybrid` from ponswarp master:

```ts
export type HybridPathKind = 'host' | 'srflx' | 'relay' | 'unknown' | string;

export interface HybridPeerCaps {
  hybridHttp: boolean;
  // optional version / max object bytes later
}

export interface HybridArmDecision {
  armed: boolean;
  reason: string;
}

export function shouldArmHybrid(params: {
  compileEnabled?: boolean;
  remoteCaps?: HybridPeerCaps | null;
  totalBytes: number;
  cloudApiConfigured: boolean;
  minBytes?: number;
  pathKind?: HybridPathKind | null;
  rttMs?: number | null;
  observedMBps?: number | null;
  triggerMBps?: number;
  elevatedRttMs?: number;
  force?: boolean;
}): HybridArmDecision;
```

### Decision table

| Condition | Result |
|---|---|
| compile flag off | `armed:false` `compile-flag-off` |
| cloud API unconfigured | `armed:false` `cloud-api-unconfigured` |
| remote caps missing hybridHttp | `armed:false` `remote-caps-missing` |
| totalBytes < minBytes | `armed:false` `below-min-bytes` |
| force | `armed:true` `force` |
| path host/srflx + elevated RTT | `armed:true` `elevated-rtt` |
| path host/srflx + observed < trigger | `armed:true` `slow-direct` |
| path host/srflx otherwise | `armed:false` `direct-path` |
| path relay | `armed:true` `path-relay` |
| path unknown + slow/elevated | `armed:true` |
| path unknown otherwise | `armed:false` `path-unknown-not-slow` |

Suggested defaults (match ponswarp constants when porting):

- `HYBRID_MIN_BYTES` — e.g. multi-MiB floor (read exact constant from ponswarp at implement time)
- `HYBRID_TRIGGER_MBps` — slow threshold
- `HYBRID_ELEVATED_RTT_MS` — RTT arm threshold

---

## 5. Framing (when object plane is enabled)

Length-delimited packets (big-endian u32 length + payload), same as ponswarp `frameHybridPackets` / `parseHybridFramedObject`.

Grid constraint: if WebRTC pieces are plain (no app-layer crypto), hybrid object must still carry **identical piece bytes** so SHA-256 piece verify is unchanged. Prefer piece-aligned frames keyed by `(fileId, pieceIndex)` rather than opaque bulk-only blobs, so partial assist can fill the same PieceManager.

### Recommended Grid frame (phase-3+)

```ts
// binary layout proposal (document only until implement)
// magic: "PWGH" (4) | version u8 | flags u8 | reserved u16
// | fileId utf8 length-prefixed | pieceIndex u32 | pieceBytes...
```

MVP policy package can ship **without** implementing frames.

---

## 6. Phased delivery

| Phase | Deliverable |
|---|---|
| 3a | Pure `shouldArmHybrid` + unit tests in `@ponswarp/core` or `@ponswarp/webrtc` |
| 3b | Caps exchange over signaling (`HYBRID_CAPS` / session join fields) |
| 3c | Optional HTTP upload/download adapter interface (injectable; no hard cloud vendor) |
| 3d | Receiver dual-path: merge hybrid pieces into PieceManager with same verify path |
| 3e | Metrics: arm reason, bytes via hybrid vs webrtc |

---

## 7. Package placement

| Component | Package |
|---|---|
| `shouldArmHybrid` pure policy | `@ponswarp/core` (no DOM/fetch) |
| HTTP adapter interface | `@ponswarp/core` ports |
| Browser fetch implementation | `apps/demo` or thin `@ponswarp/hybrid` later |
| Caps on signaling | `@ponswarp/signaling` message validation |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Cloud cost / abuse | compile flag off by default; minBytes; rate limits |
| LAN accidental hybrid | host/srflx default off unless slow |
| Double-download waste | cancel hybrid when WebRTC finishes piece first |
| Privacy | document that assist leaves peer path; optional only |

---

## 9. Tests

- Table-driven `shouldArmHybrid` for every branch above.
- Caps missing / cloud off never arms.
- Force arm only when other prerequisites pass (or document force bypasses path only).

---

## 10. Success criteria (phase-3a minimum)

- [ ] Pure policy module + tests.
- [ ] Documented defaults copied from current ponswarp constants at implement time.
- [ ] No production path arms hybrid without explicit compile flag.

## Implementation status

Landed 2026-07-17 in monorepo unit tests. See package tests for `shouldArmHybrid`.
