# Claude Multi-Turn Completion Handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent intermediate Claude Code `result` events from terminating an
active learner session while preserving immediate process-group reaping for a
completed session that leaks subprocesses.

**Architecture:** Extract the learner phase and artifact rules from
`harvest.ts` into one reusable lifecycle-artifact contract. The Claude adapter
will cache each top-level result and settle it only when that contract reports
normal terminal artifacts or a valid learner error artifact. Child exit and
window abort remain independent bounded fallbacks.

**Tech Stack:** TypeScript, Node child processes and filesystem APIs, Vitest,
Yarn 4, Node 22.

## Global Constraints

- Preserve issue `#2264` and Task `1196` as immutable failure evidence.
- Never rerun active mode for issue `#2264`.
- Do not create another live issue or Task until the fixed build has passed
  focused tests, all learner tests, typecheck, the full client suite, and the
  production build, and has replaced the sole daemon.
- Use the existing learner mode and phase-range artifact contract; do not
  introduce a second hard-coded phase list.
- A terminal phase artifact or learner error artifact must contain a JSON
  object, not merely exist.
- Do not introduce polling, a grace-period heuristic, or a new model-authored
  completion marker.
- Preserve issue `#883` process-group shutdown: `SIGTERM` followed by the
  existing two-second `SIGKILL` backstop once terminal evidence exists.
- Preserve the existing task-window abort as the bound for a genuinely
  incomplete or hung session.
- Run client commands with
  `PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH`.

---

### Task 1: Reproduce the multi-turn result race in tests

**Files:**

- Modify:
  `client/test/harnesses/impls/learner/claude-code-adapter.test.ts`

**Interfaces:**

- Consumes:
  `ClaudeCodeHarnessAdapter.runTask(inputs, pluginRoot): Promise<void>`.
- Produces: a controllable fake Claude child and RED behavior tests for
  intermediate results, cached results at exit, early exit, and issue `#883`.

- [ ] **Step 1: Make the fake child controllable**

Add a `manual` fake-child mode that attaches no automatic output or exit:

```ts
function fakeClaudeChild(
  mode:
    | 'manual'
    | 'result-then-hang'
    | 'result-then-exit'
    | 'crash-no-result'
    | 'result-then-late-output',
): FakeClaudeChild {
  // existing construction
  setImmediate(() => {
    if (mode === 'manual') return;
    // existing modes
  });
  return child;
}
```

Add local test writers that create literal JSON objects at the seven primary
artifact paths. Keep the expectations independent of the production phase
resolver.

- [ ] **Step 2: Add the Task 1196 regression**

Use a manual child. Write only
`.orient/goal-parse.json`, `.orient/world-state.json`, and
`.orient/own-history.json`, then emit:

```ts
child.stdout.emit(
  'data',
  Buffer.from('{"type":"result","subtype":"success"}\n'),
);
```

After one event-loop turn, require the run promise to remain pending and both
the child and process group to remain un-killed. Then write all seven terminal
artifacts, emit a second successful result, and require the promise to resolve
and the group to be reaped.

- [ ] **Step 3: Add exit-boundary regressions**

Add two manual-child tests:

1. Cache an intermediate successful result, write all terminal artifacts, then
   emit clean exit without a second result. Require resolution from the cached
   result.
2. Cache an intermediate successful result and emit clean exit while terminal
   artifacts remain incomplete. Require rejection; the cached result must not
   promote an early exit to success.

- [ ] **Step 4: Strengthen issue #883 coverage**

Before the `result-then-hang` child emits its successful result, seed all
full/train terminal artifacts. Continue requiring immediate resolution,
process-group `SIGTERM`, and child reaping even though the child never emits
`exit`.

