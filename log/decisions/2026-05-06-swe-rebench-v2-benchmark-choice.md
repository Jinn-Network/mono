---
id: DR-2026-05-06-b
title: Benchmark choice — SWE-rebench v2 for v1
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
supersedes: earlier same-day draft selecting SWE-bench Live (Microsoft) before deeper research showed its monthly Python cadence had paused at 2025-06
---

## Context

DR-2026-05-06-a commits the SolverNet to per-task continuous shape with Improve-loop compounding. This requires a benchmark with **structurally fresh task supply** — finite-pool benchmarks recycle Tasks and the producer-consumer overlap mechanism converges to memorisation.

Initial design exercise selected SWE-bench Live (Microsoft, NeurIPS 2025 D&B). Captain pushed for verification of cadence before committing. Verification found:

- `SWE-bench-Live/SWE-bench-Live` (Python-only) HuggingFace dataset's monthly partitions stop at `202506` (June 2025) — 11 months stale as of 2026-05.
- The team pivoted to `SWE-bench-Live/MultiLang` and `SWE-bench-Live/Windows`, both fixed snapshots (partitioned by language, not by month).
- The README still claims "Each month, we will add 50 newly verified, high-quality issues" but the data files contradict this.
- Issue triage abandoned: open issues from June 2025 unanswered as of May 2026.

Re-evaluating fresh-supply alternatives surfaced **SWE-rebench v2** as the right candidate. Multiple datasets exist under the SWE-rebench namespace; the actively-maintained one is `nebius/SWE-rebench-leaderboard`.

## Decision

**Select SWE-rebench v2 — specifically the `nebius/SWE-rebench-leaderboard` HuggingFace dataset under v2 methodology — as the v1 benchmark.**

Concretely:
- **Dataset:** `huggingface.co/datasets/nebius/SWE-rebench-leaderboard` (CC-BY-4.0; last commit 2026-04-22; monthly partitions through `2026_02`; ~750 instances across 14 months at v1 launch; ~50 added monthly).
- **Methodology:** v2 (paper arxiv:2602.23866, February 2026). No demonstrations, 128k context window cap (replaces strict 80-step limit from v1), auxiliary `interface` fields per task.
- **Eval harness:** `github.com/SWE-rebench/SWE-rebench-V2` (MIT). Production-quality `scripts/eval.py` reads dataset rows, pulls Docker images, applies patches, runs tests, parses logs via named log_parsers, returns structured results.
- **Docker namespace:** `docker.io/swerebenchv2/<repo>:<commit-suffix>` — verified to have **3,632 actively-maintained image repos** (last update 2026-04-22). Each dataset row carries the full `image_name` reference; no name-mangling on our side.
- **Languages:** C, C++, C#, Go, Java, JavaScript, Rust, TypeScript, Dart (multi-language by design from v2 onward).
- **Schema:** SWE-bench-compatible + v2 additions (`interface`, `language`, `install_config` with full Docker setup, `image_name`, `meta` with task complexity).

## Rationale

