# Jinn-repo generative loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `jinn-repo` a real SolverType the learner **trains on**: real merged-PR tasks flow into the live claim→execute→deliver loop, the solver checks out `mono@base_commit` and produces a patch, the evaluator grades it, and the Improve/Memory phases mutate the harness — building agentic capability on the Jinn corpus. Then launch it as a SolverNet.

**Why this exists:** the prior branch (`2026-06-08-jinn-improves-jinn.md`) built the **corpus** (PRs → `(task, repro, check)` + admission gate), the **evaluator** (`JinnRepoEvaluator`), and the **benchmark** (`jinn eval` backend). That is the scoreboard, not the engine. `jinn eval` runs **frozen** — it measures, it cannot train. This plan builds the engine: the generative training loop, then the SolverNet.

**Reused foundations (already shipped, do NOT rebuild):**
- `JinnRepoTaskSchema`, `JinnRepoPoolItem`, `solverView` — `client/src/solver-types/jinn-repo.ts`, `_jinn-repo-pool.ts`
- `JinnRepoEvaluator.grade(...)`, repo-native `runJinnRepoEval` — `client/src/harnesses/impls/jinn-repo-evaluator/`
- admission gate `validateAdmissible`, pool/slate builder — `jinn-repo-admit.ts`, `client/scripts/build-jinn-repo-pool.ts`
- `loadJinnRepoPool` / `resolveJinnRepoSlate` — `_jinn-repo-pool.ts`

**Tech stack:** TypeScript/Node22/Yarn/Vitest; the learner harness (claude-code/codex); the daemon creator + engine loops; Anvil fork for local settlement.

---

## Two stages (Gall: train locally before launching on-chain)

- **Stage 1 — the engine (G1–G5):** register `jinn-repo.v1` end-to-end, build the solver side + generator, and prove the **full loop trains** on real Jinn tasks against a **local/Anvil** settlement (no mainnet/testnet chain, no public launch). This is "the learner gets better at real Jinn work."
- **Stage 2 — the SolverNet (G6):** author + launch a `jinn-repo.v1` SolverNet manifest (the launch state machine already exists), anchor it on-chain via `IdentityRegistry.setMetadata`, let operators join by `manifestCid`. This is the actual deployed SolverNet.

Stage 1 is the point ("build capability"); Stage 2 makes it a network. Each Gn is its own plan producing testable software; **G1 is fleshed below**, G2–G6 are scoped (expand into their own plans as you reach them — their interfaces depend on the prior stage).

| Plan | Subsystem | Produces | Depends on |
|---|---|---|---|
| **G1** | SolverType registration | `jinn-repo.v1` recognized end-to-end (schemas, SDK contract, `SOLVER_TYPES`, payload registry) | shipped corpus/evaluator |
| **G2** | Evaluator **Harness** | live-loop grading: `JinnRepoEvaluatorHarness` (wraps `JinnRepoEvaluator`) in `buildHarnesses` | G1 |
| **G3** | Solver side | repo checkout runtime-plugin + `jinn-repo` patch harvest → `jinn-repo-solution.v1` | G1 |
| **G4** | Generator + train-stream | `makeJinnRepoGenerator` posts the train split (held-out excluded); launched-record factory + dispatch | G1 |
| **G5** | Local e2e | Anvil/local-adapter test: post → claim(train) → checkout → patch → grade → Improve mutates harness | G2,G3,G4 |
| **G6** | SolverNet launch | authored manifest + launch; on-chain anchor; operator join | G1–G5 |

---

## G1 — SolverType registration

**Goal:** `jinn-repo.v1` is a first-class SolverType the daemon recognizes: solution/verdict schemas, an SDK `SolverNetContract`, a `SolverTypeDefinition` in `SOLVER_TYPES`, and payload-registry entries so MCP submit + harvest normalization work. No live behaviour yet — that's G2–G4.

