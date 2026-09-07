# Prediction-forecast paired scoreability — provenance is task metadata, not work payload

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-09-02; adopted 2026-09-05 |
| **Author** | Autopilot design session (Claude Opus 5); every seam citation read against the attempt base of `autopilot/2606` (`31a763d60`) and re-verified against `24611b57a` at adoption |
| **Shape** | `design`. Output is this spec; implementation lands as a separate packet (§7) |
| **Status** | **Adopted.** D1–D3 answered by operator ruling 2026-09-05; recorded as [DR-2026-09-05](../../../log/decisions/2026-09-05-prediction-forecast-task-provenance-extension.md) |
| **Issue** | [#2606](https://github.com/Jinn-Network/mono/issues/2606) |
| **Supersedes the premise of** | [P4b scoping §6.1](../plans/demo-report-1/P4b-scoping.md) and [P4b implementation plan, Task 8a](../plans/demo-report-1/2026-08-12-P4b-implementation-plan.md) — their conclusion was correct *when written*; one of the two contracts they cite moved the day after (§2.2) |
| **Does not do** | It proposes no change to `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1`, no new admission-policy version, no re-seal of `prediction-forecast/1.0`, and no change to any method's statistics. It moves nothing that is frozen |

## 0. Decision in plain language

**Yes — prediction-forecast tasks should be scoreable by clustered paired
methods, and the way to get there costs one additive read in one package.**

The issue asks a product question and assumes a heavy answer: that saying yes
means a `v2` admission policy. That assumption was true on 2026-08-12 and
stopped being true on 2026-08-13. The frozen v1 policy already admits a
namespaced top-level extension key on a prediction Task — there is a passing
test that proves it (§2.2). So provenance has a legal home on a prediction Task
*today*, under the unchanged frozen contract.

The one thing still blocking is on the reader side:
`resolveBenchmarkTaskProvenance` looks in exactly one place,
`task.data.payload["provenance"]`, and prediction tasks structurally cannot put
it there. The fix is to teach that one resolver a second, profile-agnostic
location — the namespaced top-level extension — and to keep the payload
location as the profile-declared one that `repository-work/1.0` already uses.

That reframes the answer. This is not "should we weaken a frozen contract to
score a profile?" It is: **provenance is metadata about where a task came from,
not part of the work handed to the solver, and the resolver currently reads it
from the one place it does not belong.** `repository-work/1.0` gets away with
the payload because its `payloadSchema` is open (`additionalProperties: true`,
`repository-work-1.0.ts:20`) and declares `provenance` explicitly. Every profile
with a closed payload — `prediction-forecast/1.0` today, every future bounded
venue profile — is excluded by an accident of where one reader happens to look.

## 1. The question, restated

*Should prediction-forecast tasks be scoreable by clustered paired methods?*

The issue names three methods. The registry actually has **five** that declare
`clusteringRule: "task-provenance-source"`
(`aggregate/src/registry.ts:230,240,250,261,322`):

- `paired-mcnemar@1`
- `provenance-cluster-sign@1`
- `noninferiority-iut@1`
- `paired-delta@1`
- `paired-majority-delta@1`

All five call `resolveTaskProvenance` (`aggregate/src/resolved-inputs.ts:314`),
which raises a typed `MethodInputError("task-provenance-source-missing", …)`
when the underlying records resolver refuses. So the blast radius is the whole
clustered-comparison half of the method registry, not three methods.

## 2. What the record actually says now

### 2.1 The reader side — unchanged, and it is the real blocker

`records/src/benchmark/checks.ts:56-58` resolves provenance from exactly one
location:

```ts
const payload = task.data.payload;
const provenance = typeof payload === "object" && payload !== null && !Array.isArray(payload)
  ? (payload as Record<string, unknown>)["provenance"] : undefined;
```

No fallback, no alternative accepted location. Absent or malformed → `ok:
false, reason: "invalid-provenance"`.

This half of the issue's diagnosis is **exactly right and still current**.

### 2.2 The writer side — the issue's second premise is stale

The issue states: *"`:125` likewise closes the Task object to exactly
`evaluation,instructions,outputs,payload,profile,protocol`"*, and concludes
provenance "cannot live as a top-level sibling."

That was true when the issue was filed. Commit `6e8b9177c` (*fix(ci): close
benchmark publication integration gaps*, **2026-08-13**, one day later) replaced
the exact-key join with an open-to-namespaced-extensions predicate
(`prediction-snapshot.ts:122-128`):

```ts
const requiredTaskFields = ["evaluation", "instructions", "outputs", "payload", "profile", "protocol"];
const taskFields = Object.keys(task);
… || !requiredTaskFields.every((field) => taskFields.includes(field))
  || taskFields.some((field) => !requiredTaskFields.includes(field) && field !== "author" && !/^[a-z][a-z0-9+.-]*:/iu.test(field))
```

A top-level key is admitted if it is `author` or matches an absolute-URI scheme
(TEP §21.3 namespacing). This is not an inference from reading the regex —
`prediction-snapshot.test.ts:83` is a passing test named *"admits the same
native contract with a self-declared author and namespaced derivation
metadata"*, and it admits a Task carrying
`"https://product.example/extensions/derivation/v1"` at the top level.

Note the shape constraint the regex imposes: reverse-DNS namespacing alone is
insufficient here. `jinn.benchmarking/cell` (the style used for Submission
extensions) has no scheme colon and would be **refused**;
`https://spec.jinn.network/…` and `urn:…` are admitted. Any key chosen must be
an absolute URI.

### 2.3 The payload side — closed at the *profile*, not only at admission

The issue attributes the payload closure to the admission policy
(`prediction-snapshot.ts:164`, `Object.keys(payload).sort().join(",") !==
"forecast"`). That is one of two closures. The sealed profile document itself
closes it:

```ts
payloadSchema: { type: "object", additionalProperties: false,
  properties: { forecast: { … } }, required: ["forecast"] }
```

(`prediction-forecast-1.0.ts:16-33`.) So `payload.provenance` is not merely
refused by a policy that could be versioned — it would require re-sealing
`prediction-forecast/1.0`, moving `PREDICTION_FORECAST_PROFILE_DIGEST`, and
cascading that digest through the admission policy, the `prediction-v1-baseline`
launcher and the pinned `profile.sha256` fixture. The comment block at
`prediction-forecast-1.0.ts:61-72` records what happened the last time that
digest moved: every prediction solve was rejected.

This makes the payload route strictly *more* expensive than the issue assumed,
and the top-level route strictly *less*. The answer flips accordingly.

### 2.4 Scope of the current failure — narrower than "the sample is broken"

`checkJudgeability` is what turns `invalid-provenance` into a benchmark-level
refusal, and it is called with Task bytes only on the SWE-bench import path
(`interop/src/import/swebench.ts:181`). `defineBenchmark`
(`swebench.ts:106-128`) does **not** call it, so `buildSampleBenchmark`
(`benchmark-product/core/src/intake/sample.ts:156`) seals and passes today. The
bundled sample is not broken; it is *unpairable*. A paired method invoked
against it fails at method-compute time with a typed
`task-provenance-source-missing`, and a third party running
`checkJudgeability` over it with the Task bytes in hand would get
`invalid-provenance` on all three items.

### 2.5 What the sample can and cannot reach either way

The bundled sample has exactly three tasks
(`sample.ts:58-80`), against `paired-delta@1`'s `minN = 5`. Provenance is
therefore necessary but not sufficient for an interval-present demo on the
sample path — the P4b plan already recorded this
(`2026-08-12-P4b-implementation-plan.md:636`). With provenance, the sample
reaches *interval-withheld with a stated reason*, which is a legible product
state; without it, the sample reaches a typed refusal, which reads as a bug.
Whether to grow the sample past five items is a separate product call (D3).

## 3. Why the answer is yes

Three reasons, in decreasing order of weight.

**3.1 Nothing about a forecast task makes a paired comparison invalid.** The
clustered paired methods compare two solver policies over one shared task
slate. They are policy-comparison instruments, and the registry declares them
profile-agnostically — `requiredInputs` names `task-provenance-source`, not a
profile. Excluding one profile permanently would make that contract silently
profile-conditional, with the condition written nowhere.

**3.2 The dependence the clustering corrects for is real here too.** Whole-
source-cluster bootstrapping exists because tasks mined from one repository are
statistically dependent, so treating them as independent draws overstates
precision. Prediction snapshots have exactly the analogous structure: snapshots
taken from one market venue, in one observation window, on correlated
questions, are not independent. Refusing to cluster prediction tasks does not
avoid the dependence — it just leaves it uncorrected the moment anyone runs an
unclustered method on them.

**3.3 It is the first thing a new user runs.** The bundled sample is the empty-
workspace on-ramp (BP-11). A typed `invalid-provenance` refusal on it, with no
explanation of why it can never succeed, is the failure mode the issue names —
and it is a first-run failure mode.

The one genuine argument for "no" was cost, and §2.2/§2.3 dissolve it: the
expensive route (payload) is not the one being proposed, and the proposed route
touches nothing frozen.

## 4. Three ways to say yes, and the one to take

| | Route | What it changes | Verdict |
|---|---|---|---|
| **A** | `payload.provenance` via a re-sealed `prediction-forecast/1.1` + `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V2` | New sealed profile digest; new policy version; cascade through admission, launcher, pinned `profile.sha256`; two live prediction contracts to maintain | **Rejected.** Highest cost, and it entrenches the modelling error — provenance is not solver-visible work |
| **B** | Namespaced top-level extension + one additive resolver location | One additive branch in `records/src/benchmark/checks.ts`; sample synthesises the key; sample digest moves | **Selected** |
| **C** | Make provenance optional in the five methods | Nothing structural | **Rejected.** P4b §5.4 ratified fail-closed: optional provenance silently disables the whole-source-cluster correction and reports a narrower interval than the data supports. That is a wrong number, not a missing one |

## 5. The decision, precisely stated

### 5.1 The canonical home for task provenance

Task provenance is carried at the **top level of the sealed Task**, under the
absolute-URI extension key:

```
https://spec.jinn.network/task-provenance/v1
```

with the value shape the resolver already requires: `timestamp` (calendar-strict
RFC 3339) plus **exactly one** of `source` (non-empty string) or
`sourceCommitment` (`sha256:<64 hex>`), and `kind` where the profile declares it.

`payload.provenance` remains **legal and unchanged** as the profile-declared
location for profiles whose `payloadSchema` declares it —
`repository-work/1.0` today. No existing task, importer, fixture or digest
moves.

### 5.2 The resolver contract

`resolveBenchmarkTaskProvenance` accepts provenance from either location:

1. `task.data.payload["provenance"]` — the profile-declared location;
2. `task.data["https://spec.jinn.network/task-provenance/v1"]` — the
   profile-agnostic location.

**Both present → `invalid-provenance`.** Fail closed on ambiguity rather than
inventing a precedence rule: a Task carrying two provenance claims is corrupt,
and a precedence rule would let the shadowed one drift unnoticed. This matches
the exactness discipline the surrounding code already applies (the
`sourcePresent === commitmentPresent` refusal at `checks.ts:63` is the same
move — exactly one, never both, never neither).

Neither present → `invalid-provenance`, exactly as today. Every currently
passing input keeps its current outcome; the change is purely additive.

### 5.3 What is deliberately **not** changed

- `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1` — untouched. Its exact-key payload
  closure (`payload` is exactly `{forecast}`, `prediction-snapshot.ts:164`)
  still holds, and issue #2606's third acceptance criterion is satisfied by
  construction rather than by promise.
- `sample.ts`'s `admitPredictionSnapshot` sanity call — untouched, and still
  load-bearing. It keeps proving the frozen contract holds; under this design it
  additionally proves the extension key is admissible, which is exactly the
  property being relied on.
- `prediction-forecast/1.0` and its sealed digest — untouched.
- The five methods' statistics, `minN` floors, exclusion rules and reference
  sets — untouched.

## 6. What provenance a prediction snapshot asserts

The issue flags this as a data-modelling question in its own right, because
these tasks are generated rather than mined. Proposed answer:

| Field | Live venue snapshot | Bundled sample |
|---|---|---|
| `kind` | `live` — observed from a real market at a real instant | `synthetic` |
| `source` | the market **venue** origin (e.g. `https://<venue-host>`), never the individual market URL | one fixed synthetic origin |
| `timestamp` | the snapshot's `payload.forecast.observedAt`, verbatim | the variation's fixed `observedAt` |

The `source`-is-the-venue choice is the same lesson #2585 taught on the
SWE-bench side: the cluster key was `https://github.com/<repo>@<base_commit>`,
which made every task its own singleton cluster and silently defeated the
correction (`interop/src/import/swebench.ts:81-90`). A per-market `source`
would repeat that mistake exactly. Venue-level clustering is what makes the
between-cluster correction do work; the market identity is not lost, it stays
task identity via `payload.forecast.marketId`.

Two consequences worth stating plainly:

- The bundled sample's three tasks share one synthetic source, so they form
  **one cluster**. `paired-delta@1` will report `interval: null` with a stated
  reason (fewer than two clusters, and fewer than five paired tasks). That is
  the correct, legible outcome — a withheld interval with a reason, not a
  refusal.
- `kind` is not read by `resolveBenchmarkTaskProvenance` at all; it is
  descriptive. It is included because `repository-work/1.0` declares it and
  consistency costs nothing.

## 7. Implementation packet

Filed as [#4098](https://github.com/Jinn-Network/mono/issues/4098) (`feat`), blocked on #2606 until this spec and its DR land. Four slices, each
independently verifiable.

**S1 — resolver (records).** Add the second accepted location and the
both-present refusal to `resolveBenchmarkTaskProvenance`
(`records/src/benchmark/checks.ts:35-72`). Export the extension key as a named
constant so no consumer transcribes it. Tests: payload-only admits (unchanged);
extension-only admits; both-present refuses `invalid-provenance`;
neither refuses; malformed extension value refuses on each of the same grounds
the payload path already refuses on.

**S2 — sample synthesis (benchmark-product).** In
`buildSampleBenchmark` (`intake/sample.ts:156-202`), attach the extension key to
each variation alongside the existing `candidateTask.payload` replacement
(`:168`), with the fixed synthetic values of §6 — no wall clock, so the sample
stays byte-reproducible. The existing `admitPredictionSnapshot` sanity call is
what proves the result still satisfies the frozen contract; do not weaken it.
The sample benchmark digest **moves**: every pinned fixture updated deliberately
and each one called out in the PR body.

**S3 — paired method on the sample path.** A test that runs one clustered
paired method over the sample and asserts it produces a result with
`interval: null` and a surfaced withholding reason — not a typed refusal. This
is the acceptance test for the whole packet.

**S4 — profile-facing documentation.** Record on `prediction-forecast/1.0`, and
in the benchmarking design docs, that provenance rides the top-level extension
for closed-payload profiles and the payload for profiles that declare it. This
also discharges #2606's second acceptance criterion in the "yes" direction: the
reader of the prediction profile finds the mechanism rather than a mystery.

Regression risk is concentrated in S2 (digest movement). S1 is additive and
cannot change any currently passing outcome.

## 8. Non-goals

- Growing the bundled sample past `minN = 5` (see D3).
- Any change to the five methods' statistics or floors.
- A general "provenance registry" or provenance attestation format. This design
  moves one key to a second legal location; it does not model provenance more
  richly than the resolver already requires.
- Retrofitting existing `repository-work` tasks to the new location. They stay
  where they are, indefinitely.

## 9. Decisions taken

Answered by operator ruling on 2026-09-05 and recorded as
[DR-2026-09-05](../../../log/decisions/2026-09-05-prediction-forecast-task-provenance-extension.md).
The questions are kept in their original form so the record shows what was
asked, not only what was answered.

**D1 — Adopt the "yes" answer at all?** *Asked:* the recommendation is yes (§3);
a "no" is defensible only as a class-wide position that clustered comparison is
out of scope for bounded venue profiles, which needs stating explicitly because
it binds every future venue profile. **Answered: adopted, yes.**
Prediction-forecast tasks are scoreable by the clustered paired methods, on
route B (§4).

**D2 — The extension key spelling.** *Asked:* `https://spec.jinn.network/task-provenance/v1`
is proposed; the only hard constraint is the scheme colon (§2.2).
**Answered: as proposed** — `https://spec.jinn.network/task-provenance/v1`.

**D3 — Does the bundled sample grow to ≥5 tasks across ≥2 clusters?**
*Asked:* out of scope for this design; with this design the sample reaches
interval-withheld-with-a-reason, which is honest. **Answered: unchanged** — the
sample does not grow. It stays at its three fixed variations sharing one
synthetic source, below both thresholds named in the question, and reports a
withheld interval with a stated reason. Whether the first-run demo should show
an interval instead remains a separate product call.

> The ruling words D3 as "unchanged at 5 tasks / 2 clusters". Those two numbers
> are the thresholds this question named (`paired-delta@1`'s `minN = 5`; the two
> clusters clustering needs), not the sample's size —
> `SAMPLE_FORECAST_VARIATIONS` (`intake/sample.ts:58-80`) holds three variations
> against one synthetic source, as §2.5 and §6 state. The substantive
> ruling — *unchanged* — is unambiguous either way.

## 10. The path not taken

Kept for the record: this is what a "no" answer would have obliged, and D1
declined it. Nothing below is an outstanding obligation.

Had the answer been "no", the decision would still have been recordable, and one
obligation would follow from #2606's second acceptance criterion: the limitation
must be documented where a prediction-profile reader meets it. Minimally that is
(a) a note on `buildPredictionForecastProfile` stating that the closed
`payloadSchema` and the resolver's single read location together make the
profile unscoreable by the five clustered methods, and why that is intended; and
(b) a note at `resolveBenchmarkTaskProvenance` naming closed-payload profiles as
a known excluded class, so the typed `invalid-provenance` refusal reads as a
boundary rather than a defect.

§2.2 wanted correcting either way — the "cannot be a top-level sibling" premise
is no longer true, and leaving it in the record would cost the next reader the
same investigation. Under the adopted answer that correction is discharged by
this spec and by S4 of the implementation packet (§7), which puts the mechanism
in front of the prediction-profile reader rather than the mystery.
