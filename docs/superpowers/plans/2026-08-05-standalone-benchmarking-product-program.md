# Standalone Benchmarking Product — Implementation Program

> **Interop correction (2026-08-10):** the implemented `importInspectEvals` and
> `exportEvalLog` seams did not call official Inspect APIs and did not produce a
> valid Inspect EvalLog. They are superseded by `exportMatrixProjection` plus a
> real Tier 4 evaluation-runtime adapter. Historical packet descriptions below
> record the original program; they are not current interoperability authority.
> The adapter's runtime-native closure uses `public-bundle/2`; frozen
> `public-bundle/1` is not amended in place.

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
- `@jinn-network/benchmarking-interop` — `importSweBench`, `defineBenchmark`, `exportMatrixProjection`, `exportCroissant`, `exportStaticBundle`; native Inspect integration is product-owned.
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

- **COMPOSE:** Inspect owns evaluation execution, native EvalLogs, and deep transcript inspection. The product retains exact native artifacts and uses Inspect View; it does not synthesize EvalLogs, a viewer, or an authoring studio.
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

| ID | Shape | Objective | Depends | Acceptance (binary) |
|---|---|---|---|---|
| BP-20 | feat | Disclosed real-venue rehearsal previews + honest quote presentation (run size, coverage/refusal, caps, rehearsal-sourced wall time) | BP-14 | Preview cannot mutate official state; quote facts come from `quoteRun` + venue capabilities; preview disclosure reaches Report/claim; package battery green |
| BP-21 | feat | Complete all four assurance presets, multi-evaluator execution, dissent retention, and honest local-venue independence disclosure | BP-20 | All presets run on the real local venue; panel/strict reduction is preregistered; dissent/conflict survives Matrix/results/report/claim; only signature-verified agent-distinctness is claimed |
| BP-22 | feat | Durable typed cancellation + infrastructure/task-failure accounting | BP-21 | Real nonterminal subprocess cancellation reaches the backend terminal boundary; every expected cell is accounted; cancel is gated/idempotent/crash-resumable; collect/cancel serialization and failure-denominator laws are test-proven; CLI/public parity green |

### M3 — human surface

| ID | Shape | Objective | Depends | Acceptance (binary) |
|---|---|---|---|---|
| BP-30 | design | Register the private Next.js + shadcn/ui web package and neutral cold-start shell with its four-axis app spec | BP-22 | Web install/lint/typecheck/test/build green; brand isolation, package inventory, source boundary, CI, and architecture catalog cover the new member; no operations wiring or core edits |
| BP-31 | feat | Wire workspace, draft, intake, arms, authority, preview, quote, and lock screens as server-side clients of the core public entry; add generated GUI capability parity | BP-30 | Web has one production Jinn edge (core); no deep/client-side core imports or second semantics; public preview/quote exports pack-consume; every GUI action maps to the library/CLI row; browser flow reaches a locked draft |
| BP-32 | feat | Wire launch, live status, resume, cancellation, and collect with a durable run monitor | BP-31 | Production browser flow uses the real local venue, observes a real subprocess, survives refresh/resume, exposes typed errors and requested-to-cancelled drain, and accounts every expected cell without GUI recomputation |
| BP-33 | feat | Wire results, Report, claim, and verification views; complete responsive/accessibility browser coverage | BP-32 | GUI renders sealed core results/report/claim facts and verification outcomes without recomputation; generated GUI parity is complete; a production-build browser walkthrough covers the full real lifecycle at desktop and mobile widths |

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
| BP-01 | **integrated** | `8ef3cb19e` | `73bca93e9` (worktree bench-bp01) | PASS (0 blocking, 4 non-blocking dispositioned; sonnet reviewer) | `f1330858e` |
| BP-10 | **integrated** | `a30ffb38c` | `65f034796` (worktree bench-bp10) | PASS (0 blocking, 4 non-blocking dispositioned; sonnet reviewer) | `ebd1355d1`+`78737858d` |

BP-00 verification: export-verification subagent confirmed every §3 symbol
exists (3 draft-time corrections); acceptance criteria 13/13 PASS;
worktree clean; single commit.

BP-01 verification (packet + re-run at integration in session worktree):
`generate-architecture.mjs --check` green; platform-catalog +
architecture-control 103/103; new family guards 9/9; package battery
(install --immutable / typecheck / test 6/6 / build / pack:smoke) green;
guard-red demonstration performed and reverted in-packet.

**M0 COMPLETE** (2026-08-05): program doc, packet DAG, contract decisions,
product design spec, application skeleton, boundary guards passing on the
empty product — all verified end-to-end.

