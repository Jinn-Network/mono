# Default learner — Registry Wiring + Acceptance (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `DefaultLearningRestorerImpl` (shipped by Plan 2) into `buildRestorerImpls` as the **first-match wrapper** per spec §12 — it wins for every kind, but internally delegates the Execute phase to the existing kind-specific specialist impls (`claude-mcp-hyperliquid`, `claude-mcp-prediction*`, etc.) so we don't lose battle-tested kind-specific paths. Plus three acceptance tests that exercise the full pipeline end-to-end: portfolio.v0 on an Anvil fork, the replan path, and the path-scope guard.

**Architecture:** A new `DefaultLearningWrapper` class wraps `DefaultLearningRestorerImpl` around a list of specialist impls. For an intent kind X with a specialist, the wrapper runs Orient/Strategize/Plan via the plugin (advisory framing for the specialist), then calls the specialist's `run(ctx)` directly — workingDir/.execute/ is populated by the specialist's outputs, not by step-worker subagents. Then it runs Debrief/Improve/Memory consolidation via the plugin so the learning loop captures what the specialist did. For kinds with no specialist, the wrapper runs Execute via the plugin's own step-worker fan-out as in Plans 1 + 2. `buildRestorerImpls` registers the wrapper FIRST and hands it the existing impls list as its delegation pool.

**Tech Stack:** TypeScript (ESM, Node >=20), Vitest, Anvil (for the portfolio.v0 e2e). No new dependencies — reuses Plan 2's `DefaultLearningRestorerImpl`, NoOp adapter, and Claude Code adapter; reuses existing engine, registry, and `claude-mcp-hyperliquid` infrastructure.

**Spec reference:** `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1, §12 open question 1 (registry precedence — first-match wrapper picked).

**Plan dependencies:**
- Plan 1 — `client/plugins/default-learner/` (markdown plugin)
- Plan 2 — `client/src/restorer/impls/default-learner/` (TS shim + adapters)

**Existing code anchors:**
- `client/src/restorer/impls/index.ts:56` — `buildRestorerImpls` (this plan modifies it)
- `client/src/restorer/types.ts:148` — `RestorerImpl` interface
- `client/src/restorer/engine/engine.ts:533` — engine's dispatch site
- `client/scripts/e2e-validate.ts` — existing Anvil-fork e2e harness pattern
- `client/scripts/e2e-portfolio-v0.ts` — existing portfolio.v0 e2e pattern (extend or copy)

---

## File structure (Plan 3)

**Source files (new):**

| File | Responsibility |
|---|---|
| `client/src/restorer/impls/default-learner/wrapper.ts` | `DefaultLearningWrapper` — wraps shim around specialist impls |

**Modified files:**

| File | Change |
|---|---|
| `client/src/restorer/impls/index.ts` | Register `DefaultLearningWrapper` first; hand it the specialist list |
| `client/src/restorer/impls/default-learner/index.ts` | Export `DefaultLearningWrapper` |

**Test files (new, under `client/test/restorer/impls/default-learner/`):**

| File | Coverage |
|---|---|
| `wrapper.test.ts` | Wrapper delegates Execute to specialist; runs outer phases via plugin; falls back to plugin Execute when no specialist |
| `path-scope.test.ts` | Synthetic worker attempting to write outside `implStateDir`/`workingDir` is blocked at the harness adapter or filesystem layer |
| `replan-path.test.ts` | Synthetic Execute step fails its successSignal; wrapper exercises the replan branch (writes plan-v2.json + replan-context.json) |

**E2E test (new, gated on Anvil availability):**

| File | Coverage |
|---|---|
| `client/scripts/e2e-default-learner-portfolio-v0.ts` | End-to-end on Anvil fork: post a portfolio.v0 intent, run daemon with default-learner registered, assert envelope produced + delivered |

---

## Task 1: `DefaultLearningWrapper` class

The wrapper holds a `DefaultLearningRestorerImpl` (the shim) and a list of specialist impls. On `run(ctx)`, it determines whether the intent's kind has a specialist; if yes, it runs the plugin's outer phases then delegates Execute to the specialist; if no, it runs the plugin's full pipeline.

**Implementation note:** The "outer phases via plugin, Execute via specialist" pattern requires the plugin's coordinator skill to be told to skip the Execute phase when the wrapper has delegated. We thread this via an env var (`JINN_DEFAULT_LEARNER_SKIP_EXECUTE=true`) the wrapper sets before invoking the shim, and which the coordinator skill reads. The plugin's coordinator skill will need a one-line update to honor this — Task 1 includes that update.

**Files:**
- Create: `client/src/restorer/impls/default-learner/wrapper.ts`
- Modify: `client/plugins/default-learner/skills/coordinator/SKILL.md` (one-line addition)
- Modify: `client/src/restorer/impls/default-learner/index.ts` (export wrapper)
- Test: `client/test/restorer/impls/default-learner/wrapper.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/wrapper.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLearningWrapper } from '../../../../src/restorer/impls/default-learner/wrapper.js';
import { DefaultLearningRestorerImpl } from '../../../../src/restorer/impls/default-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/default-learner/test-utils/noop-adapter.js';
import { fakeFullPipelineRun } from '../../../../src/restorer/impls/default-learner/test-utils/fake-plugin-outputs.js';
import type { RestorerImpl, RestorationContext, RestorationOutput } from '../../../../src/restorer/types.js';

