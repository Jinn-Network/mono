# Autopilot V2 Marketplace Session Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> task-by-task. Every production behavior is implemented test-first.

**Goal:** Execute every Autopilot V2 agent session through the Jinn task
marketplace while leaving deterministic lifecycle and all GitHub mutation
authority in Autopilot.

**Architecture:** Autopilot first wins its existing branch or review claim and
creates its existing host attempt. A backend-neutral executor either starts the
current local coordinator or posts one immutable `jinn-repo.v1`
`autopilot-session` Task through the one-shot Jinn CLI. Marketplace clients
Mech-deliver typed results, wait for an exact GitHub adoption receipt, and only
then claim the corresponding Router delivery.

**Tech stack:** TypeScript, Zod v3 wire codecs, Vitest, SQLite task-run
persistence, Git/GitHub CLI ports, viem/Mech/Router adapters.

## Global Constraints

- `JINN_AUTOPILOT_EXECUTION_BACKEND=local|marketplace`; unset means `local`.
- Marketplace mode never starts a local agent and never falls back locally.
- Autopilot keeps the host worktree and is the only holder of GitHub mutation
  capability.
- Existing `checkpoint`, `implementation-complete`, `child-complete`,
  `review-verdict`, `review-findings`, and `human` operations remain the sole
  lifecycle mutation gateway.
- `jinn-repo.v1` gains an additive `source: "autopilot-session"` task branch;
  existing `merged-pr` and `live-issue` documents remain valid.
- `maxClaims=1`, one required verdict, distinct solver/evaluator identities,
  and no contract change in V1.
- Mech delivery is never repeated after its transaction is persisted.
- Router Solution/Verdict claims occur only after an exact accepted adoption
  receipt.
- Patches are UTF-8 unified diffs no larger than 2 MiB and are never applied
  with `--3way`.
- Known Human/CODEOWNER surfaces do not enter the V1 automatic canary.
- Every cross-system operation is idempotent on the complete correlation
  tuple, never on issue numbers or substring matching.

---

### Task 1: Shared session, result, correlation, and receipt contracts

**Files:**

- Create: `packages/sdk/src/autopilot-session.ts`
- Create: `packages/sdk/test/autopilot-session.test.ts`
- Create: `packages/sdk/test/fixtures/autopilot-session/*.json`
- Modify: `packages/sdk/src/jinn-repo.ts`
- Modify: `packages/sdk/src/payloads/jinn-repo.ts`
- Modify: `packages/sdk/src/solvernets/jinn-repo.ts`
- Modify: `packages/sdk/src/contracts.ts`
- Modify: `packages/sdk/test/task.jinn-repo.test.ts`
- Modify: `packages/sdk/test/payloads.jinn-repo.test.ts`

**Produces:**

```ts
type AutopilotWorkflow =
  | 'implement'
  | 'fix-child'
  | 'reconcile'
  | 'ci-failure';

const AutopilotSessionCapsuleSchema: ZodType<{
  schemaVersion: 'jinn-autopilot-session.v1';
  workflow: AutopilotWorkflow;
  repository: 'Jinn-Network/mono';
  issueNumber: number;
  childIssueNumber?: number;
  parentPrNumber?: number;
  prNumber: number;
  targetBase: string;
  branch: string;
  claimOid: string;
  expectedHead: string;
  v2AttemptId: string;
  runnerId: string;
  taskSnapshot: {
    title: string;
    body: string;
    prBody: string;
    baseSha: string;
  };
  workflowContract: {
    skill: 'implement-issue' | 'fix-child' | 'reconcile';
    version: 'v2';
    resultSchema:
      | 'jinn-autopilot-mutation-result.v1'
      | 'jinn-autopilot-review-result.v1';
  };
  deadline: string;
  receiptAuthors: string[];
}>;

const AutopilotCorrelationSchema: ZodType<{
  taskId: string;
  attemptIndex: number;
  requestId: string;
  deliveryEnvelopeCid: string;
  v2AttemptId: string;
  claimOid: string;
  prNumber: number;
  expectedHead: string;
  resultingHead?: string;
  reviewedHead?: string;
  reviewGeneration?: string;
  reviewRefOid?: string;
}>;
```

Mutation results are a strict `mutation-complete | human` union. Review results
are a strict `approve | request-changes | human` union. Adoption receipts are a
strict role/disposition union covering accepted/rejected Solution and Verdict
receipts with the stable rejection reason codes from the approved design.

- [ ] Write fixture-driven tests for every workflow, result outcome, receipt
      disposition, correlation mismatch, unknown field, and legacy
      `jinn-repo.v1` compatibility case.
- [ ] Run focused SDK tests and confirm they fail because the new exports and
      task/payload branches do not exist.
- [ ] Implement strict codecs and additive public exports.
- [ ] Run the focused tests, SDK typecheck, and complete SDK suite.
- [ ] Commit as `feat(sdk): add Autopilot marketplace session contracts`.

### Task 2: Machine-facing one-shot Task submission

