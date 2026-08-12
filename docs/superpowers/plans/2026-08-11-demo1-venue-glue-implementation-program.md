# Demo-1 Venue-Glue Engineering Implementation Program

| | |
|---|---|
| **Version** | 1.1 |
| **Date** | 2026-08-12 |
| **Author** | GTM execution session (Ritsu + Claude Fable 5); seam facts from three deep code explorations, path:line-cited |
| **Shape** | `design` (this document); execution packets are `feat`/`fix`/`test` |
| **Depends on** | [`2026-08-11-demo-report-1-skill-ab-program.md`](./2026-08-11-demo-report-1-skill-ab-program.md) (the eval-method stream this engineering serves), [`2026-08-05-benchmark-product-design.md`](../specs/2026-08-05-benchmark-product-design.md) (§3 consumption contract, §7 venue) |
| **Does not do** | Eval-method work (power analysis, red-team, lock, and the publication handoff — the sibling program owns it); network publication topology; marketplace venue; CI-dockerized grading; any GTM surface |

Demo report #1 (the pre-registered skill-vs-AGENTS.md A/B) requires the
benchmark product's venue to run coding-agent arms with container grading
and paired statistics. All capabilities exist as platform libraries but the
venue wires only the prediction-forecast family (deliberate M1 scoping).
This program turns three seam explorations into lanes → packets → discrete
implementer tasks with acceptance criteria.

Exploration also found a real integrity bug (fabricated admission evidence
→ unearned Matrix `match`), promoted to packet P2b — fixing it is a
precondition of a "pristine" demo report.

## 2026-08-12 execution amendment

The operator approved completion through the **publication boundary**, not network publication. The engineering finish line is a sealed Benchmark/Run/Matrix/Report closure, locally emitted deletion-portable bundle, exact cold recomputation, and publication handoff packet. Public report hosting, a signed Record Discovery author source, archive mirroring, Explorer ingestion, and `spec.jinn.network` deployment are separate design work and must not be improvised here.

Additional locked constraints:

- P2 binds `claude-haiku-4-5-20251001` at `high` effort through a real product-owned inventory. It must support a true no-file arm C without falsely earning loadout `match`.
- P2 makes `SKILL.md` and `AGENTS.md` from one frozen source body, materializes both through the same digest-verifying path, proves the loader-visible placement, and symmetrically excludes experiment-created instruction files from harvested patches. If that requires a platform-semantics change, the packet stops for operator review.
- P2b removes fabricated admission readiness; only real `verifyRunPinning` evidence may yield Matrix `match`.
- P3 is split into P3a (the pinned OCI grader package) and P3b (the benchmark-product binding). P3b seals test material, image, parser, timeout, and grader-program identities and pre-stages images for `--pull never` grading.
- P5 remains a 3-task × 2-arm × 2-replicate **plumbing** gate and starts only with at least 40 GiB free. It proves all twelve cells accounted, gold PASS / empty FAIL, three repository clusters, and `draws === resamples × clusterCount`; it does not estimate capability.
- The subsequent three-arm official design has a hard ceiling of 600 cells. The engineering packets must not bake in a larger run or automatic post-lock top-ups.

## Session kickoff (paste into a NEW session)

> Execute `docs/superpowers/plans/2026-08-11-demo1-venue-glue-implementation-program.md`.
> You are the program coordinator: never implement directly. Dispatch one
> Opus lane coordinator per lane (C1–C4) per the orchestration model;
> coordinators dispatch Sonnet implementers per discrete task. First
> action: dispatch all four lane coordinators' recon in parallel. Escalate
> to the operator per the escalation rule; the operator merges packet PRs.

## Orchestration model

- **Program coordinator** = the session's main loop. Never implements.
  Dispatches lane coordinators, checks gates, shepherds PRs, escalates to
  the operator.
