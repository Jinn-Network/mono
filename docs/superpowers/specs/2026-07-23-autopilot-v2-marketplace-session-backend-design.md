# Autopilot V2 Marketplace Session Backend

- **Date:** 2026-07-23
- **Status:** design approved; written review pending
- **Shape:** `design`
- **Scope:** make the Jinn task marketplace an execution backend for every
  Autopilot V2 agent session while preserving the single-surface lifecycle

## 1. Summary

Autopilot V2 keeps deterministic lifecycle authority. The Jinn task
marketplace executes every judgment-bearing agent session.

The boundary is:

> Autopilot decides what work exists and performs every shared mutation. The
> marketplace supplies agent-produced session results.

When the marketplace backend is selected:

- initial implementation, review-finding repair, reconciliation, and
  persistent CI-failure repair execute as marketplace Tasks;
- independent PR review executes as the evaluator leg of the marketplace Task
  whose adopted Solution produced the reviewable head;
- Autopilot retains branch claims, review claims, GitHub credentials, branch
  publication, PR mutations, issue filing, native reviews, CI routing, Human
  gates, and merge authority; and
- the existing V2 session protocol remains the sole mutation gateway.

The first version uses the existing two-step marketplace delivery rail:

```text
Mech delivery -> Autopilot adoption -> Router delivery claim
```

The client currently performs those two marketplace operations consecutively.
V1 pauses between them. Autopilot consumes and applies the delivered session
result, writes a durable GitHub adoption receipt, and only then allows the
operator to record the Solution or Verdict through the Router.

This makes marketplace settlement describe work that has actually entered the
authoritative V2 lifecycle. It also guarantees that a marketplace evaluator
cannot begin semantic review before the delivered implementation is
materialized as an exact, review-claimed PR head.

V1 is a closed-SolverNet deployment with official operator clients,
`maxClaims=1`, no local-agent fallback, and no TaskCoordinator or Router
contract change. Opening the fleet requires protocol-level enforcement of the
adoption receipt (§14).

## 2. Relationship to existing designs

This design supersedes the lifecycle integration in
`spec/2026-07-20-autopilot-marketplace-execution.md`. The earlier design and
its implementation remain useful foundations:

- the `jinn-repo.v1` live-issue schema;
- live issue generation;
- solution-envelope discovery;
- the mechanical live evaluator; and
- closed-fleet SolverNet operation.

The earlier delivery bridge and legacy execution-mode switch do not become the
V2 integration:

- they route work before the V2 branch claim;
- they create an unrelated `feat/...` branch from the latest `origin/next`;
- they open a second draft PR after delivery; and
- they do not enter the V2 completion-marker, child, exact-head review, or
  recovery protocols.

This design instead amends the execution mechanics of
`2026-07-21-single-surface-lifecycle.md`. That lifecycle remains authoritative:

- Git and PR facts define lifecycle state;
- Project Status remains paint;
- branch and review claims remain compare-and-swap fenced;
- publication remains append-only;
- native verdicts remain exact-head bound;
- children remain the only repair loop; and
- Human and merge authority do not move into the marketplace.

Marketplace identifiers and delivery state are attempt-operation data. They
must never become an alternative source of lifecycle truth.

## 3. Goals and non-goals

### 3.1 Goals

1. Select `local` or `marketplace` as the process-wide session execution
   backend without changing V2 scheduling or lifecycle semantics.
2. Send every agent session to the selected backend. Deterministic Autopilot
   work never becomes a marketplace Task.
3. Preserve the existing V2 session verbs as the only shared-mutation surface.
4. Keep marketplace solvers and evaluators free of GitHub credentials and V2
   lifecycle manifests.
5. Adopt marketplace artifacts into the already-claimed V2 branch and PR.
6. Make independent review the evaluator leg of the head-producing Task,
   while reviewing the full exact PR head rather than only that Task's patch.
7. Reuse the current Mech-delivery/Router-claim gap so evaluation becomes
   discoverable only after implementation adoption and review-claim
   acquisition.
8. Preserve idempotent recovery across process, network, GitHub, IPFS, and
   chain failures.
