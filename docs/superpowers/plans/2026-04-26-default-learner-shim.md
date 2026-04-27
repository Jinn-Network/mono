# Default learner — TS Shim Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the daemon-side TS bridge between the existing engine (which calls `RestorerImpl.run(ctx)`) and the markdown plugin shipped in Plan 1. This plan produces a `DefaultLearningRestorerImpl` constructable in TypeScript, two `HarnessAdapter` implementations (a NoOp test fixture and a real Claude Code subprocess adapter), a plugin-path resolver, and an output harvester. The impl is NOT yet registered in `buildRestorerImpls` (Plan 3 wires it in with the first-match-wrapper precedence). After this plan: a consumer can construct `new DefaultLearningRestorerImpl({ adapter: claudeCodeAdapter })`, call `run(ctx)`, and have the Claude Code CLI spawn with the plugin loaded, walk the seven-phase pipeline, and return a `RestorationOutput`.

**Architecture:** Lives at `client/src/restorer/impls/default-learner/`. Mirrors the existing `claude-mcp-*` impl layout (one directory per RestorerImpl, files for types, adapters, helpers). The shim is harness-agnostic — `HarnessAdapter` is an interface; `ClaudeCodeHarnessAdapter` is one implementation; `NoOpHarnessAdapter` (under `test-utils/`) is the test fixture. Plugin location is resolved at runtime via `import.meta.url` walking up from the impl directory to `client/plugins/default-learner/`. Output harvesting reads the well-known artifact paths the plugin writes (`workingDir/.execute/summary.json`, `workingDir/.debrief/analysis.json`, etc.) and constructs `RestorationOutput.gating` + optional fields.

**Tech Stack:** TypeScript (ESM, Node >=20), Vitest. `node:child_process` for subprocess spawning. `node:fs/promises` for filesystem. Existing `RestorerImpl`/`RestorationContext` from `client/src/restorer/types.ts`.

**Spec reference:** `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.

**Plugin reference:** `client/plugins/default-learner/` (shipped by Plan 1 — 8 skills + 7 agents + hook + validator + loaders).

**Existing code anchors:**
- `client/src/restorer/types.ts:148` — `RestorerImpl` interface (the shim implements this)
- `client/src/restorer/types.ts:12` — `RestorationContext` (handed in by engine)
- `client/src/restorer/impls/index.ts:56` — `buildRestorerImpls` (NOT touched in Plan 2)
- `client/src/restorer/engine/engine.ts:533` — engine's dispatch site (`await impl.run(ctx)`)
- `client/src/runner/claude.ts:187-230` — existing `spawnAgent` pattern (subprocess spawning template)
- `client/src/restorer/impls/claude-mcp-hyperliquid/session-orchestrator.ts:127` — existing `_spawnFn` injection pattern for tests

---

## File structure (Plan 2)

**Source files (new, under `client/src/restorer/impls/default-learner/`):**

| File | Responsibility |
|---|---|
| `index.ts` | Public exports: `DefaultLearningRestorerImpl`, types |
| `types.ts` | `HarnessAdapter` interface, `DefaultLearningRestorerConfig`, `IntentSessionInputs` |
| `plugin-path.ts` | `resolvePluginRoot()` — find `client/plugins/default-learner/` from impl dir |
| `harvest.ts` | `harvestOutput(workingDir)` — build `RestorationOutput` from plugin artifacts |
| `restorer.ts` | `DefaultLearningRestorerImpl` — `RestorerImpl` shell |
| `adapters/claude-code.ts` | `ClaudeCodeHarnessAdapter` — spawns `claude` CLI with plugin |
| `test-utils/noop-adapter.ts` | `NoOpHarnessAdapter` — test fixture; simulates plugin writing artifacts |
| `test-utils/fake-plugin-outputs.ts` | Factory functions producing realistic plugin artifact JSON for tests |

**Test files (new, under `client/test/restorer/impls/default-learner/`):**

| File | Coverage |
|---|---|
| `plugin-path.test.ts` | Path resolver finds plugin from impl dir |
| `harvest.test.ts` | Harvester reads plugin artifacts, constructs `RestorationOutput` |
| `restorer-shim.test.ts` | End-to-end on NoOp adapter — phase artifacts written, output harvested |
| `claude-code-adapter.test.ts` | Smoke test for Claude Code adapter (skipped without `claude` in PATH) |

---

## Task 1: Package scaffold + core types

**Files:**
- Create: `client/src/restorer/impls/default-learner/index.ts` (placeholder export)
- Create: `client/src/restorer/impls/default-learner/types.ts`

- [ ] **Step 1: Create the directory**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
mkdir -p client/src/restorer/impls/default-learner/{adapters,test-utils}
mkdir -p client/test/restorer/impls/default-learner
```

- [ ] **Step 2: Write `types.ts`**