- [ ] **Step 5: Run RED**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/harnesses/impls/learner/claude-code-adapter.test.ts
```

Expected: the Task `1196` test fails because the first result kills and settles
the fake child; the clean early-exit test also demonstrates that the adapter
currently accepts an incomplete zero exit.

### Task 2: Centralize lifecycle artifact rules and terminal evidence

**Files:**

- Create:
  `client/src/harnesses/impls/learner/lifecycle-artifacts.ts`
- Create:
  `client/test/harnesses/impls/learner/lifecycle-artifacts.test.ts`
- Modify:
  `client/src/harnesses/impls/learner/harvest.ts`

**Interfaces:**

- Produces:

```ts
export type LearnerPhase =
  | 'orient'
  | 'strategize'
  | 'plan'
  | 'execute'
  | 'debrief'
  | 'improve'
  | 'memory-consolidation';

export type LearnerPhaseRange =
  | 'full'
  | 'pre-execute'
  | 'post-execute'
  | 'solve-only';

export type LearnerTerminalEvidence =
  | { kind: 'complete'; requiredArtifacts: readonly string[] }
  | { kind: 'failure'; errorArtifact: string }
  | { kind: 'incomplete'; missingArtifacts: readonly string[] };

export function resolveLearnerPhaseRange(
  value?: string,
): LearnerPhaseRange;

export function requiredLearnerPhases(
  range: LearnerPhaseRange,
  mode?: 'train' | 'frozen',
): readonly LearnerPhase[];

export function requiredReadJson(
  path: string,
): Record<string, unknown>;

