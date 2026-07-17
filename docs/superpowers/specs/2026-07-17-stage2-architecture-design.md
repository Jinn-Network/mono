# Stage 2 Architecture Design — packages, evidence, attribution contract

- **Version:** 0.1
- **Date:** 2026-07-17
- **Author:** Ritsu (Stage 2 design session C, Claude Fable 5)
- **Shape:** `design` — output is this spec; implementation lands as Issues filed by the meta session
- **Parent:** `docs/superpowers/briefs/2026-07-17-session-c-architecture.md` under
  `docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md`; roadmap
  `docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md` §Stage 2; amends the
  Stage 1 package architecture (`docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-package-architecture.md`),
  whose §1 named approach B (full extraction) as this spec's subject.
- **Grounding:** four investigation fan-outs on 2026-07-17 (dependency graph, evidence-store
  inventory, real local episode data, debt-issue triage) plus hand verification; the operator
  approved each design decision in-session. Working assumptions W1–W4 per the framing packet.

## 1. Scope

Three pillars, one architecture: (1) the package-extraction end-state and its migration, (2) the
unified evidence architecture, (3) the attribution *contract* — the recorded facts and the claim
boundary, with attribution *mechanisms* explicitly re-shaped as feature work for the meta session
to sequence. This is not a program plan: phases and proposed issues below are design-granularity
inputs to the meta session, which owns filing and scheduling.

A live defect found during investigation is already filed as
[#1811](https://github.com/Jinn-Network/mono/issues/1811) (episode store unreadable: writer emits
`null` for `.optional()` strict-schema fields; `evidence.list()` silently drops every real
episode). Its lessons are folded into §3's contract policies; its fix is independent of the
refactor and should not wait for it.

## 2. The evidence rule: capture, derivation, or view

Generalizing DR-2026-07-14 (`log/decisions/2026-07-14-trajectory-is-the-transcript.md`) into the
storage rule the whole system follows:

> Every persisted byte of evidence is exactly one of: a **capture** (raw, at the trust boundary
> where it was produced), a **derivation** (typed, carrying the provenance of its parse —
> source format, parser name/version, writer build), or a **view** (rebuildable at any time from
> captures and derivations, never load-bearing). Each has exactly one home.

The verified inventory, classified (paths are defaults; owners cited from code):

| Store | Class | Home | Notes |
|---|---|---|---|
| Working-dir transcript streams (`.claude-code/stdout.jsonl` etc.) | capture | `~/.jinn-client/engine/work/<id>/` | reaped after terminal state; raw bytes survive in `system_snapshot` |
| `system_snapshot` tarball (in the signed envelope) | capture | IPFS artifact | scrubbed at tar-build; the durable raw home (DR-2026-07-14) |
| `jinn.trajectory.v1` | derivation | inside `jinn.execution.v1` | parsed at `pack()`; add-time + emit-time scrub |
| `jinn.execution.v1` signed envelope | canonical wrapper | IPFS + on-chain anchor | the network-canonical record of a solve/capture |
| `EpisodeV1` files | derivation (canonical local) | `~/.jinn-client/harness-layer/episodes/` | the interactive lane's one canonical store (§3) |
| Hermes captures tee (`CapturedTask` JSON) | duplicate capture | `~/.jinn-client/harness-layer/captures/` | **retires** (§3.2) |
| Daemon OTel captures (`pending_captures`/`capture_spans`) | capture | `~/.jinn-client/jinn.db` | marketplace-operator lane; **stays**, retirement path designed (§3.2) |
| Mineable contribution store | state machine | `~/.jinn-client/mineable/mineable-traces.json` | **slims** to a reference-only eligibility queue (§3.2) |
| Contribution ledger | receipt log | `~/.jinn-client/harness-layer/ledger.jsonl` | append-only receipts; unchanged |
| `envelope_projections`, `served_artifacts`, `network_artifacts`, `derived_trajectories`, `task_runs` | views / caches / operational | `~/.jinn-client/jinn.db` | distinct owners; not one logical store; unchanged by this design |
| Ponder execution ledger + enrichment table | view | indexer Postgres | rebuildable projection of chain + IPFS |
| Corpus-published evidence (`jinn.trace-envelope.v0` payload in a capture-role envelope) | derivation (network) | IPFS + anchor | target payload unification in §3.4 |
| `jinn.knowledge-packet.v1` | view (never stored) | computed at pickup | confirmed pure projection |
| Distill runs log, skills install registry, seed idempotency state | derived state | `~/.jinn-client/harness-layer/` | skill `provenance` pointer is the only skill→episode lineage today; the index (§3.1) makes lineage first-class |

