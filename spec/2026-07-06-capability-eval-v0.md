# Capability-Eval v0 — measuring the corpus-connected harness against stock

- **Version:** 0.3 (design draft — v0.2 hardened by a 6-lens adversarial review, 2026-07-06,
  23 findings folded in; **v0.3 re-pins the model to `gpt-5.4-mini`** after the flash pilot
  exposed an empty-patch confound — decision E + §9 + §11, 2026-07-08. Core design unchanged.)
- **Date:** 2026-07-06 (updated 2026-07-08)
- **Author:** Ritsu (design session)
- **Shape:** `design` — output is this methodology spec. Building the rig is a follow-on
  `feat`, gated on sign-off of this spec. A small pilot run to estimate effect size for the
  power calc is in-scope; the harness is not.
- **Owns:** the v0 **seeds-only pre-gate** for the Jinn harness-network capability bet
  (`spec/2026-07-02-jinn-harness-network.md` §8, v1b gate). A v0 PASS *supports* but does not
  fully discharge §8; a decisive §8 FAIL needs the deferred live-retrieval or distilled arm (§2.3).
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
that risk and is the most important section. A companion risk — because the team is measuring its
own binding bet — is **legibility to a skeptic**: §10 makes the number pre-registered and
externally re-checkable rather than self-graded.

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
| **B** | **Corpus ON = seeds pre-installed only.** Arm B is a static, distribution-matched skill loadout installed once via `/jinn skills install` before the per-task meter starts. **No live `corpus_search`/`corpus_fetch` mid-task.** This isolates the "skills in context" value, simplifies contamination control (no dynamic retrieval to audit), and extends cleanly to v1 (swap seeds → distilled skills in the loadout). Live-retrieval value is explicitly **out of scope for v0** — see §2.3 for what a v0 result does and does not license against §8. |
| **C** | **Gate = non-inferior quality AND strictly-lower cost**, combined as an intersection-union test (§2). |
| **D** | **Held-out slate = new, power-sized, contested-band construction** (§4). The existing v1 (N=10) and v2 (N=9) slates are reused as *format and tooling precedent only* — they are the very N≈10 artifacts DR-2026-06-02-b diagnosed as underpowered, not the measurement slate. |
| **E** | **Pinned model = `gpt-5.4-mini` via the OpenAI Codex subscription** (amended 2026-07-08; was `deepseek/deepseek-v4-flash`). The flash pilot exposed a **confound**: flash's weak agentic tool-use spirals into empty-patch / >700k-token runs when handed extra context, so arm B's apparent "seeds hurt by −9.1pp" was largely flash flailing, not a corpus effect. Re-running the same slate on the reasoning-tier `gpt-5.4-mini` **eliminated the spirals** (0 empty patches / 16 solves), lifted arm A's solve rate (54.5%→66.7%), and moved the seeds effect to **Δ=0.0pp, non-inferior** — a clean substrate where any distilled-arm signal is attributable to the skills, not to model noise. Runs on jinn-agent (the Hermes fork, corpus tools intact) via `hermes auth add openai-codex --type oauth`, per-invocation `--provider openai-codex -m gpt-5.4-mini`. **The cost gate still holds on a subscription:** the Codex OAuth backend exports provider-actual token counts (`input`/`output`/`reasoning`/`cache_read`; `output_tokens` already includes `reasoning_tokens` — do not double-count), priced at the published $0.75/$4.50-per-M rate (§5.2) — this **corrects v0.2's claim** that a flat-rate sub cannot supply provider-actual tokens. Tradeoff recorded honestly: gpt-5.4-mini is ~3–4× flash's *representative* cost/solve, so **less "cost-representative of a fork user"** than flash — but inference is free to the operator via the sub, and the signal-quality win (no empty-patch confound) is decisive for a clean measurement. The methodology is **model-agnostic**; only the pinned id changes. `deepseek-v4-flash`/`-pro` on OpenRouter (metered) remain valid fallbacks. |
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
   H1: Δ_quality > −δ. **δ = 5 percentage points, pre-registered with a stated basis:** 5pp is
   the smallest quality drop the v1-scaling decision treats as material at the band's central base
   rate (~0.5, where 5pp ≈ 10% relative). Because the band spans [0.15, 0.85], a fixed *absolute*
   δ tolerates a larger *relative* regression at the low end — so the quality leg carries a
   **PASS-blocking relative guard**: non-inferiority additionally requires the observed relative
   regression not exceed **15% of the stock base rate** on the retained set. A config that clears
   −5pp absolute but regresses >15% relative is a FAIL — faithful to "equal quality." (Superiority,
   Δ_quality > 0, is reported as a bonus when it holds, but is not required — the bet's word is
   "equal.")
2. **Cost superiority.** On tasks **both arms solve** (like-for-like: identical deliverable),
   corpus-ON costs strictly less. Formally, with Δ_cost = cost(B) − cost(A) over the
   concordant-solve set: we reject H0: Δ_cost ≥ 0 in favour of H1: Δ_cost < 0.

Restricting the cost claim to the both-solve set is deliberate and sharp — "lower cost at equal
quality" means *the same success reached for fewer dollars*, not "a failure is cheaper than a
success." It is **also a selection on a post-treatment outcome (a collider):** "both arms solve"
depends on the treatment, so the retained set drifts toward tasks stock already solves (the tasks
the corpus newly *rescues* — A-fail, B-pass — are excluded), where the seed-context tokens are
pure overhead. This is **bounded, not fatal**: the paired cost statistic compares B-vs-A on the
*same* retained task, so arm B cannot win by changing set composition; and the quality NI leg
(§2.1(1)) caps the regression channel that drives residual selection. As a mandated robustness
read (reported, not gated), the run report publishes the **both-solve composition delta** — the
excluded discordant cells (A-pass/B-fail, A-fail/B-pass, already computed by `comparePaired`) — so
a reader can see whether a cost FAIL coincides with a rescue-driven quality win. When the corpus's
value shows up as quality-superiority rather than cost, the IUT still FAILs (faithful to the bet),
but the rescue breakdown + the Δ_quality>0 bonus make that a legible "quality-win, not cost-win"
outcome, not a silent FAIL. Cost over *all* tasks (including failures) is reported as a secondary,
richer view (§5.2) and is the sanity check when the regressed count is non-trivial relative to
`concordantPass`.

The seed loadout **adds** input tokens to arm B's context (the skill text is carried every task),
so the cost bar is genuine — the corpus must save more tokens (less flailing, fewer turns) than
the skills cost to carry.

### 2.2 The gate

> **PASS** iff **both** sub-claims are rejected at α = 0.05:
> **(1)** quality non-inferior (Δ_quality > −δ, δ = 5pp, **and** relative regression ≤ 15% of the
> stock base rate) **AND**
> **(2)** cost strictly lower on the both-solve set (Δ_cost < 0), decided on **provider-actual**
> token counts (§5.2).

