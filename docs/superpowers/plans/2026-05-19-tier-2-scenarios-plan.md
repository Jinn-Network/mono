# Tier 2 scenarios implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three Tier 2 scenarios (T2.1 cross-op donation, T2.2 producer/evaluator on Anvil-fork, T2.3 multi-op SPA flow), the `run-tier-2.ts` orchestrator that runs them in parallel against substrate-derived workspaces, the prerequisite infrastructure (shared substrate+fork+daemons helper, Ponder spawn helper if absent, stubbed harness for T2.2, SWE-rebench fixture), and the documentation that takes the `tier-2-scenarios.md` reference from placeholder (Plan C) to full spec.

**Architecture:** Each scenario is a callable async function returning `ScenarioVerdict` (the shared shape from Plan C). T2.1 and T2.2 are pure TypeScript callables; T2.3 is a Playwright test invoked via subprocess from the orchestrator. All three scenarios start by calling a shared `setupTier2Scenario()` helper that creates a substrate workspace, spawns an Anvil fork, and spawns two daemons against the workspace — one helper, three call sites. The orchestrator (`run-tier-2.ts`) mirrors Plan C's `run-tier-1.ts` structure: parallel `Promise.allSettled`, verdict aggregation, marker emission, per-scenario evidence files.

**Tech Stack:** TypeScript, Vitest, Playwright, viem. Reuses Plan A's substrate scripts, Plan B's `multi-op-daemon` + `handshake-url` helpers, Plan B's `mockDaemonApi` extraction, Plan C's `scenario-types`. Adds a Ponder spawn helper (if absent in the repo today) and a stubbed harness implementation hooked into the existing harness registry.

**Dependencies:**
- **Plan A** — substrate-copy, substrate-verify, substrate-paths. Tier 2 doesn't run without substrate.
- **Plan B** — multi-op-daemon, handshake-url, mockDaemonApi (extracted in Plan C Task 2), `multi-op-playwright.md` reference doc.
- **Plan C** — `scenario-types.ts` (ScenarioVerdict, classifyFailure), `release-prep` SKILL.md scaffolding (this plan extends it), `tier-2-scenarios.md` placeholder (this plan replaces it).
- The existing fork helper `spawnAnvilFork` at `client/test/_support/chain/anvil.ts`.
- The existing harness registry at `client/src/harnesses/impls/index.ts` (verify path during Task 3; CLAUDE.md says it's `buildHarnesses`).

---

## File structure

**New source files:**

| Path | Responsibility |
|---|---|
| `client/test/release/tier-2/tier-2-helpers.ts` | `setupTier2Scenario()` shared substrate+fork+daemons setup |
| `client/test/release/tier-2/T2.1-cross-op-donation.ts` | T2.1 callable + Vitest wrapper |
| `client/test/release/tier-2/T2.2-producer-evaluator.ts` | T2.2 callable + Vitest wrapper |
| `client/test/release/tier-2/fixtures/<instance-id>.patch` | Canned solution patch for T2.2 |
| `client/test/release/tier-2/fixtures/known-instance.ts` | Constants: KNOWN_INSTANCE_ID, KNOWN_REPO, KNOWN_COMMIT, KNOWN_EXPECTED_VERDICT |
| `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts` | T2.3 Playwright test |
| `client/test/dashboard/multi-op/fixtures/two-substrate-ops.ts` | Playwright fixture: substrate + fork + daemons |
| `client/scripts/release/run-tier-2.ts` | Orchestrator |
| `client/test/_support/indexer/ponder.ts` | Ponder spawn helper (if absent in repo) |
| `client/src/harnesses/impls/stub.ts` | Stubbed harness implementation (`JINN_HARNESS_STUB_INSTANCE`-gated) |

**Modified files:**

| Path | Change |
|---|---|
| `client/src/harnesses/impls/index.ts` | Register stub harness conditionally |
| `client/src/dashboard/spa/src/pages/LauncherLaunched.tsx` | Add `data-testid="manifest-cid"` and `data-testid="operator-count"` (if missing) |
| `.claude/skills/release-prep/SKILL.md` | Real Tier 2 wall-clock budgets in the table |
| `.claude/skills/release-prep/references/tier-2-scenarios.md` | Full doc (replaces placeholder) |
| `client/package.json` | Add `release:tier-2`, `release:tier-2:T2.1`, ... yarn scripts |

---

## Task 1: Shared Tier 2 setup helper

**Files:**
- Create: `client/test/release/tier-2/tier-2-helpers.ts`
- Test: `client/test/release/tier-2/tier-2-helpers.test.ts`

Every Tier 2 scenario does the same opening dance: copy substrate workspace → spawn Anvil fork → spawn two daemons against workspace homes with the fork RPC → wait for both daemons reachable. Extract once.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/tier-2/tier-2-helpers.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setupTier2Scenario } from './tier-2-helpers';

