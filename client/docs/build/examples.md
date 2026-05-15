# Plug-in examples

The reference plug-ins in this repo are the de facto worked examples. Copy and edit.

## SolverType plug-in: `swe-rebench-v2-runtime`

Path: `client/plugins/swe-rebench-v2-runtime/`.

Two skills — `orient` and `plan` — that the Hermes harness loads when working on a SWE-rebench v2 code-issue Task. The manifest declares `"supports": ["swe-rebench-v2.v1"]` and lists the two skill paths.

```json
{
  "name": "swe-rebench-v2-runtime",
  "version": "0.1.0",
  "jinn": {
    "supports": ["swe-rebench-v2.v1"],
    "skills": [
      "skills/orient/SKILL.md",
      "skills/plan/SKILL.md"
    ],
    "description": "Provides Solver-side orientation + planning skills for SWE-rebench v2 code-issue Tasks."
  }
}
```

This is the template the `jinn create plugin --pattern solver-type-plugin` scaffolder produces.

## Runtime plug-in: `network-tools`

Path: `client/plugins/network-tools/`.

Exposes the network-level MCP tools (`search_records`, `inspect_record`, `acquire_artifact`, `get_task`) any agent role can call. Declares `"supports": ["jinn.runtime"]` — singleton, loads regardless of SolverType.

## Combined plug-in: `jinn-prediction-plugin`

Path: `client/plugins/jinn-prediction-plugin/`.

Ships an MCP server (`polymarket`) and skills for the `prediction.v1` SolverType. A good model for plug-ins that need both pieces.

## Harness-bundled plug-in: `learner`

Path: `client/plugins/learner/`.

The Claude-Code-shaped learner harness's own plug-in. Not loaded by Hermes — Hermes drives its own learning loop. Useful context for understanding the harness-side of the plug-in surface.
