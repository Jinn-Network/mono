# EXPLORER-APP-SPEC

> Canonical specification of the network explorer — the read-only web surface anyone uses to see the state of the Jinn network.
>
> **What this doc is.** A model of *what* the explorer shows, *what* a viewer can do, and *how* the explorer surfaces things that need attention. Spec, not implementation. It is the sibling of [`../../../client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md) and follows the same modelling discipline. Changes go through CODEOWNERS review with a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions); see [`../../../spec/2026-04-28-canonical-docs.md`](../../../spec/2026-04-28-canonical-docs.md).
>
> **What this doc is not.** It is not an API contract, a screen wireframe, or a description of the indexer's ingestion pipeline. The read-side data contract lives in [`../../../spec/2026-05-11-discovery-api-and-shared-indexer.md`](../../../spec/2026-05-11-discovery-api-and-shared-indexer.md). Protocol roles live in [`../../../SPEC.md`](../../../SPEC.md). UI tokens and posture live in [`../../../BRAND.md`](../../../BRAND.md) and [`../../../DESIGN.md`](../../../DESIGN.md).

## 1. Modelling discipline

The explorer is a set of **surfaces** — top-level concepts a viewer works with. Each surface is described along four axes:

- **Static** — point-in-time values shown to the viewer.
- **Collections** — lists of data items the surface owns, with item shape, ordering, and pagination/filter rules.
- **Actions** — verbs the viewer can invoke against the surface.
- **State messages** — banners or notices the surface raises when it needs the viewer's attention (loading, empty, stale, error).

A spec field belongs to exactly one surface. If a field could plausibly belong to two, the model is wrong and needs reshape, not duplication.

**Divergence from the operator spec (deliberate).** The operator spec's second axis is **Streams** — append-only event series the operator subscribes to. The explorer is a **read-only** surface: it has no streams a viewer subscribes to, only **Collections** (sortable/paginated tables) refreshed by polling, with data freshness rendered in the shared Freshness surface (§2.2, §3.1). Static / Actions / State messages are identical to the operator spec. Actions on this surface never mutate on-chain state or move funds — the explorer holds no keys and signs nothing (§3.6).

This is **UI domain modelling** with a state-machine flavour. Adding a route, table, or query param without a corresponding field in this spec is a sign the spec is stale, not that the field is novel.

## 2. Surfaces

### 2.1 Chrome

The persistent shell: sticky header (logo, primary nav, search) plus the routing that switches the surface below it.

- **Static**
  - logo — Instrument Serif italic "jinn" + caps-mono "explorer"; links home
  - nav items — `Network` (`/`), `SolverNets` (`/solvernets`), `Operators` (`/operators`); active-route detection is exact for `/`, prefix-match for deeper paths
  - active route
- **Actions**
  - navigate — via nav item or logo
  - search — free-text jump to SolverNet / operator / block *(deferred; the box renders disabled with placeholder "Search SolverNet, operator, block… (⌘K)")*
- **State messages**
  - search deferred — the search box is present but not yet wired; informational
  - no such route — inline 404 for an unmatched path
- **Collections** — none

**Routes.** `/` → Network · `/solvernets` → SolverNets · `/solvernet/:cid` → SolverNet · `/operators` → Operators · `/operator/:addr` → Operator · `/explore/:cid` → redirect to `/solvernet/:cid` preserving the query string (back-compat) · fallback → 404.

### 2.2 Freshness

How current the indexed data is. A single cross-cutting surface rendered as the fixed footer (StatusBar), fed by the `FreshnessMeta` every view response carries (§3.1).

- **Static**
  - last indexed block (`lastIndexedBlock`; decimal-serialised bigint)
  - last indexed at (`lastIndexedAt`; ISO / relative)
  - blocks behind head (`behindHead: number | null`; null when the RPC is unavailable)
  - enrichment share (`enrichmentSharePct`; optional)
- **State messages**
  - behind head — rendered when `behindHead > 0`; escalates to a `WANE` warning chip above `BEHIND_HEAD_WARN_THRESHOLD` (100 blocks)
  - discovery degraded — `degraded` flag set; `WANE` chip
- **Actions** — none
- **Collections** — none

### 2.3 Network

Protocol-wide aggregates across every SolverNet and operator. The home surface.

- **Static**
  - headline rates — `resolvedRate`, `onChainResolvedRate` (envelope-truth vs on-chain raw; §3.2), both `number | null`
  - totals — `tasksPosted`, `tasksSettled`, `tasksRefunded`, `attempts`, `verdicts`, `verdictsPass`
  - `everAttemptedOperators` — distinct operators who ever attempted on this chain
  - `solverNetsRunning`
  - `mostRecentSettlementBlock` (`string | null`)
  - verdict consistency — `{ matched, disagreed, total, agreementShare }`
  - enrichment coverage — `{ enrichedAttempts, totalAttempts, share }`
- **Collections**
  - activity strip — 3 cells: `everAttemptedOperators`, `solverNetsRunning`, `mostRecentSettlementBlock`
  - composition — four rollups, each a list of `{ value, count, share }` sorted by count: `byMode`, `byHarness`, `byModel` (hidden until ≥1 real model name), `byPlugin`
- **Actions**
  - retry — re-fetch on error
  - raw toggle — `include=raw` opts out of the envelope-only filter (§3.2)
- **State messages**
  - loading — skeleton (two placeholder cards)
  - load failed — "Failed to load network stats." + Retry
- Hosts the **Corpus** summary card (§2.4).

### 2.4 Corpus

The network's accumulating body of contributed task-trace envelopes — the public good the loop produces. Distinct from Network aggregates (§2.3): Network counts on-chain task/verdict activity; Corpus is the contributed-envelope record and its content.

**Scope.** The **summary card** (clusters over enriched capture envelopes, seed-exclusion toggle) ships today as the "Distribution Signal" card on the Network view (#1314). Renaming/restructuring it to **Corpus** is [#1407](https://github.com/Jinn-Network/mono/issues/1407); the browsable **index + detail** views and the top-level tab are [#1406](https://github.com/Jinn-Network/mono/issues/1406). Fields below marked *(target)* are specified here so the model already reflects the intended state; they are not yet built.

- **Static**
  - total corpus items (`envelopeTotal`)
  - seeds-excluded count — imported seeds are excluded from every number by default and the excluded total is stated plainly
  - current seed filter — `envelope-only` (default) | `include-seeded`
- **Collections**
  - corpus clusters (summary card) — rows `{ cluster, envelopeCount, contributorCount, topTags[] }`, sorted by volume; low-volume clusters (< `LOW_VOLUME_THRESHOLD`) sectioned separately
  - corpus items *(target — #1406, index view)* — item shape `{ cid, summary, cluster/harness, tier, contributor, tools[], model, createdAt }`; newest-first; paginated consistent with §2.5/§2.7 tables
- **Actions**
  - toggle seed filter — `envelope-only` / `include-seeded`, folds seeds back in live
  - open item *(target)* — → detail
  - view full corpus *(target)* — summary card → the Corpus tab
  - follow IPFS ref *(target)* — external link to the envelope content
  - follow on-chain anchor *(target)* — external link to the Base Sepolia ERC-8004 tx on basescan
- **State messages**
  - empty — "No contributions yet — signal appears as the corpus grows."
  - loading / stale / error — shared with §3.1

**Corpus item (detail — target, #1406).** A single envelope at a stable URL (e.g. `/corpus/:cid`), deep-linkable from the CLI's `/jinn ledger` and `/jinn preview`.
- **Static** — full envelope: summary, model, tier (e.g. `user-accepted`), tags, contributor, tool steps/sequence, IPFS `ref`, on-chain `anchor`.
- **Actions** — open IPFS content, open basescan anchor, back to index.
- **Collections** — the tool steps of the trace.
- **State messages** — not-found (unknown CID), loading, error.

### 2.5 SolverNets

The roster of launched SolverNets. Distinct from §2.6: this is the list; §2.6 is one net's detail.

- **Static**
  - heading + count ("N indexed")
  - sort key / direction (URL state; §3.3)
- **Collections**
  - `SolverNetRow[]` — `{ cid, name, description, solverNetId, status ('launched'|'paused'|'retired'), launcherAgentId, statusUpdatedAt, tasksPosted, tasksSettled, attempts, verdicts, verdictsPass, resolvedRate, recentResolvedRateSeries[] }`
  - columns — SolverNet (link) · Status (chip) · Launcher (truncated) · Updated (relative) · Tasks · Settled · Attempts · Verdicts · Resolved (colour-coded: ≥0.9 green, <0.5 wane) · Trend (sparkline)
  - ordering — default `resolvedRate` desc, nulls last; header click toggles direction, new column resets to desc; sortable columns: Tasks, Attempts, Verdicts, Resolved, SolverNet
- **Actions**
  - open row → `/solvernet/:cid`
  - sort — change key / direction
- **State messages**
  - loading — roster skeleton
  - load failed — "Failed to load SolverNets." + Retry
  - empty — "No SolverNets indexed yet."

### 2.6 SolverNet

One SolverNet's detail: its learning curve, checkpoint lineage, freeze integrity, and leaderboards, sliced by a filter/group model (§3.3).

- **Static**
  - `cid`, name (or short CID), description, status chip, launcher link
  - hero KPI — resolved-rate, the surface's single gold emphasis (§3.5)
  - supporting KPIs — `tasksPosted`, `tasksSettled`, `attempts`, `verdicts`, `verdictsPass`
  - held-out slate version
- **Collections**
  - learning curve — `learningCurveBuckets[]` (`{ bucketStartBlock, total, pass, rate }`) or `learningCurveRolling[]`, or per-group `series[]` (up to 5, distinct non-gold colours)
  - checkpoint timeline — `{ checkpoints: CheckpointTimelineEntry[], note }` (per-tick enrichment status ok/failed/pending; hover shows version, code digest, frozen resolved-rate, held-out delta)
  - freeze integrity — `{ violations: FreezeViolation[], verifiedFrozenShare, frozenAttempts }`
  - leaderboards — `trainBoard` / `frozenBoard`, each `{ ranked[], lowVolume[] }`
  - Milestone-2 gate — conditional, only when `cid === MILESTONE2_MANIFEST_CID`; owns a pinned slice (harness=codex, model=gpt-5.4-mini, window=30)
- **Actions**
  - window — segmented control (20 / 30 / 50 / 100 / ALL)
  - group by — none / operator / harness / plugin / mode / model
  - filter — add (dimension → value popover) / remove (chip ×) across operator, harness, plugin, mode, model
  - raw toggle — `include=raw` (§3.2)
  - reset — atomic clear of all slice params
  - board select — train / frozen
  - curve mode — rolling / buckets (only when group = none)
  - legend click — tie a series to a filter
  - open — operator (from leaderboard) / SolverNets (back)
- **State messages**
  - loading — skeleton (headline + curve/timeline/integrity blocks)
  - load failed — "Unknown SolverNet or failed to load." + back to SolverNets

### 2.7 Operators

The roster of operators across all SolverNets. Distinct from §2.8: list vs one operator.

- **Static**
  - heading + subtitle
  - `activeOperators` (cleared the newest 6h OLAS bucket), `sustainedOperators` (cleared all 8 completed buckets), `operatorsAtMilestone3` (≥25 OLAS lifetime)
  - `activeWindow` — `{ startTs, endTs, blockSeconds, blockCount, requiredOlasPerBlock }`
- **Collections**
  - `ranked[]` / `lowVolume[]` (`LeaderboardRow`) split at `DEFAULT_MIN_VERDICTS` (5)
  - columns — # · Operator (link) · Active? · Activity (8 oldest-first 6h blocks, earned-any encoding) · Attempts · Settled · Verdicts (pass/total) · Resolved · Mode* · Harness* (\* shown only if ≥1 row carries it)
  - ordering — default `resolvedRate` desc, nulls last; sortable columns
- **Actions**
  - sort — key / direction
  - open row → `/operator/:addr`
- **State messages**
  - loading — roster skeleton
  - load failed — "Failed to load operators."
  - empty — empty roster

### 2.8 Operator

One operator's record across the SolverNets they've participated in.

- **Static**
  - `addr` (short, with copy affordance)
  - dominant mode / harness / solver-type chips
  - totals — `attempts`, `settledContribution`, `verdictsTotal`, `verdictsPass`, `resolvedRate` (gold hero; §3.5)
- **Collections**
  - per-SolverNet breakdown — `{ cid (link), status, attempts, settledContribution, verdictsPass / verdictsTotal, resolvedRate (colour-coded), modeBreakdown }`
- **Actions**
  - copy address
  - open row → `/solvernet/:cid`
- **State messages**
  - loading — header + KPI skeleton
  - unknown operator — an unrecognised address renders zeroed totals + empty breakdown (treated as no-data, not a hard 404)

## 3. Cross-cutting concerns

### 3.1 Freshness and liveness

Every view response carries `FreshnessMeta` (`lastIndexedBlock`, `lastIndexedAt`, `behindHead`). The §2.2 Freshness surface renders it once as the footer; individual surfaces do not each re-render freshness. Data refreshes by polling (react-query), not by a subscribed stream — hence Collections, not Streams (§1). `behindHead` and the `degraded` flag are the liveness signal; above `BEHIND_HEAD_WARN_THRESHOLD` (100 blocks) the footer warns.

### 3.2 Envelope-only vs raw

Every count-bearing endpoint applies the **envelope-only** filter by default: only verdicts with a matching evaluation envelope are counted, because the daemon's raw on-chain verdict code defaults to Pass and over-states resolution. Passing `include=raw` opts out to the raw on-chain counts. This governs `resolvedRate`, `verdictsPass`, and the enrichment-coverage numerator. The choice is a surface-level Action (raw toggle) on Network (§2.3) and SolverNet (§2.6). Contract: [`../../../spec/2026-05-11-discovery-api-and-shared-indexer.md`](../../../spec/2026-05-11-discovery-api-and-shared-indexer.md) §4.

### 3.3 URL is the state; the slice model

All viewer-adjustable state (sort, direction, window, group, filters, raw, bucket, curve mode, board) lives in the query string and is set via `history.replaceState` (no back-button pollution). This makes every explorer view deep-linkable and shareable — the property the CLI relies on to link into a corpus item (§2.4) or a SolverNet slice. The SolverNet detail's **slice** is the richest instance: `manifestDigest + group + filter[dim]=csv + include + bucket + window`, resolved by the `/explorer/slice` endpoint. Legacy `?k=N` migrates to `?window=N` once per mount. A degenerate group (grouping by a dimension already filtered to one value) auto-clears to `none`; the hero KPI always reflects the aggregate slice, never a single group.

### 3.4 Deep links and external links

Internal navigation uses the §2.1 routes; `/explore/:cid` preserves history deep-links. External links leave the explorer: a corpus item (§2.4) links to its IPFS content and its Base Sepolia ERC-8004 anchor on basescan. Constructing an explorer-or-basescan URL from a hash/CID is a single mapping concern, not a per-surface one — surfaces reference the mapping rather than baking literal URLs into their shapes.

### 3.5 One gold per surface

Each surface has exactly **one** gold (`--accent-gold`) hero KPI (BRAND.md; the received design system's One-Voice rule). Multi-series charts use sky / sky-muted / sage / rose / lilac — never gold. Gold stays reserved for single-point emphasis.

### 3.6 Read-only posture

The explorer holds no keys, signs nothing, and mutates no on-chain state. Every Action is a read, a view-state change, or an outbound link. This is the load-bearing distinction from the operator app (`OPERATOR-APP-SPEC.md`), whose Actions include on-chain mutations and fund movement. A proposed explorer Action that writes to a chain or a wallet is out of model.

### 3.7 Design tokens

Colours, type, spacing, radii, shadows, and motion are the design-system tokens, copied into `src/styles/` (`colors_and_type.css`, `foundations.css`, `app.css`) and consumed as CSS variables. They are not redefined here; see [`../../../DESIGN.md`](../../../DESIGN.md), [`../../../DESIGN.json`](../../../DESIGN.json), and `docs/design/jinn-design-system/`. The explorer's component vocabulary (`Card`, `DataTable`, `HBars`, `SegmentedControl`, `StatusChip`, `Kpi`, `Sparkline`, `Leaderboard`) is the reuse surface — new surfaces compose these, they do not reinvent primitives.

### 3.8 Chain scope

The explorer is pinned to `EXPLORER_CHAIN_ID` (Base Sepolia, 84532) for testnet. Mainnet scoping is deferred and will need an explicit revisit (do not assume single-chain).

## 4. Open questions

These are unresolved spec questions, not implementation TODOs.

- **Corpus item detail (#1406).** Which envelope fields render in the detail view, and whether the tool steps show raw (args/results, scrubbed) or a summarised sequence. Ties to the #1406 design pass.
- **Corpus as top-level nav.** Whether Corpus becomes a fourth primary nav item (#1406) or stays a Network-view card that links to a sub-route. The summary card (§2.4) and the tab may co-exist.
- **Wired search (§2.1).** The search box is deferred; its result model (what a "SolverNet, operator, block" hit resolves to) is unspecified.
- **Mainnet chain scope (§3.8).** Single-chain assumptions to unwind before a mainnet explorer.

---

**Out of scope.** The jinn-agent CLI first-run onboarding ([#1405](https://github.com/Jinn-Network/mono/issues/1405)) is a *different surface* — the terminal CLI, not this web explorer — and is not modelled here. It shares the corpus/ledger concepts but has its own (CLI) domain model.
