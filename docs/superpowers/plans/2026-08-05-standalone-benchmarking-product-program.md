# Standalone Benchmarking Product — Implementation Program

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-05 |
| **Shape** | program plan (noncanonical; the ledger of record for this implementation session) |
| **Charter** | `~/Downloads/2026-08-05-standalone-benchmarking-product-charter-v0.2.md`, v0.2, 2026-08-05 (session-attached; not in-repo) |
| **Baseline** | `integration/evidence-v1` at `1fb3e78f13b804db7a0583cacacff5c39dc8c51e` (== `origin/integration/evidence-v1` at session start; the charter's stated baseline `017870bfc` is an ancestor — the branch advanced between charter authoring and this session) |
| **Session branch** | `claude/standalone-benchmarking-impl-280802` (dedicated worktree; integration worktree for this program) |
| **Authority** | Human master prompt, 2026-08-05: local implementation only. No pushes, no PRs, no issue mutation, no publishing, no deployment, no remote side effects. GitHub Issue ceremony is NOT waived — merge-readiness caveats in §9. |
| **Product design spec** | `docs/superpowers/specs/2026-08-05-benchmark-product-design.md` (authored by packet BP-00; the catalog authority document) |

## 1. Session mechanics (recorded per master prompt)

- **Hierarchy mode: nested.** Verified empirically at preflight: a general-purpose agent spawned an Explore child and relayed its output (`NESTED-CHILD-OK`). Claude Code 2.1.222; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` unset; `CLAUDE_CODE_SUBAGENT_MODEL` unset. Coordinator-grade agents inherit the session model (Fable 5, supersedes Opus); implementer-grade agents run `sonnet`.
- **Permission hardening applied** (the one authorized settings change): created `.claude/settings.local.json` in the session worktree with `permissions.deny` rules covering `git push` (both bare and argumented), `gh api`, `gh issue create|edit|close|reopen|comment|delete|transfer`, `gh pr create|edit|merge|close|ready|reopen|comment|review|lock`, `gh release`, `gh repo`, `gh project`, `gh label`, `gh workflow run|enable|disable`, `gh secret`, `gh variable`, `gh gist create`, `npm publish`, `yarn npm publish`, `yarn publish`. Read-only `gh` remains allowed. This file is operator-local (gitignored) and is not a repo change.
- **Concurrency cap:** ≤ 4 active packet coordinators; integration priority follows the milestone spine.
- **Worktrees:** packet worktrees under `/Users/adrianobradley/life's-work/jinn-mono_worktrees/bench-<packet>` created from explicit base SHAs. Known gotcha: `git worktree remove` of sibling dirs may need elevated sandbox permissions; blocked removals are recorded for manual cleanup, never force-escalated.
- **Base-refresh policy:** checked at each integration-wave boundary against `origin/integration/evidence-v1`; drift is reported and a refresh proposed; refresh only on explicit human approval. Zero drift at program start.

## 2. Program risks (recorded at orientation; none block per human direction)

1. **Demand-validation evidence for THIS charter is absent, and adjacent evidence is adverse.** The charter cites no Stage-0/P0 gate. The operator-private validation program (main checkout `.local/validation/`, not present in this worktree) ran Stage-0/P0 on adjacent territory: the "commissioned eval/benchmark desk" variant was killed twice (self-generation 0/20; mining 0/28), the panel-winning "neutral acceptance rail" variant is the live survivor with a pre-registered demand test and an explicit no-more-compute-before-demand rule. The charter's product is a *different shape* (comparative-claim commissioning + publishing for agent builders, not eval-task supply), and the charter (2026-08-05) postdates those kills — but no demand evidence exists *for* it either. Recorded as a program risk per the master prompt; the human has directed implementation.
2. **Sibling branch pointed at the same product.** `origin/claude/benchmarking-product-impl-8d4ec0` (and its local worktree `eloquent-raman-fcffbf`) sits at the same baseline with zero commits. If that session activates concurrently, two branches will diverge on one product. Coordination is a human call; this program proceeds on its own branch.
3. **Marketplace venue honesty gaps are inherited, not fixable here:** pinning axes report `unverifiable` on marketplace cells until the re-homed enforcement legs (ex-#2040/#2041) land; requester prerequisites B0b/B0c (#2447/#2448) are unbuilt. The product surfaces these as honest states (§4.6); it does not absorb them.
4. **`packages/sdk` benchmarking shapes are already retired** (`packages/sdk/src/benchmarking.ts` no longer exists); no legacy-shape migration is owed.

## 3. Fixed product decisions (charter §14 + master prompt; not reopenable in-packet)

Standalone, separately branded Tier 4 product; Jinn appears only as factual infrastructure attribution. First market: public comparative benchmarking for coding-agent/harness/skill/plugin/tool/loadout builders. Primary outcome: a credible, market-ready comparative claim. Two-plus configurations first-class. "What counts as success" is separate from "how a delivery becomes a verdict"; configurable evaluation assurance is a first-class capability. Public-first; private mutable drafts; disposable previews. The official run locks before its result is known. Every expected execution/verdict stays accounted (failures, missing, disagreement, cancellation, infra exceptions). The public report is a primary artifact; the claim package must travel (releases, READMEs, posts, challenges, agent consumption). Agent-native and human-legible: every meaningful outcome is agent-operable; authority may differ by actor; capability must not be UI-only. Compose specialists (Inspect) for advanced authoring/deep transcript inspection; no universal authoring studio, no generic trace viewer. Marketplace matching stays with the marketplace; operator readiness stays with the operator product. The product consumes Jinn records/applications and never redefines them.

## 4. Program-level architecture decisions (the product-to-Jinn contract, at altitude; BP-00 formalizes)

### 4.1 Codename and tree

- **Internal codename: `benchmark-product` directory family, packages scoped `@jinn-network/benchmark-product-*`.** Deliberately descriptive-neutral, plainly a placeholder, no Jinn lexicon, no invented public name. The user-facing display name is a configurable placeholder (`branding` module, §4.7). *(Reversible assumption; a branding engagement replaces the display name without architectural change. Directory/package renames at extraction are mechanical.)*
- Tree: `packages/benchmark-product/core` (M0; headless product: domain, operations, persistence, CLI) and `packages/benchmark-product/web` (M3; Next.js GUI). Family guard trio + one CI workflow cover the family, following `packages/benchmarking`'s family pattern.
- Catalog registration (per `architecture/README.md` atomic procedure): tier 4, `classification: "product"`, `stability: "experimental"`, `releaseGroup: "transitional-or-private"` (bump `expectedPackageCount`), `publishPolicy: "never"`, `ownerGroup: "architecture-control"`, own gate `benchmark-product-ci` (`.github/workflows/benchmark-product-ci.yml`), `boundaryPolicy` → `.github/scripts/benchmark-product-source-boundaries.test.mjs` (allow-list style with positive controls, cloned from the policy-optimization guard), authority documents → the BP-00 spec (status `draft`) + this program plan.

### 4.2 Consumption contract (REUSE — the default posture)

The product imports public exports only (no deep imports, no copied platform code):

- `@jinn-network/benchmarking-records` — Benchmark/Run/Matrix/Report sealing + checks + cell grammar. The product NEVER redefines these records; product state stores digests and bytes references.
- `@jinn-network/benchmarking-run` — `planRun`, `quoteRun`, `launchAndWatch`/`resumeRun`, `assembleMatrix`, `verifyMatrix`, named checks. The product implements no orchestration of its own.
- `@jinn-network/benchmarking-aggregate` — method registry, `produceReport`, `verifyReport`, `deriveDisclosures`, stats. The product implements no statistic (the policy-optimization R3 ruling adopted verbatim).
- `@jinn-network/benchmarking-local` — local venue ports (`localAssemblyPorts`, pinning bridge, admission, scope). The strongest currently implemented backend; M1 runs on it.
- `@jinn-network/benchmarking-interop` — `importSweBench`, `defineBenchmark`, `importInspectEvals`, `exportEvalLog`, `exportCroissant`, `exportStaticBundle`.
- `@jinn-network/task-execution-{protocol,profiles,backend}` + `backend-local/*` + `evaluation-harness`/`evaluator-adapters` — Tasks, EvaluationSpecs, `evaluateVerdictRule` (where success is defined), the local execution backend and launchers.
- `@jinn-network/trust-core` — DSSE signing for Reports, envelope binding verification.
- `@jinn-network/benchmarking-marketplace` — consumed only behind the venue seam (§4.6); no marketplace machinery re-implemented.
- NOT imported: `@jinn-network/core`, `@jinn-network/sdk` (catalog-classified legacy/deprecated).

### 4.3 Product-owned state vs sealed records

Mutable **product drafts** (task-set selection, arms, evaluation choice, assurance preset, policy, budget) live in a product **workspace**: file-based, atomic writes, one append-only **audit journal** (JSONL: actor, action, timestamp, inputs digest, outcome). **Lock = sealing the Run record** (platform law: identity is the pre-registration); after lock the official method is immutable by construction, and the product refuses draft mutation of a locked benchmark run. Sealed records (Benchmark, Run, Matrix, Report, Tasks, EvaluationSpecs) are stored as exact bytes in the workspace and referenced by digest. No SQLite in v1; no re-canonicalization ever.

### 4.4 One state machine, two peer surfaces

A single **operations library** (`packages/benchmark-product/core`) owns the product state machine: draft → (preview*) → quoted → locked → running → closed → reported → published-bundle. All validation, authority checks, lifecycle transitions, and audit entries live at this boundary. Surfaces:

- **Agent surface (M1): the library API + a CLI** (policy-optimization CLI conventions: `bin.ts`/`main.ts`/hand-written total `args.ts`, injected context, `--json` on every verb, typed error envelopes, exit codes). Machine-readable artifacts on disk (results JSON, claim package, report bundle).
- **Human surface (M3): Next.js + shadcn GUI** that imports the same operations library server-side. No second implementation, no HTTP API in v1 (deferred decision; recorded).
- **MCP wrapper: deferred** (decision recorded; the operator-server `confirm: true`/`mcp_preview` house pattern is the template if/when added).
- **Parity proof:** a generated capability matrix (CLI verb ↔ GUI action ↔ library operation) checked by test from M3 on; until M3 the CLI *is* the complete surface.

### 4.5 Evaluation assurance presets (product policy over platform primitives)

| Preset (product label) | Platform mapping |
|---|---|
| Direct check | `policy.independence: disclosed`, `evaluation.minVerdicts: 1`, method `verdictRule: sole` |
| Separate evaluator | `independence: gating`, `minVerdicts: 1`, `distinctEvaluator: true`, `verdictRule: sole` |
| Evaluator panel | `independence: gating`, `minVerdicts: N≥2`, `verdictRule: majority` (declared reduction) |
| Strict agreement | `independence: gating`, `minVerdicts: N≥2`, `verdictRule: unanimous` (disagreement ⇒ conflicted, dropped-with-report) |

Preset names are product policy, never new protocol terms; every report discloses the underlying primitives satisfied, retains dissenting verdicts, and repeats the agent-distinctness ≠ party-independence residual.

### 4.6 Venue honesty

Local venue: real execution, reproducibility + discipline, NO pre-registration guarantee against the owner (design §7.2 leg c) — stated in product copy and in every report produced from a local run. Marketplace venue: anchored guarantees, but pinning axes `unverifiable` until enforcement legs land, and requester prerequisites are incomplete — surfaced as explicit unavailable/attested/unverifiable states. **Preview = disclosed rehearsal**: an unregistered local run, clearly labeled, never entering official results, named in the official report's limitations when used (the design's rehearsal residual, disclosed rather than hidden).

### 4.7 Branding isolation

`packages/benchmark-product/core/src/branding.ts` exports a `ProductBranding` object (display name placeholder, tagline, attribution line "Runs on Jinn benchmarking records — independently verifiable"), consumed everywhere a name or attribution appears. No Jinn lexicon, sigils, palette, or mythology anywhere in product surfaces; factual attribution only in about/verification contexts.

### 4.8 Standards decisions beyond REUSE

- **COMPOSE:** Inspect for deep transcript inspection via the existing `exportEvalLog` (`inspect view` renders runs); Croissant + static-bundle exports as shipped. No viewer, no authoring studio built.
- **BUILD (the irreducible product gap):** draft/workspace model; lock ceremony; assurance presets; preview mode; quote presentation; live accounting surface; claim package format; report presentation; CLI; GUI; audit/authority model. Each is product policy or presentation — precisely what the platform declined to own.
- **DEFER:** billing/funding/fiat; confidential modes; challenger-run mechanics beyond clone/rerun; leaderboards; MCP surface; HTTP API; marketplace-venue GUI depth.
- **REJECT:** anything that would fork record semantics, add aggregates to matrices, or present preset names as protocol.

## 5. Milestone spine and packet DAG

Packet IDs `BP-xy` (x = milestone, y = ordinal). Shapes per handbook. Every packet: own worktree from a stated base, TDD where `feat`, independent implementer-grade review, verification evidence in the ledger (§8). M2+ packet tables are refined at their wave boundaries; M0/M1 are binding now.

### M0

| ID | Shape | Objective | Depends | Acceptance (binary) |
|---|---|---|---|---|
| BP-00 | design | Product design spec (the catalog authority document): formalizes §3–§4 as a dated spec per repo conventions | — | Spec exists at the path in the header; states fixed decisions, consumption contract, state machine, assurance mapping, venue honesty, non-goals; no tier-1–3 change proposed |
| BP-01 | feat | `packages/benchmark-product/core` skeleton + catalog entry + family guard trio + CI workflow | BP-00 | `yarn install/typecheck/test/build/pack:smoke` green in the new tree; `generate-architecture.mjs --check` green; platform-catalog + architecture-control `node --test` guards green; source-boundary guard has positive controls |

### M1 — walking skeleton (agent-interface first)

| ID | Shape | Objective | Depends | Acceptance (binary) |
|---|---|---|---|---|
| BP-10 | feat | Workspace + draft model + lifecycle state machine + audit journal + actors/authority v1 (sponsor/agent principals, approval policy at operation boundary, attributed audit entries) | BP-01 | Draft CRUD with validation; illegal transitions rejected with typed errors; every consequential op appends an attributed audit entry; tests green |
| BP-11 | feat | Intake: bundled sample benchmark (sealed Tasks + EvaluationSpecs via records/interop) + SWE-bench-shaped import + arm definition + pinned-config inspection | BP-10 | From empty workspace: sample → draft with ≥2 arms; import path produces sealed Benchmark; `inspect` shows exact pinning per arm; tests green |
| BP-12 | feat | Official run path: lock (seal Run) → launch/watch on local venue → assemble Matrix → complete accounting + machine-readable results (composition per policy-optimization `src/execute.ts` precedent) | BP-10, BP-11 | Lock refuses further edits; a real 2-arm run executes on the local backend; Matrix accounts every expected cell; results JSON exposes all six outcomes states + attrition; tests green |
| BP-13 | feat | Report + verify: `produceReport` (DSSE via trust-core) + claim package + `verify` composing `verifyMatrix` + `verifyReport` | BP-12 | Report seals and recomputes; claim package is machine-readable and links matrix/run/benchmark digests; verify exits nonzero on tampered input; tests green |
| BP-14 | test | CLI e2e walking skeleton: full lifecycle through CLI verbs with `--json`; one REAL 2-arm run (real launcher) captured as evidence | BP-10..13 | Scripted e2e passes; a real run's artifacts recorded in ledger; no GUI required anywhere |

### M2 — method depth
Previews (disclosed rehearsal), honest quotes (run-size/cost/coverage/caps via `quoteRun` + venue facts), assurance presets complete, cancellation + infra-failure accounting surfaced, dissent retention. Packets BP-20..BP-24 defined at the M2 boundary.

### M3 — human surface
`packages/benchmark-product/web` (Next.js + shadcn per CLAUDE.md frontend rules, incl. four-axis app spec alongside source), GUI as client of the operations library, parity matrix generated + tested. BP-30..BP-3x at boundary.

### M4 — public report flagship
Distribution-ready public report bundle; full scope/method/limitations/failures/dissent; raw-record access; verification path; claim package assets. BP-40..BP-4x at boundary.

### M5 — hardening
Accessibility, security review, docs, extraction-readiness evidence (gate-item dry run), cross-cutting review, final verification. BP-50..BP-5x at boundary.

## 6. Worktree and branch assignments

| Packet | Branch | Worktree |
|---|---|---|
| BP-00 | `bench/bp00-product-design` | `/Users/adrianobradley/life's-work/jinn-mono_worktrees/bench-bp00` |
| BP-01 | `bench/bp01-skeleton` | `.../jinn-mono_worktrees/bench-bp01` |
| BP-1x | `bench/bp1x-<slug>` | `.../jinn-mono_worktrees/bench-bp1x` |

Integration happens only in the session worktree on `claude/standalone-benchmarking-impl-280802`. Packet commits are cherry-picked/merged in dependency order after review. All local; nothing is pushed.

## 7. Issue coverage and drafts

No existing GitHub Issue covers this product (verified read-only 2026-08-05; #2038 is the superseded primitive epic whose product-side re-derivation was explicitly deferred). This session cannot create Issues. Locally implemented work is therefore **not merge-ready** until owning Issues exist. Draft triage-complete Issue bodies are maintained in `docs/superpowers/plans/2026-08-05-benchmark-product-issue-drafts.md` (created with the first packet wave; one draft per packet, context/impact/shape/dependencies/acceptance/non-goals).

## 8. Ledger

Updated at each packet completion and integration wave. Format: packet → state, base, head, commits, verification evidence, review, integration.

| Packet | State | Base | Head | Review | Integrated |
|---|---|---|---|---|---|
| BP-00 | **integrated** | `ad33f1d0d` | `65d8c6acf` (worktree bench-bp00) | PASS (2 rounds, 1 blocking fixed: guard-precedent attribution; sonnet reviewer) | `5bf629930` |
| BP-01 | dispatched | `5bf629930` | — | — | — |

BP-00 verification: export-verification subagent confirmed every §3 symbol
exists (3 draft-time corrections); acceptance criteria 13/13 PASS;
worktree clean; single commit.

**Platform substrate verification (orientation, 2026-08-05):** full portal dep chain (evidence → task-execution → trust → discovery → benchmarking) built green from source in this worktree; `benchmarking-local` typecheck clean, 100/100 tests pass.

## 9. Merge-readiness caveats (standing)

Owning Issues must be created by an authorized session before any PR; PRs target `next`-lineage per repo policy but this program's base is `integration/evidence-v1` per the human's direction; human CODEOWNERS review required for catalog/guard/CODEOWNERS-covered paths; no live validation, no deployment, no publication performed or claimed. Remote actions performed by this session: none.
