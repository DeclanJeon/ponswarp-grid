# Room-first mesh transfer (product path)

Status: Implemented in `apps/demo` product path  
Last updated: 2026-07-17

## Product contract

1. **Send** creates a **signaling socket room** (session) with file manifest, share **code**, **QR**, and **link**.
2. **Receive** via code / QR / `#/join/:sessionId` / `#/get/:code` **joins that room** over WebSocket.
3. On room join, the receiver **starts transfer immediately** (no extra “Download” confirm).
4. **Transfer mode by room membership:**
   - **1:1** (owner + single receiver): **direct** piece window to owner (`requestPieceWindow` / `DirectTransferController`).
   - **3+ peers in the room** (owner + ≥2 receivers, or multi-peer mesh): **grid** scheduler (`requestGridPieceWindow`) across room peers; fall back to owner direct if grid idles.
5. UI copy and surfaces describe **rooms**, not cloud storage.

## Signaling

- Owner: `CREATE_SESSION` with `mode: 'grid'` (room is mesh-capable; mode is room policy, not “force multi-source”).
- Receiver: `JOIN_SESSION` → `SESSION_JOINED` (manifest + peer list) → WebRTC mesh offers.
- Mesh glare avoidance: lexicographically lower `peerId` creates the offer toward higher `peerId`; receivers always offer toward owner.

## Receiver runtime

- Multi-`RTCPeerConnection` map (not a single owner PC).
- Tracks `roomPeerIds` from `SESSION_JOINED` / `PEER_JOINED` / `PEER_LEFT`.
- `useGrid()` when `roomPeerIds` excluding self has **≥ 2** members (owner + another peer).

## Non-goals

- Changing core piece hash / resume schema.
- Full BitTorrent choke; endgame remains engine-side as already implemented.