describe('setupTier2Scenario', () => {
  it('returns a handle with workspace, anvil, and two daemon URLs', async () => {
    // This test requires Plan A's substrate to exist at ~/jinn-dev/operators/.
    // Skip if not present (e.g. fresh checkout pre-Plan-A).
    const goldOpA = path.join(os.homedir(), 'jinn-dev', 'operators', 'op-a');
    try { await fs.access(goldOpA); } catch { return; }

    let handle: Awaited<ReturnType<typeof setupTier2Scenario>> | undefined;
    try {
      handle = await setupTier2Scenario({
        scenarioId: 'T2.X-test',
        portBase: 7740,
      });
      expect(handle.workspace.opPaths['op-a']).toContain('op-a');
      expect(handle.workspace.opPaths['op-b']).toContain('op-b');
      expect(handle.anvilRpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.daemons.daemons['op-a'].apiPort).toBe(7740);
      expect(handle.daemons.daemons['op-b'].apiPort).toBe(7741);
    } finally {
      if (handle) await handle.teardown();
    }
  }, 90000);

  it('teardown is idempotent and cleans up workspace + anvil + daemons', async () => {
    const goldOpA = path.join(os.homedir(), 'jinn-dev', 'operators', 'op-a');
    try { await fs.access(goldOpA); } catch { return; }

    const handle = await setupTier2Scenario({ scenarioId: 'T2.X-cleanup', portBase: 7742 });
    const workspaceRoot = handle.workspace.workspaceRoot;
    await handle.teardown();
    await expect(fs.access(workspaceRoot)).rejects.toThrow();
    // Idempotent
    await expect(handle.teardown()).resolves.toBeUndefined();
  }, 90000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/release/tier-2/tier-2-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```typescript
// client/test/release/tier-2/tier-2-helpers.ts
import { baseSepolia } from 'viem/chains';
import { copyWorkspace, type WorkspaceHandle } from '../../../scripts/release/substrate-copy';
import { spawnAnvilFork } from '../../_support/chain/anvil';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon';

export interface Tier2SetupOptions {
  scenarioId: string;                  // for run-id and debugging
  portBase: number;                    // op-a gets portBase, op-b gets portBase+1
  extraEnv?: NodeJS.ProcessEnv;        // additional env per daemon (e.g. JINN_HARNESS_STUB_INSTANCE)
  ops?: string[];                      // default: ['op-a', 'op-b']
}

export interface Tier2Handle {
  workspace: WorkspaceHandle;
  anvil: Awaited<ReturnType<typeof spawnAnvilFork>>;
  anvilRpcUrl: string;
  daemons: MultiOpHandle;
  teardown: () => Promise<void>;
}

export async function setupTier2Scenario(opts: Tier2SetupOptions): Promise<Tier2Handle> {
  const ops = opts.ops ?? ['op-a', 'op-b'];
  if (ops.length < 1 || ops.length > 3) {
    throw new Error(`setupTier2Scenario expects 1-3 ops, got ${ops.length}`);
  }

  let workspace: WorkspaceHandle | null = null;
  let anvil: Awaited<ReturnType<typeof spawnAnvilFork>> | null = null;
  let daemons: MultiOpHandle | null = null;

  const cleanup = async () => {
    if (daemons) { try { await daemons.teardown(); } catch {} }
    if (anvil) { try { await anvil.teardown(); } catch {} }
    if (workspace) { try { await workspace.teardown(); } catch {} }
  };

  try {
    // 1. Substrate workspace copy
    workspace = await copyWorkspace({ ops, runId: `${opts.scenarioId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });

    // 2. Anvil fork of Base Sepolia (one per scenario)
    const forkUrl = process.env['BASE_SEPOLIA_RPC_URL'];
    if (!forkUrl) {
      throw new Error('BASE_SEPOLIA_RPC_URL must be set to fork Base Sepolia for Tier 2 scenarios');
    }
    anvil = await spawnAnvilFork({ forkUrl, chain: baseSepolia, silent: true });

    // 3. Spawn daemons against workspace homes with fork RPC override
    daemons = await spawnMultiOpDaemons({
      ops: ops.map((name, i) => ({
        name,
        home: workspace!.opPaths[name],
        apiPort: opts.portBase + i,
      })),
      // Spread extraEnv FIRST, then set JINN_RPC_URL — fork URL must win.
      // Inverse order ({ JINN_RPC_URL: anvil.rpcUrl, ...opts.extraEnv }) would
      // let a caller-supplied opts.extraEnv.JINN_RPC_URL silently override the
      // fork RPC, breaking fork isolation. config.ts gives JINN_RPC_URL
      // unconditional precedence over BASE_RPC_URL/BASE_SEPOLIA_RPC_URL.
      extraEnv: { ...opts.extraEnv, JINN_RPC_URL: anvil.rpcUrl },
      readyTimeoutMs: 45000,
    });

    let torn = false;
    return {
      workspace,
      anvil,
      anvilRpcUrl: anvil.rpcUrl,
      daemons,
      teardown: async () => {
        if (torn) return;
        torn = true;
        await cleanup();
      },
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd client && yarn build && yarn vitest run test/release/tier-2/tier-2-helpers.test.ts`
Expected: tests pass if substrate exists; skip cleanly otherwise.

- [ ] **Step 5: Commit**

```bash
git add client/test/release/tier-2/tier-2-helpers.ts client/test/release/tier-2/tier-2-helpers.test.ts
git commit -m "test(release): add shared Tier 2 setup helper (substrate + fork + daemons)"
```

---

## Task 2: Ponder spawn helper

**Files:**
- Verify existence or create: `client/test/_support/indexer/ponder.ts`
- Test: `client/test/_support/indexer/ponder.test.ts`

T2.1 and T2.3 need an indexer running. T2.2 doesn't (it reads on-chain directly).

- [ ] **Step 1: Check for an existing helper**

Run: `find client -name "*ponder*" -type f 2>/dev/null | head -10`
Expected: either an existing helper file, or nothing.

If `client/test/_support/indexer/ponder.ts` (or similar) already exists, skip to Step 5 (verify its API matches what this plan assumes). If absent, continue Steps 2-4.

- [ ] **Step 2: Survey the indexer code to understand startup**

Run: `find . -path ./node_modules -prune -o -name "ponder.config.ts" -print 2>/dev/null | head -5`
Expected: a ponder config file (likely at `indexer/ponder.config.ts` or similar).

Run: `find . -path ./node_modules -prune -o -name "package.json" -print 2>/dev/null | xargs grep -l "ponder" 2>/dev/null | head -5`
Expected: package.json files referencing Ponder — these tell us the package layout.

The implementer should determine how Ponder is normally started (yarn script in the indexer package, etc.) before writing the helper.

- [ ] **Step 3: Write the failing test**

```typescript
// client/test/_support/indexer/ponder.test.ts
import { describe, it, expect } from 'vitest';
import { spawnPonderIndexer } from './ponder';

describe('spawnPonderIndexer', () => {
  it('starts a local Ponder pointed at a given RPC and shuts down cleanly', async () => {
    // Skip if Ponder package isn't present in the repo (e.g. monorepo subset).
    let indexer: Awaited<ReturnType<typeof spawnPonderIndexer>> | undefined;
    try {
      indexer = await spawnPonderIndexer({
        rpcUrl: 'http://127.0.0.1:8545',          // dummy; the test asserts startup, not E2E
        chainId: 84532,
        readyTimeoutMs: 30000,
      });
      expect(indexer.graphqlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/graphql$/);
      expect(indexer.port).toBeGreaterThan(0);
    } finally {
      if (indexer) await indexer.teardown();
    }
  }, 60000);

  it('teardown is idempotent', async () => {
    let indexer: Awaited<ReturnType<typeof spawnPonderIndexer>> | undefined;
    try {
      indexer = await spawnPonderIndexer({ rpcUrl: 'http://127.0.0.1:8545', chainId: 84532 });
    } catch {
      return;       // accept failure on environments without Ponder
    }
    await indexer.teardown();
    await expect(indexer.teardown()).resolves.toBeUndefined();
  }, 60000);
});
```

- [ ] **Step 4: Implement the spawn helper**

```typescript
// client/test/_support/indexer/ponder.ts
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as net from 'node:net';

export interface PonderHandle {
  graphqlUrl: string;
  port: number;
  process: ChildProcess;
  teardown: () => Promise<void>;
}

export interface SpawnPonderOptions {
  rpcUrl: string;
  chainId: number;
  port?: number;                       // default: random
  ponderRoot?: string;                 // default: resolve from repo root
  readyTimeoutMs?: number;             // default 30s
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForGraphql(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Ponder GraphQL at ${url} did not become reachable within ${timeoutMs}ms`);
}

export async function spawnPonderIndexer(opts: SpawnPonderOptions): Promise<PonderHandle> {
  const port = opts.port ?? (await pickFreePort());
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30000;
  // IMPLEMENTER: resolve the Ponder package root and the correct invocation.
  // Common shape (verify against this repo's actual layout):
  //   const ponderRoot = opts.ponderRoot ?? path.resolve(process.cwd(), '..', 'indexer');
  //   const args = ['dev', '--port', port.toString()];
  //   const env = { ...process.env, PONDER_RPC_URL_<chainId>: opts.rpcUrl };
  const ponderRoot = opts.ponderRoot ?? path.resolve(process.cwd(), '..', 'indexer');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [`PONDER_RPC_URL_${opts.chainId}`]: opts.rpcUrl,
  };
  const child = spawn('yarn', ['dev', '--port', port.toString()], {
    cwd: ponderRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const graphqlUrl = `http://127.0.0.1:${port}/graphql`;
  try {
    await waitForGraphql(graphqlUrl, readyTimeoutMs);
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
  let torn = false;
  return {
    graphqlUrl,
    port,
    process: child,
    teardown: async () => {
      if (torn) return;
      torn = true;
      try { child.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) { try { child.kill('SIGKILL'); } catch {} }
    },
  };
}
```

**NOTE TO IMPLEMENTER:** The `ponderRoot` and `args` resolution depends on this repo's actual indexer layout. The implementer should:
1. `cat <ponder-package>/package.json` to find the dev script.
2. Determine the correct env var name for the chain RPC (Ponder convention is `PONDER_RPC_URL_<chainId>`).
3. Adjust the spawn invocation to match.

If Ponder's dev mode is too slow for test invocation (warm-up + initial sync), consider a `start` mode against a pre-built artifact, or a separate test fixture.

- [ ] **Step 5: Run tests**

Run: `cd client && yarn vitest run test/_support/indexer/ponder.test.ts`
Expected: pass if Ponder is reachable, skip if not.

- [ ] **Step 6: Commit**

```bash
git add client/test/_support/indexer/ponder.ts client/test/_support/indexer/ponder.test.ts
git commit -m "test(_support): add Ponder spawn helper for Tier 2 scenarios"
```

---

## Task 3: Stubbed harness for T2.2

**Files:**
- Create: `client/src/harnesses/impls/stub.ts`
- Modify: `client/src/harnesses/impls/index.ts` (register conditionally)
- Test: `client/test/harnesses/stub.test.ts`

T2.2 needs a harness that returns a canned solution without calling any LLM. Gated by `JINN_HARNESS_STUB_INSTANCE=<instance-id>` env var.

- [ ] **Step 1: Survey the existing harness registry**

Run: `cat client/src/harnesses/impls/index.ts`
Expected: a `buildHarnesses(...)` function that returns a map/list of harness implementations. Read the existing harness shape (e.g. `claude-code-learner`, `codex-code-learner`, `hermes-agent`) to understand the interface.

The implementer should determine:
- What's the harness interface? (likely `{ name, isReady(), solve(taskSpec) }` or similar)
- How does `buildHarnesses` decide which to include?
- What does `solve()` return?

- [ ] **Step 2: Write the failing test**

```typescript
// client/test/harnesses/stub.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStubHarness } from '../../src/harnesses/impls/stub';

describe('stub harness', () => {
  let fixturesDir: string;

  beforeEach(async () => {
    fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stub-fixtures-'));
    await fs.writeFile(
      path.join(fixturesDir, 'known-instance.patch'),
      'diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+new\n',
    );
  });

  afterEach(async () => {
    await fs.rm(fixturesDir, { recursive: true, force: true });
  });

  it('returns the canned patch when instance matches', async () => {
    const harness = createStubHarness({ fixturesDir, instanceMatcher: 'known-instance' });
    expect(harness.name).toBe('harness:stub');
    const result = await harness.solve({ instanceId: 'known-instance', repo: 'r', commit: 'c' });
    expect(result.patch).toContain('diff --git a/foo.py');
  });

  it('throws when instance does not match', async () => {
    const harness = createStubHarness({ fixturesDir, instanceMatcher: 'known-instance' });
    await expect(harness.solve({ instanceId: 'other-instance', repo: 'r', commit: 'c' })).rejects.toThrow(/does not match/);
  });

  it('reports ready', async () => {
    const harness = createStubHarness({ fixturesDir, instanceMatcher: 'known-instance' });
    const ready = await harness.isReady();
    expect(ready.ready).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd client && yarn vitest run test/harnesses/stub.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the stub harness**

**NOTE (added from PR #352 execution):** Plan D's original code below shows a simplified `StubHarness` interface (`{ name, isReady, solve }`). The real `Harness` interface at `client/src/harnesses/types.ts` is richer: `name`, `version`, `supports(ctx)`, `prepare()`, `solve(...)`, etc. The executing session adopted the real interface (Path A — implement against what exists) rather than bridging. Use the real `Harness` interface; the simplified shape below is conceptual.

```typescript
// client/src/harnesses/impls/stub.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface StubHarnessOptions {
  fixturesDir: string;                 // where to look for <instanceMatcher>.patch
  instanceMatcher: string;             // instance ID this stub will respond to
}

interface SolveTaskSpec {
  instanceId: string;
  repo: string;
  commit: string;
}

interface SolveResult {
  patch: string;
  envelope?: Record<string, unknown>;
}

interface ReadinessReport {
  name: string;
  ready: boolean;
  requirements: string[];
  reasons: string[];
}

export interface StubHarness {
  name: string;
  isReady: () => Promise<ReadinessReport>;
  solve: (taskSpec: SolveTaskSpec) => Promise<SolveResult>;
}

export function createStubHarness(opts: StubHarnessOptions): StubHarness {
  return {
    name: 'harness:stub',
    async isReady() {
      return { name: 'harness:stub', ready: true, requirements: [], reasons: [] };
    },
    async solve(taskSpec) {
      if (taskSpec.instanceId !== opts.instanceMatcher) {
        throw new Error(`stub harness: taskSpec.instanceId=${taskSpec.instanceId} does not match configured instanceMatcher=${opts.instanceMatcher}`);
      }
      const patchPath = path.join(opts.fixturesDir, `${opts.instanceMatcher}.patch`);
      const patch = await fs.readFile(patchPath, 'utf-8');
      return { patch };
    },
  };
}

/**
 * Activated when env JINN_HARNESS_STUB_INSTANCE is set. Reads
 * fixtures from JINN_HARNESS_STUB_FIXTURES_DIR (default:
 * <repo>/client/test/release/tier-2/fixtures).
 */
export function maybeCreateStubHarnessFromEnv(): StubHarness | null {
  const instanceMatcher = process.env['JINN_HARNESS_STUB_INSTANCE'];
  if (!instanceMatcher) return null;
  const fixturesDir = process.env['JINN_HARNESS_STUB_FIXTURES_DIR']
    ?? path.resolve(process.cwd(), 'test', 'release', 'tier-2', 'fixtures');
  return createStubHarness({ instanceMatcher, fixturesDir });
}
```

- [ ] **Step 5: Wire into the harness registry**

Open `client/src/harnesses/impls/index.ts`. Add to the `buildHarnesses(...)` function (or equivalent shape):

```typescript
import { maybeCreateStubHarnessFromEnv } from './stub';

// Inside buildHarnesses(...), after registering production harnesses:
const stub = maybeCreateStubHarnessFromEnv();
if (stub) {
  harnesses.push(stub);   // or whatever the registry shape uses
}
```

**IMPLEMENTER:** Adjust the integration to match the actual registry shape. The principle: when `JINN_HARNESS_STUB_INSTANCE` is set, the stub harness is available alongside (or replacing — TBD by registry shape) the production ones.

- [ ] **Step 6: Run tests**

Run: `cd client && yarn vitest run test/harnesses/stub.test.ts`
Expected: PASS, 3 tests passing.

- [ ] **Step 7: Commit**

```bash
git add client/src/harnesses/impls/stub.ts client/src/harnesses/impls/index.ts client/test/harnesses/stub.test.ts
git commit -m "feat(harnesses): add env-gated stub harness for T2.2 producer/evaluator gate"
```

---

## Task 4: SWE-rebench v2 fixture for T2.2

**Files:**
- Create: `client/test/release/tier-2/fixtures/known-instance.ts`
- Create: `client/test/release/tier-2/fixtures/<INSTANCE_ID>.patch`

T2.2 needs a known-solvable SWE-rebench v2 instance: a real instance ID, a canned patch that applies cleanly, and an expected verdict outcome.

- [ ] **Step 1: Pick a known-solvable instance**

The simplest path: reuse the same instance the v0.1.6 A3 verification used — `sympy__sympy-27510` (the one Op A solved with `verdictCode=1`). Its solution patch and applied state are recorded in the v0.1.6 stewardship log.

Run: `grep -r "sympy__sympy-27510" log/decisions/ 2>/dev/null | head -5`
Expected: references in the v0.1.6 stewardship log with solution CIDs.

If those CIDs are still pinned on IPFS, the canned patch can be retrieved from there. Otherwise, the implementer picks a different instance from the SWE-rebench v2 admission pool and runs the existing harness once locally to obtain a verified-good patch.

- [ ] **Step 2: Write the fixture constants**

```typescript
// client/test/release/tier-2/fixtures/known-instance.ts

/**
 * Fixture: a known-solvable SWE-rebench v2 instance for T2.2.
 *
 * Selection criteria:
 *   - Currently admitted to the SWE-rebench v2 pool (verdict-time recheck won't reject it).
 *   - Small repo, fast clone.
 *   - Has a known-good solution patch that produces `verdictCode=1` against the
 *     evaluator's Docker image at the digest pinned in client/src/eval/admission.
 *
 * If the SWE-rebench pool rebuild invalidates this instance, replace it with
 * another admitted instance + its patch. See `<instance-id>.patch` next to this file.
 */

export const KNOWN_INSTANCE_ID = 'sympy__sympy-27510';
export const KNOWN_REPO = 'sympy/sympy';
export const KNOWN_COMMIT = 'PLACEHOLDER';            // implementer fills from v0.1.6 stewardship log
export const KNOWN_EXPECTED_VERDICT = 1;              // 1 = passed; 0 = failed
export const KNOWN_PATCH_FILE = `${KNOWN_INSTANCE_ID}.patch`;

/**
 * Manifest CID under which this instance was admitted (for cross-checks against
 * the SolverNet's manifest at runtime).
 */
export const KNOWN_MANIFEST_CID = 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';
```

**IMPLEMENTER:** Fill `KNOWN_COMMIT` from the v0.1.6 stewardship log (`log/decisions/2026-05-19-v0.1.6-stewardship.md` — A3 verification section). If the commit isn't recorded there, look up the instance in the SWE-rebench v2 admission manifest at runtime via the existing eval-substrate code.

- [ ] **Step 3: Write the patch file**

The patch file `<KNOWN_INSTANCE_ID>.patch` should be the actual unified-diff text that was verified to produce `verdictCode=1` during the v0.1.6 A3 verification.

Path: `client/test/release/tier-2/fixtures/sympy__sympy-27510.patch`

**IMPLEMENTER:** Retrieve the patch via:
1. The solution-CID IPFS pin from the v0.1.6 stewardship log (recorded in `log/decisions/`). The envelope contains the patch in its trajectory.
2. Or, re-run the harness once against the known instance to produce a fresh patch, then commit it.

The file should be exactly the patch text — no JSON wrapping, no envelope. The stub harness reads it raw and the daemon's delivery flow wraps it in the standard envelope.

If the patch is large (>50KB), commit it but flag in a comment that it's a fixture and shouldn't be edited.

- [ ] **Step 4: Commit**

```bash
git add client/test/release/tier-2/fixtures/known-instance.ts client/test/release/tier-2/fixtures/sympy__sympy-27510.patch
git commit -m "test(release): add SWE-rebench v2 fixture instance + canned solution for T2.2"
```

---

## Task 5: T2.1 — cross-operator donation

**Files:**
- Create: `client/test/release/tier-2/T2.1-cross-op-donation.ts`

**NOTE (added from PR #352 execution):** The endpoints `/v1/corpus/produce`, `/v1/corpus/:cid`, `/v1/corpus/:cid/pay`, `/v1/discovery/corpus` do NOT exist in the v0.1.6 daemon — they were speculative in Plan B's scenario doc. The executing session implemented T2.1 with a **skip-on-prereq** pattern: probe for endpoint existence first; if missing, return `verdict: 'skip'` with a `failNotes` referencing the GH issue tracking the gap. **GH issue #349** filed for the missing endpoints. T2.1 will activate once those endpoints land. Adapt the code below to use the skip-on-prereq pattern (probe the endpoint with a HEAD request or a minimal POST; if 404, skip).

**What this scenario does:** Per the contract in `.claude/skills/testing-jinn-app/references/scenario-cross-op-donation.md` (Plan B): op-a produces a corpus artifact, indexer attributes it, op-b queries via Discovery API (returns 402), op-b pays x402, op-b retrieves (returns 200 with valid payload + ERC-8128 signature).

- [ ] **Step 1: Survey the existing x402 test pattern**

Run: `cat client/test/x402-corpus-read-twoop.e2e.test.ts | head -100`
Expected: existing two-op corpus-read pattern. Note the daemon API endpoints used, the payment flow, the assertion shape.

The implementer's job: adapt this pattern to T2.1's substrate-workspace + Anvil-fork setup (using `setupTier2Scenario` from Task 1) and to emit a `ScenarioVerdict`.

- [ ] **Step 2: Write the scenario callable + Vitest wrapper**

```typescript
// client/test/release/tier-2/T2.1-cross-op-donation.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setupTier2Scenario, type Tier2Handle } from './tier-2-helpers';
import { spawnPonderIndexer } from '../../_support/indexer/ponder';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types';

const SAMPLE_PAYLOAD = {
  kind: 'corpus-read',
  topic: 'T2.1-fixture',
  body: 'donation-scenario-fixture-payload',
  ts: Date.now(),
};

async function waitFor<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 2000;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor${opts.label ? ` (${opts.label})` : ''} timed out after ${opts.timeoutMs}ms`);
}

export async function runT21CrossOpDonation(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string) => evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);

  let handle: Tier2Handle | null = null;
  let indexer: Awaited<ReturnType<typeof spawnPonderIndexer>> | null = null;

  try {
    log('1. setup substrate workspace + fork + daemons');
    handle = await setupTier2Scenario({ scenarioId: 'T2.1', portBase: 7750 });
    log(`   workspace: ${handle.workspace.workspaceRoot}`);
    log(`   anvil: ${handle.anvilRpcUrl}`);

    log('2. spawn Ponder indexer against fork');
    indexer = await spawnPonderIndexer({ rpcUrl: handle.anvilRpcUrl, chainId: 84532, readyTimeoutMs: 45000 });
    log(`   indexer: ${indexer.graphqlUrl}`);

    const opAPort = handle.daemons.daemons['op-a'].apiPort;
    const opBPort = handle.daemons.daemons['op-b'].apiPort;

    log('3. op-a produces a corpus artifact');
    const produceRes = await fetch(`http://127.0.0.1:${opAPort}/v1/corpus/produce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SAMPLE_PAYLOAD),
    });
    if (!produceRes.ok) {
      throw new Error(`/v1/corpus/produce returned ${produceRes.status}: ${await produceRes.text()}`);
    }
    const produced = await produceRes.json() as { artifactCid: string };
    log(`   artifact CID: ${produced.artifactCid}`);

    log('4. wait for indexer attribution');
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${opBPort}/v1/discovery/corpus?cid=${produced.artifactCid}`);
      if (!r.ok) return null;
      const body = await r.json() as { cid?: string };
      return body.cid === produced.artifactCid ? body : null;
    }, { timeoutMs: 60000, label: 'indexer-attribution' });
    log('   indexer saw the artifact');

    log('5. op-b unpaid query — expect 402');
    const previewRes = await fetch(`http://127.0.0.1:${opBPort}/v1/corpus/${produced.artifactCid}`);
    if (previewRes.status !== 402) {
      throw new Error(`expected 402 (payment required) for unpaid query, got ${previewRes.status}`);
    }
    log('   correctly gated');

    log('6. op-b pays x402');
    const payRes = await fetch(`http://127.0.0.1:${opBPort}/v1/corpus/${produced.artifactCid}/pay`, {
      method: 'POST',
    });
    if (!payRes.ok) {
      throw new Error(`/v1/corpus/${produced.artifactCid}/pay returned ${payRes.status}`);
    }
    const paid = await payRes.json() as { paymentTx?: string };
    if (!paid.paymentTx || !/^0x[a-fA-F0-9]{64}$/.test(paid.paymentTx)) {
      throw new Error(`expected paymentTx hash, got ${JSON.stringify(paid)}`);
    }
    log(`   payment tx: ${paid.paymentTx}`);

    log('7. op-b retrieves with payment proof');
    const retrievedRes = await fetch(`http://127.0.0.1:${opBPort}/v1/corpus/${produced.artifactCid}`, {
      headers: { 'x-x402-payment': paid.paymentTx },
    });
    if (retrievedRes.status !== 200) {
      throw new Error(`expected 200 for paid retrieval, got ${retrievedRes.status}`);
    }
    const retrieved = await retrievedRes.json() as { payload?: typeof SAMPLE_PAYLOAD; signature?: unknown };
    if (!retrieved.payload || retrieved.payload.body !== SAMPLE_PAYLOAD.body) {
      throw new Error('retrieved payload does not match what was produced');
    }
    if (!retrieved.signature) {
      throw new Error('retrieved artifact has no signature field');
    }
    log('   payload + signature match');

    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T2.1',
      verdict: 'pass',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: null,
      failNotes: null,
    };
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T2.1',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: classifyFailure(err),
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (indexer) { try { await indexer.teardown(); } catch {} }
    if (handle) { try { await handle.teardown(); } catch {} }
  }
}

describe('T2.1 cross-op-donation', () => {
  it('returns pass when full producer-consumer handshake closes', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T2.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T2.1.log');
    try {
      const verdict = await runT21CrossOpDonation({ evidencePath, wallClockBudgetMs: 5 * 60 * 1000 });
      // If skip (Ponder unavailable), accept. Otherwise expect pass.
      expect(['pass', 'fail', 'skip']).toContain(verdict.verdict);
      if (verdict.verdict === 'fail') {
        console.error('T2.1 failed:', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 6 * 60 * 1000);
});
```

**IMPLEMENTER:** The exact daemon API endpoint shapes (`/v1/corpus/produce`, `/v1/corpus/:cid`, `/v1/corpus/:cid/pay`) need to match what the daemon actually exposes in v0.1.6. Read `client/src/api/server.ts` (and any route definitions) to confirm. If the endpoint paths differ, update the test to match the real surface. If the endpoints don't exist at all (the scenario was written speculatively), file a GH issue and mark T2.1 as skip in this Tier; the proper fix is to add the endpoints in a follow-up.

- [ ] **Step 3: Run the test**

Run: `cd client && yarn build && yarn vitest run test/release/tier-2/T2.1-cross-op-donation.ts`
Expected: pass if substrate + Ponder + daemon endpoints all align; fail with structured verdict otherwise (no test assertion failure).

- [ ] **Step 4: Commit**

```bash
git add client/test/release/tier-2/T2.1-cross-op-donation.ts
git commit -m "feat(release): add T2.1 cross-op donation scenario"
```

---

## Task 6: T2.2 — producer/evaluator on Anvil-fork

**Files:**
- Create: `client/test/release/tier-2/T2.2-producer-evaluator.ts`

**NOTE (added from PR #352 execution):** Same skip-on-prereq pattern as Task 5. The endpoints `/v1/tasks` (POST), `/v1/tasks/:id`, `/v1/verdicts`, `/v1/activity` don't all exist in v0.1.6 in the shapes assumed here. **GH issue #350** filed for the missing endpoints. T2.2 returns `verdict: 'skip'` until the endpoints land. Adapt the code below to probe + skip on 404.

**What this scenario does:** Per `.claude/skills/testing-jinn-app/references/scenario-producer-evaluator.md`: op-a posts a known-solvable SWE-rebench v2 task, claims, solves via the stubbed harness, delivers; op-b claims the verdict request, runs the real evaluator Docker image, posts verdict. Assert `verdictCode === KNOWN_EXPECTED_VERDICT`. Activity counters increment.

- [ ] **Step 1: Write the scenario callable + Vitest wrapper**

```typescript
// client/test/release/tier-2/T2.2-producer-evaluator.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setupTier2Scenario, type Tier2Handle } from './tier-2-helpers';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types';
import {
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
  KNOWN_COMMIT,
  KNOWN_EXPECTED_VERDICT,
} from './fixtures/known-instance';

async function waitFor<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 2000;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor${opts.label ? ` (${opts.label})` : ''} timed out after ${opts.timeoutMs}ms`);
}

export async function runT22ProducerEvaluator(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string) => evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);

  let handle: Tier2Handle | null = null;

  try {
    log('1. setup substrate workspace + fork + daemons (with stub harness env)');
    const fixturesDir = path.resolve(__dirname, 'fixtures');
    handle = await setupTier2Scenario({
      scenarioId: 'T2.2',
      portBase: 7752,
      extraEnv: {
        JINN_HARNESS_STUB_INSTANCE: KNOWN_INSTANCE_ID,
        JINN_HARNESS_STUB_FIXTURES_DIR: fixturesDir,
      },
    });
    log(`   workspace: ${handle.workspace.workspaceRoot}`);
    log(`   anvil: ${handle.anvilRpcUrl}`);

    const opAPort = handle.daemons.daemons['op-a'].apiPort;
    const opBPort = handle.daemons.daemons['op-b'].apiPort;

    log('2. op-a posts a known-solvable task');
    const postRes = await fetch(`http://127.0.0.1:${opAPort}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        solverType: 'swe-rebench-v2.v1',
        spec: { instanceId: KNOWN_INSTANCE_ID, repo: KNOWN_REPO, commit: KNOWN_COMMIT },
      }),
    });
    if (!postRes.ok) throw new Error(`/v1/tasks returned ${postRes.status}: ${await postRes.text()}`);
    const posted = await postRes.json() as { taskId: string; requestId: string };
    log(`   taskId: ${posted.taskId}, requestId: ${posted.requestId}`);

    log('3. wait for op-a to claim + solve (stubbed) + deliver');
    const delivered = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${opAPort}/v1/tasks/${posted.taskId}`);
      if (!r.ok) return null;
      const body = await r.json() as { state?: string; deliveryTxHash?: string };
      return body.state === 'DELIVERED' && body.deliveryTxHash ? body : null;
    }, { timeoutMs: 90000, label: 'op-a-delivery' });
    log(`   deliveryTx: ${delivered.deliveryTxHash}`);

    log('4. wait for op-b to claim verdict request, run evaluator, post verdict');
    const verdict = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${opBPort}/v1/verdicts?taskId=${posted.taskId}`);
      if (!r.ok) return null;
      const body = await r.json() as { verdicts?: Array<{ verdictCode: number; verdictTxHash?: string }> };
      return body.verdicts && body.verdicts.length > 0 ? body.verdicts[0] : null;
    }, { timeoutMs: 120000, label: 'op-b-verdict' });
    log(`   verdictCode: ${verdict.verdictCode}, verdictTx: ${verdict.verdictTxHash}`);

    log('5. assert verdict matches expected');
    if (verdict.verdictCode !== KNOWN_EXPECTED_VERDICT) {
      throw new Error(`expected verdictCode=${KNOWN_EXPECTED_VERDICT}, got ${verdict.verdictCode}`);
    }

    log('6. assert activity counters incremented');
    const opAActivity = await fetch(`http://127.0.0.1:${opAPort}/v1/activity`).then((r) => r.json()) as { deliveriesCount?: number };
    if (!opAActivity.deliveriesCount || opAActivity.deliveriesCount < 1) {
      throw new Error(`op-a deliveriesCount expected >= 1, got ${opAActivity.deliveriesCount}`);
    }
    const opBActivity = await fetch(`http://127.0.0.1:${opBPort}/v1/activity`).then((r) => r.json()) as { verdictsCount?: number };
    if (!opBActivity.verdictsCount || opBActivity.verdictsCount < 1) {
      throw new Error(`op-b verdictsCount expected >= 1, got ${opBActivity.verdictsCount}`);
    }
    log('   activity counters correct');

    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T2.2',
      verdict: 'pass',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: null,
      failNotes: null,
    };
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T2.2',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: classifyFailure(err),
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (handle) { try { await handle.teardown(); } catch {} }
  }
}

