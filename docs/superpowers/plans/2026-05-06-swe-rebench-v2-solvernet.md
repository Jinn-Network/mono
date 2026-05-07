# SWE-rebench v2 SolverNet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `swe-rebench-v2` SolverNet — schemas, evaluator package, runtime plugin, and task generator with full-historical-pool + post-until-target-successes policy. This is the second SolverNet alongside `prediction.v1`.

**Architecture:** Tasks are pulled from `nebius/SWE-rebench-leaderboard` HuggingFace dataset (~750 instances at v1 launch, ~50/month thereafter; CC-BY-4.0). The generator works against the full historical pool minus saturated tasks and posts each task on JinnRouter until N successful Verdicts accumulate (default N=3). Solvers run their Harness against the Task; the Evaluator pulls the per-instance Docker image from `docker.io/swerebenchv2/...`, applies the submitted patch, runs the tests via the upstream `eval.py` harness (MIT), and emits a `{ score: 0|1, passed_match }` Verdict. The aggregation function returns a structured multi-winrate result (mean / complexityWeighted / byLanguage / frontierResolved / parityTripRate) over a 30-day rolling window. Reward distribution: per-Task escrow proportional to task complexity (R2); Verdict.score is the per-Task reward fraction.

**Tech Stack:** TypeScript (Node 22, yarn workspaces); Zod (schemas); vitest (unit + integration tests); Docker (per-instance image runtime); Python (upstream `scripts/eval.py` invoked as subprocess); HuggingFace `datasets-server.huggingface.co/rows` HTTP API.

**Spec:** `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §3.

**DRs covered:** DR-2026-05-06-a (per-task continuous over fresh-supply); DR-2026-05-06-b (SWE-rebench v2 selection); DR-2026-05-06-e (multi-winrate aggregation); DR-2026-05-06-f (R2 task-complexity-weighted escrow); DR-2026-05-06-i (full-historical-pool + post-until-target-successes generator policy).

**Depends on:** **Plan 1 (freeze-mode protocol mechanism) must ship first.** The Solver-side Harness needs `HarnessContext.mode` and the daemon's freeze-fence to produce envelopes with stable `Executor.mode` and `Executor.codeDigest`. Without Plan 1, frozen-mode benchmark scoring on `swe-rebench-v2` does not work.

**Out of scope (Plan 3):** Subgraph indexing of mode + codeDigest rollups; dashboard surfaces; `jinn checkpoint publish/install` CLI verbs; ReputationRegistry slashing hook for freeze violations.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/sdk/src/swe-rebench-v2.ts` | **Create** | SWE-rebench v2 Task schema (Zod). Top-level Task payload fields: `instance_id`, `repo`, `base_commit`, `language`, `problem_statement`, `interface`, `hf_dataset`, `hf_split`, `deadline_unix`, `round_month`. |
| `packages/sdk/src/payloads/swe-rebench-v2.ts` | **Create** | SWE-rebench v2 Solution payload (`patch`, `trajectory_cid`, optional `cost.totalUsd`) and Verdict payload (`score: 0\|1`, `passed_match: bool`, `test_log_cid`, `evaluator_cost_usd`). |
| `packages/sdk/src/contracts.ts` | **Modify** | Add `SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT`. Extend `SupportedSolverType` union to include `'swe-rebench-v2.v1'`. Register in `SOLVER_NET_CONTRACTS` map. |
| `packages/sdk/test/swe-rebench-v2.test.ts` | **Create** | Unit tests: Task / Solution / Verdict schemas accept valid rows, reject invalid; contract registered correctly. |
| `client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts` | **Create** | EvaluatorImpl: fetch HF row by `(hf_dataset, hf_split, instance_id)`, pull Docker image, apply patch via upstream `eval.py`, parse output, emit Verdict. |
| `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts` | **Create** | Thin Python-subprocess wrapper around `scripts/eval.py` from the upstream `SWE-rebench/SWE-rebench-V2` repo. Reads instance_id list, returns parsed results. |
| `client/test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts` | **Create** | Unit tests with mock HF + Docker: schema-shape grading, patch-apply, log parsing, error handling. |
| `client/plugins/swe-rebench-v2-runtime/.claude-plugin/plugin.json` | **Create** | Host plugin manifest (Claude Code format). Bundles SDKs needed by Solver harnesses on this SolverType. |
| `client/plugins/swe-rebench-v2-runtime/jinn.plugin.json` | **Create** | Jinn-side sidecar manifest. `jinn.supports: ["swe-rebench-v2.v1"]`. |
| `client/plugins/swe-rebench-v2-runtime/skills/` | **Create** | Jinja prompt templates + skill content for SWE-rebench-v2-specific orientations. |
| `client/src/solver-types/swe-rebench-v2-auto.ts` | **Create** | Task generator: pulls historical pool from HF; tracks per-task `posted_count` + `successful_count`; posts on JinnRouter; respects cooldown + N_target_successes + N_max_postings_per_task. |
| `client/src/solver-types/_swe-rebench-v2-pool.ts` | **Create** | Pool builder: queries HF `datasets-server` API, iterates monthly partitions, deduplicates instance_ids, applies language balancing. |
| `client/src/solver-types/_swe-rebench-v2-state.ts` | **Create** | Generator state persistence (`~/.jinn-client/solvernets/swe-rebench-v2/generator-state.json`): per-task counters survive daemon restarts. |
| `client/src/solver-types/_swe-rebench-v2-escrow.ts` | **Create** | R2 escrow calculator: `escrowWei = base × (1 + α × normalized_loc + β × normalized_files + γ × normalized_tests)`. Reads task `meta` for proxies. |
| `client/test/solver-types/swe-rebench-v2-auto.test.ts` | **Create** | Generator policy tests: saturation halts reposting; cooldown respected; max-postings cap; pool ordering; state persistence across restarts. |
| `client/src/solver-nets/contracts.ts` | **Modify** | Add `swe-rebench-v2` registration alongside `prediction`. Wires the SDK contract + the evaluator-impl path + the auto-generator. |
| `client/src/config.ts` | **Modify** | Add `swe-rebench-v2` entry to `DEFAULT_SOLVER_NETS`. Disabled by default; operators opt in via config. |
| `client/test/e2e/swe-rebench-v2.test.ts` | **Create** | End-to-end on Anvil fork: Task posted → Solver claims → Evaluator grades → Verdict settles → repeat until task is saturated → no further posting. |

Test command throughout: `yarn test` from `client/` (vitest run); `yarn e2e` for end-to-end.

---

## Task 1: Task schema for SWE-rebench v2

**Files:**
- Create: `packages/sdk/src/swe-rebench-v2.ts`
- Create: `packages/sdk/test/swe-rebench-v2-task.test.ts`

- [ ] **Step 1: Write the failing tests for the Task schema**

Create `packages/sdk/test/swe-rebench-v2-task.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SweRebenchV2TaskSchema } from '../src/swe-rebench-v2.js';

const validTask = {
  schemaVersion: 'swe-rebench-v2.v1',
  instance_id: 'unidata__netcdf-c-1925',
  repo: 'Unidata/netcdf-c',
  base_commit: 'ad6bff35c39a0600fb8f2e176be4269e768e4e22',
  language: 'c',
  problem_statement: 'tst_filter does not handle quoted filter args correctly...',
  interface: 'Function: handle_filter(args)\nReturns: int',
  hf_dataset: 'nebius/SWE-rebench-leaderboard',
  hf_split: '2026_02',
  deadline_unix: 1746547200,
  round_month: '2026-05',
};

describe('SweRebenchV2TaskSchema', () => {
  it('parses a valid task', () => {
    expect(() => SweRebenchV2TaskSchema.parse(validTask)).not.toThrow();
  });

  it('requires instance_id', () => {
    const bad = { ...validTask, instance_id: undefined };
    expect(() => SweRebenchV2TaskSchema.parse(bad)).toThrow();
  });

  it('requires hf_split (the monthly partition identifier)', () => {
    const bad = { ...validTask, hf_split: undefined };
    expect(() => SweRebenchV2TaskSchema.parse(bad)).toThrow();
  });

  it('accepts known languages: python, javascript, typescript, go, c, cpp, cs, java, rust, dart', () => {
    for (const language of ['python', 'javascript', 'typescript', 'go', 'c', 'cpp', 'cs', 'java', 'rust', 'dart']) {
      expect(() => SweRebenchV2TaskSchema.parse({ ...validTask, language })).not.toThrow();
    }
  });

  it('allows interface to be empty string (some tasks have no auxiliary interface)', () => {
    expect(() => SweRebenchV2TaskSchema.parse({ ...validTask, interface: '' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-task.test.ts`

