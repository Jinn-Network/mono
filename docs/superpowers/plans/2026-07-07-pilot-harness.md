# Capability-Eval Pilot Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A lean, bounded harness that runs a *small* batch of SWE-rebench-V2 instances through both arms (stock vs corpus-ON), grades each patch, captures per-solve tokens, and prints the paired comparison — so we can smoke-test the machinery (~$0.50) and get an early validation read (~$10) before committing to the full ~$150 run.

**Architecture:** Reuse everything already built/proven — the `hf-fetcher` + `PythonEvalRunner` grader (mono), the `capability-stats` functions (Plan 1), and the exact jinn-agent commands the spike proved (`docs/spikes/2026-07-07-jinn-agent-headless-spike.md`). The only new code is a thin **solve driver** (drive jinn-agent → recover patch + tokens), a **tally** step (wire results into the Plan-1 stats), and a **CLI orchestrator** with a **`--dry-run`** mode that stubs all spend so the wiring is verifiable for free.

**Tech Stack:** TypeScript (ESM), Vitest, `node:child_process`. No new deps.

## Global Constraints

- **This spends real money when run for real.** Every design choice bounds spend: `--max-turns` per solve (no shell timeout — not installed on this host), **no retry-on-failure** (a failed solve is a datapoint, not a re-burn), an explicit `--max-instances` cap, and a **`--dry-run`** that runs the full control flow with stubbed solve+grade (zero spend, zero Docker).
- **Arm A empty loadout is enforced:** arm A runs jinn-agent with `--ignore-rules` (no memory/AGENTS.md/skill leakage); arm B = arm A **+ `-s <skill>`** (spec §3.1, spike-confirmed). This is the sole varied input.
- **Reuse, do not reinvent:** `HttpHfFetcher`/`HfRow` + `PythonEvalRunner` from `client/src/harnesses/impls/swe-rebench-v2-evaluator/`; `pairedRateDiffLowerBound` / `nonInferiorityVerdict` / `pairedCostVerdict` from `client/src/eval/capability-stats.ts`.
- **Cost = provider-actual token counts** from `jinn-agent sessions export`, priced by a fixed rate table (deepseek-v4-flash: $0.09/M input, $0.18/M output; cache-read at OpenRouter's discount if present) — NOT the agent's own `estimated_cost_usd` (spec §5.2).
  - **Note (2026-07-08 re-pin):** the **ratified** model pin is now `gpt-5.4-mini` (`$0.75`/M input, `$4.50`/M output — `GPT_5_4_MINI_RATES` in `cost.ts`), selected per DR-2026-07-06 decision E + Amendment. The `deepseek-v4-flash` rates below are the **metered fallback only**, not the primary. This plan predates the re-pin; `--provider openai-codex -m gpt-5.4-mini` is the ratified invocation and `run-pilot.ts` already selects `GPT_5_4_MINI_RATES` for that provider.
  - **Assumption (make it explicit):** provider `input_tokens` is treated as **already inclusive of** `cache_read_tokens` (OpenAI `prompt_tokens` semantics). This inclusion cancels in the paired A−B direction (both arms priced identically), so it does not bias the gate; it is stated here so the `cost.ts` `fresh = input − cache_read` split is not misread as double-counting.
- Pure/deterministic library code (no `Date.now()`/`Math.random()` — inject clock/rng). ESM `.js` import specifiers. Vitest tests in `client/test/pilot/`. Commit prefix `feat(pilot): …`. Keep `yarn typecheck` green.
- This harness is **interim** (the production rig is Plan 2). It lives under `client/src/pilot/` + `client/scripts/run-pilot.ts` and does not touch the daemon.

## File Structure

| File | Responsibility |
|---|---|
| `client/src/pilot/instance.ts` | `PilotInstance` (instance_id, repo, base_commit, problem_statement) + `fetchPilotInstance` — the raw-row fetch the grader's `HfRow` doesn't carry (base_commit + problem_statement for the solve side). |
| `client/src/pilot/solve.ts` | Solve driver: `buildSolveArgs` (arm → jinn-agent flags), `parseSessionTokens`, `extractSessionId` (pure, tested) + `solveOne` (integration, deps-injected). |
| `client/src/pilot/cost.ts` | `solveCostUsd(tokens, rates)` — price provider-actual tokens by a fixed rate table (pure, tested). |
| `client/src/pilot/tally.ts` | `tallyPilot(solves, grades, opts)` → per-task `TaskRates` + cost diffs → `capability-stats` → `PilotReport` (pure, tested; reuses Plan 1). |
| `client/scripts/run-pilot.ts` | CLI orchestrator: config, per-instance base checkout → per-(arm,repeat) solve+grade → tally → print. `--dry-run` stubs spend. Validated by dry-run + smoke, not unit tests. |
| `client/test/pilot/*.test.ts` | One test file per pure module. |

---

## Task 1: Solve driver — pure helpers (`solve.ts`)

**Files:**
- Create: `client/src/pilot/solve.ts`
- Test: `client/test/pilot/solve.test.ts`

**Interfaces:**
- Produces: `Arm` (`{ name: 'A' | 'B'; skills: string[] }`), `SolveTokens` (`{ inputTokens: number; outputTokens: number; cacheReadTokens: number }`), `buildSolveArgs(arm: Arm, prompt: string, opts: { maxTurns: number }): string[]`, `parseSessionTokens(exportLine: string): SolveTokens`, `extractSessionId(stderr: string): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/pilot/solve.test.ts
import { describe, it, expect } from 'vitest';
import { buildSolveArgs, parseSessionTokens, extractSessionId, type Arm } from '../../src/pilot/solve.js';

const armA: Arm = { name: 'A', skills: [] };
const armB: Arm = { name: 'B', skills: ['systematic-debugging'] };

describe('solve driver helpers', () => {
  it('arm A args enforce an empty loadout (--ignore-rules, no -s)', () => {
    const args = buildSolveArgs(armA, 'fix the bug', { maxTurns: 20 });
    expect(args).toEqual([
      'chat', '-q', 'fix the bug', '-Q', '--yolo', '--ignore-rules',
      '--pass-session-id', '--max-turns', '20',
    ]);
    expect(args).not.toContain('-s');
  });

  it('arm B adds exactly the skill loadout via -s', () => {
    const args = buildSolveArgs(armB, 'fix the bug', { maxTurns: 20 });
    expect(args).toContain('-s');
    expect(args[args.indexOf('-s') + 1]).toBe('systematic-debugging');
    // arm B is arm A + the loadout: identical otherwise
    expect(args.slice(0, 7)).toEqual(['chat', '-q', 'fix the bug', '-Q', '--yolo', '--ignore-rules', '-s']);
  });

  it('parses provider-actual tokens from a session export line', () => {
    const line = JSON.stringify({
      input_tokens: 186114, output_tokens: 6207, cache_read_tokens: 258944,
      estimated_cost_usd: 0.02253, model: 'deepseek-v4-flash', cwd: '/tmp/armA',
    });
    expect(parseSessionTokens(line)).toEqual({ inputTokens: 186114, outputTokens: 6207, cacheReadTokens: 258944 });
  });

  it('throws on a session export missing token fields (fail-loud, never silently zero)', () => {
    expect(() => parseSessionTokens(JSON.stringify({ model: 'x' }))).toThrow(/token/);
  });

  it('extracts the session id from the stderr marker', () => {
    expect(extractSessionId('...\nsession_id: 20260707_103508_da8b11\n...')).toBe('20260707_103508_da8b11');
    expect(extractSessionId('no marker here')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/pilot/solve.test.ts`
Expected: FAIL — `solve.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/pilot/solve.ts
export interface Arm { name: 'A' | 'B'; skills: string[]; }
export interface SolveTokens { inputTokens: number; outputTokens: number; cacheReadTokens: number; }

/** The jinn-agent argv for one solve. Arm A = empty loadout enforced via
 *  --ignore-rules (no memory/AGENTS.md/preloaded-skill leakage, spike §3.1);
 *  arm B = arm A + `-s <skill>` for each loadout skill. */
export function buildSolveArgs(arm: Arm, prompt: string, opts: { maxTurns: number }): string[] {
  const base = ['chat', '-q', prompt, '-Q', '--yolo', '--ignore-rules'];
  const skills = arm.skills.flatMap((s) => ['-s', s]);
  return [...base, ...skills, '--pass-session-id', '--max-turns', String(opts.maxTurns)];
}

export function parseSessionTokens(exportLine: string): SolveTokens {
  const o = JSON.parse(exportLine) as Record<string, unknown>;
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number') throw new Error(`session export missing numeric token field '${k}'`);
    return v;
  };
  return {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: typeof o['cache_read_tokens'] === 'number' ? (o['cache_read_tokens'] as number) : 0,
  };
}

export function extractSessionId(stderr: string): string | null {
  const m = stderr.match(/session_id:\s*(\S+)/);
  return m ? m[1]! : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/pilot/solve.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/pilot/solve.ts client/test/pilot/solve.test.ts
git commit -m "feat(pilot): solve-driver pure helpers (arm args, token parse, session id)"
```

---

## Task 2: Token cost pricing (`cost.ts`)

**Files:**
- Create: `client/src/pilot/cost.ts`
- Test: `client/test/pilot/cost.test.ts`

**Interfaces:**
- Consumes: `SolveTokens` from `./solve.js`.
- Produces: `RateTable` (`{ inputPerM: number; outputPerM: number; cacheReadPerM?: number }`), `solveCostUsd(tokens: SolveTokens, rates: RateTable): number`. Default `DEEPSEEK_V4_FLASH_RATES = { inputPerM: 0.09, outputPerM: 0.18 }`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/pilot/cost.test.ts
import { describe, it, expect } from 'vitest';
import { solveCostUsd, DEEPSEEK_V4_FLASH_RATES } from '../../src/pilot/cost.js';

describe('token cost pricing', () => {
  it('prices input + output at the fixed rate table', () => {
    // 186114 input * 0.09/M + 6207 output * 0.18/M
    const c = solveCostUsd({ inputTokens: 186114, outputTokens: 6207, cacheReadTokens: 0 }, DEEPSEEK_V4_FLASH_RATES);
    expect(c).toBeCloseTo(186114 * 0.09e-6 + 6207 * 0.18e-6, 6);
  });
  it('discounts cache-read input when a cacheReadPerM rate is given', () => {
    const rates = { ...DEEPSEEK_V4_FLASH_RATES, cacheReadPerM: 0.02 };
    const withCache = solveCostUsd({ inputTokens: 100000, outputTokens: 0, cacheReadTokens: 50000 }, rates);
    const noCacheRate = solveCostUsd({ inputTokens: 100000, outputTokens: 0, cacheReadTokens: 50000 }, DEEPSEEK_V4_FLASH_RATES);
    expect(withCache).toBeLessThan(noCacheRate); // cache-read billed cheaper than fresh input
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `cd client && yarn vitest run test/pilot/cost.test.ts` → FAIL (no `cost.js`).

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/pilot/cost.ts
import type { SolveTokens } from './solve.js';

export interface RateTable { inputPerM: number; outputPerM: number; cacheReadPerM?: number; }
export const DEEPSEEK_V4_FLASH_RATES: RateTable = { inputPerM: 0.09, outputPerM: 0.18 };

/** USD for one solve from provider-actual token counts. When a cacheReadPerM
 *  rate is supplied, cache-read tokens are priced at that (discounted) rate and
 *  the remaining (fresh) input at inputPerM; otherwise all input is inputPerM. */
export function solveCostUsd(tokens: SolveTokens, rates: RateTable): number {
  const per = (n: number, rate: number): number => n * rate * 1e-6;
  if (typeof rates.cacheReadPerM === 'number') {
    const fresh = Math.max(0, tokens.inputTokens - tokens.cacheReadTokens);
    return per(fresh, rates.inputPerM) + per(tokens.cacheReadTokens, rates.cacheReadPerM) + per(tokens.outputTokens, rates.outputPerM);
  }
  return per(tokens.inputTokens, rates.inputPerM) + per(tokens.outputTokens, rates.outputPerM);
}
```

- [ ] **Step 4: Run to verify it passes.** PASS (2 tests).

- [ ] **Step 5: Commit.** `git commit -m "feat(pilot): token cost pricing from a fixed rate table"`

---

## Task 3: Tally + report (`tally.ts`)

Wires per-(task,arm,repeat) results into the Plan-1 stats and produces the pilot report. This is where the whole comparison comes together.

**Files:**
- Create: `client/src/pilot/tally.ts`
- Test: `client/test/pilot/tally.test.ts`

**Interfaces:**
- Consumes: `pairedRateDiffLowerBound`, `nonInferiorityVerdict`, `pairedCostVerdict`, `TaskRates` from `../eval/capability-stats.js`.
- Produces: `SolveOutcome` (`{ instance_id: string; arm: 'A' | 'B'; repeat: number; passed: boolean | null; costUsd: number }` — `passed: null` = ungradeable), `PilotReport`, `tallyPilot(outcomes: SolveOutcome[], opts: { rng: () => number }): PilotReport`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/pilot/tally.test.ts
import { describe, it, expect } from 'vitest';
import { tallyPilot, type SolveOutcome } from '../../src/pilot/tally.js';

function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; }; }

// Build R=2 outcomes for N tasks where arm B matches A's quality and is cheaper.
function mk(n: number): SolveOutcome[] {
  const out: SolveOutcome[] = [];
  for (let i = 0; i < n; i++) for (const r of [0, 1]) {
    out.push({ instance_id: `t${i}`, arm: 'A', repeat: r, passed: i % 2 === 0, costUsd: 0.03 });
    out.push({ instance_id: `t${i}`, arm: 'B', repeat: r, passed: i % 2 === 0, costUsd: 0.02 });
  }
  return out;
}

describe('pilot tally', () => {
  it('computes per-arm resolve rate and the both-solve cost delta', () => {
    const rep = tallyPilot(mk(10), { rng: lcg(1) });
    expect(rep.n).toBe(10);
    expect(rep.armA.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.armB.resolveRate).toBeCloseTo(0.5, 5);
    expect(rep.quality.lowerBound).toBeGreaterThan(-0.05); // non-inferior
    expect(rep.cost.verdict).toBe('lower');                // B cheaper on both-solve tasks
    expect(rep.bothSolveTasks).toBeGreaterThan(0);
  });
  it('excludes ungradeable (passed:null) task-repeats from the pairing, never scores them as fail', () => {
    const o = mk(4);
    o[0]!.passed = null; // one ungradeable arm-A repeat
    const rep = tallyPilot(o, { rng: lcg(2) });
    expect(rep.excluded).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** FAIL (no `tally.js`).

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/pilot/tally.ts
import { pairedRateDiffLowerBound, nonInferiorityVerdict, pairedCostVerdict, type TaskRates } from '../eval/capability-stats.js';

export interface SolveOutcome { instance_id: string; arm: 'A' | 'B'; repeat: number; passed: boolean | null; costUsd: number; }

export interface PilotReport {
  n: number;
  armA: { resolveRate: number };
  armB: { resolveRate: number };
  bothSolveTasks: number;
  excluded: number;
  quality: { lowerBound: number; nonInferior: boolean; deltaPP: number };
  cost: { verdict: 'lower' | 'not-lower' | 'inconclusive'; medianDeltaUsd: number };
}

export function tallyPilot(outcomes: SolveOutcome[], opts: { rng: () => number }): PilotReport {
  const byTask = new Map<string, SolveOutcome[]>();
  for (const o of outcomes) (byTask.get(o.instance_id) ?? byTask.set(o.instance_id, []).get(o.instance_id)!).push(o);

  const rates: TaskRates[] = [];
  const costDiffs: number[] = [];
  let excluded = 0;
  let aPassTot = 0, aTot = 0, bPassTot = 0, bTot = 0, bothSolve = 0;

  for (const [, os] of byTask) {
    const A = os.filter((o) => o.arm === 'A');
    const B = os.filter((o) => o.arm === 'B');
    const gradedA = A.filter((o) => o.passed !== null);
    const gradedB = B.filter((o) => o.passed !== null);
    if (gradedA.length === 0 || gradedB.length === 0) { excluded++; continue; }
    const pA = gradedA.filter((o) => o.passed === true).length / gradedA.length;
    const pB = gradedB.filter((o) => o.passed === true).length / gradedB.length;
    rates.push({ pA, pB });
    aPassTot += gradedA.filter((o) => o.passed === true).length; aTot += gradedA.length;
    bPassTot += gradedB.filter((o) => o.passed === true).length; bTot += gradedB.length;
    // both-solve cost: mean cost on the repeats where BOTH arms passed (like-for-like)
    if (pA > 0 && pB > 0) {
      const meanCost = (xs: SolveOutcome[], pass: boolean): number => {
        const f = xs.filter((o) => o.passed === pass); return f.length ? f.reduce((s, o) => s + o.costUsd, 0) / f.length : NaN;
      };
      const ca = meanCost(gradedA, true), cb = meanCost(gradedB, true);
      if (Number.isFinite(ca) && Number.isFinite(cb)) { costDiffs.push(cb - ca); bothSolve++; }
    }
  }

  const stockBaseRate = aTot > 0 ? aPassTot / aTot : 0;
  const ni = rates.length
    ? nonInferiorityVerdict(rates, { rng: opts.rng, stockBaseRate: Math.max(stockBaseRate, 1e-9) })
    : { pass: false, lowerBound: NaN, relativeRegression: NaN, reasons: ['no gradeable pairs'] } as ReturnType<typeof nonInferiorityVerdict>;
  const cost = pairedCostVerdict(costDiffs, { minN: 1 });
  const median = (xs: number[]): number => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

  return {
    n: rates.length + excluded,
    armA: { resolveRate: stockBaseRate },
    armB: { resolveRate: bTot > 0 ? bPassTot / bTot : 0 },
    bothSolveTasks: bothSolve,
    excluded,
    quality: { lowerBound: ni.lowerBound, nonInferior: ni.pass, deltaPP: 100 * ((bTot > 0 ? bPassTot / bTot : 0) - stockBaseRate) },
    cost: { verdict: cost.verdict, medianDeltaUsd: median(costDiffs) },
  };
}
```

- [ ] **Step 4: Run to verify it passes.** PASS (2 tests).

- [ ] **Step 5: Commit.** `git commit -m "feat(pilot): tally per-solve outcomes into paired quality+cost report"`

---

## Task 4: Instance fetch + CLI orchestrator (`instance.ts`, `run-pilot.ts`)

The integration glue. Its I/O (spawning jinn-agent, git, the grader) is **validated by `--dry-run` + the smoke run, not unit tests** — a deliberate, stated choice (the pure logic is covered by Tasks 1–3).

**Files:**
- Create: `client/src/pilot/instance.ts` (raw-row fetch for base_commit + problem_statement)
- Create: `client/scripts/run-pilot.ts` (CLI orchestrator)
- Test: `client/test/pilot/instance.test.ts` (parse-only, stubbed fetch)

**Interfaces:**
- `PilotInstance` = `{ instance_id, repo, base_commit, problem_statement, hf_dataset, hf_split }`.
- `parsePilotInstanceRow(row: Record<string, unknown>, ctx): PilotInstance` (pure, tested).
- `run-pilot.ts` orchestration (no exported API; a `main()` behind `import.meta` guard).

- [ ] **Step 1: Write the failing test (parse only)**

```ts
// client/test/pilot/instance.test.ts
import { describe, it, expect } from 'vitest';
import { parsePilotInstanceRow } from '../../src/pilot/instance.js';

describe('pilot instance parse', () => {
  it('pulls the solve-side fields the grader HfRow omits', () => {
    const row = { instance_id: 'pilosus__pip-license-checker-119', repo: 'pilosus/pip-license-checker',
      base_commit: '22d2f959', problem_statement: 'pin the API version header' };
    expect(parsePilotInstanceRow(row, { hf_dataset: 'ds', hf_split: 'train' })).toEqual({
      instance_id: 'pilosus__pip-license-checker-119', repo: 'pilosus/pip-license-checker',
      base_commit: '22d2f959', problem_statement: 'pin the API version header',
      hf_dataset: 'ds', hf_split: 'train',
    });
  });
  it('throws when base_commit or problem_statement is missing', () => {
    expect(() => parsePilotInstanceRow({ instance_id: 'x', repo: 'a/b', base_commit: 'c' }, { hf_dataset: 'ds', hf_split: 't' })).toThrow(/problem_statement/);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** FAIL (no `instance.js`).

- [ ] **Step 3: Implement `instance.ts`**

```ts
// client/src/pilot/instance.ts
export interface PilotInstance {
  instance_id: string; repo: string; base_commit: string; problem_statement: string;
  hf_dataset: string; hf_split: string;
}
export function parsePilotInstanceRow(row: Record<string, unknown>, ctx: { hf_dataset: string; hf_split: string }): PilotInstance {
  const s = (k: string): string => {
    const v = row[k]; if (typeof v !== 'string' || !v) throw new Error(`pilot instance row missing '${k}'`); return v;
  };
  return {
    instance_id: s('instance_id'), repo: s('repo'), base_commit: s('base_commit'),
    problem_statement: s('problem_statement'), hf_dataset: ctx.hf_dataset, hf_split: ctx.hf_split,
  };
}
```

- [ ] **Step 4: Run to verify it passes.** PASS (2 tests).

- [ ] **Step 5: Implement `run-pilot.ts` (orchestrator)**

Write `client/scripts/run-pilot.ts` implementing this control flow (see the spike doc for the exact commands). Requirements, precisely:

- **Config** (CLI flags or a small JSON): `instances` (explicit list of `{instance_id, hf_dataset, hf_split}`, default the spike's `pilosus__pip-license-checker-119` on `ibragim-bad/SWE-rebench-V2-sample`/`train`), `R` (repeats, default 1 for smoke), `skill` (arm-B loadout skill, default `systematic-debugging`), `maxTurns` (default 20), `maxInstances`, `upstreamRepoDir` (default `~/.jinn-client/SWE-rebench-V2-upstream`), `jinnAgentBin` (default `~/.local/bin/jinn-agent`), `dryRun` (bool).
- **Per instance:** fetch the row (raw HF `/rows` like `hf-fetcher.ts`; parse via `parsePilotInstanceRow` for solve fields **and** the grader fields via `HttpHfFetcher.fetchTaskRow`); `git clone` the repo once to a temp base dir + `git checkout base_commit`.
- **Per (arm, repeat):** `cp -R` the base to a fresh dir; write the prompt (a short instruction wrapper + `problem_statement`); spawn `jinnAgentBin` with `buildSolveArgs(arm, prompt, {maxTurns})` (cwd = the copy); on exit, `git diff` → patch, `extractSessionId(stderr)` → `jinn-agent sessions export --session-id <id> -` → `parseSessionTokens` → tokens; `solveCostUsd(tokens, DEEPSEEK_V4_FLASH_RATES)` → cost.
- **Grade** each patch with `new PythonEvalRunner({ upstreamRepoDir }).runEval({...grader fields from the HfRow, patch})`; map `passed_match` → `passed: boolean`, and `EvalCouldNotGradeError` (import it) → `passed: null` (ungradeable, never a fail).
- **Collect** `SolveOutcome[]`, call `tallyPilot(outcomes, { rng })`, and **print** a readable report: per-arm resolve rate, quality lower-bound + non-inferior?, cost verdict + median Δ$, both-solve count, excluded count, and **total tokens + total $ actually spent**.
- **`--dry-run`:** skip clone/spawn/grade entirely; synthesize deterministic fake outcomes (e.g. alternating pass/fail, arm B slightly cheaper) so the full control flow + printing runs with **zero spend and zero Docker**. Print a clear `DRY RUN — no spend` banner.
- **Bounds:** no retry on a failed solve/grade (record it as ungradeable/failed and continue); honor `maxInstances`; log each solve's instance/arm/repeat/tokens/$ as it happens so a run is observable and interruptible.
- Guard `main()` with `if (import.meta.url === \`file://${process.argv[1]}\`)` and run via `yarn tsx client/scripts/run-pilot.ts`.

- [ ] **Step 6: Verify the wiring with a dry-run (no spend)**

Run: `cd client && yarn tsx scripts/run-pilot.ts --dry-run`
Expected: prints the `DRY RUN` banner + a full report from synthesized outcomes, exit 0. This proves the orchestration + tally + print path end-to-end without a cent.

- [ ] **Step 7: Typecheck + full eval/pilot tests, then commit**

```bash
cd client && yarn vitest run test/pilot && yarn typecheck
git add client/src/pilot/instance.ts client/scripts/run-pilot.ts client/test/pilot/instance.test.ts
git commit -m "feat(pilot): instance fetch + CLI orchestrator with --dry-run (no-spend wiring check)"
```

---

## Self-Review

- **Coverage:** solve driver (T1), cost (T2), tally→stats (T3), instance fetch + orchestrator + dry-run (T4). Reuses hf-fetcher + PythonEvalRunner (grade) + capability-stats (compare). Every spend-bounding constraint (max-turns, no-retry, max-instances, dry-run) is in T4.
- **Placeholder scan:** T1–T3 ship complete code; T4's orchestrator is a precise spec (its I/O is validated by dry-run + smoke, stated explicitly — not a placeholder).
- **Type consistency:** `SolveTokens` (T1) → `solveCostUsd` (T2); `SolveOutcome` (T3) is what the orchestrator (T4) assembles from solve+grade; `TaskRates`/verdict types come from the Plan-1 `capability-stats`.
- **Not built (deferred to Plan 2, by design):** contested-band screening, the frozen slate artifact + disjointness wiring, pre-registration, R-sizing power calc. The pilot uses a hand-picked small instance set and R=1–3; its job is *does the machinery work + an early effect read*, not a gate-quality number.

## After the plan: the run ladder (no spend until the smoke)

1. `yarn tsx scripts/run-pilot.ts --dry-run` — free wiring check.
2. **Smoke** — 2–3 instances, R=1 (~$0.50): does the real loop solve+grade+tally end to end?
3. **Pilot** — ~20 instances, R=3 (~$8–12): the early validation read + effect-size for sizing the full run.
