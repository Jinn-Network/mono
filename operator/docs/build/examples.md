# Plug-in examples

The reference plug-ins in this repo are the de facto worked examples. Copy and edit.

## SolverType plug-in: `swe-rebench-v2-runtime`

Path: `operator/plugins/swe-rebench-v2-runtime/`.

A single domain-reference skill — `swe-rebench-v2-task` — that the harness loads when working on a SWE-rebench v2 code-issue Task. The skill describes the task input shape, repo handling, FAIL_TO_PASS / PASS_TO_PASS semantics, and the `swe-rebench-v2-solution.v1` payload schema. The manifest declares `"supports": ["swe-rebench-v2.v1"]` and points at the one skill path.

```json
{
  "name": "swe-rebench-v2-runtime",
  "version": "0.1.0",
  "jinn": {
    "supports": ["swe-rebench-v2.v1"],
    "skills": [
      "skills/task/SKILL.md"
    ],
    "description": "Provides domain reference for swe-rebench-v2.v1 code-issue tasks — task shape, repo handling, FAIL_TO_PASS / PASS_TO_PASS semantics, and solution payload schema."
  }
}
```

This is the template the `jinn create plugin --pattern solver-type-plugin` scaffolder produces.

**SolverType plug-ins describe their domain only — no orchestration verbs.** Per DR-2026-05-26, the harness's `learn` skill owns task phases (orient, plan, execute, review). A SolverType plug-in's job is to tell the agent what the task *is*: input shape, success criteria, output schema. It does not tell the agent *how to work*. If you find yourself writing "first do X, then do Y" in a SolverType SKILL.md, you're leaking harness orchestration into the plug-in — split it out, or fold it back into the harness.

## Runtime plug-in: `network-tools`

Path: `operator/plugins/network-tools/`.

Exposes the network-level MCP tools (`search_records`, `inspect_record`, `acquire_artifact`, `get_task`) any agent role can call. Declares `"supports": ["jinn.runtime"]` — singleton, loads regardless of SolverType.

## Combined plug-in: `jinn-prediction-plugin`

Path: `operator/plugins/jinn-prediction-plugin/`.

Ships an MCP server (`polymarket`) and skills for the `prediction.v1` SolverType. A good model for plug-ins that need both pieces.

## Harness-bundled plug-in: `learner`

Path: `operator/plugins/learner/`.

The Claude-Code-shaped learner harness's own plug-in. Not loaded by Hermes — Hermes drives its own learning loop. Useful context for understanding the harness-side of the plug-in surface.
