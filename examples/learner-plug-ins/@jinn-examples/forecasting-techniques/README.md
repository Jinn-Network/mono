# @jinn-examples/forecasting-techniques

**Recruit shape:** skill author with documented forecasting techniques
(calibration, base rates, reference-class forecasting, prediction-market-specific
patterns).

**Slot:** skill-bundle → claude-code-learner phase agents (especially the
strategist), scoped to `prediction.v0`.

## What this plug-in does

Adds three Claude Code skills loadable by the strategist (and any other phase
agent that surfaces the skill descriptions):

- `reference-class-forecasting` — anchor on the outside view first
- `base-rate-anchoring` — start from base rates, surface adjustment magnitudes
- `calibration-techniques` — self-checks before freezing a probability

The skills are pure markdown (Claude Code skill format) — no code, no MCP
server. They surface inside the harness via Claude Code's `--plugin-dir`
mechanism.

## Install

```bash
yarn add @jinn-examples/forecasting-techniques
jinn plug-ins add @jinn-examples/forecasting-techniques --entry $(npm root)/@jinn-examples/forecasting-techniques
```

## Test

```bash
yarn install
yarn test
```

## Add a new skill

Drop a `skills/<skill-name>/SKILL.md` (with valid frontmatter `name`,
`description`, `allowed-tools`). The skill becomes loadable on the next
session.

## Spec

`spec/2026-04-30-plug-in-surface.md` §4.7.4.
