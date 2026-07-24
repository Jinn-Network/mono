# Autopilot Canonical implement-issue Runtime Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the drifting Hermes lifecycle skill with one canonical `implement-issue` skill, and make finite Hermes coordinator and root-stage processes synchronously receive native subagent results without modifying Hermes runtime files.

**Architecture:** The canonical skill owns every lifecycle gate and stage deliverable; two mechanics-only references map those stages onto Claude and Hermes. A Jinn-owned Python launcher binds Hermes’s existing session capability to `async_delivery=False`, then enters the normal `hermes chat -q` path. Both coordinator dispatch and the runtime-aware `stage:run` command reuse one TypeScript Hermes invocation helper.

**Tech Stack:** TypeScript, Vitest, Node child processes, Python 3, Hermes Agent’s existing `gateway.session_context` API, Markdown skills.

## Global Constraints

- Keep the Hermes model id bare as `gpt-5.6-sol`.
- Pass `--provider openai-codex` explicitly in coordinator and stage invocations.
- Do not set Hermes `api_mode` or `base_url`.
- Preserve the per-issue `HERMES_HOME`, copied auth state, delegation toolset, MCP wiring, and Effort-to-reasoning mapping.
- Process-local delegation depth stays at Hermes’s default of 1; Stages 1, 3, 4, and 5 reset depth by launching fresh operating-system root processes.
- Do not modify files under the installed Hermes checkout.
- Do not touch `docs/runbooks/swe-rebench-v2-public-testnet.md`.
- Claude remains the default adapter and retains its current behavior.
- Implementation is test-first; every production or skill edit follows a witnessed failing test.

---

## File map

- `.claude/skills/implement-issue/SKILL.md` — the only lifecycle contract; selects and delegates mechanics to one adapter reference.
- `.claude/skills/implement-issue/references/claude.md` — Claude root-stage, lightweight-child, and composed-skill mechanics.
- `.claude/skills/implement-issue/references/hermes.md` — Hermes stateless-root, synchronous-child, and Hermes-native skill mechanics.
- `.claude/skills/implement-issue-hermes/SKILL.md` — deleted; its lifecycle copy must not survive.
- `packages/autopilot/bin/jinn-hermes-stateless.py` — compatibility entry point that binds the finite-session capability before entering the normal Hermes CLI.
- `packages/autopilot/src/dispatcher/hermes-runtime.ts` — shared Python path, launcher path, argument construction, and runtime-file validation.
- `packages/autopilot/src/headless.ts` — runtime-specific rendering of the shared headless override.
- `packages/autopilot/src/dispatcher/run-stage.ts` — runtime-aware root-stage process runner with one result contract.
- `packages/autopilot/bin/jinn-run-stage.ts` — CLI parsing for `--runtime claude|hermes`.
- `packages/autopilot/src/dispatcher/dispatch.ts` — canonical skill invocation and stateless Hermes coordinator spawn.
- `packages/autopilot/src/dispatcher/types.ts` — `hermesPythonPath` dispatcher configuration.
- `packages/autopilot/scripts/run-autopilot.ts` — environment override, boot validation, and log output for the Hermes Python launcher.
- `packages/autopilot/src/dispatcher/hermes-home.ts` — correct process-local depth explanation.
- `packages/autopilot/test/implement-issue-skill.test.ts` — canonical-source and adapter-boundary regression tests.
- `packages/autopilot/test/hermes-stateless-launcher.test.ts` — launcher integration test with fake Hermes modules.
- `packages/autopilot/test/dispatcher/hermes-runtime.test.ts` — shared invocation-helper tests.
- `packages/autopilot/test/dispatcher/run-stage.test.ts` — Claude/Hermes root-stage behavior.
- `packages/autopilot/test/dispatcher/dispatch.test.ts` — canonical prompt, interpreter, environment, model/provider, and regression coverage.
- `packages/autopilot/test/dispatcher/hermes-home.test.ts` — process-local depth contract.
- Dispatcher test fixtures containing `DispatcherConfig` literals — rename `hermesPath` to `hermesPythonPath`.

---

### Task 1: Establish the canonical skill and mechanics-only adapters

