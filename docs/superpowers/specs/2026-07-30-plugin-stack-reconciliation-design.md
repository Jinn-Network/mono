# Jinn Plugin Reconciliation — Disposition and the Clean-Slate Product

- **Version:** 0.1
- **Date:** 2026-07-30
- **Author:** Ritsu (design session, Claude Fable 5)
- **Status:** Draft — every material decision approved in-session (operator: Ritsu,
  2026-07-30); two fresh reviews (architecture + standards/adversarial) run on this written
  form with dispositions in §14; operator commit approval pending
- **Shape:** `design`
- **Scope:** the disposition of `packages/core`, `packages/layer`, `packages/plugin` (the
  pre-stack plugin lineage); the capability-ownership reconciliation against the merged
  stack (PR [#2292](https://github.com/Jinn-Network/mono/pull/2292)); the product scope and
  architecture of the clean-slate Jinn Plugin built stack-native in the integration branch;
  the install-channel and build-seam consequences; dated amendments to the superseded
  Stage 1/2 plugin designs
- **Out of scope:** the daemon cutover and its CLI re-keying (composition program); the
  public work client and `sdk` retirement (marketplace-surfaces session); executing any
  migration or retirement (PR trains under their own plans); protocol changes to any
  frozen record family
- **Depends on:** the platform architecture
  ([`2026-07-30-jinn-platform-architecture.md`](./2026-07-30-jinn-platform-architecture.md),
  DR-2026-07-30) — §7 assigns this disposition here; the operator-daemon composition design
  ([`2026-07-30-operator-daemon-composition-design.md`](./2026-07-30-operator-daemon-composition-design.md))
  — §12.2 hands this session the post-cutover tree and the plugin-content CLI's deeper
  disposition; the stack design principles
  ([`2026-07-30-stack-design-principles.md`](./2026-07-30-stack-design-principles.md));
  the consumption-boundary custody law
  (`2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md` §4.1, C1–C5)

## 1. Summary

Two lineages implement the same concerns. The plugin trio — `@jinn-network/core`,
`@jinn-network/jinn-layer`, `@jinn-network/plugin`, published at 0.1.2 — is a parallel,
earlier implementation of evidence capture, stores, corpus reads, scrub, and publication,
designed before the stack existed. The stack that merged in PR #2292 owns those concerns
now, conformance-kitted and guard-enforced. The two share **zero code**: no stack package
imports the trio, and the trio imports no stack package. Every reconciliation below is a
replacement decision, never an untangling.

The ruling (operator decision, this session): **clean-slate supersession, not migration.**
The trio is frozen as reference; nothing in it is ported. The Jinn Plugin is **redesigned
as a stack-native product in the integration branch** — a new top-level product tree
composed from the stack packages — and the capability gaps the old lineage papered over
are built in the stack trees that should own them, kit-first. The old architecture is
consulted as reference and mined for fixtures; its code does not migrate. This is the same
posture the composition design took for the venue adapters (fresh-rewrite, legacy behavior
as fixtures, §6.6 there), applied to a whole product.

The redesigned product's scope (operator decision): **capture + federated retrieval** —
the host-side integration that makes an interactive agent a first-class participant on the
evidence plane. It captures sessions as standard execution-evidence records into a local
archive, and retrieves relevant evidence into the agent's context from **both** planes:
the operator's own local archive and the public corpus (the platform's announced,
discovery-served record space — empty in this branch today; the product is wired to it so
it has value the moment content exists). Outbound publication, the task-mint lane, and
additional hosts are recorded extension points, not built. Distillation is **dropped from
the product scope** entirely.

## 2. Ground truth — what the research lanes established

Three read-only lanes (capability inventory, consumer census, stack-fit probe) ran against
worktree head `8c7179f2c` plus the extracted repositories. Facts load-bearing for the
decisions, each verified at code level:

1. **Zero coupling between the lineages.** `plugin` is a leaf (zod only); `core → plugin`;
   `layer → core + plugin`; no edge in either direction between the trio and
   `packages/{evidence,task-execution,discovery,trust,marketplace}`.
2. **The consumer census corrects the session prompt.** The extracted
   [`Jinn-Network/autopilot`](https://github.com/Jinn-Network/autopilot) imports **none**
   of the trio — its only Jinn package import is `@jinn-network/sdk/autopilot`, and the
   in-repo vendored copy enforces SDK-only with a boundary test
   (`packages/autopilot/test/marketplace-sdk-boundary.test.ts`). But it consumes the
   plugin stack through **three product channels**: `@jinn-network/client` 0.2.2 as a CLI
   subprocess (whose published tarball embeds `core` + `plugin` as `bundledDependencies`);
   `hermes plugins install Jinn-Network/jinn-plugin --enable` run programmatically during
   `autopilot init` (`src/init.ts`, `ensureJinnPlugin`); and per-worker plugin activation
   (`src/dispatcher/hermes-home.ts` symlinks the operator's installed plugin and enables
   it in every worker's Hermes config). Every Autopilot worker session runs the plugin.
3. **The only external package contract is one file.** Installed Hermes hosts resolve the
   runtime via `layer-runtime.json`
   (`{"package": "@jinn-network/jinn-layer", "version": "0.1.2", "bin":
   "runtime/node_modules/.bin/jinn-layer"}`), riding the `jinn-plugin-split.yml`
   content-mirror into the separate repository `Jinn-Network/jinn-plugin`, and
   hard-asserted by name, exact version, and bin path in the installed plugin's
   `jinn_layer.py`. No document anywhere instructs installing `@jinn-network/core` or
   `@jinn-network/plugin` directly.
4. **In-repo consumption is lopsided.** `client/src` imports `core` at ~50 sites (39 of
   them the `scrub`/`trajectory`/`corpus-read` subpaths, many as one-line re-export
   façades), `plugin` at exactly one site, `jinn-layer` at zero (scripts/tests only). The
   operator image ships `core` + `plugin` materialized; `layer` and `sdk` are build-stage
   only. The trio cannot version independently: `layer-npm-publish.yml` runs a serial
   canary chain and `verify-layer-stable-version.mjs` enforces a four-way same-version
   lockstep including the Hermes runtime pin, and `npm-publish.yml` refuses a stable
   client release unless `core` and `plugin` already exist on npm.
5. **The stack-fit probe's verdicts** (capability by capability): evidence
   capture/stores/index, contribution, publication-time scrub, corpus fetch/validation,
   CID handling, canonical JSON, signing, and process-transport mechanics all have stack
   owners today — with named deltas; corpus *relevance* reads, trajectory parsing, and
   distillation have **no stack owner**; the launcher model structurally forbids a
   stateful plugin process inside it (pure `plan()` contract, loadouts are static
   digest-pinned directories, no mid-attempt callback channel).
6. **The bridge constraint is live.** `jinn.execution.v1` (core's signed envelope) is
   load-bearing for the cutover's bridge-era `deliveryExtensions` hook until stage 5, and
   the ERC-8004 manifest/anchor path retires at cutover stage 4. Several trio surfaces are
   keyed to substrate that is already scheduled to die.
7. **`sdk` is fully disjoint.** `packages/sdk` depends on `zod` + `zod-to-json-schema`
   only; zero imports exist in either direction between it and the trio. No plugin-tree
   surface is load-bearing for `sdk` consumers — the session prompt's §3 question closes
   clean.

## 3. Q1 — capability ownership (approved)

Every exported surface of the three packages lands in exactly one row. Four categories:
**A** — a stack package owns the concern today (the trio implementation is the pre-stack
duplicate); **B** — no stack owner (genuine gap); **C** — genuinely tier-4
product-specific; **D** — keyed to substrate the cutover retires on schedule (the
long-term answer is neither migrate nor keep).

### A. Stack-owned concerns (pre-stack duplicates)

| Capability | Trio home | Stack owner | Named delta |
| --- | --- | --- | --- |
| Execution record family | `plugin` `EpisodeV1` (534-line zod) | `evidence/protocol` (`ExecutionEvidenceDocument`) | trajectory is structured `steps[]` in EpisodeV1, an opaque digest-bound native-trace artifact in the stack (→ §7); ~12 product fields (retention, activity receipt, attemptGroup, verifier, lineage…) have no typed stack home |
| Durable local evidence store | `core` evidence-adapter (episode files, lock, fsync+hardlink) | `evidence/execution-recorder` + `repository` + `local-runtime` | stack repository is append-only; no retention/eviction (→ §7) |
| Derived evidence index | `core` evidence-index (SQLite, repair journals) | `evidence/catalog-sqlite` + `local-runtime` sync/failure reporting | none material |
| Contribution state + publication | `core` contribution-store + `plugin` ContributionPort + `layer` ledger | `evidence/contribution` (destinations, standing grants, work claims, receipts) | stack is reference-oriented (digests); the old candidate is payload-oriented (diff, test runs) — moot under clean slate |
| Store-before-announce publication | `layer` publish.ts (resumable journal) | `evidence/publication` | anchor leg is ERC-8004 (group D) |
| Publication-time scrub engine | `core/scrub` (28 top-level modules, ~4,100 lines) | `evidence/derivation` (isomorphic detector/finding/band/disposition/policy/receipt model; same secretlint dependency) | core-only extras: ML PII (GLiNER/transformers), gitleaks pack, review-queue store, eval bench (→ §11 follow-up 6) |
| Corpus fetch / validate / cache | `core/corpus-read` + `layer` consume + SqliteCorpusStore | `evidence/retrieval` + `catalog-sqlite` | query half is B/D |
| IPFS/CID handling | core `corpus-read/ipfs.ts` + layer `ipfs-cid.ts` (two of three copies) | `evidence/repository-ipfs` | none |
| Canonical JSON + digests | `core` canonical-json.ts | `evidence/protocol` hashing + the per-package sealing precedent with equivalence fixtures | core's copy predates the fixture discipline |
| Envelope signing | `layer` signing.ts (bespoke secp256k1, no EIP-191) | `trust/*` + the DSSE-only rule (principles §5) | non-conformant with the sealed-record discipline |
| Process-transport mechanics | `layer` process-contract (JSON-over-stdio) | `evidence/execution-recorder-bridge` proves the stdio pattern; MCP supersedes for the host seam (§8) | the verbs are product (group C) |
| Producer capture input shape | `core` captured-task.ts | `execution-recorder` capture types | none material |

### B. No stack owner (genuine gaps)

| Capability | Trio home | The gap, precisely |
| --- | --- | --- |
| Trajectory decoding | `core/trajectory` — six harness transcript parsers (claude-code, codex, cursor-sqlite, aider, continue, gemini) + two transcript→span converters + `jinn.trajectory.v1` span profile + hash chain | the recorder binds native-trace bytes and a declared format IRI and never opens them; the launchers declare the IRIs (`claude-code-stream-json`, `hermes-json`, …) and **no decoder exists anywhere in the stack**. The claude-code launcher emits exactly the wire format core already parses, with zero shared code |
| Distillation | `layer` — the entire subsystem (~20 modules) | `derivation` is redaction, not synthesis; the stack consumes `jinn.skill.v1` loadouts and nothing produces one. **Dropped from product scope this session** (§10) |
| Skill artifact + packaging + seed import | `core` skill-artifact + `layer` skill/seed modules | consumption (loadout pinning) is stack-owned in task-execution; production is unowned. Falls out of scope with distillation |
| Capture-time privacy posture | `layer` capture.ts (fail-closed scrub before persist) | the stack scrubs only at derive-for-publication; its local store is unscrubbed by construction. Under the retrieval+capture scope with publication parked, this converts to the **retention finding** (next row) plus a publication-time obligation when the outbound lane un-parks |
| Local retention/eviction | `core` prune (200-episode cap, user-visible policy) | no eviction concept in the stack repository/runtime — a real build item for a product persisting interactive sessions on personal machines (→ §7) |
| Free-text/relevance query surface | `plugin` pickup + the Ponder `capture-meta` endpoint | the discovery protocol forbids ranking and its catalog queries are exact-match; relevance is application-side **by design** — ranking is product intelligence (group C); a *hosted* text-query plane, if ever, belongs to the marketplace-surfaces lineage |
| Paired statistics + three-arm measurement | `core` paired.ts + `layer` measurement.ts | no evidence-tree owner; the adjacent rightful home is the benchmarking tree. Recorded as reference material (§11 follow-up 7) |

### C. Genuinely tier-4 (product)

`createJinnPlugin` + `PluginSession` lifecycle; the five-port contract + `PortResult`
algebra; the product schemas (KnowledgeHit, KnowledgePacket + budget/truncation,
EligibilityVerdict, SessionSummary, HistoryEntry, PickupConfig); pickup ranking + packet
projection; history/explain folding; the eligibility gates (with an internal
plugin-vs-layer duplication); the `jinn-layer` CLI verbs + process API (the published
external contract); wiring/composition root; corpus doctor probes; the Hermes host adapter
(`apps/jinn-agent/plugins/jinn`, mirrored to the slim repo). Under clean slate these are
**reference implementations of product functions the redesign re-derives** — the
functions survive (§6); none of the schemas or code carries.

### D. Keyed to retiring substrate

| Capability | Trio home | Retirement key |
| --- | --- | --- |
| `jinn.execution.v1` signed envelope | `core` execution-envelope.ts | superseded by evidence/protocol DSSE; **bridge-load-bearing until cutover stage 5** (`deliveryExtensions`) |
| `TraceEnvelopeV0` (frozen; symbol-for-symbol copies in core *and* layer) | core + layer `envelope.ts` | frozen read-compat for historical records |
| Manifest + Merkle + ERC-8004 anchor encoding | `core` manifest.ts | registry client retires at cutover stage 4 → signed discovery announcements |
| Ponder GraphQL envelope discovery + capture-meta | `core` corpus-read | indexer becomes projector #1; query plane re-derives (marketplace-surfaces) |
| SolverNet query vocabulary (`solverType`, tier filters, client-side substring match) | core types + layer consume | SolverNet retirement schedule (composition design §9) |

## 4. Q2 — the disposition: clean-slate supersession (approved)

**One verdict for all three packages: frozen as reference, superseded by the clean-slate
product, retired after the install channel cuts over.** No re-derivation program, no
internal migration trains, no porting. The operator's stated rationale, recorded: the trio
was built ad hoc before the stack's architecture existed; migrating it piecewise would
carry the old architecture into the coherent one. Existing code is *reference* — consulted
for behavior, mined for fixtures — never merged.

Both of the session prompt's failure modes are answered on the record: this is not
*assumed* dissolution — it is dissolution decided against the consumer census (§2.2–2.4),
with the migration story below keeping every consumer channel working; and nothing is
grandfathered — the duplication ends with the old lineage's retirement, on gates.

### 4.1 Interim freeze rules (until the channel cutover, §9)

- The published 0.1.2 trio, `layer-runtime.json`, and the slim-repo channel stay exactly
  as they are: **critical fixes only, no feature work**. Installed Hermes hosts and the
  extracted Autopilot's init/worker provisioning keep working untouched. **Mechanical
  relocations are permitted under the freeze** (content-unchanged moves serving #2294 —
  §9.1); they are not feature work.
- **The critical-fix path is named so nobody discovers it mid-incident:** the lockstep
  verifier (`verify-layer-stable-version.mjs`) forces a coordinated same-version bump of
  all three packages **plus** the `layer-runtime.json` pin, so a fix to one package ships
  as: triple bump + pin bump on `next` → `layer-v*` tag → manual stable dispatch → `main`
  promote (Monday, or hotfix push) carries the new pin through the mirror → per-host
  manual `hermes plugins update`. Fix latency to installed hosts is promote-cadence
  bound, and the pin bump must precede the stable dispatch at the release SHA (the
  verifier requires it) — a `main` promote landing between the two opens a dead-pin
  window; sequence the two in one sitting.
- `client/`'s portal surface and the five-tree operator image stay intact per the platform
  architecture's sequencing constraint; the daemon cutover inherits them unchanged. Of the
  client's ~50 `core` import sites, the engine-capture and corpus/discovery clusters are
  retired by the cutover's own stages (1–2 and 4 respectively) as the paths they serve are
  recomposed — that work belongs to the composition program. The **trajectory/scrub
  cluster (~23 sites)** serves the harvest/mint machinery the composition design keeps
  as-is; it retires with that machinery via §11 follow-up 4 and the §4.2 train, not with
  the cutover stages.
- Two client consumers outlive the cutover stages and get named follow-ups (§11): the
  corpus-autoload loop (application-tier by the composition design, but reading the
  retiring Ponder path — forced re-point when stage 4 lands) and the harvest/mint
  contribution machinery (retired with the old contribution model, timing per §11
  follow-up 4).
- The publish coupling stays as-is while frozen: the `layer-npm-publish.yml` chain, the
  lockstep verifier, and `npm-publish.yml`'s bundled-dependency gate continue to protect
  the frozen artifacts.

### 4.2 Retirement (gated, not scheduled by date)

Trigger: the clean-slate product passes its channel-cutover gate (§9.3). Then, as one
retirement train: `npm deprecate` all three identities with pointers to their successors;
dismantle `layer-npm-publish.yml`, the lockstep verifier and its two workflow-test files;
remove the `core`/`plugin` `bundledDependencies` and the bundled-publication gate from
`npm-publish.yml` **after** the client's own imports are gone (post-cutover-stage-5);
remove the trees. Each dismantling PR owns the workflow changes it forces, per the
release-train rule. The npm registry-side trusted-publisher deregistrations ride the same
train (`docs/runbooks/layer-npm-publishing.md`).

*Corrected 2026-07-31 (planning consolidation, C9 findings F1–F5).* This section's census
covered the publish machinery and CI but **omitted the client-side surface entirely**, and
the omission is load-bearing: the real coupling is 48 source files, 7 scripts, 8 tests, and
15 manifest lines. Because those source files are almost all one-line re-export façades over
`@jinn-network/core`, deleting them is only a deletion once roughly sixty transitive
consumers are dead — and the daemon composition design's stage table claims almost none of
them. As scoped, the train would have stalled against work nobody owns.

**The disposition is therefore split in two, and the split is the ruling:**

- **Retire the identities and the publish machinery now.** Deprecate the three npm
  identities, dismantle the publish lane, deregister the trusted publishers, and remove the
  per-package CI. This is what the §4 disposition actually promised — the duplication stops
  being *consumable* — and it needs nothing from the daemon cutover.
- **`packages/core` is then on a scheduled removal**, not an open-ended reprieve
  *(operator decision, 2026-07-31)*. Its functionality is re-derived elsewhere; what keeps
  the tree alive is one unmigrated consumer, and that consumer gets an owner rather than a
  shrug.

**The removal schedule.** *(Corrected 2026-07-31, second pass — the first correction was
wrong and is retracted here rather than quietly edited.)* That draft claimed the blocking
work was migrating **harvest**, on the reasoning that the composition design keeps harvest
"as-is" and that harvest is what the scrub/trajectory cluster serves. The second half is
false. Read at code level:

- **Harvest is commit-echo mining and barely touches `core` at all.** It walks fresh
  upstream commits in configured local repositories, selects fix-shaped ones, extracts the
  gold patch, the regression tests introduced by that same commit, test paths, language and
  problem statement, builds a mint candidate, admits it to a validated pool and optionally
  publishes it — it manufactures benchmark tasks from real commits. Its only `core`
  dependency is `canonicalJson`, reached through a one-line façade. Its `sessions` source
  is parked.
- **The scrub/trajectory cluster serves the harness execution engine and its capture path**
  — `harnesses/engine/*`, `captures/*`, the conformance checks over the v1 trajectory
  format, `observability/redact-secrets.ts`, and `eval/`.
- **The daemon cutover does retire that engine**: TaskEngine's solution path at stage 1,
  "the legacy TaskEngine entirely" at stage 2.

So the original trigger — consumers retire under the operator recomposition — is
substantially correct, and the schedule is:

| Gate | Work | Owner |
| --- | --- | --- |
| 1 | Identities deprecated, publish lane and per-package CI dismantled | C9 Part A — no external dependency |
| 2 | The engine and capture consumers retire with cutover stages 1–2 and 4 | Operator-daemon composition program, already in scope |
| 3 | The capability gaps close or are consciously dropped: ML PII detectors, the gitleaks pack, and the scrub review-queue store into `evidence/derivation`; the five remaining transcript parsers into `evidence/trace-decode`, or dropped with their formats declared unsupported | Owning stack trees; each is already a recorded finding |
| 4 | The 14 one-line re-export façades and then the trees deleted | C9 Part C |

**The residual risk is real but smaller than the retracted version claimed.** The
composition design's stage table retires *loops and the TaskEngine*, not modules by name.
Whether `client/src/captures/`, `client/src/conformance/checks/`,
`observability/redact-secrets.ts`, and `eval/` are deliberately removed or merely left
orphaned is unstated — as is where harvest's `canonicalJson` goes when the façade dies.
C9's Task 1 already re-derives the census against the repository, so the check exists; what
is recorded here is that gate 2 needs **module-level** confirmation, not just green stages.

Four mechanical corrections ride along: the stable lane is five artifacts, not four
(`publish-layer-stable.mjs`, the actual publisher, was missing); each per-package workflow
carries an unlisted `client-compat` job; **`npm deprecate` and trusted-publisher
deregistration have no authenticated CI path** — OIDC authenticates `npm publish` only, so
both are interactive maintainer actions this section implied were automatable; and deleting
the publish lane makes the frozen manifests' `version` fields silently load-bearing, since
`npm-publish.yml` will otherwise wait ten minutes for a canary that can never appear. The
trio stays pinned at `0.1.2` until the bundled-dependency gate is removed.

The full coupling census the train must clear (enumerated so nothing is discovered
mid-dismantle): the per-package workflows (`core-ci.yml`, `plugin-ci.yml`,
`layer-ci.yml`); trio path filters in `ci.yml`, `sdk-npm-publish.yml`, and
`jinn-agent-ci.yml`; the `jinn-agent-ci.yml` **cold-stock job**, which builds all three
trees from source (its removal ordering is entangled with #2294 item 3 — the cold-stock
gate re-homes or retires with the fork); `environment-suite.yml`'s `build:plugin` /
`build:core` preflight steps (fall away with the client imports at stage 5); trio names
in `.github/scripts/evidence-source-boundaries.test.mjs` allowlists; and
`client/scripts/vendor-private-packages.mjs` + the five-tree `client/Dockerfile` (owned
by the composition program's stage 5, referenced here for completeness).

### 4.3 What is *not* decided by this disposition

The SolverPlugin distribution question is parked (§10.1); the daemon-side plugin-content
CLI verbs continue under the composition design's re-keying as the bridge. Nothing in this
section gates the daemon cutover, the marketplace-surfaces follow-ups, or Autopilot's
adoption pass. Note the converse dependency loudly: **the extracted Autopilot never
auto-updates an existing plugin install** (`ensureJinnPlugin` returns early when the
plugin reports `enabled`, and is interactive-consent-gated otherwise), so the fleet
adopts the clean-slate product only through Autopilot's own adoption pass — the §9.3
cutover does not reach it implicitly.

## 5. Product scope — the clean-slate Jinn Plugin (approved)

Derived from the platform's four verbs, not inherited from the roadmap. From the seat of a
person's own agent harness, the product is **the host-side evidence integration**: it
makes an interactive agent a first-class producer and consumer on the evidence plane.

**In scope (both from the start, operator decision):**

1. **Capture.** The host adapter observes the session; the runtime seals it as a standard
   **Execution Evidence record** — the same record family every producer on the platform
   writes — into a local evidence archive (recorder → repository → catalog via
   local-runtime). The native transcript is attached as a digest-bound artifact with its
   declared format IRI, exactly as the capture design intends. Private by default; nothing
   leaves the machine. There is no bespoke episode format: **the stack record is the
   record.**
2. **Federated retrieval.** Relevant evidence enters the context at the moment of work,
   drawn from **two planes**: the operator's own local archive (which capture feeds) and
   the **public corpus** — the platform's public record space, meaning whatever is
   announced through record discovery and served from archives (operator archives,
   benchmarking outputs, seeded content). First-turn pickup injects budgeted, attributed
   context; `corpus_search`/`corpus_fetch` are available mid-session; the `◇ corpus`
   moment is unchanged as the product's visible beat.

**Recorded extension points (architecture must not preclude; not built, not designed):**
outbound publication (captured records are publishable *by construction* — they are
already sealed platform records, so un-parking contribution later is a consent surface
plus derivation-scrub at the boundary, not a subsystem); the task-mint lane (Request
Work); additional hosts beyond Hermes (§6.2 makes this cheap by construction).

**Dropped:** distillation, skills production/install surfaces, the bespoke contribution
subsystem, the episode store, mint machinery. See §10.2 for distillation's record.

**The honest value dependency, on the record:** a retrieval product is exactly as valuable
as the evidence plane it reads. The public corpus in this branch is empty today; archives
go live with the daemon cutover's discovery-serving stage, and seeding/curation is a named
coordination point (§11 follow-up 5) — the product does not pretend to carry its own value
floor. The near-term supply is the product's own capture (Autopilot's fleet runs the
plugin in every worker session) plus seeded content.

**What survives from the Stage 1/2 product designs:** the product *moments* — one-command
install, zero-consent onboarding, the doctor with `{name, ok, detail, remedy}` checks, the
`◇` marker, honest empty states, disable-returns-to-stock. Those were approved product
decisions and remain the experience bar. The architecture beneath them is entirely new.

*Corrected 2026-07-31 (planning consolidation, C7 finding F-C7-2).* **Disable-returns-to-stock
is only partly achievable and is restated here honestly**, having been inherited flatly from
the Stage 1/2 designs. Hermes exposes no plugin-disable hook, so an adapter that is not
loaded cannot retract its own `mcp_servers` entry: disabling stops hooks, first-turn
injection, capture, and the doctor immediately, but the two registered corpus tools persist
until `hermes plugins remove` or one config edit. The durable fix is an upstream
plugin-declared `mcp_servers` block; until then the product documents the residue rather
than claiming a guarantee it cannot keep. The **doctor** clause is also tightened by the
program's new health-check contract: a check whose answer is identical on every install is a
release note, not a check, and `remedy: null` is the honest form of "broken, and no action of
yours fixes it".

## 6. Architecture — one runtime, one thin adapter (approved)

### 6.1 The runtime

One small stack-composed process — the clean-slate successor of `jinn-layer` — living in a
new top-level product tree (working name **`plugin/`**, settled at the naming pass;
sibling of the future `operator/`), guard trio from day one, built in the integration
branch. Composition (every dependency a stack package, consumed through public
interfaces):

| Concern | Stack package(s) | Product-side addition |
| --- | --- | --- |
| Capture | `evidence/execution-recorder` → `evidence/repository` (fs) + `evidence/catalog-sqlite` via `evidence/local-runtime` | session→record assembly (task summary, runtime spec, outcome, native trace + format IRI) |
| Public-corpus mirror | `discovery` client (chain-walk/sync, high-water-mark store) → local catalog | source configuration (which archives to follow) |
| Retrieval | `evidence/retrieval` (exact-byte fetch + validation), `evidence/repository-ipfs` where sources are IPFS-backed | — |
| Trust filtering | `trust/*` (key bindings, trust-policy statements) | source/producer admission policy applied before ranking; fail-closed on rejection (§6.3) |
| Relevance | — (deliberately: the discovery protocol forbids server-side ranking) | the product's text index + ranking over both planes (SQLite FTS over indexed record text), selection, budgeted context projection with attribution — the re-derived successor of the packet function, product intelligence by design |
| Trajectory access | the new tier-3 decoder capability (§7.1) | excerpting decoded spans into retrieval projections |

The read plane is **local-first**: the runtime maintains a local mirror of followed public
sources (discovery sync → catalog) and ranks locally. No hosted query service is depended
on; if a hosted text-query plane ever exists it is the marketplace-surfaces lineage's
surface and this product may adopt it as an *additional* candidate source.

### 6.2 The host seam

**MCP is the sole wire protocol** (operator decision; standards ruling §8.1). The runtime
is an MCP server over stdio exposing the product's tools — `corpus_search`,
`corpus_fetch`, the first-turn pickup operation, and the capture-lifecycle operations the
adapter drives at session end. There is no bespoke process-verb contract in the new
product; the old `ProcessEnvelope` stdio protocol is not carried.

**Topology (reviewed and settled at the level this spec owns):**

- **Two MCP clients, one protocol.** The host's model loop reaches the runtime through
  the host's native MCP plumbing (Hermes: `mcp_servers`, stdio). The per-host adapter's
  *hook code* — first-turn pickup injection, session-end capture — is itself an MCP
  client of the same runtime binary. The adapter carrying an MCP client dependency is
  part of the design, stated here so it is not discovered at implementation.
- **Session-scoped instances, no daemon.** Runtime instances are short-lived and
  session-scoped; a stdio server is owned by whichever process spawned it, so a session
  may hold two instances (host-spawned for tools, adapter-spawned for hooks). That is
  acceptable **because the shared local state is the coordination point, not the
  process**: catalog and index access run under SQLite WAL; capture has a single writer
  per session (the adapter's instance); mirror sync runs under an exclusive advisory
  lock (skip-if-held).

  *Resolved 2026-07-31 (planning consolidation; C3 finding F-C3-8 and C4's code
  investigation).* This paragraph named the archive-access mode as the build plan's first
  design unit and offered two options. The choice does not exist: `openLocalEvidenceRuntime`
  takes an **exclusive** lock and fails `ROOT_IN_USE` rather than waiting
  (`packages/evidence/local-runtime/src/lock.ts`), so direct multi-process access under
  cooperative locks is unavailable at any price. The ratified mode is **per-operation
  open/close**, with one bounded hold at session end for sealing and contention surfaced as
  a retryable busy state — never a long-lived archive handle taken at start, which would
  starve the sibling instance for the whole session.

  *Also settled 2026-07-31 (C7 finding F-C7-3).* The two-instance topology is **necessary,
  not incidental**: Hermes exposes no MCP client handle to plugins, so the adapter cannot
  reuse the host's connection. It is also **load-bearing for safety** — the host-spawned
  instance registers read-only tools, so a prompt-injected model cannot reach the capture
  tools by name. Collapsing to one instance would place them in the model's tool list.
- **Fleet concurrency defaults to per-worker archives.** The extracted Autopilot enables
  the plugin in every worker home; N concurrent workers must not contend on one archive.
  Default: each Hermes home gets its own archive (matching how worker homes are already
  isolated); cross-archive reads, if ever wanted, arrive through federation, not shared
  writes.
- **Bulk bytes move by path, not by protocol.** MCP carries control and references; the
  native transcript is handed to the runtime as a file path within the same machine
  boundary (the same shape as the recorder bridge's file-based artifacts). Stated openly:
  the seam is MCP-plus-shared-filesystem, and claims no more.
- **Mirror sync never blocks pickup.** Pickup serves from the current local mirror,
  always; sync is opportunistic (session start, post-pickup, bounded) under the sync
  lock. A stale mirror degrades relevance, never latency.

The **per-host adapter** keeps only what MCP structurally cannot do, because it lives in
host hook APIs: observing the session (transcript capture feed) and injecting pickup
content into the first turn. For Hermes this is a thin Python plugin (hooks + rendering +
doctor surface). Multi-host later means a new thin adapter per host, not a new runtime.

### 6.3 Untrusted-content posture (adversarial-review finding, resolved in-text)

Federated retrieval injects third-party content into a live agent session that holds
tools — a first-order prompt-injection surface, treated as such:

- **Corpus records are untrusted input by default.** Digest validation proves a record is
  what was announced, not that it is safe to inject; sealed ≠ safe.
- **Trust filtering is a composition row, not an afterthought.** Candidate sources and
  producers pass through trust-layer policy (the `trust/*` packages) before ranking;
  trust-filter rejection is **fail-closed** (the record is not considered), while plain
  absence of results remains fail-open (work proceeds). The §6.1 composition table gains
  a `trust` row accordingly.

  *Corrected 2026-07-31 (planning consolidation, C6 escalating a C5/C7 interaction).*
  "Before ranking" was insufficient, because the relevance index sits between the two and
  **caches an admission decision**. Producer admission happens at read, so an expired trust
  policy empties the reader — but queries run against the index, not the reader, so
  previously-indexed records would keep reaching model context under a policy that no
  longer admits them. A stale record is tolerable; a stale *authorization* is not, since
  `refreshBy` exists precisely to bound how long an admission decision may be relied on.
  The posture is therefore **filter before ranking and again after selection**: the index
  is a ranking accelerator, never authoritative for trust, and the selected candidate set —
  a handful of records, not the index — passes admission on the way into the projection. An
  emptied selection is an honest "nothing relevant found", which the product already treats
  as a real outcome.
- **Projection is hardened as a product invariant.** Injected content is framed as quoted
  data with a model-visible provenance boundary, never as instructions; the projection
  never asks the model to follow retrieved directives.
- **The product's own index is an attack surface.** Keyword stuffing against the FTS
  ranking (the documented #1791 distractor-collision class, weaponized) is named in the
  relevance test set: the ranking/projection tests carry **adversarial fixtures**
  (instruction-bearing records, stuffed metadata, distractors) alongside golden ones.

### 6.4 Local privacy posture (adversarial-review finding, resolved in-text)

The old lineage scrubbed at capture, fail-closed. This scope has no outbound lane, so the
regression to name is not exfiltration — it is **re-injection**: a secret pasted in one
session persisting raw in the archive and resurfacing in a later session's context, where
the agent has tools. Posture:

- **At rest:** captured records and native traces are written owner-only (0600-class
  permissions), like the host's own session logs — the host already persists transcripts
  on disk, so capture adds a copy inside the same exposure class, not a new class.
  Accepted and stated.
- **Re-injection is closed on every path into model context.** Indexing runs the
  derivation detector model over capture content; excerpts and spans carrying high-band
  findings (credentials, key-shaped material, funds-controlling secrets) are **excluded
  from retrieval projections**. Secrets may exist in the sealed record; they do not come
  back through pickup. This composes the existing `evidence/derivation` engine — no
  second scrub engine is built.

  *Corrected 2026-07-31 (planning consolidation, C6 finding F12).* Index-time exclusion
  alone left a bypass: `corpus_fetch` reads through the retrieval layer and never touches
  the index, so an explicit fetch could return exactly the material pickup withholds. The
  posture is therefore **two enforcement points over one disposition table** — exclusion at
  index time for pickup, and the same classifier on the fetch path — mirroring the
  two-point trust filtering of §6.3 and for the same reason: the data arrives by two paths.
  "Explicit" is not a trust boundary here, because a prompt-injected model can drive a
  fetch as readily as it can shape a query. A withheld region is reported as withheld
  rather than silently emptied, and receipts carry classes only, never matched text.
- **Retention** per §7.3 bounds how long raw material persists at all.
- When the outbound lane un-parks, publication-time scrub via derivation is mandatory,
  as already recorded.

### 6.5 Placement in the execution taxonomy

The Jinn Plugin is a **host integration** — it attaches through the host's own plugin
surface, beside the local backend's launchers, never inside them. The launcher contract
(pure `plan()`, deterministic, hermetic) needs no change; when a daemon-side or
Autopilot-side session should run with the plugin, that is host-environment provisioning
(exactly how the extracted Autopilot already does it: install + enable in the worker's
Hermes home), not a backend concern. Which sessions run with the plugin is host/product
configuration, above both.

## 7. New platform surfaces this session commissions (kit-first, in their owning trees)

The gap build-list. Per the standing discipline, each ships its conformance kit and guard
trio with the package, and each is buildable in the integration branch without touching
the frozen trio or the client.

### 7.1 Native-trace decoder — a new tier-3 capability (approved)

The launchers declare trace format IRIs on every capture; a declaration nobody can read is
half a contract. A small package in the evidence tree (working name
`evidence/trace-decode`) completes it: **format-IRI-keyed decoders from digest-bound
native-trace bytes to structured spans.** Kit + golden/adversarial fixtures per format
first; the legacy parsers in `core/trajectory` are reference material and fixture sources.
Plausible consumers: the operator app rendering attempts, explorers, benchmarking
analysis, any third party reading published evidence.

*Corrected 2026-07-30 (planning, program finding F2).* This section sequenced the decoder
first and named the Hermes transcript as its first format, on the assumption that the
product would decode Hermes sessions to excerpt its own work. Code investigation falsified
the premise: the Hermes adapter captures a **live structured hook feed**, so own-session
capture produces spans directly and never parses a transcript — and Hermes's JSON session
snapshot is off by default and carries neither per-message timestamps nor token counts,
making it the worse source anyway. The ratified sequencing: the product is a trajectory
**producer** (§7.2's record kind is what it emits), the decoder serves *cross-producer
consumption*, its first format is **`claude-code-stream-json`** — what the local backend
actually emits, with reference parsers and fixtures in-tree — and it leaves the critical
path. The decoder additionally owns the format-identity gap (finding F3): launcher
`envelopeFormat` strings, legacy parser `sourceFormat` names, and
`NativeTraceCapture.format.entityId` are three unmapped namings today, and the attached
harness trace does not yet carry a harness format IRI at all.

### 7.2 Trajectory record kind — tier 2, composed on OTel (approved; audit §8.2)

The decoder's output graduates to a sealed record kind: OpenTelemetry span structure and
GenAI/agent semantic-convention vocabulary, wrapped in the Jinn sealed-record profile
(I-JSON, JCS-once, media type, digest identity). This closes the "trajectory is opaque
bytes" delta from §3.A without touching capture: capture still binds exact native bytes;
the trajectory record is a *derived, provenance-linked* view — produced by a decoder from
a stored trace, or emitted directly by a producer that observed the execution live.

*Corrected 2026-07-30 (planning, program findings F1, F8, F7; component plan C1).* Four
clauses of this section are amended by what implementation planning established:

1. **"Pinned at a specific semconv version" is not achievable and is replaced by a
   Jinn-owned profile.** Every `gen_ai.*` attribute was deprecated out of the core
   OpenTelemetry semantic-conventions repository at v1.42.0 and moved to a dedicated
   repository that publishes no release, no tag, and no schema URL, with all 100
   attributes at `stability: development`. There is no upstream version to pin. The record
   therefore declares **`https://jinn.network/profiles/trajectory-vocabulary/1.0`** — owned
   and versioned by Jinn — which cites an upstream commit and snapshot date. The intent of
   the original clause (consumers can interpret attributes across bumps) is preserved and
   strengthened; the mechanism changes.
2. **The record kind takes platform URI form:** kind
   `https://jinn.network/records/trajectory/1.0`, media type
   `application/vnd.jinn.trajectory.v1+json`, protocol
   `https://jinn.network/protocols/trajectory/1.0`. The working name `jinn.trajectory.v2`
   is retired; the frozen `core` `jinn.trajectory.v1` was a `schemaVersion` literal inside
   a package, never a platform record kind, so nothing collides.
3. **The integrity hash chain is superseded, not carried.** Derived identity does the same
   work more simply: the record is sealed, and each span identifier is derived from
   `(traceId, ordinal)` where `traceId` itself derives from the source digest and the
   decoder identity — so excision, reordering, or insertion breaks validation with no chain
   field, and fabricated spans over a real source digest are refused. Redaction-receipt
   hooks remain an extension point with no v1 consumer (nothing leaves the machine in the
   approved scope); the namespaced-extension discipline admits them later without a schema
   change.
4. **Record-level DSSE signing is not implemented.** Identity is the digest, and
   attributability arrives through discovery announcements, which are already DSSE-signed
   and carry record references. A second signing scheme at the record layer would duplicate
   that machinery for no threat the model names, since the forgery defense is the derived
   identity and does not depend on a signature. Direct DSSE envelopes stay available via the
   trust layer for a future consumer that requires them.

Three further clauses were settled after the component plans were written
*(2026-07-31 consolidation)*:

5. **The record is stored as an artifact, not as a new evidence record family** (C4).
   `EVIDENCE_RECORD_FAMILIES` is a closed three-member set, and extending it is a
   frozen-surface change §13 forbids. The Trajectory record keeps every tier-2 property
   that matters — sealed bytes, digest identity, media type, published schema, conformance
   kit — and is persisted with `putArtifact`, linked from inside the sealed execution
   record as an identifier on the native-trace entity, which is an existing typed surface
   rather than a workaround. Tier-2 status never required an evidence record-family slot;
   benchmarking's record kinds are the precedent.
6. **A declared timebase is a first-class field** (C2 finding F9). Determinism forbids a
   decoder consulting a clock, but real formats — `claude-code-stream-json` among them —
   carry no timestamps, and the frozen parser synthesized them with `Date.now()`. A record
   whose source lacks timestamps must therefore declare the timebase its span times are
   expressed against, so the times are interpretable and the output stays reproducible.
7. **The attribute vocabulary is closed** (C2). Only the profile's declared keys are
   admissible, which turns §7.4's "content is referenced, not inlined" from a discipline
   into a guard: a decoder cannot emit `message.content`, `tool.args`, or `tool.result`
   even by accident.

The two-level verification statement below is unchanged and is what the record's kit
asserts.

**Derivation integrity rules (adversarial-review finding, resolved in-text):**

- The sealed record carries the full derivation provenance **inside itself**: the source
  native-trace digest, the parent execution record reference, the format IRI, the
  decoder identity + version, and the pinned semconv version its vocabulary conforms to.
  A trajectory record without these fields is invalid.
- **Decoder determinism is a contract:** per (format IRI, decoder version), identical
  input bytes produce identical span output — enforced by the §7.1 kit's byte→span
  golden fixtures, which are the determinism proof, not just examples. Decoder version
  bumps produce *new* records; they never claim identity with records sealed under a
  prior version.
- The record is **DSSE-signed** by its producer, per the stack-wide rule.
- **Verification is two-level, stated honestly:** seal, signature, and reference
  integrity are third-party-verifiable without running Jinn code (the tier-2 property);
  span *faithfulness* to the native bytes is an attributable producer claim, verifiable
  only by re-running the pinned decoder against the digest-bound source. Fabricated
  spans over a real trace digest are therefore not free — they are attributable and
  refutable.

### 7.3 Local retention/eviction — finding against `evidence/local-runtime`

A product persisting interactive sessions on personal machines needs a stated,
user-visible retention policy; the stack repository is append-only with no eviction
concept. Surfaced to the local-runtime owners with a proposed disposition: a
host-configurable retention sweep at the runtime layer (never inside the repository
contract), with the old 200-episode cap as the reference policy.

*Sharpened 2026-07-31 (planning consolidation, C4).* The interim "implemented
product-side over the catalog" is weaker than it sounded: **retention cannot delete sealed
material at all** from outside the repository contract. What the product can bound is what
it owns — the staged session feed and the recorder workspace, both duplicates of bytes
already sealed — plus a watermark the retrieval layer honors so aged material stops being
surfaced. That is a real, honest policy and it is what ships; it is **not** a storage bound.
Sealed local evidence therefore grows without limit until the local-runtime finding lands,
and the product must say so plainly rather than implying a cap. This raises the finding's
priority from convenience to a stated product limitation.

### 7.4 Explicit non-commissions

No capture-time scrub stage — the local privacy posture is §6.4's index-time
sensitivity exclusion (composing the derivation detector model), and the full scrub
obligation returns with the outbound lane at the publication boundary via
`evidence/derivation`. No hosted text-query plane (marketplace-surfaces territory). No
skill/distillation surfaces (§10.2). The ML-PII/gitleaks/review-queue detector
extensions are recorded as optional contributions to `derivation` (§11 follow-up 6),
not commissioned.

## 8. Standards audit (principles §3)

Run for the surfaces this session designs; each ruling names adopt / compose-with-profile
/ bespoke. Primary-source verification of the moving targets (MCP revision, OTel GenAI
semconv status) is part of the implementation plan's first unit.

1. **Host seam — adopt: MCP.** The old lineage invented a bespoke JSON-over-stdio verb
   contract because it predates MCP ubiquity. Today MCP is the standard for exactly this
   seam; the hosts in scope speak it natively (Hermes ships `mcp_servers` config; the old
   layer already shipped an MCP server for distillation, proving the fit in-family).
   Adopting it dissolves the cross-language contract-version machinery (`contract
   --json`, the Python-side manifest assertions) into MCP's own initialize/capabilities
   handshake plus the runtime pin (§9.2). Stated honestly: the host's native MCP
   plumbing covers only the model-facing tools — the adapter's hook-driven half of the
   seam requires the adapter to be an MCP client itself, and bulk transcript bytes move
   by file path (§6.2); the ruling is "MCP plus shared filesystem," claimed as such.
   Rejected: keeping the bespoke verb contract (a second process protocol in a repo
   whose stack already has stdio precedent and whose hosts speak MCP); rejected:
   host-specific RPC.
2. **Trajectory representation — compose: OTel spans + GenAI/agent semantic conventions
   under a Jinn-owned, versioned vocabulary profile and the sealed-record profile.**
   *(Corrected 2026-07-30 — "pinned" originally meant pinning an upstream semconv version;
   see §7.2's correction. The composition ruling itself stands.)* The prior implementation independently
   converged on OTLP-shaped spans (`jinn.trajectory.v1` — span IDs, parent links,
   nanosecond times, attributes/events/status), which is strong evidence the composition
   is natural. OpenInference's span-kind vocabulary is a candidate profile input. What no
   standard provides — sealed identity, JCS-once, digest binding, the integrity hash
   chain, redaction receipts — is the Jinn profile, same pattern as every stack audit.
   Wholesale adoption is rejected (the GenAI semconv is young and moving; it carries no
   sealing semantics — pinning is mandatory); bespoke is rejected (prior art too strong).
   Two profile rules, per review: the **OTel GenAI semconv is the single normative
   vocabulary** (OpenInference is consulted, never mixed in as a second authority), and
   the pinned semconv version is **declared in the sealed record** (§7.2) so consumers
   can interpret attributes across pin bumps.
3. **Relevance index — established practice, named: SQLite FTS5 product-side.** Same
   engine family the stack's catalog already uses; no service, no embeddings, no model
   calls in the retrieval path at this stage. Rankers beyond lexical are product
   iterations, not architecture. One architecture-adjacent parameter is named now
   rather than discovered later: FTS5's default `unicode61` tokenizer segments neither
   CJK nor code identifiers (camelCase/snake_case), and the corpus is code-heavy — the
   tokenizer configuration is decided in the build plan **with the rebuild cost
   accepted by design**: the index is a derived cache over the mirror and the archive,
   rebuildable at any time; tokenizer changes are cheap by construction.
3a. **Runtime acquisition pin — compose, recorded (review finding m4).** The pin file
   (§9.2) is a deliberate near-standard: npm performs the acquisition (exact-version
   install, npm-native integrity), while the pin itself is a minimal JSON manifest the
   Python adapter can assert **without a Node toolchain** — the property the
   package.json+lockfile alternative lacks. The in-repo pattern (`layer-runtime.json` +
   `jinn_layer.py`) is the proven precedent; kept, with the ruling on the record.
4. **Record identity, discovery, retrieval, publication** — no new design; the owning
   stack specs' audits govern, and this product consumes them unchanged.
5. **Custody law (C1–C5)** — the new runtime is read-plus-local-write and holds no keys,
   acquires no ambient signing authority, and accepts no key material in any parameter
   position; when the publication extension point opens, write capability enters
   signer-injected per C3. The published runtime package carries npm trusted-publisher
   provenance per C5.

## 9. Distribution, channels, and the build seam (Q3; approved)

### 9.1 The install channel

Unchanged for users and for Autopilot's programmatic init:
`hermes plugins install Jinn-Network/jinn-plugin`. The slim repository — a separate
repository, populated today by the deterministic content-mirror `jinn-plugin-split.yml`
from `apps/jinn-agent/plugins/jinn/` — stays the channel. What changes is the content and
the mirror source: the new Hermes adapter lives in the new product tree in mono (the
editing home stays mono, because the adapter co-evolves with the runtime packages in the
integration branch; developing directly in the slim repo would fork the source of truth),
and the mirror workflow re-points to it. **This is the answer to
[#2294](https://github.com/Jinn-Network/mono/issues/2294) checklist item 1** (relocate the
plugin source-of-truth out of `apps/jinn-agent`) — **and #2294 does not wait for the new
product** (architecture-review finding, resolved): the fork's removal is unblocked by an
interim, freeze-permitted mechanical relocation — move the *frozen* adapter directory and
`layer-runtime.json` content-unchanged to a first-party in-repo home (the new product
tree, under a clearly-frozen path), re-point `jinn-plugin-split.yml` and the
`verify-layer-stable-version.mjs` read at it, and re-home the cold-stock gate per #2294's
own item 3. The slim repo's content is bit-identical across that move. When the
clean-slate adapter later replaces the frozen copy, that is the §9.3 cutover, not a
second relocation.

*Corrected 2026-07-31 (planning consolidation, C0 finding F2).* "Mechanical" understates
it. `apps/jinn-agent/plugins/jinn` is not only a mirror source — it is a **live bundled
plugin of the Hermes fork**: fork production code imports it (`hermes_cli/banner.py`), the
bundled-plugin resolver expects it at that path (`hermes_cli/plugins.py:65`), and 36 files
import it as a Python package. A bare move breaks all of them. The ratified mechanism is a
committed directory symlink left at the old path — an established pattern in this tree —
deleted by #2294 together with everything that needs it. Three consumers this section's
census also missed name the path and would have failed silently in a later, unrelated PR: a
runtime-pin reader inside the frozen layer tree, and two workflow test files. The gate is
correspondingly stronger than specified: the local adapter tree is currently blob-for-blob
identical to the published slim head, so the check asserts the relocated mirror produces
**no new slim commit at all**, backed by an offline git-tree-hash comparison.

### 9.2 The runtime pin

The adapter acquires the runtime by exact pin, same proven pattern, new artifact: a
runtime-pin file in the plugin directory naming the published clean-slate runtime package
(name settled at the naming pass) and its bin. The doctor names a pin/handshake mismatch
with its one-command remedy, exactly as the onboarding design's seam rules require. The
old `layer-runtime.json` continues to pin `@jinn-network/jinn-layer@0.1.2` until cutover.

### 9.3 The channel-cutover gate

The mirror re-point and pin swap land together, gated by the onboarding design's
four-layer pattern re-instantiated for the new product: extended cold-stock CI on the real
install path — **including the real npm acquisition of the pinned runtime**;
published-artifacts smoke on a clean runner; agent-driven rehearsal with transcript
attached; operator ratification (fresh environment, `◇` moment inside the 5-minute
budget). Passing this gate is also the §4.2 retirement trigger.

Three mechanics corrected per the adversarial review:

- **A branch precondition this section missed** *(added 2026-07-31, C8; extended at
  operator decision)*: both npm publish lanes — and #2293's own acceptance criteria —
  trigger from `next`, and `integration/evidence-v1` is **not** an ancestor of `next`.
  The constraint is larger than this program: the entire stack
  (`packages/{evidence,task-execution,trust,discovery,marketplace,benchmarking}`) exists
  **only** on the integration branch and is absent from `next` altogether, so **#2293 as
  written cannot execute either** — its workflows watch a branch where its packages do not
  exist. This program inherits the blocker; it does not cause it.

  **Operator decision (2026-07-31): the work stays on `integration/evidence-v1` as long as
  possible, and the acceptance gate splits to make that safe.** Everything except
  registry acquisition is provable from the integration branch today, because the plans
  already carry the seams for it: the adapter's resolution order is pinned-artifact →
  `JINN_PLUGIN_RUNTIME_BIN` → PATH, so a locally built runtime substitutes for a published
  one; `hermes plugins install file://<clone>` exercises the real install and enable path
  without the slim-repo mirror; and every stack dependency resolves through `portal:`.
  So §9.3's gate is **two gates**:

  1. **Local acceptance — runs from the integration branch, gates C7.** The whole product
     end to end: real Hermes, real install path from a `file://` clone, capture, pickup,
     the `◇` moment against a seeded archive, the doctor's full precondition matrix, and
     disable/remove. Proves the product works.
  2. **Published-channel acceptance — the C8 cutover proper.** Real npm acquisition of
     the pinned runtime on a clean runner, the mirror re-point, operator ratification.
     Proves the *channel* works, which is a strictly different claim and the one the
     #1797 class of breakage lives in — defects that exist only in published artifacts and
     are structurally invisible to any local rehearsal.

  Only gate 2 needs npm, `next`, or #2293. C0 through C7 and gate 1 need none of them, so
  the branch question defers until the product is already proven. When it arrives, the
  recorded recommendation is to **land the integration branch into `next`** rather than
  teach the publish lanes a second branch: the diff is 351,713 insertions against **37
  deletions**, modifies only ten existing files, and touches neither `client/` nor any
  publish workflow — it is additive, and publishing npm artifacts from a non-mainline
  branch would have to be unwound later anyway.
- **Ordering is explicit: the clean-slate runtime package is published stable on npm
  *before* the re-point lands on `main`.** *(Strengthened 2026-07-31, C8: enforcement is
  not a checklist. A guard runs inside the mirror workflow between the mirror and the push,
  fail-closed on registry doubt, so a re-point cannot land ahead of its runtime. It covers
  the frozen channel too, which makes §4.1's dead-pin window structurally impossible rather
  than merely documented.)* Otherwise a host updating mid-window gets a
  pin `npm install` cannot satisfy. The cold-stock gate's real-acquisition clause is the
  pre-merge check for exactly this class; the published-artifacts smoke catches it only
  after users would.
- **Rollback is mono-side.** The slim repo is never hand-edited (the mirror re-asserts
  mono content on every `main` push); rolling back the cutover means reverting the
  re-point commit on `main` (hotfix push), after which the mirror emits a new
  fast-forwardable commit. Rollback latency is bounded by a push to `main`, not by one
  git command. Installed hosts keep working throughout because the old pin remains
  published — deprecation never unpublishes.
- **The doctor names the non-user-fixable state.** The `{name, ok, detail, remedy}`
  contract gains one phrasing: when the pin resolves to a package/version npm cannot
  supply, the doctor reports a known-outage state ("not fixable from this machine —
  channel issue") instead of printing a no-op remedy. The break-each-precondition
  matrix in the gate covers this state. The cutover's `ensure`-runtime step also removes
  the superseded `runtime/node_modules` residue the git pull leaves behind, and says so.

### 9.4 Operator image and workflows

The new product tree does **not** enter the operator image; the five-tree build stays
as-is until the daemon cutover's stage 5 and the §4.2 retirement train. New CI for the new
tree follows the stack pattern: own paths-filtered workflow, guard trio, its own tests,
and runs of the **consumed stack packages' conformance kits** where the product composes
them. **The product itself carries no conformance kit** (architecture-review finding,
resolved): it is tier 4 — kits gate tiers 1–3; the §9.3 four-layer gate is the product's
acceptance harness, and the §7 platform packages carry their own kits. The
`published-artifacts-smoke` workflow re-points at cutover as part of the §9.3 gate.

## 10. Parked and dropped

### 10.1 SolverPlugin distribution — parked with an owner (operator decision)

The daemon-side plugin lineage (harness tool bundles under `client/plugins/`; the
`solver-plugins publish/read/feedback/block/revoke` verbs) keeps the composition design's
bridge: verbs re-keyed to wiring entries, mounting per the daemon's machinery. The deeper
distribution-and-trust design is **parked**, owned by a **dedicated follow-on design
session**, triggered by the first real cross-operator plugin-sharing need after the
daemon cutover. The leading candidate on the record for that session: platform-primitive
distribution — digest-addressed bundle + sealed describing record over record discovery,
distrust via trust-policy statements — with OCI artifacts / VSIX / npm provenance as the
audit comparables. Nothing in the bridge precludes it.

### 10.2 Distillation — dropped (operator decision)

Dropped from the product scope entirely; not carried, not migrated. The reference
implementation (~20 modules in `layer`) remains in git history and freezes with the trio.
If a skill-production capability is ever revived, its natural owner is the
**skill-factory lineage** (`2026-07-30-skills-factory-mvp-design.md`), which starts from
its own design, not from this code. The `jinn.skill.v1` loadout kind remains consumed by
task-execution unchanged; nothing in this session produces or retires it.

## 11. Follow-ups (recorded once; owners named)

1. **Clean-slate build plan** — implementation plan for the new product tree + the §7
   surfaces (decoder kit first). Owner: this session's follow-on planning session; PR
   train into the integration branch. (`feat`, own issues.)
2. **Channel cutover + retirement train** — §9.3 gate then §4.2 retirement. Owner: the
   plugin product train; requires the #2293 publish path for the runtime package's
   npm identity. (`chore`+`feat`.)
3. **#2294 item 1** — answered here (§9.1); the jinn-agent extraction checklist consumes
   this spec's ruling. Owner: the #2294 issue.
4. **Old contribution/harvest machinery retirement** in the client — rides the daemon
   cutover's stages where they already retire its callers; the residue (mineable store,
   harvest loop) is retired by the §4.2 train. Owner: composition program (stages),
   retirement train (residue).
5. **Seeding/curation coordination** — the retrieval product's value floor: curated
   retrieval-visible content in the new-plane archives before onboarding targets any
   named user; the corpus-content doctor check re-derives against archive sources.
   Owner: operator (product/growth call), tracked with the build plan.
6. **Derivation detector contributions** (optional) — ML PII, gitleaks pack, review-queue
   store offered to `evidence/derivation` as findings with reference code. Owner:
   evidence-derivation owners; no product dependency.
7. **Measurement re-home** (optional) — `paired.ts`/three-arm reference material noted
   for the benchmarking tree. Owner: benchmarking lineage; no product dependency.
8. **SolverPlugin distribution session** — per §10.1. Owner: dedicated design session;
   trigger named there.
9. **Discovery/local-runtime findings** — §7.3 retention; filed against the owning
   designs as dated findings. Owner: evidence tree owners.

## 12. Amendments to the Stage 1/2 designs (applied in this commit)

Per the session prompt, supersession is explicit and dated, never silent. This commit adds
a dated amendment note to the header of each of:

- `2026-07-14-jinn-plugin-product-roadmap-design.md` — the product promise and lifecycle
  framing survive as vision; the stage machinery, episode substrate, and
  contribution/distillation surfaces are superseded by this spec's clean-slate scope.
- `2026-07-14-jinn-plugin-stage-1-package-architecture.md` — the package architecture
  (ports/adapters/composition-root across the trio) is superseded in full; the trio is
  frozen per §4.
- `2026-07-14-jinn-plugin-stage-1-product-design.md` — the product *moments* survive
  (§5); the architecture, episode model, and contribution lanes are superseded.
- `2026-07-17-jinn-plugin-onboarding-design.md` — the install story, doctor contract, and
  four-layer gate survive and are re-instantiated by §9; the layer-acquisition mechanics
  (C6/`layer-runtime.json`) are superseded by §9.2.
- `spec/2026-06-14-solver-plugin-mounting-model.md` — unaffected in the bridge era; noted
  as input to the parked §10.1 session.

## 13. Non-goals

- No migration of trio code into the stack or the new product — reference and fixtures
  only.
- No change to the daemon cutover's plan, gates, or bridge rules; no new stage gates.
- No outbound publication, mint lane, or consent surface in this scope — extension points
  only.
- No multi-host adapters beyond Hermes in the first build.
- No hosted retrieval service, no embeddings, no model calls in the retrieval path.
- No protocol changes to frozen record families; the §7 record kind is additive tier-2.
- No renaming of the frozen trio's npm identities before the §4.2 train; no unpublishing,
  ever.
- No SolverPlugin distribution design (parked, §10.1).

## 14. Provenance and review dispositions

Designed 2026-07-30 in worktree `plugin-stack-reconciliation-5ee384` under the session
method of principles §12: three read-only research lanes (capability inventory; consumer
census including the extracted `Jinn-Network/autopilot` and `Jinn-Network/jinn-plugin`
repositories, which corrected the prompt's Autopilot assumption; code-level stack-fit
probe), findings reconciled by the coordinating agent; one material question at a time
with operator approval at each: Q1 table → clean-slate disposition (operator-directed,
superseding the coordinator's initial keep/re-derive proposal) → product scope
(operator-directed to retrieval, then extended to capture + federated retrieval) →
decoder tier-3 + OTel composition → MCP-first transport, tree placement, install channel
→ SolverPlugin park. Two fresh reviews run on this written form before presentation.

**Review dispositions (v0.1).** Both reviews ran on the written form; neither found a
blocker; every finding is resolved in-text. The **architecture review** (2 major /
4 minor; ~25 code claims verified clean) yielded: the host-seam instance topology and
shared-state concurrency rules (→ §6.2), the #2294 interim relocation so the fork's
removal does not wait for the new product (→ §9.1, §4.1 freeze carve-out), the
trajectory/scrub import-cluster re-attribution (→ §4.1), the `sdk`-disjointness closure
(→ §2.7), the no-product-kit ruling (→ §9.4), and the obligation that §12's amendment
notes be authored in the ratification commit. The **standards/adversarial review**
(6 major / 6 minor; 13 claims verified clean) yielded: the untrusted-corpus/
prompt-injection posture with trust filtering as a composition row (→ §6.3 + §6.1), the
local privacy posture closing the re-injection loop via index-time sensitivity exclusion
(→ §6.5), the decoder derivation-integrity rules — in-record provenance, determinism by
fixture, DSSE, two-level verification (→ §7.2), the MCP-plus-shared-filesystem honesty
and adapter-side client (→ §6.2, §8.1), fleet per-worker archives and
sync-never-blocks-pickup (→ §6.2), the cutover ordering/rollback/doctor corrections
(→ §9.3), the critical-fix lockstep path (→ §4.1), the retirement coupling census
(→ §4.2), the FTS tokenizer parameter (→ §8.3), the pin-file audit row (→ §8.3a), the
OTel normative-vocabulary and in-record semconv-version rules (→ §8.2, §7.2), and the
Autopilot-never-auto-updates warning (→ §4.3). The §2.2 extracted-repository claims were
verified by the census lane against clones of `Jinn-Network/autopilot` and
`Jinn-Network/jinn-plugin` directly.
