# Exact Failed-Adoption Recovery Implementation Plan

> Execute test-first. Do not mutate the live Task `1197` row until the exact
> reviewed build is the sole running daemon and Autopilot recover-only has
> posted an authenticated accepted receipt.

**Goal:** Correct Autopilot adoption identity validation and provide one
explicit, exact-request, compare-and-swap recovery from the known false
contradiction to `AWAITING_ADOPTION`, without repeating any delivery work.

**Design:** The GitHub observer keeps numeric protocol correlation
(`run.taskId`) separate from semantic runtime identity
(`run.task.id === spec.instance_id`). A pure recovery validator reuses the
observer's durable expectation derivation, adds terminal/delivery guard checks,
and delegates one exhaustive CAS update to `TaskRunPersistence`. A standalone
operator command exposes required `--dry-run` or `--apply` modes for one exact
request ID.

**Runtime:** TypeScript, Vitest, better-sqlite3, existing Jinn CLI framework.

---

## Task 1: Correct the observer identity contract

**Files:**

- Modify: `client/test/autopilot/github-adoption-receipt-observer.test.ts`
- Modify: `client/src/autopilot/github-adoption-receipt-observer.ts`

### Step 1: Add production-shaped failing coverage

Change the persisted-run fixture so the protocol and semantic identifiers are
independent:

```ts
taskId: correlation.taskId, // numeric on-chain ID
task: {
  id: `autopilot:${session.v2AttemptId}`,
  role,
  spec: {
    instance_id: `autopilot:${session.v2AttemptId}`,
    session,
    // existing strict fields
  },
},
```

Add assertions that:

- a production-shaped restoration row reaches the GitHub port and returns
  `pending` when no receipt exists;
- changing only `task.id` away from `spec.instance_id` returns the existing
  structured contradiction without a GitHub call;
- changing `spec.instance_id` away from
  `autopilot:<session.v2AttemptId>` also fails closed.

### Step 2: Run RED

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/autopilot/github-adoption-receipt-observer.test.ts
```

Expected: the production-shaped row returns
`persisted runtime Task identity or role is contradictory` before GitHub.

### Step 3: Implement the semantic identity check

Export the pure durable expectation derivation for recovery reuse. Parse the
strict Autopilot spec before identity comparison, then require:

```ts
runtimeTask.id === task.instance_id
task.instance_id === `autopilot:${task.session.v2AttemptId}`
runtimeTask.role === run.taskRole
```

Keep delivered correlation unchanged:

```ts
correlation.taskId === run.taskId
```

### Step 4: Run GREEN and commit

Run the Step 2 command, `yarn --cwd client typecheck`, and
`git diff --check`. Commit only the observer and its test:

```bash
git commit -m "fix(client): distinguish Autopilot task identities"
```

---

## Task 2: Specify the exact recovery API with failing tests

**Files:**

- Create: `client/test/harnesses/engine/failed-adoption-recovery.test.ts`
- Create: `client/test/cli/commands/recover-failed-adoption.test.ts`
- Modify: `client/test/harnesses/engine/adoption-delivery.test.ts`

### Step 1: Build a production-shaped failed-row fixture

Use an in-memory `Store` and `TaskRunPersistence`. Persist all Task `1197`
shapes without copying its live row:

- numeric `taskId`;
- semantic runtime/spec instance ID;
- strict Autopilot session;
- delivered producer output correlated to the numeric ID;
- manifest CID, delivery transaction, digest, evidence hash;
- exact failure reason and structured contradictory observation;
- no accepted receipt.

### Step 2: Add API behavior tests

Specify:

- dry-run returns `eligible` and leaves every column byte-identical;
- apply changes only the documented state/failure/scheduling columns;
- apply retains delivery evidence, output, task payload, receipt policy,
  observation, and attempt count;
- a second apply refuses because the row is no longer `FAILED`;
- a stale validated snapshot loses the CAS;
- table-driven single-field mutations refuse every eligibility guard,
  including failure text, observation, receipt, task/role/solver identities,
  strict instance/session binding, receipt policy, output correlation, and
  each delivery evidence/timestamp field.

### Step 3: Add command behavior tests

Specify:

- `--request-id` is required and must be one exact 32-byte request ID;
- exactly one of `--dry-run` and `--apply` is required;
- dry-run and apply forward the exact request and selected mode;
- JSON output distinguishes `eligible`, `recovered`, and `refused`;
- a refusal exits non-zero and does not fall through to an unguarded write.

### Step 4: Add the no-reexecution engine regression

Recover a fixture to `AWAITING_ADOPTION`, run normal in-flight recovery with a
pending receipt observer, and assert that only observation runs. Execution,
snapshot, packaging, and delivery ports must remain untouched.

### Step 5: Run RED

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/harnesses/engine/failed-adoption-recovery.test.ts \
  test/cli/commands/recover-failed-adoption.test.ts \
  test/harnesses/engine/adoption-delivery.test.ts
```

Expected: recovery modules/API/command are absent and the new expectations
cannot pass.

---

## Task 3: Implement the guarded recovery API

**Files:**

- Create: `client/src/harnesses/engine/failed-adoption-recovery.ts`
- Modify: `client/src/harnesses/engine/persistence.ts`
- Modify: tests from Task 2

### Step 1: Implement pure eligibility validation

Validate the exact request, terminal failure signature, exact structured
observation, absent accepted receipt, strict durable expectation, semantic ID
bindings, numeric correlation, and required delivery/timestamp formats.

