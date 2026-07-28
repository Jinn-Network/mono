# Autopilot Mutation Delivery Binding Design

**Date:** 2026-07-28

**Status:** Approved for planning

**Scope:** Released `@jinn-network/sdk` and `@jinn-network/client` support for
`jinn-repo.v1` Autopilot mutation Solutions

## 1. Problem

The live Autopilot V2 marketplace canary submitted Task `1192` for an
`autopilot-session` variant of `jinn-repo.v1`. The released client successfully
claimed the Task, edited the repository, and delivered a Solution, but the
delivery observer rejected the result:

```text
invalid-result: outcome: Invalid discriminator value.
Expected 'mutation-complete' | 'human'
```

The learner harvester always materializes a legacy payload:

```json
{
  "schemaVersion": "jinn-repo-solution.v1",
  "patch": "<git diff>"
}
```

That shape is valid for retrospective and ordinary live-issue `jinn-repo.v1`
Tasks, but an Autopilot session's `workflowContract.resultSchema` requires
`jinn-autopilot-mutation-result.v1`.

The existing strict mutation-result correlation also requires
`deliveryEnvelopeCid`. A producer cannot know that CID while constructing the
payload because the payload is itself an input to the content-addressed
envelope. Requiring the CID in the pre-envelope payload is a cryptographic
self-reference. The session-backend design permits correlation fields to be
carried **or derived**, so the envelope boundary must derive this one field.

## 2. Goals

1. Emit `jinn-autopilot-mutation-result.v1` for `jinn-repo.v1` Tasks whose
   source is `autopilot-session`.
2. Bind every producer-known correlation field before envelope assembly.
3. Derive `deliveryEnvelopeCid` from the signed envelope and validate the full
   strict correlation before exposing a verified delivery.
4. Preserve legacy `jinn-repo-solution.v1` behavior for non-Autopilot Tasks.
5. Keep adoption receipts and evaluator inputs strictly bound to the complete
   post-envelope correlation.
6. Make crash recovery deterministic and preserve the public
   SDK/client/CLI boundary used by Autopilot.

## 3. Non-goals

- Changing Autopilot's adoption protocol or GitHub authority model.
- Adding another marketplace Task for evaluator execution.
- Weakening accepted receipt schemas or making receipt correlation optional.
- Repairing or rewriting the immutable invalid delivery from Task `1192`.
- Implementing Verdict adoption, child-result adoption, or merge behavior.
- Changing ordinary retrospective `jinn-repo.v1` payloads.

## 4. Chosen boundary

Use two related schemas:

1. **Pre-envelope mutation delivery payload**
   (`JinnRepoAutopilotSolutionPayloadSchema`): requires every
   `AutopilotCorrelation` field except `deliveryEnvelopeCid`.
2. **Verified mutation result** (`AutopilotMutationResultSchema`): retains the
   current strict, complete correlation including `deliveryEnvelopeCid`.

The pre-envelope schema is accepted only as the `jinn-repo.v1` Solution payload
inside an execution envelope. It is not a receipt schema and is not the shape
returned by `jinn tasks observe-autopilot-delivery`.

After retrieving and authenticating the envelope, consumers construct:

```text
complete correlation =
  payload correlation
  + authenticated envelope CID
```

They then parse the result with the existing strict
`AutopilotMutationResultSchema`. The producer-side correlation is strict and
does not accept an envelope-CID field; the authenticated envelope is the only
source for that value.

This keeps the producer contract possible while preserving strict correlation
at every authority-bearing consumer boundary.

## 5. Components

### 5.1 SDK schema

Add a producer-side mutation result schema whose correlation has:

- required `taskId`;
- required `attemptIndex`;
- required `requestId`;
- required `v2AttemptId`;
- required `claimOid`;
- required `prNumber`;
- required `expectedHead`;
- optional post-mutation/review extension fields as today; and
- no producer-authored `deliveryEnvelopeCid`.