**Files:**
- Modify: `packages/autopilot/test/implement-issue-skill.test.ts`
- Modify: `.claude/skills/implement-issue/SKILL.md`
- Create: `.claude/skills/implement-issue/references/claude.md`
- Create: `.claude/skills/implement-issue/references/hermes.md`
- Delete: `.claude/skills/implement-issue-hermes/SKILL.md`

**Interfaces:**
- Consumes: dispatcher prompt value `JINN_IMPLEMENT_ISSUE_ADAPTER=claude|hermes` and an explicit runtime-adapter sentence in the scenario.
- Produces: one lifecycle skill plus two references that Task 3’s `stage:run` implementation satisfies.

- [ ] **Step 1: Run the skill baseline without leaking the intended answer**

Dispatch a clean-context, read-only evaluator with:

```text
Read .claude/skills/implement-issue-hermes/SKILL.md and
.claude/skills/implement-issue/fixtures/feat-fixture.md. Describe the exact
pipeline you would execute, including named skills, intake gates, process
topology, review loops, PR requirements, and cleanup. Do not inspect the
Claude implement-issue skill and do not edit files.
```

Record which canonical requirements it omits. The already-observed sibling
shortening is the RED behavior; do not edit the skill before this run finishes.

- [ ] **Step 2: Write the failing canonical-source tests**

Add path constants and assertions equivalent to:

```ts
import { existsSync, readFileSync } from 'node:fs';

const CLAUDE_ADAPTER_PATH = join(
  REPO_ROOT, '.claude', 'skills', 'implement-issue', 'references', 'claude.md',
);
const HERMES_ADAPTER_PATH = join(
  REPO_ROOT, '.claude', 'skills', 'implement-issue', 'references', 'hermes.md',
);

describe('implement-issue canonical runtime adapters', () => {
  it('has no copied Hermes lifecycle skill', () => {
    expect(existsSync(HERMES_SKILL_PATH)).toBe(false);
  });

  it('links both mechanics-only adapter references from the canonical skill', () => {
    expect(doc).toContain('references/claude.md');
    expect(doc).toContain('references/hermes.md');
    expect(doc).toContain('JINN_IMPLEMENT_ISSUE_ADAPTER');
  });

  it('ships both adapter references', () => {
    expect(existsSync(CLAUDE_ADAPTER_PATH)).toBe(true);
    expect(existsSync(HERMES_ADAPTER_PATH)).toBe(true);
  });

  it('keeps lifecycle gates out of the adapters', () => {
    for (const path of [CLAUDE_ADAPTER_PATH, HERMES_ADAPTER_PATH]) {
      const adapter = existsSync(path) ? readFileSync(path, 'utf8') : '';
      expect(adapter).not.toContain('## Step 1 — Read the issue');
      expect(adapter).not.toContain('## Step 5 — Finding handling and escalation');
      expect(adapter).not.toContain('## Step 6 — Shape variants');
    }
  });
});
```

- [ ] **Step 3: Run the targeted test and verify RED**

Run:

```bash
cd packages/autopilot
yarn test test/implement-issue-skill.test.ts
```

Expected: FAIL because the sibling exists and both adapter references are absent.

- [ ] **Step 4: Convert the canonical skill to runtime-neutral dispatch**

Keep every existing lifecycle section and replace only mechanics declarations.
The opening selection contract must be:

```markdown
## Runtime adapter

The dispatcher names the active adapter in the task and exports
`JINN_IMPLEMENT_ISSUE_ADAPTER=claude|hermes`. Before Step 1, read exactly one
reference completely:

- Claude: [`references/claude.md`](references/claude.md)
- Hermes: [`references/hermes.md`](references/hermes.md)

If a human invokes this skill without naming an adapter, use Claude. The
adapter controls process and child-dispatch mechanics only. This file remains
authoritative for every gate, stage deliverable, retry, escalation, shipping,
and cleanup decision.
```

Change the stage annotations to “run through the active adapter’s fresh-root
mechanism” for Stages 1, 3, 4, and 5, and “run through the active adapter’s
lightweight-child mechanism” for Stages 2, 6, 7, and 8. Keep all existing
deliverables, guards, shape variants, human-surface requirements, and cleanup.

