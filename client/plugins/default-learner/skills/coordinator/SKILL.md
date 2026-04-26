---
name: coordinator
description: Use when running a Jinn restoration intent end-to-end. Sequences the seven-phase pipeline (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation) by loading each phase's skill in order.
allowed-tools: Bash, Read, Write, Skill
---

# Coordinator — default-learner entry point

You are running one Jinn restoration intent end-to-end. This skill is the entry point. Each phase's skill is loaded into your session in turn; each phase skill does its own thin orchestration — meaning each phase skill's job is to launch a specialized subagent via the Agent tool and collect its output, not to do the deep reasoning itself.

## Inputs (from the daemon)

- `intent` — `{ id, description, kind, window: { startTs, endTs }, spec, eligibility? }`
- `workingDir` — ephemeral; the engine harvests for delivery when you return
- `implStateDir` — operator-private durable self; persists across runs
- `msUntilEndTs` — function returning remaining time in the window
- An abort signal that fires at `window.endTs`

## Boot

The session-start hook (`hooks/session-start.sh`) has already run with `IMPL_STATE_DIR` set, so:
- `implStateDir` is a git repo
- The default-learner git author identity is configured
- HEAD sha is the implStateDir state at run start

Capture it for the constitution span:

```bash
IMPL_STATE_DIR_SHA=$(git -C "$IMPL_STATE_DIR" rev-parse HEAD)
SKILL_BUNDLE_CID=$(find "$PLUGIN_ROOT" -type f \( -name '*.md' -o -name '*.sh' -o -name '*.mjs' \) | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)
```

(`$PLUGIN_ROOT` is the path to this plugin install; if your harness doesn't expose it, hash the loaded skills from their loaded paths.)

Write `workingDir/.coordinator/boot.json` (downstream phases — particularly Strategize — read it for the constitution span). The shape is:

```json
{
  "implStateDirShaAtStart": "<git HEAD sha of implStateDir at run start>",
  "skillBundleCid": "sha256:<plugin bundle digest>",
  "intentId": "<intent.id>",
  "windowEndTs": <window.endTs as milliseconds since epoch>
}
```

The daemon hands you `intent`, `workingDir`, and `implStateDir` as session inputs (not POSIX env vars). Bind them to the variables this section uses, then write the file:

```bash
# Bind session inputs into shell variables (substitute your harness's
# mechanism — e.g., values pulled from the initial prompt context or a
# harness-provided JSON input):
WORKING_DIR="<workingDir from session inputs>"
INTENT_ID="<intent.id from session inputs>"
WINDOW_END_TS="<intent.window.endTs from session inputs>"

mkdir -p "$WORKING_DIR/.coordinator"
cat > "$WORKING_DIR/.coordinator/boot.json" <<EOF
{
  "implStateDirShaAtStart": "$IMPL_STATE_DIR_SHA",
  "skillBundleCid": "sha256:$SKILL_BUNDLE_CID",
  "intentId": "$INTENT_ID",
  "windowEndTs": $WINDOW_END_TS
}
EOF
```

`windowEndTs` is the intent window's end timestamp in milliseconds since epoch.

## Pipeline

*Skip-execute hint:* if the env var `JINN_DEFAULT_LEARNER_SKIP_EXECUTE=true` is set (the daemon-side wrapper sets it when delegating Execute to a kind-specific specialist), skip phase 4 entirely. The wrapper will run Execute externally and populate `workingDir/.execute/` itself before invoking Debrief.

For each phase below, in order:

1. Load the phase skill via the `Skill` tool (e.g., `Skill orient`).
2. The skill loads into your session; follow its instructions. It will typically launch one or more specialized subagents via the Agent tool, collect their outputs, and write artifacts under `workingDir/.<phase>/`.
3. Append a JSONL entry to `workingDir/.coordinator/log.jsonl` after each phase: `{ ts, phase, status, summary }`.

Phases in order:

1. `orient` — gather intent + world-state + history
2. `strategize` — pick approach, freeze success criteria + timing posture
3. `plan` — concrete steps, optionally time-anchored
4. `execute` — walk plan, spawn step-workers, decide stuck
5. `debrief` — post-execution analysis
6. `improve` — mutate `implStateDir`, commit
7. `memory-consolidation` — curate, separate commit

## Constitution span

After Strategize, read `workingDir/.strategize/constitution.json` and emit its fields as attributes on a `jinn.state_transition` span. If your harness exposes an OTel tracer, do this; otherwise the file itself is the constitution record (Debrief reads it from there).

## Returning

When the pipeline finishes — whether all seven phases completed cleanly, an abort signal fired, or a phase reported failure — return. The Jinn daemon's walkArtifacts packaging handles delivery. Never modify anything outside `implStateDir/**` or `workingDir/**`.

## Failure handling

- Within Execute: that skill judges `continue / retry-step / replan / abort` per its own rules.
- Execute reporting `abort` is not a coordinator-level abort — continue to Debrief / Improve / Memory consolidation as normal so partial work is analyzed and curated. The Execute skill writes `workingDir/.errors/execute.json` itself.
- Other phases: if a phase reports a hard problem, write `workingDir/.errors/<phase>.json` and abort the pipeline. Still invoke `memory-consolidation` so partial work gets curated.
- Abort signal fired (window expired): stop the current phase cleanly, write `workingDir/.errors/abort.json`, invoke `memory-consolidation`, return.

## Cross-reference

Spec: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1, sections §2, §10.