Export it through the `jinn-repo` SolverNet surface and use it for
`JinnRepoAutopilotSolutionPayloadSchema`. Leave
`AutopilotMutationResultSchema`, `AutopilotCorrelationSchema`, and all adoption
receipt schemas strict and unchanged.

### 5.2 Harness execution context

The engine already knows the authoritative on-chain `taskId`, `attemptIndex`,
and `requestId`, but the learner harvester currently receives only the signed
Task body. Add these attempt identifiers to `HarnessContext` and populate them
from the persisted `task_runs` row. They are runtime context only and must not
mutate or re-hash the signed Task.

### 5.3 Learner and Hermes harvest

When all of the following hold:

- Solver type is `jinn-repo.v1`;
- role is restoration;
- Task spec parses as `JinnRepoAutopilotSessionTaskSchema`; and
- the worktree has a non-empty, policy-filtered patch,

materialize:

```json
{
  "schemaVersion": "jinn-autopilot-mutation-result.v1",
  "outcome": "mutation-complete",
  "correlation": {
    "taskId": "<on-chain Task id>",
    "attemptIndex": 0,
    "requestId": "0x...",
    "v2AttemptId": "<session value>",
    "claimOid": "<session value>",
    "prNumber": 2255,
    "expectedHead": "<session value>"
  },
  "patch": "<policy-filtered git diff>",
  "summary": "<bounded completion summary>",
  "evidence": {
    "commands": [],
    "tests": [],
    "notes": ["Patch harvested from the completed repository worktree."]
  }
}
```

The summary is deterministic and bounded. Evidence may use verified learner
artifacts when available, but empty command/test arrays are valid and must not
be populated with claims the daemon did not observe.

If attempt identifiers are missing for an Autopilot session, harvesting fails
closed instead of falling back to the legacy schema.

### 5.4 Envelope and observer

Envelope assembly validates the producer-side payload schema.

The marketplace delivery observer:

1. authenticates the discovered envelope and delivery provenance;
2. parses the producer-side mutation payload;
3. injects the authenticated envelope CID into correlation;
4. parses the enriched result with `AutopilotMutationResultSchema`; and
5. compares the complete correlation against the expected Task/session tuple.

Only the enriched strict result is returned by
`jinn tasks observe-autopilot-delivery`.

### 5.5 Receipt and evaluator consumers

The GitHub adoption-receipt observer and evaluator-context resolver perform the
same enrichment from their already authenticated Solution envelope before
using the result.

Persisted engine output may contain the producer-side correlation. Whenever the
engine compares it with an adoption receipt, it enriches it from the persisted
`manifestCid` first. Accepted receipts remain strict and complete.

## 6. Data flow

```text
Autopilot Task request
  -> daemon claims Task and records taskId / attemptIndex / requestId
  -> harness receives immutable Task + runtime attempt identity
  -> learner edits isolated repository
  -> harvester emits producer-side mutation result without envelope CID
  -> engine validates payload and signs content-addressed envelope
  -> envelope CID becomes authoritative
  -> observer authenticates envelope and injects its CID into correlation
  -> strict mutation result validation
  -> Autopilot verifies/applies/commits/completes the mutation
  -> Autopilot publishes strict accepted receipt
  -> daemon enriches persisted result from manifest CID
  -> daemon validates receipt and may claim the Solution
```

## 7. Failure and recovery behavior

- Missing runtime attempt identity: fail packaging before delivery.
- Invalid session capsule: retain normal `jinn-repo.v1` handling only when the
  Task is genuinely non-Autopilot; a declared `source: autopilot-session`
  that fails parsing is an error.
- Payload/session correlation mismatch: fail packaging or return
  `correlation-mismatch`.
- Envelope-CID mismatch: return a contradiction and never authorize adoption.
- Crash after packaging: reuse persisted payload, generated timestamp, and
  manifest CID as today.
- Crash during adoption wait: enrich from the persisted manifest CID and
  continue receipt polling.