describe('T2.2 producer-evaluator', () => {
  it('returns a structured verdict (pass/fail/skip)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T2.2-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T2.2.log');
    try {
      const verdict = await runT22ProducerEvaluator({ evidencePath, wallClockBudgetMs: 5 * 60 * 1000 });
      expect(['pass', 'fail', 'skip']).toContain(verdict.verdict);
      if (verdict.verdict === 'fail') {
        console.error('T2.2 failed:', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 6 * 60 * 1000);
});
```

**IMPLEMENTER:** The endpoints (`/v1/tasks`, `/v1/tasks/:id`, `/v1/verdicts`, `/v1/activity`) must match the real daemon surface in v0.1.6. Verify against `client/src/api/server.ts`. If a route doesn't exist, surface as a follow-up GH issue and mark T2.2 as skip; the test can't run without those routes.

- [ ] **Step 2: Run the test**

Run: `cd client && yarn build && yarn vitest run test/release/tier-2/T2.2-producer-evaluator.ts`
Expected: pass if substrate + fork + stub + endpoints + Docker evaluator all align.

- [ ] **Step 3: Commit**

```bash
git add client/test/release/tier-2/T2.2-producer-evaluator.ts
git commit -m "feat(release): add T2.2 producer-evaluator Anvil-fork scenario"
```

---

## Task 7: Playwright fixture for two-substrate-ops

**Files:**
- Create: `client/test/dashboard/multi-op/fixtures/two-substrate-ops.ts`

Shared Playwright fixture used by T2.3 (and future multi-op SPA tests). Wraps the `setupTier2Scenario` helper into the Playwright test-extend pattern.

- [ ] **Step 1: Implement the fixture**

```typescript
// client/test/dashboard/multi-op/fixtures/two-substrate-ops.ts
import { test as base } from '@playwright/test';
import { setupTier2Scenario, type Tier2Handle } from '../../../release/tier-2/tier-2-helpers';

interface TwoSubstrateOpsFixtures {
  tier2: Tier2Handle;
  opAUrl: string;
  opBUrl: string;
}

export const test = base.extend<TwoSubstrateOpsFixtures>({
  tier2: async ({}, use, testInfo) => {
    const handle = await setupTier2Scenario({
      scenarioId: testInfo.titlePath.join('-').replace(/[^a-zA-Z0-9-]/g, '_'),
      portBase: 7754,
    });
    try {
      await use(handle);
    } finally {
      await handle.teardown();
    }
  },
  opAUrl: async ({ tier2 }, use) => {
    const url = tier2.daemons.daemons['op-a'].handshakeUrl ?? `http://127.0.0.1:${tier2.daemons.daemons['op-a'].apiPort}/`;
    await use(url);
  },
  opBUrl: async ({ tier2 }, use) => {
    const url = tier2.daemons.daemons['op-b'].handshakeUrl ?? `http://127.0.0.1:${tier2.daemons.daemons['op-b'].apiPort}/`;
    await use(url);
  },
});

export { expect } from '@playwright/test';
```

- [ ] **Step 2: Commit**

```bash
git add client/test/dashboard/multi-op/fixtures/two-substrate-ops.ts
git commit -m "test(multi-op): add Playwright fixture for two-substrate-ops"
```

---

## Task 8: T2.3 — multi-op SPA flow

**Files:**
- Create: `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts`

Per Plan B's `scenario-multi-op-spa-flow.md`: op-a launches a SolverNet via the SPA Launcher Create wizard. op-b sees it appear in the Operator catalog. op-b joins via the SPA. op-a's launched dashboard shows "1 operator joined."

- [ ] **Step 1: Write the test**

```typescript
// client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts
import { test, expect } from './fixtures/two-substrate-ops';

test('T2.3 — op-a launches, op-b joins, both observe each other', async ({ browser, opAUrl, opBUrl }) => {
  test.setTimeout(5 * 60 * 1000);

  const opACtx = await browser.newContext();
  const opBCtx = await browser.newContext();
  const opAPage = await opACtx.newPage();
  const opBPage = await opBCtx.newPage();

  try {
    // ===== op-a: Launcher Create wizard =====
    await opAPage.goto(opAUrl);
    await opAPage.getByRole('link', { name: /launcher/i }).click();
    await opAPage.getByRole('button', { name: /create solvernet/i }).click();

    const solverNetName = `t23-${Date.now()}`;

    // Step 1: Define
    await opAPage.getByLabel(/name/i).fill(solverNetName);
    await opAPage.getByLabel(/description/i).fill('T2.3 e2e test SolverNet');
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 2: Review Contract
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 3: Configure Generator
    await opAPage.getByLabel(/cadence/i).fill('60000');
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 4: Configure Pricing
    await opAPage.getByLabel(/price/i).fill('100');
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 5: Review and Launch
    await opAPage.getByRole('button', { name: /launch/i }).click();

    // Wait for state machine to reach 'launched'
    await expect(opAPage.getByText(/launched/i).first()).toBeVisible({ timeout: 120000 });
    const manifestCid = await opAPage.getByTestId('manifest-cid').textContent({ timeout: 10000 });
    expect(manifestCid).toMatch(/^bafkrei/);

    // ===== op-b: Catalog sees op-a's SolverNet =====
    await opBPage.goto(opBUrl);
    await opBPage.getByRole('link', { name: /operator/i }).click();
    await opBPage.getByRole('button', { name: /browse catalog/i }).click();

    // Allow indexer + SPA polling lag (~30s).
    await expect(opBPage.getByText(solverNetName)).toBeVisible({ timeout: 60000 });

    // ===== op-b joins =====
    await opBPage.getByText(solverNetName).click();
    await opBPage.getByRole('button', { name: /^join$/i }).click();
    await expect(opBPage.getByText(/restart required/i)).toBeVisible({ timeout: 10000 });

    // ===== op-a sees op-b's join =====
    await opAPage.goto(`${opAUrl}/launcher/launched`);
    await opAPage.getByText(solverNetName).click();
    await expect(opAPage.getByTestId('operator-count')).toHaveText(/1/, { timeout: 60000 });
  } finally {
    await opACtx.close();
    await opBCtx.close();
  }
});
```

- [ ] **Step 2: Run the test**

Run: `cd client && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/multi-op/launcher-join-flow.e2e.test.ts`
Expected: PASS, or fail with a specific selector — in which case Task 9 (SPA test-id additions) is needed.

If the test passes without Task 9 because semantic queries are sufficient, mark Task 9 as skipped.

- [ ] **Step 3: Commit**

```bash
git add client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts
git commit -m "feat(release): add T2.3 multi-op SPA flow Playwright test"
```

---

## Task 9: SPA test-id additions (conditional)

**Files (only if Task 8 failed on missing testids):**
- Modify: `client/src/dashboard/spa/src/pages/LauncherLaunched.tsx` (or wherever manifest-cid + operator-count are rendered)
- Test: `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts` re-run to verify

The T2.3 test references `data-testid="manifest-cid"` and `data-testid="operator-count"`. If these don't exist on the launched-SolverNet dashboard, add them.

**NOTE (added from PR #352 execution):**
- `manifest-cid` was added cleanly — it aliases existing manifest data.
- `operator-count` was NOT added: the launched-record data shape doesn't include operator-join counts yet. The session deliberately filed **GH issue #351** instead of speculatively wiring a data path that doesn't exist. T2.3 currently asserts on `manifest-cid` only and skips the "1 operator joined" assertion until #351 is resolved.

- [ ] **Step 1: Find the launched-SolverNet dashboard component**

Run: `find client/src/dashboard/spa -name "LauncherLaunched*" -o -name "*Launched*" 2>/dev/null | head -5`
Expected: the component file(s) for the launched-SolverNet dashboard.

Run: `grep -rn "manifest-cid\|operator-count\|data-testid" client/src/dashboard/spa/src/pages 2>/dev/null | head -10`
Expected: any existing test-ids on the page.

- [ ] **Step 2: Add test-ids**

Find the JSX element that renders the manifest CID. Add `data-testid="manifest-cid"`:

```tsx
<span data-testid="manifest-cid">{launchedRecord.manifestCid}</span>
```

Find the element that renders the operator count (e.g. "1 operator joined"). Add `data-testid="operator-count"` to the element holding the count number:

```tsx
<span data-testid="operator-count">{joinedOperators.length}</span>
```

These should be additive — don't change existing markup or accessibility.

- [ ] **Step 3: Re-run T2.3**

Run: `cd client && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/multi-op/launcher-join-flow.e2e.test.ts`
Expected: PASS now that test-ids exist.

- [ ] **Step 4: Commit (if any changes were needed)**

```bash
git add client/src/dashboard/spa/src/pages/LauncherLaunched.tsx
git commit -m "ui(launcher): add data-testid attributes for T2.3 cross-op visibility test"
```

If Task 8 passed without changes, mark this task as skipped (no commit).

---

## Task 10: run-tier-2.ts orchestrator

**Files:**
- Create: `client/scripts/release/run-tier-2.ts`

Mirrors Plan C's `run-tier-1.ts` shape. 2 callable scenarios + 1 Playwright subprocess.

- [ ] **Step 1: Implement the orchestrator**

```typescript
// client/scripts/release/run-tier-2.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runT21CrossOpDonation } from '../../test/release/tier-2/T2.1-cross-op-donation';
import { runT22ProducerEvaluator } from '../../test/release/tier-2/T2.2-producer-evaluator';
import { type ScenarioVerdict, ScenarioVerdictSchema, classifyFailure } from './scenario-types';

interface RunOptions {
  outputDir?: string;
  candidateVersion?: string;
}

async function runT23MultiOpSpaFlow(outputDir: string): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidencePath = path.join(outputDir, 'T2.3.log');
  return new Promise<ScenarioVerdict>((resolve) => {
    const child = spawn(
      'yarn',
      [
        'playwright',
        'test',
        '--config=playwright.config.ts',
        'test/dashboard/multi-op/launcher-join-flow.e2e.test.ts',
        '--reporter=line',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', async (code) => {
      await fs.writeFile(evidencePath, `=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}\n=== exit code ===\n${code}\n`);
      resolve({
        scenarioId: 'T2.3',
        verdict: code === 0 ? 'pass' : 'fail',
        wallClockMs: Date.now() - started,
        evidencePath,
        failClass: code === 0 ? null : classifyFailure(new Error(stderr || stdout)),
        failNotes: code === 0 ? null : `Playwright exited ${code}`,
      });
    });
  });
}

export async function runTier2(opts: RunOptions = {}): Promise<{ verdicts: ScenarioVerdict[]; allPassed: boolean }> {
  const outputDir = opts.outputDir ?? path.join(
    process.cwd(),
    'tier-2-evidence',
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  );
  await fs.mkdir(outputDir, { recursive: true });

  // Run callable scenarios + Playwright in parallel
  const callablePromises = [
    runT21CrossOpDonation({ evidencePath: path.join(outputDir, 'T2.1.log'), wallClockBudgetMs: 5 * 60 * 1000 }),
    runT22ProducerEvaluator({ evidencePath: path.join(outputDir, 'T2.2.log'), wallClockBudgetMs: 5 * 60 * 1000 }),
  ];
  const playwrightPromise = runT23MultiOpSpaFlow(outputDir);

  const [t21Settled, t22Settled, t23] = await Promise.all([
    ...callablePromises.map((p) => p.catch((err) => ({
      __crashed: true,
      err,
    } as const))),
    playwrightPromise,
  ]) as [
    ScenarioVerdict | { __crashed: true; err: unknown },
    ScenarioVerdict | { __crashed: true; err: unknown },
    ScenarioVerdict,
  ];

  const toVerdict = (id: string, settled: ScenarioVerdict | { __crashed: true; err: unknown }, evidencePath: string): ScenarioVerdict => {
    if ('__crashed' in settled) {
      return {
        scenarioId: id,
        verdict: 'fail' as const,
        wallClockMs: 0,
        evidencePath,
        failClass: 'agent-crash' as const,
        failNotes: settled.err instanceof Error ? settled.err.message : String(settled.err),
      };
    }
    return settled;
  };

  const verdicts = [
    toVerdict('T2.1', t21Settled, path.join(outputDir, 'T2.1.log')),
    toVerdict('T2.2', t22Settled, path.join(outputDir, 'T2.2.log')),
    t23,
  ];

  for (const v of verdicts) ScenarioVerdictSchema.parse(v);

  const allPassed = verdicts.every((v) => v.verdict === 'pass');

  const summary = {
    candidateVersion: opts.candidateVersion ?? 'unknown',
    timestamp: new Date().toISOString(),
    verdicts,
    allPassed,
  };
  await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const markerLines = [
    '<!-- jinn-release-evidence:v1',
    `release-candidate=${opts.candidateVersion ?? 'unknown'}`,
    ...verdicts.map((v) => {
      const key = `tier-2-${v.scenarioId.toLowerCase().replace(/\./g, '-')}`;
      if (v.verdict === 'pass') return `${key}=passed`;
      if (v.verdict === 'skip') return `${key}=skipped:${v.failNotes ?? 'no-reason'}`;
      return `${key}=failed:${v.failClass}`;
    }),
    `tier-2-overall=${allPassed ? 'passed' : 'failed'}`,
    '-->',
  ];
  await fs.writeFile(path.join(outputDir, 'marker.txt'), markerLines.join('\n') + '\n');

  return { verdicts, allPassed };
}

async function cliMain(): Promise<void> {
  const candidateVersion = process.argv[2];
  const { verdicts, allPassed } = await runTier2({ candidateVersion });
  console.log(JSON.stringify({ verdicts, allPassed }, null, 2));
  const hasRealBug = verdicts.some((v) => v.verdict === 'fail' && v.failClass === 'real-bug');
  process.exit(hasRealBug ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error('run-tier-2 crashed:', err);
    process.exit(2);
  });
}
```

- [ ] **Step 2: Smoke test**

Run: `cd client && yarn build && tsx scripts/release/run-tier-2.ts v0.1.7-smoke`
Expected: orchestrator runs all three scenarios in parallel, prints structured verdicts, creates `tier-2-evidence/<timestamp>/`.

- [ ] **Step 3: Commit**

```bash
git add client/scripts/release/run-tier-2.ts
git commit -m "feat(release): add run-tier-2 orchestrator"
```

---

## Task 11: release-prep SKILL.md Tier 2 section update

**Files:**
- Modify: `.claude/skills/release-prep/SKILL.md`

Plan C left a Tier 2 placeholder pointing at `references/tier-2-scenarios.md`. Now that scenarios exist, update the Tier 2 table.

- [ ] **Step 1: Find the Tier 2 section in SKILL.md**

Run: `grep -n "Tier 2" .claude/skills/release-prep/SKILL.md`
Expected: section heading + table location.

- [ ] **Step 2: Update the Tier 2 section**

Replace:

```markdown
## Tier 2 scenarios

