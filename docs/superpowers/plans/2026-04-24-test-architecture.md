# Test Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land shared test infrastructure (`test/_support/`), move e2e scripts under `test/e2e/`, migrate three exemplar tests to prove the pattern, and ship a written SOP — without regressing the 1085-test vitest suite.

**Architecture:** Four‑tier pyramid (unit / integration / e2e / manual). Helpers live in `client/test/_support/` and are imported by both vitest and e2e scripts. Mock policy: `vi.mock` only at architectural boundaries, with a mandatory `// MOCK_JUSTIFICATION:` comment. Existing tests keep mirroring `src/`; no mass relocation.

**Tech Stack:** TypeScript, vitest 3.x, better-sqlite3, viem, Anvil (Foundry), Node 22.

**Reference:** `docs/superpowers/specs/2026-04-24-test-architecture-design.md`

**Worktree:** All work happens in `/Users/adrianobradley/harbor/jinn-mono/cargo-refactor-tests` on branch `refactor/tests-architecture`. All paths below are **relative to the repo root** inside that worktree.

---

## Preflight

- Working directory: `cargo-refactor-tests/` (the worktree).
- Branch: `refactor/tests-architecture` (created from `main @ a93f77d3`).
- Already committed: `docs/superpowers/specs/2026-04-24-test-architecture-design.md` (the spec this plan implements).

Every task ends with a commit. Conventional-commit prefixes follow the repo pattern (`feat`, `refactor`, `test`, `docs`, `chore`).

---

### Task 1: Baseline verification and install

**Files:** none modified.

- [ ] **Step 1: Install deps and rebuild native modules**

Run:
```bash
cd client
yarn install --immutable
npm rebuild better-sqlite3
```
Expected: no errors; `rebuilt dependencies successfully`.

- [ ] **Step 2: Establish baseline test count**

Run: `yarn test 2>&1 | tail -5`
Expected: `Test Files 140 passed | 2 skipped (142)` and `Tests 1085 passed | 2 skipped (1087)`.

Record the exact numbers — every later task re-runs this and must match ±2.

- [ ] **Step 3: Establish baseline typecheck**

Run: `yarn typecheck`
Expected: zero errors, exit code 0.

No commit for this task.

---

### Task 2: Vitest path aliases

**Files:**
- Modify: `client/vitest.config.ts`
- Modify: `client/tsconfig.json`

- [ ] **Step 1: Read current vitest config**

Run: `cat client/vitest.config.ts`
Expected output:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Add aliases to vitest.config.ts**

Replace the entire file with:
```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    alias: {
      '@test/': fileURLToPath(new URL('./test/_support/', import.meta.url)),
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: Add matching paths to tsconfig.json**

Find the `"compilerOptions"` block in `client/tsconfig.json` and add or merge:
```json
"paths": {
  "@test/*": ["test/_support/*"],
  "@/*": ["src/*"]
},
"baseUrl": "."
```
If `baseUrl` already exists, leave it; otherwise add it. If `paths` already exists, merge these two entries in.

- [ ] **Step 4: Verify typecheck still passes**

Run: `yarn typecheck`
Expected: zero errors.

- [ ] **Step 5: Verify tests still pass**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1085 passed | 2 skipped (1087)`.

- [ ] **Step 6: Commit**

```bash
git add client/vitest.config.ts client/tsconfig.json
git commit -m "chore(client): add @/ and @test/ path aliases for vitest + tsc"
```

---

### Task 3: `test/_support/time.ts` — `FakeClock`

**Files:**
- Create: `client/test/_support/time.ts`
- Create: `client/test/_support/time.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/time.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { FakeClock } from '@test/time.js';

describe('FakeClock', () => {
  it('returns the initial time', () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it('advances by the given number of ms', () => {
    const clock = new FakeClock(0);
    clock.advance(500);
    expect(clock.now()).toBe(500);
    clock.advance(250);
    expect(clock.now()).toBe(750);
  });

  it('defaults to Date.now() when no initial time is given', () => {
    const before = Date.now();
    const clock = new FakeClock();
    const after = Date.now();
    expect(clock.now()).toBeGreaterThanOrEqual(before);
    expect(clock.now()).toBeLessThanOrEqual(after);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/time.test.ts 2>&1 | tail -10`
Expected: FAIL with `Cannot find module '@test/time.js'` or similar.

- [ ] **Step 3: Implement `FakeClock`**

Create `client/test/_support/time.ts`:
```ts
/**
 * Deterministic clock for tests that touch time.
 * Production code that needs "now" should accept a `() => number` so tests can inject `clock.now`.
 */
export class FakeClock {
  private ms: number;

  constructor(initialMs: number = Date.now()) {
    this.ms = initialMs;
  }

  now(): number {
    return this.ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/time.test.ts 2>&1 | tail -5`
Expected: `Tests 3 passed (3)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1088 passed | 2 skipped (1090)` (1085 + 3 new).

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/time.ts client/test/_support/time.test.ts
git commit -m "test(support): add FakeClock for deterministic time in tests"
```

---

### Task 4: `test/_support/store.ts` — `withTempStore`

**Files:**
- Create: `client/test/_support/store.ts`
- Create: `client/test/_support/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/store.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { withTempStore } from '@test/store.js';

