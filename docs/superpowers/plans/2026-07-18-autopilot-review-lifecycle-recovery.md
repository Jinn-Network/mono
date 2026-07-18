# Autopilot Review Lifecycle Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make review slots release immediately when their detached review processes exit, retain bounded crash recovery, restore reviewer metadata operations with the existing token, and recover issue #1816 without regenerating its implementation.

**Architecture:** The existing injectable `SpawnFn` gains an optional exit callback registered by the production adapter before `ChildProcess.unref()`. `dispatchReview` owns exact-path cleanup for its `pr-<N>` worktree, while `runReviewCycle` retains a two-hour age reaper for callbacks lost across dispatcher crashes or restarts. Review verdict labels move from `gh pr edit` to repository REST calls so the current `repo`-scoped reviewer token is sufficient.

**Tech Stack:** TypeScript, Node.js child processes, Vitest, Git worktrees, GitHub CLI/REST, GitHub Actions YAML.

## Global Constraints

- Keep the shared Autopilot supervisor paused until the repaired code is merged into `next`.
- Use test-first development: every behavior change must be preceded by a failing focused test.
- Cleanup may target only `join(WORKTREES_BASE, "pr-<validated PR number>")`.
- Never remove a review worktree while its leased reviewer PID is alive.
- Immediate cleanup is best-effort; cleanup failure must not terminate the dispatcher.
- Preserve the two-hour reaper as restart/crash fallback.
- Fallback cleanup requires a valid persisted ownership lease, a provably dead
  reviewer PID, a known age beyond two hours, and the exact canonical path.
- Unknown-age or unowned review worktrees must never be age-reaped.
- Do not include #1816's untracked `.tasks-1816-design.md` or `.tasks-1816-plan.md` in its PR.
- Do not auto-merge #1816; its release-workflow change retains the issue's human-review requirement.
- Preserve unrelated local changes in every existing checkout.

---

### Task 1: Add process-exit cleanup to the spawn contract

**Files:**
- Modify: `packages/autopilot/src/dispatcher/dispatch.ts`
- Modify: `packages/autopilot/src/dispatcher/review-dispatch.ts`
- Modify: `packages/autopilot/scripts/run-autopilot.ts`
- Modify: `packages/autopilot/test/dispatcher/review-dispatch.test.ts`

**Interfaces:**
- Produces: `SpawnExitHandler`
- Produces: optional `SpawnFn` option `onExit?: SpawnExitHandler`
- Consumes: existing `CommandRunner`, `WORKTREES_BASE`, and dispatcher-derived review worktree path
- Behavior: the production spawn adapter attaches `onExit` before `child.unref()`

- [ ] **Step 1: Write the failing review-dispatch cleanup tests**

Add tests that capture and invoke the exit callback:

```ts
it('removes only its exact pr-N worktree after the review process exits', async () => {
  const { runner, calls: runnerCalls } = makeRunner();
  const { spawn, calls: spawnCalls } = makeSpawn();

  await dispatchReview(PR, CFG, { runner, spawn });

  const onExit = spawnCalls[0].opts.onExit as
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;
  expect(onExit).toBeTypeOf('function');

  onExit?.(0, null);
  await vi.waitFor(() => {
    expect(runnerCalls).toContainEqual({
      cmd: 'git',
      args: ['worktree', 'remove', '--force', EXPECTED_WT],
    });
  });
});

it('logs cleanup failure without throwing from the child exit event', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { spawn, calls: spawnCalls } = makeSpawn();
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return '';
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
      throw new Error('locked');
    }
    if (cmd === 'git') return '';
    throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
  };

  await dispatchReview(PR, CFG, { runner, spawn });
  const onExit = spawnCalls[0].opts.onExit as
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;

  expect(() => onExit?.(1, null)).not.toThrow();
  await vi.waitFor(() => {
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('review #42 worktree cleanup failed'),
      expect.any(Error),
    );
  });
  error.mockRestore();
});
```