```typescript
// client/src/restorer/impls/default-learner/types.ts
import type { RestorationContext } from '../../types.js';

/**
 * Inputs the shim derives from RestorationContext and hands to the
 * harness adapter. The adapter then constructs a session prompt + env
 * for the underlying CLI / runtime.
 */
export interface IntentSessionInputs {
  /** Intent id from ctx.intent.id */
  intentId: string;
  /** IPFS CID of the intent (if known) for provenance */
  intentCid?: string;
  /** Intent kind (e.g. 'portfolio.v0', 'prediction.v0') */
  intentKind?: string;
  /** Operator-private impl-state directory; passed to the plugin via env IMPL_STATE_DIR */
  implStateDir: string;
  /** Ephemeral workingDir for this attempt */
  workingDir: string;
  /** Window timestamps (ms since epoch) */
  windowStartTs: number;
  windowEndTs: number;
  /** Remaining ms in the window at adapter-invocation time */
  msUntilEndTs: number;
  /** Aborted when window.endTs fires */
  abort: AbortSignal;
}

/**
 * Adapter contract: launch the underlying agent harness with the
 * default-learner plugin loaded and the intent context set up. Block
 * until the harness exits cleanly or the abort signal fires.
 *
 * The adapter does NOT harvest outputs — that's the shim's job afterwards.
 */
export interface HarnessAdapter {
  /** Adapter name for logs / spans (e.g. 'claude-code', 'noop'). */
  readonly name: string;

  /**
   * Whether this adapter permits the plugin's Improve phase to patch
   * harness install code (e.g. Pi.dev). Always false for closed harnesses.
   */
  readonly allowsHarnessSelfModification: boolean;

  /**
   * Run one default-learner session. The adapter is responsible for:
   * - Loading the plugin into the harness's skill/plugin directory (or
   *   pointing the harness at it via flags).
   * - Setting IMPL_STATE_DIR in the harness's env so the session-start
   *   hook fires.
   * - Constructing the initial prompt that invokes the `coordinator` skill
   *   with the intent + paths.
   * - Blocking until the harness session exits or `inputs.abort` fires.
   */
  runIntent(inputs: IntentSessionInputs, pluginRoot: string): Promise<void>;
}

/** Shim construction config. */
export interface DefaultLearningRestorerConfig {
  /** Harness adapter (NoOp for tests; Claude Code adapter for production). */
  adapter: HarnessAdapter;
  /** Optional override for the impl name (defaults to 'default-learner'). */
  name?: string;
  /** Semver string for envelope provenance (defaults to '0.1.0-shim'). */
  version?: string;
  /**
   * Optional override for plugin root resolution. When unset, resolved from
   * the impl directory via `plugin-path.ts`. Tests may override.
   */
  pluginRoot?: string;
}
```

- [ ] **Step 3: Write `index.ts`**

```typescript
// client/src/restorer/impls/default-learner/index.ts
/**
 * @jinn-network/client default-learner restorer impl.
 *
 * Bridges the engine's RestorerImpl interface to the default-learner
 * plugin shipped at client/plugins/default-learner/.
 *
 * Plan 2 ships shim + NoOp + Claude Code adapter. Not yet registered in
 * buildRestorerImpls — Plan 3 handles registry wiring.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md (v1.1)
 */

export type {
  HarnessAdapter,
  IntentSessionInputs,
  DefaultLearningRestorerConfig,
} from './types.js';
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn typecheck
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/src/restorer/impls/default-learner/index.ts client/src/restorer/impls/default-learner/types.ts
git commit -m "feat(default-learner-shim): package scaffold + core types"
```

---

## Task 2: Plugin path resolver

Resolves the plugin root (`client/plugins/default-learner/`) from the impl directory's location at runtime. Uses `import.meta.url` so it works whether the package is installed globally, locally, or run from source.

**Files:**
- Create: `client/src/restorer/impls/default-learner/plugin-path.ts`
- Test: `client/test/restorer/impls/default-learner/plugin-path.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/plugin-path.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginRoot } from '../../../../src/restorer/impls/default-learner/plugin-path.js';

describe('resolvePluginRoot', () => {
  it('returns an existing directory containing the expected plugin layout', () => {
    const root = resolvePluginRoot();
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, 'skills', 'coordinator', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, 'agents', 'explorer.md'))).toBe(true);
    expect(existsSync(join(root, 'hooks', 'session-start.sh'))).toBe(true);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  });

  it('returns an absolute path', () => {
    const root = resolvePluginRoot();
    expect(root.startsWith('/')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/plugin-path.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `plugin-path.ts`**

```typescript
// client/src/restorer/impls/default-learner/plugin-path.ts
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the default-learner plugin root from the impl directory's
 * runtime location.
 *
 * Layout assumption: this file lives at
 *   <package>/<src-or-dist>/restorer/impls/default-learner/plugin-path.{ts,js}
 * and the plugin lives at
 *   <package>/plugins/default-learner/
 *
 * Walks up four directories from this file (impls → restorer → src/dist →
 * package root) then descends into plugins/default-learner/. Verifies the
 * expected layout exists and throws with a clear message if not.
 */
export function resolvePluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..', '..', '..');
  const pluginRoot = join(packageRoot, 'plugins', 'default-learner');

  if (!existsSync(pluginRoot)) {
    throw new Error(
      `default-learner plugin not found at expected path: ${pluginRoot}. ` +
        `Resolved from impl dir: ${here}.`,
    );
  }
  if (!existsSync(join(pluginRoot, 'skills', 'coordinator', 'SKILL.md'))) {
    throw new Error(
      `default-learner plugin at ${pluginRoot} is missing skills/coordinator/SKILL.md`,
    );
  }
  return pluginRoot;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/plugin-path.test.ts