### G1 file structure
- Create `client/src/types/jinn-repo-payloads.ts` — `JinnRepoSolutionPayloadSchema`, `JinnRepoVerdictPayloadSchema` (Zod).
- Modify the payload registry (find `SOLVER_TYPE_PAYLOADS` — per investigation likely `client/src/types/payloads/` or similar; grep for `SOLVER_TYPE_PAYLOADS`) to add `'jinn-repo.v1'` → `{ restoration: solution, evaluation: verdict }`.
- Modify `packages/sdk/src/contracts.ts` — add `JINN_REPO_V1_SOLVER_NET_CONTRACT` + register in `SOLVER_NET_CONTRACTS`.
- Modify `client/src/solver-types/jinn-repo.ts` — add the `SolverTypeDefinition` export (the file currently only has the task schema).
- Modify `client/src/solver-types/index.ts` — register in `SOLVER_TYPES`.

### Task G1.1 — solution + verdict payload schemas

**Files:** Create `client/src/types/jinn-repo-payloads.ts`; Test `client/test/types/jinn-repo-payloads.test.ts`. Mirror `swe-rebench-v2` solution/verdict schemas.

- [ ] **Step 1 — failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { JinnRepoSolutionPayloadSchema, JinnRepoVerdictPayloadSchema } from '../../src/types/jinn-repo-payloads.js';

describe('jinn-repo payloads', () => {
  it('accepts a solution payload', () => {
    expect(JinnRepoSolutionPayloadSchema.parse({ schemaVersion: 'jinn-repo-solution.v1', patch: 'diff --git ...' }).patch).toBeDefined();
  });
  it('rejects a solution with empty patch', () => {
    expect(() => JinnRepoSolutionPayloadSchema.parse({ schemaVersion: 'jinn-repo-solution.v1', patch: '' })).toThrow();
  });
  it('accepts a verdict payload', () => {
    expect(JinnRepoVerdictPayloadSchema.parse({ schemaVersion: 'jinn-repo-verdict.v1', passed: true }).passed).toBe(true);
  });
});
```

- [ ] **Step 2** — run, verify FAIL: `cd client && yarn vitest run test/types/jinn-repo-payloads.test.ts`

- [ ] **Step 3 — implement**

```typescript
// client/src/types/jinn-repo-payloads.ts
import { z } from 'zod';

export const JinnRepoSolutionPayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-solution.v1'),
  patch: z.string().min(1), // unified diff of the candidate fix (test hunks stripped)
});
export type JinnRepoSolutionPayload = z.infer<typeof JinnRepoSolutionPayloadSchema>;