describe('withTempStore', () => {
  it('provides a working :memory: Store and closes it on exit', async () => {
    let stored: unknown;
    await withTempStore(async (store) => {
      store.recordOwnActivity('req-1', 'created');
      stored = store.isOwnActivity('req-1');
    });
    expect(stored).toBe(true);
  });

  it('closes the store even when the callback throws', async () => {
    await expect(withTempStore(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // No way to assert the store is closed from the outside; the test exists to
    // prove the wrapper doesn't swallow errors and doesn't leak an open handle.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/store.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/store.js'`).

- [ ] **Step 3: Implement `withTempStore`**

Create `client/test/_support/store.ts`:
```ts
import { Store } from '@/store/store.js';

/**
 * Creates a `:memory:` Store, invokes the callback with it, and guarantees the
 * store is closed on both success and failure. Replaces the per-file
 * beforeEach/afterEach dance that exists in ~10 test files today.
 */
export async function withTempStore<T>(
  fn: (store: Store) => T | Promise<T>,
): Promise<T> {
  const store = new Store(':memory:');
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/store.test.ts 2>&1 | tail -5`
Expected: `Tests 2 passed (2)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1090 passed | 2 skipped (1092)`.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/store.ts client/test/_support/store.test.ts
git commit -m "test(support): add withTempStore helper for :memory: SQLite"
```

---

### Task 5: `test/_support/cli.ts` — `makeCommandCtx`, `collectWrites`, `runCommand`

**Files:**
- Create: `client/test/_support/cli.ts`
- Create: `client/test/_support/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeCommandCtx, runCommand } from '@test/cli.js';
import type { CommandModule } from '@/cli/command.js';

describe('makeCommandCtx', () => {
  it('defaults to empty argv, empty env, tty=false', () => {
    const { ctx } = makeCommandCtx();
    expect(ctx.argv).toEqual([]);
    expect(ctx.env).toEqual({});
    expect(ctx.stdoutIsTty).toBe(false);
  });

  it('captures writes and exits', () => {
    const { ctx, writes, exits } = makeCommandCtx();
    ctx.writer.write('hello\n');
    ctx.writer.write('world\n');
    ctx.exit(7);
    expect(writes).toEqual(['hello\n', 'world\n']);
    expect(exits).toEqual([7]);
  });

  it('applies overrides', () => {
    const { ctx } = makeCommandCtx({
      argv: ['--json'],
      env: { JINN_PASSWORD: 'secret' },
      tty: true,
    });
    expect(ctx.argv).toEqual(['--json']);
    expect(ctx.env).toEqual({ JINN_PASSWORD: 'secret' });
    expect(ctx.stdoutIsTty).toBe(true);
  });
});

describe('runCommand', () => {
  it('returns JSON envelopes parsed from writes', async () => {
    const fakeCommand: CommandModule = {
      name: 'fake',
      summary: 'fake',
      helpText: 'fake',
      async run(ctx) {
        ctx.writer.write(JSON.stringify({ schemaVersion: 1, kind: 'ok' }) + '\n');
      },
    };
    const { envelopes, exits } = await runCommand(fakeCommand);
    expect(envelopes).toEqual([{ schemaVersion: 1, kind: 'ok' }]);
    expect(exits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/cli.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/cli.js'`).

- [ ] **Step 3: Implement the helper**

Create `client/test/_support/cli.ts`:
```ts
import type { CommandContext, CommandModule } from '@/cli/command.js';

export interface MakeCommandCtxOpts {
  argv?: string[];
  env?: Record<string, string>;
  tty?: boolean;
}

export interface MadeCtx {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
}

/**
 * Canonical replacement for the ~15 ad-hoc `makeCtx` helpers across test/cli/.
 * Produces a CommandContext with captured writer+exit, plus the write/exit buffers.
 */
export function makeCommandCtx(opts: MakeCommandCtxOpts = {}): MadeCtx {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: opts.argv ?? [],
    stdoutIsTty: opts.tty ?? false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: opts.env ?? {},
  };
  return { ctx, writes, exits };
}

export interface RanCommand {
  envelopes: unknown[];
  exits: number[];
  raw: string[];
}

/**
 * Runs a command module and returns captured stdout parsed as one JSON envelope
 * per non-empty write. Non-JSON writes are tolerated (they appear in `raw` but not
 * in `envelopes`). Commands that write partial lines across multiple calls are
 * joined before splitting on newlines.
 */
export async function runCommand(
  cmd: CommandModule,
  opts: MakeCommandCtxOpts = {},
): Promise<RanCommand> {
  const made = makeCommandCtx(opts);
  await cmd.run(made.ctx);
  const joined = made.writes.join('');
  const lines = joined.split('\n').map(l => l.trim()).filter(Boolean);
  const envelopes: unknown[] = [];
  for (const line of lines) {
    if (line.startsWith('{') || line.startsWith('[')) {
      try { envelopes.push(JSON.parse(line)); } catch { /* not JSON; skip */ }
    }
  }
  return { envelopes, exits: made.exits, raw: made.writes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/cli.test.ts 2>&1 | tail -5`
Expected: `Tests 4 passed (4)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1094 passed | 2 skipped (1096)`.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/cli.ts client/test/_support/cli.test.ts
git commit -m "test(support): add makeCommandCtx + runCommand helpers"
```

---

### Task 6: `test/_support/engine.ts` — `makeIntentInput` + `createStateMachineSpy`

**Files:**
- Create: `client/test/_support/engine.ts`
- Create: `client/test/_support/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/engine.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeIntentInput, createStateMachineSpy } from '@test/engine.js';
import { withTempStore } from '@test/store.js';
import { IntentState } from '@/restorer/engine/state.js';

describe('makeIntentInput', () => {
  it('returns a valid PersistedIntentInput with sensible defaults', () => {
    const input = makeIntentInput();
    expect(input.requestId).toMatch(/^req-/);
    expect(input.intentCid).toMatch(/^bafy/);
    expect(input.specKind).toBe('portfolio.v0');
    expect(input.windowStartTs).toBeGreaterThan(0);
    expect(input.windowEndTs).toBeGreaterThan(input.windowStartTs);
  });

  it('applies overrides', () => {
    const input = makeIntentInput({ requestId: 'req-custom', specKind: 'prediction.v0' });
    expect(input.requestId).toBe('req-custom');
    expect(input.specKind).toBe('prediction.v0');
  });
});

describe('createStateMachineSpy', () => {
  it('records which lifecycle methods were called', async () => {
    await withTempStore(async (store) => {
      const { engine, calls } = createStateMachineSpy({ store });
      const persisted = engine.testPersistence.insertDiscovered(makeIntentInput({ requestId: 'r1' }));
      expect(persisted.state).toBe(IntentState.DISCOVERED);
      // Invoke one lifecycle method directly — it should be recorded and throw NotImplementedError.
      await expect(engine.claim(persisted)).rejects.toThrow();
      expect(calls).toContain('claim');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/engine.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/engine.js'`).

- [ ] **Step 3: Implement the helper**

Create `client/test/_support/engine.ts`:
```ts
import {
  RestorationEngine,
  NotImplementedError,
  type RestorationEngineOptions,
  type RestorerImplRegistry,
} from '@/restorer/engine/engine.js';
import type {
  PersistedIntent,
  PersistedIntentInput,
  IntentPersistence,
} from '@/restorer/engine/persistence.js';
import type { Store } from '@/store/store.js';

const NOOP_REGISTRY: RestorerImplRegistry = { resolveImplName: () => null };

let counter = 0;
function nextId(): string { return `req-${++counter}`; }

/**
 * Canonical fixture replacing the ~5 ad-hoc `makeInput` helpers across engine tests.
 * Signature drift (`makeInput(overrides)` vs `makeInput(id, overrides)` vs
 * `makeInput(id='req-gate')`) is collapsed into one shape.
 */
export function makeIntentInput(
  overrides: Partial<PersistedIntentInput> = {},
): PersistedIntentInput {
  const id = overrides.requestId ?? nextId();
  const now = Date.now();
  return {
    requestId: id,
    intentCid: `bafycid-${id}`,
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 1000,
    specKind: 'portfolio.v0',
    windowStartTs: now + 60_000,
    windowEndTs: now + 60_000 + 86_400_000,
    desiredState: { id, description: 'test' },
    ...overrides,
  };
}

export interface StateMachineSpyOpts {
  store: Store;
  paths?: { workingDirRoot: string; implStateDirRoot: string };
  onClaim?(intent: PersistedIntent): Promise<void>;
  onPreSnapshot?(intent: PersistedIntent): Promise<void>;
  onRunImpl?(intent: PersistedIntent): Promise<void>;
  onPostSnapshot?(intent: PersistedIntent): Promise<void>;
  onPack?(intent: PersistedIntent): Promise<void>;
  onDeliver?(intent: PersistedIntent): Promise<void>;
}

export interface StateMachineSpy {
  engine: SpyEngine;
  calls: string[];
  callsByIntent: Map<string, string[]>;
}

class SpyEngine extends RestorationEngine {
  readonly calls: string[] = [];
  readonly callsByIntent: Map<string, string[]> = new Map();
  private readonly opts: StateMachineSpyOpts;

  constructor(opts: StateMachineSpyOpts) {
    super({
      store: opts.store,
      registry: NOOP_REGISTRY,
      paths: opts.paths ?? { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
    });
    this.opts = opts;
  }

  get testPersistence(): IntentPersistence { return this.persistence; }

  private record(intent: PersistedIntent, name: string): void {
    this.calls.push(name);
    const list = this.callsByIntent.get(intent.requestId) ?? [];
    list.push(name);
    this.callsByIntent.set(intent.requestId, list);
  }

  override async claim(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'claim');
    if (this.opts.onClaim) return this.opts.onClaim(intent);
    throw new NotImplementedError('claim');
  }
  override async takePreSnapshot(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'takePreSnapshot');
    if (this.opts.onPreSnapshot) return this.opts.onPreSnapshot(intent);
    throw new NotImplementedError('takePreSnapshot');
  }
  override async runImpl(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'runImpl');
    if (this.opts.onRunImpl) return this.opts.onRunImpl(intent);
    throw new NotImplementedError('runImpl');
  }
  override async takePostSnapshot(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'takePostSnapshot');
    if (this.opts.onPostSnapshot) return this.opts.onPostSnapshot(intent);
    throw new NotImplementedError('takePostSnapshot');
  }
  override async pack(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'pack');
    if (this.opts.onPack) return this.opts.onPack(intent);
    throw new NotImplementedError('pack');
  }
  override async deliver(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'deliver');
    if (this.opts.onDeliver) return this.opts.onDeliver(intent);
    throw new NotImplementedError('deliver');
  }
}

/** Canonical spy engine replacing the ad-hoc TestEngine/SpyEngine subclasses in 5 test files. */
export function createStateMachineSpy(opts: StateMachineSpyOpts): StateMachineSpy {
  const engine = new SpyEngine(opts);
  return { engine, calls: engine.calls, callsByIntent: engine.callsByIntent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/engine.test.ts 2>&1 | tail -5`
Expected: `Tests 3 passed (3)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1097 passed | 2 skipped (1099)`.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/engine.ts client/test/_support/engine.test.ts
git commit -m "test(support): add makeIntentInput + createStateMachineSpy"
```

---

### Task 7: `test/_support/ipfs.ts` — `FakeIPFS`

**Files:**
- Create: `client/test/_support/ipfs.ts`
- Create: `client/test/_support/ipfs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/ipfs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createFakeIPFS } from '@test/ipfs.js';

describe('FakeIPFS', () => {
  it('round-trips content via put/get', async () => {
    const ipfs = createFakeIPFS();
    const payload = new TextEncoder().encode('hello');
    const { cid } = await ipfs.put(payload);
    expect(cid).toMatch(/^bafy/);
    const got = ipfs.get(cid);
    expect(got && new TextDecoder().decode(got)).toBe('hello');
  });

  it('returns undefined for unknown CIDs', () => {
    const ipfs = createFakeIPFS();
    expect(ipfs.get('bafy-nope')).toBeUndefined();
  });

  it('is deterministic: same payload → same CID', async () => {
    const ipfs = createFakeIPFS();
    const a = await ipfs.put(new TextEncoder().encode('x'));
    const b = await ipfs.put(new TextEncoder().encode('x'));
    expect(a.cid).toBe(b.cid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/ipfs.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/ipfs.js'`).

- [ ] **Step 3: Implement the helper**

Create `client/test/_support/ipfs.ts`:
```ts
import { createHash } from 'node:crypto';

export interface FakeIPFS {
  gatewayUrl: string;
  put(payload: Uint8Array): Promise<{ cid: string }>;
  get(cid: string): Uint8Array | undefined;
}

/**
 * In-memory IPFS substitute for integration tests. CIDs are deterministic
 * (SHA-256 of payload, base32-ish prefixed with `bafy`) so tests that re-put
 * the same bytes get the same CID. `gatewayUrl` is a marker string, not a real
 * URL — tests that need HTTP gateway resolution should wire an HTTP handler
 * separately.
 */
export function createFakeIPFS(): FakeIPFS {
  const store = new Map<string, Uint8Array>();
  return {
    gatewayUrl: 'fake-ipfs://',
    async put(payload) {
      const hex = createHash('sha256').update(payload).digest('hex');
      const cid = `bafy${hex.slice(0, 52)}`;
      store.set(cid, payload);
      return { cid };
    },
    get(cid) {
      return store.get(cid);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/ipfs.test.ts 2>&1 | tail -5`
Expected: `Tests 3 passed (3)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1100 passed | 2 skipped (1102)`.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/ipfs.ts client/test/_support/ipfs.test.ts
git commit -m "test(support): add FakeIPFS in-memory substitute"
```

---

### Task 8: `test/_support/claude.ts` — `FakeClaudeRunner`

**Files:**
- Create: `client/test/_support/claude.ts`
- Create: `client/test/_support/claude.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/claude.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createFakeClaudeRunner } from '@test/claude.js';
import type { DesiredState } from '@/types/desired-state.js';

describe('FakeClaudeRunner', () => {
  it('returns the scripted result for a desired state', async () => {
    const runner = createFakeClaudeRunner({
      script: (ds) => ({
        requestId: ds.id,
        success: true,
        evidence: { desiredState: ds, note: 'scripted' },
      }),
    });
    const ds: DesiredState = { id: 'req-1', description: 'x' };
    const result = await runner.run(ds, {
      requestId: 'req-1',
      workingDirectory: '/tmp/x',
      timeoutMs: 1000,
    });
    expect(result.success).toBe(true);
    expect((result.evidence as { note: string }).note).toBe('scripted');
  });

  it('defaults to success: true with a trivial evidence payload', async () => {
    const runner = createFakeClaudeRunner();
    const result = await runner.run(
      { id: 'req-2', description: 'default' },
      { requestId: 'req-2', workingDirectory: '/tmp/x', timeoutMs: 1000 },
    );
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/claude.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/claude.js'`).

- [ ] **Step 3: Implement the helper**

Create `client/test/_support/claude.ts`:
```ts
import type { Runner, RunnerContext } from '@/runner/runner.js';
import type { DesiredState, RestorationResult } from '@/types/index.js';

export interface FakeClaudeOpts {
  script?: (desiredState: DesiredState, context: RunnerContext) => RestorationResult;
}

/**
 * In-process substitute for `ClaudeRunner`. Does not spawn a subprocess.
 * Integration tests wire this in via DI where production uses `ClaudeRunner`.
 */
export function createFakeClaudeRunner(opts: FakeClaudeOpts = {}): Runner {
  return {
    async run(desiredState, context) {
      if (opts.script) return opts.script(desiredState, context);
      return {
        requestId: context.requestId,
        success: true,
        evidence: { desiredState, note: 'fake-claude-default' },
      } satisfies RestorationResult;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/claude.test.ts 2>&1 | tail -5`
Expected: `Tests 2 passed (2)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1102 passed | 2 skipped (1104)`.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/claude.ts client/test/_support/claude.test.ts
git commit -m "test(support): add FakeClaudeRunner in-process substitute"
```

---

### Task 9: `test/_support/chain/port-allocator.ts`

**Files:**
- Create: `client/test/_support/chain/port-allocator.ts`
- Create: `client/test/_support/chain/port-allocator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/chain/port-allocator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { allocateAnvilPort } from '@test/chain/port-allocator.js';
import { createServer } from 'node:net';

describe('allocateAnvilPort', () => {
  it('returns a listenable port', async () => {
    const port = await allocateAnvilPort();
    expect(port).toBeGreaterThan(1024);
    // Verify the port is currently unbound — bind and immediately close.
    await new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });

  it('returns different ports on repeated calls', async () => {
    const a = await allocateAnvilPort();
    const b = await allocateAnvilPort();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/chain/port-allocator.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/chain/port-allocator.js'`).

- [ ] **Step 3: Implement the allocator**

Create `client/test/_support/chain/port-allocator.ts`:
```ts
import { createServer } from 'node:net';

/**
 * Asks the OS kernel for a free TCP port by binding to :0 and reading the
 * assigned port. Caller must spawn its process promptly — the port is
 * re-usable immediately but a racing allocator could pick it.
 * Replaces the hand-coded 8546 / 8547 / 8548 / 8549 ports in the legacy e2e scripts.
 */
export function allocateAnvilPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not resolve allocated port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/chain/port-allocator.test.ts 2>&1 | tail -5`
Expected: `Tests 2 passed (2)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1104 passed | 2 skipped (1106)`.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/chain/port-allocator.ts client/test/_support/chain/port-allocator.test.ts
git commit -m "test(support): add dynamic anvil port allocator"
```

---

### Task 10: `test/_support/chain/interface.ts` — `ChainTestHarness`

**Files:**
- Create: `client/test/_support/chain/interface.ts`

- [ ] **Step 1: Create the interface file**

Create `client/test/_support/chain/interface.ts`:
```ts
import type { Address, Hex, WalletClient } from 'viem';

/**
 * Common API for anything that pretends to be an EVM chain in tests.
 * Implemented by `anvil.ts` (real anvil fork) and, potentially later, by an
 * in-memory `FakeChain` (deferred — see design spec §5.4 and risk #1).
 */
export interface ChainTestHarness {
  /** JSON-RPC URL the harness listens on. */
  rpcUrl: string;

  /** Impersonate an address, run `fn`, then stop impersonating — even on throw. */
  impersonate<T>(addr: Address, fn: (client: WalletClient) => Promise<T>): Promise<T>;

  /** Set native (ETH) balance for an address. */
  setBalance(addr: Address, wei: bigint): Promise<void>;

  /** Write directly to a contract storage slot — used for token funding via balance map. */
  setStorageSlot(contract: Address, slot: Hex, value: Hex): Promise<void>;

  /** Mine N empty blocks. */
  mineBlocks(n: number): Promise<void>;

  /** Current block timestamp in seconds. */
  now(): Promise<number>;

  /** Advance block timestamp by `seconds`. */
  advanceTime(seconds: number): Promise<void>;

  /** Tear down the harness (kill anvil, drop state). */
  teardown(): Promise<void>;
}
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `yarn typecheck`
Expected: zero errors.

- [ ] **Step 3: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1104 passed | 2 skipped (1106)` (no new tests — interface-only).

- [ ] **Step 4: Commit**

```bash
git add client/test/_support/chain/interface.ts
git commit -m "test(support): define ChainTestHarness interface"
```

---

### Task 11: `test/_support/chain/anvil.ts` — `spawnAnvilFork`

**Files:**
- Create: `client/test/_support/chain/anvil.ts`
- Create: `client/test/_support/chain/anvil.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/chain/anvil.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { spawnAnvilFork } from '@test/chain/anvil.js';
import type { ChainTestHarness } from '@test/chain/interface.js';

// This test requires Foundry (anvil) on PATH and internet connectivity for the fork.
const RUN_ANVIL = process.env['JINN_TEST_SKIP_ANVIL'] !== '1';
const describeMaybe = RUN_ANVIL ? describe : describe.skip;

describeMaybe('spawnAnvilFork', () => {
  let harness: (ChainTestHarness & { port: number; pid: number }) | undefined;

  afterEach(async () => {
    if (harness) { await harness.teardown(); harness = undefined; }
  });

  it('spawns an anvil fork on a dynamically allocated port', async () => {
    harness = await spawnAnvilFork({ silent: true });
    expect(harness.port).toBeGreaterThan(1024);
    expect(harness.rpcUrl).toBe(`http://127.0.0.1:${harness.port}`);
    const block = await harness.now();
    expect(block).toBeGreaterThan(0);
  }, 30_000);

  it('can set balance and mine blocks', async () => {
    harness = await spawnAnvilFork({ silent: true });
    const addr = '0x000000000000000000000000000000000000dEaD' as const;
    await harness.setBalance(addr, 10n ** 18n);
    const before = await harness.now();
    await harness.mineBlocks(3);
    const after = await harness.now();
    expect(after).toBeGreaterThanOrEqual(before);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/chain/anvil.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/chain/anvil.js'`).

- [ ] **Step 3: Implement `spawnAnvilFork`**

Create `client/test/_support/chain/anvil.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { Address, Hex, WalletClient } from 'viem';
import { createWalletClient, http, numberToHex } from 'viem';
import { mainnet } from 'viem/chains';
import type { ChainTestHarness } from './interface.js';
import { allocateAnvilPort } from './port-allocator.js';

export interface SpawnAnvilOpts {
  /** Fork source (default: BASE_RPC_URL env → mainnet.base.org). */
  forkUrl?: string;
  /** Pin fork at a specific block; defaults to tip. */
  forkBlock?: number;
  /** Suppress anvil stdout. Default: true. */
  silent?: boolean;
  /** How long to wait for anvil readiness, ms. Default: 15_000. */
  readyTimeoutMs?: number;
}

export interface AnvilHarness extends ChainTestHarness {
  port: number;
  pid: number;
}

/**
 * Shared anvil spawner. Replaces the copy-pasted `jsonRpc`, `spawn(anvilPath, …)`,
 * and hand-coded port constants duplicated across 6 legacy e2e scripts.
 */
export async function spawnAnvilFork(opts: SpawnAnvilOpts = {}): Promise<AnvilHarness> {
  const forkUrl = opts.forkUrl ?? process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
  const silent = opts.silent ?? true;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const port = await allocateAnvilPort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const args = ['--fork-url', forkUrl, '--port', String(port)];
  if (silent) args.push('--silent');
  if (opts.forkBlock !== undefined) args.push('--fork-block-number', String(opts.forkBlock));

  const child: ChildProcess = spawn('anvil', args, {
    stdio: silent ? 'ignore' : 'inherit',
    detached: false,
  });

  // Wait for anvil to accept RPC calls.
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await jsonRpc(rpcUrl, 'eth_chainId', []);
      break;
    } catch { await sleep(100); }
  }
  if (Date.now() >= deadline) {
    child.kill('SIGKILL');
    throw new Error(`anvil did not become ready within ${readyTimeoutMs}ms on port ${port}`);
  }

  const harness: AnvilHarness = {
    rpcUrl,
    port,
    pid: child.pid ?? -1,

    async impersonate(addr, fn) {
      await jsonRpc(rpcUrl, 'anvil_impersonateAccount', [addr]);
      try {
        const client = createWalletClient({
          account: addr,
          chain: mainnet,           // chain object is only used for viem types; unlocked accounts ignore chain id
          transport: http(rpcUrl),
        }) as WalletClient;
        return await fn(client);
      } finally {
        await jsonRpc(rpcUrl, 'anvil_stopImpersonatingAccount', [addr]);
      }
    },

    async setBalance(addr, wei) {
      await jsonRpc(rpcUrl, 'anvil_setBalance', [addr, numberToHex(wei)]);
    },

    async setStorageSlot(contract, slot, value) {
      await jsonRpc(rpcUrl, 'anvil_setStorageAt', [contract, slot, value]);
    },

    async mineBlocks(n) {
      await jsonRpc(rpcUrl, 'anvil_mine', [numberToHex(BigInt(n))]);
    },

    async now() {
      const head = (await jsonRpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false])) as {
        timestamp: Hex;
      };
      return Number(BigInt(head.timestamp));
    },

    async advanceTime(seconds) {
      await jsonRpc(rpcUrl, 'evm_increaseTime', [seconds]);
      await jsonRpc(rpcUrl, 'anvil_mine', ['0x1']);
    },

    async teardown() {
      if (child.killed) return;
      child.kill('SIGKILL');
    },
  };

  return harness;
}

/** Raw JSON-RPC POST; exported only for tests that need to call unsupported methods. */
export async function jsonRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`RPC error (${method}): ${body.error.message}`);
  return body.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/chain/anvil.test.ts 2>&1 | tail -5`
Expected: `Tests 2 passed (2)`. If foundry is not installed, set `JINN_TEST_SKIP_ANVIL=1` to skip.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1106 passed | 2 skipped (1108)` (or +0 if skipped).

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/chain/anvil.ts client/test/_support/chain/anvil.test.ts
git commit -m "test(support): add spawnAnvilFork with shared jsonRpc + harness impl"
```

---

### Task 12: `test/_support/chain/olas-funding.ts`

**Files:**
- Create: `client/test/_support/chain/olas-funding.ts`
- Create: `client/test/_support/chain/olas-funding.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/_support/chain/olas-funding.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { spawnAnvilFork, type AnvilHarness } from '@test/chain/anvil.js';
import { fundAddressWithOLAS, OLAS_TOKEN_BASE } from '@test/chain/olas-funding.js';
import { createPublicClient, http, parseAbi } from 'viem';

const RUN_ANVIL = process.env['JINN_TEST_SKIP_ANVIL'] !== '1';
const describeMaybe = RUN_ANVIL ? describe : describe.skip;

describeMaybe('fundAddressWithOLAS', () => {
  let harness: AnvilHarness | undefined;
  afterEach(async () => { if (harness) { await harness.teardown(); harness = undefined; } });

  it('sets the ERC-20 balance to the requested amount', async () => {
    harness = await spawnAnvilFork({ silent: true });
    const holder = '0x000000000000000000000000000000000000C0Ed' as const;
    const amount = 5000n * 10n ** 18n;
    await fundAddressWithOLAS(harness, holder, amount);
    const client = createPublicClient({ transport: http(harness.rpcUrl) });
    const balance = await client.readContract({
      address: OLAS_TOKEN_BASE,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [holder],
    });
    expect(balance).toBe(amount);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test test/_support/chain/olas-funding.test.ts 2>&1 | tail -10`
Expected: FAIL (`Cannot find module '@test/chain/olas-funding.js'`).

- [ ] **Step 3: Implement the helper**

Create `client/test/_support/chain/olas-funding.ts`:
```ts
import { keccak256, pad, toHex, encodeAbiParameters, type Address, type Hex } from 'viem';
import type { ChainTestHarness } from './interface.js';

/** OLAS token address on Base (shared by all Base fork e2e tests). */
export const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416' as const satisfies Address;

/**
 * Funds `holder` with `amount` OLAS by writing directly to the ERC-20 balance
 * mapping slot. Replaces the OLAS-whale impersonation + transfer dance that
 * three legacy e2e scripts copy-pasted.
 *
 * Slot derivation: balance mapping is at slot 0 for the OLAS token on Base.
 * If a future test targets a token with a different balance slot, parameterize
 * this helper rather than adding another copy.
 */
export async function fundAddressWithOLAS(
  chain: ChainTestHarness,
  holder: Address,
  amount: bigint,
): Promise<void> {
  const slot = computeMappingSlot(holder, 0n);
  const value = pad(toHex(amount), { size: 32 });
  await chain.setStorageSlot(OLAS_TOKEN_BASE, slot, value);
}

/** Computes keccak256(abi.encode(key, slot)) for a standard Solidity mapping layout. */
function computeMappingSlot(key: Address, mappingSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [key, mappingSlot],
    ),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test test/_support/chain/olas-funding.test.ts 2>&1 | tail -5`
Expected: `Tests 1 passed (1)`.

- [ ] **Step 5: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1107 passed | 2 skipped (1109)`.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/chain/olas-funding.ts client/test/_support/chain/olas-funding.test.ts
git commit -m "test(support): add fundAddressWithOLAS storage-slot helper"
```

---

### Task 13: Move e2e scripts to `test/e2e/`

**Files:**
- Move: `client/scripts/e2e-validate.ts` → `client/test/e2e/validate.ts`
- Move: `client/scripts/e2e-portfolio-v0.ts` → `client/test/e2e/portfolio-v0.ts`
- Move: `client/scripts/e2e-prediction-v0.ts` → `client/test/e2e/prediction-v0.ts`
- Move: `client/scripts/e2e-prediction-apy-v0.ts` → `client/test/e2e/prediction-apy-v0.ts`
- Move: `client/scripts/e2e-legacy-restorer.ts` → `client/test/e2e/legacy-restorer.ts`
- Move: `client/scripts/staking-validate.ts` → `client/test/e2e/staking.ts`
- Move: `client/scripts/stolas-validate.ts` → `client/test/e2e/stolas.ts`
- Modify: `client/package.json`

- [ ] **Step 1: Create the directory**

Run: `mkdir -p client/test/e2e`

- [ ] **Step 2: Move the 7 files with `git mv` to preserve history**

Run:
```bash
cd client
git mv scripts/e2e-validate.ts           test/e2e/validate.ts
git mv scripts/e2e-portfolio-v0.ts       test/e2e/portfolio-v0.ts
git mv scripts/e2e-prediction-v0.ts      test/e2e/prediction-v0.ts
git mv scripts/e2e-prediction-apy-v0.ts  test/e2e/prediction-apy-v0.ts
git mv scripts/e2e-legacy-restorer.ts    test/e2e/legacy-restorer.ts
git mv scripts/staking-validate.ts       test/e2e/staking.ts
git mv scripts/stolas-validate.ts        test/e2e/stolas.ts
```

- [ ] **Step 3: Fix relative imports inside the moved files**

Each moved file contains imports like `import { MechAdapter } from '../src/adapters/mech/adapter.js';` — these were one level up from `scripts/`, now two levels up from `test/e2e/`. For each of the 7 files:

Run:
```bash
# Replace '../src/' with '../../src/' — the moved files are one dir deeper.
for f in client/test/e2e/*.ts; do
  sed -i.bak "s|'\\.\\./src/|'../../src/|g" "$f"
  rm "${f}.bak"
done
```

Also verify `import.meta.url`-based `__dirname` dances still land on `client/` (not `test/` or `scripts/`). The `e2e-validate.ts` uses `__dirname, '..'` to reach `client/`; it now needs `'..', '..'`. Search each file for `__dirname, '..'` patterns and add another `'..'` segment. Same for `join(dirname(fileURLToPath(import.meta.url)), '..', '.env')` — add another `'..'`.

- [ ] **Step 4: Update `package.json` scripts**

Modify `client/package.json` — replace these lines in the `scripts` block:

```json
"e2e": "tsx scripts/e2e-validate.ts",
"e2e-portfolio-v0": "tsx scripts/e2e-portfolio-v0.ts",
"e2e-prediction-apy-v0": "tsx scripts/e2e-prediction-apy-v0.ts",
"e2e:prediction": "cd ../contracts && yarn compile && cd ../client && tsx scripts/e2e-prediction-v0.ts",
"staking": "tsx scripts/staking-validate.ts",
"stolas": "tsx scripts/stolas-validate.ts",
```

with:

```json
"e2e": "tsx test/e2e/validate.ts",
"e2e-portfolio-v0": "tsx test/e2e/portfolio-v0.ts",
"e2e-prediction-apy-v0": "tsx test/e2e/prediction-apy-v0.ts",
"e2e:prediction": "cd ../contracts && yarn compile && cd ../client && tsx test/e2e/prediction-v0.ts",
"staking": "tsx test/e2e/staking.ts",
"stolas": "tsx test/e2e/stolas.ts",
```

- [ ] **Step 5: Update `vitest.config.ts` to exclude e2e from the unit suite**

Open `client/vitest.config.ts` and change the `include` pattern to exclude `test/e2e/`:

```ts
include: ['test/**/*.test.ts'],
exclude: ['test/e2e/**', 'node_modules/**'],
```

e2e files are `.ts` (not `.test.ts`) so they were never matched, but the explicit exclude documents the intent.

- [ ] **Step 6: Verify vitest still passes**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests 1107 passed | 2 skipped (1109)` — no change (e2e scripts weren't in vitest anyway).

- [ ] **Step 7: Verify typecheck still passes (flushes out missed import fixes)**

Run: `yarn typecheck`
Expected: zero errors. If there are errors, find the missed `../src/` path and add the extra `../`.

- [ ] **Step 8: Smoke-test one e2e locally (optional — requires anvil + internet)**

Run: `yarn e2e 2>&1 | tail -20`
Expected: script starts and reaches at least the bootstrap phase. Full run not required.

- [ ] **Step 9: Commit**

```bash
git add client/test/e2e/ client/scripts/ client/package.json client/vitest.config.ts
git commit -m "refactor(e2e): move e2e-*.ts and *-validate.ts into test/e2e/"
```

---

### Task 14: Exemplar migration — CLI `doctor` from `vi.mock` to DI + `makeCommandCtx`

**Files:**
- Modify: `client/src/cli/commands/doctor.ts` (refactor to factory pattern)
- Modify: `client/test/cli/commands/doctor.test.ts` (replace `vi.mock` with DI + `makeCommandCtx`)

- [ ] **Step 1: Read the current doctor.ts shape**

Run: `grep -n "^import\|^export\|^function\|^async function\|CommandModule" client/src/cli/commands/doctor.ts`

Identify the external deps the command statically imports: at minimum `loadConfig`, `checkRpcNetwork`, `rpcNetworkFailureHint`, `runPortfolioV0DoctorChecks`. Keep a list — these become DI deps in Step 3.

- [ ] **Step 2: Write a new integration test using DI (failing)**

Replace `client/test/cli/commands/doctor.test.ts` entirely with:
```ts
import { describe, it, expect } from 'vitest';
import { createDoctorCommand } from '@/cli/commands/doctor.js';
import { runCommand } from '@test/cli.js';

describe('doctor command (DI integration)', () => {
  it('emits an ok envelope when every check passes', async () => {
    const cmd = createDoctorCommand({
      loadConfig: () => ({
        network: 'testnet',
        rpcUrl: 'http://fake',
        apiPort: 7331,
      } as any),
      getConfigPathFromArgs: () => undefined,
      checkRpcNetwork: async () => ({
        ok: true,
        network: 'testnet' as const,
        expectedChainId: 84532,
        actualChainId: 84532,
        rpcHost: 'fake',
      }),
      rpcNetworkFailureHint: () => 'unused',
      runPortfolioV0DoctorChecks: async () => [],
    });
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0] as { schemaVersion: number; ok: boolean; checks: unknown[] };
    expect(env.schemaVersion).toBe(1);
    expect(env.ok).toBe(true);
    expect(env.checks.length).toBeGreaterThan(0);
  });

  it('emits ok=false when rpc-network check fails', async () => {
    const cmd = createDoctorCommand({
      loadConfig: () => ({ network: 'testnet', rpcUrl: 'http://fake', apiPort: 7331 } as any),
      getConfigPathFromArgs: () => undefined,
      checkRpcNetwork: async () => ({
        ok: false,
        network: 'testnet' as const,
        expectedChainId: 84532,
        actualChainId: 1,
        rpcHost: 'fake',
      }),
      rpcNetworkFailureHint: () => 'set rpcUrl',
      runPortfolioV0DoctorChecks: async () => [],
    });
    const { envelopes } = await runCommand(cmd);
    expect((envelopes[0] as { ok: boolean }).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run new test to verify it fails**

Run: `yarn test test/cli/commands/doctor.test.ts 2>&1 | tail -10`
Expected: FAIL — `createDoctorCommand` is not exported.

- [ ] **Step 4: Refactor `doctor.ts` to factory pattern**

Open `client/src/cli/commands/doctor.ts`. Introduce the following shape — **keeping the existing logic intact**, just threading deps through.

At the top, after imports, add:
```ts
import type { JinnConfig } from '../../config.js';
import { getConfigPathFromArgs as defaultGetConfigPathFromArgs, loadConfig as defaultLoadConfig } from '../../config.js';
import { checkRpcNetwork as defaultCheckRpcNetwork, rpcNetworkFailureHint as defaultRpcNetworkFailureHint } from '../../preflight/rpc-network.js';
import { runPortfolioV0DoctorChecks as defaultRunPortfolioV0DoctorChecks } from '../../api/portfolio-v0-doctor.js';

export interface DoctorDeps {
  loadConfig: (path?: string) => JinnConfig;
  getConfigPathFromArgs: (argv: string[]) => string | undefined;
  checkRpcNetwork: typeof defaultCheckRpcNetwork;
  rpcNetworkFailureHint: typeof defaultRpcNetworkFailureHint;
  runPortfolioV0DoctorChecks: typeof defaultRunPortfolioV0DoctorChecks;
}

const PRODUCTION_DEPS: DoctorDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  checkRpcNetwork: defaultCheckRpcNetwork,
  rpcNetworkFailureHint: defaultRpcNetworkFailureHint,
  runPortfolioV0DoctorChecks: defaultRunPortfolioV0DoctorChecks,
};
```

Now perform the factory wrap as **three mechanical edits** — do not rewrite the helpText or other string literals; leave them in place.

**Edit A.** Delete the existing static top-level imports of `loadConfig`, `getConfigPathFromArgs`, `checkRpcNetwork`, `rpcNetworkFailureHint`, `runPortfolioV0DoctorChecks` (now renamed with `default` prefix in the `DoctorDeps` block above — the `default*` versions replace them).

**Edit B.** Find the existing top-level `const command: CommandModule = { … };` declaration. Wrap it in a factory. Before the declaration, add:
```ts
export function createDoctorCommand(deps: DoctorDeps = PRODUCTION_DEPS): CommandModule {
  return {
```
Immediately after the final `};` of the existing object literal, add:
```ts
  };
}

const command: CommandModule = createDoctorCommand();
```
The existing object literal (name, summary, helpText, run) is preserved verbatim — only the outer wrapping changes.

**Edit C.** Inside the factory body (the body of `run(ctx)` and any helpers it calls), rewrite each reference:
- `loadConfig(` → `deps.loadConfig(`
- `getConfigPathFromArgs(` → `deps.getConfigPathFromArgs(`
- `checkRpcNetwork(` → `deps.checkRpcNetwork(`
- `rpcNetworkFailureHint(` → `deps.rpcNetworkFailureHint(`
- `runPortfolioV0DoctorChecks(` → `deps.runPortfolioV0DoctorChecks(`

The helper `checkRpcNetworkForDoctor(config)` currently lives at module scope. Move it inside `createDoctorCommand` (so it closes over `deps`), or convert it to accept `deps` as an extra arg. Either works; inner-closure is less diff.

- [ ] **Step 5: Run typecheck**

Run: `yarn typecheck`
Expected: zero errors. If any errors surface (e.g., a helper in `doctor.ts` still references the static import), convert that helper to close over `deps` by moving it inside `createDoctorCommand`.

- [ ] **Step 6: Run new integration test — should pass**

Run: `yarn test test/cli/commands/doctor.test.ts 2>&1 | tail -8`
Expected: `Tests 2 passed (2)`.

- [ ] **Step 7: Verify `grep -n "vi\\.mock" test/cli/commands/doctor.test.ts` returns nothing**

Run: `grep -n "vi\\.mock" client/test/cli/commands/doctor.test.ts`
Expected: no output (exit code 1).

- [ ] **Step 8: Full suite still green**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests ~1104 passed` (the doctor test went from ~3 tests to 2 — may see a small count delta; the count must remain within ±5 of the prior baseline).

- [ ] **Step 9: Commit**

```bash
git add client/src/cli/commands/doctor.ts client/test/cli/commands/doctor.test.ts
git commit -m "refactor(cli): doctor command uses DI factory; test drops vi.mock"
```

---

### Task 15: Exemplar migration — `test/restorer/engine/engine.test.ts` uses `createStateMachineSpy`

**Files:**
- Modify: `client/test/restorer/engine/engine.test.ts` (delete local `TestEngine` subclass; use helper)

- [ ] **Step 1: Read current engine.test.ts**

Run: `grep -n "class TestEngine\|noopRegistry\|makeOpts\|makeInput\|beforeEach\|afterEach" client/test/restorer/engine/engine.test.ts`

Confirm the file defines `noopRegistry`, `makeOpts`, `makeInput`, and `class TestEngine` locally — these are the duplication targets.

- [ ] **Step 2: Rewrite the imports and scaffolding section**

In `client/test/restorer/engine/engine.test.ts`, delete:
- The local `noopRegistry` constant
- The local `makeOpts` function
- The local `makeInput` function
- The local `class TestEngine` declaration (entire subclass)

Replace with these imports at the top of the file:
```ts
import { withTempStore } from '@test/store.js';
import { makeIntentInput, createStateMachineSpy } from '@test/engine.js';
```

Rewrite the top-level `describe` block to use `withTempStore` and `createStateMachineSpy`. Each `it` that previously did `store = new Store(':memory:')` + `engine = new TestEngine(makeOpts(store))` now reads:

```ts
it('DISCOVERED → dispatches to claim()', async () => {
  await withTempStore(async (store) => {
    const { engine, calls } = createStateMachineSpy({ store });
    const persisted = engine.testPersistence.insertDiscovered(makeIntentInput({ requestId: 'r-disc' }));
    await engine.claim(persisted).catch(() => undefined);
    expect(calls).toContain('claim');
  });
});
```

Apply the same pattern to every `it` block. Tests that previously overrode a specific lifecycle method (e.g. `testEngine.claimFn = ...`) now pass `onClaim: …` in the opts to `createStateMachineSpy`.

- [ ] **Step 3: Run the migrated test**

Run: `yarn test test/restorer/engine/engine.test.ts 2>&1 | tail -10`
Expected: all tests in that file pass. Same count as before the migration (±0).

- [ ] **Step 4: Verify full suite**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests ~1104 passed` — the migration should not change the total test count.

- [ ] **Step 5: Verify the local scaffolding is actually gone**

Run: `grep -n "class TestEngine\|class SpyEngine\|const noopRegistry\|function makeOpts" client/test/restorer/engine/engine.test.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add client/test/restorer/engine/engine.test.ts
git commit -m "refactor(test): engine.test.ts uses @test/engine spy helpers"
```

---

### Task 16: Exemplar migration — `test/e2e/validate.ts` uses `spawnAnvilFork`

**Files:**
- Modify: `client/test/e2e/validate.ts` (replace inline anvil boilerplate with helper calls)

- [ ] **Step 1: Add helper imports at the top of the file**

In `client/test/e2e/validate.ts`, add after the existing imports:
```ts
import { spawnAnvilFork, jsonRpc as anvilJsonRpc } from '@test/chain/anvil.js';
import { fundAddressWithOLAS } from '@test/chain/olas-funding.js';
```

Note: the file is not run by vitest, so the `@test/` alias must be resolvable by `tsx`. If `tsx` does not honor the tsconfig paths by default, install `tsconfig-paths/register` and add `-r tsconfig-paths/register` to the `yarn e2e` script, or use a plain relative import (`../_support/chain/anvil.js`). Prefer the latter for simplicity — change the import to:
```ts
import { spawnAnvilFork, jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';
import { fundAddressWithOLAS } from '../_support/chain/olas-funding.js';
```

- [ ] **Step 2: Delete the inline anvil scaffolding**

Remove the following from the file:
1. The constant `const ANVIL_PORT = 8546;` (line ~67)
2. The constant `const ANVIL_RPC = ...;` (line ~68)
3. The local `async function jsonRpc(...)` definition (starting around line ~181)

Keep `BASE_RPC_URL` — `spawnAnvilFork` reads it from env as a fallback, and the script may still reference it for logging.

- [ ] **Step 3: Replace the anvil-spawn block with `spawnAnvilFork`**

Find the block that spawns anvil (around line ~580; contains `anvil = spawn(anvilPath, anvilArgs, ...)`). Replace the entire block — including the ready-wait loop and the port/rpc setup — with:

```ts
const chain = await spawnAnvilFork({
  forkUrl: BASE_RPC_URL,
  silent: true,
});
// Subsequent code references:
const ANVIL_RPC = chain.rpcUrl;
const ANVIL_PORT = chain.port;
```

Every later call site of `jsonRpc(ANVIL_RPC, 'anvil_setBalance', [addr, value])` stays valid — but rename the import to avoid shadowing: replace `jsonRpc(` with `anvilJsonRpc(` where it appears in this file, OR reassign `const jsonRpc = anvilJsonRpc;` once at the top to minimize diff.

- [ ] **Step 4: Replace the OLAS funding block with `fundAddressWithOLAS`**

Find the OLAS-whale impersonation + transfer block (search for `anvil_impersonateAccount` near an OLAS_TOKEN reference, around lines 660–680). Replace it with:
```ts
await fundAddressWithOLAS(chain, safeAddress, olasAmount);
```

- [ ] **Step 5: Replace the teardown at script exit**

Find the spot where the script calls `anvil.kill(...)` (search `anvil.kill`). Replace the explicit kill with:
```ts
await chain.teardown();
```

- [ ] **Step 6: Verify typecheck**

Run: `yarn typecheck`
Expected: zero errors.

- [ ] **Step 7: Confirm LOC reduction**

Run: `wc -l client/test/e2e/validate.ts`
Expected: file length reduced by 150–400 lines versus the pre-migration version. If less than 100, search for remaining `anvil_setBalance` / `anvil_impersonate` direct calls that should have been migrated.

- [ ] **Step 8: Smoke-test against real anvil (requires Foundry + internet)**

Run: `yarn e2e 2>&1 | tail -40`
Expected: script reaches at least the "bootstrapped" phase. If it does not, compare remaining diffs against the original `e2e-validate.ts` in git history.

If Foundry/internet are unavailable in the dev environment, skip the smoke and note it in the commit message — CI will catch regressions.

- [ ] **Step 9: Commit**

```bash
git add client/test/e2e/validate.ts
git commit -m "refactor(e2e): validate.ts uses spawnAnvilFork + fundAddressWithOLAS"
```

---

### Task 17: Write the SOP — `docs/runbooks/testing.md`

**Files:**
- Create: `docs/runbooks/testing.md`

- [ ] **Step 1: Create the SOP document**

Create `docs/runbooks/testing.md`:
```markdown
# Testing — standard operating procedure

This runbook is the canonical guide for writing tests in the Jinn monorepo.
Design rationale lives in `docs/superpowers/specs/2026-04-24-test-architecture-design.md`.

## The pyramid

Four tiers. Most tests belong in the **integration** tier.

1. **Unit** — pure logic, no I/O, no DI needed. Examples: `canonical-json.test.ts`,
   zod schema validators, pure helpers.
2. **Integration** — orchestration; real target module against **fake** external
   boundaries from `test/_support/`. This is the default tier for CLI commands,
   engine state-machine logic, API builders, restorer impls, and daemon loops.
3. **E2E** — real anvil fork, real IPFS, real or mocked Claude. One file per
   protocol scenario in `client/test/e2e/`.
4. **Manual acceptance** — `yarn release:testnet-acceptance`. Out of scope for
   this runbook.

## Which tier does my test belong in?

- Pure function with no external dependencies → **unit**
- CLI command, HTTP builder, state machine, bootstrap flow → **integration**
- Full protocol scenario against real EVM → **e2e**

## Where does the file go?

Tests mirror `src/`:
- `client/src/cli/commands/doctor.ts` → `client/test/cli/commands/doctor.test.ts`

When a single test file grows past ~400 LOC, split by aspect:
- `test/cli/commands/foo/a.test.ts`, `test/cli/commands/foo/b.test.ts`

E2E scripts live in `client/test/e2e/<scenario>.ts` and are invoked via
`yarn e2e`, `yarn e2e:portfolio`, etc. — not vitest.

## What do I mock?

**Default: nothing.** Wire a fake from `test/_support/`:

| Boundary | Fake |
|---|---|
| Claude subprocess | `createFakeClaudeRunner()` from `@test/claude.js` |
| Chain RPC | `spawnAnvilFork()` from `@test/chain/anvil.js` |
| IPFS | `createFakeIPFS()` from `@test/ipfs.js` |
| Time | `new FakeClock()` from `@test/time.js` |
| SQLite store | `withTempStore(fn)` from `@test/store.js` |
| `process.exit` | `makeCommandCtx()` from `@test/cli.js` captures it |

Only boundaries are legitimate targets for `vi.mock`. Every `vi.mock` call
requires a `// MOCK_JUSTIFICATION:` comment on the preceding line.

**Bad** — mocks an internal module:
```ts
vi.mock('../../src/config.js', () => ({ loadConfig: () => ({ ... }) }));
```

**Good** — inject the dep instead:
```ts
const cmd = createDoctorCommand({ loadConfig: () => ({ ... }), /* … */ });
```

**Legit vi.mock** — external boundary, DI infeasible:
```ts
// MOCK_JUSTIFICATION: child_process.spawn is a leaf syscall; cannot DI without a shim module we don't own.
vi.mock('node:child_process', () => ({ /* … */ }));
```

## Skeletons

### Unit test

```ts
import { describe, it, expect } from 'vitest';
import { canonicalizeJson } from '@/lib/canonical-json.js';

describe('canonicalizeJson', () => {
  it('sorts keys recursively', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
```

### Integration test — CLI command

```ts
import { describe, it, expect } from 'vitest';
import { createDoctorCommand } from '@/cli/commands/doctor.js';
import { runCommand } from '@test/cli.js';

describe('doctor command', () => {
  it('emits ok envelope on green path', async () => {
    const cmd = createDoctorCommand({
      loadConfig: () => ({ /* fake config */ } as any),
      checkRpcNetwork: async () => ({ ok: true, /* … */ }),
      /* other deps */
    });
    const { envelopes } = await runCommand(cmd);
    expect((envelopes[0] as { ok: boolean }).ok).toBe(true);
  });
});
```

### Integration test — engine / state machine

```ts
import { describe, it, expect } from 'vitest';
import { withTempStore } from '@test/store.js';
import { makeIntentInput, createStateMachineSpy } from '@test/engine.js';

describe('engine lifecycle', () => {
  it('transitions DISCOVERED → claim', async () => {
    await withTempStore(async (store) => {
      const { engine, calls } = createStateMachineSpy({
        store,
        onClaim: async () => { /* success */ },
      });
      const intent = engine.testPersistence.insertDiscovered(makeIntentInput());
      await engine.claim(intent);
      expect(calls).toContain('claim');
    });
  });
});
```

### E2E

```ts
import { spawnAnvilFork } from '../_support/chain/anvil.js';
import { fundAddressWithOLAS } from '../_support/chain/olas-funding.js';

const chain = await spawnAnvilFork({ silent: true });
try {
  await fundAddressWithOLAS(chain, someSafeAddress, 5000n * 10n ** 18n);
  // … drive the scenario via real CLI subprocesses, viem clients, etc.
} finally {
  await chain.teardown();
}
```

## How do I run tests?

| Command | Scope | Target time |
|---|---|---|
| `yarn test` | vitest (unit + integration) | < 15 s |
| `yarn test:watch` | vitest in watch mode | — |
| `yarn e2e` | one e2e scenario (validate) | < 2 min |
| `yarn e2e-portfolio-v0` | portfolio e2e | < 2 min |
| `yarn e2e-prediction-apy-v0` | prediction-apy e2e | < 2 min |
| `yarn e2e:prediction` | prediction-v0 e2e (compiles contracts first) | < 3 min |
| `yarn staking` | staking bootstrap e2e | < 2 min |
| `yarn stolas` | stolas bootstrap e2e | < 2 min |

## CI gates

- Every PR: `yarn typecheck` + `yarn test`.
- Nightly / release: all `yarn e2e*` scenarios serially.
- E2E tests use `allocateAnvilPort()` so parallelism is safe when we add it.

## Adding a new helper to `test/_support/`

1. Write the helper's own unit test under `test/_support/<name>.test.ts`.
2. Implement the helper. Prefer pure TS; lean on existing node APIs for I/O.
3. Document the helper's public API in a comment at the top of the file.
4. Migrate one existing test to use it, as proof that the API fits.

## Migration policy

Existing tests stay as-is until someone touches them. When a PR modifies
`src/foo/bar.ts`, the tests for that file migrate to the new shape in the same PR.
No big-bang refactor. New tests always use the new shape.
```

- [ ] **Step 2: Link the SOP from `CLAUDE.md`**

Modify `CLAUDE.md` — find the section near "Development Commands" and add above it (or anywhere prominent):

```markdown
## Testing

See [`docs/runbooks/testing.md`](docs/runbooks/testing.md) for the test SOP: pyramid,
where tests go, the mock policy, shared helpers. Design rationale lives in
[`docs/superpowers/specs/2026-04-24-test-architecture-design.md`](docs/superpowers/specs/2026-04-24-test-architecture-design.md).
```

- [ ] **Step 3: Link the SOP from `client/CONTRIBUTING.md`**

Modify `client/CONTRIBUTING.md` — replace the current test-count bullet (`yarn test # vitest suite — 267 tests`) with:

```bash
yarn test              # vitest suite — see docs/runbooks/testing.md
```

And add a new section after "Setup":

```markdown
## Tests

See [`docs/runbooks/testing.md`](../docs/runbooks/testing.md) for the SOP.
Shared helpers live in `test/_support/`.
```

- [ ] **Step 4: Verify typecheck + test still green**

Run: `yarn typecheck && yarn test 2>&1 | tail -3`
Expected: zero errors; test count unchanged.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/testing.md CLAUDE.md client/CONTRIBUTING.md
git commit -m "docs(testing): add SOP runbook; link from CLAUDE.md and CONTRIBUTING"
```

---

### Task 18: Fix stale counts in `CLAUDE.md` repo structure

**Files:**
- Modify: `CLAUDE.md` (or `cargo/CLAUDE.md`; whichever holds the stale count)

- [ ] **Step 1: Locate the stale count**

Run: `grep -rn "14 files, 33 tests\|267 tests" CLAUDE.md cargo/CLAUDE.md 2>/dev/null`

The repo-structure block in the top-level `CLAUDE.md` currently reads:
```
  test/                  Vitest tests (14 files, 33 tests)
```

Replace that line with:
```
  test/                  Vitest tests (see docs/runbooks/testing.md)
```

- [ ] **Step 2: Verify nothing else claims a specific test count**

Run: `grep -rn "tests)\|tests$" CLAUDE.md cargo/CLAUDE.md client/CLAUDE.md client/README.md client/CONTRIBUTING.md 2>/dev/null | grep -v "docs/runbooks"`

Fix any remaining stale counts by pointing to the runbook instead.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md  # + any other file modified in step 2
git commit -m "docs: remove stale test counts; point to docs/runbooks/testing.md"
```

---

### Task 19: Final verification and push

**Files:** none modified.

- [ ] **Step 1: Full suite pass**

Run: `yarn test 2>&1 | tail -3`
Expected: `Tests ≥1107 passed | 2 skipped` (original 1085 + helpers' own tests).

- [ ] **Step 2: Typecheck pass**

Run: `yarn typecheck`
Expected: zero errors.

- [ ] **Step 3: No leftover `vi.mock` in migrated tests**

Run: `grep -n "vi\\.mock" client/test/cli/commands/doctor.test.ts client/test/restorer/engine/engine.test.ts`
Expected: no output.

- [ ] **Step 4: No leftover local `makeCtx` / `TestEngine` in migrated files**

Run: `grep -n "function makeCtx\|class TestEngine\|class SpyEngine" client/test/cli/commands/doctor.test.ts client/test/restorer/engine/engine.test.ts`
Expected: no output.

- [ ] **Step 5: Close the bead and push**

Run from repo root:
```bash
bd close jinn-mono-cnp --reason="Spec + plan landed. Three exemplar migrations prove the pattern. Remaining tests migrate opportunistically per SOP."
git pull --rebase origin main
bd dolt push
git push -u origin refactor/tests-architecture
git status
```
Expected: `Your branch is up to date with 'origin/refactor/tests-architecture'.`

- [ ] **Step 6: Open PR (optional)**

Run:
```bash
gh pr create --title "refactor(test): shared helpers, SOP, and exemplar migrations" --body "$(cat <<'EOF'
## Summary
- Lands the test architecture spec and implementation plan.
- Adds `test/_support/` with cli/engine/store/claude/ipfs/chain/time helpers.
- Moves legacy `scripts/e2e-*.ts` and `*-validate.ts` under `test/e2e/`.
- Exemplar migrations: `doctor` CLI test → DI + `makeCommandCtx`; `engine.test.ts` → `createStateMachineSpy`; `validate.ts` e2e → `spawnAnvilFork`.
- Writes the SOP at `docs/runbooks/testing.md`.
- Removes stale test counts from `CLAUDE.md` and `CONTRIBUTING.md`.

## Test plan
- [ ] `yarn typecheck` clean
- [ ] `yarn test` passes ≥1107 tests
- [ ] `yarn e2e` reaches the bootstrap phase against anvil

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- Spec coverage verified: every acceptance-criterion item in §9 of the spec has a task.
- No TBDs / TODOs / placeholders.
- FakeChain (spec §5.4) is **explicitly deferred**; the `ChainTestHarness` interface is shipped so a future fake drops in without churn.
- Migration policy (spec §8) is captured in the SOP (Task 17) under "Migration policy".
- Lint rule (spec §8.5) is explicitly out of scope for this plan; it ships after ~6 weeks of bedding in.
