# DR-2026-08-05 — Cutover One-Swap Collapse

- **Date:** 2026-08-05
- **Status:** Proposed (operator ruling given in-session, Ritsu, 2026-08-05; ratification
  is approval of this PR)
- **Owning spec:** [`docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md`](../../docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md)
- **Amends:** the operator-daemon composition design (§10), the composition program plan
  (§2, §3, §4, §6 contracts 5/9/10, new §10), cutover stage plans 2/3/4 (top addenda),
  the stage-5 plan (dependency + baseline assumptions), the implementation-program
  addenda (§2 ruling 5, §3 register R1/R2), and the headless operator re-derivation
  design (§13 note). Each carries a dated amendment pointing back here.

## Context

Stage 1 of the operator-daemon composition cutover is deployed and gate-green (Base
Sepolia closed loop, tasks 1216/1217). Stage 2's implementation train (PR #2350) was
superseded: PR #2363 harvested its evaluator primitives into the native estate ("adapted
without cherry-picking", donor SHAs in its commit bodies), and the native derivation
dissolved both of its blocking ratifications (R1, R2 — decision 9 below). #2350 was
closed 2026-08-05 with its unique artifacts salvaged (`docs/salvage/stage-2/`,
`docs/runbooks/cutover-stage-2-drain.md`). A full-ref survey (1,470 refs, both remotes)
confirmed the remaining swap exists on no branch: the fleet daemon still constructs
`TaskEngine`, `DeliveryWatcherLoop`, and `CreatorLoop`, while the native machinery —
which DR-2026-08-04-b decision 1 rules is "the machinery the stages swap in" — is
reachable only from its parallel entry point.

Running stages 2, 3, and 4 as three separate hard swaps would build a bridge era three
times: bridge-subject synthesis for the evaluator (stage 2), carve-out closure and
legacy-posted-task compatibility (stage 3), and inter-stage handshake checks (stage 4) —
all of it deleted again by stage 5. The operator ruled against carrying that cost.

## Decisions

1. **Stages 2, 3, and 4 collapse into one wholesale swap.** One stacked PR train into
   `integration/evidence-v1`, one combined drain, one deploy PR (operator-approved), one
   gate. The design §10 stage rows 2–4 read as a single row whose "swaps in" and
   "retires" columns are the union of the three, **minus the bridge-era work the
   collapse deletes outright**: the bridge-subject synthesis and its admission-receipt
   rule (register R2 — dissolved unbuilt), the self-signer grant allowance (register R1
   — dissolved, decision 9), the operator-API archive mount (already reversed by the
   headless design §6), the mutating posting routes (already re-ruled by headless §4.2),
   and the inter-stage handshake checks the stage plans carried against each other.
   Stages 5 and 6 are unchanged in content; stage 5's dependency becomes "the one-swap
   deploy PR merged and its gate green." The support/earning loops are **not** in the
   swap — their re-derivation is stage 6's job (headless design §1). Legacy behavior
   continues to enter as kit fixtures, never ported code (composition §6.6 / program
   contract 12). Native-v1's parallel entry point (`native-main.ts`, the per-role file
   leases, `NativeProductFileSchema`, the `Daemon` `native-v1` compatibility branch)
   retires at **stage 5**, not in the swap — DR-2026-08-04-b decision 1 says "when the
   stages complete," headless §13(e) puts the `verticalMode` manifest-row flips in the
   stage-5 branch-deletion PR, and the `legacy-operator-composition` row stays `planned`
   through the swap (decision 7). The swap makes the parallel entry redundant; stage 5
   deletes it.

