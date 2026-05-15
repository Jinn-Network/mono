# Eval substrate spike — making any SolverNet eval trustworthy

- **Version:** 0.1 (spike output — pre-implementation)
- **Date:** 2026-05-14
- **Author:** opus (on jinn-mono-fufn)
- **Status:** Proposal — requires Captain (oaksprout) review before implementation bds are filed
- **Run-mode:** spike (no code merges from this work — output is this finding)
- **Tracks:** `jinn-mono-fufn` (epic `ebu7`, eval-infra, phase-a)
- **Subsumes:** symptom bds `jinn-mono-xw6i`, `jinn-mono-y4ah`, `jinn-mono-b609`, `jinn-mono-tptp`, `jinn-mono-nf92` (re-disposition in §13)

---

## TL;DR

The 2026-05-14 triage on Base Sepolia surfaced a structural bug, not a substrate bug: the SWE-rebench v2 evaluator harness collapses **"the eval container could not produce a verdict"** and **"the model's solution was wrong"** into the same on-chain `Fail(2)` signal. The polarity is a regex denylist with a Fail default — when the denylist misses (it did, four times today), real failures bury real signal.

The structural answer is **invert the polarity**: separate **"did we grade?"** from **"did the solution pass?"** at every evaluator. Default to `Invalid(3)` when the gradeable predicate is not satisfied. Promote a typed eval-substrate description (image + dataset row + eval-code) to the SolverNet contract registry so every SolverType inherits the same discipline. Pin the substrate by digest. Smoke-test instances at launcher admission so broken-from-day-one instances never become Tasks.

The path ships in three layers — **v1 (this week / next Monday cut)**: polarity fix, denylist extensions for the four known fingerprints, harness emits `INVALID` with a `failureMode` instead of swallowing the eval into a `SkippableError`, explorer surfaces it. **Phase A.1 (next ~month)**: typed `EvalSubstrate` primitive on `SolverNetContract`, launcher-side admission smoke-test, drift sweep, backfill reclassification of the 107 existing verdicts. **Phase 2 (mainnet gate)**: protocol-enforced admission attestation in ValidationRegistry, TEE-attested eval composing on top.

The property the protocol claims, after all three layers land: **every accepted Solution produces a Verdict that is either a graded `Pass`/`Fail` with substrate-attested provenance, or an `Invalid`/`Unresolved` with a substrate-level cause attribution. No verdict is silently misclassified.** That property degrades gracefully — at v1 it's enforced by the harness; at A.1 by the launcher; at mainnet by the contract. There is no Phase where "FAIL" might secretly mean "we couldn't run pytest."

---

## 1. The property (answering Q10 first)

The 10th open question — "what does 'any eval works' actually mean as a property the protocol claims?" — is the load-bearing one. Every other answer falls out of it. Naming the property first makes the rest of the recommendation legible.

Four candidate properties were on the table:

| Property | What it guarantees | What it costs |
|---|---|---|
| **Reproducibility** | Same Task + same Solution → same Verdict, across operators and time | Pinned substrate; deterministic eval; substrate ownership |
| **Hermeticity** | The eval is sealed; external state cannot affect the verdict | TEE substrate (Phala) or strict trust boundary |
| **Trustless verifiability** | Anyone can independently re-run the eval and reproduce the verdict | Open substrate (public images, public dataset, public eval code) + reproducibility |
| **Liveness-under-drift** | Even when upstream substrate changes, the eval produces a *correctly classified* verdict (which may be `Invalid`, but is never silently misclassified) | A gradeable predicate + admission gating + classification polarity |

These compose. The spike's recommendation: **claim liveness-under-drift now, claim reproducibility at Phase A.1, claim trustless verifiability + hermeticity at Phase 2.** Each property gates the next.

