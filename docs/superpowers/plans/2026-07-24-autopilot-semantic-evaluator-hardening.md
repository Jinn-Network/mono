# Autopilot Semantic Evaluator Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Autopilot semantic evaluator so full-head correlation is correct and candidate code/configuration cannot escape the evaluator trust boundary.

**Architecture:** Keep mutation and review Git anchors distinct in the strict SDK session capsule. Make the host-side mechanical runner a safe repository/policy preflight plus an optional immutable-verifier port, resolve semantic runtimes per SolverNet invocation, and supervise every evaluator subprocess group through bounded termination and reaping.

**Tech Stack:** TypeScript, Zod v3, Node.js child processes, Vitest, Yarn 4, Node 22.

## Global Constraints

- Do not wire the production daemon context resolver, receipt observer, or semantic-runtime composition in this branch.
- Never execute candidate dependency installation, lifecycle hooks, package scripts, tests, project settings, skills, hooks, plugins, agents, or MCP configuration on the evaluator host.
- Missing immutable verification or semantic runtime resolution is unscorable, never a pass or ordinary failure.
- Preserve strict accepted-Solution correlation and ordinary non-Autopilot evaluator behavior.
- Test every behavior red-first and verify the final client typecheck under Node 22.

---

### Task 1: Separate mutation parent and full-review base OIDs

**Files:**
- Modify: `packages/sdk/src/autopilot-session.ts`
- Modify: `packages/sdk/test/autopilot-session.test.ts`
- Modify: `packages/sdk/test/fixtures/autopilot-session/*.json`
- Modify: `packages/autopilot/src/lifecycle/session-execution-backend.ts`
- Modify: `packages/autopilot/src/lifecycle/marketplace-session-backend.ts`
- Modify: `packages/autopilot/src/lifecycle/implementation-executor.ts`
- Modify: `packages/autopilot/test/lifecycle/implementation-executor.test.ts`
- Modify: `packages/autopilot/test/lifecycle/marketplace-session-backend.test.ts`
- Modify: affected Autopilot/client fixtures constructing strict session capsules

**Interfaces:**
- Produces: required `ClaimedMutationSessionInput.targetBaseOid: GitOid`.
- Produces: required `session.taskSnapshot.targetBaseOid`.
- Preserves: `session.taskSnapshot.baseSha` as the mutation parent.
- Changes: `AutopilotEvaluationContextSchema` binds `reviewTarget.baseOid` to `targetBaseOid`.

- [ ] **Step 1: Write failing SDK and producer tests**

Add an SDK context case where `baseSha` is the prior PR head and
`targetBaseOid` is the target branch OID:

```ts
const value = evaluationContext({
  session: {
    taskSnapshot: {
      baseSha: '8'.repeat(40),
      targetBaseOid: '3'.repeat(40),
    },
  },
  reviewTarget: { baseOid: '3'.repeat(40) },
});
expect(AutopilotEvaluationContextSchema.parse(value).reviewTarget.baseOid)
  .toBe('3'.repeat(40));
```

In the implementation-executor child test, make `readTargetBaseHead` return a
different OID from `parent.head` and assert the backend input carries both:

```ts
expect(started).toMatchObject({
  baseSha: parent.head,
  targetBaseOid: TARGET_BASE_HEAD,
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn test test/autopilot-session.test.ts
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn test test/lifecycle/implementation-executor.test.ts test/lifecycle/marketplace-session-backend.test.ts
```

Expected: schema/producer assertions fail because `targetBaseOid` is absent and
the evaluation context still binds to `baseSha`.

- [ ] **Step 3: Implement the strict contract and producer**

Add the required snapshot field:

```ts
taskSnapshot: z.object({
  title: z.string(),
  body: z.string(),
  prBody: z.string(),
  baseSha: GitOidSchema,
  targetBaseOid: GitOidSchema,
}).strict(),
```

Bind the evaluator:

```ts
[reviewTarget.baseOid, session.taskSnapshot.targetBaseOid,
  ['reviewTarget', 'baseOid'], 'base OID'],
```

Extend only mutation session inputs:

```ts
export interface ClaimedMutationSessionInput extends ClaimedSessionCommon {
  readonly targetBaseOid: GitOid;
  // existing fields
}
```

For initial work, reuse one target-base read when no PR exists. For adopted PRs
and all child work, read the target-base head separately and pass it without
changing `baseSha`.

- [ ] **Step 4: Update all strict fixtures and verify GREEN**

Every session fixture must carry an explicit `targetBaseOid`; child fixtures use
a value distinct from `baseSha`. Rerun the two commands from Step 2.

---

### Task 2: Make mechanical evaluation fail closed

