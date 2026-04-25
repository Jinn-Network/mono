# Default learning restorer — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the harness-agnostic foundation of the default learning restorer — package scaffold, types, git-backed `implStateDir` utility, path-scope guard, constitution helper, NoOp harness adapter for tests, phase scaffolds, orchestrator, and `RestorerImpl` shell — such that a synthetic `run(ctx)` traverses all seven phases on a NoOp adapter, writes artifacts to the expected paths, and commits to `implStateDir`. No real subagent spawning, no real `wait()`, no skill markdown content, no registry wiring — those land in subsequent plans.

**Architecture:** New impl directory under `client/src/restorer/impls/default-learner/`. Pure-TypeScript, vitest tests. The `DefaultLearningRestorerImpl` implements the existing `RestorerImpl` interface and constructs an `Orchestrator` that walks a fixed phase pipeline. Each phase is a function that takes typed inputs and returns typed outputs + artifacts; the orchestrator threads inputs/outputs and writes per-phase artifacts under `workingDir/.<phase>/`. The harness adapter is an interface — Plan 1 ships a `NoOpHarnessAdapter` only, used in tests; the Claude Code adapter and skill markdown bundles ship in Plan 2.

**Tech Stack:** TypeScript (ESM, Node >=20), Vitest, Yarn 4.13, `node:child_process` for git CLI (no library dependency), `node:fs/promises` for filesystem.

**Spec reference:** `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.

**Existing code anchors:**
- `client/src/restorer/types.ts` — `RestorerImpl`, `RestorationContext`, `RestorationOutput`, `SkippableError`
- `client/src/restorer/impls/index.ts` — `buildRestorerImpls` (NOT touched in Plan 1)
- `client/src/restorer/engine/engine.ts:451-471` — engine already provisions `workingDir` and `implStateDir` before calling `impl.run(ctx)`
- `client/src/restorer/engine/packaging.ts:112` — `provisionImplStateDir` (mkdir only; git init happens lazily inside our impl)

---

## File structure (Plan 1)

**Source files (under `client/src/restorer/impls/default-learner/`):**

| File | Responsibility |
|---|---|
| `index.ts` | Public exports: `DefaultLearningRestorerImpl`, types |
| `types.ts` | `HarnessAdapter`, `PhaseId`, `PhaseInput`, `PhaseOutput`, `OrchestratorState`, `WaitOptions` |
| `path-guard.ts` | `assertPathInScope(path, allowedRoots)` — blocks writes outside `implStateDir` + `workingDir` |
| `git-impl-state.ts` | `ensureGitRepo(dir)`, `commitChange(dir, message)`, `revertHead(dir)` — wraps git CLI |
| `constitution.ts` | `serializeConstitution(snapshot)` — returns OTel span attributes |
| `phases.ts` | Abstract `Phase` type + seven stub `Phase` implementations |
| `orchestrator.ts` | `runPipeline(ctx, adapter)` — boot, sequence phases, return `RestorationOutput` |
| `restorer.ts` | `DefaultLearningRestorerImpl` — `RestorerImpl` shell |
| `test-utils/noop-adapter.ts` | `NoOpHarnessAdapter` — synchronous in-process test fixture |

**Test files (under `client/test/restorer/impls/default-learner/`):**

| File | Coverage |
|---|---|
| `path-guard.test.ts` | Path scope assertions |
| `git-impl-state.test.ts` | Git repo init + commit + revert |
| `constitution.test.ts` | Span attribute serialization |
| `orchestrator.test.ts` | Phase ordering + state propagation |
| `restorer-lifecycle.test.ts` | End-to-end on NoOp adapter — phase order, artifact paths, implStateDir commit, RestorationOutput shape |

---

## Task 1: Create package scaffold + public exports

**Files:**
- Create: `client/src/restorer/impls/default-learner/index.ts`

- [ ] **Step 1: Create the directory and the placeholder index file**

```bash
mkdir -p client/src/restorer/impls/default-learner
```

- [ ] **Step 2: Write `index.ts` as a placeholder export**

```typescript
// client/src/restorer/impls/default-learner/index.ts
/**
 * @jinn-network/default-learner — default learning restorer.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md (v1.1)
 *
 * Plan 1 (foundation) ships scaffolding only — no real harness adapter, no
 * skill content, not registered in buildRestorerImpls.
 */

export {};
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/restorer/impls/default-learner/index.ts
git commit -m "feat(default-learner): package scaffold"
```

---

## Task 2: Core types

**Files:**
- Create: `client/src/restorer/impls/default-learner/types.ts`
- Modify: `client/src/restorer/impls/default-learner/index.ts`

- [ ] **Step 1: Write the type definitions**

```typescript
// client/src/restorer/impls/default-learner/types.ts
import type { RestorationContext } from '../../types.js';

/** Identifiers for the seven pipeline phases. Ordered. */
export const PHASE_IDS = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

export type PhaseId = (typeof PHASE_IDS)[number];