9. Prove one complete request-changes -> child -> fresh-review -> approve loop
   before routing ordinary work.

### 3.2 Non-goals

V1 does not:

- redesign V2 issue eligibility, branch claims, review claims, child issues,
  CI handling, Human gates, or merge rules;
- let marketplace operators push branches, create PRs, file GitHub issues, or
  post native reviews directly;
- add a separate marketplace lifecycle to GitHub;
- make review a self-review continuation of the implementation solver;
- create a standalone top-level Review Task for the normal path;
- refactor the stable local backend to emit marketplace-shaped envelopes;
- support mixed local/marketplace agent stages inside one Autopilot process;
- open the SolverNet to arbitrary operators;
- solve model, harness, provider, or reasoning-effort procurement;
- add parallel competing Solutions;
- rely on Project fields for lifecycle decisions; or
- replace the normal CI and human merge gates with marketplace Verdicts.

## 4. Ownership boundary

### 4.1 Autopilot control plane

Autopilot permanently owns:

- reading GitHub and deriving V2 lifecycle state;
- issue eligibility, prioritization, backpressure, and capacity;
- implementation branch-claim creation and compare-and-swap publication;
- early draft PR creation;
- exact-head review-claim acquisition and release;
- attempt identity and recovery;
- validation and materialization of delivered artifacts;
- branch checkpoints and completion commits;
- labels, draft state, PR summaries, comments, and durable markers;
- native `APPROVE` and `REQUEST_CHANGES` reviews;
- review-finding, reconcile, CI-failure, and follow-up issue filing;
- Human overlays;
- deterministic update-branch and CI operations; and
- merge authority.

### 4.2 Marketplace execution plane

Marketplace operators own:

- claiming an advertised agent session;
- executing the supplied workflow against the immutable session context;
- producing code artifacts, evidence, summaries, findings, or escalation
  reasons;
- delivering the signed result envelope through Mech;
- waiting for Autopilot adoption; and
- claiming the Solution or Verdict delivery only after an accepted adoption
  receipt.

The evaluator operator must differ from the Solution operator. The existing
TaskCoordinator self-evaluation prohibition remains in force.

### 4.3 Deterministic versus agentic work

| V2 operation | Owner |
|---|---|
| Derive state and choose the next transition | Autopilot |
| Win implementation or review authority | Autopilot |
| Open draft PR | Autopilot |
| Implement an issue | Marketplace solver |
| Diagnose and repair a review finding | Marketplace solver |
| Resolve a semantic merge conflict | Marketplace solver |
| Diagnose and repair persistent CI failure | Marketplace solver |
| Review an exact PR head | Marketplace evaluator |
| Apply artifacts and publish commits | Autopilot |
| File issues and post native reviews | Autopilot |
| Observe/rerun CI and perform clean update-branch | Autopilot |
| Enforce Human, CODEOWNER, CI, and merge gates | Autopilot |

## 5. Backend-neutral session contract

### 5.1 `SessionExecutionBackend`

V2 depends on one backend-neutral executor:

```ts
interface SessionExecutionBackend {
  start(input: ClaimedSessionInput): Promise<ExecutionHandle>;
  recover(handle: ExecutionHandle): Promise<ExecutionObservation>;
  cancel(handle: ExecutionHandle, reason: string): Promise<void>;
}
```

These names define the design boundary. Its contract may not expose GitHub
mutation capability.

The local implementation wraps the current coordinator process. The
marketplace implementation creates or recovers a Task and returns its
correlation identifiers.

`cancel` means "stop accepting this result through the official backend." It
does not authorize destructive Git or GitHub cleanup.

### 5.2 `ClaimedSessionInput`

Every backend receives the same logical session input:

- workflow kind;
- issue and optional child issue;
- PR, target base, and claimed branch;
- V2 attempt, runner, claim OID, and expected head;
- review generation and review-ref OID when the session is a review;
- approval policy;
- immutable issue/PR context;
- workflow skill and contract version;
- deadline; and
- required result schema.

The local backend may continue receiving this through its manifest and prompt.
The marketplace backend serializes it into the Task document.