Detailed contracts: [`references/tier-2-scenarios.md`](references/tier-2-scenarios.md) (placeholder; expanded by Plan D)

Tier 2 implementations land in Plan D. release-prep's runner will be extended at that point to call a `run-tier-2.ts` orchestrator alongside `run-tier-1.ts`.
```

With:

```markdown
## Tier 2 scenarios

Detailed contracts: [`references/tier-2-scenarios.md`](references/tier-2-scenarios.md)

| ID | Name | Wall-clock budget |
|---|---|---|
| T2.1 | cross-operator-donation | 5min |
| T2.2 | producer-evaluator-anvil-fork | 5min |
| T2.3 | multi-op-spa-flow | 5min |

All three run in parallel against separate substrate workspaces. Wall-clock for the tier ≈ max of the budgets (~5min).

Tier 2 is invoked from release-readiness's Phase 5 (per spec §4). Standalone invocation:

```bash
yarn release:tier-2 <candidate-version>
```
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/release-prep/SKILL.md
git commit -m "docs(release-prep): replace Tier 2 placeholder with real budgets + invocation"
```

---

## Task 12: tier-2-scenarios.md full doc

**Files:**
- Modify (replace contents): `.claude/skills/release-prep/references/tier-2-scenarios.md`

- [ ] **Step 1: Replace the placeholder with full content**

Save:

```markdown
# Tier 2 scenarios

