# DR-2026-08-18 — Official suite protocol (APEX-Agents)

- **Date:** 2026-08-18
- **Status:** **Accepted 2026-08-18.** Ratified by operator instruction to
  implement the APEX-Agents official-suite train (issue
  [#2770](https://github.com/Jinn-Network/mono/issues/2770)).
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
- **Extends** [DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md)
  (named official suite protocol) with the third locked suite. Does not rewrite
  Terminal-Bench 2.1 or SWE-bench Verified. Inspect-as-specified remains
  [#2745](https://github.com/Jinn-Network/mono/issues/2745).
- **Does not amend:** `GROWTH.md`.

## Context

Colophon already wraps Terminal-Bench 2.1 (Harbor, k=5, ATIF, Hub) and
SWE-bench Verified (swebench.harness, k=1, predictions export). Wearing the
APEX-Agents name on a cousin method is the same overclaim those trains
refused: legitimacy for an official suite is that **their** method ran.

Official APEX-Agents as specified (dataset `mercor/apex-agents` at the
HuggingFace revision pin, 480 tasks / 33 worlds, identity `task_id`, Pass@1
with k=1, Archipelago Docker MCP world + ReAct `react_toolbelt_agent` +
snapshot grader) is the third named official protocol Colophon will lock.
AA Stirrup (452 tasks, drop worlds 244 & 246, k=3), Claude Code / Codex as
the agent, Harbor, Inspect, SWE-bench Verified / swe-rebench, k=8, and the
HF demo `max_steps=50` stay and cannot claim `apex-agents` or
`leaderboardSubmitReady`.

There is no Mercor submit CLI. Inspection export is a derived artifact of a
Colophon-accounted run. The checkable claim of record remains the
Colophon/Jinn bundle. Copy must say Colophon does not place the Mercor row.

## Decisions

1. **Named protocol is APEX-Agents**, not APEX-SWE, not AA Stirrup, and not
   a Harbor or Inspect overlay on APEX tasks. Dataset id `mercor/apex-agents`
   (480 tasks, 33 worlds, 160 per job). Identity is `task_id`, not index
   0–479. Revision is the HuggingFace dataset git SHA re-read and sealed at
   implementation (`92c86856cf1b11f9833a8a076b3a45a63afa3929`). Cousin
   methods cannot claim `apex-agents`.

2. **Official trial settings.** Planned k = 1 per selected task (one cell /
   one TEP Submission with `attempts.maxTotal = 1`). Pass@1 = all binary
   rubric criteria Met. Mercor’s 8-run mean Pass@1 / Pass@8 are cousins.
   Engine: Archipelago owns the cell — Docker MCP world + ReAct
   `react_toolbelt_agent` + snapshot grader. Adapter id `archipelago`.
   Archipelago commit pin `0cb5c476c219a9df637e0bd37fb86b2361f4ab89` (no
   GitHub tags). `maxSteps: 250`, `timeoutSeconds: 10800` (paper/registry;
   HF example 50/3600 is demo-only). Judge `gemini-3-flash`, thinking `low`,
   web search off. No timeout or resource overrides. A missing
   `output/<task_id>/grades.json` is unscorable, not a silent skip. Pass iff
   `passed === true` or `final_score === 1`.

3. **Comparability is two-axis**, same product bits as TB 2.1 and Verified,
   protocol-specific sentences. Report v2 gains no new required fields. Bind
   a product-sealed `SuiteProtocolSelection` with `protocol: "apex-agents"`.
   Surface:
   - `execution_conformance` — pin, Archipelago commit, ReAct agent, k=1,
     250 steps, 10800s, judge settings, Archipelago evaluator (not Harbor,
     Inspect, or swe-rebench);
   - `coverage` — `one_task` | `ten_task` | `full` | `custom`;
   - `leaderboard_submit_ready` — `full` and `execution_conformance` and
     every dataset task × 1 accounted after collect as judged or
     unscorable, and an Archipelago `grades.json` present per `task_id`.
     Quote/lock method bits never set this true.
   Named slice membership is the lexicographic first 1 / first 10 / all
   `task_id`s from the pinned snapshot, sealed at select. Custom picks are
   legal and cannot be `full` or `leaderboard_submit_ready`.
   When not `leaderboard_submit_ready`, Report `limitations[]` carries a
   canonical sentence that names **APEX-Agents**, not Terminal-Bench or
   SWE-bench.

4. **Archipelago owns the cell.** Colophon does not solve then hand off to
   a foreign grader. No Harbor Job. No Inspect batch. Do not call
   swe-rebench parsers for an APEX-locked run. Archipelago `grading_run_id`
   is derived from the Colophon run digest so a new attempt cannot reuse a
   cached grade.

5. **Inspection export is a derived artifact, not the claim of record.**
   From a `leaderboard_submit_ready` run, emit trajectories, snapshots, and
   grades plus inspection instructions. Named-slice protocol-faithful runs
   may copy the grade tree for inspection and must not be packaged as a
   leaderboard submission. Custom / non-conforming / cousin (Stirrup, Code,
   Harbor, Inspect, k=8) runs refuse the APEX-Agents suite name. Copy must
   say Colophon does not place the Mercor APEX-Agents row. There is no
   Mercor submit CLI.

6. **Quote before full-suite lock.** Quote shows `tasks × arms × 1`,
   Archipelago commit, pin, and the three comparability bits. A full-suite
   lock without that quote is refused. CI / `yarn test` never downloads the
   APEX-Agents dataset or world images.

7. **Out of this train.** AA Stirrup; Claude Code / Codex as the agent;
   Harbor; Inspect-as-specified (#2745); APEX-SWE; Terminal-Bench 3.0;
   DeepSWE; a live 480-task run; placing a Mercor row; CI dataset download;
   rewriting TB 2.1 or Verified paths.

## Consequences

- `SuiteProtocolSelection` is a discriminated union. TB 2.1 stays
  `protocol: "terminal-bench-2.1"` with k=5 and ATIF. Verified is
  `protocol: "swe-bench-verified"` with k=1 and no ATIF. APEX-Agents is
  `protocol: "apex-agents"` with k=1, no ATIF, and Archipelago grades.
- GTM may describe APEX-Agents as a named protocol Colophon wraps.
- A cousin method on APEX tasks still cannot wear the suite name.

## Alternatives rejected

- **Colophon solve + their grader.** Official APEX-Agents is Archipelago
  end-to-end. Their method includes the ReAct agent and snapshot grader.
- **Copy TB 2.1 k=5 / ATIF / Harbor / Hub.** Their method is Pass@1 k=1
  and Archipelago.
- **Wear the name on Stirrup or k=8.** Those are cousins.
- **New required Report v2 fields.** Comparability is product-private plus
  existing `limitations[]`.
- **CI downloads the 480-task dataset or world images.** Operator qualify
  is fail-closed and one lexicographic task.

## Ratification

Ratified on 2026-08-18 by the operator’s instruction to implement the
attached APEX-Agents official-suite train. Changing who owns the campaign,
synthesizing TEP from a foreign harness job, or wearing the suite name on a
cousin method requires a superseding record.