### 5.3 `SessionResult`

An agent produces one typed result. The result describes judgment and
artifacts, never shared mutations.

Mutation workflows produce one of:

```text
mutation-complete:
  artifact
  summary
  evidence

human:
  reason
```

Review produces one of:

```text
approve:
  body
  optional non-blocking follow-ups

request-changes:
  blocking findings

human:
  reason
```

The artifact is a patch in V1. It is UTF-8, size bounded, path validated, and
applied without a `--3way` fallback. Commit bundles and streamed checkpoints
are later extensions.

### 5.4 `SessionResultApplier`

The host translates an accepted result into the existing V2 protocol:

| Result | Existing V2 operation |
|---|---|
| mutation artifact | materialize in attempt worktree, then `checkpoint` |
| initial implementation complete | `implementation-complete` |
| fix/reconcile/CI child complete | `child-complete` |
| approve | `review-verdict APPROVE` |
| request changes | `review-findings` |
| human | `human` |

The applier calls the protocol in-process or through an equivalent
authority-preserving adapter. It must not reproduce the protocol's mutation
logic in a marketplace-specific bridge.

The local coordinator may continue invoking `autopilot session ...` directly
in V1. Both backends therefore share lifecycle behavior and mutation code,
even though their result-delivery topology differs. Refactoring local
execution to return `SessionResult` is optional future cleanup.

## 6. Marketplace Task contract

### 6.1 Solver type

V1 remains in the `jinn-repo.v1` family so retrospective repository work and
live Autopilot work retain corpus continuity. The live-issue variant gains a
required Autopilot session capsule rather than creating a parallel repository
solver type.

### 6.2 Session capsule

The Task contains:

```text
schemaVersion: jinn-autopilot-session.v1
workflow: implement | fix-child | reconcile | ci-failure
repository
issueNumber
childIssueNumber?
parentPrNumber?
prNumber
targetBase
branch
claimOid
expectedHead
v2AttemptId
runnerId
taskSnapshot
workflowContract
deadline
receiptAuthors
```

`taskSnapshot` contains the immutable problem statement and relevant GitHub
context. `workflowContract` binds the canonical skill and result-schema
versions. `receiptAuthors` is the closed-fleet allowlist of GitHub identities
whose adoption markers the official client accepts.

The Task never contains:

- a GitHub credential;
- a V2 manifest;
- a Git/SSH credential helper;
- authority to select a different branch or PR;
- authority to change lifecycle state; or
- an instruction to publish.

### 6.3 Correlation

The following tuple uniquely binds a delivery to a V2 attempt:

```text
taskId
attemptIndex
requestId
deliveryEnvelopeCid
v2AttemptId
claimOid
expectedHead
prNumber
```

Every Task, result, receipt, attempt manifest, PR marker, and evaluator input
must carry or derive this tuple. Issue number or substring matching is never
sufficient provenance.

## 7. Remote attempt representation

The current attempt representation assumes a local child PID and worktree.
V1 generalizes execution metadata:

```text
backend: local
  pid
  worktree
  log

backend: marketplace
  taskId
  attemptIndex
  requestId
  taskCid
  deadline
  deliveryTx?
  deliveryEnvelopeCid?
  adoptionReceipt?
```

The V2 attempt still owns a host-side detached worktree. The marketplace
operator never sees that worktree; the host uses it to validate and
materialize the returned artifact before invoking the session protocol.

Marketplace fields are operational recovery data. Branch, PR, review-ref, and
native-review facts remain authoritative.

V1 does not add remote heartbeats to the lifecycle. The marketplace
submission deadline must be strictly shorter than the V2 stale-attempt
threshold, leaving enough margin for adoption and Router settlement. A
non-delivered Task therefore expires before V2 is eligible to reap the claim.

## 8. Two-phase delivery and adoption

### 8.1 Existing boundary

The harness engine already performs:

1. `deliverToMarketplace(requestId, deliveryDigest)`;
2. persist the delivery transaction for crash recovery; and
3. `claimSolutionDelivery` or `claimVerdictDelivery`.

