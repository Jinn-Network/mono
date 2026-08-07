# Standalone Benchmarking Product — Product Design

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-05 |
| **Author** | Packet BP-00 of the standalone benchmarking product implementation program (Claude Fable 5 session) |
| **Shape** | `design` |
| **Status** | draft (program authority document; local session, unreviewed by humans) |
| **Depends on** | [`2026-07-28-benchmarking-application-design.md`](./2026-07-28-benchmarking-application-design.md) (the records and capabilities this product composes), [`2026-07-30-jinn-platform-architecture.md`](./2026-07-30-jinn-platform-architecture.md) (tier law, inclusion test, extraction gate), [`../plans/2026-08-05-standalone-benchmarking-product-program.md`](../plans/2026-08-05-standalone-benchmarking-product-program.md) (the program plan whose §3–§4 decisions this spec formalizes), and the product charter `2026-08-05-standalone-benchmarking-product-charter-v0.2.md` (v0.2, session-attached, not in-repo — product intent authority) |
| **Does not amend** | Jinn protocol or record semantics (tiers 1–3): no TEP, evidence, trust, discovery, or profiles change; no benchmarking record kind, named check, or frozen interface change; no new record kind; no facts-profile amendment. No canonical-doc change (`PRINCIPLES.md`, `SPEC.md`, `GLOSSARY.md`, `BRAND.md`, `GROWTH.md`, `THESIS.md`, `CLAUDE.md`). No marketplace, operator-product, or catalog-procedure change |

This document is the **catalog authority document** for the
`packages/benchmark-product` tree (program plan §4.1). It formalizes the
program plan's fixed product decisions (§3) and architecture decisions (§4);
it does not reopen them. Where this spec fills a genuine gap the program plan
left open, the choice is labeled as a reversible assumption and collected in
§12.

## 1. Problem statement and product definition

A technical team — or an independent builder — is about to make an externally
scrutinized comparative claim about an agent system: a new coding-agent
version, a harness or model configuration, a skill or tool-policy change, a
comparison destined for a README, release post, research note, customer
discussion, or public challenge. Running an evaluation, operating it through
an agent, and publishing a credible market-facing claim are related but
different jobs, and today the work is fragmented across human-only
dashboards, scripts, spreadsheets, raw logs, and ad hoc publication. A
credible comparison requires fixing the exact task set and configurations
before results exist, declaring what counts as success and how much
independent judgment each result needs, accounting for every expected
execution (including failures and missing results), and turning the outcome
into an outward-facing claim that skeptical readers can check — without the
claim's credibility resting solely on a self-produced chart (charter §3).

**The product** is a standalone, separately branded offering with which
humans and their delegated agents commission, run, inspect, and publish
comparative agent benchmarks. Its category-level explanation is *"compare
agents on the same work"*; its durable output is a **distribution-ready
benchmark claim package**: a clear public report, complete run and evaluation
accounting, limitations and guarantee boundaries, machine-readable evidence
and verification references, and shareable claim assets that link back to the
full report (charter §2, §4). The product is **agent-native and
human-legible**: every meaningful capability available to a human is
available to an authorized agent over the same product state, with humans as
first-class sponsors, supervisors, and readers (charter §1, §7).

The product is **not** a new name for the underlying platform, not the
platform's canonical frontend, and not a generic evaluation suite. Jinn
provides the execution, evidence, and verification stack on which the product
runs; Jinn is not the product's category, identity, or customer-facing
proposition. The product is not "Jinn Benchmarks" and carries no Jinn lexicon
as product identity — Jinn appears only as factual infrastructure attribution
in about, technical, and verification contexts (charter §1, §11; §9 below).

First market: public comparative benchmarking for builders of coding agents,
harnesses, skills, plugins, tools, and loadouts, making public or
customer-facing performance claims (charter §5; program plan §3). Two-plus
configurations are first-class; baseline-versus-candidate is a UX default,
not a limit.

## 2. Position: a Tier 4 product

Under the platform architecture's layering law
([platform architecture §3](./2026-07-30-jinn-platform-architecture.md)) this
product is **tier 4**: a composition of tier-2 records and tier-3
applications into a participant experience. It lives under the two mechanical
tier-4 rules (platform architecture §5):

1. **Nothing in tiers 1–3 imports it** — enforced by the frozen dependency
   direction and the source-boundary guards.
2. **No tier-1–3 kit, guard, or fixture references it** — no first-party
   product's behavior is ever treated as normative for the platform.

Catalog posture (program plan §4.1, registered per `architecture/README.md`'s
atomic procedure by the implementation packet, not by this spec): tier 4,
`classification: "product"`, `stability: "experimental"`,
`releaseGroup: "transitional-or-private"`, `publishPolicy: "never"`,
`ownerGroup: "architecture-control"`; own CI gate `benchmark-product-ci`;
allowlist source-boundary policy with positive controls; authority documents:
this spec plus the program plan.

Tree: `packages/benchmark-product/core` (headless product: domain,
operations, persistence, CLI) and `packages/benchmark-product/web` (Next.js
GUI, milestone M3). Packages are scoped `@jinn-network/benchmark-product-*`
under the internal codename `benchmark-product` — deliberately
descriptive-neutral, plainly a placeholder, carrying no Jinn lexicon and no
invented public name (§9; reversible assumption A1).

**This spec proposes no tier-1–3 change, no new record kind, and no protocol
amendment.** Everything below is product policy or presentation over the
platform as frozen.

## 3. Consumption contract

The product's default posture is **REUSE**. It imports public package exports
only: no deep imports, no copied platform code. The packages and the named
public exports the product builds on (each verified present in the package's
public entry, 2026-08-05):

| Package | Named public exports the product consumes | Role |
|---|---|---|
| `@jinn-network/benchmarking-records` | `sealBenchmark`, `sealRun`, `sealMatrix`, `sealReport`, `OUTCOME_VOCABULARY`, `checkItemDistinctness` | Benchmark / Run / Matrix / Report sealing, named checks, the frozen six-value outcome vocabulary. The product **never redefines these records**; product state stores digests and bytes references (§4.5) |
| `@jinn-network/benchmarking-run` | `planRun`, `quoteRun`, `launchAndWatch`, `resumeRun`, `assembleMatrix`, `verifyMatrix` | The run procedure. The product implements **no orchestration of its own** |
| `@jinn-network/benchmarking-aggregate` | `produceReport`, `verifyReport`, `deriveDisclosures`, `BENCHMARKING_METHOD_REGISTRY` | Method registry, Report production/verification, statistics. The product implements **no statistic** (the policy-optimization R3 ruling, adopted verbatim) |
| `@jinn-network/benchmarking-local` | `localAssemblyPorts`, `localPinningObservation`, `localInputScope`, `localCloseBoundary`, `integrityTierFromReceipt` | Local venue ports (assembly ports, pinning bridge, admission, scope) — the strongest currently implemented backend; M1 runs on it |
| `@jinn-network/benchmarking-interop` | `importSweBench`, `defineBenchmark`, `importInspectEvals`, `exportEvalLog`, `exportCroissant`, `exportStaticBundle` | Import/export seams (SWE-bench, Inspect, Croissant, static bundle) |
| `@jinn-network/task-execution-protocol` | `sealTask`, `sealSubmission`, `sealDelivery`, `deriveAttemptUri`, `foldObservations` | Task/Submission/Delivery sealing, attempt identity, observation fold |
| `@jinn-network/task-execution-profiles` | `evaluateVerdictRule`, `sealEvaluationSpec`, `parseEvaluationSpec`, `EvaluationSpecSchema`, `VerdictRuleSchema` | EvaluationSpecs and verdict-rule reduction — where "what counts as success" is defined |
| `@jinn-network/task-execution-backend` | `TaskExecutionBackend`, `BackendCapabilities`, `verifyPreclaim`, `TaskExecutionError` | The frozen backend contract the venues implement |
| `@jinn-network/task-execution-backend-local` | `makeLocalTaskExecutionBackend`, `LocalTaskExecutionBackend`, `assembleCapabilities`, `projectObservations` | The local execution backend (embedded) |
| `@jinn-network/task-execution-launchers` | `claudeCodeLauncher`, `codexLauncher`, `hermesLauncher`, `cursorLauncher`, `LauncherContract` | Harness launchers for local execution |
| `@jinn-network/task-execution-evaluation-harness` | `runEvaluationHarness`, `evaluationLauncher`, `EvaluatorAdapter`, `defineEvaluatorRegistration` | Evaluation dispatch on the local venue |
| `@jinn-network/task-execution-evaluator-adapters` | `createEvaluatorDeployment`, `createSweRebenchEvaluatorAdapter`, `parseSweRebenchReport`, `createSweRebenchEvaluatorRegistration`, `createPredictionEvaluatorRegistration` | Shipped evaluator adapters |
| `@jinn-network/trust-core` | `sealSignedRecord`, `sealDsseEnvelope`, `parseDsseEnvelope`, `verifyEnvelopeBinding`, `DsseSigner` | DSSE signing for Reports; envelope binding verification |
| `@jinn-network/benchmarking-marketplace` | `runOnMarketplace`, `marketplaceAssemblyPorts`, `marketplaceCloseBoundary`, `enforceAnchoredOrderingGate` — consumed **only behind the venue seam** (§7) | Marketplace venue; **no marketplace machinery re-implemented** |