2. **One combined drain replaces contract 10's per-flow drains for the collapsed
   stages.** The drain freezes every retiring flow's intake before the single deploy:
   evaluator intake, posting, solver claims for the deploy window (operator may waive),
   peer-sync, registry lifecycle, evidence-driver publication — with one shared patience
   bound and **one** straggler table `(taskId, attemptIndex, requestId, flow)` in the
   deploy PR body. Stragglers strand **loudly and verifiably**: the straggler table in
   the deploy PR plus the per-flow chain probe (`cast call claimed(requestId)`) are the
   record — the `unreleased_attempt` notification kind is **documented-dead on the
   branch** (`client/src/api/notifications-build.ts:35-38`: "NOT wired… future work"),
   so no claim in this program rests on it; wiring it remains follow-up work, not a
   drain precondition. Rollback is symmetric, honest, and now **all-or-nothing across
   the three flows** — that is the accepted cost of the collapse, stated rather than
   hidden. Runbook: [`docs/runbooks/cutover-one-swap-drain.md`](../../docs/runbooks/cutover-one-swap-drain.md).

3. **The gate is a fused two-probe gate on the one deploy** (operator-selected over
   three separate probes):
   - **G-loop** — one natively-posted own task goes end-to-end on testnet: posted via
     `posting[]` / `jinn tasks submit`, claimed and solved by a second operator,
     evaluated through the native evaluator with a **container-graded** evaluation
     (decision 3a), verdict announcement `decisionGrade: true`, delivery adopted
     requester-side. Evidence: task id, creation/claim/deliver/claimSolutionDelivery/
     openVerdictAttempt/claimVerdictDelivery transaction hashes, the announcement id,
     and the adoption receipt. This fuses the former stage-2 and stage-3 gates and is
     stronger than either: a natively-posted subject carries a real Submission and
     admission receipt, so the evaluator leg is proven with no bridge synthesis.
   - **G-archive** — the former stage-4 gate unchanged: a second daemon consumes the
     public archive listener (cold sync, digest retrieval, resume, live tail) and the
     serving-plane conformance kit runs green against the live surface.
   - **3a (operator ruling):** grader-container execution **blocks the gate**. The
     deploy does not happen until container grading works; G-loop's evidence set must
     include a container-graded evaluation, not only the prediction profile.
   - Gating on the Phase B closure manifest is **rejected**: headless §7 rules Class A
     "a target state, not a present discipline" — no closure-receipt writer runs in
     production and no closure verifier exists, so a closure receipt cannot gate
     anything until the verifier ships. The closure manifest MAY be emitted as
     non-gating Class O observational evidence attached to the deploy PR.

4. **The bridge-era document window ends at the swap, conditionally.** The combined
   drain is designed to leave zero non-terminal legacy-posted tasks, closing the
   bridge-era window (contract 9) at the deploy. If the straggler table is non-empty at
   deploy, the legacy-task synthesis survives for exactly those subjects and its
   transition-manifest row stays `migrating` until stage 5 (decision 7).

5. **The `e2e:app-flow` gate is re-scoped inside the train, with no green-less
   commit** (operator-selected). Its current specs (`solvernet-flow.e2e.test.ts`,
   `join.e2e.test.ts`) exercise surfaces the swap retires. Keeping those surfaces alive
   until stage 6 was rejected (vacuous parity over deleted machinery); voiding the gate
   was rejected (headless §13 names it as the failure mode). Instead, a train PR
   **before** the retirement wave authors replacement specs — a mutation-asserting
   claim-policy/execution-wiring spec and a read-plane posting-status spec — and
   re-points the `e2e:app-flow` script at them while the old specs still pass; the
   retirement-wave PR then deletes the old specs together with their surfaces. At every
   commit of the train the gate points at surfaces that exist and asserts a real
   mutation. `e2e:funding-sequence` is untouched. Stage 6's precondition (re-home the
   gates onto the console pipeline) is unchanged in kind and now ranges over the
   re-scoped spec set.