export const JinnRepoVerdictPayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-verdict.v1'),
  passed: z.boolean(),                 // gold tests PASS with the candidate patch
  test_log_excerpt: z.string().optional(),
});
export type JinnRepoVerdictPayload = z.infer<typeof JinnRepoVerdictPayloadSchema>;
```

- [ ] **Step 4** — run, verify PASS (3). **Step 5** — `yarn typecheck`; commit `feat(jinn-repo): solution + verdict payload schemas`.

### Task G1.2 — SDK SolverNetContract

**Files:** Modify `packages/sdk/src/contracts.ts`; Test `packages/sdk/test/contracts.jinn-repo.test.ts` (mirror an existing contracts test). Mirror `SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT` (`packages/sdk/src/contracts.ts:149-206`).

- [ ] **Step 1 — failing test:** `getSolverNetContract({ id: 'jinn-repo', version: 'v1' })` returns a contract with `evaluationFunction.implementation === 'client/src/harnesses/impls/jinn-repo-evaluator'` and task/solution/verdict schemas present.

- [ ] **Step 2** — run, verify FAIL.

- [ ] **Step 3 — implement** `JINN_REPO_V1_SOLVER_NET_CONTRACT` (id `jinn-repo`, version `v1`, name "Jinn repo"), schemas = `{ task: JinnRepoTaskSchema (the solver-visible task), solution: JinnRepoSolutionPayloadSchema, verdict: JinnRepoVerdictPayloadSchema }` (zod + `zodToJsonSchema`), `claimPolicyDefaults` (mirror swe-rebench: parallel, maxClaims 5, lease 3600), `credentialRequirements` (creator/solver/evaluator — solver needs git+public GitHub read; evaluator needs the repo-native runner, no Docker), `evaluationFunction.implementation: 'client/src/harnesses/impls/jinn-repo-evaluator'`, `aggregationFunction` (mirror swe-rebench multi-winrate, windowDays 30). Register in `SOLVER_NET_CONTRACTS` under `'jinn-repo.v1'`.

- [ ] **Step 4** — run, verify PASS. **Step 5** — `yarn typecheck` (build the SDK if needed); commit `feat(jinn-repo): SDK SolverNet contract`.

### Task G1.3 — SolverTypeDefinition + registration

**Files:** Modify `client/src/solver-types/jinn-repo.ts`; Modify `client/src/solver-types/index.ts`; Modify the `SOLVER_TYPE_PAYLOADS` registry; Test `client/test/solver-types/jinn-repo-definition.test.ts`. Mirror `sweRebenchV2` (`swe-rebench-v2.ts:908-933`).

- [ ] **Step 1 — failing test:** `SOLVER_TYPES['jinn-repo.v1']` exists; `.solverType === 'jinn-repo.v1'`; `parseSpec(validTask)` resolves `{ spec }`; `loadHeldOutSlate('v1')` resolves the jinn-repo slate; and `SOLVER_TYPE_PAYLOADS['jinn-repo.v1'].restoration` parses a solution payload.

- [ ] **Step 2** — run, verify FAIL.

- [ ] **Step 3 — implement** the `jinnRepo: SolverTypeDefinition` export: `solverType: 'jinn-repo.v1'`, `parseSpec(raw)` → `{ window: undefined, spec: JinnRepoTaskSchema.parse(raw), eligibility: {} }`, `buildGenerator: (cfg) => makeJinnRepoGenerator(cfg)` (forward-declared; G4 implements `makeJinnRepoGenerator` — for G1, a minimal generator that returns `null`, replaced in G4), `loadHeldOutSlate: (v) => loadHeldOutSlate('jinn-repo.v1', v)`, `ui: { description: 'Real merged Jinn-Network/mono PRs', category: 'code' }`. Register in `SOLVER_TYPES` (index.ts) and add `'jinn-repo.v1'` → `{ restoration: JinnRepoSolutionPayloadSchema, evaluation: JinnRepoVerdictPayloadSchema }` to `SOLVER_TYPE_PAYLOADS`.

- [ ] **Step 4** — run, verify PASS. **Step 5** — `yarn typecheck`; commit `feat(jinn-repo): SolverTypeDefinition + registration`.

### G1 self-review
- All five registration surfaces touched (payloads, SDK contract + map, SolverTypeDefinition + SOLVER_TYPES, payload registry). The daemon now *recognizes* `jinn-repo.v1` but does no live work yet.
- No behaviour beyond recognition (YAGNI) — generator is a stub until G4; evaluator-as-Harness is G2.
- Type consistency: `JinnRepoSolutionPayload`/`JinnRepoVerdictPayload` are the single payload shapes used by the SDK contract, the payload registry, the harvest (G3), and the evaluator harness (G2).

---

## G2 — Evaluator Harness (scoped)

**Goal:** the live daemon needs a `Harness` (not just the `JinnRepoEvaluator` class) that claims `role: 'evaluation'` jinn-repo tasks and grades them. Mirror `SweRebenchV2EvaluatorHarness` (`client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts`).
**Files:** `client/src/harnesses/impls/jinn-repo-evaluator/harness.ts` (`JinnRepoEvaluatorHarness implements Harness`, `supports({solverType:'jinn-repo.v1', role:'evaluation'})`, delegates to the existing `JinnRepoEvaluator`, emits a `jinn-repo-verdict.v1` payload); register in `buildHarnesses` (`client/src/harnesses/impls/index.ts`). **Key:** the evaluator receives the full pool item (gold tests); it resolves `gold_tests`/`solution_patch` for the task's `instance_id` from the local pool (`loadJinnRepoPool`).

## G3 — Solver side (scoped)

**Goal:** a solver agent, given `solverView(task)`, checks out `mono@base_commit`, fixes the problem, and produces a `jinn-repo-solution.v1` patch.
**Files:**
- `client/plugins/jinn-repo-runtime/skills/task/SKILL.md` — instruct the agent to materialize `$workingDir/repo` via `git init && git remote add origin https://github.com/Jinn-Network/mono.git && git fetch --depth 1 origin <base_commit> && git checkout FETCH_HEAD` (mirror `client/plugins/swe-rebench-v2-runtime/skills/task/SKILL.md:23-37`).
- `client/src/harnesses/impls/learner/harvest.ts` — add `maybeMaterializeJinnRepoPatchPayload(workingDir, task)` gated on `task.solverType === 'jinn-repo.v1' && role !== 'evaluation'`: `git -C repo diff --binary` → `stripTestPathHunks` → write `{ schemaVersion: 'jinn-repo-solution.v1', patch }`. Wire it into the harvest dispatch alongside the swe-rebench one (generalize the dispatch rather than copy-paste if clean).
- Register the runtime plugin so a joined `jinn-repo.v1` operator loads it (mirror swe-rebench-v2-runtime registration).
**Acceptance:** unit test the harvest (git-diff + strip → payload) with a temp git repo fixture; MCP `submit_typed_payload` validates against the G1 payload schema automatically.