- **Lane coordinators** = `Agent(model: "opus")`, one per lane, long-lived
  (SendMessage to continue). Each: verifies its recon facts against CURRENT
  `origin/integration/evidence-v1` (this program's citations were read on a
  slightly stale worktree; PR #2558's grader image and #2555 are
  post-cutoff) → writes the packet's task-level TDD plan
  (superpowers:writing-plans) → dispatches implementers → orchestrates
  review → readies the PR.
- **Implementers** = `Agent(model: "sonnet")`, one per discrete task (one
  TDD cycle: failing test → minimal impl → green → commit). Self-contained
  prompts with exact file paths from the lane's plan.
- **Reviewers** = independent Opus agents per PR
  (superpowers:requesting-code-review); never the implementing lane
  reviewing itself.
- **Worktrees:** each lane in its own worktree off current
  `origin/integration/evidence-v1`
  (`git worktree add ../jinn-mono_worktrees/<lane>`); all git via
  `git -C`; the coordinator checks lane worktrees stay clean after each
  dispatch.
- **PRs:** one per packet, base `integration/evidence-v1` (protected:
  review required + `platform-architecture-control` +
  `platform-verification` contexts; squash merge). Conventional titles. No
  agent self-merge — **the operator merges** each packet PR.
- **Escalation:** recon contradicting this program, or a packet estimate
  exceeding its budget by >50% → STOP, report to the operator. No silent
  re-scoping.
- **CI blindness rule:** benchmark-product CI only triggers on
  benchmark-product paths. Every packet PR body must record a local
  full-chain verification (portal build order from
  `benchmark-product-ci.yml:69-92` → core suite) — upstream-only PRs state
  "benchmark-product suite run locally: green."

## Lanes

| Lane | Coordinator scope | Packets |
|---|---|---|
| **C1 — Venue & Arms** | The product venue + launcher wiring | P1 → P2 → P2b |
| **C2 — Grading Bridge** | Container runtime extraction + venue deployment-module emission | P3 |
| **C3 — Statistics** | Method registry decision | P4 (may discharge) |
| **C4 — Slate & E2E** | Task slate + the final proof | R5 early; P5 after P1–P3 |

Dependencies: P1 → P2 → P2b; P3 parallel (joins at P5); P4 parallel; P5
last. Estimates: P1 ~2–3d, P2 ~3–4d, P2b ~1–2d, P3 ~2–3d, P4 0–2d, P5
~1–2d agent-days; wall-clock ~1.5–2 weeks with lane parallelism.

## Packets and acceptance criteria

### P1 — Venue profile generalization (`feat(benchmark-product)`)

The seam is exactly four URI hardcodes + one payload check + evaluator
registration, all mapped:
(A) `core/src/venue/venue.ts:330-343` `resolveTaskProfileFor` two-arm
`if`, refuses everything else; (B) `provisionerCapabilities.taskProfiles`
`venue.ts:517-523`; (C) `createLocalProvisioner` selector
`venue/provisioner.ts:263-295`; (D) launcher `taskProfiles` declarations;
(E) backend intersects B∩D
(`backend-local/assembly/src/capabilities.ts:63-75`) — both must list a
URI or it never reaches capabilities. Plus: `prepareEvaluationCell`'s
prediction-payload refusal (`venue.ts:538-556`) and prediction-only
evaluator registration (`venue.ts:304, 409`).

Key asset: **SWE-bench intake already exists and produces
`repository-work/1.0` Tasks** (`core/src/intake/swebench.ts:79-110` →
`interop/src/import/swebench.ts:53-83`) — currently unrunnable (site A
refuses). P1 makes the venue admit `repository-work/1.0` end-to-end for
solve legs.

**Acceptance:**
1. `repository-work/1.0` resolves at site A, appears in capabilities (B
   and E), and selects a provisioner at C; unknown URIs still refuse typed
   at every site.