V1 inserts an adoption wait after step 2.

### 8.2 Client state

For this SolverNet, the client transitions:

```text
PACKAGING
  -> DELIVERING
  -> AWAITING_ADOPTION
  -> CLAIMING_DELIVERY
  -> COMPLETE
```

`AWAITING_ADOPTION` persists:

- request ID;
- Task and attempt;
- role (`solution` or `verdict`);
- delivery transaction;
- envelope CID and digest;
- expected receipt location and authors;
- first-wait timestamp; and
- last observation/error.

Recovery from `AWAITING_ADOPTION` never repeats Mech delivery. It polls the
receipt, validates it, and resumes at the Router claim.

### 8.3 Solution ordering

The implementation path is:

```text
V2 wins branch claim and opens draft PR
  -> Autopilot creates marketplace Task
  -> solver claims and executes
  -> solver Mech-delivers SessionResult
  -> client pauses
  -> Autopilot adopts the result into the claimed branch
  -> Autopilot completes the implementation/child transition
  -> Autopilot wins the exact-head review claim
  -> Autopilot writes accepted adoption receipt
  -> solver validates receipt
  -> solver calls claimSolutionDelivery
  -> TaskSubmitted makes evaluation discoverable
```

Acquiring the review claim before the accepted receipt is mandatory. The
receipt binds its review generation and review-ref OID. Known Human/CODEOWNER
surfaces are excluded from ordinary V1 canaries. If the adopted diff
unexpectedly reaches a Human/CODEOWNER boundary, the evaluator may still
perform non-authoritative review and return `human`; Autopilot applies the
Human overlay, and the marketplace records an `Unresolved` Verdict rather
than withholding settlement for already-adopted implementation work.

### 8.4 Verdict ordering

The review path is:

```text
evaluator discovers submitted Solution
  -> evaluator validates adoption receipt and exact review claim
  -> evaluator reviews full exact PR head
  -> evaluator Mech-delivers review result
  -> client pauses
  -> Autopilot validates the still-current review generation/head
  -> Autopilot invokes review-verdict, review-findings, or human
  -> GitHub native review/child/Human state is read back
  -> Autopilot writes accepted adoption receipt
  -> evaluator validates receipt
  -> evaluator calls claimVerdictDelivery
  -> TaskCoordinator records Verdict/finalizes attempt
```

The GitHub mutation occurs before marketplace settlement. A crash after the
mutation but before the receipt is recovered through the exact-head V2
markers and idempotent protocol readbacks.

## 9. GitHub adoption receipts

### 9.1 V1 choice

V1 uses GitHub-native receipt comments on the Task's PR. This avoids a new
database, HTTP control plane, or receipt registry and keeps recovery anchored
to V2's existing authority surface.

The official client accepts a receipt only when:

- it is on the exact Task PR;
- its author is in `receiptAuthors`;
- its marker binds the exact request and delivery envelope;
- its JSON passes the strict schema;
- its V2 attempt, Task, claim, and head fields match;
- an accepted receipt's asserted GitHub outcome is observable; and
- no contradictory accepted/rejected receipt exists.

Contradiction is fail-closed and requires Human intervention.

### 9.2 Marker

One comment exists per `(requestId, deliveryEnvelopeCid)`:

````text
<!-- jinn-autopilot:marketplace-adoption:v1
request=<request-id> envelope=<cid> -->

```json
{
  "schemaVersion": "jinn-autopilot-marketplace-adoption.v1",
  "disposition": "accepted",
  "role": "solution",
  "operation": "implementation-complete",
  "taskId": "123",
  "attemptIndex": 0,
  "requestId": "0x...",
  "deliveryEnvelopeCid": "bafy...",
  "v2AttemptId": "...",
  "prNumber": 1234,
  "claimOid": "...",
  "expectedHead": "...",
  "resultingHead": "...",
  "reviewGeneration": "...",
  "reviewRefOid": "...",
  "recordedAt": "..."
}
```
````

The actual schema is a discriminated union:

- accepted Solution receipt;
- rejected Solution receipt;
- accepted Verdict receipt; and
- rejected Verdict receipt.

