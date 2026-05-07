---
title: Agent-harness SolverNet — design exercise output
date: 2026-05-06
author: opus (drafted on jinn-mono-9fe5; Captain ritsukai)
status: design-locked — ready for implementation plan
version: 0.1
---

**Sibling specs (load-bearing pre-reads):**

- `spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 — SolverNet identity model (`{contract.id, contract.version}` + `manifestCid`); `solverType` removed; this spec uses the v0.2 vocabulary throughout.
- `spec/2026-05-01-harness-pack-architecture.md` v0.9 — Harness / SolverPlugin / SolverNet vocabulary; protocol authority for SolverType wire shape sits in the in-tree contract registry.
- `spec/2026-05-02-role-native-sdk-package-architecture.md` v0.2 — `@jinn-network/sdk/harness` is the canonical Harness contract surface; SolverNet contracts live in `@jinn-network/sdk/solvernets`.
- `spec/2026-04-30-phase-a-umbrella.md` — Phase A.1 substrate (corpus library, gating fix, manifest hygiene). This spec extends Phase A by adding a second SolverNet.
- `spec/2026-04-30-plug-in-surface.md` — Path 1 / Path 2 recruitment paths. This spec preserves both: the freeze contract is at the Harness-interface level so any Path-2 harness participates without forking claude-code-learner.
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` — the seven-phase pipeline this spec gates Improve and Memory phases of in frozen mode.
- `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` — envelope schema, tier semantics, source bundle pattern; this spec adds `Executor.mode` and reuses the source-bundle pattern for HarnessCheckpoint publication.
- `contracts/src/staking/RestorationActivityCheckerV2.sol` — already-shipped SimHash anti-farming decay; this spec composes against it as defence-in-depth.

**Discussion lineage:**

