# Network explorer — public leaderboard + activity aggregation over the Discovery substrate

- **Date:** 2026-05-12
- **Author:** Oak with Opus
- **Status:** Design draft — ready for review
- **Version:** 0.1
- **Bead:** `jinn-mono-ebu7.1` (design); epic `jinn-mono-ebu7`
- **Related:**
  - `spec/2026-05-11-discovery-api-and-shared-indexer.md` (the indexer + `DiscoveryAPI` this rides on)
  - `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §6 (frozen-state contract; train/frozen; `HarnessCheckpoint`; the inert `HarnessRollup` / `LanguageRollup` / `FreezeViolation` entities)
  - `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md` §3 (reputation payload v2 — `(implName, codeDigest, modeFlag)` surfaced on-chain for indexing)
  - `client/src/types/envelope.ts` (`jinn.execution.v1` — `solverType`, `executor.{implName,implVersion,codeDigest,plugins,mode,source}`, `sessionProvenance`)
  - `client/src/erc8004/identity.ts` (`ExecutionPayloadV2`; the "unlock the inert rollup entities" intent)
  - `docs/runbooks/swe-rebench-v2-public-testnet.md`, `docs/runbooks/launch-swe-rebench-v2.md` (the first SolverNet; `N_target_successes` etc.)
  - `BRAND.md`, `DESIGN.md`, `DESIGN.json`, `docs/design/jinn-design-system/project/ui_kits/explorer/` (visual canon + reference UI kit)
  - `jinn-mono-rdod` (the v1-scoped first instance — SWE-rebench v2), `jinn-mono-uy6v` (first public release; rdod is a release gate), `jinn-mono-xmq` (CLI aggregated history — adjacent)

---

## 1. Purpose

A public, **daemon-free** web surface that makes the Jinn network legible: what work the network has done and how operators and SolverNets perform — and, for SolverNets that define a score, **how a self-improving agent's performance is trending over successive tasks/iterations/checkpoints**. It reads off the privately-operated Ponder indexer shipped as `jinn-mono-280n` (`spec/2026-05-11-discovery-api-and-shared-indexer.md`), through a read surface shaped for aggregate queries — not by coupling to raw Ponder internals.

The Project boards show the plan; this shows the network actually working. It is also the first real external consumer of the indexer, and the thing that activates the harness/language/freeze rollup entities that the ERC-8004 payload-schema v2 work surfaced on-chain "for the subgraph to index" but that nothing consumes yet.

## 2. View scopes

Three scopes, each filterable/groupable by the dimensions in §4:

- **Network** — totals across everything: tasks posted / attempted / settled, JINN distributed (cumulative + recent rate), distinct active operators, number of SolverNets running, overall verdict-success rate, composition (share of attempts by harness / mode / model).
- **Per-SolverNet** — scoped to one `manifestCid`: that net's activity KPIs, plus — if the SolverNet defines a scoring metric — the **Learning panel** (§5) with operator leaderboards split train/frozen.
- **Per-operator** — one operator across the SolverNets they participate in: their scores, settled-task contribution, JINN earned, dominant harness/mode, per net.

**v1 (`jinn-mono-uy6v`) ships exactly one SolverNet — SWE-rebench v2.** At N=1 the Network view and the Per-SolverNet view are the same data; there is nothing to aggregate *across*. `jinn-mono-rdod` is precisely "this explorer, with the SolverNet filter pinned to SWE-rebench v2" — not a separate artifact. The multi-net pages (SolverNets index, cross-net operator leaderboard, network rollups that sum nets) are designed here but only have data to chew on once a second SolverNet exists; they land as a follow-up child. `jinn-mono-rdod` remains the tracking bead for the `uy6v` release gate and gains a dependency on the relevant explorer children.

`jinn-mono-xmq` (CLI aggregated history) is adjacent, not subsumed — different surface (one operator's own CLI history vs. the public web aggregate); may share the indexer as a data source later, nothing to resolve here.

## 3. Read path, deployable shape, hosting

**One indexer, one schema; two *shaped* read surfaces over it.** The daemon's `DiscoveryAPI` (`spec/2026-05-11-...` §5) stays daemon-shaped — "what is actionable for me, the operator daemon, right now": point lookups, operator-filtered, claim-window-windowed, polled constantly, latency-sensitive, narrow. The explorer gets a **sibling surface: aggregate JSON routes on the indexer service** — it does *not* extend `DiscoveryAPI`. Same source data (JinnRouter events + ERC-8004 metadata/reputation + distribution-contract events + IPFS-resident envelopes), genuinely different query shapes and consumers. The thing kept single is the **Ponder schema + handlers**; the read interfaces are thin and may differ. The ticket's "DiscoveryAPI only" relaxes to: *no coupling to raw Ponder/GraphQL internals — go through a shaped read surface.* The explorer JSON routes are that surface.

**The explorer ships inside `@jinn-network/indexer`.** The indexer is already a required, running service (privately operated by the daemon's current maintainer per `spec/2026-05-11-...` §8.1 — not protocol infrastructure). It already exposes HTTP and Ponder lets custom Hono routes mount alongside the auto-GraphQL endpoint. So the indexer package gains:

- the explorer **static SPA, served at `/`**;
- the **`/explorer/*` aggregate + faceted JSON routes**.

**One deployable — the one that already exists.** The "team-hosted canonical instance" is the maintainer's existing indexer instance; **anyone who runs `@jinn-network/indexer` serves an explorer for free**, and the static SPA can be pointed at any indexer URL. This matches "Jinn runs no runtime infrastructure for operators" (`spec/2026-05-08-vps-first-operator-deployment-design.md`) and the headless-brand posture (`BRAND.md`): the explorer is one narrative skin riding a participant-run service; another operator may re-skin their own. The operator app may *link out* to a canonical explorer URL; it does **not** embed it (embedding would re-introduce a daemon dependency and a second render path). SPA source lives in the repo under `packages/indexer/explorer/` (or `packages/explorer/` built into the indexer's static dir — pick at impl).

**No "RPC floor" for the explorer.** The on-chain `OnchainDiscoveryAPI` floor is a *daemon liveness* mechanism (keep the operator working during an indexer outage). A public dashboard has no such requirement: if the indexer is down, the explorer is down or stale, which is acceptable. The SPA shows a staleness banner with `lastIndexedBlock` / `updatedAt`. A direct-RPC fallback for the explorer is possible but slow and not worth it — explicitly deferred. (x402 never enters the picture — the explorer shows refs and counts, never gated bytes.)

**Caching/refresh.** Aggregate routes compute from Postgres on request with a short server-side cache (~30–60 s on the heavy rollups — leaderboards, learning curves; shorter or none on small KPI reads). Every response carries `lastIndexedBlock` + `updatedAt`. The SPA polls on a modest interval and renders the staleness state. Materialized rollup tables vs compute-on-read is an impl decision (default: compute-on-read; promote to materialized if the leaderboard/learning queries are too slow).

## 4. Data model — additive Ponder schema

The Ponder schema (`spec/2026-05-11-...` §7: four entities — `Task`, `Attempt`, `SolverNetManifest`, `Envelope`) grows **additively**. Nothing existing is renamed or restructured.

| Entity | Source | Powers |
|---|---|---|
| `Task`, `Attempt` *(existing)* | JinnRouter `TaskCreated/Finalized/Refunded`, `AttemptSubmitted/Resolved` | settled-task counts, distinct active operators, throughput, verdict-success rate (resolved-pass / total) |
| `SolverNetManifest` *(existing)* | `IdentityRegistry.MetadataSet` (`solvernet-manifest:*`) | SolverNets running, per-net scoping |
| `RewardDistribution` *(new)* | the four distribution-contract reward events (creation / restoration / outcome / evaluation) | JINN distributed — network / per-SolverNet / per-operator, cumulative + rate, per-channel split |
| `HarnessRun` / `HarnessRollup` *(new — activates the spec'd-but-inert entity)* | ERC-8004 reputation payload **v2** `(implName, codeDigest, modeFlag)` — surfaced on-chain *for this purpose* | per-attempt harness, harness identity (`codeDigest`), train/frozen mode, SolverType; checkpoint-lineage threads (codeDigest continuity) |
| `FreezeViolation` *(new — activates spec'd entity)* | derived: a `modeFlag=frozen` attempt whose `codeDigest` differs from the operator's established frozen digest for that SolverNet (`...agent-harness-solvernet...` §6.2 Layer 2) | freeze-integrity metric |
| `LanguageRollup` *(new — activates spec'd entity)* | programming language of the solved repo, where the SolverNet/task exposes it (SWE-rebench tasks are language-tagged) | success-rate by language |
| `HarnessCheckpoint` *(new)* | `HarnessCheckpoint` publication events / metadata (`...agent-harness-solvernet...` §6) | checkpoint timeline + per-checkpoint frozen-eval score; verified-frozen (source-bundle published) flag |
| `AttemptEnvelopeMeta` *(new — DEFERRED to a later child)* | IPFS-enrichment pass: fetch + parse the `jinn.execution.v1` envelope an attempt references | `executor.plugins[]`, `sessionProvenance.originatingTool` (≈ model/agent), `evidenceTier`, `executor.source` published flag |

**On-chain-derivable vs envelope-enrichment.** Harness, harness-version, mode, SolverType, codeDigest, language, reward amounts — all come **free from on-chain data** (no IPFS fetch). v1/rdod ships those. `plugins`, model/originating-tool, evidence-tier, source-published — only live in the off-chain envelope; populating them needs an IPFS-enrichment pass in the indexer (fetch+parse per attempt). Heavier; a fast-follow child; does **not** block `uy6v`.

## 5. The Learning panel (per-SolverNet, when a score is defined)

This is the part the explorer exists for: making "as your agent learns, the network learns" observable. SWE-rebench v2 is the first SolverNet to fill it in; the panel generalizes to any SolverNet that (a) defines a scoring metric and (b) has a frozen-eval task distribution.

**What "the score" is for SWE-rebench v2:** the evaluator runs the upstream SWE-rebench v2 test suite in Docker and emits a verdict — resolved / not-resolved. The SolverNet's quality metric is **resolved-rate**.

**The aggregate we keep improving** is *not* "tasks done" — it is the **best frozen-checkpoint resolved-rate**. The train/frozen split is the measurement instrument: train-mode operators (`claude-code-learner` with Improve+Memory active) accumulate state across tasks; that state is periodically pinned as a published `HarnessCheckpoint` and run in **frozen mode** (`modeFlag=1`, fixed `codeDigest`) against the eval distribution. Frozen-mode resolved-rate at a fixed `codeDigest` is a clean, comparable score. Checkpoint v2 should beat v1. The staircase of frozen-checkpoint scores over time *is* the self-improving agent getting better.

**Panel contents (per-SolverNet page = rdod, with the filter pinned to SWE-rebench v2):**

1. **Score, big** — current best frozen-checkpoint resolved-rate, with the delta vs the previous checkpoint.
2. **Learning curve** — x = tasks completed (toggle: iterations / wall-clock / checkpoint index); y = **rolling resolved-rate over the last K tasks** (K selector: 20 / 50 / 100 / all). One line per operator, or per checkpoint-lineage (codeDigest thread). Flat line = not learning; rising line = the loop works. This is the chart the whole explorer exists to make possible.
3. **Checkpoint timeline** — each published `HarnessCheckpoint` as a marker: its frozen-eval resolved-rate, n tasks, verified-frozen (source-bundle published — §6.2 Layer 4) or not. Click → checkpoint detail. The train-mode work *between* markers is what produced the lift.
4. **Train vs frozen leaderboards** — twin tables. Frozen = ranked checkpoints (the canonical "who's best"). Train = active learners, ranked by recent rolling resolved-rate. Min-attempts floor (§6). Low-volume operators in a separate "new / low-volume" strip with raw numbers, not ranked among leaders.
5. **Composition / activity (supporting, smaller)** — share of attempts by harness (`claude-code-learner` vs `codex-code-learner`) and mode; throughput; JINN distributed (per-channel split); `N_target_successes` saturation.
6. **Freeze integrity** — `FreezeViolation` count (target zero); verified-vs-unverified-frozen split.

**SolverNet without a defined score** → the panel degrades: headline = verdict-success rate, learning curve = rolling verdict-success rate, no checkpoint timeline, leaderboard ranks by verdict-success.

**Network-level headline at v1** = SWE-rebench v2's best frozen-checkpoint resolved-rate (one SolverNet). At N>1 there is no single cross-net score (SolverNets aren't comparable) — the Network view becomes a row per SolverNet, each with its own score + trend sparkline + a few KPIs.

## 6. Dimensions, leaderboards, faceting

The explorer is **faceted**, not a counter. Every aggregate view can be sliced / grouped / sorted by: **harness** (`implName`), **harness version** (`implVersion`), **mode** (train/frozen), **SolverType**, **language**, **evidence tier** (enrichment), **plugin** (enrichment), **model / originating-tool** (enrichment), **time window**.

**Leaderboard ranking** — quality-first by default: the SolverNet's own scoring metric where one is defined (e.g. SWE-rebench resolved-rate), else verdict-success rate. Throughput, settled tasks, JINN earned, dominant-harness are sortable columns but quality is the headline sort. Train and frozen are separate boards. **Small-sample guard:** operators below a minimum number of resolved attempts (`N` picked at impl, ~5–10) are listed but not ranked among leaders — they sit in a separate "new / low-volume" section with their raw numbers. (Considered and rejected for v1: Wilson lower-bound / Bayesian shrinkage as the sort key — more correct, more to explain in the UI; revisit if the simple threshold proves unsatisfying.)

**Visualizations** (all in the `DESIGN.md` idiom — see §7): activity-over-time as a stacked area by harness (or any facet); quality-by-dimension as a horizontal bar grouped by harness/model/language with the low-volume strip greyed; operator scatter — throughput (x) vs success-rate (y), dot colour = dominant harness, dot size = JINN earned, click → operator detail; "what's running" composition bar/table; JINN-flow cumulative line + per-channel stacked bar; freeze-integrity counts; the Learning panel of §5.

## 7. Visual — bound by `DESIGN.md` + `BRAND.md`

Built on the explorer UI kit (`docs/design/jinn-design-system/project/ui_kits/explorer/` — `Chrome` (TopNav, StatusBar with `lastIndexedBlock`/health), `Data` (KPI, KPIRow, tables, StatusChip), master-detail right pane for SolverNet/operator/checkpoint drill-in). Reuse the kit's components and tokens; don't redraw.

- **Charts are engineering diagrams, not dashboards.** Hairline 1px borders carry structure; **no gradient fills, no neon, no glow.** Series colours come from the fixed palette: sky `#7aa7dc` for primary structure; lamplight gold `#dcb866` as the *single* point of emphasis per surface (the Gold-as-Hint rule); `vow-green` / `wane` / `break-red` / `seer-violet` for status only, on stroke + text, never as filled backgrounds.
- **Type:** axis labels, legends, column headers in ALL-CAPS JetBrains Mono, `letter-spacing: 0.14em`; values in mono, sentence case. Instrument Serif only for page-level display headlines and the one `.wish`-style pull-quote if any. **No sans, ever. No emoji, ever.**
- **Cards/panels:** `bg-elevated` (`#142340`), 1px hairline (`#1f3a66`), 10px radius, 24px padding. **Never nest cards.** Status chips: pill radius, status colour on border + text only. No `--shadow-float` on resting chrome; no `backdrop-filter: blur()` on chrome.
- **Motion:** linear, or `cubic-bezier(0.4,0,0.2,1)` as the rare exception — no spring, bounce, or overshoot on chart transitions. The `.wish` slow-fade (≤600ms) is the only decorative motion.
- **Lexicon** holds (tasks ≈ wishes, evaluators ≈ seers, *scrying* for logs, *ether* for the network state) — **except drop the metaphor wherever JINN amounts / money are shown:** plain "JINN distributed", not vow-language (`BRAND.md` operational rule; `DESIGN.md` §6).
- **Headless note:** the explorer ships one narrative skin; the doc and the package README record that operators running their own indexer may re-skin their explorer per `BRAND.md` posture — protocol (the loop, the lexicon, the non-negotiables) fixed, visuals forkable.

## 8. Decision records to file

- **DR — explorer rides the indexer service (one deployable), not a separate static site.** The indexer is already a required running service; the explorer ships inside `@jinn-network/indexer` as the static SPA at `/` + `/explorer/*` JSON routes. Rationale: zero new infrastructure; consistent with "Jinn runs no runtime infra for operators" and the headless posture; anyone running the indexer serves an explorer.
- **DR — explorer reads via a sibling aggregate surface on the indexer, not via an extended `DiscoveryAPI`.** `DiscoveryAPI` stays daemon-shaped; the explorer's aggregate/faceted queries are a separate thin surface over the same Ponder schema. Rationale: genuinely different read concerns/consumers; keeping the schema single is the DRY invariant, not the interfaces; cramming aggregate leaderboard queries into `DiscoveryAPI` bloats an interface with a clear narrow job.
- **DR — leaderboard ranking is quality-first (SolverNet score → verdict-success fallback) with a min-attempts floor and a separate low-volume section.** Rejected for v1: Wilson/Bayesian shrinkage as the sort key.
- *(Recorded, not a fresh DR — already resolved in the `jinn-mono-ebu7` notes:)* rdod **is** the explorer at N=1 scope (the SolverNet filter pinned to SWE-rebench v2), not a separate thing to subsume.
- *(Recorded — partly a finding:)* the train/frozen split, harness identity, and checkpoint lineage are read from on-chain data (reputation payload v2 `modeFlag`/`implName`/`codeDigest` + `HarnessCheckpoint` events), **not** from operator-local config — the explorer activates the spec'd-but-inert `HarnessRollup` / `LanguageRollup` / `FreezeViolation` entities.

## 9. Open questions (carried into implementation)

1. **SWE-rebench eval/frozen task-split delineation** — exactly how the frozen-eval task distribution is delineated on-chain vs the train stream (the runbook's `N_target_successes` / `N_max_postings_per_task` generator config; commit `51f489ff`). Determines how the frozen-checkpoint score is computed. Confirm at impl of the Learning-panel child.
2. **On-chain → envelope link** for the IPFS-enrichment pass — which event/field carries the `jinn.execution.v1` envelope CID for a given attempt (the on-chain record carries `evidenceHash`, a keccak, not a CID). Confirm at impl of the enrichment child.
3. **`LanguageRollup` source** — does the SWE-rebench v2 task spec expose repo language somewhere the indexer sees on-chain, or does it need envelope enrichment? Confirm at impl.
4. **"Active operator" window** (rolling — e.g. ≥1 attempt in 30d — vs cumulative) and **min-attempts threshold value** — pin at impl.
5. **Materialized rollup tables vs compute-on-read** — decide when the leaderboard / learning-curve routes are built; default compute-on-read.
6. **`HarnessCheckpoint` publication surface** — confirm the exact event/metadata key the checkpoint timeline indexes (`...agent-harness-solvernet...` §6 references it; pin the concrete on-chain shape at impl).

## 10. Implementation children to file under `jinn-mono-ebu7`

- **ebu7.2 — Ponder schema additions.** `RewardDistribution`; `HarnessRun`/`HarnessRollup`; `FreezeViolation`; `LanguageRollup`; `HarnessCheckpoint` — entities + handlers, all on-chain-derivable (JinnRouter + ERC-8004 reputation payload v2 + distribution contracts + checkpoint events). Activates the spec'd-but-inert rollup entities. (`feat`.)
- **ebu7.3 — explorer read routes on the indexer.** `/explorer/network`, `/explorer/solvernets`, `/explorer/solvernet/:cid` (incl. the Learning-panel payloads — score, learning curve, checkpoint timeline), `/explorer/operators`, `/explorer/operator/:addr`; faceted filter/group/sort over the §6 dimensions; `lastIndexedBlock`/`updatedAt` plumbing; short server-side cache. (`feat`.)
- **ebu7.4 — explorer SPA (the rdod-shaped deliverable).** Network + Per-SolverNet views; the Learning panel (§5); faceted leaderboard (§6); the core visualizations (§6/§7); bound by `DESIGN.md`/`BRAND.md`; built on the explorer UI kit. Link `jinn-mono-rdod` and `jinn-mono-uy6v`; satisfies rdod's acceptance criteria once deployed with the SolverNet filter pinned to SWE-rebench v2. (`feat`.)
- **ebu7.5 — indexer serves the SPA + deploy doc.** `@jinn-network/indexer` serves the explorer static bundle at `/`; update `packages/indexer/deploy/README.md`. (`chore`/`feat`.)
- **ebu7.6 — IPFS envelope-enrichment pass.** `AttemptEnvelopeMeta` entity + enrichment handler; unlocks plugin / model / evidence-tier / source-published dimensions; explorer surfaces them. Does not block `uy6v`. (`feat`.)
- **ebu7.7 — multi-net generalization.** SolverNets index page; per-operator view; cross-net operator leaderboard; network rollups that sum nets. Lights up at N>1. (`feat`.)

Dependency shape: ebu7.2 → ebu7.3 → ebu7.4 → ebu7.5 (the rdod path, gating `uy6v`); ebu7.6 and ebu7.7 follow ebu7.4.