- **Continuously fresh supply, verified.** 14 monthly partitions through 2026_02; last data commit 2026-04-22; 2-3 month curation lag from real time. The cadence we need is being kept.
- **Better v2 methodology fit.** Modern frontier models don't need demonstrations; 128k context handles large-context tasks; auxiliary interfaces bound task ambiguity without giving away solutions. Aligns with where coding-agent harnesses are in 2026.
- **Self-describing eval surface.** Each row carries `image_name`, `install_config`, `FAIL_TO_PASS`, `PASS_TO_PASS`. Our `@jinn-network/swe-rebench-v2-evaluator` is a thin wrapper around upstream `scripts/eval.py`. Minimal custom evaluator code.
- **Permissive licensing.** CC-BY-4.0 dataset + MIT harness. No restrictive use clauses. Per-instance license disclosure (each row carries the underlying repo's license at the commit) lets consumers filter on license-compatibility per task.
- **Active community signal.** Parent dataset `nebius/SWE-rebench` has 102k+ downloads (vs SWE-bench Live's 5k); brand has wider adoption in the ML training community. The active `nebius/SWE-rebench-leaderboard` has 4.5k downloads and is the live-leaderboard backing dataset.
- **Headroom for measurement.** Frontier scores Claude Opus 4.6 = 65.3% resolved, GPT-5.2-medium = 64.4% on the active leaderboard window. 30+ points of headroom; harness improvements have visible signal.
- **Verified end-to-end integration.** A real instance (`unidata__netcdf-c-1925`) was pulled from the dataset, its Docker image confirmed to exist on Docker Hub (~897MB linux/amd64), the eval harness's `scripts/eval.py` reviewed for production quality. Integration risk low.

## Alternatives considered and rejected

- **SWE-bench Live (Microsoft, NeurIPS 2025 D&B).** Originally the v1 candidate. Rejected after verification showed monthly Python cadence stopped at 2025-06; team pivoted to fixed-snapshot multi-language datasets. Microsoft + NeurIPS branding is real but does not compensate for the substrate's load-bearing fresh-supply requirement breaking. Could be revisited as a fixed-snapshot v1.5 companion. Worth contacting maintainers (`SWE-bench-Live@microsoft.com`) to confirm whether the Python pipeline is paused or permanently ended.
- **GDPval (OpenAI).** THESIS-aligned (44 occupations, knowledge work) but 220-task gold subset is finite; continuous-stream over it produces memorisation vector; round-only operation is a tokenised leaderboard, not substrate. Filed as future workstream pending fresh-task-supply infrastructure.
- **apex-agents (Mercor).** Recruitment-cluster ideal but explicit "no training, no scraping, no programmatic download" clauses in the dataset card make it incompatible with substrate redistribution + Improve-loop mechanics. Filed as future workstream pending Mercor partnership.
- **SWE-bench Verified.** Saturated (70%+ frontier scores → no harness-improvement signal). Rejected.
- **SWE-bench Pro (Scale AI).** 731 public tasks; deterministic Docker grading; CC-BY-4.0 + MIT. Strong candidate but finite-pool — same memorisation vector as GDPval. Filed as v2 cross-validation companion if desired.
- **LiveBench (LeCun et al).** Multi-domain, fresh supply. Rejected: scores already saturating in the 80s for frontier models; harness improvements have insufficient signal. Tests model capability more than agent harness capability — wrong axis.
- **LiveCodeBench (Berkeley/MIT/Cornell).** Coding contests with date-stamped problems; cleanest contamination protection. HF dataset stale since 2025-06; no programmatic monthly HF feed. Filed as v1.5+ companion if direct contest-stream integration is built.
- **SWE-rebench v1 (the original `nebius/SWE-rebench` paper dataset).** Last data update 2025-12-23; superseded by v2 methodology in February 2026. v1's strict 80-step limit and demonstration-prompts are obsolete for current frontier models. We adopt v2.

## Consequences

- **Coding-agent cluster is the v1 recruitment surface.** SWE-rebench v2 recruits coding-agent builders; broader knowledge-work cluster (GDPval / apex) defers to future SolverNets. `prediction.v1` continues to recruit forecasters in parallel.
- **Reference-don't-redistribute as a SolverNet design principle.** Task payloads on JinnRouter carry `(hf_dataset, hf_split, instance_id)` references; operators fetch full task rows from HuggingFace at solve time. Pattern generalises to all future benchmark SolverNets.
- **Multi-language scope from day 1.** v2's language-agnostic design gives the aggregation function a real `byLanguage` breakdown; harnesses that specialise (Python-strong vs JS-strong vs Go-strong) emerge as a leaderboard axis from launch.
- **Evaluator integration is light.** `@jinn-network/swe-rebench-v2-evaluator` wraps the upstream `scripts/eval.py`. ~3-5 days engineering vs the ~10-15 days I'd estimated for a from-scratch SWE-bench-Live evaluator. Engineering scope improves with the pivot.
- **One BD ping outstanding.** Email Nebius / SWE-rebench team to confirm monthly cadence intent and offer downstream-consumer coordination. Less load-bearing than for SWE-bench Live (data already proves cadence is being kept) but worth doing.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06 after Captain-driven verification round that surfaced the SWE-bench Live cadence break and led to the pivot.