- [#59](https://github.com/Jinn-Network/mono/discussions/59) — knowledge-market roadmap. The "self-improving harness as the strongest expression of the loop" framing in §1 is what this spec operationalises through train mode + corpus reads + Improve phase. The "open population producing a richer base than any one shop can match" claim is what frozen mode is designed to make externally citable.
- [#57](https://github.com/Jinn-Network/mono/discussions/57) — Prediction SolverNet GTM. This spec adds a second SolverNet that runs alongside `prediction.v1`, broadening the recruitment surface from forecasters to coding-agent builders.
- PR [#94](https://github.com/Jinn-Network/mono/pull/94) — claude-code-learner plugin simplification + Jinn-vocabulary decoupling. This spec adds one orchestrator-level config gate (`mode` parameter) that disables Improve and Memory phase invocations in frozen mode.

**Bead lineage:**

- `jinn-mono-9fe5` — the dispatched design Task this spec is the output of.

---

## TL;DR

A second SolverNet — `swe-rebench-v2` — runs alongside `prediction.v1`. Tasks are pulled from the Nebius / SWE-rebench-team's `nebius/SWE-rebench-leaderboard` HuggingFace dataset (~50 fresh GitHub-issue tasks per month, multi-language, CC-BY-4.0 dataset + MIT eval harness, deterministic per-instance Docker grading). The full historical pool of monthly partitions (~750 tasks at v1 launch, growing ~50/month) is available to the task generator as the active task surface. Operators run their existing Harness against these Tasks; the substrate's continuous Improve loop evolves the harness against fresh content; anti-farming SimHash decay defends against residual within-task contamination via the post-until-target-successes generator policy (DR-i).

**The substrate is not a benchmark — it is a training environment.** Mutating, evolving harnesses do not have clean benchmark scores; static benchmarks measure frozen artifacts. The bridge between the two is **frozen mode**: a Harness-interface contract that any Harness package can satisfy. When `ctx.mode === 'frozen'`, the harness MUST NOT write to `implStateDir`. The daemon enforces via pre/post hash-fence; subgraph-level cross-envelope consistency, cross-operator forking validation, source-bundle publication, and ReputationRegistry slashing layer on top.

In frozen mode, an operator's harness produces Solutions whose Verdicts attribute to a single stable `(implName, version, codeDigest)` identity. That identity has a clean benchmark score directly comparable to traditional harness leaderboards (OpenHands, SWE-Agent, Aider, Pi.dev, etc.). Published as a `HarnessCheckpoint` (forkable starting state, IPFS-pinned source bundle + implStateDir CID, ERC-8004-anchored), the checkpoint is what external comms anchor on.

Two leaderboards: train-mode rollups (substrate-flow metric, training progress) and frozen-mode rollups (per-checkpoint clean scores, externally comparable). Both are derived from the same Verdict stream. The substrate produces checkpoints; checkpoints compete on traditional benchmark turf; the corpus + Improve loop is what makes the next checkpoint stronger than the last.

The design exercise's **headline finding**: *Jinn's substrate is structurally a training environment, not a benchmark; freeze mode is the discipline that crystallises flow into externally-comparable artifacts. The substrate-flow story and the frozen-checkpoint story are two layers of the same protocol, not in tension.*

---

## 1. Purpose and scope

### 1.1 What this spec commits

1. A new SolverNet contract `swe-rebench-v2` v1.0.0 in `packages/sdk/src/contracts.ts`, sibling to `PREDICTION_V1_SOLVER_NET_CONTRACT`. Pulls Tasks from `nebius/SWE-rebench-leaderboard` monthly partitions (full historical pool); deterministic per-instance Docker test-suite grading via the `docker.io/swerebenchv2/...` image namespace; CC-BY-4.0 dataset + MIT eval harness.
2. A protocol-level **frozen-state contract** added to the `Harness` interface in `@jinn-network/sdk/harness`: a new `mode: 'train' | 'frozen'` field on `HarnessContext` and `Executor`. When `ctx.mode === 'frozen'`, harness implementations MUST NOT write to `ctx.implStateDir`.
3. A daemon-level enforcement mechanism: pre/post hash-fence around each Task; envelope rejection on violation; rollback to pre-Task state.
4. A subgraph + dashboard split: train-mode and frozen-mode rollups indexed separately; verified vs unverified frozen distinction surfaced in the leaderboard.
5. A `HarnessCheckpoint` artifact concept: a published frozen state (source bundle CID + implStateDir CID + signed manifest, anchored via `IdentityRegistry.setMetadata`). Forkable; externally citable; the artifact-level entity.
6. Vocabulary alignment with `opus/solvernet-creation-and-launch` v0.2 (no `solverType`) and AI/ML conventions (`train` / `frozen`, `HarnessCheckpoint`).

### 1.2 In scope

- The `swe-rebench-v2` SolverNet contract definition (schemas, evaluator, aggregation, default substrate plugins).
- The freeze contract added to the Harness interface and the daemon's hash-fence enforcement.
- claude-code-learner's mode-aware orchestrator gate (one config flag; Improve and Memory phase invocations gated on `mode === 'train'`).
- Subgraph indexing of `Executor.mode`; dashboard rollups.
- HarnessCheckpoint manifest schema + `jinn checkpoint publish` / `install` CLI verbs (with publication deferrable to v1.5 if scope-pressured).
- Trust-stack composition: daemon hash-fence + subgraph cross-envelope consistency + cross-operator forking validation + source-bundle publication + ReputationRegistry slashing.

### 1.3 Out of scope

- New SolverTypes beyond `swe-rebench-v2` (apex-agents, GDPval, LiveBench, SWE-rebench V2 are filed as future workstreams; see §11).
- Per-SolverNet mode scope (v1 ships per-daemon mode; per-SolverNet partitioning of implStateDir is a v1.5+ workstream if demand emerges).
- Round-commitment mechanism (operators ad-hoc going frozen in v1; explicit `jinn checkpoint commit-to-round <round-id>` registration is v2 if volume warrants).
- Multi-judge consensus for the evaluator (v1 ships single-judge or single-deterministic; multi-judge consensus on judge-graded benchmarks like apex/GDPval is the canonical Phase B.2 evaluator-economics work).
- Builder-direct rewards for HarnessCheckpoint publication (e1/e2 from earlier discussion remain deferred per Captain decision).
- TEE-attested freeze enforcement (Phase B.1 attested-tier work; v1 self-signed tier with the layered trust stack).

### 1.4 Non-goals

- This is not a marketplace spec. SolverNets are launched via the existing `2026-05-05-solvernet-creation-and-launch.md` v0.2 mechanism; this spec adds one new SolverNet contract, not a marketplace primitive.
- This is not a substrate redesign. The corpus library, Improve loop, producer-consumer overlap mechanism are unchanged. This spec composes on top.
- This is not a benchmark generator. We use Nebius/SWE-rebench-team's SWE-rebench v2 as-is via the `nebius/SWE-rebench-leaderboard` HF dataset; we do not curate, augment, or regenerate Tasks.

---

## 2. Design exercise summary — what we discovered

### 2.1 What the original Task asked

`jinn-mono-9fe5` was dispatched to design a SolverNet whose purpose is to make better and better agent harnesses, using a benchmark score as the aggregating function. The implicit framing assumed a single SolverNet design that would (a) post benchmark Tasks, (b) reward harnesses for solving them, and (c) compound harness quality through repeated iterations.

### 2.2 What the design exercise discovered

Three findings, each strictly stronger than the prior assumption:

1. **A standalone "harness SolverNet" doesn't earn substrate value over a centralised leaderboard.** A SolverNet whose only purpose is "post benchmark Tasks, reward solvers" is functionally equivalent to a tokenised leaderboard. Without continuous fresh task supply or the producer-consumer overlap mechanism firing, it is leaderboard-with-token-rewards — not substrate.

2. **Finite-pool benchmarks (apex-agents, GDPval) cannot be substrate-shaped.** With corpus reads + Improve loop + recycling Tasks, the producer-consumer overlap converges to memorisation. Future operators read past trajectories and submit near-equal deliverables on Tasks they recognise. Anti-farming decay reduces the economic incentive but does not eliminate the structural problem; the corpus on a finite pool becomes inert / contaminated regardless of reward distribution.

3. **Fresh-supply benchmarks (SWE-rebench v2, SWE-rebench V2, LiveBench) restore substrate viability.** Monthly fresh Task drops + time-window-based contamination protections give the producer-consumer overlap a constantly-replenishing surface; the corpus mechanism fires; the substrate compounds. Plus anti-farming decay as defence-in-depth.

4. **Continuous-substrate-only still has a "no externally-comparable harness" gap.** Operator harnesses mutate via Improve in flight; codeDigest changes after every Task; no `(implName, codeDigest)` runs the slate cleanly. Per-codeDigest rollups are confounded by Task-subset selection. The substrate has network-level metrics ("the network is improving over time") but no artifact-level claim ("this specific harness scored Y on the benchmark").

5. **Frozen mode bridges this.** A Harness-interface contract: when `ctx.mode === 'frozen'`, no writes to implStateDir. codeDigest stable across the frozen window. Verdicts attribute to a single artifact identity. Externally comparable to OpenHands, SWE-Agent, etc. The substrate produces checkpoints; checkpoints compete on traditional benchmark turf; both compose.

### 2.3 The headline finding

> **Jinn's substrate is structurally a training environment, not a benchmark. Frozen mode is the discipline that crystallises the flowing substrate into externally-comparable artifacts. The substrate-flow story and the frozen-checkpoint story are two layers of the same protocol, not in tension.**

This is the spec's organising thesis. Every concrete commitment that follows (SolverNet contract shape, freeze contract mechanics, two-leaderboard dashboard, HarnessCheckpoint artifact) is in service of this finding.

---

## 3. The `swe-rebench-v2` SolverNet

### 3.1 Identity

Per `spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 §2 principle 5, SolverNet contracts are identified by `{contract.id, contract.version}`; launched-instance authority is the `manifestCid`. The contract `swe-rebench-v2` v1.0.0 lives in `packages/sdk/src/contracts.ts` next to `PREDICTION_V1_SOLVER_NET_CONTRACT`.

A launcher creates a launched instance from this template, signs the manifest, anchors via `IdentityRegistry.setMetadata`, IPFS-pins, and starts the launcher-owned Task generator. Operators discover the launched manifest from the registry (subgraph-indexed) and participate as `solving` or `evaluating` per `openRoles`.

The launcher's manifest carries `solutionPriceWei`, `verdictPriceWei`, and `openRoles` per the existing pattern. Multiple launchers can launch independent `swe-rebench-v2` SolverNets with different price/role configs; they are discoverable side-by-side. There is no "canonical" launched instance — the registry surfaces all of them.

### 3.2 Contract definition

```ts
// packages/sdk/src/contracts.ts
export const SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  id: 'swe-rebench-v2',
  version: '1.0.0',

  schemas: {
    task:     SWE_REBENCH_V2_TASK_SCHEMA,      // { instance_id, repo, base_commit, problem_statement, hf_dataset, hf_split, language, interface, deadline }
    solution: SWE_REBENCH_V2_SOLUTION_SCHEMA,  // { patch, trajectory_cid, cost?: { totalUsd } }
    verdict:  SWE_REBENCH_V2_VERDICT_SCHEMA,   // { score: 0|1, passed_match: bool, test_log_cid, evaluator_cost_usd }
  },

  claimPolicyDefaults: {
    maxConcurrentClaimsPerOperator: 5,
    claimTimeoutMs: 60 * 60 * 1000, // 1 hour per Task
  },

  credentialRequirements: {
    solving:    { minReputation: 0 },
    evaluating: { minReputation: 0, requiresBond: true, bondAmountUsdc: '100' },
  },

  evaluationFunction: {
    id: '@jinn-network/swe-rebench-v2-evaluator',
    version: '1.0.0',
    deterministic: true,
  },

  aggregationFunction: {
    id: 'swe-rebench-v2-multi-winrate',
    version: '1.0.0',
    windowing: { kind: 'rolling-days', days: 30 },
  },

  defaultRuntimePlugins: [
    'bundled:network-tools',
    'bundled:swe-rebench-v2-runtime', // contains the SWE-rebench-V2 eval harness wrapper, Anthropic SDK, etc.
  ],
};
```

Schemas, evaluator, and aggregation function are protocol authority; operator config does not redeclare them.

### 3.3 The Task schema (illustrative — based on real `nebius/SWE-rebench-leaderboard` rows)

```jsonc
{
  "instance_id": "unidata__netcdf-c-1925",
  "repo": "Unidata/netcdf-c",
  "base_commit": "ad6bff35c39a0600fb8f2e176be4269e768e4e22",
  "language": "c",
  "problem_statement": "tst_filter does not handle quoted filter args correctly...",
  "interface": "...auxiliary interface info per v2 methodology...",
  "hf_dataset": "nebius/SWE-rebench-leaderboard",
  "hf_split": "2026_02",
  "deadline_unix": 1746547200,
  "round_month": "2026-05"
}
```

The Task payload references the canonical HuggingFace dataset (reference-don't-redistribute pattern). Solvers and evaluators fetch the full task row (including `patch`, `test_patch`, `install_config`, `image_name`, `FAIL_TO_PASS`, `PASS_TO_PASS`) from HuggingFace at solve time using `(hf_dataset, hf_split, instance_id)`. The Jinn on-chain payload stays small (~few KB).

### 3.4 The Evaluator

`@jinn-network/swe-rebench-v2-evaluator` is a thin wrapper around the upstream `SWE-rebench/SWE-rebench-V2/scripts/eval.py` (MIT). It:

1. Fetches the canonical task row from HuggingFace using `(hf_dataset, hf_split, instance_id)`. Reads `image_name`, `install_config.test_cmd`, `install_config.log_parser`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`.
2. Pulls the named Docker image (`docker.io/swerebenchv2/<repo-with-dashes>:<commit-suffix>`). The dataset row carries the full image reference; no name-mangling required.
3. Applies the Solver's submitted patch + the dataset's `test_patch` in a new container instance.
4. Runs `install_config.test_cmd` inside the container.
5. Parses the test log via the named `log_parser` from the upstream `agent.log_parsers` module (timing-suffix normalisation included upstream).
6. Compares actual passed/failed against `FAIL_TO_PASS ∪ PASS_TO_PASS`. Emits Verdict: `{ score: 0|1, passed_match, test_log_cid, evaluator_cost_usd }`.

Deterministic. Anyone can re-run the evaluator on the same Solution against the same Docker image and tag and confirm the score (Docker images are content-addressed by tag; the upstream image registry has 3,632 repos under the `swerebenchv2` namespace, all updated through 2026-04). Challenge arbitration is automatic.

Per-Verdict cost: dominated by Docker image pull (typical image ~900MB) and test-run time. ~few cents of CPU + bandwidth on warm-cache evaluators; first-time pulls are larger. Bonded evaluators absorb this from the Verdict reward share of the Task escrow.

### 3.5 The aggregation function

Returns a structured `swe-rebench-v2-network-result` over the 30-day rolling window:

```ts
interface SWERebenchV2NetworkResult {
  schemaVersion: 'swe-rebench-v2.network.v1';
  windowStart: string; windowEnd: string;
  verdictCount: number; uniqueOperators: number; uniqueCheckpoints: number;

  // Headline win-rates
  meanResolved:           number;  // raw mean Verdict.score
  complexityWeighted:     number;  // weighted by task complexity (LoC × file count proxy)
  byLanguage:             Record<string, { resolved: number; n: number }>; // python / js / ts / go / windows
  frontierResolved:       number;  // mean of top-K Solutions per Task (best-of-network)
  parityTripRate:         number;  // % of Tasks where best-of-network resolved
}
```

`meanResolved` is the OpenAI-comparable "% Pass@1" headline. `complexityWeighted` is the Jinn-native variant that grounds reward distribution in task difficulty (see §8). `byLanguage` is for slicing — language-stratified performance is a real signal (per the SWE-bench Pro paper, JS/TS lag Python by 10+ points for many models; this is a useful diagnostic).

The aggregation runs continuously (per-Verdict or per-batch) and emits a fresh structured result each time. Subgraph indexes the latest result; dashboard surfaces it.

### 3.6 Task generation policy — full historical pool, post until target successes per task

The launcher's Task generator runs against the **full historical pool** of SWE-rebench v2 monthly partitions, not just the current month's drop. This gives the substrate plenty of unsolved task surface even between monthly drops, and lets new operators arriving on the network train on historical content while waiting for the next fresh drop.

The generator implements a **post-until-target-successes** policy across the full pool. This is load-bearing for memorisation resistance — fresh-supply benchmarks (DR-b) handle cross-month memorisation, but within-month memorisation can still emerge if the same task is posted many times: the first successful trajectory enters the corpus and subsequent attempts read it and near-copy. The generator's posting policy bounds this.

For each task in the **full pool** (union of all monthly partitions from `2025_01` onward, currently ~750 unique tasks across 14 months in `nebius/SWE-rebench-leaderboard`, plus next month's drop when it arrives), the generator tracks:

- `posted_count[task]` — number of times this task has been posted on JinnRouter.
- `successful_count[task]` — number of Verdicts with `score === 1` on this task across all postings.

The generator's main loop (illustrative pseudocode):

```ts
const fullPool = unionOfAllMonthlyPartitions(latestMonth); // ~750 tasks initially; grows monthly

for (const task of fullPool) {
  if (successful_count[task] >= N_target_successes) continue;       // saturated; remove from active pool
  if (taskInFlightOnChain(task))                    continue;       // wait for resolution
  if (posted_count[task] >= N_max_postings_per_task) continue;      // capped on impossible tasks
  if (now - last_posted_at[task] < cooldown_window)  continue;      // operator availability window

  await postTaskOnJinnRouter(task);
  posted_count[task] += 1;
  last_posted_at[task] = now;
}
```

Saturated tasks remain in the corpus as historical artifacts: their (up to N) successful trajectories are read by future operators attempting *unsaturated* tasks — that's the producer-consumer overlap doing its job. Saturated tasks are not posted again even after months have passed (the corpus has reached "enough training" on them; reposting would only invite copying).

When the next month's drop arrives (~50 new tasks added to `nebius/SWE-rebench-leaderboard`), they are added to the active pool with fresh counters. The pool grows monthly; the saturated subset grows with operator participation. Equilibrium emerges: as fast as new tasks are added, similar numbers are saturated and retired.

**v1 defaults:**

| Parameter | Default | Rationale |
|---|---|---|
| `N_target_successes` | 3 | Diversity of successful approaches without excessive memorisation surface. After 1-2 successes additional successes contribute diminishing corpus value (they tend to converge); 3 is the sweet spot. |
| `N_max_postings_per_task` | 10 | Cap on impossible tasks. If 10 postings yield zero successes, the task is genuinely beyond current network capability; move on. |
| `cooldown_window` | 24 hours | Operators need time to claim and attempt before reposting. Avoids spam while keeping iteration cadence reasonable. |
| `pool_ordering` | round-robin balanced by language + month | Avoids starvation of older tasks; rotates languages so harnesses can specialise without one-language saturation blocking the rest. |

These are launcher-set parameters in the launched manifest; different launchers can pick different values for their own instance.

**Volume implication.** Full pool ≈ 750 unsaturated tasks at v1 launch × N=3 target successes = up to ~2,250 successful Solutions during the initial saturation phase, plus failed attempts (~5-10× successful counts on hard tasks). Substrate volume on `swe-rebench-v2` is meaningfully larger than I'd estimated under "current-month-only" framing. After initial saturation, equilibrium is ~150 successful Solutions/month from the new monthly drop plus residual unsaturated tasks (impossible-task tail). Operators run `prediction.v1` in parallel for additional Polymarket-fresh substrate flow.

**Why "don't stop at first success."** The first successful Solution is rarely the only good approach; different Harnesses might solve the same task in genuinely different ways (different test-discovery strategy, different patch-generation approach, different multi-file edit ordering). Diversity of successful trajectories in the corpus is itself substrate value. Stopping at N=1 throws this away. N=3 captures most of the diversity surface.

**Why "stop at all."** The corpus's accumulating successful trajectories are the memorisation vector. After 3 successful trajectories appear in the corpus for a task, the marginal copyability outweighs the marginal diversity. Operators 4+ attempting the same task would predominantly read-and-copy. Bounding the surface at N=3 preserves the producer-consumer mechanism's substrate value while capping the copying surface.

**Why include historical months in the active pool.** Two reasons. (1) **Bootstrap volume.** New operators joining the network shouldn't have to wait for next month's drop to find work; ~750 unsaturated tasks across 14 months gives them immediate training surface. (2) **The corpus compounds across the full history.** A 2026-02 task being attempted today benefits from peer trajectories on similar 2025-08 tasks already in the corpus. The producer-consumer overlap operates across the full monthly partition history, not just within one month. Limiting the pool to one month would artificially throw away that compounding surface.

**Multi-launcher concern.** If multiple launchers each launch independent `swe-rebench-v2` SolverNet instances, each runs its own generator policy. Aggregate memorisation surface = N × num_launched_instances. For v1 we expect one canonical launched instance (Jinn-team-operated or aligned launcher); cross-launcher coordination of task assignment is filed as future work for v1.5+ when multiple launchers are demonstrably in flight. Ratified in DR-i.

---

## 4. Benchmark choice — why SWE-rebench v2, what was rejected

### 4.1 Why SWE-rebench v2

- **Continuously fresh supply, verified.** The `nebius/SWE-rebench-leaderboard` HuggingFace dataset has 14 monthly partitions from `2025_01` through `2026_02`, totalling ~750 instances. Last commit 2026-04-22 (~2 weeks before this spec). The cadence is genuinely active — partitions are added with a 2-3 month curation lag (typical for human-verified test cases). This is the property SWE-bench Live's monthly Python promise was supposed to deliver but did not (see §4.2).
- **v2 methodology fits modern frontier models.** No demonstrations in the agent prompt (frontier models don't need them); 80-step limit removed in favour of a 128k context window cap; auxiliary `interface` fields provided per task (function names, signatures, descriptions) to bound task ambiguity without giving away solutions. Paper at arxiv:2602.23866.
- **Deterministic test-suite grading via self-describing Docker images.** Each row carries `image_name` (full Docker reference: `docker.io/swerebenchv2/<repo>:<commit-suffix>`), `install_config.test_cmd`, `install_config.log_parser`. The `swerebenchv2` DockerHub namespace has 3,632 actively-maintained image repositories (verified 2026-05). Re-runnable by anyone with Docker; challenge arbitration is automatic.
- **CC-BY-4.0 dataset + MIT harness.** No "evaluation only" / "no scraping" clauses. Trajectory storage and resale via x402 are within license. Per-instance license disclosure (the dataset row carries the underlying GitHub repo's license at the commit) lets consumers filter on license-compatibility per task — cleaner than blanket licensing.
- **Headroom for measurement.** Frontier scores Claude Opus 4.6 = 65.3% resolved, GPT-5.2-medium = 64.4% on the active leaderboard window (Jan-Mar 2026). 30+ points of headroom below saturation; harness/scaffolding/Improve-loop differences are visible on the leaderboard.
- **Agent-task focus.** Multi-step problem solving, multi-file edits, tool use, test running, log parsing. Harness design is most of the variance.
- **Multi-language by design.** v2 covers C, C++, C#, Go, Java, JavaScript, Rust, TypeScript, and Dart out of the box. Per-language stratification surfaces specialisation as a leaderboard axis.
- **Self-describing eval surface.** The dataset's `install_config` and `image_name` fields mean our evaluator can be a thin wrapper around the upstream `scripts/eval.py` (MIT) — no Docker name-mangling, no per-task config curation on our side.

### 4.2 Alternatives considered and rejected

- **SWE-bench Live (Microsoft).** Was the original v1 candidate before deeper research. The Python-only `SWE-bench-Live/SWE-bench-Live` HF dataset's monthly partition cadence stopped at `202506` (June 2025) — 11 months stale. The team pivoted to `MultiLang` and `Windows` datasets which are fixed snapshots, not monthly-fresh. The README still markets monthly cadence but the data files contradict that. Issue triage on the repo is essentially abandoned (issues from June 2025 unanswered as of May 2026). Microsoft + NeurIPS D&B branding is real but does not compensate for cadence breaking. **Rejected** for v1 substrate use; could be revisited as a fixed-snapshot v2 companion. Worth contacting the maintainers (`SWE-bench-Live@microsoft.com`) to confirm whether the Python pipeline is paused or permanently ended.
- **GDPval (OpenAI).** Considered as the THESIS-aligned choice (44 occupations, knowledge work). Rejected for v1: 220-task gold subset is finite and fixed; continuous-stream over it produces the memorisation vector; round-only operation makes it a tokenised leaderboard, not substrate. Filed as future workstream — pairs with fresh-task-supply infrastructure (LLM-generated tasks from O*NET; Mercor / OpenAI partnership for curated fresh supply).
- **apex-agents (Mercor).** Recruitment-cluster ideal but explicit "no training, no scraping, no programmatic download" clauses make it incompatible with the substrate's redistribution + Improve-loop mechanics. Filed as future workstream pending Mercor partnership conversation.
- **SWE-bench Verified / Pro.** Verified is saturated (70%+ frontier scores → no harness-improvement signal). Pro is a finite 731-task pool with the same memorisation vector as GDPval. Both rejected for v1.
- **LiveBench (LeCun et al).** Multi-domain (coding + math + reasoning + language + instruction-following); fresh supply; broader cluster pull. Rejected for v1: scores are already saturating in the 80s for frontier models; harness improvements have insufficient signal to register on the leaderboard. Tests model capability more than agent harness capability — wrong axis for our purpose.
- **LiveCodeBench (Berkeley/MIT/Cornell).** Coding contests with date-stamped problems; cleanest contamination protection. HF dataset has not been refreshed since 2025-06; the underlying contest stream may be more current via direct integration but no programmatic monthly HF feed for our task generator to consume. Filed as v1.5+ companion if that integration is built.
- **SWE-rebench v1 (the original `nebius/SWE-rebench` paper dataset).** Superseded by v2 (last data update 2025-12-23). The active leaderboard at swe-rebench.com transitioned to v2 methodology in February 2026. v1 methodology had a strict 80-step limit and required demonstrations in prompts — both removed in v2. We adopt v2.

### 4.3 Reference-don't-redistribute principle

A SolverNet design principle worth committing for all benchmark SolverNets, present and future: **Task payloads reference benchmark content (HuggingFace URI, instance_id, etc.); they do not embed it.** Operators fetch from canonical sources at solve time. This sidesteps redistribution licensing for any benchmark whose dataset license permits download (most do; apex-agents is the notable counterexample), keeps Task payloads tiny on IPFS, and inherits canonical-source determinism (every operator reads from the same dataset).

---

## 5. The substrate vs benchmark architecture — train and frozen modes

### 5.1 The structural tension

A traditional benchmark leaderboard works on **frozen artifacts**. A submitter takes `harness@v1.4`, freezes it, runs against the canonical slate, reports a score. That score is comparable across submissions because everyone's harness was the same fixed thing during their slate run. Recruitment, forks, and integrations all anchor on the named artifact.

Jinn's substrate works on **flowing processes**. Operators run continuously; their `implStateDir` mutates via Improve every Task; `(implName, codeDigest)` accumulates Verdicts on whatever subset of Tasks it happened to claim during its lifetime; the harness running at Operator A is structurally different from the same `implName` running at Operator B because their constitutional states diverged. There is no canonical frozen artifact.

These are different kinds of objects. The substrate's continuous compounding and the benchmark's clean frozen scoring want different things.

### 5.2 Resolution: train and frozen modes on the Harness interface

The same Harness package operates in two modes, declared at runtime via the `HarnessContext`:

- **`train` (default).** Improve and Memory phases (or equivalent writeback paths in Path 2 harnesses) write to implStateDir. State mutates; codeDigest changes per Task. Substrate-flow contributor.
- **`frozen`.** Improve and Memory disabled (or equivalent gates in Path 2). State is read-only; codeDigest stable across the entire frozen window. Solutions accumulate Verdicts under one `(implName, version, codeDigest)` identity. Externally-comparable benchmark score.

The flag is a **Harness-interface contract**, not a feature of any specific harness package. claude-code-learner respects it. Path 2 harnesses (Pi.dev port, Stirrup-based, custom) implement the same contract themselves. Stateless harnesses satisfy it trivially. The protocol's contract: `when ctx.mode === 'frozen'`, the harness MUST NOT write to `ctx.implStateDir`.

### 5.3 What this unlocks

Cross-Harness benchmark competition. The frozen-mode leaderboard surfaces multiple distinct Harness packages' frozen states with comparable scores:

```
swe-rebench-v2 frozen-mode leaderboard, May 2026 window:
  ┌───────────────────────────────────────────────────────────────┐
  │ Harness                                       │ Score │ Ops   │
  ├───────────────────────────────────────────────┼───────┼───────┤
  │ claude-code-learner@v1.4 + 6w-trained-state   │  0.71 │   3   │
  │ pi-port@v0.3 + bittensor-corpus-state         │  0.69 │   2   │
  │ stirrup-fork@v2.1 + crypto-trained-state      │  0.66 │   2   │
  │ openhands-bridge@v0.4 + base-state            │  0.55 │   1   │
  │ swe-agent-bridge@v1.0 + base-state            │  0.42 │   1   │
  └───────────────────────────────────────────────┴───────┴───────┘
```

Every row is a different Harness package (or a different state of the same package) evaluated under the same freeze contract. Real harness competition. Real recruitment surface — "ship your harness, run frozen, get a score directly comparable to OpenHands, SWE-Agent, the rest of the field."

The substrate (train mode) trains harnesses; the freeze contract crystallises them; the benchmark SolverNet gives them comparable scores.

---

## 6. The frozen-state contract — full mechanism

### 6.1 Interface contract

```ts
// @jinn-network/sdk/harness — additive to existing HarnessContext
interface HarnessContext {
  // ... existing fields ...
  mode: 'train' | 'frozen';   // NEW
}

interface Executor {            // on every envelope
  implName: string;
  implVersion: string;
  clientGitSha: string;
  codeDigest: string;
  signingKey: string;
  mode: 'train' | 'frozen';   // NEW; defaults to 'train' if absent (back-compat)
}
```

The contract: **when `ctx.mode === 'frozen'`, the harness MUST NOT cause persistent writes to `ctx.implStateDir`.** Reads are unrestricted. Ephemeral writes that net to zero before `run()` returns are allowed. Workingdir scratch (`ctx.workingDir`) is unrestricted.

SDK helper for builders:

```ts
export function requireTrain(ctx: HarnessContext, action: string): void {
  if (ctx.mode === 'frozen') {
    throw new HarnessError(`Cannot ${action} in frozen mode.`);
  }
}
```

Used at write call sites in Path 2 implementations. Optional ergonomics; the contract is the contract.

### 6.2 The trust stack — six layers

The freeze contract is enforced by a layered stack. Each layer addresses a different threat profile.

**Layer 1 — Daemon hash-fence (self-enforcement, immediate).** The operator's daemon hashes `implStateDir` before and after each Task in frozen mode. Mismatch → envelope rejected locally, never submitted on-chain. State rolled back to pre-Task snapshot. Catches honest implementation bugs and operators running stock Jinn code who forgot to gate a write somewhere. See §6.3 for the implementation.

**Layer 2 — Subgraph cross-envelope consistency (passive, post-hoc).** The subgraph indexes every envelope's `(operator_signing_key, mode, codeDigest, timestamp)`. Anyone querying it can verify that an operator's claimed frozen-mode codeDigest is stable across their submission stream. An operator claiming `mode=frozen` for envelopes 1–47 whose codeDigest changes mid-window is publicly observable contradiction. The subgraph exposes this as a queryable consistency property; dashboard surfaces violations.

**Layer 3 — Cross-operator forking validation (active, when checkpoints are forked).** When Operator B installs a HarnessCheckpoint published by Operator A and runs it in frozen mode, B's envelope codeDigest should match A's. Discrepancy implies one party violated the freeze contract or computed their digest wrong. Most powerful when the checkpoint is widely-forked: many independent operators running the same published state all producing matching codeDigests is strong evidence of integrity.

**Layer 4 — Source-bundle publication (independent re-derivation).** Operators who voluntarily publish `source bundle CID + implStateDir CID` enable anyone to independently derive the expected codeDigest from those inputs. The published artifacts on IPFS are ground truth. An operator's envelope claiming a codeDigest that doesn't match what's derivable from their own published bundle is auto-busted. *This is the most powerful verification at v1, and the spec rewards it explicitly via the verified-vs-unverified frozen distinction.*

**Layer 5 — ReputationRegistry slashing (consequences).** Caught freeze-contract violations slash reputation. Higher-stakes claims (HarnessCheckpoints used in external comms, top-of-leaderboard positions) carry larger slash multipliers. Compounds with the existing `RestorationActivityCheckerV2.sol` SimHash anti-farming decay as defence in depth.

**Layer 6 — Phase B.1 attested-tier (future cryptographic enforcement).** Out of v1 scope. When attested tier ships, harnesses run in TEE; attestation cryptographically proves `mode=frozen` and proves no implStateDir mutation occurred. Closes the residual gap entirely. Until then, the layered stack is sufficient for the threat model the SolverNet operates against.

The protocol does **not** require evaluator-level codeDigest verification. The evaluator's per-Task scope cannot naturally do cross-Task consistency, and it cannot independently re-derive codeDigest without source-bundle publication (which only exists at the verified-frozen tier). The subgraph + source-bundle layers cover the same threat at lower cost.

### 6.3 Daemon hash-fence — concrete implementation

The hash function is a deterministic SHA-256 Merkle of `implStateDir` contents:

```ts
// client/src/harness/freeze.ts
export async function hashImplStateDir(dirPath: string): Promise<string> {
  const entries: Array<{ relPath: string; fileHash: string }> = [];
  async function walk(currentPath: string): Promise<void> {
    const items = (await readdir(currentPath)).sort();
    for (const item of items) {
      const full = join(currentPath, item);
      const s = await stat(full);
      if (s.isDirectory()) await walk(full);
      else if (s.isFile()) {
        const content = await readFile(full);
        const fileHash = createHash('sha256').update(content).digest('hex');
        entries.push({ relPath: relative(dirPath, full), fileHash });
      }
    }
  }
  await walk(dirPath);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const combined = entries.map(e => `${e.relPath}:${e.fileHash}`).join('\n');
  return createHash('sha256').update(combined).digest('hex');
}
```

Properties: deterministic, content-addressable, order-stable, dependency-free. Cost is O(total bytes); for a typical claude-code-learner state (a few MB) it is sub-second. Note: this is not an IPFS CID; for verified-frozen publication, the IPFS CID is computed separately when pinning. The codeDigest in the envelope is this Merkle hash.

The fence wraps each frozen-mode Task:

```ts
// client/src/daemon/freeze-fence.ts
export async function runHarnessWithFreezeFence(
  harness: Harness,
  ctx: HarnessContext,
): Promise<FenceResult> {
  if (ctx.mode === 'train') {
    const output = await harness.run(ctx);
    const codeDigest = await hashImplStateDir(ctx.implStateDir);
    return { ok: true, output, codeDigest };
  }

  const stateHashBefore = await hashImplStateDir(ctx.implStateDir);
  const snapDir = await mkdtemp(join(tmpdir(), 'jinn-freeze-snap-'));
  await cp(ctx.implStateDir, snapDir, { recursive: true });

  try {
    const output = await harness.run(ctx);
    const stateHashAfter = await hashImplStateDir(ctx.implStateDir);

    if (stateHashAfter !== stateHashBefore) {
      // VIOLATION: rollback, reject envelope, emit reputation event
      await rm(ctx.implStateDir, { recursive: true });
      await cp(snapDir, ctx.implStateDir, { recursive: true });
      await rm(snapDir, { recursive: true });
      return { ok: false, violation: { /* … */ } };
    }
    await rm(snapDir, { recursive: true });
    return { ok: true, output, codeDigest: stateHashBefore };
  } catch (err) {
    // Defensive rollback even on harness throw
    await rm(ctx.implStateDir, { recursive: true });
    await cp(snapDir, ctx.implStateDir, { recursive: true });
    await rm(snapDir, { recursive: true });
    throw err;
  }
}
```

Edge cases handled:

- Net-zero writes (write then delete in one Task) — hashes match, no violation, fine.
- Harness crashes mid-Task — defensive rollback in `catch` block.
- Subprocess writes (e.g., Claude Code spawning Bash) — hash sees final state regardless.
- Out-of-Task manual edits — fence is per-Task; subgraph cross-envelope consistency catches mid-window codeDigest changes.
- Concurrent Tasks on same daemon — frozen mode is no-write; concurrent reads safe.

Honest limit: this is honor-system at v1. An operator running modified Jinn code can skip the fence and forge codeDigest. The fence catches honest implementation bugs and lazy attackers; layers 2–5 of the trust stack catch determined attackers (subgraph consistency, cross-operator forking validation, source-bundle publication, reputation slashing). Phase B.1 attested tier closes the residual gap.

### 6.4 Verified vs unverified frozen — credibility tiers

The trust stack creates a natural credibility tier the dashboard surfaces explicitly:

- **Verified frozen.** Operator has published source bundle + implStateDir CID via `jinn checkpoint publish`. Anyone can independently derive the expected codeDigest and confirm the envelope's claim. Multiple operators may have forked and run, providing cross-operator validation. Highest credibility. What external comms quotes; what recruitment narratives anchor on; what the SolverNet's headline numbers pull from.
- **Unverified frozen.** Operator has not published source-bundle / implStateDir. Their codeDigest is internally consistent across their envelope stream (subgraph confirms) but cannot be independently re-derived. Lower credibility. Useful for operator-internal A/B testing or training-progress tracking; not a defensible external claim.

The frozen-mode leaderboard SPA visually distinguishes these (verification badge next to verified entries; sort defaults preferring verified). External claims and headline numbers pull from verified entries only.

This creates the right incentive: operators who care about external credibility publish their bundles; operators who don't, don't bother. Free market for verification effort.

---

## 7. The HarnessCheckpoint artifact

### 7.1 What a HarnessCheckpoint is

A published frozen state. The artifact-level entity that bridges the substrate's flow and the benchmark's frozen-artifact model. Manifest schema:

```jsonc
{
  "schemaVersion": "harness.checkpoint.v1",
  "name": "@some-team/claude-code-learner-fork",
  "version": "2.1.4",
  "parentCheckpointCid": "bafy…",          // null if scratch; otherwise the checkpoint this was forked from
  "harnessPackage": {
    "implName": "claude-code-learner-fork",
    "implVersion": "2.1.4",
    "clientGitSha": "0xabc…",
    "sourceBundleCid": "bafy…",            // IPFS-pinned source + build recipe
  },
  "implStateDirCid": "bafy…",               // IPFS-pinned constitutional state at freeze time
  "codeDigest": "0xabcd…",                  // Merkle hash of implStateDirCid contents
  "publisher": {
    "agentId": "did:jinn:…",
    "signingKey": "ed25519:…",
    "safeAddress": "0x…",
  },
  "publishedAt": "2026-05-15T12:00:00Z",
  "registry": {
    "anchor": "IdentityRegistry.setMetadata",
    "metadataKey": "harness.checkpoint:bafy…",
    "txHash": "0x…",
    "blockNumber": 12345678
  },
  "signature": "ed25519-sig-by-publisher-signing-key"
}
```

Once published:

- **Forkable.** Any operator can `jinn checkpoint install <cid>` and start running from this state. Cost: nothing.
- **Benchmarkable.** Any operator running this exact CID in frozen mode produces Solutions whose Verdicts attribute to the checkpoint identity. Multiple operators running the same CID over the same monthly slate average out operator-environment noise → tighter confidence intervals.
- **Externally claimable.** "Checkpoint @some-team/claude-code-learner-fork@v2.1.4 (cid: bafy…) achieved 0.68 mean resolved-rate on SWE-rebench v2's January 2026 slate, run by 7 operators across 47 of 60 tasks (95% CI 0.62–0.74)." Comparable to OpenHands@v0.X = 0.55 on the same slate.
- **Self-asserted at any tier.** No need to wait for Phase B.1 attested-tier; operators self-publish at self-signed, reputation enforces honesty (claimed source bundle vs running codeDigest mismatches are publicly visible).

### 7.2 CLI surface

```bash
# operator-side
jinn harness mode train          # toggle this daemon to train mode
jinn harness mode frozen         # toggle to frozen mode
jinn harness status              # current mode, codeDigest, implStateDir hash, time-since-mode-switch

# checkpoint publication / installation
jinn checkpoint publish [--name X] [--version V]   # IPFS-pin source + state; sign manifest; anchor via setMetadata
jinn checkpoint install <cid>                       # fetch + verify + stage as new starting state
jinn checkpoint list                                # local: published checkpoints + installed checkpoints
```

`jinn checkpoint publish` is what unlocks "verified frozen" tier credibility. Lean: include in v1.

### 7.3 The compounding loop, restated

With HarnessCheckpoints in place, the compounding loop operates at three levels:

1. **Per-Solution.** Verdict.score on each Task. Immediate truth signal.
2. **Per-snapshot (intra-operator).** Improve loop reads corpus + own / peer Verdicts → mutates implStateDir → next codeDigest is incrementally better at the SolverNet's task class.
3. **Per-checkpoint (cross-operator).** Operator publishes a checkpoint when their state is "good enough" to crystallise. Other operators fork it as starting state, continue training from there. The lineage `parentCheckpointCid` captures the fork graph. Top-scoring checkpoints become the starting states of the future.

Levels 1–2 are the substrate's continuous compounding. Level 3 is the publication-discipline compounding — checkpoints accumulate across the network as a public, forkable, externally-comparable lineage.

---

## 8. Reward function — R2 (task-complexity-weighted escrow)

Per discussion, the cleanest economic alignment for benchmark SolverNets is **task escrow proportional to task complexity**, with `Verdict.score` as the per-Task reward fraction.

For SWE-rebench v2, complexity proxies are: lines of code in the gold patch (`gold_patch_loc`), number of files modified (`gold_patch_files`), number of `fail2pass` tests (test suite breadth). The launcher computes:

```
escrowWei = base_escrow_wei × (1 + α × normalized_loc + β × normalized_files + γ × normalized_tests)
```

with base_escrow_wei + α/β/γ as launcher-set parameters in the SolverNet manifest.

A Solution that resolves a complex multi-file refactor with broad test coverage earns proportionally more than one that resolves a 2-line typo fix. Operator incentives align with task value; the network's economic-weighted resolved rate aggregation (§3.5) emerges as the natural rollup.

Per-Solution reward: `escrowWei × Verdict.score` (binary 0/1 for SWE-rebench v2; would be `0|0.5|1` for pairwise-graded benchmarks like GDPval). Evaluators receive a separate `verdictPriceWei` per the manifest.

---

## 9. Implementation surface and engineering scope

### 9.1 Component breakdown

| Component | Files / scope | Lift |
|---|---|---|
| **SDK additions** | `@jinn-network/sdk/harness` — `HarnessContext.mode`; `requireTrain` helper; types | ~1 day |
| **Envelope schema** | `client/src/types/envelope.ts` — `Executor.mode` (additive, back-compat) | ~half-day |
| **Daemon hash-fence** | `client/src/harness/freeze.ts`, `client/src/daemon/freeze-fence.ts`, task-handler integration | ~3 days |
| **claude-code-learner mode gate** | Per PR #94's orchestrator-skill structure: gate Improve and Memory phase invocations on `mode === 'train'` | ~1-2 days |
| **CLI** | `jinn harness mode`, `jinn harness status`, `jinn checkpoint publish`, `jinn checkpoint install` | ~3-4 days |
| **Subgraph** | Add `mode` indexing; per-`(implName, codeDigest, mode)` rollups; cross-envelope consistency view | ~2 days |
| **Dashboard** | Train-mode and frozen-mode leaderboards; verified/unverified indicator; mode toggle in operator app | ~3 days |
| **`swe-rebench-v2` SolverNet contract** | `packages/sdk/src/contracts.ts`; schemas; defaults | ~2 days |
| **`@jinn-network/swe-rebench-v2-evaluator`** | Docker fetch + apply patch + run tests + emit Verdict | ~3-4 days |
| **`bundled:swe-rebench-v2-runtime` plugin** | SWE-bench Docker harness wrapper + tools for solving | ~3 days |
| **Task generator** | Pulls SWE-rebench v2 monthly drops from HuggingFace; posts as Tasks; respects time-window for contamination filtering | ~2-3 days |
| **Tests** | Freeze fence unit tests; freeze-mode e2e on Anvil; SolverNet e2e | ~3-4 days |
| **Total** | | **~26-33 days, ~5-7 weeks** |

### 9.2 v1 acceptance criteria

The v1 SolverNet ships when:

1. `swe-rebench-v2` SolverNet contract registered in `packages/sdk/src/contracts.ts`.
2. A launched `swe-rebench-v2` SolverNet manifest exists on testnet, anchored via `IdentityRegistry.setMetadata`, indexed by the subgraph.
3. The launcher's Task generator successfully pulls SWE-rebench v2's monthly drop and posts Tasks on JinnRouter.
4. `@jinn-network/swe-rebench-v2-evaluator` runs on bonded evaluator daemons; produces deterministic Verdicts on Solver submissions.
5. claude-code-learner respects `ctx.mode`; e2e test confirms train-mode codeDigest mutates and frozen-mode codeDigest stable across N Tasks.
6. Daemon hash-fence catches a deliberate-violation test fixture; envelope rejected; rollback succeeds.
7. Subgraph indexes `Executor.mode`; dashboard surfaces train-mode and frozen-mode rollups separately.
8. `jinn checkpoint publish` produces a forkable manifest CID; another operator can `jinn checkpoint install <cid>` and run frozen against it.
9. ReputationRegistry slashing hook triggers on subgraph-detected freeze violation.
10. Documentation: SDK JSDoc explains the `mode` field and freeze contract; recruit-grade docs for Path 2 builders shipping their own freeze-respecting Harness.

### 9.3 v1.5 / v2 future work

- **Cross-benchmark companion SolverNets.** Add a second benchmark (e.g. SWE-bench Live MultiLang as a fixed-snapshot companion, or LiveCodeBench's contest-attributed stream once integration is built) for cross-benchmark validation of harness improvements. Same mechanism — different SolverNet contract.
- **Multi-judge consensus.** For judge-graded benchmarks (apex-agents, GDPval) when their license / availability allows. Same evaluator-config structure; multi-judge ensemble in the contract registry; aggregation by majority/median.
- **Round-commitment mechanism.** Explicit `jinn checkpoint commit-to-round <round-id>` registration for cleaner per-round per-checkpoint scoring. Useful when volume warrants.
- **Per-SolverNet mode scope.** Per-SolverNet train/frozen with partitioned implStateDirs. Allows operators to train on one SolverNet while benchmarking on another. Demand-driven.
- **Phase B.1 attested-tier freeze.** TEE attestation cryptographically enforces `mode=frozen` + zero implStateDir mutations. Closes the trust stack's residual gap.
- **HarnessCheckpoint reward economics (e1 / e2).** Direct rewards to harness-builders whose checkpoints are widely forked or top-of-leaderboard. Filed as Phase B.2 evaluator-economics work.
- **Fresh-supply infrastructure for finite-pool benchmarks.** LLM-generated tasks from O*NET (for GDPval-shape knowledge work); Mercor / OpenAI partnership for curated fresh supply. Unblocks GDPval, apex-agents, and similar as substrate-shaped SolverNets.

---

## 10. Phase placement and acceptance — Phase A.5

Per `spec/2026-04-30-phase-a-umbrella.md`, Phase A is the operational-loop + campaign-ready surface around `prediction.v1`. Phase A.4 trips when the campaign launches.

This SolverNet ships as **Phase A.5**: post-Phase A.4 campaign launch. Reasoning:

- `prediction.v1` is the campaign-launch focus; adding `swe-rebench-v2` in parallel risks splitting recruitment focus between two clusters.
- The substrate vision in #59 is primarily satisfied by `prediction.v1`; `swe-rebench-v2` extends the substrate to a second cluster (coding-agent builders) once the first cluster is launched.
- The freeze-mode mechanism is an addition every SolverNet benefits from, not just `swe-rebench-v2`. Shipping `swe-rebench-v2` as A.5 means freeze mode lands across the protocol cleanly, including back-applied to `prediction.v1` (operators in `prediction.v1` can also flip to frozen mode and benchmark their forecasting harnesses).

A.5 acceptance is the §9.2 criteria above plus: at least 3 operators participating in the launched `swe-rebench-v2` SolverNet on testnet; at least one published HarnessCheckpoint with cross-operator validation (≥2 operators running it).

---

## 11. Vocabulary alignment

This spec uses the current vocabulary throughout:

- **SolverNet contract** identity is `{contract.id, contract.version}`; **launched-instance** authority is `manifestCid` (per `2026-05-05-solvernet-creation-and-launch.md` v0.2 §2 principle 5). No `solverType` references.
- **Harness** (renamed from RestorerImpl); **HarnessContext**; **Solver** role; **Task** (renamed from intent); **Solution**; **Verdict**.
- **Mode**: `'train' | 'frozen'` (matches PyTorch's `model.train()` / frozen-weights ML transfer-learning vocab; avoids `'eval'` overload with the Evaluator role).
- **HarnessCheckpoint** (renamed from HarnessSnapshot in earlier discussion drafts; matches universal ML "checkpoint" terminology).
- **Train-mode / frozen-mode** when describing leaderboard rollups, dashboard surfaces, operator UX.
- **Frozen-state contract** when describing the Harness-interface obligation.

PR #94's vocabulary decoupling carries forward: claude-code-learner stays generic. Domain-specific concerns live in domain-specific plugins (`jinn-prediction-plugin/`, `jinn-swe-rebench-v2-runtime-plugin/` if one is needed). The freeze contract is added to the Harness interface itself, not to any specific Harness package.

---

## 12. Open questions deferred to the implementation plan

Three questions the design locks at v1 defaults; the implementation plan can revisit if scope pressure or new information emerges:

1. **Per-daemon vs per-SolverNet mode scope.** v1: per-daemon (simpler; per-SolverNet creates implStateDir-partitioning complications). Per-SolverNet as v1.5+ if demand emerges.
2. **`jinn checkpoint publish` + `install` in v1.** Lean: include in v1 — the design's external credibility hinges on it. ~3-4 days. If scope-pressured, defer to v1.5; v1 still has freeze mechanism but checkpoints are tied to authoring operator.
3. **Round-commitment mechanism in v1.** v1: ad-hoc operators going frozen; per-checkpoint scoring derived from continuous-stream Verdicts on whatever Tasks they happened to claim while frozen. Confidence intervals reflect partial-slate coverage. Explicit rounds as v2 if volume warrants.

---

## 13. Decision records

The following DRs are filed alongside this spec at `log/decisions/2026-05-06-…`:

- **DR-2026-05-06-a — SolverNet shape: per-task continuous over fresh-supply benchmark.** Rejects tournament shape (option α from the design exercise: trajectory locality broken; Solver doesn't produce trajectories), rejects round-only on finite pool (option γ: tokenised leaderboard, not substrate). Selects (c′): per-task continuous on fresh supply.
- **DR-2026-05-06-b — Benchmark choice: SWE-rebench v2 for v1.** Pivot from initial SWE-bench Live consideration after research showed the Python monthly cadence broke at 2025-06; SWE-rebench's `nebius/SWE-rebench-leaderboard` is the actively-maintained monthly fresh-supply alternative. Documents why GDPval, apex-agents, SWE-bench Pro/Verified, LiveBench, LiveCodeBench, and SWE-rebench v1 were each considered and rejected for v1.
- **DR-2026-05-06-c — Frozen-state contract at Harness-interface level.** Rejects claude-code-learner-specific freeze (locks one harness package); rejects separate HarnessSnapshot manifest as a new artifact type (parallel to envelope is too heavy). Selects: Harness-interface contract via `ctx.mode` field; daemon hash-fence enforcement; HarnessCheckpoint as voluntary publication on top.
- **DR-2026-05-06-d — Trust stack composition.** Rejects evaluator-level codeDigest verification (redundant with subgraph layer; per-Task scope can't do cross-Task consistency; can't independently re-derive codeDigest without source bundle). Selects: layered stack of daemon hash-fence + subgraph cross-envelope consistency + cross-operator forking validation + source-bundle publication + reputation slashing; Phase B.1 attested-tier closes residual gap.
- **DR-2026-05-06-e — Aggregation function: structured multi-winrate result.** Rejects single-scalar headline (loses information); selects structured `SWERebenchV2NetworkResult` with mean / complexity-weighted / by-language / frontier / parity-trip metrics; 30-day rolling window.
- **DR-2026-05-06-f — Reward function: task-complexity-weighted escrow (R2).** Rejects flat per-Solution rewards; selects launcher-set complexity-proxy escrow weighting; aligns operator incentives with task value.
- **DR-2026-05-06-g — Vocabulary: train / frozen / HarnessCheckpoint.** Rejects `'learning' | 'frozen'` (less ML-native); rejects `'train' | 'eval'` (overloads Evaluator role); selects `'train' | 'frozen'` + `HarnessCheckpoint`. Aligns with PyTorch + ML transfer-learning + universal ML checkpoint vocabulary.
- **DR-2026-05-06-h — Phase placement: A.5 (post-A.4 campaign launch).** Rejects parallel-to-A.3 (splits recruitment focus); selects sequential-after-A.4 (substrate generalisation story; freeze mechanism back-applies to `prediction.v1`).
- **DR-2026-05-06-i — Task generation policy: full historical pool, post until target successes per task.** Generator runs against the union of all monthly partitions (~750 tasks at v1 launch, growing ~50/month) minus saturated tasks. Rejects current-month-only (artificially low volume; ignores compounding across the full history). Rejects post-each-task-once (low volume; operators idle) and post-each-task-many-times (memorisation vector). Selects: post until N successful Solutions per task (default N=3) with `N_max_postings_per_task` cap and cooldown window. Saturated tasks remain in corpus as historical training data. Bounds within-task memorisation surface; preserves diversity of successful approaches; bootstraps substrate volume via the full 14-month history.

---

## 14. References

- SWE-rebench v2: paper at arxiv:2602.23866 (Feb 2026); harness repo `github.com/SWE-rebench/SWE-rebench-V2` (MIT); active monthly dataset `huggingface.co/datasets/nebius/SWE-rebench-leaderboard` (CC-BY-4.0, last updated 2026-04-22, monthly partitions through 2026_02); per-instance Docker images at `docker.io/swerebenchv2/<repo>:<commit-suffix>` (3,632 image repos under namespace, last updated 2026-04-22). Live leaderboard: swe-rebench.com.
- SWE-bench Live (Microsoft, NeurIPS 2025 D&B; rejected for v1 — Python monthly cadence stopped at 2025-06): github.com/microsoft/SWE-bench-Live; `huggingface.co/datasets/SWE-bench-Live/SWE-bench-Live` (Python, stale); `MultiLang` and `Windows` datasets (fixed snapshots, not monthly-fresh).
- `RestorationActivityCheckerV2.sol:37-440` — already-shipped SimHash anti-farming decay; this spec composes against it as defence in depth.
- `client/src/restorer/impls/prediction-v0-baseline/` — the in-repo Path-2 reference Harness for Prediction; analogous structure for any future SWE-rebench v2 baseline.
- `2026-05-05-solvernet-creation-and-launch.md` v0.2 §2 (core principles), §10 (launch state machine), §11 (generator-launcher boundary).
- `harness-pack-architecture.md` v0.9 §2 (glossary), §3 (first-principles), §5 (SolverPlugin), §7 (HarnessContext).
- `default-learning-restorer-design.md` (Pi seven-phase pipeline; freeze-mode mechanism gates phases 6 (Improve) and 7 (Memory)).
- PR #94 (claude-code-learner plugin simplification + Jinn-vocabulary decoupling); this spec adds one orchestrator-level config gate.