Two policies the rule implies, both lessons paid for this week:

**Scrub topology (stated, not implicit).** Local stores are raw at rest *by design*: the privacy
boundary is the machine edge, and the one mandatory, fail-closed scrub gate is the outbound
`capture()` → `publish()` path (plus per-span add/emit scrub on the marketplace lane). The spec
makes this the stated rule; the known exception to document and fix in place is
`served_artifacts` storing unscrubbed bytes in non-donation mode (marketplace lane; unchanged
behavior, now stated).

**Read-tolerance and writer provenance (the #1811 policy).** Schemas are strict on write,
tolerant on read: literal `null` on an optional field reads as absent; unknown fields pass
through on wire envelopes (today's `strictObject` on the wire means *additive* evolution breaks
old readers — the same failure shape as #1811). Every persisted record carries a writer stamp
(producing package + version/build). Read paths never silently drop: unreadable records are
counted and surfaced (a doctor-check primitive — A-seam). The process contract stays **v1** with
this compatibility rule stated: additive-with-defaults changes do not bump; semantic changes do.

## 3. Unified evidence architecture

### 3.1 Decision: federated stores, one derived index, files canonical

**Federated-with-one-index**, not one store. Captures legitimately live in different trust and
durability domains (working dir, IPFS, chain, local disk); the accidental part was overlapping
local stores and the absence of any unified view. Concretely:

- **`EpisodeV1` files remain the canonical local evidence home** — one JSON file per episode,
  raw at rest, strict-written, tolerant-read.
- **One machine-local evidence index** — SQLite, WAL, owned by the extracted core package (§4),
  openable concurrently by the short-lived `jinn-layer` process and the daemon. **No daemon
  requirement**: the plugin lifecycle must work with no daemon installed (local-floor
  principle). The index is a **view**: rebuildable from the stores at any time (`reindex`), so
  it carries no migration burden and can be deleted without data loss.
- The index knows: every episode (with its activity, outcome, origin facts), every envelope this
  operator produced or fetched (`envelope_projections` remains its marketplace-side input),
  contribution queue state, distill runs and produced skills, and the lineage edges
  (`providedRefs` episode→record, skill→source episodes, episode→mint→published evidence).
  History, explain, the distiller, harvest, and attribution analytics all query the index
  instead of walking directories.

### 3.2 The store collapse

- **Hermes captures tee retires.** Its only live consumer is the rung-1 distill loader; the
  distiller repoints to the episode store (episodes are a superset of `CapturedTask`). Legacy
  files remain readable during a deprecation window; the tee write in `distill.py` is removed.
- **Mineable contribution store slims to a reference-only eligibility queue.** It already keys
  by `episodeId`; the duplicated content (the 34KB diff observed live) is replaced by the
  episode reference plus eligibility state. W1 "parked" for this design means exactly: the queue
  keeps recording, its outbound consumer is off, surfaces hidden, no divergent second store.
- **The daemon OTel captures lane stays, with a designed retirement.** It feeds the operator
  dashboard Captures tab and the publish drain, and the process contract has exactly one wired
  host today (Hermes — verified: no Claude Code/Codex path invokes `jinn-layer session end`;
  `install-hooks` wires the older stop-hook lane). When non-Hermes host adapters arrive
  (Stage 3+, a non-goal here), they write episodes through the process contract and the old lane
  retires; the design requirement now is only that nothing new couples to it.

### 3.3 Evidence contract v1.1 — additive schema deltas

All additive-with-defaults (contract stays v1 per §2). These are *facts recorded truthfully*,
posture-agnostic; no field presumes any particular measurement mechanism exists.

| Field | Where | Why |
|---|---|---|
| `session.kind: 'user' \| 'host-internal'` + `session.parentSessionId?` | episode | #1799: Hermes background-review forks share the parent `session_id` and today produce indistinguishable sibling episodes and duplicate mint candidates (verified live: 18 files → 11 unique sessionIds). Hosts declare fork identity through the process contract; internal sessions become linked children, excluded from contribution candidacy and from default history/analytics populations. |
| `origin: { writer, build }` + record-level writer stamp | episode (and wire envelopes) | #1811: installed-build drift produced unreadable files invisibly; synthetic smoke traffic (three days of `s1`/`sA` fixtures) is indistinguishable from real sessions in the shared homedir store. |
| `task.repositorySlug?` | episode | stratification and honest population definition; today only the contribution candidate carries it. |
| `outcome.acceptedDiff?: boolean`, `outcome.testRuns?: { passed, failed }` | episode | the observable outcome record. Verified reality: `outcome.status` and `verifiabilityTier` have zero variance across all real episodes — no analysis can use them. Accepted-diff is already computed for eligibility; test-run extraction already exists in `session_bridge`. |
| `activity.retrievalFired`, `activity.eligibleRefs[]`, `activity.deliveredRefs[]`, `activity.deliveryMode: 'delivered' \| 'disabled' \| 'degraded' \| 'withheld'`, `activity.deliveredContentHash?` | episode | the eligibility/delivery split. Subsumes #1800 (what the model actually received becomes a recorded fact — hash plus retained bytes ref); `providedRefs` is retained as an alias for `deliveredRefs` on read. `'withheld'` exists as a value so any future measurement design plugs in without re-migration; nothing in this spec turns it on. |
| `cost.tokens` verify | episode | wiring exists (`_on_post_llm_call`, mono #1662) but 0% of real episodes carry tokens — repair the host-side reporting, don't redesign. |

**Test-sandboxing convention:** any suite or script that exercises session persistence MUST set
`JINN_LAYER_EPISODES_DIR` (and sibling env overrides) to a temp dir. The operator's real store
contains three days of fixture pollution because this was convention-less. Enforcement: a lint
in the plugin/layer test setup that fails when the default store paths are writable targets.

### 3.4 Local and public share the contract

Target: the published evidence record's payload becomes **`jinn.episode.v1`** (a scrubbed,
seed/mint-provenance projection of the local episode — same schema, different scrub and
retention), making the roadmap's "stable canonical evidence contract shared by local and public
knowledge" literal. `jinn.trace-envelope.v0` freezes as the read-compat legacy payload (the
corpus keeps serving existing records; the knowledge-packet projector accepts both).

This wire-format migration is **gated on B's field-level training-readiness requirements**
(B↔C seam: B states what SFT / Agent SFT / RLVR / preference-optimization consumers need; those
fields land in the episode schema in the same change). W2's retrieval-visibility tier flag rides
record metadata and survives this unification — C guarantees the mechanics once B specifies the
rule. If B's requirements slip, the local goals of §3.1–3.3 are unaffected; the payload
unification slides without harm (see Would renegotiate).

### 3.5 Migration of existing data

The index is derived, so data migration is `reindex` plus store repair, one shot:

1. Null-quartet files (18 on the operator machine) become readable via §2 read-tolerance; an
   optional repair pass rewrites them clean (#1811's fix owns this).
2. The 23 misnamed `*.json` episode files (invisible to `list()` today) are rescued by the
   reindex scan accepting both patterns, then normalized to `*.episode.json`.
3. Legacy unstamped files index as `origin: 'legacy-unstamped'`; population filters treat them
   accordingly (synthetic fixtures are excluded by heuristic at reindex, recorded, reversible).
4. The declared retention policy (newest 200, enforced since the rescope) applies unchanged.

## 4. Package end-state

### 4.1 Decision

**Approach B — product core + shared local core + publishable layer.** Rejected: **A** (one big
layer package the daemon also depends on — inverts sense: the daemon needs scrub/corpus-read but
not distillation or a CLI; couples daemon releases to layer releases, recreating the #1797 class
in mirror form) and **C** (maximal decomposition — package/CI overhead with no consumer needing
the finer split).

Verified starting facts that shape this: the repo is independent yarn projects (no root
workspace); `harness-layer` declares **zero dependencies** (parasitic on client hoisting); the
daemon links the plugin package only at schema level (via an esbuild-bundled
`contribution-store` artifact it constructs unconditionally) while `createJinnPlugin` /
`PluginSession` are linked only by the `jinn-layer` CLI; harness-layer's mass is roughly five
true adapters over `client/src` machinery plus a large self-contained body (distillation
subsystem, contribution store, process contract, trace envelope, bridge, measurement, skill
packaging, seed-import) plus the 2,206-line `cli.ts`; and the `jinn-layer` bin needs a bespoke
bundler precisely because harness-layer reaches back into `client/src`.

### 4.2 The packages

| Package | Contents | Depends on | Published |
|---|---|---|---|
| `@jinn-network/plugin` (`packages/plugin`) | unchanged: product core, contracts, workflow | `zod` | yes (new) |
| `@jinn-network/core` (`packages/core`, name open — "local implementation of roadmap Jinn-Core primitives"; alternatives `evidence`, `substrate` noted, `substrate` overloaded) | evidence store + index (§3.1), contribution store, scrub pipeline, corpus-read (discovery client, IPFS fetch, cache, capture-meta search), trajectory schema + transcript parsers | `plugin` (schemas), `zod`, SQLite driver | yes (new) |
| `@jinn-network/jinn-layer` (`packages/layer`) | `jinn-layer` bin, process contract, port adapters (bindings core→plugin ports), distillation subsystem, seed-import, CLI | `plugin`, `core` | yes (new) — the bin **leaves** `@jinn-network/client` |
| `@jinn-network/client` | daemon loops, engine, mech adapter, wallet/earning, API/SPA/MCP, chain-writing publish/anchor (the layer stops linking wallet code; W1-parked outbound surfaces live behind the daemon/sidecar) | `core`, `plugin` (types), `sdk` | yes (as today) |

Dependency rule: `plugin ← core ← layer`; `client → { core, plugin, sdk }`; **nothing under
`packages/*` imports `client/src`**. The Python host adapter is unchanged except bin discovery
(A owns that UX; the contract handshake is untouched).

**What dies:** `client/scripts/bundle-jinn-layer.mjs` (the layer builds with plain `tsc` +
declared deps — this is the extraction's success criterion), the `dist/harness-layer/contribution-store.js`
esbuild artifact (the daemon imports `core` normally), the `DEFAULT_LOCAL_DISTIL_CAPTURES_DIR`
path-literal coupling in `client/src/captures/distil-export.ts`, and the
`client/packages/harness-layer` directory itself. `vendor-sdk.mjs` is an optional adjacent
cleanup (sdk already has public `publishConfig`), not required by this design.

### 4.3 Boundary enforcement (carried forward from Stage 1 §7, extended)

1. **Physical:** each package a real yarn project with a complete dependency manifest
   (harness-layer's empty manifest is the anti-pattern).
2. **Architecture tests:** the existing forbidden-imports and exports-map test pattern
   (`packages/plugin/test/architecture/`) replicated per package with per-package forbidden
   lists (`core`: no wallet, no chain-write, no MCP, no `client/src`; `layer`: no `client/src`).
3. **CI:** per-package paths-filtered workflows plus **client-compat jobs** for every package the
   client consumes (makes #1754's ask structural), and per-package canary publish workflows —
   a plugin-only merge publishes the layer artifact directly, ending the #1797 class (the client
   no longer bundles the layer at all).
4. **Success criterion:** `packages/layer` builds and publishes with plain `tsc`; no bespoke
   bundler anywhere in the lane.

## 5. Attribution: the contract and the claim boundary

Scope decision (operator-ratified): attribution *mechanisms* are feature work, not refactoring.
This spec owns (a) the recorded facts — §3.3's posture-agnostic instrumentation — and (b) the
claim-boundary policy below. Mechanisms (randomized holdback, marketplace measurement arms, any
feedback verb, claim-rendering surfaces) appear only as `feat`/`spike`-shaped proposed issues.

Verified reality motivating the split: 10 real sessions over ~1.5 days (the capture pipeline is
3 days old); `providedRefs` populated in 4/10 but perfectly confounded with a same-morning build
boundary; zero variance in every outcome field; tokens 0%; `durationMs` the only varying signal.
No comparison is honestly supportable today; facts must exist before analytics.

**Claim-boundary policy** (the product may render, given what ran):

| Level | Precondition | Renderable language |
|---|---|---|
| Facts | always | per-session: searched, provided (delivered), refs, outcome facts |
| Descriptive | index populated, population filtered to `session.kind = 'user'` + real origin | aggregate counts with N shown; association wording only ("in N sessions where evidence was delivered, X") — never "helped" |
| Causal | a randomized instrument ran (delivery withheld at random within the retrieval-fired stratum, or controlled marketplace arms) meeting a preregistered bar | "helped / harmed / no difference," with design and N named |

Guards, stated once and inherited by any future mechanism: **one primary outcome** declared
before any run (recommended: completed-with-accepted-diff rate; test-pass rate where tests
exist); everything else exploratory; no per-packet / per-repo slicing until N supports it
(multiple-comparisons); fixed evaluation windows, no peeking-based stopping
(regression-to-the-mean); populations exclude `host-internal` and synthetic-origin records
(SUTVA/policy identity: the delivered-refs set is the content-addressed identity of the
intervention). Reuse `client/src/eval/paired.ts` / `wilson.ts`; build no new stats.

**Non-binding mechanism recommendation** (recorded for the meta session): the marketplace lane
is the *powered* instrument — corpus-autoload on/off arms over the existing three-arm
measurement machinery on verdict-grounded tasks — and is mostly ops over existing code; it is
the realistic satisfier of W4's "embeddings only with Stage 2 attribution evidence." The
interactive-lane randomized holdback is the *ecologically valid* instrument, months-scale at
dogfood rates, and should run (if ratified) as an operator-visible measurement mode, on for the
dogfooding operator only. Neither blocks nor is blocked by the refactor once §3.3 lands.

## 6. Stage-1 debt triage

Verified correction to the framing packet: **none of the listed debt issues is autopilot-bound**
— none is on the Jinn engineering board, none has an Issue Type, none has a PR (the dispatcher's
`selectReady` requires board + type + priority + unblocked). They are filed-only; the meta
session must triage whatever it keeps.

**Absorbed as design inputs (this spec):**
- **#1799** — `session.kind` + parent link + population rules (§3.3); the process contract gains
  the host-declared fork identity.
- **#1800** — the eligibility/delivery split + `deliveredContentHash` (§3.3).
- **#1811** (filed this session) — the read-tolerance + writer-stamp + surfaced-drop policies
  (§2); its fix is independent and urgent.

**Handed to the meta backlog as chores (independent of this architecture):**
- **#1792** content re-scoring — self-contained algorithm on the existing content-bearing
  `CorpusPort.get`; no schema change.
- **#1797** npm-publish path filter + silent publish failure — live operator-facing gap; worth
  fixing *before* the refactor starts (canary health during migration); the class is then ended
  structurally by §4.3.
- **#1754** plugin-ci client-compat job — mechanical now; §4.3 makes it structural.
- **#1783** flaky session-end-delegate test — pure test infra.
- **#1784 / #1776** — B's domain (seed scrub profile, corpus dedupe); noted, not triaged here.

## 7. Migration sequencing

Strangler-fig, stacked PRs (refactor shape). Each phase independently green and shippable; the
listed invariant is the phase's gate.

| Phase | Content | Invariant / gate |
|---|---|---|
| 0 | `harness-layer` gets a complete dependency manifest; boundary tests extended; golden-envelope fixture captured (byte-identical envelope assembly recorded as a regression fixture) | no behavior change; all suites green |
| 1 | `packages/core` scaffold; contribution store + evidence store move in; the evidence index built (§3.1); daemon re-points `MineableTraceStore` to `core` (esbuild artifact dies); evidence contract v1.1 deltas (§3.3) land in `plugin` schemas + writers | process contract responses unchanged (additive only); contract kits + cold-stock e2e green; reindex rebuilds identically twice |
| 2 | scrub + trajectory schema/parsers + corpus-read move to `core`; daemon and layer re-point | golden-envelope fixture byte-identical; pickup behavior unchanged (gate scenarios); no `client/src` import remains in moved code |
| 3 | `packages/layer` scaffold; process contract + adapters + distillation + seed-import + CLI move; plain-`tsc` build; independent publish workflows for `plugin`/`core`/`layer`; `jinn-layer` bin leaves the client package | fresh-machine `npm i -g @jinn-network/jinn-layer` + `contract --json` handshake passes; contract stays v1; #1797-class impossible by construction |
| 4 | delete `client/packages/harness-layer`; retire the Hermes captures tee (distiller reads episodes); slim the mineable store to references; store repair/reindex tooling ships (§3.5) | full Stage-1 walkthrough re-run passes on the extracted topology; no consumer of the retired tee remains |

**Concurrency constraints (for the meta session's train, with the colliding surfaces named):**

- **Phase 2 must not run concurrently with B's seed-lane implementation or #1792.** Shared
  files: `client/packages/harness-layer/src/seed-import/*` (imports the scrub pipeline being
  moved), `consume.ts` / corpus-read (the surface #1792 modifies).
- **Phase 3 must not run concurrently with A's doctor/install implementation.** Shared
  surfaces: `cli.ts` (verb dispatcher A's doctor extends), bin discovery
  (`$JINN_LAYER_BIN`/PATH conventions), the npm publish workflows, `onboarding.py`.
- **Schema-delta PRs serialize** on `packages/plugin/src/schemas/episode.ts` and
  `client/packages/harness-layer/src/process-contract.ts` — one train, no parallel writers
  (the Stage 1 rescope's convergent-file rule).
- #1811's fix and #1797 are deliberately *ahead of* Phase 1 (store readability and canary
  health during the migration).

## 8. Non-goals

- Multi-host adapters (Claude Code / Codex process-contract wiring) — Stage 3+; the daemon
  OTel captures lane's retirement waits for them (§3.2).
- Skills Hub, network distillation (rung 3), knowledge pricing, evaluator economics.
- Embeddings in retrieval — stays behind W4's evidence gate; this spec only makes the evidence
  producible.
- Un-parking outbound contribution (W1): the mint/publish lane keeps existing behind the ports
  and the daemon sidecar; no surfaces return in this scope.
- Attribution mechanisms (holdback, marketplace arms, feedback verb, claim rendering) — `feat`
  work, proposed below, not part of the refactor.
- SDK vendoring cleanup — optional adjacent improvement, explicitly not required.
- No new services, accounts, or telemetry.

## 9. Proposed issues (not filed — meta session reconciles and files)

| # | Title | Shape | Packages | Depends on | Effort |
|---|---|---|---|---|---|
| C1 | Harness-layer dependency manifest + extended boundary tests + golden-envelope fixture | refactor | harness-layer, client | — | Low |
| C2 | `packages/core` scaffold: contribution + evidence stores move, daemon re-point kills the esbuild artifact | refactor | core (new), client, harness-layer | C1 | High |
| C3 | Evidence contract v1.1: session.kind/parent, origin/writer stamp, outcome observables, eligibility/delivery split, repositorySlug (absorbs #1799 + #1800 design) | feat | plugin, harness-layer, jinn-agent | C1 (serialize on episode.ts with C2) | Medium |
| C4 | Machine-local evidence index + `reindex` + store repair/rescue (§3.5; coordinates with #1811's fix) | feat | core | C2 | Medium |
| C5 | Move scrub + trajectory + corpus-read into `core`; re-point daemon and layer | refactor | core, client, harness-layer | C2 | High |
| C6 | `packages/layer`: process contract + adapters + distill + seed-import + CLI; plain-tsc; independent publish (bin leaves client) | refactor | layer (new), client, core | C5 | High |
| C7 | Retire Hermes captures tee; distiller reads episodes; slim mineable store to references | refactor | layer, jinn-agent, client | C4, C6 | Medium |
| C8 | Delete `client/packages/harness-layer`; final consumer sweep | refactor | client | C6, C7 | Low |
| C9 | Tokens verify: host-reported usage actually lands in `cost.tokens` (mono #1662 wiring exists, 0% populated live) | fix | jinn-agent | — | Low |
| C10 | Test-sandbox enforcement: suites must override store env paths; lint + cleanup of fixture pollution | test | plugin, layer, jinn-agent | — | Low |
| C11 | Published-payload unification: `jinn.episode.v1` as the corpus evidence payload; `trace-envelope.v0` frozen read-compat | refactor | core, layer, indexer | C3 + **B's field requirements** (blocked: another track) | Medium |
| C12 | Marketplace attribution instrument: corpus-autoload on/off arms over the three-arm machinery (W4 evidence path) | spike | client | C3 | Medium |
| C13 | Interactive randomized-holdback measurement mode (operator-visible; posture decision at pickup) | feat | plugin, layer, jinn-agent | C3, C12 finding | Medium |
| C14 | Session-end feedback verb (optional supplement; analytics must not require it) | feat | jinn-agent, layer | C3 | Low |

Sequencing note for meta: C1→C2→C5→C6→C7→C8 is the refactor spine (serialized); C3/C4 ride
alongside after C1/C2 with the schema-file serialization rule; C9/C10 are independent and early;
C11 waits on B; C12–C14 are the post-refactor feature tier, prioritized separately.

## 10. Verification posture

The Stage 1 precedent stands: the walkthrough found nine defects CI could not see, and this
session's investigation found a live total read-path failure (#1811) that every green gate
missed. Gates are necessary, never sufficient.

- **Per phase:** all suites + port contract kits + the cold-stock e2e gate (updated paths) +
  the golden-envelope byte-identity fixture (Phases 2–3) + `reindex` idempotency (Phase 1 on).
- **Per phase, additionally: a live regression walkthrough by the operator on the real
  machine** — one real Hermes session end-to-end: episode written *and readable back*
  (`/jinn history` shows it — the #1811 lesson as a standing check), pickup provides against the
  seeded corpus, sharing-off proves zero outbound; plus the operator-app Captures surface for
  the daemon lane. Phase 3 adds the fresh-machine standalone install
  (`npm i -g @jinn-network/jinn-layer` → handshake → doctor-clean), coordinated with A's
  onboarding acceptance so one walkthrough serves both.
- **Final:** the full Stage-1 acceptance walkthrough re-run on the extracted topology before
  Phase 4 closes.

## Seams & assumptions register

**Assumes from other tracks**
- From **A**: the doctor's required check list and placement (C provides the primitives:
  contract handshake, readable-episode count, corpus reachability); the bin-discovery
  convention for a standalone `jinn-layer`; A's acceptance that the layer installs separately
  from the client (Phase 3 changes A's install story — coordinate before Phase 3 lands).
- From **B**: the field-level training-readiness checklist per consumer (SFT / Agent SFT /
  RLVR / preference optimization) — gates C11; the W2 retrieval-visibility rule (tag/flag
  semantics) so §3.4 carries it; B's seeding cadence, to schedule Phase 2 around the seed-lane
  files.
- From the **meta session**: triage of the chores this spec hands back (none is
  autopilot-bound today — verified); the decision on C13's measurement posture when it
  prioritizes the feature tier.

**Provides to other tracks**
- The evidence contract v1.1 field set (§3.3) — the schema B states requirements against and A
  renders from.
- The claim-boundary policy (§5) — the language rule for any surface that mentions efficacy.
- The guarantee that W2's tier flag survives unification as record metadata (§3.4).
- Process-contract stability: v1, additive rule, tolerant-read (§2) — A's doctor and install
  checks ride this unchanged.
- The standalone published `@jinn-network/jinn-layer` (Phase 3) — A's one-command install
  artifact; per-package canary workflows ending the #1797 class.
- The evidence index and its lineage edges — the substrate for history, attribution analytics,
  and B's distillation reads.

**Would renegotiate**
- **"Chores are autopilot-bound" (framing packet §Status of known chores):** verified false;
  either the meta session triages them onto the board or they will not move. Recommend the meta
  session own this explicitly.
- **Publication surface:** if operating five published packages proves too heavy, the fallback
  is layer-only publication with `core`/`plugin` inlined at build — but that re-introduces a
  bespoke bundler and single-sources the #1797 class rather than ending it; renegotiate only
  with that cost on the table.
- **C11 timing:** if B needs training fields on the wire sooner than the refactor spine allows,
  C11 can be pulled ahead of C6 (it depends only on C3); if B slips, C11 slides to Stage 3
  without harming the local architecture.
- **If W1 flips** (outbound contribution returns early): the reference-only mineable store and
  the daemon-side publish placement still hold; what returns is surfaces, not stores. The one
  placement C would revisit is whether scrubbed-publish moves from the daemon sidecar into
  `layer` for daemon-less publication — deferred until W1 actually flips.