- **v1 (Sepolia, this Monday's cut and the one after)** — the protocol claims liveness-under-drift only. Substrate is pinned where free, denylisted where pragmatic, classified honestly. No `Fail` ever masks an ungradeable.
- **Phase A.1 (multi-operator dogfood, mainnet readiness work)** — the protocol claims reproducibility. Substrate is pinned by digest; launcher attests admission; drift is detected out-of-band; every verdict carries a substrate-version pointer that future re-evaluators can resolve.
- **Phase 2 (mainnet)** — the protocol claims trustless verifiability via TEE attestation and an on-chain admission attestation. Anyone can re-run an eval and verify the substrate matches what was declared on-chain.

That phasing answers Q7 (cost model) before we write a single line of code: the cheap, structural fix happens first because it's a polarity change, not a substrate fork.

The rest of the doc grounds each recommendation in that phasing.

---

## 2. Where the boundary breaks today

The triage evidence is summarised in `jinn-mono-fufn`. The architectural cause is in **two adjacent decisions** the codebase already made, neither of which is wrong in isolation:

### 2.1 The polarity is a denylist with a Fail default

`client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:155-166` carries `INFRA_SIGNATURES`, a 10-entry regex denylist of "known infra-failure" patterns:

```ts
const INFRA_SIGNATURES: Array<{ rx: RegExp; reason: string }> = [
  { rx: /Cannot connect to the Docker daemon/i, reason: 'docker_unavailable' },
  { rx: /input\/output error/i, reason: 'docker_storage_io_error' },
  { rx: /No such image|manifest unknown|pull access denied/i, reason: 'image_pull_failed' },
  // … 7 more
];
```

The classifier (`eval-runner.ts:402-407`) fires only when **(container exit non-zero) AND (no test passed) AND (a signature matches)** — otherwise the output flows through as a normal verdict with `passed_match: false`. The harness (`harness.ts:421`) maps that to `gating.verdict: 'FAIL'`, and the engine maps `'FAIL' → VerdictCode.Fail(2)`.

The four 2026-05-14 fingerprints don't match the denylist:

- `/opt/conda/bin/python: No module named pytest` — venv-recreation bug on Princeton's basic-memory / litellm images (`xw6i`)
- `RequestsDependencyWarning … ImportError while loading conftest` — urllib3/chardet mismatch on beeware images (`y4ah`)

So they fall through to `Fail(2)`. The model's diff applied cleanly; pytest never ran; the operator's resolved-rate drops; the explorer shows a clean `FAIL` indistinguishable from a real wrong-answer.

This is a denylist with a Fail default. The structurally correct shape is an **allowlist** with an **Invalid default** — what positively counts as "graded" is small and enumerable; anything else is Invalid until proven otherwise.

### 2.2 SkippableError silently drops the verdict

The same code path has a *second* problem that's worse for the loop, not just the explorer. When `INFRA_SIGNATURES` *does* fire, the harness throws `EvalCouldNotGradeError`, which `harness.ts:370` re-wraps as `SkippableError`. The engine (`engine.ts:1075-1110`) records the run as `status: 'skipped'` and **never delivers a verdict**.

That looks fail-safe but isn't: the solver's Solution sits unresolved, the evaluator's activity counter doesn't tick, and the explorer has no signal that something tried-and-couldn't-grade. An evaluator who hits the denylist 100% of the time looks identical on-chain to an evaluator who never tried — same zero deliveries, same zero verdict signal.

The structural answer is: **deliver `Invalid(3)` on-chain instead of skipping**. The activity counter ticks (the operator did the work), the verdict is visible (no silent gap), the explorer can show the failure mode, and downstream reward distribution can refuse to compensate for `Invalid` verdicts without affecting visibility.

### 2.3 Why these two decisions made local sense

The current shape was introduced by PR #183 (uy6v.8, 2026-05-08), which fixed a *real* regression where the harness was emitting `Fail` even for cases the eval clearly couldn't grade (Docker down, patch failed to apply). PR #183 said "let's catch the obvious cases and skip them" — pragmatic, ship the loop, move on. It explicitly didn't try to enumerate everything.

So today's bug is not a regression — it's the lower bound of how far the denylist was going to take us. The drift is structural: the SWE-rebench V2 substrate is upstream, mutable, and not authored by Jinn. Every additional image, every dataset row update, every upstream `eval.py` change introduces new failure shapes the denylist won't have seen. The recursive denylist-extension treadmill is a forecast of the next year of operator pain, not a one-time fix.

---

## 3. Surface map across harnesses (answering Q5 in part)

The spike's premise is that this isn't a SWE-rebench problem — it's the same exposure pattern in every evaluator harness. The codebase confirms this and **also** surfaces the lever we already have:

`client/src/harnesses/engine/engine.ts:1765-1788` maps gating verdicts to on-chain codes:

```ts
case 'PASS':           return VerdictCode.Pass;
case 'SCORED':         return VerdictCode.Pass;
case 'FAIL':           return VerdictCode.Fail;
case 'REJECTED':       return VerdictCode.Fail;
case 'INVALID':        return VerdictCode.Invalid;
case 'INDETERMINATE':  return VerdictCode.Unresolved;
case 'UNRESOLVED':     return VerdictCode.Unresolved;
default: /* warn + */  return VerdictCode.Invalid;
```

Every evaluator-harness's `gating.verdict` string passes through this map. The default for unknown-strings is already `Invalid` (good). The four-tier vocabulary `SCORED | REJECTED | INVALID | INDETERMINATE` is already in use by `prediction-v1-evaluator`, `portfolio-v0-evaluator`, and `prediction-apy-v0-evaluator`. They each have a `deriveVerdict(checks): Verdict` function that classifies the eval's checks into the four tiers.

The asymmetry: **swe-rebench-v2-evaluator is the outlier.** It emits only `'PASS' | 'FAIL'` and never produces `INVALID` or `INDETERMINATE` — the substrate-failure branch goes to `SkippableError` instead. The other evaluators have classification machinery the swe-rebench harness lacks.

The cross-harness pattern, restated:

| Harness | Verdict states emitted | Substrate-failure handling | Polarity |
|---|---|---|---|
| `prediction-v1-evaluator` | `SCORED \| REJECTED \| INVALID \| INDETERMINATE` | `deriveVerdict()` returns `INVALID` / `INDETERMINATE` based on `checks` | Allowlist (must reach `SCORED` to score) |
| `portfolio-v0-evaluator` | `SCORED \| REJECTED \| INVALID \| INDETERMINATE` | Availability checks fail → `INDETERMINATE` | Allowlist |
| `prediction-apy-v0-evaluator` | `SCORED \| REJECTED \| INVALID \| INDETERMINATE` | Same shape as portfolio | Allowlist |
| `session-derived-evaluator` | (composite — Phase 10) | Per-signal handling | Mixed |
| **`swe-rebench-v2-evaluator`** | **`PASS \| FAIL`** | **`SkippableError` (silent skip) gated by regex denylist** | **Denylist (defaults to Fail)** |

The structural fix is to bring swe-rebench-v2 onto the same polarity as the other evaluators, then to extract the shared discipline as a SolverNet-contract-level primitive so it can't drift back.

---

## 4. Recommendation A — separate "graded?" from "passed?" at every evaluator (Q3 in detail)

The core structural fix. Every evaluator harness emits one of four verdict states, derived from two predicates:

```
gradeable(eval_output) → true | false
result(eval_output)    → 'satisfied' | 'not_satisfied'   (defined only when gradeable)
```

Mapping to the existing four-state vocabulary, with explicit semantics for each:

| `gating.verdict` | `VerdictCode` | When | "Retry helps?" |
|---|---|---|---|
| `SCORED` / `PASS` | `Pass(1)` | gradeable=true, result=satisfied | n/a |
| `REJECTED` / `FAIL` | `Fail(2)` | gradeable=true, result=not_satisfied | no (real signal) |
| `INVALID` | `Invalid(3)` | gradeable=false; cause is substrate / inputs / harness | maybe (fix substrate) |
| `INDETERMINATE` / `UNRESOLVED` | `Unresolved(4)` | gradeable=false-yet; cause is a future event (oracle window, resolution time) | yes (wait) |

Two semantic moves matter:

1. **`Invalid` is not "evaluator failed" — it's "we couldn't *get to* a graded result."** The cause can be the substrate (image, dataset, container), the inputs (patch malformed, manifest unsigned), or the harness itself (eval-code crashed). Each of these is recorded as a `failureMode` in the verdict payload's informational metadata so the explorer can distinguish *which* substrate problem.
2. **`INDETERMINATE` vs `INVALID` is not the same predicate.** `INVALID` means "this attempt cannot be graded — substrate is structurally broken." `INDETERMINATE` means "this attempt cannot be graded *yet* — we are waiting on a future event." They map to different on-chain codes (`Invalid(3)` vs `Unresolved(4)`) because they imply different downstream behaviour: `Invalid` says "fix something and retry"; `Unresolved` says "come back later."

For SWE-rebench specifically: `INDETERMINATE` is unused. The tests either run or they don't; there's no "waiting on a future event." Verdicts are `PASS | FAIL | INVALID`. For prediction.v1, `INDETERMINATE` is the right state when the market hasn't resolved yet.

### 4.1 What `gradeable` means for SWE-rebench specifically

Concretely, in `eval-runner.ts`, the predicate becomes:

> **gradeable = the eval container collected and ran every `FAIL_TO_PASS` test, and for each `PASS_TO_PASS` test we observed either a pass or fail outcome (not "errored before collection").**

Mechanically, this is a richer parse of the upstream `report.json` than today's code does. The upstream report includes per-test outcomes; today we only use `from_fail_to_pass` (intersection) and `failed_from_pass_to_pass` (set). The `gradeable` predicate needs to additionally inspect: did pytest actually load conftest? Did `python -m pytest` resolve a real pytest binary? Did the upstream `eval.py` write a non-error item to `items[]`? These are observable from the existing log path + report shape — no new substrate is required to compute them.

The denylist becomes **diagnostic, not classifier**. It still exists, but only to populate the `failureMode` reason field on `Invalid` verdicts. The classifier itself is the positive predicate.

### 4.2 Downstream consequences of switching to Invalid-by-default

- **The activity counter ticks for Invalid verdicts.** Operators who attempt evaluations get credit for trying. Reward distribution can refuse to pay out for Invalid verdicts separately — that's a reward policy, not a verdict-classification policy.
- **The on-chain `verdictCode` carries the four-state truth.** The indexer is already enriching against this enum; no schema change required to surface it.
- **The verdict envelope carries `failureMode` and a substrate-attribution payload.** This is informational metadata that the explorer reads via the existing test-log-CID path.
- **The activity-checker invariants need to be re-read.** The OLAS activity checker counts deliveries. If we emit Invalid verdicts where we previously skipped, deliveries-per-checkpoint increases. This is what we want — the operator did the work — but it changes the calibration of the reward checkpoint. Worth a one-time recheck against the activity checker's reward formula; non-blocking.

### 4.3 Backwards compatibility with existing verdicts

122 attempt envelopes and 107 verdicts pre-date this change. The on-chain Fail(2) codes for them are immutable. The explorer surfaces verdicts via the indexer + verdict-envelope-meta GraphQL surface, so a "reclassified failure mode" can be derived without rewriting history. See §11 for the backfill recipe.

---

## 5. Recommendation B — phased substrate ownership (answering Q1, Q2, Q7 jointly)

The polarity fix (Recommendation A) makes the loop honest. It does not, by itself, stop the eval container from breaking. For that, we need to gain control over the substrate — pinning what's pinnable, smoke-testing what's pullable, attesting what's the operator's. The right cut of "where does the boundary belong" is driven by what each phase needs.

### 5.1 v1 (Sepolia, ships with the polarity fix): pin upstream by digest

The cheap wins, all under one Monday cut:

- **Pin the upstream `SWE-rebench/SWE-rebench-V2` repo by commit SHA.** Today `harness.ts:51` clones `:HEAD` of the upstream repo into `<implStateDir>/upstream/`. Switch to a pinned SHA; bump it in a follow-up bd when upstream needs updating.
- **Pin per-instance Docker images by `@sha256:` digest, not `:latest`.** This is a SolverNet contract registry change: the `swe-rebench-v2.v1` task schema's `image` field becomes `image@digest`. The launcher resolves digest-from-tag once at admission and writes the digest into the on-chain Task. (Existing tasks remain valid; new admissions carry digests.)
- **Add the four known failure-fingerprints to the diagnostic denylist.** They become `failureMode` reasons on `Invalid` verdicts. This is the only place the old denylist survives, now demoted to attribution.
- **Run pytest in the dataset's pre-populated `/testbed/.venv` instead of overriding with `python -m pytest`.** This is the root-cause fix for the `xw6i` venv-recreation bug (per the investigator's transcript). The override exists to enforce node-id–scoped runs; we can keep that by switching to `.venv/bin/python -m pytest` rather than `python -m pytest`. Validated against the four known-broken instances before merge.