Three scenarios, all multi-operator, all running against substrate-derived workspaces with an Anvil-fork-of-Base-Sepolia RPC. Tier 2 is invoked by `release-prep` during release-readiness Phase 5; not on every push.

The "what does this scenario actually exercise" contracts live in `testing-jinn-app` (one doc per scenario, Plan B). The "how is it wired and what's the runtime shape" details are below.

## T2.1 — cross-operator-donation

**Catches:** x402 + ERC-8128 handshake regressions; corpus indexer attribution bugs; payment-gated artifact access bugs. Designed to catch the #310 class of silent failure.

**Contract:** [`testing-jinn-app/references/scenario-cross-op-donation.md`](../../testing-jinn-app/references/scenario-cross-op-donation.md)

**Implementation:** `client/test/release/tier-2/T2.1-cross-op-donation.ts`

**Wall-clock budget:** 5 minutes

**Prerequisites:**
- Substrate workspace via Plan A's `substrate-copy`.
- Local Ponder indexer (helper at `client/test/_support/indexer/ponder.ts`).
- Daemon endpoints: `/v1/corpus/produce`, `/v1/corpus/:cid`, `/v1/corpus/:cid/pay`, `/v1/discovery/corpus`.

## T2.2 — producer-evaluator-anvil-fork

**Catches:** Claim → solve → deliver → evaluate loop regressions; activity-counter incorrectness; verdict pipeline mechanics.