Replace the Claude-only Step 4 command body with an adapter-neutral rule:

```markdown
### Running a depth-needing stage

Use the active adapter reference’s `stage:run` command. The command must launch
a fresh depth-0 operating-system process in `$WORKTREE_PATH`, prepend canon and
the runtime-specific headless override exactly once, and return captured output
as the stage report. Never dispatch a depth-needing stage as a lightweight
child.
```

- [ ] **Step 5: Add the complete Claude mechanics reference**

The reference must contain the current command contract:

```markdown
# Claude runtime adapter

Use this reference only for dispatch mechanics. The canonical `../SKILL.md`
owns the lifecycle.

## Fresh-root stages

Write the curated prompt to `/tmp/stage-<N>-<stage>.md`, then run:

```bash
(cd "$WORKTREE_PATH/packages/autopilot" && yarn stage:run \
  --runtime claude \
  --prompt-file /tmp/stage-<N>-<stage>.md \
  --worktree "$WORKTREE_PATH" \
  [--model <model>])
```

Stages 1, 3, 4, and 5 each use a separate invocation.

## Lightweight children

Use a fresh Agent-tool child for Stages 2, 6, 7, and 8. Give it only the
canonical stage task, issue/acceptance criteria, worktree/branch, and relevant
prior-stage outputs.

## Method skills

- Stage 1: `superpowers:brainstorming`
- Stage 2: `superpowers:writing-plans`
- Stage 3: `superpowers:test-driven-development` then
  `superpowers:executing-plans`
- Stage 4: `/code-review`
- Stage 5: `superpowers:requesting-code-review`
- Stage 6: `/security-review`
- Stage 7: `testing-jinn-app`
- Stage 8: `superpowers:verification-before-completion`
```

- [ ] **Step 6: Add the complete Hermes mechanics reference**

The reference must state:

```markdown
# Hermes runtime adapter

Use this reference only for dispatch mechanics. The canonical `../SKILL.md`
owns the lifecycle.

## Finite-session invariant

The coordinator and every root stage run through Jinn’s stateless Hermes
launcher. It binds `async_delivery=False`, so top-level `delegate_task` calls
use Hermes’s existing synchronous aggregation path. A task batch may still fan
out concurrently; its consolidated result returns in the current turn.

## Fresh-root stages

Write the curated prompt to `/tmp/stage-<N>-<stage>.md`, then run:

```bash
(cd "$WORKTREE_PATH/packages/autopilot" && yarn stage:run \
  --runtime hermes \
  --prompt-file /tmp/stage-<N>-<stage>.md \
  --worktree "$WORKTREE_PATH")
```

Stages 1, 3, 4, and 5 each use a separate invocation. Each invocation is a new
depth-0 Hermes process, so that stage may use its own `delegate_task` fan-out.

## Lightweight children

Use a fresh synchronous `delegate_task` child for Stages 2, 6, 7, and 8.
Never use a lightweight child for a depth-needing stage.

## Method skills

Load the closest installed Hermes skill for the canonical methodology:
`plan`/`writing-plans`, `test-driven-development`,
`subagent-driven-development`, `simplify-code`,
`requesting-code-review`, `github-code-review`, and the repository’s
`testing-jinn-app`. Where Hermes has no separately named security or
verification skill, follow the canonical stage checklist directly; do not
remove or compress the stage.
```

- [ ] **Step 7: Delete the copied sibling and verify GREEN**

Run:

```bash
cd packages/autopilot
yarn test test/implement-issue-skill.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the canonical skill boundary**

```bash
git add .claude/skills/implement-issue packages/autopilot/test/implement-issue-skill.test.ts
git add -u .claude/skills/implement-issue-hermes
git commit -m "refactor(autopilot): make implement-issue runtime canonical"
```

---

### Task 2: Add and verify the stateless Hermes launcher

**Files:**
- Create: `packages/autopilot/bin/jinn-hermes-stateless.py`
- Create: `packages/autopilot/test/hermes-stateless-launcher.test.ts`

**Interfaces:**
- Consumes: normal Hermes CLI arguments in `sys.argv[1:]`.
- Produces: the same Hermes command behavior under a session context whose asynchronous-delivery capability is false.

- [ ] **Step 1: Write the failing launcher integration test**

Create a temporary fake Python package tree for
`gateway.session_context` and `hermes_cli.main`. The test runs the not-yet
existing launcher and asserts the trace:

```ts
const result = spawnSync(
  process.env.PYTHON ?? 'python3',
  [LAUNCHER_PATH, 'chat', '-q', 'PROMPT-MARKER'],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: fakeModulesRoot,
      TRACE_FILE: tracePath,
    },
  },
);

