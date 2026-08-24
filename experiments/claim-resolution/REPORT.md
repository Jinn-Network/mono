# Does Jinn's multi-solver architecture beat one good web-enabled agent at claim resolution?

**Date:** 2026-08-19 · **Status:** complete · **Scope:** solver layer only, no settlement mechanism

## Summary

Across 145 externally-resolved claims, a single strong web-enabled agent resolved
**145/145 correctly (100%, 95% CI 0.974–1.000)**. Five independent diverse solvers
plus aggregation also resolved 145/145, at **6.0× the cost**. The five solvers
disagreed on **2 of 145 claims (1.4%)**; on both, aggregation correctly overruled
the dissenting solver — the mechanism works, it just almost never has anything to do.

There is no measured accuracy benefit to the multi-solver architecture on this task,
and no headroom in which one could appear.

---

## 1. How the benchmark was assembled

Reality.eth, Kleros and the Polymarket/UMA APIs were **unreachable** from the
execution environment — the egress proxy refused CONNECT to
`gamma-api.polymarket.com`, `reality.eth.limo` and `api.thegraph.com` alike, and the
same block applies to direct page fetches. The benchmark was therefore assembled from
externally-resolved claims located through web search, with the substantive settlement
record (official announcement, regulator's docket, court judgment, journal notice) as
ground truth. The experiment brief permits this fallback; §7 states what it costs.

The pipeline (`bench/`, five stages, each resumable and each writing its own artifact):

| stage | what it does | model |
|---|---|---|
| `curate.mjs` | 21 topic buckets, one unrestricted web-search agent each, proposes claims + criteria + deadline + ground truth + provenance | sonnet-5 |
| `sanitize.mjs` | rewrites criteria that name the settlement venue into substantive tests; drops trivial-lookup and answer-leaking items | sonnet-5 |
| `verify.mjs` | re-establishes the resolution **without seeing the curator's answer**, with explicit permission to read the settlement record | opus-5 |
| `closed-book-probe.mjs` | answers each claim with **no web access at all** — the contamination control | sonnet-5 |
| `build-dataset.mjs` | admission rules, near-duplicate removal, class-balance cap, deterministic dev/eval split | — |

Admission required all of: verifier agrees with curator; verifier confidence ≥ 0.85;
verifier judged the criteria unambiguous; ≥ 2 provenance URLs; not a near-duplicate.
Everything rejected is kept in `bench/rejected.json` with reasons.

**Two strata were built.**

**Main benchmark — 100 claims** (`bench/`). 51 YES / 49 NO · 39 hard / 61 medium ·
10 disputed · 96 resolving after the solver models' training cutoff · 20 dev / 80
held-out eval. Drawn from 15 buckets: geopolitics, elections, macro, US policy,
corporate, crypto, AI/tech, space/science, international organisations, legal,
health/regulatory, energy/commodities, culture, deliberately compound claims, and
contested historical oracle cases.

**Hard stratum — 45 claims** (`bench/hard/`), built *after* the main benchmark
ceilinged on its dev split. Its six difficulty axes were fixed a priori from the
structure of the task, **not** by looking at which claims the solvers got wrong:
contested/corrected reporting (5), obscure low-coverage sources (7), near-threshold
outcomes (7), process-stage distinctions (9), negative existence claims (10),
multi-hop assembly (7).

### Ground truth was independently spot-checked

Because curator, verifier and solvers are all Claude models using the same search
backend, "accuracy" could in principle measure model agreement rather than truth.
Three claims were re-verified by hand through a separate search path, chosen to be
maximally damaging if wrong:

- *Khamenei killed in the 28 Feb 2026 strikes* (ground truth NO on the claim that the
  Foreign Ministry's "safe and firmly in command" statement held up) — confirmed;
  Iranian state media confirmed the death on 1 March.
- *BMJ Public Health retraction of Mostert et al.* by 15 Aug 2026 (YES) — confirmed;
  retracted 11 Aug 2026.
- *KFTC sugar cartel, Samyang's fine larger than CJ CheilJedang's* (NO) — confirmed
  against Korean-language reporting: CJ ₩138.3bn > Samyang ₩130.2bn.

3/3 correct, including the deliberately obscure one. The ground truth is sound.

---

## 2. Experimental conditions

Identical claims, identical prompts, across all conditions. Each solver attempt is one
headless `claude -p` subprocess with WebSearch — the same execution shape Jinn's
Claude harnesses already use (`operator/src/runner/claude.ts`,
`operator/src/harnesses/impls/learner/`) — emitting a schema-validated payload
(`answer`, `confidence`, `evidence[]`, `reasoning_summary`, `abstain`) that mirrors the
`prediction.v1` payload convention.

| condition | composition |
|---|---|
| **A_opus** | 1 × opus-5, direct-research strategy. The strongest single agent; the baseline to beat. |
| **A_sonnet** | one ordinary network member alone. Reported as B1 rather than re-run, so it is literally one draw from the network. |
| **B** | 5 independent attempts: sonnet-5 × {direct, disconfirmation-first, criteria-literal}, haiku-4.5 × {timeline-reconstruction, direct}. Every member is individually weaker than A_opus by design. |
| **C_majority** | plain majority over non-abstaining answers; tie ⇒ abstain. |
| **C_conf** | confidence-weighted vote. |
| **C_judge** | unanimous answers pass through; on any disagreement an opus-5 judge reads the five outputs and their cited evidence, with **no web access and no ground truth**, and decides. |

Diversity is model × research posture only — four generic strategy prompts written
before any results were seen, no per-claim tuning, no new infrastructure.

The solver prompt contains exactly three things: claim, resolution criteria, deadline.
Nothing else from the truth file ever reaches it.

### Experimental discipline

No prompt was tuned against benchmark answers. The four strategy variants and the
system prompt were written before any claim was run and never revised. The dev/eval
split is a deterministic hash of the claim text, so it cannot be reshuffled to taste,
and the eval split was scored once.

The hard stratum was added *after* seeing that the dev split ceilinged — but its
difficulty axes were chosen from the structure of the resolution task, not from solver
errors, and no solver output was inspected before it was built. It is worth noting that
adding it made the result **worse** for the hypothesis, not better: the hard stratum
produced zero solver disagreement where the main benchmark produced 2%. The benchmark
was not optimised until Jinn looked good.

**Totals:** 1,149 solver attempts (1,140 successful, 9 lost to transient proxy faults
and re-run) + 2 judge calls, across the 100-claim main benchmark and two independent
runs of the 45-claim hard stratum.

---

## 3. Leakage precautions

This is a resolution task, not a forecasting task, so reporting published *after* the
deadline about what happened *by* the deadline is legitimate evidence. What must not
leak is the **oracle's own verdict**.

1. **Structural separation.** `bench/claims.public.json` holds only id, claim,
   criteria, deadline, split. Ground truth, provenance, difficulty and dispute metadata
   live in `bench/truth.json`, which is read only by `bench/` tooling and `src/score.mjs`.
   The solver path never opens it — enforced by construction, not by convention.
2. **Venue references stripped.** The sanitize pass rewrites criteria that named the
   settling venue ("resolves according to the Polymarket contract X") into the
   substantive test; anything still naming a venue after that was dropped. This cost
   most of the disputed-historical bucket, which is why it is only 10 claims.
3. **Enforced search filter.** Every solver runs behind a `PreToolUse` hook
   (`hooks/websearch-guard.mjs`) that **denies** any WebSearch naming a prediction
   market, betting site or oracle — 26 terms — and appends every query to an audit log.
   Across **3,306 logged searches — 2,142 in the main run and 1,164 in the hard
   stratum — zero were denied**: the solvers never reached for a market page
   unprompted. The guard is a backstop that never had to fire.
4. **Answer-leaking wording removed.** 20 candidates across the two strata were dropped
   because the claim or criteria let a reader infer the answer without research.
5. **Parametric contamination measured, not assumed.** The closed-book probe answers
   each claim with no tools. On the main benchmark **2 of 100** were answerable without
   the web; on the hard stratum 8 of 45 (it deliberately includes 26 pre-cutoff claims).
   Both are flagged per-claim in `truth.json` as `closed_book` and
   `contamination_risk`. Removing all pre-cutoff claims changes no result below: the
   96-claim post-cutoff subset scores identically.

---

## 4. Results

### Held-out eval split (80 claims, main benchmark)

| condition | accuracy | abstention | acc \| answered | $/claim | tokens/claim | searches/claim | wall s/claim |
|---|---|---|---|---|---|---|---|
| A_opus | **100.0%** | 0.0% | 100.0% | $0.151 | 35.6k | 3.0 | 29.6 |
| A_sonnet (= B1) | 98.8% | 0.0% | 98.8% | $0.109 | 29.9k | 2.5 | 27.9 |
| B2 sonnet/disconfirm | 100.0% | 0.0% | 100.0% | $0.107 | 29.1k | 2.4 | 27.4 |
| B3 sonnet/criteria | 100.0% | 0.0% | 100.0% | $0.113 | 30.6k | 2.5 | 28.5 |
| B4 haiku/timeline | 100.0% | 0.0% | 100.0% | $0.168 | 72.9k | 5.9 | 48.7 |
| B5 haiku/direct | 98.8% | 0.0% | 98.8% | $0.161 | 70.0k | 5.6 | 47.6 |
| C_majority | **100.0%** | 0.0% | 100.0% | $0.659 | 232.6k | 18.8 | 180.1 |
| C_conf | **100.0%** | 0.0% | 100.0% | $0.659 | 232.6k | 18.8 | 180.1 |
| C_judge | **100.0%** | 0.0% | 100.0% | $0.661 | 232.6k | 18.8 | 180.5 |

Dev split (20 claims): every condition 100%, zero disagreement.

### Hard stratum (45 claims), run twice

| condition | run 1 | run 2 | $/claim (run 1 / run 2) | searches/claim |
|---|---|---|---|---|
| A_opus | **100.0%** | **100.0%** | $0.159 / $0.185 | 3.2 / 3.8 |
| A_sonnet | **100.0%** | **100.0%** | $0.115 / $0.110 | 2.6 / 2.6 |
| C_majority / C_conf / C_judge | **100.0%** | **100.0%** | $0.760 / $0.752 | 22.4 / 22.6 |

The hard stratum was run twice, independently, on separate solver samples. Both runs
returned 45/45 for every condition and **zero solver disagreement on all 45 claims in
both runs** — the ceiling is reproducible, not a lucky draw.

Every difficulty axis ceilinged: contested reporting, obscure sources, near-threshold
outcomes, process-stage traps, negative existence claims and multi-hop assembly all
scored 100% for a single agent.

### Combined (145 claims)

| metric | A_opus | A_sonnet | C_judge |
|---|---|---|---|
| accuracy | **145/145 (100%)** | 144/145 (99.3%) | **145/145 (100%)** |
| 95% CI (Wilson) | 0.974 – 1.000 | 0.962 – 0.999 | 0.974 – 1.000 |
| abstention rate | 0% | 0% | 0% |
| Brier score | 0.0021 | 0.0123 | 0.0021 |

**Abstention never fired.** Not one of 1,140 successful attempts set `abstain`, despite the option
being offered and explicitly endorsed in the system prompt. On this claim population
solvers are never in a position where they cannot answer.

---

## 5. Single vs multi-solver, and what it costs

| | single (A_opus) | multi (C_judge) | ratio |
|---|---|---|---|
| accuracy, 145 claims | 100% | 100% | — |
| cost per claim | $0.152 | $0.917 | **6.0×** |
| tokens per claim | 36.2k | 245.0k | 6.8× |
| web searches per claim | 3.0 | 19.7 | 6.5× |
| wall clock, solvers serial | 30.0 s | 185.2 s | 6.2× |
| wall clock, solvers parallel | 30.0 s | 55.8 s | 1.9× |

McNemar's exact test, A_opus vs C_judge: **0 discordant pairs, p = 1.0**. Same against
C_majority. The comparison is not merely non-significant — the two conditions produce
identical answers on every claim.

Against the weaker single-solver baseline the multi-solver gain is +0.7pp (144 → 145
of 145) for 6× the cost, and that single correction is the one case discussed below.

**Aggregation mechanism choice was irrelevant.** Majority, confidence-weighted and
evidence-aware judge agreed on all 145 claims. The judge was invoked on 2 claims in
total; on 143 the solvers were unanimous and it was never called.

---

## 6. Disagreement, failures and calibration

**Disagreement rate: 2/145 = 1.4%** (95% CI 0.4%–4.9%); mean pairwise disagreement
across the five solvers 0.8%. On the hard stratum it was **0.0% in both independent
runs** — the harder claims produced *less* disagreement, not more.

**Does disagreement predict error?** Directionally yes, and it is the one place the
architecture demonstrably earned its keep — but n = 2:

- *Starship Flight 13 (ground truth NO).* B1 (sonnet/direct) answered YES at 0.85
  confidence, citing five outlets reporting a successful Starlink deployment and a
  clean booster landing burn. The other four answered NO. The judge chose NO. This is
  the single claim on which the whole experiment's baselines diverge — and it is a
  compound claim where the "both legs succeeded" framing is exactly what a
  first-pass reader gets wrong.
- *Hardware-wallet RNG flaw, >$100M stolen in a single month (ground truth YES).* B5
  (haiku/direct) answered NO at 0.72 confidence, having decided the thefts did not fall
  inside one calendar month. The other four answered YES. The judge chose YES.

So on both disagreements the minority was wrong and aggregation corrected it. But
because A_opus was already right on both, aggregation converted zero A_opus errors.
**Where the network disagreed, A_opus was correct 2/2; where it was unanimous, A_opus
was correct 143/143.** Disagreement carries signal about *member* error, not about
*strong-baseline* error.

**Calibration.** Confidence is well-ordered but compressed and, on this set,
under-confident: A_opus placed 58 claims in the 0.90–0.97 band and 22 in 0.97–1.0, with
empirical accuracy 100% in both. A_sonnet's 0.80–0.90 band (n=12) scored 91.7%, the
only band below ceiling. Brier scores are 0.002–0.012. Calibration cannot be meaningfully
assessed against a 100% outcome rate — there is no variance to calibrate against — so
confidence-weighted aggregation could not be evaluated on its merits.

**Failure inspection.** Every attempt is retained in `results/attempts*.jsonl` with the
full evidence list, reasoning summary, per-model token counts, search counts and cost;
`src/inspect-failures.mjs` dumps any wrong answer side by side with ground truth,
provenance and all five solver rationales. On the eval split it prints nothing, because
neither A_opus nor C_judge got anything wrong.

---

## 7. Limitations

These are ordered by how much they threaten the conclusion.

1. **The benchmark cannot contain claims a single web agent cannot resolve.** This is
   the binding limitation. Ground truth was established by an agent searching the web;
   a claim only entered the set if such an agent could settle it confidently. The
   population is therefore *defined* as "claims resolvable by a web-enabled Claude
   agent", and a single such agent scoring 100% on it is close to tautological. The
   hard stratum changed the *shape* of the difficulty — corrections, obscurity,
   thresholds, process stages, negation, multi-hop — but not the *findability*, because
   the curator still had to find the answer in order to state it. Breaking this
   requires ground truth from a source that is not agent web search: the actual
   Reality.eth / Kleros / UMA resolution databases, which the egress policy blocked.
2. **Zero power to detect improvement.** With the baseline at 100%, no aggregation
   scheme can improve on it by construction. This experiment can only falsify a claimed
   edge, not measure one. The reported null is "no edge is demonstrable here", not
   "multi-solver never helps".
3. **The genuinely contested oracle cases are the ones missing.** Reality.eth/Kleros
   disputes are hard precisely because the *criteria* are ambiguous — the Zelenskyy-suit
   and Ukraine-minerals markets are famous for it. The admission rule required the
   verifier to judge the criteria unambiguous, which is necessary for reliable ground
   truth and simultaneously excludes exactly that population. A benchmark that admits
   ambiguous criteria cannot have trustworthy ground truth; one that excludes them
   cannot test the hard case. Resolving this needs the oracle's own adjudication as
   ground truth, not a reconstruction of it.
4. **Monoculture.** Curator, verifier, solvers and judge are all Claude models sharing
   one search backend. Correlated blind spots would be invisible. The three-claim
   hand-check mitigates but does not eliminate this; a non-Claude solver or a different
   search index would be a stronger control.
5. **Diversity was shallow.** Two model families and four prompt postures. Genuinely
   different retrieval strategies, tool sets or knowledge sources might produce the
   disagreement that this configuration did not.
6. **No settlement layer was exercised.** The daemon, chain, Mech Marketplace, IPFS,
   evaluator harnesses and verdict persistence were all deliberately bypassed. This
   measures Jinn's solver-layer hypothesis, not a deployed Jinn network. Nothing in
   those layers would change the numbers above, but the operational claim ("Jinn can
   run this as a service") is untested.
7. **Sports and price-lookup claims were excluded** by design, as the brief requires;
   16 candidates were dropped on that basis.
8. **Costs are Claude Code CLI list prices** including its per-request overhead, not
   optimised API usage. Ratios between conditions are the meaningful figure, not
   absolute dollars.

**Total experiment cost:** ≈ $245 — $81 benchmark construction (curate $31, sanitize
$4, verify $42, contamination probe $4), $80 main solver runs, $41 + $42 for the two
hard-stratum runs, $0.17 aggregation. 1,149 solver attempts in ~2.5 hours of wall clock
at concurrency 10.

---

## 8. Verdict

**NOT SUPPORTED: A strong single agent performs similarly enough that Jinn's
multi-solver architecture currently has no demonstrated edge.**

On 145 externally-resolved, research-requiring claims — 96% of the main benchmark
resolving after the solver models' training cutoff, only 2% answerable without web
access — one opus-5 agent with web search was correct on every single one. Five diverse
solvers with three aggregation schemes matched it exactly, at 6× the cost, 6.8× the
tokens and 6.5× the search volume. The solvers disagreed on 1.4% of claims, so
aggregation could not have moved more than a point and a half even if every
disagreement had been a baseline error, which none were. The hard stratum was run twice
and returned identical results both times, including zero disagreement on all 45 claims.

Against the decision threshold set out for this experiment: single agents do resolve a
substantial majority correctly — in fact all of them; multi-solver aggregation produced
**no** repeatable accuracy improvement; the improvement was **not** largest on
ambiguous, research-heavy claims, because the hard stratum showed *zero* disagreement;
and the added compute cost is real. Three of the four promising-result criteria fail.

The honest reading is narrower than "the idea is wrong", and the difference matters:

- **What is established.** For claims whose resolution is discoverable by competent web
  search, the marginal value of a solver *network* over a single strong solver is not
  measurable, and the cost multiplier is ~6×. If Jinn's pitch to a Reality.eth or Kleros
  integration is "many solvers are more accurate than one", this experiment does not
  support it on that population — and that population is most of what an oracle
  actually processes.
- **What is untested.** The population where oracle resolution genuinely is hard —
  ambiguous criteria, contested interpretation, adversarial submissions, evidence that
  does not exist in the search index — is exactly the population this benchmark could
  not construct, because reliable ground truth for it requires the oracle's own
  adjudication record. That is the only place a multi-solver edge could still live.
- **One positive signal, at n = 2.** Both times the network disagreed, aggregation
  correctly overruled the dissenting member. The mechanism functions; the task supplies
  it with almost nothing to do.

**Recommendation.** Do not invest further in multi-solver aggregation for public-data
claim resolution on the strength of an accuracy argument. If the direction is pursued
at all, the next step is not more solvers — it is obtaining real Reality.eth/Kleros/UMA
dispute records as ground truth and re-running this harness against the questions those
systems actually escalated. That is a data-access problem, not a modelling one, and it
is cheap: the harness in this directory runs unchanged against any dataset in the same
two-file format.
