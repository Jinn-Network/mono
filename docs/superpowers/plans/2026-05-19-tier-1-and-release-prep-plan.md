# Tier 1 + release-prep skill implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the mechanical-floor gate layer: four Tier 1 scenario implementations (T1.1–T1.4), an orchestrator that runs them in parallel and emits a structured verdict, the `release-prep` skill that documents how to invoke them, and the CI workflow migration that replaces today's brittle operator-gate step with the new Tier 1 step. Tier 2 scenarios stay as documented contracts (in Plan B's reference docs); their implementations land in Plan D.

**Architecture:** Each scenario is a callable async function exported from `client/test/release/tier-1/<id>.ts` with a defined `ScenarioVerdict` return shape. The runner at `client/scripts/release/run-tier-1.ts` imports all four scenarios, runs them in parallel via `Promise.allSettled`, classifies failures, and prints a structured JSON verdict + a marker block. The `release-prep` skill SKILL.md describes how release-readiness should invoke it. CI workflow adds a `yarn release:tier-1` step that replaces `Release gate — operator-gate`.

**Tech Stack:** TypeScript, Vitest (for testing scenarios in isolation), Playwright (T1.4 only), viem for chain interaction, child_process for daemon spawning. Reuses existing patterns from `client/scripts/staking-validate.ts`, `client/test/e2e/task-first-helpers.ts`, and `client/test/dashboard/spa-config.e2e.test.ts`.

