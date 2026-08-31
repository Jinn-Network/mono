# DR-2026-08-24 — Resolve bundled/local SolverPlugins in-place

- **Date:** 2026-08-24
- **Issue:** [#1242](https://github.com/Jinn-Network/mono/issues/1242)
- **Spec:** [`spec/2026-06-14-solver-plugin-mounting-model.md`](../../spec/2026-06-14-solver-plugin-mounting-model.md) (spike #296)

## Decision

`bundled:` and `local:` SolverPlugin entries resolve to their on-disk install roots. The daemon no longer `cpSync`s them into `~/.jinn-operator/solver-plugins/` (legacy `~/.jinn-client/solver-plugins/`). Remote kinds (`npm:`, `git:`, `github:`, `claude:`) keep the writable vendor-root materialization they require.

Boot runs a best-effort GC that deletes orphaned bundled/local vendor copies and their sidecar markers, whitelisting vendor directories that correspond to configured remote plugin sources.

Hermes and Claude Code harnesses stop injecting `JINN_NETWORK_TOOLS_CLIENT_ROOT` once the network-tools plugin root is the real in-package tree (the launcher's `../..` walk reaches `operator/` where `dist/mcp/server.js` lives). Codex workspace projection still injects the env when plugins are symlinked/copied under the task working directory.

## Rationale

The vendor copy was incidental unify-all-kinds resolver behavior with no benefit for immutable in-package code. It broke the network-tools MCP launcher (#294) and created stale `local:` shadow copies. In-place resolution is the minimal fix tracked since spike #296.