2. A SWE-bench-imported draft with a `repository-work`-capable arm passes
   lock→launch to the dispatch boundary (grading may still be absent —
   that's P3).
3. Prediction sample byte-stable: the enumerated
   venue/quote/compile/integration test set green unmodified
   (`venue.test.ts`, `venue.integration.test.ts` incl. exact-output
   assertions, `run-quote.test.ts`, `quote-presentation.test.ts` incl. the
   coverage↔errors cross-check at :263, `run-path.integration.test.ts`,
   `cli-lifecycle.integration.test.ts` literal-output assertion at :330,
   `public-quickstart.test.ts`).
4. The quote-time coverage duplication stays in sync
   (`operations/run-quote.ts:169-192` ↔ `benchmarking/run/src/quote.ts:29-69`)
   — the cross-check test extended, not weakened.
5. Harvest normalization for `repository-work` output slots (`patch`
   text/x-diff, `summary`, `evidence` —
   `profiles/src/documents/repository-work-1.0.ts:53-59`) parallel to the
   prediction path (`provisioner.ts:120-143`).
6. Provisioner design decision recorded in the lane's recon:
   dir-provisioner + task-declared inputs vs `makeWorktreeProvisioner`
   (which requires per-attempt `referenceRepository` + 40-hex `oid` no
   product config carries — `workspace/src/worktree-provisioner.ts:17,39-40`);
   the chosen design must materialize task inputs the launcher can
   actually use.

### P2 — Claude Code as a lockable arm (`feat(benchmark-product)`)

Verified blockers this packet exists to clear:
- `claudeCodeLauncher` probe defaults `ready: false`
  (`launchers/src/planning.ts:9-11`); **adding it without an injected
  probe fails preflight for the ENTIRE run** (empty preflight request
  probes all launchers: `backend.ts:1083-1088,1123-1132`; the venue calls
  `preflight({})` at `venue.ts:591`). Use `makeClaudeCodeLauncher({ probe })`.
- Deployment readiness must echo `models`, `loadouts`, `harnessVersions`
  (`assembly/src/pinning.ts:8-19`) or any model/loadout pin **rejects at
  submit** (`pinning.ts:56-78`). **No working precedent exists anywhere in
  the repo for an enforced model/skill pin** — the venue's deployments
  today echo neither (`venue.ts:484-515`); this machinery is new.
- The skill pin is the **`loadout` key** with kind `jinn.skill.v1` inside
  the value (`workspace/src/loadout.ts:15-66`); claude-code inventory
  `["jinn.skill.v1","jinn.harness-state.v1"]` (`claude-code.ts:10-16`),
  consumed as `--plugin-dir <path>` via `canonicalLoadoutPath`.
- The product's solve provisioner writes ONLY `input/task.sealed`
  (`venue/provisioner.ts:112-145`) — **no loadout materialization**; the
  platform's `materializeLoadout` (`workspace/src/dir-provisioner.ts:113-115`,
  exported) must be wired in.
- `effort` is declared/enforced at plan time but is NOT in
  `verifyRunPinning` and NOT a graded Matrix axis (axes =
  harness|model|loadout|isolation, `benchmarking/local/src/axes.ts:11`) —
  the A/B holds it constant and the eval design discloses it as
  attested-not-graded.
- An id-only harness pin can never reach `match`
  (`pinning-bridge.ts:203-206`) — arms pin `{id, version}`.

**Acceptance:**
1. Venue config admits claude-code with an injected binary probe (path
   from product config or explicit venue option — design in lane recon;
   `JINN_CURSOR_PATH`-style env invention is refused, config must be
   explicit).
2. Deployment readiness echoes the pinned model id and the materialized
   loadout digests; `verifyRunPinning` passes for a fully-pinned arm and
   **rejects** a wrong model id / wrong loadout digest (negative tests).
3. Two byte-identical-except-loadout arms lock, dispatch, and the launcher
   receives the materialized skill at `input/<canonical loadout path>`;
   argv carries `--plugin-dir`.
4. Per-axis pinning verification reaches `match` on harness/model/loadout
   for both arms in a kit test (real `verifyRunPinning` result, not
   fabricated — see P2b).
