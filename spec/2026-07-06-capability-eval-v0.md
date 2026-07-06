# Capability-Eval v0 — measuring the corpus-connected harness against stock

- **Version:** 0.1 (design draft)
- **Date:** 2026-07-06
- **Author:** Ritsu (design session)
- **Shape:** `design` — output is this methodology spec. Building the rig is a follow-on
  `feat`, gated on sign-off of this spec. A small pilot run to estimate effect size for the
  power calc is in-scope; the harness is not.
- **Owns:** the v0 capability gate for the Jinn harness network
  (`spec/2026-07-02-jinn-harness-network.md` §8, v1b gate).
- **Publishes:** the **held-out task-set boundary** — the shared interface consumed by the
  distillation-design session (§12). Distillation MUST exclude this set from its input.

---

## 1. Summary

The whole harness-network bet reduces to one number (`spec/2026-07-02-jinn-harness-network.md`
§1, §8): a **corpus-connected harness must measurably beat a stock harness at equal quality and
lower total cost** on the coding distribution. If that number does not materialise, earning and
steering are decoration — the spec says *stop and rethink before scaling v1*.

This document defines **how to produce that number so it survives scrutiny** — not the rig. It
nails down the claim, the pass/fail gate, what is held constant vs varied, how the held-out task
set is chosen and *proven* disjoint from the corpus, the metrics, the statistical design (with a
power analysis that picks N and R), and how the same design scores v1 (distilled skills) without
a rebuild.

The load-bearing risk is **contamination**: if the corpus already contains the answer to a
held-out task, the corpus arm "wins" by memorisation and the number is fake. §4 is the answer to
that risk and is the most important section.

**The good news — this is mostly reuse.** The paired statistic, the marginal confidence
interval, the frozen content-addressed slate, the contamination guard, the screening generator,
and the verified PASS/FAIL grader all already exist, shipped and tested, from the
DR-2026-06-02-b held-out-efficacy lineage. This spec reuses them and adds a thin layer: cost
capture, a paired cost test, the two-arm solve orchestration, corpus-snapshot content-addressing,
and the joint gate. §7 records the reuse-vs-rebuild decision line-by-line.

### Decisions locked in this session

| # | Decision |
|---|----------|
| **A** | Distribution = **coding** (SWE-rebench-V2 instances), aligned with the distillation session. |
| **B** | **Corpus ON = seeds pre-installed only.** Arm B is a static, distribution-matched skill loadout installed once via `/jinn skills install` before the per-task meter starts. **No live `corpus_search`/`corpus_fetch` mid-task.** This isolates the "skills in context" value, simplifies contamination control (no dynamic retrieval to audit), and extends cleanly to v1 (swap seeds → distilled skills in the loadout). Live-retrieval value is explicitly **out of scope for v0**. |
| **C** | **Gate = non-inferior quality AND strictly-lower cost**, combined as an intersection-union test (§2). |
| **D** | **Held-out slate = new, power-sized, contested-band construction** (§4). The existing v1 (N=10) and v2 (N=9) slates are reused as *format and tooling precedent only* — they are the very N≈10 artifacts DR-2026-06-02-b diagnosed as underpowered, not the measurement slate. |
| **E** | **Pinned model = Haiku-class** for the primary run (matches the existing v2 screening base `claude-code/Haiku`; cheapest run). Threats to external validity from the low ceiling are named in §11, with an optional Sonnet-class replication as the mitigation. |
| **F** | This is a **human-run measurement, not a CI gate** (§9). |

---

## 2. The claim and the gate

### 2.1 Operational definition

Two arms solve the **same** held-out coding tasks:

- **Arm A — stock:** the pinned jinn-agent, empty skill loadout, no corpus.
- **Arm B — corpus-ON:** the same agent, same model, with the distribution-matched **seed skill
  loadout pre-installed** (decision B).

For each task we measure **quality** (did the produced patch resolve the task, verified by the
eval harness) and **cost** (dollars of model usage to produce it). The claim "beats stock at
equal quality, lower cost" becomes two testable sub-claims:

1. **Quality non-inferiority.** Corpus-ON does not *reduce* resolve-rate by more than a margin
   δ. Formally, with Δ_quality = rate(B) − rate(A): we reject H0: Δ_quality ≤ −δ in favour of
   H1: Δ_quality > −δ. **δ = 5 percentage points.** (Superiority, Δ_quality > 0, is reported as
   a bonus when it holds, but is not required — the bet's word is "equal.")
2. **Cost superiority.** On tasks **both arms solve** (like-for-like: identical deliverable),
   corpus-ON costs strictly less. Formally, with Δ_cost = cost(B) − cost(A) over the
   concordant-solve set: we reject H0: Δ_cost ≥ 0 in favour of H1: Δ_cost < 0.

Restricting the cost claim to the both-solve set is deliberate and sharp: "lower cost at equal
quality" means *the same success reached for fewer dollars*, not "a failure is cheaper than a
success." The seed loadout **adds** input tokens to arm B's context (the skill text is carried
every task), so this is a genuine bar — the corpus must save more tokens (less flailing, fewer
turns) than the skills cost to carry. Cost over *all* tasks (including failures) is reported as a
secondary, richer view (§5.2).