These changes are mechanical, well-scoped, and don't depend on architecture work. The polarity fix is the load-bearing one; the rest are bug fixes that compose with it.

Engineering budget: ~1 dev-week (split across the polarity refactor, the four bug-fix patches, and explorer surface changes).

### 5.2 Phase A.1 (next ~month): typed `EvalSubstrate` on the SolverNet contract registry

Now that the polarity fix has put the discipline in the harness, extract it into the SolverNet contract registry so every SolverType inherits it and new SolverTypes can't ship without it.

Add a new top-level field to `SolverNetContract` in `packages/sdk/src/contracts.ts`:

```ts
export interface SolverNetContract {
  // … existing fields (id, version, name, schemas, claimPolicyDefaults, …)
  evalSubstrate: {
    /** Typed description of the eval substrate's dependencies. */
    dependencies: EvalSubstrateDependency[];
    /**
     * Predicate that runs over the harness's eval output and returns whether
     * the run reached a graded state. Implementations live in-tree alongside
     * the evaluator harness.
     */
    gradeablePredicate: string;  // module ref, e.g. "@jinn-network/swe-rebench-v2-evaluator/gradeable"
    /**
     * Classifier mapping the eval output to one of {PASS, FAIL, INVALID,
     * INDETERMINATE}, given `gradeable: true`. Same shape as the existing
     * deriveVerdict() functions in prediction-v1 / portfolio-v0.
     */
    classifier: string;  // module ref
  };
}

export type EvalSubstrateDependency =
  | { kind: 'docker-image'; ref: string; digest?: `sha256:${string}` }
  | { kind: 'huggingface-dataset'; repo: string; commitSha?: string }
  | { kind: 'git-source'; repo: string; commitSha: string }
  | { kind: 'http-resolution-source'; baseUrl: string }
  | { kind: 'rpc-data'; chainId: number };
```