Rejected receipts carry a stable reason code and sanitized detail. They never
authorize a Router claim through the official client.

### 9.3 Idempotency

Autopilot searches by the exact marker, not by "last comment." It:

- returns an existing matching accepted receipt;
- returns an existing matching rejected receipt;
- reconstructs and writes an accepted receipt when the V2 mutation already
  completed;
- updates no unrelated comment; and
- escalates contradictory duplicates.

The receipt is evidence of adoption, not an additional V2 lifecycle state.
No Autopilot scheduling decision depends on the comment alone; the asserted
branch, PR, review-ref, child, and native-review facts must agree.

## 10. Adoption coordinator

### 10.1 Discovery

The V2 marketplace backend discovers pre-settlement Mech deliveries, not only
`SolutionDeliveryClaimed`/`VerdictDelivered` events. Discovery must:

- map the request ID to the locally recorded V2 attempt;
- retrieve the exact delivered envelope CID;
- verify the TaskCreated and request provenance;
- verify operator role and SolverNet manifest;
- reject unrelated `jinn-repo.v1` envelopes; and
- keep a durable, idempotent observation cursor.

The legacy reader's latest-N, timestamp-only in-memory cursor is insufficient.

### 10.2 Mutation-result adoption

For a mutation result, the coordinator:

1. validates the envelope and full correlation tuple;
2. reads the current V2 claim, branch, PR, child, and Human facts;
3. rejects stale or contradictory authority before touching the worktree;
4. creates or recovers the host attempt worktree at `expectedHead`;
5. writes the patch to an attempt-private, non-symlink file;
6. runs `git apply --check` without `--3way`;
7. applies the patch and validates the resulting tree;
8. runs policy-scoped repository verification;
9. creates the host commit with marketplace evidence trailers;
10. invokes `checkpoint`;
11. invokes `implementation-complete` or `child-complete`;
12. waits for exact GitHub readback;
13. acquires the new exact-head review claim;
14. writes the accepted receipt; and
15. records the receipt in the operational attempt manifest.

The host commit carries:

```text
jinn-marketplace-task: <task-id>
jinn-marketplace-request: <request-id>
jinn-marketplace-envelope: <cid>
jinn-autopilot-attempt: <attempt-id>
```

An empty or non-applying patch is rejected unless the workflow contract
explicitly permits a no-code Human/escalation outcome.

### 10.3 Review-result adoption

For an evaluator result, the coordinator:

1. validates the Verdict envelope and correlation tuple;
2. confirms evaluator differs from the Solution operator;
3. confirms the review ref is active for the supplied generation and head;
4. confirms the current PR head is exactly `reviewedHead`;
5. confirms the evaluator reviewed the full effective PR diff;
6. parses the strict review-result payload;
7. calls `review-verdict APPROVE`, `review-findings`, or `human`;
8. reads back the native review, child/follow-ups, labels, review ref, and
   Human state;
9. writes the accepted receipt; and
10. records it in the operational attempt manifest.

The marketplace evaluator never chooses GitHub issue metadata directly.
For request changes it supplies blocking findings. Autopilot constructs and
files the idempotent `review-finding` child through the existing protocol. For
approve it may supply the existing bounded follow-up payload, which Autopilot
validates and files.

## 11. Review semantics

### 11.1 Separate execution, same Task

Review is a separate evaluator execution, not a continuation of the
implementation solver and not normally a separate top-level TaskCoordinator
Task. The evaluator still receives the existing evaluation request and
evaluation Task document for the same Task attempt.

The Solution and Verdict legs map to V2 as:

```text
solver Solution -> adopted mutation result
evaluator Verdict -> adopted exact-head PR review
```

### 11.2 Solution-anchored, exact-head scoped

The marketplace evaluation has two distinct bindings:

```text
trigger:
  taskId
  attemptIndex
  solutionRequestId
  solutionEnvelopeCid
  solutionAdoptionReceipt

review target:
  prNumber
  targetBase
  reviewedHead
  reviewGeneration
  reviewRefOid
  full effective PR diff
```