expect(result.status).toBe(0);
expect(readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse))
  .toEqual([
    { event: 'set', source: 'jinn-autopilot', cwd: AUTOPILOT_ROOT, async_delivery: false },
    { event: 'main', argv: ['chat', '-q', 'PROMPT-MARKER'] },
    { event: 'clear', token_count: 1 },
  ]);
```

The fake `hermes_cli.main.main()` must raise `SystemExit(0)` after writing its
trace, proving the launcher’s `finally` block clears context on the real CLI
exit path.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd packages/autopilot
yarn test test/hermes-stateless-launcher.test.ts
```

Expected: FAIL because `bin/jinn-hermes-stateless.py` does not exist.

- [ ] **Step 3: Implement the minimal launcher**

Create:

```python
#!/usr/bin/env python3
"""Run a finite Hermes CLI command with synchronous top-level delegation."""

from __future__ import annotations

import os


def main() -> None:
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(
        source="jinn-autopilot",
        cwd=os.getcwd(),
        async_delivery=False,
    )
    try:
        from hermes_cli.main import main as hermes_main

        hermes_main()
    finally:
        clear_session_vars(tokens)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the launcher test and verify GREEN**

Run:

```bash
cd packages/autopilot
yarn test test/hermes-stateless-launcher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the launcher**

```bash
git add packages/autopilot/bin/jinn-hermes-stateless.py packages/autopilot/test/hermes-stateless-launcher.test.ts
git commit -m "fix(autopilot): join Hermes delegates in finite sessions"
```

---

### Task 3: Make the root-stage runner runtime-aware

**Files:**
- Create: `packages/autopilot/src/dispatcher/hermes-runtime.ts`
- Create: `packages/autopilot/test/dispatcher/hermes-runtime.test.ts`
- Modify: `packages/autopilot/src/headless.ts`
- Modify: `packages/autopilot/test/headless.test.ts`
- Modify: `packages/autopilot/src/dispatcher/run-stage.ts`
- Modify: `packages/autopilot/bin/jinn-run-stage.ts`
- Modify: `packages/autopilot/test/dispatcher/run-stage.test.ts`

**Interfaces:**
- Consumes: `StageRunOpts.runtime`, `hermesPythonPath`, `model`, `provider`, and inherited `HERMES_HOME`.
- Produces: `hermesChatArgs(prompt, { model, provider })`, `assertHermesRuntimeFiles`, and runtime-neutral `StageRunResult`.

- [ ] **Step 1: Write failing Hermes invocation-helper tests**

Assert:

```ts
expect(hermesChatArgs('PROMPT', {
  model: 'gpt-5.6-sol',
  provider: 'openai-codex',
})).toEqual([
  HERMES_STATELESS_LAUNCHER,
  'chat', '-q', 'PROMPT', '-Q', '--yolo', '--accept-hooks',
  '--model', 'gpt-5.6-sol',
  '--provider', 'openai-codex',
]);

expect(() => assertHermesRuntimeFiles('/missing/python', () => false))
  .toThrow(/Hermes Python interpreter.*missing/);
```

- [ ] **Step 2: Write failing runtime-stage tests**

Extend `run-stage.test.ts` with:

