# Active-operator surface — fix the "active" definition and the mint-time clock

- **Version:** 0.1 (draft for review)
- **Date:** 2026-06-01
- **Author:** Oak (drafted with Claude)
- **Issue:** #926 (spike) — "investigate: active-operator surface — is the M1 48h dashboard broken or just empty?"
- **Amends:** [`2026-05-30-active-operator-explorer-design.md`](2026-05-30-active-operator-explorer-design.md)
- **Related:** #927 (M1 recalibrated 2026-05-28 to a two-gate rule)

## TL;DR

The surface is **not broken** — it faithfully renders what it computes. But it conflates two
different questions under one word, and it reads the wrong clock. This spec splits the two
questions and moves the clock.

1. **`Active?` should mean "active now," not "sustained for 48h."** Today `Active? = Yes` only
   when an operator cleared the floor in **all 8** of the last completed 6-hour blocks. That is
   the Milestone-1 *sustained* measure wearing the *liveness* label. Redefine `Active?` to the
   **most-recent completed block** (recommended) — or a tolerant **N-of-8** — so the word matches
   the meaning.
2. **The 48h-sustained measure stays, but as its own readout** — a `blocksQualified / 8`
   progress fraction, not a hard count hidden behind a boolean.
3. **Clock on settlement time (L2), not mint time (L1 claim).** Bucketing by the
   `JinnDistributor.Claimed` block timestamp couples the surface to relayer/claim liveness: a
   relayer outage empties the window even while operators keep working, and a backlog catch-up
   can never refill the blocks where the work actually happened. (Larger change — see §4; can
   ship after §1–§2.)

## Evidence (the #926 finding)

Captured 2026-06-01 ~16:30–18:15 UTC against the live indexer
(`https://jinn-indexer-production.up.railway.app`):

- Indexer healthy and realtime on both chains (`ponder_sync_is_realtime{baseSepolia}=1`;
  footer `BLOCK 42,284,748 · JUST NOW`). Not an indexer-slice gap. Not a UI bug — the API
  itself returns `activeOperators: 0`.
- Whole pipeline confirmed live on-chain: operator daemon attempting (attempt at L2 block
  42284602, ~2 min behind head), launcher posting tasks (42284395), relayer minting on L1
  (claim at 18:10 UTC). Railway: `relayer`, `jinn-operator-claude-1/operator`, `jinn-indexer`
  all `SUCCESS`.
- The `JinnDistributor.Claimed` (L1) feed had **zero events for ~61h** (last pre-gap claim
  2026-05-30 03:43 UTC) because the relayer was down. On restart (16:34 UTC) it minted the
  entire backlog in one burst at 16:44–16:49 UTC.
- Because `claimedAtTimestamp` is the **L1 mint block time**, the whole backlog landed in a
  **single** 6-hour block. Live proof — the two working operators both read
  `recentBlocks = [. . . . . . . T]` (1 of 8). `activeOperators` is correctly `0`: the
  all-8 AND-gate cannot be satisfied while 7 blocks are empty, and those blocks never refill
  (the work they represent was minted "now," not then).

**Conclusion:** the data is the story, but the surface design makes it an unreliable readout —
it is hostage to relayer liveness, cannot self-heal after an outage for ~48h, and even in
steady state is brittle (one sub-floor block drops an operator).

## §1 — Redefine `Active?` (liveness)

Supersedes the original spec's "This definition is canonical for the word 'active' everywhere…
There is no second definition." There are two questions; this is the fix.

**`Active?` = operator cleared the per-block floor in the most-recent *completed* 6-hour block.**

- Recommended primary definition: **last completed block** ≥ floor. Simple, matches the word,
  shows `2` today.
