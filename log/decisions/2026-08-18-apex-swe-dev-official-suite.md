# DR-2026-08-18 — Official suite protocol (APEX-SWE-dev)

- **Date:** 2026-08-18
- **Status:** **Accepted 2026-08-18.** Ratified by operator instruction to
  implement the APEX-SWE-dev official-suite train.
- **Owning docs:** the publication interoperability profile; Colophon
  self-serve; the benchmark-product GTM plan (copy); product-design pointer
  addendum.
- **Amends (at ratification):**
  [`docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
  (§8.3 third named protocol);
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §8.3;
  [`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md)
  (pointer addendum only).
- **Sibling of** [DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md)
  (Terminal-Bench 2.1) and the SWE-bench Verified follow-on named there.
  Does not rewrite Terminal-Bench 2.1. Inspect-as-specified remains
  [#2745](https://github.com/Jinn-Network/mono/issues/2745). APEX-Agents
  (Archipelago) is out of scope.
- **Does not amend:** `GROWTH.md`.

## Context

Mercor’s **APEX-SWE** leaderboard is n=200 (100 integration + 100
observability), Pass@1, held out. The public artifact is **n=50** (25+25) at
HuggingFace [`mercor/APEX-SWE`](https://huggingface.co/datasets/mercor/APEX-SWE)
(CC-BY-4.0) plus harness
[`Mercor-Intelligence/apex-swe`](https://github.com/Mercor-Intelligence/apex-swe).

Wearing `APEX-SWE` or `leaderboardSubmitReady` on the public 50 is the same
overclaim DR-2026-08-17-b refused for Terminal-Bench 2.0-as-2.1: legitimacy
for an official suite is that **their** method ran, on **their** held-out
set. Colophon locks the public 50 as **APEX-SWE-dev**.

## Decisions

1. **Named protocol is `apex-swe-dev`**, not `apex-swe`. Dataset id
   `mercor/APEX-SWE`, 50 tasks. Revision is the HuggingFace dataset git SHA
   re-read and sealed at implementation
   (`4d7aeb2b829ca348c224992da803bca6502235f4`, 2026-04-22).
   `datasetTaskCount: 50`. The 200-task leaderboard name cannot be worn.

2. **Wrap both Mercor harnesses end-to-end** (Harbor pattern), not
   Colophon-solve + foreign grade (Verified pattern). Integration agent loop
   is `apx` (tmux terminal, files, MCP). Observability agent is **their**
   Inspect AI tree (`observability/agent/` + `run_e2e.py`), then
   `unified_scorer()`. Injecting Claude Code / Codex / Colophon
   `inspect-ai==0.3.255` into those worlds is a cousin.

3. **Official trial settings.** k = 1 (Pass@1 = first attempt). Integration
   CLI default `--n-trials 3` is **not** the protocol; force `--n-trials 1`.
   Observability `--trials 1`. Pass@3 is paper-only. Paper wall-clock
   **3600s**. Observability default `--time-limit 3600` matches. Integration
   CLI default **900** does not — official lock uses `--timeout 3600`. No
   resource overrides. Observability `--message-limit 250` (their default).
   Inner observability `--max-retries 2` stays their infra default (Docker
   flake salvage), not a second scientific replicate — disclose like TB 2.1
   retry vs k.

4. **Score is tests only.** Integration: pytest vs live service APIs.
   Observability: all F2P pass and all P2P stay pass (`passed` in their JSON).
   Rubrics / Gemini LM-judge are **not** the cell score
   ([arxiv 2601.08806](https://ar5iv.labs.arxiv.org/html/2601.08806) §3.2–3.3).
   Missing JSON is unscorable, not skip. Each task maps onto one cell
   (`attempts.maxTotal = 1`).

5. **Comparability is two-axis**, same product bits as TB 2.1, protocol-
   specific sentences. Report v2 gains no new required fields. Bind a
   product-sealed `SuiteProtocolSelection` with `protocol: "apex-swe-dev"`,
   `replicates: 1`, `atifRequired: false`. Each suite item also carries
   `taskType: "integration" | "observability"`. Surface:
   - `execution_conformance` — pin, dual Mercor wrap, k=1, n-trials 1,
     timeout 3600, no timeout/resource override, adapter `apex-swe-dev`;
   - `coverage` — `one_task` | `ten_task` | `full` | `custom`;
   - `leaderboard_submit_ready` — **always false**, even `coverage: "full"`
     (50/50 of the public set) with every cell accounted. There is no public
     submit path onto the 200-task Mercor board.
   Named slice membership is the lexicographic first 1 / first 10 / all
   `taskId`s across **both** types from the pinned snapshot, sealed at
   select. Custom picks are legal and cannot be `full`. When not
   `leaderboard_submit_ready` (always), Report `limitations[]` carries a
   canonical sentence that names **APEX-SWE-dev** and the **200-task
   APEX-SWE leaderboard**, not Terminal-Bench or SWE-bench Verified.
   Wilson@1 over judged cells. Refuse `binary-instrument` majority-k.

6. **Harness pin.** Dual wrap of `apex-swe` at git SHA
   `7cfa580dd59704ff15cf558bda80257c23b6cb04` (2026-04-09), re-read at
   implement. Dataset commit is newer than harness; layout must still match
   before sealing. Registry snapshot is **task ids + types only** (no 2.08 GB
   blob in CI). Official pin requires exactly 25 integration + 25
   observability.

7. **Export.** `inspection-upload` for named slices with
   `executionConformance`. Refuse custom / non-conforming. **Never**
   `leaderboard-submit`. Copy Mercor JSON + agent patches/logs. Instructions:
   inspect locally; do not claim a Mercor leaderboard row.

8. **Cousins that cannot wear the name:**
   - Colophon Inspect-as-specified (#2745) / `runtime inspect select` / PATH
     `inspect-ai==0.3.255` as the observability runtime;
   - `import swebench` + swe-rebench, or `swe-bench-verified`, on the
     observability F2P slice;
   - Harbor / `terminal-bench-2.1`;
   - `--n-trials` / `--trials` greater than 1 (Pass@3);
   - protocol id `apex-swe` without `-dev`;
   - rubric LM-judge as the resolved bit;
   - custom slice as `full`.

9. **Qualify is `one_task` only.** Fail-closed operator script gated on
   `COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY=1`. Default CI never downloads
   HuggingFace/LFS and never spins compose stacks. Git LFS pointers fail
   closed if select is pointed at un-materialized files.

## Out of scope

- Full 200 / Mercor holdout / claiming APEX-SWE
- `ten_task` / full-50 live runs
- APEX-Agents (Archipelago)
- Rubric secondary analyses
- Changing Colophon’s Inspect 0.3.255 pin
- Rewriting Terminal-Bench 2.1 or SWE-bench Verified