export function inspectLearnerTerminalEvidence(input: {
  workingDir: string;
  mode: 'train' | 'frozen';
  phaseRange?: string;
}): LearnerTerminalEvidence;
```

- Consumes: `harvest.ts` keeps using the same phase order, primary artifact
  names, phase-range fallback, and `requiredReadJson` behavior through this
  module.

- [ ] **Step 1: Add failing contract tests**

Use literal table cases to require:

```ts
[
  { range: 'full', mode: 'train', required: [
    'orient', 'strategize', 'plan', 'execute', 'debrief',
    'improve', 'memory-consolidation',
  ] },
  { range: 'full', mode: 'frozen', required: [
    'orient', 'strategize', 'plan', 'execute', 'debrief',
  ] },
  { range: 'pre-execute', mode: 'train', required: [
    'orient', 'strategize', 'plan',
  ] },
  { range: 'post-execute', mode: 'train', required: [
    'debrief', 'improve', 'memory-consolidation',
  ] },
  { range: 'post-execute', mode: 'frozen', required: ['debrief'] },
  { range: 'solve-only', mode: 'frozen', required: [] },
]
```

Also require:

- complete evidence only when every required primary artifact is valid JSON;
- corrupt or missing primary JSON yields `incomplete`;
- the first lexically sorted valid `.errors/*.json` yields `failure`;
- corrupt error JSON is ignored and does not become terminal evidence.

- [ ] **Step 2: Run the new test to verify RED**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/harnesses/impls/learner/lifecycle-artifacts.test.ts
```

Expected: FAIL because `lifecycle-artifacts.ts` and its exports do not exist.

- [ ] **Step 3: Implement the shared contract**

Move, without semantic drift, the existing phase order, primary artifact map,
phase-range map, phase-range normalization, and required JSON-object reader
from `harvest.ts`. Implement frozen-mode filtering only in
`requiredLearnerPhases`; harvest calls it without a mode and therefore retains
its current required ranges.

`inspectLearnerTerminalEvidence` must inspect valid error JSON first, then
validate each required primary artifact. It must return deterministic,
absolute artifact paths.

- [ ] **Step 4: Rewire harvest to the shared contract**

Replace the private constants and resolver in `harvest.ts` with imports.
Preserve the existing public import path for tests and callers:

```ts
export { requiredReadJson } from './lifecycle-artifacts.js';
```

Resolve the existing environment fallback at the harvest boundary:

```ts
const range = resolveLearnerPhaseRange(
  phaseRange ?? process.env.LEARNER_PHASE_RANGE,
);
```

- [ ] **Step 5: Run contract and harvest tests GREEN**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/harnesses/impls/learner/lifecycle-artifacts.test.ts \
  test/harnesses/impls/learner/harvest.test.ts
```

Expected: PASS, including existing full, pre-execute, post-execute,
solve-only, missing, and corrupt artifact cases.

### Task 3: Gate Claude result settlement on terminal evidence

**Files:**

- Modify:
  `client/src/harnesses/impls/learner/adapters/claude-code.ts`
- Modify:
  `client/test/harnesses/impls/learner/claude-code-adapter.test.ts`

**Interfaces:**

- Consumes:
  `inspectLearnerTerminalEvidence({ workingDir, mode, phaseRange })`.
- Produces: a result/exit state machine that distinguishes intermediate
  turn-boundary results from learner-terminal completion.

- [ ] **Step 1: Cache the latest parsed result**

Represent only fields the adapter consumes:

```ts
type ClaudeResult = {
  subtype?: unknown;
};

let latestResult: ClaudeResult | undefined;
```

Every top-level parsed `result` replaces `latestResult`, even when terminal
evidence is incomplete.

- [ ] **Step 2: Split terminal reaping from evidence inspection**

Keep the existing process-group reap and two-second `SIGKILL` timer in a helper
called only after terminal evidence is `complete` or `failure`.

For `failure`, reject with a bounded message naming the relative learner error
artifact. For `complete`, preserve subtype handling:

```ts
if (result.subtype === undefined || result.subtype === 'success') {
  resolve();
} else {
  reject(
    new Error(
      `claude-code adapter: session ended with result subtype=${String(result.subtype)}`,
    ),
  );
}
```

- [ ] **Step 3: Continue after intermediate results**

Make `onResult` return whether it settled. In the stdout newline loop, return
only after terminal settlement; otherwise continue scanning:

```ts
if (obj && obj.type === 'result') {
  if (onResult({ subtype: obj.subtype })) return;
}
```

- [ ] **Step 4: Re-evaluate evidence on child exit**

For a non-aborted child exit:

1. retain the existing non-zero exit error;
2. reject valid learner error evidence;
3. reject a zero exit with incomplete terminal evidence;
4. if evidence is complete and a cached result exists, settle from that
   result; and
5. if evidence is complete with no cached result, resolve a zero exit.

Check `inputs.abort.aborted` before incomplete-evidence rejection so
window-end partial-output behavior remains unchanged.

- [ ] **Step 5: Add mode, phase-range, and error integration cases**

Add focused adapter cases requiring successful terminal settlement for:

- full/frozen without Improve or Memory consolidation;
- pre-execute/train with only Orient, Strategize, and Plan; and
- post-execute/frozen with only Debrief.

Require a valid `.errors/plan.json` plus a successful Claude result to reject
and reap. Require corrupt `.errors/plan.json` to remain incomplete.

- [ ] **Step 6: Run adapter and contract tests GREEN**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/harnesses/impls/learner/claude-code-adapter.test.ts \
  test/harnesses/impls/learner/lifecycle-artifacts.test.ts \
  test/harnesses/impls/learner/harvest.test.ts
```

Expected: PASS. Mentally mutate the incomplete-evidence branch to settle and
confirm the Task `1196` test would fail; mutate the terminal branch to wait for
exit and confirm the strengthened `#883` test would time out.

### Task 4: Verify, commit, deploy, and checkpoint before retry

**Files:**

- Modify:
  `.superpowers/sdd/2026-07-28-autopilot-mutation-delivery-binding/task-5-report.md`
  (ignored evidence report only; do not commit)

**Interfaces:**

- Consumes: the tested adapter build and the existing foreground daemon
  session.
- Produces: one committed client repair and one healthy replacement daemon;
  no external marketplace mutation occurs in this task.

- [ ] **Step 1: Run all learner tests**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run test/harnesses/impls/learner
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client typecheck
```

Expected: exit `0`.

- [ ] **Step 3: Run the full client suite**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client test
```

Expected: exit `0`.

- [ ] **Step 4: Build the production client**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client build
```

Expected: exit `0`, with the repaired adapter present under `client/dist/`.

- [ ] **Step 5: Review and commit**

Run `git diff --check`, inspect the exact source/test diff, and verify no
unrelated files or live-canary artifacts are tracked. Commit:

```bash
git add \
  client/src/harnesses/impls/learner/lifecycle-artifacts.ts \
  client/src/harnesses/impls/learner/harvest.ts \
  client/src/harnesses/impls/learner/adapters/claude-code.ts \
  client/test/harnesses/impls/learner/lifecycle-artifacts.test.ts \
  client/test/harnesses/impls/learner/claude-code-adapter.test.ts
git commit -m "fix(client): await learner terminal artifacts"
```

- [ ] **Step 6: Replace the sole daemon**

Stop the current foreground daemon cleanly. Prove its PID is absent and port
`7332` is free. Start exactly one daemon from the new `client/dist/bin/jinn.js`
with:

```bash
JINN_DISABLE_AUTO_TASKS=1 \
JINN_AI_UNITS_CEILING_OVERRIDE=10000:280000 \
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
node client/dist/bin/jinn.js run --no-ui
```

Verify exactly one process/listener, healthy RPC and harness readiness,
unchanged canonical membership CID, and an unpaused AI budget.

- [ ] **Step 7: Send the pre-mutation checkpoint**

Report the commit, RED/GREEN evidence, full verification, built artifact, and
sole-daemon identity to the root coordinator. Wait for the root coordinator's
external-retry go-ahead before creating a fresh issue or Task.

### Task 5: Run one fresh marketplace retry and stop before Verdict

**Files:**

- Modify:
  `.superpowers/sdd/2026-07-28-autopilot-mutation-delivery-binding/task-5-report.md`
  (ignored evidence report only; do not commit)

**Interfaces:**

- Consumes: the root coordinator's go-ahead, the verified daemon, the existing
  standalone Autopilot worktree, and recovery-only orchestration after the one
  active dispatch.
- Produces: one fresh issue, one fresh Task, one authenticated typed Solution
  adoption, and same-Task evaluator readiness, stopping before Verdict.

- [ ] **Step 1: Re-attest and preflight**

Refresh the supported capability attestation, verify the standalone checkout
is still at the exact allowed base with only its preserved `.autopilot/`
state, verify the trusted Docker digest immediately before activation, and
confirm the sole daemon and membership are unchanged.

- [ ] **Step 2: Create exactly one disposable issue**

Create one new Low-effort, P4, Blocked-on-Nothing documentation-marker issue
with a unique marker and a non-CODEOWNER target. Record its project item,
branch, PR, V2 attempt, runner, and expected head.

- [ ] **Step 3: Dispatch exactly one active cycle and Task**

Run one active standalone cycle with the single-issue allowlist and caps of
one. Record cycle ID, Task ID/CID, creation transaction/block, attempt index,
request ID, request digest, and immutable session correlation. Permanently
lock that issue to recovery-only orchestration after dispatch.

- [ ] **Step 4: Observe delivery and adoption**

Require:

- the learner reaches terminal artifacts without an intermediate-result reap;
- a typed `jinn-autopilot-mutation-result.v1` Solution envelope and delivery
  transaction;
- strict observer correlation to the authenticated envelope CID;
- trusted-Docker patch verification;
- exact patch application, commit, push, and implementation completion;
- accepted adoption receipt; and
- exact-head evaluator readiness for the same Task and adopted Solution.

- [ ] **Step 5: Stop before Verdict and finalize evidence**

Do not create or adopt a Verdict. Record final issue/Task/PR/head/envelope/
receipt/evaluator state, daemon health, and all stop-boundary assertions in the
ignored task report, then hand the evidence to the root coordinator.
