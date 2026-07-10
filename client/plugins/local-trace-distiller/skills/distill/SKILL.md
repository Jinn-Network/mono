---
name: distill
description: Use local trace tools to derive experimental skills from private session traces. Trigger on /distill, "distill this", "distill all", or requests to turn repeated local work into a reusable skill.
tools: distill_trace_search, distill_trace_read, distill_trace_cluster, distill_local, distill_feedback_record
---

# Local Trace Distill

Use this skill to help the user turn local work traces into experimental skills using the existing Jinn distillation methodology.

## Arguments

- No argument means `this`: focus on the current or most recent session.
- `this`, `current`, or `recent`: inspect the most recent local trace cards, choose the best match for the current session, then distill only that trace unless the user chooses a broader set.
- `all`: run a capped, cheap scan over local trace cards, cluster recurring signals, present candidates, and ask the user which candidate to distill.
- A trace id, session id, or candidate trace list: inspect those traces and distill only the selected traces.

## Tool Workflow

1. Start with `distill_trace_search`, using compact cards. Do not read full transcripts first.
2. For `all`, call `distill_trace_cluster` with a conservative cap. Default to `limit: 50` unless the user requested a different cap.
3. Read only what is needed:
   - Use `mode: "summary"` for orientation.
   - Use `mode: "tool_calls"` to understand commands and edits.
   - Use `mode: "transcript_excerpt"` with a query when one section matters.
   - Use `mode: "full_transcript"` only when the skill cannot be safely derived from smaller reads, and set `allowFullTranscript: true` only after deciding it is necessary.
4. Before calling `distill_local`, summarize the proposed source traces and the likely skill opportunity in one short paragraph.
5. Call `distill_local` with `confirm: true` only after the user explicitly approves the run or has already requested an execution form such as "distill this now".
6. Pass selected `traceIds` or `sessionIds` whenever the user chose a candidate. Avoid distilling every capture unless the user asked for `all` and then approved that broad run.

## Distillation Methodology

Reuse the existing Jinn distillation methodology rather than inventing a new prompt:

- Prefer evaluator/user-accepted successful traces for success patterns.
- Use failed or abandoned traces only for concrete lessons and failure avoidances.
- Keep the skill grounded in repeated evidence when available; label single-trace outputs as experimental.
- Preserve provenance through the generated skill metadata.
- Run through the existing scrub, contamination, structure, and package gates via `distill_local`.

## User Feedback Loop

Generated skills are experimental. After a later session uses one, ask the user whether it helped, hurt, was mixed, or went unused. If the user gives feedback, call `distill_feedback_record` with the skill name, verdict, session id if known, and only user-approved notes or accepted changes. Convert accepted feedback into a targeted skill improvement instead of accumulating broad notes.

## Future Marketplace

Do not list local skills publicly in this version. Later versions may let users publish useful skills to a marketplace for others to use and pay for, but that requires explicit user approval and a separate publish flow.

## Privacy

Local traces are private by default. Do not export trace content or generated skills to a remote marketplace or shared corpus unless the user explicitly asks for that future publish flow.