**Base drift record (wave boundary after M0):** `origin/integration/evidence-v1`
advanced 10 commits (`1fb3e78f1` → `0bf0c7862`): CI path-filter/concurrency +
platform-verification fan-in gating (#2445, #2451), dashboard e2e quarantine
end (#2400), stage-2 salvage docs (#2453), post-merge architecture regen.
None touches `packages/benchmark-product`; two touch consumed surfaces
(`.github` CI gating, `architecture/generated` — mechanical regen conflict
expected on refresh). **Proposed: refresh base at next human contact;
awaiting explicit approval. Program continues on `1fb3e78f1` lineage
meanwhile, per policy.**

**Worktrees pending cleanup** (integrated; removal deferred to avoid the
sandbox `git worktree remove` gotcha): `bench-bp00`, `bench-bp01`.

**Platform substrate verification (orientation, 2026-08-05):** full portal dep chain (evidence → task-execution → trust → discovery → benchmarking) built green from source in this worktree; `benchmarking-local` typecheck clean, 100/100 tests pass.

## 9. Merge-readiness caveats (standing)

Owning Issues must be created by an authorized session before any PR; PRs target `next`-lineage per repo policy but this program's base is `integration/evidence-v1` per the human's direction; human CODEOWNERS review required for catalog/guard/CODEOWNERS-covered paths; no live validation, no deployment, no publication performed or claimed. Remote actions performed by this session: none.

BP-10 verification: TDD red/green per unit; battery green (13 files /
213 tests); guards 10/10; audit law (one attributed entry per operation)
test-proven; lifecycle/authority typed refusals exhaustively swept;
re-verified at integration. Carried finding for BP-11: add a
grant-authority operation (delegated-agent parity demo needs it).

M1 sequencing decision (2026-08-05): BP-11 -> BP-12 -> BP-13 -> BP-14
SERIALIZED. Rationale: all M1 packets contend on package.json/yarn.lock/
guard allow-list (single-owner files) and the CLI verb registry; the
source-boundary positive-control test forbids pre-adding unused deps.
Correctness over wall-clock, per program parallelization rules.

| BP-11 | integrated | `efa49533e` | `fa6ddac63` (worktree bench-bp11) | PASS + CONFIRMED-PASS (1 should-fix fixed, 2 nits; sonnet reviewer) | see git log |

BP-11 verification: 260/260 tests; real-subprocess launcher-contract test
for sample tasks; determinism test (byte-identical digests across builds);
pack:smoke runs buildSampleBenchmark() from packed tarballs; guards green.
Facts: admission pins ONE EvaluationSpec byte-exactly across sample tasks;
package name is @jinn-network/task-admission. Carried to BP-12: end-to-end
gated-operation test for lock/launch; consume attachBenchmarkToDraft
conflict rule + stored admission receipts. Session-worktree build order
note for BP-12 CI: attestation-issuer -> evaluation-harness ->
evaluator-adapters -> backend-local/assembly.

| BP-12 | integrated | `ca11be3b5` | `376711829` (worktree bench-bp12) | NEEDS CHANGES -> PASS all 9 criteria (sonnet reviewer, 2 rounds) | see git log 2026-08-06 |

BP-12 note — **hierarchy deviation, disclosed**: the packet coordinator
wedged after both implementers finished; the MASTER coordinator performed
final assembly directly (flattened mode for this packet's completion):
battery verification (389/389, build, pack:smoke, guards 11/11),
dispatched the independent reviewer, applied the one blocking fix
(copied platform Task-predicate removed from the sample-uniform runner —
now reads the product provisioner's fixed input/task.json with a minimal
sanity check), re-review PASS, commit. Implementer work was authored by
two sonnet implementers under the (pre-wedge) packet coordinator.
Reviewer non-blocking notes carried forward: evaluation-harness bin.js
relative-URL entrypoint coupling (fragile to that package's build
layout); computeCloseAt 3-line duplication in run-quote/run-lock.
Verification includes: AC2 real-backend integration test (2 arms x 3
items reaching judged, verifyMatrix ok, no task-execution-testing
import); resume idempotency (no double-posting); gated lock/launch e2e.

| BP-13 | integrated | `f09032b09` | `5314010aa` (worktree bench-bp13) | FAIL-with-fixes -> PASS (sonnet reviewer, independent battery re-run) | see git log 2026-08-06 |
| BP-14 | integrated | post-BP-13 head | committed in session worktree (flattened packet, disclosed) | NEEDS CHANGES -> PASS (stale-dist fix; sonnet reviewer) | see git log 2026-08-06 |

BP-13 verification: 440 tests; crash-safety reorder (writes before the
irreversible reported transition) + verify reads sealed Run owner; F1
verdict-canonicality fact (aggregate requires trust-core canonical DSSE
payload bytes; sealVerdictStatement seals canonicalJsonBytes) and F2
preregistration verdictRule-merge fact recorded as spec addenda.

BP-14 (shape test, flattened: one sonnet implementer + master-coordinator
evidence run + independent sonnet reviewer, 2 rounds): parity matrix
(24 entries, 3 gated, 3 honest exclusions), m1-walkthrough harness with
unconditional clean rebuild, recorded evidence run exit 0 (16 commands,
6/6 judged, verify ok, delegated-agent lock+launch). Evidence doc:
2026-08-06-benchmark-product-m1-evidence.md.

**M1 COMPLETE** (2026-08-06): agent-interface-first walking skeleton
demonstrated end-to-end on the real local backend and verified. 441
tests, guards green. Second drift note: origin/integration/evidence-v1
advanced a further 13 commits past 0bf0c786; refresh still awaiting
explicit human approval.

| BP-20 | integrated | `9ad21c6b1` | `571169c9b` (worktree bench-bp20) | PASS, 3 non-blocking fixed + delta-confirmed (sonnet reviewer) | see git log 2026-08-06 |

BP-20 verification: 485/485 tests; preview purity proven (byte-identical
sealed Run across previewed/un-previewed paths; official-state sha256
snapshot unchanged by previews); disclosure plumbing in report
limitations + claim package; quote presentation (run size, coverage,
caps, estimate-from-rehearsal only from real timings). Engine gap
recorded for BP-21: evaluation dispatch does not yet honor minVerdicts
(quote presents it as committed requirement, honestly framed).

| BP-21 | integrated | `756bd7ac8` | `c3029029e` (worktree bench-bp21) | PASS-WITH-FIXES -> PASS (must-fix resolver negative coverage w/ mutation check; atomic key writes; verdictRule cross-check) | see git log 2026-08-06 |

BP-21 verification: 538/538; all four assurance presets run locally;
independence gating truthfully satisfied via signature-verified
agent-distinct evaluator resolution (party-independence disclosed as
unproven everywhere); strict-agreement conflicted + majority dissent
proven on the real venue with dissent retained in results/matrix/
report/claim; minVerdicts engine gap closed; pre-existing fold bug
(eval legs clobbering solve submissionSha256) fixed via journal leg
field. Pre-existing generate-architecture --check drift confirmed
at base via stash test (upstream origin drift, refresh pending).

| BP-22 | integrated | `bc0868d62` | `971680579` (worktree bench-bp22) | NEEDS CHANGES across repeated independent review/correction rounds -> PASS (11 material concurrency, durability, integrity, and typed-error defects fixed; independent reviewer + read-only lock auditor) | `d765e9716` |

BP-22 verification: Node 22.23.1; typecheck; 62 files / 619 tests;
real slow local-venue cancellation 3/3; build; generated parity (26
operations, 2 legitimate exclusions); packed public-entry consumer;
family guards 11/11; platform catalog/architecture controls 105/105;
`git diff --check`. The real venue proved a solve subprocess was observed
nonterminal, cancelled through the backend, terminated by signal, and
reached durable `cancelled` before launch returned. Six expected cells
remained accounted (one dispatched, five undispatched); results/report/
claim denominators included judged cells only; `run.verify` passed.
Synthetic and real coverage keep task, infrastructure, expired,
unscorable, and cancellation paths distinct.

BP-22 review evidence: the first review caught collect/cancel TOCTOU,
buffered-event false live-cancel proof, impossible blame facts, and
concurrent attribution overwrite. Subsequent review/audit rounds caught
the submit-to-first-observe lost signal, missing marker-directory fsync,
stale-owner ABA, paused recovery initializers, unknown-liveness stealing,
successor-directory cleanup, reverse ownerless-claim transition, and a
mis-typed failed restoration. Each finding received a deterministic
red-first regression and an independent final PASS. The original
implementer completed implementation/battery but initially did not return
its packet summary after repeated nudges; the master stopped that idle turn,
took over review coordination, then resumed the same implementer for every
correction round. No work was lost and no unreviewed change was committed.

**M2 COMPLETE** (2026-08-07): disclosed previews and honest quote depth,
all assurance presets with retained dissent, durable real-process
cancellation, complete terminal accounting, and task/infrastructure
separation are implemented through the agent surface and verified on the
real local venue. Final M2 core baseline: 619 tests; guards green.

**Base drift record (wave boundary after M2):** the local
`origin/integration/evidence-v1` ref is `370932061b` and the session lineage
is 24 commits ahead / 44 behind. No product path differs; drift in the
program's watched surface is limited to architecture catalog/generated/
transition files, including the pre-existing `platform-topology.md`
generator mismatch. The previously proposed base refresh remains
unapproved, so the program continues on its current lineage.

| BP-30 | integrated | `bc0868d62` | `7b0ff3de7` (worktree bench-bp30) | NEEDS CHANGES (stale cancellation target-model text) -> PASS; staged integration re-review PASS | `2f4dff4fb` |

BP-30 verification: Node 22.23.1; immutable web install; lint; Next type
generation + TypeScript; 2 files / 10 tests; production Next build and
static route generation; package inventory/source-boundary guards 11/11;
combined catalog/generated-architecture/control battery 131 tests;
`git diff --check`. The catalog registers the private tier-4 web package,
CI gives it an isolated gate, and the family packed-consumer guard records
its no-public-entrypoint exclusion explicitly. The shell has no core edge
and no operation controls; its neutral placeholder identity is drift-pinned
to core branding until BP-31 replaces the temporary module with the public
runtime import.

BP-30 review/integration evidence: independent review found that the
interrupted pre-BP-22 app spec still called cancellation unshipped. The
target model now records gated `runCancel` / `cancel`, durable requested-to-
cancelled draining, and typed contention while preserving BP-30's no-wiring
scope. The first reviewer completed the battery and found this defect but
wedged during final rendered inspection despite repeated report requests;
the master stopped that turn and a second independent non-author reviewer
issued NEEDS CHANGES, then PASS after correction. Integration used a
no-commit cherry-pick; its sole conflict retained the complete BP-22 design
addendum followed by BP-30, and the staged current-lineage diff received a
separate independent PASS before commit.

| BP-31 | integrated | `a605e0bbc` | `2d71ed409` (worktree bench-bp31) | PASS (fresh independent non-author; full battery + production runtime + coordinator browser evidence) | `670124427` |

BP-31 verification: Node 22.23.1; core immutable install/typecheck/build,
62 files / 619 tests, generated parity check, packed ESM import plus Node
22 synchronous `require`, and exact external TypeScript consumer; web
immutable install/lint/typecheck, 4 files / 18 tests, production Next build;
family package/source guards 13/13; catalog/architecture/ownership review
battery 166 tests and generated architecture check; `git diff --check`.
The web package has exactly one direct Jinn edge (the core public entry),
while member-specific guards deny browser-side/deep/local/other-product
imports, API routes, and duplicated semantics. The generated parity artifact
now gives all 26 operations an explicit GUI disposition: 18 BP-31 action ids,
five BP-32 run-control deferrals, and three BP-33 result/report/verify
deferrals.

BP-31 real-path evidence: the Server Action integration used the default
real local venue to walk a temporary workspace through init, draft, bundled
sample, two arms, sponsor grant/revoke, a solve-only two-cell rehearsal,
quote, and gated lock. A separate production `next start` run proved the
external public core entry loads at request time. The coordinator then used
the in-app browser-control workflow against another fresh production server:
the same human flow visibly produced the rehearsal disclosure, two cells,
six quoted solve cells, a sealed locked state and Run digest. Reload at
390x844 preserved the state with viewport width equal to document width and
no console warnings/errors. The server was stopped and its temporary
workspace moved to Trash for recoverable cleanup.

BP-31 review evidence: the independent reviewer reran both package batteries,
packed consumers, guards, architecture controls, and production route fetches
and issued PASS with no blocking findings. Non-blocking presentation debt is
owned by BP-33/M5: replace raw rich-result JSON with semantic views, give card
titles heading semantics, automate browser regression, audit keyboard/focus/
error states, and disable lifecycle-illegal controls where the read model can
do so without recreating core rules.

| BP-32 | integrated | `0009676d0` | `8061b108d` (worktree bench-bp32) | NEEDS CHANGES (5 blockers) -> PASS after correction and production-browser re-walk | `0e356b6ea` |

BP-32 verification: Node 22.23.1; local-backend immutable install/typecheck/
build and 15 files (116 passed, 1 platform-specific skip); core immutable
install/typecheck/build, 62 files / 626 tests, generated parity, packed runtime
smoke; web immutable install/lint/typecheck/build and 7 files / 32 tests;
packed external TypeScript consumer; family package/source guards 13/13;
platform catalog/architecture/workflow controls 166/166 in independent review;
generated architecture check; `git diff --check`. GUI parity now maps launch,
resume, status, cancel, and collect to shipped server actions; only BP-33's
results/report/verify operations remain deferred.

BP-32 runtime architecture/evidence: launch and resume start the exact public
core promise in-process and retain it with Next `after()` when it crosses the
response boundary; there is no CLI child, API route, or web-owned driver. A
narrow synchronous local-backend ownership assertion fences concurrent venue
contenders before a UUID driver generation is journaled. Async readiness,
drive, cancellation-wrapper close, and venue shutdown all occur inside that
generation's terminal accounting, so any failure after a scheduled response
is durable and refresh-visible. Latest journal order remains authoritative;
deterministic tests prove a later sequential failure supersedes prior success,
a concurrent loser creates no generation, and a late shutdown rejection writes
exactly one `driver-failed`. Submission acceptance now establishes live
dispatch accounting without double-counting its later cell event.

BP-32 real-path evidence: Server Action integration ran both a natural real
local-venue launch -> status -> resume -> collect path and a deliberately slow
real subprocess path. The latter observed a durable active generation and
dispatch, wrote gated cancel intent while the venue was busy, showed requested/
draining, and proved the backend attempt journal had exactly one cancel request,
a SIGTERM/SIGKILL `exec-finished`, and a cancelled terminal. Retry finalized a
closed cancelled Matrix with all six expected cells terminal. Two exact
server-only environment opt-ins expose the test delay, capped at the core's
60-second limit and absent from browser payloads.

BP-32 review/correction evidence: the first fresh non-author review found five
material defects: terminal cancellation still described as draining; a 390px
terminal result widened the document to 737px; venue shutdown occurred after a
durable success entry; arbitrary driver diagnostics reached the browser; and
the web/core delay ceilings disagreed. Each received a red-first regression.
The GUI now distinguishes pending from finalized cancellation, contains rich
action results locally, projects runtime diagnostics to typed safe guidance
without changing core/CLI records, and rejects 60,001ms before launch. The same
reviewer rechecked the repaired diff and issued PASS. Coordinator production
browser verification on a fresh workspace measured scheduled launch in 285ms,
live and requested states at 390/390 client/document width, then closed/
finalized cancellation with all six cells terminal, no stale draining copy,
no test-control leak, and `innerWidth = clientWidth = scrollWidth = 390`.

One pre-review platform test invocation overlapped core package preparation and
saw a transient missing portal `dist/` import. It is excluded as invalid evidence
per the documented build-order rule; the clean serial platform battery above
passed. Both coordinator browser workspaces were moved to Trash after their
servers stopped, preserving recoverable cleanup.

| BP-33 | integrated | `5ba7d3afe` | `4b7328f80` (worktree bench-bp33) | NEEDS CHANGES (4 blockers) -> PASS after correction and production-browser re-walk | `7f9348883` |

BP-33 verification: Node 22.23.1; core immutable install/typecheck, standard
62-file / 628-test suite with the unchanged five-second timeout, build,
generated parity, and packed runtime smoke; web immutable install/lint/
typecheck, 9 files / 37 tests, and production Next build with all seven routes;
local-venue assembly typecheck/build/pack smoke and 15 files (116 passed, one
platform-specific skip); packed external TypeScript consumer; package inventory
5/5; per-member source boundaries 8/8; architecture generator 15/15 plus
catalog/control 103/103; generated architecture check; `git diff --check`.
The capability matrix now has all 26 operations shipped in the GUI, zero
deferrals, and only the two legitimate non-operation exclusions.

BP-33 product evidence: the results route is a semantic projection of the
core operations library, never a second record reader or statistics engine. It
shows sealed Matrix completeness, per-arm attrition/asymmetry, every frozen
cell/verdict/dissent/cost/latency/failure/axis fact, explicit valid-versus-
rejected verdict membership, venue honesty, the sealed Report's own arm results
and conflicted cells, the separately stored claim facts/disclosures, and a
dedicated verification result. Reload after reporting projects the exact
stored Report/claim through `runResults` with verification honestly `not-run`;
`runVerify` then exposes the three named matrix-rederivation, report-verification,
and claim-consistency checks. All Server Actions return recursively plain,
minimal receipts while rich evidence remains server-loaded.

BP-33 review/correction evidence: the first fresh non-author review found four
material defects: Report/claim objects with non-plain nested prototypes crashed
the production Flight response after a durable report write; reported content
widened a 390px document to 621px; the Report's own result/conflicted block was
omitted; and frozen verdict validity membership was not presented. Each received
a red-first regression, including class/null-prototype serialization controls,
an intentionally inconsistent Report-versus-claim fixture, rejected-verdict
membership, and hostile long disclosure/link containment. The same reviewer
re-ran focused core/web/production gates and issued PASS. Coordinator production
re-verification exercised refresh and verify against the preserved real local-
venue workspace without a Flight error, displayed all three named checks, and
measured `innerWidth`, client width, document scroll width, and body scroll width
as exactly 390; the prior disclosure leak measured 308/308. Viewport, tab, and
server were reset/stopped, and temporary evidence remained recoverably in Trash.

One four-worker core invocation is excluded from evidence: 624/628 tests passed
but four deterministic cases exceeded Vitest's default five-second bound under
resource starvation, and the multiline shell lacked fail-fast semantics so its
later build/pack output was also invalidated. The four cases passed 30/30 focused.
The package worker cap was reduced from four to two without widening timeouts;
the exact standard `yarn test` then passed 628/628 in 117.85 seconds under
`set -e`, before build/parity/pack ran successfully. The original implementer
completed code and batteries but wedged on final prose after repeated nudges;
the master stopped that idle turn, preserved all work, and resumed it for the
review correction pass. No unreviewed change was committed.

**M3 COMPLETE** (2026-08-07): the production web app is a server-only client of
the core public entrypoint across setup, real preview/quote/lock, durable launch/
resume/status/cancel/collect, semantic results/report/verify, and sponsor
authority controls. GUI parity is complete, production desktop/mobile browser
paths are verified, and no API route, deep import, client-side core edge, or
duplicated benchmark semantics exists.

**Base drift record (wave boundary after M3):** the local
`origin/integration/evidence-v1` ref moved to `103f434d9b`; the session lineage
is 32 commits ahead / 47 behind. No upstream `packages/benchmark-product`,
product design, or program-ledger path changed. Origin-only watched drift is in
repository-level workflow/control surfaces, including architecture-control and
platform-verification selection. The proposed base refresh remains unapproved;
the program continues on its current lineage.

| BP-40 | integrated | `307737877` | `9bd5b9c4e` (worktree bench-bp40) | NEEDS CHANGES across three review/correction rounds -> PASS on fourth review (9 P1 classes + browser/spec correction) | `4893cb080` |

BP-40 verification: Node 22.23.1; core typecheck and 64 files / 653
tests under the unchanged two-worker/default-five-second policy, build,
27-operation generated parity, and packed runtime smoke; web lint/typecheck,
10 files / 39 tests, and production Next build; local-backend typecheck/build/
pack smoke and 15 files (116 passed, one platform-specific skip); packed public
TypeScript consumer; family inventory/source/packed controls 14/14; architecture
generator 15/15; catalog/control/workflow 166/166; generated architecture and
`git diff --check`. The real Server Action battery publishes and re-verifies
both a natural complete two-arm/six-cell run and a drained cancelled run whose
bundle retains `verification/cancel-requested.json` and all six terminal cells.

BP-40 product evidence: `runPublish` is a gated local-only operation; no upload,
hosting, deployment, or package publication exists. It shares workspace skeptic,
Matrix assembly, Report method/trust, and claim-consistency seams with `runVerify`,
then emits a deterministic allowlisted closure to a manifest-digest-addressed,
no-overwrite target. Exact evaluation Task and Delivery bytes are now stored and
journaled for future publishable runs; legacy runs missing mandatory evidence
refuse honestly. The portable bundle carries canonical records/catalogs/assembly
facts, public Report/evaluator SPKI trust, and five deterministic neutral assets,
never private keys or the mutable workspace. A copied bundle passes both library
and CLI verification after its entire source workspace is deleted. GUI publication
and re-verification accept only a draft id; standalone arbitrary-path verification
remains a documented library/CLI exclusion. Reload persists bundle identity,
relative digest path, timestamp, and all six named checks.

BP-40 hardening evidence: the verifier authenticates one `O_NOFOLLOW`/fstat/
inode/nlink-checked byte snapshot and never reopens semantic paths. It reconstructs
one exact bidirectional typed CAS graph across Tasks, EvaluationSpecs, admission
receipts, solve/evaluation Submissions, solve/evaluation Deliveries, outputs, and
verdicts; coordinate domains, consumption, role-set equality, SPKI-derived key
identities, exact evaluator set, claim bytes, cancellation bytes, and every asset
are independently enforced. Successful evaluation legs require full verdict
bijection. Three legitimate `could-not-grade` shapes retain exact monotonic partial
lineage and pass portable verification while nine tamper variants refuse. Manifest,
Matrix, Report payload/envelope, claim, assembly, trust keys, evidence, assets,
unsafe path, symlink, hardlink, special-file, missing/extra, substitution, and
unreachable-record cases fail named checks. Publication uses the already-hardened
finalization recovery guard for cross-process stale-owner ABA fencing, PID-start/
tri-state liveness, token/inode/directory-exact release, concurrent convergence,
crash-hook retry, and atomic RunState/draft finalization.

BP-40 review evidence: the first review found incomplete attacker-authored graph
closure, pathname TOCTOU/hardlinks, unbound trust identities, unchecked claim/
asset facts, publication target/finalization races, browser path leakage, and stale
spec text. The second found forged coordinate edges, unknown raw claim fields, and
a weaker publication-lock ABA/PID protocol; publication was refactored to reuse
the hardened guard. The third found that exact successful-lineage rules incorrectly
rejected supported partial `could-not-grade` terminals. Every finding received a
deterministic red-first regression, and the fourth independent read-only review
issued PASS without edits. Earlier full-battery reds caused only by legacy forged
published fixtures or fixed-path expectations are excluded; final fail-fast runs
above are the evidence of record.

The implementer completed all code and automated batteries but wedged twice in
the in-app browser despite repeated report/stop requests. The master interrupted
those turns, terminated the isolated servers, and performed final assembly on a
fresh real published workspace: Report sealing, digest-addressed publication,
portable re-verification, reload-persistent identity/path/six checks, portable
command visibility, and `innerWidth = clientWidth = document/body scrollWidth =
390`. No server error was emitted. Viewport/tab/server were reset/stopped and all
three BP-40 browser workspaces were moved recoverably to Trash. No work was lost,
and no unreviewed change was committed.

| BP-41 | integrated | `080f4d8e2` | `cf043a110` (worktree bench-bp41) | NEEDS CHANGES twice -> PASS (six presentation/a11y findings corrected) | `cefab02ff` |

BP-41 verification: Node 22.23.1; core typecheck and 65 files / 663 tests
under the unchanged two-worker/default-five-second policy, build, parity, and
packed runtime smoke; web lint/typecheck, 10 files / 39 tests (including the real
complete and drained-cancelled publish paths), and optimized production build;
local-backend typecheck/build/pack smoke and 15 files (116 passed, one platform-
specific skip); packed public TypeScript consumer; family inventory/source
controls 13/13; generator 15/15; a broader repository catalog/control/workflow
battery 366/366; generated architecture and `git diff --check`. Focused final
review evidence is 2 files / 29 tests.

BP-41 product evidence: the frozen `public-bundle/1` layout and five BP-40 asset
roles remain unchanged. One pure deterministic `buildPublicAssets` projection is
used byte-for-byte by both materialization and portable verification. It emits a
self-contained, no-script/no-remote semantic HTML report, badge and social-card
SVGs, README, and share text from stored Matrix, Report, Claim, and verification-
assembly facts only. It never computes a statistic, reconciles inconsistent
stored sources, chooses a winner, or adds a conclusion. The full report labels
each authenticated source separately and preserves exact completeness, attrition,
conflicts, method/preregistration, disclosures, limitations, dissent, trust
boundary, configuration pins, digests, and every manifest-listed content-addressed
record link. Compact assets keep neutral/no-winner and adverse facts prominent,
carry the complete Report identity and exact arm ids in accessible metadata, and
direct readers to relative limitations and verification paths.

BP-41 review evidence: the first independent review found that several mirrored
Claim/Report blocks were not independently visible, raw CAS links were absent,
compact SVGs exposed only a digest prefix, and unbounded arm ids could displace
adverse qualifiers. Red-first corrections added source-labelled exact mirrors,
independently derived sorted CAS identities, full accessible digests/ids, and a
fixed neutral -> adverse -> bounded-configuration SVG structure. Re-review then
found that 2,048-character valid arm ids were only hidden by page-level overflow
clipping and that the social-card's 112-codepoint visual summary still exceeded
its view box. Two additional tests failed exactly (7 pass / 2 fail), then passed
(9/9) after intrinsic anywhere/break-word containment, fixed local table layout,
removal of outer overflow masking, and a conservative 40-codepoint visual config
summary. The same non-author reviewer issued final PASS without edits.

Fresh real evidence published a natural two-arm/six-judged-cell run, copied its
digest-addressed bundle, deleted the source workspace, and passed library plus
standalone CLI portable verification with all six named checks. The final bundle
identity was `6853508ea0de182804e7ebe644b1d13519a724bd627a50a5b6f32079bd9d623b`.
Coordinator browser verification of that copy at 390x844 measured document/body
widths 390/390 and every report section `clientWidth == scrollWidth` (350 or 356),
with one h1/header/main/footer, all 49 raw CAS links, and zero scripts, remote
resources, warnings, or errors. Social-card fields ended at x=260.94/377.95/
143.41 and badge fields at x=192.47/298.32/114.05 inside a 390px SVG; both retained
the full 64-character Report digest. The in-app browser's SVG instrumentation
emitted its known `animation in undefined` diagnostic although the authenticated
SVG sources contain no script or animation; the HTML report itself logged zero.
Server, viewport, and tabs were reset, and the copied bundle was moved recoverably
to Trash.

The resumption boundary lost the original BP-41 implementer's terminal agent
status after it reported the corrected focused suite green. The master preserved
the intact unstaged worktree, re-ran the complete fail-fast battery, coordinated
the two independent review/correction rounds, and performed final browser
assembly. No work was lost and no unreviewed change was committed.

**M4 COMPLETE** (2026-08-09): a reported complete, partial, conflicted, adverse,
or cancelled benchmark can be materialized as an immutable, digest-addressed,
distribution-ready public bundle. The bundle remains verifiable after source-
workspace deletion using only its authenticated bytes and public trust material;
its static public assets preserve neutral findings, scope, limitations, failure,
dissent, trust boundaries, and exact raw-record access without upload, hosting,
deployment, private keys, or a second implementation.

**Base drift record (wave boundary after M4):** the local
`origin/integration/evidence-v1` ref moved to `1980c7e067`; the session lineage
is 36 commits ahead / 54 behind. No upstream watched `packages/benchmark-product`,
product design, program-ledger, product CI, or product guard path changed. The
proposed base refresh remains unapproved; M5 continues on the current lineage.

| BP-50 | integrated | `c9f1e942d` | `51054aaf2` (worktree bench-bp50) | NEEDS CHANGES twice -> PASS (eight accessibility/security classes corrected) | `4eb02cff6` |

BP-50 verification: Node 22.23.1; core typecheck and 65 files / 663 tests,
build, 27-operation parity, and packed runtime smoke; web lint/typecheck, 13
files / 64 tests, optimized seven-route build, and production Playwright 3/3;
local-backend typecheck/build/pack and 15 files (116 passed, one platform skip);
focused bundle/Report/claim/trust/asset adversarial battery 48/48; family package/
source guards 13/13; packed public TypeScript consumer; generator 15/15;
catalog/control/workflow 203/203; generated architecture and `git diff --check`.

BP-50 product evidence: the private web application now has product-owned,
production-build browser acceptance with a keyboard-only real local-venue journey
from workspace initialization through a six-cell run, collection, semantic results,
Report, verification, local publication, copied-bundle source deletion, and shipped
standalone CLI re-verification. Every route and material lifecycle/error state is
audited at desktop and 390px with zero axe violations and no waiver filter. Skip
navigation, semantic headings/landmarks/labels, visible result and skip-target focus,
named focusable scroll regions, disabled lifecycle affordances, reduced motion,
200%-equivalent reflow, and mobile containment are regression-checked. A scheduled
launch now performs bounded refreshes only until the existing durable run monitor
takes over, fixing a real locked-page liveness defect without creating a second
driver or lifecycle implementation.

BP-50 security evidence: live HTML and Flight responses carry `no-store`,
`base-uri 'none'` CSP, frame denial, nosniff, no-referrer, and an exact finite
empty-allowlist Permissions Policy. The policy authority pins Playwright 1.59.1 /
Chromium 147.0.7727.15 and all 81 sorted runtime-recognized features; production
tests require exact feature equality, `allowedFeatures() == []`, exact response
bytes, and zero page policy warnings so browser evolution fails for explicit
review. GUI view/action/background projections retain typed recovery categories
but redact absolute workspace paths, draft/configuration identifiers, runtime
diagnostics, issue text, credentials, and unexpected exceptions. Build-time,
runtime, workspace, and credential sentinels plus exact generated PEM private-key
bytes are checked against every console level, every requested URL, every completed
HTML/Flight body, rendered HTML, static chunks, and the copied bundle. Only request-
failure-proven `ERR_ABORTED` speculative RSC responses are classified non-delivered.
The copied bundle is moved outside the source workspace, the source is deleted,
then the public CLI verifies all six checks. Per-run UUID browser workspaces use
exclusive creation and exact regular single-link ownership markers; parallel,
stale, partial-identity, tamper, inherited-identity, and exact-owner teardown cases
are deterministic and fail closed. The product-local threat model records local-
process authority, filesystem/concurrency/browser boundaries, non-goals, and
deployment status `none`.

BP-50 review evidence: the first independent review found silent moderate/minor
axe waivers, incomplete route/state audits, invisible programmatic focus, weaker
CSP/Permissions Policy, vacuous confidentiality scans, and a crash-poisonable fixed
browser workspace. Red-first corrections exercised each gap and the no-waiver gate
then found and fixed enabled, disabled, and transitioning button contrast defects.
Re-review cleared four classes but showed that route `<main>` targets still suppressed
their outline and that numerous Chromium capabilities remained allowed. Final
runtime reds proved both; a high-specificity three-pixel main focus outline and the
version-pinned 81-feature policy closed them. The same read-only reviewer issued
PASS after a fresh optimized build and Chromium run. One preliminary family-guard
invocation used ambient Node 20 and failed only on unsupported `import.meta.dirname`;
it is excluded, and the required Node 22.23.1 rerun passed 13/13. No remote effect,
browser artifact, listener, or temporary BP-50 workspace remained.

| BP-51 | integrated | `b235db6f5` | `0bb71c6eb` (worktree bench-bp51) | NEEDS CHANGES -> PASS (identity-bound quickstart cleanup) | `ce81c175e` |

BP-51 verification: Node 22.23.1; core immutable install/typecheck, 68 files /
677 tests, build, 27-operation parity, and packed runtime smoke; web immutable
install/lint/typecheck, 13 files / 64 tests, optimized seven-route build, and
production Playwright 3/3; local-backend typecheck/build/pack and 15 files (116
passed, one platform skip); family guards 13/13; packed public TypeScript consumer;
generator 15/15; catalog/control/workflow 203/203; generated architecture and
`git diff --check`. The final docs/quickstart focused suite is 3 files / 14 tests.

BP-51 product evidence: product-root, core, web, public-bundle, security, and
extraction-readiness documentation now describes the complete shipped surface
without inventing hosting or authority. Machine-checked docs derive all 27 parity
operations, five gated actions, 11 typed errors, four exit classes, bundle format/
files/six checks, package commands, and relative links from implementation
authorities. The public quickstart clean-builds and invokes the built CLI for 17
steps: init, draft/sample/two arms, quote/lock, real launch/status/resume/status,
collect/results/report/workspace verification/publish, then copied-bundle standalone
verification. It accepts no caller path, forwards no ambient credential/network
configuration, completes six real local cells, copies the digest-addressed public
bundle outside its source, deletes the source workspace, verifies all six portable
checks through the shipped CLI, and removes its uniquely owned temporary root.

BP-51 cleanup/review evidence: the first independent review found that replayable
marker bytes did not bind recursive cleanup to the originally created root,
workspace, or marker inode. Eight deterministic tests failed first for root and
workspace replacement, stale/malformed/symlink/hardlink markers, parallel roots,
and combined primary/cleanup failure. The correction captures root, marker,
workspace, and copied-bundle device/inode identities, uses `O_NOFOLLOW`/fstat/
single-link marker validation, atomically quarantines before deletion, fsyncs and
revalidates moved objects twice, and recursively removes only a proven quarantine.
Mismatch poisons the owner, retains evidence, and attempts only an exclusive,
non-overwriting relative restoration symlink; occupied or failed restoration never
deletes. The read-only reviewer re-ran 14/14 plus a complete real quickstart and
issued PASS. Final proof identities were run `a6dda1f02bd1643893fa7e4938c8205a491eb3257fa6a77324730499b1322df9`,
Matrix `00166d519ae7d11227dfc603c5feff8700a7344d67c67d4f02202055115c3332`,
Report `f5a95a013053649c27a2aa38d44191458823d4c67afc927fcd64bfe6668af39f`,
and bundle `b50cc89266efe06165a8867b988df82cd613fe2948f9f60c4342116e7c401451`.

The extraction-readiness dry run is explicitly evidence, not authorization:
gate 1 BLOCKED (portal/unpublished platform dependencies); 2 BLOCKED (sibling
builds/dist transfer); 3 NOT GREEN (no deploy contract); 4 PASS (no tier-1--3
product references); 5 BLOCKED (repo-global CI/guards and no extracted-tree
conformance); 6 BLOCKED/not applicable to the current private `publishPolicy:
never` posture (no release pipeline); 7 BLOCKED (no product-specific CODEOWNERS/
target protection evidence); 8 PASS with explicit generic filesystem-helper and
private structural-type provenance disclosure. Even an all-green future dry run
would require its own decision record. The issue-drafts ledger now contains all 12
required M2--M5 drafts BP-20/21/22/30/31/32/33/40/41/50/51/52; no GitHub object
was created or mutated.

An intermediate generator run classified `core/scripts/public-quickstart.mjs` and
mechanically changed the two canonical generated architecture views. At the master
constraint check those exact diffs were reverted, the executable was relocated to
the product-local `core/quickstart/` path and invoked directly, and fresh generator
tests/check proved both canonical files byte-clean. No canonical Jinn document,
remote resource, deployment, package, issue, project, PR, or branch was mutated.

| BP-52 | integrated | `cb9cea5a5` | `52185b1b1` (worktree bench-bp52) | NEEDS CHANGES twice -> PASS (final-record CI closure and controller-held browser-cleanup ownership) | `c09e89703` |

BP-52 verification: Node 22.23.1; core typecheck/build, 68 files / 680 tests,
27-operation parity, and packed runtime smoke; web lint/typecheck, 13 files / 72
tests, optimized seven-route build, and production Playwright 3/3; local-backend
typecheck/build/pack and 15 files (116 passed, one platform skip); family package/
source guards 13/13; packed public TypeScript consumer; generator 15/15;
catalog/control/workflow 203/203; generated architecture and `git diff --check`.
The final focused adversarial battery passed 79/79 across records, graph closure,
trust, cancellation, public assets, path/link, and filesystem-integrity cases.
Documentation consistency passed 7/7 and the final cleanup-ownership suite passed
11/11.

BP-52 cross-cutting evidence: the built public CLI quickstart completed all 17
operations on the real local venue, accounted six cells, copied its digest-addressed
bundle outside the workspace, deleted the source workspace, and passed all six
standalone portable checks. Its final identities were run
`41670341f40dab3457b956bfea1bdbaaf66b027d9180957f13a7395bcea15f84`,
Matrix `227dbb7329c09dfe178ec2c96980c97afeeada6b3968ac5e82e5eef0c3346d8a`,
Report `9621850be78be3f44ce4d170ee5bf9e251dd54e79666168c824f1f192ee1921b`,
and bundle `e0ad39ad69c84304a63f12905c4d51683cf38320182e54e158f16c822ffb34d4`.
The optimized browser gate now proves both a natural complete journey and a second
real requested -> draining -> cancelled journey through Report, verification,
publication, copy, source deletion, cancellation-marker retention, and six-check
standalone verification. The authority deliberately assigns the complete journey
to the CLI and the cancelled journey to the optimized browser; shared-core real
cancellation, typed CLI cancellation, and generated parity cover the surface seam,
so the absence of a redundant CLI-only cancelled end-to-end journey was independently
reviewed and accepted.

BP-52 review evidence: the first fresh program-wide review found that the new final
evidence authority did not itself trigger product CI and that browser teardown
trusted replayable marker bytes rather than setup-time filesystem identity. Red-first
corrections added the evidence path to both pull-request and push filters and moved
cleanup behind captured root/marker identities plus quarantine-before-delete. The
first re-review then found that a filesystem receipt still self-described its own
identity. A second deterministic red reproduced that boundary; the receipt and
separate global teardown were removed. Playwright global setup now returns its
supported teardown closure and retains the opaque original root/marker identity,
token, and bytes only in controller memory. Cleanup atomically quarantines, checks
the marker through `O_NOFOLLOW`/fstat/single-link rules, validates exact identities
and child allowlist twice immediately before the sole recursive removal, preserves
new original-path occupants, and retains/restores evidence non-overwriting on any
identity change. The same read-only reviewer issued final PASS after focused Node
22 checks and the optimized 3/3 production journeys. The final dated evidence record
is `docs/superpowers/plans/2026-08-10-benchmark-product-final-verification.md`.

**M5 COMPLETE** (2026-08-10): accessibility, keyboard/focus/reflow, security headers
and browser capability denial, typed error/privacy projection, secret/path/external-
request sweeps, identity-fenced temporary cleanup, complete product documentation,
extraction-readiness evidence, real complete and cancelled journeys, adversarial
portable-bundle verification, and a fresh program-wide review are all green. M0--M5
are implemented on the local session lineage. This is implementation completion,
not extraction authorization, deployment, publication, or remote merge readiness.

**Final compatibility record:** after M0--M5 completion and final independent PASS,
the human explicitly authorized merging the remote base and opening a full PR.
`origin/integration/evidence-v1` was still exactly `1980c7e067`; it was merged
without rebasing as `9e878c61b`, preserving every packet and review hash. The only
conflicts were the two generated architecture views and were resolved mechanically
from the merged catalog. Upstream's added `task-admission` ->
`task-execution-profiles` dependency produced an exact immutable-install red in
both independent product lockfiles; each lock gained that one portal edge. The
post-merge battery passed core 680/680, web 72/72 and production browser 3/3,
backend 116 plus one platform skip, family 13/13, generator 15/15, merged
catalog/control/workflow 222/222, packed consumers, generated checks, and the real
17-step public quickstart with source deletion and six portable checks. After the
compatibility commit the branch is 45 commits ahead / 0 behind the remote target.