- Optional tolerance: **≥ N of the last 8** (e.g. N=1 ⇒ "active in the last 48h"; N=6 ⇒ "mostly
  on"). A single tunable constant; pick during review. Last-block is N=1 restricted to the
  newest block — choose one.
- Caveat to surface in the tooltip: this is the last *completed* block (in-progress excluded),
  so it can reflect activity up to ~6h old. If truly-live is wanted, include the in-progress
  block for `Active?` only (keep it excluded from §2's sustained measure).

Backend: `computeActiveOperators` already returns `perOperator.{blocks, blocksQualified}`.
Add `activeLastBlock: boolean` (or `activeRecent` with the N threshold) to each per-row payload
and a top-level count. The all-8 `active` set stays for §2.

Frontend (`OperatorsView`): the `Active?` cell reads the new field. `Yes` in `--vow-green`,
`No` in `--break-red`, as today.

## §2 — Surface M1 progress as a fraction (sustained)

Keep the 48h-sustained measure — it *is* the M1 gate — but stop hiding it behind a boolean.

- Per-row: keep the `ACTIVITY BLOCKS` strip (`N N N N N N N Y`) — it already shows the history.
- Headline tile: change eyebrow `ACTIVE OPERATORS` from a hard count of all-8 operators to an
  **M1-progress** readout. Options: "`k` operators sustaining (≥2 with all 8 blocks)" plus the
  best-operator `blocksQualified/8`, or a small per-operator `7/8` badge. Decide during review.
- Align the floor with #927: M1 was recalibrated 2026-05-28 to a **per-block floor of ≥2 tJINN**
  (with ≥2 distinct operators) plus a **48h aggregate of ≥30 tJINN per operator**. The current
  `REQUIRED_TJINN_PER_BLOCK = 3` is the pre-recalibration literal. Move it to `2` and add the
  aggregate gate, coordinating with #927 so the dashboard and `check-milestone-1.ts` agree.

## §3 — Sequencing

- **§1 + §2 are a single small `fix` PR** (indexer payload fields + SPA column/tile + tests).
  Low risk, no schema change, immediately fixes the user-visible complaint ("`Active? No` for an
  operator that's earning right now"). This is the deliverable that closes #926.
- **§4 is a follow-up** (its own issue), gated on a design decision (below). It is the deeper
  fix but needs schema/indexing work and a call on the Legibility tension.

## §4 — Clock on settlement time, not mint time (follow-up)

**Problem:** qualification buckets on `rewardDistribution.claimedAtTimestamp` = the L1 mint
block time. Minting is a downstream, batched, **relayer-mediated** step. So the surface measures
relayer claim cadence, not operator activity. After any relayer gap the window empties even
though operators worked, and the backlog catch-up stamps "now" — it can never refill the blocks
where the work happened.

**Goal:** bucket each operator's earning into the 6-hour block of the **L2 settlement event**
that produced it (when the operator delivered the work), independent of when the relayer mints.

**Options (decide in the follow-up):**
- **A — attribute mint to L2 settlement time.** Index the L2 `ClaimTicket` (`TaskClaimEmitter`)
  block timestamp and join `claimId` → `rewardDistribution`, bucketing `operatorMinted` by the
  L2 time. Keeps tJINN as the unit; cost is the join + indexing the L2 emitter.
- **B — measure settled work directly on L2.** Define a block as "qualified" from L2 settlement
  events (delivery weight / count) rather than minted tJINN. Decouples fully from the distributor
  but diverges from the "tJINN earned" framing.

**Tension to resolve:** `check-milestone-1.ts` deliberately sources `JinnDistributor.Claimed`
because JINN is only *truly earned when minted* — the Legibility argument (PRINCIPLES.md). So the
**M1 gate** (§2) may legitimately stay mint-clocked, while the **`Active?` liveness signal** (§1)
moves to settlement-time. That split is the likely resolution: liveness = L2 work clock,
milestone = L1 mint clock, with relayer/mint lag shown as its own explicit indicator so a stalled
relayer reads as "claims behind," not "operators gone."

## Out of scope

- Changing the canonical M1 *definition* (owned by #927); this spec consumes it.
- Per-block `/operator/:addr` drill-down (already a noted follow-up in the original spec).
- Relayer reliability itself — the relayer is healthy; the 61h gap was a setup/migration window,
  not a defect. A separate "relayer liveness indicator" is proposed in §4, not a relayer fix.

## Testing

- `active-operators.test.ts` — add cases for `activeLastBlock` / `activeRecent(N)`: last-block
  clear ⇒ active, last-block empty but earlier blocks clear ⇒ not-last-block-active, N-of-8
  boundary.
- `explorer.test.ts` — assert the new per-row liveness field + the M1-progress field on
  `/operators` and `/network`.
- `OperatorsView.test.tsx` / `NetworkView.test.tsx` — assert `Active?` reflects last-block, the
  tile renders the progress fraction, tooltip copy updated.