```ts
it('spawns a fresh stateless Hermes root with the subscription billing guard', async () => {
  const { spawn, calls } = makeSpawn('close-0', 'ok');
  await runStageHeadless({
    ...BASE_OPTS,
    runtime: 'hermes',
    hermesPythonPath: '/opt/hermes/python',
    model: 'gpt-5.6-sol',
    provider: 'openai-codex',
  }, spawn);

  expect(calls[0].cmd).toBe('/opt/hermes/python');
  expect(calls[0].args[0]).toBe(HERMES_STATELESS_LAUNCHER);
  expect(calls[0].args).toContain('chat');
  expect(calls[0].args).toContain('-q');
  expect(calls[0].args[calls[0].args.indexOf('--provider') + 1])
    .toBe('openai-codex');
});

it('reframes the root-stage headless block for Hermes', async () => {
  // Extract the argument after -q.
  expect(prompt).toContain('hermes chat -q');
  expect(prompt).not.toContain('`claude -p` / `--print`');
});
```

Add CLI parsing tests only if `jinn-run-stage` already has a test harness;
otherwise cover its pure runtime validator exported from `run-stage.ts`.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
cd packages/autopilot
yarn test test/dispatcher/hermes-runtime.test.ts test/dispatcher/run-stage.test.ts test/headless.test.ts
```

Expected: FAIL because the runtime helper and Hermes stage mode do not exist.

- [ ] **Step 4: Implement the shared Hermes invocation helper**

Create:

```ts
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

export const HERMES_STATELESS_LAUNCHER = join(
  REPO_ROOT, 'packages', 'autopilot', 'bin', 'jinn-hermes-stateless.py',
);

export const DEFAULT_HERMES_PYTHON = process.platform === 'win32'
  ? join(homedir(), '.hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe')
  : join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python');

export function hermesChatArgs(
  prompt: string,
  opts: { model: string; provider: string },
): string[] {
  return [
    HERMES_STATELESS_LAUNCHER,
    'chat', '-q', prompt, '-Q', '--yolo', '--accept-hooks',
    '--model', opts.model,
    '--provider', opts.provider,
  ];
}

export function assertHermesRuntimeFiles(
  pythonPath: string,
  exists: (path: string) => boolean = existsSync,
): void {
  if (!exists(pythonPath)) {
    throw new Error(
      `[autopilot] Hermes Python interpreter is missing: ${pythonPath}. ` +
      'Set JINN_DISPATCHER_HERMES_PYTHON to the Hermes venv Python path.',
    );
  }
  if (!exists(HERMES_STATELESS_LAUNCHER)) {
    throw new Error(
      `[autopilot] Hermes stateless launcher is missing: ${HERMES_STATELESS_LAUNCHER}.`,
    );
  }
}
```

- [ ] **Step 5: Add runtime-specific headless rendering**

Expose:

```ts
export type HeadlessRuntime = 'claude' | 'hermes';

export function headlessOverrideFor(runtime: HeadlessRuntime): string {
  const block = headlessOverride();
  return runtime === 'hermes'
    ? block.replace(CLAUDE_CLI_TOKEN, '`hermes chat -q`')
    : block;
}
```

Use it from both `buildHermesHeadlessPrompt` and `buildStagePrompt`.

- [ ] **Step 6: Implement the runtime-aware stage runner**

Extend `StageRunOpts`:

```ts
runtime?: 'claude' | 'hermes';
hermesPythonPath?: string;
provider?: string;
```

Resolve Hermes values from explicit options first, then:

```ts
const pythonPath =
  opts.hermesPythonPath ?? process.env.JINN_DISPATCHER_HERMES_PYTHON;
const model = opts.model ?? process.env.JINN_DISPATCHER_HERMES_MODEL;
const provider = opts.provider ?? process.env.JINN_DISPATCHER_HERMES_PROVIDER;
```

Fail with a named missing value rather than falling back to inference. Spawn
Claude exactly as before; spawn Hermes with `pythonPath` and
`hermesChatArgs(prompt, { model, provider })`. Both use the same cwd, captured
stdio, timeout, and `StageRunResult`.

- [ ] **Step 7: Parse `--runtime` in the CLI**

Read:

```ts
const runtime = flag('--runtime') ??
  process.env.JINN_IMPLEMENT_ISSUE_ADAPTER ??
  'claude';
```

Reject any value other than `claude` or `hermes`, then pass it to
`runStageHeadless`.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
cd packages/autopilot
yarn test test/dispatcher/hermes-runtime.test.ts test/dispatcher/run-stage.test.ts test/headless.test.ts
```

Expected: PASS, with existing Claude tests unchanged.

