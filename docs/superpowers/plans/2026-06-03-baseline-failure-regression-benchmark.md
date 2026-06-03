# Baseline-Failure Regression Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the screening tool that constructs a held-out "baseline-failure regression benchmark" (the `v2` slate) — gradeable tasks the base Haiku harness reliably fails but a stronger Codex/GPT-5.5 prover can pass — plus the train-stream exclusion and the protocol, so a frozen checkpoint can be scored against it over time (issue #986).

**Architecture:** A pure, dependency-injected core (`screen.ts`) implements the 3-layer partition (gradeable → Haiku 0/R≥3 → Codex ≥1-pass) over a repo-stratified, budget-bounded candidate stream. A production runner (`screen-runner.ts`) wires the real evaluator + base/prover harnesses; a `jinn solver-nets screen-held-out` subverb is the thin operator entry point. The generator excludes the union of active slate versions. The eval-on-`v2` side is reused unchanged (`jinn eval v2`, which already reports Wilson + paired McNemar from PR #987).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, node `parseArgs`, the existing swe-rebench-v2 evaluator (Docker gold-grading) + learner harnesses (claude-code / codex).

---

## Prerequisite — stack on PR #987

This plan **depends on `client/src/eval/paired.ts`** (the McNemar statistic) and the `EvalRunResult.paired` wiring, which live on PR #987 (`claude/gallant-brattain-b07015`), not yet on `next`. The execution branch must include #987's commits. **Merge order: #987 → this.**

Spec: [`docs/superpowers/specs/2026-06-03-baseline-failure-regression-benchmark-design.md`](../specs/2026-06-03-baseline-failure-regression-benchmark-design.md).

---

### Task 0: Verify the #987-stacked baseline is green

**Files:** none (environment check)

- [ ] **Step 1: Confirm paired.ts is present (the #987 dependency)**

Run: `cd client && test -f src/eval/paired.ts && grep -q 'export function comparePaired' src/eval/paired.ts && echo PRESENT || echo MISSING`
Expected: `PRESENT`. If `MISSING`, rebase/merge `origin/claude/gallant-brattain-b07015` into the working branch before continuing (the eval-on-v2 reporting needs it).

- [ ] **Step 2: Confirm the toolchain is green**

Run: `cd client && yarn install --immutable && yarn typecheck`
Expected: exit 0, zero type errors.

- [ ] **Step 3: Confirm the eval test slice passes**

Run: `cd client && yarn test test/eval`
Expected: PASS (includes `paired.test.ts` from #987).

---

### Task 1: `repoOf` + `stratifyByRepo` candidate ordering

Deterministic, repo-round-robin ordering so the first N base-fails span repos (spec §2 "repo-stratified"). The repo key is the org prefix of `instance_id` (`tobymao__sqlglot-4661` → `tobymao`) — derivable without an HF fetch.

**Files:**
- Create: `client/src/eval/screen.ts`
- Test: `client/test/eval/screen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/screen.test.ts
import { describe, it, expect } from 'vitest';
import { repoOf, stratifyByRepo } from '../../src/eval/screen.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const t = (instance_id: string): PoolTask => ({ instance_id }) as PoolTask;

describe('repoOf', () => {
  it('returns the org prefix before the first __', () => {
    expect(repoOf(t('tobymao__sqlglot-4661'))).toBe('tobymao');
    expect(repoOf(t('All-Hands-AI__OpenHands-11914'))).toBe('All-Hands-AI');
  });
});

describe('stratifyByRepo', () => {
  it('round-robins across repos, deterministic within and across groups', () => {
    const pool = [
      t('b__r-2'), t('a__r-3'), t('a__r-1'), t('b__r-1'), t('a__r-2'),
    ];
    // groups sorted by repo: a=[a__r-1,a__r-2,a__r-3], b=[b__r-1,b__r-2]
    // round-robin: a__r-1, b__r-1, a__r-2, b__r-2, a__r-3
    expect(stratifyByRepo(pool).map((x) => x.instance_id)).toEqual([
      'a__r-1', 'b__r-1', 'a__r-2', 'b__r-2', 'a__r-3',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/eval/screen.test.ts -t stratifyByRepo`
Expected: FAIL — `repoOf`/`stratifyByRepo` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/eval/screen.ts
import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';

/** Stratification / diversity key: the org prefix of an instance_id
 *  (`tobymao__sqlglot-4661` → `tobymao`). Derivable without an HF fetch. */
export function repoOf(task: PoolTask): string {
  const idx = task.instance_id.indexOf('__');
  return idx === -1 ? task.instance_id : task.instance_id.slice(0, idx);
}

/**
 * Order candidates round-robin across repos so the first N base-fails span
 * repos rather than clumping in alphabetically-early ones. Deterministic:
 * instances sort by instance_id within each repo group; repo groups iterate in
 * sorted repo order.
 */
export function stratifyByRepo(pool: PoolTask[]): PoolTask[] {
  const groups = new Map<string, PoolTask[]>();
  for (const task of pool) {
    const repo = repoOf(task);
    (groups.get(repo) ?? groups.set(repo, []).get(repo)!).push(task);
  }
  const repos = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const repo of repos) {
    groups.get(repo)!.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  }
  const out: PoolTask[] = [];
  let added = true;
  for (let i = 0; added; i++) {
    added = false;
    for (const repo of repos) {
      const g = groups.get(repo)!;
      if (i < g.length) {
        out.push(g[i]!);
        added = true;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/eval/screen.test.ts -t stratifyByRepo`
Expected: PASS (both `repoOf` and `stratifyByRepo` describes).

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/screen.ts client/test/eval/screen.test.ts
git commit -m "feat(eval): repo-stratified candidate ordering for held-out screening (#986)"
```

---

### Task 2: `screenBaseFailures` — the 3-layer partition core

The heart of the tool. Pure logic with injected boundaries: each candidate passes gradeable → base 0/R → prover ≥1-pass, capped at N with a per-repo diversity cap and a max-candidates budget. Unscorable runs are excluded from the denominator, never coerced to a fail (#476). No-headroom tasks (base-fail but prover doesn't pass) are excluded.

**Files:**
- Modify: `client/src/eval/screen.ts`
- Test: `client/test/eval/screen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to client/test/eval/screen.test.ts
import { screenBaseFailures, type ScreenDeps, type ScreenOpts } from '../../src/eval/screen.js';

function deps(over: Partial<ScreenDeps>): ScreenDeps {
  return {
    ensureGradeable: async () => true,
    runBaseFrozen: async () => ({ passed: false }),
    runProverFrozen: async () => ({ passed: true }),
    ...over,
  };
}
const OPTS: ScreenOpts = { R: 3, heldOutCount: 10, maxCandidates: 100, perRepoCap: 10 };

describe('screenBaseFailures', () => {
  it('admits gradeable × base-0/R × prover-pass; classifies the rest', async () => {
    const cands = [t('o__a-1'), t('o__b-1'), t('o__c-1'), t('o__d-1')];
    const r = await screenBaseFailures(cands, deps({
      ensureGradeable: async (x) => x.instance_id !== 'o__a-1',          // a: not gradeable
      runBaseFrozen: async (x) => ({ passed: x.instance_id === 'o__b-1' }), // b: base passes
      runProverFrozen: async (x) => ({ passed: x.instance_id === 'o__c-1' }), // c: prover passes, d: not
    }), OPTS);
    expect(r.heldOut.map((h) => h.instance_id)).toEqual(['o__c-1']);
    const byId = Object.fromEntries(r.screened.map((s) => [s.instance_id, s.reason]));
    expect(byId).toEqual({
      'o__a-1': 'not-gradeable', 'o__b-1': 'base-passes',
      'o__c-1': 'held-out', 'o__d-1': 'no-headroom',
    });
  });

  it('excludes a base-unscorable task (never coerces to fail)', async () => {
    const r = await screenBaseFailures([t('o__a-1')], deps({
      runBaseFrozen: async () => ({ passed: null }),
    }), OPTS);
    expect(r.heldOut).toHaveLength(0);
    expect(r.screened[0]!.reason).toBe('base-unscorable');
  });

  it('honors the per-repo cap', async () => {
    const r = await screenBaseFailures([t('o__a-1'), t('o__a-2')], deps({}), { ...OPTS, perRepoCap: 1 });
    expect(r.heldOut.map((h) => h.instance_id)).toEqual(['o__a-1']);
    expect(r.screened.find((s) => s.instance_id === 'o__a-2')!.reason).toBe('per-repo-cap');
  });

  it('stops at the held-out cap', async () => {
    const r = await screenBaseFailures([t('o__a-1'), t('o__b-1')], deps({}), { ...OPTS, heldOutCount: 1 });
    expect(r.heldOut).toHaveLength(1);
    expect(r.screened).toHaveLength(1); // loop breaks once the cap is full
  });

  it('runs base exactly R times and stops early on a base pass', async () => {
    let runs = 0;
    await screenBaseFailures([t('o__a-1')], deps({
      runBaseFrozen: async () => { runs++; return { passed: true }; },
    }), { ...OPTS, R: 3 });
    expect(runs).toBe(1); // first pass ⇒ not a reliable fail ⇒ stop
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/eval/screen.test.ts -t screenBaseFailures`
Expected: FAIL — `screenBaseFailures` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to client/src/eval/screen.ts

/** One frozen run's grade outcome. `null` = unscorable (Docker/grader/infra failure). */
export interface ScreenCandidateRun {
  passed: boolean | null;
}

export interface ScreenDeps {
  /** Confirm gradeable at the current semantics version (idempotent; cheap/cached). */
  ensureGradeable(task: PoolTask): Promise<boolean>;
  /** Base Haiku, frozen, empty impl-state. `passed: null` = unscorable. */
  runBaseFrozen(task: PoolTask): Promise<ScreenCandidateRun>;
  /** Prover (Codex/GPT-5.5), frozen, empty impl-state. `passed: null` = unscorable. */
  runProverFrozen(task: PoolTask): Promise<ScreenCandidateRun>;
  log?: (msg: string) => void;
}

export interface ScreenOpts {
  /** Base runs per candidate (≥3). A candidate is a reliable fail iff 0/R passed. */
  R: number;
  /** Exam cap N. */
  heldOutCount: number;
  /** Budget: stop after this many candidates reach the base-run stage. */
  maxCandidates: number;
  /** Max held-out instances per repo (diversity). */
  perRepoCap: number;
}

export type ScreenReason =
  | 'held-out' | 'not-gradeable' | 'base-passes' | 'base-unscorable' | 'no-headroom' | 'per-repo-cap';

export interface ScreenedCandidate {
  instance_id: string;
  repo: string;
  gradeable: boolean;
  baseRuns: number;
  basePasses: number;
  proverPassed: boolean | null; // null = not reached or unscorable
  heldOut: boolean;
  reason: ScreenReason;
}

export interface ScreenResult {
  heldOut: { instance_id: string; repo: string; baseRuns: number }[];
  screened: ScreenedCandidate[];
}

/**
 * Partition a candidate stream into the held-out exam vs the rest, applying the
 * three filter layers cheapest-first. `candidates` MUST already be ordered (use
 * {@link stratifyByRepo}); selection order is the iteration order and is frozen.
 */
export async function screenBaseFailures(
  candidates: PoolTask[],
  deps: ScreenDeps,
  opts: ScreenOpts,
): Promise<ScreenResult> {
  const log = deps.log ?? (() => {});
  const heldOut: ScreenResult['heldOut'] = [];
  const screened: ScreenedCandidate[] = [];
  const perRepo = new Map<string, number>();
  let baseScreened = 0;

  for (const task of candidates) {
    if (heldOut.length >= opts.heldOutCount) break;
    const repo = repoOf(task);
    const base = { instance_id: task.instance_id, repo, baseRuns: 0, basePasses: 0, proverPassed: null as boolean | null };

    if (!(await deps.ensureGradeable(task))) {
      screened.push({ ...base, gradeable: false, heldOut: false, reason: 'not-gradeable' });
      continue;
    }
    if (baseScreened >= opts.maxCandidates) break; // budget bounds expensive runs
    baseScreened++;

    // Layer 2: base Haiku × R, early-stop on the first pass.
    let basePasses = 0;
    let baseUnscorable = false;
    let r = 0;
    for (; r < opts.R; r++) {
      const run = await deps.runBaseFrozen(task);
      if (run.passed === null) { baseUnscorable = true; break; }
      if (run.passed) { basePasses++; break; }
    }
    const baseRuns = r + (baseUnscorable || basePasses > 0 ? 1 : 0);
    if (baseUnscorable) {
      screened.push({ ...base, baseRuns, gradeable: true, heldOut: false, reason: 'base-unscorable' });
      continue;
    }
    if (basePasses > 0) {
      screened.push({ ...base, baseRuns, basePasses, gradeable: true, heldOut: false, reason: 'base-passes' });
      continue;
    }

    // Layer 3: prover ≥1 pass (existence proof of headroom).
    const prover = await deps.runProverFrozen(task);
    if (prover.passed !== true) {
      screened.push({ ...base, baseRuns: opts.R, gradeable: true, proverPassed: prover.passed, heldOut: false, reason: 'no-headroom' });
      continue;
    }
    if ((perRepo.get(repo) ?? 0) >= opts.perRepoCap) {
      screened.push({ ...base, baseRuns: opts.R, gradeable: true, proverPassed: true, heldOut: false, reason: 'per-repo-cap' });
      continue;
    }

    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
    heldOut.push({ instance_id: task.instance_id, repo, baseRuns: opts.R });
    screened.push({ ...base, baseRuns: opts.R, gradeable: true, proverPassed: true, heldOut: true, reason: 'held-out' });
    log(`[screen] held out ${task.instance_id} (${heldOut.length}/${opts.heldOutCount})`);
  }

  return { heldOut, screened };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/eval/screen.test.ts`
Expected: PASS (all `screenBaseFailures` + Task 1 cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/screen.ts client/test/eval/screen.test.ts
git commit -m "feat(eval): 3-layer base-failure screening core (gradeable/base-0R/prover) (#986)"
```

---

### Task 3: v2 slate artifact builder

Produce the content-hashed `v2` slate object (reusing the #817 hashing) so it round-trips through `loadHeldOutSlate`. The `comment` documents provenance and is outside the hash.

**Files:**
- Modify: `client/src/eval/screen.ts`
- Test: `client/test/eval/screen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to client/test/eval/screen.test.ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildV2SlateFile } from '../../src/eval/screen.js';
import { loadHeldOutSlate } from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';

describe('buildV2SlateFile', () => {
  it('builds a v2 slate that loadHeldOutSlate accepts with a matching hash', () => {
    const file = buildV2SlateFile(['o__b-2', 'o__a-1'], '2026-06-03T00:00:00.000Z');
    expect(file.version).toBe('v2');
    expect(file.solverType).toBe('swe-rebench-v2.v1');
    expect(file.instanceIds).toEqual(['o__a-1', 'o__b-2']); // sorted
    const dir = mkdtempSync(join(tmpdir(), 'slate-test-'));
    try {
      writeFileSync(join(dir, 'held-out-slate.swe-rebench-v2.v2.json'), JSON.stringify(file));
      const loaded = loadHeldOutSlate('swe-rebench-v2.v1', 'v2', { dir });
      expect(loaded.hash).toBe(file.hash);
      expect([...loaded.instanceIds].sort()).toEqual(['o__a-1', 'o__b-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/eval/screen.test.ts -t buildV2SlateFile`
Expected: FAIL — `buildV2SlateFile` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to client/src/eval/screen.ts
import {
  HELD_OUT_SLATE_SCHEMA_VERSION,
  hashHeldOutSlateArtifact,
  type HeldOutSlateArtifact,
} from '../solver-types/_swe-rebench-v2-held-out-slate.js';

/** The on-disk v2 slate file = the hashed artifact + a provenance `comment`
 *  (the comment is outside the canonical hash). solverType matches the
 *  `${solverType}.v1` key `jinn eval` loads with. */
export interface V2SlateFile extends HeldOutSlateArtifact {
  comment: string;
  hash: `sha256:${string}`;
}

const V2_SLATE_COMMENT =
  'BASELINE-FAILURE REGRESSION BENCHMARK (issue #986). Screened: gradeable at the current ' +
  'evalSemanticsVersion AND base claude-code/Haiku frozen fails 0/R (R≥3) AND a stronger Codex/GPT-5.5 ' +
  'prover passes ≥1 (proven headroom). Baseline 0% by construction. Held out from the generator train ' +
  'stream via the active-slate-version union. Content-addressed; scores comparable WITHIN this version only.';

export function buildV2SlateFile(instanceIds: string[], generatedAt: string): V2SlateFile {
  const artifact: HeldOutSlateArtifact = {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: 'swe-rebench-v2.v1',
    version: 'v2',
    generatedAt,
    instanceIds: [...instanceIds].sort((a, b) => a.localeCompare(b)),
  };
  return { comment: V2_SLATE_COMMENT, ...artifact, hash: hashHeldOutSlateArtifact(artifact) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/eval/screen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/screen.ts client/test/eval/screen.test.ts
git commit -m "feat(eval): v2 held-out slate artifact builder (#986)"
```

---

### Task 4: Generator excludes the union of active slate versions

AC#2. The generator hardcodes `SLATE_VERSION = 'v1'` and excludes only v1. Introduce an active-versions list and a union loader so any active slate version is held out. **Keep the constant at `['v1']` now** — Task 7 flips it to `['v1', 'v2']` in the same commit that adds the v2 file (so the generator never loads a missing slate).

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-held-out-slate.ts`
- Modify: `client/src/solver-types/swe-rebench-v2.ts:564`
- Test: `client/test/solver-types/held-out-slate.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// client/test/solver-types/held-out-slate.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadActiveHeldOutSlateIds,
  hashHeldOutSlateArtifact,
  HELD_OUT_SLATE_SCHEMA_VERSION,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';

function writeSlate(dir: string, version: string, ids: string[]): void {
  const artifact = {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: 'swe-rebench-v2.v1',
    version,
    generatedAt: '2026-06-03T00:00:00.000Z',
    instanceIds: ids,
  };
  writeFileSync(
    join(dir, `held-out-slate.swe-rebench-v2.${version}.json`),
    JSON.stringify({ ...artifact, hash: hashHeldOutSlateArtifact(artifact) }),
  );
}

describe('loadActiveHeldOutSlateIds', () => {
  it('unions instance ids across all active slate versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slates-'));
    try {
      writeSlate(dir, 'v1', ['o__a-1', 'o__b-1']);
      writeSlate(dir, 'v2', ['o__c-1', 'o__b-1']); // b-1 overlaps
      const ids = loadActiveHeldOutSlateIds('swe-rebench-v2.v1', ['v1', 'v2'], { dir });
      expect([...ids].sort()).toEqual(['o__a-1', 'o__b-1', 'o__c-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/solver-types/held-out-slate.test.ts`
Expected: FAIL — `loadActiveHeldOutSlateIds` not exported.

- [ ] **Step 3: Add the union loader + active-versions constant**

```ts
// append to client/src/solver-types/_swe-rebench-v2-held-out-slate.ts

/**
 * Slate versions currently used as held-out exams. The generator excludes the
 * UNION of these from the train stream, so every active exam stays out of
 * training while non-slate instances of every repo remain trainable. Add a
 * version here ONLY when its slate file exists (loadHeldOutSlate fails loud on
 * a missing file).
 */
export const ACTIVE_HELD_OUT_SLATE_VERSIONS = ['v1'] as const;

/** Union of instance ids across the given active slate versions. */
export function loadActiveHeldOutSlateIds(
  solverType: string,
  versions: readonly string[],
  opts: { dir?: string } = {},
): Set<string> {
  const ids = new Set<string>();
  for (const version of versions) {
    for (const id of loadHeldOutSlate(solverType, version, opts).instanceIds) ids.add(id);
  }
  return ids;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/solver-types/held-out-slate.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the generator to the union**

In `client/src/solver-types/swe-rebench-v2.ts`, update the imports from `./_swe-rebench-v2-held-out-slate.js` to add `ACTIVE_HELD_OUT_SLATE_VERSIONS` and `loadActiveHeldOutSlateIds`, then replace the exclusion call (currently around line 564):

```ts
    // Held-out eval slate exclusion (issue #817 AC#2, #986). Exclude the UNION
    // of active slate versions so every held-out exam stays out of the train
    // stream while non-slate instances of every repo remain trainable.
    const slateExcludedBefore = scorablePool.length;
    const eligiblePool = excludeHeldOutSlate(
      scorablePool,
      loadActiveHeldOutSlateIds(SOLVER_TYPE, ACTIVE_HELD_OUT_SLATE_VERSIONS),
    );
    if (eligiblePool.length < slateExcludedBefore && !slateWarned) {
      slateWarned = true;
      console.warn(
        `[swe-rebench-v2-gen] held-out slates [${ACTIVE_HELD_OUT_SLATE_VERSIONS.join(', ')}]: excluded ` +
        `${slateExcludedBefore - eligiblePool.length} reserved instance(s) from the train stream.`,
      );
    }
```

- [ ] **Step 6: Verify typecheck + the broader slate/generator tests pass**

Run: `cd client && yarn typecheck && yarn test test/solver-types`
Expected: exit 0; PASS (the existing v1 exclusion behavior is unchanged since the constant is still `['v1']`).

- [ ] **Step 7: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-held-out-slate.ts client/src/solver-types/swe-rebench-v2.ts client/test/solver-types/held-out-slate.test.ts
git commit -m "feat(solver-types): generator excludes union of active held-out slate versions (#986 AC#2)"
```

---

### Task 5: Production screening runner + `jinn solver-nets screen-held-out` subverb

Wire the real evaluator + base (Haiku) and prover (Codex) harnesses into `screenBaseFailures`, emit the v2 slate + screening report, and persist the base arm. The runner mirrors `efficacy-probe.ts` (harness/eval wiring) and the `validate-pool` subverb (evaluator/Docker preconditions); the subverb is a thin flag-parsing shell.

**Files:**
- Create: `client/src/eval/screen-runner.ts`
- Modify: `client/src/cli/commands/solver-nets.ts` (add flags + the subverb dispatch)
- Test: `client/test/eval/screen-runner.test.ts`

- [ ] **Step 1: Write the production runner**

```ts
// client/src/eval/screen-runner.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness, RuntimePlugin } from '../harnesses/types.js';
import type { Task } from '../types/task.js';
import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';
import { loadConfig } from '../config.js';
import { Store } from '../store/store.js';
import { hashImplStateDir } from '../harnesses/freeze.js';
import { LearnerHarness } from '../harnesses/impls/learner/harness.js';
import { ClaudeCodeHarnessAdapter } from '../harnesses/impls/learner/adapters/claude-code.js';
import { CodexCodeHarnessAdapter } from '../harnesses/impls/learner/adapters/codex-code.js';
import { CODEX_HARNESS } from '../harnesses/names.js';
import { runHarnessForEval, resolveRuntimePluginsForSolverType } from './eval-harness-run.js';
import { corpusEnvFromConfig } from '../cli/commands/eval.js';
import {
  loadSweRebenchV2Pool, defaultStateDir, getSweRebenchV2ValidatedPoolStore,
} from '../solver-types/swe-rebench-v2.js';
import { PoolCacheStore, loadPoolWithCacheFallback } from '../solver-types/_swe-rebench-v2-pool-cache.js';
import {
  validatePoolInstances, EVAL_SEMANTICS_VERSION,
} from '../solver-types/_swe-rebench-v2-validated-pool.js';
import { resolveSlateTasks } from './resolve-slate-tasks.js';
import { SweRebenchV2Evaluator } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { HttpHfFetcher } from '../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { readEnabledState, defaultSweRebenchV2EvaluatorImplStateDir } from '../harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import {
  stratifyByRepo, screenBaseFailures, buildV2SlateFile,
  type ScreenDeps, type ScreenResult,
} from './screen.js';

const DISPATCH_SOLVER_TYPE = 'swe-rebench-v2.v1';
const SLATE_VERSION = 'v2';
const RUN_BUDGET_MS = 3_600_000;

export interface ScreenRunOptions {
  R: number;
  heldOutCount: number;
  maxCandidates: number;
  perRepoCap: number;
  proverModel?: string;
  /** Restrict candidates to these instance ids (else whole gradeable pool). */
  instanceIds?: string[];
  /** Restrict candidates to one repo (org prefix), e.g. `tobymao`. */
  repo?: string;
  configPath?: string;
  log?: (msg: string) => void;
}

export interface ScreenRunSummary {
  result: ScreenResult;
  baseCodeDigest: string;
  slatePath: string;
  reportPath: string;
  heldOutCount: number;
}

/** dist/src parity: the shipped slate JSON lives next to the compiled module. */
function slatesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'solver-types', 'slates');
}

export async function runScreenHeldOut(opts: ScreenRunOptions): Promise<ScreenRunSummary> {
  const log = opts.log ?? (() => {});
  const config = loadConfig(opts.configPath);

  // Precondition: evaluator enabled (upstream repo cloned).
  const enabled = readEnabledState(defaultSweRebenchV2EvaluatorImplStateDir());
  if (!enabled) {
    throw new Error(
      'swe-rebench-v2 evaluator not enabled — run `jinn harnesses enable swe-rebench-v2-evaluator` first',
    );
  }
  const upstreamRepoDir = enabled.upstreamRepoDir;

  const stateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? defaultStateDir();
  const fetcher = new HttpHfFetcher();
  const evaluator = new SweRebenchV2Evaluator({ fetcher, runner: new PythonEvalRunner({ upstreamRepoDir }) });
  const validatedStore = getSweRebenchV2ValidatedPoolStore();
  const runtimePlugins: RuntimePlugin[] = await resolveRuntimePluginsForSolverType(
    DISPATCH_SOLVER_TYPE, config.joinedSolverNets,
  );

  // Common adapter wiring (mirrors buildEvalHarness in cli/commands/eval.ts).
  const daemonApiToken = process.env['DAEMON_API_TOKEN']?.trim();
  const corpusEnv = corpusEnvFromConfig(config);
  const common = {
    claudePath: config.claudePath ?? 'claude',
    storePath: config.dbPath,
    daemonApiUrl: `http://127.0.0.1:${config.apiPort}`,
    ...(daemonApiToken ? { daemonApiToken } : {}),
    ...(corpusEnv ? { corpusEnv } : {}),
  };
  const baseHarness: Harness = new LearnerHarness({
    adapter: new ClaudeCodeHarnessAdapter({ ...common, claudeModel: config.claudeModel }),
    claudePath: common.claudePath,
  });
  const proverHarness: Harness = new LearnerHarness({
    name: CODEX_HARNESS,
    adapter: new CodexCodeHarnessAdapter({ ...common, ...(opts.proverModel ? { codexModel: opts.proverModel } : {}) }),
    claudePath: common.claudePath,
    ...(config.codexPath !== undefined ? { codexPath: config.codexPath } : {}),
  });

  // Candidate pool (whole gradeable pool by default; scopeable).
  const cacheResult = await loadPoolWithCacheFallback({
    loadPool: loadSweRebenchV2Pool, cache: new PoolCacheStore({ stateDir }), currentPool: [],
  });
  let pool = cacheResult.pool;
  if (pool.length === 0) throw new Error(`SWE-rebench v2 pool empty${cacheResult.error ? ` (${cacheResult.error.message})` : ''}`);
  if (opts.instanceIds?.length) {
    const want = new Set(opts.instanceIds);
    pool = pool.filter((t) => want.has(t.instance_id));
  }
  if (opts.repo) pool = pool.filter((t) => t.instance_id.startsWith(`${opts.repo}__`));
  const candidates = stratifyByRepo(pool);
  log(`[screen] ${candidates.length} candidate(s) after stratification`);

  // Resolve a single instance to the {task,row} the harness + grader need.
  const byId = new Map(pool.map((t) => [t.instance_id, t]));
  async function runOnce(harness: Harness, poolTask: PoolTask, implStateDir: string): Promise<{ passed: boolean | null }> {
    try {
      const [resolved] = await resolveSlateTasks({
        poolTasks: [poolTask], hf_dataset: poolTask.hf_dataset, hf_split: poolTask.hf_split, fetcher,
      });
      if (!resolved) return { passed: null };
      const task: Task = {
        id: poolTask.instance_id,
        description: resolved.task.problem_statement,
        role: 'restoration',
        solverType: DISPATCH_SOLVER_TYPE,
        spec: resolved.task as unknown as Record<string, unknown>,
        window: { startTs: 0, endTs: Date.now() + RUN_BUDGET_MS },
      };
      const run = await runHarnessForEval({
        harness, task, solverType: DISPATCH_SOLVER_TYPE, runtimePlugins, implStateDir, mode: 'frozen',
      });
      if (run.violation || !run.solution) return { passed: null };
      const verdict = await evaluator.grade({
        task: resolved.task,
        solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch: run.solution.patch },
        row: resolved.row,
      });
      return { passed: verdict.passed_match };
    } catch {
      return { passed: null }; // any harness/grader/infra failure ⇒ unscorable, never a fail (#476)
    }
  }

  const emptyBaseDir = mkdtempSync(join(tmpdir(), 'jinn-screen-base-'));
  const hashOpts = baseHarness.freezeStateHashIgnore?.length
    ? { ignoreRelPaths: [...baseHarness.freezeStateHashIgnore] } : undefined;
  const baseCodeDigest = `sha256:${await hashImplStateDir(emptyBaseDir, hashOpts)}`;

  const deps: ScreenDeps = {
    log,
    ensureGradeable: async (task) => {
      await validatePoolInstances([task], {
        fetcher, runner: new PythonEvalRunner({ upstreamRepoDir }), store: validatedStore,
        semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir,
      }, {});
      return (await validatedStore.getEntry(task.instance_id, EVAL_SEMANTICS_VERSION))?.scorable === true;
    },
    runBaseFrozen: (task) => runOnce(baseHarness, byId.get(task.instance_id)!, mkdtempSync(join(tmpdir(), 'jinn-screen-base-'))),
    runProverFrozen: (task) => runOnce(proverHarness, byId.get(task.instance_id)!, mkdtempSync(join(tmpdir(), 'jinn-screen-prover-'))),
  };

  const result = await screenBaseFailures(candidates, deps, {
    R: opts.R, heldOutCount: opts.heldOutCount, maxCandidates: opts.maxCandidates, perRepoCap: opts.perRepoCap,
  });

  const generatedAt = new Date().toISOString();
  const slateFile = buildV2SlateFile(result.heldOut.map((h) => h.instance_id), generatedAt);
  mkdirSync(slatesDir(), { recursive: true });
  const slatePath = join(slatesDir(), 'held-out-slate.swe-rebench-v2.v2.json');
  writeFileSync(slatePath, `${JSON.stringify(slateFile, null, 2)}\n`);
  const reportPath = join(slatesDir(), 'held-out-slate.swe-rebench-v2.v2.screening-report.json');
  writeFileSync(reportPath, `${JSON.stringify({
    generatedAt, evalSemanticsVersion: EVAL_SEMANTICS_VERSION, baseCodeDigest,
    R: opts.R, proverModel: opts.proverModel ?? 'codex-default', heldOut: result.heldOut, screened: result.screened,
  }, null, 2)}\n`);

  // Persist the base arm (all-fail) so `jinn eval v2 --parent <baseCodeDigest>` reports McNemar.
  const store = new Store(config.dbPath);
  try {
    const runAtMs = Date.now();
    for (const h of result.heldOut) {
      store.recordEvalResult({
        checkpoint_cid: baseCodeDigest, slate_hash: slateFile.hash, slate_version: SLATE_VERSION,
        instance_id: h.instance_id, passed: false, unscorable: false, code_digest: baseCodeDigest,
        run_at_ms: runAtMs, test_log_excerpt: 'base arm (screening): consistent fail 0/R',
      });
    }
  } finally {
    store.close?.();
  }

  return { result, baseCodeDigest, slatePath, reportPath, heldOutCount: result.heldOut.length };
}
```

- [ ] **Step 2: Write the runner precondition smoke test**

```ts
// client/test/eval/screen-runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The evaluator-enabled check must fire before any inference. Force it absent.
vi.mock('../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js', () => ({
  readEnabledState: () => null,
  defaultSweRebenchV2EvaluatorImplStateDir: () => '/tmp/nope',
}));

describe('runScreenHeldOut preconditions', () => {
  beforeEach(() => vi.resetModules());
  it('fails loud with an actionable message when the evaluator is not enabled', async () => {
    const { runScreenHeldOut } = await import('../../src/eval/screen-runner.js');
    await expect(
      runScreenHeldOut({ R: 3, heldOutCount: 10, maxCandidates: 60, perRepoCap: 3 }),
    ).rejects.toThrow(/jinn harnesses enable swe-rebench-v2-evaluator/);
  });
});
```

- [ ] **Step 3: Run the smoke test to verify it fails then passes**

Run: `cd client && yarn test test/eval/screen-runner.test.ts`
Expected: first FAIL (module/export missing), then PASS after Step 1 is in place. (No Docker/inference exercised — the precondition throws first.)

- [ ] **Step 4: Add CLI flags for the new subverb**

In `client/src/cli/commands/solver-nets.ts`, extend the `parseArgs` `options` block (currently ending at `'known-pytest-missing'`) with:

```ts
        // screen-held-out (#986)
        runs: { type: 'string' },
        'held-out-count': { type: 'string' },
        'max-candidates': { type: 'string' },
        'per-repo-cap': { type: 'string' },
        'prover-model': { type: 'string' },
        repo: { type: 'string' },
```

- [ ] **Step 5: Add the subverb dispatch block**

In `client/src/cli/commands/solver-nets.ts`, immediately AFTER the `if (subverb === 'validate-pool') { … }` block (it ends near line 636, before the `if (!name)` guard), insert:

```ts
    if (subverb === 'screen-held-out') {
      if (name !== 'swe-rebench-v2') {
        fail(ctx, 'solver-nets screen-held-out currently supports only `swe-rebench-v2`');
        return;
      }
      // Docker must be reachable (spec §8 precondition) or every base/prover
      // grade is unscorable and the screen yields nothing — fail loud instead.
      if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
        fail(ctx, 'Docker daemon not reachable — start Docker, then re-run `jinn solver-nets screen-held-out swe-rebench-v2`');
        return;
      }
      const num = (key: string, dflt: number): number => {
        const raw = parsed.values[key] as string | undefined;
        const v = raw ? Number.parseInt(raw, 10) : NaN;
        return Number.isFinite(v) && v > 0 ? v : dflt;
      };
      const { runScreenHeldOut } = await import('../../eval/screen-runner.js');
      const instanceIds = resolveValidatePoolInstanceIds({
        instanceId: parsed.values['instance-id'] as string[] | undefined,
        instancesFile: parsed.values['instances-file'] as string | undefined,
        seedPositive: Boolean(parsed.values['seed-positive']),
        knownBad: Boolean(parsed.values['known-bad']),
        knownPytestMissing: Boolean(parsed.values['known-pytest-missing']),
      });
      const summary = await runScreenHeldOut({
        R: num('runs', 3),
        heldOutCount: num('held-out-count', 10),
        maxCandidates: num('max-candidates', 60),
        perRepoCap: num('per-repo-cap', 3),
        ...(parsed.values['prover-model'] ? { proverModel: parsed.values['prover-model'] as string } : {}),
        ...(instanceIds.length ? { instanceIds } : {}),
        ...(parsed.values['repo'] ? { repo: parsed.values['repo'] as string } : {}),
        ...(parsed.values['config'] ? { configPath: parsed.values['config'] as string } : {}),
        log: (m) => process.stderr.write(`${m}\n`),
      });
      emit(
        ctx,
        {
          verb: 'solver-nets screen-held-out', solverNet: 'swe-rebench-v2',
          heldOut: summary.heldOutCount, baseCodeDigest: summary.baseCodeDigest,
          slatePath: summary.slatePath, reportPath: summary.reportPath,
          screened: summary.result.screened.length,
        },
        human, json,
        (v) => {
          const s = v as { heldOut: number; baseCodeDigest: string; slatePath: string };
          return `held-out=${s.heldOut}  base=${s.baseCodeDigest}\n  slate: ${s.slatePath}\n` +
            `  next: jinn eval v2 --checkpoint <trained-cid> --parent ${s.baseCodeDigest}`;
        },
      );
      return;
    }
```

- [ ] **Step 6: Add the subverb to the help text**

In the `solver-nets` `helpText` (near the `validate-pool` usage line ~400), add:

```
  jinn solver-nets screen-held-out swe-rebench-v2 [--repo <org>] [--instance-id <id> ...]
      [--runs 3] [--held-out-count 10] [--max-candidates 60] [--per-repo-cap 3] [--prover-model <m>]
```

- [ ] **Step 7: Verify typecheck + tests**

Run: `cd client && yarn typecheck && yarn test test/eval/screen-runner.test.ts`
Expected: exit 0; PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/eval/screen-runner.ts client/src/cli/commands/solver-nets.ts client/test/eval/screen-runner.test.ts
git commit -m "feat(solver-nets): screen-held-out subverb + production screening runner (#986)"
```

---

### Task 6: Protocol doc

AC#4 — document the standing-benchmark protocol so future operators run it correctly.

**Files:**
- Create: `docs/runbooks/held-out-regression-benchmark.md`

- [ ] **Step 1: Write the doc**

```markdown
# Held-out regression benchmark (baseline-failure exam) — runbook

Issue #986. Design: `docs/superpowers/specs/2026-06-03-baseline-failure-regression-benchmark-design.md`.

## What it is
A standing, content-addressed set of swe-rebench-v2 tasks that are (a) gradeable
at the current evalSemanticsVersion, (b) reliably failed by the base
claude-code/Haiku harness (0/R, R≥3), and (c) passed by a stronger Codex/GPT-5.5
prover at least once (proven headroom). Baseline = 0% by construction → the most
sensitive operating point. The live SolverNet is the training stream; this exam
is held out from it and scored against frozen checkpoints over time.

## Preconditions
- `jinn harnesses enable swe-rebench-v2-evaluator` (clones the upstream eval repo).
- Docker reachable.
- The Codex prover configured (the `codex` CLI + its API key) for layer 3.
- `JINN_EVAL_DISK_FLOOR_GB ≥ 40`. The evaluator prunes Docker per instance
  (`rmi` + `container`/`builder prune`) and gates each round on the floor, so
  peak disk ≈ the heaviest single image (~12.6 GB), NOT the sum — a whole-pool
  screen runs on a normal machine, exactly like `validate-pool`. If an instance
  can't hold the floor the runner aborts that grade cleanly
  (`InsufficientDiskError` → unscorable → skipped); it never crashes. The DR §4
  laptop crash was a low *starting* disk (~14 GB), not a leak. No 100 GB host
  needed; on a very tight box raise headroom or scope with `--repo`.

## Cut the exam (screening)
```
jinn solver-nets screen-held-out swe-rebench-v2 \
  --runs 3 --held-out-count 10 --max-candidates 60 --per-repo-cap 3
```
Whole-pool by default (repo-stratified). Scope with `--repo tobymao` (within-repo
sanity check) or `--instance-id <id> ...`. Emits, next to the slate module:
- `held-out-slate.swe-rebench-v2.v2.json` (content-hashed exam)
- `held-out-slate.swe-rebench-v2.v2.screening-report.json` (per-candidate evidence)
and records the base arm (all-fail) under the printed `baseCodeDigest`.

Then add `'v2'` to `ACTIVE_HELD_OUT_SLATE_VERSIONS` and commit the slate + report
(see the plan, Task 7). The generator now holds v2 out of the train stream.

## Honesty guards (never weaken the exam)
- **R≥3, keep only 0/R.** A single Haiku miss is noise, not a capability gap.
- **Prover proves headroom, not Haiku-reachability.** It removes unflippable /
  broken tasks; it does not guarantee the learner specifically can flip them.
- **Freeze before training.** Selection order is deterministic and the set is
  content-hashed; never re-pick based on checkpoint outcomes (no p-hacking).
- **Exclude un-gradeable / unscorable.** Never coerce an infra/grader failure to
  a capability fail.
- **Widen, don't pad.** If fewer than N clear all three layers, widen the
  candidate pool; the report logs the shortfall and any disk-skipped repos.

## Score a checkpoint
```
jinn eval v2 --checkpoint <trained-cid> --parent <baseCodeDigest>
```
Reports per-task pass/fail, Wilson CIs, and the paired McNemar verdict vs the
base arm. With baseline 0%, ~5–6 fail→pass flips clears the strict bar.

## Periodic base re-run (control)
Re-run `screen-held-out` scoped to the v2 ids (or re-grade base Haiku on them) to
confirm they STILL fail at baseline — rules out regression-to-the-mean. If base
still fails them but a trained checkpoint passes, the delta is airtight.

## Threats to validity
Held-out discipline currently rests on the generator being the sole posting path
(generator-only exclusion; the published vetted-pool artifact still lists the exam
instances). A whole-pool exam measures cross-repo transfer, a genuinely harder bar
than within-repo — it may read within-noise longer.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/held-out-regression-benchmark.md
git commit -m "docs(runbook): held-out regression benchmark protocol (#986)"
```

---

### Task 7: Cut the v2 slate (operator run) + activate the exclusion

**Real inference + Docker — not a CI step.** This produces the committed `v2`
artifact and turns on the train-stream exclusion. Run on any machine with ≥40 GB
free disk — the evaluator prunes Docker per instance, so peak ≈ one image, not the
sum (scope with `--repo` on a very tight box).

**Files:**
- Create (emitted): `client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v2.json`
- Create (emitted): `client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v2.screening-report.json`
- Modify: `client/src/solver-types/_swe-rebench-v2-held-out-slate.ts` (flip the active-versions constant)

- [ ] **Step 1: Build the CLI and run the screening**

Run:
```bash
cd client && yarn build
JINN_EVAL_DISK_FLOOR_GB=40 node dist/bin/jinn.js solver-nets screen-held-out swe-rebench-v2 \
  --runs 3 --held-out-count 10 --max-candidates 80 --human
```
Expected: stderr progress per held-out instance; final line prints `held-out=<n>`,
the `baseCodeDigest`, and the slate path. The two JSON artifacts now exist under
`client/src/solver-types/slates/`. If `held-out < 10`, re-run with a larger
`--max-candidates` (widen) — do not lower the bar.

- [ ] **Step 2: Sanity-check the emitted slate loads**

Run: `cd client && yarn tsx -e "import {loadHeldOutSlate} from './src/solver-types/_swe-rebench-v2-held-out-slate.js'; const s=loadHeldOutSlate('swe-rebench-v2.v1','v2'); console.log(s.version, s.hash, [...s.instanceIds].length)"`
Expected: prints `v2 sha256:… <count>` with no hash-mismatch throw.

- [ ] **Step 3: Activate the union exclusion**

Edit `client/src/solver-types/_swe-rebench-v2-held-out-slate.ts`:

```ts
export const ACTIVE_HELD_OUT_SLATE_VERSIONS = ['v1', 'v2'] as const;
```

- [ ] **Step 4: Verify the generator now excludes v2 + typecheck**

Run: `cd client && yarn typecheck && yarn test test/solver-types`
Expected: exit 0; PASS (the held-out-slate union test still green; the generator loads both slate files without throwing).

- [ ] **Step 5: Verify the eval-on-v2 wiring (no training needed)**

Run: `cd client && node dist/bin/jinn.js eval v2 --checkpoint <baseCodeDigest> --parent <baseCodeDigest> --human`
(substitute the `baseCodeDigest` printed in Step 1; pass `--impl-state-dir` to an empty dir if prompted)
Expected: a `resolved 0/<scorable> = 0.0% … Δ +0.0pp (within noise)` line with a `paired` McNemar field present — confirms the base arm + paired stat are wired end-to-end. (Self-compare ⇒ 0 flips.)

- [ ] **Step 6: Commit the artifacts + activation**

```bash
git add client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v2.json \
        client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v2.screening-report.json \
        client/src/solver-types/_swe-rebench-v2-held-out-slate.ts
git commit -m "feat(eval): cut held-out v2 baseline-failure slate + activate exclusion (#986)"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full typecheck + targeted test suites**

Run: `cd client && yarn typecheck && yarn test test/eval test/solver-types`
Expected: exit 0; all PASS.

- [ ] **Step 2: Confirm AC coverage against the spec**

Check each acceptance criterion in the spec §7 maps to merged work:
- AC#1 screening tool emits content-hashed v2 → Tasks 1–5, 7.
- AC#2 v2 excluded via `excludeHeldOutSlate` union → Task 4 + Task 7 activation.
- AC#3 repeatable eval w/ Wilson + paired McNemar → reused `jinn eval v2`, verified Task 7 Step 5.
- AC#4 protocol incl. R≥3 + periodic base re-run → Task 6.
- AC#5 live trained-checkpoint delta → **follow-on milestone** (file/track separately; gated on SolverNet training wall-clock).

- [ ] **Step 3: Confirm the working tree is clean and the branch is ready**

Run: `cd client && git status --porcelain` then `git log --oneline origin/claude/gallant-brattain-b07015..HEAD`
Expected: clean tree; the commit list shows Tasks 1–7 stacked on #987.
```
