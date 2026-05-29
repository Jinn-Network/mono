# Ghost-task admission — symmetric solver/evaluator gate

- **Date:** 2026-05-29
- **Author:** Claude (Opus, with Oak) — v0.1.8 release-readiness sweep
- **Status:** Proposal + bounded fix landed (see §6)
- **Version:** 0.1
- **Refs:** [#300](https://github.com/Jinn-Network/mono/issues/300) (investigate spike), prior spike note `spec/2026-05-26-ghost-task-class-symmetric-admission.md` (branch `spike/300-investigate-…`, commit `a4e45177`, not on `next`), v0.1.6 stewardship session (the recency-floor band-aid), [DR-2026-05-22](../log/decisions/) (claim slots are a one-way budget), release-readiness C5 (task-admission-filter check).
- **Related code (verified on `origin/next` @ `d20e670c`):**
  - `client/src/harnesses/engine/engine.ts:1066-1073` (`canAcceptTask` → `impl.canAttempt` gate; the single solver-side admission hook)
  - `client/src/harnesses/impls/hermes-agent/harness.ts` (`swe-rebench-v2.v1` solver harness — had NO `canAttempt`)
  - `client/src/harnesses/impls/learner/harness.ts` (generic solver harness, also serves `swe-rebench-v2.v1` restoration — had NO `canAttempt`)
  - `client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts:564-627` (`loadPublishedPoolRow` — strict evaluator admission via `vettedPoolRef`)
  - `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:81` (`EVAL_SEMANTICS_VERSION = '4'`), `:421` (`vettedPoolArtifactRefFromEligibility`)
  - `client/src/adapters/mech/adapter.ts:805-824` (the v0.1.6 recency floor, now applied on the DiscoveryAPI read path too — already references #300)

## 1. Root cause (re-verified on `next`)

A **ghost task** is an on-chain task a solver will claim but that no evaluator — its own or any peer's — will grade. The class persists on `next` and is *not* hypothetical: since #300 was filed, `EVAL_SEMANTICS_VERSION` has advanced `'3' → '4'`, so the exact recurrence the issue predicted has already happened once.

The root cause is a **solver/evaluator admission asymmetry**:

```
SOLVER CLAIM PATH (engine.canAcceptTask)      EVALUATOR ADMISSION PATH (loadPublishedPoolRow)
  manifestBackedValidation                      vettedPoolArtifactRefFromEligibility(task)
  impl.canAttempt   ← EMPTY for swe-rebench-v2    manifestCid match
  impl.isReady                                    evalSemanticsVersion === EVAL_SEMANTICS_VERSION  ← hard gate
  claim slot gates                                artifact fetch + hash match
  adapter.claimTask ← IRREVOCABLE (DR-2026-05-22) instance_id ∈ scorable set
```

The evaluator gate (`loadPublishedPoolRow`, harness.ts:586-591) **hard-rejects** any task whose `vettedPoolRef.evalSemanticsVersion` differs from the local `EVAL_SEMANTICS_VERSION`. The solver gate consults nothing: neither the `swe-rebench-v2.v1` production solver (`hermes-agent`) nor the generic `learner` harness implemented `canAttempt` at all. The engine's `impl.canAttempt` hook (engine.ts:1067) exists and is honoured — it was simply never wired for swe-rebench-v2 solvers.

So a v3-stamped task (or any task whose `vettedPoolRef` no longer matches the operator's regime) is claimed by the solver, executed at compute cost, delivered, and then **the operator's own evaluator refuses to score it** — wasted compute on a task that cannot earn.

The on-chain `vettedPoolRef` (`SolverNetArtifactRef`, attached via `eligibility.vettedPoolRef`) already carries `evalSemanticsVersion` and the scorable-set artifact CID. The solver simply never read it.

The v0.1.6 recency floor (`DEFAULT_TASK_DISCOVERY_FROM_BLOCK`, adapter.ts:805-824, now applied on the DiscoveryAPI path too) is a **band-aid**: it narrows the discovery window so the daemon doesn't *find* known pre-bump ghosts. It does not help operators with persisted cursors below the floor, does not survive a future pool rebuild, and — load-bearing — does nothing once a *new* ghost class appears above the floor (e.g. the next `EVAL_SEMANTICS_VERSION` bump posts fine, then the operator rebuilds under v5 and every v4 task above the floor becomes a ghost).

## 2. Drift surfaces (which a fix must address)

| | Surface | Knowable at claim time? |
|---|---|---|
| **A** | **Semantics-version skew** — task `vettedPoolRef.evalSemanticsVersion` ≠ local `EVAL_SEMANTICS_VERSION`. The observed 2026-05-14 incident + the `'3'→'4'` recurrence. | **Yes — from the task spec alone, zero I/O.** |
| B | Instance not in the published scorable set | Yes, but needs an IPFS fetch of the artifact. |
| C | Substrate drift between admission and verdict (HF `rowHash`, image digest re-push) | No — by definition only knowable at verdict time. |
| D | Per-operator reproduction divergence (ARM vs amd64 digest, transient ENOSPC) | Partly; residual tail. |
| E | Pre-`vettedPoolRef` / `python-floor` / out-of-band tasks (no ref present) | The *recency floor's* job; fail-open here preserves current behaviour. |

Surface **A** is the cheap, high-value, observed one. It is closable with a pure, zero-fetch check.

## 3. The right architectural fix (recommendation)

**Symmetric admission**: the solver consults the same `vettedPoolRef` the evaluator already uses, via `impl.canAttempt`. Three tiers, increasing cost and blast radius:

1. **Tier 1 — zero-fetch semantics-version gate (LANDED this sweep, see §6).** Solver `canAttempt` parses `task.eligibility.vettedPoolRef` and rejects when `ref.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION`. **Fail-open when the ref is absent** (preserves today's behaviour for pre-`vettedPoolRef` and `python-floor` tasks — the recency floor still guards those). Closes surface A. No network I/O on the hot pre-claim path. This is the load-bearing, observed-incident fix and is genuinely low-risk.
2. **Tier 2 — scorable-set membership gate (DEFER to its own issue).** Solver `canAttempt` additionally fetches the published artifact (sharing the evaluator's per-CID cache, extracted into a `swe-rebench-v2-admission.ts` module) and rejects when `instance_id ∉ scorable`. Closes surface B. **Risk:** adds an IPFS round-trip to `engine.canAcceptTask`, which runs per discovered candidate. Needs a shared, bounded cache and a fail-open-on-fetch-error policy so a gateway blip doesn't shut every operator's claim loop down. This is the architectural extraction the prior spike's §4.1 describes; it deserves TDD and its own review, not a sweep.
3. **Tier 3 — stamp `evalSemanticsVersion` on the task spec (DEFER).** Promote the version from the `vettedPoolRef` envelope to a first-class `SweRebenchV2TaskSchema` field so even ref-less tasks self-identify their regime. Schema change → generator + evaluator + solver lockstep. Most valuable *after* Tier 1 is universal.

## 4. Why fail-open-when-ref-absent (not fail-closed)

The prior spike (`2026-05-26-…`) recommended fail-**closed** when `vettedPoolRef` is absent. This sweep deliberately ships fail-**open** for Tier 1, because fail-closed changes network-wide claim behaviour for every pre-`vettedPoolRef` and `python-floor` task in one step — a behavioural change that belongs in a reviewed feature issue (Tier 2), not a release-hardening sweep. Tier 1's job is narrow: stop claiming tasks that *explicitly announce* (via their ref) a semantics version we cannot grade. The recency floor continues to guard ref-less ghosts until Tier 2 lands. This is the conservative, surgical choice per CLAUDE.md Rule 3.

## 5. The recency floor after Tier 1

The floor (`DEFAULT_TASK_DISCOVERY_FROM_BLOCK`) stays — it still guards ref-less ghosts (surface E) that Tier 1 fails open on. Its role narrows from "the only ghost defence" to "the defence for ref-less tasks + an RPC-cost window optimiser." Removing it as a correctness gate is gated on Tier 2 landing (which closes surfaces B and the ref-bearing remainder). Do **not** generalise the floor into a `--days-of-history` knob — that preserves the band-aid shape (prior spike §7).

## 6. Bounded fix landed this sweep

Tier 1 only. Added a pure helper `vettedPoolRefSemanticsMismatch(eligibility)` to `_swe-rebench-v2-validated-pool.ts` (reuses the existing `vettedPoolArtifactRefFromEligibility` parser + `EVAL_SEMANTICS_VERSION` constant — single source of truth, no drift). Wired it into `canAttempt` on both `swe-rebench-v2.v1` solver harnesses: `hermes-agent` and `learner`. Unit tests cover: match → ok, mismatch → rejected with reason, absent ref → ok (fail-open). No IPFS, no schema change, no contract change.

## 7. Out of scope (candidate follow-up issues)

- Tier 2 (scorable-set membership) — the architectural extraction; needs shared cache + fail-open-on-fetch-error TDD.
- Tier 3 (`evalSemanticsVersion` on the task spec) — schema change, lockstep migration.
- Creator-side `JinnRouterV3.shortenDeadline` retraction escape hatch (prior spike §4.2).
- IPFS pinning policy for the vetted-pool artifact (prior spike §8).
- `recheckUpstreamCommit` evaluator parity, multi-arch Docker digest policy (prior spike §8).