**Explicit refusals** (each is a boundary the source-boundary guard and
review enforce):

- **No deep imports** — public package entries only.
- **No copied platform code** — no vendored record-kind or capability source
  (the extraction-gate item 8 discipline, honored from day one; §11).
- **No redefinition of Benchmark, Run, Matrix, or Report** — the four record
  kinds and their frozen interfaces (benchmarking design §14) are consumed as
  sealed bytes; the product adds no fields, no variants, no alternates.
- **No aggregates in matrices** — the matrix never contains a conclusion
  (benchmarking design tenet 3); the product never smuggles a score, rate, or
  winner into any matrix-adjacent surface it produces.
- **No new statistics** — every number in a report comes from a named,
  versioned registry method via `@jinn-network/benchmarking-aggregate`.
- **No `@jinn-network/core` and no `@jinn-network/sdk`** —
  catalog-classified legacy/deprecated; not imported.

## 4. Domain model

Per the repo frontend rules (CLAUDE.md §Frontends), every component is
described on four axes — **State**, **State messages**, **Collections**,
**Actions** — and that discipline applies product-wide: the operations
library (§5.1) is the single place these axes are defined, and every surface
renders them. A component with zero entries on an axis says so; silence is
ambiguous.

### 4.1 Lifecycle state machine

One product state machine, named states:

> **draft → (preview\*) → quoted → locked → running → closed → reported →
> published-bundle**

`preview*` is a repeatable operation available before lock; it never advances
the lifecycle (§7.2). **Lock = sealing the Run record** — the platform law
that identity is the pre-registration (benchmarking design §7.2); after lock
the official method is immutable by construction, and the product refuses
draft mutation of a locked benchmark run.

| From | Operation | To | Principal | Notes |
|---|---|---|---|---|
| — | `create` | draft | sponsor or delegated agent | new workspace draft; audit entry |
| draft | `edit` | draft | sponsor or delegated agent | validated on write; typed errors on invalid input |
| draft, quoted | `preview` | (unchanged) | sponsor or delegated agent | disclosed rehearsal (§7.2); produces a preview artifact, never official results (A5) |
| draft | `quote` | quoted | sponsor or delegated agent | side-effect-free validate + price via `quoteRun` + venue facts; nothing signs, posts, or spends |
| quoted | `edit` | draft | sponsor or delegated agent | any draft mutation invalidates the quote (A2) |
| quoted | `lock` | locked | either, **approval-gated** | seals the Run record; refuses if validation fails; irreversible |
| locked | `launch` | running | either, **approval-gated** (spend authority on paid venues) | dispatch via `launchAndWatch` on the configured venue |
| running | `watch` / `resume` | running | sponsor or delegated agent | crash-safe resumption via the records' cell idempotency keys; read-only plus re-dispatch per the pre-registered replacement policy |
| running | `cancel` | closed | either, **approval-gated** | drains to a boundary; the matrix still assembles, `runOutcome: cancelled` — cancellation is accounted, never erased |
| running | close boundary reached | closed | (system) | `assembleMatrix`; exactly one entry per expected cell |
| closed | `report` | reported | either, **approval-gated** | `produceReport`; DSSE-signed interpretation (A6) |
| reported | `publish` | published-bundle | either, **approval-gated** | emits the claim package and report bundle (§8.2) |

`inspect` (read any draft, run, record, or artifact) and `verify` (compose
`verifyMatrix` + `verifyReport`) are non-advancing operations available in
every state that has their subject.

**There is no product-level "failed" state.** Failures are typed, per-cell,
and accounted: the six-value outcome vocabulary (`judged | unjudged |
unscorable | expired | invalidated | excluded`, benchmarking design §8.2)
plus attrition and `runOutcome: complete | partial | cancelled` live in the
Matrix; a failed product *operation* returns a typed error and leaves the
lifecycle state unchanged (§4.3).

### 4.2 Principals and authority

Two principal roles (charter §6):

- **Sponsor** — the human or team owning the comparative question, budget,
  and publication consequences. May act directly or delegate.
- **Delegated agent** — an agent operating the product with authority granted
  by a sponsor. Capability parity is fixed: the agent can perform every
  lifecycle action a human can, within its granted authority.

Charter §6's five roles collapse deliberately into these two principals: the
**human supervisor** is a sponsor exercising approval authority (no
capability requires a supervisor distinct from the sponsor role); **report
consumers** and **benchmark authors / tooling integrators** act outside the
workspace and hold no lifecycle authority, so they are audiences and
suppliers, not principals.

**Approval is a permission policy, not a human-only path** (charter §6): an
approval-gated operation checks, at the operations boundary, that the acting
principal holds the required authority (lock, spend, cancel, publish); once
the authority exists, an agent may execute the approved action. There is no
capability that exists only behind a GUI click (§5.4). Default authority
mapping — consequential operations (`lock`, `launch`, `cancel`, `publish`)
require explicit grants; read operations require workspace membership only —
is a v1 policy choice (A3). Concierge assistance (charter §5) acts through
the same operations, permissions, and audit journal; there is no hidden
human-only control plane.

### 4.3 Typed error posture

Every operation returns either a typed result or a typed error — never a
silent fallback, never free-text-only failure. Error categories (v1):
`validation` (draft content invalid), `illegal-transition` (operation not
valid in the current state), `authority` (principal lacks the required
grant), `venue-unavailable` / `venue-unverifiable` (§7.3), `record-integrity`
(sealed-bytes digest mismatch on read), `execution` (backend-reported
failure, carried through with the backend's own typing). Errors are
machine-readable envelopes on the library surface, `--json` envelopes plus
distinct exit codes on the CLI (§5.2), and rendered error states with retry
guidance in the GUI.

### 4.4 Audit journal

One append-only JSONL journal per workspace. Every consequential operation
(anything that creates, mutates, seals, spends, cancels, or publishes)
appends one attributed entry:
`{ at, actor, action, subject, inputsDigest, outcome }` — actor is the
principal identity (sponsor or specific delegated agent), `inputsDigest` a
digest of the operation inputs, `outcome` `ok` or the typed error code.
Entries are never rewritten or deleted. The journal is **product state**, not
a sealed record — it makes agent operation supervisable and concierge work
attributable (charter §5, §7); it claims no protocol semantics.

### 4.5 Workspace layout: mutable drafts vs sealed bytes

The workspace is file-based with atomic writes (temp-file + rename). Two
storage disciplines, never mixed:

- **Mutable drafts** — the product's own documents (task-set selection,
  arms, evaluation choice, assurance preset, policy, budget, notes), plain
  JSON, freely edited before lock.