This is an **intersection-union test** (IUT). Because the gate fires only when *every* component
null is rejected, the size of the combined test is at most the size of the individual tests — so
**requiring both at level α controls the overall type-I error at α with no multiplicity
correction** (Berger 1982). We do not Bonferroni-adjust; the conjunction *is* the control. This
is the statistically honest way to make a two-part claim without inflating false-positives. The
IUT α-guarantee covers exactly the two pre-registered one-sided tests above; the corroborating
statistics in §6.2 carry **no decision rule** and cannot change the gate's boolean value.

**Met / not-met is decidable.** The gate is a boolean over two pre-registered one-sided tests
with a pre-registered δ, α, slate, and pinned inputs. Three honest outcomes:

- **PASS** — both sub-claims hold. The bet's binding number materialised (within v0's scope, §2.3).
- **FAIL (clear)** — quality regressed beyond δ (absolute or relative), or cost was not lower. See
  §2.3 for what a FAIL licenses against §8.
- **INCONCLUSIVE** — neither a clean pass nor a clean fail at the achieved N (the CI straddles the
  threshold), or the cost sub-claim is UNMEASURED (provider-actual tokens unavailable, §5.2) or the
  both-solve set fell below its pre-registered floor (§6.2). Reported honestly as "could not detect
  an effect ≥ MDE at N=…" (§6.4). This is **not** a pass; and it is a **terminal** outcome of the
  run of record — it may not be silently re-screened into a PASS (§10.1).

The full 2×2 pass/fail contingency, the rescue/regression breakdown, and the cost distributions
are published alongside the boolean so a mixed or null result is legible rather than buried.

### 2.3 What a v0 outcome licenses against §8

v0's estimand is deliberately narrow — coding (decision A), installed generic seeds with **no live
retrieval** (decision B), the contested band (decision D), Haiku-class (decision E) — while the §8
bet is broader (the *top usage-selected* distribution, *live* consumption, an empirically-selected
niche). Therefore:

- A v0 **PASS** is a necessary-condition / lower-bound result that **supports but does not fully
  discharge** §8.
- A v0 **FAIL/null does NOT by itself trigger §8's "stop and rethink"**, because a null is
  confounded between (a) the corpus mechanism not helping and (b) the generic skills.sh seeds being
  irrelevant to these contested coding tasks. §8's halt is warranted only after ruling out (b) —
  via the deferred live-retrieval or distilled-skills arm (§8). This session owns the v0 seeds-only
  pre-gate; a decisive §8 FAIL needs one of those arms.

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
- **Loadout-composition selection is pre-registered and slate-blind.** To keep the ablation
  measuring corpus value rather than loadout-curation skill, the seed loadout is EITHER the full
  imported skills.sh coding set (mechanical, no human sub-selection) OR a subset chosen by a fixed,
  published rule — and in either case the loadout is frozen and published **before** the slate
  `instance_id`s are drawn (mirroring the §12.4 corpus-first freeze order for content). No human
  picks skills against a visible slate.
- Installation happens **once, before the run**, outside the per-task cost/wall-clock meter. The
  per-task meter covers only the solve (task prompt in → patch out). The skill text that the
  loadout injects into the model context on every task **is** counted (it is part of each solve's
  input tokens) — that is the cost the corpus must earn back.
- **No live `corpus_search`/`corpus_fetch`.** Arm B has an empty tool surface for corpus
  retrieval. v0 measures the value of *installed* seeds only. (v1 may add a live-retrieval arm;
  the rig supports it as another loadout parameter — §8.)
- **Arm A's "empty loadout" is enforced, not assumed** (spike finding,
  `docs/spikes/2026-07-07-jinn-agent-headless-spike.md`). jinn-agent injects the operator's memory,
  any cwd `AGENTS.md`/`SOUL.md`, and preloaded skills by default; **arm A must run with
  `--ignore-rules`** so none of that leaks, or the A/B contrast is confounded. Arm B is *exactly*
  arm A plus the seed loadout (`-s <skill>`), so the loadout is the sole varied input. Enforcing
  this is a treatment-fidelity check (§11).

---

## 4. The held-out task set and contamination control

This is the load-bearing methodology risk. If any corpus item (a seed skill or a real trace)
contains, derives from, or references the solution to a held-out task, arm B can win by
memorisation and the number is fake. The controls below make disjointness a **proven property of
the artifact**, not an assumption.

### 4.1 Why paired design neutralises the MAIN EFFECT of pretraining contamination

The pinned model may have seen a held-out task's GitHub PR during *its own pretraining*. That is a
real confound for **absolute** resolve-rates — but its **main effect** is shared by both arms
(same model), so it cancels in the **paired difference** Δ_quality.