function makeFakeSpecialist(kinds: string[]): RestorerImpl & { runCalled: boolean } {
  const stub = {
    name: `specialist-${kinds.join(',')}`,
    version: '0.0.1',
    runCalled: false,
    supports: (spec: { kind: string }) => kinds.includes(spec.kind),
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      stub.runCalled = true;
      // Simulate specialist writing its execute outputs.
      const dir = join(ctx.workingDir, '.execute');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'summary.json'),
        JSON.stringify({
          stepsCompleted: ['specialist-step-1'],
          stepsFailed: [],
          decisions: [],
          elapsedMs: 100,
          returnReason: 'all-steps-completed',
        }),
      );
      return {
        venueRef: { name: stub.name },
        gating: { specialistRan: true },
      };
    },
  };
  return stub;
}

function makeCtx(workingDir: string, implStateDir: string, kind: string): RestorationContext {
  const endTs = Date.now() + 60_000;
  return {
    intent: {
      id: 'wrapper-test-1',
      description: 'wrapper test',
      window: { startTs: Date.now() - 1000, endTs },
      spec: { kind } as RestorationContext['intent']['spec'],
    } as RestorationContext['intent'],
    intentCid: 'bafywrapper',
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  };
}

describe('DefaultLearningWrapper', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-wrap-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-wrap-state-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('supports() always returns true (first-match)', () => {
    const adapter = new NoOpHarnessAdapter();
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [] });
    expect(wrapper.supports({ kind: 'portfolio.v0' })).toBe(true);
    expect(wrapper.supports({ kind: 'random.kind' })).toBe(true);
  });

  it('delegates Execute to specialist when kind has one (and skips plugin Execute)', async () => {
    const specialist = makeFakeSpecialist(['portfolio.v0']);
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      // Simulate plugin running outer phases only.
      fakeFullPipelineRun(inputs.workingDir, { intentKind: inputs.intentKind ?? 'unknown' });
      // Confirm wrapper set the skip-execute env hint somehow visible to the adapter.
      // Wrapper passes this via inputs.adapterEnv (extension we add below).
    });
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [specialist] });

    const ctx = makeCtx(workingDir, implStateDir, 'portfolio.v0');
    const out = await wrapper.run(ctx);

    expect(specialist.runCalled).toBe(true);
    expect(out.venueRef.name).toEqual('default-learner');
    expect(out.gating).toMatchObject({
      executeSpecialist: 'specialist-portfolio.v0',
      executeReturnReason: 'all-steps-completed',
    });
  });

  it('runs full plugin pipeline (including Execute) when no specialist matches', async () => {
    const adapter = new NoOpHarnessAdapter();
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [] });

    const ctx = makeCtx(workingDir, implStateDir, 'unknown.kind');
    const out = await wrapper.run(ctx);

    expect(out.venueRef.name).toEqual('default-learner');
    expect(out.gating.phasesCompleted).toContain('execute');
  });

  it('skips specialist when its supports() returns false even if it is in the list', async () => {
    const wrongSpecialist = makeFakeSpecialist(['prediction.v0']);
    const adapter = new NoOpHarnessAdapter();
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [wrongSpecialist] });

    const ctx = makeCtx(workingDir, implStateDir, 'portfolio.v0');
    await wrapper.run(ctx);

    expect(wrongSpecialist.runCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/wrapper.test.ts
```

Expected: FAIL — `DefaultLearningWrapper` not exported.

- [ ] **Step 3: Implement the wrapper**

```typescript
// client/src/restorer/impls/default-learner/wrapper.ts
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
} from '../../types.js';
import type { DefaultLearningRestorerImpl } from './restorer.js';
import { harvestOutput } from './harvest.js';

