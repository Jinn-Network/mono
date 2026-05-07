# Freeze-mode Protocol Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `mode: 'train' | 'frozen'` flag to the `Harness` interface contract and the envelope schema, enforce the contract via a daemon-side hash-fence, and wire the bundled `claude-code-learner` harness to respect it.

**Architecture:** The mode field propagates from operator config → `HarnessContext.mode` → harness implementation → `Executor.mode` on the produced envelope. When `ctx.mode === 'frozen'`, the harness MUST NOT write to `ctx.implStateDir`; the daemon enforces by hashing implStateDir before and after each Task and rejecting envelopes where the hash changed (rolling back to the pre-Task snapshot). Learning mode is the default and unchanged behaviour. claude-code-learner gains a config gate that disables the Improve and Memory phase invocations when frozen.

**Tech Stack:** TypeScript (Node 22, yarn workspaces); Zod (envelope schema); vitest (unit + integration tests); Node `crypto` + `fs/promises` (hash fence); existing `client/src/harnesses/engine/engine.ts` (dispatch site).

**Spec:** `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §6.

**DRs covered:** DR-2026-05-06-c (frozen-state contract), DR-2026-05-06-d (trust stack composition), DR-2026-05-06-g (vocabulary: train / frozen / HarnessCheckpoint).

**Out of scope (other plans):** SWE-rebench v2 SolverNet contract + evaluator + task generator (separate plan); subgraph/dashboard/CLI surface for two-leaderboard view + `jinn checkpoint publish/install` (separate plan).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/sdk/src/harness.ts` | **Modify** | Add `mode: 'train' \| 'frozen'` to `HarnessContext`. Export `requireTrain` helper. Update JSDoc. |
| `packages/sdk/src/harness.test.ts` | **Create** | Type-level tests for `mode` field; behavioural tests for `requireTrain`. |
| `client/src/harnesses/types.ts` | **Modify** | Mirror `mode: 'train' \| 'frozen'` on the client-side `HarnessContext`. |
| `client/src/types/envelope.ts` | **Modify** | Add `mode: z.enum(['train', 'frozen']).default('train')` to `ExecutorSchema`. Backward-compatible (defaults to `'train'`). |
| `client/test/envelope-schema.test.ts` | **Modify** | New test cases: envelope with `mode: 'frozen'` parses; envelope without `mode` defaults to `'train'`. |
| `client/src/harnesses/freeze.ts` | **Create** | `hashImplStateDir(dirPath)` — deterministic SHA-256 Merkle of directory contents. |
| `client/test/harnesses/freeze.test.ts` | **Create** | Unit tests for hash determinism, order-independence, sensitivity. |
| `client/src/daemon/freeze-fence.ts` | **Create** | `runHarnessWithFreezeFence` — wraps `harness.run(ctx)` with snapshot + post-hash check + rollback on violation. Returns `{ ok: true, output, codeDigest }` or `{ ok: false, violation }`. |
| `client/test/daemon/freeze-fence.test.ts` | **Create** | Unit tests: train passthrough, frozen no-violation, frozen violation, harness throw rollback, net-zero writes accepted. |
| `client/src/harnesses/engine/engine.ts` | **Modify** | Replace direct `harness.run(ctx)` call with `runHarnessWithFreezeFence`. Reject envelope on violation. |
| `client/test/harnesses/engine/engine-mode.test.ts` | **Create** | Engine-level integration: `mode=train` produces envelopes with mutating codeDigest; `mode=frozen` produces stable codeDigest; violations skip envelope assembly. |
| `client/src/config.ts` | **Modify** | Add `harness.mode: 'train' \| 'frozen'` (default `'train'`) to `JinnConfigSchema`. |
| `client/test/config.test.ts` | **Modify** | New cases: config parses `harness.mode`; defaults to `'train'`; rejects invalid values. |
| `client/src/harnesses/impls/claude-code-learner/harness.ts` | **Modify** | Read `ctx.mode`; pass through to `adapter.runTask` inputs. |
| `client/src/harnesses/impls/claude-code-learner/types.ts` | **Modify** | Add `mode: 'train' \| 'frozen'` to `TaskSessionInputs`. |
| `client/src/harnesses/impls/claude-code-learner/adapter.ts` | **Modify** | Forward `mode` through to the orchestrator skill invocation prompt. |
| `client/plugins/claude-code-learner/skills/learn/SKILL.md` | **Modify** | Document `mode` parameter; gate Improve and Memory phase invocations on `mode === 'train'`. |
| `client/test/harnesses/impls/claude-code-learner/mode-gate.test.ts` | **Create** | Test: `mode=train` invokes all 7 phases; `mode=frozen` skips Improve and Memory. |
| `client/src/cli/commands/harnesses.ts` | **Modify** | Add `jinn harness mode <train\|frozen>` subcommand; add mode + codeDigest to `jinn harness status` output. |
| `client/test/cli/harness-mode.test.ts` | **Create** | CLI: `mode train` / `mode frozen` round-trip through config; `status` prints current mode + codeDigest. |
| `client/test/e2e/freeze-mode.test.ts` | **Create** | End-to-end on Anvil fork: operator switches modes, codeDigest stability and mutation behave correctly, deliberate-violation harness is caught and envelope rejected. |

Test command throughout: `yarn test` from `client/` (runs `yarn build:sdk && vitest run`).

---

## Task 1: Add `mode` field to SDK `HarnessContext` + envelope `ExecutorSchema`

**Files:**
- Modify: `packages/sdk/src/harness.ts`
- Modify: `client/src/harnesses/types.ts`
- Modify: `client/src/types/envelope.ts`
- Modify: `client/test/envelope-schema.test.ts`

- [ ] **Step 1: Write the failing test for envelope schema accepting `mode: 'frozen'` and defaulting to `'train'`**

Open `client/test/envelope-schema.test.ts` and add:

```typescript
import { describe, it, expect } from 'vitest';
import { UnsignedEnvelopeSchema } from '../src/types/envelope.js';

describe('Executor.mode', () => {
  const baseExecutor = {
    implName: 'test-harness',
    implVersion: '0.1.0',
    clientGitSha: 'abc1234',
    codeDigest: 'sha256:' + '0'.repeat(64),
    runtimeBundleDigest: 'sha256:' + '1'.repeat(64),
    plugins: [],
    signingKey: { kind: 'ed25519' as const, publicKey: '0x' + '2'.repeat(64) },
  };

  const baseEnvelope = {
    schemaVersion: 'jinn.execution.v1',
    intent: { id: 'task-1', solverType: 'prediction.v1' },
    executor: baseExecutor,
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {},
  };

  it('accepts mode: "train" on Executor', () => {
    const env = { ...baseEnvelope, executor: { ...baseExecutor, mode: 'train' } };
    expect(() => UnsignedEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('accepts mode: "frozen" on Executor', () => {
    const env = { ...baseEnvelope, executor: { ...baseExecutor, mode: 'frozen' } };
    expect(() => UnsignedEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('defaults Executor.mode to "train" when absent (back-compat)', () => {
    const env = { ...baseEnvelope, executor: baseExecutor };
    const parsed = UnsignedEnvelopeSchema.parse(env);
    expect(parsed.executor.mode).toBe('train');
  });

  it('rejects invalid mode values', () => {
    const env = { ...baseEnvelope, executor: { ...baseExecutor, mode: 'eval' } };
    expect(() => UnsignedEnvelopeSchema.parse(env)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn test envelope-schema -t "Executor.mode"`