The first binding coordinates and pays for the evaluation. The second defines
its semantic scope.

The evaluator always reviews the complete cumulative PR at `reviewedHead`.
It never limits judgment to the latest Solution patch. A fix-child Solution
may therefore trigger an approval of a head containing the original
implementation plus every adopted fix.

Marketplace Verdict codes map to the adopted V2 outcome:

| Adopted V2 outcome | Marketplace Verdict |
|---|---|
| `APPROVE` | `Pass` |
| `REQUEST_CHANGES` with a finding child | `Fail` |
| Human/CODEOWNER escalation | `Unresolved` |

The marketplace code records loop completion; the native exact-head review
and unchanged CI/Human/merge gates remain the repository's quality authority.

Example:

```text
Implementation Task A
  Solution A -> full review of H1 -> REQUEST_CHANGES

Fix-child Task B
  Solution B -> full review of H2 (A + B) -> APPROVE
```

Verdict B is economically attached to Solution B and semantically attests to
all of H2.

### 11.3 Reviewable head, not every head change

The invariant is:

> Every reviewable PR head receives one full review. The evaluator leg is
> anchored to the adopted marketplace Task that produced that reviewable
> head.

Autopilot releases review only when:

- the mutation result is fully adopted;
- the PR is non-draft and carries its completion evidence;
- no review-finding, reconcile, or CI-failure child remains open;
- no Human overlay blocks automation;
- the exact head has no valid terminal verdict; and
- the exact-head review claim has been acquired.

Current V2 files one aggregated review-finding child per review round, so V1
has one head-producing marketplace Task between semantic reviews. If a future
lifecycle allows multiple concurrently adopted children before one review,
Autopilot must designate the final reviewable head and its anchor Task rather
than start one semantic evaluator per intermediate Solution.

### 11.4 Deterministic and semantic checks

The evaluator runs deterministic gates first:

- receipt and exact-head validation;
- patch/result identity;
- typecheck and policy-scoped tests; and
- prohibited-path/policy checks.

It then performs the `review-pr` semantic workflow against the full PR. A
deterministic failure may yield `REQUEST_CHANGES`; a clean deterministic pass
does not imply semantic approval.

## 12. Failure and recovery

### 12.1 General rules

- Every operation is idempotent on exact identifiers.
- No retry weakens expected-head checks.
- No patch is silently rebased or three-way applied.
- Marketplace failure never authorizes local-agent fallback.
- GitHub readback, not command success, proves mutation.
- A stale result is never applied to a newer head.
- A hard contradiction enters Human.

### 12.2 Failure matrix

| Failure | Required behavior |
|---|---|
| Solver expires before Mech delivery | Task expires; V2 reaps after its longer stale threshold |
| Client crashes before Mech delivery | normal marketplace recovery |
| Client crashes after Mech delivery | recover `AWAITING_ADOPTION`; do not redeliver |
| Autopilot unavailable | client keeps polling; Router claim remains uncalled |
| Envelope malformed or unrelated | rejected receipt; no worktree/GitHub mutation |
| Claim/head changed before adoption | rejected as stale; no patch application |
| Patch fails `git apply --check` | rejected; no `--3way` |
| Verification fails | rejected or Human according to workflow policy |
| Autopilot crashes before publication | recover attempt; retry adoption |
| Autopilot crashes after publication | reconstruct from Git/PR markers; write receipt |
| Receipt write is ambiguous | read exact marker and GitHub facts; retry or Human |
| Solver crashes after accepted receipt | existing delivery recovery claims Solution |
| Evaluation claimed from wrong generation | evaluator rejects before work |
| PR head moves during evaluation | Verdict adoption rejects as stale |
| Review mutation lands, receipt does not | reconstruct native review/child/ref; write receipt |
| Evaluator crashes after receipt | existing delivery recovery claims Verdict |
| Duplicate envelope observation | return the existing receipt |
| Conflicting receipts | Human; official client claims neither |

### 12.3 Rejection and retry

A rejected delivery is not recorded as a Solution or Verdict by the official
client. Stable reason codes include:

- `correlation-mismatch`;
- `untrusted-operator`;
- `stale-claim`;
- `stale-head`;
- `stale-review-generation`;
- `invalid-artifact`;
- `patch-does-not-apply`;
- `verification-failed`;
- `policy-human`;
- `receipt-contradiction`; and
- `internal-adoption-failure`.

Retryable infrastructure failures do not write rejection receipts. They leave
the client waiting and preserve the adoption attempt. Semantic or authority
failures write durable rejection.

## 13. Configuration and operation

### 13.1 Backend selection

V2 gains one process-wide setting:

```text
executionBackend: local | marketplace
```

This setting is orthogonal to the existing local runtime
`claude | hermes | cursor`.

In `marketplace` mode:

- no local agent coordinator is spawned;
- every agentic workflow uses the marketplace backend;
- deterministic V2 handlers remain local;
- unsupported workflow/result versions enter Human;
- loss of marketplace connectivity degrades capacity rather than selecting a
  local fallback; and
- the configured SolverNet, launcher, indexer/gateway, receipt authors, and
  deadlines must pass preflight before new work is claimed.

### 13.2 V1 fleet policy

V1 requires:

- closed solver and evaluator roles;
- official Jinn clients with adoption waiting enabled;
- `maxClaims=1`;
- solver self-evaluation disabled;
- one required semantic Verdict;
- Task deadline shorter than V2 staleness;
- public repository read access for receipt polling;
- automated-review-eligible PR surfaces; and
- an allowlisted set of host GitHub receipt authors.

### 13.3 Observability

Status and logs expose:

- V2 attempt and workflow;
- marketplace Task, attempt, and request;
- operator role and address;
- delivery, adoption-wait, receipt, and settlement timestamps;
- current expected/resulting head;
- rejection reason;
- elapsed solve, adoption, review, and settlement latency; and
- links to Task, Solution/Verdict envelope, adoption receipt, issue, and PR.

The operator should be able to answer "why is this PR waiting?" without
reading raw chain logs.

## 14. Trust boundary and open-fleet follow-up

The Router currently permits the attempt operator to call
`claimSolutionDelivery` after Mech delivery and the evaluator to call
`claimVerdictDelivery` after Verdict delivery. It does not require Autopilot
adoption.

V1 relies on:

- a closed SolverNet;
- official clients that enforce receipt validation; and
- evaluator harnesses that reject missing or contradictory receipts.

This is not sufficient for an open fleet. Before open participation, the
protocol must prevent bypass. The preferred direction is a launcher-signed
adoption authorization binding:

```text
role
taskId
attemptIndex
requestId
envelopeDigest
resultingHead
reviewGeneration?
expiry
```

The Router or a TaskCoordinator policy hook must verify that authorization
before recording the Solution or Verdict. GitHub authorship alone is not an
open-network cryptographic authority.

This follow-up is deliberately outside V1; adding it before the closed-fleet
vertical loop works would conflate protocol hardening with execution-quality
validation.

## 15. Validation

### 15.1 Unit and contract tests

Tests cover:

- strict Task, `SessionResult`, and receipt codecs;
- complete correlation binding;
- backend-neutral attempt decoding;
- receipt author and exact-marker validation;
- delivery pause/resume and crash recovery;
- mutation-result translation into every V2 session verb;
- exact-head and review-generation rejection;
- idempotent duplicate adoption;
- full-PR rather than patch-only review inputs;
- child/follow-up payload validation;
- deadline/staleness ordering; and
- no contract regression from the client-only V1 flow.

### 15.2 Backend conformance

Fixtures feed equivalent local and marketplace outcomes into the V2 protocol
and assert identical authoritative results:

- branch head and completion marker;
- PR summary, label, and draft state;
- review ref and native review;
- finding child or follow-up issues;
- Human marker; and
- derived lifecycle state.

The conformance claim is lifecycle equivalence, not identical internal
process topology.

### 15.3 End-to-end vertical loop

The acceptance canary proves:

1. V2 claims a Low-effort issue and opens its normal draft PR.
2. A marketplace Task is created from that exact attempt.
3. A solver delivers through Mech.
4. `TaskSubmitted` remains absent while adoption is pending.
5. Autopilot applies the patch to the existing branch and completes the PR.
6. Autopilot acquires the exact-head review claim and writes the receipt.
7. The solver records the Solution.
8. A distinct evaluator reviews the full exact head.
9. The evaluator requests changes.
10. Autopilot files one review-finding child and posts native
    `REQUEST_CHANGES`.
11. The evaluator records the Verdict.
12. V2 routes the child as a new marketplace Task on the parent branch.
13. Autopilot adopts the fix and closes the child.
14. A fresh evaluator reviews the complete new head and approves.
15. Native CI and merge gates take over unchanged.

### 15.4 Failure injection

The canary suite crashes or interrupts each boundary:

- before and after Mech delivery;
- before and after artifact application;
- before and after branch publication;
- before and after implementation completion;
- before and after review-claim acquisition;
- before and after receipt publication;
- before and after Solution Router claim;
- before and after native review/child filing; and
- before and after Verdict Router claim.

Every restart must converge without duplicate branches, PRs, children,
reviews, receipts, Solutions, or Verdicts.

### 15.5 Quality kill test

Before automatic routing broadens, at least five real Low-effort issues run
through the complete closed-fleet path. Record:

- accepted/adopted Solution rate;
- mergeable-quality rate;
- review finding rate and severity;
- child-loop convergence;
- solve, adoption, and review latency;
- model and infrastructure cost;
- CI and human rejection reasons; and
- maintainer corrections before merge.

Failure to produce mergeable work at acceptable cost stops rollout even when
all transport and settlement checks pass.

## 16. Delivery sequence

Implementation planning should decompose the work into independently
verifiable stages:

1. **Contracts and fixtures**
   - session capsule, result, receipt, and remote-attempt codecs;
   - golden fixtures for every workflow/result/disposition; and
   - backend conformance harness.
2. **Client adoption wait**
   - split Mech delivery from Router claim;
   - persist `AWAITING_ADOPTION`;
   - GitHub receipt discovery/validation; and
   - crash recovery.
3. **V2 marketplace backend**
   - backend selection and preflight;
   - Task creation/correlation;
   - remote attempt tracking; and
   - no-local-fallback behavior.
4. **Mutation adoption**
   - pre-settlement delivery discovery;
   - exact-attempt artifact validation;
   - existing-branch materialization;
   - session-protocol completion;
   - review-claim acquisition; and
   - Solution receipts.
5. **Semantic evaluator**
   - adoption-aware evaluation Task construction;
   - full-exact-head review harness;
   - typed approve/findings/Human output;
   - review-result adoption; and
   - Verdict receipts.
6. **Child coverage**
   - review-finding, reconcile, and CI-failure workflows;
   - parent-branch append-only adoption; and
   - fresh full-head re-review.
7. **Canary and soak**
   - complete request-changes loop;
   - failure injection;
   - five-issue quality kill test; and
   - bounded closed-fleet soak.

No stage routes ordinary issues before its predecessor's recovery and
idempotency checks pass.

## 17. Acceptance criteria

The design is implemented when:

1. `executionBackend=local` preserves current V2 behavior.
2. `executionBackend=marketplace` spawns no local agent session.
3. Every V2 agentic workflow has a marketplace representation.
4. Marketplace operators receive no GitHub credential or V2 manifest.
5. All GitHub mutations pass through existing V2 session/deterministic ports.
6. Mech-delivered Solutions remain unsubmitted until mutation adoption and
   exact-head review-claim acquisition succeed.
7. Mech-delivered Verdicts remain unsettled until their GitHub review outcome
   is applied and read back.
8. The evaluator differs from the solver and reviews the full exact PR head.
9. Every result and receipt is bound to the complete V2/marketplace
   correlation tuple.
10. Stale or contradictory results never mutate a newer head.
11. A request-changes child loop converges through fresh full-head approval.
12. Crash recovery creates no duplicate shared artifacts.
13. Existing CI, Human, CODEOWNER, and merge gates remain unchanged.
14. The five-issue closed-fleet quality gate passes before broader routing.