**Dependencies:**
- **Plan B** — required for `multi-op-daemon.ts` (T1.x uses it for single-op spawn too), `handshake-url.ts`, and the `scenario-spa-route-smoke.md` reference doc that defines T1.4's contract.
- **Plan A** — NOT required for runtime (Tier 1 doesn't use substrate). Plan C can land before A merges.
- The existing fork-helper at `client/test/_support/chain/anvil.ts` (`spawnAnvilFork`) — verified to exist by Plan B's fold-back commit.

---

## File structure

**New source files:**

| Path | Responsibility |
|---|---|
| `client/scripts/release/scenario-types.ts` | Shared `ScenarioVerdict`, `FailClass`, `ScenarioOptions` types |
| `client/scripts/release/run-tier-1.ts` | Orchestrator: run T1.1–T1.4 in parallel, emit verdicts + marker |
| `client/test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts` | T1.1 callable (importable by the orchestrator without invoking Vitest) |
| `client/test/release/tier-1/T1.1-bootstrap-fresh-anvil.test.ts` | T1.1 Vitest wrapper — imports the callable, asserts verdict shape |
| `client/test/release/tier-1/T1.2-harness-readiness-contract.ts` | T1.2 callable |
| `client/test/release/tier-1/T1.2-harness-readiness-contract.test.ts` | T1.2 Vitest wrapper |
| `client/test/release/tier-1/T1.3-indexer-round-trip.ts` | T1.3 callable |
| `client/test/release/tier-1/T1.3-indexer-round-trip.test.ts` | T1.3 Vitest wrapper |
| `client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts` | T1.4 Playwright test |

**New refactor outputs:**

| Path | Responsibility |
|---|---|
| `client/src/dashboard/spa/src/routes.ts` | Extracted `ROUTES` constant (for T1.4 to import) |
| `client/test/dashboard/helpers/mock-daemon-api.ts` | Extracted `mockDaemonApi(page, port?)` from `spa-config.e2e.test.ts` |

**New skill files:**

| Path | Responsibility |
|---|---|
| `.claude/skills/release-prep/SKILL.md` | Skill description, invocation contract, output format |
| `.claude/skills/release-prep/references/tier-1-scenarios.md` | Detailed shape per Tier 1 scenario |
| `.claude/skills/release-prep/references/tier-2-scenarios.md` | Placeholder pointing at Plan B's scenario docs; expanded in Plan D |
| `.claude/skills/release-prep/references/evidence-format.md` | Marker schema, evidence doc shape |
| `.claude/skills/release-prep/references/failure-classification.md` | flake-infra / flake-timing / real-bug / agent-crash rules |

**Modified files:**

| Path | Change |
|---|---|
| `client/src/dashboard/spa/src/App.tsx` | Import `ROUTES` from the new module instead of inlining |
| `client/test/dashboard/spa-config.e2e.test.ts` | Import `mockDaemonApi` from the extracted module |
| `client/package.json` | Add `release:tier-1`, `release:tier-1:T1.1`, ... yarn scripts |
| `.github/workflows/npm-publish.yml` | Replace `Release gate — operator-gate` step with `Tier 1 — mechanical floor` |

---

## Task 1: Extract `ROUTES` constant from App.tsx

**Files:**
- Create: `client/src/dashboard/spa/src/routes.ts`
- Modify: `client/src/dashboard/spa/src/App.tsx`

Small refactor so T1.4 can import the canonical route list instead of hardcoding.

- [ ] **Step 1: Read the current App.tsx to find the route list**

Run: `grep -n "Route\|path=" client/src/dashboard/spa/src/App.tsx | head -30`

Expected: lines showing `<Route path="..."` declarations or a route table object.

- [ ] **Step 2: Create the routes module**

```typescript
// client/src/dashboard/spa/src/routes.ts
// Canonical SPA route list — single source of truth.
// T1.4 SPA route smoke imports this so any new route automatically gets
// covered by the route-smoke gate.

export interface RouteSpec {
  path: string;                       // pathname (no query/hash)
  label: string;                      // human-readable name for test output
  /** Test-only param substitutions for parameterized routes. */
  params?: Record<string, string>;
}

export const ROUTES: RouteSpec[] = [
  { path: '/', label: 'root' },
  { path: '/overview', label: 'overview' },
  { path: '/configuration', label: 'configuration' },
  { path: '/configuration#network', label: 'configuration#network' },
  { path: '/configuration#security', label: 'configuration#security' },
  { path: '/launcher', label: 'launcher' },
  { path: '/launcher/create', label: 'launcher-create' },
  {
    path: '/launcher/launched/:solverNetId',
    label: 'launcher-launched',
    params: { solverNetId: '5474_swe-rebench-v2-v1_edb172d3' },
  },
  {
    path: '/operator/join/:cid',
    label: 'operator-join',
    params: { cid: 'bafkrei-mock-manifest-cid' },
  },
  { path: '/network', label: 'network' },
  { path: '/build', label: 'build' },
];

/** Substitute :param tokens with the spec's `params` values. */
export function expandRoutePath(spec: RouteSpec): string {
  if (!spec.params) return spec.path;
  let out = spec.path;
  for (const [k, v] of Object.entries(spec.params)) {
    out = out.replace(`:${k}`, v);
  }
  return out;
}
```

- [ ] **Step 3: Update App.tsx to import the list**

Open `client/src/dashboard/spa/src/App.tsx`. Replace the inline route declarations (whatever shape they take — `<Route>` JSX or a `createBrowserRouter` config) with code that maps over the `ROUTES` constant. The exact diff depends on the current App.tsx shape; the implementer should:

1. Import `ROUTES` from `./routes`.
2. Replace the inline route list with `ROUTES.map(...)` producing the equivalent JSX/config.
3. Verify no route paths are lost; the imported `ROUTES` must be the canonical list, not a duplicate.

If App.tsx uses a Routes object literal that's already hostable, just import it. If it uses JSX `<Route>` elements, factor them into the constant.

- [ ] **Step 4: Verify SPA still builds + routes**

Run: `cd client && yarn build`
Expected: build succeeds with no new errors.

Run: `cd client && yarn vitest run src/dashboard/spa/src/App.routing.test.tsx`
Expected: PASS — existing routing tests still pass against the refactored code.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/routes.ts client/src/dashboard/spa/src/App.tsx
git commit -m "refactor(spa): extract canonical ROUTES list for T1.4 route smoke"
```

---

## Task 2: Extract `mockDaemonApi` to a shared module

**Files:**
- Create: `client/test/dashboard/helpers/mock-daemon-api.ts`
- Modify: `client/test/dashboard/spa-config.e2e.test.ts` (use the extracted helper)
- Test: extracted helper is exercised by the existing test file; no new test needed

Per Plan B's fold-back, `mockDaemonApi` is currently a private function inside `spa-config.e2e.test.ts` with port 7332 hardcoded. Extract it to a shared module with a `port` argument so T1.4 and Plan D's multi-op tests can import it.

- [ ] **Step 1: Read the current mockDaemonApi signature**

Run: `grep -n "mockDaemonApi" client/test/dashboard/spa-config.e2e.test.ts | head -10`
Expected: the function declaration line + usage sites.

Run: `awk '/function mockDaemonApi/,/^}/' client/test/dashboard/spa-config.e2e.test.ts | head -100`
Expected: the full function body.

- [ ] **Step 2: Create the extracted module**

```typescript
// client/test/dashboard/helpers/mock-daemon-api.ts
import type { Page } from '@playwright/test';

export interface MockDaemonApiOptions {
  /** Port the daemon would normally run on; route patterns include this. */
  port?: number;
}

/**
 * Intercept the daemon HTTP API endpoints the SPA polls. Use one call per
 * Playwright page when running multi-op tests; each page gets its own
 * isolated route table.
 *
 * Extracted from spa-config.e2e.test.ts so both single-op and multi-op
 * tests can share the same mock surface.
 */
export async function mockDaemonApi(page: Page, opts: MockDaemonApiOptions = {}): Promise<void> {
  const port = opts.port ?? 7332;
  const base = `http://127.0.0.1:${port}`;

  // /v1/bootstrap — running-mode payload
  await page.route(`${base}/v1/bootstrap`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'running',
        fleet: { agentId: '5474', safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' },
        chain: { id: 84532, name: 'base-sepolia' },
        joinedSolverNets: {},
      }),
    });
  });

  // /v1/status — minimal status snapshot
  await page.route(`${base}/v1/status`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, loops: [] }),
    });
  });

  // /auth/handshake** — suppress redirect, return ok
  await page.route(`${base}/auth/handshake**`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // (Add other endpoints currently hardcoded in spa-config.e2e.test.ts here.
  //  The implementer should copy the full route list from there into this module.)
}
```

**NOTE TO IMPLEMENTER:** The exact set of routes intercepted depends on what the SPA currently polls. The body above is a starting template; the implementer must copy the FULL route list from `spa-config.e2e.test.ts` and parameterize each by `port`. If the current implementation hardcodes `127.0.0.1:7332` anywhere, replace with the parameterized `base`.

- [ ] **Step 3: Update spa-config.e2e.test.ts to use the extracted helper**

Open `client/test/dashboard/spa-config.e2e.test.ts`. Replace the inline `mockDaemonApi` function with:

```typescript
import { mockDaemonApi } from './helpers/mock-daemon-api';
```

Delete the inline function. Verify all call sites still resolve (they should — same name, same signature for the single-arg case since `port` defaults to 7332).

- [ ] **Step 4: Run the existing single-op tests to verify the extraction didn't break anything**

Run: `cd client && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/spa-config.e2e.test.ts`
Expected: same pass/fail as before the extraction (existing tests are the regression check).

- [ ] **Step 5: Commit**

```bash
git add client/test/dashboard/helpers/mock-daemon-api.ts client/test/dashboard/spa-config.e2e.test.ts
git commit -m "refactor(test): extract mockDaemonApi to shared helper with port arg"
```

---

## Task 3: Scenario verdict types

**Files:**
- Create: `client/scripts/release/scenario-types.ts`
- Test: `client/test/release/tier-1/scenario-types.test.ts`

Shared types used by all four T1.x scenario implementations and the runner.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/tier-1/scenario-types.test.ts
import { describe, it, expect } from 'vitest';
import {
  ScenarioVerdictSchema,
  classifyFailure,
  type ScenarioVerdict,
  type FailClass,
} from '../../../scripts/release/scenario-types';

describe('ScenarioVerdictSchema', () => {
  it('parses a pass verdict', () => {
    const v: ScenarioVerdict = {
      scenarioId: 'T1.1',
      verdict: 'pass',
      wallClockMs: 5000,
      evidencePath: '/tmp/T1.1.log',
      failClass: null,
      failNotes: null,
    };
    expect(() => ScenarioVerdictSchema.parse(v)).not.toThrow();
  });

  it('parses a fail verdict with class + notes', () => {
    const v: ScenarioVerdict = {
      scenarioId: 'T1.2',
      verdict: 'fail',
      wallClockMs: 30000,
      evidencePath: '/tmp/T1.2.log',
      failClass: 'real-bug',
      failNotes: 'harness readiness returned malformed shape',
    };
    expect(() => ScenarioVerdictSchema.parse(v)).not.toThrow();
  });

  it('parses a skip verdict', () => {
    const v: ScenarioVerdict = {
      scenarioId: 'T1.3',
      verdict: 'skip',
      wallClockMs: 0,
      evidencePath: '',
      failClass: null,
      failNotes: 'indexer not available locally',
    };
    expect(() => ScenarioVerdictSchema.parse(v)).not.toThrow();
  });

  it('rejects fail without failClass', () => {
    const v = {
      scenarioId: 'T1.1',
      verdict: 'fail',
      wallClockMs: 5000,
      evidencePath: '/tmp/T1.1.log',
      failClass: null,
      failNotes: null,
    };
    expect(() => ScenarioVerdictSchema.parse(v)).toThrow();
  });
});

describe('classifyFailure', () => {
  it('classifies HTTP errors as flake-infra', () => {
    expect(classifyFailure(new Error('HTTP request failed'))).toBe('flake-infra');
    expect(classifyFailure(new Error('fetch failed: ECONNREFUSED'))).toBe('flake-infra');
    expect(classifyFailure(new Error('socket hang up'))).toBe('flake-infra');
  });

  it('classifies timeout patterns as flake-timing', () => {
    expect(classifyFailure(new Error('timed out after 30000ms'))).toBe('flake-timing');
    expect(classifyFailure(new Error('Timeout waiting for selector'))).toBe('flake-timing');
  });

  it('classifies assertion failures as real-bug', () => {
    expect(classifyFailure(new Error('expected 5 to equal 6'))).toBe('real-bug');
    expect(classifyFailure(new Error('AssertionError: arrays differ'))).toBe('real-bug');
  });

  it('classifies unknown errors as real-bug (conservative default)', () => {
    expect(classifyFailure(new Error('something unexpected'))).toBe('real-bug');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/release/tier-1/scenario-types.test.ts`
Expected: FAIL with `Cannot find module '../../../scripts/release/scenario-types'`

- [ ] **Step 3: Implement scenario-types.ts**