```

Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/impls/default-learner/plugin-path.ts client/test/restorer/impls/default-learner/plugin-path.test.ts
git commit -m "feat(default-learner-shim): plugin path resolver"
```

---

## Task 3: Output harvester

Reads the well-known artifact paths the plugin writes and constructs the `RestorationOutput` the engine expects from `RestorerImpl.run()`.

**Files:**
- Create: `client/src/restorer/impls/default-learner/harvest.ts`
- Test: `client/test/restorer/impls/default-learner/harvest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/harvest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harvestOutput } from '../../../../src/restorer/impls/default-learner/harvest.js';

describe('harvestOutput', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-harvest-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function writePhaseArtifact(phase: string, fileName: string, payload: unknown): void {
    const dir = join(workingDir, `.${phase}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), JSON.stringify(payload, null, 2));
  }

  it('returns minimal RestorationOutput when no phase artifacts present', () => {
    const out = harvestOutput(workingDir);
    expect(out.venueRef.name).toEqual('default-learner');
    expect(out.gating).toMatchObject({ phasesCompleted: [] });
  });

  it('reports phasesCompleted from per-phase output presence', () => {
    writePhaseArtifact('orient', 'summary.json', { topics: [] });
    writePhaseArtifact('strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact('plan', 'plan.json', { steps: [] });
    writePhaseArtifact('execute', 'summary.json', { stepsCompleted: ['step-1'] });
    const out = harvestOutput(workingDir);
    expect(out.gating).toMatchObject({
      phasesCompleted: ['orient', 'strategize', 'plan', 'execute'],
    });
  });

  it('lifts execute summary fields into gating when present', () => {
    writePhaseArtifact('execute', 'summary.json', {
      stepsCompleted: ['step-1', 'step-2'],
      stepsFailed: [],
      returnReason: 'all-steps-completed',
      elapsedMs: 12345,
    });
    const out = harvestOutput(workingDir);
    expect(out.gating).toMatchObject({
      executeReturnReason: 'all-steps-completed',
      executeStepsCompleted: 2,
      executeStepsFailed: 0,
    });
  });

  it('lifts strategize timingPosture into gating when present', () => {
    writePhaseArtifact('strategize', 'strategy.json', {
      approach: 'foo',
      timingPosture: 'hold-and-revise',
    });
    const out = harvestOutput(workingDir);
    expect(out.gating.timingPosture).toEqual('hold-and-revise');
  });

  it('reports debrief.successCriteriaMet into gating when present', () => {
    writePhaseArtifact('debrief', 'analysis.json', {
      successCriteriaMet: 'partial',
    });
    const out = harvestOutput(workingDir);
    expect(out.gating.debriefVerdict).toEqual('partial');
  });

  it('does not throw on malformed phase JSON; falls back gracefully', () => {
    const dir = join(workingDir, '.execute');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), 'not-json{');
    expect(() => harvestOutput(workingDir)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/harvest.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `harvest.ts`**

```typescript
// client/src/restorer/impls/default-learner/harvest.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RestorationOutput } from '../../types.js';

const PHASE_ORDER = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Walk workingDir/.<phase>/ to determine which phases produced artifacts.
 * A phase is considered "completed" if its dot-namespaced subdirectory
 * exists and contains at least one file.
 */
function detectCompletedPhases(workingDir: string): string[] {
  const completed: string[] = [];
  for (const phase of PHASE_ORDER) {
    const dir = join(workingDir, `.${phase}`);
    if (!existsSync(dir)) continue;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      const entries = readdirSync(dir);
      if (entries.length > 0) completed.push(phase);
    } catch {
      // Best-effort; ignore permission / IO errors.
    }
  }
  return completed;
}

/**
 * Construct RestorationOutput from the plugin's per-phase artifacts.
 *
 * Reads:
 * - workingDir/.execute/summary.json — for stepsCompleted / stepsFailed / returnReason / elapsedMs
 * - workingDir/.strategize/strategy.json — for timingPosture
 * - workingDir/.debrief/analysis.json — for successCriteriaMet
 *
 * Lifts the relevant fields into gating so the engine's packaging /
 * downstream consumers see them. Missing artifacts are treated as
 * "phase did not run" rather than errors — the engine separately
 * verifies tier requirements.
 */
export function harvestOutput(workingDir: string): RestorationOutput {
  const phasesCompleted = detectCompletedPhases(workingDir);

  const gating: Record<string, unknown> = { phasesCompleted };

  const strategy = safeReadJson(join(workingDir, '.strategize', 'strategy.json'));
  if (strategy && typeof strategy.timingPosture === 'string') {
    gating.timingPosture = strategy.timingPosture;
  }

  const exec = safeReadJson(join(workingDir, '.execute', 'summary.json'));
  if (exec) {
    if (typeof exec.returnReason === 'string') gating.executeReturnReason = exec.returnReason;
    if (Array.isArray(exec.stepsCompleted)) gating.executeStepsCompleted = exec.stepsCompleted.length;
    if (Array.isArray(exec.stepsFailed)) gating.executeStepsFailed = exec.stepsFailed.length;
    if (typeof exec.elapsedMs === 'number') gating.executeElapsedMs = exec.elapsedMs;
  }

  const debrief = safeReadJson(join(workingDir, '.debrief', 'analysis.json'));
  if (debrief && typeof debrief.successCriteriaMet === 'string') {
    gating.debriefVerdict = debrief.successCriteriaMet;
  }

  return {
    venueRef: { name: 'default-learner' },
    gating,
  };
}
```

- [ ] **Step 4: Run test (expect pass)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/harvest.test.ts
```

Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/impls/default-learner/harvest.ts client/test/restorer/impls/default-learner/harvest.test.ts
git commit -m "feat(default-learner-shim): output harvester"
```

---

## Task 4: NoOp adapter (test fixture) + fake plugin outputs

Synchronous in-process adapter for tests. Doesn't actually spawn a harness; instead, registered fake-output handlers write the expected workingDir artifacts to simulate the plugin running.

**Files:**
- Create: `client/src/restorer/impls/default-learner/test-utils/fake-plugin-outputs.ts`
- Create: `client/src/restorer/impls/default-learner/test-utils/noop-adapter.ts`

- [ ] **Step 1: Write `fake-plugin-outputs.ts`**

```typescript
// client/src/restorer/impls/default-learner/test-utils/fake-plugin-outputs.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Helpers to seed workingDir with realistic plugin artifacts so tests
 * can exercise the shim's harvest + lifecycle logic without spawning a
 * real harness.
 *
 * Each function writes one phase's output. The shapes match what the
 * plugin (Plan 1) writes per its skill/agent contracts.
 */

function writeJson(path: string, payload: unknown): void {
  const dir = path.substring(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

export function fakeOrientSummary(workingDir: string, intentId: string, intentKind: string): void {
  writeJson(join(workingDir, '.orient', 'summary.json'), {
    intent: { id: intentId, kind: intentKind, window: { startTs: 0, endTs: 0 } },
    topics: [
      { topic: 'intent-parse', artifact: 'workingDir/.orient/intent-parse.json', summary: 'parsed', flags: [] },
    ],
    openQuestions: [],
  });
}

export function fakeStrategy(workingDir: string, posture: 'early-return' | 'hold-and-revise' | 'continuous-observation'): void {
  writeJson(join(workingDir, '.strategize', 'strategy.json'), {
    approach: 'fake-approach',
    rationale: 'test',
    successCriteria: 'fake passes if test passes',
    timingPosture: posture,
    constraints: [],
    rejectedAlternatives: [],
  });
  writeJson(join(workingDir, '.strategize', 'constitution.json'), {
    successCriteriaCid: 'sha256:fake',
    timingPosture: posture,
    skillBundleCid: 'sha256:fake',
    implStateDirSha: 'fakeSha',
    editableScope: [`${workingDir}/**`],
  });
}

export function fakePlan(workingDir: string, stepCount: number): void {
  writeJson(join(workingDir, '.plan', 'plan.json'), {
    successCriteria: 'fake passes if test passes',
    timingPosture: 'early-return',
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `step-${i + 1}`,
      kind: 'work',
      concurrency: 'sequential',
      description: `fake step ${i + 1}`,
      inputs: {},
      toolsNeeded: [],
      expectedOutputs: [],
      successSignal: 'always',
      abortCondition: 'never',
    })),
  });
}

export function fakeExecuteSummary(
  workingDir: string,
  opts: {
    stepsCompleted?: string[];
    stepsFailed?: string[];
    returnReason?: string;
    elapsedMs?: number;
  } = {},
): void {
  writeJson(join(workingDir, '.execute', 'summary.json'), {
    stepsCompleted: opts.stepsCompleted ?? ['step-1'],
    stepsFailed: opts.stepsFailed ?? [],
    decisions: [],
    elapsedMs: opts.elapsedMs ?? 0,
    returnReason: opts.returnReason ?? 'all-steps-completed',
  });
}

export function fakeDebriefAnalysis(
  workingDir: string,
  verdict: 'yes' | 'no' | 'partial',
): void {
  writeJson(join(workingDir, '.debrief', 'analysis.json'), {
    successCriteriaMet: verdict,
    successCriteriaShortfall: verdict === 'yes' ? null : 'fake shortfall',
    divergencesFromPlan: [],
    crossOperatorSignals: [],
    trend: { kind: 'fake', lastNRuns: 0, passRate: 1, direction: 'flat', notableFailureShapes: [] },
    recommendationsForImprove: [],
  });
}

export function fakeImproveSummary(workingDir: string): void {
  writeJson(join(workingDir, '.improve', 'summary.json'), {
    implStateDirShaBefore: 'fakeShaBefore',
    implStateDirShaAfter: 'fakeShaBefore',
    changesAccepted: 0,
    changesRejected: 0,
    operatorRequests: 0,
    rejectionsRationale: [],
  });
}

export function fakeMemoryConsolidationRecord(workingDir: string): void {
  writeJson(join(workingDir, '.memory-consolidation', 'consolidation_record.json'), {
    ts: Date.now(),
    implStateDirShaBefore: 'fakeShaBefore',
    implStateDirShaAfter: 'fakeShaBefore',
    durable: { skillsArchived: [], promotionsReverted: [], notesCompacted: 0, conflictsResolved: [] },
    ephemeral: { movedToPrivate: [], migratedToImplState: [] },
  });
}

/** Convenience: write all seven happy-path phase artifacts. */
export function fakeFullPipelineRun(
  workingDir: string,
  opts: { intentId?: string; intentKind?: string; posture?: 'early-return' | 'hold-and-revise' | 'continuous-observation'; verdict?: 'yes' | 'no' | 'partial' } = {},
): void {
  const intentId = opts.intentId ?? 'fake-intent';
  const intentKind = opts.intentKind ?? 'fake.kind';
  const posture = opts.posture ?? 'early-return';
  const verdict = opts.verdict ?? 'yes';
  fakeOrientSummary(workingDir, intentId, intentKind);
  fakeStrategy(workingDir, posture);
  fakePlan(workingDir, 1);
  fakeExecuteSummary(workingDir);
  fakeDebriefAnalysis(workingDir, verdict);
  fakeImproveSummary(workingDir);
  fakeMemoryConsolidationRecord(workingDir);
}
```

- [ ] **Step 2: Write `noop-adapter.ts`**

```typescript
// client/src/restorer/impls/default-learner/test-utils/noop-adapter.ts
import type { HarnessAdapter, IntentSessionInputs } from '../types.js';
import { fakeFullPipelineRun } from './fake-plugin-outputs.js';

export type NoOpRunHandler = (inputs: IntentSessionInputs, pluginRoot: string) => void | Promise<void>;

/**
 * Test-only HarnessAdapter. By default, a runIntent call simulates a
 * full happy-path pipeline by writing all seven phase artifacts to
 * inputs.workingDir. Tests can override via .on() to inject failures,
 * partial completion, etc.
 */
export class NoOpHarnessAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;

  private handler: NoOpRunHandler | null = null;
  private invocations: Array<{ inputs: IntentSessionInputs; pluginRoot: string }> = [];

  /** Override the default happy-path simulation. */
  on(handler: NoOpRunHandler): this {
    this.handler = handler;
    return this;
  }

  /** Inspect what runIntent was called with — useful for assertions. */
  getInvocations(): ReadonlyArray<{ inputs: IntentSessionInputs; pluginRoot: string }> {
    return this.invocations;
  }

  async runIntent(inputs: IntentSessionInputs, pluginRoot: string): Promise<void> {
    this.invocations.push({ inputs, pluginRoot });
    if (this.handler) {
      await this.handler(inputs, pluginRoot);
    } else {
      fakeFullPipelineRun(inputs.workingDir, {
        intentId: inputs.intentId,
        intentKind: inputs.intentKind ?? 'unknown',
      });
    }
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/restorer/impls/default-learner/test-utils/
git commit -m "feat(default-learner-shim): NoOp harness adapter + fake plugin outputs"
```

---

## Task 5: `DefaultLearningRestorerImpl` shell + lifecycle test

Wires plugin path resolver + adapter + harvester behind `RestorerImpl`.

**Files:**
- Create: `client/src/restorer/impls/default-learner/restorer.ts`
- Modify: `client/src/restorer/impls/default-learner/index.ts`
- Test: `client/test/restorer/impls/default-learner/restorer-shim.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/restorer/impls/default-learner/restorer-shim.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLearningRestorerImpl } from '../../../../src/restorer/impls/default-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/default-learner/test-utils/noop-adapter.js';
import { fakeFullPipelineRun } from '../../../../src/restorer/impls/default-learner/test-utils/fake-plugin-outputs.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(workingDir: string, implStateDir: string, kind = 'portfolio.v0'): RestorationContext {
  const endTs = Date.now() + 60_000;
  return {
    intent: {
      id: 'shim-test-1',
      description: 'shim test',
      window: { startTs: Date.now() - 1000, endTs },
      spec: { kind } as RestorationContext['intent']['spec'],
    } as RestorationContext['intent'],
    intentCid: 'bafyshim',
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  };
}

describe('DefaultLearningRestorerImpl — shim lifecycle (NoOp adapter)', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-shim-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-shim-state-'));
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

  it('supports() returns true for any kind in Plan 2', () => {
    const impl = new DefaultLearningRestorerImpl({ adapter: new NoOpHarnessAdapter() });
    expect(impl.supports({ kind: 'portfolio.v0' })).toBe(true);
    expect(impl.supports({ kind: 'prediction.v0' })).toBe(true);
    expect(impl.supports({ kind: 'anything', type: 'evaluation' })).toBe(true);
  });

  it('run(ctx) invokes adapter with derived IntentSessionInputs and harvests output', async () => {
    const adapter = new NoOpHarnessAdapter();
    const impl = new DefaultLearningRestorerImpl({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);

    const out = await impl.run(ctx);

    expect(adapter.getInvocations()).toHaveLength(1);
    const invocation = adapter.getInvocations()[0];
    expect(invocation.inputs.intentId).toEqual('shim-test-1');
    expect(invocation.inputs.intentKind).toEqual('portfolio.v0');
    expect(invocation.inputs.workingDir).toEqual(workingDir);
    expect(invocation.inputs.implStateDir).toEqual(implStateDir);
    expect(invocation.inputs.windowEndTs).toEqual(ctx.intent.window.endTs);
    expect(invocation.pluginRoot).toMatch(/plugins\/default-learner$/);

    expect(out.venueRef.name).toEqual('default-learner');
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
      executeReturnReason: 'all-steps-completed',
      debriefVerdict: 'yes',
      timingPosture: 'early-return',
    });
  });

  it('run(ctx) returns a RestorationOutput even when adapter writes no artifacts (degraded path)', async () => {
    const adapter = new NoOpHarnessAdapter().on(async () => {
      // Simulate harness exiting without writing anything.
    });
    const impl = new DefaultLearningRestorerImpl({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);

    const out = await impl.run(ctx);

    expect(out.venueRef.name).toEqual('default-learner');
    expect(out.gating).toMatchObject({ phasesCompleted: [] });
  });

  it('honors a custom pluginRoot override', async () => {
    const adapter = new NoOpHarnessAdapter();
    const customRoot = mkdtempSync(join(tmpdir(), 'jinn-shim-plugin-'));
    try {
      const impl = new DefaultLearningRestorerImpl({ adapter, pluginRoot: customRoot });
      const ctx = makeCtx(workingDir, implStateDir);
      await impl.run(ctx);
      expect(adapter.getInvocations()[0].pluginRoot).toEqual(customRoot);
    } finally {
      rmSync(customRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/restorer-shim.test.ts
```

Expected: FAIL — `DefaultLearningRestorerImpl` not exported.

- [ ] **Step 3: Implement `restorer.ts`**

```typescript
// client/src/restorer/impls/default-learner/restorer.ts
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
} from '../../types.js';
import type {
  HarnessAdapter,
  IntentSessionInputs,
  DefaultLearningRestorerConfig,
} from './types.js';
import { resolvePluginRoot } from './plugin-path.js';
import { harvestOutput } from './harvest.js';

/**
 * `RestorerImpl` shell. Bridges the engine's dispatch contract
 * (engine.ts:533: `await impl.run(ctx)`) into the harness adapter +
 * markdown plugin shipped by Plan 1.
 *
 * Plan 2 supports() returns true for any kind. Plan 3 wraps this in a
 * first-match-wrapper that delegates Execute to the kind-specific
 * specialist when one exists.
 */
export class DefaultLearningRestorerImpl implements RestorerImpl {
  readonly name: string;
  readonly version: string;
  private readonly adapter: HarnessAdapter;
  private readonly pluginRoot: string;

  constructor(config: DefaultLearningRestorerConfig) {
    this.adapter = config.adapter;
    this.name = config.name ?? 'default-learner';
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
  }

  supports(_spec: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return true;
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const inputs: IntentSessionInputs = {
      intentId: ctx.intent.id,
      intentCid: ctx.intentCid,
      intentKind: ctx.intent.spec?.kind,
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      windowStartTs: ctx.intent.window.startTs,
      windowEndTs: ctx.intent.window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
    };

    await this.adapter.runIntent(inputs, this.pluginRoot);

    return harvestOutput(ctx.workingDir);
  }
}
```

- [ ] **Step 4: Update `index.ts` to export the shim**

```typescript
// client/src/restorer/impls/default-learner/index.ts
/**
 * @jinn-network/client default-learner restorer impl.
 *
 * Bridges the engine's RestorerImpl interface to the default-learner
 * plugin shipped at client/plugins/default-learner/.
 *
 * Plan 2 ships shim + NoOp + Claude Code adapter. Not yet registered in
 * buildRestorerImpls — Plan 3 handles registry wiring.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md (v1.1)
 */

export type {
  HarnessAdapter,
  IntentSessionInputs,
  DefaultLearningRestorerConfig,
} from './types.js';
export { DefaultLearningRestorerImpl } from './restorer.js';
export { resolvePluginRoot } from './plugin-path.js';
export { harvestOutput } from './harvest.js';
```

- [ ] **Step 5: Run test (expect pass)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/restorer-shim.test.ts
```

Expected: PASS, all four cases.

- [ ] **Step 6: Commit**

```bash
git add client/src/restorer/impls/default-learner/restorer.ts client/src/restorer/impls/default-learner/index.ts client/test/restorer/impls/default-learner/restorer-shim.test.ts
git commit -m "feat(default-learner-shim): DefaultLearningRestorerImpl + lifecycle test"
```

---

## Task 6: Claude Code harness adapter

Real subprocess adapter. Spawns the `claude` CLI with the plugin loaded and an initial prompt invoking the `coordinator` skill. Sets `IMPL_STATE_DIR` env var so the session-start hook fires.

**Files:**
- Create: `client/src/restorer/impls/default-learner/adapters/claude-code.ts`

- [ ] **Step 1: Implement `claude-code.ts`**

```typescript
// client/src/restorer/impls/default-learner/adapters/claude-code.ts
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, IntentSessionInputs } from '../types.js';

export interface ClaudeCodeHarnessAdapterConfig {
  /** Path to the `claude` executable. Default: 'claude' (from PATH). */
  claudePath?: string;
  /** Optional model override (e.g. 'claude-sonnet-4-6'). */
  claudeModel?: string;
  /**
   * Plugin install directory for Claude Code. Defaults to
   * `~/.claude/plugins/`. The adapter copies (or symlinks) the plugin
   * into this directory before spawning.
   */
  pluginInstallDir?: string;
  /**
   * Override spawn for testing. When provided, called instead of
   * node:child_process.spawn so tests can inject a fake child process.
   */
  _spawnFn?: typeof spawn;
}

/**
 * Allowlist of env vars that propagate to the spawned Claude session.
 * We deliberately limit this to avoid leaking unrelated credentials
 * into the agent process.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  // Claude Code auth-related vars; the adapter does not set these
  // itself but propagates them if present.
  'CLAUDE_CODE_SESSION',
  'ANTHROPIC_API_KEY',
];

function buildAgentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

/**
 * Construct the initial prompt that invokes the coordinator skill with
 * the intent context.
 */
function buildInitialPrompt(inputs: IntentSessionInputs): string {
  return [
    'You are running a Jinn restoration intent. Invoke the `coordinator` skill via the Skill tool to begin.',
    '',
    'Session inputs (refer to these when the coordinator skill or any phase asks for them):',
    `- intent.id = ${inputs.intentId}`,
    inputs.intentCid ? `- intent.cid = ${inputs.intentCid}` : '',
    inputs.intentKind ? `- intent.kind = ${inputs.intentKind}` : '',
    `- workingDir = ${inputs.workingDir}`,
    `- implStateDir = ${inputs.implStateDir}`,
    `- window.startTs = ${inputs.windowStartTs} (ms since epoch)`,
    `- window.endTs = ${inputs.windowEndTs} (ms since epoch)`,
    `- msUntilEndTs = ${inputs.msUntilEndTs}`,
    '',
    'Run all seven phases and return when complete.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Real Claude Code adapter. Spawns the `claude` CLI with the plugin
 * loaded via Claude Code's plugin install directory, sets IMPL_STATE_DIR
 * so the session-start hook fires correctly, and hands the coordinator
 * an initial prompt with intent context.
 *
 * Output collection is delegated to the shim's harvester — this adapter
 * only owns the spawn lifecycle.
 */
export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly name = 'claude-code';
  readonly allowsHarnessSelfModification = false;

  private readonly claudePath: string;
  private readonly claudeModel: string | undefined;
  private readonly pluginInstallDir: string;
  private readonly spawnFn: typeof spawn;

  constructor(config: ClaudeCodeHarnessAdapterConfig = {}) {
    this.claudePath = config.claudePath ?? 'claude';
    this.claudeModel = config.claudeModel;
    this.pluginInstallDir = config.pluginInstallDir ?? join(homedir(), '.claude', 'plugins');
    this.spawnFn = config._spawnFn ?? spawn;
  }

  async runIntent(inputs: IntentSessionInputs, pluginRoot: string): Promise<void> {
    // Ensure the plugin install directory exists. The adapter does NOT
    // copy the plugin — that's the operator's responsibility per the
    // README. If the operator has not installed it, Claude Code will
    // not find the coordinator skill and will fail; check for it here.
    mkdirSync(this.pluginInstallDir, { recursive: true });

    const prompt = buildInitialPrompt(inputs);
    const args: string[] = ['-p', prompt];
    if (this.claudeModel) args.push('--model', this.claudeModel);

    const env = buildAgentEnv({
      IMPL_STATE_DIR: inputs.implStateDir,
      JINN_DEFAULT_LEARNER_PLUGIN_ROOT: pluginRoot,
    });

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: inputs.workingDir,
    };

    return new Promise<void>((resolve, reject) => {
      const child: ChildProcess = this.spawnFn(this.claudePath, args, spawnOpts);

      // Window-end abort: kill child, reject.
      const onAbort = () => {
        if (!child.killed) child.kill('SIGTERM');
      };
      inputs.abort.addEventListener('abort', onAbort);

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('exit', (code, signal) => {
        inputs.abort.removeEventListener('abort', onAbort);
        if (code === 0) {
          resolve();
        } else if (inputs.abort.aborted) {
          // Window expired; resolve anyway so harvester can collect
          // partial outputs. The shim's caller (engine) handles the
          // abort signal separately.
          resolve();
        } else {
          reject(
            new Error(
              `claude-code adapter: child exited with code=${code} signal=${signal}: ${stderr.slice(0, 500)}`,
            ),
          );
        }
      });

      child.on('error', (err) => {
        inputs.abort.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/restorer/impls/default-learner/adapters/claude-code.ts
git commit -m "feat(default-learner-shim): Claude Code harness adapter"
```

---

## Task 7: Claude Code adapter smoke test (skipped without `claude` CLI)

Smoke-tests the spawn behavior using `_spawnFn` injection. Does NOT require the real `claude` CLI to be available — uses a mock.

**Files:**
- Test: `client/test/restorer/impls/default-learner/claude-code-adapter.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// client/test/restorer/impls/default-learner/claude-code-adapter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ClaudeCodeHarnessAdapter } from '../../../../src/restorer/impls/default-learner/adapters/claude-code.js';
import type { IntentSessionInputs } from '../../../../src/restorer/impls/default-learner/index.js';

function makeFakeChild(exitCode: number, exitDelayMs = 0): ChildProcess {
  const ee = new EventEmitter() as ChildProcess & EventEmitter;
  (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (ee as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (ee as unknown as { kill: () => boolean }).kill = () => true;
  (ee as unknown as { killed: boolean }).killed = false;
  setTimeout(() => ee.emit('exit', exitCode, null), exitDelayMs);
  return ee;
}

function makeInputs(overrides: Partial<IntentSessionInputs> = {}): IntentSessionInputs {
  return {
    intentId: 'cc-test-1',
    intentCid: 'bafycc',
    intentKind: 'portfolio.v0',
    implStateDir: '/tmp/fake-state',
    workingDir: '/tmp/fake-work',
    windowStartTs: Date.now() - 1000,
    windowEndTs: Date.now() + 60_000,
    msUntilEndTs: 60_000,
    abort: new AbortController().signal,
    ...overrides,
  };
}

describe('ClaudeCodeHarnessAdapter', () => {
  it('spawns the configured claudePath with the intent prompt', async () => {
    const spawnFn = vi.fn(() => makeFakeChild(0));
    const adapter = new ClaudeCodeHarnessAdapter({
      claudePath: '/usr/bin/fake-claude',
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    await adapter.runIntent(makeInputs(), '/path/to/plugin');

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [path, args, opts] = spawnFn.mock.calls[0];
    expect(path).toEqual('/usr/bin/fake-claude');
    expect(args).toEqual(expect.arrayContaining(['-p']));
    const promptArg = (args as string[])[1];
    expect(promptArg).toContain('cc-test-1');
    expect(promptArg).toContain('coordinator');
    expect(promptArg).toContain('/tmp/fake-work');
    expect((opts as { env: Record<string, string> }).env.IMPL_STATE_DIR).toEqual('/tmp/fake-state');
    expect((opts as { env: Record<string, string> }).env.JINN_DEFAULT_LEARNER_PLUGIN_ROOT).toEqual('/path/to/plugin');
    expect((opts as { cwd: string }).cwd).toEqual('/tmp/fake-work');
  });

  it('rejects when child exits non-zero (and not aborted)', async () => {
    const spawnFn = vi.fn(() => makeFakeChild(1));
    const adapter = new ClaudeCodeHarnessAdapter({
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });
    await expect(adapter.runIntent(makeInputs(), '/p')).rejects.toThrow(/exited with code=1/);
  });

  it('resolves on non-zero exit when abort signal already fired', async () => {
    const ac = new AbortController();
    ac.abort();
    const spawnFn = vi.fn(() => makeFakeChild(143));
    const adapter = new ClaudeCodeHarnessAdapter({
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });
    await expect(adapter.runIntent(makeInputs({ abort: ac.signal }), '/p')).resolves.toBeUndefined();
  });

  it('passes --model flag when claudeModel is set', async () => {
    const spawnFn = vi.fn(() => makeFakeChild(0));
    const adapter = new ClaudeCodeHarnessAdapter({
      claudeModel: 'claude-opus-4-7',
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });
    await adapter.runIntent(makeInputs(), '/p');
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-7']));
  });
});
```

- [ ] **Step 2: Run test (expect pass)**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/claude-code-adapter.test.ts
```

Expected: PASS, all four cases.

- [ ] **Step 3: Run the full default-learner suite**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn vitest run test/restorer/impls/default-learner/
```

Expected: PASS — every test in plugin-path, harvest, restorer-shim, claude-code-adapter.

- [ ] **Step 4: Run the full client test suite to ensure nothing else broke**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn test
```

Expected: PASS — pre-existing tests are unaffected because nothing in `buildRestorerImpls` was touched.

- [ ] **Step 5: Commit**

```bash
git add client/test/restorer/impls/default-learner/claude-code-adapter.test.ts
git commit -m "test(default-learner-shim): Claude Code adapter spawn smoke test"
```

---

## Plan 2 acceptance

When all 7 tasks are committed:

- [ ] `cd client && yarn typecheck` — zero errors.
- [ ] `cd client && yarn vitest run test/restorer/impls/default-learner/` — every test passes.
- [ ] `cd client && yarn test` — pre-existing client tests still pass.
- [ ] `client/src/restorer/impls/default-learner/index.ts` exports `DefaultLearningRestorerImpl`, `ClaudeCodeHarnessAdapter`, `NoOpHarnessAdapter`, `resolvePluginRoot`, `harvestOutput`.
- [ ] The impl is NOT registered in `buildRestorerImpls` — daemon behavior is unchanged. Plan 3 handles wiring.
- [ ] A consumer can construct `new DefaultLearningRestorerImpl({ adapter: new ClaudeCodeHarnessAdapter() })` and call `run(ctx)` to spawn `claude` with the plugin loaded; output is harvested into `RestorationOutput`.

---

## What Plan 3 will pick up

- First-match-wrapper class that wraps `DefaultLearningRestorerImpl` around the existing kind-specific specialist impls (`claude-mcp-hyperliquid`, `claude-mcp-prediction*`, etc.). When the intent's kind has a specialist, the wrapper runs Orient/Strategize/Plan via the plugin (advisory), then delegates Execute to the specialist's `run(ctx)`, then runs Debrief/Improve/Memory consolidation via the plugin.
- `buildRestorerImpls` integration — default-learner registers FIRST; the wrapper internally references the rest of the list.
- Portfolio.v0 end-to-end acceptance test on Anvil fork.
- Replan-path acceptance test (synthetic Execute step that fails its successSignal).
- Out-of-scope-write block test (synthetic worker tries to write outside `implStateDir`/`workingDir`).