6. **Staleness-findings register** (recorded here per the designs-are-law rule; each
   owning plan's addendum mirrors its own entries):
   1. The stage-2 plan's in-executor attestation-signing architecture was reversed
      2026-08-03 (`25924bd4a`): the sandbox writes an unsigned Result Evaluation
      statement; the host byte-equality-reseals it. Stage-2 Tasks 8 and 12 assert the
      old model and are killed accordingly.
   2. Stage-3 Tasks 23/24's mutating posting routes were killed by headless §4.2
      (posting status joins the read plane; mutations are config + `jinn tasks`; no
      mutating posting routes). T23 dies; T24 survives read-only.
   3. Stage-4 Task 3's operator-API archive mount was reversed by headless §6 (separate
      listener only). "Lands at stage 4" now reads "lands in the swap."
   4. Stage-4 Task 8's client-side notification derivation is superseded by the landed
      server-side `GET /v1/notifications`; its target file
      `client/src/dashboard/spa/src/api/types.ts` was deleted (headless §8 artifact 2) —
      contract types live under `client/src/api/contract/`.
   5. Grader-container execution has no owner on the integration branch — the shipped
      `evaluator-adapters` boundary explicitly delegates container execution to the
      host (the evaluator-adapters plan's finding 1, labeled "Finding A" in the salvage
      README), and the only implementation is the salvage at `docs/salvage/stage-2/`.
      The swap train owns the port, under the salvage README's three re-derivation
      constraints. This is the single largest genuinely-unbuilt item in the collapsed
      scope.
   6. The stage-2 plan's Task 9 is titled "Evaluation Submission derivation with the
      carve-out enforced" — the carve-out is dissolved (decision 9); the done-native
      verification for that row verifies the **grant-free** derivation's tests, not the
      carve-out's.

7. **Transition-manifest edits ride the swap train, citing this decision record.**
   - `legacy-evaluator-delivery-watcher` → `deleted` in the retirement PR that deletes
     its entry points.
   - `marketplace-pipeline` → `deleted` **if** the native claim path fully replaces
     `runPipeline` in this train and the pipeline package deletes with zero remaining
     client imports; otherwise the row stays `migrating` and the deploy PR says so.
     Implementation constraint: `config/shape-v2.ts` must re-home its pipeline-typed
     legacy fields without importing the pipeline, because contract 4 keeps legacy
     config keys parseable until stage 5.
   - `legacy-task-submission-synthesis` → `deleted` conditional on an empty straggler
     table at deploy (decision 4); otherwise `migrating` until stage 5.
   - `legacy-wiring-config`, `legacy-operator-composition`,
     `legacy-task-run-store-coupling` — **not** flipped; stage-5 scope (headless §13).
   - The manifest's `defaultPolicy` and dissolved `targetPullRequest` strings still
     speak the "default flip" frame that DR-2026-08-04-b dissolved. They are rewritten
     in the swap train to the stage-driven frame — "Retirement is stage-driven under the
     composition cutover (DR-2026-08-04-b): a row flips to `deleted` in the PR train
     that deletes its machinery, citing Class A evidence; there is no default flip" —
     together with the coupled assertion edit in
     `.github/scripts/phase-d-transition-deletion.test.mjs` (the `includes('remains
     legacy')` check follows the text). The closed `EXPECTED_TRANSITIONS` list is
     untouched: no rows are added or removed.
   - **Three further deletion-test assertions break under the swap and are in the
     train's scope** (each edited in the retirement PR that invalidates it, never
     pre-emptively): (a) the `legacy-task-run-store-coupling` arm's unconditional
     `deepEqual` on the exact `TaskRunPersistence` importer list — the list shrinks as
     `delivery-watcher.ts`, `engine.ts`, `work-loop-corpus.ts`'s usage, and
     `mech/adapter.ts` retire; (b) the `marketplace-pipeline` not-deleted arm's frozen
     consumer list, which `shape-v2.ts`'s de-pipelining breaks by itself; (c) the
     `legacy-task-submission-synthesis` deleted-arm assertion that
     `client/src/daemon/projector-enrich.ts` not exist — that file carries non-bridge
     exports (`ProjectorEnrichPorts`, `createProjectorEnrich`), so the flip **requires
     splitting the synthesis out of it first**; if the split does not land in-train, the
     row stays `migrating` regardless of the straggler table.

