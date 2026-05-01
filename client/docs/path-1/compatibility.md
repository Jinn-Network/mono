# Path 1 compatibility + deprecation policy

Path 1 plug-ins target two contract surfaces: the `claude-code-learner` package's slot registration interface, and the `jinn-plugin.json` manifest schema. Both follow semver with a 12-week deprecation window — same as the Path 2 SDK.

## `claude-code-learner` semver discipline

The bundled learner package follows strict semver:

- **Major bump** when the slot registration interface changes, when a phase-agent contract changes (the prompt shape, the artifact schema, the agent role enum), or when the manifest schema breaks.
- **Minor bump** for additive surface — a new slot type, a new optional field on an existing slot, a new optional `scope` predicate, a new phase or topic added to the pipeline. Pre-existing plug-ins continue to load unchanged.
- **Patch bump** for bug fixes that don't change the public surface.

Phase A.2 ships at `0.x` while the surface stabilises. The 1.0 cut happens after the campaign ships and the surface absorbs feedback from the first wave of recruits.

## Plug-in compatibility ranges

Plug-ins declare `compatibility.claudeCodeLearner` in their `jinn-plugin.json` as a semver range:

```jsonc
{
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0"
  }
}
```

The loader behaviour:

- **In-range** → load normally.
- **Out-of-range** → load with a `console.warn` and surface a fleet-status warning under `status.fleet.needsAttention`. The plug-in still loads; the operator sees the mismatch and decides whether to upgrade the plug-in or pin the learner.
- **Missing** → install-time refusal. `jinn plug-ins add` requires `compatibility.claudeCodeLearner` to be present.

The "load anyway" posture is intentional: a plug-in declaring `>=0.1.0 <0.2.0` against a learner running `0.2.0` is most often still functional — the slot registration interface rarely breaks across minor majors. The warning lets the operator catch the few cases where it does without forcing a hard block.

## Plug-in manifest schema versioning

`schemaVersion` in `jinn-plugin.json` declares which manifest schema the plug-in targets. Phase A.2 ships `1.0.0`.

When the schema breaks (a new required field, a removed slot type, a changed enum), Phase A.2's policy is:

1. Ship a new schema file: `client/schemas/jinn-plugin-v2.json`.
2. Bump the `claude-code-learner` major (because the manifest schema is part of its public surface).
3. The loader accepts both `schemaVersion: "1.0.0"` and `schemaVersion: "2.0.0"` for **12 weeks** from the v2 release date. After the window, only v2 loads.
4. The `console.warn` line in the load path names the deprecated `schemaVersion` and the cutover date.

This mirrors the Path 2 SDK deprecation window (per `spec/2026-04-30-plug-in-surface.md` §3.1) and the #57 §5.1 component-side reversion threshold.

## Slot-type additions vs removals

- **New slot types** ship as minor bumps of `claude-code-learner`. The schema gains a new `oneOf` branch; existing plug-ins keep loading; new plug-ins can target the new slot.
- **Slot-type removals** require a major bump and the same 12-week deprecation overlap. Plug-ins declaring the removed slot warn during the window and refuse to load after it.
- **Slot-type renames** are a removal + an addition. Two majors of the schema overlap during the window.

## Deprecation surface

Where deprecations are announced:

- **`packages/restorer-sdk/CHANGELOG.md` and `client/CHANGELOG.md`** — release notes name the deprecated surface, the cutover date, the upgrade path.
- **`console.warn` in the daemon's load path** — names the impl + the deprecated surface + a link to the changelog entry. Operators see the warning each time the daemon boots.
- **The plug-in surface spec** (`spec/2026-04-30-plug-in-surface.md`) — appendix-tracks ratified deprecations once they ship.

The 12-week timer is the **operator-side** SLA: from the day a major lands on npm, an operator running the prior major has 12 weeks before the daemon refuses to load that major's plug-ins. Plug-in authors get the same window to publish a compatible release.

## Upgrade path

When a learner major bumps:

1. Read the changelog for the deprecation list.
2. Update `compatibility.claudeCodeLearner` in `jinn-plugin.json` to include the new major.
3. If a slot's contract changed (new required `phase` value, renamed agent role, new `scope` shape), update the slot declaration.
4. Bump your plug-in's own minor (additive compatibility) or major (if your slot's behaviour changed semantically).
5. Publish to npm. Operators on the new learner major upgrade your plug-in via `yarn upgrade @yourname/your-package` + (no-op restart of the daemon).

The `examples/learner-plug-ins/@jinn-examples/*` packages are the canonical reference for what a compatibility upgrade looks like — when the bundled learner bumps, these examples bump in lock-step.
