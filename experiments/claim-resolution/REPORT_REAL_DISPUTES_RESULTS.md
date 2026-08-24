# Real disputed oracle cases: multi-solver vs one strong agent — results

**Date:** 2026-08-20 · **Predecessors:** [`REPORT.md`](REPORT.md) (round 1, synthetic, ceiling effect) · [`REPORT_REAL_DISPUTES.md`](REPORT_REAL_DISPUTES.md) (round 2, blocked on egress — the block does not apply to this local environment, so the experiment ran)

## Verdict: NOT SUPPORTED

On 150 genuinely disputed, protocol-resolved claims, five-solver aggregation did not
out-resolve one strong web-enabled agent. The best aggregation (evidence-aware judge)
scored **67.3%** against the single Opus baseline's **69.3%** — a difference of −2.0
points at **2.9× the cost** (McNemar exact, 9 discordant pairs, p = 0.51). Even a single
Sonnet network member alone (68.7% at $0.32/claim) was statistically indistinguishable
from the full aggregate (p = 0.73). This is not a ceiling artifact: overall accuracy sat
at 61–69% across conditions, with plenty of room to differentiate.

Two genuine, narrower Jinn edges did show up, with caveats (§7, §8):

1. **Abstention discipline.** On the 26 cases the protocol itself refused to answer
   (INVALID / ANSWERED TOO SOON), the single strong agent forced an inappropriate YES/NO
   **92%** of the time; individual network members only 65–77%, and at least one member
   abstained on 10/26 (the single agent flagged 2/26). A resolver network is a better
   *invalidity detector* than a lone maximally-capable agent, which answers when it
   should refuse.
2. **Disagreement predicts difficulty.** Where the 5 members disagreed (26% of claims),
   the single agent's error rate nearly doubled (24.3% → 43.6%). But the same signal was
   available for free: flagging the single agent's own 39 lowest-confidence claims
   isolates *exactly* the same error concentration (43.6% vs 24.3%), with only
   half-overlapping claim sets. Disagreement is a real difficulty signal, not a unique one.

Escalation routing (single agent everywhere, aggregate only on disagreement) also did
not help: 68.0% at $1.29/claim — the aggregate is *worse* than the single agent on
exactly the disagreement set it would be escalated to (51.3% vs 56.4%).

---

## 1. What ran

- **Task**: given a historical Reality.eth question (verbatim), answer YES / NO /
  UNRESOLVABLE as of the moment the dispute existed (arbitration request, else last
  competing answer), from public web evidence, under a leakage guard.
- **A (baseline)**: one `claude-opus-5` solver with WebSearch. Not weakened.
- **B (network)**: five independent attempts — 3× `claude-sonnet-5`
  (direct / disconfirmation-first / criteria-literal postures), 2× `claude-haiku-4-5`
  (timeline / direct). Each individually cheaper and weaker than A.
- **C (aggregation)**: majority vote; confidence-weighted vote; and a no-web Opus judge
  that reads the five outputs + cited evidence only where they disagree (39/150 claims).
- 900 solver attempts, all completed; 6,262 web searches; ~$342 inference total.

## 2. Dataset — real disputes, protocol ground truth, no model in the loop

Reconstructed directly from chain state over public JSON-RPC
(`bench/fetch-reality-disputes.mjs`; raw export + manifest in `bench/raw/`):

- Six Reality.eth deployments scanned from their deployment blocks: Ethereum mainnet
  v2.0/3.0/3.2 and Gnosis v2.1/3.0/3.2 — 33,225 questions, snapshot-pinned.
- **Mechanical dispute filter** (no model, no topic judgment): finalized AND (≥2
  distinct bonded answers OR arbitration requested) → 1,491 cases.
- Finalization and the final answer are read from the contract itself (`isFinalized()`,
  `resultFor()`), because `LogFinalize` turns out to be emitted only on the arbitrator
  path — passive timeout finalization emits nothing (corrects DATA_REQUEST §1.2).
- Decoding admits booleans and single-selects whose outcome list is exactly a Yes/No
  pair — 98% of the disputed population (Omen/Presagio markets) has that shape; mapping
  OPTION_n through the protocol's own outcome order is its own semantics. Non-Yes/No
  templates (sports selects, uints, hash templates) are held out, logged: 213.
- Mechanical exclusions, all logged in `bench/real/ingest-log.json`: topic keywords
  (41) and titles under 3 words (117 — usernames, IPFS CIDs, hex addresses; CJK exempt).
  **1,120 admitted.**
- **Deterministic sample of 150** (`bench/select-real-sample.mjs`): all 10 arbitrated
  cases with researchable text + 25 INVALID/TOO-SOON cases (deliberate ~3× oversample of
  the 7.5% base rate, so abstention metrics have power) + 115 bonded-only cases ranked
  by dispute intensity, capped at 10 per question family. One rule revision happened
  before any solver ran and is documented in the file header.
- Two files, structurally separated: `claims.public.json` (solver-visible) and
  `truth.json` (ground truth; read only by `src/score-real.mjs`).