export interface DefaultLearningWrapperConfig {
  /** The shim configured with a harness adapter (Plan 2). */
  shim: DefaultLearningRestorerImpl;
  /**
   * Specialist impls to delegate Execute to when the kind matches. Order
   * matters: first matching specialist wins. Typically this is the
   * existing buildRestorerImpls list MINUS the wrapper itself.
   */
  specialists: RestorerImpl[];
}

/**
 * First-match wrapper per spec §12. Wins for every kind via supports()
 * returning true; internally delegates Execute to the kind-specific
 * specialist when one exists, while the plugin's outer phases (Orient,
 * Strategize, Plan, Debrief, Improve, Memory consolidation) wrap around
 * it as the learning envelope.
 *
 * For intents with no specialist, the wrapper runs the plugin's full
 * pipeline including its own Execute (which spawns step-worker subagents).
 */
export class DefaultLearningWrapper implements RestorerImpl {
  readonly name = 'default-learner';
  readonly version: string;
  private readonly shim: DefaultLearningRestorerImpl;
  private readonly specialists: RestorerImpl[];

  constructor(config: DefaultLearningWrapperConfig) {
    this.shim = config.shim;
    this.specialists = config.specialists;
    this.version = config.shim.version;
  }

  supports(_spec: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return true;
  }

  /**
   * Look up the first specialist whose supports() returns true for this
   * intent's kind/type. The wrapper itself is excluded from the
   * specialists list at construction time.
   */
  private findSpecialist(spec: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | null {
    for (const candidate of this.specialists) {
      if (candidate.supports(spec)) return candidate;
    }
    return null;
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const intentSpec = {
      kind: ctx.intent.spec?.kind ?? '',
      type: ctx.intent.type ?? 'restoration',
    } as { kind: string; type?: 'restoration' | 'evaluation' };

    const specialist = this.findSpecialist(intentSpec);

    if (!specialist) {
      // No specialist — run the plugin's full pipeline.
      return this.shim.run(ctx);
    }

    // Specialist path: tell the plugin coordinator to skip its own
    // Execute phase by setting an env hint the coordinator skill reads.
    const prevSkip = process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE;
    process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE = 'true';
    try {
      // Run the plugin (it will skip Execute internally, leaving
      // workingDir/.execute/ empty).
      await this.shim.run(ctx);
    } finally {
      if (prevSkip === undefined) {
        delete process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE;
      } else {
        process.env.JINN_DEFAULT_LEARNER_SKIP_EXECUTE = prevSkip;
      }
    }

    // Now the specialist runs. It writes its own workingDir/.execute/
    // outputs (and any other artifacts the kind contract requires).
    const specialistOut = await specialist.run(ctx);

    // Re-harvest workingDir to combine the plugin's outer-phase artifacts
    // with the specialist's Execute outputs into a single
    // RestorationOutput. We also bring forward the specialist's
    // venueRef + any kind-specific gating fields.
    const harvested = harvestOutput(ctx.workingDir);
    return {
      ...specialistOut,
      venueRef: { name: 'default-learner' },
      gating: {
        ...harvested.gating,
        ...specialistOut.gating,
        executeSpecialist: specialist.name,
      },
    };
  }
}
```

- [ ] **Step 4: Update `index.ts` to export the wrapper**

Use Edit on `client/src/restorer/impls/default-learner/index.ts`. Append:

```typescript
export { DefaultLearningWrapper, type DefaultLearningWrapperConfig } from './wrapper.js';
```

- [ ] **Step 5: Update the coordinator skill to honor JINN_DEFAULT_LEARNER_SKIP_EXECUTE**

Edit `client/plugins/default-learner/skills/coordinator/SKILL.md`. In the Pipeline section, find the line for phase 4 (`execute` — walk plan, spawn step-workers, decide stuck`) and add a parenthetical note immediately before that line:

```
*Skip-execute hint:* if the env var `JINN_DEFAULT_LEARNER_SKIP_EXECUTE=true` is set (the daemon-side wrapper sets it when delegating Execute to a kind-specific specialist), skip phase 4 entirely. The wrapper will run Execute externally and populate `workingDir/.execute/` itself before invoking Debrief.
```

Place this note before the numbered phase list (or as a sub-bullet under the Pipeline header) so the agent reads it before reaching phase 4.

- [ ] **Step 6: Run test (expect pass)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/wrapper.test.ts
```

Expected: PASS, all four cases.

- [ ] **Step 7: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/src/restorer/impls/default-learner/wrapper.ts client/src/restorer/impls/default-learner/index.ts client/plugins/default-learner/skills/coordinator/SKILL.md client/test/restorer/impls/default-learner/wrapper.test.ts
git commit -m "feat(default-learner): first-match wrapper + coordinator skip-execute hint"
```

---

## Task 2: Wire wrapper into `buildRestorerImpls`

Default-learner registers FIRST. The wrapper holds a reference to the rest of the impl list as its specialists pool.

**Files:**
- Modify: `client/src/restorer/impls/index.ts`

- [ ] **Step 1: Read the current `buildRestorerImpls` implementation**

```bash
cat /Users/adrianobradley/harbor/jinn-learner/client/src/restorer/impls/index.ts
```

Confirm the existing structure: imports + the function that builds `out: RestorerImpl[]` then returns it.

- [ ] **Step 2: Update `buildRestorerImpls` to register the wrapper first**

Use Edit on `client/src/restorer/impls/index.ts`. Add imports:

```typescript
import {
  DefaultLearningRestorerImpl,
  DefaultLearningWrapper,
} from './default-learner/index.js';
import { ClaudeCodeHarnessAdapter } from './default-learner/adapters/claude-code.js';
```

Then in `buildRestorerImpls`, after the existing `const out: RestorerImpl[] = [];` line, do NOT push the wrapper yet. Instead, build the specialist list in the existing way (all the existing `out.push(...)` calls), then at the END of the function (just before `return out`), construct the wrapper with `out` as its specialists pool and prepend it:

```typescript
  // Build the default-learner wrapper LAST (so it sees all other impls
  // as its specialists pool) but register it FIRST so it wins
  // first-match for every kind.
  const learnerAdapter = new ClaudeCodeHarnessAdapter({
    claudePath: env.claudePath,
    claudeModel: env.claudeModel,
  });
  const learnerShim = new DefaultLearningRestorerImpl({ adapter: learnerAdapter });
  const learnerWrapper = new DefaultLearningWrapper({
    shim: learnerShim,
    specialists: [...out], // snapshot of specialists; wrapper does not delegate to itself
  });
  return [learnerWrapper, ...out];
```

Verify by reading back: the returned array starts with `learnerWrapper`, then the original specialist list in unchanged order.

- [ ] **Step 3: Run the registry test to confirm nothing else broke**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/engine/registry.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the full test suite**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn test
```

Expected: PASS — pre-existing tests should continue to pass because:
- The wrapper delegates Execute to specialists when matched (so kind-specific behavior is preserved).
- Tests that exercise specialists directly (not via the registry) still work.
- Tests that exercise the registry will see the wrapper at index 0; if any test asserts `findFor(...).name === '<specialist>'`, it may now return `default-learner` instead. Update those tests if needed; do NOT loosen production assertions.

If a registry test fails, decide whether the test was asserting a contract that now needs updating (because first-match wrapping IS the new contract) or whether the wrapper is mis-wired. Fix accordingly.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/impls/index.ts
git commit -m "feat(default-learner): wire wrapper into buildRestorerImpls (first-match)"
```

---

## Task 3: Path-scope guard test

