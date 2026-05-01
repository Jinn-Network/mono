# Path 1 — contribute a plug-in into `claude-code-learner`

Path 1 lets you ship one component into the bundled learning restorer's seven-phase pipeline (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory) without writing a whole `RestorerImpl`. You distribute as an npm package; the operator installs it; the daemon loads it at session start.

This index links the recruit-facing docs.

| Doc | What it covers |
|---|---|
| **[Quickstart](./quickstart.md)** | 60-second walkthrough — scaffold, edit, test, publish, install. |
| **[Slot reference](./slot-reference.md)** | The six slot categories, each with material shape, integration point, inputs, outputs, capability constraints. |
| **[Manifest reference](./manifest-reference.md)** | Field-by-field reference for `jinn-plugin.json`, derived from `client/schemas/jinn-plugin-v1.json`. |
| **[Compatibility](./compatibility.md)** | Versioning + deprecation policy — semver discipline, plug-in compatibility ranges, schema versioning. |
| **[Examples](./examples/README.md)** | Six worked-example walkthroughs, one per slot category, anchored on packages under `examples/learner-plug-ins/`. |

## How Path 1 fits

`claude-code-learner` is **one `RestorerImpl` among many** in the registry. It declares `supports()` for the kinds it claims, and the engine dispatches to it the same way it dispatches to any specialist. Path 1 plug-ins ship **inside** that one impl — they extend its internal pipeline, not the protocol.

This split matters: the protocol surface stays narrow (RestorerImpl + RestorationContext + intent kinds); the harness's internal architecture is publicly pluggable so component-builders can drop in refiners, judges, planners, tools, skills, and memory backends without forking. See `spec/2026-04-30-plug-in-surface.md` §4.1 for the full reconciliation.

## Trust posture

Path 1 plug-ins **inherit trust from the host harness**. There is no per-plug-in capability allow-list, no per-plug-in manifest signature, no per-plug-in revocation. The trust surface is operator-level: the operator vouched by running `jinn plug-ins add`. A plug-in cannot widen the harness's capability surface — see [slot-reference.md](./slot-reference.md) for the constraints. Builders who need new daemon-level capabilities ship Path 2 instead.

For the canonical statement see `spec/2026-04-30-plug-in-surface.md` §4.3 and the cross-reference in `spec/2026-05-executor-trust-boundary.md` §1.2.

## Distribution

Path 1 plug-ins distribute as **npm packages**. Builders publish to npm (or any npm-compatible registry); operators install via:

```bash
yarn add @some-operator/your-plug-in
jinn plug-ins add @some-operator/your-plug-in
```

The two-step shape mirrors Path 2's `yarn add` + `jinn impls add`. The plural `plug-ins` verb disambiguates from `jinn plugin install` (which installs the Jinn MCP server / skill into AI hosts).

## Vocabulary

When in doubt about a Jinn-specific term (`vessel`, `vow`, `wish`, `seer`, `wane`), check `GLOSSARY.md` rather than redefining it locally.
