# Design: evaluator test-injection seam for `buildHarnesses()` (#1642)

**Date:** 2026-07-22  
**Issue:** #1642 (`test`, Effort Medium, Priority P2)  
**Status:** Stage 1 design (Autopilot implement-issue)  
**Author:** Autopilot design stage

## 1. Problem restatement and success criteria

### Problem

`buildHarnesses(env)` (`client/src/harnesses/impls/index.ts`) is the single construction site for first-party harnesses. Marketplace e2e (`client/test/e2e/task-creator-marketplace.ts`) needs deterministic evaluator verdicts (gold → pass, garbage → fail) without running the Docker-backed `SweRebenchV2EvaluatorHarness`.

Today the script **bypasses** the harness path entirely and calls `submitSelfEvaluation` with a hand-picked score, because:

1. `externalImpls` only **appends** after in-repo evaluators.
2. Registry dispatch is **first-match** on `supports()`. The real `swe-rebench-v2-evaluator` is registered before `externalImpls`, so an appended stub never wins unless the real name is also in `disabledNames`.
3. Per-evaluator `_testDeps` (e.g. on `SweRebenchV2EvaluatorHarness`) exists for unit tests but is **not** wired through `buildHarnesses`, and even with deps injected the harness `isReady()` still demands enable-state + Docker.
4. The existing env-gated `StubHarness` is restoration-only (`supports` returns false for `evaluation`) and relies on append-before-learner, which works for solve but not for evaluate.

### Success criteria (mapped to issue body)

| Criterion | Done when |
|---|---|
| Test-only injection path on `buildHarnesses` | Callers can supply a stub evaluator that **wins** first-match for `swe-rebench-v2.v1` + `role: evaluation` through the real `HarnessRegistry` wiring |
| Deterministic verdicts | Stub can return caller-chosen pass/fail (or score→verdict) without Docker / upstream clone |
| Safety | Fake evaluator path cannot activate in a real operator run (`JINN_TEST_MODE` fail-closed, same posture as `StubHarness`) |
| Minimum surface | No rewrite of marketplace e2e in this issue unless explicitly required (it is not — seam only; e2e rewiring is a follow-on) |
| Test discipline | Issue Type `test` — regression/unit tests for the seam are the primary deliverable |

## 2. Plausible approaches

### A. Document / helper over existing `externalImpls` + `disabledNames`

**How:** Caller passes `disabledNames: ['swe-rebench-v2-evaluator']` and appends a stub via `externalImpls`. Optional thin helper `withDisabledAndExternal(...)` that asserts `JINN_TEST_MODE=1`.

**Pros:** Zero (or near-zero) change to `buildHarnesses` core list construction; already covered by `build-harnesses.test.ts`.

**Cons:** Two knobs; easy to forget `disabledNames` and silently keep the real evaluator; no fail-closed unless we add a helper gate; stub must use a *different* name from the disabled in-repo harness (or disable + replace becomes awkward); does not address the review ask for an explicit seam on `buildHarnesses()`.

### B. Env-gated evaluator stub (mirror `StubHarness` / `maybeCreateStubHarnessFromEnv`)

**How:** New `EvaluatorStubHarness` + `maybeCreateEvaluatorStubFromEnv()` gated on e.g. `JINN_EVALUATOR_STUB=1` **and** `JINN_TEST_MODE=1` (throw if stub env set without test mode). Inside `buildHarnesses`, when active: skip constructing the real `SweRebenchV2EvaluatorHarness` (or auto-disable it) and push the stub in its place / early enough to first-match.

**Pros:** Matches the restoration stub’s production-safety pattern exactly; works for subprocess e2e that only control env; operators already know the two-env-var story.

**Cons:** Env is a poor fit for marketplace e2e’s **mutable** score sequence (pass then fail in one process) without restarting the daemon or inventing a multi-score fixture protocol; couples the seam to one solverType unless generalized; score/config surface tends to grow (`JINN_EVALUATOR_STUB_SCORE`, fixtures dir, …).

### C. `HarnessEnv` `_testDeps` passthrough into `SweRebenchV2EvaluatorHarness`

