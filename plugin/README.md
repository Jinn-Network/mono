# plugin/

The Jinn Plugin product tree — a tier-4 skeleton that later components compose into the
host-side evidence integration. C3 ships lifecycle, configuration, health reporting, and
structured logging only; there is no capture, retrieval, publication, or MCP capability
in this tree yet.

This is a **tier-4 product tree**: it composes stack packages through their public
interfaces and carries no conformance kit of its own. Kits gate tiers 1–3; this tree's
acceptance harness is the channel-cutover gate.

See `../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md`.

## Layout

| Directory | What it is |
| --- | --- |
| `runtime/` | `@jinn-network/plugin-runtime` — lifecycle/configuration/health/logging scaffold. npm-published; later components and the Hermes adapter acquire it by exact pin. |
| `adapter-hermes/` | The clean-slate Hermes adapter. Python; mirrored to the `Jinn-Network/jinn-plugin` channel repository; **never** npm-published. |
| `frozen/` | The superseded 0.1.2-era Hermes adapter and its `layer-runtime.json`. Frozen: critical fixes only, no feature work. Removed when the published trio retires. |

`runtime/` must never import from `frozen/`, and the source-boundary guard enforces it.

## Guards

`.github/scripts/plugin-tree-package-inventory.test.mjs`,
`.github/scripts/plugin-tree-source-boundaries.test.mjs`,
`.github/scripts/plugin-tree-packed-types.test.mjs`, run by
`.github/workflows/plugin-tree-ci.yml`.

Adding a dependency to a package in this tree means adding it to the inventory guard's
dependency graph with a matching `portal:` resolution; the source-boundary guard's
allowlist already admits the composition table of the design's §6.1.