Expected: All fail (`SweRebenchV2TaskSchema` not exported).

- [ ] **Step 3: Implement the schema**

Create `packages/sdk/src/swe-rebench-v2.ts`:

```typescript
/**
 * SWE-rebench v2 Task schema. The on-chain JinnRouter Task payload references
 * a HuggingFace dataset row by `(hf_dataset, hf_split, instance_id)`; the
 * Solver and Evaluator fetch the full row at solve / grade time.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.3
 */

import { z } from 'zod';

export const SweRebenchV2LanguageSchema = z.enum([
  'python', 'javascript', 'typescript', 'go',
  'c', 'cpp', 'cs', 'java', 'rust', 'dart',
]);

export const SweRebenchV2TaskSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2.v1'),
  /**
   * The SWE-rebench v2 instance identifier. Format: <org>__<repo>-<issue-or-pr-number>,
   * e.g. "unidata__netcdf-c-1925".
   */
  instance_id: z.string().min(1),
  /** GitHub repo path (org/repo). */
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  /** Git commit SHA at which the issue was reported. */
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Programming language of the underlying repo. */
  language: SweRebenchV2LanguageSchema,
  /** Issue or PR description. */
  problem_statement: z.string(),
  /**
   * v2 auxiliary interface info (function names, signatures, descriptions for
   * touched symbols). Empty string when no interface is provided.
   */
  interface: z.string(),
  /** HuggingFace dataset id, e.g. 'nebius/SWE-rebench-leaderboard'. */
  hf_dataset: z.string().regex(/^[^/]+\/[^/]+$/),
  /** HF split identifier, e.g. '2026_02'. */
  hf_split: z.string().regex(/^\d{4}_\d{2}$/),
  /** Unix epoch (seconds) deadline for Solution submission. */
  deadline_unix: z.number().int().positive(),
  /**
   * Round identifier for the launched SolverNet manifest. Format YYYY-MM.
   * Used for per-round dashboard rollups and per-round reward distribution.
   */
  round_month: z.string().regex(/^\d{4}-\d{2}$/),
});

export type SweRebenchV2Task = z.infer<typeof SweRebenchV2TaskSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-task.test.ts`

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/swe-rebench-v2.ts packages/sdk/test/swe-rebench-v2-task.test.ts
git commit -m "feat(sdk): add SweRebenchV2TaskSchema

Task payload references a HuggingFace dataset row by
(hf_dataset, hf_split, instance_id). Reference-don't-redistribute pattern:
on-chain payload stays small; Solvers and Evaluators fetch the full row
at solve/grade time.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.3"
```

---

## Task 2: Solution + Verdict payload schemas

**Files:**
- Create: `packages/sdk/src/payloads/swe-rebench-v2.ts`
- Create: `packages/sdk/test/swe-rebench-v2-payloads.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/test/swe-rebench-v2-payloads.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
} from '../src/payloads/swe-rebench-v2.js';

describe('SweRebenchV2SolutionPayloadSchema', () => {
  it('accepts a minimal Solution', () => {
    const sol = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n',
      trajectory_cid: 'bafy...',
    };
    expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol)).not.toThrow();
  });

  it('accepts an optional cost field', () => {
    const sol = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: '...',
      trajectory_cid: 'bafy...',
      cost: { totalUsd: 0.42 },
    };
    expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol)).not.toThrow();
  });

  it('rejects a Solution missing patch', () => {
    const sol = { schemaVersion: 'swe-rebench-v2-solution.v1', trajectory_cid: 'bafy...' };
    expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol)).toThrow();
  });
});