**Files:**

- Create: `client/src/tasks/submit-request.ts`
- Create: `client/test/cli/commands/tasks.test.ts`
- Modify: `client/src/cli/commands/tasks.ts`
- Modify: `client/src/tasks/posting-service.ts`
- Modify: the existing task-post persistence/adapter ports only where required
  for exact digest recovery.

**Produces:**

```ts
const MarketplaceTaskSubmitRequestSchema: ZodType<{
  schemaVersion: 'jinn-task-submit-request.v1';
  id: string;
  description: string;
  solverType: 'jinn-repo.v1';
  solverNetManifestCid?: string;
  solverNet?: string;
  createdAt: number;
  window: { startTs: number; endTs: number };
  claimPolicy: {
    mode: 'exclusive';
    maxClaims: 1;
    maxClaimsPerOperator: 1;
    claimWindowStartTs: number;
    claimWindowEndTs: number;
    submissionDeadlineTs: number;
    claimLeaseTtlSeconds: number;
    requiredVerdicts: 1;
  };
  spec: JinnRepoAutopilotSessionTask;
}>;
```

`jinn tasks submit --request-file <path> --yes --json` is mutually exclusive
with the legacy loose task flags. It returns `taskId`, `taskCid`, creation
transaction/block, selected SolverNet manifest CID, and `idempotent`.
`--dry-run` validates creator Safe, funding/configuration, contracts, target
SolverNet, indexer, gateway, and RPC without broadcasting.

- [ ] Write failing command tests for exact request parsing, malformed and
      unknown fields, mutual exclusion, dry-run non-mutation, rich JSON output,
      deterministic retry, and crash recovery after broadcast.
- [ ] Add the strict request codec and refactor `tasks submit` through one
      normalized task-construction path.
- [ ] Persist the canonical request/signed Task before broadcast and recover
      `TaskCreated` by creator plus Task/manifest digests before reposting.
- [ ] Run focused CLI/posting tests and client typecheck.
- [ ] Commit as `feat(client): add machine Task submission contract`.

### Task 3: Adoption-aware client delivery state

**Files:**

- Modify: `client/src/harnesses/engine/state.ts`
- Modify: `client/src/harnesses/engine/delivery.ts`
- Modify: `client/src/harnesses/engine/engine.ts`
- Modify: `client/src/harnesses/engine/persistence.ts`
- Modify: `client/src/types/task-run.ts`
- Add/modify: focused engine state, delivery, persistence, and recovery tests.

**Produces:**

```ts
type AdoptionObservation =
  | { state: 'pending'; observedAt: string; detail?: string }
  | { state: 'accepted'; receipt: AutopilotAdoptionReceipt }
  | { state: 'rejected'; receipt: AutopilotAdoptionReceipt }
  | { state: 'contradictory'; detail: string };

interface AdoptionReceiptObserver {
  observe(run: TaskRun): Promise<AdoptionObservation>;
}
```

Autopilot-session runs use
`DELIVERING -> AWAITING_ADOPTION -> CLAIMING_DELIVERY -> COMPLETE`.
All other task types retain immediate deliver-and-claim behavior.

- [ ] Write failing transition, persistence, no-redelivery, and restart tests.
- [ ] Split Mech delivery from Router claim while retaining the compatibility
      `deliverAndClaim` path for non-Autopilot tasks.
- [ ] Persist the complete waiting/claiming payload and recover each phase
      without repeating its predecessor.
- [ ] Treat accepted, rejected, pending, and contradictory receipts exactly as
      specified; rejected runs end with
      `adoption-rejected:<stable-reason>`.
- [ ] Run focused engine tests and client typecheck.
- [ ] Commit as `feat(client): wait for Autopilot adoption before settlement`.

### Task 4: V2 backend abstraction and direct marketplace publisher

**Files:**

- Create: `packages/autopilot/src/lifecycle/session-execution-backend.ts`
- Create: `packages/autopilot/src/lifecycle/marketplace-session-backend.ts`
- Modify: `packages/autopilot/src/lifecycle/active-config.ts`
- Modify: `packages/autopilot/src/lifecycle/active-runtime-production.ts`
- Modify: `packages/autopilot/src/lifecycle/implementation-executor.ts`
- Modify: `packages/autopilot/src/lifecycle/review-executor.ts`
- Modify: `packages/autopilot/src/lifecycle/attempt-workspace.ts`
- Modify: `packages/autopilot/scripts/run-autopilot-v2.ts`
- Add/modify: backend, executor, manifest, runtime, and boot tests.

**Produces:**

```ts
interface SessionExecutionBackend {
  start(input: ClaimedSessionInput): Promise<ExecutionHandle>;
  recover(handle: ExecutionHandle): Promise<ExecutionObservation>;
  cancel(handle: ExecutionHandle, reason: string): Promise<void>;
}
```

