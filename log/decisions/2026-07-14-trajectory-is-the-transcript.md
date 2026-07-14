---
id: DR-2026-07-14
title: The trajectory is the transcript — `jinn.trajectory.v1` becomes the one record of the run (conversational + operational spans); resolving the #1473 span-kind fork
date: 2026-07-14
verb: Decide
status: accepted (revised same-day; see Revision note)
authors: Claude Fable 5 (drafted, Stage 1 planning session), Ritsu (steer + decision)
spec: docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md (§6)
amends: none — closes the design fork recorded in issue #1473
relates-to: "#1473 (the implementation issue this unblocks); #1472 (snapshot-extraction workaround, retained for historical envelopes); #1537 (interactive-lane capture tee); #1658 (EpisodeV1 — shared span vocabulary); spec/2026-07-06-distillation-v1.md §3; PR #1653 (Stage 1 designs); PR #1667 (this DR's initial version)"
---

> **Revision note (same day).** PR #1667 landed this DR deciding a separate
> `agent-transcript.v1` artifact (option c below). Within the hour — before any consumer,
> schema, or implementation existed against it — the decision was revisited with the operator
> and reversed to full unification (option a+). This file, renamed from
> `2026-07-14-agent-transcript-artifact.md`, is the single authoritative record; the artifact
> route is preserved under Rejected. No amendment DR is warranted for a same-session reversal
> with zero downstream consumers.

## Context

A marketplace solve's `jinn.execution.v1` envelope has a typed `trajectory` slot, but the
`jinn.trajectory.v1` blob it references carries only packaging bookkeeping — 2
`jinn.artifact.emit` spans (surveyed live 2026-07-08 across claude-code, codex, hermes;
`client/packages/harness-layer/docs/solution-envelope-anatomy.md`). The agent's actual
reasoning exists on disk during the solve (`.claude-code/stdout.jsonl`,
`.codex-code/stdout.jsonl`) and survives only inside the generic `system_snapshot` tarball.
Consumers already prove the demand: the distillation bridge extracts transcripts from
snapshots as a workaround (#1472).

The root defect is conceptual, not just plumbing. In AI usage, a **trajectory** *is* the
episode record — the sequence of agent turns, tool calls, and observations (the RL sense, and
how the SWE-agent/distillation literature uses the word). `jinn.trajectory.v1` was instead
implemented as observability-style operational telemetry (phases, artifact emissions,
subprocess events) — a distributed-systems trace wearing the AI term's name. The field named
for the episode record never contained one.

Issue #1473 names the fork and requires a DR before implementation:

- **(a)** Additive span-kind enum extension + span-profile + conformance updates — makes the
  `trajectory` field truthful; costs spec-level surgery, per-solve scrub latency (60+
  free-text spans through the add-time + emit-time pipelines), and temporary content
  duplication with the snapshot.
- **(b)** Map transcript events onto existing kinds with synthesized attributes — dishonest
  (a Bash tool call is not `jinn.mcp_call`; `jinn.llm_call` requires token counts).
- **(c)** Emit the parsed transcript as a separate first-class artifact with its own CID —
  lighter, but leaves the `trajectory` slot permanently misleading and gives consumers two
  places to look.

## Decision

**One record. `jinn.trajectory.v1` is the single, signed, hash-chained account of the run:
the span-kind enum is extended with conversational kinds, so the agent's turns and tool calls
are first-class spans alongside the existing operational kinds. The envelope's `trajectory`
slot becomes truthful. There is no separate transcript artifact type.**

Concretely:

1. `JinnSpanKindSchema` (`client/src/trajectory/span-profile.ts`) gains conversational kinds
   (working names: `jinn.agent_turn` with `role: user|assistant`, and `jinn.tool_call`; final
   names and per-kind required attributes are defined and reviewed in #1473's implementation
   PR). The conformance check (`client/src/conformance/checks/trajectory-profile.ts`) is
   updated in the same PR. The extension is additive — existing v1 blobs remain valid.
2. At the engine `pack()` seam, the solve transcript is parsed into the run's
   `TrajectoryCollector`; transcript-derived spans pass the same add-time + emit-time scrub
   as every other span.
3. Token counts ride conversational spans **when the source stream provides them**
   (claude-code stream-json does) as optional-but-recorded attributes — never synthesized.
4. A missing or unparseable transcript degrades, never fails: the solve still publishes with
   operational spans only.
5. #1472's snapshot extraction remains the read path for historical envelopes; new solves
   stop needing it.
6. **Lane alignment:** the interactive-lane episode (`EpisodeV1` in `@jinn-network/plugin`,
   #1658) uses the same span-kind vocabulary for its steps, so the local episode and the
   marketplace trajectory speak one language (the capture lane already stores span-shaped
   steps).

## Raw and typed — the two roles

Normalization is lossy and parsers can be wrong, so the raw bytes are not disposable:

- **Raw transcript bytes are retained, deliberately** — content-addressed and format-tagged,
  where they already live today (inside `system_snapshot`). The earlier idea of stripping
  stdout streams from the snapshot as "de-duplication" is dropped: raw is the *capture*.
- **The typed trajectory is the canonical consumer interface** — the *first derivation*,
  parsed once per solve by a **versioned per-harness parser**; the trajectory records
  `sourceFormat` and parser name/version so the parse itself has provenance.
- **Re-derivation is guaranteed**: any consumer needing harness-specific richness the common
  vocabulary drops (thinking blocks, hook events, exact token streams for training) parses
  the raw — a right, not the default tax on every consumer.

This is "capture once, derive many" applied to the transcript itself: raw = the capture;
typed spans = the first, canonical derived view.

**Known gap, stated openly:** the hermes-agent *solve* adapter currently writes no usable
transcript (a ~1KB stdout log with no decision path; its session store lives outside
`workingDir`). "Parse the Hermes transcript" first requires that adapter to write a real
stream — in scope for #1473 or a named sibling issue. The *interactive* Hermes lane is
unaffected (the plugin's hook collector is the transcript source there).

## Rejected

- **(b) Synthesized span mapping** — dishonest typing; rejected outright (per #1473).
- **(c) Separate `agent-transcript.v1` artifact** — the initial same-day decision (PR #1667),
  reversed on conceptual-integrity grounds: the trajectory *is* the transcript in the AI
  sense; a sibling record type would leave the trajectory slot permanently untruthful and
  split the evidence across two homes. Rejected before any consumer existed.

## Costs, accepted openly

- Per-solve scrub latency for the transcript-derived spans (bounded; solves are
  minutes-scale).
- Span-profile + conformance surgery (additive, single PR).
- Transcript bytes exist twice — raw in `system_snapshot`, typed in the trajectory. This is
  deliberate, not temporary: raw is the capture, typed is the derivation (§Raw and typed).

## Consequences

- **#1473 implements this DR**: enum extension + conformance update + transcript parsing into
  the collector at `pack()`; byte-level kind names/attributes reviewed there. Its AC-1 (a DR
  resolving the fork) is satisfied by this document.
- **#1658 (`EpisodeV1`)** adopts the shared span-kind vocabulary (note carried in that
  issue's implementing PR).
- Distillation reads real spans from the trajectory for new solves;
  `bridge-fetch-evidence.ts` hop-4 becomes a trajectory read with snapshot extraction as the
  historical fallback.
