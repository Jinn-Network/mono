# DR-2026-08-17-e — Official suite protocol (SWE-bench Verified)

- **Date:** 2026-08-17
- **Status:** **Accepted 2026-08-17.** Ratified by operator instruction to
  implement the SWE-bench Verified official-suite train (issue
  [#2744](https://github.com/Jinn-Network/mono/issues/2744)).
- **Owning docs:** the publication interoperability profile; Colophon
  self-serve; the benchmark-product GTM plan (copy); product-design pointer
  addendum.
- **Amends (at ratification):**
  [`docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
  (§8.3 second named protocol);
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §8.3;
  [`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md)
  (pointer addendum only).
- **Closes the follow-on named in** [DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md)
  decision 9 (official SWE-bench Verified). Does not rewrite Terminal-Bench
  2.1. Inspect-as-specified remains [#2745](https://github.com/Jinn-Network/mono/issues/2745).
- **Does not amend:** `GROWTH.md`.

## Context

Colophon already imports SWE-bench-shaped rows and grades them with the Jinn
OCI swe-rebench grader. Wearing the SWE-bench Verified name on that cousin
method is the same overclaim DR-2026-08-17-b refused for Terminal-Bench 2.1:
legitimacy for an official suite is that **their** method ran.

Official SWE-bench Verified as specified (dataset
`princeton-nlp/SWE-bench_Verified` at the HuggingFace revision pin, one
prediction per instance, grade with `python -m swebench.harness.run_evaluation`,
metric % resolved) is the second named official protocol Colophon will lock.
Terminal-Bench 2.1 stays a separate campaign type (Harbor, k=5, ATIF, Hub).
The existing `colophon import swebench` + swe-rebench path stays and cannot
claim `swe-bench-verified` or `leaderboardSubmitReady`.

Predictions JSONL / `sb submit` is a derived export of a Colophon-accounted
run so the publisher can feed swebench.com. The checkable claim of record
remains the Colophon/Jinn bundle.

## Decisions

1. **Named protocol is SWE-bench Verified**, not Lite / Full / Multimodal,
   not SWE-rebench, and not the mini-SWE-agent LM track. Dataset id
   `princeton-nlp/SWE-bench_Verified` (500 instances). Revision is the
   HuggingFace dataset git SHA re-read and sealed at implementation
   (`c104f840cc67f8b6eec6f759ebc8b2693d585d4a`). The cousin swe-rebench
   intake stays and cannot claim `swe-bench-verified`.

2. **Official trial settings.** Planned k = 1 per selected instance (one
   prediction / one cell / one TEP Submission with `attempts.maxTotal = 1`).
   Default harness timeout 1800s; no timeout or resource overrides. Evaluator
   is `swebench.harness.run_evaluation` (`swebench` 4.1.x), not the Jinn
   swe-rebench OCI grader and not Inspect. Empty or wrong patches are not
   resolved. A missing `report.json` is unscorable, not a silent skip.

3. **Comparability is two-axis**, same product bits as TB 2.1, protocol-
   specific sentences. Report v2 gains no new required fields. Bind a
   product-sealed `SuiteProtocolSelection` with `protocol: "swe-bench-verified"`.
   Surface:
   - `execution_conformance` — pin, harness version, k=1, default timeout,
     harness evaluator (not swe-rebench);
   - `coverage` — `one_task` | `ten_task` | `full` | `custom`;
   - `leaderboard_submit_ready` — `full` and `execution_conformance` and
     every dataset instance × 1 accounted after collect as judged or
     unscorable, and a harness `report.json` present per instance.
     Quote/lock method bits never set this true.
   Named slice membership is the lexicographic first 1 / first 10 / all
   `instance_id`s from the pinned snapshot, sealed at select. Custom picks
   are legal and cannot be `full` or `leaderboard_submit_ready`.
   When not `leaderboard_submit_ready`, Report `limitations[]` carries a
   canonical sentence that names **SWE-bench Verified**, not Terminal-Bench.

4. **Solve vs grade.** Colophon solve arms (Claude Code / Codex / sample
   repository-work) emit a unified diff as `model_patch`. Their harness
   grades. No Harbor Job. No Inspect batch. Do not call swe-rebench parsers
   for a Verified-locked run. Harness `run_id` is derived from the Colophon
   run digest (and the predictions bytes) so a new patch cannot reuse a
   cached `(run_id, instance_id)`.

5. **Predictions export is a derived artifact, not the claim of record.**
   From a `leaderboard_submit_ready` run, emit `predictions.jsonl` plus
   `sb submit` / `run_evaluation` instructions. Named-slice protocol-faithful
   runs may copy JSONL and the harness report tree for inspection and must
   not be packaged as a leaderboard submission. Custom / non-conforming /
   cousin swe-rebench runs refuse the Verified suite name. Copy must say
   Colophon does not place the swebench.com row.

6. **Quote before full-suite lock.** Quote shows `instances × arms × 1`,
   harness version, pin, and the three comparability bits. A full-suite lock
   without that quote is refused. CI / `yarn test` never downloads the
   Verified dataset or images.

7. **Out of this train.** mini-SWE-agent LM track; SWE-bench Lite / Full /
   Multimodal as this protocol; Inspect-as-specified (#2745); replacing or
   deleting `import swebench` / swe-rebench; a live 500-task run; `sb submit`
   placement; Modal; CI dataset/images.

## Consequences

- `SuiteProtocolSelection` is a discriminated union. TB 2.1 stays
  `protocol: "terminal-bench-2.1"` with k=5 and ATIF. Verified is
  `protocol: "swe-bench-verified"` with k=1 and no ATIF.
- GTM may describe SWE-bench Verified as a named protocol Colophon wraps.
  SWE import copy stays the cousin path.
- A cousin method on Verified instances still cannot wear the suite name.

## Alternatives rejected

- **Rename swe-rebench to Verified.** Official Verified harness is a third
  grader (DR-2026-07-06 already refused Inspect’s vanilla SWE-bench scorer).
- **Copy TB 2.1 k=5 / ATIF / Harbor / Hub.** Their method is one prediction
  and `swebench.harness`.
- **New required Report v2 fields.** Comparability is product-private plus
  existing `limitations[]`.
- **CI downloads the 500-row dataset or Verified images.** Operator qualify
  is fail-closed and one lexicographic instance.

## Ratification

Ratified on 2026-08-17 by the operator’s instruction to implement the
attached SWE-bench Verified official-suite train. Changing who owns the
campaign, synthesizing TEP from a foreign harness job, or wearing the suite
name on a cousin swe-rebench method requires a superseding record.