- [ ] **Step 9: Commit the runtime-aware stage path**

```bash
git add packages/autopilot/src/dispatcher/hermes-runtime.ts \
  packages/autopilot/test/dispatcher/hermes-runtime.test.ts \
  packages/autopilot/src/headless.ts \
  packages/autopilot/test/headless.test.ts \
  packages/autopilot/src/dispatcher/run-stage.ts \
  packages/autopilot/bin/jinn-run-stage.ts \
  packages/autopilot/test/dispatcher/run-stage.test.ts
git commit -m "feat(autopilot): run Hermes stages as fresh roots"
```

---

### Task 4: Route coordinators through the canonical skill and launcher

**Files:**
- Modify: `packages/autopilot/src/dispatcher/types.ts`
- Modify: `packages/autopilot/scripts/run-autopilot.ts`
- Modify: `packages/autopilot/src/dispatcher/dispatch.ts`
- Modify: `packages/autopilot/test/dispatcher/dispatch.test.ts`
- Modify: `packages/autopilot/test/dispatcher/review-dispatch.test.ts`
- Modify: `packages/autopilot/test/dispatcher/merge-prep-dispatch.test.ts`
- Modify: `packages/autopilot/test/dispatcher/merge-prep-loop.test.ts`
- Modify: `packages/autopilot/test/dispatcher/review-loop.test.ts`

**Interfaces:**
- Consumes: `DispatcherConfig.hermesPythonPath` and the shared `hermesChatArgs`.
- Produces: coordinator environment consumed by the canonical skill and Hermes `stage:run`.

- [ ] **Step 1: Write the failing dispatcher expectations**

Change Hermes dispatch tests to expect:

```ts
expect(calls[0].cmd).toBe('/opt/hermes/python');
expect(calls[0].args[0]).toBe(HERMES_STATELESS_LAUNCHER);
expect(prompt).toContain('Use the implement-issue skill');
expect(prompt).toContain('references/hermes.md');
expect(prompt).not.toContain('implement-issue-hermes');

const env = calls[0].opts.env as Record<string, string>;
expect(env.JINN_IMPLEMENT_ISSUE_ADAPTER).toBe('hermes');
expect(env.JINN_DISPATCHER_HERMES_PYTHON).toBe('/opt/hermes/python');
expect(env.JINN_DISPATCHER_HERMES_MODEL).toBe('gpt-5.6-sol');
expect(env.JINN_DISPATCHER_HERMES_PROVIDER).toBe('openai-codex');
```

Add the Claude regression:

```ts
expect(prompt).toContain('references/claude.md');
expect(env.JINN_IMPLEMENT_ISSUE_ADAPTER).toBe('claude');
```

- [ ] **Step 2: Run dispatcher tests and verify RED**

Run:

```bash
cd packages/autopilot
yarn test test/dispatcher/dispatch.test.ts
```

Expected: FAIL because dispatch still spawns the direct Hermes CLI and names the sibling skill.

- [ ] **Step 3: Replace `hermesPath` with `hermesPythonPath`**

In `DispatcherConfig`:

```ts
/** Python interpreter from the Hermes installation. Source:
 * `JINN_DISPATCHER_HERMES_PYTHON`. */
hermesPythonPath: string;
```

Set `DEFAULT_CONFIG.hermesPythonPath = DEFAULT_HERMES_PYTHON`. Update every
test configuration literal. Replace the runner environment override with
`JINN_DISPATCHER_HERMES_PYTHON`.

- [ ] **Step 4: Validate and log the launcher at boot**

When any implementer rule selects Hermes:

```ts
assertHermesRuntimeFiles(cfg.hermesPythonPath);
console.log(
  `[autopilot] hermes coordinator routing ACTIVE ` +
  `(model=${cfg.hermesModel}, provider=${cfg.hermesProvider}, ` +
  `python=${cfg.hermesPythonPath})`,
);
```

Keep the existing org-prefixed-model warning.

- [ ] **Step 5: Invoke the canonical skill with an explicit adapter**

Build the scenario with:

```ts
const skill = 'implement-issue';
const adapter = isHermes ? 'hermes' : 'claude';
const scenario = [
  `Use the implement-issue skill on issue #${number}.`,
  `Runtime adapter: ${adapter}. Read \`.claude/skills/implement-issue/references/${adapter}.md\` before dispatching any stage.`,
  // existing issue, implementer directive, worktree, and stack-base lines
].join('\n');
```

Use `buildHermesHeadlessPrompt` only to reframe the shared headless block, not
to select a different skill.

- [ ] **Step 6: Spawn the coordinator through the stateless launcher**

Use:

```ts
result = spawn(
  cfg.hermesPythonPath,
  hermesChatArgs(fullPrompt, {
    model: cfg.hermesModel,
    provider: cfg.hermesProvider,
  }),
  {
    cwd: worktreePath,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    logPath,
    startedAtMarkerPath,
    ...identityEnv,
    env: {
      ...identityEnv.env,
      HERMES_HOME: hermesHome,
      JINN_AUTOPILOT_PACKAGE_DIR: AUTOPILOT_PACKAGE_DIR,
      JINN_IMPLEMENT_ISSUE_ADAPTER: 'hermes',
      JINN_DISPATCHER_HERMES_PYTHON: cfg.hermesPythonPath,
      JINN_DISPATCHER_HERMES_MODEL: cfg.hermesModel,
      JINN_DISPATCHER_HERMES_PROVIDER: cfg.hermesProvider,
    },
  },
);
```

Set `JINN_IMPLEMENT_ISSUE_ADAPTER=claude` in the Claude spawn environment.

- [ ] **Step 7: Run dispatcher and related tests and verify GREEN**

Run:

```bash
cd packages/autopilot
yarn test test/dispatcher/dispatch.test.ts \
  test/dispatcher/review-dispatch.test.ts \
  test/dispatcher/merge-prep-dispatch.test.ts \
  test/dispatcher/merge-prep-loop.test.ts \
  test/dispatcher/review-loop.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit canonical coordinator dispatch**

```bash
git add packages/autopilot/src/dispatcher/types.ts \
  packages/autopilot/scripts/run-autopilot.ts \
  packages/autopilot/src/dispatcher/dispatch.ts \
  packages/autopilot/test/dispatcher/dispatch.test.ts \
  packages/autopilot/test/dispatcher/review-dispatch.test.ts \
  packages/autopilot/test/dispatcher/merge-prep-dispatch.test.ts \
  packages/autopilot/test/dispatcher/merge-prep-loop.test.ts \
  packages/autopilot/test/dispatcher/review-loop.test.ts
git commit -m "refactor(autopilot): select implement-issue runtime adapter"
```

---

### Task 5: Correct the process-depth contract and run the local gate

**Files:**
- Modify: `packages/autopilot/src/dispatcher/hermes-home.ts`
- Modify: `packages/autopilot/test/dispatcher/hermes-home.test.ts`

**Interfaces:**
- Consumes: fresh-root stage behavior from Task 3.
- Produces: generated Hermes config and comments that no longer claim the overall pipeline is flat.

- [ ] **Step 1: Confirm the existing process-depth regression**

Run:

```bash
cd packages/autopilot
yarn test test/dispatcher/hermes-home.test.ts
```

Expected: PASS; this establishes that generated config currently omits
`max_spawn_depth`. The change in this task corrects the documented topology,
not the generated value.

- [ ] **Step 2: Correct the test name and topology assertion**

Replace the old flat-pipeline test name with:

```ts
it('keeps process-local depth at one because depth-needing stages are fresh roots', () => {
  const { yaml } = prep('Medium');
  expect(yaml).not.toContain('max_spawn_depth');
  expect(readFileSync(HERMES_ADAPTER_PATH, 'utf8'))
    .toContain('new depth-0 Hermes process');
});
```

- [ ] **Step 3: Replace the incorrect flat-topology explanation**

The config comment must state:

```ts
// Hermes's default max_spawn_depth=1 is process-local. Lightweight coordinator
// children are leaves, while Stages 1/3/4/5 launch as fresh depth-0 OS
// processes through stage:run and may each fan out their own depth-1 children.
// Do not raise depth to compensate for launching a stage incorrectly as a child.
delegation: { max_concurrent_children: 3 },
```

