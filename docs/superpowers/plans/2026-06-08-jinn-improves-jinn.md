# Jinn improves Jinn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate, on a held-out slate of real merged `Jinn-Network/mono` PRs, that a learned harness solves real coding tasks at ≥30% lower inference cost per solved task than the same base model with a frozen baseline harness — Milestone #4.

**Architecture:** Reuse the entire shipped measurement floor (`jinn eval` orchestrator, Wilson/McNemar comparison, freeze-fence, `eval_results` store, `harvestHarnessUsage`). Add one new SolverType (`jinn-repo.v1`) whose tasks are real merged PRs and whose evaluator is **repo-native** (checkout `mono@base_commit` in a throwaway git worktree, apply candidate patch + the PR's own test files, run targeted `vitest`, parse PASS/FAIL). The "with-harness vs without-harness" comparison is the existing child-vs-parent checkpoint eval, where the baseline is an empty/initial `implStateDir` checkpoint — no new comparison machinery.

**Tech Stack:** TypeScript, Node 22, Yarn, Vitest, viem/Anvil (existing repro pattern), git worktrees, the existing `jinn` CLI + eval orchestrator.

**Spec:** [`spec/2026-06-08-jinn-improves-jinn.md`](../../../spec/2026-06-08-jinn-improves-jinn.md) · GitHub Discussion [#1123](https://github.com/Jinn-Network/mono/discussions/1123) · Milestone [#4](https://github.com/Jinn-Network/mono/milestone/4).

---

## Program overview (four plans)

This milestone is four independent subsystems. Per the writing-plans scope rule, each is its own plan producing working, testable software. **P1 and P2 are fleshed below**; P3–P4 are scoped and become their own plans once P1/P2 land (their interfaces depend on the concrete output above).

| Plan | Subsystem | Produces | Depends on |
|---|---|---|---|
| **P1** | `jinn-repo.v1` SolverType: task schema + pool + repo-native evaluator + eval-pipeline wiring | `jinn eval v1 --solver-type jinn-repo` runs and grades a slate of real mono PRs | shipped eval floor |
| **P2** | Held-out slate construction from merged PRs | `held-out-slate.jinn-repo.v1.json` + a pool builder that reduces merged PRs to tasks; ≥1 on-chain-verifiable headline task | P1 |
| **P3** | Cost capture in the eval path | per-eval-task `costUsdMicros` recorded alongside `eval_results` | P1 |
| **P4** | `check-milestone-4.ts` | cost-per-solved-task delta (learned vs baseline checkpoint) + ≥30% gate verdict | P1, P3 |

**What is a "run", not code (out of scope for all four plans):** producing the two checkpoints — a learned `implStateDir` (train the learner on jinn-repo train tasks) and a baseline `implStateDir` (empty/initial) — and invoking `jinn eval` on each. That is operator execution once P1–P4 ship.

---

## P1 file structure

- `client/src/solver-types/jinn-repo.ts` — SolverType definition: task schema, pool loader, generator hook (train-stream). One responsibility: define what a jinn-repo task *is* and where the pool comes from.
- `client/src/solver-types/_jinn-repo-pool.ts` — pool types + on-disk loader (mirrors `_swe-rebench-v2-pool.ts`).
- `client/src/harnesses/impls/jinn-repo-evaluator/repro.ts` — worktree preparation + patch/test application (pure-ish, the risky core).
- `client/src/harnesses/impls/jinn-repo-evaluator/eval-runner.ts` — run `test_cmd`, parse vitest result → PASS/FAIL/could-not-grade.
- `client/src/harnesses/impls/jinn-repo-evaluator/evaluator.ts` — `JinnRepoEvaluator` conforming to the orchestrator's `evaluator` slot.
- `client/src/cli/commands/eval.ts` — modify `runPipeline` to select pool-loader + evaluator by `--solver-type`.
- Test fixtures: `client/test/fixtures/jinn-repo/<instance_id>/` — one real merged PR reduced to `task.json` + `gold-test/` + a known-good `solution.patch` and a known-bad patch.

**Interfaces to conform to (read before coding):**
- Evaluator slot shape: `EvalOrchestratorDeps.evaluator` in [`client/src/eval/orchestrator.ts`](../../../client/src/eval/orchestrator.ts) and the parallel `SweRebenchV2Evaluator` in [`client/src/harnesses/impls/swe-rebench-v2-evaluator/`](../../../client/src/harnesses/impls/swe-rebench-v2-evaluator/). Match the method the orchestrator calls to grade a solution.
- Refuse-to-grade pattern: `EvalCouldNotGradeError` → `SkippableError` in [`eval-runner.ts`](../../../client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts). Reuse the same semantics (infra failure ⇒ `unscorable`, never coerced to FAIL).

---

## P1 tasks

### Task 1: Jinn-repo task schema

**Files:**
- Create: `client/src/solver-types/jinn-repo.ts`
- Test: `client/test/solver-types/jinn-repo.schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { JinnRepoTaskSchema } from '../../src/solver-types/jinn-repo.js';

describe('JinnRepoTaskSchema', () => {
  const valid = {
    schemaVersion: 'jinn-repo.v1',
    instance_id: 'Jinn-Network__mono-1042',
    repo: 'Jinn-Network/mono',
    base_commit: '627e1eb72f0000000000000000000000000000aa',
    merged_pr: 1042,
    language: 'typescript',
    problem_statement: 'Mech safe nonce is stale on retry; refresh it.',
    test_files: ['client/test/adapters/mech/safe.nonce.test.ts'],
    test_cmd: 'yarn vitest run client/test/adapters/mech/safe.nonce.test.ts',
  };

  it('accepts a well-formed task', () => {
    expect(JinnRepoTaskSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a task with no test_files (ungradeable)', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...valid, test_files: [] })).toThrow();
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...valid, schemaVersion: 'jinn-repo.v2' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo.schema.test.ts`
Expected: FAIL — `JinnRepoTaskSchema` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// client/src/solver-types/jinn-repo.ts
import { z } from 'zod';

export const JINN_REPO_SCHEMA_VERSION = 'jinn-repo.v1' as const;

export const JinnRepoTaskSchema = z.object({
  schemaVersion: z.literal(JINN_REPO_SCHEMA_VERSION),
  instance_id: z.string().min(1),
  repo: z.literal('Jinn-Network/mono'),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  merged_pr: z.number().int().positive(),
  language: z.literal('typescript'),
  problem_statement: z.string().min(1),
  // The PR's own test files — the FAIL_TO_PASS gold. A task with none is ungradeable.
  test_files: z.array(z.string().min(1)).min(1),
  // The exact command the evaluator runs (scoped to test_files).
  test_cmd: z.string().min(1),
});

export type JinnRepoTask = z.infer<typeof JinnRepoTaskSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo.schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/jinn-repo.ts client/test/solver-types/jinn-repo.schema.test.ts
git commit -m "feat(jinn-repo): task schema for real merged-PR tasks"
```

---

### Task 2: One real-PR fixture (the de-risking ground truth)

**Files:**
- Create: `client/test/fixtures/jinn-repo/<instance_id>/task.json` (a real merged PR, hand-reduced)
- Create: `client/test/fixtures/jinn-repo/<instance_id>/solution.patch` (the PR's actual code diff, test hunks stripped)
- Create: `client/test/fixtures/jinn-repo/<instance_id>/bad.patch` (a no-op or wrong diff)
- Create: `client/test/fixtures/jinn-repo/<instance_id>/gold-test/<path>` (the PR's test file(s))

- [ ] **Step 1: Pick a merged PR with a regression test.** Use `gh pr list --repo Jinn-Network/mono --state merged --search "is:merged"` and pick one whose merge added/changed a `client/test/**` file and whose fix is a small TS diff (e.g. a `fix:` PR). Record its number, merge-base commit (`git rev-parse <merge_commit>^`), the test file path(s), and the `vitest` command scoped to those paths.

- [ ] **Step 2: Materialise the fixture.** Write `task.json` per `JinnRepoTaskSchema`. Save the PR's code diff (excluding test hunks) as `solution.patch` (`git show <merge> -- . ':(exclude)client/test/**' > solution.patch`). Save the PR's test file(s) under `gold-test/`. Create `bad.patch` as an empty diff.

- [ ] **Step 3: Commit the fixture** (no test yet — fixture is consumed by Task 3).

```bash
git add client/test/fixtures/jinn-repo/
git commit -m "test(jinn-repo): real merged-PR fixture for repro-eval"
```

---

### Task 3: Repo-native repro + eval runner (the risky core)

**Files:**
- Create: `client/src/harnesses/impls/jinn-repo-evaluator/repro.ts`
- Create: `client/src/harnesses/impls/jinn-repo-evaluator/eval-runner.ts`
- Test: `client/test/harnesses/jinn-repo-evaluator/eval-runner.integration.test.ts`

- [ ] **Step 1: Write the failing integration test** (uses the Task 2 fixture; real git + yarn, so it is an integration test — gate behind an env flag like the existing `e2e` suites).

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JinnRepoTaskSchema } from '../../../src/solver-types/jinn-repo.js';
import { runJinnRepoEval } from '../../../src/harnesses/impls/jinn-repo-evaluator/eval-runner.js';

const FIXTURE = join(__dirname, '../../fixtures/jinn-repo/<instance_id>');
const RUN = process.env.JINN_E2E_JINN_REPO === '1';

describe.runIf(RUN)('runJinnRepoEval', () => {
  const task = JinnRepoTaskSchema.parse(JSON.parse(readFileSync(join(FIXTURE, 'task.json'), 'utf8')));

  it('PASS when the real solution patch is applied', async () => {
    const patch = readFileSync(join(FIXTURE, 'solution.patch'), 'utf8');
    const result = await runJinnRepoEval({ task, patch, monoRepoUrl: process.env.JINN_MONO_REMOTE ?? 'https://github.com/Jinn-Network/mono.git' });
    expect(result.unscorable).toBe(false);
    expect(result.passed).toBe(true);
  }, 600_000);

  it('FAIL when an empty/wrong patch is applied', async () => {
    const patch = readFileSync(join(FIXTURE, 'bad.patch'), 'utf8');
    const result = await runJinnRepoEval({ task, patch, monoRepoUrl: process.env.JINN_MONO_REMOTE ?? 'https://github.com/Jinn-Network/mono.git' });
    expect(result.unscorable).toBe(false);
    expect(result.passed).toBe(false);
  }, 600_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && JINN_E2E_JINN_REPO=1 yarn vitest run test/harnesses/jinn-repo-evaluator/eval-runner.integration.test.ts`
Expected: FAIL — `runJinnRepoEval` not defined.

- [ ] **Step 3: Implement `repro.ts`** — prepare an isolated checkout at `base_commit`.

```typescript
// client/src/harnesses/impls/jinn-repo-evaluator/repro.ts
import { mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(execFile);

export interface PreparedRepro {
  dir: string;
  cleanup: () => Promise<void>;
}

/** Clone mono at base_commit into a throwaway dir, apply patch, overwrite gold tests. */
export async function prepareRepro(args: {
  monoRepoUrl: string;
  baseCommit: string;
  patch: string;
  goldTestFiles: Record<string, string>; // relpath -> contents
}): Promise<PreparedRepro> {
  const dir = await mkdtemp(join(tmpdir(), 'jinn-repo-eval-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await sh('git', ['init', '-q', dir]);
    await sh('git', ['-C', dir, 'remote', 'add', 'origin', args.monoRepoUrl]);
    await sh('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', args.baseCommit]);
    await sh('git', ['-C', dir, 'checkout', '-q', args.baseCommit]);
    // Apply candidate solution.
    const patchPath = join(dir, '.candidate.patch');
    await writeFile(patchPath, args.patch);
    if (args.patch.trim().length > 0) {
      await sh('git', ['-C', dir, 'apply', '--3way', patchPath]);
    }
    // Overwrite with the PR's gold test files (the FAIL_TO_PASS contract).
    for (const [rel, contents] of Object.entries(args.goldTestFiles)) {
      const dest = join(dir, rel);
      await sh('mkdir', ['-p', join(dest, '..')]);
      await writeFile(dest, contents);
    }
    return { dir, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
```

- [ ] **Step 4: Implement `eval-runner.ts`** — install, run targeted tests, parse, classify.

```typescript
// client/src/harnesses/impls/jinn-repo-evaluator/eval-runner.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRepro } from './repro.js';
import type { JinnRepoTask } from '../../../solver-types/jinn-repo.js';

const sh = promisify(execFile);

export interface JinnRepoEvalResult {
  passed: boolean | null; // null only when unscorable
  unscorable: boolean;
  logExcerpt: string;
}

/** Infra failure (install/clone) ⇒ unscorable; test pass/fail ⇒ scored. Never coerce infra failure to FAIL. */
export async function runJinnRepoEval(args: {
  task: JinnRepoTask;
  patch: string;
  monoRepoUrl: string;
}): Promise<JinnRepoEvalResult> {
  const goldTestFiles: Record<string, string> = {};
  // Gold test contents come from the task's repo at the merge commit; the fixture
  // ships them under gold-test/. The pool builder (P2) populates these inline.
  // For the fixture test, read them from the fixture dir adjacent to task.json.
  // (P2 replaces this with pool-embedded gold test contents.)
  for (const rel of args.task.test_files) {
    goldTestFiles[rel] = readFileSync(join(process.env.JINN_REPO_FIXTURE_DIR ?? '.', 'gold-test', rel), 'utf8');
  }

  let repro;
  try {
    repro = await prepareRepro({
      monoRepoUrl: args.monoRepoUrl,
      baseCommit: args.task.base_commit,
      patch: args.patch,
      goldTestFiles,
    });
  } catch (e) {
    return { passed: null, unscorable: true, logExcerpt: `repro-prep-failed: ${String(e).slice(0, 1000)}` };
  }

  try {
    await sh('corepack', ['enable'], { cwd: repro.dir });
    await sh('yarn', ['install', '--immutable'], { cwd: join(repro.dir, 'client'), maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    await repro.cleanup();
    return { passed: null, unscorable: true, logExcerpt: `install-failed: ${String(e).slice(0, 1000)}` };
  }

  try {
    // test_cmd is scoped to the gold test files; exit 0 = PASS, non-zero = FAIL.
    const [bin, ...rest] = args.task.test_cmd.split(' ');
    await sh(bin, rest, { cwd: repro.dir, maxBuffer: 64 * 1024 * 1024 });
    return { passed: true, unscorable: false, logExcerpt: '' };
  } catch (e: any) {
    const out = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`.slice(0, 1000);
    return { passed: false, unscorable: false, logExcerpt: out };
  } finally {
    await repro.cleanup();
  }
}
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `cd client && JINN_E2E_JINN_REPO=1 JINN_REPO_FIXTURE_DIR=test/fixtures/jinn-repo/<instance_id> yarn vitest run test/harnesses/jinn-repo-evaluator/eval-runner.integration.test.ts`
Expected: PASS — real solution scores PASS, empty patch scores FAIL. (First run is slow: clone + `yarn install`.)

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/jinn-repo-evaluator/ client/test/harnesses/jinn-repo-evaluator/
git commit -m "feat(jinn-repo): repo-native repro + eval runner"
```

---

### Task 4: `JinnRepoEvaluator` (orchestrator-conformant)

**Files:**
- Create: `client/src/harnesses/impls/jinn-repo-evaluator/evaluator.ts`
- Test: `client/test/harnesses/jinn-repo-evaluator/evaluator.test.ts`

- [ ] **Step 1: Read the interface.** Open [`client/src/eval/orchestrator.ts`](../../../client/src/eval/orchestrator.ts) and find the `evaluator` field on `EvalOrchestratorDeps` and the exact method the loop calls to grade a solution (mirror `SweRebenchV2Evaluator`). The evaluator receives the task + the harness's solution payload and returns `{ passed, unscorable, logExcerpt }`.

- [ ] **Step 2: Write the failing test** (unit — inject a fake runner so no git/yarn).

```typescript
import { describe, it, expect } from 'vitest';
import { JinnRepoEvaluator } from '../../../src/harnesses/impls/jinn-repo-evaluator/evaluator.js';

describe('JinnRepoEvaluator', () => {
  const task = { schemaVersion: 'jinn-repo.v1', instance_id: 'x-1', repo: 'Jinn-Network/mono',
    base_commit: 'a'.repeat(40), merged_pr: 1, language: 'typescript',
    problem_statement: 'p', test_files: ['t.test.ts'], test_cmd: 'yarn vitest run t.test.ts' } as const;

  it('maps a PASS run to a passed verdict', async () => {
    const evaluator = new JinnRepoEvaluator({ run: async () => ({ passed: true, unscorable: false, logExcerpt: '' }) });
    const v = await evaluator.grade({ task, solution: { patch: 'diff' } });
    expect(v).toEqual({ passed: true, unscorable: false, logExcerpt: '' });
  });

  it('propagates unscorable (infra failure) without coercing to FAIL', async () => {
    const evaluator = new JinnRepoEvaluator({ run: async () => ({ passed: null, unscorable: true, logExcerpt: 'install-failed' }) });
    const v = await evaluator.grade({ task, solution: { patch: 'diff' } });
    expect(v.unscorable).toBe(true);
    expect(v.passed).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd client && yarn vitest run test/harnesses/jinn-repo-evaluator/evaluator.test.ts`
Expected: FAIL — `JinnRepoEvaluator` not defined.

- [ ] **Step 4: Implement `evaluator.ts`** (thin adapter over the runner; inject `run` for testability). Align the public method name/shape with the `evaluator` slot found in Step 1 — if the orchestrator calls e.g. `grade(...)`, expose `grade`; if it expects a different name, match it.

```typescript
// client/src/harnesses/impls/jinn-repo-evaluator/evaluator.ts
import { runJinnRepoEval, type JinnRepoEvalResult } from './eval-runner.js';
import type { JinnRepoTask } from '../../../solver-types/jinn-repo.js';

type RunFn = (args: { task: JinnRepoTask; patch: string; monoRepoUrl: string }) => Promise<JinnRepoEvalResult>;

export class JinnRepoEvaluator {
  private readonly run: RunFn;
  private readonly monoRepoUrl: string;
  constructor(opts?: { run?: RunFn; monoRepoUrl?: string }) {
    this.run = opts?.run ?? runJinnRepoEval;
    this.monoRepoUrl = opts?.monoRepoUrl ?? 'https://github.com/Jinn-Network/mono.git';
  }
  async grade(args: { task: JinnRepoTask; solution: { patch: string } }): Promise<JinnRepoEvalResult> {
    return this.run({ task: args.task, patch: args.solution.patch, monoRepoUrl: this.monoRepoUrl });
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd client && yarn vitest run test/harnesses/jinn-repo-evaluator/evaluator.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/jinn-repo-evaluator/evaluator.ts client/test/harnesses/jinn-repo-evaluator/evaluator.test.ts
git commit -m "feat(jinn-repo): orchestrator-conformant evaluator"
```

---

### Task 5: Wire `jinn eval` to dispatch `jinn-repo`

**Files:**
- Create: `client/src/solver-types/_jinn-repo-pool.ts` (pool loader; mirrors `_swe-rebench-v2-pool.ts`)
- Modify: `client/src/cli/commands/eval.ts:417-499` (`runPipeline`)
- Test: `client/test/cli/eval.dispatch.test.ts`

- [ ] **Step 1: Write the failing test** — `runPipeline` builds the jinn-repo evaluator + pool when `solverType === 'jinn-repo'`, the SWE path otherwise. Inject deps so no network: assert the *selection*, not a full run.

```typescript
import { describe, it, expect } from 'vitest';
import { selectEvalBackend } from '../../src/cli/commands/eval.js';

describe('selectEvalBackend', () => {
  it('returns the jinn-repo backend for solverType jinn-repo', () => {
    const b = selectEvalBackend('jinn-repo');
    expect(b.kind).toBe('jinn-repo');
  });
  it('returns the swe-rebench-v2 backend otherwise', () => {
    const b = selectEvalBackend('swe-rebench-v2');
    expect(b.kind).toBe('swe-rebench-v2');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/cli/eval.dispatch.test.ts`
Expected: FAIL — `selectEvalBackend` not exported.

- [ ] **Step 3: Extract a `selectEvalBackend(solverType)` helper** in `eval.ts` and route the hardwired SWE block (lines 431-457) through it, adding a `jinn-repo` branch that loads `loadJinnRepoPool()` and constructs `JinnRepoEvaluator`. Implement `_jinn-repo-pool.ts` `loadJinnRepoPool()` to read the pool JSON produced in P2 (for P1, a small committed fixture pool). Keep the SWE branch byte-for-byte equivalent to today.

(Code: a discriminated union `{ kind: 'jinn-repo'; evaluator; resolveTasks } | { kind: 'swe-rebench-v2'; evaluator; resolveTasks }`. The `resolveTasks` for jinn-repo reads the pool by `instanceIds` instead of fetching HF. Full code authored in-task against the exact current `runPipeline` body.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/cli/eval.dispatch.test.ts && yarn typecheck`
Expected: PASS + zero type errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/eval.ts client/src/solver-types/_jinn-repo-pool.ts client/test/cli/eval.dispatch.test.ts
git commit -m "feat(jinn-repo): dispatch jinn eval to the repo-native backend by solver-type"
```

---

## P1 self-review

- **Spec coverage:** P1 delivers the `(task, clean repro, deterministic check)` reduction and the eval-pipeline wiring the spec's milestone requires. Slate JSON (P2), cost capture (P3), and the check script (P4) are explicitly deferred to their own plans.
- **Survivorship caveat (spec §"does not yet prove"):** the fixture/pool draws from merged PRs that already passed review — bias toward the already-doable. P2's pool builder must record this and the slate must be curated (mirror the SWE-rebench `validated-pool.json` discipline) to resist drift toward easy instances.
- **Type consistency:** `JinnRepoEvalResult` (`{ passed: boolean|null, unscorable, logExcerpt }`) is the single result shape across `eval-runner.ts`, `evaluator.ts`, and the orchestrator's `eval_results` row (`passed` nullable, `unscorable` flag) — matches the shipped `EvalResultRecord`.
- **Interface risk:** Tasks 4-5 conform to interfaces in `orchestrator.ts` / the SWE evaluator — the implementer reads those files first (named in each task). If the orchestrator's evaluator method name differs from `grade`, match it; this is the one place the plan defers to the live interface rather than inventing one.

---

## P2 — Task-creation pipeline (script-curation)

**Goal:** A script that turns merged `Jinn-Network/mono` PRs into admitted, self-contained `(task, repro, check)` pool items, and emits a content-addressed held-out slate. Creation is **us-run script-curation** (scope confirmed 2026-06-08) — no agent/network in the creation loop yet. The admission gate is the P1 evaluator run twice (empty → FAIL, solution → PASS), so junk cannot enter the pool silently.

**Leak-control invariant:** gold-test contents and the reference solution patch are **evaluator-side only**. The solver harness sees `problem_statement + base_commit + repo` and nothing else — otherwise it overfits to the test or copies the answer (spec §"hide the reference solution"). A `solverView()` enforces this at task-handoff.

**Cost note:** the admission double-run is two full `clone + yarn install + vitest` cycles per candidate — slow, but it is a one-time offline build. Cache the `base_commit` checkout across the two runs (Task 5).

### P2 file structure
- Modify: `client/src/solver-types/_jinn-repo-pool.ts` — pool item type (P1 task + evaluator-side `gold_tests` + `solution_patch`), `loadJinnRepoPool()`, `solverView()`.
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/eval-runner.ts` — `runJinnRepoEval` takes `goldTests` as a parameter (retire the P1 `JINN_REPO_FIXTURE_DIR` env hack).
- Create: `client/src/solver-types/jinn-repo-extract.ts` — PR selection + extraction (pure; injected `gh`/`git` runners).
- Create: `client/src/solver-types/jinn-repo-admit.ts` — the double-run admission gate.
- Create: `client/scripts/build-jinn-repo-pool.ts` — orchestrating builder (select → extract → admit → write pool + slate).
- Create (by the builder): `client/src/solver-types/slates/held-out-slate.jinn-repo.v1.json`.

### Task 1: Pool item type + `solverView` leak-control

**Files:**
- Modify: `client/src/solver-types/_jinn-repo-pool.ts`
- Test: `client/test/solver-types/jinn-repo-pool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { solverView, JinnRepoPoolItemSchema } from '../../src/solver-types/_jinn-repo-pool.js';

const item = {
  schemaVersion: 'jinn-repo.v1', instance_id: 'Jinn-Network__mono-1042', repo: 'Jinn-Network/mono',
  base_commit: 'a'.repeat(40), merged_pr: 1042, language: 'typescript',
  problem_statement: 'Mech safe nonce stale on retry.',
  test_files: ['client/test/adapters/mech/safe.nonce.test.ts'],
  test_cmd: 'yarn vitest run client/test/adapters/mech/safe.nonce.test.ts',
  gold_tests: { 'client/test/adapters/mech/safe.nonce.test.ts': 'import ...' },
  solution_patch: 'diff --git ...',
};

describe('jinn-repo pool item', () => {
  it('parses a full pool item', () => {
    expect(JinnRepoPoolItemSchema.parse(item).gold_tests).toBeDefined();
  });
  it('solverView strips evaluator-side fields (no test contents, no solution)', () => {
    const v = solverView(item);
    expect(v).not.toHaveProperty('gold_tests');
    expect(v).not.toHaveProperty('solution_patch');
    expect(v.problem_statement).toBe(item.problem_statement);
    expect(v.base_commit).toBe(item.base_commit);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-pool.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```typescript
// client/src/solver-types/_jinn-repo-pool.ts
import { z } from 'zod';
import { JinnRepoTaskSchema } from './jinn-repo.js';

// Pool item = the solver-visible task + evaluator-side secrets (gold tests, reference solution).
export const JinnRepoPoolItemSchema = JinnRepoTaskSchema.extend({
  gold_tests: z.record(z.string(), z.string()),  // relpath -> file contents (evaluator-side)
  solution_patch: z.string(),                     // reference fix (admission only; never shown to solver)
});
export type JinnRepoPoolItem = z.infer<typeof JinnRepoPoolItemSchema>;

// What the solver harness is allowed to see. Leak-control: no gold tests, no solution.
export interface JinnRepoSolverView {
  schemaVersion: 'jinn-repo.v1';
  instance_id: string;
  repo: 'Jinn-Network/mono';
  base_commit: string;
  problem_statement: string;
}
export function solverView(item: JinnRepoPoolItem): JinnRepoSolverView {
  return {
    schemaVersion: item.schemaVersion,
    instance_id: item.instance_id,
    repo: item.repo,
    base_commit: item.base_commit,
    problem_statement: item.problem_statement,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-pool.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_jinn-repo-pool.ts client/test/solver-types/jinn-repo-pool.test.ts
git commit -m "feat(jinn-repo): pool item type + solver-view leak-control"
```

### Task 2: Candidate PR selection

**Files:**
- Create: `client/src/solver-types/jinn-repo-extract.ts`
- Test: `client/test/solver-types/jinn-repo-select.test.ts`

- [ ] **Step 1: Write the failing test** (inject the `gh` fetcher; assert filters — merged, touches `client/test/**`, has a linked issue).

```typescript
import { describe, it, expect } from 'vitest';
import { selectCandidatePRs, type PrSummary } from '../../src/solver-types/jinn-repo-extract.js';

const prs: PrSummary[] = [
  { number: 1042, files: ['client/src/adapters/mech/safe.ts', 'client/test/adapters/mech/safe.nonce.test.ts'], closingIssues: [501] },
  { number: 1043, files: ['docs/readme.md'], closingIssues: [502] },            // no code/test
  { number: 1044, files: ['client/src/x.ts', 'client/test/x.test.ts'], closingIssues: [] }, // no linked issue
];

describe('selectCandidatePRs', () => {
  it('keeps PRs that touch client/test/** AND have a linked issue', () => {
    expect(selectCandidatePRs(prs).map((p) => p.number)).toEqual([1042]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-select.test.ts`
Expected: FAIL — `selectCandidatePRs` undefined.

- [ ] **Step 3: Implement the filter** (and declare `PrSummary`; the live `gh` fetch is added in Task 6, kept out of this pure function).

```typescript
// client/src/solver-types/jinn-repo-extract.ts
export interface PrSummary {
  number: number;
  files: string[];
  closingIssues: number[];
}

const TEST_PATH = /(^|\/)client\/test\/.+\.test\.ts$/;

export function selectCandidatePRs(prs: PrSummary[]): PrSummary[] {
  return prs.filter(
    (pr) => pr.closingIssues.length > 0 && pr.files.some((f) => TEST_PATH.test(f)),
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-select.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/jinn-repo-extract.ts client/test/solver-types/jinn-repo-select.test.ts
git commit -m "feat(jinn-repo): candidate PR selection filter"
```

### Task 3: Extraction (PR → pool item)

**Files:**
- Modify: `client/src/solver-types/jinn-repo-extract.ts`
- Test: `client/test/solver-types/jinn-repo-extract.test.ts`

- [ ] **Step 1: Write the failing test** — inject a fake `git`/`gh` runner returning canned output for one PR; assert the produced pool item. Key behaviours: `base_commit` = merge commit's first parent; `problem_statement` = linked **issue** body (not PR body); `solution_patch` = diff with `client/test/**` excluded; `gold_tests` = the touched test files' contents at the merge commit; `test_cmd` scoped to those paths.

```typescript
import { describe, it, expect } from 'vitest';
import { extractPoolItem } from '../../src/solver-types/jinn-repo-extract.js';

const fakeExec = async (cmd: string, args: string[]): Promise<string> => {
  const key = [cmd, ...args].join(' ');
  if (key.includes('rev-parse')) return 'b'.repeat(40);                       // base = parent
  if (key.includes('show') && key.includes(':client/test/')) return 'TEST_CONTENT';
  if (key.includes('diff')) return 'diff --git a/client/src/safe.ts ...';     // test-stripped
  throw new Error(`unexpected: ${key}`);
};
const fakeIssue = async (_n: number) => ({ title: 'Nonce stale', body: 'On retry the mech safe nonce is stale.' });

describe('extractPoolItem', () => {
  it('builds a pool item with issue-derived problem statement and gold tests', async () => {
    const item = await extractPoolItem(
      { number: 1042, files: ['client/src/safe.ts', 'client/test/adapters/mech/safe.nonce.test.ts'], closingIssues: [501] },
      { exec: fakeExec, fetchIssue: fakeIssue, mergeCommit: 'c'.repeat(40) },
    );
    expect(item.base_commit).toBe('b'.repeat(40));
    expect(item.problem_statement).toContain('nonce is stale');
    expect(item.gold_tests['client/test/adapters/mech/safe.nonce.test.ts']).toBe('TEST_CONTENT');
    expect(item.solution_patch).not.toContain('client/test/');
    expect(item.test_cmd).toContain('client/test/adapters/mech/safe.nonce.test.ts');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-extract.test.ts`
Expected: FAIL — `extractPoolItem` undefined.

- [ ] **Step 3: Implement `extractPoolItem`** (pure orchestration over injected `exec`/`fetchIssue`; commands mirror P1 `repro.ts` style).

```typescript
// append to client/src/solver-types/jinn-repo-extract.ts
import { JinnRepoPoolItemSchema, type JinnRepoPoolItem } from './_jinn-repo-pool.js';

export interface ExtractDeps {
  exec: (cmd: string, args: string[]) => Promise<string>;
  fetchIssue: (n: number) => Promise<{ title: string; body: string }>;
  mergeCommit: string;
}

export async function extractPoolItem(pr: PrSummary, deps: ExtractDeps): Promise<JinnRepoPoolItem> {
  const base = (await deps.exec('git', ['rev-parse', `${deps.mergeCommit}^1`])).trim();
  const testFiles = pr.files.filter((f) => TEST_PATH.test(f));
  const gold_tests: Record<string, string> = {};
  for (const f of testFiles) {
    gold_tests[f] = await deps.exec('git', ['show', `${deps.mergeCommit}:${f}`]);
  }
  const solution_patch = await deps.exec('git', [
    'diff', base, deps.mergeCommit, '--', '.', ':(exclude)client/test/**',
  ]);
  const issue = await deps.fetchIssue(pr.closingIssues[0]!);
  const item: JinnRepoPoolItem = {
    schemaVersion: 'jinn-repo.v1',
    instance_id: `Jinn-Network__mono-${pr.number}`,
    repo: 'Jinn-Network/mono',
    base_commit: base,
    merged_pr: pr.number,
    language: 'typescript',
    problem_statement: `${issue.title}\n\n${issue.body}`.trim(),
    test_files: testFiles,
    test_cmd: `yarn vitest run ${testFiles.join(' ')}`,
    gold_tests,
    solution_patch,
  };
  return JinnRepoPoolItemSchema.parse(item);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/jinn-repo-extract.ts client/test/solver-types/jinn-repo-extract.test.ts
git commit -m "feat(jinn-repo): extract a pool item from a merged PR"
```

### Task 4: Refactor `runJinnRepoEval` to take gold tests as a parameter

**Files:**
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/eval-runner.ts`
- Modify: `client/test/harnesses/jinn-repo-evaluator/eval-runner.integration.test.ts` (drop the `JINN_REPO_FIXTURE_DIR` env; pass `goldTests` read from the fixture)

- [ ] **Step 1: Update the integration test** to pass `goldTests` explicitly instead of relying on the env hack.

```typescript
// in the existing integration test, replace the run calls:
import { readdirSync } from 'node:fs';
function readGold(dir: string, paths: string[]): Record<string, string> {
  const g: Record<string, string> = {};
  for (const p of paths) g[p] = readFileSync(join(dir, 'gold-test', p), 'utf8');
  return g;
}
// ...
const goldTests = readGold(FIXTURE, task.test_files);
const result = await runJinnRepoEval({ task, patch, goldTests, monoRepoUrl: ... });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/harnesses/jinn-repo-evaluator/eval-runner.integration.test.ts`
Expected: FAIL/type error — `runJinnRepoEval` does not accept `goldTests`.

- [ ] **Step 3: Change the signature** — remove the `JINN_REPO_FIXTURE_DIR` read; add `goldTests: Record<string,string>` to the args and pass it straight into `prepareRepro({ goldTestFiles: args.goldTests, ... })`. Delete the fixture-dir block from P1.

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && JINN_E2E_JINN_REPO=1 yarn vitest run test/harnesses/jinn-repo-evaluator/eval-runner.integration.test.ts && yarn typecheck`
Expected: PASS + zero type errors (callers updated).

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/impls/jinn-repo-evaluator/eval-runner.ts client/test/harnesses/jinn-repo-evaluator/
git commit -m "refactor(jinn-repo): pass gold tests explicitly, retire fixture-dir env hack"
```

### Task 5: Admission gate (the double-run)

**Files:**
- Create: `client/src/solver-types/jinn-repo-admit.ts`
- Test: `client/test/solver-types/jinn-repo-admit.test.ts` (unit, injected runner) + extend the integration test (one real PR)

- [ ] **Step 1: Write the failing unit test** — `validateAdmissible` runs the evaluator twice and admits only when empty→FAIL and solution→PASS.

```typescript
import { describe, it, expect } from 'vitest';
import { validateAdmissible } from '../../src/solver-types/jinn-repo-admit.js';

const item: any = { test_files: ['t.test.ts'], gold_tests: { 't.test.ts': 'x' }, solution_patch: 'diff', base_commit: 'a'.repeat(40), repo: 'Jinn-Network/mono', test_cmd: 'yarn vitest run t.test.ts' };

describe('validateAdmissible', () => {
  it('admits when empty FAILS and solution PASSES', async () => {
    const run = async ({ patch }: any) => (patch.trim() === '' ? { passed: false, unscorable: false, logExcerpt: '' } : { passed: true, unscorable: false, logExcerpt: '' });
    expect((await validateAdmissible(item, { run })).admitted).toBe(true);
  });
  it('rejects when the gold test passes even WITHOUT the fix (test does not exercise the bug)', async () => {
    const run = async () => ({ passed: true, unscorable: false, logExcerpt: '' });
    const r = await validateAdmissible(item, { run });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/empty.*PASS|not FAIL_TO_PASS/i);
  });
  it('rejects when unscorable (infra failure)', async () => {
    const run = async () => ({ passed: null, unscorable: true, logExcerpt: 'install-failed' });
    expect((await validateAdmissible(item, { run })).admitted).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-admit.test.ts`
Expected: FAIL — `validateAdmissible` undefined.

- [ ] **Step 3: Implement**

```typescript
// client/src/solver-types/jinn-repo-admit.ts
import type { JinnRepoPoolItem } from './_jinn-repo-pool.js';
import type { JinnRepoEvalResult } from '../harnesses/impls/jinn-repo-evaluator/eval-runner.js';

type RunFn = (args: { task: JinnRepoPoolItem; patch: string; goldTests: Record<string, string>; monoRepoUrl: string }) => Promise<JinnRepoEvalResult>;

export interface AdmissionVerdict { admitted: boolean; reason: string; }

export async function validateAdmissible(
  item: JinnRepoPoolItem,
  deps: { run: RunFn; monoRepoUrl?: string },
): Promise<AdmissionVerdict> {
  const monoRepoUrl = deps.monoRepoUrl ?? 'https://github.com/Jinn-Network/mono.git';
  const common = { task: item, goldTests: item.gold_tests, monoRepoUrl };
  const withoutFix = await deps.run({ ...common, patch: '' });
  if (withoutFix.unscorable) return { admitted: false, reason: `unscorable without fix: ${withoutFix.logExcerpt}` };
  if (withoutFix.passed === true) return { admitted: false, reason: 'gold test PASSes without the fix — not FAIL_TO_PASS' };
  const withFix = await deps.run({ ...common, patch: item.solution_patch });
  if (withFix.unscorable) return { admitted: false, reason: `unscorable with fix: ${withFix.logExcerpt}` };
  if (withFix.passed !== true) return { admitted: false, reason: 'gold test FAILs even with the reference solution — not reproducible' };
  return { admitted: true, reason: 'FAIL_TO_PASS verified' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-admit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add one integration assertion** — in the integration test, run `validateAdmissible` against the Task-2 fixture with the real `runJinnRepoEval`; expect `admitted === true`. (Guard behind `JINN_E2E_JINN_REPO=1`.) Optional optimisation: have `runJinnRepoEval` accept a pre-cloned `baseDir` so the two admission runs share one checkout.

- [ ] **Step 6: Commit**

```bash
git add client/src/solver-types/jinn-repo-admit.ts client/test/solver-types/jinn-repo-admit.test.ts client/test/harnesses/jinn-repo-evaluator/
git commit -m "feat(jinn-repo): FAIL_TO_PASS admission gate (double-run)"
```

### Task 6: Builder script + slate emission

**Files:**
- Create: `client/scripts/build-jinn-repo-pool.ts`
- Output: `client/src/solver-types/jinn-repo-pool.json` + `client/src/solver-types/slates/held-out-slate.jinn-repo.v1.json`
- Test: `client/test/solver-types/jinn-repo-slate.test.ts` (slate hashing/shape; pure)

- [ ] **Step 1: Write the failing test for slate assembly** — `buildSlate(instanceIds)` produces a `held-out-slate.v1`-conformant object whose `hash` matches the existing loader's recomputation (reuse the SWE-rebench slate hash function so `loadHeldOutSlate('jinn-repo.v1','v1')` validates it).

```typescript
import { describe, it, expect } from 'vitest';
import { buildSlate } from '../../scripts/build-jinn-repo-pool.js';
import { loadHeldOutSlate } from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';

describe('buildSlate', () => {
  it('emits a slate the shipped loader accepts', () => {
    const slate = buildSlate(['Jinn-Network__mono-2', 'Jinn-Network__mono-1'], 'v1', '2026-06-08T00:00:00.000Z');
    expect(slate.instanceIds).toEqual(['Jinn-Network__mono-1', 'Jinn-Network__mono-2']); // sorted
    expect(slate.solverType).toBe('jinn-repo.v1');
    // hash recomputation: write to a temp dir and load via loadHeldOutSlate; expect no throw.
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-slate.test.ts`
Expected: FAIL — `buildSlate` undefined.

- [ ] **Step 3: Implement `buildSlate`** (reuse the canonical sort + sha256 from `_swe-rebench-v2-held-out-slate.ts` — import its hash helper; if it is not exported, export it there in this step) and the orchestrating `main()`:

```typescript
// client/scripts/build-jinn-repo-pool.ts  (sketch — full code authored in-task)
// 1. ghListMergedPRs() -> PrSummary[]   (gh pr list --repo Jinn-Network/mono --state merged --json number,files,closingIssuesReferences)
// 2. selectCandidatePRs(prs)
// 3. for each: extractPoolItem(pr, { exec: realGit, fetchIssue: ghIssue, mergeCommit })
// 4. validateAdmissible(item, { run: runJinnRepoEval })  -> keep admitted, LOG every rejection + reason
// 5. write jinn-repo-pool.json (admitted items)
// 6. split: held-out = first K by instance_id; train = rest. buildSlate(heldOutIds) -> write slate JSON.
// 7. print a summary: candidates, admitted, rejected-by-reason, train/held-out counts.
export function buildSlate(instanceIds: string[], version: string, generatedAt: string) { /* sort, hash, shape */ }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-slate.test.ts && yarn typecheck`
Expected: PASS + zero type errors.

- [ ] **Step 5: Curation discipline (non-code, MANDATORY).** The script must `console.log` every rejected PR with its reason, and print admitted/rejected counts. Per spec §survivorship, record the bias: merged-only PRs lean easy. Do **not** silently drop — the rejection log is the curation audit trail.

- [ ] **Step 6: Commit**

```bash
git add client/scripts/build-jinn-repo-pool.ts client/test/solver-types/jinn-repo-slate.test.ts client/src/solver-types/_swe-rebench-v2-held-out-slate.ts
git commit -m "feat(jinn-repo): pool+slate builder with rejection-logging admission"
```

### Task 7: `loadJinnRepoPool` + wire to the eval backend

**Files:**
- Modify: `client/src/solver-types/_jinn-repo-pool.ts` (`loadJinnRepoPool`)
- Modify: `client/src/cli/commands/eval.ts` (the `jinn-repo` branch from P1 Task 5 resolves tasks via `loadJinnRepoPool`, passes `gold_tests` to the evaluator, hands `solverView(item)` to the harness)
- Test: `client/test/solver-types/jinn-repo-pool-load.test.ts`

- [ ] **Step 1: Write the failing test** — `loadJinnRepoPool()` parses the pool JSON into `JinnRepoPoolItem[]`; resolving a slate's `instanceIds` against it yields full items (with `gold_tests`) for the evaluator, while the harness handoff uses `solverView`.

```typescript
import { describe, it, expect } from 'vitest';
import { loadJinnRepoPool, resolveJinnRepoSlate } from '../../src/solver-types/_jinn-repo-pool.js';

describe('loadJinnRepoPool', () => {
  it('resolves slate instance ids to full pool items', () => {
    const pool = loadJinnRepoPool({ path: 'test/fixtures/jinn-repo/pool.sample.json' });
    const resolved = resolveJinnRepoSlate(pool, new Set(['Jinn-Network__mono-1042']));
    expect(resolved[0]!.gold_tests).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-pool-load.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement `loadJinnRepoPool` + `resolveJinnRepoSlate`**, then update the `jinn-repo` branch in `eval.ts` `selectEvalBackend` (P1 Task 5) so `resolveTasks` reads the pool and the evaluator gets `gold_tests`. The `runHarnessOnce` handoff passes `solverView(item)` only.

```typescript
// in _jinn-repo-pool.ts
import { readFileSync } from 'node:fs';
export function loadJinnRepoPool(opts: { path?: string } = {}): JinnRepoPoolItem[] {
  const path = opts.path ?? new URL('./jinn-repo-pool.json', import.meta.url).pathname;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
  return raw.map((r) => JinnRepoPoolItemSchema.parse(r));
}
export function resolveJinnRepoSlate(pool: JinnRepoPoolItem[], ids: Set<string>): JinnRepoPoolItem[] {
  return pool.filter((p) => ids.has(p.instance_id));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/jinn-repo-pool-load.test.ts && yarn typecheck`
Expected: PASS + zero type errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_jinn-repo-pool.ts client/src/cli/commands/eval.ts client/test/
git commit -m "feat(jinn-repo): load pool, resolve slates, wire eval backend with solver-view handoff"
```

### P2 self-review

- **Spec coverage:** P2 is the task-creation process the spec's "flow" section describes — extract → validate → admit — with merged-PR selection as the source and the double-run as the reproducibility/evaluatability gate. The on-chain-verifiable headline task (spec gate) is admitted like any other; flag it in the pool builder summary so P4 can feature it.
- **Leak-control:** gold tests + reference solution are evaluator-side; `solverView` is the single chokepoint and is tested (Task 1). If any future caller hands a raw `JinnRepoPoolItem` to a harness, that is a leak bug.
- **Admission soundness:** the two failure modes the gate must catch — test passes without the fix (doesn't exercise the bug) and test fails even with the fix (not reproducible) — are both tested (Task 5). These are the ways junk enters silently.
- **Curation audit:** rejection logging (Task 6 Step 5) is mandatory, not optional — it is the only record of what the pool excluded and why (spec §survivorship).
- **Type consistency:** `JinnRepoPoolItem` (task + `gold_tests` + `solution_patch`) flows extract → admit → pool JSON → load → evaluator; `JinnRepoEvalResult` is unchanged from P1; the slate object conforms to the shipped `held-out-slate.v1` loader (Task 6 reuses its hash helper).

## P3–P4 (scoped; expand into their own plans)

### P3 — Cost capture in the eval path
**Goal:** record per-eval-task inference cost so the milestone's cost gate is computable. After each eval harness run in the orchestrator, call `harvestHarnessUsage(harness, workingDir, model)` ([`client/src/spend/usage.ts`](../../../client/src/spend/usage.ts)) and persist `costUsdMicros` keyed by `(checkpoint_cid, slate_version, instance_id)`. **Files:** add an `eval_cost` column/table in [`client/src/store/store.ts`](../../../client/src/store/store.ts) (sibling to `eval_results`), wire it in [`orchestrator.ts`](../../../client/src/eval/orchestrator.ts). **Why separate:** it's an additive store + orchestrator change, independently testable against a fake usage harvester.

### P4 — `check-milestone-4.ts`
**Goal:** compute the cost-per-solved-task delta between the learned checkpoint and the baseline checkpoint, and report the ≥30% gate. **Files:** `client/scripts/check-milestone-4.ts` (mirror [`check-milestone-2.ts`](../../../client/scripts/check-milestone-2.ts)). Reads `eval_results` + `eval_cost` for both checkpoints from the store (or an indexer slice if exposed); reuses `wilsonInterval` for the no-worse-pass-rate guard. Emits the markdown verdict table.