/** Options for the unified `wait()` primitive (spec §5). */
export interface WaitOptions {
  /** Block at least this many ms (unless condition fires first). */
  durationMs?: number;
  /** Block until this absolute timestamp (unless condition fires first). */
  untilTs?: number;
  /**
   * Block until this condition fires. Implementation is harness-specific.
   * Pure timed waits omit this.
   */
  condition?: { kind: string; [attr: string]: unknown };
}

/**
 * Harness-agnostic interface every adapter must satisfy.
 *
 * Plan 1 ships only a NoOp implementation under `test-utils/`.
 * The Claude Code adapter ships in Plan 2.
 */
export interface HarnessAdapter {
  /** Adapter name (for logs / spans). */
  readonly name: string;

  /**
   * Spawn a bounded subagent with fresh context.
   * Returns the subagent's structured output. The harness adapter is
   * responsible for any nesting limits — orchestrator does not assume
   * nesting is supported.
   */
  spawnSubagent(input: SubagentInput): Promise<SubagentOutput>;

  /** Block until duration / deadline / condition fires. */
  wait(opts: WaitOptions): Promise<void>;

  /** Whether this adapter permits Improve to patch harness install. */
  readonly allowsHarnessSelfModification: boolean;
}

/** Bounded inputs passed to a fresh-context subagent. */
export interface SubagentInput {
  /** What the subagent is being asked to do (free-form text or structured). */
  task: string;
  /** Inputs the subagent reads (artifact paths, structured payloads). */
  inputs: Record<string, unknown>;
  /** Path roots the subagent may write to. */
  writableRoots: string[];
  /** Remaining ms in the run window when this subagent is spawned. */
  msUntilEndTs: number;
}

/** Structured handoff from a subagent back to the orchestrator. */
export interface SubagentOutput {
  /** Free-form summary the orchestrator threads to the next phase. */
  summary: string;
  /** Structured payload (phase-specific shape). */
  payload: Record<string, unknown>;
  /** Paths of artifacts the subagent wrote. */
  artifactPaths: string[];
}

/** Per-phase typed input. Phases not yet active receive `null` slots. */
export interface PhaseInput {
  ctx: RestorationContext;
  adapter: HarnessAdapter;
  /** Output from the prior phase, if any. */
  prior: PhaseOutput | null;
  /** Mutable state the orchestrator threads through phases. */
  state: OrchestratorState;
}

/** Phase output handed back to the orchestrator. */
export interface PhaseOutput {
  phase: PhaseId;
  summary: string;
  payload: Record<string, unknown>;
  artifactPaths: string[];
}

/** Mutable orchestrator state threaded across phases within one run. */
export interface OrchestratorState {
  /** Per-phase outputs accumulated so far. */
  history: PhaseOutput[];
  /** Once Strategize commits, this holds the frozen snapshot. */
  constitution?: ConstitutionSnapshot;
}

/** Frozen run-start invariants per spec §10. */
export interface ConstitutionSnapshot {
  successCriteriaCid: string;
  timingPosture: 'early-return' | 'hold-and-revise' | 'continuous-observation';
  skillBundleCid: string;
  implStateDirSha: string;
  editableScope: string[];
}
```

- [ ] **Step 2: Re-export from `index.ts`**

```typescript
// client/src/restorer/impls/default-learner/index.ts
/**
 * @jinn-network/default-learner — default learning restorer.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md (v1.1)
 *
 * Plan 1 (foundation) ships scaffolding only — no real harness adapter, no
 * skill content, not registered in buildRestorerImpls.
 */

export type {
  HarnessAdapter,
  SubagentInput,
  SubagentOutput,
  WaitOptions,
  PhaseId,
  PhaseInput,
  PhaseOutput,
  OrchestratorState,
  ConstitutionSnapshot,
} from './types.js';
export { PHASE_IDS } from './types.js';
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/restorer/impls/default-learner/
git commit -m "feat(default-learner): core types"
```

---

## Task 3: Path-scope guard

The orchestrator and (eventually) Improve must not write outside `implStateDir` + `workingDir`. This utility centralizes the check.

**Files:**
- Create: `client/src/restorer/impls/default-learner/path-guard.ts`
- Test: `client/test/restorer/impls/default-learner/path-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
mkdir -p client/test/restorer/impls/default-learner
```

```typescript
// client/test/restorer/impls/default-learner/path-guard.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { assertPathInScope, isPathInScope } from '../../../../src/restorer/impls/default-learner/path-guard.js';