**How:** Add `HarnessEnv.sweRebenchV2EvaluatorTestDeps` (or a generic map) and pass through at construction — same pattern as `polymarketGammaBaseUrl` → `PredictionV1Evaluator`.

**Pros:** Exercises the real harness class (`supports`, envelope parse, IPFS pin path); `_testDeps` already exists on the constructor.

**Cons:** `isReady()` still requires enable marker + Docker unless we also widen `_testDeps` / stub-mode readiness; deep coupling to one harness; does not generalize to `jinn-repo-evaluator` or future evaluators; still not a “replace the evaluator” seam for e2e that wants a thin canned verdict.

### D. `HarnessEnv.testHarnessReplacements` — replace-by-canonical-name (recommended)

**How:** Add an optional `testHarnessReplacements?: readonly Harness[]` on `HarnessEnv`. When non-empty:

1. If `process.env.JINN_TEST_MODE !== '1'`, **throw** (same fail-closed posture as `maybeCreateStubHarnessFromEnv`).
2. Build the normal list.
3. For each replacement, remove any entry whose `canonicalHarnessName(name)` matches, then insert the replacement at the removed index (preserving first-match order). If no match, append among the evaluator region or at the end of in-repo specialists before learners — prefer **require a matching name** and throw on unknown names to avoid silent mis-wiring.
4. Apply existing `disabledNames` filter last (unchanged).

**Pros:** One explicit test-only knob on the factory the issue names; programmatic stubs with closures (mutable score for marketplace e2e follow-on); works for any named in-repo harness, not only swe-rebench; preserves registration index so first-match and name-based `solverTypeHarnesses` stay coherent if the stub keeps the canonical name (e.g. `swe-rebench-v2-evaluator`); safety matches `StubHarness`.

**Cons:** New `HarnessEnv` field (must never be plumbed from operator config / `main.ts`); callers must set `JINN_TEST_MODE=1` even for in-process unit tests that pass replacements.

### E. Prepend-only `testHarnesses` without replace

**How:** Unshift test harnesses before the in-repo list under `JINN_TEST_MODE`.

**Pros:** Simple.

**Cons:** Duplicate names in the registry; first-match may hit the stub while name lookup still finds the real one; worse than replace-by-name for `solverTypeHarnesses` and readiness enumeration.

## 3. Recommended approach

**Recommend D — `HarnessEnv.testHarnessReplacements` with replace-by-canonical-name and `JINN_TEST_MODE` fail-closed.**

### Why

- Minimum new surface that actually solves first-match displacement (A alone is error-prone; E is sloppy).
- Matches the **fail-closed** safety of `StubHarness` without forcing an env-only score protocol (B).
- Avoids pretending `_testDeps` passthrough (C) is enough for e2e when readiness/Docker still gate the real harness.
- Lets follow-on marketplace e2e pass a thin in-process stub with a mutable `nextScore` closure through `startDaemon` → `buildHarnesses`, keeping the Daemon → `HarnessRegistry` → `harness.run()` path — the opposite of today’s `submitSelfEvaluation` bypass.

### Concrete API sketch

```ts
// HarnessEnv
/**
 * Test-only replacements keyed by harness identity: each entry displaces the
 * in-repo harness with the same canonical name (registration index preserved).
 * Fail-closed: if non-empty and JINN_TEST_MODE !== '1', buildHarnesses throws.
 * Never wire from operator config / main.ts.
 */
testHarnessReplacements?: readonly Harness[];
```

Stub harnesses used with this seam should typically **reuse the displaced name** (e.g. `name: 'swe-rebench-v2-evaluator'`) so existing dispatch maps and logs stay readable. A tiny test helper class may live under `client/src/harnesses/impls/` **only if** shared by multiple producers; otherwise keep stub implementations in `client/test/` and pass instances in — prefer test-local stubs unless a second consumer appears.

### Decisions (headless Stage 1)

