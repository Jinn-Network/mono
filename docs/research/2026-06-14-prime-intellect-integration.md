# Prime Intellect ↔ Jinn: integration opportunities for SolverNets and agent-training loops

**Date:** 2026-06-14
**Author:** Jinn contributor (spike under [#118](https://github.com/Jinn-Network/mono/issues/118))
**Status:** Research / spike finding — not a spec, not a commitment. Output is a recommendation plus follow-up issues; no integration is implemented here (per #118 non-goals).

---

## TL;DR

Jinn and Prime Intellect have independently converged on the **same core
abstraction**: an *environment / SolverNet* is a triple of **task dataset +
model harness + scoring rubric**. That isomorphism is the strongest, lowest-risk
surface for interop. Prime's open-source `verifiers` library is the same shape as
a Jinn SolverNet's `{ task, solution, verdict }` schema + evaluator, and Jinn's
existing `swe-rebench-v2-evaluator` (a "wrap an external deterministic grader"
harness) is already the exact pattern a `verifiers` evaluator harness would take.

Where they diverge is **trust and time-coupling**. Prime is a *training-time*
loop — one trusted operator owns orchestrator + trainer + inference, rewards are
dense scalars feeding gradient updates, environments are Python wheels. Jinn is a
*market* loop — mutually-distrusting, distinct operators, on-chain settlement,
signed envelopes with evidence tiers, verdicts that are settlement-grade rather
than advisory. None of Jinn's manifest-CID / pricing / roles / settlement /
signature machinery maps onto Prime environment metadata, and Prime's gradient-RL
weight-update loop has **no equivalent** in Jinn (whose "learner" mutates the
harness over a frozen model — see [`2026-05-27-rl-on-harness-survey-discussion-draft.md`](2026-05-27-rl-on-harness-survey-discussion-draft.md)).

**Recommendation: export-only interop now, a `verifiers` evaluator harness as a
fast-follow — explicitly a loose interop/export path, not a hosted dependency.**
Defer hosted-training (Prime Lab) integration behind a data-ownership review; it
is the only option that fills a real Jinn capability gap (gradient RL), but it is
also the one that most conflicts with the Permissionless / Neutral / public-good-corpus
posture in [`PRINCIPLES.md`](../../PRINCIPLES.md).

> **Evidence caveat (Legibility).** Everything below about Prime Intellect is
> drawn from their public docs, blog, and the open-source `verifiers` /
> `prime-rl` repos as of June 2026 — not from running the stack. Several specific
> shapes (the exact `vf.EnvServer` wire format, the rollout record the trainer
> consumes, Environments Hub registry internals, Lab pricing) the public docs do
> not fully pin down; those are marked **unknown** in the mapping table and
> should be confirmed against source before any build commitment.

---

## 1. Prime Intellect's relevant stack

Prime positions "Lab" as an open stack for self-improving agents spanning compute,
RL post-training, environments, evals, inference, and deployment. The pieces that
matter for Jinn interop:

| Piece | Open-source? | What it is | Relevance to Jinn |
|---|---|---|---|
| **`verifiers`** | Yes (GitHub) | The spec layer. Defines RL environments + evals as one shape. Base classes `MultiTurnEnv` (core rollout loop), `SingleTurnEnv` (= `max_turns=1`), `ToolEnv` (adds tool calling). `Rubric(funcs=[...], weights=[...])` with async reward fns. | **High** — direct analogue of a SolverNet's task+harness+evaluator triple. The interop seam. |
| **`prime-rl`** | Yes (GitHub) | Production async RL trainer. Three cooperating processes: **orchestrator** (CPU data plane — drives rollouts, computes advantages, packs batches, relays weights), **trainer** (FSDP2 optimizer steps), **inference** (vLLM serving current policy). Entrypoint `uv run rl @ config.toml`. Agentic RL + LoRA + MoE. | **Medium** — a backend Jinn *could* route gradient-RL to; not something Jinn would re-implement. |
| **`prime` CLI / Lab** | Hosted product | `prime lab setup`, `prime rl run configs/x.toml`. Hosted training (INTELLECT-3 + NVIDIA / Qwen / Arcee / AI2 / Z.AI models; agentic RL with LoRA today, SFT / GEPA / GKD / DPO planned), hosted evals, the Environments Hub. Built on NVIDIA Dynamo. Pricing undisclosed; moved from private beta (3,000+ runs) to open. | **Low–Medium** — convenience layer; introduces platform dependency. |
| **Environments Hub** | Hosted registry (open contributions) | Share/discover environments. Environments published as Python wheels (`pyproject.toml`), each exposing a `load_environment()` entrypoint. | **Medium** — a distribution channel for Jinn-shaped work, and a source of ready-made graders. |
| **INTELLECT-2** | Research artifact | Decentralized RL: rollout workers, validators, trainers, async policy updates. | **Low / strategic** — directionally similar to Jinn's distinct-operator model; speculative. |

### The `verifiers` data shapes (the load-bearing detail)

- **Dataset row:** `{ prompt: [{role, content}], question?, answer?, info?, task? }` —
  `info` is structured metadata (dict or JSON string); `task` (v1 harness pattern)
  carries all task-specific data.
- **Rollout output:** `completion` (message list) + `state` (mutable dict
  accumulated during the rollout, includes `"completion"`, `"error"`,
  `"trajectory"`) + `reward` (weighted sum of rubric scores) + per-function
  `metrics`.
- **Reward function:** `async def f(completion, answer, prompt, info, state) -> float`,
  combined via `Rubric(funcs=[...], weights=[...])`. Group variants take plural
  args (`completions`, `answers`) → `list[float]` for pass@k / diversity.
- **Trainer record:** the trainer receives "the exact tokens the server sampled"
  plus fields like `query`, `completion`, `expected_answer`, `reward`, `error`.
- **Serving:** `verifiers` is deliberately **trainer-agnostic** — any trainer that
  exposes an OpenAI-compatible inference client can drive rollouts; `vf.EnvServer`
  serves an environment as a sidecar/endpoint. (Exact wire format **unknown** from
  public docs.)

---

## 2. Mapping table — Jinn concept → Prime concept → fit / gap / unknown

| Jinn concept | Closest Prime concept | Fit / Gap / Unknown |
|---|---|---|
| **SolverNet** (task stream + harness + evaluator) | `verifiers` **Environment** (dataset + harness + rubric) | **Fit (strong).** Same triple. This is the integration thesis. |
| SolverNet `contract.schemas.task` (JSON Schema) | Environment **dataset row** (`prompt`/`question`/`info`/`task`) | **Fit, with transform.** Jinn task `spec` → dataset `info`/`task`; `description` → `prompt`. JSON-Schema-typed vs duck-typed dict. |
| Jinn **Harness** (`run(HarnessContext) → Solution`) | Environment **harness** (`MultiTurnEnv` / `ToolEnv` rollout loop) | **Fit (conceptual), gap (mechanics).** Jinn harness is TS, daemon-hosted, role-aware (`supports({solverType, role})`); verifiers harness is Python, `env_response()`-driven. Same job, different runtime + language. |
| **Evaluator** + `contract.evaluationFunction` → verdict | **`Rubric`** + reward functions | **Fit (strong).** Jinn's deterministic graders (Brier for prediction, PASS/FAIL for swe-rebench) are exactly `Rubric` reward functions. `swe-rebench-v2-evaluator` ≈ a verifiers rubric wrapping an external grader. |
| **Verdict** (`verdictEnvelopeMeta.actualPassed` / `actualScore`; `passedCount`/`totalCount`) | Rollout **`reward`** (float) | **Fit on value, gap on trust.** Jinn verdict is *settlement-grade* (signed, evidence-tiered, payment-bound, challengeable in Phase B.2). Prime reward is *advisory to the trainer that owns it*. A verifiers reward can be promoted to settlement-grade **only** when deterministic. |
| **Trajectory** (`jinn.trajectory.v1`: hash-chained OTLP spans, redaction manifest, span kinds `jinn.llm_call`/`jinn.mcp_call`/…) | Rollout **`state["trajectory"]`** / `completion` message list | **Partial fit, lossy.** Jinn trajectory is far richer (signed, hash-chained, redaction-aware, multi-span). verifiers rollout is a conversation transcript + state dict. Transform is lossy in both directions; **schema-transform spec needed**. |
| **Execution envelope** (`jinn.execution.v1`: executor impl/version/plugins, `evidenceTier`, `attestation`, signature) | *(none)* | **Gap.** No Prime analogue for evidence tiers, attestation, signed provenance. |
| **Manifest CID** (ERC-8004-anchored, EIP-191 signed) | Environment **wheel + Hub registry entry** | **Gap.** Content-addressed + on-chain-anchored + signed vs a PyPI-style wheel in a hosted registry. No trust/identity binding on the Prime side. |
| **Pricing** (`solutionPriceWei`, `verdictPriceWei`), settlement, JINN emission | *(none)* | **Gap (fundamental).** Prime has no payment/settlement concept. This is Jinn's, and stays Jinn's. |
| **Roles / credential requirements** (`creator`/`solver`/`evaluator`) | *(none — one trusted operator)* | **Gap (fundamental).** Prime assumes a single trusted party running the whole loop; Jinn assumes distinct mutually-distrusting parties. |
| **Learner** (harness-as-policy: prompt/skill/tool edits over a **frozen** model; Memory/Improve phases; steer hook) | **`prime-rl`** gradient RL (LoRA weight updates) | **Complementary gap.** Jinn deliberately does *not* update weights; Prime's whole point is updating weights. Prime could supply the gradient-RL capability Jinn forgoes by design — *if* Jinn ever wants it. |
| **learning-approach-v0** meta-SolverNet (behavioural-novelty gating; Hamming/Jaccard) | Environments Hub (share approaches) | **Loose fit.** Both are registries of "learning interventions," but Jinn gates on novelty + on-chain identity; Hub is open contribution. |
| `vf.EnvServer` wire format; trainer rollout record; Hub registry internals; Lab pricing | — | **Unknown.** Not pinned by public docs; confirm against source before building. |

---

## 3. Integration options, ordered by implementation risk

### Option A — Export-only / interop adapter  *(lowest risk; recommended now)*

Build a **`jinn → verifiers` exporter**: map a Jinn SolverNet plus its captured
trajectories and verdicts into a `verifiers` Environment package — dataset rows
from task `spec`/`description`, a reward function wrapping the Jinn verdict, `info`
from envelope metadata. Optionally publish to the Environments Hub as a static
dataset/eval. **Reverse direction:** a Jinn SolverType/harness that *consumes* a
`verifiers` environment as a task source + grader.

- **Coupling:** none. Pure adapter, lives in `client/` tooling or a standalone repo.
- **No protocol change, no hosted dependency, no on-chain change.**
- **Value:** lets the open RL community train on Jinn-shaped work; dogfoods
  "is our corpus actually RL-usable?"; cheap experiment surface.
- **Risk:** lossy trajectory transform (see §2); needs the schema-transform spec
  (follow-up #4) to be honest about what's dropped.

### Option B — `verifiers` evaluator / environment harness  *(medium; fast-follow)*

Implement a Jinn **Harness** that runs a `verifiers` Environment's `Rubric` as a
Jinn evaluator (and/or drives a policy through a verifiers env as a solver).

- **Reuses an existing Jinn pattern.** `swe-rebench-v2-evaluator` is already a
  "wrap an external deterministic grader, emit PASS/FAIL, pin logs to IPFS"
  harness. A `verifiers-env-evaluator` is the same shape with a `vf.EnvServer`
  sidecar instead of a Docker grader.
- **Trust boundary, stated explicitly:** Prime scoring is **advisory** by default.
  It becomes **settlement-grade** only when the verifiers rubric is deterministic
  and reproducible (same patch + same env → same reward), exactly the bar
  swe-rebench already clears. Non-deterministic rubrics stay advisory signal, never
  verdict.
- **Risk:** new harness + Python sidecar integration; the determinism call must be
  made per environment; `vf.EnvServer` wire format is currently **unknown** (spike
  it first).

### Option C — Prime Lab / `prime-rl` as a learner training backend  *(higher risk; gated)*

Route Jinn's learner updates to gradient RL: Jinn supplies task provenance +
trajectories as rollouts, Prime (hosted Lab **or** self-hosted open `prime-rl`)
runs the RL/LoRA training, the trained policy returns as a Jinn harness/plugin
bundle measured via the **existing frozen-mode held-out eval** on swe-rebench-v2.

- **Fills a real gap:** Jinn has no gradient-RL loop today — the learner is
  in-context (harness mutation over a frozen model). This is the only option that
  adds a genuinely new capability.
- **Risks:** (1) hosted-product dependency + undisclosed pricing (mitigated by
  self-hosting open `prime-rl` at the cost of GPU infra); (2) **data-ownership /
  trace-sharing review required** — shipping Jinn trajectories to a third-party
  trainer must be checked against the public-good-corpus framing and Neutral /
  Permissionless principles; (3) the `jinn.trajectory.v1` → verifiers-rollout
  transform is nontrivial and lossy.
- **Gate:** do not start until B.1 verifiability tiers are concrete *and* a
  data-ownership review (follow-up #3) signs off.

### Option D — Operator / compute bridge & deeper protocol alignment  *(strategic; defer)*

Explore whether Prime's decentralized rollout-worker / validator / trainer model
(INTELLECT-2) can complement Jinn operators for large training runs. Directionally
resonant with Jinn's distinct-operator economics but speculative and far from
implementation. **Defer** — revisit only if Option C proves out.

---

## 4. Recommendation

**Export-only interop (Option A) now; a `verifiers` evaluator harness (Option B)
as a fast-follow. Keep Prime Intellect a loose interop/export path, not a hard
dependency.**

Rationale:

- The **shape-isomorphism** (SolverNet ≈ verifiers Environment; Jinn evaluator ≈
  `Rubric`) makes A and B near-free relative to their optionality value. Jinn
  already ships the exact "wrap an external deterministic grader" pattern Option B
  needs.
- A and B touch **no settlement, no on-chain state, no protocol surface**, and add
  **zero hosted dependency** — fully coherent with Permissionless / Neutral /
  Legibility.
- **Reject a hard hosted dependency.** Binding the protocol (or default operator
  path) to Lab would conflict with Permissionless and the public-good-corpus
  framing, and Lab pricing is undisclosed. If gradient RL is wanted, prefer the
  open `prime-rl` self-hosted path and keep Jinn the source of task provenance,
  settlement, and corpus attribution.
- **Defer Option C** behind the verifiability-tier work and a data-ownership
  review. It is the only option that fills a real capability gap, but also the one
  most in tension with the principles — so it earns a deliberate gate, not a
  reflexive no and not a reflexive yes.

What stays Jinn's, non-negotiably: manifest CID + on-chain anchoring, pricing /
settlement / JINN emission, role + credential model, signed evidence-tiered
envelopes, and settlement-grade (challengeable) verdicts. Prime is a training /
eval *backend and interop format*, never the trust or settlement layer.

---

## 5. Follow-up implementation issues (if a path is pursued)

1. **`feat` (Effort: Medium)** — `jinn-to-verifiers` exporter: SolverNet + captured
   corpus → a `verifiers` Environment package; validate by training a small policy
   against it (self-hosted `prime-rl` or Environments Hub). *Implements Option A.*
2. **`feat` (Effort: Medium)** — `verifiers-env` evaluator harness: run a verifiers
   `Rubric` as a Jinn evaluator via `vf.EnvServer`; decide advisory-vs-settlement
   per-environment on a determinism test. *Implements Option B; depends on #4.*
3. **`design` (Effort: Medium)** — Data-ownership / trace-sharing review (DR): may
   Jinn route trajectories to a third-party (hosted or self-hosted) trainer, and
   under what attribution/consent terms? *Gates Option C.*
4. **`spike` (Effort: Low)** — Schema-transform spike: pin `vf.EnvServer` wire
   format + the trainer rollout record from `verifiers`/`prime-rl` source; specify
   the lossy mapping `jinn.trajectory.v1` (OTLP spans) ↔ verifiers rollout
   (messages + state + reward). *Unblocks #1 and #2.*

---

## Cross-references

- [`docs/research/2026-05-27-rl-on-harness-survey-discussion-draft.md`](2026-05-27-rl-on-harness-survey-discussion-draft.md)
  — Jinn's RL-component framing (Policy = harness, Environment = SolverNet, Reward
  = `verdictEnvelopeMeta.actualPassed`/`actualScore`, Trajectory = `TrajectoryCollector`
  spans) and the harness-as-policy / frozen-weights bet. The Prime mapping in §2
  reuses that frame.
- [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](../../spec/2026-05-28-harness-as-policy-learning-architecture.md)
  — learner action surface + train/frozen modes (the Option C measurement path).
- [`spec/2026-06-10-learning-approach-solvernet.md`](../../spec/2026-06-10-learning-approach-solvernet.md)
  — learning-approach-v0 meta-SolverNet + behavioural-novelty gating.
- [`spec/2026-05-05-solvernet-creation-and-launch.md`](../../spec/2026-05-05-solvernet-creation-and-launch.md)
  — SolverNet manifest shape referenced in §2.
- Primary Prime Intellect sources: [primeintellect.ai/blog/lab](https://www.primeintellect.ai/blog/lab),
  [docs.primeintellect.ai](https://docs.primeintellect.ai/),
  [github.com/PrimeIntellect-ai/verifiers](https://github.com/PrimeIntellect-ai/verifiers),
  [github.com/PrimeIntellect-ai/prime-rl](https://github.com/PrimeIntellect-ai/prime-rl),
  [primeintellect.ai/blog/intellect-2](https://www.primeintellect.ai/blog/intellect-2).