describe('path-guard', () => {
  const work = resolve('/tmp/jinn-test-work');
  const state = resolve('/tmp/jinn-test-state');
  const roots = [work, state];

  it('accepts paths inside an allowed root', () => {
    expect(isPathInScope(resolve(work, 'a/b/c.json'), roots)).toBe(true);
    expect(isPathInScope(resolve(state, 'env/keystore.json'), roots)).toBe(true);
  });

  it('rejects paths outside all allowed roots', () => {
    expect(isPathInScope('/etc/passwd', roots)).toBe(false);
    expect(isPathInScope(resolve(work, '..', 'sibling'), roots)).toBe(false);
  });

  it('rejects relative path traversal that escapes a root', () => {
    expect(isPathInScope(resolve(work, 'a', '..', '..', 'escape'), roots)).toBe(false);
  });

  it('assertPathInScope throws with the offending path in the message', () => {
    expect(() => assertPathInScope('/etc/passwd', roots)).toThrowError(/path outside scope/i);
    expect(() => assertPathInScope('/etc/passwd', roots)).toThrowError(/etc\/passwd/);
  });

  it('assertPathInScope is a no-op for in-scope paths', () => {
    expect(() => assertPathInScope(resolve(work, 'ok.json'), roots)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/path-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `path-guard.ts`**

```typescript
// client/src/restorer/impls/default-learner/path-guard.ts
import { resolve, relative, sep } from 'node:path';

/**
 * Returns true iff `path` resolves inside one of `allowedRoots`.
 * Symbolic links are not resolved here; if symlinks become a vector,
 * the orchestrator should `realpath` before checking.
 */
export function isPathInScope(path: string, allowedRoots: string[]): boolean {
  const absPath = resolve(path);
  return allowedRoots.some((root) => {
    const absRoot = resolve(root);
    const rel = relative(absRoot, absPath);
    if (rel === '') return true;
    return !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
  });
}

/**
 * Throws if `path` is not inside any allowed root.
 * Message includes the offending path so callers can include it in spans.
 */
export function assertPathInScope(path: string, allowedRoots: string[]): void {
  if (!isPathInScope(path, allowedRoots)) {
    throw new Error(
      `path outside scope: ${resolve(path)} (allowed roots: ${allowedRoots.map((r) => resolve(r)).join(', ')})`,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/path-guard.test.ts`
Expected: PASS, all five test cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/impls/default-learner/path-guard.ts client/test/restorer/impls/default-learner/path-guard.test.ts
git commit -m "feat(default-learner): path-scope guard"
```

---

## Task 4: Git-backed implStateDir utility

Wraps `git init`, `git add . && git commit`, and `git revert HEAD` against a target directory using the git CLI. No library dependency.

**Files:**
- Create: `client/src/restorer/impls/default-learner/git-impl-state.ts`
- Test: `client/test/restorer/impls/default-learner/git-impl-state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/git-impl-state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureGitRepo,
  commitChange,
  revertHead,
  currentSha,
} from '../../../../src/restorer/impls/default-learner/git-impl-state.js';

describe('git-impl-state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-impl-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensureGitRepo creates a repo with an initial empty commit', () => {
    const sha = ensureGitRepo(dir);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ensureGitRepo is idempotent — second call returns same head sha', () => {
    const first = ensureGitRepo(dir);
    const second = ensureGitRepo(dir);
    expect(second).toEqual(first);
  });

  it('commitChange stages and commits all changes; returns new sha', () => {
    ensureGitRepo(dir);
    writeFileSync(join(dir, 'foo.txt'), 'hello');
    const sha = commitChange(dir, 'add foo');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(currentSha(dir)).toEqual(sha);
  });

  it('commitChange returns null and does not commit when nothing to stage', () => {
    ensureGitRepo(dir);
    const sha = commitChange(dir, 'no-op');
    expect(sha).toBeNull();
  });

  it('revertHead applies an inverse commit; file content reverts', () => {
    ensureGitRepo(dir);
    writeFileSync(join(dir, 'foo.txt'), 'first');
    commitChange(dir, 'add foo');
    writeFileSync(join(dir, 'foo.txt'), 'second');
    commitChange(dir, 'change foo');
    expect(readFileSync(join(dir, 'foo.txt'), 'utf8')).toEqual('second');

    revertHead(dir);
    expect(readFileSync(join(dir, 'foo.txt'), 'utf8')).toEqual('first');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/git-impl-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `git-impl-state.ts`**

```typescript
// client/src/restorer/impls/default-learner/git-impl-state.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Synchronous wrappers around the git CLI for a single implStateDir repo.
 * Each operation is best-effort idempotent.
 *
 * Author identity is deterministic and local-only — no remote, no signing —
 * because implStateDir history is operator-private.
 */

const AUTHOR_NAME = 'jinn-default-learner';
const AUTHOR_EMAIL = 'default-learner@jinn.local';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    },
  }).trim();
}

/**
 * Initialize `dir` as a git repo if not already one. Returns the current
 * HEAD sha after ensuring an initial commit exists. Idempotent.
 */
export function ensureGitRepo(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(join(dir, '.git'))) {
    git(dir, 'init', '--initial-branch=main', '--quiet');
    git(dir, 'commit', '--allow-empty', '-m', 'init implStateDir', '--quiet');
  }
  return currentSha(dir);
}

/**
 * Stage all current working-tree changes and create a commit.
 * Returns the new HEAD sha, or null if there was nothing to commit.
 */
export function commitChange(dir: string, message: string): string | null {
  git(dir, 'add', '-A');
  const status = git(dir, 'status', '--porcelain');
  if (status === '') return null;
  git(dir, 'commit', '-m', message, '--quiet');
  return currentSha(dir);
}

/**
 * Apply an inverse commit on top of HEAD. Used by Memory consolidation
 * when the cross-run trend says a recently promoted change made things
 * worse. Caller is responsible for choosing which commit to revert —
 * this helper reverts HEAD specifically.
 */
export function revertHead(dir: string): string {
  git(dir, 'revert', '--no-edit', 'HEAD', '--quiet');
  return currentSha(dir);
}

/** Current HEAD sha. */
export function currentSha(dir: string): string {
  return git(dir, 'rev-parse', 'HEAD');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/git-impl-state.test.ts`
Expected: PASS, all five test cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/impls/default-learner/git-impl-state.ts client/test/restorer/impls/default-learner/git-impl-state.test.ts
git commit -m "feat(default-learner): git-backed implStateDir utility"
```

---

## Task 5: Constitution attribute serializer

Strategize freezes `ConstitutionSnapshot`; the orchestrator emits a run-start `jinn.state_transition` span (Plan 2 wires real OTel; Plan 1 just produces the attributes).

**Files:**
- Create: `client/src/restorer/impls/default-learner/constitution.ts`
- Test: `client/test/restorer/impls/default-learner/constitution.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/constitution.test.ts
import { describe, it, expect } from 'vitest';
import { serializeConstitution } from '../../../../src/restorer/impls/default-learner/constitution.js';
import type { ConstitutionSnapshot } from '../../../../src/restorer/impls/default-learner/types.js';

describe('serializeConstitution', () => {
  it('maps snapshot fields to OTel-style span attributes', () => {
    const snap: ConstitutionSnapshot = {
      successCriteriaCid: 'bafy123',
      timingPosture: 'hold-and-revise',
      skillBundleCid: 'bafy456',
      implStateDirSha: '0123456789abcdef0123456789abcdef01234567',
      editableScope: ['/work/a', '/state/b'],
    };

    const attrs = serializeConstitution(snap);

    expect(attrs).toEqual({
      'jinn.constitution.successCriteriaCid': 'bafy123',
      'jinn.constitution.timingPosture': 'hold-and-revise',
      'jinn.constitution.skillBundleCid': 'bafy456',
      'jinn.constitution.implStateDirSha': '0123456789abcdef0123456789abcdef01234567',
      'jinn.constitution.editableScope': ['/work/a', '/state/b'],
    });
  });

  it('preserves array order in editableScope', () => {
    const snap: ConstitutionSnapshot = {
      successCriteriaCid: 'a',
      timingPosture: 'early-return',
      skillBundleCid: 'b',
      implStateDirSha: 'c',
      editableScope: ['/x', '/y', '/z'],
    };
    const attrs = serializeConstitution(snap);
    expect(attrs['jinn.constitution.editableScope']).toEqual(['/x', '/y', '/z']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/constitution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `constitution.ts`**

```typescript
// client/src/restorer/impls/default-learner/constitution.ts
import type { ConstitutionSnapshot } from './types.js';

/**
 * Per spec §10: Strategize's frozen invariants are emitted as attributes
 * on a run-start `jinn.state_transition` span. This serializer only
 * produces the attribute map — the actual span emission happens in the
 * harness adapter (Plan 2) which has access to the OTel tracer.
 */
export function serializeConstitution(
  snap: ConstitutionSnapshot,
): Record<string, string | string[]> {
  return {
    'jinn.constitution.successCriteriaCid': snap.successCriteriaCid,
    'jinn.constitution.timingPosture': snap.timingPosture,
    'jinn.constitution.skillBundleCid': snap.skillBundleCid,
    'jinn.constitution.implStateDirSha': snap.implStateDirSha,
    'jinn.constitution.editableScope': snap.editableScope,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/constitution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/impls/default-learner/constitution.ts client/test/restorer/impls/default-learner/constitution.test.ts
git commit -m "feat(default-learner): constitution attribute serializer"
```

---

## Task 6: NoOp harness adapter (test fixture)

A synchronous in-process implementation of `HarnessAdapter` used in tests. `spawnSubagent` invokes a registered handler keyed by `task` string; `wait()` resolves immediately for short durations and rejects on `untilTs` past now (no real timer in tests).

**Files:**
- Create: `client/src/restorer/impls/default-learner/test-utils/noop-adapter.ts`

- [ ] **Step 1: Implement the NoOp adapter**

```typescript
// client/src/restorer/impls/default-learner/test-utils/noop-adapter.ts
import type {
  HarnessAdapter,
  SubagentInput,
  SubagentOutput,
  WaitOptions,
} from '../types.js';

export type NoOpHandler = (input: SubagentInput) => SubagentOutput | Promise<SubagentOutput>;

/**
 * Test-only HarnessAdapter. Routes spawnSubagent calls to a registered
 * handler map keyed by SubagentInput.task. Unhandled tasks return an
 * empty SubagentOutput so the orchestrator can still progress.
 *
 * `wait()` is a no-op (resolves immediately) — sleeping in tests is bad.
 * Tests that need to assert wait was called should use a mock instead.
 */
export class NoOpHarnessAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;

  private readonly handlers = new Map<string, NoOpHandler>();
  private readonly waitCalls: WaitOptions[] = [];

  /** Register a handler for a specific task string. */
  on(task: string, handler: NoOpHandler): this {
    this.handlers.set(task, handler);
    return this;
  }

  /** Inspect what `wait()` was called with — useful for assertions. */
  getWaitCalls(): readonly WaitOptions[] {
    return this.waitCalls;
  }

  async spawnSubagent(input: SubagentInput): Promise<SubagentOutput> {
    const handler = this.handlers.get(input.task);
    if (!handler) {
      return {
        summary: `noop: unhandled task ${input.task}`,
        payload: {},
        artifactPaths: [],
      };
    }
    return handler(input);
  }

  async wait(opts: WaitOptions): Promise<void> {
    this.waitCalls.push(opts);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/restorer/impls/default-learner/test-utils/noop-adapter.ts
git commit -m "feat(default-learner): NoOp harness adapter (test fixture)"
```

---

## Task 7: Phase scaffolds

Each phase is a function that returns typed output. Plan 1 stubs all seven; Plan 2 fills in the real spawning logic via the harness adapter.

**Files:**
- Create: `client/src/restorer/impls/default-learner/phases.ts`

- [ ] **Step 1: Implement the phase scaffolds**

```typescript
// client/src/restorer/impls/default-learner/phases.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PhaseId,
  PhaseInput,
  PhaseOutput,
  ConstitutionSnapshot,
} from './types.js';

/**
 * Plan 1 stubs:
 *   - each phase writes a marker file under workingDir/.<phase>/output.json
 *     so the lifecycle test can assert artifact paths
 *   - Strategize commits a synthetic ConstitutionSnapshot into state
 *   - no real subagent spawning yet; that lands in Plan 2 via adapter
 *
 * The function signature is uniform across all phases so the orchestrator
 * can drive them in a loop.
 */
export type PhaseFn = (input: PhaseInput) => Promise<PhaseOutput>;

async function writeMarker(
  workingDir: string,
  phase: PhaseId,
  payload: Record<string, unknown>,
): Promise<string> {
  const dir = join(workingDir, `.${phase}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'output.json');
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}

export const orient: PhaseFn = async ({ ctx }) => {
  const path = await writeMarker(ctx.workingDir, 'orient', {
    intentId: ctx.intent.id,
    note: 'stub orient output (plan 1)',
  });
  return {
    phase: 'orient',
    summary: 'stub orient',
    payload: { intentId: ctx.intent.id },
    artifactPaths: [path],
  };
};

export const strategize: PhaseFn = async ({ ctx, state }) => {
  const constitution: ConstitutionSnapshot = {
    successCriteriaCid: 'stub:criteria',
    timingPosture: 'early-return',
    skillBundleCid: 'stub:bundle',
    implStateDirSha: 'stub:sha',
    editableScope: [ctx.implStateDir, ctx.workingDir],
  };
  state.constitution = constitution;
  const path = await writeMarker(ctx.workingDir, 'strategize', {
    constitution,
  });
  return {
    phase: 'strategize',
    summary: 'stub strategize',
    payload: { constitution },
    artifactPaths: [path],
  };
};

export const plan: PhaseFn = async ({ ctx }) => {
  const path = await writeMarker(ctx.workingDir, 'plan', {
    steps: [{ kind: 'noop', desc: 'stub' }],
  });
  return {
    phase: 'plan',
    summary: 'stub plan',
    payload: { stepCount: 1 },
    artifactPaths: [path],
  };
};

export const execute: PhaseFn = async ({ ctx }) => {
  const path = await writeMarker(ctx.workingDir, 'execute', {
    decision: 'continue',
    workersSpawned: 0,
  });
  return {
    phase: 'execute',
    summary: 'stub execute',
    payload: { workersSpawned: 0 },
    artifactPaths: [path],
  };
};

export const debrief: PhaseFn = async ({ ctx }) => {
  const path = await writeMarker(ctx.workingDir, 'debrief', {
    successCriteriaMet: true,
    note: 'stub debrief — always passes',
  });
  return {
    phase: 'debrief',
    summary: 'stub debrief',
    payload: { successCriteriaMet: true },
    artifactPaths: [path],
  };
};

export const improve: PhaseFn = async ({ ctx }) => {
  // Stub: no real mutation. Plan 2 will write to implStateDir + emit
  // promotion_record artifacts.
  const path = await writeMarker(ctx.workingDir, 'improve', {
    mutations: [],
    accessRequests: [],
  });
  return {
    phase: 'improve',
    summary: 'stub improve',
    payload: { mutationCount: 0 },
    artifactPaths: [path],
  };
};

export const memoryConsolidation: PhaseFn = async ({ ctx }) => {
  const path = await writeMarker(ctx.workingDir, 'memory-consolidation', {
    durablePruned: 0,
    ephemeralReclassified: 0,
  });
  return {
    phase: 'memory-consolidation',
    summary: 'stub memory consolidation',
    payload: { pruned: 0 },
    artifactPaths: [path],
  };
};

/**
 * Ordered map of all phases. The orchestrator iterates this in order.
 * Execute is included like every other phase even though spec §4.4 calls
 * it "session-level" — Plan 1's Execute stub does not spawn nested
 * subagents (none of the stubs do); Plan 2 fills in the real worker
 * spawning logic at session level via the adapter.
 */
export const PHASE_SEQUENCE: ReadonlyArray<{ id: PhaseId; fn: PhaseFn }> = [
  { id: 'orient', fn: orient },
  { id: 'strategize', fn: strategize },
  { id: 'plan', fn: plan },
  { id: 'execute', fn: execute },
  { id: 'debrief', fn: debrief },
  { id: 'improve', fn: improve },
  { id: 'memory-consolidation', fn: memoryConsolidation },
];
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/restorer/impls/default-learner/phases.ts
git commit -m "feat(default-learner): phase scaffolds (stubs)"
```

---

## Task 8: Orchestrator

The orchestrator boots (ensures git repo on `implStateDir`, propagates context), then iterates `PHASE_SEQUENCE` threading state forward.

**Files:**
- Create: `client/src/restorer/impls/default-learner/orchestrator.ts`
- Test: `client/test/restorer/impls/default-learner/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/orchestrator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../../../src/restorer/impls/default-learner/orchestrator.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/default-learner/test-utils/noop-adapter.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(workingDir: string, implStateDir: string): RestorationContext {
  const endTs = Date.now() + 60_000;
  return {
    intent: {
      id: 'test-intent-1',
      description: 'unit test intent',
      window: { startTs: Date.now() - 1000, endTs },
    } as RestorationContext['intent'],
    intentCid: 'bafytest',
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  };
}

describe('orchestrator.runPipeline', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-orch-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-orch-state-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('runs all seven phases in order and returns RestorationOutput', async () => {
    const adapter = new NoOpHarnessAdapter();
    const ctx = makeCtx(workingDir, implStateDir);

    const result = await runPipeline(ctx, adapter);

    expect(result.history.map((p) => p.phase)).toEqual([
      'orient',
      'strategize',
      'plan',
      'execute',
      'debrief',
      'improve',
      'memory-consolidation',
    ]);
  });

  it('writes a marker artifact per phase under workingDir/.<phase>/', async () => {
    const adapter = new NoOpHarnessAdapter();
    const ctx = makeCtx(workingDir, implStateDir);

    await runPipeline(ctx, adapter);

    for (const phase of [
      'orient',
      'strategize',
      'plan',
      'execute',
      'debrief',
      'improve',
      'memory-consolidation',
    ]) {
      expect(existsSync(join(workingDir, `.${phase}`, 'output.json'))).toBe(true);
    }
  });

  it('initializes implStateDir as a git repo on first call', async () => {
    const adapter = new NoOpHarnessAdapter();
    const ctx = makeCtx(workingDir, implStateDir);

    await runPipeline(ctx, adapter);

    expect(existsSync(join(implStateDir, '.git'))).toBe(true);
  });

  it('threads constitution from Strategize into later phases via state', async () => {
    const adapter = new NoOpHarnessAdapter();
    const ctx = makeCtx(workingDir, implStateDir);

    const result = await runPipeline(ctx, adapter);

    expect(result.constitution).toBeDefined();
    expect(result.constitution?.timingPosture).toEqual('early-return');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

```typescript
// client/src/restorer/impls/default-learner/orchestrator.ts
import type { RestorationContext } from '../../types.js';
import type { HarnessAdapter, OrchestratorState, PhaseInput } from './types.js';
import { PHASE_SEQUENCE } from './phases.js';
import { ensureGitRepo } from './git-impl-state.js';

export interface PipelineResult {
  history: OrchestratorState['history'];
  constitution: OrchestratorState['constitution'];
  /** SHA of implStateDir at run start (for the constitution span). */
  implStateDirShaAtStart: string;
}

/**
 * Boots, then runs all phases in order. State is threaded across phases —
 * Strategize's constitution becomes available to Debrief/Improve via
 * `state.constitution`.
 *
 * This is intentionally synchronous in flow control. Parallelism, when it
 * applies, lives inside individual phases (e.g., Orient's explorers fan
 * out internally). The orchestrator does not interleave phases.
 */
export async function runPipeline(
  ctx: RestorationContext,
  adapter: HarnessAdapter,
): Promise<PipelineResult> {
  // Boot: ensure implStateDir is a git repo. The engine has already
  // mkdir'd it (engine.ts:471 calls provisionImplStateDir); we add the
  // git layer.
  const implStateDirShaAtStart = ensureGitRepo(ctx.implStateDir);

  const state: OrchestratorState = { history: [] };

  for (const { fn } of PHASE_SEQUENCE) {
    const input: PhaseInput = {
      ctx,
      adapter,
      prior: state.history.length > 0 ? state.history[state.history.length - 1] : null,
      state,
    };
    const out = await fn(input);
    state.history.push(out);
  }

  return {
    history: state.history,
    constitution: state.constitution,
    implStateDirShaAtStart,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/orchestrator.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/impls/default-learner/orchestrator.ts client/test/restorer/impls/default-learner/orchestrator.test.ts
git commit -m "feat(default-learner): pipeline orchestrator"
```

---

## Task 9: `DefaultLearningRestorerImpl`

Wraps the orchestrator behind the existing `RestorerImpl` interface. Plan 1 makes it constructible and runnable, but does NOT register it in `buildRestorerImpls` — that lands in Plan 3 with the registry-precedence decision.

**Files:**
- Create: `client/src/restorer/impls/default-learner/restorer.ts`
- Modify: `client/src/restorer/impls/default-learner/index.ts`

- [ ] **Step 1: Implement `DefaultLearningRestorerImpl`**

```typescript
// client/src/restorer/impls/default-learner/restorer.ts
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
} from '../../types.js';
import type { HarnessAdapter } from './types.js';
import { runPipeline } from './orchestrator.js';

export interface DefaultLearningRestorerConfig {
  /** Harness adapter (NoOp for tests; Claude Code adapter ships in Plan 2). */
  adapter: HarnessAdapter;
  /** Optional override for the impl name (defaults to 'default-learner'). */
  name?: string;
  /** Semver string for envelope provenance (defaults to '0.1.0-foundation'). */
  version?: string;
}

/**
 * `RestorerImpl` shell. The interesting work happens inside the orchestrator;
 * this class adapts that to the engine's existing dispatch contract
 * (engine.ts:533 calls `await impl.run(ctx)`).
 *
 * Plan 1 returns a minimal `RestorationOutput`. Plan 2 enriches the output
 * once real phases produce real results. Plan 3 wires this into
 * `buildRestorerImpls`.
 */
export class DefaultLearningRestorerImpl implements RestorerImpl {
  readonly name: string;
  readonly version: string;
  private readonly adapter: HarnessAdapter;

  constructor(config: DefaultLearningRestorerConfig) {
    this.adapter = config.adapter;
    this.name = config.name ?? 'default-learner';
    this.version = config.version ?? '0.1.0-foundation';
  }

  /**
   * Plan 1: matches every kind. Plan 3 will revisit per the
   * registry-precedence decision (first-match wrapper / last-match /
   * replace-specialists).
   */
  supports(_spec: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return true;
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const result = await runPipeline(ctx, this.adapter);

    // Plan 1 returns a minimal RestorationOutput — fields the engine's
    // packaging layer requires plus a notes-only payload pointing at the
    // pipeline result. Plan 2 will populate gating/informational from the
    // real Execute output.
    return {
      venueRef: { name: 'default-learner-stub' },
      gating: {
        phasesCompleted: result.history.map((p) => p.phase),
        timingPosture: result.constitution?.timingPosture ?? null,
      },
    };
  }
}
```

- [ ] **Step 2: Re-export from `index.ts`**

```typescript
// client/src/restorer/impls/default-learner/index.ts
/**
 * @jinn-network/default-learner — default learning restorer.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md (v1.1)
 *
 * Plan 1 (foundation) ships scaffolding only — no real harness adapter, no
 * skill content, not registered in buildRestorerImpls.
 */

export type {
  HarnessAdapter,
  SubagentInput,
  SubagentOutput,
  WaitOptions,
  PhaseId,
  PhaseInput,
  PhaseOutput,
  OrchestratorState,
  ConstitutionSnapshot,
} from './types.js';
export { PHASE_IDS } from './types.js';
export { runPipeline, type PipelineResult } from './orchestrator.js';
export { DefaultLearningRestorerImpl, type DefaultLearningRestorerConfig } from './restorer.js';
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/restorer/impls/default-learner/restorer.ts client/src/restorer/impls/default-learner/index.ts
git commit -m "feat(default-learner): RestorerImpl shell"
```

---

## Task 10: Lifecycle integration test

End-to-end: instantiate `DefaultLearningRestorerImpl` with a `NoOpHarnessAdapter`, call `run(ctx)`, assert the full lifecycle properties — phase order, artifact paths, `implStateDir` git init, `RestorationOutput` shape.

**Files:**
- Test: `client/test/restorer/impls/default-learner/restorer-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/restorer-lifecycle.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLearningRestorerImpl } from '../../../../src/restorer/impls/default-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/default-learner/test-utils/noop-adapter.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(workingDir: string, implStateDir: string): RestorationContext {
  const endTs = Date.now() + 60_000;
  return {
    intent: {
      id: 'lifecycle-1',
      description: 'lifecycle test',
      window: { startTs: Date.now() - 1000, endTs },
    } as RestorationContext['intent'],
    intentCid: 'bafylifecycle',
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  };
}

describe('DefaultLearningRestorerImpl — lifecycle', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-life-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-life-state-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('exposes name and version', () => {
    const impl = new DefaultLearningRestorerImpl({ adapter: new NoOpHarnessAdapter() });
    expect(impl.name).toEqual('default-learner');
    expect(impl.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('supports() returns true for any kind in Plan 1', () => {
    const impl = new DefaultLearningRestorerImpl({ adapter: new NoOpHarnessAdapter() });
    expect(impl.supports({ kind: 'portfolio.v0' })).toBe(true);
    expect(impl.supports({ kind: 'prediction.v0', type: 'restoration' })).toBe(true);
    expect(impl.supports({ kind: 'anything', type: 'evaluation' })).toBe(true);
  });

  it('run(ctx) traverses all seven phases and returns valid RestorationOutput', async () => {
    const impl = new DefaultLearningRestorerImpl({ adapter: new NoOpHarnessAdapter() });
    const ctx = makeCtx(workingDir, implStateDir);

    const out = await impl.run(ctx);

    expect(out.venueRef.name).toEqual('default-learner-stub');
    expect(out.gating).toMatchObject({
      phasesCompleted: [
        'orient',
        'strategize',
        'plan',
        'execute',
        'debrief',
        'improve',
        'memory-consolidation',
      ],
      timingPosture: 'early-return',
    });
  });

  it('initializes implStateDir as a git repo and writes a per-phase artifact', async () => {
    const impl = new DefaultLearningRestorerImpl({ adapter: new NoOpHarnessAdapter() });
    const ctx = makeCtx(workingDir, implStateDir);

    await impl.run(ctx);

    expect(existsSync(join(implStateDir, '.git'))).toBe(true);
    for (const phase of [
      'orient',
      'strategize',
      'plan',
      'execute',
      'debrief',
      'improve',
      'memory-consolidation',
    ]) {
      expect(existsSync(join(workingDir, `.${phase}`, 'output.json'))).toBe(true);
    }
  });

  it('two consecutive runs on the same implStateDir do not re-init the repo', async () => {
    const adapter = new NoOpHarnessAdapter();
    const impl = new DefaultLearningRestorerImpl({ adapter });

    const ctx1 = makeCtx(workingDir, implStateDir);
    await impl.run(ctx1);

    const workingDir2 = mkdtempSync(join(tmpdir(), 'jinn-life-work2-'));
    try {
      const ctx2 = makeCtx(workingDir2, implStateDir);
      await impl.run(ctx2);
      // Second run should still see a valid git repo (idempotent ensureGitRepo).
      expect(existsSync(join(implStateDir, '.git'))).toBe(true);
    } finally {
      rmSync(workingDir2, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/restorer-lifecycle.test.ts`
Expected: PASS, all five cases. (No "fail first" step — this is an integration test over already-implemented pieces; if it fails, fix the underlying piece, not the test.)

- [ ] **Step 3: Run the full default-learner test suite**

Run: `cd client && yarn vitest run test/restorer/impls/default-learner/`
Expected: PASS — every test in path-guard, git-impl-state, constitution, orchestrator, and lifecycle.

- [ ] **Step 4: Run the full client test suite to ensure nothing else broke**

Run: `cd client && yarn test`
Expected: PASS — pre-existing tests are unaffected because nothing in `buildRestorerImpls` was touched.

- [ ] **Step 5: Commit**

```bash
git add client/test/restorer/impls/default-learner/restorer-lifecycle.test.ts
git commit -m "test(default-learner): lifecycle integration test"
```

---

## Plan 1 acceptance

When all 10 tasks are committed:

- [ ] `cd client && yarn typecheck` — zero errors.
- [ ] `cd client && yarn vitest run test/restorer/impls/default-learner/` — every test passes.
- [ ] `cd client && yarn test` — pre-existing client tests still pass (nothing in `buildRestorerImpls` was touched).
- [ ] `client/src/restorer/impls/default-learner/index.ts` exports `DefaultLearningRestorerImpl` — but the impl is NOT registered in `buildRestorerImpls`. Daemon behavior is unchanged.
- [ ] A consumer can construct `new DefaultLearningRestorerImpl({ adapter: new NoOpHarnessAdapter() })` and call `run(ctx)` to traverse the seven-phase pipeline, write per-phase artifacts under `workingDir/.<phase>/output.json`, and ensure `implStateDir` is a git repo.

---

## What Plan 2 will pick up

- Coordinator meta-skill markdown (`client/src/restorer/impls/default-learner/skills/coordinator.md` or similar layout — TBD by Plan 2)
- Per-phase skill markdowns (Orient, Strategize, Plan, Execute, Debrief, Improve, Memory consolidation)
- Real Claude Code harness adapter using the Agent tool for subagent spawning + a real `wait()` implementation
- Promotion of the phase stubs to actually invoke `adapter.spawnSubagent()` with real prompts
- Real OTel span emission including the run-start `jinn.state_transition` constitution span

## What Plan 3 will pick up

- `buildRestorerImpls` registry wiring per the §12 first-match-wrapper recommendation
- Portfolio.v0 end-to-end acceptance test on Anvil fork
- Replan-path acceptance test (failing Execute step exercises runtime judgment)
- The out-of-scope-write block test (synthetic Execute step tries to write outside `implStateDir`/`workingDir`)