| Decision | Choice | Reason |
|---|---|---|
| Seam shape | Replace-by-name on `HarnessEnv` | Solves first-match; one knob; programmatic |
| Safety gate | `JINN_TEST_MODE === '1'` or throw | Mirror `maybeCreateStubHarnessFromEnv` |
| Unknown replacement name | Throw | Fail loud vs silent append |
| Empty / omitted replacements | No-op | Production path unchanged |
| Wire from `main.ts` / config schema | **No** | Keeps the field unreachable from operator config |
| Marketplace e2e rewrite | **Out of scope** | Issue asks for the seam; follow-on consumes it |
| Env-gated evaluator stub (B) | Not primary | Keep available as future additive if subprocess-only gates need it; not required for #1642 |

## 4. Files likely touched / out of scope

### In scope

| File | Change |
|---|---|
| `client/src/harnesses/impls/index.ts` | Add `testHarnessReplacements` to `HarnessEnv`; apply replace + fail-closed gate in `buildHarnesses` |
| `client/test/harnesses/impls/build-harnesses.test.ts` | TDD: displace evaluator, fail-closed without test mode, unknown name throws, no-op when unset |
| Optionally `client/test/harnesses/impls/test-harness-replacements.ts` (or inline fakes) | Shared fake evaluator for tests |

### Out of scope (#1642)

- Rewriting `client/test/e2e/task-creator-marketplace.ts` to stop using `submitSelfEvaluation` (follow-on once the seam lands).
- Extending `startDaemon`’s `extraHarnesses` (post-registry append; does not fix first-match inside `buildHarnesses`).
- New env vars / `EvaluatorStubHarness` production class (Approach B) unless a later issue needs subprocess-only activation.
- Plumbing `_testDeps` for production readiness bypass.
- Config / Zod / `main.ts` exposure of the new field.
- Changing `HarnessRegistry` dispatch semantics.

## 5. Test plan outline (Issue Type `test`)

TDD against `buildHarnesses` (extend `build-harnesses.test.ts`):

1. **Displace:** With `JINN_TEST_MODE=1`, pass a fake named `swe-rebench-v2-evaluator`; assert the returned list has exactly one harness with that name, it is the fake, and `supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })` is true on that instance.
2. **First-match integration (light):** Register the list into `HarnessRegistry` (no default override for that solverType) and assert `findFor` evaluation picks the fake.
3. **Fail-closed:** With replacements non-empty and `JINN_TEST_MODE` unset / not `'1'`, `buildHarnesses` throws a message naming `JINN_TEST_MODE` (assert does not construct).
4. **Unknown name:** Replacement whose name matches no in-repo harness throws.
5. **Baseline unchanged:** Omitting `testHarnessReplacements` yields the same names/length as today (alongside existing externalImpls/disabledNames cases).
6. **Composes with `disabledNames`:** If both disable and replace the same name, document chosen behavior (recommended: replace first, then disabledNames — a replaced stub can still be disabled if listed; or treat replace as authoritative and ignore disable for that name — pick **replace then filter** for least surprise with existing filter semantics).

Do **not** require Anvil/marketplace e2e green for this issue; unit/registry tests are the gate.

## 6. Production-safety constraints

- **Fail-closed:** Any non-empty `testHarnessReplacements` without `JINN_TEST_MODE === '1'` throws before returning harnesses. Same rationale as `StubHarness`: canned verdicts would mint fraudulent on-chain evaluation activity.
- **Unreachable from operator config:** Do not add the field to Zod config or `main.ts` `buildHarnesses({...})` call. Only in-process test / e2e helpers may pass it.
- **No silent append:** Replacements must match an existing canonical name or throw — prevents “I thought I replaced the evaluator” while the real Docker harness still first-matches.
- **Restoration stub unchanged:** `maybeCreateStubHarnessFromEnv` / `StubHarness` keep their current two-env-var contract; this issue does not weaken or broaden them.
- **Document in the `HarnessEnv` JSDoc** that the field is test-only and fail-closed.

## 7. Follow-on (not this PR)

After the seam lands, a separate `test`/`chore` issue can rewire `task-creator-marketplace.ts` to:

1. Set `JINN_TEST_MODE=1`.
2. Pass a thin evaluator stub via `testHarnessReplacements` into `startDaemon` → `buildHarnesses`.
3. Drive gold/garbage scores through Daemon evaluation delivery instead of `submitSelfEvaluation`.
4. Delete or shrink the bypass helper once assertions still hold.