**Files:**
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/autopilot-mechanical-runner.ts`
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/scope-tests.ts`
- Modify: `client/test/harnesses/jinn-repo-evaluator/autopilot-mechanical-runner.test.ts`
- Modify: `client/test/harnesses/jinn-repo-evaluator/scope-tests.test.ts`

**Interfaces:**
- Produces: `ImmutableMechanicalVerifier.verify(input): Promise<ImmutableMechanicalVerification>`.
- Changes: `RepositoryCommandRunner` options include an explicit `env`.
- Preserves: successful verifier output keeps the exact-head checkout alive for semantic review.

- [ ] **Step 1: Write failing trust-boundary tests**

Add tests proving:

```ts
expect(command.mock.calls.every(([, , options]) =>
  options.env.GH_TOKEN === undefined
  && options.env.JINN_PASSWORD === undefined,
)).toBe(true);
expect(command.mock.calls.some(([command]) =>
  command === 'yarn' || command === 'corepack',
)).toBe(false);
```

Add a mixed-path case:

```ts
changedFiles: 'client/src/main.ts\n.claude/settings.json\n'
```

and expect `unsupported-diff-scope` before verifier invocation. Add a supported
diff without a verifier and expect `immutable-verifier-unavailable`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn vitest run test/harnesses/jinn-repo-evaluator/autopilot-mechanical-runner.test.ts test/harnesses/jinn-repo-evaluator/scope-tests.test.ts
```

Expected: ambient credentials are inherited, candidate commands run, mixed
paths are ignored, and the runner passes without an immutable verifier.

- [ ] **Step 3: Implement safe policy preflight**

Construct the command environment from a fixed allowlist and isolated HOME:

```ts
function repositoryCommandEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}
```

Reject if any changed file has no owner in `KNOWN_LIVE_EVAL_PACKAGES`, even
when another path is supported. Delete all package-manager/typecheck/test
execution. Invoke the immutable verifier only after exact-head and total-path
policy checks. Without it, clean up and return unscorable.

- [ ] **Step 4: Verify GREEN**

Rerun the focused command from Step 2.

---

### Task 3: Isolate and reap evaluator subprocess groups

**Files:**
- Create: `client/src/harnesses/impls/jinn-repo-evaluator/supervised-process.ts`
- Create: `client/test/harnesses/jinn-repo-evaluator/supervised-process.test.ts`
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/autopilot-mechanical-runner.ts`
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/claude-semantic-agent.ts`
- Modify: `client/test/harnesses/jinn-repo-evaluator/claude-semantic-agent.test.ts`

**Interfaces:**
- Produces: `runSupervisedProcess(command, args, options)` with explicit env,
  output bounds, AbortSignal, grace intervals, and injected spawn/kill/timers.
- Guarantees: cancellation resolves/rejects only after `close`, or reports an
  unreaped infrastructure timeout without deleting live-process state.

- [ ] **Step 1: Write failing lifecycle tests**

Use fake timers and a fake detached child to assert:

```ts
controller.abort();
expect(killProcessGroup).toHaveBeenCalledWith(1234, 'SIGTERM');
await vi.advanceTimersByTimeAsync(2_000);
expect(killProcessGroup).toHaveBeenCalledWith(1234, 'SIGKILL');
expect(remove).not.toHaveBeenCalled();
child.emit('close', null, 'SIGKILL');
await expect(pending).rejects.toThrow('aborted');
expect(remove).toHaveBeenCalled();
```

Add an unreaped timeout case that reports infrastructure failure and leaves the
isolated directory intact.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn vitest run test/harnesses/jinn-repo-evaluator/supervised-process.test.ts test/harnesses/jinn-repo-evaluator/claude-semantic-agent.test.ts
```

Expected: no shared supervisor exists and Claude currently settles immediately
after SIGTERM.

- [ ] **Step 3: Implement the shared supervisor**

Spawn detached on non-Windows systems. On abort or output overflow, signal the
group and direct child with SIGTERM, schedule SIGKILL after the grace period,
then await `close`. A second timeout rejects with a typed unreaped error. Clear
timers and listeners on every terminal path.

Use the supervisor for default Git commands and Claude. Keep dependency
injection at the supervisor boundary so tests do not spawn real processes.

- [ ] **Step 4: Verify GREEN**

Rerun the focused command from Step 2.

---

### Task 4: Disable candidate Claude control plane

**Files:**
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/claude-semantic-agent.ts`
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/autopilot-semantic.ts`
- Modify: `client/test/harnesses/jinn-repo-evaluator/claude-semantic-agent.test.ts`
- Modify: `client/test/harnesses/jinn-repo-evaluator/autopilot-semantic.test.ts`

**Interfaces:**
- Changes: `SemanticAgentRunnerInput` includes the exact resolved `model`.
- Preserves: fixed read-only repository inspection tools.