The marketplace implementation writes an immutable request file and invokes
`jinn tasks submit --request-file ... --yes --json`. Its stable Task key is
`autopilot:<v2AttemptId>`. Attempt manifests add a backward-compatible
backend-discriminated execution record; missing backend decodes as local.

- [ ] Write failing config, local conformance, manifest compatibility, remote
      capacity/recovery, CLI invocation, and “spawn was never called” tests.
- [ ] Implement the local adapter around current coordinator spawning.
- [ ] Implement marketplace preflight/publisher/recovery with no daemon,
      launcher, marker generator, or local fallback.
- [ ] Route mutation sessions through the selected backend after existing
      branch/PR authority is established.
- [ ] Suppress standalone local review dispatch in marketplace mode; review is
      anchored during Solution adoption.
- [ ] Run focused Autopilot tests, typecheck, and full Autopilot suite.
- [ ] Commit as `feat(autopilot): add marketplace session backend`.

### Task 5: Exact delivery observation, safe mutation adoption, and receipts

**Files:**

- Create focused Autopilot modules for delivery observation, patch validation,
  result application, repository verification, and adoption receipts under
  `packages/autopilot/src/lifecycle/`.
- Reuse production session ports rather than duplicating GitHub mutations.
- Add unit/integration tests beside the new modules.

**Behavior:**

- Resolve the exact attempt from the locally recorded Task ID, then resolve its
  request/operator/envelope through the indexer and verify the Mech `Deliver`
  event through RPC.
- Validate the complete correlation tuple and current V2 authority before
  writing a patch file.
- Reject over-2-MiB, binary, absolute/traversal/`.git`, symlink, and submodule
  patches; require clean `git apply --check`; never use `--3way`.
- Apply in the existing host worktree, run the versioned `jinn-mono.v1`
  verification profile, commit marketplace evidence trailers, then invoke the
  existing implementation/child protocol.
- Acquire the exact-head review claim before writing the accepted Solution
  receipt.
- Locate receipts by exact marker; verify author and observable GitHub facts;
  reconstruct idempotently; contradiction moves to Human.

- [ ] Write each rejection and crash-boundary test first.
- [ ] Implement pure validation before filesystem/Git/GitHub effects.
- [ ] Implement idempotent GitHub receipt writer/reader through injected ports.
- [ ] Implement mutation application and session-protocol translation.
- [ ] Run focused adoption tests, integration tests, typecheck, and Autopilot
      suite.
- [ ] Commit as `feat(autopilot): adopt marketplace mutation results`.

### Task 6: Semantic full-head evaluator and Verdict adoption

**Files:**

- Add an Autopilot-session evaluator runner under
  `client/src/harnesses/impls/jinn-repo-evaluator/`.
- Modify evaluator registration/routing and evaluation Task construction.
- Add review-result adoption under Autopilot lifecycle modules.
- Add exact-head evaluator and review-protocol tests.

**Behavior:**

- An evaluator must differ from the Solution operator.
- Evaluation starts only after an accepted Solution receipt and receives the
  full exact PR head, review generation, and review-ref OID.
- Deterministic checks run before the semantic `review-pr` workflow.
- Semantic output is typed `approve | request-changes | human`.
- Autopilot applies the result through its existing review protocol, reads
  back the native approval/finding child/Human outcome, and writes the Verdict
  adoption receipt.
- The evaluator claims the Router Verdict only after validating that receipt.
- Existing mechanical evaluation remains unchanged for non-Autopilot tasks.

- [ ] Write failing role-separation, full-head, stale-head/generation,
      semantic-output, native-readback, and wait-before-claim tests.
- [ ] Implement additive evaluator routing and typed output.
- [ ] Implement review-result adoption and Verdict receipt publication.
- [ ] Run focused client/Autopilot tests and both typechecks.
- [ ] Commit as `feat: add Autopilot marketplace semantic evaluation`.

### Task 7: Child-loop recovery and closed-fleet vertical proof

**Files:**

- Add backend conformance and failure-injection tests in Autopilot.
- Add an Anvil-backed client/Autopilot vertical test or extend the nearest
  existing task-first marketplace fixture.
- Add canary configuration documentation without enabling broad routing.

**Behavior:**

- Cover review-finding, reconcile, and CI-failure Tasks on the existing parent
  branch.
- Prove request changes creates one aggregated child, its patch is adopted,
  and a fresh distinct evaluator reviews the complete new head and approves.
- Crash at every boundary named in the approved design without duplicate Task,
  delivery, patch application, commit, PR mutation, receipt, Solution, or
  Verdict.
- Keep canary eligibility behind an issue allowlist and exclude
  Human/CODEOWNER surfaces.

- [ ] Write conformance and failure-injection tests before missing behavior.
- [ ] Complete any recovery wiring exposed by those tests.
- [ ] Run SDK, Autopilot, focused client, typecheck, and Anvil vertical suites.
- [ ] Record the pre-existing unrelated `packages/layer` lockfile baseline
      failure if it still prevents the monolithic client test command.
- [ ] Commit as `test: prove Autopilot marketplace closed loop`.

