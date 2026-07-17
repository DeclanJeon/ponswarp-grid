# Grid Scheduler & Endgame Design

Status: Design only (phase-2)  
Last updated: 2026-07-17  
Related: findings C (fixed), F, I, J in `docs/20-logic-algorithm-audit-scorecard.md`

---

## 1. Problem

`requestNextGridPiece` implements a single-piece schedule step with:

- rarity sort (now using full advertised provider counts — finding C fixed),
- peer health ranking,
- owner fallback,
- request leases,
- maxRequestsPerPeer.

Gaps vs BitTorrent / multi-source practice:

1. **No multi-peer fill loop** at engine level — callers must loop; CLI grid path is thin.
2. **No endgame** — last pieces can stall on one slow provider.
3. **`fromOffset` always 0** — partial piece resume unused.
4. **No cancel** message type for superseded endgame requests.

---

## 2. Goals

1. Document correct rarest-first invariants (post-fix C).
2. Add `requestGridPieceWindow` that fills up to N outstanding across peers.
3. Define endgame mode: when remaining pieces ≤ threshold, allow multi-provider requests for same piece with cancel-on-first-verify.
4. Optional partial piece resume via `fromOffset` when assembly can resume mid-piece.

---

## 3. Non-goals

- Tit-for-tat choke algorithm (optional later for fairness).
- Changing lease semantics for non-endgame.
- Wire protocol overhaul beyond optional `PIECE_CANCEL`.

---

## 4. Rarest-first invariants (normative)

For each missing piece index:

1. **rarityCount** = number of **advertised** non-owner providers with verified bit; if zero non-owner, use all providers (including owner).
2. Do **not** exclude busy peers from rarityCount (capacity filter only affects `rankProviders` eligibility).
3. Sort key order:
   1. Prefer pieces that currently have at least one **schedulable** non-owner provider.
   2. Lower rarityCount first.
   3. Lower retryCount first.
   4. Lower piece index (stable).
4. Provider pick: highest PeerHealth.score with owner penalty (−5), then lower active request count.

---

## 5. API: multi-peer window

```ts
interface GridWindowOptions extends GridScheduleOptions {
  /** Total outstanding grid requests for this file across peers. Default 1. */
  maxInFlightTotal?: number;
  /** Per-peer outstanding cap. Default maxRequestsPerPeer ?? 1. */
  maxInFlightPerPeer?: number;
}

async requestGridPieceWindow(
  fileId: FileId,
  options: GridWindowOptions
): Promise<GridScheduleResult[]>;
```

Behavior:

- Loop `requestNextGridPiece` until total outstanding ≥ maxInFlightTotal or idle/exhausted.
- Return only newly scheduled results.
- Respect leases and existing outstanding map.

---

## 6. Endgame mode

### Trigger

```ts
remainingMissing <= max(2, ceil(0.05 * pieceCount))
// or remainingMissing <= endgameMaxPieces (default 4)
```

### Behavior

1. For each remaining piece, may schedule **up to K providers** (default 2) concurrently.
2. On first `pieceVerified` for that index:
   - release other leases,
   - send `PIECE_CANCEL` to other providers if connected,
   - ignore late chunks for cancelled requestIds (tombstone).
3. Endgame must not exceed `maxInFlightTotal` global cap.

### New message (optional wire)

```ts
{ type: 'PIECE_CANCEL', fileId, pieceIndex, requestId }
```

Provider stops sending remaining chunks for that requestId. If wire freeze desired, phase-2a can tombstone locally without cancel message (waste bandwidth but correct).

---

## 7. Partial piece resume (`fromOffset`)

Today: `fromOffset: 0` always; receiver assembles full piece before verify.

Phase-2b (optional):

1. Persist incomplete assembly only if hash policy allows streaming (hard — SHA-256 of full piece).
2. Practical approach without protocol change: **do not** partial-resume mid-piece; only retry full piece. Mark finding I as **wontfix** unless piece-level streaming hash is introduced.
3. Recommended: keep `fromOffset` for future; document **no partial resume** until incremental piece hash exists.

**Decision for Grid v1.x:** I is deferred / wontfix under current integrity model. Endgame + multi-peer window deliver more value.

---

## 8. CLI / demo usage

```ts
while (!complete) {
  const scheduled = await engine.requestGridPieceWindow(fileId, {
    ownerPeerId,
    candidatePeers,
    maxInFlightTotal: 4,
    maxInFlightPerPeer: 2,
    requestLeaseMs: 15_000
  });
  await waitForProgress();
}
```

Direct owner path continues to use `requestPieceWindow` from `docs/19`.

---

## 9. Tests

| Case | Expect |
|---|---|
| Rarity uses advertised count when peer at maxRequests | rarer piece still preferred |
| Window schedules across two peers | two outstanding different indices |
| Endgame dual request | two requestIds same index; first verify cancels second |
| Lease expiry | piece returns to missing; health timeout |

---

## 10. File touch list (phase-2)

- `packages/core/src/index.ts` — window + endgame state
- `packages/core/test/*` — scheduler tests
- `packages/cli/src/cli-runtime.ts` — grid join loop
- `docs/04-protocol-spec.md` — if PIECE_CANCEL added

---

## 11. Success criteria

- [ ] `requestGridPieceWindow` tested.
- [ ] Endgame dual-fetch + tombstone tested.
- [ ] Finding C regression test locked in.
- [ ] `fromOffset` documented as deferred under whole-piece hash.

## Implementation status

Landed 2026-07-17 in monorepo unit tests. See package tests for `requestGridPieceWindow`.