**Contract:** [`testing-jinn-app/references/scenario-producer-evaluator.md`](../../testing-jinn-app/references/scenario-producer-evaluator.md)

**Implementation:** `client/test/release/tier-2/T2.2-producer-evaluator.ts`

**Wall-clock budget:** 5 minutes

**Prerequisites:**
- Substrate workspace via Plan A's `substrate-copy`.
- Stubbed harness via `JINN_HARNESS_STUB_INSTANCE` env (Task 3).
- SWE-rebench v2 fixture at `client/test/release/tier-2/fixtures/` (Task 4).
- Daemon endpoints: `/v1/tasks`, `/v1/tasks/:id`, `/v1/verdicts`, `/v1/activity`.

## T2.3 — multi-op-spa-flow

**Catches:** Cross-op UI flows that pass with mocks but break with real daemons; SPA state synchronization; Launcher → Operator catalog visibility.

**Contract:** [`testing-jinn-app/references/scenario-multi-op-spa-flow.md`](../../testing-jinn-app/references/scenario-multi-op-spa-flow.md)

**Implementation:** `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts` (Playwright, invoked via subprocess from the orchestrator)

**Wall-clock budget:** 5 minutes

**Prerequisites:**
- Substrate workspace via Plan A's `substrate-copy`.
- SPA test-id attributes (`manifest-cid`, `operator-count`) — added in Task 9 if missing.
- The Playwright two-substrate-ops fixture at `client/test/dashboard/multi-op/fixtures/two-substrate-ops.ts`.