## G4 — Generator + train-stream (scoped)

**Goal:** post the **train split** (admitted pool minus held-out slate) into the loop so the learner trains.
**Files:**
- `client/src/solver-types/jinn-repo-auto.ts` — `makeJinnRepoGenerator(config)` and `makeJinnRepoGeneratorForLaunchedRecord(opts)`: read `loadJinnRepoPool()`, `excludeHeldOutSlate(pool, slate.instanceIds)`, select candidates not yet at target successes, build `Task[]` (`solverType: 'jinn-repo.v1'`, `spec: solverView(item)`, window, claimPolicy, `solverNetManifestCid`). Mirror `makeSweRebenchV2Generator` (`swe-rebench-v2.ts:430-933`) but the pool is local (no HuggingFace). Replace `buildGenerator` stub from G1.3.
- `client/src/solvernets/launched-record-dispatcher.ts` — add `jinnRepo` to `LaunchedRecordGeneratorFactories`, `defaultFactories()`, and the `wireLaunchedRecordGenerators` dispatch (match `contract.id === 'jinn-repo'`).
**Local feed (no on-chain launch):** to train Stage-1 without a public SolverNet, generate tasks carrying a **local** `solverNetManifestCid` and add a matching `joinedSolverNets[<cid>]` entry (roles `['solver','evaluator']`); settle via the local/Anvil adapter (G5). Document this local-manifest recipe.

## G5 — Local e2e validation (scoped)

**Goal:** prove the full loop **trains** on real Jinn tasks end to end, locally.
**Files:** `client/test/e2e/jinn-repo-train-loop.e2e.test.ts` (or extend the daemon-harness e2e). Use the Anvil-fork harness (`client/test/_support/chain/anvil.ts`, `spawnAnvilFork`/`spawnAnvilFromState`) + a locally-deployed router, OR the in-memory `local` adapter. Flow: build a tiny admitted pool from 1–2 real PRs (reuse `build-jinn-repo-pool.ts` against the local checkout) → generator posts a train task → daemon (mode `train`) claims → solver checks out + patches → `JinnRepoEvaluatorHarness` grades → verdict delivered → assert the Improve/Memory phase ran and `implStateDir` changed (a learning commit). **This is the milestone-adjacent proof: the harness measurably mutated from a real Jinn task.** Heavy (clone+install) — env-gated like the other jinn-repo e2e.

## G6 — SolverNet launch (scoped, Stage 2)

**Goal:** the actual deployed SolverNet.
**Files/steps:** author a `jinn-repo.v1` SolverNet manifest (contract from G1.2), run the launch state machine (`client/src/solvernets/launch-state-machine.ts`: pin → record → `IdentityRegistry.setMetadata` → confirm → spawn generator); the launched record drives the G4 generator. Operators join via `joinedSolverNets[<manifestCid>]`. Decision to confirm before G6: testnet first (Base Sepolia) vs mainnet; pricing (`solutionPriceWei`/`verdictPriceWei`); `openRoles`. **This is where "we deployed a new SolverNet" becomes true.**

---

## Honest sequencing note

The corpus + evaluator + benchmark from the prior branch are the foundation this reuses — not throwaway. But the **engine** is G1–G5 and the **SolverNet** is G6; none of it existed before this plan. G1–G3 are the critical path to "a solver can attempt a real Jinn task"; G4–G5 are "the learner trains on them"; G6 is "it's a live network." Build in order; do not skip to G6 (a launched SolverNet with no working solver/evaluator/generator posts tasks nothing can solve).