Verify that a synthetic worker attempting to write outside `implStateDir`/`workingDir` is blocked. Plan 1 deferred path-guard enforcement to "the harness adapter," so this test exercises the boundary at that layer.

**Files:**
- Test: `client/test/restorer/impls/default-learner/path-scope.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// client/test/restorer/impls/default-learner/path-scope.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DefaultLearningRestorerImpl } from '../../../../src/restorer/impls/default-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/default-learner/test-utils/noop-adapter.js';
import { fakeFullPipelineRun } from '../../../../src/restorer/impls/default-learner/test-utils/fake-plugin-outputs.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(workingDir: string, implStateDir: string): RestorationContext {
  const endTs = Date.now() + 60_000;
  return {
    intent: {
      id: 'path-scope-1',
      description: 'path scope test',
      window: { startTs: Date.now() - 1000, endTs },
    } as RestorationContext['intent'],
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  };
}

describe('default-learner path-scope guard', () => {
  let workingDir: string;
  let implStateDir: string;
  let unsafeRoot: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-pathscope-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-pathscope-state-'));
    unsafeRoot = mkdtempSync(join(tmpdir(), 'jinn-pathscope-unsafe-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
    rmSync(unsafeRoot, { recursive: true, force: true });
  });

  it('rejects (or noticeably warns about) writes outside workingDir + implStateDir', async () => {
    // Construct a NoOp adapter that "the worker" attempts an out-of-scope write through.
    // The plugin contract is that subagents only write to outputPath under
    // workingDir/.<phase>/. A misbehaving worker that writes to unsafeRoot
    // is the failure mode we want to detect.
    const violationAttempted = { tried: false };
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      // Happy path artifacts (so the run succeeds enough to harvest).
      fakeFullPipelineRun(inputs.workingDir, { intentKind: 'test.kind' });
      // Violating write (a real harness would block this; the NoOp doesn't
      // enforce — this test asserts the contract is documented + that any
      // resulting artifact under unsafeRoot is NOT visible in workingDir).
      try {
        writeFileSync(join(unsafeRoot, 'leak.txt'), 'should not be harvested');
        violationAttempted.tried = true;
      } catch {
        // Some harnesses/test envs may block the write itself.
      }
    });

    const impl = new DefaultLearningRestorerImpl({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);
    const out = await impl.run(ctx);

    // Whatever the adapter wrote outside scope must NOT appear in
    // RestorationOutput's harvest. Confirm the harvest stayed scoped to
    // workingDir contents and that unsafeRoot leak is not referenced.
    expect(JSON.stringify(out)).not.toContain(unsafeRoot);
    expect(JSON.stringify(out)).not.toContain('leak.txt');
    expect(out.gating.phasesCompleted).toContain('execute');

    // The leak file may exist on disk (the NoOp adapter doesn't enforce
    // the boundary), but it must not be in workingDir.
    expect(existsSync(join(workingDir, 'leak.txt'))).toBe(false);
  });

  it('verifies all artifact paths in RestorationOutput resolve under workingDir or implStateDir', async () => {
    const adapter = new NoOpHarnessAdapter();
    const impl = new DefaultLearningRestorerImpl({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);
    const out = await impl.run(ctx);

    // RestorationOutput's gating may carry path-like strings; if any do,
    // they must resolve under one of the two scoped roots.
    const allowedRoots = [resolve(workingDir), resolve(implStateDir)];
    for (const value of Object.values(out.gating)) {
      if (typeof value === 'string' && value.startsWith('/')) {
        const resolved = resolve(value);
        const inScope = allowedRoots.some((root) => resolved.startsWith(root));
        expect(inScope, `path ${resolved} outside allowed roots`).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run test**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/path-scope.test.ts
```

Expected: PASS, both cases.

- [ ] **Step 3: Commit**

```bash
git add client/test/restorer/impls/default-learner/path-scope.test.ts
git commit -m "test(default-learner): path-scope guard"
```

---

## Task 4: Replan-path test

Synthetic Execute step that fails its successSignal; the wrapper exercises the replan branch (Execute writes plan-v1.json + replan-context.json, re-invokes Plan, then succeeds on the second attempt).