This gives us three things at once:

1. **Cross-SolverType uniformity.** Every SolverNet contract declares its substrate dependencies in the same shape. Prediction.v1 declares `[{kind: 'http-resolution-source', ...}]`. SWE-rebench declares `[{kind: 'docker-image', ...}, {kind: 'huggingface-dataset', ...}, {kind: 'git-source', ...}]`. Portfolio declares `[{kind: 'rpc-data', ...}]`. New SolverTypes ship the same shape.
2. **Launcher admission gating becomes typed.** The launcher walks `dependencies` at instance-admission time; for `docker-image` it pulls and runs a known-passing smoke test; for `huggingface-dataset` it fetches the row and checks shape; for `rpc-data` it checks reachability. The admission attestation is a typed list of `{dependencyIdx, status: 'ok' | 'failed', evidence}`, written into the on-chain Task as `admissionAttestation`.
3. **A path to TEE attestation in Phase 2.** The substrate description is exactly what a TEE quote needs to bind. The Phase 2 `attested` tier requires the substrate description to match what the enclave measured — that mapping is trivial once the substrate description is typed.

### 5.3 Phase A.1 (continued): launcher admission smoke-test

Before the launcher posts a Task on-chain for instance X, the launcher's SolverNet generator pulls the per-instance Docker image, runs the upstream eval against a **gold solution** (the dataset's own `test_patch`, which should pass by construction), and refuses to post if the smoke-test produces `Invalid` or `Fail`.