It does **NOT** cancel a **skill×memorization interaction**: a distribution-matched seed can act as
a *retrieval cue* that raises the accessibility of a memorized gold solution in **arm B only**. (The
SWE-Bench Illusion — [arXiv 2506.12286](https://arxiv.org/abs/2506.12286) — shows models identify
the buggy file from issue text alone at up to 76% on SWE-bench vs 53% off it, and reproduce gold
functions verbatim, evidence of exactly this memorized-solution channel.) The contested band
**amplifies** this because it is enriched for tasks the stock arm *almost* solves — exactly where a
cue can flip a near-miss. Mitigations: (i) the loadout is distribution-matched, **not** task-matched
(§3.1), so it carries no task-specific cue; (ii) the pilot (§6.4) runs the SWE-Bench-Illusion
issue-text-only reproduction probe under the **stock** arm on the frozen slate — a high verbatim /
file-path score flags the slate as memorization-saturated (cueing confound live) and gates
publication pending review. Recording the pinned model's stated training cutoff in the artifact and
reporting the gate with/without memorization-exposed tasks is a strong optional secondary
mitigation (SWE-rebench-V2's recent-PR mining already blunts this axis), not required if the probe
shows low reproduction.

The contamination that most threatens the estimand is **corpus** contamination, because it helps
**only arm B**. That is what §4.3 proves against.

### 4.2 Slate construction — contested-band (decision D)

Reuse the screening generator (`client/src/eval/screen.ts`, `screen-runner.ts`) and the
gradeability gate (`validatePoolInstances` / `filterToScorablePool`), changing **only the
selection predicate**. The generator's existing three layers become:

1. **Gradeable.** The instance's gold patch resolves cleanly at the pinned `evalSemanticsVersion`
   (the existing gate — a raw sample admits ungradeable instances that make the denominator
   measure noise; see the v1 slate comment and `eval-runner.ts`).
2. **Contested band (widened from v2's `0/R`).** Screen each candidate with the **pinned stock
   arm** (corpus OFF), frozen, R ≥ 3 runs. **Screen on the SAME harness + endpoint + model the arms
   use** — jinn-agent (the Hermes fork) on OpenRouter at the pinned model — *not* the legacy
   `claude-code/Haiku` screening base: a contested band measured with a different scaffold does not
   transfer to the agent under test. Keep instances whose stock pass-rate is in a **contested
   band** — target `[0.15, 0.85]` — measured **blind to corpus**. This is the
   generalisation of v2's "base fails 0/R" predicate into the regime where "equal quality, lower
   cost" is actually testable: the stock agent is neither saturated (would give arm B no room)
   nor hopeless (would collapse the claim to "rescues failures").
3. **Repo-stratified, deterministic selection** (`stratifyByRepo`) to prevent alphabetical
   clumping, drawn until the power-sized N is reached (§6).

**Blind-screen fidelity (attested, not asserted).** "Measured blind to corpus" is a *checkable
property of the artifact*, not an honor-system claim. Each screening run records an
empty-skill-loadout assertion, an empty corpus-tool-surface assertion, and a hash of the host skill
directory (which MUST be empty), alongside the pinned screening jinn-agent SHA (schema in §4.4). A
screen that silently inherited an installed skill fails loud rather than biasing band membership
toward corpus-favorable tasks invisibly.

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
- **Selection-on-baseline is not a bias here.** The band selects tasks by a function of the *stock*
  arm's pass-rate, which raises a regression-to-the-mean worry. It does not bite: screening runs are
  **not** reused as gate data (`stockPassRate` in §4.4 is audit metadata only); the gate runs a
  **fresh, independent** N×R×2 measurement of both arms (§9). RTM biases only the *marginal absolute*
  rate — which the spec confines to non-gating context — not the fresh paired difference.

**Screening-yield caveat (named, not hidden).** The v2 screen kept 9 of 59 candidates (~15%).
The contested band is *wider* than `0/R`, so yield should be higher, but the Haiku-class ceiling
may still make the band thin (Haiku fails many SWE-rebench tasks ~0). Mitigation, per the runbook's
"widen, don't pad" rule (`docs/runbooks/held-out-regression-benchmark.md`): widen the candidate pool
(screen more HF rows), never lower the gradeability bar to hit N. The pilot (§6.4) measures the
realised yield and band width before the full screen is committed. The screen is itself a full
Docker eval pass and dominates host-hours — see the envelope (§9) and the cheaper-leading-indicator
option (§13).

### 4.3 Disjointness proof (the load-bearing control)

At slate-freeze time, **snapshot and content-address the live corpus** (the 84 seeded skills +
the real traces): enumerate every corpus record, its source repo(s), and the task descriptor /
instance ids it references, and hash the enumeration into a `corpusSnapshotCid`. Then prove the
slate disjoint from that snapshot along **three content axes**, extending the existing
`assertNoOverlap(trainIds, slateIds)` guard (`client/src/eval/train-sequence.ts`) from
train-pool scope to corpus scope:

1. **Instance-level.** No slate `instance_id` appears in any corpus record's task descriptor or
   distribution tags. (Direct extension of `assertNoOverlap`.)
2. **Repo-level.** No slate task's `repo` (from the HF row) appears in the set of repos referenced
   by any corpus item — seed skills' source repos and trace task repos alike. SWE-rebench
   instances are repo-keyed, so this is a strong, cheap, checkable exclusion, and it is the primary
   near-duplicate / paraphrase guard. **This is the axis handed to distillation** (§12). Seed
   repo-provenance is self-declared and cross-checked against each skill's actual source URL before
   it counts.
3. **Lexical.** For each slate task, scan the full corpus text (every seed skill body + every
   trace step) for the gold patch's distinctive tokens — changed file paths, changed symbol
   names, the `instance_id`, the PR number/URL. Any hit → **exclude the task** (widen, don't
   pad). This is the residual catch under axis 2; it is **known-insufficient against paraphrase,
   identifier renaming, and prose** (SWE-Bench Illusion), so it is a backstop, not the main guard.

**Limit of the three axes (named, not solved).** These axes prove the corpus does not contain the
*answer* to a slate task. They **cannot** detect a generic seed that supplies a slate task's *fix as
a technique* without naming its files, symbols, or repo (e.g. a seed "fix Django N+1 via
`select_related`" when the slate task is a `select_related` fix in a *different* Django file). That
seed passes all three axes yet hands arm B the fix — and this is most acute in the contested band,
selected for tasks a targeting technique would rescue. This is the crux the spec's own framing
raises ("a relevant skill is the point; the answer is fraud"): the boundary is **not fully
provable by content scans**. The only structural defense is §3.1's distribution-matched,
slate-blind, generic-imported loadout, fixed *before* the slate is drawn, so it cannot be tuned to
the slate's bug-classes. v0 therefore **requires the frozen artifact to attest** that the loadout
was fixed before the slate ids were drawn; absent that attestation the report is marked
`technique-leak-unattested` and the gate never certifies this axis as proven.

**Semantic axis (optional v0, mandatory v1 arm C).** To tighten the cross-repo / no-repo paraphrase
seam that axes 2+3 miss, add a fourth axis: a pre-registered **embedding cosine-similarity** pass
between each slate task's (gold patch + issue text) and each corpus record (seed body / trace step /
distilled skill), flagging above-threshold pairs for human review and exclusion. **Optional for v0**
(generic imported seeds, repo-provenance expected clean, thin seam); **mandatory for v1 arm C**,
because distilled skills *are* paraphrases of repo-keyed traces — the seam is wide. Record the
embedding model, threshold, and flagged pairs in the artifact.

**External re-checkability.** The instance- and repo-axis scans are made externally recomputable by
publishing, alongside `corpusSnapshotCid`, the derived enumeration this section already computes:
the sorted set of every corpus record's (source repos, referenced instance_ids). The lexical axis
cannot release raw scrubbed corpus bodies (§7.1 — we hold the only copy), so it is published as a
per-record salted-token / MinHash **sketch** of each record's token set, letting a third party
recompute lexical overlap against the *public* slate's gold-patch tokens without the corpus text.
The lexical verdict is therefore **self-attested** at the raw-text level and labelled as such;
instance and repo verdicts are externally re-runnable from the published index. `corpusSnapshotCid`
is a Merkle root over this public derived index, not over private blobs.

**Freeze-order vs content.** The proof certifies content-*disjointness* (the snapshot does not
contain the slate), not freeze-*order* (that the snapshot preceded the slate draw). Order is
enforced procedurally by §12.4 and, optionally, by anchoring the slate hash + index root on-chain so
the freeze timestamp is external. Additionally, each arm-B run MUST assert at solve time that the
loadout it actually loaded content-hashes to the artifact's `corpusSnapshotCid`; a mismatch
aborts/excludes the run rather than being scored (mirrors the §11 treatment-fidelity check) —
closing the innocent-edit-between-proof-and-run hole without on-chain machinery.

The guard is **fail-loud**: a construction that cannot prove disjointness aborts rather than
emitting a slate. Because v0 is seeds-only and the corpus is small (84 + a few), all scans are
cheap. The v0 seeds are generic imported skills (skills.sh; `provenance: imported`), so repo-level
disjointness is *expected* clean — but the spec requires it be **proven**, not assumed.

### 4.4 The frozen slate artifact

Extend the shipped `HeldOutSlateArtifact` schema
(`client/src/solver-types/_swe-rebench-v2-held-out-slate.ts`, `hashHeldOutSlateArtifact`) into a
capability-eval artifact carrying everything a third party needs to reproduce and to check the
externally-recomputable axes:

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
      "stockPassRate": 0.33,           // R-run screening estimate, blind to corpus — AUDIT metadata, NOT gate data
      "screening": {                   // blind-screen fidelity, §4.2
        "agentSha": "...", "emptyLoadout": true, "noCorpusTools": true,
        "hostSkillDirHash": "sha256:<empty-dir>"
      }
    }
  ],
  "construction": "contested-band[0.15,0.85], stock=<model>, R=<n>, repo-stratified",
  "corpusSnapshotCid": "ipfs://...",     // Merkle root over corpusDerivedIndexCid, NOT over private blobs
  "corpusDerivedIndexCid": "ipfs://...", // public: sorted (repos, instance_ids) + per-record token sketches
  "loadoutFrozenBeforeSlate": true,      // technique-leak attestation, §4.3
  "disjointness": {
    "instance": { "verdict": "pass", "flaggedPairs": [] },
    "repo":     { "verdict": "pass", "flaggedPairs": [] },
    "lexical":  { "verdict": "pass", "flaggedPairs": [], "attestation": "self-attested" },
    "semantic": { "verdict": "n/a-v0", "model": null, "threshold": null, "flaggedPairs": [] }
  },
  "hash": "sha256:..."                   // content-address over the canonical, sorted artifact
}
```

Scores are comparable **only within a slate version** (a version bump is a distinct hash, never
an in-place edit — the existing invariant). Note the reused primitive's own docstring warns its
in-file `hash` is *not a tamper-proof anchor* (`_swe-rebench-v2-held-out-slate.ts` L16-21); external
trust rests on the published derived index + the optional on-chain anchor (§4.3), not the self-hash.
This artifact **is** the shared boundary of §12.

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
counted (`excluded`, mirroring `comparePaired`), never coerced into a flip. Drops are symmetric by
construction (a task-repeat drops from *both* arms) and the drop count is published (§10.1).

### 5.2 Cost — dollars, tokens, wall-clock

Cost accrues on the **solve** side (the agent), not the grader (`evaluator_cost_usd: 0`). Per
task, per arm, per repeat capture:

- **input tokens, output tokens** — **provider-reported *actual* usage**. This is a **hard
  precondition** for the cost gate, not a preference: if the harness cannot expose provider-actual
  usage, the cost sub-claim is reported **UNMEASURED** and the gate is **INCONCLUSIVE** — never
  PASS on the `client/src/harnesses/cost-estimates.ts` heuristic, whose per-model fixed rates would
  make Δcost ≡ 0 (a fake tie). The heuristic is for dashboards, not the gate.
- **dollars** = `input_tok × rate_in + output_tok × rate_out`, using **one fixed rate table for
  both arms** (`MODEL_COST_TABLE`), so the cost delta is purely a token-usage delta priced at a
  constant. This is the **primary** cost metric.
- **wall-clock** — solve start → patch emission. Secondary (host-dependent; reported for context,
  not gated).

Boundaries: the per-task meter starts at task-prompt submission and ends at final patch emission.
One-time `/jinn skills install` (arm B) is **outside** the meter (amortised). The per-task
skill-context tokens injected into every solve **are inside** the meter (§3.1) — the corpus pays
for its own context.

- **Gate cost statistic:** dollars on the **both-solve** set (§2.1), on provider-actual tokens.
- **Secondary:** dollars over all tasks; total tokens; wall-clock; and the cost *conditional on
  outcome* (cost-per-solve, cost-per-failure) — the richer picture behind the headline, and the
  sanity check against the both-solve collider (§2.1).

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
- **Note on common random numbers.** Classical CRN variance reduction — coupling both arms on a
  shared decoding seed so within-task noise *cancels* rather than merely averages down — is largely
  inapplicable here: the two arms' contexts diverge *by construction* (arm B injects seed text every
  task), so an identical seed does not produce coupled trajectories. The design therefore controls
  within-task variance via R-averaging, consensus verdicts, and the mixed-effects model, and sizes
  N from pilot-**measured** discordance (§6.4), not assumed signal-only discordance.

### 6.2 The tests (reuse first)

**Quality — gate primary: paired per-task pass-rate difference.** For each task i, compute
p̂_A,i and p̂_B,i (each over R runs). Test non-inferiority of the mean paired difference
mean(Δ_i), Δ_i = p̂_B,i − p̂_A,i, via a **one-sided (1−α) BCa bootstrap CI over tasks**:
non-inferiority is declared iff the lower bound > −δ (with the §2.1 relative-regression guard also
satisfied); superiority (bonus) iff the lower bound > 0. Resampling the task index over the
observed per-task Δ_i propagates within-task Binomial(R, p_i) noise (it is embedded in each Δ_i's
spread), so the CI is if anything conservative. This uses the full R > 1 information and is
precisely the R > 1 path the `paired.ts` docstring names as the planned extension ("per-instance
pass RATES → Wilcoxon signed-rank / paired bootstrap … DR-2026-06-02-b §2b"). Wilcoxon signed-rank
on Δ_i is reported alongside as a distribution-free corroborator.

**Quality — legible corroboration: consensus McNemar (shipped, reused verbatim).** Collapse R
repeats to a per-task **consensus verdict** (pass iff resolved in ≥ ⌈R/2⌉ runs; ties → fail — a
no-op at the planned odd R = 3 / R = 5, where ties cannot occur; the operative distortion is the
≥ ⌈R/2⌉ polarisation, which depresses low-ceiling rates — a reason this read is a **direction-only
corroborator, not the gate**) and feed the two arms into `comparePaired(before=A, after=B)`
(`client/src/eval/paired.ts`). It returns the discordant counts b = `improved` (A-fail → B-pass,
"rescues"), c = `regressed` (B broke what A solved), the `concordantPass`/`concordantFail` cells,
the **exact two-sided McNemar p-value** (`mcnemarExact`), and its own superiority verdict. From
the **same b, c** we read the non-inferiority test: the paired resolve-rate difference is
(b − c)/pairs, with a one-sided (1−α) CI via **Tango's score interval** for a paired proportion
difference (better small-sample coverage than Wald; Wald `SE = √((b+c) − (b−c)²/n)/n` as a
fallback). Marginal absolute rates are reported with `wilson.ts` (`wilsonInterval`, `compareRates`)
as the most conservative view.

**Corroborators are descriptive/diagnostic only.** The consensus-McNemar, Wilcoxon, marginal-Wilson,
and mixed-model reads carry **no decision rule** and cannot change the boolean gate value, which is
fixed solely by the two primary one-sided tests (§2.2). A direction disagreement may **hold**
publication of a nominal PASS for review, but can never **license** a PASS — so inspecting them
cannot inflate type-I above α (no garden-of-forking-paths on the gate). The optional Sonnet-class
replication (decision E) is pre-registered as a **separate** confirmatory external-validity test
with its own stated α; it is not pooled with the primary run.

**Cost — paired.** For each both-solve task, Δcost_i = mean$(B) − mean$(A) over the R runs. Test
H1: mean(Δcost_i) < 0 via one-sided **Wilcoxon signed-rank** (primary; distribution-free — cost
is skewed) plus a **BCa bootstrap CI** on the median and mean difference. Report median and mean
Δ$, and the % reduction. **If the both-solve set falls below its pre-registered floor** (§10
pinned inputs), the paired Wilcoxon is underpowered and the cost sub-claim is **INCONCLUSIVE by
construction** — never re-tuned upward.

**Robustness (optional, reported not gated): mixed-effects logistic** on all N·R·2 runs (outcome
resolved ∈ {0,1}; fixed effect = arm; random intercept per task) → the corpus odds-ratio + CI,
which models the stochasticity directly and gives the most powerful read.

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
the mixed model detect the same effect at **equal or smaller N**. Two caveats keep the Connor table
honest: (i) consensus collapse injects a **symmetric spurious-discordance noise floor** (b ≈ c even
at zero effect, because consensus verdicts are stochastic) that the clean p_b, p_c inputs ignore —
so the Connor N is a *loose cross-check only*; (ii) the operative N comes from the §6.4 pilot's
*realised* p_b, p_c fed into the gate-primary bootstrap sim, not from this table. The reproducible
calculator extends `client/scripts/power.ts` with this McNemar formula.

### 6.4 The pilot (in-scope) → final N

Run a small pilot — **N_pilot ≈ 20–30, R = 3, both arms** — on a provisional contested-band draw.
It estimates: (a) the realised discordance p_b, p_c and effect size; (b) per-task verdict
volatility (does R = 3 suffice or is R = 5 needed); (c) the both-solve cost delta and its
variance; (d) the screening yield and band width (§4.2); (e) **slate memorization exposure** — the
SWE-Bench-Illusion issue-text-only reproduction probe under the stock arm (§4.1). Feed (a)–(c) into
a **bootstrap power simulation** for the gate-primary pass-rate test to set the final N (and confirm
with the Connor table).

**Caveat on pilot precision.** At N_pilot ≈ 20–30 the pilot estimates discordance from only a
handful of discordant pairs (SE on p_b − p_c ≈ the effect itself), so its N is a rough guide, not a
precise size. Therefore **size N from the pilot's CI lower bound** on discordance/effect, not its
point estimate, so an unlucky-lucky pilot does not undersize. Because the final gate is a
pre-registered α = 0.05 IUT on the *achieved* N, a mis-sized N can only cost budget or land
INCONCLUSIVE (§2.2) — it **cannot** produce a false PASS. A batched/sequential run with
pre-registered alpha-spending boundaries is a budget-saving alternative that converts unknown
discordance into a stopping rule.

Then:

- If the required N ≤ the budget cap → run at that N.
- If the required N > budget cap → run at the affordable N and **report the MDE honestly**: "at
  N = …, R = …, the minimum detectable effect at 80% power is X pp; the observed effect was Y with
  CI […]." An effect smaller than a budget-feasible MDE is a valid, decisive gate outcome *within
  v0's scope* (§2.3), reported as INCONCLUSIVE, not spun as a pass.

**Explicitly not N = 10 / R = 1.** DR-2026-06-02-b proved that configuration cannot detect
anything short of a +60pp jump. The pilot exists to justify N from data, not to *be* the
measurement — and the pilot's *only* sanctioned feedback is N/R sizing; it MUST NOT feed band-edge
selection (§10.1).

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
content-addressing + derived index (§4.3); the two-arm (OFF/ON) solve orchestration; the joint IUT
gate (§2). The **statistics are not reinvented** — the primary quality test is the R>1 extension
the shipped `paired.ts` already names as its own roadmap.

**Deliberate divergence:** the v2 screen's `base-fails-0/R` predicate is *not* reused as-is. Its
estimand (learner-improvement-from-zero) differs from ours (capability delta where the bet's
"equal quality, lower cost" is meaningful). We reuse its generator and widen its predicate. This
divergence is the reuse finding the brief asked to record.

### 7.1 External frameworks considered (build-vs-adopt for the rig)

The reuse above is all *internal*. A separate question is whether an off-the-shelf eval framework
lets the follow-on rig avoid hand-rolling the two-arm orchestration and logging.

**No external eval supplies *our* number.** No public benchmark measures "does *our* corpus help
*our* agent" — the bet is a **differential** (ON − OFF) on a slate proven disjoint from *our*
seeds+traces, and we hold the only copy of the corpus. Off-the-shelf evals give *absolute* scaffold
scores on a shared task set, not this contrast and not the disjointness proof. The experiment
(two-arm design, contested-band slate, disjointness proof, joint gate) is irreducibly ours. There
is no read-the-number-off-a-leaderboard shortcut. (This is a claim about *our differential*, not
about the general question — see the prior-art note below.)

**But the plumbing is adoptable.** The layers separate cleanly:

| Layer | Disposition |
|---|---|
| Benchmark (task set) | **Already reused** — SWE-rebench-V2 via HF, maintained + continuously mined |
| Grader (container pass/fail) | **Already reused, with our corrections** — upstream `scripts/eval.py` + our re-derived "resolved" semantics and ungradeable-≠-fail (§5.1). Keep these; upstream harnesses get them wrong |
| Runner / orchestration | **Adopt [Inspect AI](https://inspect.aisi.org.uk) (UK AISI)** for the rig — see below |
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
- **Scoring library ships bootstrap CIs** (overlapping §6; the IUT gate remains our policy).
- **HuggingFace dataset bridge** — SWE-rebench-V2 HF rows load directly.

**Inspect does NOT supply the gate's cost numbers — a correctness precondition, not a rig footnote.**
Inspect's own docs confirm token/cost is logged only for calls routed through its model proxy; a
bridged agent that makes its *own* provider calls (jinn-agent) is not metered by Inspect. So the
recommended default (§5.2 / §13 option b) sources cost from **jinn-agent's own emitted
provider-actual usage**. If instead option (a) — routing jinn-agent through Inspect's proxy — is
chosen, it MUST be preceded by a documented one-instance confirmation that proxying does not alter
the agent's native token usage / turn structure (a treatment-fidelity check that itself argues for
option b). Because cost is half the gate and provider-actual tokens are a hard precondition (§5.2),
this is not a deferrable detail.

**Net:** adoption is *partial* — Inspect covers the outer loop (arms, epochs, run store, bootstrap
CIs, orchestration/logging), we keep the SWE-rebench-V2 grader, own the experiment, and source cost
ourselves. This saves building orchestration/logging from scratch without discarding our scoring
corrections.

**Prior art (corroboration + one honest reckoning).** The general question — does prior context /
experience help a coding agent, at what cost — *is* studied publicly, and the spec must not overclaim
otherwise. **SWE Context Bench** ([arXiv 2602.08316](https://arxiv.org/abs/2602.08316), 2026) is the
closest: its Oracle (pre-provided) vs Free (autonomously-retrieved) context settings mirror decision
B's installed-seeds vs live-retrieval split, its within-task paired + test-based design mirrors ours,
and it quantifies the exact cost-inflation failure mode our both-solve cost bar guards against —
*unfiltered or incorrectly-selected experience gives limited or negative benefit*, while correctly-
selected summarized experience cuts cost, especially on hard tasks. It is corroboration, **not** a
source of our number: it measures a private trajectory pool helping a strong model on SWE-bench Lite
(not our corpus/agent) and reports aggregate averages with no paired-significance test — so it
supports the premise and the cost bar but supplies neither our differential, the disjointness proof,
nor the IUT gate. Its oracle/task-matched setting is a possible v1 upper-bound arm under §8's
loadout-parameter framing, **not** a v0 arm (decision B forbids per-task loadouts as a contamination
vector). Separately, methodologically, recent agent-ablation work pairs per-task comparisons with
**McNemar's exact test + Wilcoxon signed-rank** — our exact stat choice — and reports context-file
effects around **+6.4pp** on solve rate ([Harness-Bench](https://arxiv.org/html/2605.27922v1);
[Natural-Language Agent Harnesses](https://arxiv.org/html/2603.25723v1), whose only-full / only-
ablation / both-agree coding *is* the McNemar discordant cells). A +6.4pp effect on a *representative*
slate needs N > 2000 (§6.3) — external evidence that **reinforces the contested-band decision**.

---

## 8. Extensibility to v1 (distilled > seeds)

The design treats **"arm = corpus loadout" as a parameter**. v0 scores {A: empty, B: seeds}. v1
adds **arm C: distilled skills** on the **same frozen slate** (`cap-v0`), and the analysis becomes
pairwise contrasts against the stock baseline:

- **C − A** — distilled vs stock: the v1 restatement of the binding bet.
- **C − B** — distilled vs seeds: does distillation beat raw seeds? (the v1-over-v0 claim.)

Nothing else changes: same slate + hash, same grader + semantics version, same paired structure,
same tests, same gate — **except** the semantic disjointness axis (§4.3) becomes **mandatory** for
arm C, because distilled skills are paraphrases of repo-keyed traces and the paraphrase seam is
wide. **The rig is reused, not rebuilt** — v1 is a new loadout and one more arm, not a new
methodology. The one hard requirement this places on the future is that the **slate stays pinned**
across v0 → v1 (a re-drawn slate makes the numbers incomparable) — which is compatible with
contamination control because distillation excludes the slate by construction (§12). If a semantics
bump forces a slate re-cut, v0 must be re-run on the new slate before v1 numbers are compared to it.
A live-retrieval arm (and SWE-Context-Bench-style oracle upper-bound arm) are additional
loadout parameters available under this same framing — the deferred work that a decisive §8 FAIL
requires (§2.3).

---

## 9. Practical envelope and posture

**Human-run measurement, not CI.** This is a deliberate, resourced run an operator executes on a
capable host, producing a dated report + anchored raw records. It is **not** wired to a gate or a
push-triggered job (swe-rebench evals are heavy, stochastic, and Docker/disk-bound — a flaky gate
is worse than no gate, per the `dont-over-validate-flaky-nongating-tests` lesson). The output is a
signed measurement, reproducible by re-running the pinned rig against the pinned slate.

**Envelope** (illustrative, for a mid-size run):

- **Measurement volume:** N × R × 2 solves + the same number of grades. E.g. **N = 200, R = 3 →
  1,200 solves + 1,200 Docker grades.**
- **Screening volume (dominates, and was previously uncounted):** the contested band is built by a
  full stock-arm eval pass over candidates at ~15% yield → ≈ **(N / yield) × R stock solves+grades**
  (e.g. N = 200 at ~15% yield ≈ 1,333 candidates × R ≈ **4,000 screening solves+grades**). The
  screen, not the measurement, dominates host-hours — this is where the cheaper-leading-indicator
  option (§13) pays off.
- **Cost (solve side, `gpt-5.4-mini`, decision E):** the small-repo pilot (16 solves, 8 repos)
  measured **~$0.026–0.185/solve, avg ~$0.094** (representative, priced at the published
  $0.75/$4.50-per-M rate) — reasoning tokens are a large share of output (e.g. 8.9k reasoning of
  15.3k out). At ~$0.094/solve the combined solve side (≈1,200 measurement + ≈4,000 screening ≈
  **5,200 solves**) is **~$490+ representative** — ~3–4× the earlier flash estimate, still small
  next to the Docker/disk/wall-clock constraint (big repos push per-solve higher). **Inference is
  free to the operator via the Codex sub** — *no throttle observed across the 16-solve pilot* — but
  the ~5,200-solve powered screen+measurement *will* hit subscription caps, so it runs either
  throttle-bound over many days on the sub or on the **metered OpenAI API** (~$490). Note the §4.2
  constraint that **screening must use the same model as the arms** — so no cheap-flash-screen /
  mini-measure split; both run on the pinned model. (Corollary unchanged: the "lower cost" bar is
  demanding — a loadout must save more than the context tokens it carries cost to carry, §2.1; on
  gpt-5.4-mini the generic-seed tax was a small ~+$0.003/solve median and quality-neutral.)
- **Fallback metering (`deepseek`/OpenRouter):** OpenRouter's credit check requires the key to
  *afford* the worst-case `max_tokens` up front but bills **actual** tokens; keep `max_tokens`
  generous so no legitimate solve is truncated (a truncated solve is a spurious fail) and size the
  key's limit to cover the reservation.
- **Grade side (Docker):** each grade minutes-to-tens-of-minutes wall-clock, up to a **2-hour**
  hard timeout per instance (`DEFAULT_EVAL_TIMEOUT_MS`); images are linux/amd64 (slow/crash-prone
  under Apple-Silicon emulation — run on amd64 hosts). Serialised grades ≈ many hundreds of
  host-hours → **parallelise across K hosts**; wall-clock ≈ (grade-hours / K) + solve time.
- **Disk:** floor **≥ 40 GB** (`JINN_EVAL_DISK_FLOOR_GB ≥ 40`; the full pandas/OpenHands/litellm
  slate has crashed laptops at the 20 GB default — `swe-rebench-eval-disk-crashes-laptop`). Big
  repos on a **≥ 100 GB** host. The runner already prunes each round's Docker footprint and aborts
  cleanly below the floor (`InsufficientDiskError`).

Net: a **multi-day, multi-host, low-thousands-of-dollars run** (screen + measurement). That is the
price of a number that decides whether to scale v1.

---

## 10. Legibility and reproducibility (PRINCIPLES.md)

Every claim must be independently reproducible (PRINCIPLES → Legible). The run publishes, all
content-addressed:

- **Pinned inputs:** jinn-agent SHA, model id + params, slate artifact (with its hash, `rowHash`
  and `imageDigest` per instance, `corpusSnapshotCid`, and the public `corpusDerivedIndexCid`),
  `evalSemanticsVersion`, the price table, R, δ **and its relative-regression cap**, α, **and the
  both-solve-set minimum size** — all committed *before* the run (§10.1).
- **The corpus derived index** (§4.3), so a third party can re-check the **instance- and repo-axis**
  disjointness from public data; the lexical axis is self-attested (raw corpus text is not released,
  §7.1) and recomputable only against the published per-record token sketches.
- **Every raw per-run record:** the produced patch, the grader verdict + test log CID, provider-
  actual input/output tokens, dollars, wall-clock — for all N·R·2 runs, plus the ungradeable-drop
  log. Anyone can recompute the statistic from these; the published number is a *function* of
  published data, not a private assertion.
- **The analysis script** (bootstrap + McNemar + Wilcoxon + the Connor power calc) so the p-values
  and CIs are re-derivable.

Because the agent is stochastic, exact per-run reproduction is not guaranteed; **the R repeats and
the full raw records** are what make the *statistic* reproducible (re-running yields a
distribution the published CI already characterises).

### 10.1 Neutral verification and pre-registration

Recomputing the statistic from our records checks *arithmetic*, not *fidelity* — that the runs
happened as described, no runs were silently dropped, the loadout was only distribution-matched,
ungradeable-drops were symmetric. For the one number the bet reduces to, self-grading is not
Legible to a skeptic (PRINCIPLES → **Neutral**: the operator cannot be the house). Two binding
requirements:

1. **Pre-registered stopping rule.** The band edges, the candidate HF-row pool, the screening model
   + R, δ + the relative cap, α, and the both-solve floor are **committed** (content-addressed /
   signed git tag) **before** the pilot runs. The **first** run executed at the pilot-set N on the
   frozen slate + pinned agent SHA + pinned model is the **run of record**. Any subsequent
   re-screen, band-edge change, or slate re-draw mints a **new anchored slate version** (distinct
   hash, from-scratch stock-only re-screen) whose existence and reason are published. An
   INCONCLUSIVE result MUST NOT be silently re-rolled into a PASS. The pilot's only sanctioned
   feedback is N/R sizing (§6.4 (a)–(c)); it MUST NOT feed band-edge selection.
2. **Independent fidelity check.** A party with **no authorship stake** in the harness-network bet
   re-runs a random ≥ 20% subset of pairs (both arms) from the pinned slate and confirms the re-run
   resolve-rates fall inside the published CIs. Absent this check, the report is labelled
   self-attested.

---

## 11. Threats to validity

| Threat | Handling |
|---|---|
| **Corpus contamination** (helps only B) | §4.3 three content axes + optional semantic axis, fail-loud; the load-bearing control |
| **Technique-leak** (a generic seed supplies a slate task's fix as a technique) | Un-provable by the content axes; bounded *only* structurally by the distribution-matched, slate-blind, fixed loadout (§3.1), attested in the artifact (else `technique-leak-unattested`); semantic axis mandatory at v1 (§4.3) |
| **Lexical scan defeated by paraphrase** | Axis 2 (repo) is the primary near-duplicate guard; axis 3 (tokens) is a backstop; the optional/v1-mandatory embedding axis (§4.3) covers the cross-repo paraphrase seam |
| **Model-pretraining contamination** | **Main effect** cancels in the paired difference (§4.1). The residual **skill×memorization interaction** (an arm-B-only cue-unlock) does NOT cancel; bounded by the distribution-matched (not task-matched) loadout and flagged by the pilot's memorization-exposure probe (§4.1, §6.4) |
| **Both-solve conditioning = selection on a post-treatment outcome (collider)** | Bounded: paired cost compares same-task B-vs-A (no set-composition win); the quality NI leg caps the driving regression channel; the both-solve composition delta + the §5.2 all-tasks cost secondary are published as a sanity check (§2.1) |
| **δ mis-calibration / base-rate sensitivity** | δ = 5pp absolute pre-registered with a stated basis (§2.1); PASS additionally blocked if relative regression > 15% of stock base rate, so a large relative drop at a low band base rate cannot pass on the absolute margin |
| **Pinned-model ceiling → thin/empty contested band, weak tool-use, or empty-patch spirals** (decision E) | **Largely resolved by the v0.3 re-pin.** flash's spirals (empty-patch / >700k-token runs when handed extra context) confounded the seeds arm — its "seeds hurt −9.1pp" was mostly flailing; `gpt-5.4-mini` eliminated them (0 empty patches / 16 solves) and holds a healthy contested band (arm A 66.7%). Residual, now *inverted*: gpt-5.4-mini is a **stronger** model than a floor fork user, so the band/effect may not transfer *down* — mitigated by the model-agnostic methodology (a cheaper-model replication is pre-registerable, own α) and the honestly-recorded cost-representativeness tradeoff (decision E, §9) |
| **Contested-band ≠ full distribution / selection-on-baseline** | The claim is *explicitly scoped* to the contested region (§2.3); screening runs are not gate data, so RTM biases only the non-gating marginal rate, not the fresh paired difference (§4.2) |
| **Ungradeable runs biasing quality** | Never scored as FAIL; re-run K=2 then symmetric drop-the-pair; drop count published (§5.1, §10.1) |
| **Per-task skill cherry-picking / loadout-composition tuned to the task family** | Loadout is the whole imported seed set or a published fixed rule, frozen *before* slate ids are drawn (§3.1); per-task hand-picking forbidden |
| **Consensus-collapse noise floor** | Ties→fail is a no-op at odd R; the ≥⌈R/2⌉ polarisation injects symmetric spurious discordance the Connor table ignores — so consensus-McNemar is a direction-only corroborator and N is sized from the pilot bootstrap, not the table (§6.2, §6.3) |
| **Multiple comparisons / forking paths** | The gate is a single IUT on two pre-registered tests (§2.2); corroborators carry no decision rule and cannot license a PASS (§6.2); the Sonnet replication has its own α |
| **Regression to the mean** | Periodic re-run of the stock arm during the campaign (runbook guard) rules out drift masquerading as effect |
| **Treatment fidelity** (is "corpus ON" really on? is arm A really empty? is the screen really blind?) | **Arm A runs with `--ignore-rules`** so no operator memory / `AGENTS.md` / preloaded skill leaks into the "empty" arm (spike-confirmed, §3.1); arm-B runs assert the loadout loaded and content-hashes to `corpusSnapshotCid` (§4.3); screening runs attest empty-loadout / no-corpus-tools / empty-host-skill-dir (§4.2); a fidelity-failed run is excluded, not scored |
| **Cost-capture path** (Inspect proxy vs native usage) | Gate decided on provider-actual usage (§5.2); UNMEASURED → INCONCLUSIVE, never PASS on heuristic constants; option-(a) proxy diverges the measured agent's network path from the production binary — prefer option (b); billing cross-check mandatory pre-run (§7.1, §13) |
| **Conflict of interest** (team measures its own bet) | Pre-registered stopping rule + independent fidelity re-run (§10.1); PRINCIPLES → Neutral |

---

## 12. The shared held-out boundary (hand-off to the distillation session)

This session **owns and publishes** the held-out task-set boundary; the distillation-design
session **consumes** it. The interface is the frozen slate artifact of §4.4. The contract:

1. **Distribution = coding.** Both sessions target SWE-rebench-V2 coding instances (decision A).
2. **The boundary is the `cap-v0` slate artifact** — its `instances[]` (instance_ids + repos),
   its hash, `corpusSnapshotCid`, and the public `corpusDerivedIndexCid`.
3. **Distillation MUST exclude the slate from its input**, by **both** instance_id **and repo**
   (the repo denylist forecloses near-duplicate leakage — a different PR in the same repo). The
   mechanism already exists: distillation calls **`excludeHeldOutSlate(pool, slateIds)`**
   (`_swe-rebench-v2-held-out-slate.ts`) — the same chokepoint the training generator uses — and
   additionally filters its trace input by the repo denylist. Any distilled skill whose provenance
   traces to a slate repo is dropped before it can enter arm B/C. For v1 arm C, the **semantic
   disjointness axis (§4.3) is mandatory** on the distilled output.
4. **Direction is two-sided.** The slate excludes anything already in the corpus (§4.3); the
   corpus/distillation excludes anything in the slate (this section). Freeze order: freeze +
   snapshot the corpus → draw the contested slate disjoint from it → publish the slate → from
   then on, distillation excludes the slate. If the corpus grows after freeze, the slate's
   disjointness proof is re-checked against the new snapshot before any v1 comparison.
5. **The slate is pinned across v0 → v1** (§8), so distillation's exclusion set is stable.

**Handed to distillation:** `cap-v0` instance_id denylist + repo denylist + the freeze timestamp.
**Required back from distillation:** confirmation that its input excludes both, that no distilled
skill's provenance traces to a slate repo, and (v1) that the semantic axis was run.

---

## 13. Decisions deferred to the rig (`feat`, post-sign-off)

These are implementation choices, not methodology, and are settled when the rig is built. (Note:
δ + its relative cap, α, R, the both-solve floor, and the band edges are **pre-registered before
the pilot**, §10.1 — they are *not* on this list.)

- Exact contested-band edges: **committed before the pilot** (§10.1); if the pilot motivates a
  change it is a new pre-registered slate version, from-scratch re-screened, never an in-place edit.
- K (ungradeable re-run cap; start 2).
- Bootstrap resample count and BCa vs percentile CI (start BCa, 10k resamples).
- Parallelism / host orchestration for the grade side.
- Whether the optional representative sanity sample and the optional semantic disjointness axis are
  run in v0 or deferred.
- **Cheaper leading indicator for the BAND SCREEN only** — a reduced-timeout or single-run stock-arm
  pass-rate proxy to pre-rank candidates by likely band membership, so the full R ≥ 3 certified
  screen is spent on a higher-yield shortlist. The certified SWE-rebench-V2 grader stays the sole
  authority for the measurement slate and the final `stockPassRate` (§4.4); a proxy risks
  band-misclassification and is never the gate authority.
- **Adopt Inspect AI as the outer runner** (§7.1) — recommended; validate the `sandbox_agent_bridge`
  fit against the jinn-agent fork on one instance first.
- **Token-capture path** (§5.2, §7.1): default to capturing jinn-agent's own **provider-actual**
  usage (option b); the provider-billing cross-check on a sample is a **mandatory pre-run validity
  gate**, not an option. If option (a) proxy-routing is used, run the one-instance fidelity
  confirmation first.

---

## 14. The gate, restated (met / not-met)

> On the frozen `cap-v0` contested-band coding slate, with arm A = stock jinn-agent and arm B =
> the same agent with the distribution-matched seed loadout pre-installed (no live retrieval),
> both at the pinned model and R ≥ 3 repeats:
>
> **PASS** iff, at α = 0.05 as an intersection-union test —
> **(1)** corpus-ON resolve-rate is non-inferior to stock (Δ_quality > −5pp **and** relative
> regression ≤ 15% of the stock base rate), **AND**
> **(2)** corpus-ON costs strictly less on the both-solve set (Δ_cost < 0), on provider-actual tokens.
>
> Otherwise **FAIL** (clear regression or no cost win) or **INCONCLUSIVE** (underpowered at the
> achieved N, cost UNMEASURED, or both-solve set below floor — reported with its MDE, and treated
> as *not a pass*; terminal, never silently re-screened into a PASS, §10.1).

This is the one number the harness-network bet reduces to. It is decidable, pre-registered,
externally re-checkable on its instance/repo axes, and extends unchanged to v1 by adding the
distilled arm on the same slate. Its scope is deliberately narrow: a v0 seeds-only **pre-gate** for
§8 — a v0 PASS supports the bet, a v0 FAIL does not by itself trigger §8's halt (§2.3); a decisive
§8 FAIL needs the deferred live-retrieval or distilled arm.