Expected: 4 failures (mode field unknown / default not applied / etc.)

- [ ] **Step 3: Add `mode` to ExecutorSchema in `client/src/types/envelope.ts`**

Locate the `ExecutorSchema = z.object({...})` block (around line 55). Add a `mode` field:

```typescript
const ExecutorSchema = z.object({
  implName: z.string().min(1),
  implVersion: z.string().min(1),
  clientGitSha: z.string().min(1),
  codeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  runtimeBundleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  plugins: z.array(z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    cid: z.string().min(1).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })),
  signingKey: SigningKeySchema,
  source: SourceBundleSchema.optional(),
  /**
   * Harness execution mode. 'train' (default) means the harness was running
   * with state writes enabled (Improve + Memory phases active in
   * claude-code-learner); 'frozen' means writes were disabled and the
   * implStateDir hash was preserved across the Task. See
   * docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.
   * Default 'train' provides backward compatibility with envelopes
   * produced before this field was introduced.
   */
  mode: z.enum(['train', 'frozen']).default('train'),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn test envelope-schema -t "Executor.mode"`

Expected: 4 passes.

- [ ] **Step 5: Add `mode` to SDK `HarnessContext` in `packages/sdk/src/harness.ts`**

Locate the `HarnessContext` interface declaration (around line 38) and append the `mode` field:

```typescript
export interface HarnessContext {
  task: Task;
  taskCid?: string;
  implStateDir: string;
  workingDir: string;
  log: (event: {
    level: 'info' | 'warn' | 'error';
    msg: string;
    data?: unknown;
  }) => void;
  abort: AbortSignal;
  msUntilEndTs: () => number;
  trajectory: TrajectoryCollector;
  signer?: ScopedSigner;
  rpc?: ScopedRpc;
  secrets?: ScopedSecrets;
  /**
   * Harness execution mode.
   *
   * - `'train'` (default): learning mode. The harness's Improve / Memory
   *   phases (or equivalent writeback paths in a Path 2 harness) run;
   *   `implStateDir` mutates as the harness accumulates experience;
   *   `Executor.codeDigest` changes after each Task. Substrate-flow
   *   contributor.
   *
   * - `'frozen'`: evaluation mode. The harness MUST NOT write to
   *   `implStateDir`. State is read-only; `codeDigest` is stable across
   *   the entire frozen window. Verdicts on Solutions produced in this
   *   mode accumulate under a single `(implName, version, codeDigest)`
   *   identity, producing a clean benchmark score directly comparable to
   *   traditional harness leaderboards (OpenHands, SWE-Agent, Aider, etc).
   *
   * The protocol enforces the freeze contract via the daemon-side
   * hash-fence (the daemon hashes implStateDir before and after each Task
   * and rejects envelopes where the hash changed in frozen mode).
   * Path 2 harness implementations MUST gate writes on `mode === 'train'`;
   * the SDK provides `requireTrain(ctx, action)` as an opt-in helper at
   * write call sites.
   *
   * See docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
   * for the full design (trust stack, daemon enforcement, verified vs
   * unverified frozen credibility tier).
   */
  mode: 'train' | 'frozen';
}
```

- [ ] **Step 6: Mirror `mode` on the client-side `HarnessContext` in `client/src/harnesses/types.ts`**

Locate the `HarnessContext` interface (around line 30). Add:

```typescript
export interface HarnessContext {
  // ... existing fields ...
  /**
   * Harness execution mode. See @jinn-network/sdk/harness HarnessContext.mode
   * for full documentation.
   */
  mode: 'train' | 'frozen';
}
```

- [ ] **Step 7: Run typecheck to confirm SDK + client align**

Run: `cd client && yarn typecheck`

Expected: 0 errors related to `mode` (any pre-existing typecheck errors per `client/CLAUDE.md` notes are unrelated).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/harness.ts client/src/harnesses/types.ts client/src/types/envelope.ts client/test/envelope-schema.test.ts
git commit -m "feat(sdk): add HarnessContext.mode and Executor.mode for freeze contract

Adds 'train' | 'frozen' mode field to HarnessContext (SDK + client) and
the Zod ExecutorSchema. Default 'train' preserves backward compatibility
with envelopes produced before this field existed.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
DR: log/decisions/2026-05-06-frozen-state-contract.md"
```

---

## Task 2: SDK helper `requireTrain(ctx, action)`

**Files:**
- Modify: `packages/sdk/src/harness.ts`
- Create: `packages/sdk/test/require-train.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/require-train.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { requireTrain, HarnessError } from '../src/harness.js';
import type { HarnessContext } from '../src/harness.js';

function ctxWithMode(mode: 'train' | 'frozen'): HarnessContext {
  return {
    task: { id: 't1', solverType: 'prediction.v1' } as any,
    implStateDir: '/tmp/x',
    workingDir: '/tmp/y',
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: { addSpan: () => {} } as any,
    mode,
  };
}