Population facts worth knowing:

- **Every admitted case is title-only.** The disputed population predates (or ignored)
  the v3.2 criteria field: not one carried written resolution criteria. Real oracle
  disputes happen on questions with *no* spec — "ambiguous criteria" in this population
  means "no criteria at all". Solvers were told exactly that.
- Genuine arbitration with researchable text is rare: 10 cases in the entire history of
  six deployments (most arbitrated volume is username/moderation junk filtered above).
- Dispute intensity: 120 two-answer, 27 three-plus-answer, 128 with ≥2 bond-ladder flips.

## 3. Leakage control and its audit

- Guard (`hooks/websearch-guard.mjs`) denies searches naming oracle/prediction venues,
  dispute machinery, or reproducing 8+ consecutive words of the question. Denied and
  allowed queries are all logged (`results/websearch-audit-real.jsonl`): **90 of 6,262
  queries denied** (1.4%); exactly one verbatim-title attempt.
- Solver prompt pins the historical cutoff and declares later evidence inadmissible.
- Residual risk that cannot be engineered away: solvers carry training-data knowledge of
  post-cutoff events. One case proves it (§6, Harris-2024: the baseline's reasoning
  cites the eventual winner despite the cutoff). This inflates *absolute* accuracy on
  YES/NO cases for **both** conditions symmetrically; the paired A-vs-C comparison — the
  question under test — is unaffected. Absolute numbers here are optimistic bounds, not
  deployment estimates.

## 4. Headline results (n = 150)

Scoring rule (fixed before results were seen): YES/NO ground truth — match = correct,
abstain tracked separately; INVALID/TOO-SOON ground truth — abstention is the correct
resolution, a forced answer is wrong.

| condition | accuracy | abstain | acc \| answered (Y/N gt) | inappropriate-answer (26 special) | $/claim | wall s |
|---|---|---|---|---|---|---|
| **A_opus** (baseline) | **69.3%** | 2.7% | **83.6%** | 92.3% | **$0.58** | 62 |
| A_sonnet (= member B1) | 68.7% | 10.7% | 80.3% | 65.4% | $0.32 | 46 |
| members B2–B5 | 60.7–68.7% | 9–13% | 74.6–80.5% | 65–77% | $0.31–0.35 | 46–77 |
| C_majority | 65.3% | 8.0% | 79.5% | 80.8% | $1.63 | 288 |
| C_conf | 65.3% | 7.3% | 78.8% | 80.8% | $1.63 | 288 |
| **C_judge** | **67.3%** | 7.3% | 81.4% | 80.8% | **$1.70** | 294 |
| escalation (A + judge on disagreement) | 68.0% | 2.7% | 82.0% | 92.3% | $1.29 | 155 |

Paired tests (McNemar exact): A_opus vs C_judge p = 0.51 (6 vs 3 discordant);
A_opus vs C_majority and vs escalation similarly null. With n = 150 and 9 discordant
pairs, an aggregation advantage larger than ~5 points would very likely have surfaced;
the observed direction is negative.

## 5. Disagreement, routing, and what the network is actually good at

- Members disagreed on 39/150 (26%); mean pairwise disagreement 12.9%.
- Everyone gets worse on disagreement cases: A_opus 73.9% → 56.4%, C_judge 73.0% → 51.3%.
  Disagreement is a true difficulty detector — it doubles the error concentration.
- **But it is not a unique detector**: the baseline's own 39 lowest-confidence claims
  carry an identical wrong-rate split (43.6% flagged / 24.3% unflagged). The two flag
  sets overlap only 20/39, so they see partially different difficulty; their union flags
  58 claims holding 23/44 of all baseline errors.
- Where the network is genuinely better: **knowing when not to answer.** Any-member-
  abstained flags 10/26 protocol-refused cases (38%) at an 11% false-positive rate;
  the strong single agent abstains on 2/26 (8%). The members' higher abstention rates
  (9–13% vs 2.7%) buy this at a modest recall cost on answerable claims.
- Dispute-intensity stratification (§10 of the brief): on 3+-distinct-answer cases
  (n = 27) the predicted pattern appears — A_opus falls to 48.1% while C_majority holds
  55.6% (judge 51.9%); majority wins 2 discordant claims to 0. Direction matches
  "aggregation degrades more slowly as real-world dispute intensity rises", but at
  n = 27 (p ≈ 0.5) it is a hypothesis for a follow-up, not a finding.

## 6. Failure anatomy (44 baseline errors, 43 judge errors, 41 shared)

Case studies in `results/failures-real.txt`; divergent cases in full via
`src/inspect-failures-real.mjs --which divergent`.

**Network right / single agent wrong (3):** all abstention cases. Exemplar: *"Will
Harris win the 2024 US Presidential Election?"* asked 2024-10-01, finalized INVALID.
The baseline answered NO, its reasoning explicitly citing the eventual outcome —
post-cutoff knowledge it was told not to use. All five members independently reasoned
"cutoff precedes the election → unresolvable" and the network abstained. Same pattern on
*"Kleros is bad."* (TOO SOON) and a no-referent measurement question (INVALID).

