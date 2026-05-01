# Worked example: phase-agent-override

**Example package:** [`examples/learner-plug-ins/@jinn-examples/calibration-refiner`](../../../../examples/learner-plug-ins/@jinn-examples/calibration-refiner)

## Recruit shape

You're a calibration-model author. You have an isotonic-regression model (or Platt scaling, or some adversarial-CoT calibration trick) that improves any forecaster's probability estimates. You don't have a whole forecaster — you have a refiner.

This is the Silverarrow shape: the marginal improvement is well-defined, the integration point is narrow, and the reusable artefact is one component, not a pipeline.

## What the slot does

The `phase-agent-override` slot replaces (or augments) one of `claude-code-learner`'s six bundled phase agents — `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator` — for declared kinds.

The calibration-refiner example overrides the `step-worker` agent in the `execute` phase for `prediction.v0` intents. When Execute fans out to step-workers, our agent runs in place of the bundled one for steps that match. It reads the forecaster's raw probability + a calibration history (from `implStateDir/calibration/history.json`), applies isotonic regression, and writes the calibrated probability with a `calibration_diff` field for Debrief's analyst to absorb.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/calibration-refiner",
  "version": "0.1.0",
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0",
    "supportedKinds": ["prediction.v0"]
  },
  "slots": [
    {
      "type": "phase-agent-override",
      "phase": "execute",
      "agent": "step-worker",
      "scope": { "matchKinds": ["prediction.v0"] },
      "entry": "agents/calibration-step-worker.md"
    }
  ]
}
```

The `scope.matchKinds` filter ensures the override only fires for `prediction.v0` intents; other kinds keep using the bundled step-worker.

## Slot entry walkthrough

The `entry` points at `agents/calibration-step-worker.md` — a markdown agent file with frontmatter declaring its tools (`Bash`, `Read`, `Write`) and a body describing how to run isotonic regression over the input history.

The agent file lives entirely in markdown; no TS, no MCP server. The harness spawns it with the same prompt shape it uses for the bundled step-worker, plus the slice of `RestorationContext` the phase coordinator passes through. The agent writes its output to `workingDir/.execute/<step-id>/output.json` matching the bundled artefact schema.

## Test → install → run

```bash
# Local clone
cd examples/learner-plug-ins/@jinn-examples/calibration-refiner
yarn install
yarn test          # passes — validates manifest + simulates session-start load

# Install into a daemon for end-to-end testing
cd ~/your-daemon-config
yarn add file:.../examples/learner-plug-ins/@jinn-examples/calibration-refiner
jinn plug-ins add @jinn-examples/calibration-refiner

# Restart daemon. On the next prediction.v0 attempt, the override fires.
```

## Replace the stub

To turn this scaffold into a production refiner:

1. **Replace the agent body.** Edit `agents/calibration-step-worker.md` — write the prompt that drives your specific calibration model. The frontmatter's `tools` list tells the harness what's available; you cannot widen it (no new RPC, no new signer).
2. **Update the calibration history schema** at `implStateDir/calibration/history.json` if your model needs richer features.
3. **Bump the package version**, publish to npm, point recruits at your install command.

Builders who need new daemon-level capabilities (custom RPC method, signer access) should ship Path 2 instead. Path 1 is for components that fit inside the harness's existing capability surface.