### 2.2 The gate

> **PASS** iff **both** sub-claims are rejected at α = 0.05:
> **(1)** quality non-inferior (Δ_quality > −δ, δ = 5pp) **AND**
> **(2)** cost strictly lower on the both-solve set (Δ_cost < 0).

This is an **intersection-union test** (IUT). Because the gate fires only when *every* component
null is rejected, the size of the combined test is at most the size of the individual tests — so
**requiring both at level α controls the overall type-I error at α with no multiplicity
correction** (Berger 1982). We do not Bonferroni-adjust; the conjunction *is* the control. This
is the statistically honest way to make a two-part claim without inflating false-positives.

**Met / not-met is decidable.** The gate is a boolean over two pre-registered one-sided tests
with a pre-registered δ, α, slate, and pinned inputs. Three honest outcomes:

- **PASS** — both sub-claims hold. The bet's binding number materialised; v1 scaling is justified.
- **FAIL (clear)** — quality regressed beyond δ, or cost was not lower. The bet did not
  materialise on this distribution/config; per §8 of the harness-network spec, stop and rethink.
- **INCONCLUSIVE** — neither a clean pass nor a clean fail at the achieved N (the CI straddles
  the threshold). Reported honestly as "could not detect an effect ≥ MDE at N=…" (§6.4). This is
  **not** a pass; it is a statement that the run was underpowered for the observed effect, and it
  names what a decisive run would cost.

The full 2×2 pass/fail contingency, the rescue/regression breakdown, and the cost distributions
are published alongside the boolean so a mixed or null result is legible rather than buried.

---

## 3. Held constant vs varied

The single independent variable is **the seed skill loadout** (empty vs distribution-matched).
Everything else is pinned and recorded in the run report so the number is reproducible (§10).

| Held **constant** across both arms | Pinned as |
|---|---|
| jinn-agent build | exact commit SHA of the fork under test |
| Model | exact model id + provider + params (temperature, max tokens, tool config) |
| Task set | the frozen, content-addressed capability slate (§4), one version |
| Grader | swe-rebench-v2 evaluator at a pinned `evalSemanticsVersion` (currently `'4'`) |
| Execution substrate | Docker **image digests** (not tags), pinned per instance |
| Repeats | R runs per (task, arm), same R both arms |
| Host class | disk floor, CPU/arch profile recorded (arm parity matters more than the absolute) |

| **Varied** (the only variable) | Arm A | Arm B |
|---|---|---|
| Seed skill loadout | empty | distribution-matched seeds, pre-installed via `/jinn skills install` |

### 3.1 "Corpus ON" — precise definition (decision B)

- The loadout is **distribution-matched, not task-matched.** The same fixed set of installed
  skills is used for **every** task in the slate. The human running the eval MUST NOT hand-pick
  skills per task with knowledge of the task — that is overfitting / a contamination vector. The
  loadout is chosen once, to match the *coding distribution*, and frozen with the slate.
- Installation happens **once, before the run**, outside the per-task cost/wall-clock meter. The
  per-task meter covers only the solve (task prompt in → patch out). The skill text that the
  loadout injects into the model context on every task **is** counted (it is part of each solve's
  input tokens) — that is the cost the corpus must earn back.
- **No live `corpus_search`/`corpus_fetch`.** Arm B has an empty tool surface for corpus
  retrieval. v0 measures the value of *installed* seeds only. (v1 may add a live-retrieval arm;
  the rig supports it as another loadout parameter — §8.)

---

## 4. The held-out task set and contamination control

This is the load-bearing methodology risk. If any corpus item (a seed skill or a real trace)
contains, derives from, or references the solution to a held-out task, arm B can win by
memorisation and the number is fake. The controls below make disjointness a **proven property of
the artifact**, not an assumption.

### 4.1 Why paired design already neutralises one contamination class

The pinned model may have seen a held-out task's GitHub PR during *its own pretraining*. That is
a real confound for **absolute** resolve-rates — but it is **shared by both arms** (same model),
so it cancels in the **paired difference** Δ_quality. Pretraining contamination inflates A and B
equally; it does not bias the corpus *effect*. (SWE-rebench-V2 also mitigates it by mining
*recent* GitHub PRs, but we do not rely on that here.)

The contamination that **does** threaten the estimand is **corpus** contamination, because it
helps **only arm B**. That is what §4.3 proves against.

### 4.2 Slate construction — contested-band (decision D)

Reuse the screening generator (`client/src/eval/screen.ts`, `screen-runner.ts`) and the
gradeability gate (`validatePoolInstances` / `filterToScorablePool`), changing **only the
selection predicate**. The generator's existing three layers become:

1. **Gradeable.** The instance's gold patch resolves cleanly at the pinned `evalSemanticsVersion`
   (the existing gate — a raw sample admits ungradeable instances that make the denominator
   measure noise; see the v1 slate comment and `eval-runner.ts`).