**Single agent right / network wrong (2):** both criteria-interpretation splits where
the judge sided with a loose majority. Exemplar: *"Will Russia reveal its secret war
drones project in China by October 1, 2024?"* — the fact (Reuters exposé, Sept 25) was
found by everyone; three members read "Russia reveal" loosely (YES), two strictly (NO =
the protocol's answer). The judge adopted the majority. A minority-with-better-criteria-
reading lost the vote — the exact failure the judge prompt warns about.

**Both wrong (41), classified:**
- 21 forced answers on INVALID/TOO-SOON ground truths — criteria-interpretation /
  invalidity-detection failures (the abstention problem again, shared by both).
- ~13 retrieval/temporal failures on YES/NO cases (announcement-by-date questions where
  the evidence existed but wasn't found or was mis-dated).
- ~7 cases where **the protocol's own final answer looks factually wrong** — unchallenged
  low-liquidity bonds. Starkest: *"Will GNO be above $1000 in 1 second from now?"*
  finalized YES twice while GNO traded near $100; every solver said NO with cited price
  data. Per the brief these score as wrong and are analyzed, not rescored. They put a
  hard ceiling (~95%) on measurable accuracy against oracle-recorded truth.

## 7. Economics

- Single baseline: $0.58/claim. Full 5-solver + judge: $1.70/claim (2.9×). Escalation:
  $1.29/claim. Judge itself: $10.73 total across 39 invocations.
- **Incremental cost per additional correctly-resolved claim: undefined — the aggregate
  resolved 3 fewer claims (101 vs 104) while spending $168 more.** The round-1 finding
  (6× cost, no accuracy gain) survives contact with genuinely disputed data at 2.9×.
- The defensible buy: a 5× spend converts a 2/26 invalidity detector into a 10/26 one,
  and supplies a difficulty flag (which self-confidence supplies free). If the flag is
  used to *decline/escalate to human arbitration* rather than to auto-answer, 26% of
  claims are routed away carrying ~2× error density.
- Production framing (per the brief's constraint): any on-chain coordination assumes a
  cheap L2, where per-claim transaction costs are cents — negligible against $0.32–1.70
  inference. Resolution-side unit economics are dominated by inference and by bond
  capital, not by gas. Nothing was deployed on-chain for this experiment.

## 8. Limitations

- **Historical-web replay is imperfect.** Training-data contamination inflates absolute
  YES/NO accuracy for both conditions; the paired comparison stands. A deployment-grade
  estimate needs prospective claims (resolve now, settle later).
- **Ground truth carries oracle noise** (~5% visibly questionable finals; §6). Also
  symmetric across conditions.
- The INVALID conventions of the dominant question source (AI-generated Presagio
  markets) are venue-specific: some INVALID-finalized questions were factually
  answerable. Abstention metrics measure agreement with *the venue's* refusal policy.
- Diversity in condition B came from model × prompt-posture; solvers shared a model
  family, so member errors correlate. A cross-vendor network might disagree more
  usefully. The abstention edge may partly reflect Sonnet/Haiku temperament rather than
  network architecture per se.
- 213 non-Yes/No disputed cases (sports selects, scalars) were held out; conclusions
  cover boolean-shaped claims only.
- n = 150; effects smaller than ~5 points are not resolvable at this sample.

## 9. What would change the verdict

1. A prospective (post-training-cutoff, pre-settlement) replication showing aggregation
   gains once hindsight is truly unavailable.
2. A larger sample of high-intensity disputes (the 3+-answer stratum trend, n = 27).
3. An aggregation mechanism designed around criteria interpretation (the judge's two
   losses were both interpretive, not evidential) — e.g. explicit strict-vs-loose
   reading adjudication.
4. Reframing the product around what the network measurably does better: invalidity
   detection and evidence-packet production for arbitration (Kleros-juror support), not
   answer generation.

## 10. Reproducing

```bash
# dataset (public RPC only, no keys)
node bench/fetch-reality-disputes.mjs scan   --deployment all
node bench/fetch-reality-disputes.mjs export --deployment all
node bench/ingest-disputes.mjs --in bench/raw/dispute-export.jsonl --out-dir bench/real
node bench/select-real-sample.mjs --target 150 --family-cap 10

# experiment
node src/run-experiment.mjs --claims bench/real-sample/claims.public.json --split all \
    --out results/attempts-real.jsonl --audit results/websearch-audit-real.jsonl
node src/aggregate.mjs --claims bench/real-sample/claims.public.json \
    --attempts results/attempts-real.jsonl --out results/aggregated-real.jsonl
node src/score-real.mjs --claims bench/real-sample/claims.public.json \
    --truth bench/real-sample/truth.json --attempts results/attempts-real.jsonl \
    --aggregated results/aggregated-real.jsonl --out results/metrics.real.json
node src/inspect-failures-real.mjs --which divergent
```