Return a structured refusal; never throw for an ineligible row.

### Step 2: Implement the exhaustive CAS

Add one dedicated persistence method that takes the validated immutable
snapshot. Its `UPDATE ... WHERE` repeats every recovery-critical value,
including the exact JSON payload/output/observation and delivery evidence.

The `SET` clause may only:

```text
state = AWAITING_ADOPTION
state_updated_at = now
failure_reason = NULL
failure_at = NULL
adoption_last_error = NULL
adoption_next_observation_at = now
```

Return zero changes as a concurrent-change refusal.

### Step 3: Implement dry-run/apply orchestration

Dry-run stops after validation. Apply runs the CAS once and reports the exact
before/after state. Neither mode touches chain, GitHub, wallet, worktree, or
delivery APIs.

### Step 4: Run API GREEN

Run the focused engine recovery and adoption-delivery tests. Inspect the
before/after row diff in the tests and run `git diff --check`.

---

## Task 4: Implement the explicit operator command

**Files:**

- Create: `client/src/cli/commands/recover-failed-adoption.ts`
- Modify: `client/src/cli/index.ts`
- Modify: `client/test/cli/commands/recover-failed-adoption.test.ts`
- Modify only generated/help fixtures required by the registered verb

### Step 1: Parse exact mutually exclusive authority

Require:

```text
--request-id 0x<64 hex>
--dry-run | --apply
```

Use the existing config only to resolve the local DB path. Do not initialize
chain, GitHub, wallet, or daemon dependencies.

### Step 2: Emit bounded machine and human results

Report request ID, mode, prior state, result, and a bounded refusal reason.
Never serialize the Task payload, output, secrets, or credentials.

### Step 3: Run command GREEN and register the verb

Run the Task 2 command, then the CLI help/conformance tests selected by the
command registry change.

### Step 4: Commit the recovery implementation

Stage only the recovery API, persistence, command, registration, and tests:

```bash
git commit -m "fix(client): recover exact failed adoption"
```

---

## Task 5: Verify and review the exact code

### Step 1: Focused verification

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/autopilot/github-adoption-receipt-observer.test.ts \
  test/harnesses/engine/failed-adoption-recovery.test.ts \
  test/cli/commands/recover-failed-adoption.test.ts \
  test/harnesses/engine/adoption-delivery.test.ts \
  test/harnesses/engine/persistence.test.ts
```

### Step 2: Complete verification

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client typecheck
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client test
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client build
```

Record exact counts and any isolated rerun of a demonstrably unrelated flaky
test. Do not describe the full suite as wholly green if it was not.

### Step 3: Self-review

```bash
git diff --check origin/next...HEAD
git status --short
git diff --stat fb6947cb610a961d4e21a006ed6c00a354778ecc...HEAD
git diff fb6947cb610a961d4e21a006ed6c00a354778ecc...HEAD -- \
  client/src/autopilot \
  client/src/harnesses/engine \
  client/src/cli \
  client/test
```

Confirm no broad FAILED transition, scan, automatic migration, manual SQL,
reexecution, redelivery, or unrelated behavior entered the diff.

### Step 4: Mandatory scoped review

Request review of the exact post-`fb6947cb6` range. Treat every Critical or
Important finding as blocking. Apply any fix test-first, rerun focused checks,
and obtain a cleared follow-up review.

---

## Task 6: Resume the one live canary

### Step 1: Deploy the exact reviewed build

Stop the sole foreground daemon through its supported interrupt path. Start the
exact reviewed `client/dist/bin/jinn.js` once with the already-authorized local
claim-budget override. Confirm one PID/listener and exact commit/build stamp.

Do not run the recovery command yet.

### Step 2: Run Autopilot recover-only first

Use the existing Task `1197` attempt and the same tightly scoped environment:

```text
--mode recover --once --json status
```

Require Solution observation, Docker verification, patch application, pushed
resulting head, completion marker, and authenticated accepted Solution receipt
on PR `2267`. Never run active mode or submit another Task.

### Step 3: Read back immutable evidence

Confirm the receipt's authorized author, disposition, operation, numeric Task
correlation, request, attempt, envelope CID, V2 attempt, PR, claim OID,
expected head, and resulting head. Confirm the live DB row is still the exact
known false-contradiction `FAILED` row.

### Step 4: Dry-run then apply exact recovery

```bash
client/dist/bin/jinn.js recover-failed-adoption \
  --request-id 0xe55cb949d97af3779bd5dac153ef70c4709fd49cbd24d726a01d049103357e9f \
  --dry-run --json

client/dist/bin/jinn.js recover-failed-adoption \
  --request-id 0xe55cb949d97af3779bd5dac153ef70c4709fd49cbd24d726a01d049103357e9f \
  --apply --json
```

Require dry-run eligibility and exactly one successful CAS. Read back that only
the documented columns changed and all delivery evidence is identical.

### Step 5: Observe the parity stop condition

Allow the daemon to observe the existing accepted receipt and continue through
Router Solution claim plus exact-head, same-Task evaluator readiness/claim.
Stop before Verdict result observation/adoption, child work, merge work, or any
new top-level Task.

### Step 6: Finish the evidence report

Update
`.superpowers/sdd/2026-07-28-autopilot-mutation-delivery-binding/task-5-report.md`
with RED/GREEN/review/build evidence, authenticated receipt, CAS readback,
Router claim, evaluator link, exact Task count, and the unchanged immutable
failed-canary records.