- [ ] **Step 4: Run focused and full local verification**

Run:

```bash
cd packages/autopilot
yarn test test/dispatcher/hermes-home.test.ts
yarn typecheck
yarn test
```

Expected: typecheck exits 0 and the complete Vitest suite passes.

- [ ] **Step 5: Inspect the final diff and preserve the unrelated file**

Run:

```bash
git diff --check
git status --short
git diff "$(git merge-base origin/next HEAD)"..HEAD -- \
  .claude/skills/implement-issue \
  packages/autopilot \
  docs/superpowers
```

Confirm `docs/runbooks/swe-rebench-v2-public-testnet.md` remains modified but
unstaged and unchanged by this work.

- [ ] **Step 6: Commit the corrected depth contract**

```bash
git add packages/autopilot/src/dispatcher/hermes-home.ts \
  packages/autopilot/test/dispatcher/hermes-home.test.ts
git commit -m "docs(autopilot): explain Hermes root-stage depth"
```

---

### Task 6: Prove the full Hermes route and publish the branch

**Files:**
- No planned source edits; failures return to the relevant test-first task.

**Interfaces:**
- Consumes: the completed branch and a triage-ready Low-effort issue.
- Produces: live session evidence, a pushed branch, and a draft PR against `next`.

- [ ] **Step 1: Run the direct launcher smoke**

Run the checked-in launcher with the installed Hermes Python, normal
`HERMES_HOME`, bare model, and explicit provider. The prompt must delegate one
child and return `PARENT_RECEIVED: HERMES_SYNC_CHILD_OK`.

Expected: exit 0 and the exact success marker.

- [ ] **Step 2: Re-check the candidate issue before mutating its board state**

Inspect issue, Project fields, existing PR links, and reality-check verdict.
Use issue `#1822` only if it is still the parked issue from the failed Hermes
run and has no new external work. Otherwise choose exactly one triage-ready
Low-effort issue. Do not dispatch more than one.

- [ ] **Step 3: Restore the parked issue only when evidence supports it**

If `#1822` is unchanged and parked solely because of the fixed lifecycle bug,
set `Blocked on: Nothing` and `Status: Todo`, leaving an issue comment that the
known Hermes one-shot defect is fixed locally and the issue is being retried.
If its state has changed for another reason, do not overwrite it.

- [ ] **Step 4: Run one live Autopilot cycle**

```bash
cd packages/autopilot
JINN_DISPATCHER_IMPLEMENTER_RULES='[{"effort":"Low","implementer":"hermes"}]' \
  yarn autopilot --once --cap 1
```

Tail `~/.jinn-client/autopilot/sessions/<N>.log`.

- [ ] **Step 5: Verify the terminal state from external evidence**

Confirm:

1. Boot log names the Hermes coordinator, bare model, explicit provider, and Python launcher.
2. Coordinator spawn goes through the stateless launcher.
3. Triage returns `clear`.
4. Stages 1, 3, 4, and 5 launch as fresh Hermes roots.
5. At least one root stage uses native `delegate_task` fan-out and receives results.
6. `git -C <worktree> log origin/next..HEAD --oneline` shows commits.
7. A draft PR exists with `Closes #N` and `engine:review`.
8. Project `Status` is `In Review`.
9. The guarded worktree cleanup completed, or any refusal is reported honestly.

If the pipeline cleanly escalates, verify `Blocked on: Human`, report the exact
finding, and do not claim PR success.

- [ ] **Step 6: Re-run the local gate after any live-run fix**

```bash
cd packages/autopilot
yarn typecheck
yarn test
```

Expected: both exit 0.

- [ ] **Step 7: Push and open the feature PR**

Push `feat/autopilot-hermes-implementer`, then open a draft PR to `next`.
Include:

- The canonical-skill/runtime-adapter design.
- The stateless-launcher rationale and upstream issue links.
- Typecheck and full test counts.
- Direct delegation smoke evidence.
- Full live issue number and observed terminal state.
- The existing feature commits and `Closes #<tracking-issue>` only if a real
  tracking issue is filed or identified.

Do not include or stage `docs/runbooks/swe-rebench-v2-public-testnet.md`.