```typescript
// client/scripts/release/scenario-types.ts
import { z } from 'zod';

export const FailClassSchema = z.enum(['real-bug', 'flake-infra', 'flake-timing', 'agent-crash']);
export type FailClass = z.infer<typeof FailClassSchema>;

export const VerdictKindSchema = z.enum(['pass', 'fail', 'skip']);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

export const ScenarioVerdictSchema = z.object({
  scenarioId: z.string(),
  verdict: VerdictKindSchema,
  wallClockMs: z.number().int().nonnegative(),
  evidencePath: z.string(),
  failClass: FailClassSchema.nullable(),
  failNotes: z.string().nullable(),
}).refine(
  (v) => v.verdict !== 'fail' || v.failClass !== null,
  { message: 'fail verdicts must include a failClass' },
);

export type ScenarioVerdict = z.infer<typeof ScenarioVerdictSchema>;

export interface ScenarioOptions {
  /** Where the scenario should write its evidence (log file path). */
  evidencePath: string;
  /** Wall-clock budget in ms; scenario should abort if exceeded. */
  wallClockBudgetMs?: number;
  /** Optional RPC URL override. */
  rpcUrl?: string;
}

const FLAKE_INFRA_PATTERNS = [
  /HTTP request failed/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /network/i,
  /getaddrinfo/i,
];
const FLAKE_TIMING_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /waiting for/i,
];

export function classifyFailure(err: unknown): FailClass {
  const msg = err instanceof Error ? err.message : String(err);
  for (const re of FLAKE_INFRA_PATTERNS) {
    if (re.test(msg)) return 'flake-infra';
  }
  for (const re of FLAKE_TIMING_PATTERNS) {
    if (re.test(msg)) return 'flake-timing';
  }
  return 'real-bug';
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd client && yarn vitest run test/release/tier-1/scenario-types.test.ts`
Expected: PASS, 8 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/scenario-types.ts client/test/release/tier-1/scenario-types.test.ts
git commit -m "feat(release): add ScenarioVerdict types + failure classifier"
```

---

## Task 4: T1.1 — bootstrap-fresh-anvil

**Files:**
- Create: `client/test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts` (callable export only — no `vitest` imports)
- Create: `client/test/release/tier-1/T1.1-bootstrap-fresh-anvil.test.ts` (Vitest wrapper that imports the callable)

**NOTE (added 2026-05-19 from PR #347 execution):** Plan C's original task put the callable and the Vitest `describe` block in the same file. The orchestrator imports the callable; if the callable's file has top-level `describe`/`it` from `vitest`, those imports fire on every orchestrator run and crash outside a Vitest test context. Split into two files: the `.ts` file exports `runT11BootstrapFreshAnvil` only; the `.test.ts` file imports it and wraps with Vitest. The code below shows the original single-file shape — when executing, place the `runT11...` function (and its supporting imports) in `T1.1-bootstrap-fresh-anvil.ts`, and the `describe(...)` block (plus its `import { describe, it, expect } from 'vitest'`) in `T1.1-bootstrap-fresh-anvil.test.ts`. Same pattern applies to Tasks 5 and 6.

**What this scenario does:** Spawn an Anvil fork of Base Sepolia, generate a fresh master EOA, fund it, run the bootstrap state machine through all 11 phases, assert phase=`complete`. Cleans up Anvil + tmpdir on exit.

Adapts the existing pattern from `client/scripts/staking-validate.ts`. The reusability: extract the core "bootstrap a fresh operator on Anvil fork" into a callable function that staking-validate and T1.1 both consume.

- [ ] **Step 1: Survey the existing pattern**

Run: `head -80 client/scripts/staking-validate.ts`
Expected: existing script with phases. Note: phases include Anvil spawn, master EOA generation, funding, bootstrap-through-completion, on-chain verification.

- [ ] **Step 2: Write a failing test for the scenario callable**

```typescript
// client/test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT11BootstrapFreshAnvil } from './T1.1-bootstrap-fresh-anvil';
import type { ScenarioVerdict } from '../../../scripts/release/scenario-types';

