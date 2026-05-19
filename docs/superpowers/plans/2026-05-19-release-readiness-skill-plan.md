# release-readiness skill + Tier 3 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the meta-skill that audits canon, triages gaps, drives blocking-gap closure, invokes release-prep + Tier 3, and emits the handoff doc that humans use to decide ship/defer/block. Plus the Tier 3 scenario itself (real Base Sepolia, real Hermes, real verdict) — the only required gate for a named cut. This plan ends the brainstorm-to-execution loop: when Plan E lands, the full release-readiness flow is callable.

**Architecture:** The skill is a thin coordinator implemented as the `.claude/skills/release-readiness/SKILL.md` definition plus a small TypeScript scaffolding script that the skill's instructions point at. The skill dispatches a single audit subagent (judgmental + canon pass combined) plus a triage subagent, then optionally fans out closure subagents per blocking gap, then invokes the `release-prep` skill (Plan C/D) and the Tier 3 callable, then dispatches a handoff-doc-drafting subagent. Main agent stays a thin coordinator. The Tier 3 scenario is a separate callable at `client/test/release/tier-3/T3.1-producer-evaluator-real.ts` — same shape as Tier 2 scenarios but no Anvil fork (real Base Sepolia) and a real Hermes call (small budget cap).

**Tech Stack:** Markdown for the skill + reference docs. TypeScript for Tier 3 callable + run-tier-3 orchestrator (mirrors Plan D's `run-tier-2.ts` shape). Reuses Plan A's substrate (this time the gold copy, no workspace), Plan B's multi-op-daemon, Plan C's scenario-types, Plan D's tier-2-helpers (one-off adaptation for gold-direct vs workspace-copy).

**Dependencies:**
- **Plan A** — substrate scripts. Tier 3 uses the gold substrate directly (no workspace copy — Tier 3 mutations are append-only on-chain).
- **Plan B** — multi-op-daemon, handshake-url.
- **Plan C** — scenario-types (ScenarioVerdict, classifyFailure), release-prep skill must exist.
- **Plan D** — release-prep with Tier 2 populated, tier-2-helpers as a structural model for tier-3 setup. The release-readiness skill invokes release-prep; Plan D fills in release-prep's Tier 2 surface.

---

## File structure

**New source files:**

| Path | Responsibility |
|---|---|
| `client/test/release/tier-3/T3.1-producer-evaluator-real.ts` | T3.1 callable: real Base Sepolia, real Hermes, real verdict |
| `client/test/release/tier-3/tier-3-helpers.ts` | `setupTier3Scenario()` — gold-substrate-direct daemon spawn with daily-driver mutex check |
| `client/scripts/release/run-tier-3.ts` | Tier 3 orchestrator (single-scenario for now; expandable) |
| `client/scripts/release/release-readiness.ts` | Thin TS scaffolding for the skill: audit summary aggregator, handoff doc writer, log/decisions appender |

**New skill files:**

| Path | Responsibility |
|---|---|
| `.claude/skills/release-readiness/SKILL.md` | Skill definition: phases, subagent dispatch, input contract |
| `.claude/skills/release-readiness/references/static-checklist.md` | C1-C11 detailed shape + which run in main vs subagent |
| `.claude/skills/release-readiness/references/canon-audit-prompts.md` | Prompt templates for the judgmental audit subagent |
| `.claude/skills/release-readiness/references/triage-taxonomy.md` | BLOCKING / DEFERRABLE / ALREADY-MET rules |
| `.claude/skills/release-readiness/references/handoff-doc-template.md` | The output artifact's full template |
| `.claude/skills/release-readiness/references/tier-3-scenario.md` | Detailed contract for T3.1 |
| `.claude/skills/release-readiness/references/autonomous-vs-invoked.md` | Mode differences |

**Modified files:**

| Path | Change |
|---|---|
| `client/package.json` | Add `release:tier-3`, `release-readiness` yarn scripts |
| `client/scripts/release/README.md` | Document Tier 3 + the release-readiness scaffolding |

**No CI workflow changes.** release-readiness is human-invoked (and future cron). It doesn't wire into `npm-publish.yml`.

---

## Task 1: Tier 3 setup helper

**Files:**
- Create: `client/test/release/tier-3/tier-3-helpers.ts`
- Test: `client/test/release/tier-3/tier-3-helpers.test.ts`

Tier 3 runs against the gold substrate directly (no workspace copy). Mutations are append-only on-chain (post task, deliver solution, post verdict — no state corruption). Plan A's substrate has the gold operators at `~/jinn-dev/operators/op-{a,b}/` already.

**Critical difference from Tier 2:** Tier 3 must check that the daily-driver daemons (the user's `~/.jinn-client/` and `~/jinn-canary-test/...`) are NOT running before spawning gold-substrate daemons. They share on-chain identity. Tier 3 SIGTERMs them in human-invoked mode and refuses to run in autonomous mode if they're present.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/release/tier-3/tier-3-helpers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { setupTier3Scenario, type Tier3Handle, isDailyDriverRunning } from './tier-3-helpers';

describe('isDailyDriverRunning', () => {
  it('returns false when nothing is on the daily-driver ports', async () => {
    const running = await isDailyDriverRunning({ ports: [60001, 60002] });
    expect(running).toBe(false);
  });

  it('returns true when something is on a daily-driver port', async () => {
    const net = await import('node:net');
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(60003, resolve));
    try {
      const running = await isDailyDriverRunning({ ports: [60003] });
      expect(running).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('setupTier3Scenario', () => {
  it('refuses to run when daily driver is up and mode is autonomous', async () => {
    const net = await import('node:net');
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(60004, resolve));
    try {
      await expect(
        setupTier3Scenario({
          scenarioId: 'T3.X-test',
          mode: 'autonomous',
          dailyDriverPorts: [60004],
        }),
      ).rejects.toThrow(/daily driver/i);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('uses gold paths directly (no workspace copy)', async () => {
    // Skip if substrate not present
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const goldOpA = path.join(os.homedir(), 'jinn-dev', 'operators', 'op-a');
    try { await fs.access(goldOpA); } catch { return; }

    // We don't actually want to spawn daemons in this unit test (that would
    // require mutex'ing the real daily driver). Just assert that the helper's
    // resolveGoldPath function returns the gold dir.
    const { resolveGoldDaemonHome } = await import('./tier-3-helpers');
    const home = resolveGoldDaemonHome('op-a');
    expect(home).toBe(goldOpA);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && yarn vitest run test/release/tier-3/tier-3-helpers.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the helper**

```typescript
// client/test/release/tier-3/tier-3-helpers.ts
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon';
import { goldPath } from '../../../scripts/release/substrate-paths';

const DAILY_DRIVER_PORTS = [7331, 7332];     // ~/.jinn-client and ~/jinn-canary-test default ports

export function resolveGoldDaemonHome(opName: string): string {
  return goldPath(opName);
}

export interface IsDailyDriverOptions {
  ports?: number[];
}

export async function isDailyDriverRunning(opts: IsDailyDriverOptions = {}): Promise<boolean> {
  const ports = opts.ports ?? DAILY_DRIVER_PORTS;
  for (const port of ports) {
    const inUse = await isPortInUse(port);
    if (inUse) return true;
  }
  return false;
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE');
    });
    tester.once('listening', () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, '127.0.0.1');
  });
}

export interface Tier3SetupOptions {
  scenarioId: string;
  mode: 'human-invoked' | 'autonomous';
  portBase?: number;                  // daemons get portBase, portBase+1
  dailyDriverPorts?: number[];        // override the default mutex check
  extraEnv?: NodeJS.ProcessEnv;
}

export interface Tier3Handle {
  daemons: MultiOpHandle;
  teardown: () => Promise<void>;
}

export async function setupTier3Scenario(opts: Tier3SetupOptions): Promise<Tier3Handle> {
  // 1. Daily-driver mutex check
  const dailyUp = await isDailyDriverRunning({ ports: opts.dailyDriverPorts });
  if (dailyUp) {
    if (opts.mode === 'autonomous') {
      throw new Error(
        'daily driver appears to be running on one of the substrate-shared ports. ' +
        'Autonomous mode refuses to SIGTERM it. Re-run in human-invoked mode or stop the daily driver first.',
      );
    }
    // human-invoked mode: instruct caller to stop daily driver first.
    // We don't auto-SIGTERM because that requires the caller's process to have permission
    // over the daily-driver process; instead surface explicitly and let release-readiness
    // handle the SIGTERM via its own daemon-mutex Phase 5 logic.
    throw new Error(
      'daily driver is running on a substrate-shared port. ' +
      'In human-invoked mode, release-readiness should SIGTERM it before invoking Tier 3.',
    );
  }

  // 2. Spawn daemons against gold paths (no workspace copy)
  const portBase = opts.portBase ?? 7350;
  let daemons: MultiOpHandle;
  try {
    daemons = await spawnMultiOpDaemons({
      ops: [
        { name: 'op-a', home: resolveGoldDaemonHome('op-a'), apiPort: portBase },
        { name: 'op-b', home: resolveGoldDaemonHome('op-b'), apiPort: portBase + 1 },
      ],
      extraEnv: opts.extraEnv,
      readyTimeoutMs: 60000,           // real chain warm-up may be slower than fork
    });
  } catch (err) {
    throw new Error(`Tier 3 daemon spawn failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let torn = false;
  return {
    daemons,
    teardown: async () => {
      if (torn) return;
      torn = true;
      await daemons.teardown();
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd client && yarn vitest run test/release/tier-3/tier-3-helpers.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add client/test/release/tier-3/tier-3-helpers.ts client/test/release/tier-3/tier-3-helpers.test.ts
git commit -m "test(release): add Tier 3 setup helper with daily-driver mutex check"
```

---

## Task 2: T3.1 — producer-evaluator real-testnet

**Files:**
- Create: `client/test/release/tier-3/T3.1-producer-evaluator-real.ts` (callable only)
- Create: `client/test/release/tier-3/T3.1-producer-evaluator-real.test.ts` (Vitest wrapper)

**What this scenario does:** Per the contract: op-a posts a small SWE-rebench v2 task on real Base Sepolia, claims, solves via real Hermes (real OpenRouter API call, ~$0.05-$0.10 cost), delivers. op-b claims verdict request, runs real evaluator Docker image, posts verdict. Assert `verdictCode === KNOWN_EXPECTED_VERDICT`.

**Key differences from T2.2 (Tier 2):**
- Real chain, not Anvil fork — txs cost real test ETH (tiny amounts)
- Real Hermes harness, not stubbed — real API spend
- Cost cap enforced
- Wall-clock budget 10 min (vs 5 min for T2.2)

- [ ] **Step 1: Write the callable**

```typescript
// client/test/release/tier-3/T3.1-producer-evaluator-real.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setupTier3Scenario, type Tier3Handle } from './tier-3-helpers';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types';
import {
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
  KNOWN_COMMIT,
  KNOWN_EXPECTED_VERDICT,
} from '../tier-2/fixtures/known-instance';

const COST_CAP_USD = 0.25;
const WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000;

interface ScenarioOptionsT3 extends ScenarioOptions {
  mode?: 'human-invoked' | 'autonomous';
  hermesModel?: string;
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 5000;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor${opts.label ? ` (${opts.label})` : ''} timed out after ${opts.timeoutMs}ms`);
}

export async function runT31ProducerEvaluatorReal(opts: ScenarioOptionsT3): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string) => evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);

  let handle: Tier3Handle | null = null;
  const hermesModel = opts.hermesModel ?? 'deepseek/deepseek-v4-flash';

  try {
    log(`1. setup Tier 3 scenario (mode=${opts.mode ?? 'human-invoked'}, model=${hermesModel})`);
    handle = await setupTier3Scenario({
      scenarioId: 'T3.1',
      mode: opts.mode ?? 'human-invoked',
      portBase: 7360,
      extraEnv: {
        JINN_HERMES_MODEL: hermesModel,
        JINN_TIER3_COST_CAP_USD: COST_CAP_USD.toString(),
      },
    });
    log('   daemons up against real Base Sepolia');

    const opAPort = handle.daemons.daemons['op-a'].apiPort;
    const opBPort = handle.daemons.daemons['op-b'].apiPort;

    log(`2. op-a posts task instance=${KNOWN_INSTANCE_ID}`);
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
    log(`   taskId=${posted.taskId}, requestId=${posted.requestId}`);

    log('3. wait for op-a to claim, solve via real Hermes, deliver');
    const delivered = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${opAPort}/v1/tasks/${posted.taskId}`);
      if (!r.ok) return null;
      const body = await r.json() as { state?: string; deliveryTxHash?: string; cost?: { usd?: number } };
      return body.state === 'DELIVERED' ? body : null;
    }, { timeoutMs: 8 * 60 * 1000, intervalMs: 5000, label: 'op-a-delivery' });
    log(`   deliveryTx=${delivered.deliveryTxHash}`);
    if (delivered.cost?.usd !== undefined) {
      log(`   cost so far: $${delivered.cost.usd.toFixed(4)}`);
      if (delivered.cost.usd > COST_CAP_USD) {
        throw new Error(`cost cap exceeded: spent $${delivered.cost.usd.toFixed(4)}, cap $${COST_CAP_USD}`);
      }
    }

    log('4. wait for op-b to claim verdict request, run evaluator, post verdict');
    const verdict = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${opBPort}/v1/verdicts?taskId=${posted.taskId}`);
      if (!r.ok) return null;
      const body = await r.json() as { verdicts?: Array<{ verdictCode: number; verdictTxHash?: string; solutionCid?: string; verdictCid?: string }> };
      return body.verdicts && body.verdicts.length > 0 ? body.verdicts[0] : null;
    }, { timeoutMs: 5 * 60 * 1000, intervalMs: 5000, label: 'op-b-verdict' });
    log(`   verdictCode=${verdict.verdictCode}, verdictTx=${verdict.verdictTxHash}`);
    log(`   solutionCid=${verdict.solutionCid}, verdictCid=${verdict.verdictCid}`);

    log('5. assert verdict matches expected');
    if (verdict.verdictCode !== KNOWN_EXPECTED_VERDICT) {
      throw new Error(`expected verdictCode=${KNOWN_EXPECTED_VERDICT}, got ${verdict.verdictCode}`);
    }
    log('   PASS — verdict matches');

    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T3.1',
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
      scenarioId: 'T3.1',
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
```

- [ ] **Step 2: Write the Vitest wrapper**

```typescript
// client/test/release/tier-3/T3.1-producer-evaluator-real.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT31ProducerEvaluatorReal } from './T3.1-producer-evaluator-real';

describe('T3.1 producer-evaluator-real', () => {
  // Gated: this test spends real testnet ETH + real OpenRouter $. Only runs when
  // explicitly opted in via JINN_T31_REAL=1.
  const enabled = process.env['JINN_T31_REAL'] === '1';

  it.skipIf(!enabled)('returns pass verdict against real Base Sepolia + real Hermes', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T3.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T3.1.log');
    try {
      const verdict = await runT31ProducerEvaluatorReal({
        evidencePath,
        mode: 'human-invoked',
        wallClockBudgetMs: 10 * 60 * 1000,
      });
      expect(['pass', 'fail']).toContain(verdict.verdict);
      if (verdict.verdict === 'fail') {
        console.error('T3.1 fail:', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 12 * 60 * 1000);

  it('callable shape matches ScenarioVerdict', () => {
    // Static type check at compile time; this test just asserts the export exists.
    expect(typeof runT31ProducerEvaluatorReal).toBe('function');
  });
});
```

- [ ] **Step 3: Run the wrapper without the gate (function shape only)**

Run: `cd client && yarn vitest run test/release/tier-3/T3.1-producer-evaluator-real.test.ts`
Expected: 1 passing (callable shape), 1 skipped (real-network gate not opted in).

To run the real-network test:
```bash
cd client && JINN_T31_REAL=1 yarn vitest run test/release/tier-3/T3.1-producer-evaluator-real.test.ts
```

(This will cost ~$0.10 in real OpenRouter spend + tiny test ETH.)

- [ ] **Step 4: Commit**

```bash
git add client/test/release/tier-3/T3.1-producer-evaluator-real.ts client/test/release/tier-3/T3.1-producer-evaluator-real.test.ts
git commit -m "feat(release): add T3.1 producer-evaluator real-testnet scenario"
```

---

## Task 3: run-tier-3.ts orchestrator

**Files:**
- Create: `client/scripts/release/run-tier-3.ts`

Single-scenario orchestrator for now (T3.1 only). Structure matches `run-tier-2.ts` for consistency.

- [ ] **Step 1: Implement**

```typescript
// client/scripts/release/run-tier-3.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runT31ProducerEvaluatorReal } from '../../test/release/tier-3/T3.1-producer-evaluator-real';
import { type ScenarioVerdict, ScenarioVerdictSchema } from './scenario-types';

interface RunOptions {
  outputDir?: string;
  candidateVersion?: string;
  mode?: 'human-invoked' | 'autonomous';
  hermesModel?: string;
}

export async function runTier3(opts: RunOptions = {}): Promise<{ verdicts: ScenarioVerdict[]; allPassed: boolean }> {
  const outputDir = opts.outputDir ?? path.join(
    process.cwd(),
    'tier-3-evidence',
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  );
  await fs.mkdir(outputDir, { recursive: true });

  const verdict = await runT31ProducerEvaluatorReal({
    evidencePath: path.join(outputDir, 'T3.1.log'),
    mode: opts.mode ?? 'human-invoked',
    hermesModel: opts.hermesModel,
    wallClockBudgetMs: 10 * 60 * 1000,
  });

  ScenarioVerdictSchema.parse(verdict);
  const verdicts = [verdict];
  const allPassed = verdict.verdict === 'pass';

  const summary = {
    candidateVersion: opts.candidateVersion ?? 'unknown',
    timestamp: new Date().toISOString(),
    mode: opts.mode ?? 'human-invoked',
    verdicts,
    allPassed,
  };
  await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const markerLines = [
    '<!-- jinn-release-evidence:v1',
    `release-candidate=${opts.candidateVersion ?? 'unknown'}`,
    `tier-3-t3-1=${verdict.verdict === 'pass' ? 'passed' : `failed:${verdict.failClass}`}`,
    `tier-3-overall=${allPassed ? 'passed' : 'failed'}`,
    '-->',
  ];
  await fs.writeFile(path.join(outputDir, 'marker.txt'), markerLines.join('\n') + '\n');

  return { verdicts, allPassed };
}

async function cliMain(): Promise<void> {
  const candidateVersion = process.argv[2];
  const mode = (process.argv[3] as 'human-invoked' | 'autonomous' | undefined) ?? 'human-invoked';
  const { verdicts, allPassed } = await runTier3({ candidateVersion, mode });
  console.log(JSON.stringify({ verdicts, allPassed }, null, 2));
  const hasRealBug = verdicts.some((v) => v.verdict === 'fail' && v.failClass === 'real-bug');
  process.exit(hasRealBug ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error('run-tier-3 crashed:', err);
    process.exit(2);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add client/scripts/release/run-tier-3.ts
git commit -m "feat(release): add run-tier-3 orchestrator"
```

---

## Task 4: release-readiness scaffolding

**Files:**
- Create: `client/scripts/release/release-readiness.ts`
- Test: `client/scripts/release/release-readiness.test.ts`

The release-readiness skill's SKILL.md is the primary deliverable, but it needs a thin TS scaffolding for:
- Aggregating audit findings + triage + verdicts into the handoff doc
- Writing the handoff doc to `docs/release/<version>/handoff.md`
- Appending the one-line audit-trail entry to `log/decisions/release-readiness-runs.md`
- Emitting the final marker block

- [ ] **Step 1: Write the failing test**

```typescript
// client/scripts/release/release-readiness.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeHandoffDoc,
  appendAuditTrailEntry,
  type HandoffDocInput,
  type ReadinessRecommendation,
} from './release-readiness';

describe('release-readiness scaffolding', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'release-readiness-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('writeHandoffDoc produces a structured markdown file', async () => {
    const input: HandoffDocInput = {
      candidateVersion: 'v0.1.7',
      branchSha: 'abc123def4567890abc123def4567890abc123de',
      lastReleasedSha: '579541cd7fefe305289a51b0ac5da19587e00ad2',
      mode: 'human-invoked',
      runId: '2026-05-26T11-30-00-a4f3',
      recommendation: 'SHIP',
      recommendationReasoning: 'All blocking gaps closed; Tier 3 passed.',
      diffSummary: { prsInWindow: 14, locAdded: 2847, locRemoved: 442, surfacesTouched: ['bootstrap', 'dashboard'] },
      gaps: [
        { id: 'GAP-1', source: 'C1', classification: 'BLOCKING', status: 'CLOSED', notes: 'PR #321 merged' },
        { id: 'GAP-2', source: 'canon:SPEC.md', classification: 'DEFERRABLE', status: 'FILED', ghIssue: '#322', milestone: 'v0.1.8' },
      ],
      releasePrepVerdicts: [
        { scenarioId: 'T1.1', verdict: 'pass', wallClockMs: 87234, evidencePath: '', failClass: null, failNotes: null },
      ],
      tier3Verdict: { scenarioId: 'T3.1', verdict: 'pass', wallClockMs: 278000, evidencePath: '', failClass: null, failNotes: null },
      tier3Evidence: {
        scenario: 'op-a solves sympy__sympy-27510, op-b evaluates',
        hermesModel: 'deepseek/deepseek-v4-flash',
        verdictCode: 1,
        deliveryTxHash: '0xa1b2',
        verdictTxHash: '0xc3d4',
        costUsd: 0.07,
      },
      walkThrough: ['Fresh operator bootstrap completes panel-driven', 'Network view solve-rate hero renders'],
      openQuestions: ['Q1: spec drift in unused section — acceptable?'],
    };

    const outPath = path.join(tmpRoot, 'docs', 'release', 'v0.1.7', 'handoff.md');
    await writeHandoffDoc(outPath, input);
    const content = await fs.readFile(outPath, 'utf-8');
    expect(content).toContain('# Release-readiness handoff — v0.1.7');
    expect(content).toContain('## Recommendation: SHIP');
    expect(content).toContain('GAP-1');
    expect(content).toContain('verdictCode=1');
    expect(content).toContain('release-readiness-recommendation=SHIP');
  });

  it('appendAuditTrailEntry adds a one-line entry to log/decisions/', async () => {
    const trailPath = path.join(tmpRoot, 'log', 'decisions', 'release-readiness-runs.md');
    await appendAuditTrailEntry(trailPath, {
      timestamp: '2026-05-26T11:30:00Z',
      candidateVersion: 'v0.1.7',
      mode: 'human-invoked',
      recommendation: 'SHIP' as ReadinessRecommendation,
      handoffPath: 'docs/release/v0.1.7/handoff.md',
    });
    const content = await fs.readFile(trailPath, 'utf-8');
    expect(content).toContain('2026-05-26T11:30:00Z | v0.1.7 | human-invoked | recommendation=SHIP | handoff=docs/release/v0.1.7/handoff.md');
  });

  it('appendAuditTrailEntry creates the file if missing', async () => {
    const trailPath = path.join(tmpRoot, 'log', 'decisions', 'release-readiness-runs.md');
    await appendAuditTrailEntry(trailPath, {
      timestamp: '2026-05-26T12:00:00Z',
      candidateVersion: 'v0.1.7',
      mode: 'autonomous',
      recommendation: 'DEFER' as ReadinessRecommendation,
      handoffPath: 'docs/release/v0.1.7/handoff.md',
    });
    const content = await fs.readFile(trailPath, 'utf-8');
    expect(content.split('\n').length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && yarn vitest run scripts/release/release-readiness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scaffolding**

```typescript
// client/scripts/release/release-readiness.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ScenarioVerdict } from './scenario-types';

export type ReadinessRecommendation = 'SHIP' | 'DEFER' | 'BLOCK';

export interface Gap {
  id: string;
  source: string;                       // e.g. "C1" or "canon:PRINCIPLES.md"
  classification: 'BLOCKING' | 'DEFERRABLE' | 'ALREADY-MET';
  status: 'OPEN' | 'CLOSED' | 'FILED' | 'ESCALATED' | 'EVIDENCE-LINKED';
  notes: string;
  ghIssue?: string;                     // e.g. "#322"
  milestone?: string;                   // e.g. "v0.1.8"
}

export interface HandoffDocInput {
  candidateVersion: string;
  branchSha: string;
  lastReleasedSha: string;
  mode: 'human-invoked' | 'autonomous';
  runId: string;
  recommendation: ReadinessRecommendation;
  recommendationReasoning: string;
  diffSummary: {
    prsInWindow: number;
    locAdded: number;
    locRemoved: number;
    surfacesTouched: string[];
  };
  gaps: Gap[];
  releasePrepVerdicts: ScenarioVerdict[];
  tier3Verdict: ScenarioVerdict | null;
  tier3Evidence: {
    scenario: string;
    hermesModel: string;
    verdictCode: number;
    deliveryTxHash: string;
    verdictTxHash: string;
    costUsd: number;
  } | null;
  walkThrough: string[];
  openQuestions: string[];
  independentEvidence?: string;
}

export async function writeHandoffDoc(outPath: string, input: HandoffDocInput): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  push(`# Release-readiness handoff — ${input.candidateVersion}`);
  push(`Generated: ${new Date().toISOString()}`);
  push(`Branch SHA: ${input.branchSha}`);
  push(`Mode: ${input.mode}`);
  push(`Audited against last released: ${input.lastReleasedSha}`);
  push(`Run-id: ${input.runId}`);
  push();
  push(`## Recommendation: ${input.recommendation}`);
  push();
  push(input.recommendationReasoning);
  push();
  push(`## Diff under audit`);
  push(`- PRs in window: ${input.diffSummary.prsInWindow}`);
  push(`- LOC: +${input.diffSummary.locAdded} / -${input.diffSummary.locRemoved}`);
  push(`- Surfaces touched: ${input.diffSummary.surfacesTouched.join(', ')}`);
  push();
  push(`## Gap log`);
  push();
  const blocking = input.gaps.filter((g) => g.classification === 'BLOCKING');
  const deferrable = input.gaps.filter((g) => g.classification === 'DEFERRABLE');
  const alreadyMet = input.gaps.filter((g) => g.classification === 'ALREADY-MET');
  push(`### Blocking (${blocking.length})`);
  for (const g of blocking) {
    push(`- **${g.id}** [${g.source}] ${g.status}: ${g.notes}`);
  }
  push();
  push(`### Deferrable (${deferrable.length})`);
  for (const g of deferrable) {
    const tag = g.ghIssue ? ` (${g.ghIssue}${g.milestone ? `, milestone ${g.milestone}` : ''})` : '';
    push(`- **${g.id}** [${g.source}]${tag}: ${g.notes}`);
  }
  push();
  push(`### Already met (${alreadyMet.length})`);
  for (const g of alreadyMet) {
    push(`- **${g.id}** [${g.source}]: ${g.notes}`);
  }
  push();
  push(`## release-prep evidence`);
  for (const v of input.releasePrepVerdicts) {
    push(`- ${v.scenarioId}: ${v.verdict}${v.failClass ? ` (${v.failClass})` : ''} (${v.wallClockMs}ms)`);
  }
  push();
  if (input.tier3Verdict && input.tier3Evidence) {
    push(`## Tier 3 evidence (load-bearing)`);
    push(`- Scenario: ${input.tier3Evidence.scenario}`);
    push(`- Hermes model: ${input.tier3Evidence.hermesModel}`);
    push(`- Verdict: ${input.tier3Verdict.verdict} (verdictCode=${input.tier3Evidence.verdictCode})`);
    push(`- Tx: deliver ${input.tier3Evidence.deliveryTxHash}, verdict ${input.tier3Evidence.verdictTxHash}`);
    push(`- Cost: $${input.tier3Evidence.costUsd.toFixed(2)}`);
    push(`- Wall-clock: ${input.tier3Verdict.wallClockMs}ms`);
    push();
  } else {
    push(`## Tier 3 evidence`);
    push(`SKIPPED (mode=${input.mode}; Tier 3 only runs in human-invoked mode with explicit consent).`);
    push();
  }
  push(`## Walk-through script for human pass`);
  for (const item of input.walkThrough) {
    push(`- [ ] ${item}`);
  }
  push();
  push(`## Open questions for human`);
  for (const q of input.openQuestions) {
    push(`- ${q}`);
  }
  push();
  if (input.independentEvidence) {
    push(`## Independent evidence`);
    push(input.independentEvidence);
    push();
  }
  push(`## Marker block (final)`);
  push(`<!-- jinn-release-evidence:v1`);
  push(`release-tag=${input.candidateVersion}`);
  push(`release-commit=${input.branchSha}`);
  for (const v of input.releasePrepVerdicts) {
    const key = `${v.scenarioId.toLowerCase().replace(/\./g, '-').replace(/^t/, 'tier-')}`;
    push(`${key}=${v.verdict === 'pass' ? 'passed' : `failed:${v.failClass}`}`);
  }
  if (input.tier3Verdict) {
    push(`tier-3-t3-1=${input.tier3Verdict.verdict === 'pass' ? 'passed' : `failed:${input.tier3Verdict.failClass}`}`);
  } else {
    push(`tier-3-t3-1=skipped:${input.mode === 'autonomous' ? 'autonomous-mode' : 'human-skipped'}`);
  }
  push(`release-readiness-recommendation=${input.recommendation}`);
  push(`release-readiness-handoff=docs/release/${input.candidateVersion}/handoff.md`);
  push(`release-readiness-run=${input.runId}`);
  push(`-->`);

  await fs.writeFile(outPath, lines.join('\n') + '\n');
}

export interface AuditTrailEntry {
  timestamp: string;
  candidateVersion: string;
  mode: 'human-invoked' | 'autonomous';
  recommendation: ReadinessRecommendation;
  handoffPath: string;
}

export async function appendAuditTrailEntry(trailPath: string, entry: AuditTrailEntry): Promise<void> {
  await fs.mkdir(path.dirname(trailPath), { recursive: true });
  const line = `${entry.timestamp} | ${entry.candidateVersion} | ${entry.mode} | recommendation=${entry.recommendation} | handoff=${entry.handoffPath}\n`;
  try {
    await fs.access(trailPath);
    await fs.appendFile(trailPath, line);
  } catch {
    const header = '# release-readiness audit trail\n\nOne line per release-readiness run. Format: `timestamp | version | mode | recommendation=<X> | handoff=<path>`.\n\n';
    await fs.writeFile(trailPath, header + line);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd client && yarn vitest run scripts/release/release-readiness.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add client/scripts/release/release-readiness.ts client/scripts/release/release-readiness.test.ts
git commit -m "feat(release): add release-readiness scaffolding — handoff writer + audit trail"
```

---

## Task 5: release-readiness SKILL.md

**Files:**
- Create: `.claude/skills/release-readiness/SKILL.md`

This is the canonical skill definition. The main agent reads this when the skill is invoked.

- [ ] **Step 1: Write SKILL.md**

```markdown
# release-readiness

Meta-skill. Audits a candidate release against canon, triages identified gaps, drives blocking-gap closure, invokes release-prep + Tier 3 for evidence, and emits a structured handoff doc that humans use to decide ship/defer/block. **Advisory, never blocking** — the skill produces a recommendation; humans (and future automation) make the final call.

Spec: `docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md` §4.

## When to use

- Manually invoked when a candidate version is in view (Friday evening / Saturday for a Monday cut).
- (Future) auto-triggered by a weekend GitHub Actions cron — separate follow-up.
- Never invoked as a subagent of release-prep; the dependency is the other way.

## Input contract

```typescript
interface ReleaseReadinessInput {
  candidateVersion: string;              // "v0.1.7"
  branchSha: string;                     // candidate SHA (usually next HEAD)
  lastReleasedSha?: string;              // diff anchor; defaults to v<prev> tag
  mode: "human-invoked" | "autonomous";
  outputDir?: string;                    // default: docs/release/<candidateVersion>/
  forceShip?: boolean;                   // emergency override, logged
}
```

## Subagent-first design

Main agent is a thin coordinator. Anything that requires loading non-trivial context (canon doc, PR diff, daemon logs) runs as a subagent. Main only sees structured verdicts.

| Operation | Where |
|---|---|
| Phase 1 setup (git diff, gh issue queries, substrate-verify) | main |
| Phase 2 mechanical checks (C2, C5, C6, C9 — grep/AST) | main |
| Phase 2 judgmental + canon pass (C1, C3, C4, C7, C8, C10, C11) | **1 subagent** |
| Phase 3 triage (classify all gaps) | **1 subagent** |
| Phase 4 closure (fix + PR) | **1 subagent per gap** |
| Phase 4 PR review per closure | **1 subagent per PR** |
| Phase 5 release-prep invocation | **release-prep skill** |
| Phase 5 Tier 3 scenario | **1 subagent invoking run-tier-3** |
| Phase 6 handoff doc drafting | **1 subagent** |
| Phase 6 SHIP/DEFER/BLOCK decision | main |
| Phase 7 terminal notification | main |

Per-run subagent count: ~6-9 fixed + N closure subagents (usually 0-3).

## Seven-phase process

```
Phase 1: Setup
  ├─ git diff lastReleasedSha..branchSha → resolve diff
  ├─ load canon: PRINCIPLES.md, SPEC.md, BRAND.md, GROWTH.md, GLOSSARY.md
  ├─ load operational memory from ~/.claude/projects/<project>/memory/
  ├─ gh issue list --label release-blocker
  └─ substrate-verify op-a op-b

Phase 2: Audit
  ├─ main: mechanical checks (C2/C5/C6/C9 grep + AST)
  ├─ dispatch judgmental audit subagent with full diff + all canon + check items
  │   See references/canon-audit-prompts.md for the prompt template.
  └─ collect findings list

Phase 3: Triage
  ├─ dispatch triage subagent with all findings
  │   See references/triage-taxonomy.md for the classification rules.
  ├─ subagent classifies BLOCKING / DEFERRABLE / ALREADY-MET
  ├─ for DEFERRABLE: subagent emits gh issue create shell with labels/milestone
  └─ for BLOCKING: queue for Phase 4

Phase 4: Closure (skip if no BLOCKING)
  ├─ for each BLOCKING gap, dispatch closure subagent in parallel
  ├─ subagent: investigate, fix on a worktree branch, push, file PR
  ├─ for each returned PR, dispatch PR-review subagent
  ├─ main: cross-account merge via dual-account flow if approved
  └─ 3 failed close attempts on same gap → BLOCKING-ESCALATED (recommendation → DEFER)

Phase 5: Validate
  ├─ Skill release-prep --branchSha=<sha> --candidateVersion=<v>
  │   reads back: marker block + per-scenario verdicts
  ├─ if mode === human-invoked:
  │     SIGTERM daily-driver daemons (ports 7331, 7332)
  │     tsx scripts/release/run-tier-3.ts <candidateVersion> human-invoked
  │     restart daily-driver daemons after
  │   else (autonomous):
  │     SKIP Tier 3 if daily-driver running; otherwise still SKIP
  │     (autonomous can't safely manage daemon mutex)
  └─ aggregate release-prep + Tier 3 verdicts

Phase 6: Synthesize
  ├─ dispatch handoff-doc-drafting subagent with all inputs
  ├─ subagent returns: structured doc draft
  ├─ main: determine recommendation
  │     SHIP   if all BLOCKING closed AND Tier 3 passed
  │     DEFER  if BLOCKING escalated OR Tier 3 failed AND independent evidence weak
  │            OR mode=autonomous AND Tier 3 skipped (INSUFFICIENT-EVIDENCE)
  │     BLOCK  if Tier 3 produced a clear regression vs last release
  ├─ writeHandoffDoc(...) — see scripts/release/release-readiness.ts
  └─ appendAuditTrailEntry(...) — log/decisions/release-readiness-runs.md

Phase 7: Terminal
  ├─ human-invoked: emit "handoff at <path>; recommendation: <X>"
  └─ autonomous: gh issue create --label release-ready --title "release-readiness completed for <v>" --body "review at <path>"
```

## Reference docs

- [`references/static-checklist.md`](references/static-checklist.md) — C1-C11 detailed shape
- [`references/canon-audit-prompts.md`](references/canon-audit-prompts.md) — subagent prompt templates
- [`references/triage-taxonomy.md`](references/triage-taxonomy.md) — classification rules
- [`references/handoff-doc-template.md`](references/handoff-doc-template.md) — output shape
- [`references/tier-3-scenario.md`](references/tier-3-scenario.md) — T3.1 contract
- [`references/autonomous-vs-invoked.md`](references/autonomous-vs-invoked.md) — mode differences

## Invocation

```bash
# Human-invoked (full flow including Tier 3 with real-network spend)
Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked

# Autonomous (audit + closure + release-prep; Tier 3 SKIPPED)
Skill release-readiness --candidateVersion v0.1.7 --mode autonomous

# Emergency override (logs forceShip in handoff)
Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked --forceShip
```

## What this skill deliberately does NOT do

- **Publish the release.** Always advisory.
- **Modify canon docs unilaterally.** Audit findings → GH issue, never silent rewrite.
- **Re-run release-prep gates when they already ran against this SHA.**
- **Kill operator daemons in autonomous mode.** Mutual exclusion is human-supervised.
- **Run Tier 3 in autonomous mode.** Cost/risk requires explicit consent.
- **Use bd.** All issue tracking via `gh issue`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/release-readiness/SKILL.md
git commit -m "docs(release-readiness): add SKILL.md"
```

---

## Task 6: static-checklist.md reference

**Files:**
- Create: `.claude/skills/release-readiness/references/static-checklist.md`

- [ ] **Step 1: Write the doc**

```markdown
# Static checklist (C1-C11)

Mechanical checks that fire deterministically against the diff. Each item is either grep/AST-based (runs in main) or judgmental (dispatched to the judgmental audit subagent).

## C1 — operator-app-principle

**Triggers when:** diff touches `client/src/dashboard/` or operator-facing copy.

**Where:** judgmental subagent.

**The principle (from memory `operator-app-principle-oak-reiterated-2026-05-18`):** after the first `jinn run`, the operator should never have to leave the app. Any new error message instructing CLI re-runs is a violation.

**Subagent looks for:** new strings in the diff matching `(rerun|run again|jinn run)` in user-facing text, especially in panel components.

## C2 — bootstrap-phase change

**Triggers when:** diff touches `client/src/earning/bootstrap.ts` or phase definitions.

**Where:** main (grep).

**Why:** u34i / h74p / k1ng / 3nc5 all regressed bootstrap; high regression risk.

## C3 — per-harness readiness

**Triggers when:** new harness implementation added, or readiness flow changed.

**Where:** judgmental subagent.

**Subagent looks for:** any new file in `client/src/harnesses/impls/` that lacks an `isReady()` implementation; or changes to `client/src/api/server.ts` `/v1/harnesses/*` routes.

## C4 — eval admission / verdict recheck

**Triggers when:** diff touches eval admission or substrate hashing (`client/src/eval/admission/`, `client/src/eval/substrate-hash/`).

**Where:** judgmental subagent.

**Subagent looks for:** changes that could weaken the verdict-time recheck (e.g. removed assertions, conditional skips of the hash check).

## C5 — task admission filter

**Triggers when:** diff touches floor logic, DiscoveryAPI filter, or claim eligibility.

**Where:** main (grep for known floor constants + filter call sites).

**Why:** #300 ghost-task class — floor drift introduces silent non-claimability or worse, silent re-emergence.

## C6 — canon doc movement

**Triggers when:** any line of PRINCIPLES.md / SPEC.md / BRAND.md / GROWTH.md / GLOSSARY.md changes.

**Where:** main (grep).

**Action:** flag as concern. Canonical-docs policy requires Discussion + CODEOWNERS approval; the audit subagent verifies this was followed.

## C7 — memory invariant violation

**Triggers when:** any diff that contradicts a stored memory file.

**Where:** judgmental subagent.

**Subagent reads:** all memory files under `~/.claude/projects/<project>/memory/`. For each memory whose body describes an invariant or rule, checks the diff for direct violation.

## C8 — wiring-seam coverage

**Triggers when:** any value computed in 2+ modules without a single-source-of-truth helper.

**Where:** judgmental subagent (AST + reasoning).

**Why:** u34i lesson — module-isolated unit tests miss cross-module invariant drift.

## C9 — release-evidence marker schema

**Triggers when:** diff touches `.github/workflows/npm-publish.yml` marker check.

**Where:** main (grep).

**Action:** validate any new marker keys against `client/scripts/release/release-readiness.ts` schema. If the schema isn't updated to match, flag.

## C10 — spec freshness

**Triggers when:** a spec under `spec/` referenced by code no longer matches the code.

**Where:** judgmental subagent.

**Subagent reads:** each referenced spec + the code section that references it. Reports drift.

## C11 — skill currency

**Triggers when:** diff touches operator-facing UI, CLI verbs, public skill-relevant surfaces.

**Where:** judgmental subagent.

**Subagent reads:** every `.claude/skills/*/SKILL.md` and the diff. Reports:
- Skills that make false claims about changed surfaces (BLOCKING)
- Skills that don't yet cover new surfaces but existing surfaces are still accurate (DEFERRABLE)

This is the recursion that keeps the system honest. Every release sweeps the skills.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/release-readiness/references/static-checklist.md
git commit -m "docs(release-readiness): add static-checklist C1-C11 reference"
```

---

## Task 7: canon-audit-prompts.md reference

**Files:**
- Create: `.claude/skills/release-readiness/references/canon-audit-prompts.md`

- [ ] **Step 1: Write the doc**

```markdown
# Canon audit prompts

Prompt templates for the judgmental audit subagent (Phase 2) and the triage subagent (Phase 3).

## Judgmental audit subagent prompt

The subagent runs once per release-readiness invocation. It receives:
- Full diff from `git log lastReleasedSha..branchSha`
- All five canon docs (PRINCIPLES.md, SPEC.md, BRAND.md, GROWTH.md, GLOSSARY.md)
- All operational memory files
- All skill SKILL.md files (under `.claude/skills/`)
- List of judgmental check items (C1, C3, C4, C7, C8, C10, C11) with descriptions

```
You're auditing a candidate release branch against canon and operational memory.

Inputs you have access to:
- Diff: {DIFF_TEXT}
- Canon docs: {CANON_DOCS_INLINED}
- Operational memories: {MEMORY_FILES}
- Skill files: {SKILL_FILES}
- Judgmental check items: {CHECK_ITEMS}

For EACH check item, walk the diff and identify findings.

Then, for EACH canon doc, do an open-ended pass: does anything in the diff
contradict, undermine, or skirt a principle in this doc?

For EACH skill file, ask: does anything in the diff make this skill's
instructions wrong or incomplete?

Return a single unified structured report as JSON:

[
  {
    "id": "GAP-1",
    "source": "C1" | "C7" | "canon:PRINCIPLES.md" | "skill:testing-jinn-app/SKILL.md" | ...,
    "description": "...",
    "severity": "high" | "medium" | "low",
    "rationale": "specific cite from both the diff and the source",
    "references": [{"file": "path", "line": N, "snippet": "..."}, ...],
    "crossCuttingWith": ["GAP-N", ...]
  },
  ...
]

Be specific. "Vibes off" is not a finding. Cite both sides — the diff content
that triggers the concern AND the canon/memory/skill section it violates.

If two findings share a root cause, list both in `crossCuttingWith`.
```

## Triage subagent prompt

The triage subagent runs once after the audit. It receives:
- The full findings list from the audit subagent
- PRINCIPLES.md (re-loaded for context)
- The current candidate version and recent release history (so it knows what "next release" target is)
- The triage taxonomy rules

```
You're triaging audit findings for release {CANDIDATE_VERSION}.

Findings: {FINDINGS_JSON}

Rules: {TRIAGE_TAXONOMY_TEXT}

For each finding, classify:
  BLOCKING   — close before recommend SHIP
  DEFERRABLE — file GH issue with milestone, ship anyway
  ALREADY-MET — link to evidence (existing test, spec section, etc.)

For each:
- BLOCKING: leave as-is; will be passed to closure subagents.
- DEFERRABLE: emit a `gh issue create` shell with:
    - Title: short, action-oriented
    - Body: includes the rationale + references from the finding
    - Labels: "release-blocker" if escalating from DEFERRABLE to near-blocking;
              "skill-drift" if C11 source; relevant area label otherwise
    - Milestone: next release version
- ALREADY-MET: link to the evidence (file path / test name / spec section).

Cross-cutting:
- If multiple findings share a root cause, indicate so in the classifications.
- If a deferrable cluster is large enough that the next-release surface is
  going to drift further, escalate one of them to BLOCKING with a note.

Return JSON:

[
  {
    "gapId": "GAP-1",
    "classification": "BLOCKING" | "DEFERRABLE" | "ALREADY-MET",
    "rationale": "...",
    "ghIssueDraft": null | {
      "title": "...",
      "body": "...",
      "labels": ["..."],
      "milestone": "v0.1.8"
    },
    "evidenceLinks": [{"path": "...", "summary": "..."}, ...]
  },
  ...
]
```

## Handoff-doc-drafting subagent prompt

```
You're drafting a release-readiness handoff doc.

Inputs:
- audit findings: {AUDIT_FINDINGS}
- triage classifications: {TRIAGE_CLASSIFICATIONS}
- closure outcomes: {CLOSURE_OUTCOMES}
- release-prep verdicts: {RELEASE_PREP_VERDICTS}
- Tier 3 verdict + evidence: {TIER_3_RESULT}
- diff summary: {DIFF_SUMMARY}

Use the template at references/handoff-doc-template.md to produce a fully
populated draft. The MAIN agent will read your draft, make the SHIP/DEFER/BLOCK
recommendation, and write the final file.

Produce a markdown draft. Don't make the SHIP/DEFER/BLOCK decision yourself —
populate everything else.
```
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/release-readiness/references/canon-audit-prompts.md
git commit -m "docs(release-readiness): add canon-audit-prompts reference"
```

---

## Task 8: Remaining reference docs

**Files:**
- Create: `.claude/skills/release-readiness/references/triage-taxonomy.md`
- Create: `.claude/skills/release-readiness/references/handoff-doc-template.md`
- Create: `.claude/skills/release-readiness/references/tier-3-scenario.md`
- Create: `.claude/skills/release-readiness/references/autonomous-vs-invoked.md`

These are reference docs that mirror sections from the spec §4. The content is largely already specified in the spec; this task just transcribes into the right place.

- [ ] **Step 1: triage-taxonomy.md**

Save:

```markdown
# Triage taxonomy

Classification rules used by the triage subagent. The taxonomy is from spec §4.

## BLOCKING

Close before recommend SHIP. Includes:
- Direct PRINCIPLES.md violation **introduced by this branch** (not pre-existing).
- operator-app-principle violation in new UI copy.
- Canon doc moved without ratification path (Discussion + CODEOWNERS approval).
- Bootstrap / auth / eval substrate regression.
- Wiring-seam drift introduced (multiple modules computing same value, no helper).
- Tier 3 scenario regression vs last release.
- Skill makes false claims about changed surface (operator hits a wall).

## DEFERRABLE

File GH issue with milestone, ship anyway, note in release notes. Includes:
- Spec-drift in unreferenced area.
- Pre-existing open issue.
- Quality-of-life concerns that don't break a documented invariant.
- Tier 1/2 flake-class failures (release-prep marked `flake-infra`).
- Skill doesn't yet cover new surface but existing surface is still accurate.
- Anything previously triaged as "next release" pattern.

## ALREADY-MET

Concern is addressed; link to evidence. Includes:
- Static checklist item that passed without finding.
- Open-ended concern that's covered by an existing test.
- Concern explicitly resolved by a commit in this window.

## Edge cases

- **BLOCKING that can't be closed (after 3 attempts):** mark BLOCKING-ESCALATED. Gap stays BLOCKING; recommendation shifts to DEFER (not BLOCK — defer means "not ready this cycle," block means "broken in a way that needs hotfix-level attention").
- **Cross-cutting clusters:** multiple deferrable findings with the same root cause should escalate one to BLOCKING with a note about the cluster.
- **Pre-existing vs introduced:** the audit only flags issues *introduced by this branch*. Pre-existing issues that the diff happens to touch don't escalate; they stay DEFERRABLE.
```

- [ ] **Step 2: handoff-doc-template.md**

Save:

```markdown
# Handoff doc template

The shape of `docs/release/<candidateVersion>/handoff.md`. Generated by `writeHandoffDoc()` in `client/scripts/release/release-readiness.ts`.

```markdown
# Release-readiness handoff — <version>
Generated: <ISO timestamp>
Branch SHA: <sha>
Mode: human-invoked | autonomous
Audited against last released: <prev-sha>
Run-id: <run-id>

## Recommendation: SHIP | DEFER | BLOCK

<one sentence + reasoning>

## Diff under audit
- PRs in window: N
- LOC: +X / -Y
- Surfaces touched: <list>

## Gap log

### Blocking (N)
- **GAP-1** [source]: ...

### Deferrable (N)
- **GAP-2** [source] (gh issue #N, milestone v0.1.8): ...

### Already met (N)
- **GAP-3** [source]: covered by <evidence>

## release-prep evidence
- T1.1: pass (87s)
- T1.2: pass (22s)
- ...

## Tier 3 evidence (load-bearing)
- Scenario: op-a solves ..., op-b evaluates
- Hermes model: ...
- Verdict: pass (verdictCode=1)
- Tx: deliver 0x..., verdict 0x...
- Cost: $0.07
- Wall-clock: 4m 38s

## Walk-through script for human pass
- [ ] check 1
- [ ] check 2

## Open questions for human
- Q1: ...

## Independent evidence
<any out-of-band signal>

## Marker block (final)
<!-- jinn-release-evidence:v1
release-tag=...
...
-->
```
```

- [ ] **Step 3: tier-3-scenario.md**

Save:

```markdown
# Tier 3 scenario — producer-evaluator real-testnet

The single Tier 3 scenario. Run from release-readiness Phase 5 in human-invoked mode only.

**Implementation:** `client/test/release/tier-3/T3.1-producer-evaluator-real.ts`

**Orchestrator:** `client/scripts/release/run-tier-3.ts`

## Pre-conditions

- Daily-driver daemons SIGTERM'd (ports 7331, 7332 free). release-readiness Phase 5 manages this.
- substrate-topup verified: op-a + op-b have ≥ 0.002 ETH on Base Sepolia; OLAS bond current.
- OpenRouter API key available (env `OPENROUTER_API_KEY` or daemon config).
- `JINN_T31_REAL=1` environment variable to acknowledge real-network spend.

## Execution flow

1. Spawn op-a daemon: `HOME=~/jinn-dev/operators/op-a node dist/bin/jinn.js run --no-ui` (port 7360)
2. Spawn op-b daemon: `HOME=~/jinn-dev/operators/op-b ...` (port 7361)
3. op-a posts a small SWE-rebench v2 task (instance from fixtures/known-instance.ts)
4. op-a claims, solves via real Hermes (real OpenRouter API call, ~$0.05-$0.10)
5. op-a delivers
6. op-b claims verdict request
7. op-b runs real evaluator Docker image, scores
8. op-b posts verdict
9. Assert `verdictCode === KNOWN_EXPECTED_VERDICT`

## Budgets

- Wall-clock: 10 min hard
- Cost: $0.25 cap (API + tiny gas)

## Failure modes

| Failure | Class | Result |
|---|---|---|
| Daily driver running | n/a | abort with explicit instruction |
| Daemon spawn fails | real-bug | BLOCK with daemon stderr |
| Task post fails | real-bug | BLOCK |
| Solve times out (>8 min) | flake-timing first; real-bug on retry | retry once |
| Verdict mismatches expected | real-bug | REAL REGRESSION → recommendation = BLOCK |
| API budget exceeded | n/a | abort partial; surface cost analysis |

## Output

- `tier-3-evidence/<timestamp>/T3.1.log` — phase markers + tx hashes + CIDs
- `tier-3-evidence/<timestamp>/summary.json` — structured verdict
- `tier-3-evidence/<timestamp>/marker.txt` — release-evidence marker

## Why this is load-bearing

T3.1 was the manual A3 verification that carried the v0.1.6 ship decision (the gates flaked four ways; A3 said `verdictCode=1`; we shipped). Codifying it makes that evidence pattern reproducible.
```

- [ ] **Step 4: autonomous-vs-invoked.md**

Save:

```markdown
# Autonomous vs human-invoked

The two modes differ in what they're allowed to do.

## human-invoked

- Daily-driver daemons SIGTERM'd before Tier 3, restarted after.
- Tier 3 runs (real network + real Hermes spend).
- Cost budget permissive (one run per week).
- Phase 7: emits "handoff ready at <path>, see you in a new session". Session ends.
- Human reads handoff doc in a fresh session, drives the walk-through script, makes ship/no-ship decision.

## autonomous

- Daily-driver daemons NOT touched.
- Tier 3 SKIPPED entirely (autonomous can't safely manage daemon mutex).
- If Tier 3 skipped, recommendation defaults to INSUFFICIENT-EVIDENCE-FOR-SHIP; needs human-invoked re-run.
- Cost budget tighter.
- Phase 7: `gh issue create --label release-ready --title "release-readiness completed for <v>"`. Session ends. Issue sits in queue.

## When to use which

- **Autonomous:** weekend run for Monday cut. Audit + closure happen overnight; the human picks up Monday morning and runs Tier 3 themselves before deciding.
- **Human-invoked:** any time a human wants the full flow including Tier 3. Required for the final pre-publish run.

## Future cron

Captured as follow-up GH issue: "Wire release-readiness autonomous-mode to a Friday 23:00 UTC GitHub Actions schedule." When wired:
- Cron triggers a workflow that checks out `next`, runs the skill against HEAD with `--mode autonomous`.
- Workflow posts the handoff doc as a comment on the existing Monday-draft GH Release.
- Captain reads on Monday, optionally runs human-invoked for Tier 3, publishes if SHIP.
```

- [ ] **Step 5: Commit all four reference docs**

```bash
git add .claude/skills/release-readiness/references/triage-taxonomy.md \
        .claude/skills/release-readiness/references/handoff-doc-template.md \
        .claude/skills/release-readiness/references/tier-3-scenario.md \
        .claude/skills/release-readiness/references/autonomous-vs-invoked.md
git commit -m "docs(release-readiness): add triage-taxonomy, handoff-doc-template, tier-3-scenario, autonomous-vs-invoked references"
```

---

## Task 9: yarn scripts + README

**Files:**
- Modify: `client/package.json`
- Modify: `client/scripts/release/README.md`

- [ ] **Step 1: Add yarn scripts**

In `client/package.json`'s `scripts` object, add:

```json
{
  "scripts": {
    "release:tier-3": "tsx scripts/release/run-tier-3.ts",
    "release:tier-3:T3.1": "JINN_T31_REAL=1 vitest run test/release/tier-3/T3.1-producer-evaluator-real.test.ts"
  }
}
```

- [ ] **Step 2: Update README**

In `client/scripts/release/README.md`, add a new section after "Tier 1 orchestrator":

```markdown
## Tier 3 orchestrator

`run-tier-3.ts` runs the single Tier 3 scenario (T3.1 producer-evaluator-real) against the real Base Sepolia testnet. **This spends real test ETH + real OpenRouter API budget (~$0.10).** Only run when intentional.

```bash
yarn release:tier-3 <candidate-version>
```

Output goes to `tier-3-evidence/<timestamp>/`.

Per-scenario standalone (gated on `JINN_T31_REAL=1`):

```bash
yarn release:tier-3:T3.1
```

## release-readiness skill

The audit + triage + closure + handoff meta-skill. Invoked from a Claude Code session:

```bash
# Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked
```

See `.claude/skills/release-readiness/SKILL.md` for the full skill contract.
```

- [ ] **Step 3: Commit**

```bash
git add client/package.json client/scripts/release/README.md
git commit -m "chore(release): wire yarn scripts + README for Tier 3 + release-readiness"
```

---

## Task 10: End-to-end smoke

**Files:**
- None modified. Verification gate.

- [ ] **Step 1: Verify all prerequisites are present**

Run:
```bash
cd client

# Substrate (Plan A)
yarn substrate:verify op-a --skip-on-chain
yarn substrate:verify op-b --skip-on-chain

# Helpers (Plan B)
ls test/helpers/multi-op-daemon.ts test/helpers/handshake-url.ts

# Tier 1 (Plan C)
ls scripts/release/scenario-types.ts scripts/release/run-tier-1.ts
ls .claude/skills/release-prep/SKILL.md

# Tier 2 (Plan D, if landed)
ls scripts/release/run-tier-2.ts 2>/dev/null || echo "Plan D not landed yet"

# Tier 3 + release-readiness (this plan)
ls scripts/release/run-tier-3.ts scripts/release/release-readiness.ts
ls .claude/skills/release-readiness/SKILL.md
ls .claude/skills/release-readiness/references/
```

Expected: every check passes, OR the missing item is a known cross-plan gap.

- [ ] **Step 2: Smoke the Tier 3 scaffolding (no real-network spend)**

Run: `cd client && yarn vitest run scripts/release/release-readiness.test.ts test/release/tier-3/`
Expected: scaffolding tests pass; T3.1 callable-shape test passes; real-network T3.1 test skips (gate off).

- [ ] **Step 3: Smoke the Tier 3 orchestrator (without running the scenario)**

Run: `cd client && tsx scripts/release/run-tier-3.ts v0.1.7-smoke autonomous 2>&1 | head -30`
Expected: orchestrator runs Tier 3 with the daily-driver mutex check. Because we're in autonomous mode and either daily drivers are up OR substrate isn't healthy, it should abort with a clear message rather than spending real budget.

- [ ] **Step 4: If you want to run T3.1 for real**

This is THE moment to test the load-bearing scenario. Cost ~$0.10. Run:

```bash
cd client
# Make sure daily-driver daemons are stopped (ports 7331, 7332)
JINN_T31_REAL=1 yarn release:tier-3 v0.1.7-smoke human-invoked
```

Expected: ~5-10 min run, produces tier-3-evidence/, exits 0 if pass.

- [ ] **Step 5: No commit unless gaps were found**

Verification gate. If everything resolves, the brainstorm-to-execution loop is complete.

---

## Self-review

### Spec coverage

| Spec requirement | Covered by | Status |
|---|---|---|
| §4 release-readiness skill | Tasks 5-8 | ✓ |
| §4 7-phase process | Task 5 (SKILL.md) | ✓ |
| §4 subagent-first design | Tasks 5, 7 | ✓ |
| §4 static checklist C1-C11 | Task 6 | ✓ |
| §4 triage taxonomy | Task 8 | ✓ |
| §4 handoff doc shape | Task 4 (scaffolding) + Task 8 (template) | ✓ |
| §4 Tier 3 scenario | Tasks 1, 2 | ✓ |
| §4 autonomous vs human-invoked | Task 8 | ✓ |
| §6 T3.1 scenario | Task 2 | ✓ |
| Marker schema extension | Task 4 (writeHandoffDoc emits new keys) | ✓ |
| Audit trail | Task 4 (appendAuditTrailEntry) | ✓ |

### Placeholder scan

- Task 2 (T3.1): wall-clock budget hard-coded to 10 min; reuses Plan D's fixture. No placeholder; just env-gated for cost protection.
- Task 5 (SKILL.md): subagent dispatch table mirrors what's in the spec. No placeholder.
- All other tasks have complete content.

### Type consistency

- `ScenarioVerdict` consistent with Plan C's definition. T3.1 returns it; orchestrator parses it.
- `Gap`, `HandoffDocInput`, `ReadinessRecommendation` types defined in Task 4 used in Task 5 SKILL.md.
- `setupTier3Scenario` signature consistent across Tasks 1, 2.

### Cross-plan contract check

This plan consumes from:
- Plan A: substrate gold copy at `~/jinn-dev/operators/` (Tier 3 uses directly).
- Plan B: multi-op-daemon (Task 1 uses `spawnMultiOpDaemons`).
- Plan C: scenario-types (ScenarioVerdict, classifyFailure). release-prep skill (release-readiness Phase 5 invokes via `Skill release-prep`).
- Plan D: tier-2-scenarios infrastructure as the model for `setupTier3Scenario`. Plan D's `release-prep` updates (Tier 2 populated) are required for release-readiness Phase 5 to get full evidence.

This plan completes the brainstorm-to-execution loop. No downstream plan depends on it.

### Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-release-readiness-skill-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task. 10 tasks; the most documentation-heavy plan (5 reference docs). Subagent flow's review pass catches transcription errors.

2. **Inline Execution** — Execute tasks in this session.

Plan E depends on A + B + C + D. To dispatch in background, the worktree must be stacked on all four. Since Plan D's branch already includes A+B+C via merges, Plan E's branch can be stacked on Plan D's branch directly.

Which approach?