5. Platform pin-inventory tests untouched (`loadout-inventory.test.ts`,
   `real-launchers.test.ts:31-35` exact ordered key lists).

### P2b — Truthful admission evidence (`fix(benchmark-product)`)

**The integrity bug:** `core/src/run/assembly-ports.ts:157-161` fabricates
`admission: { ready: true }` (no `checkedRequirementsDigest`, no
observations) whenever `dispatches > 0` — and dispatches counts a journal
entry written BEFORE `backend.submit` resolves (`run/drive.ts:120-131`,
`run/journal.ts:335-342`). Net: Matrix `match` can be reported on axes the
venue never gated (`pinning-bridge.ts:246-272` reaches `match` only via
accepted admission; `:26-38` documents `checkedRequirementsDigest` as the
binding field).

**Acceptance:**
1. The real `verifyRunPinning` result (with `checkedRequirementsDigest`
   over the merged pinning map) is captured at submit time and forwarded
   through assembly ports; fabricated admission removed.
2. A submit-rejected cell can no longer surface as `match` (regression
   test reproducing the current false-positive first).
3. The prediction sample still reaches `match` on its harness axis — via
   real evidence now.
4. Disclosed in the packet PR as a fix with user-visible effect on
   venue-honesty surfaces (`run-results.ts:88-94, 208-228`).

### P3 — Container grading bridge (`feat(task-execution)` + `feat(benchmark-product)`)

Settled by exploration: extraction + deployment-module emission, both
small.
- **P3a:** extract `client/src/daemon/native-evaluator-container-runtime.ts`
  (382 lines, ZERO client-internal imports, spawner-injected tests —
  near-mechanical) into a NEW task-execution sibling package (NOT
  evaluator-adapters — its charter says "never shells out",
  `container-grader-source.ts:118-123`). Full catalog **Add** procedure +
  task-execution guard triplet + the 8-step edge checklist (worked
  example: BP-31 commit `670124427`) for benchmark-product-core → new
  package.
- **P3b:** extend the venue's generated deployment module
  (`venue.ts:283-328`, prediction-only today) to also emit a swe-rebench
  registration: `containerGraderReportSource` +
  `createSweRebenchEvaluatorRegistration` (both already exported by
  evaluator-adapters, already a core dependency) +
  `createDockerContainerRuntime` from the new package. Deployment modules
  re-import from scratch in the spawned child (no live objects cross) —
  the established daemon pattern (`swe-rebench-v2-deployment.mjs`).

Constraints: product→client import refused by this program (catalog-legal
but design-rejected; client also ships no exports map). Timeout authority
= EvaluationSpec `block.timeout` (legacy env knobs are not on this path).
Grader image = `client/deployments/evaluator/swe-rebench-v2-grader/`
(PR #2558), digest-pinned (mutable tags refused by
`container-grader-source.ts:181-201`).

**Acceptance:**
1. New package green with spawner-injected tests (no Docker in CI);
   catalog + topology + guards green; stale "Finding A" comment
   (`adapter.ts:41-43`) and stale pack-smoke launchers note corrected in
   passing.
2. A real container-graded verdict flows: venue deployment module →
   adapter → `grader-output.json` → `parseSweRebenchReport` → sealed
   verdict → Matrix cell (local runbook + recorded evidence;
   CI-dockerized variant explicitly out of scope).
3. The ungradeable-without-Docker path stays typed
   (`ungradeable-docker-unavailable` fixtures pattern).

### P4 — Paired statistics (`feat(benchmarking)` — MAY DISCHARGE)

The registry already has 7 methods incl. TWO paired two-arm comparisons,
both `versionRobust`: `paired-mcnemar@1` (**requires
`Run.replicates === 1`** — violates the 5-replicate design) and
`noninferiority-iut@1` (clustered BCa bootstrap on the paired rate
difference + Wilcoxon; `clusteredPairedRateDiffBca` already exists).

