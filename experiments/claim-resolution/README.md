# Claim resolution: does Jinn's multi-solver architecture beat one good agent?

A falsifiable, self-contained experiment. Everything lives under this directory
and nothing outside it imports from here — delete the directory to remove the
experiment.

## Status

This is a completed historical experiment, not a production subsystem. No
product integration or follow-up issue is created by this archival PR.

The principal claim was **not supported**. On the real disputed-oracle
benchmark the strong single solver scored **69.3%**. The best five-solver
aggregate scored **67.3% at 2.9 times the cost**.

The narrower surviving findings were better invalidity or abstention
detection, and disagreement as a difficulty signal. The experiment does
**not** justify the claim that a multi-solver network generally beats one
strong agent.

Keep the original reports and their limitations intact. Do not massage the
results. Do not make new model calls or rerun the 900 solver attempts.

## The question

Given a natural-language claim, explicit resolution criteria and public web
access, do several independent Jinn solvers plus a simple aggregation step
resolve externally-settled claims more accurately than one strong web-enabled
agent?

This is scoped to *investigation and answer generation*. It builds no oracle and
no cryptoeconomic mechanism; settlement is assumed to come from Reality.eth /
Kleros / UMA.

## Layout

```
bench/           dataset construction pipeline + the benchmark itself
  buckets.mjs           topic buckets handed to the curators
  curate.mjs            stage 1  — harvest candidate claims (unrestricted web)
  sanitize.mjs          stage 1b — strip settlement-venue references, drop
                                   trivial-lookup and answer-leaking items
  verify.mjs            stage 2  — independent ground-truth verification
  closed-book-probe.mjs stage 3  — contamination probe (no web access at all)
  build-dataset.mjs     stage 4  — admission rules, dedupe, dev/eval split
  ingest-disputes.mjs   round 2  — converts a real oracle-dispute export into the
                                   two-file benchmark. Model-free; no fallback that
                                   invents data. See DATA_REQUEST.md.
  fixtures/             parser test vectors only — never a benchmark
  claims.public.json    SOLVER-VISIBLE benchmark (claim, criteria, deadline)
  truth.json            GROUND TRUTH + provenance — never read on the solver path
  rejected.json         everything that failed admission, with reasons
src/
  strategies.mjs        system prompt + four research-posture variants
  conditions.mjs        conditions A / B definitions
  solver.mjs            one solver attempt = one `claude -p` + WebSearch
  run-experiment.mjs    runs A and B over the benchmark (resumable)
  aggregate.mjs         condition C: majority / confidence-weighted / judge
  score.mjs             the only place ground truth is read
  inspect-failures.mjs  dumps failures with full evidence for manual review
hooks/
  websearch-guard.mjs   PreToolUse leakage guard + query audit log
schema/                 JSON Schemas for every structured output
results/                attempts, aggregation, metrics, audit log
REPORT.md               findings — round 1 (synthetic benchmark, ceiling effect)
REPORT_REAL_DISPUTES.md findings — round 2 (real disputes; blocked on data access)
DATA_REQUEST.md         export request for genuine Reality.eth / Kleros / UMA records
```

## Reproducing

```bash
node bench/curate.mjs                                  # ~$22
node bench/sanitize.mjs                                # ~$3
node bench/verify.mjs   --in bench/sanitized.json      # ~$25
node bench/closed-book-probe.mjs                       # ~$3
node bench/build-dataset.mjs --target 100

# main benchmark
node src/run-experiment.mjs --split all --concurrency 10
node src/aggregate.mjs
node src/score.mjs --split eval
node src/score.mjs --split dev
node src/inspect-failures.mjs --split eval

# hard stratum (same code path, different dataset)
node bench/curate.mjs --buckets ./buckets-hard.mjs --out bench/candidates-hard.json
node bench/sanitize.mjs --in bench/candidates-hard.json --out bench/sanitized-hard.json
node bench/verify.mjs   --in bench/sanitized-hard.json --out bench/verified-hard.json
node bench/closed-book-probe.mjs --in bench/verified-hard.json --out bench/closed-book-hard.json
node bench/build-dataset.mjs --in bench/closed-book-hard.json --target 48 --dev 0 \
                             --out-dir bench/hard
node src/run-experiment.mjs --claims bench/hard/claims.public.json --split all \
                            --out results/attempts-hard.jsonl \
                            --audit results/websearch-audit-hard.jsonl
node src/aggregate.mjs --claims bench/hard/claims.public.json \
                       --attempts results/attempts-hard.jsonl \
                       --out results/aggregated-hard.jsonl
node src/score.mjs --split all --claims bench/hard/claims.public.json \
                   --truth bench/hard/truth.json \
                   --attempts results/attempts-hard.jsonl \
                   --aggregated results/aggregated-hard.jsonl \
                   --out results/metrics.hard.json
```

Every stage is resumable and every stage writes its own artifact, so a killed
run restarts from the last completed file.

## Findings

See [`REPORT.md`](REPORT.md). Short version: on 145 externally-resolved claims a single
web-enabled agent scored 145/145 and five-solver aggregation also scored 145/145 at 6x
the cost, with solvers disagreeing on 1.4% of claims. Verdict: **NOT SUPPORTED** — no
demonstrated edge for the multi-solver architecture on claims that competent web search
can settle. The report is explicit about which population that conclusion does and does
not cover.

## Relationship to the operator codebase

The solver execution shape is the one Jinn's Claude harnesses already use
(`operator/src/runner/claude.ts`, `operator/src/harnesses/impls/learner/`):
spawn the Claude CLI headless against a task, get a structured payload back.
The solver output schema mirrors the `prediction.v1` payload convention
(answer + confidence + methodology + source refs).

What this experiment deliberately does **not** run: the daemon, the chain, the
Mech Marketplace, IPFS, the evaluator harnesses, or verdict persistence. Those
carry the settlement and incentive layer, and none of them affect whether N
independent solvers resolve a claim better than one. Running them would have
cost days and changed no number in the report. The consequence is stated as a
limitation: this measures Jinn's *solver layer* hypothesis, not a deployed Jinn
network.


## Round 2 — real disputed oracle cases

Round 1 (`REPORT.md`) ceilinged: a single Opus agent resolved 145/145, so the benchmark
could not distinguish one agent from a network. The cause was structural — an agent
established ground truth, so only claims an agent could resolve entered the set.

Round 2 targets cases where real counterparties bonded money against each other, with
ground truth taken exclusively from the protocol's own resolution. The cloud attempt was
blocked at data acquisition by that environment's egress policy
(`REPORT_REAL_DISPUTES.md`, `DATA_REQUEST.md`); a local environment with RPC access then
reconstructed the dataset directly from Reality.eth chain state and ran the experiment.

**Results: [`REPORT_REAL_DISPUTES_RESULTS.md`](REPORT_REAL_DISPUTES_RESULTS.md).**
Verdict: **NOT SUPPORTED** — on 150 genuinely disputed protocol-resolved claims,
five-solver aggregation scored 67.3% vs the single Opus baseline's 69.3% at 2.9× cost
(paired p = 0.51, no ceiling effect). The network's measurable edges are invalidity
detection (abstaining where the protocol itself refused) and a difficulty flag that the
baseline's own confidence largely replicates.

Round-2 pipeline: `bench/fetch-reality-disputes.mjs` (chain scan + export, public RPC
only) → `bench/ingest-disputes.mjs` → `bench/select-real-sample.mjs` → the same
run/aggregate harness → `src/score-real.mjs` / `src/inspect-failures-real.mjs`.