This catches:
- broken images (basic-memory pytest-missing)
- broken dataset rows (FAIL_TO_PASS / PASS_TO_PASS sets that don't actually match the instance)
- upstream `eval.py` regressions (the very tooling we run breaks)

before they ever become Tasks operators waste compute on. The smoke-test artifact (a verdict CID with `Pass` and the image's `@digest`) gets written into the Task's IPFS payload as `admissionAttestation`. Operators can refuse Tasks without an admission attestation (reputation-only at this phase; protocol-enforced at Phase 2).

This is the answer to **Q2 (when does the gate fire?)**: A (admission), B (solution-time), and D (continuous drift sweep) are **complementary, not substitutable**. We do A in Phase A.1, B is already mostly there (we just fix the polarity), and D follows.

### 5.4 Phase A.1 (continued): drift sweep cron

A periodic out-of-band sweep that takes the admitted instances and re-runs the gold-solution smoke-test against each. If a previously-admitted instance now produces `Invalid` (image got worse, dataset row drifted), the sweep emits an alert and Auto-marks the instance as `degraded` in the launcher's local state. The explorer surfaces a per-instance health badge.

This catches the third class of substrate failure: pinned-by-tag images that get re-tagged upstream, or dataset rows that mutate after admission. Cheap to run (one Docker pull + one pytest per instance per week), high-value signal.

### 5.5 Phase A.1 (continued): backfill reclassification

The 107 existing verdicts on Sepolia can be reclassified offline. For each verdict envelope:

1. Fetch the `test_log_cid` from the envelope's informational metadata.
2. Run the new `gradeablePredicate` over the log.
3. Emit a `verdict-reclassification.v1` artifact pinning the new classification (`Pass | Fail | Invalid`) and the `failureMode` reason.
4. The indexer surfaces this artifact in `verdictEnvelopeMeta` queries; the explorer reads it and shows the reclassified state alongside the immutable on-chain `Fail(2)`.

This is **derived data, not a chain rewrite.** The on-chain history stays honest about what was recorded; the explorer shows what the substrate now says about it.

Engineering budget for the whole Phase A.1 block: ~1 dev-month, parallelizable across the typed-substrate work and the admission-gate work.

### 5.6 Phase 2 (mainnet gate): protocol-enforced admission + TEE attestation

When Phase 2 lands, **admission attestation becomes a required protocol property**, not a reputation property. ValidationRegistry refuses Tasks without an `admissionAttestation` signed by a registered launcher identity. This is the same upgrade pattern as ERC-8004's other registries — testnet ships the property as advisory; mainnet enforces it.

In parallel: the **TEE-attested eval tier** (per `spec/2026-04-23-jinn-execution-envelope-tee-scope.md`) attests the *executor* side; this spike's recommendation extends the same vocabulary to the *eval substrate* side. An attested eval is one where the eval substrate's measured identity (Docker image digest, dataset commit SHA, eval-code source) matches what the SolverNet contract declares, and the TEE attestation quote binds them. The `attested` evidence tier becomes meaningfully stronger because the verdict-side substrate has the same property the executor-side substrate already does.

That answers **Q6 (TEE attestation's place)**: TEE is **complementary**, not substitutable. The polarity fix and admission gating must land before TEE is worth activating — TEE without correct classification just gives you a hermetic environment that confidently produces a misclassified `Fail`. Order matters.

---

## 6. The launcher / solver / evaluator contract (Q4)

The protocol-level contract between the three roles, after the recommendation:

```
Launcher   →  produces Task; signs `admissionAttestation` over (substrate description, gold-solution smoke verdict)
Solver     →  produces Solution; signs `restoration` envelope over (Task ref, patch, executor identity)
Evaluator  →  produces Verdict; signs `verdict` envelope over (Solution ref, classification, failureMode, substrate proof)
```

Three distinct signing roles, three distinct trust anchors, three distinct failure modes the protocol can attribute. Today's loop has only two of these (solver + evaluator); the launcher's role is implicit (whoever calls `JinnRouter.createRestorationJob`).

**Trust placement:**

- **Launcher vouches that the substrate works at admission time.** If the substrate is broken when the operator runs it, that's *new* evidence the launcher needs to act on (alert, drift sweep, remove instance) — not the operator's reputation hit.
- **Solver vouches for the solution + executor identity.** Unchanged from today (per `spec/2026-04-23-jinn-execution-envelope-tee-scope.md`).
- **Evaluator vouches that the classification predicate ran honestly.** Bonded behaviour in Phase B.2.

Required vs reputation:

- **v1 (Sepolia):** `admissionAttestation` is a reputation property. Operators see it in the explorer; they can refuse Tasks without one; the chain doesn't enforce.
- **Phase A.1:** Same property, now signed and validated by the local plugin loader. Still reputation; we want the property in real-world use before locking the on-chain enforcement.
- **Phase 2 (mainnet):** Required protocol property. `JinnRouter` refuses Tasks without a valid attestation.

This staged trust-promotion is consistent with the canonical-docs cadence pattern: ship the property as advisory; enforce on the chain only after the property has survived multi-operator dogfood.

---

## 7. Cross-SolverType generalisation, completed (Q5)

The typed `EvalSubstrate` primitive in §5.2 is the answer. Spelled out per harness:

| SolverType | Substrate dependencies | Gradeable predicate | Classifier output |
|---|---|---|---|
| `swe-rebench-v2.v1` | docker-image, huggingface-dataset, git-source | pytest ran every F2P + every P2P observed | PASS, FAIL, INVALID |
| `prediction.v1` | http-resolution-source (Polymarket / UMA) | resolution exists + checks pass | SCORED, REJECTED, INVALID, INDETERMINATE |
| `portfolio.v0` | rpc-data | RPC reachable + canonical metrics computable | SCORED, REJECTED, INDETERMINATE |
| `prediction-apy.v0` | rpc-data, http-resolution-source | both available + integrity checks pass | SCORED, REJECTED, INDETERMINATE |
| `session-derived.v1` | docker-image (re-run), llm-judge-api, structural-similarity-corpus | composite: all three sub-signals reached | SCORED, REJECTED, INVALID, INDETERMINATE |

Each `evalSubstrate.dependencies` entry is typed; each has a uniform `liveness` check (admission-time) and `integrity` check (digest/commit pin); each harness ships its own `gradeablePredicate` and `classifier`.

**Shared concerns live in the SolverNet contract registry** — the typed substrate description, the verdict-state vocabulary, the admission-attestation envelope shape. **Per-SolverType concerns live in the harness** — the actual predicate logic, the substrate-specific log parsing, the failure-mode taxonomy. The boundary is clean, the surface is enumerable, and adding a new SolverType requires writing a contract + harness without re-deriving the classification discipline from scratch.

---

## 8. Upstream story (Q8)

The basic-memory venv recreation bug and the beeware urllib3 mismatch are upstream Princeton issues. Two postures:

- **File upstream issues, work around in-tree.** Fastest. Lets us unblock without forking. Upstream has incentive to fix because their published image being internally inconsistent with their dataset row is bad for *their* benchmark too.
- **Fork the dataset.** Heavier. Buys us a deterministic snapshot. Costs us CI + registry + ongoing sync work.

Recommendation: **file upstream issues now, work around in-tree, defer forking until Phase A.1's drift sweep produces evidence we have ≥10 instances Princeton won't fix on a useful timeline.** Forking before then is premature ownership for a benefit we may not need.

Specifically:

- **xw6i (venv recreation)** — file an issue against `nebius/SWE-rebench` (the dataset publisher) noting the install line is inconsistent with the image's pre-populated `/testbed/.venv`. Mitigate in-tree by either (a) appending `--clear` to uv venv lines in the dataset row before passing to the eval, or (b) switching `buildTestCommands` to `.venv/bin/python -m pytest` to use the pre-populated venv.
- **y4ah (urllib3 dependency warning)** — file an issue against `swe-rebench/SWE-rebench-V2` (the image publisher) noting the image's Python deps need an upgrade. Mitigate in-tree by adding a `pip install -U urllib3 charset_normalizer chardet` line ahead of `test_cmd` for beeware instances.

Both mitigations are reversible — once upstream lands fixes, our overrides become no-ops; we remove them at next image-digest bump.

This doesn't affect any decision in Q1-Q7. It's strictly the "what do we do this week about the four specific failing instances" answer.

---

## 9. Backfill / historical-correctness (Q9)

The 107 verdicts and 122 attempt envelopes are immutable on-chain, but the explorer's display of them is not. Two layers:

1. **No chain rewrite.** The on-chain `verdictCode` for historical verdicts stays `Fail(2)`. Honesty about the record.
2. **Derived reclassification at the explorer.** Per §5.5, an offline sweep produces `verdict-reclassification.v1` artifacts for every historical verdict, pinned to IPFS. The indexer enriches them onto `verdictEnvelopeMeta`. The explorer shows both: the immutable on-chain code, and the substrate's current verdict given the new predicate.

For public viewers: the explorer surfaces the pre-/post-reclassification pass-rate side by side with a one-line note about why they differ. This is more honest than silently rewriting — the protocol *did* record a Fail; the substrate *now* says it was Invalid; both are true at different times.

---

## 10. Open questions, answered

| # | Question | Answer (with reference) |
|---|---|---|
| 1 | Where does the eval boundary belong? | Thin shim + pin upstream by digest at v1 (§5.1); typed `EvalSubstrate` primitive at A.1 (§5.2); TEE-attested at Phase 2 (§5.6). Forking upstream only triggers on evidence from §5.4's drift sweep. |
| 2 | When does the gate fire? | At admission (launcher pre-flight per §5.3), at verdict time (the polarity fix per §4), and continuously (drift sweep per §5.4). Complementary, not substitutable. |
| 3 | What's the right verdict polarity? | Allowlist with `Invalid` default. Four-state vocabulary `Pass | Fail | Invalid | Unresolved`, mapped from existing four-state `SCORED | REJECTED | INVALID | INDETERMINATE` already in use by other evaluators (§4). `Invalid` ≠ `Unresolved`: the former is "substrate broken, retry won't help"; the latter is "waiting on a future event, retry later." |
| 4 | Protocol-level contract between launcher / solver / evaluator? | Three signing roles: launcher signs admission, solver signs solution, evaluator signs verdict (§6). Admission attestation is reputation-only at v1, protocol-enforced at Phase 2. |
| 5 | Cross-SolverType generalisation? | Yes — typed `EvalSubstrate` primitive on `SolverNetContract` (§5.2 + §7). Shared concerns at the contract layer; per-type predicate logic at the harness. |
| 6 | TEE attestation's place? | Complementary, not substitutable. Composes on top of polarity + admission gating + digest pinning; activates at Phase 2 (mainnet) per `spec/2026-04-23-jinn-execution-envelope-tee-scope.md`. Order matters — TEE without correct classification is a hermetic misclassifier. |
| 7 | Cost model? | v1: ~1 dev-week (polarity + 4 fingerprint fixes + explorer surface). Phase A.1: ~1 dev-month (typed substrate + admission gate + drift sweep + backfill). Phase 2: gates mainnet; substantial. (§5 throughout.) |
| 8 | Upstream story? | File issues, work around in-tree, defer forking (§8). Reverses cleanly once upstream lands fixes. |
| 9 | Backfill / historical correctness? | Derived reclassification artifacts; no chain rewrite (§9). Honest about both the on-chain record and the current substrate verdict. |
| 10 | "Any eval works" — what property? | Liveness-under-drift at v1 → reproducibility at A.1 → trustless verifiability + hermeticity at Phase 2 (§1). Each phase claims a stronger property; no phase silently misclassifies. |

---

## 11. The property statement (for SPEC / canonical-doc citation)

When all three layers land, the protocol claims:

> **Every accepted Solution produces a Verdict in one of four states — `Pass`, `Fail`, `Invalid`, `Unresolved` — with the substrate identity that produced the verdict bound to the verdict envelope. There is no silently misclassified verdict. Solvers, evaluators, and external observers can independently re-derive the classification given the verdict's substrate pointer.**

This is the property the spike commits the SolverNet eval boundary to. It composes with `spec/2026-04-23-jinn-execution-envelope-tee-scope.md`'s executor-side property (executor identity bound to the restoration envelope) to give the full protocol-loop trust shape: both the *thing that ran* and the *thing that graded it* are identifiable and verifiable.

Phase B's evaluator economics (`Phase B.2` per `cargo/CLAUDE.md`) then has a clean foundation to build bonded-evaluator slashing against — `Invalid` verdicts can be challenged with substrate evidence; `Fail` verdicts can be challenged with test-log evidence; the dispute primitives have an honest signal to bond against.

---

## 12. What this spike does NOT decide

Out-of-scope for this spike (consistent with `jinn-mono-fufn`'s "out of scope" section):

- **Implementation.** Output is this finding. Implementation bds get filed against it after Captain review.
- **Per-image fixes for specific basic-memory / litellm / beeware instances.** Re-scoped under their existing bds (§13).
- **Reward-distribution mechanics for Invalid verdicts.** Touched briefly in §4.2 but the actual policy (do Invalid verdicts earn rewards? at what fraction? bonded?) is a Phase B.2 design surface, not eval-substrate.
- **Multi-evaluator consensus.** When multiple evaluators disagree on a verdict's classification — that's evaluator-economics-design, not substrate-design.
- **The exact wire shape of `admissionAttestation`.** §5.2 sketches it; the precise envelope shape is a design-spec decision for the Phase A.1 work (a new spec under `spec/2026-XX-eval-substrate-protocol.md`).
- **Whether the `attested` evidence tier's source-bundle requirement applies to evaluator substrate too.** That's an extension of `spec/2026-04-23-jinn-execution-envelope-tee-scope.md` §3 to the verdict side. The TEE spec scope today is executor-side; expanding it is part of Phase 2 mainnet-readiness work.

---

## 13. Bd disposition

The five symptom bds blocked by this spike, with the post-spike disposition:

| Bd | Status today | Post-spike disposition |
|---|---|---|
| `jinn-mono-xw6i` (venv recreation + pytest missing) | Open P1, blocked by fufn | **Re-scope** as the v1 mitigation bd: add `--clear` to uv venv lines or switch to `.venv/bin/python -m pytest`; validate against the four affected instance IDs; file upstream issue. Run-mode: `fix`. Closes when all four instances pass a fresh grading run. |
| `jinn-mono-y4ah` (urllib3 mismatch) | Open P1, blocked by fufn | **Re-scope** as the second v1 mitigation bd: pre-`pip install -U urllib3 charset_normalizer chardet` ahead of `test_cmd` for affected images; file upstream issue. Run-mode: `fix`. |
| `jinn-mono-b609` (Invalid vs Fail classification) | Open P2, blocked by fufn | **Re-scope** as the polarity-fix bd — the load-bearing structural change in §4. Bump to **P1**. Run-mode: `feat`. AC: every eval-substrate failure emits `Invalid(3)` with a `failureMode`; the four 2026-05-14 fingerprints are diagnostic reasons, not load-bearing classifiers. |
| `jinn-mono-tptp` (explorer per-verdict failureMode + test_log_cid) | Open P3, blocked by fufn | **Keep as-is, unblock.** The polarity fix populates the data this bd surfaces. Run-mode: `feat`. |
| `jinn-mono-nf92` (evaluator_cost_usd always 0) | Open P3, blocked by fufn | **Keep as-is, unblock.** Adjacent, not core to the spike. Run-mode: `fix`. Owns its own AC. |

New bds to file after Captain approval (Phase A.1 work):

- **`evalSubstrate` typed primitive on `SolverNetContract`** — `refactor` shape. Adds `evalSubstrate: {dependencies, gradeablePredicate, classifier}` to the SolverNet contract type; backfills the three existing contracts.
- **Launcher admission smoke-test for SWE-rebench v2** — `feat` shape. The launcher generator pulls each candidate image, runs the gold-solution smoke, and refuses to post on `Invalid`/`Fail`. Writes `admissionAttestation` into the Task IPFS payload.
- **Drift-sweep cron + per-instance health badge in explorer** — `feat` shape. Periodic out-of-band gold-solution sweep; explorer health badge.
- **Backfill reclassification of historical SWE-rebench v2 verdicts** — `chore` shape. One-shot sweep over the 107 verdicts; emits `verdict-reclassification.v1` artifacts; indexer surfaces.
- **Pin upstream `SWE-rebench/SWE-rebench-V2` clone by SHA** — `chore` shape. Tied to v1; can ride with the b609 polarity fix.
- **Pin per-instance Docker images by digest** — `feat` shape. Touches the SolverNet contract schema for `swe-rebench-v2.v1` Tasks.

New bds to file for Phase 2 work (deferred, no immediate filing):

- Protocol-enforced admission attestation in ValidationRegistry (mainnet gate; companion to `jinn-mono-gu8q`).
- TEE-attested eval substrate (extends `spec/2026-04-23-jinn-execution-envelope-tee-scope.md` to verdict side).

---

## 14. Specs / DRs the recommended path needs

Before any implementation bd lands against the Phase A.1 work, write:

1. **`spec/2026-XX-eval-substrate-protocol.md`** — the protocol-level contract: typed `EvalSubstrate` primitive, the `admissionAttestation` envelope shape, the four-state verdict vocabulary as a SPEC-level commitment (not just a per-harness convention), the substrate-pointer field on verdict envelopes. Status: not yet drafted.
2. **`log/decisions/2026-XX-verdict-polarity.md`** — DR ratifying the polarity flip from "denylist + Fail default" to "allowlist + Invalid default" across all evaluators. Cites this spike. Light-weight; one-page.
3. **Amendment to `spec/2026-05-01-harness-pack-architecture.md`** — §5.6 (Schema authority lives with the SolverNet contract) extended to mention `evalSubstrate` as a peer of `evaluationFunction` and `claimPolicyDefaults`. Currently the spec says "schemas, evaluator, default substrate" — we're adding "eval substrate" as a typed bundle.
4. **Update to `cargo/CLAUDE.md` §Phased Rollout** — Phase A.1's "evidence-schema work" line gets extended to call out the eval-substrate work as a peer commitment, so the canonical doc reflects what Phase A.1 actually contains.

These don't all need to land before implementation. Order: (2) DR first (locks the polarity decision so the v1 bds can proceed against it), (3) and (4) as part of the Phase A.1 PR (canonical-doc + spec-amendment land together), (1) before any of the typed-substrate bds.

---

## 15. Review questions for Captain

The spike's recommendation depends on a few judgement calls only Captain can ratify:

1. **Verdict polarity decision** — is "allowlist with Invalid default" the right policy for *every* evaluator, not just SWE-rebench? Prediction and portfolio are already there; SWE-rebench is the laggard. Confirming this lets the v1 bd (b609 re-scope) proceed.
2. **Activity counter implications** — if we emit `Invalid` deliveries where today we silently skip, the operator's deliveries-per-checkpoint count changes. Does this require recalibrating the activity checker's reward formula? (My read: no, but worth a one-line check.)
3. **Admission-attestation reputation-vs-required path** — is "reputation at v1 / A.1, required at Phase 2" the right phasing? I read this as consistent with how ERC-8004 properties are ratified, but the line could be drawn elsewhere.
4. **Upstream forking trigger** — §5.4's drift sweep proposes an evidence threshold ("≥10 instances Princeton won't fix on a useful timeline") for forking the dataset. Is that the right threshold, or should we fork preemptively given the multi-operator dogfood threat?
5. **Property statement (§11)** — does the SPEC-level commitment to a four-state verdict vocabulary need a CODEOWNERS approval before the polarity fix can merge? My read: it's already implicit in the existing `verdictCodeForTask` machinery; making it explicit is a docs change, not a protocol change. But if it counts as a canonical-doc change, the v1 bd timeline shifts.

The spike's recommendation hangs together regardless of how (4) and (5) resolve. (1)-(3) are load-bearing for the v1 bd's framing.

---

## 16. Related material

- `jinn-mono-fufn` (this bd) — origin
- `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:155-166` — current denylist
- `client/src/harnesses/engine/engine.ts:1765-1788` — `verdictCodeForTask` mapping
- `client/src/adapters/mech/verdict-code.ts` — `VerdictCode` enum (PR #193 / uy6v.7)
- `packages/sdk/src/contracts.ts:71-86` — `SolverNetContract` type to be extended
- `spec/2026-05-01-harness-pack-architecture.md` §5.6 — schema authority lives with the SolverNet contract
- `spec/2026-04-23-jinn-execution-envelope-tee-scope.md` — TEE work, executor side (this spike extends to verdict side)
- `log/decisions/2026-05-08-swe-rebench-v2-loop-closed.md` — single-operator loop closure that produced the manifest still live today
- `log/decisions/2026-05-13-keep-self-eval-bypass-on-testnet.md` — trust-property splits between testnet and mainnet
- PR #183 — introduced the current denylist + Fail polarity
- Investigator transcript (xw6i) — full attribution chain for the venv-recreation bug