Import `vi` from Vitest before adding these tests.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/autopilot
yarn vitest run test/dispatcher/review-dispatch.test.ts
```

Expected: FAIL because `opts.onExit` is undefined.

- [ ] **Step 3: Extend the spawn contract**

In `dispatch.ts`, add:

```ts
export type SpawnExitHandler = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;
```

Add this property to the `SpawnFn` option type:

```ts
onExit?: SpawnExitHandler;
```

- [ ] **Step 4: Register review cleanup at dispatch**

In `dispatchReview`, pass this callback in the spawn options:

```ts
onExit: (_code, _signal) => {
  void runner('git', ['worktree', 'remove', '--force', worktreePath]).catch((err) => {
    console.error(
      `[autopilot] review #${pr.number} worktree cleanup failed (${worktreePath}):`,
      err,
    );
  });
},
```

The callback uses only `worktreePath`, which was computed from
`join(WORKTREES_BASE, \`pr-${pr.number}\`)`.

- [ ] **Step 5: Wire the production child exit event before detachment**

In both production `SpawnFn` adapters in `run-autopilot.ts`, destructure the
callback before passing options to Node:

```ts
const { onExit, ...spawnOpts } = opts;
const child = spawn(cmd, args, { ...spawnOpts, stdio } as SpawnOptions);
if (onExit != null) child.once('exit', onExit);
if (child.pid != null) child.unref();
```

For the review-pass adapter, use the same ordering:

```ts
const { onExit, ...spawnOpts } = opts;
const child = spawn(cmd, args, spawnOpts as SpawnOptions);
if (onExit != null) child.once('exit', onExit);
if (child.pid != null) child.unref();
```

Do not pass the custom `onExit` key to Node's `spawn`.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```bash
cd packages/autopilot
yarn vitest run test/dispatcher/review-dispatch.test.ts
```

Expected: all review-dispatch tests pass.

- [ ] **Step 7: Commit the immediate lifecycle behavior**

```bash
git add \
  packages/autopilot/src/dispatcher/dispatch.ts \
  packages/autopilot/src/dispatcher/review-dispatch.ts \
  packages/autopilot/scripts/run-autopilot.ts \
  packages/autopilot/test/dispatcher/review-dispatch.test.ts
git commit -m "fix(autopilot): release review worktrees on process exit"
```

### Task 2: Add the timeout reaper as crash/restart fallback

**Files:**
- Modify: `packages/autopilot/src/dispatcher/review-loop.ts`
- Modify: `packages/autopilot/scripts/run-autopilot.ts`
- Modify: `packages/autopilot/test/dispatcher/review-loop.test.ts`

**Interfaces:**
- Produces: `REVIEW_REAP_MS = 2 * 60 * 60 * 1000`
- Extends: `ReviewCycleReport.reaped: number[]`
- Extends: `ReviewCycleDeps.removeWorktree` and injectable `now`
- Consumes: `InFlightReview.startedAt`

- [ ] **Step 1: Port the two failing regression tests from PR #1778**

Add `removeWorktree: async () => {}` to all existing `runReviewCycle` test
dependencies, then add:

```ts
it('reaps a stale worktree and dispatches a waiting review in the same cycle', async () => {
  const now = 10_000_000_000;
  const stale: InFlightReview = {
    prNumber: 20,
    branch: 'b/20',
    worktreePath: '/pr-20',
    pid: null,
    startedAt: now - REVIEW_REAP_MS - 1,
  };
  const fresh: InFlightReview = {
    prNumber: 21,
    branch: 'b/21',
    worktreePath: '/pr-21',
    pid: null,
    startedAt: now - 1_000,
  };
  const unknown: InFlightReview = {
    prNumber: 22,
    branch: 'b/22',
    worktreePath: '/pr-22',
    pid: null,
    startedAt: 0,
  };
  const removed: number[] = [];
  const dispatched: number[] = [];

  const report = await runReviewCycle({
    prSource: { poll: async () => [pr(30)] },
    cfg: { ...CFG, reviewCap: 3 },
    now: () => now,
    deriveReviewInFlight: async () => ({
      inFlight: [stale, fresh, unknown],
      drift: [],
    }),
    removeWorktree: async (w) => { removed.push(w.prNumber); },
    dispatchReview: async (p) => {
      dispatched.push(p.number);
      return {
        prNumber: p.number,
        branch: p.headRefName,
        worktreePath: `/pr-${p.number}`,
        pid: 1,
        startedAt: now,
      };
    },
  });

  expect(removed).toEqual([20]);
  expect(report.reaped).toEqual([20]);
  expect(dispatched).toEqual([30]);
});

it('keeps a failed reap counted as live', async () => {
  const now = 10_000_000_000;
  const stale: InFlightReview = {
    prNumber: 40,
    branch: 'b/40',
    worktreePath: '/pr-40',
    pid: null,
    startedAt: now - REVIEW_REAP_MS - 1,
  };
  const dispatched: number[] = [];

  const report = await runReviewCycle({
    prSource: { poll: async () => [pr(41), pr(42)] },
    cfg: { ...CFG, reviewCap: 2 },
    now: () => now,
    deriveReviewInFlight: async () => ({ inFlight: [stale], drift: [] }),
    removeWorktree: async () => { throw new Error('locked'); },
    dispatchReview: async (p) => {
      dispatched.push(p.number);
      return {
        prNumber: p.number,
        branch: p.headRefName,
        worktreePath: `/pr-${p.number}`,
        pid: 1,
        startedAt: now,
      };
    },
  });

  expect(report.reaped).toEqual([]);
  expect(dispatched).toEqual([41]);
  expect(report.skippedForCap).toBe(1);
});
```

Import `REVIEW_REAP_MS` from `review-loop.ts`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/autopilot
yarn vitest run test/dispatcher/review-loop.test.ts
```

Expected: compile/test failure because `REVIEW_REAP_MS`, `removeWorktree`,
`now`, and `reaped` do not exist.

- [ ] **Step 3: Implement the fallback reaper**

In `review-loop.ts`:

```ts
export const REVIEW_REAP_MS = 2 * 60 * 60 * 1000;
```

Extend the report and dependencies:

```ts
reaped: number[];
removeWorktree(w: InFlightReview): Promise<void>;
now?(): number;
```

Before building the exclusion set and dispatch budget, partition `inFlight`
into `live` and `reaped`:

```ts
const now = deps.now ?? Date.now;
const live: InFlightReview[] = [];
const reaped: number[] = [];

for (const review of inFlight) {
  const stale =
    review.startedAt > 0 &&
    now() - review.startedAt > REVIEW_REAP_MS;
  if (!stale) {
    live.push(review);
    continue;
  }

  try {
    await deps.removeWorktree(review);
    reaped.push(review.prNumber);
  } catch (err) {
    console.error(
      `[review-loop] reap failed for PR #${review.prNumber} (continuing):`,
      err,
    );
    live.push(review);
  }
}
```

Use `live`, not `inFlight`, for the exclusion set and
`cfg.reviewCap - live.length`. Include `reaped` in the returned report.

- [ ] **Step 4: Wire and report fallback cleanup**

Pass from `runReviewPass`:

```ts
removeWorktree: async (review) => {
  await runner('git', [
    'worktree',
    'remove',
    '--force',
    review.worktreePath,
  ]);
},
```

Log successful reaps:

```ts
if (report.reaped.length > 0) {
  console.log(
    `[autopilot] review reaped stale worktree → PR #${report.reaped.join(', #')}`,
  );
}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
cd packages/autopilot
yarn vitest run test/dispatcher/review-loop.test.ts
```

Expected: all review-loop tests pass, including dispatch-failure isolation
already present on current `next`.

- [ ] **Step 6: Commit the fallback lifecycle**

```bash
git add \
  packages/autopilot/src/dispatcher/review-loop.ts \
  packages/autopilot/scripts/run-autopilot.ts \
  packages/autopilot/test/dispatcher/review-loop.test.ts