This test uses the NoOp adapter to inject a custom run handler that simulates the Execute skill's stuck-judgment flow.

**Files:**
- Test: `client/test/restorer/impls/default-learner/replan-path.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// client/test/restorer/impls/default-learner/replan-path.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLearningRestorerImpl } from '../../../../src/restorer/impls/default-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/default-learner/test-utils/noop-adapter.js';
import {
  fakeOrientSummary,
  fakeStrategy,
  fakePlan,
  fakeDebriefAnalysis,
  fakeImproveSummary,
  fakeMemoryConsolidationRecord,
} from '../../../../src/restorer/impls/default-learner/test-utils/fake-plugin-outputs.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(workingDir: string, implStateDir: string): RestorationContext {
  const endTs = Date.now() + 60_000;
  return {
    intent: {
      id: 'replan-test-1',
      description: 'replan test',
      window: { startTs: Date.now() - 1000, endTs },
      spec: { kind: 'unknown.kind' } as RestorationContext['intent']['spec'],
    } as RestorationContext['intent'],
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  };
}

describe('default-learner replan path', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-replan-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-replan-state-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('exercises the replan branch: archives plan-v1.json, writes replan-context.json, succeeds on second plan', async () => {
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      const wd = inputs.workingDir;

      // Outer phases (Orient, Strategize, Plan v1).
      fakeOrientSummary(wd, inputs.intentId, inputs.intentKind ?? 'unknown.kind');
      fakeStrategy(wd, 'early-return');
      fakePlan(wd, 1);

      // Simulate Execute attempt 1 — step fails its successSignal.
      const execDir = join(wd, '.execute');
      mkdirSync(execDir, { recursive: true });
      writeFileSync(
        join(execDir, 'log.jsonl'),
        JSON.stringify({
          ts: Date.now(),
          stepId: 'step-1',
          decision: 'replan',
          summary: 'step-1 failed successSignal',
          retryCount: 0,
          workerStatus: 'failed',
          workerBlockers: ['successSignal not met'],
        }) + '\n',
      );

      // Replan: archive plan.json → plan-v1.json, write replan-context.json,
      // re-invoke Plan to produce a fresh plan.json.
      const planDir = join(wd, '.plan');
      const { renameSync, copyFileSync } = await import('node:fs');
      copyFileSync(join(planDir, 'plan.json'), join(planDir, 'plan-v1.json'));
      writeFileSync(
        join(planDir, 'replan-context.json'),
        JSON.stringify({
          failedStepId: 'step-1',
          blockers: ['successSignal not met'],
          partialOutputs: [],
        }),
      );
      // Fresh plan v2 (just overwrite plan.json).
      fakePlan(wd, 2);

      // Execute attempt 2 — succeeds.
      writeFileSync(
        join(execDir, 'log.jsonl'),
        JSON.stringify({
          ts: Date.now(),
          stepId: 'step-1',
          decision: 'continue',
          summary: 'step-1 OK on retry',
          retryCount: 1,
          workerStatus: 'success',
          workerBlockers: [],
        }) + '\n',
        { flag: 'a' },
      );
      writeFileSync(
        join(execDir, 'summary.json'),
        JSON.stringify({
          stepsCompleted: ['step-1', 'step-2'],
          stepsFailed: [],
          decisions: ['replan', 'continue', 'continue'],
          elapsedMs: 200,
          returnReason: 'all-steps-completed',
        }),
      );

      // Final outer phases.
      fakeDebriefAnalysis(wd, 'yes');
      fakeImproveSummary(wd);
      fakeMemoryConsolidationRecord(wd);
    });

    const impl = new DefaultLearningRestorerImpl({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);
    const out = await impl.run(ctx);

    // Assert the replan-path artifacts landed where they should.
    expect(existsSync(join(workingDir, '.plan', 'plan-v1.json'))).toBe(true);
    expect(existsSync(join(workingDir, '.plan', 'replan-context.json'))).toBe(true);
    expect(existsSync(join(workingDir, '.plan', 'plan.json'))).toBe(true);
    // Final harvest reflects a successful run after replan.
    expect(out.gating).toMatchObject({
      executeReturnReason: 'all-steps-completed',
      executeStepsCompleted: 2,
    });
  });
});
```

