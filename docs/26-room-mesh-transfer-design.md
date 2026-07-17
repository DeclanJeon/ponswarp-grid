# Room-first mesh transfer (product path)

Status: Implemented in `apps/demo` product path  
Last updated: 2026-07-17

## Product contract

1. **Send** creates a **signaling socket room** (session) with file manifest, share **code**, **QR**, and **link**.
2. **Receive** via code / QR / `#/join/:sessionId` / `#/get/:code` **joins that room** over WebSocket.
3. On room join, the receiver **starts transfer immediately** (no extra “Download” confirm).
4. On transfer complete, the browser **auto-starts a download** when a blob URL is available (Save again link remains as fallback).
5. **Transfer mode by room membership:**
   - **1:1** (owner + single receiver): **direct** piece window to owner (`requestPieceWindow` / `DirectTransferController`).
   - **3+ peers in the room** (owner + ≥2 receivers, or multi-peer mesh): **grid** scheduler (`requestGridPieceWindow`) across room peers; fall back to owner direct if grid idles.
6. UI copy and surfaces describe **rooms**, not cloud storage.

## What “grid” means here (not a permanent swarm)

Grid is **room-scoped multi-peer piece exchange**, not a long-lived public torrent network.

| Role | Must stay online? | Why |
|------|-------------------|-----|
| **Sender (owner)** | **Yes, until each receiver finishes** (or enough peers have full verified pieces) | Original file bytes live on the owner device. Coordinator/signaling does **not** store payload. |
| **Receiver** | Only while **they** are downloading | They pull pieces, verify, assemble, then can leave. |
| **Other receivers in same room** | Optional helpers while online | Once a receiver has verified pieces, it can advertise a `PIECE_MAP` and serve those pieces to later joiners in the **same room** (mesh). Leaving removes them as providers. |
| **grid.ponslink.com** | Server stays up | Signaling + ICE + share-code registry only. **Not** a file host. |

### Flow

```text
Owner tab open ──CREATE_SESSION──► Signaling room
Receiver opens link/code ──JOIN_SESSION──► same room
WebRTC DataChannels mesh (owner ↔ receivers, receiver ↔ receiver)
1:1  → direct piece requests to owner
N peers → rarest-first grid scheduler across room peers
Pieces → OPFS/IDB → verify → auto download
```

Users do **not** need to “live on the site forever.” They need the **relevant tabs open for that transfer session**. After download completes, closing is fine. A new share = a new room.

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
- Cloud payload hosting / offline owner seeding.