- **Sealed bytes** — every sealed record the product touches (Benchmark,
  Run, Matrix, Report, Tasks, EvaluationSpecs) is stored as its **exact
  bytes** and addressed by digest. Product state references records **by
  digest only**; nothing is ever re-canonicalized (the platform's exactness
  property).

Plus derived **artifacts** (preview outputs, results JSON, claim packages,
report bundles) and the journal (§4.4). No SQLite in v1. Exact directory
naming is implementation detail (A4).

### 4.6 Components (four axes)

| Component | State | State messages | Collections | Actions |
|---|---|---|---|---|
| **Workspace** | path; storage version; draft/run counts | `record-integrity` warning when stored sealed bytes fail digest check (informational; affected reads refuse with typed error) | drafts; runs; sealed records (by digest); artifacts; journal entries | `init` (workspace creation — distinct from the lifecycle `create` that starts a draft, §4.1). No other actions |
| **Benchmark draft** | lifecycle state (`draft`/`quoted`); validation status; selected task set (digests); arms with pinning; assurance preset (§6); policy (replicates, `closeAt`, replacement, budget); venue choice | per-field validation messages, each mapping to the `edit` that resolves it; "quote invalidated by edit" (A2) | items (task digests); arms; preview artifacts; prior quotes | `edit`, `preview`, `quote`, `lock` (gated) |
| **Quote** | expected cell count; per-cell and total price (paid venues) or time/disk estimates (local); hard-cap check; coverage facts; venue guarantee summary (§7.1) | "venue unavailable / degraded" (§7.3), mapping to venue re-selection | line items per arm × items × replicates | none of its own — a quote is a read; `lock` acts on the draft |
| **Official run** | lifecycle state (`locked`/`running`/`closed`); Run record digest; per-cell live status (dispatched/claimed/delivered/judged); spend against cap | infra failures shown as infra (`unscorable` ≠ fail); cap-approach warning → `cancel`; stall notice → `resume` | cells (with dispatch lineage); live events | `launch` (gated), `watch`, `resume`, `cancel` (gated) |
| **Results (Matrix)** | Matrix record digest; `runOutcome`; completeness `{expected, judged, floor}`; attrition per arm; asymmetry flags; per-axis verification states | asymmetry flag raised (informational — a validity threat surfaced, never absorbed) | cells with the six-value outcome, verdicts, dissent, cost, latency; exclusions | `inspect`, `verify`, `report` (gated), exports (EvalLog, Croissant, static bundle) |
| **Report** | Report record digest; method id/version/parameters; `preregistered` flag; disclosures block; signature status | "recompute divergence" from `verify` (fail-loud) | subject matrices; conflicted-cell list; limitations | `inspect`, `verify`, `publish` (gated) |
| **Claim package** | bundle version; digest links to report/matrix/run/benchmark; scope statement | none — informational asset | derived assets (headline, snippet, machine-readable claim) | `publish` produces it; `inspect` |
| **Audit journal** | entry count; last entry | none | attributed entries (§4.4), newest last, append-only | none — read-only; appends happen only as a side effect of operations |
| **Principals & authority** | principals with their grants; approval policy in force | "operation awaiting authority" — maps to a sponsor grant action | grants; pending approvals | grant / revoke authority (sponsor); approve pending operation (holder of the approval authority) |

## 5. Surfaces: one state machine, two peer surfaces

### 5.1 The operations library is the single trusted boundary

`packages/benchmark-product/core` exports an **operations library** that owns
the product state machine. All validation, authority checks, lifecycle
transitions, and audit-journal appends live at this boundary — never in a
surface. Surfaces are clients; a surface that bypasses the library is a bug
by definition.

### 5.2 Agent surface (M1): the library API plus a CLI

The CLI is the **complete agent surface** from milestone M1 on. It follows
the policy-optimization CLI structure (`src/cli/bin.ts` / `main.ts` /
hand-written total `args.ts`, injected context) and adds the machine-surface
requirements this product's agent-native contract demands: **`--json` on
every verb**, typed error envelopes, distinct exit codes. Every artifact an agent needs is
machine-readable on disk: results JSON, claim package, report bundle. A
connected agent can determine — without visual interpretation — the current
state, valid next operations, required inputs and validation errors, quote
and authority constraints, long-running status, and result/report/asset
identities (charter §7).

### 5.3 Human surface (M3): a GUI client of the same library

`packages/benchmark-product/web` is a Next.js + shadcn/ui application (per
CLAUDE.md §Frontends, including a four-axis app spec alongside its source)
that imports the operations library server-side. **No second
implementation** of any operation, and **no HTTP API in v1** — the GUI calls
the library in-process (deferred decision, §5.5).

### 5.4 Capability parity, proven

Commitment: every meaningful human capability has an agent-accessible
equivalent over the same product state (charter §1, §7). Proof: a
**generated capability matrix** (CLI verb ↔ GUI action ↔ library operation)
checked by test from M3 on — a GUI action with no CLI/library row fails CI.
Until M3 exists, the CLI *is* the complete surface, so parity holds by
construction.

### 5.5 Deferred surfaces (decisions recorded)

- **MCP wrapper: deferred.** If added, the operator-server
  `confirm: true` / `mcp_preview` house pattern is the template.
- **HTTP API: deferred.** v1 surfaces are the library and the CLI; the GUI
  consumes the library directly.

## 6. Evaluation assurance presets

The product separates two questions the customer answers independently
(charter §8): *what counts as success* (the Task's sealed EvaluationSpec;
`evaluateVerdictRule` territory) and *how a delivery becomes a verdict* (the
assurance preset). Presets are **product policy over platform primitives**
(program plan §4.5), mapped exactly:

| Preset (product label) | Platform mapping |
|---|---|
| Direct check | `policy.independence: disclosed`, `evaluation.minVerdicts: 1`, method `verdictRule: sole` |
| Separate evaluator | `independence: gating`, `minVerdicts: 1`, `distinctEvaluator: true`, `verdictRule: sole` |
| Evaluator panel | `independence: gating`, `minVerdicts: N≥2`, `verdictRule: majority` (declared reduction) |
| Strict agreement | `independence: gating`, `minVerdicts: N≥2`, `verdictRule: unanimous` (disagreement ⇒ conflicted, dropped-with-report) |

Disclosure rules, non-negotiable:

- **Preset names are product policy, never new protocol terms.** No record,
  check, or platform interface ever learns a preset name.
- **Every report discloses the underlying primitives satisfied** — the
  independence mode, verdict counts, distinctness results, and reduction rule
  actually applied (the Report's required `disclosures` block, benchmarking
  design §9.1) — not the preset label alone.
- **Dissent is retained.** Dissenting verdicts remain referenced in the
  matrix and visible in the report; conflicted-cell counts and cellKeys
  always appear in results (benchmarking design §9.2).
- **Multiple verdicts do not prove truth.** Every report repeats the
  residual: the stack proves *agent-distinctness*, not real-world
  *party-independence* (charter §8; §8.1 below).

## 7. Venue honesty

The product presents only the guarantees the selected venue actually
supports (charter §10). Venue facts appear at the decision points they
affect: quote, lock, and in every produced report.

### 7.1 Local vs marketplace guarantees

Compiled from the benchmarking design's backend-profile table (§13) and
pre-registration legs (§7.2); the "what a run proves" row summarizes the
design's venue-strength statements (§3, §5, §12.2). The design is
authoritative.