git commit -m "fix(autopilot): reap orphaned review worktrees"
```

### Task 3: Make review verdict labels work with the existing token

**Files:**
- Create: `packages/autopilot/test/review-pr-skill.test.ts`
- Modify: `.claude/skills/review-pr/SKILL.md`

**Interfaces:**
- Consumes: `GH_TOKEN` with `repo` scope
- Produces: REST-based add/remove label commands
- Preserves: `gh pr review` and `gh pr ready`

- [ ] **Step 1: Write a failing skill-contract test**

Create:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const skill = readFileSync(
  join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'),
  'utf8',
);

describe('review-pr verdict metadata', () => {
  it('uses repo-scoped REST label operations instead of gh pr edit', () => {
    expect(skill).toContain(
      'repos/Jinn-Network/mono/issues/<N>/labels',
    );
    expect(skill).toContain(
      'repos/Jinn-Network/mono/issues/<N>/labels/review%3Aapproved',
    );
    expect(skill).toContain(
      'repos/Jinn-Network/mono/issues/<N>/labels/review%3Achanges-requested',
    );
    expect(skill).not.toContain('gh pr edit <N>');
  });
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
cd packages/autopilot
yarn vitest run test/review-pr-skill.test.ts
```

Expected: FAIL because the skill still contains `gh pr edit`.

- [ ] **Step 3: Replace label commands with REST**

For each verdict, add the desired label:

```bash
gh api --method POST \
  repos/Jinn-Network/mono/issues/<N>/labels \
  -f 'labels[]=review:approved'
```

Remove the opposite label only when present:

```bash
if gh api repos/Jinn-Network/mono/issues/<N> \
  --jq '.labels[].name' |
  grep -Fxq 'review:changes-requested'; then
  gh api --method DELETE \
    repos/Jinn-Network/mono/issues/<N>/labels/review%3Achanges-requested
fi
```