## Parallelism

All three scenarios run in parallel via `client/scripts/release/run-tier-2.ts`. Each gets its own:
- Substrate workspace (port-isolated daemons)
- Anvil fork
- Ponder indexer (T2.1, T2.3; T2.2 doesn't need it)

Total wall-clock at full parallelism ≈ max(scenario wall-clocks) ≈ 5 minutes.

## RPC budget

Tier 2 is the tier that historically saturates Tenderly (jinn-mono-lrey). The architectural fix is:
- Use substrate-derived workspaces (no re-bootstrap inside the gate).
- One Anvil fork per scenario; both daemons in a scenario share that fork.
- The fork lazy-fetches state from the upstream RPC, but workspace ops already have their identity state cached.

This should keep one Tier 2 run under the per-key rate limit. Concurrent Tier 2 runs (e.g. parallel CI workers) can still saturate. For now, run-tier-2 is single-instance.

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| Substrate stale | n/a | Block run, instruct re-adopt |
| Anvil fork lazy-fetch stalls | flake-infra | Retry once; if persistent, jinn-mono-lrey territory |
| Ponder spawn timeout | flake-infra (env) or real-bug (Ponder config) | Inspect Ponder logs |
| Daemon endpoint 4xx/5xx unrelated to scenario | real-bug | BLOCKING — API surface regression |
| Cross-op visibility lag exceeds budget | flake-timing | Retry once with extended timeout |
| Verdict mismatch in T2.2 | real-bug | BLOCKING — substrate/scoring regression |
| Playwright selector miss in T2.3 | real-bug | UI changed without test-id update |

## Invocation

```bash
# All three scenarios via the orchestrator
yarn release:tier-2 <candidate-version>

# Per-scenario standalone
yarn release:tier-2:T2.1
yarn release:tier-2:T2.2
yarn release:tier-2:T2.3
```

Output: `tier-2-evidence/<timestamp>/` with `summary.json`, `marker.txt`, per-scenario `.log` files.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/release-prep/references/tier-2-scenarios.md
git commit -m "docs(release-prep): replace tier-2-scenarios placeholder with full doc"
```

---

## Task 13: yarn scripts wiring

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Add the Tier 2 yarn scripts**

In `client/package.json`'s `scripts` object, add:

```json
{
  "scripts": {
    "release:tier-2": "tsx scripts/release/run-tier-2.ts",
    "release:tier-2:T2.1": "vitest run test/release/tier-2/T2.1-cross-op-donation.ts",
    "release:tier-2:T2.2": "vitest run test/release/tier-2/T2.2-producer-evaluator.ts",
    "release:tier-2:T2.3": "playwright test --config=playwright.config.ts test/dashboard/multi-op/launcher-join-flow.e2e.test.ts"
  }
}
```

- [ ] **Step 2: Verify the yarn scripts run**

Run: `cd client && yarn release:tier-2 v0.1.7-yarn-smoke 2>&1 | tail -20`
Expected: orchestrator executes; verdicts emitted (pass/fail/skip per scenario).

- [ ] **Step 3: Commit**

```bash
git add client/package.json
git commit -m "chore(release): wire yarn scripts for Tier 2"
```

---

## Task 14: End-to-end smoke + final verification

**Files:**
- None modified. This is a verification gate.

- [ ] **Step 1: Confirm Tier 2 prerequisites are present**

Run:
```bash
cd client
# Substrate
yarn substrate:verify op-a --skip-on-chain
yarn substrate:verify op-b --skip-on-chain

# Stub harness fixture
ls test/release/tier-2/fixtures/

# Ponder helper exists
ls test/_support/indexer/ponder.ts

# SPA test-ids (if Task 9 was needed)
grep "manifest-cid\|operator-count" src/dashboard/spa/src/pages/LauncherLaunched.tsx 2>/dev/null
```

Expected: all checks pass (or document gaps and skip the next step).

- [ ] **Step 2: Run full Tier 2 against a candidate**

Run: `cd client && BASE_SEPOLIA_RPC_URL=$BASE_SEPOLIA_RPC_URL yarn release:tier-2 v0.1.7-final-smoke`
Expected: orchestrator runs all three scenarios. At minimum, all three should return a structured verdict (pass/fail/skip with classification). Best case: all three pass.

If any scenario returns `fail:real-bug`, triage:
- T2.1 — is it the daemon API surface mismatch? File GH issue.
- T2.2 — is it the harness stub not being picked up? Debug the env wiring.
- T2.3 — is it a selector issue? Re-run Task 9 to add missing test-ids.

If any scenario returns `fail:flake-*`, re-run once. If persistent, file GH issue and document as known-flake.

- [ ] **Step 3: No commit unless gaps were found**

If gaps required additional commits (e.g. extra test-ids, env wiring fixes), they should land in their respective task commits. Final task is a verification gate.

---

## Self-review

### Spec coverage

| Spec requirement | Covered by | Status |
|---|---|---|
| §3 Tier 2 scenarios T2.1-T2.3 | Tasks 5, 6, 8 | ✓ |
| §3 run-tier-2 orchestrator | Task 10 | ✓ |
| §3 release-prep Tier 2 documentation | Tasks 11, 12 | ✓ |
| §6 stubbed harness for T2.2 | Task 3 | ✓ |
| §6 SWE-rebench fixture | Task 4 | ✓ |
| §6 Ponder spawn helper | Task 2 | ✓ |
| §6 shared Tier 2 setup helper | Task 1 | ✓ |
| §6 Playwright two-substrate-ops fixture | Task 7 | ✓ |
| Plan B fold-back: SPA test-ids referenced | Task 9 (conditional) | ✓ |

### Placeholder scan

- Task 2 (Ponder helper) has implementer notes for repo-specific spawn invocation — necessary because the exact Ponder package layout depends on the monorepo structure. Acceptable.
- Task 3 (stub harness) has implementer notes for the registry integration — necessary because the harness registry shape needs verification. Acceptable.
- Task 4 (SWE-rebench fixture) has `KNOWN_COMMIT: 'PLACEHOLDER'` — explicit instruction for the implementer to fill from the v0.1.6 stewardship log. Acceptable as it's a fixture data point, not a code placeholder.
- All other tasks have complete code.

### Type consistency

- `ScenarioVerdict` consistent across Tasks 5, 6, 8 (returned by all three scenarios).
- `Tier2Handle` defined in Task 1 used by Tasks 5, 6, 7.
- `setupTier2Scenario(opts)` signature consistent in Tasks 1, 5, 6, 7.
- Yarn script names (`release:tier-2`, `release:tier-2:T2.1`, ...) consistent with Plan C's Tier 1 naming.

### Cross-plan contract check

This plan consumes from Plan A: `substrate-copy`, `substrate-paths`, `substrate-verify`. Cross-verified.
This plan consumes from Plan B: `multi-op-daemon`, `handshake-url`. Cross-verified.
This plan consumes from Plan C: `scenario-types`, the `release-prep` SKILL.md scaffolding, `run-tier-1.ts` as the structural model for `run-tier-2.ts`. Cross-verified.

This plan promises Plan E:
- A working Tier 2 invocation via `yarn release:tier-2 <version>` that emits structured verdicts.
- An extended `release-prep` skill with both tiers populated.
- Plan E's `release-readiness` skill can invoke release-prep as a subagent and consume the verdicts.

### Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-tier-2-scenarios-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task. 14 tasks; subagent-driven works well here because adapter code (daemon API endpoints, harness registry shape) varies and per-task review catches misadaptations.

2. **Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`. Less robust given the adapter-heavy code in this plan; subagent review is more valuable here than for Plan A.

Plan D depends on:
- **Plan A merged** — substrate scripts must be on `next` (or merged into Plan D's branch) for runtime.
- **Plan B merged** — multi-op-daemon + handshake-url must be importable.
- **Plan C merged or branch-stacked** — scenario-types, release-prep skill scaffolding.

If Plans A/B/C haven't merged yet, dispatch Plan D against a branch that's already stacked on top of all three (analogous to Plan C being stacked on Plan B). The dispatched session should first `git merge` the prerequisite branches before starting Task 1.

Which approach?
