# Per-codeDigest Reward Selection on Revert (Issue #764) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the learner's Memory-consolidation phase a quantitative, statistically-grounded trigger for reverting regressed Improve commits — backed by per-(operator, codeDigest) network-truth pass-rate aggregates from the indexer — so reverts fire only when an Improve commit made the frozen-eval pass rate significantly worse than its parent.

**Architecture:** Decision logic lives in pure, testable TypeScript (`client/src/learner/`): a two-proportion z-test (`revert-stats.ts`) plus a revert-decision function (`revert-decision.ts`) keyed off per-codeDigest aggregates. A new `DiscoveryAPI.getCodeDigestRewards` method (modeled on `getInstanceSuccessCounts`, #669) joins `attemptEnvelopeMeta` (codeDigest, mode) to `verdictEnvelopeMeta` (actualPassed, actualScore) by `requestId`, optionally scoped to an operator via the `attempt` table. The Consolidator subagent — which has only `Bash`/filesystem tools, not MCP — reaches this logic through a new `jinn codedigest-revert-check` CLI subcommand it shells out to; the same core also backs a new `get_codedigest_reward` MCP tool for parity. Commit→codeDigest mapping is the central correctness risk: codeDigest is the content-hash of `implStateDir` (`hashImplStateDir`, no `sha256:` prefix), NOT the git sha, and the learner harness currently hashes `.git` too — so the plan first makes `.git` ignored in the freeze hash, then maps each commit by exporting its tree (`git archive`, no `.git`) and re-hashing with the real hasher.

**Tech Stack:** TypeScript (Node 22), Vitest, viem, Ponder GraphQL (indexer), `@modelcontextprotocol/sdk`, the learner plugin's git-backed `implStateDir`.

---

## Background facts verified against the worktree (read before starting)

- **codeDigest definition.** `client/src/harnesses/freeze.ts` `hashImplStateDir(dir, { ignoreRelPaths })` returns a 64-hex SHA-256 over `"<relpath>:<filehash>\n"` lines (sorted), walking subdirs, skipping symlinks. The engine stamps `codeDigest = "sha256:" + hashImplStateDir(...)` (`client/src/harnesses/engine/engine.ts:1273`, `freeze-fence.ts:55`). The indexer column `attemptEnvelopeMeta.codeDigest` stores that `sha256:`-prefixed string (`packages/indexer/ponder.schema.ts:539`).
- **`.git` is currently hashed.** Only `hermes-agent` sets `freezeStateHashIgnore` (`client/src/harnesses/impls/hermes-agent/harness.ts:51`). The `learner` harness (`client/src/harnesses/impls/learner/harness.ts`) sets none, so its codeDigest hashes the whole tree **including `.git`**. `implStateDir` is git-backed (`client/plugins/learner/hooks/session-start` runs `git init`). Therefore a commit's codeDigest is NOT reproducible by `git checkout <sha>` + re-hash unless `.git` is excluded. **Task 1 fixes this prerequisite.**
- **Indexer schema (no operator on the meta table).** `attemptEnvelopeMeta` (PK `requestId, chainId`) has `codeDigest`, `mode` ('train'|'frozen'|'unknown'), `solverType`, `manifestCid`, `enrichmentStatus`, `enrichedAtBlock` — **no `operator`**. `verdictEnvelopeMeta` (PK `requestId, chainId`) has `actualPassed` (bool, source of truth), `actualScore` (string), `solverType`, `instanceId`. The `operator` Safe lives on `attempt` (PK `taskId, attemptIndex, chainId`; has `requestId`, `operator`, indexes on `operator`). Join key across all three is `requestId` (+`chainId`).
- **`codeDigestIdx` on `attemptEnvelopeMeta.codeDigest`** was added by PR #783 (this branch is stacked on it) — `packages/indexer/ponder.schema.ts:565`.
- **Existing precedent to mirror:** `getInstanceSuccessCounts` — interface JSDoc `client/src/discovery/types.ts:265-294`; http impl `client/src/discovery/http.ts:1008-1050` (paginated, `MAX_PAGES`/`PAGE_LIMIT=1000`, client-side group, `(requestId|chainId)` dedupe); onchain stub `client/src/discovery/onchain.ts:1286-1288` (empty Map); withFallback no-fallthrough `client/src/discovery/with-fallback.ts:247-256`. http test patterns: `client/test/discovery/http.test.ts` (`mockFetch`, `notReadyFetch`, `networkErrorFetch`, `isReadyProbe`, `BASE_URL`).
- **GraphQL transport:** `postGql` (`http.ts:478`) turns any network/HTTP/GraphQL error into `DiscoveryUnavailableError`. `ensureReady()` (`http.ts:550`) gates every method on the `/ready` probe.
- **Consolidator tools:** `client/plugins/learner/skills/learn/consolidator-prompt.md` frontmatter `tools: Bash, Read, Write, Edit, Glob, Grep` — **no MCP**. It already owns "Regressed promotions" reverts (line 19) using `improvePromotionsDir/<n>.json`'s `implStateDirShaAfter`.
- **CLI command shape:** `client/src/cli/commands/rewards.ts` is the canonical small `CommandModule` (factory + `PRODUCTION_DEPS` + `parseArgs` + `emitResult`); register in `client/src/cli/index.ts` `COMMANDS` array.
- **Policy override convention:** `implStateDir/policy.json` (e.g. `policy.maxNotesBytes`), read by consolidator prompt.

---

## File Structure

**New files:**
- `client/src/learner/revert-stats.ts` — pure two-proportion z-test (no I/O).
- `client/src/learner/revert-decision.ts` — pure decision function + constants + types.
- `client/src/cli/commands/codedigest-revert-check.ts` — CLI subcommand the Consolidator shells out to.
- `client/test/learner/revert-stats.test.ts` — unit tests for the z-test (hand-computed values).
- `client/test/learner/revert-decision.test.ts` — unit tests for the decision function.
- `client/test/learner/revert-decision.git-fixture.test.ts` — synthetic git-history fixture test (AC5).
- `client/test/discovery/http.codedigest-rewards.test.ts` — http `getCodeDigestRewards` tests (mirrors `http.test.ts`).
- `client/test/cli/codedigest-revert-check.test.ts` — CLI command tests (stubbed deps).

**Modified files:**
- `client/src/harnesses/impls/learner/harness.ts` — add `freezeStateHashIgnore = ['.git']`.
- `client/src/discovery/types.ts` — add `CodeDigestRewardRow`, `getCodeDigestRewards` to the interface.
- `client/src/discovery/http.ts` — implement `getCodeDigestRewards`.
- `client/src/discovery/onchain.ts` — empty-array stub + export.
- `client/src/discovery/with-fallback.ts` — no-fallthrough wiring.
- `client/src/mcp/server.ts` — register `get_codedigest_reward` tool.
- `client/src/cli/index.ts` — register the new command.
- `client/plugins/learner/skills/learn/consolidator-prompt.md` — document the quantitative trigger + how to invoke the CLI and map commits→codeDigest.
- `client/test/harnesses/` (existing freeze test location) — assert `.git` ignored.

---

## Task 1: Exclude `.git` from the learner codeDigest (mapping prerequisite)

**Why first:** Without this, a commit's codeDigest can never be reproduced from its git tree, so the whole per-codeDigest mapping is unsound. This is a behavior change to the freeze hash for the learner harness only.

**Files:**
- Modify: `client/src/harnesses/impls/learner/harness.ts`
- Test: `client/test/harnesses/learner-freeze-ignore.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `client/test/harnesses/learner-freeze-ignore.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import { LearnerHarness } from '../../src/harnesses/impls/learner/harness.js';

describe('learner harness freezeStateHashIgnore', () => {
  it('declares .git as ignored', () => {
    const h = new LearnerHarness();
    expect(h.freezeStateHashIgnore).toContain('.git');
  });

  it('codeDigest is stable across differing .git contents when .git is ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learner-freeze-'));
    try {
      await writeFile(join(dir, 'skill.md'), 'content-A', 'utf8');
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
      const ignore = ['.git'] as const;
      const before = await hashImplStateDir(dir, { ignoreRelPaths: ignore });
      // Mutate ONLY .git — digest must not change.
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other', 'utf8');
      const after = await hashImplStateDir(dir, { ignoreRelPaths: ignore });
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Confirm the exported class name / constructor by reading `client/src/harnesses/impls/learner/harness.ts` and `index.ts`; adjust the import to match (it may export a factory rather than a class — mirror whatever the file exports).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/harnesses/learner-freeze-ignore.test.ts`
Expected: FAIL — `freezeStateHashIgnore` is undefined / does not contain `.git`.

- [ ] **Step 3: Add the ignore declaration**

In `client/src/harnesses/impls/learner/harness.ts`, add a class field mirroring hermes-agent's shape:

```typescript
readonly freezeStateHashIgnore = ['.git'] as const;
```

(If learner is a factory/object rather than a class, set the same property on the returned harness object. Match the existing `Harness` interface field `freezeStateHashIgnore?: readonly string[]` at `client/src/harnesses/types.ts:234`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/harnesses/learner-freeze-ignore.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/impls/learner/harness.ts client/test/harnesses/learner-freeze-ignore.test.ts
git commit -m "fix(learner): exclude .git from codeDigest so commit->digest mapping is reproducible (#764)"
```

---

## Task 2: Pure two-proportion z-test (`revert-stats.ts`)

**Files:**
- Create: `client/src/learner/revert-stats.ts`
- Test: `client/test/learner/revert-stats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/learner/revert-stats.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { twoProportionZTest } from '../../src/learner/revert-stats.js';

describe('twoProportionZTest', () => {
  it('returns z≈0 and p≈1 for identical proportions', () => {
    const r = twoProportionZTest({ passesA: 50, totalA: 100, passesB: 50, totalB: 100 });
    expect(r.z).toBeCloseTo(0, 6);
    expect(r.pValue).toBeCloseTo(1, 3);
  });

  it('computes a known z for a clear difference (90/100 vs 50/100)', () => {
    // pooled p = 140/200 = 0.7; se = sqrt(0.7*0.3*(1/100+1/100)) = sqrt(0.0042) = 0.0648074
    // z = (0.9 - 0.5) / 0.0648074 = 6.172
    const r = twoProportionZTest({ passesA: 90, totalA: 100, passesB: 50, totalB: 100 });
    expect(r.z).toBeCloseTo(6.172, 2);
    expect(r.pValue).toBeLessThan(0.001);
  });

  it('sign of z reflects A minus B (worse A => negative z)', () => {
    const r = twoProportionZTest({ passesA: 40, totalA: 100, passesB: 70, totalB: 100 });
    expect(r.z).toBeLessThan(0);
    expect(r.delta).toBeCloseTo(0.4 - 0.7, 6);
  });

  it('returns z=0,p=1 (no signal) when either arm total is 0', () => {
    const r = twoProportionZTest({ passesA: 0, totalA: 0, passesB: 5, totalB: 10 });
    expect(r.z).toBe(0);
    expect(r.pValue).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/learner/revert-stats.test.ts`
Expected: FAIL with "Cannot find module '../../src/learner/revert-stats.js'".

- [ ] **Step 3: Implement the pure z-test**

Create `client/src/learner/revert-stats.ts`:

```typescript
/**
 * Pure statistics for the per-codeDigest revert decision (issue #764).
 *
 * Two-proportion z-test on pass/total for "arm A" (codeDigest WITH a candidate
 * Improve commit) vs "arm B" (codeDigest AT the commit's parent). No I/O; unit-
 * tested directly with hand-computed z-values. `delta = pA - pB` (negative means
 * the commit made the pass rate worse).
 */

export interface TwoProportionInput {
  passesA: number;
  totalA: number;
  passesB: number;
  totalB: number;
}

export interface TwoProportionResult {
  /** pA - pB (negative => arm A is worse). */
  delta: number;
  /** Test statistic; sign matches `delta`. 0 when either arm has no samples. */
  z: number;
  /** Two-sided p-value in [0, 1]. 1 when there is no signal. */
  pValue: number;
}

/** Two-proportion z-test. Returns no-signal (z=0, p=1) if either total is 0. */
export function twoProportionZTest(input: TwoProportionInput): TwoProportionResult {
  const { passesA, totalA, passesB, totalB } = input;
  if (totalA <= 0 || totalB <= 0) {
    const pA = totalA > 0 ? passesA / totalA : 0;
    const pB = totalB > 0 ? passesB / totalB : 0;
    return { delta: pA - pB, z: 0, pValue: 1 };
  }
  const pA = passesA / totalA;
  const pB = passesB / totalB;
  const delta = pA - pB;
  const pooled = (passesA + passesB) / (totalA + totalB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (se === 0) {
    // Both arms 0% or both 100% — no measurable difference.
    return { delta, z: 0, pValue: 1 };
  }
  const z = delta / se;
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { delta, z, pValue };
}

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation. */
function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26, max abs error ~1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/learner/revert-stats.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/learner/revert-stats.ts client/test/learner/revert-stats.test.ts
git commit -m "feat(learner): pure two-proportion z-test for revert decisions (#764)"
```

---

## Task 3: Pure revert-decision function + constants (`revert-decision.ts`)

**Files:**
- Create: `client/src/learner/revert-decision.ts`
- Test: `client/test/learner/revert-decision.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/learner/revert-decision.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  decideRevert,
  DEFAULT_REVERT_POLICY,
  type CodeDigestAggregate,
} from '../../src/learner/revert-decision.js';

const agg = (passes: number, attempts: number): CodeDigestAggregate => ({
  codeDigest: 'sha256:x',
  attempts,
  passRate: attempts > 0 ? passes / attempts : 0,
  passes,
});

describe('decideRevert', () => {
  it('recommends revert when delta<0 and p<alpha and both arms meet the floor', () => {
    const r = decideRevert(
      { withCommit: agg(40, 100), atParent: agg(80, 100) },
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(true);
    expect(r.delta).toBeLessThan(0);
    expect(r.pValue).toBeLessThan(DEFAULT_REVERT_POLICY.alpha);
    expect(r.reason).toBe('significant_regression');
  });

  it('does NOT revert when an arm is below the sample floor', () => {
    const r = decideRevert(
      { withCommit: agg(2, 5), atParent: agg(80, 100) }, // withCommit total 5 < 30
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.reason).toBe('insufficient_samples');
  });

  it('treats a zero-attempt codeDigest as insufficient_samples, not pass-rate 0', () => {
    const r = decideRevert(
      { withCommit: agg(0, 0), atParent: agg(80, 100) },
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.reason).toBe('insufficient_samples');
  });

  it('does NOT revert when the regression is not significant (worse but p>=alpha)', () => {
    const r = decideRevert(
      { withCommit: agg(48, 100), atParent: agg(52, 100) }, // small diff
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.delta).toBeLessThan(0);
    expect(r.reason).toBe('not_significant');
  });

  it('does NOT revert when the commit IMPROVED things (delta>0)', () => {
    const r = decideRevert(
      { withCommit: agg(90, 100), atParent: agg(50, 100) },
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.reason).toBe('no_regression');
  });

  it('exposes documented constants (no magic numbers)', () => {
    expect(DEFAULT_REVERT_POLICY.minSamplesPerArm).toBe(30);
    expect(DEFAULT_REVERT_POLICY.alpha).toBe(0.05);
    expect(DEFAULT_REVERT_POLICY.recentAttemptsWindow).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/learner/revert-decision.test.ts`
Expected: FAIL with "Cannot find module '../../src/learner/revert-decision.js'".

- [ ] **Step 3: Implement the decision function**

Create `client/src/learner/revert-decision.ts`:

```typescript
/**
 * Revert-decision logic for the learner's Memory-consolidation phase (#764).
 *
 * Given per-codeDigest pass-rate aggregates for a candidate Improve commit
 * (`withCommit`) and its parent (`atParent`), decide whether the commit
 * significantly regressed the frozen-eval pass rate and should be reverted.
 *
 * Thresholds are explicit and documented here (AC4) — not magic constants:
 *   - minSamplesPerArm: minimum indexed attempts required in EACH arm before a
 *     statistical test is meaningful. Below it, plateau is expected Level-1
 *     behaviour, so we abstain (reason 'insufficient_samples').
 *   - alpha: significance threshold (revert only when p < alpha, two-sided).
 *   - recentAttemptsWindow: how many most-recent attempts per codeDigest the
 *     aggregate is computed over. Overridable via implStateDir/policy.json
 *     (`policy.revert.recentAttemptsWindow`), mirroring policy.maxNotesBytes.
 */

import { twoProportionZTest } from './revert-stats.js';

export interface RevertPolicy {
  /** Minimum indexed attempts required per arm. Default 30. */
  minSamplesPerArm: number;
  /** Two-sided significance threshold. Default 0.05 (95% confidence). */
  alpha: number;
  /** Recent-attempts window per codeDigest. Default 200. */
  recentAttemptsWindow: number;
}

export const DEFAULT_REVERT_POLICY: RevertPolicy = {
  minSamplesPerArm: 30,
  alpha: 0.05,
  recentAttemptsWindow: 200,
};

export interface CodeDigestAggregate {
  codeDigest: string;
  /** Total indexed attempts for this codeDigest (within the window). */
  attempts: number;
  /** Pass count (verdictEnvelopeMeta.actualPassed === true). */
  passes: number;
  /** passes / attempts; 0 when attempts === 0. */
  passRate: number;
}

export type RevertReason =
  | 'significant_regression'
  | 'insufficient_samples'
  | 'not_significant'
  | 'no_regression';

export interface RevertDecisionInput {
  withCommit: CodeDigestAggregate;
  atParent: CodeDigestAggregate;
}

export interface RevertDecision {
  withCommit: { codeDigest: string; n: number; passRate: number };
  atParent: { codeDigest: string; n: number; passRate: number };
  delta: number;
  pValue: number;
  significant: boolean;
  recommendRevert: boolean;
  reason: RevertReason;
}

export function decideRevert(
  input: RevertDecisionInput,
  policy: RevertPolicy = DEFAULT_REVERT_POLICY,
): RevertDecision {
  const { withCommit, atParent } = input;
  const base = {
    withCommit: { codeDigest: withCommit.codeDigest, n: withCommit.attempts, passRate: withCommit.passRate },
    atParent: { codeDigest: atParent.codeDigest, n: atParent.attempts, passRate: atParent.passRate },
  };

  // Sample floor first — a zero-attempt codeDigest is "insufficient_samples",
  // NOT pass-rate zero (a fresh promotion that has not run yet is not a regression).
  if (withCommit.attempts < policy.minSamplesPerArm || atParent.attempts < policy.minSamplesPerArm) {
    return { ...base, delta: withCommit.passRate - atParent.passRate, pValue: 1, significant: false, recommendRevert: false, reason: 'insufficient_samples' };
  }

  const stats = twoProportionZTest({
    passesA: withCommit.passes,
    totalA: withCommit.attempts,
    passesB: atParent.passes,
    totalB: atParent.attempts,
  });
  const significant = stats.pValue < policy.alpha;

  if (stats.delta >= 0) {
    return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'no_regression' };
  }
  if (!significant) {
    return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'not_significant' };
  }
  return { ...base, delta: stats.delta, pValue: stats.pValue, significant: true, recommendRevert: true, reason: 'significant_regression' };
}

/** Merge a partial policy (e.g. from implStateDir/policy.json) over the defaults. */
export function resolveRevertPolicy(override?: Partial<RevertPolicy>): RevertPolicy {
  return { ...DEFAULT_REVERT_POLICY, ...(override ?? {}) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/learner/revert-decision.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/learner/revert-decision.ts client/test/learner/revert-decision.test.ts
git commit -m "feat(learner): pure revert-decision function with documented thresholds (#764)"
```

---

## Task 4: `getCodeDigestRewards` — DiscoveryAPI interface + types

**Files:**
- Modify: `client/src/discovery/types.ts`
- Test: `client/test/discovery/types.codedigest-reward.test.ts` (create — a compile-level shape test)

- [ ] **Step 1: Write the failing test**

Create `client/test/discovery/types.codedigest-reward.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { CodeDigestRewardRow, DiscoveryAPI } from '../../src/discovery/types.js';

describe('CodeDigestRewardRow shape', () => {
  it('has the documented fields', () => {
    const row: CodeDigestRewardRow = {
      codeDigest: 'sha256:abc',
      attempts: 10,
      passes: 7,
      passRate: 0.7,
      avgScore: 0.62,
    };
    expect(row.attempts).toBe(10);
    expect(row.passRate).toBeCloseTo(0.7);
  });

  it('DiscoveryAPI declares getCodeDigestRewards', () => {
    // Type-level assertion: a value typed as DiscoveryAPI must have the method.
    const has = (api: DiscoveryAPI): boolean => typeof api.getCodeDigestRewards === 'function';
    expect(has).toBeTypeOf('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/types.codedigest-reward.test.ts`
Expected: FAIL (type error: `CodeDigestRewardRow` not exported / `getCodeDigestRewards` not on `DiscoveryAPI`).

- [ ] **Step 3: Add the type and interface method**

In `client/src/discovery/types.ts`, add the row type near the other result shapes (above the `DiscoveryAPI` interface), and the method inside the interface immediately after `getInstanceSuccessCounts` (before the closing `}` at line 295):

```typescript
/**
 * Per-codeDigest network-truth reward aggregate (issue #764). One row per
 * distinct executor.codeDigest, joining attemptEnvelopeMeta (codeDigest, mode)
 * to verdictEnvelopeMeta (actualPassed, actualScore) on (requestId, chainId).
 * `actualPassed` is the source of truth (NOT the on-chain verdictCode, which
 * defaults to Pass — see verdictEnvelopeMeta JSDoc).
 */
export interface CodeDigestRewardRow {
  /** The executor.codeDigest, e.g. "sha256:<hex>". */
  codeDigest: string;
  /** Count of distinct (requestId, chainId) attempts with a verdict, mode='train'. */
  attempts: number;
  /** Count where verdictEnvelopeMeta.actualPassed === true. */
  passes: number;
  /** passes / attempts; 0 when attempts === 0. */
  passRate: number;
  /** Mean of numeric actualScore over verdicts that carried one; 0 when none. */
  avgScore: number;
}
```

Inside `DiscoveryAPI`:

```typescript
  /**
   * Returns per-codeDigest reward aggregates (#764) for the given codeDigests,
   * scoped to mode='train'. Joins attemptEnvelopeMeta (codeDigest) to
   * verdictEnvelopeMeta (actualPassed, actualScore) on (requestId, chainId).
   * When `operator` is provided, further restricts to attempts the operator
   * claimed (via the `attempt` table, joined on requestId).
   *
   * Like getInstanceSuccessCounts (#669), this throws DiscoveryUnavailableError
   * on a degraded backing and MUST NOT silently fall through to the on-chain
   * floor (substrate-incident policy) — the floor returns an empty array and
   * withFallback never routes this method to it. A codeDigest with zero indexed
   * attempts is simply absent from the result (callers treat absence as
   * "insufficient samples", not pass-rate zero).
   *
   * Rides PR #783's attemptEnvelopeMeta.codeDigest index.
   */
  getCodeDigestRewards(args: {
    codeDigests: string[];
    operator?: `0x${string}`;
    solverNetManifestCid?: string;
  }): Promise<CodeDigestRewardRow[]>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/types.codedigest-reward.test.ts && cd client && yarn typecheck`
Expected: test PASS; typecheck will now FAIL in `onchain.ts`/`http.ts`/`with-fallback.ts` (interface not yet implemented) — that's expected and fixed in Tasks 5–7. Confirm the *test file itself* compiles/passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/discovery/types.ts client/test/discovery/types.codedigest-reward.test.ts
git commit -m "feat(discovery): declare getCodeDigestRewards + CodeDigestRewardRow (#764)"
```

---

## Task 5: `getCodeDigestRewards` — HTTP (Ponder GraphQL) implementation

**Files:**
- Modify: `client/src/discovery/http.ts`
- Test: `client/test/discovery/http.codedigest-rewards.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `client/test/discovery/http.codedigest-rewards.test.ts` (mirror helpers from `http.test.ts` — copy `isReadyProbe`, `BASE_URL`, and a route-aware mock):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

const BASE_URL = 'http://localhost:42069';
const isReadyProbe = (url: string) => url.endsWith('/ready');

/** Route by GraphQL operation name found in the query body. */
function routedFetch(routes: {
  attemptMeta?: unknown;
  verdictMeta?: unknown;
  attempts?: unknown;
  throwOn?: 'attemptMeta' | 'verdictMeta';
}) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (isReadyProbe(url)) return new Response(null, { status: 200 });
    const body = JSON.parse(init!.body as string) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    const pick = (key: 'attemptMeta' | 'verdictMeta'): unknown =>
      routes.throwOn === key ? null : routes[key];
    if (body.query.includes('attemptEnvelopeMetas')) {
      if (routes.throwOn === 'attemptMeta') return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(pick('attemptMeta')), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body.query.includes('verdictEnvelopeMetas')) {
      if (routes.throwOn === 'verdictMeta') return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(pick('verdictMeta')), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // attempts query (operator scoping)
    return new Response(JSON.stringify(routes.attempts), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { impl, calls };
}

describe('getCodeDigestRewards', () => {
  it('aggregates passRate and avgScore per codeDigest from joined meta rows', async () => {
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x2', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x3', chainId: 8453, codeDigest: 'sha256:A' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0x2', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0x3', chainId: 8453, actualPassed: true, actualScore: '0.5' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.codeDigest).toBe('sha256:A');
    expect(a.attempts).toBe(3);
    expect(a.passes).toBe(2);
    expect(a.passRate).toBeCloseTo(2 / 3);
    expect(a.avgScore).toBeCloseTo((1.0 + 0.0 + 0.5) / 3);
  });

  it('omits a requested codeDigest that has no indexed attempts', async () => {
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:missing'] });
    expect(rows).toEqual([]);
  });

  it('scopes mode=train in the attempt-meta query', async () => {
    const { impl, calls } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    const attemptCall = calls.find((c) => c.query.includes('attemptEnvelopeMetas'));
    expect(JSON.stringify(attemptCall)).toContain('train');
  });

  it('propagates DiscoveryUnavailableError when the indexer errors (no swallow)', async () => {
    const { impl } = routedFetch({ throwOn: 'attemptMeta' });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.getCodeDigestRewards({ codeDigests: ['sha256:A'] }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('returns [] for empty codeDigests without hitting the network', async () => {
    const { impl } = routedFetch({});
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: [] });
    expect(rows).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/http.codedigest-rewards.test.ts`
Expected: FAIL — `getCodeDigestRewards` is not a function on the http client.

- [ ] **Step 3: Implement the http method**

In `client/src/discovery/http.ts`, add the GraphQL queries (near `INSTANCE_SUCCESS_COUNTS_QUERY`), page-response interfaces (near `InstanceSuccessCountsPage`), the function (near `getInstanceSuccessCounts`), and add it to the returned object. Use the `codeDigest_in` filter on attemptEnvelopeMeta and `requestId_in` on verdictEnvelopeMeta. If Ponder's `_in` operator is unavailable for a column, page per-codeDigest instead — verify the operator name against the indexer's generated schema before finalizing (it exposes array `_in` filters per the schema's array-filter note at `ponder.schema.ts:381`).

```typescript
const CODEDIGEST_ATTEMPTS_QUERY = `
query CodeDigestAttempts($codeDigests: [String!]!, $limit: Int!, $after: String) {
  attemptEnvelopeMetas(
    where: { codeDigest_in: $codeDigests, mode: "train", enrichmentStatus: "ok" },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "desc"
  ) {
    items { requestId chainId codeDigest }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const CODEDIGEST_VERDICTS_QUERY = `
query CodeDigestVerdicts($requestIds: [String!]!, $limit: Int!, $after: String) {
  verdictEnvelopeMetas(
    where: { requestId_in: $requestIds },
    limit: $limit,
    after: $after,
    orderBy: "requestId",
    orderDirection: "asc"
  ) {
    items { requestId chainId actualPassed actualScore }
    pageInfo { hasNextPage endCursor }
  }
}
`;

// Optional operator scoping: restrict attempts to those the operator claimed.
const CODEDIGEST_OPERATOR_ATTEMPTS_QUERY = `
query CodeDigestOperatorAttempts($requestIds: [String!]!, $operator: String!, $limit: Int!, $after: String) {
  attempts(
    where: { requestId_in: $requestIds, operator: $operator },
    limit: $limit,
    after: $after,
    orderBy: "createdAtBlock",
    orderDirection: "asc"
  ) {
    items { requestId chainId }
    pageInfo { hasNextPage endCursor }
  }
}
`;

interface CodeDigestAttemptsPage {
  attemptEnvelopeMetas: {
    items: Array<{ requestId: string; chainId: number; codeDigest: string }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}
interface CodeDigestVerdictsPage {
  verdictEnvelopeMetas: {
    items: Array<{ requestId: string; chainId: number; actualPassed: boolean; actualScore: string }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}
interface CodeDigestOperatorAttemptsPage {
  attempts: {
    items: Array<{ requestId: string; chainId: number }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}
```

Function (place near `getInstanceSuccessCounts`, before the `return { ... }`):

```typescript
  async function getCodeDigestRewards(args: {
    codeDigests: string[];
    operator?: `0x${string}`;
    solverNetManifestCid?: string;
  }): Promise<CodeDigestRewardRow[]> {
    if (args.codeDigests.length === 0) return [];
    await ensureReady();

    const MAX_PAGES = 20;
    const PAGE_LIMIT = 1000;

    // 1) Pull all train-mode attempt-meta rows for the requested codeDigests.
    const requestKeyToDigest = new Map<string, string>(); // "requestId|chainId" -> codeDigest
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await postGql<CodeDigestAttemptsPage>(
        gqlUrl, fetchImpl, CODEDIGEST_ATTEMPTS_QUERY,
        { codeDigests: args.codeDigests, limit: PAGE_LIMIT, after: cursor },
      );
      for (const row of data.attemptEnvelopeMetas?.items ?? []) {
        requestKeyToDigest.set(`${row.requestId}|${row.chainId}`, row.codeDigest);
      }
      const pi = data.attemptEnvelopeMetas?.pageInfo;
      if (!pi?.hasNextPage || !pi.endCursor) break;
      cursor = pi.endCursor;
    }
    if (requestKeyToDigest.size === 0) return [];

    // 2) Optional operator scoping: keep only requests the operator claimed.
    let allowedKeys: Set<string> | null = null;
    if (args.operator) {
      allowedKeys = new Set<string>();
      const reqIds = [...new Set([...requestKeyToDigest.keys()].map((k) => k.split('|')[0]!))];
      cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await postGql<CodeDigestOperatorAttemptsPage>(
          gqlUrl, fetchImpl, CODEDIGEST_OPERATOR_ATTEMPTS_QUERY,
          { requestIds: reqIds, operator: args.operator, limit: PAGE_LIMIT, after: cursor },
        );
        for (const row of data.attempts?.items ?? []) allowedKeys.add(`${row.requestId}|${row.chainId}`);
        const pi = data.attempts?.pageInfo;
        if (!pi?.hasNextPage || !pi.endCursor) break;
        cursor = pi.endCursor;
      }
    }

    // 3) Pull verdict-meta rows for those requestIds (actualPassed/actualScore).
    const verdictByKey = new Map<string, { passed: boolean; score: number | null }>();
    const requestIds = [...new Set([...requestKeyToDigest.keys()].map((k) => k.split('|')[0]!))];
    cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await postGql<CodeDigestVerdictsPage>(
        gqlUrl, fetchImpl, CODEDIGEST_VERDICTS_QUERY,
        { requestIds, limit: PAGE_LIMIT, after: cursor },
      );
      for (const row of data.verdictEnvelopeMetas?.items ?? []) {
        const key = `${row.requestId}|${row.chainId}`;
        const scoreNum = Number(row.actualScore);
        verdictByKey.set(key, { passed: Boolean(row.actualPassed), score: Number.isFinite(scoreNum) && row.actualScore !== '' ? scoreNum : null });
      }
      const pi = data.verdictEnvelopeMetas?.pageInfo;
      if (!pi?.hasNextPage || !pi.endCursor) break;
      cursor = pi.endCursor;
    }

    // 4) Aggregate per codeDigest (only requests that HAVE a verdict count).
    const agg = new Map<string, { attempts: number; passes: number; scoreSum: number; scoreN: number }>();
    for (const [key, digest] of requestKeyToDigest) {
      if (allowedKeys && !allowedKeys.has(key)) continue;
      const v = verdictByKey.get(key);
      if (!v) continue; // no verdict yet — not a completed attempt
      const cur = agg.get(digest) ?? { attempts: 0, passes: 0, scoreSum: 0, scoreN: 0 };
      cur.attempts += 1;
      if (v.passed) cur.passes += 1;
      if (v.score !== null) { cur.scoreSum += v.score; cur.scoreN += 1; }
      agg.set(digest, cur);
    }

    const rows: CodeDigestRewardRow[] = [];
    for (const [codeDigest, a] of agg) {
      rows.push({
        codeDigest,
        attempts: a.attempts,
        passes: a.passes,
        passRate: a.attempts > 0 ? a.passes / a.attempts : 0,
        avgScore: a.scoreN > 0 ? a.scoreSum / a.scoreN : 0,
      });
    }
    return rows;
  }
```

Add `getCodeDigestRewards,` to the returned object literal, and add `CodeDigestRewardRow` to the existing `./types.js` import at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/http.codedigest-rewards.test.ts`
Expected: PASS (all 5 cases). If the `_in` filter operator name differs in the generated schema, adjust the query and re-run.

- [ ] **Step 5: Commit**

```bash
git add client/src/discovery/http.ts client/test/discovery/http.codedigest-rewards.test.ts
git commit -m "feat(discovery): http getCodeDigestRewards joining attempt+verdict meta (#764)"
```

---

## Task 6: `getCodeDigestRewards` — onchain floor stub

**Files:**
- Modify: `client/src/discovery/onchain.ts`
- Test: `client/test/discovery/onchain.codedigest-rewards.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `client/test/discovery/onchain.codedigest-rewards.test.ts`. Mirror the construction used in `client/test/discovery/onchain.test.ts` (read it for the exact factory + minimal deps), then:

```typescript
// ...construct the onchain API exactly as onchain.test.ts does (copy its setup)...
it('returns an empty array (floor cannot reconstruct IPFS-enriched aggregates)', async () => {
  const rows = await api.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
  expect(rows).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/onchain.codedigest-rewards.test.ts`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement the stub**

In `client/src/discovery/onchain.ts`, beside `getInstanceSuccessCounts` (line ~1286):

```typescript
  // ── getCodeDigestRewards (#764) — empty-array stub ─────────────────────────
  // Per-codeDigest aggregates derive from the indexer's IPFS enrichment
  // (attempt/verdict envelope meta), which the on-chain floor cannot
  // reconstruct. withFallback never routes here (no silent fall-through).
  async function getCodeDigestRewards(): Promise<CodeDigestRewardRow[]> {
    return [];
  }
```

Add `getCodeDigestRewards,` to the returned object and import `CodeDigestRewardRow` from `./types.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/onchain.codedigest-rewards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/discovery/onchain.ts client/test/discovery/onchain.codedigest-rewards.test.ts
git commit -m "feat(discovery): onchain floor stub for getCodeDigestRewards (#764)"
```

---

## Task 7: `getCodeDigestRewards` — withFallback no-fallthrough wiring

**Files:**
- Modify: `client/src/discovery/with-fallback.ts`
- Test: `client/test/discovery/with-fallback.codedigest-rewards.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `client/test/discovery/with-fallback.codedigest-rewards.test.ts`. Read `client/test/discovery/with-fallback.test.ts` for how it builds `primary`/`floor` stubs (it constructs partial DiscoveryAPI doubles), then:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { withFallback } from '../../src/discovery/with-fallback.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

function api(over: Partial<Record<string, unknown>>) {
  // Build a minimal DiscoveryAPI double — copy the helper shape used in
  // with-fallback.test.ts so every method exists; override what we test.
  return { /* ...all methods stubbed... */, ...over } as any;
}

describe('withFallback.getCodeDigestRewards', () => {
  it('uses primary on success', async () => {
    const primary = api({ getCodeDigestRewards: vi.fn(async () => [{ codeDigest: 'sha256:A', attempts: 1, passes: 1, passRate: 1, avgScore: 1 }]) });
    const floor = api({ getCodeDigestRewards: vi.fn(async () => []) });
    const wrapped = withFallback(primary, floor /* , deps as in existing test */);
    const rows = await wrapped.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    expect(rows).toHaveLength(1);
    expect(floor.getCodeDigestRewards).not.toHaveBeenCalled();
  });

  it('propagates DiscoveryUnavailableError (never falls through to floor)', async () => {
    const primary = api({ getCodeDigestRewards: vi.fn(async () => { throw new DiscoveryUnavailableError('down'); }) });
    const floor = api({ getCodeDigestRewards: vi.fn(async () => [{ codeDigest: 'x', attempts: 9, passes: 9, passRate: 1, avgScore: 1 }]) });
    const wrapped = withFallback(primary, floor /* , deps */);
    await expect(wrapped.getCodeDigestRewards({ codeDigests: ['x'] })).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    expect(floor.getCodeDigestRewards).not.toHaveBeenCalled();
  });
});
```

Match the actual `withFallback` signature/deps from `with-fallback.test.ts` (it may take a third deps arg for health tracking).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/with-fallback.codedigest-rewards.test.ts`
Expected: FAIL — method missing on the wrapped object.

- [ ] **Step 3: Implement the wiring**

In `client/src/discovery/with-fallback.ts`, beside `getInstanceSuccessCounts` (line 247), add:

```typescript
    getCodeDigestRewards(args) {
      // Never fall through to the floor — an empty array from the floor is
      // indistinguishable from "no successes", the exact failure mode #764's
      // revert logic must avoid. Propagate the error so the Consolidator skips
      // reverts on degraded data (substrate-incident policy; mirrors #669).
      return primary.getCodeDigestRewards(args);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/with-fallback.codedigest-rewards.test.ts && cd client && yarn typecheck`
Expected: test PASS; `yarn typecheck` now passes (all three DiscoveryAPI implementations satisfy the interface).

- [ ] **Step 5: Commit**

```bash
git add client/src/discovery/with-fallback.ts client/test/discovery/with-fallback.codedigest-rewards.test.ts
git commit -m "feat(discovery): withFallback no-fallthrough for getCodeDigestRewards (#764)"
```

---

## Task 8: `jinn codedigest-revert-check` CLI subcommand (the Consolidator's reach into the logic)

This is the surface the Consolidator (Bash-only) actually invokes. It takes a candidate commit's codeDigest and its parent's codeDigest, queries the indexer, applies `decideRevert`, and emits the structured decision as JSON.

**Files:**
- Create: `client/src/cli/commands/codedigest-revert-check.ts`
- Modify: `client/src/cli/index.ts`
- Test: `client/test/cli/codedigest-revert-check.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/codedigest-revert-check.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createCodedigestRevertCheckCommand } from '../../src/cli/commands/codedigest-revert-check.js';

function ctx(argv: string[]) {
  const out: string[] = [];
  return {
    ctx: { argv, stdoutIsTty: false, writer: { write: (s: string) => { out.push(s); return true; } }, exit: vi.fn(), env: {} },
    out,
  };
}

describe('jinn codedigest-revert-check', () => {
  it('emits recommendRevert=true for a significant regression', async () => {
    const cmd = createCodedigestRevertCheckCommand({
      buildDiscovery: () => ({
        getCodeDigestRewards: async () => [
          { codeDigest: 'sha256:CHILD', attempts: 100, passes: 40, passRate: 0.4, avgScore: 0.4 },
          { codeDigest: 'sha256:PARENT', attempts: 100, passes: 80, passRate: 0.8, avgScore: 0.8 },
        ],
      }) as any,
    });
    const { ctx: c, out } = ctx(['--code-digest', 'sha256:CHILD', '--parent-code-digest', 'sha256:PARENT', '--json']);
    await cmd.run(c as any);
    const payload = JSON.parse(out.join(''));
    expect(payload.recommendRevert).toBe(true);
    expect(payload.reason).toBe('significant_regression');
  });

  it('emits recommendRevert=false reason=insufficient_samples when a digest has no aggregate', async () => {
    const cmd = createCodedigestRevertCheckCommand({
      buildDiscovery: () => ({
        getCodeDigestRewards: async () => [
          { codeDigest: 'sha256:PARENT', attempts: 100, passes: 80, passRate: 0.8, avgScore: 0.8 },
        ], // CHILD absent => zero attempts
      }) as any,
    });
    const { ctx: c, out } = ctx(['--code-digest', 'sha256:CHILD', '--parent-code-digest', 'sha256:PARENT', '--json']);
    await cmd.run(c as any);
    const payload = JSON.parse(out.join(''));
    expect(payload.recommendRevert).toBe(false);
    expect(payload.reason).toBe('insufficient_samples');
  });

  it('emits recommendRevert=false on DiscoveryUnavailableError (skip reverts on degraded data)', async () => {
    const { DiscoveryUnavailableError } = await import('../../src/discovery/types.js');
    const cmd = createCodedigestRevertCheckCommand({
      buildDiscovery: () => ({ getCodeDigestRewards: async () => { throw new DiscoveryUnavailableError('down'); } }) as any,
    });
    const { ctx: c, out } = ctx(['--code-digest', 'sha256:CHILD', '--parent-code-digest', 'sha256:PARENT', '--json']);
    await cmd.run(c as any);
    const payload = JSON.parse(out.join(''));
    expect(payload.recommendRevert).toBe(false);
    expect(payload.reason).toBe('discovery_unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/cli/codedigest-revert-check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

Create `client/src/cli/commands/codedigest-revert-check.ts` (mirror `rewards.ts` structure — factory + `PRODUCTION_DEPS` + `parseArgs`). Read `client/src/cli/introspection-context.ts` / `client/src/discovery/factory.ts` to wire `buildDiscovery` from the resolved config in production.

```typescript
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { createDiscoveryAPI } from '../../discovery/factory.js';
import type { DiscoveryAPI } from '../../discovery/types.js';
import { DiscoveryUnavailableError } from '../../discovery/types.js';
import {
  decideRevert, resolveRevertPolicy, type CodeDigestAggregate, type RevertPolicy,
} from '../../learner/revert-decision.js';

export interface CodedigestRevertCheckDeps {
  buildDiscovery: (configPath?: string) => DiscoveryAPI;
}

const PRODUCTION_DEPS: CodedigestRevertCheckDeps = {
  buildDiscovery: (configPath) => {
    const config = loadConfig(configPath);
    // Build deps from config exactly as the daemon does — read
    // introspection-context.ts for the canonical wiring and reuse it.
    return createDiscoveryAPI(config.discovery ?? { mode: 'onchain' }, /* deps from config */ {} as never);
  },
};

function toAggregate(codeDigest: string, rows: Array<{ codeDigest: string; attempts: number; passes: number; passRate: number }>): CodeDigestAggregate {
  const found = rows.find((r) => r.codeDigest === codeDigest);
  if (!found) return { codeDigest, attempts: 0, passes: 0, passRate: 0 };
  return { codeDigest, attempts: found.attempts, passes: found.passes, passRate: found.passRate };
}

export function createCodedigestRevertCheckCommand(deps: CodedigestRevertCheckDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'codedigest-revert-check',
    summary: 'Decide whether an Improve commit regressed the pass rate (per-codeDigest, #764)',
    helpText: `Usage: jinn codedigest-revert-check --code-digest <sha256:...> --parent-code-digest <sha256:...> [--operator 0x..] [--solvernet <cid>] [--min-samples N] [--alpha A] [--window N] [--json]

Emits a JSON decision: { withCommit, atParent, delta, pValue, significant, recommendRevert, reason }.
On indexer outage emits recommendRevert=false reason=discovery_unavailable (the Consolidator then skips reverts).`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            'code-digest': { type: 'string' },
            'parent-code-digest': { type: 'string' },
            operator: { type: 'string' },
            solvernet: { type: 'string' },
            'min-samples': { type: 'string' },
            alpha: { type: 'string' },
            window: { type: 'string' },
            config: { type: 'string' },
            json: { type: 'boolean', default: true },
          },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope({ code: 'invalid_invocation', message: err instanceof Error ? err.message : String(err), exampleCli: 'jinn codedigest-revert-check --code-digest sha256:.. --parent-code-digest sha256:..', details: { field: 'flags' } }, { writer: ctx.writer, exit: ctx.exit });
        return;
      }
      const child = parsed.values['code-digest'];
      const parent = parsed.values['parent-code-digest'];
      if (!child || !parent) {
        emitEnvelope({ code: 'invalid_invocation', message: '--code-digest and --parent-code-digest are required', exampleCli: 'jinn codedigest-revert-check --code-digest sha256:.. --parent-code-digest sha256:..', details: { field: 'flags' } }, { writer: ctx.writer, exit: ctx.exit });
        return;
      }
      const policy: RevertPolicy = resolveRevertPolicy({
        ...(parsed.values['min-samples'] ? { minSamplesPerArm: Number(parsed.values['min-samples']) } : {}),
        ...(parsed.values.alpha ? { alpha: Number(parsed.values.alpha) } : {}),
        ...(parsed.values.window ? { recentAttemptsWindow: Number(parsed.values.window) } : {}),
      });

      const discovery = deps.buildDiscovery(parsed.values.config);
      let rows;
      try {
        rows = await discovery.getCodeDigestRewards({
          codeDigests: [child, parent],
          ...(parsed.values.operator ? { operator: parsed.values.operator as `0x${string}` } : {}),
          ...(parsed.values.solvernet ? { solverNetManifestCid: parsed.values.solvernet } : {}),
        });
      } catch (err) {
        if (err instanceof DiscoveryUnavailableError) {
          ctx.writer.write(JSON.stringify({ recommendRevert: false, reason: 'discovery_unavailable', message: err.message }) + '\n');
          return;
        }
        throw err;
      }

      const decision = decideRevert({ withCommit: toAggregate(child, rows), atParent: toAggregate(parent, rows) }, policy);
      ctx.writer.write(JSON.stringify(decision) + '\n');
    },
  };
}

const command: CommandModule = createCodedigestRevertCheckCommand();
export default command;
```

Note: the `PRODUCTION_DEPS.buildDiscovery` wiring (`createDiscoveryAPI` deps) must be completed by reading `client/src/cli/introspection-context.ts` for how the daemon constructs `DiscoveryFactoryDeps` (rpcUrl/chainId/addresses/fetchImpl) from `JinnConfig`; reuse that helper rather than re-deriving. Tests inject `buildDiscovery`, so production wiring is not under test here.

Then register in `client/src/cli/index.ts`: add `import codedigestRevertCheckCommand from './commands/codedigest-revert-check.js';` and push it into the `COMMANDS` array.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/cli/codedigest-revert-check.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/codedigest-revert-check.ts client/src/cli/index.ts client/test/cli/codedigest-revert-check.test.ts
git commit -m "feat(cli): codedigest-revert-check subcommand for the Consolidator (#764)"
```

---

## Task 9: `get_codedigest_reward` MCP tool (parity surface)

**Files:**
- Modify: `client/src/mcp/server.ts`
- Test: `client/test/mcp/codedigest-reward.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Read `client/test/mcp/operator-server.test.ts` for how MCP tools are invoked under test in this repo (it exercises a registered tool's handler). Create `client/test/mcp/codedigest-reward.test.ts` mirroring that pattern, asserting: (a) the handler returns the aggregated rows as JSON `content`; (b) on `DiscoveryUnavailableError` it returns a structured `{ ok: false, error: { kind: 'discovery_unavailable' } }`; (c) with no discovery configured it returns a structured "no discovery" error rather than throwing.

If `operator-server.test.ts` shows the server is not easily unit-invokable, extract the handler into a small exported `handleGetCodeDigestReward(discovery, args)` function in a sibling file (`client/src/mcp/get-codedigest-reward.ts`) and unit-test that pure handler directly (preferred — matches the `handleSearchRecords`/`handleAcquireArtifact` extraction pattern already used in server.ts imports).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/mcp/codedigest-reward.test.ts`
Expected: FAIL — handler/module missing.

- [ ] **Step 3: Implement the tool**

Following the existing extracted-handler pattern (`./search-records.js`, `./acquire-artifact.js`), create `client/src/mcp/get-codedigest-reward.ts`:

```typescript
import type { DiscoveryAPI } from '../discovery/types.js';
import { DiscoveryUnavailableError } from '../discovery/types.js';

export async function handleGetCodeDigestReward(
  discovery: DiscoveryAPI | null,
  args: { codeDigests: string[]; operator?: `0x${string}`; solverNetManifestCid?: string },
): Promise<Record<string, unknown>> {
  if (!discovery) return { ok: false, error: { kind: 'no_discovery', message: 'discovery not configured' }, rows: [] };
  try {
    const rows = await discovery.getCodeDigestRewards(args);
    return { ok: true, rows };
  } catch (err) {
    if (err instanceof DiscoveryUnavailableError) {
      return { ok: false, error: { kind: 'discovery_unavailable', message: err.message }, rows: [] };
    }
    throw err;
  }
}
```

In `client/src/mcp/server.ts`: (1) build a `discovery` handle at server scope — refactor `buildReadOnlyCorpus` so the `discovery` instance it constructs is also returned/hoisted (it currently only lives inside that function; lift it to a module-level `const discoveryForTools = hasDiscovery ? createHttpDiscoveryAPI({...}) : null`, reusing the same `discoveryUrl`/`discoveryMode` env reads at lines 81-99). (2) Register the tool mirroring the `search_records` registration shape (around line 370):

```typescript
server.tool(
  'get_codedigest_reward',
  'Network-truth pass-rate and average-score aggregates per executor codeDigest, from the indexer (verdictEnvelopeMeta.actualPassed is the source of truth). Use during Memory consolidation to compare a candidate Improve commit\'s codeDigest against its parent\'s before deciding to revert. Read-only; throws if the indexer is unavailable (do not revert on degraded data).',
  {
    codeDigests: z.array(z.string()).min(1).describe('Executor codeDigests, e.g. ["sha256:abc", "sha256:def"]'),
    operator: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe('Restrict to attempts this operator Safe claimed'),
    solverNetManifestCid: z.string().optional().describe('Optional SolverNet manifest CID scope'),
  },
  async (args) => {
    const out = await handleGetCodeDigestReward(discoveryForTools, args as { codeDigests: string[]; operator?: `0x${string}`; solverNetManifestCid?: string });
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  },
);
```

Add the import: `import { handleGetCodeDigestReward } from './get-codedigest-reward.js';`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/mcp/codedigest-reward.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/mcp/get-codedigest-reward.ts client/src/mcp/server.ts client/test/mcp/codedigest-reward.test.ts
git commit -m "feat(mcp): get_codedigest_reward tool surface for per-digest aggregates (#764)"
```

---

## Task 10: Synthetic git-history fixture test (AC5)

Proves the end-to-end revert selection: walk a synthetic `implStateDir` git history of Improve commits, map each commit to a codeDigest with the REAL freeze hasher, feed seeded aggregates through `decideRevert`, and assert exactly the significantly-worse commit is selected for revert while the under-threshold one is not.

**Files:**
- Create: `client/test/learner/revert-decision.git-fixture.test.ts`

- [ ] **Step 1: Write the test (this IS the deliverable for AC5)**

Create `client/test/learner/revert-decision.git-fixture.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import { decideRevert, DEFAULT_REVERT_POLICY, type CodeDigestAggregate } from '../../src/learner/revert-decision.js';

const IGNORE = ['.git'] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Export a commit's tree (no .git) and hash it the way production does. */
async function codeDigestAt(repoDir: string, sha: string): Promise<string> {
  const exportDir = await mkdtemp(join(tmpdir(), 'cd-export-'));
  // `git archive <sha> | tar -x -C exportDir` — tree only, no .git.
  const tar = execFileSync('git', ['archive', sha], { cwd: repoDir, maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', exportDir], { input: tar });
  const hex = await hashImplStateDir(exportDir, { ignoreRelPaths: IGNORE });
  await rm(exportDir, { recursive: true, force: true });
  return `sha256:${hex}`;
}

describe('per-codeDigest revert selection over a synthetic git history (#764 AC5)', () => {
  it('reverts the significantly-worse commit and leaves the under-threshold one', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'implstate-'));
    try {
      git(repo, 'init', '--initial-branch=main', '--quiet');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'config', 'user.name', 'test');

      // init commit
      await mkdir(join(repo, 'skills'), { recursive: true });
      await writeFile(join(repo, 'skills', 'base.md'), 'base', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'init');
      const c0 = git(repo, 'rev-parse', 'HEAD');

      // Improve commit 1 — will be the BIG regression (revert this)
      await writeFile(join(repo, 'skills', 'a.md'), 'change-a', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'improve: a');
      const c1 = git(repo, 'rev-parse', 'HEAD');

      // Improve commit 2 — slightly worse but under significance (do NOT revert)
      await writeFile(join(repo, 'skills', 'b.md'), 'change-b', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'improve: b');
      const c2 = git(repo, 'rev-parse', 'HEAD');

      // Distinct codeDigests per commit (real hasher).
      const [d0, d1, d2] = await Promise.all([codeDigestAt(repo, c0), codeDigestAt(repo, c1), codeDigestAt(repo, c2)]);
      expect(new Set([d0, d1, d2]).size).toBe(3);

      // Seeded aggregates: c1-with-commit is much worse than its parent c0;
      // c2-with-commit is marginally worse than its parent c1 (not significant).
      const seeded: Record<string, CodeDigestAggregate> = {
        [d0]: { codeDigest: d0, attempts: 100, passes: 85, passRate: 0.85 },
        [d1]: { codeDigest: d1, attempts: 100, passes: 45, passRate: 0.45 }, // big drop vs d0
        [d2]: { codeDigest: d2, attempts: 100, passes: 42, passRate: 0.42 }, // ~same as d1
      };

      const decideForCommit = (childDigest: string, parentDigest: string) =>
        decideRevert({ withCommit: seeded[childDigest]!, atParent: seeded[parentDigest]! }, DEFAULT_REVERT_POLICY);

      const toRevert: string[] = [];
      for (const { sha, child, parent } of [
        { sha: c1, child: d1, parent: d0 },
        { sha: c2, child: d2, parent: d1 },
      ]) {
        if (decideForCommit(child, parent).recommendRevert) toRevert.push(sha);
      }

      expect(toRevert).toEqual([c1]); // only the significant regression
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd client && yarn vitest run test/learner/revert-decision.git-fixture.test.ts`
Expected: PASS — `toRevert` equals `[c1]` only. (If `git archive`/`tar` are unavailable in the CI sandbox, gate with a skip-if-no-git guard mirroring any existing git-dependent test in `client/test/`; the assertion logic stays the same.)

- [ ] **Step 3: Commit**

```bash
git add client/test/learner/revert-decision.git-fixture.test.ts
git commit -m "test(learner): synthetic git-history fixture for per-codeDigest revert selection (#764 AC5)"
```

---

## Task 11: Update the Consolidator prompt (decision logic & invocation documented — AC4)

**Files:**
- Modify: `client/plugins/learner/skills/learn/consolidator-prompt.md`

- [ ] **Step 1: Edit the "Regressed promotions" bullet and add a quantitative-trigger subsection**

Replace the single "Regressed promotions" bullet (line 19) so it documents BOTH triggers and the exact procedure. The new content must state:

1. **Qualitative trigger (existing):** the Debrief/`analysisPath` trend signal — unchanged.
2. **Quantitative trigger (new, #764):** for each candidate Improve commit on recent `implStateDir` git history (the commits since `implStateDirShaBefore`, identified from `improvePromotionsDir/<n>.json` `implStateDirShaAfter`):
   - Compute the commit's codeDigest and its parent's codeDigest by exporting each tree without `.git` and hashing with the same deterministic hasher production uses. Documented commands (Consolidator has Bash):
     ```bash
     codedigest_at() {  # $1 = sha
       d=$(mktemp -d)
       git archive "$1" | tar -x -C "$d"
       # hash matches client/src/harnesses/freeze.ts (sha256 over sorted "<relpath>:<filehash>")
       node "$JINN_BIN/codedigest-hash.js" "$d"   # or: jinn-internal helper; see note
       rm -rf "$d"
     }
     ```
     Note for the implementer: provide the hashing to the prompt via the CLI — the cleanest is to have `jinn codedigest-revert-check` accept `--impl-state-dir <path> --commit <sha> --parent <sha>` and do the `git archive`+hash internally (so the prompt does not reimplement the hasher). If you add those flags, document THOSE instead of a raw node call. Either way the prompt must NOT hand-roll the hash.
   - Call the decision tool:
     ```bash
     jinn codedigest-revert-check --code-digest <child> --parent-code-digest <parent> --json
     ```
   - Read the structured response `{ withCommit:{codeDigest,n,passRate}, atParent:{codeDigest,n,passRate}, delta, pValue, significant, recommendRevert, reason }` and act ONLY on `recommendRevert === true`. Do not re-derive the thresholds in the prompt.
   - On `reason: 'discovery_unavailable'` or `'insufficient_samples'`, **do not revert** (degraded data / expected plateau).
3. **Documented thresholds (mirror, do not redefine):** state that `min-samples=30 per arm`, `alpha=0.05` (95% confidence), `window=200` recent attempts are the canonical defaults encoded in `client/src/learner/revert-decision.ts` and overridable via `implStateDir/policy.json` `policy.revert.*`. The test used is a two-proportion z-test on pass/total (codeDigest-with-commit vs codeDigest-at-parent); revert fires only when `delta < 0 AND p < alpha AND both arms ≥ min-samples`.
4. The actual revert remains `git revert <implStateDirShaAfter>` for each selected commit (unchanged mechanism).

- [ ] **Step 2: Verify the prompt is internally consistent**

Re-read the edited bullet and the Output section. Ensure `promotionsReverted[].reason` in the output JSON can carry the decision's `reason` string. No code test for prose, but confirm the documented CLI flags exactly match what Task 8 implemented (`--code-digest`, `--parent-code-digest`, `--json`, plus any `--impl-state-dir/--commit/--parent` if you added them).

- [ ] **Step 3: Commit**

```bash
git add client/plugins/learner/skills/learn/consolidator-prompt.md
git commit -m "docs(learner): document quantitative per-codeDigest revert trigger in Consolidator (#764)"
```

---

## Task 12: Optional — `jinn codedigest-revert-check` self-hashes the tree (removes prompt-side hashing risk)

Only do this if Task 11 Step 1's note chose the CLI-self-hash path. It moves the `git archive`+hash into TS so the prompt never reimplements the hasher (the single largest correctness risk).

**Files:**
- Modify: `client/src/cli/commands/codedigest-revert-check.ts`
- Test: extend `client/test/cli/codedigest-revert-check.test.ts`

- [ ] **Step 1: Write the failing test**

Add a case that, given `--impl-state-dir <repo> --commit <sha> --parent <sha>` (a real temp git repo built in the test, as in Task 10), asserts the command computes two distinct codeDigests and calls the injected `getCodeDigestRewards` with exactly those two `sha256:` strings.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/cli/codedigest-revert-check.test.ts`
Expected: FAIL — flags not handled.

- [ ] **Step 3: Implement**

Add `'impl-state-dir'`, `commit`, `parent` string options. When present, compute child/parent digests via a small exported helper `codeDigestForCommit(implStateDir, sha)` (mirrors Task 10's `codeDigestAt`, importing `hashImplStateDir` with `ignoreRelPaths: ['.git']`), then proceed as before. Keep the explicit `--code-digest`/`--parent-code-digest` path for tests and manual use.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/cli/codedigest-revert-check.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/codedigest-revert-check.ts client/test/cli/codedigest-revert-check.test.ts
git commit -m "feat(cli): codedigest-revert-check can hash impl-state commits directly (#764)"
```

---

## Task 13: Full verification in the worktree

- [ ] **Step 1: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `cd client && yarn test`
Expected: all pass, including the new `test/learner/*`, `test/discovery/*codedigest*`, `test/cli/codedigest-revert-check`, `test/mcp/codedigest-reward`, and `test/harnesses/learner-freeze-ignore`.

- [ ] **Step 3: Build (compiles + bundles SPA, confirms CLI registration and MCP server build)**

Run: `cd client && yarn build`
Expected: success. Then smoke the CLI registration:
Run: `node dist/bin/jinn.js codedigest-revert-check --help`
Expected: prints the usage text (command is registered).

- [ ] **Step 4: Lint (if configured)**

Run: `cd client && yarn lint` (skip if no lint script).
Expected: clean.

- [ ] **Step 5: Final commit if any verification fixups were needed**

```bash
git add -A
git commit -m "chore(learner): verification fixups for per-codeDigest revert selection (#764)"
```

---

## Acceptance Criteria → Task Map

| # | Acceptance criterion | Satisfied by |
|---|----------------------|--------------|
| 1 | Memory-consolidation queries the indexer for per-(operator, codeDigest) aggregate `actualPassed`/`actualScore` over a configurable window of recent attempts | **Tasks 4–7** (`getCodeDigestRewards` across types/http/onchain/withFallback — joins `attemptEnvelopeMeta.codeDigest` + `verdictEnvelopeMeta.actualPassed/actualScore`, optional `operator` scope via `attempt`); **Task 8** (CLI exposes `--window`, default 200 from `DEFAULT_REVERT_POLICY.recentAttemptsWindow`, overridable via `policy.json`); **Task 11** (Consolidator invokes it) |
| 2 | For each candidate Improve commit on recent git history of `implStateDir`, compute a pass-rate delta between codeDigest-with-commit and codeDigest-at-parent | **Task 1** (makes commit→codeDigest reproducible by ignoring `.git`); **Task 3** (`decideRevert` computes `delta = pA − pB`); **Task 8/12** (CLI maps a commit + parent to codeDigests and computes the delta); **Task 10** (fixture walks the history per commit); **Task 11** (prompt drives the per-commit walk) |
| 3 | Reverts trigger only when (a) sample count ≥ documented minimum AND (b) pass-rate delta is statistically significant under a documented test | **Task 2** (two-proportion z-test, documented); **Task 3** (`minSamplesPerArm=30` gate + `alpha=0.05` significance gate; `insufficient_samples` / `not_significant` / `no_regression` reasons); covered by `revert-decision.test.ts` cases |
| 4 | Decision logic, window size, confidence threshold encoded explicitly (prompt or code), not magic constants | **Task 3** (`DEFAULT_REVERT_POLICY` named constants with JSDoc, `resolveRevertPolicy` for `policy.json` override); **Task 8** (CLI flags `--min-samples/--alpha/--window`); **Task 11** (prompt documents the same constants and the z-test, references the TS source rather than restating magic numbers) |
| 5 | A test fixture walks a synthetic git history with seeded verdicts and asserts the correct commits are reverted | **Task 10** (`revert-decision.git-fixture.test.ts` — 3 commits, distinct real codeDigests, seeded aggregates: one significant regression + one under-threshold; asserts `toRevert === [c1]`) |

---

## Self-Review Notes

- **Spec coverage:** all 5 ACs mapped above; the design note's MCP tool (Task 9), TS-located thresholds (Task 3), two-proportion z-test (Task 2), `getCodeDigestRewards` modeled on `getInstanceSuccessCounts` with no-fallthrough (Tasks 4–7), and the git fixture (Task 10) are all present.
- **Correction vs design note:** the note said codeDigest is "the content-hash of implStateDir … NOT the git sha" and to "hash the tree at each sha" — but the learner harness currently hashes `.git` too, so a naive checkout+hash would never match the indexer. **Task 1** fixes this prerequisite (ignore `.git`), and Tasks 10/12 hash via `git archive` (tree only, no `.git`) to match. This is the single most important correctness addition.
- **Correction vs design note:** the note assumed the Consolidator can call an MCP tool, but its frontmatter grants only `Bash`/filesystem tools. The plan therefore makes the **CLI subcommand** (Task 8) the Consolidator's actual reach into the logic, with the MCP tool (Task 9) as a parity surface. Both share the same `revert-decision.ts` core, so logic cannot drift.
- **Operator field:** `attemptEnvelopeMeta` has no `operator` column; per-(operator, codeDigest) scoping joins via the `attempt` table on `requestId` (Task 5, `CODEDIGEST_OPERATOR_ATTEMPTS_QUERY`). `operator` is optional so the common case (all operators) needs no extra query.
- **Type consistency:** `CodeDigestRewardRow` (codeDigest, attempts, passes, passRate, avgScore) is identical across types/http/onchain/withFallback/CLI/MCP. `RevertDecision` / `decideRevert` / `DEFAULT_REVERT_POLICY` / `CodeDigestAggregate` names are consistent across Tasks 3, 8, 10. CLI flags `--code-digest`, `--parent-code-digest`, `--json` match between Task 8 impl and Task 11 docs.
- **Open item to confirm at implementation time:** the exact Ponder filter operator for array membership (`codeDigest_in` / `requestId_in`). Verify against the indexer's generated GraphQL schema (the array-filter note is at `ponder.schema.ts:381`); fall back to per-codeDigest paging if `_in` is unavailable. Flagged in Task 5 Step 3.
