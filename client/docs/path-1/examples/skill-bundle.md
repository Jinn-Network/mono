# Worked example: skill-bundle

**Example package:** [`examples/learner-plug-ins/@jinn-examples/forecasting-techniques`](../../../../examples/learner-plug-ins/@jinn-examples/forecasting-techniques)

## Recruit shape

You're a skill author. You have well-documented forecasting techniques — reference-class forecasting, base rates, calibration heuristics, prediction-market-specific patterns — written as prompts. You don't run a forecaster yourself; you teach forecasters how to think.

The `skill-bundle` slot is your shape: ship a directory of `SKILL.md` files; phase agents load them via the `Skill` tool.

## What the slot does

The harness registers each `<name>/SKILL.md` under the `skillsDir` into its loadable-skills index at session start. Phase agents — most often the strategist generating candidate approaches — invoke a skill via `Skill <bundle-name>:<skill-name>`. The skill body becomes part of the calling agent's context for that turn.

The forecasting-techniques example ships three skills: `reference-class-forecasting`, `base-rates`, and `calibration`.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/forecasting-techniques",
  "version": "0.1.0",
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0",
    "supportedKinds": ["prediction.v0"]
  },
  "slots": [
    {
      "type": "skill-bundle",
      "skillsDir": "skills",
      "scope": { "matchKinds": ["prediction.v0"] }
    }
  ]
}
```

`skillsDir` is relative to the package root. The harness walks the directory at session start and registers each `<name>/SKILL.md`.

## Slot entry walkthrough

Each skill is a markdown file with frontmatter declaring `name`, `description`, and (optionally) `tools`. The body is the prompt that the calling agent loads into its context.

```
skills/
├── reference-class-forecasting/SKILL.md
├── base-rates/SKILL.md
└── calibration/SKILL.md
```

The strategist subagent, when generating candidate approaches for a `prediction.v0` intent, can invoke `Skill forecasting-techniques:reference-class-forecasting` to load the technique. The skill's body shapes the strategist's next turn.

## Test → install → run

```bash
cd examples/learner-plug-ins/@jinn-examples/forecasting-techniques
yarn install
yarn test          # validates manifest + that each SKILL.md parses

cd ~/your-daemon-config
yarn add file:.../examples/learner-plug-ins/@jinn-examples/forecasting-techniques
jinn plug-ins add @jinn-examples/forecasting-techniques

# Restart daemon. Skills are now in the strategist's loadable index.
```

## Replace the stub

1. **Author your skills.** Each skill is one markdown file. Keep them focused — one technique per skill. The strategist composes multiple skills; you don't need to pre-bundle every variant.
2. **Pick good `name` + `description` frontmatter** — these are what the strategist sees when deciding which skill to load. Vague descriptions waste turns; specific descriptions earn invocations.
3. **Don't smuggle capabilities.** A skill body can reference tools the calling agent already has, but cannot add new ones. Skills inherit their caller's capability surface.
4. **Scope wisely.** If your skills are prediction-specific, set `scope.matchKinds: ["prediction.v0"]`. Skills register globally per session; scoping keeps them out of irrelevant sessions.

Skill bundles compose well with `phase-agent-override` slots: ship an override that reaches for your skills, plus the skill bundle itself, in the same package.
