# Learner Plugin Attribution (#1035) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `claude-code-learner` plugin attributable in a learner run's solution envelope `executor.plugins` (and therefore in the indexer's `pluginsJson`), in the same `{name, version, sha256}` shape as every other runtime plugin — so learner runs can be partitioned by plugin version.

**Architecture:** The `LearnerHarness` resolves a `RuntimePlugin` descriptor for its own plugin tree (`name: 'claude-code-learner'`, version read from the plugin's `plugin.json`, `sha256` from a directory digest) and exposes it via a new optional `Harness.attributionPlugins()` method. The engine merges any impl-provided attribution plugins into the existing `runtimePlugins` carrier at the RUNNING transition, so they flow through the already-built `executorPlugins` projection at `pack()`-time with no parallel descriptor format and no indexer change.

**Tech Stack:** TypeScript, Vitest (client + indexer), Node `crypto` (sha256), the existing `digestDirectory` and manifest primitives under `client/src/plugins/`.

---

## Corrections to the Stage-1 design note (verified against code)

These were checked against the actual source before this plan was written. The implementer MUST honor the corrected facts below, not the original note where they differ.

1. **Engine path is wrong in the note.** The engine is at `client/src/harnesses/engine/engine.ts` (a sub-directory), NOT `client/src/harnesses/engine.ts`. All engine line numbers below are re-grepped against the real file.
2. **`RuntimePlugin` required fields.** `client/src/harnesses/types.ts:12-24` — required fields are: `name`, `version`, `source`, `root`, `manifestPath`, `sha256`, `provenance` (`'default' | 'configured'`). Optional: `sourceKind?`, `solverType?`, `supports?`, `cid?`. The note said `source?` is optional — it is NOT; `source` is required and `sourceKind?` is the optional one. The descriptor MUST set `source`, `root`, `manifestPath`, and `provenance: 'default'` or the type won't compile.
3. **Do NOT call `loadSolverPluginManifest` on the learner root.** The note suggested reading the version via `loadSolverPluginManifest(this.pluginRoot)`. That function calls `validateSolverPluginManifest` (`client/src/plugins/manifest.ts:26`), which **requires** `manifest.jinn` and a non-empty `manifest.jinn.supports` array (`client/src/plugins/validator.ts:34-42`). The learner manifest at `client/plugins/learner/.claude-plugin/plugin.json` has only `name` + `version` (no `jinn` key), so `loadSolverPluginManifest` AND `resolveSolverPlugin` both throw. Read the manifest version with `findSolverPluginManifest` (the non-validating path finder, exported from the same module) + a direct `readFileSync`/`JSON.parse`.
4. **The harness's `this.name`/`this.version` are NOT the plugin's.** `LearnerHarness.name` is `'claude-code'` / `'codex'` (`harness.ts:49`), `version` is `'0.1.0-shim'` (`harness.ts:50`). The attribution descriptor's `name`/`version` come from the **plugin manifest** (`claude-code-learner` / `0.1.0`), not the harness shim.
5. **`this.pluginRoot` confirmed** at `harness.ts:41`, set in the constructor at `harness.ts:51` from `config.pluginRoot ?? resolvePluginRoot()`.
6. **Carrier/persistence line numbers (re-grepped):** carrier map store at `engine.ts:1168`; both persistence sites at `engine.ts:1261` (skipped path) and `engine.ts:1313` (normal path); pack() carrier read at `engine.ts:1600-1602`; `executorPlugins` projection at `engine.ts:1603-1611`; `runtimeBundleDigest` at `engine.ts:1616-1626`.
7. **Crash-recovery is covered by persisting the merged array.** The pack() read at `engine.ts:1600-1602` is `this.runtimePluginsByRequest.get(...) ?? (task.runtimePluginsJson ? JSON.parse(...) : [])`. If both the in-memory map (`engine.ts:1168`) and the persisted `runtimePluginsJson` (`engine.ts:1261`, `:1313`) carry the **merged** array, then a crash-recovery pack() (map empty → JSON fallback) still includes the learner descriptor. No separate threading into the recovery path is needed. **Gap to avoid:** if you only set the map and forget either persistence site, recovery loses the attribution — set all three.
8. **Do NOT add the learner descriptor to `ctx.runtimePlugins` / `ctx.solverPluginRoots`** (`engine.ts:1207-1208`). `solverPluginRoots` is `runtimePlugins.map(p => p.root)` and is handed to the harness adapter to **load** plugins as solver plugins. The learner plugin is already loaded by the harness itself via `this.pluginRoot`; adding its root here would double-load it. The merge must produce a **separate** array used only for the carrier map + persisted JSON, leaving the `runtimePlugins` variable that feeds `ctx` untouched.
9. **Indexer: no code change.** `parseEnvelopeLite` blindly `JSON.stringify`s `executor.plugins` with zero filtering (`packages/indexer/src/handlers.ts:636-644`); the round-trip test is at `packages/indexer/test/handlers.test.ts:911-914`. AC2 is satisfied for free once the descriptor is in the envelope. The indexer task in this plan is verification-only (run its existing suite), plus an optional assertion-strengthening test.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `client/src/harnesses/types.ts` | `Harness` interface + `RuntimePlugin` type | Add optional `attributionPlugins?(): RuntimePlugin[]` to `Harness`. |
| `client/src/harnesses/impls/learner/harness.ts` | `LearnerHarness` | Build the `claude-code-learner` descriptor once (constructor) and return it from `attributionPlugins()`. |
| `client/src/harnesses/engine/engine.ts` | Engine `runImpl` + carrier/persistence | Merge `impl.attributionPlugins?.()` into the persisted/carried array at the RUNNING transition (3 sites). |
| `client/test/harnesses/impls/learner/attribution-plugins.test.ts` | Unit test | NEW — asserts `attributionPlugins()` shape against the real plugin tree. |
| `client/test/harnesses/engine/learner-attribution.test.ts` | Integration test | NEW — drives the real `runImpl → pack` and asserts the signed envelope's `executor.plugins`. |
| `packages/indexer/test/handlers.test.ts` | Indexer round-trip | OPTIONAL — strengthen the existing test to include a 3-plugin slate with `claude-code-learner`. |

---

## Task 1: Regression test — engine integration (the failing test first)

This is the load-bearing regression test for the whole fix: it drives the **real** `runImpl` and **real** `pack()` and asserts the signed envelope that hits IPFS carries all three plugins, including `claude-code-learner`. It fails today because nothing merges the attribution plugin into the carrier.

**Files:**
- Create: `client/test/harnesses/engine/learner-attribution.test.ts`

The test mirrors the construction in `client/test/harnesses/engine/engine-packaging.test.ts:100-224` (a `TestEngine extends TaskEngine` with `packagingDeps` + `envelopeDeps`, the `uploadToIpfs` mock, reading the envelope from the mock's call args) and the impl-registry stub pattern in `client/test/harnesses/engine/impl-state-dir.test.ts:34-52`. It wires a `solverNetRegistry` returning the two baseline runtime plugins and a stub impl that implements `attributionPlugins()`.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * Regression test for #1035 — claude-code-learner attribution.
 *
 * A learner run's signed envelope must carry the learner plugin in
 * executor.plugins alongside the SolverNet's baseline runtime plugins, in the
 * same {name, version, sha256} shape. A harness that does NOT implement
 * attributionPlugins() must NOT inject any extra plugin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
  type SolverNetRegistryLike,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, RuntimePlugin, Solution } from '../../../src/harnesses/types.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(('0x' + 'de'.repeat(32)) as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const SOLVER_TYPE = 'swe-rebench-v2.v1';

function mkTmp(): string {
  const dir = join(tmpdir(), `learner-attr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Two baseline runtime plugins the SolverNet ships, mirroring production.
const baselinePlugins: RuntimePlugin[] = [
  {
    name: '@jinn-network/network-tools',
    version: '0.3.0',
    source: 'bundled:network-tools',
    root: '/dev/null/network-tools',
    manifestPath: '/dev/null/network-tools/jinn.plugin.json',
    sha256: 'aa'.repeat(32),
    provenance: 'default',
  },
  {
    name: 'swe-rebench-v2-runtime',
    version: '1.0.0',
    source: 'bundled:swe-rebench-v2-runtime',
    root: '/dev/null/swe-rebench-v2-runtime',
    manifestPath: '/dev/null/swe-rebench-v2-runtime/jinn.plugin.json',
    sha256: 'bb'.repeat(32),
    provenance: 'default',
  },
];

const learnerDescriptor: RuntimePlugin = {
  name: 'claude-code-learner',
  version: '0.1.0',
  source: 'bundled:learner',
  root: '/dev/null/learner',
  manifestPath: '/dev/null/learner/.claude-plugin/plugin.json',
  sha256: 'cc'.repeat(32),
  provenance: 'default',
};

function makeSolverNetRegistry(): SolverNetRegistryLike {
  return {
    forSolverType: (solverType) =>
      solverType === SOLVER_TYPE
        ? {
            name: 'test-net',
            solverType: SOLVER_TYPE,
            harness: 'claude-code',
            runtimePlugins: baselinePlugins,
          }
        : undefined,
  };
}

/** Stub impl. When `withAttribution` is true it advertises the learner plugin. */
function makeStubImpl(withAttribution: boolean): Harness {
  const impl: Harness = {
    name: 'claude-code',
    version: '0.1.0-shim',
    supports: (s) => s.role !== 'evaluation' && s.solverType === SOLVER_TYPE,
    async run(): Promise<Solution> {
      return {
        venueRef: { name: 'claude-code' },
        gating: { ok: true },
        preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        fills: [],
      };
    },
  };
  if (withAttribution) {
    impl.attributionPlugins = () => [learnerDescriptor];
  }
  return impl;
}

function makeOpts(store: Store, tmp: string, impl: Harness): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(tmp, 'work'), implStateDirRoot: join(tmp, 'impl') },
    implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    solverNetRegistry: makeSolverNetRegistry(),
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xsafe' as `0x${string}`,
    },
  };
}

function makeInput(requestId: string): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    taskCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    solverType: SOLVER_TYPE,
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task: { id: requestId, description: 'test', solverType: SOLVER_TYPE, role: 'restoration' },
  };
}

/** Drive observe → … → PACKAGING through the real runImpl + pack, return the uploaded envelope. */
async function runToEnvelope(
  store: Store,
  tmp: string,
  impl: Harness,
  requestId: string,
): Promise<Record<string, unknown>> {
  const engine = new TaskEngine(makeOpts(store, tmp, impl));
  const p = new TaskRunPersistence(store.db);
  await engine.observe(makeInput(requestId));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  // First process(): WAITING → PRE_SNAPSHOT → RUNNING (real runImpl) → POST_SNAPSHOT.
  // The RUNNING case `break`s after runImpl (engine.ts:733-735), so the task
  // stops at POST_SNAPSHOT (postSnapshotPayload now set from the stub Solution).
  await engine.process(requestId);
  expect(p.getByRequestId(requestId)!.state).toBe(TaskRunState.POST_SNAPSHOT);
  // Second process(): POST_SNAPSHOT case (engine.ts:737-749) data-driven-advances
  // to PACKAGING and runs the real pack() (which uploads the signed envelope).
  await engine.process(requestId);

  const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
  const calls = (uploadToIpfs as ReturnType<typeof vi.fn>).mock.calls;
  const envelopeCall = calls.find(
    ([, payload]: [string, Record<string, unknown>]) =>
      typeof payload === 'object' && payload !== null && 'executor' in payload && 'participant' in payload,
  );
  if (!envelopeCall) throw new Error('no envelope was uploaded to IPFS');
  return envelopeCall[1] as Record<string, unknown>;
}

function pluginNames(envelope: Record<string, unknown>): string[] {
  const executor = envelope.executor as { plugins?: Array<{ name: string }> };
  return (executor.plugins ?? []).map((pl) => pl.name);
}

describe('#1035 learner plugin attribution in executor.plugins', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    vi.clearAllMocks();
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('includes claude-code-learner with {name, version, sha256} for a learner run', async () => {
    const envelope = await runToEnvelope(store, tmp, makeStubImpl(true), 'req-attr-1');
    const executor = envelope.executor as { plugins: Array<{ name: string; version: string; sha256: string }> };
    const learner = executor.plugins.find((pl) => pl.name === 'claude-code-learner');
    expect(learner).toBeDefined();
    expect(learner!.version).toBe('0.1.0');
    expect(learner!.sha256).toBe('cc'.repeat(32));
    // No regression: both baseline plugins still present.
    expect(pluginNames(envelope)).toEqual(
      expect.arrayContaining(['@jinn-network/network-tools', 'swe-rebench-v2-runtime', 'claude-code-learner']),
    );
  });

  it('omits claude-code-learner for a harness without attributionPlugins()', async () => {
    const envelope = await runToEnvelope(store, tmp, makeStubImpl(false), 'req-attr-2');
    expect(pluginNames(envelope)).not.toContain('claude-code-learner');
    expect(pluginNames(envelope)).toEqual(
      expect.arrayContaining(['@jinn-network/network-tools', 'swe-rebench-v2-runtime']),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails for the right reason**

Run (from `client/`):
```bash
yarn vitest run test/harnesses/engine/learner-attribution.test.ts
```
Expected:
- The first test (`includes claude-code-learner …`) FAILS: `learner` is `undefined` because `executor.plugins` only contains the two baseline plugins — nothing merges `attributionPlugins()` into the carrier yet.
- The second test (`omits …`) PASSES already (no attribution path exists, so nothing is injected).

If the first test errors on a *type* (`Property 'attributionPlugins' does not exist on type 'Harness'`) rather than an *assertion*, that is also an acceptable red — Task 2 adds the interface member that makes it compile, and it will then fail on the assertion. Note: `yarn test` runs `build:sdk` first; for the inner TDD loop use `yarn vitest run <file>` directly to skip the SDK build. Do a full `yarn typecheck` at the end (Task 6).

---

## Task 2: Add `attributionPlugins()` to the `Harness` interface

**Files:**
- Modify: `client/src/harnesses/types.ts` (the `Harness` interface, after `freezeStateHashIgnore` ~line 234, before `supports`)

- [ ] **Step 1: Add the optional method to the interface**

Insert into the `Harness` interface (it already imports/defines `RuntimePlugin` in this file):

```typescript
  /**
   * Optional self-attribution: runtime plugins this harness bundles and runs
   * itself (not provided by the SolverNet's `runtimePlugins`), so they appear
   * in the solution envelope's `executor.plugins` like any other plugin.
   *
   * Only `LearnerHarness` implements this — it returns a descriptor for the
   * `claude-code-learner` plugin it loads from its own plugin root. Every other
   * harness omits the method and is unaffected (#1035).
   *
   * Called synchronously by the engine at the RUNNING transition; the digest is
   * stable per run, so implementers should compute it once (e.g. in their
   * constructor) and return the cached array.
   */
  attributionPlugins?(): RuntimePlugin[];
```

- [ ] **Step 2: Typecheck the file compiles**

Run (from `client/`):
```bash
yarn vitest run test/harnesses/engine/learner-attribution.test.ts
```
Expected: the regression test now compiles; the first test still FAILS on the assertion (`learner` undefined) because the engine doesn't merge yet. The second still PASSES.

- [ ] **Step 3: Commit**

```bash
git add client/src/harnesses/types.ts client/test/harnesses/engine/learner-attribution.test.ts
git commit -m "test(engine): failing regression for #1035 learner plugin attribution + Harness.attributionPlugins() interface

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Implement `LearnerHarness.attributionPlugins()`

Build the `claude-code-learner` descriptor once in the constructor (the digest is stable for a given plugin tree), reading the version from the plugin manifest **without** the validator (which would throw — see correction #3).

**Files:**
- Modify: `client/src/harnesses/impls/learner/harness.ts`
- Test: `client/test/harnesses/impls/learner/attribution-plugins.test.ts` (new unit test)

- [ ] **Step 1: Write the failing unit test**

Create `client/test/harnesses/impls/learner/attribution-plugins.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

/** Minimal no-op adapter to satisfy the required `adapter` field. */
class NoOpAdapter implements HarnessAdapter {
  readonly name = 'noop';
  async runTask(_inputs: TaskSessionInputs, _pluginRoot: string): Promise<void> { /* no-op */ }
}

describe('LearnerHarness.attributionPlugins', () => {
  it('returns one descriptor for the claude-code-learner plugin', () => {
    const harness = new LearnerHarness({ adapter: new NoOpAdapter() });
    const plugins = harness.attributionPlugins();
    expect(plugins).toHaveLength(1);
    const [learner] = plugins;
    expect(learner.name).toBe('claude-code-learner');
    expect(learner.version).toMatch(/^\d+\.\d+\.\d+/); // whatever version ships
    expect(learner.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(learner.provenance).toBe('default');
    expect(learner.source).toBe('bundled:learner');
    expect(learner.root).toContain('plugins/learner');
  });

  it('carries the live manifest version (AC3 — observable, not bumped)', () => {
    const harness = new LearnerHarness({ adapter: new NoOpAdapter() });
    const [learner] = harness.attributionPlugins();
    // The descriptor reflects whatever version is in
    // client/plugins/learner/.claude-plugin/plugin.json at build time.
    expect(typeof learner.version).toBe('string');
    expect(learner.version.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `client/`):
```bash
yarn vitest run test/harnesses/impls/learner/attribution-plugins.test.ts
```
Expected: FAIL — `harness.attributionPlugins is not a function` (the method doesn't exist on `LearnerHarness` yet; the interface member is optional, so TS allows the call but it's `undefined` at runtime).

- [ ] **Step 3: Add imports to `harness.ts`**

At the top of `client/src/harnesses/impls/learner/harness.ts`, add (near the existing `resolvePluginRoot` import at line 15):

```typescript
import { readFileSync } from 'node:fs';
import type { RuntimePlugin } from '../../types.js';
import { digestDirectory } from '../../../plugins/digest.js';
import { findSolverPluginManifest } from '../../../plugins/manifest.js';
```

Note: `RuntimePlugin` is currently NOT imported in this file; the existing `import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../types.js';` can be extended to include `RuntimePlugin`, or add the separate `import type` line above. Either is fine; keep it a type-only import.

- [ ] **Step 4: Build the descriptor in the constructor and expose `attributionPlugins()`**

Add a private field and populate it at the end of the constructor (the constructor ends at line 56, after `this.runtimeMode = …`):

```typescript
  private readonly attributionPlugin: RuntimePlugin;
```

At the end of the constructor body (after `this.runtimeMode = config.runtimeMode ?? 'bare';`):

```typescript
    // #1035: self-attribute the learner plugin so it lands in the envelope's
    // executor.plugins like any SolverNet runtime plugin. We do NOT use
    // resolveSolverPlugin/loadSolverPluginManifest here: the learner manifest
    // (.claude-plugin/plugin.json) has only name+version and no jinn.supports,
    // so the SolverPlugin validator would reject it. Read name+version directly.
    const manifestPath = findSolverPluginManifest(this.pluginRoot);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: string; version?: string };
    this.attributionPlugin = {
      name: 'claude-code-learner',
      version: manifest.version ?? '0.0.0',
      source: 'bundled:learner',
      sourceKind: 'bundled',
      root: this.pluginRoot,
      manifestPath,
      sha256: digestDirectory(this.pluginRoot),
      provenance: 'default',
    };
```

Then add the method (anywhere in the class body, e.g. right after the constructor):

```typescript
  /**
   * #1035 — advertise the bundled learner plugin for envelope attribution.
   * The descriptor is built once in the constructor (stable digest per run).
   */
  attributionPlugins(): RuntimePlugin[] {
    return [this.attributionPlugin];
  }
```

> **Note on `name: 'claude-code-learner'` hardcode:** the manifest `name` IS `claude-code-learner`, but the harness `name` may be `codex` (the Codex variant shares this shell). The attributed plugin is the same `claude-code-learner` tree regardless of which CLI drives it, so hardcoding the plugin name is correct and matches the manifest. You may instead use `manifest.name ?? 'claude-code-learner'` for symmetry — either is acceptable; the manifest value is `claude-code-learner`.

- [ ] **Step 5: Run the unit test to verify it passes**

Run (from `client/`):
```bash
yarn vitest run test/harnesses/impls/learner/attribution-plugins.test.ts
```
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/learner/harness.ts client/test/harnesses/impls/learner/attribution-plugins.test.ts
git commit -m "fix(learner): build claude-code-learner attribution descriptor (#1035)

Reads name+version from the plugin manifest directly (the SolverPlugin
validator would reject the learner manifest, which has no jinn.supports)
and sha256 from a directory digest. Exposed via Harness.attributionPlugins().

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Merge attribution plugins into the carrier at the RUNNING transition

Make the engine merge `impl.attributionPlugins?.()` into the array it stores in the carrier map and persists as `runtimePluginsJson` — at all three sites — WITHOUT touching the `runtimePlugins` variable that feeds `ctx.runtimePlugins` / `ctx.solverPluginRoots` (correction #8).

**Files:**
- Modify: `client/src/harnesses/engine/engine.ts:1167-1168` (compute merged array, store in map), `:1261` and `:1313` (persist merged array).

- [ ] **Step 1: Compute the merged array and store it in the carrier map**

Replace the current lines `engine.ts:1167-1168`:

```typescript
    const runtimePlugins: RuntimePlugin[] = solverNet?.runtimePlugins ?? [];
    this.runtimePluginsByRequest.set(task.requestId, runtimePlugins);
```

with:

```typescript
    const runtimePlugins: RuntimePlugin[] = solverNet?.runtimePlugins ?? [];
    // #1035: merge harness self-attributed plugins (e.g. claude-code-learner)
    // into the envelope carrier so they appear in executor.plugins. This is a
    // SEPARATE array from `runtimePlugins`: the latter still feeds
    // ctx.runtimePlugins / ctx.solverPluginRoots (which the harness uses to
    // LOAD solver plugins), and the learner plugin is already loaded by the
    // harness itself via its own plugin root — adding it there would double-load.
    const attributedPlugins: RuntimePlugin[] = [
      ...runtimePlugins,
      ...(impl.attributionPlugins?.() ?? []),
    ];
    this.runtimePluginsByRequest.set(task.requestId, attributedPlugins);
```

- [ ] **Step 2: Persist the merged array at the skipped-path transition (`engine.ts:1261`)**

Change:
```typescript
            runtimePluginsJson: JSON.stringify(runtimePlugins),
```
to:
```typescript
            runtimePluginsJson: JSON.stringify(attributedPlugins),
```
(the occurrence inside the `SkippableError` branch's `persistence.transition(... POST_SNAPSHOT ...)` block.)

- [ ] **Step 3: Persist the merged array at the normal-path transition (`engine.ts:1313`)**

Change the second occurrence (inside the main `persistence.transition(task.requestId, TaskRunState.POST_SNAPSHOT, {...})` block) the same way:
```typescript
        runtimePluginsJson: JSON.stringify(attributedPlugins),
```

> Both sites are inside the same `runImpl` method, so `attributedPlugins` is in scope at both. There are exactly two `JSON.stringify(runtimePlugins)` occurrences in `runImpl`; replace both. Leave `ctx.runtimePlugins` (line 1207) and `ctx.solverPluginRoots` (line 1208) as `runtimePlugins` — do NOT change them.

- [ ] **Step 4: Run the engine integration regression test — should now pass**

Run (from `client/`):
```bash
yarn vitest run test/harnesses/engine/learner-attribution.test.ts
```
Expected: BOTH tests PASS. The first now finds `claude-code-learner` (version `0.1.0`, sha256 `cc..cc`) alongside the two baseline plugins; the second still has no learner plugin.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/engine/engine.ts
git commit -m "fix(engine): merge harness attributionPlugins into envelope carrier (#1035)

Merges impl.attributionPlugins() into the runtimePluginsByRequest map and the
persisted runtimePluginsJson at both POST_SNAPSHOT transition sites, so the
descriptors flow into executor.plugins at pack()-time. Crash-recovery is
covered because pack() falls back to the persisted JSON. ctx.runtimePlugins /
solverPluginRoots are deliberately left unchanged (no double-load).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Indexer — verify passthrough (no code change) + optional assertion strengthening

The indexer already materializes any `executor.plugins` into `pluginsJson` verbatim (`packages/indexer/src/handlers.ts:636-644`). This task confirms that and (optionally) strengthens the round-trip test to include the three-plugin learner slate so AC2 is pinned.

**Files:**
- Optional modify: `packages/indexer/test/handlers.test.ts` (the round-trip assertion at lines 911-914).

- [ ] **Step 1: Run the existing indexer suite (no change) to confirm green**

Run (from `packages/indexer/`):
```bash
yarn test
```
Expected: PASS — including the existing `plugins round-trip` assertion.

- [ ] **Step 2 (optional): Strengthen the round-trip fixture to include claude-code-learner**

In the test fixture that feeds `executor.plugins` for the round-trip case (the envelope object built before the `plugins round-trip` assertion at `handlers.test.ts:911`), extend the plugins array to a three-plugin slate, e.g.:

```typescript
plugins: [
  { name: '@jinn-network/network-tools', version: '0.3.0', sha256: 'aa'.repeat(32) },
  { name: 'swe-rebench-v2', version: '1.0', sha256: 'dd'.repeat(32) },
  { name: 'claude-code-learner', version: '0.1.0', sha256: 'cc'.repeat(32) },
],
```

and update the assertion at lines 911-914 to expect the same three entries (preserving the indexer's `JSON.stringify` order — it does not sort, so list them in the order they appear in the fixture):

```typescript
expect(JSON.parse(metaRow!.pluginsJson as string)).toEqual([
  { name: '@jinn-network/network-tools', version: '0.3.0', sha256: 'aa'.repeat(32) },
  { name: 'swe-rebench-v2', version: '1.0', sha256: 'dd'.repeat(32) },
  { name: 'claude-code-learner', version: '0.1.0', sha256: 'cc'.repeat(32) },
]);
```

> Before editing, READ `packages/indexer/test/handlers.test.ts` around the fixture (locate the `executor.plugins` literal feeding this `metaRow`) so the edit matches the actual fixture variable and the indexer's serialization order. If the fixture is shared with other assertions, prefer a new dedicated `it(...)` block over mutating the shared fixture.

- [ ] **Step 3 (if Step 2 done): Run the indexer suite again**

Run (from `packages/indexer/`):
```bash
yarn test
```
Expected: PASS.

- [ ] **Step 4: Commit (only if Step 2 was done)**

```bash
git add packages/indexer/test/handlers.test.ts
git commit -m "test(indexer): pin claude-code-learner in pluginsJson round-trip (#1035)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification

- [ ] **Step 1: Client typecheck**

Run (from `client/`):
```bash
yarn typecheck
```
Expected: zero errors. (Catches any `RuntimePlugin` field omissions in the new descriptor and the interface change.)

- [ ] **Step 2: Run the two new client tests together**

Run (from `client/`):
```bash
yarn vitest run test/harnesses/impls/learner/attribution-plugins.test.ts test/harnesses/engine/learner-attribution.test.ts
```
Expected: all PASS.

- [ ] **Step 3: Run the touched-area client suites to confirm no regression**

Run (from `client/`):
```bash
yarn vitest run test/harnesses/engine test/harnesses/impls/learner
```
Expected: all PASS. (Confirms the engine carrier change and the learner harness change broke nothing — e.g. `is-ready.test.ts`, `mode-gate.test.ts`, packaging/recovery tests.)

- [ ] **Step 4: Indexer typecheck + suite**

Run (from `packages/indexer/`):
```bash
yarn typecheck && yarn test
```
Expected: zero type errors; all tests PASS.

- [ ] **Step 5: Final commit if any uncommitted verification fixups were needed** (otherwise skip).

---

## Acceptance-criteria → task mapping

| AC | Satisfied by |
| --- | --- |
| **AC1** — learner envelope `executor.plugins` includes `claude-code-learner` with `{name, version, sha256}`, same shape as other runtime plugins | Task 3 (builds the `RuntimePlugin` descriptor) + Task 4 (merges it into the carrier so `pack()`'s `executorPlugins` projection emits it). Verified by Task 1's first integration test + Task 3's unit test. |
| **AC2** — indexer materializes `claude-code-learner` (with version) into `pluginsJson` on `attemptEnvelopeMeta` | Task 5 — no indexer code change needed; `parseEnvelopeLite` (`handlers.ts:636-644`) stringifies `executor.plugins` verbatim. Confirmed by the existing/strengthened round-trip test. Once AC1 lands, the descriptor flows through automatically. |
| **AC3** — a query can partition learner runs by `claude-code-learner` version (`@0.2.0` vs `@0.1.0`) | Task 3 — the descriptor carries the live manifest `version` (read from `plugin.json`), so whatever version ships is observable in `pluginsJson`. No version bump (out of scope per the coordinator). Verified by Task 3's "carries the live manifest version" test + Task 1's `version: '0.1.0'` assertion. |
| **AC4** — no regression: `@jinn-network/network-tools` and `swe-rebench-v2-runtime` still appear in `pluginsJson` | Task 4 (merge prepends `...runtimePlugins`, never drops the baseline) + Task 1's `arrayContaining([...baseline, learner])` assertions + the negative test (harness without `attributionPlugins()` yields exactly the baseline). Task 6 Step 3 re-runs the broader suites. |

---

## Self-review notes

- **Spec coverage:** all four ACs map to a task above; the negative case (non-learner harness) is explicitly tested (Task 1, second test) to prevent over-injection.
- **No placeholders:** every code step shows the exact code; every run step shows the exact command + expected outcome.
- **Type consistency:** the descriptor sets every required `RuntimePlugin` field (`name`, `version`, `source`, `root`, `manifestPath`, `sha256`, `provenance`) — verified against `client/src/harnesses/types.ts:12-24`. The new method name `attributionPlugins` is identical in the interface (Task 2), the impl (Task 3), and the engine call site (Task 4).
- **Crash-recovery gap closed:** the merged `attributedPlugins` is persisted at BOTH `runtimePluginsJson` sites, so `pack()`'s JSON fallback (`engine.ts:1602`) recovers the attribution after a crash between RUNNING and PACKAGING.
- **Surgical:** no change to `ctx.runtimePlugins` / `ctx.solverPluginRoots`, no indexer source change, no `plugin.json` version edit.