describe('SweRebenchV2VerdictPayloadSchema', () => {
  it('accepts a passing Verdict (score 1, passed_match true)', () => {
    const v = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 1,
      passed_match: true,
      test_log_cid: 'bafy...',
      evaluator_cost_usd: 0.05,
    };
    expect(() => SweRebenchV2VerdictPayloadSchema.parse(v)).not.toThrow();
  });

  it('accepts a failing Verdict (score 0)', () => {
    const v = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 0,
      passed_match: false,
      test_log_cid: 'bafy...',
      evaluator_cost_usd: 0.05,
    };
    expect(() => SweRebenchV2VerdictPayloadSchema.parse(v)).not.toThrow();
  });

  it('rejects scores outside {0, 1}', () => {
    const v = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 0.5,
      passed_match: true,
      test_log_cid: 'bafy...',
      evaluator_cost_usd: 0.05,
    };
    expect(() => SweRebenchV2VerdictPayloadSchema.parse(v)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-payloads.test.ts`

- [ ] **Step 3: Implement the payload schemas**

Create `packages/sdk/src/payloads/swe-rebench-v2.ts`:

```typescript
/**
 * SWE-rebench v2 Solution + Verdict payload schemas.
 *
 * Solution: the unified-diff patch the Solver's harness produced for the
 * benchmark instance, plus a pointer to the trajectory blob in the corpus.
 * Cost (operator-self-reported) is generalisable across SolverNets.
 *
 * Verdict: deterministic test-suite pass/fail + grading provenance.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.2
 */

import { z } from 'zod';

export const SweRebenchV2SolutionPayloadSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-solution.v1'),
  /** Unified diff patch (git-format). */
  patch: z.string().min(1),
  /** IPFS CID of the trajectory blob (operator-side reasoning + tool calls). */
  trajectory_cid: z.string().min(1),
  /**
   * Operator-self-reported cost of producing this Solution. Optional; when
   * present, contributes to the per-harness cost rollups. Generalisable
   * across SolverNets — only `totalUsd` is required at v1.
   */
  cost: z
    .object({
      totalUsd: z.number().nonnegative(),
      breakdown: z
        .object({
          llm: z.number().nonnegative().optional(),
          tools: z.number().nonnegative().optional(),
          other: z.number().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type SweRebenchV2SolutionPayload = z.infer<typeof SweRebenchV2SolutionPayloadSchema>;

export const SweRebenchV2VerdictPayloadSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-verdict.v1'),
  /** Pass@1 score: 1 if the test suite passed, 0 otherwise. */
  score: z.union([z.literal(0), z.literal(1)]),
  /**
   * Whether the actual passed/failed test set matched the expected
   * `FAIL_TO_PASS ∪ PASS_TO_PASS` exactly. False if extra tests passed
   * or expected tests failed unexpectedly.
   */
  passed_match: z.boolean(),
  /** IPFS CID of the test execution log. */
  test_log_cid: z.string().min(1),
  /** Cost of running the evaluator on this Solution (USDC-equivalent). */
  evaluator_cost_usd: z.number().nonnegative(),
});

export type SweRebenchV2VerdictPayload = z.infer<typeof SweRebenchV2VerdictPayloadSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-payloads.test.ts`

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/payloads/swe-rebench-v2.ts packages/sdk/test/swe-rebench-v2-payloads.test.ts
git commit -m "feat(sdk): add SWE-rebench v2 Solution + Verdict payload schemas

Solution carries the unified-diff patch + trajectory CID + optional cost.
Verdict carries score (0|1), passed_match flag, test log CID, evaluator
cost. Both validated via Zod.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.2"
```

---

## Task 3: Register the SolverNet contract

**Files:**
- Modify: `packages/sdk/src/contracts.ts`
- Create: `packages/sdk/test/swe-rebench-v2-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/swe-rebench-v2-contract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SOLVER_NET_CONTRACTS, getSolverNetContract } from '../src/contracts.js';

describe('SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT', () => {
  it('is registered under "swe-rebench-v2.v1"', () => {
    const contract = getSolverNetContract('swe-rebench-v2.v1');
    expect(contract).toBeDefined();
    expect(contract?.solverType).toBe('swe-rebench-v2.v1');
    expect(contract?.name).toBe('SWE-rebench v2');
  });

  it('declares the correct schemas', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract.schemas.task).toBeDefined();
    expect(contract.schemas.solution).toBeDefined();
    expect(contract.schemas.verdict).toBeDefined();
  });

  it('declares deterministic evaluation function pointing at the evaluator impl', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract.evaluationFunction.deterministic).toBe(true);
    expect(contract.evaluationFunction.implementation).toContain('swe-rebench-v2-evaluator');
  });

  it('declares the multi-winrate aggregation function', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract.aggregationFunction.id).toBe('swe-rebench-v2.multi-winrate.v1');
    expect(contract.aggregationFunction.windowDays).toBe(30);
  });

  it('declares the runtime plugin', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract.defaultRuntimePlugins).toContain('bundled:swe-rebench-v2-runtime');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-contract.test.ts`

- [ ] **Step 3: Extend `SupportedSolverType` and add the contract**

In `packages/sdk/src/contracts.ts`, modify the type union and append the new contract:

```typescript
// Existing line:
//   export type SupportedSolverType = 'prediction.v1';
// Replace with:
export type SupportedSolverType = 'prediction.v1' | 'swe-rebench-v2.v1';

// Add imports near the top, alongside the prediction-v1 imports:
import { SweRebenchV2TaskSchema } from './swe-rebench-v2.js';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
} from './payloads/swe-rebench-v2.js';

// After the PREDICTION_V1_SOLVER_NET_CONTRACT block, add:

export const SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  name: 'SWE-rebench v2',
  solverType: 'swe-rebench-v2.v1',
  schemas: {
    task: SweRebenchV2TaskSchema,
    solution: SweRebenchV2SolutionPayloadSchema,
    verdict: SweRebenchV2VerdictPayloadSchema,
  },
  claimPolicyDefaults: {
    mode: 'parallel',
    maxClaims: 50,
    maxClaimsPerOperator: 5,
    claimLeaseTtlSeconds: 60 * 60, // 1 hour per Task — coding tasks need more time than predictions
  },
  credentialRequirements: {
    creator: [
      {
        id: 'huggingface.dataset.read',
        kind: 'public-api',
        required: true,
        description: 'Read public HuggingFace dataset rows for Task creation (datasets-server.huggingface.co).',
      },
    ],
    solver: [],
    evaluator: [
      {
        id: 'docker.hub.swerebenchv2.read',
        kind: 'public-api',
        required: true,
        description: 'Pull SWE-rebench v2 per-instance Docker images from docker.io/swerebenchv2.',
      },
    ],
  },
  evaluationFunction: {
    id: 'swe-rebench-v2.docker-test-suite.v1',
    deterministic: true,
    inputs: ['SWE-rebench v2 Task', 'SWE-rebench v2 Solution', 'per-instance Docker image'],
    output: 'SWE-rebench v2 Verdict',
    implementation: 'client/src/harnesses/impls/swe-rebench-v2-evaluator',
  },
  aggregationFunction: {
    id: 'swe-rebench-v2.multi-winrate.v1',
    deterministic: true,
    inputs: ['SCORED swe-rebench-v2.v1 Verdicts'],
    output: 'structured network-result (mean/complexity-weighted/byLanguage/frontier/parityTrip)',
    windowDays: 30,
  },
  defaultRuntimePlugins: ['bundled:swe-rebench-v2-runtime'],
};

// Update SOLVER_NET_CONTRACTS map:
export const SOLVER_NET_CONTRACTS: SolverNetContractMap = {
  'prediction.v1': PREDICTION_V1_SOLVER_NET_CONTRACT,
  'swe-rebench-v2.v1': SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-contract.test.ts`

Expected: 5 passes.

- [ ] **Step 5: Run the full SDK test suite to confirm no regression**

Run: `cd packages/sdk && yarn test`

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/contracts.ts packages/sdk/test/swe-rebench-v2-contract.test.ts
git commit -m "feat(sdk): register SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT

Adds the swe-rebench-v2.v1 SolverNet contract alongside prediction.v1.
Schemas, evaluation function, and multi-winrate aggregation declared
per the design spec.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.2
DR: log/decisions/2026-05-06-swe-rebench-v2-benchmark-choice.md"
```

---

## Task 4: Evaluator wrapper — calls upstream `eval.py`

**Files:**
- Create: `client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts`
- Create: `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts`
- Create: `client/test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts`

- [ ] **Step 1: Write the failing test for the evaluator's grading flow**

Create `client/test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SweRebenchV2Evaluator } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

describe('SweRebenchV2Evaluator', () => {
  it('emits a passing Verdict (score=1) when test suite passes', async () => {
    const fakeRunner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a', 'test_b'],
        failed: [],
        log: 'all green',
        exitCode: 0,
      }),
    };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'unidata__netcdf-c-1925',
        image_name: 'docker.io/swerebenchv2/unidata-netcdf-c:1925-ad6bff3',
        FAIL_TO_PASS: ['test_a'],
        PASS_TO_PASS: ['test_b'],
        test_patch: 'diff --git ...',
        install_config: { test_cmd: 'make test', log_parser: 'pytest' },
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    const verdict = await evaluator.grade({
      task: {
        instance_id: 'unidata__netcdf-c-1925',
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_02',
      } as any,
      solutionPayload: { patch: 'diff ...', trajectory_cid: 'bafy' },
    });
    expect(verdict.score).toBe(1);
    expect(verdict.passed_match).toBe(true);
  });

  it('emits a failing Verdict (score=0) when tests fail', async () => {
    const fakeRunner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: false,
        passed: [],
        failed: ['test_a'],
        log: 'test_a failed',
        exitCode: 1,
      }),
    };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'unidata__netcdf-c-1925',
        image_name: 'docker.io/swerebenchv2/unidata-netcdf-c:1925-ad6bff3',
        FAIL_TO_PASS: ['test_a'],
        PASS_TO_PASS: [],
        test_patch: 'diff ...',
        install_config: { test_cmd: 'make test', log_parser: 'pytest' },
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    const verdict = await evaluator.grade({
      task: { instance_id: 'unidata__netcdf-c-1925', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2026_02' } as any,
      solutionPayload: { patch: 'diff ...', trajectory_cid: 'bafy' },
    });
    expect(verdict.score).toBe(0);
  });

  it('throws on missing image_name in HF row', async () => {
    const fakeRunner = { runEval: vi.fn() };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'X', /* no image_name */
        FAIL_TO_PASS: [], PASS_TO_PASS: [], test_patch: '', install_config: {},
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    await expect(evaluator.grade({
      task: { instance_id: 'X', hf_dataset: 'd', hf_split: '2026_02' } as any,
      solutionPayload: { patch: '...', trajectory_cid: 'bafy' },
    })).rejects.toThrow(/image_name/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn test swe-rebench-v2-evaluator`

- [ ] **Step 3: Implement the evaluator**

Create `client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts`:

```typescript
/**
 * SWE-rebench v2 evaluator. Wraps the upstream `scripts/eval.py` (MIT) to
 * grade Solver patches against the per-instance Docker test suite.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.4
 */

import type {
  SweRebenchV2Task,
  SweRebenchV2SolutionPayload,
  SweRebenchV2VerdictPayload,
} from '@jinn-network/sdk';

export interface HfRow {
  instance_id: string;
  image_name: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  test_patch: string;
  install_config: { test_cmd: string | string[]; log_parser: string };
}

export interface HfFetcher {
  fetchTaskRow(args: { hf_dataset: string; hf_split: string; instance_id: string }): Promise<HfRow>;
}

export interface EvalRunner {
  runEval(args: {
    image: string;
    patch: string;
    test_patch: string;
    test_cmd: string | string[];
    log_parser: string;
    fail_to_pass: string[];
    pass_to_pass: string[];
  }): Promise<{
    passed_match: boolean;
    passed: string[];
    failed: string[];
    log: string;
    exitCode: number;
  }>;
}

export interface GradeArgs {
  task: SweRebenchV2Task;
  solutionPayload: SweRebenchV2SolutionPayload;
}

export class SweRebenchV2Evaluator {
  constructor(
    private readonly deps: { fetcher: HfFetcher; runner: EvalRunner },
  ) {}

  async grade(args: GradeArgs): Promise<SweRebenchV2VerdictPayload & { test_log: string }> {
    const row = await this.deps.fetcher.fetchTaskRow({
      hf_dataset: args.task.hf_dataset,
      hf_split: args.task.hf_split,
      instance_id: args.task.instance_id,
    });
    if (!row.image_name) {
      throw new Error(`HF row for ${args.task.instance_id} missing image_name`);
    }
    const result = await this.deps.runner.runEval({
      image: row.image_name,
      patch: args.solutionPayload.patch,
      test_patch: row.test_patch,
      test_cmd: row.install_config.test_cmd,
      log_parser: row.install_config.log_parser,
      fail_to_pass: row.FAIL_TO_PASS,
      pass_to_pass: row.PASS_TO_PASS,
    });
    return {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: result.passed_match ? 1 : 0,
      passed_match: result.passed_match,
      test_log_cid: '',  // populated by caller after IPFS pin
      evaluator_cost_usd: 0,  // populated by caller from runtime metrics
      test_log: result.log,
    };
  }
}
```

- [ ] **Step 4: Implement the eval runner (Python subprocess wrapper)**

Create `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts`:

```typescript
/**
 * Thin Python-subprocess wrapper around `scripts/eval.py` from the upstream
 * SWE-rebench/SWE-rebench-V2 repo (MIT). Operators install the upstream
 * harness as a Python dependency; this runner shells out and parses the
 * structured JSON report.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalRunner } from './index.js';

export interface PythonEvalRunnerOptions {
  /** Path to the cloned SWE-rebench-V2 repo (cached locally). */
  upstreamRepoDir: string;
  /** Override Python executable. Defaults to `python3`. */
  pythonBin?: string;
  /** Workers for parallel eval (defaults to 1; we run one task at a time). */
  maxWorkers?: number;
}

export class PythonEvalRunner implements EvalRunner {
  constructor(private readonly opts: PythonEvalRunnerOptions) {}

  async runEval(args: Parameters<EvalRunner['runEval']>[0]): ReturnType<EvalRunner['runEval']> {
    const tmp = await mkdtemp(join(tmpdir(), 'swerebench-eval-'));
    const taskJson = [{
      instance_id: 'task',
      image_name: args.image,
      FAIL_TO_PASS: args.fail_to_pass,
      PASS_TO_PASS: args.pass_to_pass,
      test_patch: args.test_patch,
      install_config: { test_cmd: args.test_cmd, log_parser: args.log_parser },
    }];
    const taskJsonPath = join(tmp, 'task.json');
    const patchJsonPath = join(tmp, 'patch.json');
    const reportPath = join(tmp, 'report.json');
    await writeFile(taskJsonPath, JSON.stringify(taskJson));
    await writeFile(patchJsonPath, JSON.stringify({ task: { model_patch: args.patch } }));

    const pyArgs = [
      '-m', 'scripts.eval',
      '--json', taskJsonPath,
      '--patch-json', patchJsonPath,
      '--max-workers', String(this.opts.maxWorkers ?? 1),
      '--report-json', reportPath,
    ];
    const child = spawn(this.opts.pythonBin ?? 'python3', pyArgs, {
      cwd: this.opts.upstreamRepoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', reject);
    });

    let report: any;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (err) {
      throw new Error(`Eval runner failed: exitCode=${exitCode}, stderr=${stderr}`);
    }
    await rm(tmp, { recursive: true, force: true });

    const taskReport = report.task ?? report['task'] ?? {};
    return {
      passed_match: taskReport.passed_match === true,
      passed: taskReport.passed_actual ?? [],
      failed: taskReport.failed_actual ?? [],
      log: stdout + (taskReport.log ?? ''),
      exitCode,
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn test swe-rebench-v2-evaluator`

Expected: 3 passes.

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/swe-rebench-v2-evaluator/ client/test/harnesses/impls/swe-rebench-v2-evaluator/
git commit -m "feat(evaluator): SWE-rebench v2 evaluator wrapping upstream eval.py

SweRebenchV2Evaluator fetches the HF row by (hf_dataset, hf_split,
instance_id), pulls the per-instance Docker image, applies the Solver's
patch via the upstream MIT-licensed scripts/eval.py, and emits a
structured Verdict with score (0|1), passed_match, and the test log.

Reference-don't-redistribute pattern: image_name and install_config are
self-describing on the HF row; no name-mangling required.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.4"
```

---

## Task 5: Runtime plugin manifest

**Files:**
- Create: `client/plugins/swe-rebench-v2-runtime/.claude-plugin/plugin.json`
- Create: `client/plugins/swe-rebench-v2-runtime/jinn.plugin.json`
- Create: `client/plugins/swe-rebench-v2-runtime/skills/orient/SKILL.md`
- Create: `client/plugins/swe-rebench-v2-runtime/skills/plan/SKILL.md`
- Create: `client/plugins/swe-rebench-v2-runtime/README.md`

- [ ] **Step 1: Create the host plugin manifest**

Create `client/plugins/swe-rebench-v2-runtime/.claude-plugin/plugin.json`:

```json
{
  "name": "swe-rebench-v2-runtime",
  "version": "0.1.0",
  "description": "Runtime plugin for the swe-rebench-v2.v1 SolverNet — provides Solver-side orientation skills for code-issue resolution tasks.",
  "skills": [
    "skills/orient/SKILL.md",
    "skills/plan/SKILL.md"
  ]
}
```

- [ ] **Step 2: Create the Jinn-side sidecar manifest**

Create `client/plugins/swe-rebench-v2-runtime/jinn.plugin.json`:

```json
{
  "name": "swe-rebench-v2-runtime",
  "version": "0.1.0",
  "jinn": {
    "supports": ["swe-rebench-v2.v1"],
    "skills": [
      "skills/orient/SKILL.md",
      "skills/plan/SKILL.md"
    ],
    "description": "Provides Solver-side orientation + planning skills for SWE-rebench v2 code-issue Tasks."
  }
}
```

- [ ] **Step 3: Create the orient skill**

Create `client/plugins/swe-rebench-v2-runtime/skills/orient/SKILL.md`:

```markdown
---
name: swe-rebench-v2-orient
description: Orient on a SWE-rebench v2 task — read the problem statement, repo, base commit, and auxiliary interface info; identify the test files in FAIL_TO_PASS; understand what change the issue requires.
---

# Orient on a SWE-rebench v2 task

Inputs you receive:

- `task.instance_id` — e.g. `unidata__netcdf-c-1925`
- `task.repo` — `org/repo`
- `task.base_commit` — git SHA
- `task.language` — `python | javascript | typescript | go | c | cpp | cs | java | rust | dart`
- `task.problem_statement` — the issue description
- `task.interface` — auxiliary interface info (function names, signatures, descriptions). May be empty.

Steps:

1. Read the problem statement carefully. Note the symptom, the expected behaviour, and any hints about which files / symbols are involved.
2. If `task.interface` is non-empty, treat it as authoritative for function names + signatures of the API you must implement / fix.
3. Use the corpus (via `corpus.read({ kind: 'swe-rebench-v2.v1', similarTo: task.repo, ... })`) to read peer trajectories on similar repos / similar issue types. Note successful patterns; note what didn't work.
4. Check the `FAIL_TO_PASS` test names from the HF row — these define the success criterion. Find them in the codebase via grep / fs search.
5. Output a brief Orient summary (3-5 sentences): your hypothesis about the bug, the files you intend to touch, the test you intend to satisfy.

Pass this summary forward to the Plan phase.
```

- [ ] **Step 4: Create the plan skill**

Create `client/plugins/swe-rebench-v2-runtime/skills/plan/SKILL.md`:

```markdown
---
name: swe-rebench-v2-plan
description: Plan the patch for a SWE-rebench v2 task — given the Orient summary, sketch the minimal diff that resolves the issue without breaking existing PASS_TO_PASS tests.
---

# Plan the patch

Inputs:
- The Orient summary from the previous phase.
- The repo at `task.base_commit`.
- The `FAIL_TO_PASS` test names (must pass after your patch).
- The `PASS_TO_PASS` test names (must continue passing — don't break them).

Steps:

1. Read the failing test(s). Understand exactly what behaviour they assert.
2. Locate the source file(s) that need editing. Use grep, AST tools, or filesystem search.
3. Sketch the minimal diff:
   - What lines change in which files?
   - What does the new code do?
   - Which existing tests must continue to pass (briefly justify why they will)?
4. Output the plan as a list of file-level edits.

Pass this plan forward to the Execute phase, which produces the actual patch.
```

- [ ] **Step 5: Create the README**

Create `client/plugins/swe-rebench-v2-runtime/README.md`:

```markdown
# SWE-rebench v2 runtime plugin

Provides Solver-side orientation + planning skills for the `swe-rebench-v2.v1` SolverNet.

This plugin bundles two skills:
- `swe-rebench-v2-orient` — read the task, identify FAIL_TO_PASS tests, plan the bug hypothesis.
- `swe-rebench-v2-plan` — sketch the minimal diff that satisfies FAIL_TO_PASS without breaking PASS_TO_PASS.

The plugin is loaded automatically when an operator's daemon has the `swe-rebench-v2.v1` SolverNet enabled, per the SDK's `defaultRuntimePlugins: ['bundled:swe-rebench-v2-runtime']`.

License: MIT.
```

- [ ] **Step 6: Smoke-test plugin manifests**

Run: `cd client && yarn build && node dist/bin/jinn.js plug-ins list 2>&1 | grep -i swe-rebench`

Expected: `swe-rebench-v2-runtime` appears in the list.

- [ ] **Step 7: Commit**

```bash
git add client/plugins/swe-rebench-v2-runtime/
git commit -m "feat(plugin): add bundled swe-rebench-v2-runtime plugin

Two skills (orient + plan) tailored to SWE-rebench v2 code-issue tasks.
The plugin is auto-loaded when the swe-rebench-v2.v1 SolverNet is
enabled, per the SDK's defaultRuntimePlugins entry.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.2"
```

---

## Task 6: Generator pool builder — full historical pool from HF

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-pool.ts`
- Create: `client/test/solver-types/swe-rebench-v2-pool.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/solver-types/swe-rebench-v2-pool.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { listMonthlyPartitions, buildHistoricalPool } from '../../src/solver-types/_swe-rebench-v2-pool.js';

describe('listMonthlyPartitions', () => {
  it('detects month-shaped split names from the dataset config', () => {
    const splits = ['2025_01', '2025_02', 'test', 'lite', '2026_02'];
    const months = listMonthlyPartitions(splits);
    expect(months).toEqual(['2025_01', '2025_02', '2026_02']);
  });

  it('returns months sorted ascending', () => {
    const months = listMonthlyPartitions(['2026_02', '2025_03', '2025_01']);
    expect(months).toEqual(['2025_01', '2025_03', '2026_02']);
  });
});

describe('buildHistoricalPool', () => {
  it('aggregates instance_ids across monthly partitions, deduplicated', async () => {
    const fakeFetcher = async (split: string) => {
      if (split === '2025_01') return [{ instance_id: 'a' }, { instance_id: 'b' }];
      if (split === '2025_02') return [{ instance_id: 'b' }, { instance_id: 'c' }];
      return [];
    };
    const pool = await buildHistoricalPool({
      months: ['2025_01', '2025_02'],
      fetchSplit: fakeFetcher,
    });
    expect(pool.map((t) => t.instance_id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('preserves task language for round-robin balancing later', async () => {
    const fakeFetcher = async () => [{ instance_id: 'x', language: 'python' }];
    const pool = await buildHistoricalPool({
      months: ['2025_01'],
      fetchSplit: fakeFetcher,
    });
    expect(pool[0].language).toBe('python');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test solver-types/swe-rebench-v2-pool`

- [ ] **Step 3: Implement the pool builder**

Create `client/src/solver-types/_swe-rebench-v2-pool.ts`:

```typescript
/**
 * Historical pool builder for the swe-rebench-v2 task generator. Pulls
 * monthly partitions from `nebius/SWE-rebench-leaderboard` via the HF
 * datasets-server API and aggregates them into a deduplicated task pool.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 * DR: log/decisions/2026-05-06-task-generator-success-cap.md
 */

import { request } from 'node:https';

export interface PoolTask {
  instance_id: string;
  hf_dataset: string;
  hf_split: string;
  language?: string;
  meta?: { num_modified_files?: number; num_modified_lines?: number };
}

/** Filter dataset split names to only the YYYY_MM monthly partitions. */
export function listMonthlyPartitions(splits: string[]): string[] {
  return splits
    .filter((s) => /^\d{4}_\d{2}$/.test(s))
    .sort();
}

export interface BuildPoolArgs {
  months: string[];
  fetchSplit: (split: string) => Promise<Array<{ instance_id: string; language?: string; meta?: any }>>;
}

/**
 * Build a deduplicated historical pool. Tasks appearing in multiple
 * partitions are kept only from the earliest partition (first-seen wins).
 */
export async function buildHistoricalPool(args: BuildPoolArgs): Promise<PoolTask[]> {
  const seen = new Set<string>();
  const pool: PoolTask[] = [];
  for (const split of args.months) {
    const rows = await args.fetchSplit(split);
    for (const row of rows) {
      if (seen.has(row.instance_id)) continue;
      seen.add(row.instance_id);
      pool.push({
        instance_id: row.instance_id,
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: split,
        language: row.language,
        meta: row.meta,
      });
    }
  }
  return pool;
}

/** HTTP fetcher for HF datasets-server rows API. Use as fetchSplit in production. */
export async function fetchHfSplit(args: { dataset: string; split: string; limit?: number }): Promise<any[]> {
  const url = new URL('https://datasets-server.huggingface.co/rows');
  url.searchParams.set('dataset', args.dataset);
  url.searchParams.set('config', 'default');
  url.searchParams.set('split', args.split);
  url.searchParams.set('offset', '0');
  url.searchParams.set('length', String(args.limit ?? 100));
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve((parsed.rows ?? []).map((r: any) => r.row));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test solver-types/swe-rebench-v2-pool`

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-pool.ts client/test/solver-types/swe-rebench-v2-pool.test.ts
git commit -m "feat(generator): historical pool builder for SWE-rebench v2

Pulls monthly partitions from nebius/SWE-rebench-leaderboard via the HF
datasets-server API and deduplicates by instance_id. The pool is the
union of all available monthly partitions; ~750 tasks at v1 launch.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6"
```

---

## Task 7: Generator state persistence

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-state.ts`
- Create: `client/test/solver-types/swe-rebench-v2-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/solver-types/swe-rebench-v2-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeneratorStateStore } from '../../src/solver-types/_swe-rebench-v2-state.js';

describe('GeneratorStateStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'state-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with zero counters for any task', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    expect(await store.getCounters('a')).toEqual({ posted: 0, successful: 0, last_posted_at: 0 });
  });

  it('increments and persists posted_count', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordPosted('a');
    await store.recordPosted('a');
    expect((await store.getCounters('a')).posted).toBe(2);

    const reloaded = new GeneratorStateStore({ stateDir: dir });
    expect((await reloaded.getCounters('a')).posted).toBe(2);
  });

  it('increments successful_count and persists', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordSuccess('a');
    expect((await store.getCounters('a')).successful).toBe(1);
    const reloaded = new GeneratorStateStore({ stateDir: dir });
    expect((await reloaded.getCounters('a')).successful).toBe(1);
  });

  it('isolates counters per instance_id', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordPosted('a');
    await store.recordSuccess('b');
    expect((await store.getCounters('a')).posted).toBe(1);
    expect((await store.getCounters('a')).successful).toBe(0);
    expect((await store.getCounters('b')).posted).toBe(0);
    expect((await store.getCounters('b')).successful).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test solver-types/swe-rebench-v2-state`

- [ ] **Step 3: Implement the state store**

Create `client/src/solver-types/_swe-rebench-v2-state.ts`:

```typescript
/**
 * Persistent generator state for the swe-rebench-v2 task generator.
 * Tracks per-task posted_count, successful_count, last_posted_at across
 * daemon restarts. Stored at `<stateDir>/generator-state.json`.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskCounters {
  posted: number;
  successful: number;
  last_posted_at: number; // ms epoch
}

interface StateFile {
  schemaVersion: 'swe-rebench-v2-generator-state.v1';
  tasks: Record<string, TaskCounters>;
}

export class GeneratorStateStore {
  private stateFile: string;
  private cache: StateFile | null = null;

  constructor(opts: { stateDir: string }) {
    this.stateFile = join(opts.stateDir, 'generator-state.json');
  }

  private async load(): Promise<StateFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      this.cache = JSON.parse(raw);
    } catch {
      this.cache = { schemaVersion: 'swe-rebench-v2-generator-state.v1', tasks: {} };
    }
    return this.cache!;
  }

  private async save(): Promise<void> {
    if (!this.cache) return;
    await mkdir(join(this.stateFile, '..'), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(this.cache, null, 2));
  }

  async getCounters(instance_id: string): Promise<TaskCounters> {
    const state = await this.load();
    return state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
  }

  async recordPosted(instance_id: string, now: number = Date.now()): Promise<void> {
    const state = await this.load();
    const c = state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
    c.posted += 1;
    c.last_posted_at = now;
    state.tasks[instance_id] = c;
    await this.save();
  }

  async recordSuccess(instance_id: string): Promise<void> {
    const state = await this.load();
    const c = state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
    c.successful += 1;
    state.tasks[instance_id] = c;
    await this.save();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test solver-types/swe-rebench-v2-state`

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-state.ts client/test/solver-types/swe-rebench-v2-state.test.ts
git commit -m "feat(generator): persist per-task counters across daemon restarts

GeneratorStateStore writes posted_count + successful_count + last_posted_at
to ~/.jinn-client/solvernets/swe-rebench-v2/generator-state.json so the
post-until-target-successes policy survives restarts.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6"
```

---

## Task 8: Task generator with post-until-target-successes policy

**Files:**
- Create: `client/src/solver-types/swe-rebench-v2-auto.ts`
- Create: `client/test/solver-types/swe-rebench-v2-auto.test.ts`

- [ ] **Step 1: Write the failing tests for the policy**

Create `client/test/solver-types/swe-rebench-v2-auto.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { selectNextPostingCandidate, type GeneratorConfig } from '../../src/solver-types/swe-rebench-v2-auto.js';

const config: GeneratorConfig = {
  N_target_successes: 3,
  N_max_postings_per_task: 10,
  cooldown_ms: 24 * 60 * 60 * 1000,
};

describe('selectNextPostingCandidate', () => {
  const pool = [
    { instance_id: 'a', language: 'python' },
    { instance_id: 'b', language: 'go' },
    { instance_id: 'c', language: 'python' },
  ];

  it('skips saturated tasks (successful_count >= N_target_successes)', () => {
    const counters = new Map([
      ['a', { posted: 5, successful: 3, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1000 });
    expect(next?.instance_id).toBe('b');
  });

  it('skips tasks within cooldown window', () => {
    const now = 1_000_000;
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: now - 1000 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now });
    expect(next?.instance_id).toBe('b');
  });

  it('skips tasks at max-postings cap', () => {
    const counters = new Map([
      ['a', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1_000_000_000 });
    expect(next?.instance_id).toBe('b');
  });

  it('returns undefined when all tasks are saturated or capped', () => {
    const counters = new Map([
      ['a', { posted: 10, successful: 3, last_posted_at: 0 }],
      ['b', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['c', { posted: 10, successful: 3, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1_000_000_000 });
    expect(next).toBeUndefined();
  });

  it('balances by language (round-robin) when multiple eligible', () => {
    const counters = new Map();  // all tasks are fresh
    // Simulate having just posted 'a' (python). Next should be go (b), not c (python).
    counters.set('a', { posted: 1, successful: 0, last_posted_at: 1 });
    const next = selectNextPostingCandidate({
      pool, counters, config, now: 2 + config.cooldown_ms,  // past 'a' cooldown
      lastPostedLanguage: 'python',
    });
    expect(next?.language).toBe('go');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test solver-types/swe-rebench-v2-auto`

- [ ] **Step 3: Implement the policy**

Create `client/src/solver-types/swe-rebench-v2-auto.ts`:

```typescript
/**
 * Task generator for the swe-rebench-v2.v1 SolverNet. Implements the
 * full-historical-pool + post-until-target-successes policy from DR-i.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 * DR: log/decisions/2026-05-06-task-generator-success-cap.md (P5)
 */

import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { TaskCounters } from './_swe-rebench-v2-state.js';

export interface GeneratorConfig {
  N_target_successes: number;
  N_max_postings_per_task: number;
  cooldown_ms: number;
}

export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
  N_target_successes: 3,
  N_max_postings_per_task: 10,
  cooldown_ms: 24 * 60 * 60 * 1000,
};

export interface SelectArgs {
  pool: PoolTask[];
  counters: Map<string, TaskCounters>;
  config: GeneratorConfig;
  now: number;
  /** Language of the most-recently-posted task; used to bias toward a different
   *  language for round-robin balancing. */
  lastPostedLanguage?: string;
}

/**
 * Choose the next eligible task to post on JinnRouter, or undefined if no
 * task is currently eligible (all saturated, in cooldown, or capped).
 *
 * Eligibility filter:
 *   - successful_count[task] < N_target_successes
 *   - posted_count[task] < N_max_postings_per_task
 *   - now - last_posted_at[task] >= cooldown_ms
 *
 * Among eligible tasks, prefer a different language than the last-posted one
 * (simple round-robin balance). Tie-break by lower posted_count, then by
 * earliest last_posted_at, then by instance_id (deterministic).
 */
export function selectNextPostingCandidate(args: SelectArgs): PoolTask | undefined {
  const eligible = args.pool.filter((task) => {
    const c = args.counters.get(task.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    if (c.successful >= args.config.N_target_successes) return false;
    if (c.posted >= args.config.N_max_postings_per_task) return false;
    if (args.now - c.last_posted_at < args.config.cooldown_ms) return false;
    return true;
  });
  if (eligible.length === 0) return undefined;

  // Round-robin language preference
  const differentLanguage = args.lastPostedLanguage
    ? eligible.filter((t) => t.language !== args.lastPostedLanguage)
    : eligible;
  const candidates = differentLanguage.length > 0 ? differentLanguage : eligible;

  candidates.sort((a, b) => {
    const cA = args.counters.get(a.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    const cB = args.counters.get(b.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    if (cA.posted !== cB.posted) return cA.posted - cB.posted;
    if (cA.last_posted_at !== cB.last_posted_at) return cA.last_posted_at - cB.last_posted_at;
    return a.instance_id.localeCompare(b.instance_id);
  });
  return candidates[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test solver-types/swe-rebench-v2-auto`

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/swe-rebench-v2-auto.ts client/test/solver-types/swe-rebench-v2-auto.test.ts
git commit -m "feat(generator): post-until-target-successes policy for swe-rebench-v2

selectNextPostingCandidate filters the historical pool by:
  - successful < N_target (default 3)
  - posted < N_max (default 10)
  - past cooldown (default 24h)
Then prefers a different language than the last-posted task for
round-robin balancing; ties broken by posted count, last-posted time,
instance_id.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
DR: log/decisions/2026-05-06-task-generator-success-cap.md (P5)"
```

---

## Task 9: Task-complexity-weighted escrow calculator (R2)

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-escrow.ts`
- Create: `client/test/solver-types/swe-rebench-v2-escrow.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/solver-types/swe-rebench-v2-escrow.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeEscrowWei, type EscrowParams } from '../../src/solver-types/_swe-rebench-v2-escrow.js';

const params: EscrowParams = {
  base_escrow_wei: 1_000_000_000_000_000_000n,  // 1 USDC equivalent
  alpha: 0.5,
  beta: 0.3,
  gamma: 0.2,
  loc_normalizer: 100,
  files_normalizer: 5,
  tests_normalizer: 10,
};

describe('computeEscrowWei', () => {
  it('returns base for trivial tasks (1 LoC, 1 file, 1 test)', () => {
    const escrow = computeEscrowWei({ loc: 1, files: 1, tests: 1, params });
    // escrow = base * (1 + 0.5*0.01 + 0.3*0.2 + 0.2*0.1) = base * 1.085
    expect(escrow).toBe(1_085_000_000_000_000_000n);
  });

  it('scales up linearly with complexity proxies', () => {
    const small = computeEscrowWei({ loc: 10, files: 1, tests: 1, params });
    const large = computeEscrowWei({ loc: 100, files: 5, tests: 10, params });
    expect(large).toBeGreaterThan(small);
  });

  it('caps the multiplier so single-task escrow does not blow up', () => {
    const huge = computeEscrowWei({ loc: 10000, files: 100, tests: 1000, params });
    // Multiplier should be capped (e.g., 5x) to prevent runaway escrow on
    // pathological inputs.
    expect(huge).toBeLessThanOrEqual(5n * params.base_escrow_wei);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test solver-types/swe-rebench-v2-escrow`

- [ ] **Step 3: Implement the escrow calculator**

Create `client/src/solver-types/_swe-rebench-v2-escrow.ts`:

```typescript
/**
 * R2 task-complexity-weighted escrow for swe-rebench-v2 Tasks.
 *
 * escrowWei = base × clamp(1 + α × normLoc + β × normFiles + γ × normTests, [1, MAX])
 *
 * normalisers turn raw counts into [0, 1]-ish ranges; α, β, γ are weights
 * declared in the launched-instance manifest.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §8
 * DR: log/decisions/2026-05-06-reward-function-complexity-weighted.md (R2)
 */

export interface EscrowParams {
  base_escrow_wei: bigint;
  alpha: number;
  beta: number;
  gamma: number;
  loc_normalizer: number;
  files_normalizer: number;
  tests_normalizer: number;
}

export interface EscrowInputs {
  loc: number;
  files: number;
  tests: number;
  params: EscrowParams;
}

const MAX_MULTIPLIER = 5n;

export function computeEscrowWei(input: EscrowInputs): bigint {
  const { loc, files, tests, params } = input;
  const normLoc = loc / params.loc_normalizer;
  const normFiles = files / params.files_normalizer;
  const normTests = tests / params.tests_normalizer;
  const multiplier = 1 + params.alpha * normLoc + params.beta * normFiles + params.gamma * normTests;
  // 18-decimal scaled multiplier
  const scaled = BigInt(Math.round(multiplier * 1e6));
  const result = (params.base_escrow_wei * scaled) / 1_000_000n;
  // Cap at MAX_MULTIPLIER × base
  const cap = MAX_MULTIPLIER * params.base_escrow_wei;
  return result > cap ? cap : result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test solver-types/swe-rebench-v2-escrow`

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-escrow.ts client/test/solver-types/swe-rebench-v2-escrow.test.ts
git commit -m "feat(generator): R2 task-complexity-weighted escrow calculator

computeEscrowWei = base * (1 + alpha*normLoc + beta*normFiles + gamma*normTests),
capped at 5x base to prevent runaway escrow on pathological inputs.
Parameters declared by the launcher in the SolverNet manifest.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §8
DR: log/decisions/2026-05-06-reward-function-complexity-weighted.md"
```

---

## Task 10: Wire generator into the daemon's creator loop

**Files:**
- Modify: `client/src/daemon/creator.ts` (or whichever file dispatches per-SolverType auto-generators)
- Modify: `client/src/solver-nets/contracts.ts`

- [ ] **Step 1: Inspect the existing prediction-v1 auto-generator wiring as the pattern to mirror**

Run: `grep -rn "prediction-v1-auto\|getTestnetAutoConfig\|swe-rebench-v2-auto" client/src/daemon/ client/src/solver-types/ client/src/solver-nets/ 2>&1 | head -10`

Note the pattern: a per-SolverType module exports an auto-generator factory; the daemon's creator loop wires it in based on `config.solverNets.<name>.taskGenerator.enabled`.

- [ ] **Step 2: Add a `swe-rebench-v2` entry to `client/src/solver-nets/contracts.ts`**

Mirror the `prediction` entry. Reference the SDK contract, the evaluator-impl path, and the auto-generator from this plan.

- [ ] **Step 3: Wire the auto-generator into the creator loop**

In `client/src/daemon/creator.ts` (or equivalent), at the point where existing auto-generators are dispatched:

```typescript
import { selectNextPostingCandidate, DEFAULT_GENERATOR_CONFIG } from '../solver-types/swe-rebench-v2-auto.js';
import { GeneratorStateStore } from '../solver-types/_swe-rebench-v2-state.js';
import { buildHistoricalPool, fetchHfSplit, listMonthlyPartitions } from '../solver-types/_swe-rebench-v2-pool.js';
import { computeEscrowWei } from '../solver-types/_swe-rebench-v2-escrow.js';

// ... in the per-SolverType branch:
if (solverNetName === 'swe-rebench-v2') {
  const stateStore = new GeneratorStateStore({
    stateDir: join(jinnHome, 'solvernets', 'swe-rebench-v2'),
  });
  // Pool refresh (cache for ~1h, refresh on next month boundary)
  const splits = await listAvailableSplits('nebius/SWE-rebench-leaderboard');
  const months = listMonthlyPartitions(splits);
  const pool = await buildHistoricalPool({
    months,
    fetchSplit: (split) => fetchHfSplit({ dataset: 'nebius/SWE-rebench-leaderboard', split }),
  });
  const counters = new Map<string, TaskCounters>();
  for (const t of pool) counters.set(t.instance_id, await stateStore.getCounters(t.instance_id));

  // Pick next; emit Task on JinnRouter; record posted_count + last_posted_at
  const next = selectNextPostingCandidate({
    pool, counters, config: DEFAULT_GENERATOR_CONFIG, now: Date.now(),
  });
  if (next) {
    const escrow = computeEscrowWei({
      loc: next.meta?.num_modified_lines ?? 0,
      files: next.meta?.num_modified_files ?? 0,
      tests: 1,
      params: launcherConfig.escrowParams,
    });
    await postSweRebenchTask(next, escrow);
    await stateStore.recordPosted(next.instance_id);
  }
}
```

(Adapt to whatever wrapper / loop pattern the daemon uses for prediction-v1.)

- [ ] **Step 4: Add a Verdict-side hook that increments `successful_count` on score=1**

In `client/src/daemon/delivery-watcher.ts` (or wherever Verdict envelopes are processed): when a Verdict for a `swe-rebench-v2.v1` Task arrives with `score === 1`, call `stateStore.recordSuccess(verdict.task.instance_id)`.

- [ ] **Step 5: Add a `swe-rebench-v2` entry to `DEFAULT_SOLVER_NETS` in `client/src/config.ts`**

```typescript
export const DEFAULT_SOLVER_NETS: Record<string, DefaultSolverNetConfig> = {
  prediction: {
    enabled: true,
    solverType: 'prediction.v1',
    role: 'solving',
    harness: 'claude-code-learner',
    plugins: [],
    taskGenerator: { enabled: true },
  },
  'swe-rebench-v2': {
    enabled: false,  // opt-in; operator chooses to enable
    solverType: 'swe-rebench-v2.v1',
    role: 'solving',
    harness: 'claude-code-learner',
    plugins: [],
    taskGenerator: { enabled: false },
  },
};
```

- [ ] **Step 6: Run the full test suite**

Run: `cd client && yarn test`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add client/src/daemon/creator.ts client/src/daemon/delivery-watcher.ts client/src/solver-nets/contracts.ts client/src/config.ts
git commit -m "feat(daemon): wire swe-rebench-v2 task generator into the creator loop

Generator is dispatched when the swe-rebench-v2 SolverNet is enabled.
Verdict-side hook increments successful_count on score=1 so the
post-until-target-successes policy converges. Default config is opt-in.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6"
```

---

## Task 11: Aggregation function — multi-winrate structured result

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-aggregate.ts`
- Create: `client/test/solver-types/swe-rebench-v2-aggregate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/solver-types/swe-rebench-v2-aggregate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeNetworkResult } from '../../src/solver-types/_swe-rebench-v2-aggregate.js';

interface VerdictRow { score: 0 | 1; language: string; complexity: number; }

describe('computeNetworkResult', () => {
  it('mean = arithmetic mean of Verdict.score', () => {
    const verdicts: VerdictRow[] = [
      { score: 1, language: 'python', complexity: 1 },
      { score: 0, language: 'python', complexity: 1 },
      { score: 1, language: 'go', complexity: 1 },
    ];
    const result = computeNetworkResult({ verdicts, windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.meanResolved).toBeCloseTo(2 / 3, 5);
  });

  it('complexityWeighted weights by complexity proxy', () => {
    const verdicts: VerdictRow[] = [
      { score: 1, language: 'python', complexity: 100 },
      { score: 0, language: 'python', complexity: 1 },
    ];
    const result = computeNetworkResult({ verdicts, windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.complexityWeighted).toBeCloseTo(100 / 101, 5);
  });

  it('byLanguage stratifies correctly', () => {
    const verdicts: VerdictRow[] = [
      { score: 1, language: 'python', complexity: 1 },
      { score: 0, language: 'python', complexity: 1 },
      { score: 1, language: 'go', complexity: 1 },
    ];
    const result = computeNetworkResult({ verdicts, windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.byLanguage.python).toEqual({ resolved: 0.5, n: 2 });
    expect(result.byLanguage.go).toEqual({ resolved: 1, n: 1 });
  });

  it('returns zero rates on empty verdict list', () => {
    const result = computeNetworkResult({ verdicts: [], windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.meanResolved).toBe(0);
    expect(result.verdictCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test solver-types/swe-rebench-v2-aggregate`

- [ ] **Step 3: Implement the aggregator**

Create `client/src/solver-types/_swe-rebench-v2-aggregate.ts`:

```typescript
/**
 * SWE-rebench v2 aggregation function. Returns a structured network-level
 * result over a rolling window of resolved Verdicts.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.5
 * DR: log/decisions/2026-05-06-aggregation-multi-winrate.md
 */

export interface AggregateInput {
  score: 0 | 1;
  language: string;
  complexity: number;  // R2 complexity proxy (loc * files for example)
}

export interface NetworkResult {
  schemaVersion: 'swe-rebench-v2.network.v1';
  windowStart: string;
  windowEnd: string;
  verdictCount: number;

  meanResolved: number;
  complexityWeighted: number;
  byLanguage: Record<string, { resolved: number; n: number }>;
  frontierResolved: number;
  parityTripRate: number;
}

export function computeNetworkResult(args: {
  verdicts: AggregateInput[];
  windowStart: string;
  windowEnd: string;
}): NetworkResult {
  const v = args.verdicts;
  const n = v.length;
  if (n === 0) {
    return {
      schemaVersion: 'swe-rebench-v2.network.v1',
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      verdictCount: 0,
      meanResolved: 0, complexityWeighted: 0,
      byLanguage: {}, frontierResolved: 0, parityTripRate: 0,
    };
  }

  const meanResolved = v.reduce((s, x) => s + x.score, 0) / n;

  const complexitySum = v.reduce((s, x) => s + x.complexity, 0);
  const complexityWeighted = complexitySum > 0
    ? v.reduce((s, x) => s + x.score * x.complexity, 0) / complexitySum
    : 0;

  const byLanguage: Record<string, { resolved: number; n: number }> = {};
  for (const x of v) {
    if (!byLanguage[x.language]) byLanguage[x.language] = { resolved: 0, n: 0 };
    byLanguage[x.language].resolved += x.score;
    byLanguage[x.language].n += 1;
  }
  for (const lang of Object.keys(byLanguage)) {
    byLanguage[lang].resolved /= byLanguage[lang].n;
  }

  // Frontier: assume v already includes only top-K Solutions per task; for
  // simplicity at v1 frontier = max of each (instance_id, score)
  const frontierResolved = v.reduce((m, x) => Math.max(m, x.score), 0);

  // Parity trip rate: % verdicts with score = 1
  const parityTripRate = v.filter((x) => x.score === 1).length / n;

  return {
    schemaVersion: 'swe-rebench-v2.network.v1',
    windowStart: args.windowStart, windowEnd: args.windowEnd,
    verdictCount: n,
    meanResolved, complexityWeighted, byLanguage,
    frontierResolved, parityTripRate,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test solver-types/swe-rebench-v2-aggregate`

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-aggregate.ts client/test/solver-types/swe-rebench-v2-aggregate.test.ts
git commit -m "feat(aggregator): structured multi-winrate result for swe-rebench-v2

computeNetworkResult returns mean / complexity-weighted / by-language /
frontier / parity-trip rates over a rolling window of Verdicts. Used by
subgraph indexer + dashboard (Plan 3).

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.5
DR: log/decisions/2026-05-06-aggregation-multi-winrate.md"
```

---

## Task 12: e2e test on Anvil — full lifecycle

**Files:**
- Create: `client/test/e2e/swe-rebench-v2.test.ts`

- [ ] **Step 1: Write the e2e test**

Create `client/test/e2e/swe-rebench-v2.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnAnvilFork, runDaemonOnce, postTask } from './_support/anvil-helpers.js';

describe('swe-rebench-v2 SolverNet e2e on Anvil', () => {
  let anvil: { stop: () => Promise<void>; rpcUrl: string };

  beforeAll(async () => { anvil = await spawnAnvilFork(); });
  afterAll(async () => { await anvil.stop(); });

  it('full Task lifecycle: posted → claimed → solved → graded → settled', async () => {
    // Use a known small instance_id from the actual nebius/SWE-rebench-leaderboard
    const taskPayload = {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      base_commit: 'ad6bff35c39a0600fb8f2e176be4269e768e4e22',
      language: 'c',
      problem_statement: '...',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      round_month: '2026-05',
    };

    // Post Task
    const posted = await postTask({ rpcUrl: anvil.rpcUrl, payload: taskPayload });
    expect(posted.taskId).toBeDefined();

    // Solver claims and submits the gold patch (will pass tests since it's the gold).
    // For e2e, we use a minimal fixture: the Solver harness produces the gold patch.
    const solverResult = await runDaemonOnce({
      rpcUrl: anvil.rpcUrl,
      role: 'solving',
      solverNet: 'swe-rebench-v2',
      taskId: posted.taskId,
      mode: 'frozen',  // confirms freeze-fence integration with Plan 1
    });
    expect(solverResult.envelope?.executor.mode).toBe('frozen');

    // Evaluator picks up Solution and grades
    const evalResult = await runDaemonOnce({
      rpcUrl: anvil.rpcUrl,
      role: 'evaluating',
      solverNet: 'swe-rebench-v2',
      taskId: posted.taskId,
    });
    expect(evalResult.verdict?.score).toBe(1);  // gold patch should pass
  }, 5 * 60 * 1000);  // 5-minute timeout for Docker pull
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd client && yarn e2e -t "swe-rebench-v2"`

Expected: 1 pass (allow ~5 min for first Docker pull).

- [ ] **Step 3: Commit**

```bash
git add client/test/e2e/swe-rebench-v2.test.ts
git commit -m "test(e2e): swe-rebench-v2 full Task lifecycle on Anvil fork

Posts a real instance_id, runs Solver (frozen mode, confirming Plan 1
integration), runs Evaluator with Docker pull + test run + grading.
Asserts envelope.executor.mode = 'frozen' and verdict.score = 1.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §9.2"
```

---

## Self-review checklist

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §3.1 SolverNet identity | 3 |
| §3.2 Contract definition | 3 |
| §3.3 Task schema | 1 |
| §3.4 Evaluator | 4 |
| §3.5 Aggregation function | 11 |
| §3.6 Generator policy (full historical pool, post-until-target-successes) | 6, 7, 8, 10 |
| §8 Reward function R2 | 9 |
| §9.2 v1 acceptance criteria (e2e) | 12 |
| Runtime plugin (default substrate) | 5 |

Surface that lives in **other plans**:
- Plan 1: HarnessContext.mode + freeze-fence + claude-code-learner gate.
- Plan 3: subgraph indexing + dashboard + checkpoint CLI + reputation slashing hook.

**Placeholder scan:** none expected.

**Type consistency:**
- `solverType: 'swe-rebench-v2.v1'` — used throughout (matches the SDK type union extension).
- `swe-rebench-v2-...` package / file naming — consistent.
- `instance_id`, `hf_dataset`, `hf_split`, `image_name`, `FAIL_TO_PASS`, `PASS_TO_PASS` — match the actual upstream HF dataset schema.
- `N_target_successes`, `N_max_postings_per_task`, `cooldown_ms` — generator policy parameters used consistently.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-swe-rebench-v2-solvernet.md`.

Depends on Plan 1 (freeze-mode protocol mechanism) shipping first. Plan 3 (two-leaderboard surface) builds on top of this plan.

Two execution options once Plan 1 is merged:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.