- Invalid legacy delivery from Task `1192`: retain as immutable failure
  evidence; validate the fix with a fresh disposable canary Task.

## 8. Testing

### SDK

- Producer payload accepts complete producer-known correlation without
  `deliveryEnvelopeCid`.
- Strict observed mutation result still requires `deliveryEnvelopeCid`.
- Receipt schemas still reject missing envelope correlation.
- Legacy `jinn-repo-solution.v1` remains accepted.

### Harness and engine

- Autopilot session worktree diff becomes a mutation-complete payload.
- Ordinary jinn-repo worktree diff remains a legacy payload.
- Autopilot harvesting fails closed when task/attempt/request identity is
  unavailable.
- Engine populates runtime attempt identity in both learner and Hermes paths.
- Persisted correlation enrichment uses the exact persisted manifest CID.

### Delivery consumers

- Delivery observer enriches the producer payload and returns a strict verified
  result.
- Receipt observer and evaluator resolver accept the derived exact CID.
- Wrong task, request, attempt, V2 attempt, claim, PR, or expected head remains
  rejected.

### Live canary

After unit and integration suites pass:

1. build the client from the isolated worktree;
2. restart the existing operator daemon with the same canonical
   `jinn-repo.v1` SolverNet membership;
3. create one fresh disposable Low-effort documentation issue;
4. run standalone Autopilot with a one-issue allowlist and caps of one;
5. require delivery observation, Docker verification, patch adoption,
   implementation completion, exact-head evaluator claim, accepted receipt,
   and daemon Solution claimability;
6. stop before Verdict adoption.

## 9. Alternatives rejected

### Make `deliveryEnvelopeCid` optional everywhere

This is smaller mechanically but weakens receipts and other authority-bearing
correlation. It blurs producer-time and post-envelope facts.

### Manually rewrite daemon persistence and replay Task `1192`

This uses internal mutable state, risks duplicate on-chain delivery, and
violates the public-boundary canary. The failed Task remains useful evidence;
a fresh Task validates the corrected released-client behavior.

### Have the producer predict its envelope CID

A content-addressed envelope cannot contain its own CID without an impossible
cryptographic fixed point. This is not a viable protocol.

## 10. Acceptance criteria

- Autopilot-session jinn-repo mutation Tasks deliver the typed mutation result,
  not the legacy patch-only result.
- The producer payload contains all correlation available before signing.
- `deliveryEnvelopeCid` is derived exclusively from authenticated envelope
  provenance.
- Verified observations, receipts, and evaluator inputs retain full strict
  correlation.
- Non-Autopilot jinn-repo behavior is unchanged.
- Automated tests cover the producer/consumer boundary and fail-closed cases.
- One fresh marketplace canary reaches accepted Solution adoption receipt and
  exact-head evaluator readiness without a second evaluator Task.

## 11. Live-canary finding: complete worktree patch derivation

The first fresh canary after the binding change created one new Markdown file.
That file remained untracked, as expected for solver worktree output. The
Autopilot harvester correctly refused to trust the agent-authored typed payload
for runtime correlation, but its authoritative `git diff --binary` omitted the
untracked file. With no authoritative typed payload, learner phase telemetry
became mandatory and an independent agent deviation
(`.improve/promoter_summary.json` instead of `.improve/summary.json`) failed
packaging before any Solution envelope existed.

Declared `autopilot-session` tasks therefore need a complete worktree patch,
not only a tracked-file diff. Their harvester will:

1. create a temporary index outside the repository's real index;
2. initialize it from `HEAD` with `git read-tree HEAD`;
3. add the complete worktree with `git add -A --` under the temporary
   `GIT_INDEX_FILE`;
4. derive one `git diff --cached --binary HEAD --` patch from that index;
5. remove the temporary index in `finally`, on success or failure.

This preserves the current trust boundary: correlation still comes from the
daemon's persisted Task/attempt identity and the patch still comes from the
daemon-observed checkout. It captures tracked edits, deletions, and untracked
additions, respects Git ignore rules, and never mutates the real index or
worktree. Existing prohibited-test-path stripping and downstream mutation
policy validation remain unchanged.

