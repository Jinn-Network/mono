# Task Creator v0 — full implementation plan

Implements [spec/2026-07-08-task-creator-v0.md](../../spec/2026-07-08-task-creator-v0.md) (v0.3, PR [#1482](https://github.com/Jinn-Network/mono/pull/1482)). Work shape: each PR is a `feat` (TDD) targeting `next`. Phases 2+ are **gated** per the spec's ladder — planned here, built only when their gate pays.

## Reality corrections from code exploration (bind the plan, differ from spec §4.1's optimism)

- `computeEscrowWei` ([client/src/solver-types/_swe-rebench-v2-escrow.ts](../../client/src/solver-types/_swe-rebench-v2-escrow.ts)) is **test-only today**; production escrow is flat `deliveryRate` from the mech contract in `submitTask()`. D1 requires new wiring in `MechAdapter.postTask`/task build, not a config change.
- [client/src/solver-types/jinn-repo-extract.ts](../../client/src/solver-types/jinn-repo-extract.ts) emits `jinn-repo.v1` items (no image, no F2P/P2P, hardcoded to this repo). The commit-echo miner is a **new module** reusing its selection/git-extraction *patterns* (~30%), not a refactor of it.
- `MechAdapter.postTask` explicitly permits creator-claims-own-task; the `minter≠solver` / `sourceSolver≠solver` filters are net-new engine-side eligibility checks.
- `clusterEvidence`/`buildMetaClusters` ([client/packages/harness-layer/src/cluster.ts](../../client/packages/harness-layer/src/cluster.ts)) treat every `instanceId` as independent — echo instances with fresh IDs would falsely satisfy the ≥2-distinct-instance corroboration rule. Lineage collapse is required before any echo mint ships.

## Phase 0 — Rung 0: instruments, targeting, contract (unblocked; builds now)

### PR 0.1 — Negative-exemplar discrimination in admission (D3, AC #2)
- Extend `validatePoolInstances` ([client/src/solver-types/_swe-rebench-v2-validated-pool.ts](../../client/src/solver-types/_swe-rebench-v2-validated-pool.ts)): after the gold-patch run, grade a known-bad patch (empty patch first) — it must score 0.
- New `ValidatedPoolEntry` fields: `discrimination: 'pass' | 'fail' | 'unchecked'`. Policy per D3: `source: 'minted'` → hard-reject; benchmark pool → flag only.
- Flagged instances excluded from distillation input and from contested-band targeting.
- Stricter vetted-pool artifact re-publish rides the existing `shouldRepublishVettedPool` mtime path.

### PR 0.2 — Contested-band targeting comparator
- Wilson-interval informativeness ordering in `selectNextPostingCandidates`.

### PR 0.3 — Exemplar-pair yield metric
- `jinn solver-nets yield-report` subverb.

### PR 0.4 — Mineable-trace contract + two-tier consent (D2, AC #4)

### PR 0.5 — Process closures (AC #3)
- Anchor weak-suite rate; close #994 with DR.

## Phase 1 — Minting substrate

### PR 1.1 — `MintedPoolStore` + minted-rows artifact
### PR 1.2 — Row-routing `HfFetcher`
### PR 1.3 — `mint-tasks` CLI + gates (AC #5, AC #6)
### PR 1.4 — Generator union + posting guards (D1)
### AC #1 — amd64 gold-grade proof runbook

## Phase 2 — Rung 1: commit-echo miner (gated on three-arm measurement)

## Phase 3 — Rung 2: hunk-subset echo (gated on rung-1 yield + dogfood traces)

See the attached Cursor plan for full sequencing diagram and PR breakdown.