**R4 decision (lane recon, ~half day):** does `noninferiority-iut@1`
parameterize to a replicated, two-sided delta-with-CI read? If yes → P4
discharges; the eval design uses it. If no → `paired-delta@1`
**delegating to existing numerics**, touch-list verified:
`records/src/identifiers.ts` (+test), `aggregate/src/registry.ts`
(metadata `:170-252` + compute + list `:922-930`),
`aggregate/src/index.ts`, `registry.test.ts`, `benchmarking/testing`
method-conformance (ids hardcoded), new `fixtures/methods/paired-delta.json`,
**regenerated `fixtures/manifest.sha256.json`**.

**Acceptance (if built):** deterministic AND byte-stable JSON
(verification = exact JSON equality on recompute; floats via `fixed4`
discipline, `registry.ts:254-256`); `produceReport`/`verifyReport`
round-trip; conformance suite extended; zero product-side statistics.
Prior art (`packages/core/paired.ts`, `client/src/eval/wilson.ts`) is
reference-only — different stability obligations, never unified.

### P5 — End-to-end gate (`test(benchmark-product)`)

**Acceptance:** a 2-arm × N-replicate micro-benchmark (2–3 SWE-shaped
tasks from R5's slate) runs
draft→import→arms→quote→lock→launch→collect→report→verify on the local
venue with container grading, zero manual intervention; every expected
cell accounted in the Matrix; per-axis `match` on harness/model/loadout
via real admission evidence; `verifyMatrix`+`verifyReport` green; runbook
committed (pattern: `docs/runbooks/launch-swe-rebench-v2.md`) with a
recorded evidence artifact. R5 (slate recon) additionally delivers: 2–3
candidate slates with license, freshness/contamination notes, per-task
container runtime estimates, and pre-declared exclusion rules — feeding
the eval-design stream (the sibling program).

## Test blast radius (program-wide "must stay green or change deliberately")

Venue-local: `venue.test.ts`, `venue.integration.test.ts`,
`provisioner.test.ts`, `resolution.test.ts`, `sample-uniform.test.ts`
(capabilities snapshot + probe default), `signing.test.ts`. Quote seam:
`run-quote.test.ts`, `quote-presentation.test.ts` (hardcoded inventory
:88, cross-check :263). Integration: `run-path`, `assurance-presets`,
`run-resume`, `run-cancel`, `preview`, `cli-lifecycle` (literal output
:330). Cross-cutting: `public-quickstart.test.ts` (literal launcher
names), `docs-consistency.test.ts` (docs are load-bearing), `check:parity`
regenerate-then-check, web `actions.integration.test.ts` +
`production-flow.spec.ts` (hardcode prediction arms). Platform:
`loadout-inventory.test.ts`, `real-launchers.test.ts` (exact key lists),
`pinning.test.ts`, `capabilities.test.ts`. Any intentional change to a
pinned literal is called out in the PR body with rationale.

## Verification & process facts

- CI: `benchmark-product-ci.yml` (4 jobs; the 22-package portal build
  order at :69-92 is the authoritative chain);
  `platform-architecture-control.yml` on every PR (catalog +
  `generate-architecture.mjs --check`).
- Docker: possible in CI (`evidence-ci.yml` precedent) but out of scope;
  container e2e = local runbook + evidence.
- Guards: allowlist source-boundary with positive controls (unused
  allowlist entries FAIL); the inventory guard pins the exact graph +
  portal strings; packed-types via `npm pack --ignore-scripts`. New edge =
  the 8-step atomic checklist.
- Final proof: P5 green + all packet PRs merged + benchmark-product CI
  green on `integration/evidence-v1` + architecture control green.

## Decisions taken (operator-ratified at plan approval, 2026-08-11)

1. This program doc lands on its own branch/PR, not the #2551 GTM train.
2. The operator merges each packet PR after independent review + CI green
   (≤6 PRs).
3. P2b (the integrity fix) is in scope and blocking for the demo —
   pristine requires it.
4. The eval-method stream (power analysis, red-team, lock, publication)
   stays in the sibling demo-report-1 program — this program is
   engineering only.