Use the symmetric commands for `review:changes-requested`. Advisory mode adds
`review:needs-human` with the same POST endpoint. Keep `gh pr review` and
`gh pr ready` unchanged.

- [ ] **Step 4: Run the contract test and verify GREEN**

Run:

```bash
cd packages/autopilot
yarn vitest run test/review-pr-skill.test.ts
```

Expected: pass.

- [ ] **Step 5: Verify the reviewer token read-only**

Run:

```bash
set -a
. "$HOME/.jinn-client/eng-loop/secrets.env"
set +a
GH_TOKEN="$JINN_REVIEW_GH_TOKEN" \
  gh api repos/Jinn-Network/mono/issues/1764 --jq '.number'
```

Expected: `1764`. Do not mutate a live PR during this verification step.

- [ ] **Step 6: Commit the credential-compatible metadata path**

```bash
git add \
  .claude/skills/review-pr/SKILL.md \
  packages/autopilot/test/review-pr-skill.test.ts
git commit -m "fix(autopilot): use REST for review verdict labels"
```

### Task 4: Verify, publish, review, and merge the lifecycle repair

**Files:**
- Verify all files changed in Tasks 1–3
- Preserve: `docs/superpowers/specs/2026-07-18-autopilot-review-lifecycle-recovery-design.md`
- Create: GitHub PR metadata only

**Interfaces:**
- Produces: one focused repair PR targeting `next`
- Supersedes: PR #1778
- Closes: issue #1764

- [ ] **Step 1: Run focused tests together**

```bash
cd packages/autopilot
yarn vitest run \
  test/dispatcher/review-dispatch.test.ts \
  test/dispatcher/review-loop.test.ts \
  test/review-pr-skill.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run package verification**

```bash
cd packages/autopilot
yarn typecheck
yarn test
```

Expected: both exit 0.

- [ ] **Step 3: Check patch hygiene**

```bash
git diff --check origin/next...HEAD
git status --short
```

Expected: no whitespace errors and no unrelated files.

- [ ] **Step 4: Push the repair branch**

```bash
git push -u origin codex/review-lifecycle-design
```

- [ ] **Step 5: Open the repair PR**

Create a draft PR targeting `next` with:

- title: `fix(autopilot): release completed review worktrees`
- label: `engine:review`
- body covering immediate exit cleanup, two-hour fallback, REST verdict labels,
  verification evidence, `Closes #1764`, and `Supersedes #1778`.

- [ ] **Step 6: Review independently**

Run the repository `review-pr` workflow with independent code and security
reviewers. Address blocking findings with new commits and rerun focused/full
verification.

- [ ] **Step 7: Merge and verify `next`**

After approval and green CI, merge the repair PR into `next`, close superseded
PR #1778 with a pointer to the replacement, and verify:

```bash
git fetch origin next
git log origin/next -1 --oneline
```

Expected: the merged lifecycle repair is at or reachable from `origin/next`.

### Task 5: Clear the existing stale review slots and restart safely

**Files:**
- Remove only worktrees:
  - `/Users/adrianobradley/life's-work/jinn-mono_worktrees/pr-1723`
  - `/Users/adrianobradley/life's-work/jinn-mono_worktrees/pr-1726`
  - `/Users/adrianobradley/life's-work/jinn-mono_worktrees/pr-1727`
- Reuse: `/Users/adrianobradley/.jinn-client/eng-loop/supervise.sh`

**Interfaces:**
- Consumes: merged repaired `origin/next`
- Produces: running persistent `com.jinn.eng-loop` user service

- [ ] **Step 1: Reconfirm no live review process**

```bash
ps ax -o pid=,command= |
  rg 'pr-(1723|1726|1727)|review-pr.*(1723|1726|1727)' || true
```

Expected: no review worker; ignore only the inspection command itself.

- [ ] **Step 2: Reconfirm each checkout is clean**

```bash
for n in 1723 1726 1727; do
  git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/pr-$n" \
    status --porcelain
done
```

Expected: no output.

- [ ] **Step 3: Remove exactly the three stale worktrees**

```bash
for n in 1723 1726 1727; do
  git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/eng-loop-runner" \
    worktree remove \
    "/Users/adrianobradley/life's-work/jinn-mono_worktrees/pr-$n"
done
```

Do not use `--force` because Step 2 proved they are clean.

- [ ] **Step 4: Restart the persistent supervisor with the full PATH**

Submit `com.jinn.eng-loop` through `launchctl` using:

```text
/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin
/Users/adrianobradley/.local/bin
/opt/homebrew/bin
/usr/local/bin
/usr/bin
/bin
/usr/sbin
/sbin
```

The supervisor resets its runner to repaired `origin/next` before launching.

- [ ] **Step 5: Verify runtime progress**

Observe:

- runner HEAD equals `origin/next`;
- review dispatch creates up to three new `pr-<N>` worktrees;
- exited review processes remove their worktrees immediately;
- later reviews dispatch without waiting two hours;
- an approve-eligible PR receives approval and becomes non-draft;
- merge sweep either auto-merges it or reports a later specific gate.

If label operations fail, capture the exact REST response and keep the loop
paused until resolved.

### Task 6: Recover issue #1816 into a PR

**Files:**
- Existing worktree: `/Users/adrianobradley/life's-work/jinn-mono_worktrees/1816`
- Existing committed files:
  - `.github/scripts/jinn-plugin-split.mjs`
  - `.github/scripts/jinn-plugin-split.test.mjs`
  - `.github/workflows/jinn-plugin-split.yml`
- Exclude:
  - `.tasks-1816-design.md`
  - `.tasks-1816-plan.md`

**Interfaces:**
- Consumes commits:
  - `76efd6fa9 chore(plugin-split): mirror jinn plugin to Jinn-Network/jinn-plugin on main promote`
  - `ba848bc23 chore(plugin-split): apply review hardening + simplifications`
- Produces: one draft PR targeting `next`, referencing #1816

- [ ] **Step 1: Preserve and verify the exact recovery source**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/1816" \
  log --oneline --max-count=3
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/1816" \
  status --short
```

Expected: the two commits above and only the two excluded untracked scratch
files.

- [ ] **Step 2: Fetch and rebase onto current `next`**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/1816" \
  fetch origin next
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/1816" \
  rebase origin/next
```

Expected: clean rebase. If any conflict appears, stop and inspect semantics
before resolving.

- [ ] **Step 3: Rerun focused verification**

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/1816"
node --test .github/scripts/jinn-plugin-split.test.mjs
ruby -ryaml -e \
  'YAML.load_file(".github/workflows/jinn-plugin-split.yml"); puts "YAML OK"'
git diff --check origin/next...HEAD
```

Expected: 10 tests pass, `YAML OK`, and no whitespace errors.

- [ ] **Step 4: Push the recovery branch**

```bash
git push -u origin \
  HEAD:chore/1816-slim-repo-release-channel-jinn-network-jinn-plugin-split-and-r2
```

- [ ] **Step 5: Open the #1816 PR**

Open a draft PR targeting `next`:

- title: `chore(plugin-split): publish the slim Jinn plugin repository`
- label: `engine:review`
- body: summarize split source, idempotency, secret name, test evidence, and
  manual post-merge promote/install validation;
- relationship: `Refs #1816`, not `Closes`, because live promote/install
  validation remains.

Explicitly state that a human must review the release-workflow change.

- [ ] **Step 6: Put #1816 into the review lane**

Update its project status from `Human` to `In Review` and `Blocked on` from
`Human` to `Nothing`, then add an issue comment linking the recovered PR and
explaining that no work was regenerated.

- [ ] **Step 7: Stop at the human merge gate**

Do not auto-merge #1816. Confirm its CI and independent engine review are
complete, then hand the final workflow review to the human operator.

### Task 7: Final live acceptance

**Files:**
- Inspect logs only:
  - `/Users/adrianobradley/.jinn-client/eng-loop/dispatcher.log`
  - `/Users/adrianobradley/.jinn-client/autopilot/sessions/*.log`

**Interfaces:**
- Produces: evidence that the review-to-merge loop no longer wedges

- [ ] **Step 1: Capture one complete review lifecycle**

Record timestamps showing:

```text
review-pr dispatched
review process exited
review worktree removed
PR approved and ready
auto-merged
```

The PR used for auto-merge validation must not touch a code-owned path.

- [ ] **Step 2: Confirm capacity remains available**

After one batch completes, verify the next waiting review dispatches in the
following cycle without waiting for `REVIEW_REAP_MS`.

- [ ] **Step 3: Confirm fallback remains armed**

Use unit-test evidence for the two-hour orphan fallback; do not intentionally
crash a live review process in production.

- [ ] **Step 4: Report final state**

Report:

- lifecycle repair PR and merge commit;
- superseded #1778 disposition;
- number of stale worktrees removed;
- PR used to prove auto-merge;
- #1816 recovered PR URL and remaining human gate;
- any PRs still blocked by code ownership, CI, conflicts, or missing labels.
