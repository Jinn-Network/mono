# plugin/

The Jinn Plugin — the host-side evidence integration that makes an interactive agent a
first-class participant on the evidence plane. It captures sessions as standard Execution
Evidence records into a local archive, and retrieves relevant evidence into the agent's
context from both the operator's own archive and the public corpus.

This is a **tier-4 product tree**: it composes stack packages through their public
interfaces and carries no conformance kit of its own. Kits gate tiers 1–3; this tree's
acceptance harness is the channel-cutover gate.

See `../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md`.

## Layout

| Directory | What it is |
| --- | --- |
| `runtime/` | `@jinn-network/plugin-runtime` — the stack-composed MCP runtime. npm-published; the artifact the Hermes adapter acquires by exact pin. |
| `adapter-hermes/` | The clean-slate Hermes adapter. Python; mirrored to the `Jinn-Network/jinn-plugin` channel repository; **never** npm-published. |
| `frozen/` | The superseded 0.1.2-era Hermes adapter and its `layer-runtime.json`, relocated here content-unchanged so the `apps/jinn-agent` fork can be removed. Frozen: critical fixes only, no feature work. Removed when the published trio retires. |

`runtime/` must never import from `frozen/`, and the source-boundary guard enforces it.

## Guards

`.github/scripts/plugin-tree-package-inventory.test.mjs`,
`.github/scripts/plugin-tree-source-boundaries.test.mjs`,
`.github/scripts/plugin-tree-packed-types.test.mjs`, run by
`.github/workflows/plugin-tree-ci.yml`.

Adding a dependency to a package in this tree means adding it to the inventory guard's
dependency graph with a matching `portal:` resolution; the source-boundary guard's
allowlist already admits the composition table of the design's §6.1.
