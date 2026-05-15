# Per-harness auth (`vh74.2`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the daemon-level Claude auth gate; replace with a per-harness `Harness.isReady()` composition that gates claim loops (not daemon lifetime) and surfaces in the operator dashboard via a generalized precheck panel.

**Architecture:** Two stages of stacked PRs. **Stage A** adds the foundation (registry + endpoints + per-Claude `isReady()` impl + Onboarding reshape) and removes the global gate — works against current `main`. **Stage B** generalizes the Hermes-pioneered `HermesPrecheckPanel` / `/api/hermes/doctor` shapes once the Hermes PR chain (#140-#145) lands in main. Within each stage, TDD: regression test first, implementation second, verify, commit.

**Tech Stack:** TypeScript daemon (Node 22, Hono HTTP, viem RPC), React SPA (react-query + Vite), Vitest tests, ESM live-bindings for `vi.spyOn` test seams.

**Spec:** [`docs/superpowers/specs/2026-05-15-per-harness-auth-design.md`](../specs/2026-05-15-per-harness-auth-design.md)

---

## File structure

### Created in Stage A

- `client/src/harnesses/readiness-registry.ts` — `HarnessReadinessRegistry` class: composes `Harness.isReady()` results per `joinedSolverNets[<cid>].harness`, caches a snapshot, exposes `getSnapshot()` + `isReadyForClaim(manifestCid)`, owns a background refresh interval.
- `client/src/api/harness-readiness-endpoint.ts` — registers `GET /v1/harnesses/readiness` (composed) and `GET /v1/harnesses/:name/readiness` (single-harness probe) on a Hono app, both reading from `HarnessReadinessRegistry`.
- `client/test/harnesses/readiness-registry.test.ts` — unit coverage.
- `client/test/api/harness-readiness-endpoint.test.ts` — endpoint coverage.

### Modified in Stage A

- `client/src/harnesses/impls/claude-code-learner/index.ts` — implement `isReady()` that runs `claude auth status` via the existing `probeClaudeAuth` helper.
- `client/src/main.ts` — remove `claudeAuthRequired` branch (lines around 1398); wire `HarnessReadinessRegistry` construction; pass registry into daemon claim loops.
- `client/src/daemon/daemon.ts` (and per-claim-loop files) — add `readinessRegistry.isReadyForClaim(manifestCid)` check before each claim attempt; log status-change transitions.
- `client/src/api/server.ts` — call `addHarnessReadinessRoutes()` for the new endpoint.
- `client/src/dashboard/spa/src/regions/Onboarding.tsx` — drop Phase 1; renumber `PHASE_TITLES` and `PHASE_FOR_STEP`; remove `ClaudeAuthCard` import and `useQuery(['claude-auth'])` block.
- `client/src/dashboard/spa/src/regions/Onboarding.test.tsx` — update test assertions for 3-phase shape.
- `client/test/preflight/claude-required.test.ts` — deleted.
- `client/src/preflight/claude-required.ts` — deleted.
- `client/src/dashboard/spa/src/regions/ClaudeAuthCard.tsx` — deleted (replaced in Stage B by generic `HarnessPrecheckPanel` in the JoinFlow).
- `client/src/dashboard/spa/src/regions/ClaudeAuthCard.test.tsx` (if exists) — deleted.

### Created in Stage B

- `client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.tsx` — generalized rename of `HermesPrecheckPanel`. Polls `/v1/harnesses/:name/readiness`, renders state-specific UI from `ReadyStatus.nextStep`.
- `client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.test.tsx` — coverage for Claude + Hermes state machines.
- `client/src/harnesses/impls/hermes-agent/isReady.ts` (or inline in `index.ts`) — wraps the existing Hermes `doctor` logic into the `Harness.isReady()` contract.

### Modified in Stage B (require Hermes branch in main)

- `client/src/dashboard/spa/src/pages/operator-catalog/HermesPrecheckPanel.tsx` — renamed to `HarnessPrecheckPanel.tsx` (move under `regions/`), generalized.
- `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx` — replace `<HermesPrecheckPanel>` with `<HarnessPrecheckPanel harness={selected} />`; render for any selected harness (panel collapses on `ready: true`); gate "Save & Join" on all selected-role harnesses reporting ready.
- `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx` — update for generic panel + multi-harness gate.
- `client/src/api/hermes-doctor-endpoint.ts` — replace with `addHarnessReadinessRoutes` registration for Hermes (delete this file once `/v1/harnesses/hermes/readiness` covers it).
- `client/src/api/server.ts` — drop `addHermesDoctorRoutes` call.
- `client/src/dashboard/spa/src/api/client.ts` — drop `getHermesDoctor` typed client (replaced by `getHarnessReadiness(name)`).

---

## Stage A: foundation + cutover (independent of Hermes)

### Task A1: Implement `claude-code-learner.isReady()` to probe `claude auth status`

**Files:**
- Modify: `client/src/harnesses/impls/claude-code-learner/index.ts`
- Test: `client/test/harnesses/impls/claude-code-learner/is-ready.test.ts` (new)

- [ ] **Step 1: Confirm current state of claude-code-learner**

Run:
```bash
cd .tasks/vh74.2/client
grep -n "isReady\|claudeAuth" src/harnesses/impls/claude-code-learner/index.ts
```
Expected: no `isReady` method present (default `{ ready: true }` behavior). Confirms the gap.

- [ ] **Step 2: Write the failing test**

Create `client/test/harnesses/impls/claude-code-learner/is-ready.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { probeClaudeAuth } from '../../../src/preflight/claude-auth.js';
import { ClaudeCodeLearnerHarness } from '../../../src/harnesses/impls/claude-code-learner/index.js';

vi.mock('../../../src/preflight/claude-auth.js', () => ({
  probeClaudeAuth: vi.fn(),
}));

describe('ClaudeCodeLearnerHarness.isReady', () => {
  it('returns ready=true when claude auth status reports logged in', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: true,
      context: 'bare',
      detail: 'logged in as test@example.com',
      email: 'test@example.com',
    });
    const harness = new ClaudeCodeLearnerHarness({ /* minimal config */ });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('returns ready=false with sign-in nextStep when not authenticated', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: false,
      context: 'bare',
      detail: 'not logged in',
    });
    const harness = new ClaudeCodeLearnerHarness({ /* minimal config */ });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('not logged in');
    expect(result.nextStep?.description).toMatch(/sign in/i);
    expect(result.nextStep?.url).toBe('/v1/auth/claude/spawn');
  });

  it('returns ready=false when claude binary is missing', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: false,
      context: 'bare',
      detail: 'claude binary claude not found on PATH',
    });
    const harness = new ClaudeCodeLearnerHarness({ /* minimal config */ });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.nextStep?.url).toBe('/v1/setup/claude/install');
  });
});
```

> **Implementation note:** the constructor signature in the test (`new ClaudeCodeLearnerHarness({ /* minimal config */ })`) needs to match the actual class shape — Step 3 sets it up. If `ClaudeCodeLearnerHarness` is currently constructed via a factory function (`buildHarnesses`), wrap it via that factory in the test using a stub env (see `client/src/harnesses/impls/index.ts:111` for the factory pattern).

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
cd .tasks/vh74.2/client
yarn vitest run test/harnesses/impls/claude-code-learner/is-ready.test.ts
```
Expected: FAIL — either with `isReady is not a function` (no impl yet) or `expected undefined to be true` (default impl returns nothing).

- [ ] **Step 4: Implement `isReady()`**

In `client/src/harnesses/impls/claude-code-learner/index.ts`, add to the class:

```typescript
import { probeClaudeAuth } from '../../../preflight/claude-auth.js';
import type { ReadyStatus } from '../../types.js';

// ... inside the class:
async isReady(_ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<ReadyStatus> {
  const result = probeClaudeAuth({
    context: this.runtimeMode ?? 'bare',
    cwd: process.cwd(),
    claudePath: this.claudePath ?? 'claude',
  });
  if (result.authenticated) {
    return { ready: true, reason: result.detail };
  }
  const binaryMissing = result.detail.includes('not found on PATH');
  return {
    ready: false,
    reason: result.detail,
    nextStep: binaryMissing
      ? {
          description: 'Install Claude Code from the operator app',
          url: '/v1/setup/claude/install',
        }
      : {
          description: 'Sign in to Claude from the operator app',
          url: '/v1/auth/claude/spawn',
        },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
yarn vitest run test/harnesses/impls/claude-code-learner/is-ready.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/claude-code-learner/index.ts \
        client/test/harnesses/impls/claude-code-learner/is-ready.test.ts
git commit -m "feat(vh74.2): claude-code-learner.isReady() probes claude auth status

Lifts the existing probeClaudeAuth() helper into the canonical
Harness.isReady() contract. Returns ready=false with a nextStep URL
that the SPA's HarnessPrecheckPanel can act on (sign-in vs install).

Required by HarnessReadinessRegistry (next task) to replace the
daemon-level Claude auth gate per spec
docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A2: HarnessReadinessRegistry

**Files:**
- Create: `client/src/harnesses/readiness-registry.ts`
- Test: `client/test/harnesses/readiness-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/harnesses/readiness-registry.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import type { Harness, ReadyStatus } from '../../src/harnesses/types.js';

function fakeHarness(name: string, ready: ReadyStatus | (() => Promise<ReadyStatus>)): Harness {
  return {
    name,
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    isReady: typeof ready === 'function' ? ready : async () => ready,
  };
}

describe('HarnessReadinessRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns ready snapshot for each joined harness', async () => {
    const claude = fakeHarness('claude-code-learner', { ready: true, reason: 'ok' });
    const evaluator = fakeHarness('swe-rebench-v2-evaluator', { ready: false, reason: 'docker not running' });
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': claude, 'swe-rebench-v2-evaluator': evaluator },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
        'bafkrei.eval': { harnessName: 'swe-rebench-v2-evaluator', roles: ['evaluator'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const snapshot = registry.getSnapshot();
    expect(snapshot.harnesses).toEqual([
      expect.objectContaining({ harnessName: 'claude-code-learner', ready: true, manifestCids: ['bafkrei.claude'] }),
      expect.objectContaining({ harnessName: 'swe-rebench-v2-evaluator', ready: false, manifestCids: ['bafkrei.eval'] }),
    ]);
  });

  it('isReadyForClaim returns ready=false for unknown manifestCid', async () => {
    const registry = new HarnessReadinessRegistry({
      harnessesByName: {},
      joinedHarnessesByCid: {},
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const status = registry.isReadyForClaim('bafkrei.unknown');
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('not in joinedSolverNets');
  });

  it('isReadyForClaim returns cached status from last refresh', async () => {
    const claude = fakeHarness('claude-code-learner', { ready: true, reason: 'ok' });
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': claude },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    expect(registry.isReadyForClaim('bafkrei.claude').ready).toBe(true);
  });

  it('treats unknown harness name as not-registered', async () => {
    const registry = new HarnessReadinessRegistry({
      harnessesByName: {},  // empty registry
      joinedHarnessesByCid: {
        'bafkrei.x': { harnessName: 'mystery-harness', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const snapshot = registry.getSnapshot();
    expect(snapshot.harnesses[0]?.ready).toBe(false);
    expect(snapshot.harnesses[0]?.reason).toContain('not registered');
  });

  it('catches isReady() exceptions and reports ready=false', async () => {
    const broken = fakeHarness('claude-code-learner', async () => {
      throw new Error('boom');
    });
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': broken },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const snapshot = registry.getSnapshot();
    expect(snapshot.harnesses[0]?.ready).toBe(false);
    expect(snapshot.harnesses[0]?.reason).toContain('isReady threw');
    expect(snapshot.harnesses[0]?.reason).toContain('boom');
  });

  it('background tick refreshes snapshot every interval', async () => {
    let counter = 0;
    const flaky = fakeHarness('claude-code-learner', async () => ({
      ready: counter++ > 0,
      reason: counter === 1 ? 'starting up' : 'ok',
    }));
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': flaky },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    registry.start();
    await registry.refreshNow();
    expect(registry.isReadyForClaim('bafkrei.claude').ready).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(registry.isReadyForClaim('bafkrei.claude').ready).toBe(true);
    registry.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
yarn vitest run test/harnesses/readiness-registry.test.ts
```
Expected: FAIL — `Cannot find module '../../src/harnesses/readiness-registry.js'`.

- [ ] **Step 3: Implement the registry**

Create `client/src/harnesses/readiness-registry.ts`:

```typescript
/**
 * HarnessReadinessRegistry — per-harness Harness.isReady() composition for the
 * daemon's claim loops and the SPA's per-harness setup cards.
 *
 * See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 *
 * Single writer: the background refresh tick. Readers (claim loops + the
 * /v1/harnesses/readiness endpoint) read the cached snapshot lock-free.
 * Bounded staleness = tickIntervalMs.
 */

import type { Harness, ReadyStatus } from './types.js';

export interface JoinedHarnessSpec {
  harnessName: string;
  roles: Array<'solver' | 'evaluator'>;
}

export interface HarnessReadinessSnapshot {
  lastRefreshedAt: string;  // ISO-8601
  harnesses: Array<{
    harnessName: string;
    manifestCids: string[];
    ready: boolean;
    reason?: string;
    nextStep?: ReadyStatus['nextStep'];
  }>;
}

export interface HarnessReadinessRegistryOptions {
  /** Harness instances indexed by Harness.name. */
  harnessesByName: Record<string, Harness>;
  /** joinedSolverNets shape, narrowed to harness lookup. */
  joinedHarnessesByCid: Record<string, JoinedHarnessSpec>;
  /** Background refresh interval (ms). Default 4000 (matches existing Claude auth poll cadence). */
  tickIntervalMs?: number;
  /** Per-isReady() timeout (ms). Default 5000. */
  isReadyTimeoutMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 4_000;
const DEFAULT_IS_READY_TIMEOUT_MS = 5_000;

export class HarnessReadinessRegistry {
  private readonly opts: Required<HarnessReadinessRegistryOptions>;
  private snapshot: HarnessReadinessSnapshot = {
    lastRefreshedAt: new Date(0).toISOString(),
    harnesses: [],
  };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HarnessReadinessRegistryOptions) {
    this.opts = {
      tickIntervalMs: opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
      isReadyTimeoutMs: opts.isReadyTimeoutMs ?? DEFAULT_IS_READY_TIMEOUT_MS,
      harnessesByName: opts.harnessesByName,
      joinedHarnessesByCid: opts.joinedHarnessesByCid,
    };
  }

  start(): void {
    if (this.timer) return;
    // First refresh runs out-of-band; subsequent ticks are intervals.
    void this.refreshNow();
    this.timer = setInterval(() => { void this.refreshNow(); }, this.opts.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): HarnessReadinessSnapshot {
    return this.snapshot;
  }

  isReadyForClaim(manifestCid: string): ReadyStatus {
    const joined = this.opts.joinedHarnessesByCid[manifestCid];
    if (!joined) {
      return {
        ready: false,
        reason: `manifestCid ${manifestCid} not in joinedSolverNets`,
      };
    }
    const entry = this.snapshot.harnesses.find((h) => h.harnessName === joined.harnessName);
    if (!entry) {
      return { ready: false, reason: 'readiness snapshot not yet populated' };
    }
    return {
      ready: entry.ready,
      reason: entry.reason,
      nextStep: entry.nextStep,
    };
  }

  async refreshNow(): Promise<void> {
    // Group joined entries by harnessName so we only call isReady() once per harness.
    const harnessToCids = new Map<string, string[]>();
    for (const [cid, joined] of Object.entries(this.opts.joinedHarnessesByCid)) {
      const list = harnessToCids.get(joined.harnessName) ?? [];
      list.push(cid);
      harnessToCids.set(joined.harnessName, list);
    }

    const results = await Promise.all(
      Array.from(harnessToCids.entries()).map(async ([name, cids]) => {
        const harness = this.opts.harnessesByName[name];
        if (!harness) {
          return {
            harnessName: name,
            manifestCids: cids,
            ready: false,
            reason: `harness ${name} not registered in this daemon build`,
            nextStep: {
              description: 'Upgrade daemon or change SolverNet harness selection',
            },
          };
        }
        if (!harness.isReady) {
          // No isReady → treat as always-ready (matches existing default).
          return {
            harnessName: name,
            manifestCids: cids,
            ready: true,
          };
        }
        try {
          const status = await Promise.race([
            harness.isReady({ solverType: '*' }),
            new Promise<ReadyStatus>((_, reject) =>
              setTimeout(() => reject(new Error('isReady timed out')), this.opts.isReadyTimeoutMs),
            ),
          ]);
          return {
            harnessName: name,
            manifestCids: cids,
            ready: status.ready,
            reason: status.reason,
            nextStep: status.nextStep,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            harnessName: name,
            manifestCids: cids,
            ready: false,
            reason: `isReady threw: ${msg}`,
          };
        }
      }),
    );

    this.snapshot = {
      lastRefreshedAt: new Date().toISOString(),
      harnesses: results,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
yarn vitest run test/harnesses/readiness-registry.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/readiness-registry.ts \
        client/test/harnesses/readiness-registry.test.ts
git commit -m "feat(vh74.2): HarnessReadinessRegistry composes per-harness isReady()

Single-writer background refresh tick (4s default); readers (claim
loops + SPA endpoint) read cached snapshot lock-free. Catches
isReady() exceptions + timeouts; reports unknown harnesses as
not-registered.

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A3: `/v1/harnesses/readiness` + `/v1/harnesses/:name/readiness` endpoints

**Files:**
- Create: `client/src/api/harness-readiness-endpoint.ts`
- Test: `client/test/api/harness-readiness-endpoint.test.ts`
- Modify: `client/src/api/server.ts` (register routes)

- [ ] **Step 1: Write the failing test**

Create `client/test/api/harness-readiness-endpoint.test.ts`:

```typescript
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { addHarnessReadinessRoutes } from '../../src/api/harness-readiness-endpoint.js';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import type { Harness } from '../../src/harnesses/types.js';

function fixtureRegistry(): HarnessReadinessRegistry {
  const claude: Harness = {
    name: 'claude-code-learner',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    isReady: async () => ({ ready: true, reason: 'ok' }),
  };
  const evaluator: Harness = {
    name: 'swe-rebench-v2-evaluator',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    isReady: async () => ({
      ready: false,
      reason: 'docker not running',
      nextStep: { description: 'Start Docker', cli: 'open -a Docker' },
    }),
  };
  return new HarnessReadinessRegistry({
    harnessesByName: {
      'claude-code-learner': claude,
      'swe-rebench-v2-evaluator': evaluator,
    },
    joinedHarnessesByCid: {
      'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      'bafkrei.eval': { harnessName: 'swe-rebench-v2-evaluator', roles: ['evaluator'] },
    },
  });
}

describe('harness-readiness-endpoint', () => {
  it('GET /v1/harnesses/readiness returns composed snapshot', async () => {
    const registry = fixtureRegistry();
    await registry.refreshNow();
    const app = new Hono();
    addHarnessReadinessRoutes(app, { registry });

    const res = await app.request('/v1/harnesses/readiness');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.harnesses).toHaveLength(2);
    expect(body.lastRefreshedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('GET /v1/harnesses/:name/readiness returns single-harness snapshot', async () => {
    const registry = fixtureRegistry();
    await registry.refreshNow();
    const app = new Hono();
    addHarnessReadinessRoutes(app, { registry });

    const res = await app.request('/v1/harnesses/claude-code-learner/readiness');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.harnessName).toBe('claude-code-learner');
    expect(body.ready).toBe(true);
  });

  it('GET /v1/harnesses/:name/readiness returns 404 for unknown harness', async () => {
    const registry = fixtureRegistry();
    await registry.refreshNow();
    const app = new Hono();
    addHarnessReadinessRoutes(app, { registry });

    const res = await app.request('/v1/harnesses/no-such-harness/readiness');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
yarn vitest run test/api/harness-readiness-endpoint.test.ts
```
Expected: FAIL — `Cannot find module './harness-readiness-endpoint.js'`.

- [ ] **Step 3: Implement the endpoint**

Create `client/src/api/harness-readiness-endpoint.ts`:

```typescript
/**
 * GET /v1/harnesses/readiness  — composed snapshot of all joined harnesses
 * GET /v1/harnesses/:name/readiness — single-harness snapshot
 *
 * Both read from a HarnessReadinessRegistry instance (single-writer; readers
 * never block). See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 */
import type { Hono } from 'hono';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';

export interface HarnessReadinessRoutesConfig {
  registry: HarnessReadinessRegistry;
}

export function addHarnessReadinessRoutes(app: Hono, config: HarnessReadinessRoutesConfig): void {
  app.get('/v1/harnesses/readiness', (c) => {
    return c.json(config.registry.getSnapshot());
  });

  app.get('/v1/harnesses/:name/readiness', (c) => {
    const name = c.req.param('name');
    const snapshot = config.registry.getSnapshot();
    const entry = snapshot.harnesses.find((h) => h.harnessName === name);
    if (!entry) {
      return c.json({ error: 'harness not found in readiness snapshot', harnessName: name }, 404);
    }
    return c.json(entry);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
yarn vitest run test/api/harness-readiness-endpoint.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Register routes in `server.ts`**

Find the existing route-registration block in `client/src/api/server.ts` (search for `addSetupRoutes` or similar). Add:

```typescript
import { addHarnessReadinessRoutes } from './harness-readiness-endpoint.js';

// ...inside the route registration function:
if (config.harnessReadinessRegistry) {
  addHarnessReadinessRoutes(app, { registry: config.harnessReadinessRegistry });
}
```

And add to the routes config interface:

```typescript
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
// ...add to the config interface:
harnessReadinessRegistry?: HarnessReadinessRegistry;
```

- [ ] **Step 6: Confirm types compile**

Run:
```bash
yarn typecheck
```
Expected: clean (no errors).

- [ ] **Step 7: Commit**

```bash
git add client/src/api/harness-readiness-endpoint.ts \
        client/test/api/harness-readiness-endpoint.test.ts \
        client/src/api/server.ts
git commit -m "feat(vh74.2): /v1/harnesses/readiness + /v1/harnesses/:name/readiness

Composed snapshot endpoint for SPA polling; per-harness endpoint for
the JoinFlow's pre-save check. Both read from HarnessReadinessRegistry.

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A4: Wire `HarnessReadinessRegistry` into the daemon at boot

**Files:**
- Modify: `client/src/main.ts`
- Test: `client/test/main/harness-readiness-wiring.test.ts` (new)

- [ ] **Step 1: Locate the daemon-construction site**

Run:
```bash
grep -n "claudeAuthRequired\|buildHarnesses\|attachAgentWs" client/src/main.ts | head -10
```
Note the line numbers where harnesses get built and where the daemon's loops are constructed.

- [ ] **Step 2: Write the failing test**

Create `client/test/main/harness-readiness-wiring.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildHarnessReadinessRegistry } from '../../src/main.js';
import type { Harness } from '../../src/harnesses/types.js';

describe('buildHarnessReadinessRegistry', () => {
  it('composes the registry from buildHarnesses() output + config.joinedSolverNets', async () => {
    const harnesses: Harness[] = [
      {
        name: 'claude-code-learner',
        version: '0.0.0',
        supports: () => true,
        run: async () => { throw new Error('not used'); },
        isReady: async () => ({ ready: true }),
      },
    ];
    const config = {
      joinedSolverNets: {
        'bafkrei.x': {
          manifestCid: 'bafkrei.x',
          roles: ['solver' as const],
          harness: 'claude-code-learner',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    };
    const registry = buildHarnessReadinessRegistry({ harnesses, config });
    await registry.refreshNow();
    expect(registry.isReadyForClaim('bafkrei.x').ready).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
yarn vitest run test/main/harness-readiness-wiring.test.ts
```
Expected: FAIL — `buildHarnessReadinessRegistry is not a function` (not exported yet).

- [ ] **Step 4: Implement the wiring helper**

In `client/src/main.ts`, add an exported function (place near other helper exports):

```typescript
import { HarnessReadinessRegistry } from './harnesses/readiness-registry.js';
import type { Harness } from './harnesses/types.js';
import type { JinnConfig } from './config.js';

export function buildHarnessReadinessRegistry(args: {
  harnesses: Harness[];
  config: Pick<JinnConfig, 'joinedSolverNets'>;
}): HarnessReadinessRegistry {
  const harnessesByName: Record<string, Harness> = {};
  for (const h of args.harnesses) {
    harnessesByName[h.name] = h;
  }
  const joinedHarnessesByCid: Record<string, { harnessName: string; roles: Array<'solver' | 'evaluator'> }> = {};
  for (const [cid, entry] of Object.entries(args.config.joinedSolverNets ?? {})) {
    if (entry.harness) {
      joinedHarnessesByCid[cid] = {
        harnessName: entry.harness,
        roles: entry.roles,
      };
    }
  }
  return new HarnessReadinessRegistry({
    harnessesByName,
    joinedHarnessesByCid,
  });
}
```

- [ ] **Step 5: Wire the registry construction into `runDaemon()` body**

In the body of `runDaemon()` (find by `export async function runDaemon` or similar), after `buildHarnesses(...)` is called, add:

```typescript
const harnessReadinessRegistry = buildHarnessReadinessRegistry({
  harnesses,
  config,
});
harnessReadinessRegistry.start();
```

Then pass `harnessReadinessRegistry` into:
- The HTTP server config (so `/v1/harnesses/readiness` is registered).
- The daemon construction (for claim-loop access — done in Task A5).

Add a `process.on('exit')` or equivalent cleanup:

```typescript
process.once('beforeExit', () => harnessReadinessRegistry.stop());
```

- [ ] **Step 6: Run wiring test + smoke type check**

Run:
```bash
yarn vitest run test/main/harness-readiness-wiring.test.ts
yarn typecheck
```
Expected: PASS on test; clean on typecheck.

- [ ] **Step 7: Commit**

```bash
git add client/src/main.ts client/test/main/harness-readiness-wiring.test.ts
git commit -m "feat(vh74.2): wire HarnessReadinessRegistry into runDaemon()

Constructs registry from buildHarnesses() output + config.joinedSolverNets,
starts the refresh tick, registers cleanup on process exit. Passed into
HTTP routes so /v1/harnesses/readiness reports live state.

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A5: Claim-loop readiness gate

**Files:**
- Modify: `client/src/daemon/daemon.ts` (and per-claim-loop files — find via grep)
- Test: `client/test/daemon/readiness-gate.test.ts` (new)

- [ ] **Step 1: Locate the claim-loop sites**

Run:
```bash
grep -rn "submitClaim\|claimDelivery\|submitRestorationJob\|protocol_task.*claim" client/src/daemon/ | head -20
```
Note the call sites where claim attempts originate. Likely: solver claim loop, evaluator claim loop.

- [ ] **Step 2: Write the failing test**

Create `client/test/daemon/readiness-gate.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { gateClaimByReadiness } from '../../src/daemon/readiness-gate.js';
import type { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';

function fakeRegistry(ready: boolean, reason?: string): HarnessReadinessRegistry {
  return {
    isReadyForClaim: vi.fn().mockReturnValue({ ready, reason }),
    getSnapshot: vi.fn(),
    refreshNow: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as HarnessReadinessRegistry;
}

describe('gateClaimByReadiness', () => {
  it('proceeds when harness is ready', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const registry = fakeRegistry(true);
    const result = gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    expect(result).toEqual({ proceed: true });
  });

  it('skips when harness is not ready', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const registry = fakeRegistry(false, 'claude not authenticated');
    const result = gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain('claude not authenticated');
    }
  });

  it('logs status-change transitions only (not per tick)', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const registry = fakeRegistry(false, 'first-tick reason');
    gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    gateClaimByReadiness({ manifestCid: 'bafkrei.x', registry, logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);  // only the first transition fires the warn
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
yarn vitest run test/daemon/readiness-gate.test.ts
```
Expected: FAIL — `Cannot find module '../../src/daemon/readiness-gate.js'`.

- [ ] **Step 4: Implement the gate helper**

Create `client/src/daemon/readiness-gate.ts`:

```typescript
/**
 * Pre-claim readiness check: cached snapshot lookup against
 * HarnessReadinessRegistry; logs on status-change transitions only.
 *
 * See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 */
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';

interface GateLogger {
  warn(msg: string): void;
  info(msg: string): void;
}

// Per-manifestCid status memo so we only log once per ready ↔ not-ready transition.
const lastReadyByCid = new Map<string, boolean>();

export function gateClaimByReadiness(args: {
  manifestCid: string;
  registry: HarnessReadinessRegistry;
  logger: GateLogger;
}): { proceed: true } | { proceed: false; reason: string } {
  const status = args.registry.isReadyForClaim(args.manifestCid);
  const previousReady = lastReadyByCid.get(args.manifestCid);
  if (status.ready) {
    if (previousReady === false) {
      args.logger.info(`[readiness] ${args.manifestCid} now ready; resuming claims`);
    }
    lastReadyByCid.set(args.manifestCid, true);
    return { proceed: true };
  }
  if (previousReady !== false) {
    args.logger.warn(
      `[readiness] ${args.manifestCid} not ready (${status.reason ?? 'no reason'}); skipping claims`,
    );
  }
  lastReadyByCid.set(args.manifestCid, false);
  return { proceed: false, reason: status.reason ?? 'harness not ready' };
}

/** Test-only: reset the per-cid memo between tests. */
export function _resetReadinessGateMemoForTests(): void {
  lastReadyByCid.clear();
}
```

> **Note:** the test for status-change logging needs `_resetReadinessGateMemoForTests()` in `beforeEach`. Adjust the test accordingly.

- [ ] **Step 5: Re-run test to verify it passes**

Update test imports to call `_resetReadinessGateMemoForTests()` in `beforeEach`. Run:
```bash
yarn vitest run test/daemon/readiness-gate.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the gate into claim loops**

For each claim-loop call site identified in Step 1, wrap the actual claim call with:

```typescript
import { gateClaimByReadiness } from './readiness-gate.js';

// ... inside the loop iteration, before submitClaim/etc.:
const gate = gateClaimByReadiness({
  manifestCid: task.solverNetManifestCid,
  registry: this.harnessReadinessRegistry,
  logger: { warn: (msg) => console.error(msg), info: (msg) => console.error(msg) },
});
if (!gate.proceed) continue;  // skip this task; next loop tick re-checks
// ... existing claim code
```

The daemon class constructor needs `harnessReadinessRegistry: HarnessReadinessRegistry` added to its options interface; the runDaemon() wiring (Task A4 Step 5) passes it in.

- [ ] **Step 7: Run broader test suite to confirm no regression**

Run:
```bash
yarn vitest run test/daemon/ test/harnesses/
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add client/src/daemon/readiness-gate.ts \
        client/src/daemon/daemon.ts \
        client/test/daemon/readiness-gate.test.ts
git commit -m "feat(vh74.2): claim-loop readiness gate

Per-claim cached-snapshot lookup against HarnessReadinessRegistry.
Logs once per ready↔not-ready transition (not per tick). When a
joined SolverNet's harness isn't ready, the claim loop skips that
SolverNet's tasks without blocking other loops.

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A6: Reshape `Onboarding.tsx` (4 → 3 phases)

**Files:**
- Modify: `client/src/dashboard/spa/src/regions/Onboarding.tsx`
- Modify: `client/src/dashboard/spa/src/regions/Onboarding.test.tsx`
- Delete: `client/src/dashboard/spa/src/regions/ClaudeAuthCard.tsx`
- Delete: `client/src/dashboard/spa/src/regions/ClaudeAuthCard.test.tsx` (if exists)

- [ ] **Step 1: Confirm current state**

Run:
```bash
grep -n "PHASE_TITLES\|ClaudeAuthCard\|claude-auth" client/src/dashboard/spa/src/regions/Onboarding.tsx | head
ls client/src/dashboard/spa/src/regions/ClaudeAuthCard*
```
Confirms current 4-phase shape + ClaudeAuthCard presence.

- [ ] **Step 2: Update the failing test**

In `client/src/dashboard/spa/src/regions/Onboarding.test.tsx`, replace any test that asserts the presence of "Sign in to Claude" or `ClaudeAuthCard` with assertions that the 3-phase shape is rendered:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Onboarding } from './Onboarding.js';
// ... existing imports

describe('Onboarding (3-phase post-vh74.2)', () => {
  it('renders exactly three phases', () => {
    // ... harness setup as in existing tests (mock bootstrap query, etc.)
    render(<Onboarding />);
    expect(screen.getByText(/Provisioning your wallet/)).toBeInTheDocument();
    expect(screen.getByText(/Fund your wallet/)).toBeInTheDocument();
    expect(screen.getByText(/Joining Jinn/)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to Claude/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
yarn vitest run src/dashboard/spa/src/regions/Onboarding.test.tsx
```
Expected: FAIL on "Sign in to Claude" still rendered (current behavior).

- [ ] **Step 4: Modify `Onboarding.tsx`**

Edit `client/src/dashboard/spa/src/regions/Onboarding.tsx`:

Change the `Phase` type:
```typescript
type Phase = 1 | 2 | 3;
```

Update `PHASE_FOR_STEP` so each value subtracts 1:
```typescript
const PHASE_FOR_STEP: Record<string, BootstrapPhaseDescriptor> = {
  wallet: { phase: 1, subState: null },
  safe_predicted: { phase: 1, subState: null },
  awaiting_funding: { phase: 2, subState: null },
  safe_deployed: { phase: 3, subState: 'Deploying' },
  service_created: { phase: 3, subState: 'Deploying' },
  service_activated: { phase: 3, subState: 'Deploying' },
  agents_registered: { phase: 3, subState: 'Deploying' },
  service_deployed: { phase: 3, subState: 'Deploying' },
  service_staked: { phase: 3, subState: 'Deploying' },
  staked: { phase: 3, subState: 'Deploying' },
  mech_deployed: { phase: 3, subState: 'Joining the network' },
  agent_registered: { phase: 3, subState: 'Joining the network' },
  safe_binding_pending: { phase: 3, subState: 'Binding identity' },
};
```

Update `PHASE_TITLES`:
```typescript
const PHASE_TITLES: Record<Phase, string> = {
  1: 'Provisioning your wallet',
  2: 'Fund your wallet',
  3: 'Joining Jinn',
};
```

Update `BootstrapPhaseDescriptor.phase` type:
```typescript
interface BootstrapPhaseDescriptor {
  phase: Phase;   // was: Exclude<Phase, 1>
  subState: string | null;
}
```

Remove the entire `useQuery<ClaudeAuthState>` block + any rendering of `ClaudeAuthCard`. Remove `ClaudeAuthCard` import.

- [ ] **Step 5: Delete `ClaudeAuthCard.tsx`**

```bash
rm client/src/dashboard/spa/src/regions/ClaudeAuthCard.tsx
rm client/src/dashboard/spa/src/regions/ClaudeAuthCard.test.tsx 2>/dev/null || true
```

Search for any remaining imports of `ClaudeAuthCard`:
```bash
grep -rn "ClaudeAuthCard" client/src/
```
Expected: no hits (besides the deleted file's tombstone). If any references remain, remove them.

- [ ] **Step 6: Run tests + typecheck**

Run:
```bash
yarn vitest run src/dashboard/spa/src/regions/Onboarding.test.tsx
yarn typecheck
```
Expected: PASS on Onboarding test; clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add client/src/dashboard/spa/src/regions/Onboarding.tsx \
        client/src/dashboard/spa/src/regions/Onboarding.test.tsx
git rm client/src/dashboard/spa/src/regions/ClaudeAuthCard.tsx \
       client/src/dashboard/spa/src/regions/ClaudeAuthCard.test.tsx
git commit -m "refactor(vh74.2): Onboarding 4 phases → 3 (drop Sign in to Claude)

Per-harness auth moves to the /operator join flow (Stage B). Onboarding
takeover now covers only Provisioning wallet / Fund wallet / Joining
Jinn — the parts that genuinely require pre-running-mode completion.
ClaudeAuthCard deleted; functionality absorbed by HarnessPrecheckPanel
(Stage B).

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A7: Remove the global Claude auth gate (cutover)

**Files:**
- Delete: `client/src/preflight/claude-required.ts`
- Delete: `client/test/preflight/claude-required.test.ts`
- Modify: `client/src/main.ts` (remove `claudeAuthRequired` branch)
- Test: `client/test/main/daemon-does-not-exit-on-missing-claude-auth.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `client/test/main/daemon-does-not-exit-on-missing-claude-auth.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
// ... test setup that mocks the daemon's entry conditions:
// - config loads with a Claude-using joined SolverNet
// - claude auth status subprocess returns loggedIn: false

describe('runDaemon (post-vh74.2)', () => {
  it('does NOT exit when claude auth is missing', async () => {
    // Mock probeClaudeAuth to return authenticated: false.
    // Run runDaemon() up to the post-bootstrap transition.
    // Assert: no process.exit() called; HTTP server reachable;
    // HarnessReadinessRegistry reports claude-code-learner as ready: false.

    // (Exact test setup depends on the runDaemon test harness pattern used
    // in client/test/main/. If no such harness exists, this test asserts
    // via direct probeClaudeAuth mocking + checking that runDaemon does
    // not throw the exitCode=11 InvalidInvocation envelope.)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => undefined as never);
    // ... invoke runDaemon with fixture config + mocked claude auth
    // expected: exitSpy not called with code 11
    expect(exitSpy).not.toHaveBeenCalledWith(11);
  });
});
```

> **Note:** the exact test fixture depends on what `client/test/main/` already provides. If there's no existing pattern, consult `client/test/api/daemon-api-auth.test.ts` for daemon-construction test patterns. The key assertion is that the path through `runDaemon` no longer terminates the process when claude auth is missing.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
yarn vitest run test/main/daemon-does-not-exit-on-missing-claude-auth.test.ts
```
Expected: FAIL — `process.exit` called with 11 (current behavior).

- [ ] **Step 3: Remove the gate from `main.ts`**

In `client/src/main.ts`, find:
```typescript
const claudeAuthRequired = configRequiresClaudeAuth(config);
if (claudeAuthRequired) {
  // ... the entire block that runs probeClaudeAuth and exits on fail
}
```

Delete this entire block. Also delete the import:
```typescript
import { configRequiresClaudeAuth } from './preflight/claude-required.js';
```

- [ ] **Step 4: Delete `claude-required.ts` + its test**

```bash
git rm client/src/preflight/claude-required.ts \
       client/test/preflight/claude-required.test.ts
```

Search for any other importers:
```bash
grep -rn "configRequiresClaudeAuth\|CLAUDE_AUTH_REQUIRED_HARNESSES" client/src/ client/test/
```
Expected: no hits.

- [ ] **Step 5: Run typecheck + the new regression test**

Run:
```bash
yarn typecheck
yarn vitest run test/main/daemon-does-not-exit-on-missing-claude-auth.test.ts
```
Expected: clean typecheck; new test passes.

- [ ] **Step 6: Run broader earning + main test suites**

Run:
```bash
yarn vitest run test/main/ test/preflight/ test/earning/
```
Expected: all pass. `test/preflight/` may now be empty of relevant tests; that's expected.

- [ ] **Step 7: Commit (cutover)**

```bash
git add client/src/main.ts \
        client/test/main/daemon-does-not-exit-on-missing-claude-auth.test.ts
git rm client/src/preflight/claude-required.ts \
       client/test/preflight/claude-required.test.ts
git commit -m "refactor(vh74.2): remove daemon-level Claude auth gate (cutover)

Daemon no longer exits on missing Claude auth. The HarnessReadinessRegistry
(Task A2) + claim-loop gate (Task A5) cover per-harness readiness without
process-level exit.

Existing operators with Claude OAuth: zero visible change (registry
reports ready=true).
First-time-Claude operators: SPA HarnessPrecheckPanel (Stage B) drives
the in-app sign-in; meanwhile, claim loops skip claiming until ready.

Closes the architectural blocker for jinn-mono-l2zl.15.4.3.

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Stage A close-out

- [ ] **Push branch + open PR**

```bash
git push -u origin feat/vh74.2-per-harness-auth
gh pr create --repo Jinn-Network/mono --base main \
  --title "refactor(vh74.2): Stage A — per-harness readiness registry + Claude gate removal" \
  --body "$(cat <<EOF
## Summary

Implements Stage A of the per-harness auth refactor (\`jinn-mono-vh74.2\`, GH #236):

- New \`HarnessReadinessRegistry\` composes \`Harness.isReady()\` per joined SolverNet's harness, with cached snapshot + background refresh tick (4s).
- New endpoints: \`GET /v1/harnesses/readiness\` (composed) + \`GET /v1/harnesses/:name/readiness\` (single).
- Claim loops gate per-SolverNet on cached readiness; skip when not ready (log on transition only).
- \`claude-code-learner.isReady()\` wraps the existing \`probeClaudeAuth()\` helper.
- Onboarding: 4 phases → 3 (drop \"Sign in to Claude\" Phase 1; \`ClaudeAuthCard\` deleted).
- Cutover: remove \`configRequiresClaudeAuth\` + daemon-exit branch.

Stage B (depends on Hermes branch landing in main): generalize \`HermesPrecheckPanel\` → \`HarnessPrecheckPanel\` and wire into JoinFlow. Tracked as a follow-up.

## Test plan

- [ ] All new unit tests pass (HarnessReadinessRegistry, harness-readiness-endpoint, readiness-gate, claude-code-learner.isReady, Onboarding 3-phase, runDaemon-does-not-exit).
- [ ] \`yarn vitest run\` full suite clean.
- [ ] \`yarn typecheck\` clean.
- [ ] Manual: clean-HOME walkthrough on a machine WITHOUT prior Claude OAuth — daemon stays up, \`/v1/harnesses/readiness\` reports \`claude-code-learner: ready=false\`, claim loops skip Claude-using SolverNets, joined-list surfaces the warning chip. (Re-runs the \`uy6v.4\` cleanroom walkthrough that originally surfaced the gate.)

Spec: docs/superpowers/specs/2026-05-15-per-harness-auth-design.md
Bead: jinn-mono-vh74.2

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Stage B: UX generalization (requires Hermes branch in main)

**Pre-requisite check:** before starting Stage B, confirm the Hermes PR chain has merged to main:

```bash
git fetch origin main
git log origin/main --oneline | grep -i hermes | head -5
ls client/src/harnesses/impls/hermes-agent/ 2>/dev/null
ls client/src/api/hermes-doctor-endpoint.ts 2>/dev/null
ls client/src/dashboard/spa/src/pages/operator-catalog/HermesPrecheckPanel.tsx 2>/dev/null
```
Expected (Hermes merged): all three files present; recent commits show "Merge pull request ... hermes". If any are missing, STOP — Stage B can't proceed until Hermes lands. File a follow-up bead noting the dependency and pause.

### Task B1: Generalize `HermesPrecheckPanel` → `HarnessPrecheckPanel`

**Files:**
- Create: `client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.tsx` (moved + generalized from `pages/operator-catalog/HermesPrecheckPanel.tsx`)
- Create: `client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.test.tsx`
- Delete: `client/src/dashboard/spa/src/pages/operator-catalog/HermesPrecheckPanel.tsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.test.tsx`:

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { HarnessPrecheckPanel } from './HarnessPrecheckPanel.js';

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterEach(() => server.close());

describe('HarnessPrecheckPanel', () => {
  it('shows install affordance when nextStep.cli is present (Hermes shape)', async () => {
    server.use(
      http.get('/v1/harnesses/hermes-agent/readiness', () =>
        HttpResponse.json({
          harnessName: 'hermes-agent',
          ready: false,
          reason: 'binary not found',
          nextStep: {
            description: 'Install Hermes Agent',
            cli: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash',
          },
        }),
      ),
    );
    render(<HarnessPrecheckPanel harnessName="hermes-agent" onSuccess={() => {}} onCancel={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Install Hermes Agent/)).toBeInTheDocument();
      expect(screen.getByText(/curl -fsSL/)).toBeInTheDocument();
    });
  });

  it('shows sign-in affordance when nextStep.url is present (Claude shape)', async () => {
    server.use(
      http.get('/v1/harnesses/claude-code-learner/readiness', () =>
        HttpResponse.json({
          harnessName: 'claude-code-learner',
          ready: false,
          reason: 'not logged in',
          nextStep: {
            description: 'Sign in to Claude from the operator app',
            url: '/v1/auth/claude/spawn',
          },
        }),
      ),
    );
    render(<HarnessPrecheckPanel harnessName="claude-code-learner" onSuccess={() => {}} onCancel={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Sign in to Claude/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Sign in/ })).toBeInTheDocument();
    });
  });

  it('calls onSuccess when readiness transitions to ready=true', async () => {
    let readyState = false;
    server.use(
      http.get('/v1/harnesses/claude-code-learner/readiness', () =>
        HttpResponse.json({
          harnessName: 'claude-code-learner',
          ready: readyState,
          reason: readyState ? 'ok' : 'not logged in',
          nextStep: readyState ? undefined : { description: 'Sign in', url: '/v1/auth/claude/spawn' },
        }),
      ),
    );
    const onSuccess = vi.fn();
    render(<HarnessPrecheckPanel harnessName="claude-code-learner" onSuccess={onSuccess} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Sign in/)).toBeInTheDocument());
    readyState = true;  // simulate auth completion
    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 6000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
yarn vitest run src/dashboard/spa/src/regions/HarnessPrecheckPanel.test.tsx
```
Expected: FAIL — `Cannot find module './HarnessPrecheckPanel.js'`.

- [ ] **Step 3: Implement `HarnessPrecheckPanel.tsx`**

Move + generalize the existing Hermes panel. Create `client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.tsx`:

```typescript
/**
 * HarnessPrecheckPanel — generalized rename of HermesPrecheckPanel.
 *
 * Polls /v1/harnesses/<name>/readiness and renders state-specific UI:
 *   - nextStep.cli  → install / shell-command affordance with copy button
 *   - nextStep.url  → action button (POST or window navigation per the URL)
 *   - ready=true    → calls onSuccess(), panel collapses
 *
 * See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

export interface HarnessPrecheckPanelProps {
  harnessName: string;
  onSuccess: () => void;
  onCancel: () => void;
}

interface HarnessReadinessResponse {
  harnessName: string;
  ready: boolean;
  reason?: string;
  nextStep?: {
    description: string;
    cli?: string;
    url?: string;
  };
}

export function HarnessPrecheckPanel(props: HarnessPrecheckPanelProps): JSX.Element {
  const { data, isLoading, refetch } = useQuery<HarnessReadinessResponse>({
    queryKey: ['harness-readiness', props.harnessName],
    queryFn: () => api.getHarnessReadiness(props.harnessName),
    refetchInterval: 4000,
  });

  useEffect(() => {
    if (data?.ready === true) props.onSuccess();
  }, [data?.ready, props]);

  if (isLoading) return <div>Checking…</div>;
  if (!data) return <div>Readiness unavailable</div>;
  if (data.ready) return <></>;

  const step = data.nextStep;
  return (
    <div /* styling per the existing HermesPrecheckPanel */>
      <h3>{step?.description ?? data.reason ?? 'Not ready'}</h3>
      {step?.cli && (
        <pre><code>{step.cli}</code></pre>
      )}
      {step?.url && (
        <button onClick={() => {
          // For OAuth-style URLs, hit the spawn endpoint; the daemon-side WS
          // bridge handles the OAuth flow in the dashboard's xterm panel.
          void fetch(step.url, { method: 'POST' });
        }}>
          {/Sign in/i.test(step.description) ? 'Sign in' : 'Open'}
        </button>
      )}
      <div>
        <button onClick={() => refetch()}>Retry</button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
```

Add the `getHarnessReadiness` typed client in `client/src/dashboard/spa/src/api/client.ts`:

```typescript
async getHarnessReadiness(name: string): Promise<HarnessReadinessResponse> {
  const res = await fetch(`/v1/harnesses/${encodeURIComponent(name)}/readiness`, {
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`getHarnessReadiness ${name}: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
yarn vitest run src/dashboard/spa/src/regions/HarnessPrecheckPanel.test.tsx
```
Expected: PASS (3 tests).

- [ ] **Step 5: Delete the old `HermesPrecheckPanel.tsx`**

```bash
git rm client/src/dashboard/spa/src/pages/operator-catalog/HermesPrecheckPanel.tsx
```

Search for remaining importers (handled in Task B2):
```bash
grep -rn "HermesPrecheckPanel" client/src/
```

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.tsx \
        client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.test.tsx \
        client/src/dashboard/spa/src/api/client.ts
git rm client/src/dashboard/spa/src/pages/operator-catalog/HermesPrecheckPanel.tsx
git commit -m "refactor(vh74.2): HermesPrecheckPanel → generic HarnessPrecheckPanel

Generalizes the Hermes-pioneered precheck panel to work for any harness
that participates in /v1/harnesses/:name/readiness. Renders state-specific
UI from ReadyStatus.nextStep (cli for install, url for sign-in).

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B2: Wire `HarnessPrecheckPanel` into `JoinFlow`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx`
- Modify: `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx`

- [ ] **Step 1: Update existing JoinFlow test for generic panel**

In `JoinFlow.test.tsx`, find the test that asserts `HermesPrecheckPanel` is rendered when Hermes is selected. Generalize:

```typescript
it('renders HarnessPrecheckPanel for the selected solver harness', async () => {
  // ... existing setup
  // select Hermes harness in the picker
  // assert: HarnessPrecheckPanel rendered with harnessName="hermes-agent"
});

it('also renders HarnessPrecheckPanel for Claude harness selection', async () => {
  // ... setup
  // select Claude Code harness
  // assert: HarnessPrecheckPanel rendered with harnessName="claude-code-learner"
});

it('disables Save & Join until all selected-role harnesses report ready', async () => {
  // ... setup
  // mock /v1/harnesses/claude-code-learner/readiness → ready=false
  // assert: Save button disabled
  // mock → ready=true
  // assert: Save button enabled
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
yarn vitest run src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Modify `JoinFlow.tsx`**

In `JoinFlow.tsx`:

Replace the `HermesPrecheckPanel` import with:
```typescript
import { HarnessPrecheckPanel } from '../../regions/HarnessPrecheckPanel.js';
```

Replace the Hermes-conditional rendering with generic per-harness rendering:
```typescript
// Was: {selectedHarness === HERMES_AGENT_HARNESS && <HermesPrecheckPanel ... />}
// Now:
{selectedHarness && (
  <HarnessPrecheckPanel
    harnessName={selectedHarness}
    onSuccess={() => setSolverHarnessReady(true)}
    onCancel={() => setSelectedHarness(undefined)}
  />
)}
```

Add evaluator harness precheck (derived from manifest's `contract.evaluationFunction.implementation`):
```typescript
{rolesIncludeEvaluator && evaluatorHarnessName && (
  <HarnessPrecheckPanel
    harnessName={evaluatorHarnessName}
    onSuccess={() => setEvaluatorHarnessReady(true)}
    onCancel={() => {}}
  />
)}
```

Gate the "Save & Join" button:
```typescript
const allHarnessesReady =
  (!rolesIncludeSolver || solverHarnessReady) &&
  (!rolesIncludeEvaluator || evaluatorHarnessReady);
<button disabled={!allHarnessesReady} onClick={save}>Save & Join</button>
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
yarn vitest run src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx \
        client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx
git commit -m "feat(vh74.2): JoinFlow wires HarnessPrecheckPanel for all harnesses

Replaces the Hermes-conditional precheck panel with generic per-harness
rendering. Gates Save & Join on all selected-role harnesses reporting
ready (solver harness + evaluator harness derived from manifest's
contract.evaluationFunction.implementation).

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B3: Migrate `/api/hermes/doctor` → `/v1/harnesses/hermes-agent/readiness`

**Files:**
- Modify: `client/src/api/server.ts` (drop `addHermesDoctorRoutes`)
- Delete: `client/src/api/hermes-doctor-endpoint.ts`
- Modify: `client/src/harnesses/impls/hermes-agent/index.ts` (implement `isReady()` wrapping the existing doctor logic)

- [ ] **Step 1: Lift Hermes doctor logic into `hermes-agent.isReady()`**

In `client/src/harnesses/impls/hermes-agent/index.ts`, add the `isReady()` method. Copy the spawn-and-classify logic from `client/src/api/hermes-doctor-endpoint.ts`:

```typescript
import { spawnSync } from 'node:child_process';
import type { ReadyStatus } from '../../types.js';

async isReady(_ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<ReadyStatus> {
  const hermesBin = this.hermesPath ?? 'hermes';
  const result = spawnSync(hermesBin, ['doctor'], {
    timeout: 30_000,
    encoding: 'utf8',
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const notFound = errorCode === 'ENOENT';
  if (notFound) {
    return {
      ready: false,
      reason: 'hermes binary not found',
      nextStep: {
        description: 'Install Hermes Agent',
        cli: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash',
      },
    };
  }
  if (result.status === 0) {
    return { ready: true, reason: 'hermes doctor ok' };
  }
  return {
    ready: false,
    reason: `hermes doctor exit ${result.status}: ${result.stderr ?? ''}`,
    nextStep: {
      description: 'Run hermes setup to resolve configuration issues',
      cli: 'hermes setup',
    },
  };
}
```

Add a test in `client/test/harnesses/impls/hermes-agent/is-ready.test.ts` mirroring the claude-code-learner pattern (mock `spawnSync`).

- [ ] **Step 2: Delete `hermes-doctor-endpoint.ts`**

```bash
git rm client/src/api/hermes-doctor-endpoint.ts
```

- [ ] **Step 3: Drop `addHermesDoctorRoutes` from `server.ts`**

In `client/src/api/server.ts`, remove the import + call site.

- [ ] **Step 4: Update SPA api client**

In `client/src/dashboard/spa/src/api/client.ts`, remove `getHermesDoctor` (replaced by `getHarnessReadiness('hermes-agent')`).

Search for remaining callers:
```bash
grep -rn "getHermesDoctor\|/api/hermes/doctor" client/src/
```
Expected: no hits.

- [ ] **Step 5: Run full SPA + API test suite**

Run:
```bash
yarn vitest run test/api/ src/dashboard/spa/src/pages/operator-catalog/ src/dashboard/spa/src/regions/HarnessPrecheckPanel.test.tsx
yarn typecheck
```
Expected: all pass; clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/index.ts \
        client/test/harnesses/impls/hermes-agent/is-ready.test.ts \
        client/src/api/server.ts \
        client/src/dashboard/spa/src/api/client.ts
git rm client/src/api/hermes-doctor-endpoint.ts
git commit -m "refactor(vh74.2): Hermes uses generic harness-readiness endpoint

hermes-agent.isReady() lifts the existing /api/hermes/doctor spawn-and-
classify logic into the canonical Harness.isReady() contract. The
bespoke /api/hermes/doctor endpoint goes away — Hermes now participates
in /v1/harnesses/:name/readiness like all other harnesses.

Per spec docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Stage B close-out

- [ ] **Push branch + open PR**

```bash
git push origin feat/vh74.2-per-harness-auth
# Stage B commits land on the same branch; or open a second PR rebased on Stage A's merge:
gh pr create --repo Jinn-Network/mono --base main \
  --title "refactor(vh74.2): Stage B — HarnessPrecheckPanel + Hermes generic-endpoint migration" \
  --body "$(cat <<EOF
## Summary

Stage B of \`jinn-mono-vh74.2\`: generalizes the Hermes-pioneered precheck pattern across all harnesses now that Stage A's foundation has landed.

- \`HermesPrecheckPanel\` → \`HarnessPrecheckPanel\` (generic, polls \`/v1/harnesses/:name/readiness\`, renders from \`ReadyStatus.nextStep\`).
- \`JoinFlow\` wires precheck for any selected harness; Save & Join gated on all selected-role harnesses ready.
- \`hermes-agent.isReady()\` lifts the existing doctor logic into the canonical contract; bespoke \`/api/hermes/doctor\` endpoint deleted.

## Test plan

- [ ] HarnessPrecheckPanel tests (Hermes shape + Claude shape + transition-to-ready).
- [ ] JoinFlow tests (generic panel for solver + evaluator harnesses; Save gate).
- [ ] hermes-agent.isReady() unit tests.
- [ ] Full SPA + API suites clean.
- [ ] Manual: clean-HOME walkthrough — operator selects SWE-rebench v2 (claude-code-learner default); JoinFlow shows HarnessPrecheckPanel; operator signs in via embedded xterm; panel collapses; Save enabled.

Spec: docs/superpowers/specs/2026-05-15-per-harness-auth-design.md
Bead: jinn-mono-vh74.2

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Close bead `jinn-mono-vh74.2` after Stage B merges**

```bash
bd update jinn-mono-vh74.2 --notes "Both stages landed: <Stage A PR URL>, <Stage B PR URL>. Daemon-level Claude gate removed; per-harness readiness composition + UX shipped."
bd close jinn-mono-vh74.2
gh issue close 236 --repo Jinn-Network/mono --reason completed \
  --comment "Both stages landed. Daemon no longer exits on missing Claude auth; per-harness readiness via /v1/harnesses/readiness; SPA HarnessPrecheckPanel drives in-app auth for any harness. Verified by clean-HOME walkthrough."
```

---

## Self-review

**1. Spec coverage:**

| Spec section | Plan task |
|---|---|
| Architecture / invariants | Task A2 (registry), A5 (claim gate), A7 (cutover) |
| Components — Deleted | Task A6 (ClaudeAuthCard), A7 (claude-required.ts) |
| Components — New | Task A2 (registry), A3 (endpoint), B1 (HarnessPrecheckPanel) |
| Components — Modified | All tasks |
| Data flow — Boot | Task A4 (wiring in runDaemon) |
| Data flow — Per claim | Task A5 |
| Data flow — SPA polling | Task A3 + B1 |
| Data flow — Auth completion | Task B1 (nextStep.url action) |
| UX — Onboarding 4→3 | Task A6 |
| UX — JoinFlow | Task B2 |
| UX — Joined-list indicator | Implicit in A3 endpoint + B1 panel (existing /operator page consumes the snapshot; rendering may need a small follow-up if the joined-list doesn't already react to readiness — file follow-up bead if surfaced during implementation) |
| Error handling — all rows | Task A2 covers most; A3 endpoint serves stale snapshot; A5 logs transitions |
| Testing strategy | Each task includes regression test |
| Migration / rollout | Task A7 commit message articulates the cutover |

**2. Placeholder scan:** No "TBD" / "TODO" / unfinished sections. Implementation notes (e.g., "exact test fixture depends on what client/test/main/ already provides") are explicit caveats, not deferred work.

**3. Type consistency:** `HarnessReadinessRegistry` exports `HarnessReadinessSnapshot`, `JoinedHarnessSpec`, etc., used consistently across A3, A4, A5. `ReadyStatus` from `harnesses/types.ts` is the shared type. `harnessName` field used uniformly (not `name` or `harness`).

**4. Scope:** focused on per-harness auth refactor. No scope creep. The "Open implementation questions" section of the spec (registry tick interval configurability, metrics, panel "skip" affordance) is acknowledged but deferred to follow-up beads — explicit non-goals for this plan.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-per-harness-auth-plan.md` (in the `feat/vh74.2-per-harness-auth` worktree at `.tasks/vh74.2/`).

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit for this plan because tasks are tightly scoped and benefit from a fresh context per task.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Better if you want a single conversation thread covering all of Stage A.

Which approach?