- [ ] **Step 1: Write failing safe-mode tests**

Assert the Claude arguments include:

```ts
expect(args).toContain('--safe-mode');
expect(args).toContain('--disable-slash-commands');
expect(args).toContain('--strict-mcp-config');
expect(args).toContain('{"mcpServers":{}}');
expect(args).not.toContain('project');
```

Assert the prompt does not direct the model to load `review-pr`, and does
contain an embedded checklist covering correctness, correlation, security,
cleanup, and compatibility.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn vitest run test/harnesses/jinn-repo-evaluator/claude-semantic-agent.test.ts test/harnesses/jinn-repo-evaluator/autopilot-semantic.test.ts
```

Expected: the current runner loads project settings and the prompt delegates to
the candidate-controlled review skill.

- [ ] **Step 3: Implement safe mode and trusted prompt**

Replace `--setting-sources project` with the safe-mode flags and empty strict
MCP config. Retain `dontAsk`, the allowlisted read/search/Git tools, and explicit
write/network disallow rules. Select `--model` from the per-invocation input.

Replace the first prompt instruction with a fixed evaluator methodology that
does not reference checkout instructions.

- [ ] **Step 4: Verify GREEN**

Rerun the focused command from Step 2.

---

### Task 5: Resolve semantic runtimes per SolverNet

**Files:**
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/autopilot-semantic.ts`
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/harness.ts`
- Modify: `client/src/harnesses/impls/index.ts`
- Modify: `client/test/harnesses/jinn-repo-evaluator/harness.test.ts`
- Modify: relevant `buildHarnesses` tests

**Interfaces:**
- Produces:

```ts
export interface SemanticAgentRuntime {
  provider: string;
  model?: string;
  runner: SemanticAgentRunner;
}

export interface SemanticAgentRunnerResolver {
  resolve(input: {
    manifestCid?: string;
    solverNet?: HarnessContext['solverNet'];
  }): SemanticAgentRuntime | undefined;
}
```

- Removes: constructor-wide `semanticAgentRunner`/`semanticEvaluatorRunner`.

- [ ] **Step 1: Write failing per-net resolution tests**

Run two harness contexts with different manifest CIDs/models. Assert the
resolver sees each exact context, returns distinct provider-labelled runtimes,
and each runner receives its own resolved model. Assert unresolved nets produce
the existing `autopilot_eval_pending` path.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn vitest run test/harnesses/jinn-repo-evaluator/harness.test.ts
```

Expected: the harness accepts only one global runner and does not consult task
manifest/model context.

- [ ] **Step 3: Implement resolver-based dispatch**

Accept a resolver in harness/build options. `canAttempt` validates the task and
requires only that a resolver port exists. `run` resolves from
`ctx.task.solverNetManifestCid` plus `ctx.solverNet`, fails pending when absent,
and calls semantic review with the returned runner/model.

Do not modify `client/src/main.ts`.

- [ ] **Step 4: Verify GREEN**

Rerun the focused command from Step 2 and the complete six-file evaluator suite.

---

### Task 6: Final compatibility and verification

**Files:**
- Modify: any test fixtures/type-only callers exposed by strict compilation
- Verify: all files changed since `ebe4e8aa1`

**Interfaces:**
- Preserves: legacy `jinn-repo.v1` non-Autopilot evaluator routing.
- Preserves: strict accepted-Solution and review-output correlation.

- [ ] **Step 1: Run focused package suites**

```bash
cd packages/sdk
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn test test/autopilot-session.test.ts

cd packages/autopilot
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn test test/lifecycle/implementation-executor.test.ts test/lifecycle/marketplace-session-backend.test.ts

cd client
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn vitest run test/harnesses/jinn-repo-evaluator/autopilot-evaluation-context.test.ts test/harnesses/jinn-repo-evaluator/autopilot-mechanical-runner.test.ts test/harnesses/jinn-repo-evaluator/autopilot-semantic.test.ts test/harnesses/jinn-repo-evaluator/claude-semantic-agent.test.ts test/harnesses/jinn-repo-evaluator/harness.test.ts test/harnesses/jinn-repo-evaluator/scope-tests.test.ts test/harnesses/jinn-repo-evaluator/supervised-process.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the complete client typecheck**

```bash
cd client
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH corepack yarn typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 3: Inspect scope and request review**

Run `git diff --check`, inspect `git diff --stat ebe4e8aa1..HEAD` plus the
working-tree diff, and request an independent code review against the approved
design. Fix every Critical or Important finding test-first.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk packages/autopilot client docs/superpowers
git commit -m "fix: harden Autopilot semantic evaluation"
```

Record the final commit SHA and verify the worktree is clean.
