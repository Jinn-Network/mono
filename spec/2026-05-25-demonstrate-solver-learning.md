---
version: 1.0
date: 2026-05-25
author: oaksprout + claude
status: proposed
parent-epic: '#601 — EPIC: Demonstrate solver learning'
design-pass: '#602'
---

# Demonstrate solver learning — explorer engine + view reframe

The design-pass output for [#602](https://github.com/Jinn-Network/mono/issues/602), parented to [#601](https://github.com/Jinn-Network/mono/issues/601). Records the agreed shape; implementation children get filed against [#601](https://github.com/Jinn-Network/mono/issues/601) from §10.

## 1. Problem

The parent EPIC asks: *demonstrate that solvers in a SolverNet are improving — visibly, on-chain-verifiably, to a non-operator viewer of the public explorer.* The substrate is in place (network explorer SPA at [`packages/indexer/explorer/`](../packages/indexer/explorer/) shipped 2026-05-14; cross-operator donation production+consumption shipped Sprint 2). But two distinct problems prevent the explorer from telling the story honestly today:

**P1 — Contaminated historical data.** The on-chain `verdictCode` defaulted to `Pass(1)` for failed evaluations in the early-period daemon. The indexer fix that prefers envelope-truth (`actualPassed`) landed at commit `b56b9a34` on 2026-05-14. For verdicts before that, the indexer falls back to `verdictCode === 1` whenever no evaluator envelope is enriched — which reads as 100%. The learning curve visibly shows "started at 100%, declined to ~50%": **regression**, the opposite of the claim. See [`packages/indexer/src/api/explorer.ts:195-211`](../packages/indexer/src/api/explorer.ts) (`verdictTruth`) and lines 707-712 (the SolverNet bucket compute).

**P2 — Misleading aggregate framings.** `NetworkView`'s `resolvedRate` is computed across **all** SolverNets lumped together. SolverNet A at 60% and SolverNet B at 80% yield a weighted-mean network number that moves with the *mix* shifting, not with anyone actually improving. It's a roll-up summary presented as a score. The cross-SolverNet leaderboard in `OperatorsView` has the same regime-mixing problem.

Both have to be addressed before any "solvers are improving" claim survives a Legibility check (per [PRINCIPLES.md](../PRINCIPLES.md)).

## 2. First-principles framing

The unit-of-analysis where "learning" is coherent is the **SolverNet**: same task pool, same difficulty regime, same scoring rubric, so a curve over time compares to itself. Other dimensions (operator, harness, plugin, mode, model) are **groups within** a SolverNet — slicing them is meaningful because the regime is fixed.

Cross-SolverNet aggregations are only honest for quantities that survive regime-mixing: counts (distinct operators, JINN distributed, SolverNets running), lists, rosters, and per-entity breakdowns that preserve each SolverNet's number separately. **Cross-SolverNet *scores* and *curves* do not exist** — they're roll-ups, not measurements.

This splits the explorer into two distinct layers.

## 3. Architecture — two layers, not five views

### 3.1 Slice layer (the engine)

A parameterized data layer that **operates within one SolverNet at a time**. The engine accepts:

- `manifestDigest` — the SolverNet (required).
- `groupBy` ∈ `{none, operator, harness, plugin, mode, model}` — the dimension to split on.
- `filter` — any subset of dimensions, each as an allow-list of values (e.g. `{mode: ['train']}`, `{operator: ['0xabc…']}`).
- `includeUnenriched` — boolean, default `false`. Drops verdicts where `enrichmentStatus !== 'ok'`.
- `bucketSize` — `auto | per-block | per-day | per-week`.

Returns:
- `learningCurve` — series keyed by group value (one series when `groupBy = none`).
- `leaderboard` — train + frozen boards, filtered/grouped per params.
- `kpis` — attempts, verdicts, resolved rate, JINN earned for the slice.
- `enrichmentCoverage` — fraction of raw verdicts that passed the envelope filter; surfaced as the trust metric regardless of `includeUnenriched`.

Rendering reuses the existing `LearningCurve`, `Leaderboard`, `Kpi`, `Sparkline` components — they remain agnostic to the parameter system; they render whatever data they receive.

**Cross-SolverNet comparison is out of scope** (YAGNI per §9). The engine never operates on more than one SolverNet at a time.

### 3.2 Digest layer (cross-SolverNet)

Lists and counts only. **No curves. No roll-up scores.**

- `NetworkView` — network-level facts (distinct operators, JINN distributed, SolverNets running, most-recent settlement block) + a digest list of SolverNets, each carrying its own per-SolverNet resolved rate and sparkline.
- `OperatorsView` — roster of who's participated, not a leaderboard. Each row links to `OperatorView` for the per-SolverNet breakdown.
- `OperatorView` — already correctly shaped (`OperatorPerSolverNet[]`); each row keeps its SolverNet's rate separate.

The digest layer does not share query code with the engine. It shares *components* (`Kpi`, `Card`, `Sparkline`) but not query logic.

## 4. The data fix — envelope-only by default

The engine's default behaviour is **envelope-only**: `WHERE enrichmentStatus = 'ok'`. Unenriched verdicts drop from the curve, the leaderboard, and the KPI counts. The dropped fraction surfaces as `1 - enrichmentCoverage` so a viewer can always see how much of the raw data is being trusted.

A `?include=raw` URL parameter (or an in-control-surface toggle) flips the engine to permissive mode for inspection. When raw mode is active, the surface is marked with a `wane`-bordered chip reading `INCLUDES RAW DATA` (status-warning treatment per [`Design.md`](../Design.md) §2 Tertiary status; per the One-Voice Rule, this displaces the gold emphasis on that surface).

The same rule applies uniformly across every engine consumer — SolverNetView preset, `/explore`, and any future engine consumer. There is one filter, one default, one place to change it.

## 5. Per-view roles after the reframe

### 5.1 `NetworkView` — digest, not score

Drops the "solve-rate hero" framing (PR #251 lead). Replaces it with:

- **Network facts card row.** Four `Kpi` panels: distinct operators, JINN distributed (operator + DAO split), SolverNets running, most-recent settlement block. JetBrains Mono values, ALL CAPS MONO eyebrow labels per [`Design.md`](../Design.md) §3.
- **SolverNet digest list.** One row per SolverNet, carrying its name, status chip, attempts, resolvedRate (per-SolverNet, honest), and the trailing sparkline already shipped under ebu7.7. Each row links to `SolverNetView`.
- **Composition facets stay** but framed as digests (`composition.byMode` / `byHarness` / `byModel` / `byPlugin` from `NetworkResponse`), with the eyebrow `NETWORK COMPOSITION` to make the aggregation framing explicit.

The top-line `resolvedRate` field stays in `NetworkResponse` (back-compat) but is no longer rendered on the surface. A future deprecation can drop it from the API.

### 5.2 `SolverNetView` — preset engine consumer

Becomes the engine's default-params view. Default params: `{groupBy: 'none', filter: {}, includeUnenriched: false, bucketSize: 'auto'}`. The existing train/frozen leaderboards remain — they map to the engine's mode-filtered slices. The checkpoint timeline, freeze integrity, and KPI panels stay unchanged. The visible difference is purely the cleaned curve (envelope-only by default).

Adds an `Explore this slice ↗` affordance (sentence-case button per [`Design.md`](../Design.md) §3 "Labels-in-Caps, Actions-in-Sentence Rule") that opens `/explore` with the current params baked in.

### 5.3 `/explore` — engine with user-controlled params

New route, scoped to one SolverNet at a time. URL shape: `/explore/<manifestDigest>?group=<dim>&filter=<encoded>&include=raw&bucket=<size>`.

**Control surface** (rendered above the chart):

- **Background:** `bg-elevated` card (#142340) with 1px `border` hairline, `panel` radius (10px) per [`Design.md`](../Design.md) §5 Cards.
- **Group-by selector:** a chip row labelled `GROUP BY` (ALL CAPS MONO 11px eyebrow). Options rendered as chips: `none / operator / harness / plugin / mode / model`. Selected chip: `chip-accent` (transparent + sky border + sky text). Unselected: default chip (hairline border + `fg-muted`). Per §3 The Two-Voices Rule — eyebrow labels in mono caps, never serif.
- **Active filter pills:** added by clicking a dimension's value in the chart legend or leaderboard. Render as `chip-accent` with a small `×` close affordance (Lucide `x` at `stroke-width="1.5"` per [`Design.md`](../Design.md) §5 Sigil-before-Lucide). ALL CAPS MONO label.
- **Raw toggle:** single switch chip, hidden by default. When active, renders with `wane` border + `wane` text + the literal string `INCLUDES RAW DATA`. Displaces gold emphasis on this surface per the One-Voice Rule.
- **Bucket size:** small dropdown input (`bg` fill, 1px hairline border, 6px `default` radius). Options: `auto / per-block / per-day / per-week`. ALL CAPS MONO option labels.

**Chart panel** (below the controls): existing `LearningCurve` component. When `groupBy !== 'none'`, renders up to 5 series. Series colors: sky (`#7aa7dc`) for the dominant series, then sky-muted variants. **Series colors never use gold** — gold remains reserved as single-point emphasis per the Gold-as-Hint Rule.

**Leaderboard panel** (right column): existing `Leaderboard` component, filtered to the slice's params.

**Header:** page title `Explore <SolverNet name>` in Instrument Serif (Headline, 48px). Subtitle in JetBrains Mono showing the active slice as a chip strip.

No gradients, no glass, no shadows beyond the `Card` hairline. Linear motion only on control-surface transitions per [`Design.md`](../Design.md) §1.

### 5.4 `OperatorsView` — roster, not leaderboard

Drops the cross-SolverNet rank ordering. Becomes a roster: one row per operator, with attempts count, JINN earned, and the SolverNets they've participated in (chip strip). No `resolvedRate` column at this level — that lives one click deeper at `OperatorView`. Removes the misleading "operator B is rank #1" framing that conflates regimes.

### 5.5 `OperatorView` — already correct

Already renders `perSolverNet: OperatorPerSolverNet[]` with each SolverNet's `resolvedRate` kept separate. No reframe needed. Future addition (not in this milestone): per-row "Explore this slice" link to `/explore/<cid>?filter[operator]=<addr>`.

## 6. Engine API sketch

A single new endpoint replaces the bespoke per-view query paths over time:

```
GET /explorer/slice
  ?manifestDigest=<cid>          (required)
  &group=<dim>                   (default: none)
  &filter[<dim>]=<value>,<value> (repeatable per dim)
  &includeUnenriched=<bool>      (default: false)
  &bucket=<size>                 (default: auto)
  &window=<n>                    (default: 50, range: 1..1000)
```

Returns:
```ts
interface SliceResponse extends FreshnessMeta {
  params: SliceParams;             // echo of resolved params (after defaults)
  enrichmentCoverage: number;      // 0..1, fraction of raw verdicts that pass the envelope filter
  kpis: {
    attempts: number;
    verdicts: number;
    verdictsPass: number;
    resolvedRate: number | null;
    jinnEarned: string;            // decimal string
  };
  series: SliceSeries[];           // 1 series when group=none; up to N when grouped
  leaderboard: {
    train: RankedLeaderboardRow[];
    frozen: RankedLeaderboardRow[];
  };
}

interface SliceSeries {
  groupValue: string | null;       // the dimension value (e.g. operator address) or null when group=none
  buckets: LearningCurveBucket[];
  // Trailing-window resolved-rate; entry[i] = mean of trailing min(window, i+1)
  // verdicts. Length equals the number of envelope-filtered verdicts for the
  // series. Window defaults to 50; clamped to [1, 1000].
  rolling: number[];
}
```

Existing endpoints (`/explorer/network`, `/explorer/solvernet/:cid`, `/explorer/operators`, `/explorer/operator/:addr`) stay live during the migration. `SolverNetView` migrates first as the engine's reference consumer. The legacy per-view endpoints can be retired once all curated views consume the engine.

## 7. Honest assessment of the limiting factor

Per [#602](https://github.com/Jinn-Network/mono/issues/602)'s acceptance criterion, the design pass must name where the gap actually lives. It's a mix of all three:

- **Data fidelity** — addressed by §4 (envelope-only filter as engine default).
- **Data continuity** — blocked by [#570](https://github.com/Jinn-Network/mono/issues/570) (vetted-pool stale) and [#578](https://github.com/Jinn-Network/mono/issues/578) (HF 429 drop). Both are sub-issues of [#601](https://github.com/Jinn-Network/mono/issues/601) and already on Sprint 3. **Without pool growth, the curve has no material to show "improving" on.** The data fix is necessary but not sufficient; the pool-growth fixes are co-required.
- **Presentation** — addressed by §3 (two-layer architecture), §5.1 (drop misleading network roll-up), §5.4 (drop misleading cross-SolverNet operator rank).

The milestone claim is therefore: *"on SWE-rebench v2, between block X and block Y (post-cutover, envelope-only), the SolverNet's resolved rate trended from A% to B% as the validated pool grew from N to M tasks. Independently verifiable at `/explorer/solvernet/<cid>` and at each verdict's IPFS-pinned envelope."*

## 8. Press-release-shaped acceptance

The artifact under §[`docs/press/`](../docs/press/) (per CLAUDE.md §External Communication) names the SolverNet, the period, the trend numbers, the IPFS CIDs of representative envelopes, and the on-chain tx hashes for verification. The explorer surface (cleaned + reframed) is the legible artifact a reader clicks through to verify the claim. No team narration required — the data plus the framing tell the story.

## 9. Out of scope (recorded for future)

- **Cross-SolverNet comparison mode in the engine** (e.g. overlaying SolverNet A and B's curves). YAGNI for this milestone; the claim is per-SolverNet specific. Adding multi-series support later is a small backend extension.
- **Donation-consumption attribution signal.** The cross-op donation flow is shipped but the indexer does not surface "this operator consumed donated artifacts." A future child of [#601](https://github.com/Jinn-Network/mono/issues/601) could add an indexer field marking consumption events; the chart could overlay a marker; the press claim could say *"Operator B's rate rose AFTER consuming CIDs from Operator A."* Strictly nice-to-have — the current SolverNet-level "improving" claim does not require it.
- **Dedicated per-operator learning-curve view.** Covered by `?group=operator` in the engine when needed. Adding it as its own route is duplication.
- **Cutover-block annotation on the chart.** With envelope-only as the default, the pre-cutover contaminated data simply doesn't render — no cutover marker is needed in the default view. If the raw-mode toggle reveals contaminated history, a `wane`-coloured cutover marker can be added later.

## 10. Implementation phasing

The spec is one design. The plan phases the work into three implementation children of [#601](https://github.com/Jinn-Network/mono/issues/601). Phases 1 and 2 are committed for **Sprint 3** (2026-05-25 → 2026-05-31); Phase 3 ships in a subsequent sprint. Each child gets its own implementation plan filed off this spec.

**Phase 1 — milestone-critical (Sprint 3).** `feat` shape.
- (P1a) Backend: add `enrichmentStatus = 'ok'` filter as the default in `verdictTruth`-using paths; add an `includeUnenriched` boolean param on `/explorer/solvernet/:cid` and `/explorer/network` for opt-in raw mode.
- (P1b) Frontend: `NetworkView` reframe — drop the headline `resolvedRate` hero; render the four network-facts KPIs + the SolverNet digest list. Composition facets stay, labelled as digests.
- (P1c) Frontend: `OperatorsView` reframe — drop the cross-SolverNet rank ordering; render as roster.

Phase 1 is the minimum surface for the press-release-shaped artifact. Co-required: [#570](https://github.com/Jinn-Network/mono/issues/570) + [#578](https://github.com/Jinn-Network/mono/issues/578) landing so the SolverNet's pool actually grows.

**Phase 2 — engine refactor (Sprint 3).** `refactor` shape; strangler-fig per the engineering handbook.
- (P2a) Backend: introduce `/explorer/slice` endpoint per §6. Old per-view endpoints stay live.
- (P2b) Frontend: refactor `SolverNetView` to consume `/explorer/slice` with default params. Components stay; only the data source changes.

**Phase 3 — `/explore` route (post-Sprint 3).** `feat` shape; depends on Phase 2.
- (P3a) Frontend: `/explore/<manifestDigest>` route with the control surface specified in §5.3.
- (P3b) Frontend: URL-state encoding for sharable slice links (extend `url-state.ts`).
- (P3c) Frontend: `Explore this slice ↗` affordance on `SolverNetView` and `OperatorView`.
- (P3d) Engine: add `window` URL param to `/explorer/slice` so the trailing-N
  rolling line is computed server-side from the chronologically-sorted samples
  rather than reconstructed client-side from buckets. Default 50, clamped to
  [1, 1000]. Single-call-site change in `computeOneSeries`.

## 11. Out-of-scope refactors not undertaken here

- The bespoke `bucketResolvedRate` / `rollingResolvedRate` helpers stay. The engine reuses them.
- The `harnessCheckpoint` + `freezeIntegrity` substrate stays as-is in `SolverNetView`. The engine doesn't need to absorb them.
- `NetworkResponse.resolvedRate` remains in the wire shape for back-compat; it's just no longer rendered. Deprecation is a future docs PR.

## 12. References

- Parent EPIC: [#601](https://github.com/Jinn-Network/mono/issues/601)
- Design pass issue: [#602](https://github.com/Jinn-Network/mono/issues/602)
- Network explorer shipped EPIC: [#166](https://github.com/Jinn-Network/mono/issues/166) (closed)
- Pool-growth blockers (sub-issues of #601): [#570](https://github.com/Jinn-Network/mono/issues/570), [#578](https://github.com/Jinn-Network/mono/issues/578)
- Validation capacity (Sprint 3): [#493](https://github.com/Jinn-Network/mono/issues/493)
- Phase A umbrella: [`spec/2026-04-30-phase-a-umbrella.md`](2026-04-30-phase-a-umbrella.md)
- Discovery API + shared indexer: [`spec/2026-05-11-discovery-api-and-shared-indexer.md`](2026-05-11-discovery-api-and-shared-indexer.md)
- Brand & design tokens: [`Design.md`](../Design.md), [`BRAND.md`](../BRAND.md), [`PRINCIPLES.md`](../PRINCIPLES.md)
- Envelope-truth indexer fix: commit `b56b9a34` (2026-05-14)
- Explorer surface: [`packages/indexer/explorer/`](../packages/indexer/explorer/)
- Envelope-truth bucket compute: [`packages/indexer/src/api/explorer.ts:195-211`](../packages/indexer/src/api/explorer.ts), lines 707-712