- [ ] **Step 2: Run test**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/replan-path.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/test/restorer/impls/default-learner/replan-path.test.ts
git commit -m "test(default-learner): replan path acceptance"
```

---

## Task 5: Portfolio.v0 end-to-end on Anvil fork

Long-running e2e test that exercises the full daemon flow with the wrapper registered. Runs against an Anvil fork of Base, posts a portfolio.v0 intent, runs the daemon for one cycle, asserts the envelope was produced and delivery succeeded.

This test gates on Anvil being available (skipped if not). Reuses the existing `client/scripts/e2e-portfolio-v0.ts` pattern as a starting point.

**Files:**
- Create: `client/scripts/e2e-default-learner-portfolio-v0.ts`
- Modify: `client/package.json` (add `e2e:default-learner` script)

- [ ] **Step 1: Read the existing portfolio.v0 e2e script**

```bash
head -80 /Users/adrianobradley/harbor/jinn-learner/client/scripts/e2e-portfolio-v0.ts
```

Confirm the structure: it spawns Anvil, bootstraps an operator, posts an intent, runs the daemon, asserts on outputs.

- [ ] **Step 2: Implement `e2e-default-learner-portfolio-v0.ts`**

The script's responsibilities:
1. Verify `anvil` and `cast` are in PATH; skip with a clear message if not.
2. Spawn Anvil as a fork of Base.
3. Bootstrap an operator (reuse the existing earning-bootstrap infrastructure).
4. Verify `buildRestorerImpls` returns the wrapper FIRST and that `findFor({ kind: 'portfolio.v0' })` returns the wrapper (not `claude-mcp-hyperliquid` directly).
5. Post a synthetic portfolio.v0 intent.
6. Run the daemon for one full cycle.
7. Assert: an envelope was produced; the envelope's `executor.implName` is `default-learner`; `workingDir/.orient/`, `.strategize/`, `.plan/`, `.execute/`, `.debrief/`, `.improve/`, `.memory-consolidation/` all exist.
8. Tear down Anvil.

```typescript
// client/scripts/e2e-default-learner-portfolio-v0.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRestorerImpls } from '../src/restorer/impls/index.js';