describe('requireTrain', () => {
  it('returns silently when mode is "train"', () => {
    expect(() => requireTrain(ctxWithMode('train'), 'update state')).not.toThrow();
  });

  it('throws HarnessError when mode is "frozen"', () => {
    expect(() => requireTrain(ctxWithMode('frozen'), 'update state'))
      .toThrowError(HarnessError);
  });

  it('error message includes the action name', () => {
    try {
      requireTrain(ctxWithMode('frozen'), 'update constitutional state');
      throw new Error('should not reach');
    } catch (e) {
      expect((e as Error).message).toContain('update constitutional state');
      expect((e as Error).message).toContain('frozen');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/require-train.test.ts`

Expected: Failures (`requireTrain` and `HarnessError` not exported).

- [ ] **Step 3: Implement `requireTrain` and `HarnessError` in `packages/sdk/src/harness.ts`**

Append to `packages/sdk/src/harness.ts`:

```typescript
/**
 * Error thrown by SDK helpers when a harness violates an invariant.
 * Path 2 harness implementations may catch this to surface a typed error
 * to the daemon's task handler.
 */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

/**
 * Throws if the harness is in frozen mode. Use at write call sites in
 * Path 2 harness implementations to assert that a write to implStateDir
 * is only happening in train mode.
 *
 * @example
 *   requireTrain(ctx, 'update constitutional state');
 *   await fs.writeFile(constitutionPath, serialized);
 *
 * The daemon's hash-fence catches violations regardless of whether
 * `requireTrain` is used; this helper is purely for defensive ergonomics
 * at the harness implementation layer (fail fast at the call site rather
 * than after the Task completes).
 */
export function requireTrain(ctx: HarnessContext, action: string): void {
  if (ctx.mode === 'frozen') {
    throw new HarnessError(
      `Cannot ${action} in frozen mode. Gate this write on ctx.mode === 'train'.`,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sdk && yarn vitest run test/require-train.test.ts`

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/harness.ts packages/sdk/test/require-train.test.ts
git commit -m "feat(sdk): add requireTrain helper for Path 2 harness builders

Adds opt-in HarnessError + requireTrain(ctx, action) at write call
sites. Throws in frozen mode with a message naming the disallowed
action. The daemon hash-fence catches violations regardless; this is
defensive ergonomics for harness implementers.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.1"
```

---

## Task 3: `hashImplStateDir` — deterministic Merkle hash of a directory tree

**Files:**
- Create: `client/src/harnesses/freeze.ts`
- Create: `client/test/harnesses/freeze.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/harnesses/freeze.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';

describe('hashImplStateDir', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), 'freeze-test-a-'));
    dirB = await mkdtemp(join(tmpdir(), 'freeze-test-b-'));
  });

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('produces a sha256-shaped hex string', async () => {
    await writeFile(join(dirA, 'file.txt'), 'hello');
    const h = await hashImplStateDir(dirA);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for identical content (deterministic)', async () => {
    await writeFile(join(dirA, 'file.txt'), 'hello');
    await writeFile(join(dirB, 'file.txt'), 'hello');
    const hA = await hashImplStateDir(dirA);
    const hB = await hashImplStateDir(dirB);
    expect(hA).toBe(hB);
  });

  it('returns different hashes for different content', async () => {
    await writeFile(join(dirA, 'file.txt'), 'hello');
    await writeFile(join(dirB, 'file.txt'), 'world');
    const hA = await hashImplStateDir(dirA);
    const hB = await hashImplStateDir(dirB);
    expect(hA).not.toBe(hB);
  });

  it('order-independent over file system listing order', async () => {
    // Write files in different orders to dirA vs dirB; should still hash equal.
    await writeFile(join(dirA, 'a.txt'), 'A');
    await writeFile(join(dirA, 'b.txt'), 'B');
    await writeFile(join(dirA, 'c.txt'), 'C');

    await writeFile(join(dirB, 'c.txt'), 'C');
    await writeFile(join(dirB, 'a.txt'), 'A');
    await writeFile(join(dirB, 'b.txt'), 'B');

    expect(await hashImplStateDir(dirA)).toBe(await hashImplStateDir(dirB));
  });

  it('walks subdirectories recursively', async () => {
    await mkdir(join(dirA, 'sub'));
    await writeFile(join(dirA, 'sub', 'nested.txt'), 'nested-content');
    await mkdir(join(dirB, 'sub'));
    await writeFile(join(dirB, 'sub', 'nested.txt'), 'nested-content');
    expect(await hashImplStateDir(dirA)).toBe(await hashImplStateDir(dirB));
  });

  it('detects content changes in nested files', async () => {
    await mkdir(join(dirA, 'sub'));
    await writeFile(join(dirA, 'sub', 'nested.txt'), 'v1');
    const before = await hashImplStateDir(dirA);
    await writeFile(join(dirA, 'sub', 'nested.txt'), 'v2');
    const after = await hashImplStateDir(dirA);
    expect(before).not.toBe(after);
  });

  it('hashes empty directory to a stable canonical value', async () => {
    const h1 = await hashImplStateDir(dirA);
    const h2 = await hashImplStateDir(dirB);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test harnesses/freeze`

Expected: All fail (`hashImplStateDir` not found).

- [ ] **Step 3: Implement `hashImplStateDir`**

Create `client/src/harnesses/freeze.ts`:

```typescript
/**
 * Deterministic content hashing for implStateDir directories.
 *
 * Used by the daemon's freeze-fence (`client/src/daemon/freeze-fence.ts`)
 * to detect violations of the frozen-mode contract — a harness MUST NOT
 * mutate `implStateDir` when running with `ctx.mode === 'frozen'`. The
 * daemon hashes the directory before and after each Task and rejects the
 * envelope on mismatch.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Compute a deterministic SHA-256 hash of an `implStateDir`'s contents.
 *
 * Algorithm:
 *   1. Walk the directory tree recursively.
 *   2. For each file, hash its content with SHA-256.
 *   3. Sort entries by relative path (canonical ordering, OS-independent).
 *   4. Combine "<relpath>:<filehash>\n" lines and hash the whole thing.
 *
 * Properties:
 *   - Deterministic: same content → same hash.
 *   - Order-stable: filesystem listing order does not affect output.
 *   - Order-sensitive: file path differences DO affect output.
 *   - Recursive: walks subdirectories.
 *   - Metadata-independent: mtimes, permissions, file order do not affect output.
 *
 * Cost: O(total bytes) read + SHA-256. For typical claude-code-learner
 * implStateDir (~few MB) this is sub-second.
 *
 * Returns a 64-character lowercase hex string (no `sha256:` prefix; callers
 * that need that prefix add it themselves).
 */
export async function hashImplStateDir(dirPath: string): Promise<string> {
  const entries: Array<{ relPath: string; fileHash: string }> = [];

  async function walk(currentPath: string): Promise<void> {
    const items = (await readdir(currentPath)).sort();
    for (const item of items) {
      const full = join(currentPath, item);
      const s = await stat(full);
      if (s.isDirectory()) {
        await walk(full);
      } else if (s.isFile()) {
        const content = await readFile(full);
        const fileHash = createHash('sha256').update(content).digest('hex');
        entries.push({ relPath: relative(dirPath, full), fileHash });
      }
      // Symlinks and special files are skipped (not expected in implStateDir).
    }
  }

  await walk(dirPath);

  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const combined = entries.map((e) => `${e.relPath}:${e.fileHash}`).join('\n');
  return createHash('sha256').update(combined).digest('hex');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test harnesses/freeze`

Expected: 7 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/freeze.ts client/test/harnesses/freeze.test.ts
git commit -m "feat(harness): add deterministic implStateDir hash function

hashImplStateDir walks a directory tree, hashes each file with SHA-256,
sorts by relative path for canonical ordering, and combines the entries
into a single SHA-256. Used by the daemon's freeze-fence to detect
implStateDir mutations during frozen-mode Tasks.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3"
```

---

## Task 4: `runHarnessWithFreezeFence` — wraps `harness.run(ctx)` with snapshot + post-hash + rollback

**Files:**
- Create: `client/src/daemon/freeze-fence.ts`
- Create: `client/test/daemon/freeze-fence.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/daemon/freeze-fence.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessWithFreezeFence } from '../../src/daemon/freeze-fence.js';
import type { Harness, HarnessContext, Solution } from '../../src/harnesses/types.js';

function makeCtx(implStateDir: string, mode: 'train' | 'frozen'): HarnessContext {
  return {
    task: { id: 't1', solverType: 'prediction.v1' } as any,
    implStateDir,
    workingDir: implStateDir,  // any path; not used in these tests
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: { addSpan: () => {} } as any,
    mode,
  };
}

function noOpHarness(): Harness {
  return {
    name: 'noop',
    version: '0.1.0',
    supports: () => true,
    async run(): Promise<Solution> {
      return { artifact: {} as any, rationale: [] };
    },
  };
}

function writingHarness(filename: string, content: string): Harness {
  return {
    name: 'writer',
    version: '0.1.0',
    supports: () => true,
    async run(ctx): Promise<Solution> {
      await writeFile(join(ctx.implStateDir, filename), content);
      return { artifact: {} as any, rationale: [] };
    },
  };
}

function throwingHarness(): Harness {
  return {
    name: 'thrower',
    version: '0.1.0',
    supports: () => true,
    async run(ctx): Promise<Solution> {
      // Partial write before throwing
      await writeFile(join(ctx.implStateDir, 'partial.txt'), 'partial');
      throw new Error('harness exploded');
    },
  };
}

describe('runHarnessWithFreezeFence', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'fence-test-'));
    await writeFile(join(stateDir, 'baseline.txt'), 'baseline');
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('train mode passes through with no fence overhead', async () => {
    const result = await runHarnessWithFreezeFence(noOpHarness(), makeCtx(stateDir, 'train'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('train mode allows the harness to write to implStateDir', async () => {
    const result = await runHarnessWithFreezeFence(
      writingHarness('new.txt', 'wrote'),
      makeCtx(stateDir, 'train'),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(stateDir, 'new.txt'), 'utf8')).toBe('wrote');
  });

  it('frozen mode + non-writing harness succeeds with stable codeDigest', async () => {
    const r1 = await runHarnessWithFreezeFence(noOpHarness(), makeCtx(stateDir, 'frozen'));
    const r2 = await runHarnessWithFreezeFence(noOpHarness(), makeCtx(stateDir, 'frozen'));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.codeDigest).toBe(r2.codeDigest);  // stable across Tasks
    }
  });

  it('frozen mode + writing harness DETECTS violation and rolls back', async () => {
    const result = await runHarnessWithFreezeFence(
      writingHarness('forbidden.txt', 'should not persist'),
      makeCtx(stateDir, 'frozen'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation.taskId).toBe('t1');
      expect(result.violation.harnessName).toBe('writer');
      expect(result.violation.stateHashBefore).not.toBe(result.violation.stateHashAfter);
    }
    // Rollback succeeded — implStateDir is unchanged from before the run
    const filesAfter = await readdir(stateDir);
    expect(filesAfter).toEqual(['baseline.txt']);
  });

  it('frozen mode + harness throw rolls back partial writes', async () => {
    await expect(
      runHarnessWithFreezeFence(throwingHarness(), makeCtx(stateDir, 'frozen')),
    ).rejects.toThrow('harness exploded');
    // Despite the partial write inside the harness, rollback restored.
    const filesAfter = await readdir(stateDir);
    expect(filesAfter).toEqual(['baseline.txt']);
  });

  it('frozen mode allows ephemeral writes that net to zero', async () => {
    const ephemeralHarness: Harness = {
      name: 'ephemeral',
      version: '0.1.0',
      supports: () => true,
      async run(ctx): Promise<Solution> {
        const path = join(ctx.implStateDir, 'temp.txt');
        await writeFile(path, 'transient');
        await rm(path);
        return { artifact: {} as any, rationale: [] };
      },
    };
    const result = await runHarnessWithFreezeFence(ephemeralHarness, makeCtx(stateDir, 'frozen'));
    expect(result.ok).toBe(true);  // hashes match before vs after — no violation
  });
});

// helper imported from fs
import { readdir } from 'node:fs/promises';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test daemon/freeze-fence`

Expected: All fail (`runHarnessWithFreezeFence` not found).

- [ ] **Step 3: Implement `runHarnessWithFreezeFence`**

Create `client/src/daemon/freeze-fence.ts`:

```typescript
/**
 * Daemon-side freeze-fence for the Harness `mode: 'train' | 'frozen'`
 * contract. When `ctx.mode === 'frozen'`, the daemon snapshots
 * `implStateDir`, runs the harness, and verifies the post-run hash
 * matches the pre-run hash. Mismatch → envelope rejected, snapshot
 * restored.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 */

import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../harnesses/freeze.js';
import type { Harness, HarnessContext } from '../harnesses/types.js';
import type { Solution } from '../types/portfolio.js';

export interface FreezeViolation {
  taskId: string;
  harnessName: string;
  harnessVersion: string;
  stateHashBefore: string;
  stateHashAfter: string;
  detectedAt: number;
}

export type FenceResult =
  | { ok: true; output: Solution; codeDigest: string }
  | { ok: false; violation: FreezeViolation };

/**
 * Wraps `harness.run(ctx)` with the freeze-fence behaviour:
 *
 *   - `ctx.mode === 'train'`: no fence overhead. Run the harness and
 *     compute the post-run codeDigest from the (now-mutated) implStateDir.
 *
 *   - `ctx.mode === 'frozen'`: hash implStateDir before, snapshot to a
 *     temp dir, run the harness, hash again. Mismatch → roll back from
 *     snapshot, return `{ ok: false, violation: ... }` so the caller
 *     skips envelope submission. Match → succeed and return the
 *     pre-hash as the codeDigest (stable for the frozen window).
 *
 * If the harness throws inside frozen mode, the snapshot is restored
 * defensively (covers partial writes before the throw).
 */
export async function runHarnessWithFreezeFence(
  harness: Harness,
  ctx: HarnessContext,
): Promise<FenceResult> {
  if (ctx.mode === 'train') {
    const output = await harness.run(ctx);
    const codeDigest = await hashImplStateDir(ctx.implStateDir);
    return { ok: true, output, codeDigest };
  }

  // Frozen mode: snapshot, run, verify, rollback if needed.
  const stateHashBefore = await hashImplStateDir(ctx.implStateDir);
  const snapDir = await mkdtemp(join(tmpdir(), 'jinn-freeze-snap-'));
  await cp(ctx.implStateDir, snapDir, { recursive: true });

  try {
    const output = await harness.run(ctx);
    const stateHashAfter = await hashImplStateDir(ctx.implStateDir);

    if (stateHashAfter !== stateHashBefore) {
      // Violation: rollback and return error.
      await rm(ctx.implStateDir, { recursive: true, force: true });
      await cp(snapDir, ctx.implStateDir, { recursive: true });
      await rm(snapDir, { recursive: true, force: true });
      return {
        ok: false,
        violation: {
          taskId: ctx.task.id,
          harnessName: harness.name,
          harnessVersion: harness.version,
          stateHashBefore,
          stateHashAfter,
          detectedAt: Date.now(),
        },
      };
    }

    // Hashes match: contract honoured, codeDigest is the (stable) pre-hash.
    await rm(snapDir, { recursive: true, force: true });
    return { ok: true, output, codeDigest: stateHashBefore };
  } catch (err) {
    // Defensive rollback even on throw.
    await rm(ctx.implStateDir, { recursive: true, force: true }).catch(() => {});
    await cp(snapDir, ctx.implStateDir, { recursive: true });
    await rm(snapDir, { recursive: true, force: true });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test daemon/freeze-fence`

Expected: 6 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/freeze-fence.ts client/test/daemon/freeze-fence.test.ts
git commit -m "feat(daemon): add freeze-fence wrapper enforcing frozen-mode contract

runHarnessWithFreezeFence wraps harness.run(ctx) with pre/post hashing
of implStateDir when mode='frozen'. Mismatch triggers rollback from a
temp-dir snapshot and returns a FenceResult with violation metadata
so the caller skips envelope submission. Train mode passes through
with no overhead.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
DR: log/decisions/2026-05-06-trust-stack-composition.md (layer 1)"
```

---

## Task 5: Add `harness.mode` to operator config schema

**Files:**
- Modify: `client/src/config.ts`
- Modify: `client/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `client/test/config.test.ts`:

```typescript
describe('harness.mode config field', () => {
  it('defaults harness.mode to "train"', () => {
    const config = parseJinnConfig({});
    expect(config.harness?.mode).toBe('train');
  });

  it('accepts harness.mode = "frozen"', () => {
    const config = parseJinnConfig({ harness: { mode: 'frozen' } });
    expect(config.harness?.mode).toBe('frozen');
  });

  it('rejects invalid harness.mode values', () => {
    expect(() => parseJinnConfig({ harness: { mode: 'eval' } })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn test config -t "harness.mode"`

Expected: 3 failures.

- [ ] **Step 3: Add `harness` field to `JinnConfigSchema`**

Locate `JinnConfigSchema` in `client/src/config.ts`. Add the `harness` field (or extend if it already exists):

```typescript
export const JinnConfigSchema = z.object({
  // ... existing fields ...

  /**
   * Harness execution settings. The `mode` field controls whether the
   * harness runs with state-write phases enabled (`train`) or disabled
   * (`frozen`). Frozen mode produces stable codeDigest across Tasks for
   * benchmark-grade per-snapshot scoring; see
   * docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §5.
   */
  harness: z
    .object({
      mode: z.enum(['train', 'frozen']).default('train'),
    })
    .default({ mode: 'train' }),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn test config -t "harness.mode"`

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/config.ts client/test/config.test.ts
git commit -m "feat(config): add harness.mode field for operator-side mode toggle

Operators set harness.mode = 'train' | 'frozen' in ~/.jinn-client/config.json.
Default 'train' preserves existing behaviour. The daemon reads this field
on each Task dispatch and propagates to HarnessContext.mode.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6"
```

---

## Task 6: Wire freeze-fence into the harness engine

**Files:**
- Modify: `client/src/harnesses/engine/engine.ts`
- Create: `client/test/harnesses/engine/engine-mode.test.ts`

- [ ] **Step 1: Inspect the existing engine dispatch site**

Run: `grep -n "impl.run\|harness.run\|.run(ctx" client/src/harnesses/engine/engine.ts | head -10`

Note the exact line where the engine calls `await impl.run(ctx)` or equivalent. This is the call we wrap.

- [ ] **Step 2: Write the failing integration test**

Create `client/test/harnesses/engine/engine-mode.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessOnce } from '../../../src/harnesses/engine/engine.js';
import type { Harness } from '../../../src/harnesses/types.js';

describe('engine mode propagation', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'engine-mode-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('train mode produces an envelope with Executor.mode = "train"', async () => {
    const harness: Harness = {
      name: 'test', version: '0.1.0', supports: () => true,
      async run(ctx) {
        await writeFile(join(ctx.implStateDir, 'state.txt'), 'mutated');
        return { artifact: {} as any, rationale: [] };
      },
    };
    const result = await runHarnessOnce({ harness, implStateDir: stateDir, mode: 'train' });
    expect(result.envelope?.executor.mode).toBe('train');
  });

  it('frozen mode + non-writing harness produces envelope with Executor.mode = "frozen"', async () => {
    const harness: Harness = {
      name: 'test', version: '0.1.0', supports: () => true,
      async run() { return { artifact: {} as any, rationale: [] }; },
    };
    await writeFile(join(stateDir, 'baseline.txt'), 'a');
    const result = await runHarnessOnce({ harness, implStateDir: stateDir, mode: 'frozen' });
    expect(result.envelope?.executor.mode).toBe('frozen');
  });

  it('frozen mode + writing harness produces NO envelope (rejected)', async () => {
    const harness: Harness = {
      name: 'bad-actor', version: '0.1.0', supports: () => true,
      async run(ctx) {
        await writeFile(join(ctx.implStateDir, 'forbidden.txt'), 'wrote');
        return { artifact: {} as any, rationale: [] };
      },
    };
    await writeFile(join(stateDir, 'baseline.txt'), 'a');
    const result = await runHarnessOnce({ harness, implStateDir: stateDir, mode: 'frozen' });
    expect(result.envelope).toBeUndefined();
    expect(result.violation).toBeDefined();
    // Rollback restored:
    expect(await readdir(stateDir)).toEqual(['baseline.txt']);
  });
});
```

(Note: `runHarnessOnce` is the engine's dispatch entry; the exact signature may differ — adapt to whatever the engine exposes after Step 3 wiring.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd client && yarn test harnesses/engine/engine-mode`

Expected: Failures (mode not propagated; violation not handled).

- [ ] **Step 4: Wire `runHarnessWithFreezeFence` into the engine**

In `client/src/harnesses/engine/engine.ts`, replace the direct call:

```typescript
// before:
const output = await impl.run(ctx);
// build envelope from output ...

// after:
import { runHarnessWithFreezeFence } from '../../daemon/freeze-fence.js';

const fence = await runHarnessWithFreezeFence(impl, ctx);
if (!fence.ok) {
  // Violation: skip envelope assembly; emit a structured log + reputation event.
  ctx.log({
    level: 'error',
    msg: 'Harness violated frozen-mode contract — envelope rejected',
    data: fence.violation,
  });
  return { violation: fence.violation };
}
const output = fence.output;
const codeDigest = `sha256:${fence.codeDigest}`;
// build envelope from output, populating executor.codeDigest = codeDigest and
// executor.mode = ctx.mode
```

Adapt the surrounding return-type / Envelope assembly code to include `mode` and the new `violation` exit. The `runHarnessOnce` return type becomes `{ envelope?: Envelope; violation?: FreezeViolation }`.

- [ ] **Step 5: Update Envelope assembly to populate `Executor.mode`**

Find the envelope assembly site (likely `packaging.ts` or inline in engine). Set:

```typescript
executor: {
  // ... existing fields ...
  codeDigest,
  mode: ctx.mode,  // NEW
},
```

- [ ] **Step 6: Run integration tests to verify they pass**

Run: `cd client && yarn test harnesses/engine/engine-mode`

Expected: 3 passes.

- [ ] **Step 7: Run the full client test suite to confirm no regressions**

Run: `cd client && yarn test`

Expected: All pre-existing tests still pass; new tests pass.

- [ ] **Step 8: Commit**

```bash
git add client/src/harnesses/engine/engine.ts client/test/harnesses/engine/engine-mode.test.ts client/src/harnesses/engine/packaging.ts
git commit -m "feat(engine): wire freeze-fence into harness dispatch + envelope assembly

Engine wraps harness.run(ctx) with runHarnessWithFreezeFence and
populates Executor.mode on the produced envelope. Frozen-mode
violations short-circuit envelope assembly and surface a structured
log event.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3"
```

---

## Task 7: Propagate `mode` from operator config through the daemon to `HarnessContext`

**Files:**
- Modify: `client/src/daemon/daemon.ts` (or whichever loop constructs `HarnessContext`)
- Modify: `client/src/harnesses/engine/engine.ts` (read `mode` from upstream config or context)

- [ ] **Step 1: Identify the HarnessContext construction site**

Run: `grep -rn "HarnessContext\|mode:" client/src/daemon/ client/src/harnesses/engine/ | grep -v "test\|interface\|type" | head -20`

Note the file + line where `HarnessContext` is constructed before being passed to the engine / harness.

- [ ] **Step 2: Write the failing test for mode propagation through the daemon**

Add a test (or extend one in the engine test file) that asserts:
- When `config.harness.mode === 'frozen'`, the constructed HarnessContext has `mode: 'frozen'`.
- When `config.harness.mode === 'train'`, the constructed HarnessContext has `mode: 'train'`.

(Exact test fixture depends on the daemon entry; if it's hard to test in isolation, this propagation may be covered sufficiently by the e2e test in Task 11 — in that case mark this step "n/a, covered downstream" and just modify the construction.)

- [ ] **Step 3: Modify the construction site to read `config.harness.mode`**

```typescript
// in the relevant daemon loop / dispatcher
const ctx: HarnessContext = {
  // ... existing fields ...
  mode: config.harness?.mode ?? 'train',
};
```

- [ ] **Step 4: Run the test (or related engine tests) to verify**

Run: `cd client && yarn test`

Expected: All pass; mode propagates correctly.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/daemon.ts client/src/harnesses/engine/engine.ts
git commit -m "feat(daemon): propagate config.harness.mode to HarnessContext.mode

Daemon's task-dispatch loop reads operator config harness.mode and
sets HarnessContext.mode accordingly on every Task. Default 'train'.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6"
```

---

## Task 8: claude-code-learner — gate Improve and Memory phase invocations on `mode`

**Files:**
- Modify: `client/src/harnesses/impls/claude-code-learner/types.ts` (`TaskSessionInputs.mode`)
- Modify: `client/src/harnesses/impls/claude-code-learner/harness.ts` (forward `mode` to inputs)
- Modify: `client/src/harnesses/impls/claude-code-learner/adapter.ts` (pass `mode` to orchestrator prompt)
- Modify: `client/plugins/claude-code-learner/skills/learn/SKILL.md` (gate phases on mode)
- Create: `client/test/harnesses/impls/claude-code-learner/mode-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/harnesses/impls/claude-code-learner/mode-gate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ClaudeCodeLearnerImpl } from '../../../../src/harnesses/impls/claude-code-learner/harness.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../../../src/harnesses/impls/claude-code-learner/types.js';

class CapturingAdapter implements HarnessAdapter {
  public lastInputs?: TaskSessionInputs;
  async runTask(inputs: TaskSessionInputs): Promise<void> {
    this.lastInputs = inputs;
  }
}

describe('claude-code-learner mode gate', () => {
  it('forwards mode = "train" through TaskSessionInputs', async () => {
    const adapter = new CapturingAdapter();
    const harness = new ClaudeCodeLearnerImpl({ adapter, pluginRoot: '/tmp/x' });
    await harness.run({
      task: { id: 't1', solverType: 'prediction.v1', window: { startTs: 0, endTs: 0 } } as any,
      implStateDir: '/tmp/state',
      workingDir: '/tmp/work',
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 0,
      trajectory: { addSpan: () => {} } as any,
      mode: 'train',
    });
    expect(adapter.lastInputs?.mode).toBe('train');
  });

  it('forwards mode = "frozen" through TaskSessionInputs', async () => {
    const adapter = new CapturingAdapter();
    const harness = new ClaudeCodeLearnerImpl({ adapter, pluginRoot: '/tmp/x' });
    await harness.run({
      task: { id: 't1', solverType: 'prediction.v1', window: { startTs: 0, endTs: 0 } } as any,
      implStateDir: '/tmp/state',
      workingDir: '/tmp/work',
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 0,
      trajectory: { addSpan: () => {} } as any,
      mode: 'frozen',
    });
    expect(adapter.lastInputs?.mode).toBe('frozen');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn test claude-code-learner/mode-gate`

Expected: Type errors / `mode` field missing.

- [ ] **Step 3: Add `mode` to `TaskSessionInputs`**

In `client/src/harnesses/impls/claude-code-learner/types.ts`, locate the `TaskSessionInputs` interface and add:

```typescript
export interface TaskSessionInputs {
  // ... existing fields ...
  /**
   * Harness execution mode forwarded from HarnessContext. The orchestrator
   * skill gates Improve and Memory phase invocations on mode === 'train'.
   */
  mode: 'train' | 'frozen';
}
```

- [ ] **Step 4: Forward `mode` in `harness.ts`**

In `client/src/harnesses/impls/claude-code-learner/harness.ts`, locate the `inputs: TaskSessionInputs = { ... }` block. Add:

```typescript
const inputs: TaskSessionInputs = {
  taskId: ctx.task.id,
  // ... existing fields ...
  msUntilEndTs: ctx.msUntilEndTs(),
  abort: ctx.abort,
  mode: ctx.mode,  // NEW
};
```

- [ ] **Step 5: Forward `mode` in `adapter.ts` to the orchestrator prompt**

In `client/src/harnesses/impls/claude-code-learner/adapter.ts`, locate where the `claude-code-learner:learn` skill is invoked. Add the mode parameter to the invocation. Concrete shape depends on the adapter's prompt-construction code — typically:

```typescript
// existing prompt construction...
const prompt = renderLearnPrompt({
  // ... existing fields ...
  mode: inputs.mode,
});
```

- [ ] **Step 6: Update the orchestrator skill `SKILL.md` to gate phases on mode**

Modify `client/plugins/claude-code-learner/skills/learn/SKILL.md`. Add to the phase-dispatch section:

```markdown
## Phase dispatch

Phases run in order: Orient → Strategize → Plan → Execute → Debrief.

Then **conditionally on mode**:

- If `mode === 'train'`: also run Improve and Memory phases (these write to implStateDir).
- If `mode === 'frozen'`: skip Improve and Memory phases. The harness does NOT mutate
  implStateDir. This is the protocol-level frozen contract; violation is detected by
  the daemon hash-fence and rejects the envelope.

Mode is provided as input parameter `{{mode}}` (one of `'train'` | `'frozen'`).
Default if absent: `'train'`.
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd client && yarn test claude-code-learner/mode-gate`

Expected: 2 passes.

- [ ] **Step 8: Run claude-code-learner's existing e2e to confirm no regression**

Run: `cd client && yarn e2e:full-cycle` (per PR #94's test plan)

Expected: passes — both train-mode cycles complete; implStateDir HEAD advances cycle1→cycle2.

- [ ] **Step 9: Commit**

```bash
git add client/src/harnesses/impls/claude-code-learner/types.ts client/src/harnesses/impls/claude-code-learner/harness.ts client/src/harnesses/impls/claude-code-learner/adapter.ts client/plugins/claude-code-learner/skills/learn/SKILL.md client/test/harnesses/impls/claude-code-learner/mode-gate.test.ts
git commit -m "feat(claude-code-learner): gate Improve + Memory phases on mode

claude-code-learner now reads HarnessContext.mode and forwards through
TaskSessionInputs to the orchestrator skill. The skill's phase dispatch
runs all 7 phases when mode='train' and skips Improve + Memory when
mode='frozen' — preserving implStateDir for benchmark-grade per-snapshot
scoring.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
PR-aligned: #94 (orchestrator skill structure)"
```

---

## Task 9: CLI — `jinn harness mode <train|frozen>` + extended `jinn harness status`

**Files:**
- Modify: `client/src/cli/commands/harnesses.ts`
- Create: `client/test/cli/harness-mode.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/cli/harness-mode.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessModeCommand, harnessStatusCommand } from '../../src/cli/commands/harnesses.js';

describe('jinn harness mode', () => {
  let configPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-mode-'));
    configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ network: 'testnet' }));
  });

  afterEach(async () => {
    await rm(configPath, { force: true });
  });

  it('writes mode = "frozen" to config', async () => {
    await harnessModeCommand({ mode: 'frozen', configPath });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.harness?.mode).toBe('frozen');
  });

  it('writes mode = "train" to config', async () => {
    await harnessModeCommand({ mode: 'train', configPath });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.harness?.mode).toBe('train');
  });

  it('rejects invalid mode arguments', async () => {
    await expect(harnessModeCommand({ mode: 'eval' as any, configPath })).rejects.toThrow();
  });
});

describe('jinn harness status', () => {
  it('prints current mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-status-'));
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ harness: { mode: 'frozen' } }));

    let captured = '';
    const log = (s: string) => { captured += s + '\n'; };
    await harnessStatusCommand({ configPath, log });
    expect(captured).toContain('mode: frozen');

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn test cli/harness-mode`

Expected: Failures (`harnessModeCommand`, `harnessStatusCommand` not found).

- [ ] **Step 3: Implement the commands in `client/src/cli/commands/harnesses.ts`**

Append to `client/src/cli/commands/harnesses.ts`:

```typescript
import { readFile, writeFile } from 'node:fs/promises';

/**
 * `jinn harness mode <train|frozen>` — toggle the operator's harness mode.
 *
 * Writes `harness.mode` to ~/.jinn-client/config.json (or the supplied path).
 * Operators in frozen mode produce envelopes with stable codeDigest across
 * Tasks for benchmark-grade scoring; train mode is the default and allows
 * Improve / Memory phase writes to implStateDir.
 */
export async function harnessModeCommand(opts: {
  mode: 'train' | 'frozen';
  configPath: string;
}): Promise<void> {
  if (opts.mode !== 'train' && opts.mode !== 'frozen') {
    throw new Error(`Invalid mode "${opts.mode}". Expected 'train' or 'frozen'.`);
  }
  const raw = await readFile(opts.configPath, 'utf8').catch(() => '{}');
  const config = JSON.parse(raw);
  config.harness = { ...(config.harness ?? {}), mode: opts.mode };
  await writeFile(opts.configPath, JSON.stringify(config, null, 2));
}

/**
 * `jinn harness status` — print current harness configuration.
 */
export async function harnessStatusCommand(opts: {
  configPath: string;
  log?: (s: string) => void;
}): Promise<void> {
  const log = opts.log ?? console.log;
  const raw = await readFile(opts.configPath, 'utf8').catch(() => '{}');
  const config = JSON.parse(raw);
  const mode = config.harness?.mode ?? 'train';
  log(`harness:`);
  log(`  mode: ${mode}`);
  // codeDigest reporting is implemented in the surface plan; not in this scope.
}
```

- [ ] **Step 4: Wire the commands into the CLI argv parser**

Locate the existing `jinn harness` command registration in `client/src/cli/...`. Add subcommands:

```typescript
program
  .command('harness')
  .command('mode <mode>')
  .description("set harness mode ('train' or 'frozen')")
  .action(async (mode: string) => {
    await harnessModeCommand({ mode: mode as 'train' | 'frozen', configPath: defaultConfigPath() });
  });

program
  .command('harness')
  .command('status')
  .description('print harness configuration')
  .action(async () => {
    await harnessStatusCommand({ configPath: defaultConfigPath() });
  });
```

(Adapt to the project's actual argv parser — Commander.js, yargs, custom — by inspecting existing `jinn harness` registration in the CLI file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && yarn test cli/harness-mode`

Expected: 4 passes.

- [ ] **Step 6: Smoke-test the CLI manually**

Run:
```bash
cd client && yarn build
node dist/bin/jinn.js harness status
node dist/bin/jinn.js harness mode frozen
node dist/bin/jinn.js harness status   # should print "mode: frozen"
node dist/bin/jinn.js harness mode train
node dist/bin/jinn.js harness status   # should print "mode: train"
```

- [ ] **Step 7: Commit**

```bash
git add client/src/cli/commands/harnesses.ts client/test/cli/harness-mode.test.ts
git commit -m "feat(cli): add 'jinn harness mode' toggle and 'status' fields

Operators can flip between train and frozen mode via:
  jinn harness mode train|frozen
The status command surfaces current mode (codeDigest reporting lands in
the surface plan).

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6"
```

---

## Task 10: End-to-end test on Anvil — full freeze-mode lifecycle

**Files:**
- Create: `client/test/e2e/freeze-mode.test.ts`

- [ ] **Step 1: Inspect existing e2e test scaffolding**

Run: `ls client/test/e2e/ && grep -l "anvil\|forkUrl" client/test/e2e/ 2>&1 | head -3`

Note the pattern: how Anvil is spawned, how the daemon is configured, how the engine is invoked. Use the same scaffolding for the freeze-mode test.

- [ ] **Step 2: Write the e2e test**

Create `client/test/e2e/freeze-mode.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAnvilFork, runDaemonOnce } from './_support/anvil-helpers.js';  // existing helper module
import type { Harness } from '../../src/harnesses/types.js';

describe('freeze-mode e2e on Anvil', () => {
  let anvil: { stop: () => Promise<void>; rpcUrl: string };
  let stateDir: string;

  beforeAll(async () => {
    anvil = await spawnAnvilFork();
    stateDir = await mkdtemp(join(tmpdir(), 'freeze-e2e-'));
  });

  afterAll(async () => {
    await anvil.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('train mode: codeDigest mutates between Tasks', async () => {
    // Harness writes a unique tag to implStateDir on each run
    let counter = 0;
    const harness: Harness = {
      name: 'mutating', version: '0.1.0', supports: () => true,
      async run(ctx) {
        counter += 1;
        await writeFile(join(ctx.implStateDir, 'counter.txt'), String(counter));
        return { artifact: {} as any, rationale: [] };
      },
    };
    const env1 = await runDaemonOnce({ rpcUrl: anvil.rpcUrl, harness, mode: 'train', stateDir });
    const env2 = await runDaemonOnce({ rpcUrl: anvil.rpcUrl, harness, mode: 'train', stateDir });

    expect(env1.executor.mode).toBe('train');
    expect(env2.executor.mode).toBe('train');
    expect(env1.executor.codeDigest).not.toBe(env2.executor.codeDigest);  // mutated
  });

  it('frozen mode: codeDigest stable across Tasks', async () => {
    await writeFile(join(stateDir, 'baseline.txt'), 'fixed');
    const harness: Harness = {
      name: 'reading-only', version: '0.1.0', supports: () => true,
      async run(ctx) {
        // Reads but does not write
        await readFile(join(ctx.implStateDir, 'baseline.txt'), 'utf8').catch(() => null);
        return { artifact: {} as any, rationale: [] };
      },
    };
    const env1 = await runDaemonOnce({ rpcUrl: anvil.rpcUrl, harness, mode: 'frozen', stateDir });
    const env2 = await runDaemonOnce({ rpcUrl: anvil.rpcUrl, harness, mode: 'frozen', stateDir });

    expect(env1.executor.mode).toBe('frozen');
    expect(env2.executor.mode).toBe('frozen');
    expect(env1.executor.codeDigest).toBe(env2.executor.codeDigest);  // stable
  });

  it('frozen mode: deliberate-violation harness is detected and envelope rejected', async () => {
    await writeFile(join(stateDir, 'baseline.txt'), 'fixed');
    const filesBefore = await readdir(stateDir);

    const badHarness: Harness = {
      name: 'bad-actor', version: '0.1.0', supports: () => true,
      async run(ctx) {
        await writeFile(join(ctx.implStateDir, 'forbidden.txt'), 'wrote');
        return { artifact: {} as any, rationale: [] };
      },
    };
    const result = await runDaemonOnce({
      rpcUrl: anvil.rpcUrl, harness: badHarness, mode: 'frozen', stateDir,
    });

    expect(result.envelope).toBeUndefined();
    expect(result.violation).toBeDefined();
    expect(result.violation?.harnessName).toBe('bad-actor');

    // Rollback restored the original implStateDir
    expect(await readdir(stateDir)).toEqual(filesBefore);
  });
});
```

(`spawnAnvilFork` and `runDaemonOnce` are existing test helpers; if they don't yet expose a `mode` parameter, extend them in this task.)

- [ ] **Step 3: Run the e2e test**

Run: `cd client && yarn e2e -t "freeze-mode"` (or whatever the project's e2e entry is — see `client/scripts/e2e-validate.ts`).

Expected: 3 passes.

- [ ] **Step 4: Commit**

```bash
git add client/test/e2e/freeze-mode.test.ts client/test/e2e/_support/anvil-helpers.ts
git commit -m "test(e2e): freeze-mode lifecycle on Anvil fork

Three e2e cases:
  1. Train mode produces envelopes with mutating codeDigest.
  2. Frozen mode produces envelopes with stable codeDigest.
  3. Deliberate-violation harness is caught; envelope rejected; rollback
     restores implStateDir.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6"
```

---

## Task 11: Documentation — SDK JSDoc + README pointer

**Files:**
- Modify: `packages/sdk/README.md`
- Create: `client/src/harnesses/freeze.md` (or extend an existing harness README)

- [ ] **Step 1: Add a "Frozen mode" section to `packages/sdk/README.md`**

Append a new section after the existing Harness API documentation:

```markdown
## Frozen mode (the freeze contract)

Every Harness implementation must respect `HarnessContext.mode`:

- `'train'` (default): writes to `ctx.implStateDir` are allowed. Improve /
  Memory / equivalent learning phases run.
- `'frozen'`: writes to `ctx.implStateDir` are forbidden. The daemon
  hashes the directory before and after each Task; mismatch rejects the
  envelope and rolls back.

Use `requireTrain(ctx, action)` at write call sites to fail fast in
frozen mode rather than after the Task completes:

```typescript
import { requireTrain } from '@jinn-network/sdk/harness';

async function updateConstitutionalState(ctx: HarnessContext, delta: StateDelta) {
  requireTrain(ctx, 'update constitutional state');
  await fs.writeFile(constitutionPath, serialize(delta));
}
```

Frozen mode is the discipline that crystallises the flowing substrate
into externally-comparable artifacts; see
`docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §5–6
for the full design (trust stack, daemon enforcement, verified vs
unverified frozen credibility tier).
```

- [ ] **Step 2: Cross-link from `client/src/harnesses/README.md`**

If a Harness README exists, add a paragraph:

```markdown
## Mode (train / frozen)

Harnesses must respect `HarnessContext.mode`. See
`packages/sdk/README.md#frozen-mode-the-freeze-contract` for the contract
and `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §6
for the full design.
```

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/README.md client/src/harnesses/README.md
git commit -m "docs: document the frozen-mode contract for harness builders

Adds a Frozen mode section to packages/sdk/README.md explaining the
contract Path 2 builders must satisfy, the requireTrain helper, and a
link to the full design spec.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6"
```

---

## Self-review checklist (run before handing off)

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §6.1 Interface contract | 1, 2 |
| §6.3 Daemon hash-fence | 3, 4, 6 |
| §5 Train and frozen modes (claude-code-learner gate) | 8 |
| §6 mode propagation through config | 5, 7 |
| §6 CLI surface (mode toggle, partial status) | 9 |
| §6 e2e validation | 10 |
| §6 SDK documentation | 11 |

Surface that lives in **other plans** (not this one):
- `Executor.mode`-aware subgraph indexing → surface plan
- Two-leaderboard dashboard view → surface plan
- `jinn checkpoint publish/install` CLI verbs → surface plan
- ReputationRegistry slashing hook for freeze violations → surface plan
- `swe-rebench-v2` SolverNet contract / evaluator / generator → SolverNet plan

**Placeholder scan:** none expected; all task steps have actual code or commands.

**Type consistency:**
- `mode: 'train' | 'frozen'` used uniformly across SDK + client + envelope + config + CLI.
- `requireTrain` (not `requireLearning`) — matches DR-2026-05-06-g.
- Function names: `hashImplStateDir`, `runHarnessWithFreezeFence`, `harnessModeCommand`, `harnessStatusCommand` — used consistently.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-freeze-mode-protocol-mechanism.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