2. **Contested band (widened from v2's `0/R`).** Screen each candidate with the **pinned stock
   arm** (Haiku-class, corpus OFF), frozen, R ≥ 3 runs. Keep instances whose stock pass-rate is
   in a **contested band** — target `[0.15, 0.85]` — measured **blind to corpus**. This is the
   generalisation of v2's "base fails 0/R" predicate into the regime where "equal quality, lower
   cost" is actually testable: the stock agent is neither saturated (would give arm B no room)
   nor hopeless (would collapse the claim to "rescues failures").
3. **Repo-stratified, deterministic selection** (`stratifyByRepo`) to prevent alphabetical
   clumping, drawn until the power-sized N is reached (§6).

**Rationale for contested-band over the alternatives** (recorded for scrutiny):

- *Base-fails-0/R* (v2's rule) maximises power (regressions ≈ 0, ~6 flips reach significance) but
  changes the estimand to "corpus rescues stock failures" and makes the cost half of the bet
  incoherent (stock solves nothing to be cheaper than). It answers a different, narrower question.
- *Representative* (unconditioned sample) has the cleanest external validity but, at any
  budget-feasible N, is underpowered for small effects (§6.3: representative discordance ≈
  0.10–0.20 needs N ≈ 500–2000). It is retained as an **optional secondary face-validity sample**
  if budget allows, reported with an honest MDE — never as the primary.
- *Contested-band* is the middle path that keeps both halves of the bet meaningful and keeps N
  feasible. It scopes the claim honestly: *"on coding tasks where the stock agent is neither
  saturated nor hopeless, the corpus changes resolve-rate by X pp at Y% lower cost."*

**Screening-yield caveat (named, not hidden).** The v2 screen kept 9 of 59 candidates (~15%).
The contested band is *wider* than `0/R`, so yield should be higher, but the Haiku-class ceiling
may still make the band thin. Mitigation, per the runbook's "widen, don't pad" rule
(`docs/runbooks/held-out-regression-benchmark.md`): widen the candidate pool (screen more HF
rows), never lower the gradeability bar to hit N. The pilot (§6.4) measures the realised yield
and band width before the full screen is committed.

### 4.3 Disjointness proof (the load-bearing control)

At slate-freeze time, **snapshot and content-address the live corpus** (the 84 seeded skills +
the real traces): enumerate every corpus record, its source repo(s), and the task descriptor /
instance ids it references, and hash the enumeration into a `corpusSnapshotCid`. Then prove the
slate disjoint from that snapshot along **three** axes, extending the existing
`assertNoOverlap(trainIds, slateIds)` guard (`client/src/eval/train-sequence.ts`) from
train-pool scope to corpus scope:

1. **Instance-level.** No slate `instance_id` appears in any corpus record's task descriptor or
   distribution tags. (Direct extension of `assertNoOverlap`.)
2. **Repo-level.** No slate task's `repo` (from the HF row) appears in the set of repos referenced
   by any corpus item — seed skills' source repos and trace task repos alike. SWE-rebench
   instances are repo-keyed, so this is a strong, cheap, checkable exclusion. **This is the axis I
   hand distillation** (§12): a repo denylist is coarser than an instance denylist and forecloses
   near-duplicate leakage (a different PR in the same repo).
3. **Lexical.** For each slate task, scan the full corpus text (every seed skill body + every
   trace step) for the gold patch's distinctive tokens — changed file paths, changed symbol
   names, the `instance_id`, the PR number/URL. Any hit → **exclude the task** (widen, don't
   pad). This catches leakage that instance/repo keys miss (e.g. a seed skill that happens to
   embed the fix).

The guard is **fail-loud**: a construction that cannot prove disjointness aborts rather than
emitting a slate. Because v0 is seeds-only and the corpus is small (84 + a few), all three scans
are cheap. The v0 seeds are generic imported skills (skills.sh; `provenance: imported`), so
repo-level disjointness is *expected* clean — but the spec requires it be **proven**, not
assumed.

### 4.4 The frozen slate artifact

Extend the shipped `HeldOutSlateArtifact` schema
(`client/src/solver-types/_swe-rebench-v2-held-out-slate.ts`, `hashHeldOutSlateArtifact`) into a
capability-eval artifact carrying everything a third party needs to reproduce and to check
disjointness:

```jsonc
{
  "schemaVersion": "capability-slate.v1",
  "solverType": "swe-rebench-v2.v1",
  "version": "cap-v0",
  "generatedAt": "<iso>",
  "evalSemanticsVersion": "4",
  "instances": [
    {
      "instance_id": "...",
      "repo": "...",
      "rowHash": "sha256:...",         // pins the HF dataset row (from the validated-pool primitive)
      "imageDigest": "sha256:...",     // pins the Docker eval image
      "stockPassRate": 0.33            // R-run screening estimate, blind to corpus (for audit)
    }
  ],
  "construction": "contested-band[0.15,0.85], stock=<model>, R=<n>, repo-stratified",
  "corpusSnapshotCid": "ipfs://...",   // the corpus state proven disjoint against
  "disjointness": { "instance": "pass", "repo": "pass", "lexical": "pass" },
  "hash": "sha256:..."                 // content-address over the canonical, sorted artifact
}
```

Scores are comparable **only within a slate version** (a version bump is a distinct hash, never
an in-place edit — the existing invariant). This artifact **is** the shared boundary of §12.

---

## 5. Metrics

### 5.1 Quality — verified per-task PASS/FAIL

Reuse the swe-rebench-v2 evaluator (`client/src/harnesses/impls/swe-rebench-v2-evaluator/`)
unchanged. Per task, per arm, per repeat it produces a binary verdict under **SWE-bench
"resolved" semantics**: *all FAIL_TO_PASS tests now pass AND no PASS_TO_PASS test broke*
(`eval-runner.ts`). Both arms' patches are graded by the **same** evaluator, **same** gold tests,
**same** image digest — so the quality comparison is like-for-like by construction.

**Ungradeable ≠ FAIL.** The evaluator already distinguishes an infra failure (Docker
unreachable, image pull failure, patch-does-not-apply, arch mismatch, …) from a wrong answer,
raising `EvalCouldNotGradeError` rather than a `passed_match:false` verdict. This is
load-bearing: an ungradeable run carries **no signal about the solver** and MUST NOT be scored as
a failure. Policy: on an ungradeable run, **re-run** up to K times (K = 2); if still ungradeable,
**drop that task-repeat from both arms** to preserve pairing. Dropped tasks are logged and
counted (`excluded`, mirroring `comparePaired`), never coerced into a flip.

### 5.2 Cost — dollars, tokens, wall-clock

Cost accrues on the **solve** side (the agent), not the grader (`evaluator_cost_usd: 0`). Per
task, per arm, per repeat capture:

- **input tokens, output tokens** — provider-reported *actual* usage where the harness exposes it
  (preferred); the `client/src/harnesses/cost-estimates.ts` heuristic (per-1k-token rate × task
  length) only as an explicitly-flagged fallback.
- **dollars** = `input_tok × rate_in + output_tok × rate_out`, using **one fixed rate table for
  both arms** (`MODEL_COST_TABLE`), so the cost delta is purely a token-usage delta priced at a
  constant. This is the **primary** cost metric.
- **wall-clock** — solve start → patch emission. Secondary (host-dependent; reported for context,
  not gated).

Boundaries: the per-task meter starts at task-prompt submission and ends at final patch emission.
One-time `/jinn skills install` (arm B) is **outside** the meter (amortised). The per-task
skill-context tokens injected into every solve **are inside** the meter (§3.1) — the corpus pays
for its own context.

- **Gate cost statistic:** dollars on the **both-solve** set (§2.1).
- **Secondary:** dollars over all tasks; total tokens; wall-clock; and the cost *conditional on
  outcome* (cost-per-solve, cost-per-failure) — the richer picture behind the headline.

---

## 6. Statistical design

### 6.1 Pairing and repeats

- **Paired.** The same task is solved by both arms. Pairing removes between-task difficulty
  variance ("this bug is just hard"), which otherwise swamps a consistent within-task effect —
  exactly the argument in `paired.ts` for McNemar over marginal Wilson intervals. Huge power gain
  for free.
- **Repeats.** The agent is stochastic, so run **R ≥ 3** per (task, arm) (DR-2026-06-02-b's floor;
  the `held-out-regression-benchmark` runbook's honesty guard). R ≥ 3 is not just precedent — it
  is **power-protecting**: it stabilises each arm's per-task verdict, shrinking the
  *noise-driven* discordance (tasks that flip only because the agent is stochastic, not because
  of the corpus) that would otherwise dilute the signal. R = 5 is used if the pilot shows high
  per-task verdict volatility (§6.4). Same R for both arms.

### 6.2 The tests (reuse first)

**Quality — gate primary: paired per-task pass-rate difference.** For each task i, compute
p̂_A,i and p̂_B,i (each over R runs). Test non-inferiority of the mean paired difference
mean(Δ_i), Δ_i = p̂_B,i − p̂_A,i, via a **one-sided (1−α) BCa bootstrap CI over tasks**:
non-inferiority is declared iff the lower bound > −δ; superiority (bonus) iff the lower bound > 0.
This uses the full R > 1 information and is precisely the R > 1 path the `paired.ts` docstring
already names as the planned extension ("per-instance pass RATES → Wilcoxon signed-rank / paired
bootstrap … DR-2026-06-02-b §2b"). Wilcoxon signed-rank on Δ_i is reported alongside as a
distribution-free corroborator.

**Quality — legible corroboration: consensus McNemar (shipped, reused verbatim).** Collapse R
repeats to a per-task **consensus verdict** (pass iff resolved in ≥ ⌈R/2⌉ runs; ties → fail,
conservative) and feed the two arms into `comparePaired(before=A, after=B)`
(`client/src/eval/paired.ts`). It returns the discordant counts b = `improved` (A-fail → B-pass,
"rescues"), c = `regressed` (B broke what A solved), the `concordantPass`/`concordantFail` cells,
the **exact two-sided McNemar p-value** (`mcnemarExact`), and its own superiority verdict. From
the **same b, c** we read the non-inferiority test: the paired resolve-rate difference is
(b − c)/pairs, with a one-sided (1−α) CI via **Tango's score interval** for a paired proportion
difference (better small-sample coverage than Wald; Wald `SE = √((b+c) − (b−c)²/n)/n` as a
fallback); non-inferiority iff the lower bound > −δ. Marginal absolute rates are reported with
`wilson.ts` (`wilsonInterval`, `compareRates`) as the most conservative view.

The gate keys on the **primary** (pass-rate bootstrap). The consensus-McNemar and marginal-Wilson
reads are published beside it and **must agree in direction**; a disagreement is a flag to
investigate before publishing the number, never an auto-pass.

**Cost — paired.** For each both-solve task, Δcost_i = mean$(B) − mean$(A) over the R runs. Test
H1: mean(Δcost_i) < 0 via one-sided **Wilcoxon signed-rank** (primary; distribution-free — cost
is skewed) plus a **BCa bootstrap CI** on the median and mean difference. Report median and mean
Δ$, and the % reduction.

**Robustness (optional, reported not gated): mixed-effects logistic** on all N·R·2 runs (outcome
resolved ∈ {0,1}; fixed effect = arm; random intercept per task) → the corpus odds-ratio + CI,
which models the stochasticity directly and gives the most powerful read. Flag if it disagrees
with the gate primary.

### 6.3 Power analysis — picking N

McNemar power is driven by the **discordant** pairs; concordant tasks (both pass, both fail) carry
no information. This is why representative slates are so hungry and why the contested band exists.
Sample size (total task-pairs N) for the consensus-McNemar, via **Connor (1987)**, given
p_b = P(B passes, A fails), p_c = P(A passes, B fails), discordance π_d = p_b + p_c, and effect
p_b − p_c:

```
N  =  m / π_d ,   where the required discordant pairs
m  =  [ z_{α/2}·√π_d  +  z_β·√(π_d − (p_b − p_c)²) ]²  /  (p_b − p_c)²
```

Concrete table (α = 0.05 two-sided; total task-**pairs** N, and discordant m):

| p_b (B-wins) | p_c (A-wins) | net | discordance | N @80% | N @90% |
|---:|---:|---:|---:|---:|---:|
| 0.25 | 0.10 | +0.15 | 0.35 | **343** | 456 |
| 0.20 | 0.08 | +0.12 | 0.28 | 537 | 715 |
| 0.18 | 0.06 | +0.12 | 0.24 | 536 | 713 |
| 0.15 | 0.05 | +0.10 | 0.20 | 773 | 1030 |
| 0.10 | 0.04 | +0.06 | 0.14 | 2164 | 2889 |

Reading: a **large** contested-band effect (net +15pp, discordance 0.35) is decisive at
**N ≈ 343** paired tasks @80% power; a **modest** effect (net +6pp) is out of budget reach
(N > 2000). The consensus-McNemar is the **weakest** of our gate statistics (it discards
within-task info), so **sizing on it is conservative** — the gate-primary pass-rate bootstrap and
the mixed model detect the same effect at **equal or smaller N**. The reproducible calculator
extends `client/scripts/power.ts` (which today only does the Wilson-disjoint lookup) with this
McNemar formula.

### 6.4 The pilot (in-scope) → final N

Run a small pilot — **N_pilot ≈ 20–30, R = 3, both arms** — on a provisional contested-band draw.
It estimates: (a) the realised discordance p_b, p_c and effect size; (b) per-task verdict
volatility (does R = 3 suffice or is R = 5 needed); (c) the both-solve cost delta and its
variance; (d) the screening yield and band width (§4.2). Feed (a)–(c) into a **bootstrap power
simulation** for the gate-primary pass-rate test to set the final N (and confirm with the Connor
table). Then:

- If the required N ≤ the budget cap → run at that N.
- If the required N > budget cap → run at the affordable N and **report the MDE honestly**: "at
  N = …, R = …, the minimum detectable effect at 80% power is X pp; the observed effect was Y with
  CI […]." An effect smaller than a budget-feasible MDE is itself a valid, decisive **gate
  outcome** — the harness-network spec says *stop if the number doesn't materialise*, and "the
  win is too small to detect within a sane budget" is a form of not-materialising.

**Explicitly not N = 10 / R = 1.** DR-2026-06-02-b proved that configuration cannot detect
anything short of a +60pp jump. The pilot exists to justify N from data, not to *be* the
measurement.

---

## 7. Reuse vs rebuild (the finding)

Inventory of the prior held-out-efficacy / exam / paired-McNemar infrastructure (DR-2026-06-02-b
lineage, issues #766/#817/#818/#822/#986, PRs #952/#975/#987) and this spec's disposition of each:

| Component | Location | Disposition |
|---|---|---|
| Exact paired McNemar | `client/src/eval/paired.ts` — `mcnemarExact(b,c)`, `comparePaired()` | **Reuse verbatim** for the legible corroboration; read NI off its b,c |
| Marginal Wilson CI | `client/src/eval/wilson.ts` — `wilsonInterval`, `compareRates` | **Reuse** for absolute-rate reporting |
| Frozen, hash-pinned slate | `_swe-rebench-v2-held-out-slate.ts` — schema, `hashHeldOutSlateArtifact`, `loadHeldOutSlate`, `excludeHeldOutSlate` | **Reuse + extend** the schema (§4.4); `excludeHeldOutSlate` is the distillation hook (§12) |
| Contamination guard | `train-sequence.ts` — `assertNoOverlap` | **Reuse + extend** from train-pool scope to corpus scope (instance + repo + lexical, §4.3) |
| Slate generator | `client/src/eval/screen.ts`, `screen-runner.ts` — repo-stratified, cached, resumable | **Reuse machinery, widen the predicate** `0/R` → contested band (§4.2) |
| Verified grader | `swe-rebench-v2-evaluator/` — resolved semantics, ungradeable≠fail | **Reuse unchanged** (§5.1) |
| Power lookup | `client/scripts/power.ts` — Wilson-disjoint | **Extend** with the Connor McNemar formula (§6.3) |
| Precedent + honesty guards | DR-2026-06-02-b; `docs/runbooks/held-out-regression-benchmark.md` | **Reuse the guards** (R≥3, freeze-before, exclude ungradeable, periodic re-run vs regression-to-mean) |

**Rebuilt / new (thin):** cost capture + the paired cost test (§5.2, §6.2); corpus-snapshot
content-addressing (§4.3); the two-arm (OFF/ON) solve orchestration; the joint IUT gate (§2). The
**statistics are not reinvented** — the primary quality test is the R>1 extension the shipped
`paired.ts` already names as its own roadmap.

**Deliberate divergence:** the v2 screen's `base-fails-0/R` predicate is *not* reused as-is. Its
estimand (learner-improvement-from-zero) differs from ours (capability delta where the bet's
"equal quality, lower cost" is meaningful). We reuse its generator and widen its predicate. This
divergence is the reuse finding the brief asked to record.

### 7.1 External frameworks considered (build-vs-adopt for the rig)

The reuse above is all *internal*. A separate question is whether an off-the-shelf eval framework
lets the follow-on rig avoid hand-rolling the two-arm orchestration, token capture, and logging.

**No external eval supplies the number.** No public benchmark or leaderboard measures "does *our*
corpus help *our* agent" — the bet is a **differential** (ON − OFF) on a slate proven disjoint
from *our* seeds+traces, and we hold the only copy of the corpus. Off-the-shelf evals give
*absolute* scaffold scores on a shared task set, not this contrast and not the disjointness proof.
The experiment (two-arm design, contested-band slate, disjointness proof, joint gate) is
irreducibly ours. There is no read-the-number-off-a-leaderboard shortcut.

**But the plumbing is adoptable.** The layers separate cleanly:

| Layer | Disposition |
|---|---|
| Benchmark (task set) | **Already reused** — SWE-rebench-V2 via HF, maintained + continuously mined |
| Grader (container pass/fail) | **Already reused, with our corrections** — upstream `scripts/eval.py` + our re-derived "resolved" semantics and ungradeable-≠-fail (§5.1). Keep these; upstream harnesses get them wrong |
| Runner / orchestration / logging | **Adopt [Inspect AI](https://inspect.aisi.org.uk) (UK AISI)** for the rig — see below |
| The experiment + gate | **Ours** — no framework supplies the differential, the disjointness proof, or the IUT gate |

**Recommended for the rig `feat`: adopt Inspect AI as the outer runner, keep our grader as a
custom scorer.** Validated fit (2026-07-06):

- **Arms as solvers over an external CLI agent.** Inspect's `sandbox_agent_bridge()` wraps a CLI
  agent *running in a sandbox, written in any language* — the doc names Claude Code / Codex / Gemini
  CLI, which is exactly jinn-agent's shape (a forked Hermes CLI). Arm A / arm B become two solvers
  (empty loadout vs seeds-installed) over one dataset. This is the load-bearing fit check: Inspect
  can run the **real product binary**, not an Inspect-native agent loop.
- **Epochs = our R repeats**, native.
- **Pluggable scorers** — our SWE-rebench-V2 grader (with rowHash/imageDigest pinning and the
  resolved/ungradeable corrections) plugs in as a custom scorer; we do **not** adopt Inspect's
  vanilla SWE-bench scorer, which would lose those corrections and uses the wrong dataset.
- **Scoring library ships bootstrap CIs + pass/fail gates**, overlapping §6 (the IUT gate remains
  our policy on top).
- **HuggingFace dataset bridge** — SWE-rebench-V2 HF rows load directly.

**The one caveat (an integration point, not a blocker):** token/cost capture for a *bridged CLI
agent* is **not automatic**. Inspect logs model calls only when they route through its model
proxy; jinn-agent makes its own provider calls. So the rig must either (a) point jinn-agent's
model client at Inspect's proxy so Inspect logs tokens, or (b) capture tokens from jinn-agent's own
emitted usage (the path §5.2 already assumes, via `cost-estimates.ts` / #331). Either works;
which one is a rig decision (§13).

**Net:** adoption is *partial*, not wholesale — Inspect covers the outer loop (arms, epochs,
token accounting, run store, bootstrap CIs), we keep the SWE-rebench-V2 grader and own the
experiment. This saves building orchestration/logging/bootstrap from scratch without discarding
our hard-won scoring corrections.

**Independent corroboration of the design** (not a dependency, just evidence it is standard):
recent (2026) agent-ablation work pairs per-task comparisons with **McNemar's exact test +
Wilcoxon signed-rank** — our exact stat choice — and reports config/context-file effects of
~**+6.4pp** on solve rate ([Harness-Bench](https://arxiv.org/html/2605.27922v1); [Natural-Language
Agent Harnesses](https://arxiv.org/html/2603.25723v1), whose only-full / only-ablation / both-agree
coding *is* the McNemar discordant cells). A +6.4pp effect on a *representative* slate needs
N > 2000 (§6.3) — external evidence that **reinforces the contested-band decision** (§4.2):
concentrate the slate where the effect is large enough to detect on a sane budget.

---

## 8. Extensibility to v1 (distilled > seeds)

The design treats **"arm = corpus loadout" as a parameter**. v0 scores {A: empty, B: seeds}. v1
adds **arm C: distilled skills** on the **same frozen slate** (`cap-v0`), and the analysis becomes
pairwise contrasts against the stock baseline:

- **C − A** — distilled vs stock: the v1 restatement of the binding bet.
- **C − B** — distilled vs seeds: does distillation beat raw seeds? (the v1-over-v0 claim.)

Nothing else changes: same slate + hash, same grader + semantics version, same paired structure,
same tests, same gate. **The rig is reused, not rebuilt** — v1 is a new loadout and one more arm,
not a new methodology. The one hard requirement this places on the future is that the **slate
stays pinned** across v0 → v1 (a re-drawn slate makes the numbers incomparable) — which is
compatible with contamination control because distillation excludes the slate by construction
(§12). If a semantics bump forces a slate re-cut, v0 must be re-run on the new slate before v1
numbers are compared to it.

---

## 9. Practical envelope and posture

**Human-run measurement, not CI.** This is a deliberate, resourced run an operator executes on a
capable host, producing a dated report + anchored raw records. It is **not** wired to a gate or a
push-triggered job (swe-rebench evals are heavy, stochastic, and Docker/disk-bound — a flaky gate
is worse than no gate, per the `dont-over-validate-flaky-nongating-tests` lesson). The output is a
signed measurement, reproducible by re-running the pinned rig against the pinned slate.

**Envelope** (illustrative, for a mid-size run):

- **Volume:** N × R × 2 solves + the same number of grades. E.g. **N = 200, R = 3 → 1,200
  solves + 1,200 Docker grades.**
- **Cost (solve side, Haiku-class, decision E):** Haiku is ~1–2 orders cheaper than Opus; a
  1,200-solve run is on the order of **low hundreds of dollars** at Haiku rates (vs ~$2,700 at
  Opus). This is the reason for decision E.
- **Grade side (Docker):** each grade minutes-to-tens-of-minutes wall-clock, up to a **2-hour**
  hard timeout per instance (`DEFAULT_EVAL_TIMEOUT_MS`); images are linux/amd64 (slow/crash-prone
  under Apple-Silicon emulation — run on amd64 hosts). 1,200 grades serialised ≈ hundreds of
  host-hours → **parallelise across K hosts**; wall-clock ≈ (grade-hours / K) + solve time.
- **Disk:** floor **≥ 40 GB** (`JINN_EVAL_DISK_FLOOR_GB ≥ 40`; the full pandas/OpenHands/litellm
  slate has crashed laptops at the 20 GB default — `swe-rebench-eval-disk-crashes-laptop`). Big
  repos on a **≥ 100 GB** host. The runner already prunes each round's Docker footprint and aborts
  cleanly below the floor (`InsufficientDiskError`).

Net: a **multi-day, multi-host, low-thousands-of-dollars-at-most** run. That is the price of a
number that decides whether to scale v1.

---

## 10. Legibility and reproducibility (PRINCIPLES.md)

Every claim must be independently reproducible (PRINCIPLES → Legible). The run publishes, all
content-addressed:

- **Pinned inputs:** jinn-agent SHA, model id + params, slate artifact (with its hash, `rowHash`
  and `imageDigest` per instance, and `corpusSnapshotCid`), `evalSemanticsVersion`, the price
  table, R, δ, α.
- **The corpus snapshot** proven disjoint (§4.3), so a third party can re-check disjointness.
- **Every raw per-run record:** the produced patch, the grader verdict + test log CID, input/output
  tokens, dollars, wall-clock — for all N·R·2 runs. Anyone can recompute the statistic from these;
  the published number is a *function* of published data, not a private assertion.
- **The analysis script** (bootstrap + McNemar + Wilcoxon + the Connor power calc) so the p-values
  and CIs are re-derivable.

Because the agent is stochastic, exact per-run reproduction is not guaranteed; **the R repeats and
the full raw records** are what make the *statistic* reproducible (re-running yields a
distribution the published CI already characterises).

---

## 11. Threats to validity

| Threat | Handling |
|---|---|
| **Corpus contamination** (helps only B) | §4.3 three-axis disjointness proof, fail-loud; the load-bearing control |
| **Model-pretraining contamination** | Cancels in the paired difference (shared by both arms, §4.1); not a threat to the effect |
| **Haiku ceiling → thin contested band / weak external validity** (decision E) | Named. Pilot measures band width (§6.4); mitigation is widening the candidate pool and an **optional Sonnet-class replication** — the methodology is model-agnostic, only the pinned id changes |
| **Contested-band ≠ full distribution** | The claim is *explicitly scoped* to the contested region; an optional representative sanity sample (§4.2) anchors face validity |
| **Ungradeable runs biasing quality** | Never scored as FAIL; re-run K=2 then drop-the-pair (§5.1) |
| **Per-task skill cherry-picking** (overfitting arm B) | Loadout is distribution-matched and fixed across all tasks; hand-picking per task is forbidden (§3.1) |
| **Multiple comparisons** | The gate is a single IUT (no correction needed, §2.2); corroborating tests are reported, not multiplied into the gate |
| **Regression to the mean** | Periodic re-run of the stock arm during the campaign (runbook guard) rules out drift masquerading as effect |
| **Treatment fidelity** (is "corpus ON" really on?) | Assert the loadout is installed and present in context each arm-B run; log the injected skill ids; a run where the loadout failed to load is excluded, not scored |
| **Cost-metric gaming via token accounting** | One fixed rate table both arms; provider-actual tokens preferred; skill-context tokens counted (§5.2) |

---

## 12. The shared held-out boundary (hand-off to the distillation session)

This session **owns and publishes** the held-out task-set boundary; the distillation-design
session **consumes** it. The interface is the frozen slate artifact of §4.4. The contract:

1. **Distribution = coding.** Both sessions target SWE-rebench-V2 coding instances (decision A).
2. **The boundary is the `cap-v0` slate artifact** — its `instances[]` (instance_ids + repos),
   its hash, and its `corpusSnapshotCid`.
3. **Distillation MUST exclude the slate from its input**, by **both** instance_id **and repo**
   (the repo denylist forecloses near-duplicate leakage — a different PR in the same repo). The
   mechanism already exists: distillation calls **`excludeHeldOutSlate(pool, slateIds)`**
   (`_swe-rebench-v2-held-out-slate.ts`) — the same chokepoint the training generator uses — and
   additionally filters its trace input by the repo denylist. Any distilled skill whose provenance
   traces to a slate repo is dropped before it can enter arm B/C.
4. **Direction is two-sided.** The slate excludes anything already in the corpus (§4.3); the
   corpus/distillation excludes anything in the slate (this section). Freeze order: freeze +
   snapshot the corpus → draw the contested slate disjoint from it → publish the slate → from
   then on, distillation excludes the slate. If the corpus grows after freeze, the slate's
   disjointness proof is re-checked against the new snapshot before any v1 comparison.
5. **The slate is pinned across v0 → v1** (§8), so distillation's exclusion set is stable.

**Handed to distillation:** `cap-v0` instance_id denylist + repo denylist + the freeze timestamp.
**Required back from distillation:** confirmation that its input excludes both, and that no
distilled skill's provenance traces to a slate repo.

---

## 13. Decisions deferred to the rig (`feat`, post-sign-off)

These are implementation choices, not methodology, and are settled when the rig is built:

- Exact contested-band edges (start `[0.15, 0.85]`; the pilot may adjust for yield).
- K (ungradeable re-run cap; start 2) and the both-solve cost-set minimum size.
- Bootstrap resample count and BCa vs percentile CI (start BCa, 10k resamples).
- Parallelism / host orchestration for the grade side.
- Whether the optional representative sanity sample is run in v0 or deferred.
- **Adopt Inspect AI as the outer runner** (§7.1) — recommended; validate the `sandbox_agent_bridge`
  fit against the jinn-agent fork on one instance first.
- **Token-capture path for the bridged agent** (§7.1 caveat): route jinn-agent's model calls
  through Inspect's proxy, or capture from jinn-agent's own emitted usage. Start with the latter
  (matches §5.2 / #331) and cross-check against provider billing on a sample.

---

## 14. The gate, restated (met / not-met)

> On the frozen `cap-v0` contested-band coding slate, with arm A = stock jinn-agent and arm B =
> the same agent with the distribution-matched seed loadout pre-installed (no live retrieval),
> both at the pinned model and R ≥ 3 repeats:
>
> **PASS** iff, at α = 0.05 as an intersection-union test —
> **(1)** corpus-ON resolve-rate is non-inferior to stock (Δ_quality > −5pp), **AND**
> **(2)** corpus-ON costs strictly less on the both-solve set (Δ_cost < 0).
>
> Otherwise **FAIL** (clear regression or no cost win) or **INCONCLUSIVE** (underpowered at the
> achieved N — reported with its MDE, and treated as *not a pass*).

This is the one number the harness-network bet reduces to. It is decidable, reproducible from
published raw records, and extends unchanged to v1 by adding the distilled arm on the same slate.