describe('T1.1 bootstrap-fresh-anvil', () => {
  it('returns pass verdict when bootstrap completes', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.1.log');
    try {
      const verdict: ScenarioVerdict = await runT11BootstrapFreshAnvil({
        evidencePath,
        wallClockBudgetMs: 120000,
      });
      expect(verdict.scenarioId).toBe('T1.1');
      expect(verdict.verdict).toBe('pass');
      expect(verdict.evidencePath).toBe(evidencePath);
      expect(verdict.wallClockMs).toBeGreaterThan(0);
      expect(verdict.failClass).toBeNull();
      // Evidence file should contain phase markers
      const log = await fs.readFile(evidencePath, 'utf-8');
      expect(log).toContain('Phase 1');
      expect(log).toContain('Phase 11');
      expect(log).toContain('complete');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 180000);

  it('returns fail-real-bug verdict when bootstrap stalls', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.1-evidence-stall-'));
    const evidencePath = path.join(evidenceDir, 'T1.1.log');
    try {
      const verdict: ScenarioVerdict = await runT11BootstrapFreshAnvil({
        evidencePath,
        wallClockBudgetMs: 1000,                  // unrealistically short — forces timeout
      });
      expect(verdict.verdict).toBe('fail');
      expect(verdict.failClass).toMatch(/^(flake-timing|real-bug)$/);
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 30000);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd client && yarn vitest run test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts`
Expected: FAIL with `Cannot find export 'runT11BootstrapFreshAnvil'`

- [ ] **Step 4: Implement the callable**

```typescript
// Add above the describe block in the same file:
import { spawnAnvilFork } from '../_support/chain/anvil';
import { baseSepolia } from 'viem/chains';
import { FleetBootstrapper } from '../../../src/earning/bootstrap';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types';

export async function runT11BootstrapFreshAnvil(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  const started = Date.now();
  let anvil: Awaited<ReturnType<typeof spawnAnvilFork>> | null = null;
  const evidenceLines: string[] = [];
  const log = (msg: string) => { evidenceLines.push(`[${new Date().toISOString()}] ${msg}`); };

  try {
    // 1. Spawn Anvil fork
    log('Phase 0: spawn Anvil fork of Base Sepolia');
    anvil = await spawnAnvilFork({
      forkUrl: process.env['BASE_SEPOLIA_RPC_URL']!,
      chain: baseSepolia,
      silent: true,
    });
    log(`Anvil ready at ${anvil.rpcUrl}`);

    // 2. Run bootstrap (the existing FleetBootstrapper, configured for Anvil fork)
    //    The implementer should pattern-match on staking-validate.ts here: tmpdir for HOME,
    //    fund master EOA via `cast send` against Anvil, then await bootstrapper.run().
    //    Capture each phase transition into `evidenceLines`.

    // [PSEUDOCODE — implementer fills in adapted from staking-validate.ts:]
    //   const tmpHome = await fs.mkdtemp(...);
    //   const bootstrapper = new FleetBootstrapper({ home: tmpHome, rpcUrl: anvil.rpcUrl, ... });
    //   for await (const phase of bootstrapper.run({ onPhaseChange: ... })) { log(`Phase: ${phase}`); }
    //   const finalState = await readEarningState(tmpHome);
    //   if (finalState.fleet_stage !== 'stage1_and_2') throw new Error('bootstrap did not complete');

    // Wall-clock budget check
    if (opts.wallClockBudgetMs && Date.now() - started > opts.wallClockBudgetMs) {
      throw new Error(`timed out after ${opts.wallClockBudgetMs}ms`);
    }

    log('Phase 11: complete');
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));

    return {
      scenarioId: 'T1.1',
      verdict: 'pass',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: null,
      failNotes: null,
    };
  } catch (err) {
    const failClass = classifyFailure(err);
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T1.1',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass,
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (anvil) await anvil.teardown();
  }
}
```

**NOTE TO IMPLEMENTER:** The pseudocode section "[PSEUDOCODE — implementer fills in...]" needs to be replaced with real code adapted from `client/scripts/staking-validate.ts`. The existing pattern:
- creates a tmpdir for HOME
- generates a master EOA + funds it via cast against the Anvil RPC
- instantiates `FleetBootstrapper` (or equivalent — check the current naming)
- runs bootstrap and waits for completion
- verifies on-chain state matches expectations

Read `client/scripts/staking-validate.ts` in full first to understand the existing pattern; the T1.1 implementation should be a structural twin.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd client && yarn build && yarn vitest run test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts`
Expected: PASS, 2 tests passing (the second test forces a timeout; verify failure classification works correctly).

- [ ] **Step 6: Commit**

```bash
git add client/test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts
git commit -m "feat(release): add T1.1 bootstrap-fresh-anvil scenario"
```

---

## Task 5: T1.2 — harness-readiness-contract

**Files:**
- Create: `client/test/release/tier-1/T1.2-harness-readiness-contract.ts` (callable export only)
- Create: `client/test/release/tier-1/T1.2-harness-readiness-contract.test.ts` (Vitest wrapper)

(See Task 4's NOTE about the file split. Apply the same split here.)

**What this scenario does:** Spawn a fresh-HOME daemon (no bootstrap needed — daemon can run with a `mode: 'setup'` payload). Query `/v1/harnesses/readiness` and `/v1/harnesses/:name/readiness` for each known harness (`claude-code-learner`, `codex-code-learner`, `hermes-agent`). Assert each response has the expected shape (`{ name, ready: boolean, requirements: [...], reasons: [...] }`).

Catches the vh74-class regression where adding a new harness breaks the readiness contract for existing ones.

- [ ] **Step 1: Write the failing test + implementation skeleton**

```typescript
// client/test/release/tier-1/T1.2-harness-readiness-contract.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons } from '../../helpers/multi-op-daemon';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types';

const KNOWN_HARNESSES = ['claude-code-learner', 'codex-code-learner', 'hermes-agent'] as const;

interface HarnessReadiness {
  name: string;
  ready: boolean;
  requirements: string[];
  reasons: string[];
}

export async function runT12HarnessReadinessContract(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string) => { evidenceLines.push(`[${new Date().toISOString()}] ${msg}`); };

  let daemons: Awaited<ReturnType<typeof spawnMultiOpDaemons>> | null = null;
  let tmpHome: string | null = null;

  try {
    // 1. Set up a fresh tmpdir as HOME
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.2-home-'));
    await fs.mkdir(path.join(tmpHome, '.jinn-client'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, '.jinn-client', 'config.json'),
      JSON.stringify({ network: 'testnet', apiPort: 7740, pollIntervalMs: 5000 }),
    );
    log(`tmp HOME: ${tmpHome}`);

    // 2. Spawn daemon
    daemons = await spawnMultiOpDaemons({
      ops: [{ name: 't12', home: tmpHome, apiPort: 7740 }],
      readyTimeoutMs: 30000,
    });
    log('daemon spawned');

    // 3. Query the index endpoint
    const indexRes = await fetch('http://127.0.0.1:7740/v1/harnesses/readiness');
    if (!indexRes.ok) throw new Error(`/v1/harnesses/readiness returned ${indexRes.status}`);
    const indexBody = await indexRes.json() as { harnesses: HarnessReadiness[] };
    log(`index: ${indexBody.harnesses.length} harnesses reported`);

    // 4. Assert every known harness is present
    for (const expected of KNOWN_HARNESSES) {
      const found = indexBody.harnesses.find((h) => h.name === expected);
      if (!found) throw new Error(`harness ${expected} missing from /v1/harnesses/readiness`);
      log(`  ${expected}: ready=${found.ready}, requirements=${found.requirements.length}`);
    }

    // 5. Query each harness's own readiness endpoint and assert shape matches
    for (const name of KNOWN_HARNESSES) {
      const res = await fetch(`http://127.0.0.1:7740/v1/harnesses/${name}/readiness`);
      if (!res.ok) throw new Error(`/v1/harnesses/${name}/readiness returned ${res.status}`);
      const body = await res.json() as HarnessReadiness;
      if (body.name !== name) {
        throw new Error(`/v1/harnesses/${name}/readiness returned name=${body.name}`);
      }
      if (typeof body.ready !== 'boolean') {
        throw new Error(`/v1/harnesses/${name}/readiness returned ready=${typeof body.ready}`);
      }
      if (!Array.isArray(body.requirements)) {
        throw new Error(`/v1/harnesses/${name}/readiness returned requirements not an array`);
      }
    }
    log('all known harnesses have valid readiness shape');

    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T1.2',
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
      scenarioId: 'T1.2',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: classifyFailure(err),
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (daemons) await daemons.teardown();
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

describe('T1.2 harness-readiness-contract', () => {
  it('returns pass verdict when all known harnesses report valid shape', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.2-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.2.log');
    try {
      const verdict = await runT12HarnessReadinessContract({ evidencePath });
      expect(verdict.scenarioId).toBe('T1.2');
      expect(verdict.verdict).toBe('pass');
      expect(verdict.failClass).toBeNull();
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 60000);
});
```

- [ ] **Step 2: Run test**

Run: `cd client && yarn build && yarn vitest run test/release/tier-1/T1.2-harness-readiness-contract.ts`
Expected: PASS (the test verifies real behavior against a spawned daemon — `yarn build` is required first).

- [ ] **Step 3: Commit**

```bash
git add client/test/release/tier-1/T1.2-harness-readiness-contract.ts
git commit -m "feat(release): add T1.2 harness-readiness-contract scenario"
```

---

## Task 6: T1.3 — indexer-round-trip

**Files:**
- Create: `client/test/release/tier-1/T1.3-indexer-round-trip.ts` (callable export only)
- Create: `client/test/release/tier-1/T1.3-indexer-round-trip.test.ts` (Vitest wrapper)

(See Task 4's NOTE about the file split. Apply the same split here.)

**Update from PR #347 execution:** the executing session marked T1.3 as `skip` because the Ponder spawn helper didn't exist yet. The session filed **GitHub issue #341** to track the Ponder helper. Plan D's Task 2 builds the helper, so the skip will lift when Plan D lands.

**What this scenario does:** Spawn a local Ponder indexer + a daemon configured to use it. Post a task on Anvil fork. Query the Discovery API (`/v1/discovery/tasks` or equivalent). Assert the posted task appears with the correct schema.

This catches the fufn-class regression where indexer schema drifts away from what the daemon writes.

**Complexity flag:** Local Ponder spawn is non-trivial. If a Ponder spawn helper doesn't already exist in `client/test/_support/`, this task should either:
1. Create one (adds significant scope), or
2. Skip this scenario for v1 of Tier 1 (mark as TODO; file GH issue).

The implementer should first check `client/test/_support/` for a Ponder helper. If absent and creation is out of scope, file a GH issue (`gh issue create --label release-readiness --title 'Tier 1 T1.3 needs Ponder spawn helper'`) and skip this task. Tasks 7+ continue without T1.3.

- [ ] **Step 1: Check for an existing Ponder spawn helper**

Run: `find client/test -name "*ponder*" -o -name "*indexer*" 2>/dev/null | head -10`

If results exist: continue with this task using the existing helper. If not: file a GH issue and skip to Task 7.

- [ ] **Step 2 (if helper exists): Write the scenario**

```typescript
// client/test/release/tier-1/T1.3-indexer-round-trip.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons } from '../../helpers/multi-op-daemon';
import { spawnAnvilFork } from '../_support/chain/anvil';
import { baseSepolia } from 'viem/chains';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types';
// import { spawnPonderIndexer } from '../_support/indexer/ponder';   // path TBD by implementer

export async function runT13IndexerRoundTrip(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string) => { evidenceLines.push(`[${new Date().toISOString()}] ${msg}`); };

  // [PSEUDOCODE — implementer fills in:]
  //   1. Spawn Anvil fork (existing helper)
  //   2. Spawn Ponder indexer pointed at Anvil's RPC
  //   3. Spawn a daemon with config pointing at Anvil + Ponder
  //   4. POST a task via daemon API
  //   5. Poll Ponder GraphQL until the task appears
  //   6. Assert the indexed row matches what was posted (id, type, owner, etc.)
  //   7. Cleanup all three

  // Wall-clock budget: 60s

  // For the v1 of this scenario, if Ponder spawn is too complex, mark as 'skip'
  // verdict with failNotes explaining the gap, so the runner doesn't block.
  await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
  return {
    scenarioId: 'T1.3',
    verdict: 'skip',
    wallClockMs: Date.now() - started,
    evidencePath: opts.evidencePath,
    failClass: null,
    failNotes: 'Implementation pending — see GH issue (filed in Step 1 if helper missing)',
  };
}

describe('T1.3 indexer-round-trip', () => {
  it('runs (or marks as skip if helper missing)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.3-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.3.log');
    try {
      const verdict = await runT13IndexerRoundTrip({ evidencePath });
      expect(['pass', 'skip']).toContain(verdict.verdict);
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 90000);
});
```

- [ ] **Step 3: Run test**

Run: `cd client && yarn build && yarn vitest run test/release/tier-1/T1.3-indexer-round-trip.ts`
Expected: PASS (either the real scenario passes, or it marks as skip — the test accepts either).

- [ ] **Step 4: Commit**

```bash
git add client/test/release/tier-1/T1.3-indexer-round-trip.ts
git commit -m "feat(release): add T1.3 indexer-round-trip scenario (or skip-stub if helper missing)"
```

---

## Task 7: T1.4 — SPA route smoke

**Files:**
- Create: `client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts`

**What this scenario does:** Per the contract in `.claude/skills/testing-jinn-app/references/scenario-spa-route-smoke.md` (Plan B): load every route in `ROUTES`, assert no JS errors / no React error boundaries / no missing-mock console errors / route renders past spinner.

- [ ] **Step 1: Write the Playwright test**

```typescript
// client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts
import { test, expect } from '@playwright/test';
import { mockDaemonApi } from '../helpers/mock-daemon-api';
import { ROUTES, expandRoutePath, type RouteSpec } from '../../../src/dashboard/spa/src/routes';

// Patterns that may show up as console.error but are harmless noise.
// Add entries only after investigating and confirming the error is genuinely benign.
const HARMLESS_CONSOLE_ERROR_PATTERNS: RegExp[] = [
  /ResizeObserver loop completed/i,
];

test.describe('T1.4 — SPA route smoke', () => {
  for (const route of ROUTES) {
    test(`renders clean at ${route.label}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: Error[] = [];

      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => pageErrors.push(err));

      await mockDaemonApi(page);

      const url = `http://127.0.0.1:7332${expandRoutePath(route)}`;
      await page.goto(url);

      // Wait for SOMETHING rendered. Tolerant: any of these means the SPA painted.
      await page.waitForSelector(
        'main, [data-page-loaded], [data-app-shell], [data-error-boundary], h1',
        { timeout: 5000 },
      );

      // No JS errors
      expect(pageErrors, `pageerror events at ${route.label}`).toHaveLength(0);

      // No React error boundary visible
      const boundaryCount = await page.locator('[data-error-boundary]').count();
      expect(boundaryCount, `error boundary at ${route.label}`).toBe(0);

      // No console errors after filtering harmless
      const real = consoleErrors.filter(
        (err) => !HARMLESS_CONSOLE_ERROR_PATTERNS.some((re) => re.test(err)),
      );
      expect(real, `console errors at ${route.label}`).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `cd client && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/release-prep/spa-route-smoke.e2e.test.ts`
Expected: PASS — one passing test per route in `ROUTES` (currently ~11).

If a route fails: triage. Either the SPA has a bug (real catch), or the route's data dependency isn't mocked (extend `mockDaemonApi`).

- [ ] **Step 3: Commit**

```bash
git add client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts
git commit -m "feat(release): add T1.4 SPA route smoke Playwright test"
```

---

## Task 8: run-tier-1.ts orchestrator

**Files:**
- Create: `client/scripts/release/run-tier-1.ts`

**What this script does:** Imports T1.1, T1.2, T1.3 callables. Runs them in parallel via `Promise.allSettled`. Invokes T1.4 via the Playwright CLI as a subprocess (since it's a different test runner). Collects all four verdicts. Prints a structured JSON summary + a marker block to stdout. Exits 0 if all pass, 1 if any `verdict=fail` with `failClass=real-bug`, 2 on internal error.

- [ ] **Step 1: Implement the orchestrator**

```typescript
// client/scripts/release/run-tier-1.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runT11BootstrapFreshAnvil } from '../../test/release/tier-1/T1.1-bootstrap-fresh-anvil';
import { runT12HarnessReadinessContract } from '../../test/release/tier-1/T1.2-harness-readiness-contract';
import { runT13IndexerRoundTrip } from '../../test/release/tier-1/T1.3-indexer-round-trip';
import { type ScenarioVerdict, ScenarioVerdictSchema, classifyFailure } from './scenario-types';

interface RunOptions {
  outputDir?: string;          // default: ./tier-1-evidence/<timestamp>/
  candidateVersion?: string;   // for marker block
}

async function runT14SpaRouteSmoke(outputDir: string): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidencePath = path.join(outputDir, 'T1.4.log');
  return new Promise<ScenarioVerdict>((resolve) => {
    const child = spawn(
      'yarn',
      [
        'playwright',
        'test',
        '--config=playwright.config.ts',
        'test/dashboard/release-prep/spa-route-smoke.e2e.test.ts',
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
      const verdict: ScenarioVerdict = {
        scenarioId: 'T1.4',
        verdict: code === 0 ? 'pass' : 'fail',
        wallClockMs: Date.now() - started,
        evidencePath,
        failClass: code === 0 ? null : classifyFailure(new Error(stderr || stdout)),
        failNotes: code === 0 ? null : `Playwright exited ${code}`,
      };
      resolve(verdict);
    });
  });
}

export async function runTier1(opts: RunOptions = {}): Promise<{ verdicts: ScenarioVerdict[]; allPassed: boolean }> {
  const outputDir = opts.outputDir ?? path.join(
    process.cwd(),
    'tier-1-evidence',
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  );
  await fs.mkdir(outputDir, { recursive: true });

  // Run T1.1-T1.3 callables in parallel
  const scenarioPromises = [
    runT11BootstrapFreshAnvil({ evidencePath: path.join(outputDir, 'T1.1.log'), wallClockBudgetMs: 120000 }),
    runT12HarnessReadinessContract({ evidencePath: path.join(outputDir, 'T1.2.log') }),
    runT13IndexerRoundTrip({ evidencePath: path.join(outputDir, 'T1.3.log') }),
  ];
  const settled = await Promise.allSettled(scenarioPromises);
  const callableVerdicts: ScenarioVerdict[] = settled.map((result, idx) => {
    if (result.status === 'fulfilled') return result.value;
    const ids = ['T1.1', 'T1.2', 'T1.3'];
    return {
      scenarioId: ids[idx],
      verdict: 'fail' as const,
      wallClockMs: 0,
      evidencePath: path.join(outputDir, `${ids[idx]}.log`),
      failClass: 'agent-crash' as const,
      failNotes: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });

  // T1.4 needs a separate subprocess (Playwright)
  const t14 = await runT14SpaRouteSmoke(outputDir);
  const verdicts = [...callableVerdicts, t14];

  // Validate all verdicts pass schema
  for (const v of verdicts) ScenarioVerdictSchema.parse(v);

  const allPassed = verdicts.every((v) => v.verdict === 'pass');

  // Write summary
  const summary = {
    candidateVersion: opts.candidateVersion ?? 'unknown',
    timestamp: new Date().toISOString(),
    verdicts,
    allPassed,
  };
  await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // Marker block
  const markerLines = [
    '<!-- jinn-release-evidence:v1',
    `release-candidate=${opts.candidateVersion ?? 'unknown'}`,
    ...verdicts.map((v) => {
      const key = `tier-1-${v.scenarioId.toLowerCase().replace(/\./g, '-')}`;
      if (v.verdict === 'pass') return `${key}=passed`;
      if (v.verdict === 'skip') return `${key}=skipped:${v.failNotes ?? 'no-reason'}`;
      return `${key}=failed:${v.failClass}`;
    }),
    `tier-1-overall=${allPassed ? 'passed' : 'failed'}`,
    '-->',
  ];
  await fs.writeFile(path.join(outputDir, 'marker.txt'), markerLines.join('\n') + '\n');

  return { verdicts, allPassed };
}

async function cliMain(): Promise<void> {
  const candidateVersion = process.argv[2];
  const { verdicts, allPassed } = await runTier1({ candidateVersion });
  console.log(JSON.stringify({ verdicts, allPassed }, null, 2));

  // Real-bug failures exit non-zero; flake/skip exits zero (operator decides ship)
  const hasRealBug = verdicts.some((v) => v.verdict === 'fail' && v.failClass === 'real-bug');
  process.exit(hasRealBug ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error('run-tier-1 crashed:', err);
    process.exit(2);
  });
}
```

- [ ] **Step 2: Manual smoke test**

Run: `cd client && yarn build && tsx scripts/release/run-tier-1.ts v0.1.7-smoke`
Expected: prints structured JSON verdicts; exits 0 or 1 depending on results. Creates `tier-1-evidence/<timestamp>/` with per-scenario logs + summary + marker.

If the smoke test fails on real infrastructure issues (e.g. Anvil unavailable), that's a real environmental issue to fix — not a bug in the orchestrator.

- [ ] **Step 3: Commit**

```bash
git add client/scripts/release/run-tier-1.ts
git commit -m "feat(release): add run-tier-1 orchestrator"
```

---

## Task 9: release-prep SKILL.md + tier-1-scenarios.md reference

**Files:**
- Create: `.claude/skills/release-prep/SKILL.md`
- Create: `.claude/skills/release-prep/references/tier-1-scenarios.md`

- [ ] **Step 1: Create the skill SKILL.md**

Save as `.claude/skills/release-prep/SKILL.md`:

```markdown
# release-prep

Mechanical gate-runner skill. Runs Tier 1 (and eventually Tier 2) scenarios against a candidate branch, classifies failures, emits a marker block ready to paste into a GitHub Release body.

This skill is *not* the audit layer — that's `release-readiness`. release-prep runs gates and reports; it doesn't decide blocking vs deferrable. release-readiness invokes release-prep as a subagent.

## When to use

- Invoked by `release-readiness` during its Phase 5 validation.
- Invoked manually when an operator wants gate evidence for a candidate SHA.
- (Future) invoked by a CI workflow that wants on-every-push Tier 1 evidence.

## Input contract

```typescript
interface ReleasePrepInput {
  branchSha: string;
  candidateVersion: string;
  outputDir?: string;
  scenarios?: ScenarioId[];     // optional; default = all enabled
}
```

## Output

- `<outputDir>/summary.json` — structured verdict list
- `<outputDir>/marker.txt` — marker block for the release body
- `<outputDir>/T1.1.log`, `T1.2.log`, etc. — per-scenario evidence

## How to invoke

```bash
# Run all of Tier 1 against the current working tree
cd client && tsx scripts/release/run-tier-1.ts <candidate-version>

# Or via yarn
yarn release:tier-1 <candidate-version>
```

## Tier 1 scenarios

Detailed contracts: [`references/tier-1-scenarios.md`](references/tier-1-scenarios.md)

| ID | Name | Wall-clock budget |
|---|---|---|
| T1.1 | bootstrap-fresh-anvil | 90s |
| T1.2 | harness-readiness-contract | 30s |
| T1.3 | indexer-round-trip | 60s |
| T1.4 | SPA route smoke | 30s |

All four run in parallel. Wall-clock for the tier ≈ max of the budgets (~90s).

## Tier 2 scenarios

Detailed contracts: [`references/tier-2-scenarios.md`](references/tier-2-scenarios.md) (placeholder; expanded by Plan D)

Tier 2 implementations land in Plan D. release-prep's runner will be extended at that point to call a `run-tier-2.ts` orchestrator alongside `run-tier-1.ts`.

## Failure classification

[`references/failure-classification.md`](references/failure-classification.md)

## Evidence format

[`references/evidence-format.md`](references/evidence-format.md)

## What this skill does NOT do

- Decide ship/no-ship (release-readiness)
- Triage gaps as blocking-vs-deferrable (release-readiness)
- Run Tier 3 (release-readiness)
- Modify the candidate branch in any way (read-only)
```

- [ ] **Step 2: Create the tier-1-scenarios reference doc**

Save as `.claude/skills/release-prep/references/tier-1-scenarios.md`:

```markdown
# Tier 1 scenarios

Four scenarios, all single-operator, all run on every push to `next` (canary cadence) plus inside `release-prep` for any candidate version. None of them use the substrate from Plan A — Tier 1 is bootstrap-from-scratch territory.

## T1.1 — bootstrap-fresh-anvil

**Catches:** u34i / h74p / k1ng / 3nc5 bootstrap-reliability bugs.

**What it does:** Anvil-forks Base Sepolia, generates a fresh master EOA, funds it, runs the bootstrap state machine through all 11 phases. Asserts `phase=complete`.

**Implementation:** `client/test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts`

**Wall-clock budget:** 90s

## T1.2 — harness-readiness-contract

**Catches:** vh74 per-harness auth regressions; harness-readiness shape drift; missing harnesses.

**What it does:** Spawns a fresh-HOME daemon (setup mode is enough — no bootstrap needed). Queries `/v1/harnesses/readiness` (index) and `/v1/harnesses/:name/readiness` (per harness). Asserts every known harness (`claude-code-learner`, `codex-code-learner`, `hermes-agent`) is present and returns the expected shape.

**Implementation:** `client/test/release/tier-1/T1.2-harness-readiness-contract.ts`

**Wall-clock budget:** 30s

## T1.3 — indexer-round-trip

**Catches:** fufn eval-substrate / indexer schema drift.

**What it does:** Spawns a local Ponder indexer + a daemon configured to use it (against an Anvil fork). Posts a task. Polls the Discovery API. Asserts the indexed row matches what was posted.

**Implementation:** `client/test/release/tier-1/T1.3-indexer-round-trip.ts`

**Wall-clock budget:** 60s

**Status:** May be `skip` in v1 if a Ponder spawn helper isn't available. Tracked as a follow-up GH issue.

## T1.4 — SPA route smoke

**Catches:** broken routes, missing mocks, JS errors, React error boundary firings.

**What it does:** Playwright test. Loads every route in `client/src/dashboard/spa/src/routes.ts` against a mocked daemon API. For each, asserts no JS error, no error boundary visible, no console error (after filtering harmless patterns), route renders past the spinner.

**Implementation:** `client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts`

**Wall-clock budget:** 30s per route × ~11 routes ≈ 5min sequential, ~30s parallel (Playwright's default workers).

## Contract docs in testing-jinn-app

The "what does this scenario actually exercise" docs are in `testing-jinn-app` references (Plan B). release-prep references just point at them:

- T1.4: [`testing-jinn-app/references/scenario-spa-route-smoke.md`](../../testing-jinn-app/references/scenario-spa-route-smoke.md)
- (T1.1-T1.3 are simple enough to be fully described by their implementation files; no separate contract doc needed.)
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/release-prep/SKILL.md .claude/skills/release-prep/references/tier-1-scenarios.md
git commit -m "docs(release-prep): add skill + tier-1-scenarios reference"
```

---

## Task 10: release-prep references — evidence-format + failure-classification + tier-2 placeholder

**Files:**
- Create: `.claude/skills/release-prep/references/evidence-format.md`
- Create: `.claude/skills/release-prep/references/failure-classification.md`
- Create: `.claude/skills/release-prep/references/tier-2-scenarios.md`

- [ ] **Step 1: Create evidence-format.md**

Save:

```markdown
# Evidence format

Each release-prep run produces three artifact types under `<outputDir>/`:

1. **`summary.json`** — structured verdict list, parseable by release-readiness.

   ```json
   {
     "candidateVersion": "v0.1.7",
     "timestamp": "2026-05-26T11:30:00Z",
     "verdicts": [
       {
         "scenarioId": "T1.1",
         "verdict": "pass",
         "wallClockMs": 87234,
         "evidencePath": "tier-1-evidence/2026-05-26T11-30-00/T1.1.log",
         "failClass": null,
         "failNotes": null
       },
       { "scenarioId": "T1.2", "verdict": "pass", "..." : "..." }
     ],
     "allPassed": true
   }
   ```

2. **`marker.txt`** — pasteable marker for the GitHub Release body.

   ```
   <!-- jinn-release-evidence:v1
   release-candidate=v0.1.7
   tier-1-t1-1=passed
   tier-1-t1-2=passed
   tier-1-t1-3=skipped:helper-pending
   tier-1-t1-4=passed
   tier-1-overall=passed
   -->
   ```

   The schema extends the existing `jinn-release-evidence:v1` shape with `tier-1-*` keys. Each scenario gets one key shaped `tier-1-<id-lowercased-dot-to-dash>=<status>`. Status is one of `passed`, `failed:<failClass>`, or `skipped:<reason>`.

3. **`<scenarioId>.log`** — per-scenario evidence file. Free-form text written by each scenario; convention is to include phase markers and timestamps.

## Consumption

`release-readiness` reads `summary.json` directly (structured). The marker block in `marker.txt` is what gets pasted into the GH Release body so the existing marker check in `.github/workflows/npm-publish.yml` validates it. The `.log` files are for humans investigating failures.

## Output directory layout

```
tier-1-evidence/
  2026-05-26T11-30-00-abc4/
    summary.json
    marker.txt
    T1.1.log
    T1.2.log
    T1.3.log
    T1.4.log
```

Older directories under `tier-1-evidence/` should be cleaned up periodically (analogous to substrate's workspace reaper). Out of scope for Plan C.
```

- [ ] **Step 2: Create failure-classification.md**

Save:

```markdown
# Failure classification

Every `fail` verdict has a `failClass` — release-readiness uses it to decide whether a fail blocks ship.

## Classes

| Class | Pattern | Triage default |
|---|---|---|
| `real-bug` | assertion failures, schema mismatches, unexpected returned values | BLOCKING |
| `flake-infra` | HTTP errors, ECONNREFUSED, ECONNRESET, network errors, getaddrinfo failures | retry once → if persistent, DEFERRABLE |
| `flake-timing` | "timed out", "timeout", "waiting for X" | retry once → if persistent, DEFERRABLE |
| `agent-crash` | scenario itself threw before producing a verdict | escalate to human |

## Detection

`classifyFailure(err)` in `client/scripts/release/scenario-types.ts` regex-matches the error message against pattern lists. Conservative default: unknown errors are classified `real-bug` (so a genuine bug isn't accidentally treated as a flake).

## Adding patterns

When a real infrastructure issue keeps showing up as `real-bug`, extend the `FLAKE_INFRA_PATTERNS` or `FLAKE_TIMING_PATTERNS` lists in `scenario-types.ts`. Each addition should be accompanied by a regression test in `scenario-types.test.ts` so the classification is durable.

## What release-readiness does with each class

- `real-bug` → adds to BLOCKING gaps; closure subagent dispatched
- `flake-infra` → retry once; if persistent, marks as DEFERRABLE with a `tier-1-...=flake-infra` marker
- `flake-timing` → same as flake-infra
- `agent-crash` → escalate to human; recommendation = DEFER with diagnostic in handoff doc
```

- [ ] **Step 3: Create tier-2-scenarios placeholder**

Save:

```markdown
# Tier 2 scenarios

**Status:** Placeholder. Implementations land in Plan D.

Tier 2 scenarios run cross-operator against substrate-derived workspaces. The contracts (what each scenario asserts) are in `testing-jinn-app` reference docs:

- T2.1 — cross-operator-donation: [`testing-jinn-app/references/scenario-cross-op-donation.md`](../../testing-jinn-app/references/scenario-cross-op-donation.md)
- T2.2 — producer-evaluator-anvil-fork: [`testing-jinn-app/references/scenario-producer-evaluator.md`](../../testing-jinn-app/references/scenario-producer-evaluator.md)
- T2.3 — multi-op-spa-flow: [`testing-jinn-app/references/scenario-multi-op-spa-flow.md`](../../testing-jinn-app/references/scenario-multi-op-spa-flow.md)

When Plan D lands:
- Implementations at `client/test/release/tier-2/T2.1.ts`, `T2.2.ts`, `T2.3.ts` (plus the Playwright one at `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts`)
- Orchestrator at `client/scripts/release/run-tier-2.ts`
- This placeholder doc expanded with the same depth as `tier-1-scenarios.md`
- release-prep SKILL.md's Tier 2 table populated with wall-clock budgets

Plan D depends on Plan A (substrate), Plan B (helpers), and Plan C (release-prep skill scaffolding from this plan).
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/release-prep/references/evidence-format.md .claude/skills/release-prep/references/failure-classification.md .claude/skills/release-prep/references/tier-2-scenarios.md
git commit -m "docs(release-prep): add evidence-format, failure-classification, tier-2 placeholder"
```

---

## Task 11: CI workflow migration — replace operator-gate with Tier 1

**Files:**
- Modify: `.github/workflows/npm-publish.yml`

The current workflow has a `Release gate — operator-gate` step that's been failing on infra (`jinn-mono-lrey`). Replace it with a `Tier 1 — mechanical floor` step that runs the new orchestrator.

- [ ] **Step 1: Read the current operator-gate step**

Run: `awk '/Release gate — operator-gate/,/^      -/' .github/workflows/npm-publish.yml | head -25`
Expected: the existing `continue-on-error: true` operator-gate step.

- [ ] **Step 2: Replace the step**

Open `.github/workflows/npm-publish.yml`. Find this block:

```yaml
      # NOTE: marked continue-on-error 2026-05-19 because the gate
      # saturates the Tenderly Base Sepolia key during a single run —
      # multiple full fork operator bootstraps in one job exceed the
      # quota and produce HTTP errors unrelated to the candidate release.
      # See jinn-mono-lrey for the architectural follow-up
      # (per-call RPC footprint, key isolation, fork-state caching, etc.).
      # Until that lands, ship decisions rely on independent evidence
      # (real testnet A3 verification, local release-prep gates).
      - name: Release gate — operator-gate (staking + e2e on Anvil fork)
        if: steps.meta.outputs.dist_tag == 'latest'
        continue-on-error: true
        run: yarn release:operator-gate
```

Replace with:

```yaml
      # Tier 1 — mechanical floor (per spec/2026-05-19 §3 of release-readiness design).
      # Replaces the legacy operator-gate that saturated the Tenderly RPC under
      # multi-bootstrap load (see jinn-mono-lrey). Tier 1 runs four scenarios
      # (T1.1-T1.4) in parallel against a single Anvil fork; per-scenario budgets
      # cap wall-clock; verdicts feed the release-evidence marker.
      - name: Release gate — Tier 1 mechanical floor
        if: steps.meta.outputs.dist_tag == 'latest'
        run: yarn release:tier-1 "${{ steps.meta.outputs.publish_version }}"
```

Note: `continue-on-error: true` is REMOVED for Tier 1. Tier 1 is meant to be reliable; a flake here should fail the publish (operator can re-run if it was a real flake). If Tier 1 turns out to flake often in CI, file a GH issue and reconsider.

- [ ] **Step 3: Verify YAML syntax**

Run: `actionlint .github/workflows/npm-publish.yml` (if `actionlint` is available) OR rely on GitHub Actions to surface YAML errors on push.

If `actionlint` isn't installed, manual check: indentation, key alignment. The step should integrate cleanly with the surrounding steps.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/npm-publish.yml
git commit -m "ci(release): replace operator-gate with Tier 1 mechanical floor"
```

**NOTE:** This commit *changes CI behavior on the next push to `next`*. If Plans A-C land separately, ensure Plan A's substrate scripts are present on `next` before this commit lands, otherwise `yarn release:tier-1` will fail to import substrate paths. (Tier 1 itself doesn't use substrate, but the orchestrator imports `scenario-types.ts` which is in the same `client/scripts/release/` tree as substrate scripts — verify no cross-imports.)

The implementer should verify `tsx scripts/release/run-tier-1.ts v0.1.7-smoke` runs cleanly *before* this commit lands.

---

## Task 12: README + yarn scripts wiring

**Files:**
- Modify: `client/package.json` (add yarn scripts)
- Create: `client/scripts/release/README.md` (if not created by Plan A; otherwise extend it)

- [ ] **Step 1: Add yarn scripts**

Open `client/package.json`. In the `"scripts"` object, add:

```json
{
  "scripts": {
    "release:tier-1": "tsx scripts/release/run-tier-1.ts",
    "release:tier-1:T1.1": "vitest run test/release/tier-1/T1.1-bootstrap-fresh-anvil.ts",
    "release:tier-1:T1.2": "vitest run test/release/tier-1/T1.2-harness-readiness-contract.ts",
    "release:tier-1:T1.3": "vitest run test/release/tier-1/T1.3-indexer-round-trip.ts",
    "release:tier-1:T1.4": "playwright test --config=playwright.config.ts test/dashboard/release-prep/spa-route-smoke.e2e.test.ts"
  }
}
```

- [ ] **Step 2: Verify yarn scripts work**

Run: `cd client && yarn release:tier-1:T1.2 2>&1 | tail -10`
Expected: T1.2 test executes (passes or fails based on actual daemon behavior; orchestrator semantics not exercised by per-scenario yarn scripts).

Run: `cd client && yarn release:tier-1 v0.1.7-yarn-smoke 2>&1 | tail -20`
Expected: orchestrator runs all four scenarios, exits with verdict summary.

- [ ] **Step 3: Update or create release README**

If Plan A already created `client/scripts/release/README.md`, extend it with:

```markdown
## Tier 1 orchestrator

`run-tier-1.ts` runs all four Tier 1 scenarios in parallel and emits a structured verdict.

```bash
yarn release:tier-1 <candidate-version>
```

Output goes to `tier-1-evidence/<timestamp>/` with `summary.json`, `marker.txt`, and per-scenario `.log` files.

Per-scenario standalone invocations:

```bash
yarn release:tier-1:T1.1    # bootstrap-fresh-anvil
yarn release:tier-1:T1.2    # harness-readiness-contract
yarn release:tier-1:T1.3    # indexer-round-trip
yarn release:tier-1:T1.4    # SPA route smoke
```

Spec: `docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md` §3.
```

If the README doesn't exist yet (Plan A hadn't landed), create it with both the substrate ops section (from Plan A) AND this Tier 1 section. The implementer should check Plan A's README content first.

- [ ] **Step 4: Commit**

```bash
git add client/package.json client/scripts/release/README.md
git commit -m "chore(release): wire yarn scripts + README for Tier 1"
```

---

## Self-review

### Spec coverage

| Spec requirement | Covered by | Status |
|---|---|---|
| §3 release-prep skill | Tasks 9, 10 | ✓ |
| §3 Tier 1 scenarios T1.1-T1.4 | Tasks 4-7 | ✓ |
| §3 run-tier-1 orchestrator | Task 8 | ✓ |
| §3 failure classification | Task 3 + Task 10 (doc) | ✓ |
| §3 evidence + marker emission | Task 8 + Task 10 (doc) | ✓ |
| §6 T1.4 SPA route smoke | Task 7 | ✓ |
| §1 CI workflow migration | Task 11 | ✓ |
| Plan B fold-back: mockDaemonApi extraction | Task 2 | ✓ |
| Plan B fold-back: ROUTES export | Task 1 | ✓ |

### Placeholder scan

- Task 4 (T1.1) has a `[PSEUDOCODE — implementer fills in...]` block — necessarily, because adapting the existing `staking-validate.ts` requires reading its current state. This is flagged with explicit instructions to the implementer. Acceptable: the structural skeleton is concrete; only the bootstrap-loop call is left to adapt.
- Task 6 (T1.3) has a similar PSEUDOCODE block plus a `skip` fallback path — necessary because the Ponder spawn helper may not exist yet. The plan provides the skip path so the orchestrator doesn't block.
- All other tasks contain complete, copy-pasteable code.

### Type consistency

- `ScenarioVerdict`, `FailClass`, `ScenarioOptions` consistent across Tasks 3-8.
- `runT11BootstrapFreshAnvil`, `runT12HarnessReadinessContract`, `runT13IndexerRoundTrip` signature identical: `(opts: ScenarioOptions) => Promise<ScenarioVerdict>`.
- Import paths verified: `multi-op-daemon` and `handshake-url` from Plan B; `scenario-types` from this plan's Task 3; `spawnAnvilFork` from `client/test/_support/chain/anvil.ts` (verified to exist by Plan B's fold-back).

### Cross-plan contract check

This plan promises Plan D the following inputs:
- `client/scripts/release/scenario-types.ts` — Plan D's Tier 2 scenarios use the same types.
- `.claude/skills/release-prep/SKILL.md` — Plan D extends the Tier 2 section.
- `.claude/skills/release-prep/references/tier-2-scenarios.md` placeholder — Plan D expands it.
- `client/scripts/release/run-tier-1.ts` — Plan D may model `run-tier-2.ts` on it.

This plan promises Plan E:
- `.claude/skills/release-prep/SKILL.md` exists and is invocable as a subagent.
- Evidence/marker format documented (Plan E's release-readiness consumes this output).

### Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-tier-1-and-release-prep-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task. The plan has 12 tasks; subagent flow keeps the implementer's context per-task small and catches plan-spec bugs via the review pass (same pattern Plan B and Plan A executions used).

2. **Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`.

Plan C depends on Plan B's helpers (`multi-op-daemon`, `handshake-url`, `mockDaemonApi`-extraction). If Plan B isn't merged yet, Plan C execution can still proceed on a branch based off the Plan B branch (`feat/testing-jinn-app-multi-op`). Once Plan B merges to `next`, rebase.

Plan C does NOT depend on Plan A at runtime — Tier 1 scenarios don't touch the substrate. Plan A and Plan C can land in either order.

Which approach?