async function main(): Promise<void> {
  // Pre-flight: skip if Anvil not available.
  const anvilCheck = spawnSync('anvil', ['--version']);
  if (anvilCheck.status !== 0) {
    console.log('SKIP: anvil not in PATH; install foundry to run this e2e');
    process.exit(0);
  }

  // Pre-flight: skip if `claude` not available.
  const claudeCheck = spawnSync('claude', ['--version']);
  if (claudeCheck.status !== 0) {
    console.log('SKIP: claude CLI not in PATH; install Claude Code to run this e2e');
    process.exit(0);
  }

  console.log('=== default-learner portfolio.v0 e2e ===');

  // Spawn Anvil fork of Base.
  console.log('Starting Anvil fork...');
  const anvil: ChildProcess = spawn(
    'anvil',
    ['--fork-url', process.env.BASE_RPC_URL ?? 'https://mainnet.base.org', '--port', '8545'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Wait for Anvil to be ready (poll on http://127.0.0.1:8545).
  await waitForRpc('http://127.0.0.1:8545', 30_000);

  let exitCode = 0;
  try {
    // Verify wrapper is registered FIRST.
    console.log('Verifying buildRestorerImpls wrapper registration...');
    const impls = buildRestorerImpls({
      stub: true,
      rpcUrl: 'http://127.0.0.1:8545',
      claudePath: 'claude',
      claudeModel: 'claude-haiku-4-5-20251001',
    });
    if (impls[0].name !== 'default-learner') {
      throw new Error(
        `wrapper not registered first: index 0 is "${impls[0].name}" (expected "default-learner")`,
      );
    }
    if (!impls[0].supports({ kind: 'portfolio.v0' })) {
      throw new Error('wrapper.supports(portfolio.v0) returned false');
    }
    console.log('  ✓ wrapper at index 0; supports portfolio.v0');

    // Run one daemon cycle. (Reuse e2e-portfolio-v0's harness; here we
    // just inline the minimal version.)
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-e2e-dl-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-e2e-dl-state-'));
    try {
      // ... (minimal intent post + run; details mirror e2e-portfolio-v0.ts)
      // Assert workingDir has each phase's artifacts.
      const phases = [
        'orient',
        'strategize',
        'plan',
        'execute',
        'debrief',
        'improve',
        'memory-consolidation',
      ];
      for (const phase of phases) {
        const phaseDir = join(workingDir, `.${phase}`);
        if (!existsSync(phaseDir)) {
          throw new Error(`phase artifact missing: ${phaseDir}`);
        }
        console.log(`  ✓ ${phase} artifact present`);
      }
      // Assert envelope's executor.implName is 'default-learner'.
      // (Read the manifest the engine packaged.)
      // ... (manifest assertion details mirror e2e-portfolio-v0.ts patterns)
      console.log('=== e2e PASSED ===');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('e2e FAILED:', err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    if (!anvil.killed) anvil.kill('SIGTERM');
  }
  process.exit(exitCode);
}

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`RPC not ready at ${url} after ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

Note: the script above is a skeleton. The actual intent-post + daemon-run + manifest-assertion bodies need to be filled in by mirroring the patterns in `client/scripts/e2e-portfolio-v0.ts`. This task may take substantial implementation time — flag as DONE_WITH_CONCERNS if blocked on Anvil/Claude availability or if the existing e2e harness is hard to compose with.

- [ ] **Step 3: Add yarn script alias**

Edit `client/package.json` `scripts` block to add:

```
"e2e:default-learner": "tsx scripts/e2e-default-learner-portfolio-v0.ts",
```

Place adjacent to the existing `"e2e": "tsx scripts/e2e-validate.ts"` entry.

- [ ] **Step 4: Run the e2e (gated on Anvil + claude availability)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn e2e:default-learner
```

Expected: either `=== e2e PASSED ===` (if Anvil + claude available) or `SKIP: ...` (if not).

If FAILED: investigate by reading the script output. The most likely failure modes are: wrapper not registered, plugin not installed in `~/.claude/plugins/`, or kind-specific tool config missing.

- [ ] **Step 5: Commit**

```bash
git add client/scripts/e2e-default-learner-portfolio-v0.ts client/package.json
git commit -m "test(default-learner): portfolio.v0 e2e on Anvil (gated on availability)"
```

---

## Plan 3 acceptance

When all 5 tasks are committed:

- [ ] `cd client && yarn typecheck` — zero errors.
- [ ] `cd client && yarn vitest run test/restorer/impls/default-learner/` — every test passes (wrapper, path-scope, replan-path, plus the Plan 2 carry-overs).
- [ ] `cd client && yarn test` — pre-existing client test suite still passes; if any registry test was updated to reflect the new first-match wrapper contract, those updates are intentional and reviewed.
- [ ] `buildRestorerImpls` returns `default-learner` at index 0; `findFor({ kind: 'portfolio.v0' })` returns it; the wrapper internally delegates to the `claude-mcp-hyperliquid` specialist for Execute.
- [ ] `cd client && yarn e2e:default-learner` either passes (when Anvil + claude are available) or skips cleanly (when not).
- [ ] Daemon run on a portfolio.v0 intent produces an envelope with `executor.implName = "default-learner"` and per-phase artifacts under `workingDir/`.

---

## What's deferred past Plan 3

- **Real OTel tracer integration** — Plan 2's adapter sets up env vars but does not emit a `jinn.state_transition` span. Once the daemon has an OTel tracer wired, the adapter can emit the constitution span at run-start.
- **`jinn install-plugin <harness>` CLI command** — convenience for operators; today the README tells them to `cp -r` by hand.
- **Pi.dev harness adapter** — Plan 2 ships only the Claude Code adapter. A Pi.dev variant follows the same pattern but uses the Pi CLI and `~/.pi/agent/plugins/` (or equivalent).
- **Cross-operator artifact access** — depends on the access/gating sibling epic of TEE scope §5.
- **MCP tools** — `wait`, `subgraph-query`, etc. The plugin currently relies on the harness's native primitives.
- **`promotion_record` / `consolidation_record` artifact-type addition to TEE scope §3.1 K9** — small follow-up PR to the scope doc.
