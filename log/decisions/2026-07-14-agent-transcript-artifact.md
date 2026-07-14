---
id: DR-2026-07-14
title: Solve transcripts become a first-class typed artifact (`agent-transcript.v1`) — resolving the #1473 span-kind fork
date: 2026-07-14
verb: Decide
status: accepted
authors: Claude Fable 5 (drafted, Stage 1 planning session), Ritsu (steer + sign-off)
spec: docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md (§6)
amends: none — narrows the open design fork recorded in issue #1473
relates-to: "#1473 (the implementation issue this unblocks); #1472 (the shipped snapshot-extraction workaround, retained as compatibility path); #1537 (interactive-lane capture tee); spec/2026-07-06-distillation-v1.md §3 (three stores); PR #1653 (Stage 1 designs)"
---

## Context

A marketplace solve's `jinn.execution.v1` envelope has a typed `trajectory` slot, but the
`jinn.trajectory.v1` blob it references carries only packaging bookkeeping — 2
`jinn.artifact.emit` spans (surveyed live 2026-07-08 across claude-code, codex, hermes;
`client/packages/harness-layer/docs/solution-envelope-anatomy.md`). The agent's actual
reasoning exists on disk during the solve (`.claude-code/stdout.jsonl`,
`.codex-code/stdout.jsonl`) and survives only inside the generic `system_snapshot` tarball.
Consumers already prove the demand: the distillation bridge extracts transcripts from
snapshots as a workaround (#1472, `snapshot-transcript.ts`, `bridge-fetch-evidence.ts`).

Issue #1473 names the design fork and requires a DR before implementation. The options, from
the issue:

- **(a)** Additive span-kind enum extension (e.g. `jinn.agent_step`) + span-profile +
  conformance updates — makes the `trajectory` field truthful, at the cost of spec-level
  surgery, per-solve scrub latency (60+ free-text spans through the add-time + emit-time
  pipelines), and content duplication between the snapshot and the signed trajectory.
- **(b)** Map transcript events onto the existing span kinds with synthesized attributes —
  dishonest (a Bash tool call is not `jinn.mcp_call`; `jinn.llm_call` requires gen_ai token
  counts). Already rejected in the issue.
- **(c)** Emit the parsed transcript as a first-class artifact with its own CID, referenced
  from the envelope's `artifacts[]` — lighter, honestly typed, no conformance upheaval; the
  `trajectory` slot remains packaging-only for now.

Stage 1 planning (product design §6, approved and merged via PR #1653) requires that fresh
marketplace attempts — in particular attempts on user-originated minted tasks — carry a
**typed, discoverable transcript**, because those attempts are the public evidence the corpus
accumulates ("capture once, derive many").

## Decision

**Option (c). The solve transcript becomes a first-class typed artifact, `agent-transcript.v1`,
with its own CID, emitted at the engine's `pack()` seam and listed in the envelope's
`artifacts[]`.**

Constraints carried over from #1473's acceptance criteria, unchanged:

1. Transcript-derived content passes the same add-time + emit-time scrub as existing spans.
2. Solves whose transcript is missing or unparseable still publish — degradation, not failure.
3. The artifact is discoverable from the envelope without untarring `system_snapshot`
   (consumers stop needing the snapshot-tar trick).

The **byte schema** of `agent-transcript.v1` (turn/tool-call representation, parser
identification, source-harness metadata, size/truncation policy) is defined and reviewed in
#1473's implementation PR — this DR decides the route, not the field list.

The #1472 snapshot-extraction path is **retained** as the compatibility read path for
historical envelopes; it stops being load-bearing for new solves.

## Rejected

- **(b) Synthesized span mapping** — rejected outright as dishonest typing (per the issue).
- **(a) Span-kind enum extension** — rejected **for now**, not forever. The accepted,
  openly-stated cost of (c) is that the envelope's `trajectory` slot stays packaging-only —
  the reasoning lives in a sibling artifact rather than the trajectory field (Legibility:
  we say this plainly instead of half-fixing it). Revisit (a) at Stage 2, whose charter is
  exactly the unification of overlapping task / trace / trajectory / snapshot / outcome
  concepts (roadmap, `docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md`
  §Stage 2); a Stage 2 evidence-contract unification may either extend the enum or retire the
  trajectory slot in favor of the artifact — decided there, with dogfood evidence.

## Consequences

- #1473 converts from design-heavy to a plain implementable `feat`: parse the transcript at
  `pack()`, emit `agent-transcript.v1`, scrub, degrade gracefully. Its AC-1 (this DR) is
  satisfied.
- The interactive lane is unaffected: the Hermes-plugin episode (`EpisodeV1`,
  `@jinn-network/plugin`) remains the typed trajectory for sessions (#1537 tee); the two lanes
  stay distinct records serving one evidence model.
- Distillation gains a native transcript source for new solves; `bridge-fetch-evidence.ts`
  hop-4 becomes envelope-artifact lookup with snapshot extraction as fallback.
- Conformance (`trajectory-profile.ts`) is untouched in Stage 1.