| Concern | Local venue | Marketplace venue |
|---|---|---|
| Pre-registration strength | leg (a) structural + leg (c) append-order only — **no guarantee against the run owner**; retro-registration is possible | legs (a)+(b)+(c): anchored ordering, trust-bearing against the owner |
| What a run proves | reproducibility and internal discipline — **not owner-honesty** | pre-registered method, completeness checkable against the owner |
| Run pinning | `enforced` (admission gate + digest-verified materialization is a valid `match` source, benchmarking design §8.1 as amended 2026-08-03) | `attested`; verified after the fact against evidence; mismatch ⇒ `invalidated` |
| Pinning verification today | per-axis `match` reachable | per-axis **`unverifiable` until the re-homed enforcement legs (ex-#2040/#2041) land** — disclosed, never hidden |
| Budget / escrow | absent | required (`perCell`, `hardCap`); escrow per binding |
| Close boundary | `closeAt` timestamp | `closeAt` + first `finalized` block at/after it (anchor required) |
| Cost fields | `reported` (evidence resource observations) | `settled` where available, else `reported` |
| Task privacy | items private until the owner publishes | items public at post time |
| Venue label | `self-run` | `open-competition` (self-declared) |

Product copy states the local venue's limit **in the product and in every
report produced from a local run**: a local run's pre-registration is a
discipline, not a proof against its own owner.

### 7.2 Preview = disclosed rehearsal

A **preview** is an unregistered local run: clearly labeled as a rehearsal
everywhere it appears, it produces disposable artifacts, and it **never
enters official results**. When any preview of a benchmark preceded the
official run, the official report's limitations name that fact. This is the
benchmarking design's rehearsal residual (§12.2) **disclosed rather than
hidden**: rehearsal cannot be eliminated; the product's posture is to make
its own rehearsal mechanism honest instead of pretending it does not exist.

### 7.3 Marketplace availability and verifiability states

The marketplace venue is presented through explicit, typed states — never
silently degraded:

- **`unavailable`** — the requester prerequisites the venue needs are not
  yet built: the supply-awareness read (user journeys design §9 item B0b)
  and artifact retrieval into the workspace (item B0c) — tracked as #2447
  and #2448 per the program plan (§2). While unbuilt, the product says the
  venue is unavailable and why; it does not absorb the gap.
- **`attested`** — the venue accepted a constraint as a claim to be verified
  after the fact (pinning posture, §7.1).
- **`unverifiable`** — a pinning axis whose enforcement leg has not landed
  (ex-#2040/#2041); reports carry per-axis `unverifiable` counts in their
  disclosures rather than scoring unverified configurations silently.

These are inherited platform states, surfaced honestly; closing them is
platform work, out of this product's scope.

## 8. Trust and claim boundaries

### 8.1 What the product must not imply

Carried from charter §10, binding on every product surface, report, and
derived asset. The product must not imply:

- that distinct agent identities prove distinct real-world parties;
- that an evaluator majority is necessarily correct;
- that local execution proves honesty against the run owner;
- that every configured runtime property was independently enforced;
- that network execution is confidential;
- that every benchmark is cheaper on the network;
- that a report is an official certification or universal ranking;
- that the branded product is required to verify the underlying result.

Guarantees, observations, estimates, attestations, and unverifiable claims
are visually, linguistically, and structurally distinct wherever they appear.

### 8.2 Publication integrity for derived assets

Marketability never weakens disclosure (charter §10). Every derived asset —
headline, social card, badge, README snippet, machine-readable claim — must:

- identify the configuration and benchmark scope clearly enough to avoid a
  materially broader claim;
- preserve or link directly to the relevant limitations;
- link to the canonical report and its verification path;
- not hide missing cells, conflicts, or adverse results that materially
  change the interpretation;
- remain attributable to the report version (digest) it derives from.

The **claim package** (§4.6) is the mechanical form of this rule: its assets
embed the scope statement and digest-link to the full report, matrix, run,
and benchmark records — evidence that outlives the product (charter §2).

## 9. Branding isolation

`packages/benchmark-product/core/src/branding.ts` exports a single
`ProductBranding` object — display name (placeholder), tagline, and the
factual attribution line *"Runs on Jinn benchmarking records — independently
verifiable"* — consumed everywhere a product name or attribution appears
(CLI banner, GUI chrome, report presentation, claim assets). Rules:

- **Placeholder display-name posture:** the codename is plainly a
  placeholder; a later branding engagement replaces the display name by
  editing this one module, with no architectural change (A1).
- **No Jinn lexicon, sigils, palette, or mythology** anywhere in product
  surfaces. The product's visual identity is its own (and unset in v1).
- **Factual attribution only**, and only in about/verification contexts —
  never in the product name, primary navigation, category explanation, or
  hero copy (charter §1, §11).

## 10. Non-goals

Inherited from charter §12 and the benchmarking design §19, plus the program
plan's REJECT list (§4.8). The product is not, and does not build:

- an official **leaderboard** or benchmark authority (no ranking record
  beyond the Report);
- a log/transcript **viewer** (Inspect's territory — `exportEvalLog` and
  `inspect view` are the seam);
- a task-**authoring studio** or universal evaluation development
  environment (simple native task setup only; compose Inspect for advanced
  authoring);
- **marketplace matching** — coverage, quotes, dispatch, settlement stay
  with the marketplace;
- an **operator console** — harness/credential setup, machine readiness,
  and safe execution stay with the operator product;
- **billing in v1** — funding, credits, service fees, fiat display, and
  settlement-asset handling are deferred;
- a **confidential-execution tier** (public-first posture; charter §5);
- a general agent-orchestration, observability, or tracing platform; a
  model/agent hosting platform; a universal sandbox service; a provider
  credential proxy or inference reseller; a certification body; a marketing
  automation suite; a branded frontend for the underlying Jinn stack.

And, as consumption-contract refusals restated (§3): nothing that forks
record semantics, adds aggregates to matrices, or presents assurance preset
names as protocol terms.

## 11. Extraction-readiness posture

Extraction is a consequence of readiness, never a goal (platform
architecture §6), and a green gate is never itself authorization to move —
extraction would require its own decision record. From day one the tree
behaves so the gate is later mechanical:

- **Own CI**: the `benchmark-product-ci` workflow gates the family; the tree
  never rides another tree's gate.
- **No cross-tree source reach-ins**: platform dependencies are consumed as
  ordinary package dependencies (workspace `portal:` links until the stable
  publish path lands — gate item 1 is honestly unsatisfiable repo-wide until
  then, per platform architecture §6); never `src/`-path imports into
  sibling trees.
- **No vendored platform code** (gate item 8): platform behavior resolves
  only to the canonical packages; the `packages/autopilot` copy is the named
  counterexample this rule exists to prevent.
- **Guard trio wired into CI**: package-inventory and packed-types guards
  follow the `packages/benchmarking` family pattern; the allowlist
  source-boundary guard (with positive controls) is cloned from the
  policy-optimization guard (program plan §4.1).
- **No tier-1–3 references to it**: nothing in tiers 1–3 imports the
  product, and no tier-1–3 kit, guard, or fixture references it (§2) — kept
  true by the same guards.
- **Catalog hygiene**: authority documents, gate name, and boundary policy
  registered so `generate-architecture.mjs --check` stays green.

## 12. Reversible assumptions and deferred decisions

Labeled assumptions made by this spec where the program plan left a genuine
gap. Each is reversible without architectural change:

- **A1 — codename and display name.** `benchmark-product` /
  `@jinn-network/benchmark-product-*` internal codename; placeholder display
  name in `branding.ts` (program plan §4.1's own labeled assumption,
  restated). A branding engagement replaces the display name; renames at
  extraction are mechanical.
- **A2 — quote invalidation.** Any `edit` of a quoted draft returns it to
  `draft` and invalidates the quote (a quote always describes the exact
  draft it priced). Chosen here; the program plan names the states but not
  this rule.
- **A3 — default authority mapping.** `lock`, `launch`, `cancel`, `publish`
  require explicit authority grants; read operations require workspace
  membership. Policy defaults are v1 product policy, refined in BP-10.
- **A4 — workspace directory naming.** The drafts/sealed/artifacts/journal
  split is normative (§4.5); exact directory and file names are
  implementation detail for BP-10.
- **A5 — preview availability.** `preview` is available in `draft` and
  `quoted` and never advances the lifecycle; the program plan's `(preview*)`
  notation is formalized as a repeatable non-advancing operation.
- **A6 — report authorship identity.** The Report's DSSE author identity is
  the acting principal's signing identity as configured in the workspace;
  the exact key-management story lands with BP-13.
- **A7 — audit-entry shape.** The journal entry shape (§4.4) adds a
  `subject` field and names the timestamp `at`, refining the program plan's
  descriptive list (actor, action, timestamp, inputs digest, outcome);
  field-level shape settles in BP-10.
- **A8 — typed error taxonomy.** The §4.3 error categories are a v1
  starting set, refined per operation in BP-10; the posture (typed results
  or typed errors, never silent fallbacks) is fixed.

Deferred decisions recorded (not assumptions — explicitly deferred by the
program plan §4.4/§4.8): MCP surface; HTTP API; billing/funding/fiat;
confidential modes; challenger-run mechanics beyond clone/rerun;
leaderboards; marketplace-venue GUI depth. Charter §15's open items (product
name, agent authentication details, Inspect integration depth, report
hosting model, and others) remain open at the charter level.

**Addendum — 2026-08-05, packet BP-10 (implementation refinements recorded
against this spec's labeled assumptions; no §4/§5/§6 decision reopened):**

- **A8 realized.** The v1 error-code set as implemented: `validation`,
  `illegal-transition`, `authority-denied` (the §4.3 `authority` category),
  `record-integrity`, `journal-integrity`, `not-found`, `conflict`,
  `invalid-invocation`; `venue-unavailable`, `venue-unverifiable`, and
  `execution` reserved for the venue and launch packets.
- **A3 realized.** The gated-operation set enforced at the operations
  boundary is `lock`, `launch`, `cancel`, `report`, `publish` — §4.1's
  approval-gated rows; A3's prose omits `report` and this addendum keeps the
  table authoritative. Workspace membership is required for every operation,
  reads included.
- **§6 mapping refinement.** `evaluator-panel` and `strict-agreement`
  resolve `distinctEvaluator: true` (the §6 table names the field explicitly
  only for `separate-evaluator`; a panel of non-distinct evaluator
  identities would not be a panel). Overridable through the preset's
  resolved primitive overrides, and disclosed like every other resolved
  primitive.

**Addendum — 2026-08-05, packet BP-11 (§3 consumption-contract additions for
task intake; no §3 refusal, §4/§5/§6 decision, or record semantics
reopened):**

- **§3 rows activated.** BP-11 begins importing two packages the §3 table
  already names, with the exact public exports consumed:
  `@jinn-network/benchmarking-interop` — `importSweBench`, `defineBenchmark`
  (plus their public types) for the SWE-bench-shaped import seam and the
  sample Benchmark's sealing; `@jinn-network/task-execution-protocol` —
  `sealTask`, `documentDigest` for re-sealing the bundled sample's native
  prediction-forecast Tasks.
- **§3 row added: `@jinn-network/task-admission`.** Not in the original §3
  table. Consumed public exports: `loadPredictionSnapshotFixture`,
  `verifyPredictionSnapshotFixture`, `admitPredictionSnapshot`,
  `sealPredictionSnapshotAdmissionReceipt`. Role: the golden
  prediction-snapshot fixture is the derivation base for the product's
  bundled REAL sample benchmark (dossier §1, §3 decision 2), and the
  admission machinery mints the receipts that later let sample cells reach
  `re-derivable` integrity. The sample's admission receipts are DSSE-sealed
  with a product-bundled, deliberately non-secret Ed25519 sample key that
  exists solely so the bundled sample's bytes reproduce byte-for-byte; it
  attests nothing beyond "the bundled sample admitted its own tasks" and is
  never used outside the sample.
- **Test-only dependency: `@jinn-network/task-execution-launchers`.**
  devDependency, consumed by exactly one test surface: the sample intake's
  shape-contract test runs the real `prediction-v1-baseline` launcher's
  `plan()` and spawned argv as a subprocess against the bundled sample Task
  bytes (dossier §1 sample-task facts). The source-boundary guard enforces
  that no non-test source file imports it; a packed consumer never installs
  it.
- **EvaluationSpec reuse, stated.** The prediction-snapshot admission policy
  pins the EvaluationSpec content byte-exactly, so every bundled sample Task
  binds the golden fixture's EvaluationSpec verbatim (same digest); varying
  it would make admission refuse. "Each Task's bound EvaluationSpec" for the
  sample therefore means the same sealed spec bytes bound by digest from
  each Task — recorded here so no later packet mistakes this for an
  oversight.

**Addendum — 2026-08-06, packet BP-12 (§3 consumption-contract activation for
the run path; no §3 refusal, §4/§5/§6 decision, or record semantics
reopened):**

- **§3 rows activated.** BP-12 begins importing, as runtime dependencies,
  packages the §3 table already names: `@jinn-network/benchmarking-run`
  (`planRun`, `quoteRun`, `launchAndWatch`, `resumeRun`, `assembleMatrix`,
  `verifyMatrix`), `@jinn-network/benchmarking-local`
  (`localAssemblyPorts`), `@jinn-network/task-execution-backend` (types),
  `@jinn-network/task-execution-backend-local`
  (`makeLocalTaskExecutionBackend`), `@jinn-network/task-execution-launchers`
  (`predictionV1BaselineLauncher`, `LauncherContract` — promoted from the
  BP-11 test-only devDependency to runtime, superseding that addendum note),
  `@jinn-network/task-execution-evaluation-harness` (`/launcher` entry:
  `makeEvaluationLauncher`), `@jinn-network/task-execution-evaluator-adapters`
  (`createEvaluatorDeployment`, prediction registration),
  `@jinn-network/task-execution-profiles` (`deriveEvaluationTask`, profile
  builders, `parseEvaluationSpec`, `VERDICT_DSSE_PAYLOAD_TYPE`),
  `@jinn-network/task-execution-workspace` (`harvest`, provisioner types),
  `@jinn-network/task-execution-supervisor` (attempt-identity types), and
  `@jinn-network/trust-core` (`sealDsseEnvelope`, `dssePreAuthEncoding`,
  `parseDsseEnvelope`, `DsseSigner`).
- **Verdict DSSE wrapping (dossier G2), realized with one repository-fact
  correction.** The dossier's cited pattern (`sealSignedRecord` + payload
  byte-equality, `client/src/daemon/native-evaluator-composition.ts`) cannot
  hold against a real spawned evaluation harness: the harness writes
  `out/verdict` via the attestation-issuer's pretty-printed
  `deterministicJsonBytes`, while `sealSignedRecord` re-canonicalizes via
  trust-core's compact `canonicalJsonBytes`, so the byte-equality assertion
  is unsatisfiable. The product wraps the harness's statement bytes
  verbatim (`dssePreAuthEncoding` + `sealDsseEnvelope`), never
  re-canonicalizing — recorded in `src/venue/signing.ts`.
- **Venue honesty realizations (§7.1).** Local-venue identity resolution
  echoes the venue's own recorded claims (solver = run owner; evaluator =
  the verdict's claimed evaluator identity) — a disclosed self-run
  limitation, not independent verification. The bundled sample's evaluation
  context derives a deterministic resolution snapshot from each sample
  task's own payload, labeled sample-resolution data in
  `src/venue/resolution.ts`; it grades the bundled sample deterministically
  and attests nothing about any real market.
- **A4 refinement (run-path state).** Run-side product state lives beside
  the draft, not on it: `runs/<draftId>.json` (run state), a per-run
  append-only journal `runs/<draftId>.journal.jsonl`, and
  `artifacts/<draftId>/results.json`; the draft document itself only
  advances its lifecycle `state`. Quote invalidation (A2) is enforced by a
  spec digest recorded at quote time and re-checked at lock.

**Addendum — 2026-08-06, packet BP-13 (report leg + complete run-path CLI;
no §4/§5/§6 decision reopened):**

- **§3 row activated: `@jinn-network/benchmarking-aggregate`.** Consumed
  public exports: `produceReport`, `verifyReport`,
  `BENCHMARKING_METHOD_REGISTRY`, and their port types — the Report
  production/verification seam (M1 method `wilson@1`, `verdictRule: sole`
  under the Direct-check preset).
- **Verdict canonicality correction (repository fact, amends the BP-12
  addendum's verbatim-wrap note).** The aggregation boundary
  (`resolveVerdictOutcome`) requires every Matrix-referenced verdict DSSE
  payload to be the exact trust-core canonical encoding; the harness's
  pretty-printed statement bytes can never satisfy it. `sealVerdictStatement`
  now seals `canonicalJsonBytes(statement)` — a content-preserving
  re-encoding of the harness's own statement, signed once at seal time. A
  statement carrying a non-safe-integer JSON number refuses fail-loud (the
  prediction adapter's scores are decimal strings; the real venue is
  unaffected).
- **Preregistration realization.** `derivePreregistered` compares the Run's
  `analysisPlan` entry parameters against the report method tuple with
  `verdictRule` merged in by `produceReport`; the compiled `analysisPlan`
  therefore carries `{ verdictRule }` from the draft's resolved assurance
  preset. `ProduceReportInput.method.parameters` stays `{}` per the M1
  composition dossier; the merge is the platform's.
- **A6 realized (report authorship and key management).** The Report's DSSE
  author is the run-owner IRI; signing uses a second workspace-held Ed25519
  key (`venue/report-signing-key.pem`, `did:key` keyid), separate from the
  verdict key — role separation (venue evaluator vs report author) and
  independent rotation; on the self-run venue the same operator holds both,
  disclosed, never hidden. `verify`'s authenticity leg resolves a
  workspace-local synthesized genesis binding built from the workspace's own
  key material — no third-party attestation, no anchoring — the §7.1
  self-run trust root, named in the claim package's verification section.
- **Claim package realization (§8.2, §4.6).** The machine-readable claim
  package is materialized at `report` time as a workspace-derived artifact
  (`artifacts/<draftId>/claim-package.json`, one of §4.5's "claim packages");
  the later `publish` packet emits it as the public bundle per §4.1 —
  report-time materialization does not reopen §4.1's publish semantics.
- **§5.2 completed for the run path.** CLI verbs `quote`, `lock`, `launch`,
  `resume`, `status`, `collect`, `results`, `report`, `verify`, each with
  `--json`; long-running `launch`/`resume` stream one progress line per cell
  event on a diagnostic stream (stderr) in human mode only. §5.4 parity is
  now test-enforced (bidirectional operation↔verb parity test; BP-14
  formalizes the capability matrix).

**Addendum — 2026-08-06, packet BP-20 (previews as disclosed rehearsal +
quote presentation depth; no §4/§7 decision reopened):**

- **A5 realized (preview mechanics).** `preview` is an ungated operation,
  legal in `draft` and `quoted` only, refused typed once locked. It runs the
  draft's arms × a caller-bounded item subset (first N items; default all)
  on the real local venue rooted in a throwaway scratch area
  (`previews/<draftId>/<previewId>/scratch`), via an EPHEMERAL in-memory
  subset Benchmark and planned Run whose bytes are never stored in the
  sealed store. Scope is solve-cells-only (no evaluation legs), labeled as
  such in the artifact. No Run is sealed, no lifecycle state advances, the
  draft file is not rewritten (§4.6's "preview artifacts" collection lives
  in the `previews/` area, keyed by draftId, so the drafts store stays
  byte-stable across previews); the only official-state write is the §4.4
  audit entry.
- **§7.2 disclosure realized.** Every preview appends to a per-draft
  preview log (`previews/<draftId>/log.json`); each preview artifact leads
  with the marker "rehearsal — not official evidence". At `report` time a
  non-empty log adds one disclosure line (count + timestamps) to the sealed
  Report's `limitations` and a structured `rehearsal` block
  (`{ previewCount, timestamps }`) to the claim package; an un-previewed run
  carries neither. Run compilation reads only the draft spec, so the
  preview log is excluded from the sealed Run by construction —
  test-enforced byte-identity between previewed and un-previewed
  compilation.
- **§4.6 Quote row deepened.** `quote` now returns a machine-readable
  presentation: run size (solve cells, required evaluation cells =
  solve × resolved `minVerdicts`, per-arm line items), coverage facts
  (venue-supported pinning keys and per-arm refusals derived from the
  venue's real capabilities), the hard-cap check result, and — only when
  the draft's preview log carries real rehearsal timings — a wall-time
  estimate labeled `estimate-from-rehearsal`. Estimates are never
  synthesized from anything but rehearsal data; absent previews, the field
  is absent. CLI verb `preview` (`--items <n>`, `--json`) added; parity
  matrix regenerated.

**Addendum — 2026-08-06, packet BP-21 (multi-evaluator assurance on the local
venue; no §4/§6/§7 decision reopened):**

- **Independence recon finding (§6/§7.1).** The platform's
  `checkEvaluatorIndependence` tests fail-closed identity resolution plus
  solver/evaluator Agent-IRI distinctness. On the self-run venue the product
  now satisfies it truthfully in the agent-distinctness sense: evaluator
  identities are distinct workspace-minted Ed25519 keys (one per
  `venue/evaluators/<i>/` slot, plus the legacy pair), and the product's
  assembly trust resolver resolves an evaluator claim only after verifying
  the verdict's DSSE signature against that identity's registered workspace
  public key — fail-closed to `unresolved` otherwise. Party-independence
  remains unproven and disclosed (§6 residual): the same operator mints and
  holds every key. Consequence: NO assurance preset refuses at lock on the
  local venue; all four presets run.
- **Per-attempt evaluator selection mechanism.** Each evaluation leg names
  its evaluator via a product-namespaced Submission requirement key
  (`jinn.benchmark-product/evaluator`), declared by a product-owned wrapper
  of the evaluation launcher's capabilities. Submission-only requirement
  keys merge freely under the platform's tighten-only merge; the key is
  declared in the backend's `runPinning` inventory.
- **Test-only disagreement hook, disclosed.** The venue exposes
  `evaluationContextVariationForTesting`, used only by tests to manufacture
  controlled evaluator disagreement; it never runs in production paths.

**Addendum — 2026-08-07, packet BP-22 (cancellation + infrastructure
accounting; no lifecycle, record, or platform-orchestration decision
reopened):**

- **Durable intent and two-phase finalization (§4.1).** The gated `cancel`
  operation publishes a write-once, schema-valid per-run marker before
  probing the venue, fsyncing both the complete owner file and runs directory
  around exclusive hard-link publication/owner cleanup. Malformed marker
  bytes fail closed as record-integrity in hot, finalization, status, assembly,
  and verification paths. If a live driver owns the venue it returns typed `requested`;
  a retry repairs the independently idempotent journal echo and, once the
  venue is free, drains every expected cell, seals a Matrix whose
  `completeness.runOutcome` is `cancelled`, and closes the draft. Terminal
  idempotency re-reads that sealed Matrix and succeeds only when its outcome
  is truly cancelled; a stray marker can never bless a naturally completed
  run.
- **One finalizer and one attribution.** `collect` and `cancel` share a
  product-owned, cross-process per-run single-writer boundary (complete
  owner record, PID-start identity, token-exact publication, and a
  freshness-aware recovery guard that serializes stale-owner reclamation
  without displacing a successor). Every guard acquisition is fenced against
  the same directory inode and a sole exact marker name/token/inode immediately
  before ownership returns. An apparently crashed ownerless initialization is
  adoptable only when the exact moved inode still contains the byte-identical
  invalid snapshot; if initialization completed or changed meanwhile, that
  exact inode is restored non-overwriting to the fixed ownerless name and the
  reclaimer yields. Process liveness is tri-state: a missing start-time
  probe is never treated as death unless a PID existence probe proves `ESRCH`;
  live, permission-denied, and otherwise unknown owners remain contended.
  Crashed owners and crashed recovery-guard initialization remain recoverable;
  malformed, symbolic-link, or non-regular records fail closed. The
  boundary covers marker inspection/publication through the terminal
  lifecycle write, eliminating collect/cancel TOCTOU and concurrent-cancel
  attribution overwrite or duplicate intent facts. Symbolic-link or
  non-regular intent/lock paths fail closed.
- **Live-attempt cancellation uses platform ports (§3).** A product-owned
  backend decorator watches/polls the durable marker and invokes the real
  backend's existing `cancel(attempt)` port for an observably nonterminal
  solve attempt. Accepted submissions remain pending through first observe,
  and active attempts remain tracked through their true terminal snapshot;
  the marker cannot abort the platform signal across either race window.
  A marker found at a genuinely idle dispatch boundary is instead exposed
  through the platform's existing `earlyClose` port. Thus `launchAndWatch` /
  `resumeRun` remain the sole
  owners of dispatch, watch, terminal classification, and drain semantics;
  no second orchestration implementation exists. Real-local-venue coverage
  proves the subprocess receives SIGTERM/SIGKILL and terminalizes cancelled
  before undispatched cells are boundary-drained.
- **Failure-accounting and denominator law (§8.2).** Solve terminal errors
  may carry only platform-observed `task` or `infrastructure` blame; blame on
  any non-error journal event is an integrity failure. Subprocess-kill,
  unscorable, expired, and cancellation-drained cells stay explicit in
  Matrix completeness/attrition and result/claim surfaces. Only judged cells
  enter score denominators: infrastructure failures and every other
  unjudged/expired cell are never silently converted into score losses.

**Addendum — 2026-08-06, packet BP-30 (web skeleton; no §4/§5/§9 decision
reopened):**

- **§5.3 partially realized.** `packages/benchmark-product/web`
  (`@jinn-network/benchmark-product-web`) now exists as the Next.js App
  Router + shadcn/ui skeleton and is registered as the family's second
  catalog member (tier 4, product, experimental,
  `transitional-or-private`, gate `benchmark-product-ci`). It renders the
  placeholder shell only — NO operations wiring. BP-31+ wire the operations
  library in-process server-side and add the web→core dependency edge to
  the inventory graph and the source-boundary allow-list together.
- **§9 realization note.** The shell renders the placeholder display name
  and tagline from a local module that TEMPORARILY duplicates two of core
  `branding.ts`'s strings (the core import is deferred with the rest of the
  wiring); a web test pins the strings byte-equal to core's source so the
  §9 single-source rule is drift-guarded until BP-31 replaces the module
  with the import. The attribution line is deliberately absent from the
  shell — no about/verification surface exists yet, and §9 forbids it in
  hero copy.
- **App spec.** `packages/benchmark-product/web/BENCHMARK-PRODUCT-WEB-SPEC.md`
  (four-axis domain model derived from §4.6) accompanies the source per the
  repo frontend rules and is registered as an authority document on the web
  catalog record.
- **Packed-types decision, recorded.** The web application is deliberately
  excluded from the family's packed-entrypoint type consumer (`private:
  true`, no public package entrypoint — nothing installs it); the guard's
  family-coverage assertion keeps the exclusion explicit rather than
  silent.

**Addendum — 2026-08-07, packet BP-31 (M3 setup flow and GUI parity; no
§4/§5/§7/§9 decision reopened):**

- **§5.3 server-side client realized.** The private web application has
  exactly one production Jinn dependency, the public package entry of
  `@jinn-network/benchmark-product-core`. All reads and Server Actions are
  server-only in-process clients of that entry. There are no HTTP route
  handlers, deep imports, sibling source escapes, client-side core imports,
  or duplicated validation/transition/quote/preview semantics. The web
  dependency's portal closure is pinned, and CI restores the already-built
  runtime graph before web install/typecheck/test/build.
- **Fail-closed product context.** A web process must receive an explicit
  absolute workspace directory and explicit principal. Only those two
  validated values plus the server clock enter an operation context; no
  credential, private key, secret, or ambient environment object crosses
  into browser state. Known configuration/form failures produce safe typed
  details; unexpected exceptions are redacted. Core `OperationResult`
  errors retain their typed code and retry guidance; runtime-origin
  `execution`/venue details are redacted only at the GUI trust boundary.
- **§4 setup surface realized.** Routes and accessible forms now cover
  workspace init; draft create/read/list/edit/inspect; bundled sample and
  SWE-bench intake; arm add/update/remove/list; authority show plus visibly
  sponsor-only grant/revoke; real-local-venue preview; quote; and gated
  lock. Mutations revalidate the affected workspace/draft routes. A
  temporary-workspace integration test drives the entire Server Action
  layer through that order; preview exercises the real local venue rather
  than the in-memory kit backend.
- **§5.4 GUI parity realized.** The generated capability matrix now carries
  an explicit GUI cell for every shipped library operation/CLI row. A
  server-only action registry is checked bidirectionally against the public
  core GUI catalog: an unregistered rendered action or a silently omitted
  eligible operation fails. BP-32 explicitly owns `launch`, `resume`,
  `cancel`, `status`, and `collect`; BP-33 explicitly owns `results`,
  `report`, and `verify`. Existing non-operation exclusions
  `unverifiableAxisCounts` and `publish` remain named rather than silently
  treated as GUI capabilities.
- **Public consumer/build contract.** Core's root entry now exports
  `runPreview` and its input/dependency/result/artifact types, quote
  presentation types and `LOCAL_VENUE_LIMITS`, the GUI capability catalog,
  and `PRODUCT_BRANDING`. Source-entry tests and packed external consumers
  cover the additions. Node 22.23's synchronous `require()` of this ESM
  graph is a deliberate package contract used by the webpack server
  external; both packed `import`/`require` smoke and production `next start`
  route loading prove it rather than relying on a build-only assumption.

**Addendum — 2026-08-07, packet BP-32 (M3 durable run control; no
§4/§5/§7 lifecycle, authority, or venue-orchestration decision reopened):**

- **Official-run GUI parity.** The five prior BP-32 dispositions now map to
  stable server actions (`run.launch`, `run.resume`, `run.status`,
  `run.cancel`, `run.collect`). The responsive run monitor renders only
  public `runStatus` facts: lifecycle, cancellation intent, counts, cell
  terminals/details/blame, and durable driver outcome. BP-33's
  results/report/verify rows are the only remaining GUI deferrals.
- **In-process response lifetime.** Launch/resume start the public core
  operation promise in the Server Action and retain that exact promise with
  Next `after()` when it crosses the response boundary. No CLI child, API
  route, second driver, or web-owned orchestration exists. Immediate
  configuration/authority/state failures return typed errors; later failures
  are appended by core to a generation-aware run journal and folded into
  `runStatus`, so a scheduled response cannot become an invisible failure.
- **Driver causality and ownership.** A driver generation is journaled only
  after the real local backend synchronously proves it owns the state-root
  writer. The narrow public backend assertion performs no launcher probes;
  readiness remains async inside the journaled generation. Therefore a
  concurrent writer loser creates no generation, while delayed readiness or
  drive failure becomes durable. Cancellation-wrapper close and venue
  shutdown complete before a generation terminal is appended, so a late
  resource-release rejection becomes the generation's single durable
  `driver-failed`, never a false success. UUID generations remain distinct
  under frozen clocks; latest journal event order is the outcome authority.
- **Real-venue cancellation proof.** Integration coverage starts a delayed
  real subprocess, observes nonterminal durable state, writes gated cancel
  intent while the venue is busy, observes requested/draining, confirms the
  backend signal terminal, and retries finalization to a cancelled Matrix
  accounting for all expected cells. The delay dependency is explicitly
  test-only and the web exposes it only behind two independent server-side
  environment opt-ins, capped at core's 60,000 ms maximum; neither value
  reaches browser state.
- **GUI trust and narrow-screen boundary.** Durable driver error details stay
  exact in core/CLI records but are projected to typed-code-plus-retry text at
  the server-rendered browser boundary, because backend/preflight exceptions
  can contain paths or secret-bearing command material. At closed state a
  valid cancel marker renders finalized cancellation, never draining. Action
  forms and terminal JSON output shrink, wrap, or scroll inside their grid
  cell so the monitor remains within a 390 px document viewport.

**Addendum — 2026-08-07, packet BP-33 (M3 result, report, claim, and
verification surface; no §4/§5/§7/§8 semantics reopened):**

- **M3 GUI parity complete.** The final three dispositions now map to stable
  Server Actions (`run.results`, `run.report`, `run.verify`). The generated
  matrix has no deferred operation rows. Its two exclusions remain explicit:
  `unverifiableAxisCounts` is a helper rather than an operation, and `publish`
  is reserved until an operation ships. No EvalLog, Croissant, static-bundle,
  or publish control is rendered ahead of M4.
- **Core-owned reload projection.** `runResults` remains the one result read
  authority and now adds an optional reported projection after the durable
  `reported` transition. It re-reads the exact sealed Report payload and
  envelope by digest, validates the stored claim package, and returns those
  facts verbatim. It performs no scoring, claim derivation, signature check,
  or recomputation and therefore labels verification honestly as `not-run`;
  the separate `runVerify` operation remains the only skeptic path. This
  additive projection is exported through source and packed public entries.
- **Semantic human surface.** `/workspace/[draftId]/results`, linked from the
  draft and durable run monitor, renders Matrix completeness, attrition and
  asymmetry, every frozen cell outcome/verdict/dissent/cost/latency/failure,
  axis visibility, and local-venue limits. After report it renders the sealed
  Report, exact method/preregistration/disclosures/limitations, and every
  stored claim-package block (scope/pinning, record links, headline,
  completeness, attrition, conflicts, assurance, disclosures, rehearsal,
  venue honesty, and verification instructions). Wide tables scroll locally
  at narrow widths; headings, captions, live regions, and typed fail-loud
  errors preserve the accessibility contract. Rich result JSON is not used
  on this flow.
- **Verification and trust presentation.** Report is visibly gated and is
  deliberately non-idempotent. Its action revalidates the current result
  route so durable Report/claim facts survive and appear after reload.
  `runVerify` renders its named checks and exact digests on success; a typed
  record-integrity or recomputation divergence remains prominent and never
  becomes a passing state. BP-32's browser-safe projection for arbitrary
  runtime diagnostics remains unchanged. `PRODUCT_BRANDING.attribution`
  appears only in the verification landmark.
- **Real composition proof.** Server-Action integration drives the default
  real local venue through init, draft/sample/two arms, quote, lock, launch,
  durable status/resume, collect, results, gated report, result reload, and
  all three verification checks. Returned Matrix, Report, claim, and check
  facts are the public core results consumed by the route; the web does not
  read workspace files or import a second implementation.

**Addendum — 2026-08-07, packet BP-40 (portable public-bundle authority;
no record, aggregation, orchestration, or venue semantics reopened):**

- **Platform projection versus product materialization.** The existing
  `@jinn-network/benchmarking-interop` `exportStaticBundle` function is the
  product-neutral metadata projection only: it names the static-bundle format,
  Matrix digest, conventional files, and Report count. The Tier-4 product owns
  the gated materialization, immutable local publication, manifest, portable
  trust material, and standalone verification experience around that exact
  projection. It does not fork any platform record or verification rule.
- **Publish means local immutable emission only.** In v1 `publish` emits a
  complete bundle directory under the workspace and advances `reported` to
  `published-bundle`; it performs no upload, hosting, deployment, remote write,
  or package publication. The operation is authority-gated. It runs the same
  three Matrix-rederivation, Report-verification, and claim-consistency checks
  as `run.verify` before staging any output.
- **Allowlisted public evidence closure.** The fixed closure contains only
  `bundle.json`; the exact `static-bundle.json` platform projection; exact
  Benchmark, Run, Matrix, Report payload, Report envelope, and claim-package
  bytes; deterministic verdict and evidence catalogs; exact allowlisted
  content-addressed records; a privacy-minimized verification assembly journal;
  an optional validated cancellation marker; public Report/evaluator trust
  material; and the reserved presentation paths `index.html`, `badge.svg`,
  `social-card.svg`, `README.md`, and `share.txt`. Mutable drafts, authority and
  audit state, scratch data, environment data, credentials, private PEMs,
  absolute workspace paths, and every unexpected file are excluded. Gated
  publication authorizes disclosure of this explicit closure; it is not a
  general PII scrubber and makes no promise about arbitrary content already
  sealed into public records.
- **Manifest and identity.** `bundle.json` lists every other file exactly once
  and never lists itself. Paths are normalized relative paths with no absolute,
  empty, dot, parent, duplicate, symbolic-link, or special-file entries. Each
  entry binds path, exact byte length, and SHA-256. Bundle identity is the
  lowercase SHA-256 of the exact canonical manifest bytes. A verifier rejects
  missing, extra, reordered/duplicate, malformed, or byte-mismatched closure.
- **Crash safety and immutability.** Publication builds a complete sibling
  staging tree, fsyncs every file and directory, and atomically renames it to a
  digest-addressed final target with no overwrite. Only after the final tree is
  durable does the product record the bundle identity/path in RunState and then
  perform the lifecycle transition as the last write. Retries converge across
  faults before rename, after rename, before RunState, and before transition;
  concurrent identical publishers converge on the same bytes, while an
  existing different target refuses rather than overwriting.
- **Portable verification and trust.** Standalone verification consumes bundle
  bytes only and must still pass after the entire source workspace is removed.
  The trust document contains the Report author, keyId, matching did:key,
  Ed25519 SPKI public key, and validity start, plus exactly one public evaluator
  key for every Matrix-referenced verdict; key ids and evaluator identities are
  cross-validated against the signed envelopes and catalogs. No standalone path
  reads a private key. Trust remains honestly self-run: the workspace minted all
  keys, and distinct evaluator keys demonstrate agent-distinctness only, not
  custody or party independence.
- **Complete future-run closure and legacy refusal.** Future real runs persist
  the exact derived evaluation Task and evaluation Delivery bytes and journal
  their digests, completing the evidence graph needed by a portable verifier.
  A pre-BP-40 run missing any mandatory referenced bytes refuses publication
  honestly; the publisher never fabricates or re-derives absent historical
  evidence.
- **Neutral outputs only.** The current `wilson@1` Report contains per-arm facts
  but no registered comparative winner. BP-40 publication and its reserved
  assets therefore state neutral scope, completeness, method, limitation, and
  verification facts only; they never select a winner from point estimates or
  imply certification.
- **One operation, three peer surfaces.** `runPublish` is the sole publication
  operation. The CLI exposes `publish` and standalone `bundle verify --bundle
  <dir> --json`; the GUI calls `runPublish` server-side and verifies only the
  current draft-owned bundle identity through the same library verifier. The
  browser can never supply an arbitrary filesystem path. Public exports, packed
  types, and the generated capability matrix cover both peer surfaces without a
  second materializer or verifier.

## 13. Provenance

Authored by packet BP-00 of the standalone benchmarking product
implementation program (program plan §5, ledger §8), in a local session with
no remote side effects. Decision sources, in authority order: the product
charter v0.2 (product intent), the program plan §3–§4 (fixed product and
architecture decisions — this spec formalizes them and reopens none), the
benchmarking application design (records and capabilities), and the platform
architecture (tier law, inclusion test, extraction gate). Export names in §3
were verified against each package's public entry in this worktree on
2026-08-05. Status remains `draft` until human review; per the program
plan's merge-readiness caveats (§9), nothing here is merge-ready until an
owning GitHub Issue exists.