The complete-worktree path is scoped only to a successfully parsed declared
`autopilot-session`. Ordinary and legacy `jinn-repo.v1` tasks retain their
existing tracked `git diff --binary` behavior.

The regression test creates an untracked file in an Autopilot checkout and
requires a `jinn-autopilot-mutation-result.v1` payload with
`outcome: mutation-complete`, exact runtime correlation, and a patch containing
that file. It also snapshots the real Git index before harvest and proves its
bytes and status are unchanged afterward. Existing tracked-diff,
missing-identity, legacy, engine, and Hermes coverage must remain green.

## 12. Live-canary finding: learner task-workspace boundary

The next live Task (`1195`) exposed a separate path-routing defect. The runtime
correctly provisioned the authoritative repository at
`<workingDir>/repo`, and the trusted harvester correctly inspected that
checkout. The learner's planner and step workers instead received only the
episode `workingDir`. Their generic instructions said that every expected
output was under `workingDir`, so a relative task path such as
`client/docs/marketplace-canary-….md` was resolved against the episode root.
The requested file was created outside the repository, the authoritative
checkout stayed clean, and packaging had no mutation payload to deliver.

The approved boundary introduces an optional absolute `taskWorkspaceDir` in
the learner session contract:

- for repository-shaped `jinn-repo.v1` restoration tasks,
  `taskWorkspaceDir = join(workingDir, "repo")`;
- repository inspection, mutation, and verification must use
  `taskWorkspaceDir`;
- learner telemetry remains rooted at the episode `workingDir`, including
  `.coordinator`, `.orient`, `.strategize`, `.plan`, `.execute`, `.debrief`,
  `.improve`, and `.memory-consolidation`;
- `implStateDir` remains the separate persistent learning-state root; and
- non-repository tasks leave `taskWorkspaceDir` absent and retain their current
  behavior.

The harness threads this value into both supported learner launch surfaces.
Claude Code and Codex keep their process current working directory at the
episode `workingDir`; changing process cwd would be unsafe because repository
provisioning may occur in a runtime SessionStart hook and because the telemetry
contract is intentionally episode-rooted. The initial prompt names both roots
and their responsibilities. The learner uniform dispatch then passes the
absolute `taskWorkspaceDir` to the coordinator's planner and every step worker.
Planner output must use absolute task paths beneath that root, and step workers
must reject or report task mutations routed elsewhere.

This is a shared harness boundary, not SolverNet-specific solving guidance. The
runtime task skill remains authoritative for repository semantics and payload
shape, but correctness no longer depends on that skill being selected before
the learner hook's mandatory `learn` invocation. It also no longer depends on a
task description redundantly mentioning `workingDir/repo`.

### 12.1 Regression coverage

Tests must prove:

1. `LearnerHarness` sets the exact absolute repository workspace for a
   `jinn-repo.v1` restoration task and leaves it absent for a non-repository
   task.
2. Both Claude Code and Codex initial prompts expose the episode root and task
   workspace as distinct values while retaining episode-root process cwd.
3. The learner planner and step-worker contracts receive
   `taskWorkspaceDir`, route the Task `1195`-shaped relative
   `client/docs/…` mutation into `<workingDir>/repo/client/docs/…`, and keep
   phase artifacts under `<workingDir>/.<phase>/`.
4. Existing non-repository adapter and learner behavior remains unchanged.

### 12.2 Rejected alternatives

Changing the agent process cwd to `<workingDir>/repo` is insufficient and can
run before the runtime hook materializes the checkout. It also blurs the
episode telemetry boundary.

Strengthening only the repository runtime skill or its SessionStart steer is
also insufficient. The learner hook requires `learn` as the first action, and
fresh planner/worker subagents receive the learner role prompts directly.
Workspace correctness must therefore be explicit in the shared session and
dispatch contracts.