8. **Mainnet posture: refuse and pin** (operator-selected). The swapped daemon's boot
   gate (`assertNativeDeployment`) admits only Base Sepolia 84532 with the pinned
   today-generation addresses — so native mode + mainnet is an **explicit boot
   refusal** (hard error, never a silent legacy fallback), and the mainnet fleet stays
   pinned to the pre-swap canary until a mainnet native deployment is chartered (Phase 2
   scope). This amends the composition design §11 non-goal ("no mainnet deployment
   decisions") to exactly this extent: the swap makes the refusal explicit; it charters
   nothing.

9. **Ratification-register items R1 and R2 are dissolved** (they were
   operator-ratification-class; this record is their disposition). R1 (self-signer
   grant / evaluator-seals carve-out): the native derivation seals evaluation
   Submissions with `capabilityGrants: {}` (`client/src/evaluator/native-evaluation-derivation.ts`)
   and the host enforces grant-free sealing — there is no carve-out left to ratify, and
   the salvage README rules "do not carry the carve-out forward." R2 (bridge subject):
   the native path acquires real, digest-verified subject material; nothing is
   synthesized from a legacy anchor, and the drain (decision 2) empties the set the
   synthesis existed for. What requester-side sealing still owes (former stage-3 Task
   12) is re-scoped: sealing evaluation Submissions for the operator's **own posted**
   tasks carrying private test material under capability grants — the default the
   binding always intended.

## Deliberately unresolved (the swap implementation plan's scope)

The PR-train decomposition and stacking order (constraints only: kit/fixture PRs before
the deletions they pin; the e2e re-scope PR before the retirement wave; one deploy PR at
the end carrying the drain checklist and rollback pin, operator-approved); the
verification protocol for each done-native disposition row; the grader-execution port
details beyond the salvage constraints; whether `marketplace-pipeline` deletion fits
this train (decision 7's conditional); the exact replacement-spec contents for the e2e
gates; the `shape-v2.ts` de-pipelining mechanics; **names-as-landed** — the program §5
namings (`src/daemon/evaluator-loop.ts`, `src/requester/`) yield to the landed native
module names where the native estate already owns the capability.

## Operator decisions bound to deploy time

Solver-claim freeze required or waived (runbook step 3); straggler-table-empty
confirmation (governs decision 7's conditional flip); drain window and rollback canary
pin at deploy-PR open; Class A evidence sufficiency on each retirement-wave manifest
flip.

> **Addendum 2026-08-07 — gate dependency discovered unbuilt: identity provisioning.**
> The decision-3 gate (G-loop, two operators natively posting/solving/evaluating on
> testnet) depends on both operators holding native trust artifacts — role-identity
> stores, a shared trust catalog, a finalized on-chain anchor. On 2026-08-07 this
> provisioning path was found to exist **only as e2e fixtures**
> (`client/test/e2e/fixtures/native-fleet/`): the native estate shipped the trust
> verification layer complete and the production creation path unbuilt, so the real
> operators (Base Sepolia services 72/75) have OLAS earning identities but no native
> identities, and the gate cannot run. The operator ruled for the proper architecture
> over an expedient script. The work is chartered by
> [`spec/2026-08-07-native-identity-ceremony.md`](../../spec/2026-08-07-native-identity-ceremony.md)
> (a `@jinn-network/trust-authoring` package, a `jinn ceremony` CLI, and one trust-layer
> amendment: the settlement-authority association, whose shipped check compared the
> ceremony's SIWE `message.address` to the service Safe — satisfiable only by the e2e
> rig's EOA=="Safe" conflation, never by a real contract-account Safe). The gate's
> precondition list gains "both operators provisioned via `jinn ceremony`"; nothing else
> in this record changes.

> **Addendum 2026-08-07 — decision 3a decoupled into two evidence artifacts.**
> Decision 3a (operator ruling, stricter than the coordinator's recommendation) required
> grader-container execution to **block** the gate: no deploy until container grading
> works, and G-loop's evidence set must carry a container-graded evaluation, not only a
> prediction-profile one. On 2026-08-07 a code read established that a container-graded
> evaluation cannot occur **inside** the native G-loop as built. Three independent hard
> stops on this branch:
> 1. **The posted task is pinned to one fixture.**
>    `client/src/native-requester/requester.ts:97` fixes
>    `const FIXTURE = 'prediction-forecast-golden.json'`, and `request()` refuses any
>    other value (`:1916`). `posting[]` supplies run identity, not task content — there
>    is no surface on which to post a container-graded subject.
> 2. **The native claim allowlist is prediction-only.**
>    `client/src/daemon/native-claim-policy.ts:24` declares
>    `PHASE_B_NATIVE_PROFILE_ALLOWLIST = [PREDICTION_FORECAST_PROFILE_URI]`; it is read
>    at `:170` and a non-prediction card refuses non-retryably with
>    `unsupported-profile` (`:172`). The widening hook exists but is never used:
>    `allowedProfiles` is optional (`:48`) and `buildNativeClaimPolicy`
>    (`client/src/daemon/native-assembly.ts:187`) never populates it — no config surface
>    reaches it anywhere in `client/src`.
> 3. **Each shipped evaluator deployment declares exactly one registration.**
>    `client/deployments/evaluator/prediction-market-deployment.mjs:182` and
>    `swe-rebench-v2-deployment.mjs:183` each export `registrations: [registration]`, and
>    `compatibleRegistration`
>    (`client/src/daemon/native-evaluator-composition.ts:410`) refuses unless **exactly
>    one** registration matches the EvaluationSpec — zero and two are both errors. No
>    multi-registration deployment module exists in-repo.
>
> Additionally the prediction profile carries no grader adapter, so supplying
> `graderReportSources` for it is itself a hard refusal — `bindGraderReportSource`
> (`client/src/daemon/native-evaluator-composition.ts:298`) throws "is not
> container-graded and takes no host grader report source" (`:316-320`).
>
> **This is deliberate Phase-B scoping, not a defect.** The allowlist constant is
> literally named `PHASE_B_…`. Nothing is broken; the loop was scoped to one profile on
> purpose, and 3a asked one gate to prove two things the built system keeps apart.
>
> **Operator ruling (Ritsu, 2026-08-07): decouple into two evidence artifacts.** The
> gate becomes:
> - **(i) G-loop** — closed end-to-end on the **prediction** profile with two real Base
>   Sepolia operators (A = service 72, B = service 75): post → claim → deliver →
>   evaluate → adopt, on-chain, honestly distinct operators.
> - **(ii) Container-grade proof** — a **separately run, real** container-graded
>   evaluation through the M4c Docker path
>   (`client/src/daemon/native-evaluator-container-runtime.ts` with the swe-rebench
>   deployment), proving container grading genuinely works.
>
> Both properties 3a was protecting — a native loop that closes, and grading that really
> executes in a container — are still proven; they are simply two artifacts rather than
> one. **G-archive is unchanged.**
>
> **The bar does not move.** The retirement wave (Wave 4) still requires **both**
> artifacts green before any transition-manifest flip, and the deploy still does not
> happen until container grading is proven. The decoupling changes the **shape** of the
> evidence, not the standard it must meet. Decision 3's other clauses — verdict
> `decisionGrade: true`, requester-side adoption, the closure-manifest rejection — stand
> unchanged. A single-artifact gate becomes possible again only when a container-graded
> task can flow through the loop: a config surface for the posted task profile, a
> configurable claim allowlist, and a multi-registration evaluator deployment. That is
> filed as follow-up work, not a precondition of this gate.

## Provenance

In-session ruling (Ritsu, 2026-08-05) following: the #2350 disposition and salvage; the
1,470-ref survey; a three-lane read-only exploration (program/stage plans, daemon code
seams, constraint register) and a two-perspective design pass (amendment design,
implementation-program design), each by an isolated agent; four operator selections
recorded in the implementation plan (e2e re-scope; fused two-probe gate; mainnet
refuse-and-pin; grader blocks the gate).
