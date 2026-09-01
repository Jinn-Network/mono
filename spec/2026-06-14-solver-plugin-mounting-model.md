# SolverPlugin mounting model — stop copying immutable plugin code into the operator vendor root

- **Date:** 2026-06-14
- **Author:** claude (spike on `spike/296-investigate-why-are-solverplugins-copied-per-task-into-home`; Captain ritsukai)
- **Status:** Implemented (#1242)
- **Version:** 0.1
- **Issue:** [#296](https://github.com/Jinn-Network/mono/issues/296) — investigate: why are SolverPlugins copied per-task into `$HOME/.jinn-client/solver-plugins/`, and what should the layout be?
- **Tracks:** Phase A.2 SolverPlugin mechanism (`spec/2026-05-01-harness-pack-architecture.md` §11.6). Replaces the env-injection band-aid shipped in #294/#299.

## Summary

The daemon materializes every SolverPlugin tree — including the `bundled:` and `local:` plugins that ship inside the published package — by `cpSync`-copying it into `~/.jinn-client/solver-plugins/<name>/`. The copy was added as an incidental side effect of unifying six plugin source kinds (`bundled` / `local` / `npm` / `git` / `github` / `claude`) behind one "materialize into the vendor root" resolver. The remote kinds genuinely must fetch into a writable vendor root; `bundled` and `local` plugins are already on local disk inside the install and gain nothing from the copy.

The copy is the **root cause of #294**: the `network-tools` MCP launcher resolves the daemon's server entry by walking `<pluginRoot>/../..`. From the real install layout (`<client>/plugins/network-tools/`) that walk lands at `<client>/` where `dist/mcp/server.js` lives and works. From the copied layout (`~/.jinn-client/solver-plugins/network-tools/`) it lands at `~/.jinn-client/` (no `dist/`) and fails. #294/#299 papered over this by injecting `JINN_NETWORK_TOOLS_CLIENT_ROOT` into the per-task Hermes env.

**Proposal:** resolve `bundled:` and `local:` plugins to their in-place install path and skip the copy entirely. The remote kinds keep the vendor-root materialize they actually need. This kills the #294 root cause at source, lets the env-injection band-aid be removed, and also closes a latent shadowing bug in the `local:` refresh path. A best-effort one-time GC removes now-orphaned bundled/local vendor copies on boot.

## Findings

### Correction to the issue framing: the copy is per-startup, not per-task

The copy runs once per SolverNet at registration time (`client/src/solver-nets/registry.ts:285`, inside `addRuntimePlugin`, called when the daemon loads SolverNets at boot), not per task. The *per-task* artifact is the Hermes config (`writePerTaskHermesConfig`, `client/src/harnesses/impls/hermes-agent/bootstrap.ts:259`), which only **references** the already-materialized vendor root via `solverPluginRoots` (`engine.ts:1244` → `plugin.root`). The launcher's broken `../..` walk fires per task because the per-task config points at the vendor copy, but the tree itself is materialized once at startup.

### Where the copy happens

`materializeLocal` in `client/src/plugins/resolvers.ts:79-101`, called by `resolveSolverPlugin` (`:103-141`):

- `:114-116` — `bundled:` → `materializeLocal(join(bundledRoot(...), name), vendorRoot, name, { refresh: true })`
- `:117-119` — `local:` → `materializeLocal(localRoot, vendorRoot, name)` (no refresh)
- `:120-124` — remote kinds → `join(vendorRoot, safeVendorName(source))`, **must already be vendored** or it throws.

The copy itself is `cpSync(root, target, { recursive: true, dereference: true })` at `:93` (refresh path) and `:97` (first-materialize path), where `target = join(vendorRoot, name)` and `vendorRoot = ~/.jinn-client/solver-plugins` (`:14`).

Introduced by commit `d8d2a80b` (ritsukai, 2026-05-01, *"Implement harness solver plugin migration"*), squash-merged as `2d6b2676` (*"[codex] Complete Task and SolverNet migration (#72)"*). Rationale lives in `spec/2026-05-01-harness-pack-architecture.md:676`: the resolver "materializes it into the operator's vendor root (`~/.jinn-client/solver-plugins/<name>/`)" — framed as one mechanism for all six handlers, with no separate justification for copying in-package code.

### Why — only one confirmed reason, and it does not apply to bundled/local

| Candidate reason | Verdict | Evidence |
|---|---|---|
| Uniform vendor root across remote + local source kinds | **CONFIRMED** (the only driver) | Remote kinds (`npm`/`git`/`github`/`claude`) *require* a fetched copy at `join(vendorRoot, …)` (`resolvers.ts:120-124`); `bundled`/`local` were folded into the same `materializeLocal` shape for consistency. |
| Per-task version pinning | NOT-FOUND | No per-task copy exists; bundled refresh is sha256-drift-based (`:87-95`), tracking the install, not pinning a task. |
| Mutable plugin state (runtime writes into the tree) | NOT-FOUND | No `mkdir`/`writeFile`/`cpSync` writes into `solver-plugins/` at runtime. All mutable run state goes to `~/.jinn-client/engine/impl-state/` (e.g. `swe-rebench-v2-evaluator/harness.ts:427,450`; `claude-mcp-hyperliquid/index.ts:212`). The harness-pack spec treats the plugin tree as signed-immutable code (§ line 543) and `implStateDir` as the sole per-operator mutable surface. |
| Permissions / sandboxing | NOT-FOUND | Vendor root is in the operator's own home — same trust domain as the install. No code or comment cites this. |
| npm-install resolution (co-located `node_modules`) | NOT-FOUND for bundled | `client/plugins/network-tools/` has no `package.json` and no `node_modules`; the launcher imports only `node:` builtins and spawns the daemon's own server. Co-location buys nothing today. |
| Snapshot for trajectory/audit | PARTIAL | `digestDirectory(root)` (`:128`) feeds `runtimeBundleDigest`, but the digest works equally over the install path. Audit is served incidentally, not a reason to copy. |

**Net:** for every plugin that ships today (all `bundled:`/`local:`), the copy is pure overhead with no mutable-state, permissions, npm, or pinning justification.

### Code vs state

Everything in a plugin tree is immutable code: launcher `.mjs`, `.mcp.json`, `jinn.plugin.json`, host-runtime manifests (`.claude-plugin/`, `.codex-plugin/`), `hooks/`, `skills/`. Bundled plugins ship no `package.json`/`node_modules`. The only per-operator writables — the `<name>.source.sha256` marker and `<name>.lock` — live in `vendorRoot` *beside* the copies and exist *only because of* the copy mechanism. Genuine per-operator mutable state already lives entirely separately in `~/.jinn-client/engine/impl-state/`. Code and state are already cleanly separated; the copy mixes nothing in.

## Proposed layout

**Resolve `bundled:` and `local:` to their in-place install path; keep the vendor-root materialize only for remote source kinds.**

- `bundled:` → `root = join(bundledRoot(opts.bundledRoot), name)` (the in-package `client/plugins/<name>/`, already computed at `resolvers.ts:64-70`), returned directly — no `materializeLocal`.
- `local:` → `root = localPathFromSource(source)`, returned directly — no copy.
- `npm:` / `git:` / `github:` / `claude:` → unchanged; these must fetch into the writable vendor root.

With this, the launcher's `resolve(root, '..', '..')` walk (`jinn-client-server.mjs:54`) lands at the real `<client>/` for bundled plugins, where `dist/mcp/server.js` (or `src/mcp/server.ts`) exists — fixing #294 at the source. `digestDirectory(root)` still produces the audit digest over the install path, so `runtimeBundleDigest` is preserved.

### Why this direction over the alternatives

- **(a) reference by install path, no copy — chosen** for bundled/local: matches the reasons exactly (nothing to copy out for immutable, in-package code) and is the minimal change that removes the #294 root cause.
- (b) copy once per-operator, never per-task — already effectively true (copy is per-startup) and does **not** fix #294: a per-operator copy still lacks a sibling `dist/`. Rejected.
- (c) split code from state — already done; state is in `impl-state/`. Redundant.
- (d) registry mapping name → resolved path — this is the right shape for the **remote** kinds and already exists implicitly as `LoadedSolverPlugin.root`. The proposal is effectively (a)+(d): bundled/local resolve in-place, remote kinds resolve to vendor root.

## Migration path

1. Branch `resolveSolverPlugin` so `bundled`/`local` set `root` to the in-place install path (skip `materializeLocal`). Remote kinds unchanged. No operator-file migration is required — the new path simply ignores old vendor copies.
2. **One-time GC (best-effort, never fails boot):** on boot, delete orphaned `solver-plugins/<name>/`, `<name>.source.sha256`, and stale `<name>.lock` for bundled/local names. **Whitelist** names that correspond to remote (`npm:`/`git:`/`github:`/`claude:`) entries in the operator's joined SolverNets so the GC never deletes a still-needed remote vendor copy.
3. Remove the `JINN_NETWORK_TOOLS_CLIENT_ROOT` injection (`config-builder.ts:79-89`) and its comment; optionally keep the launcher's env branch (`jinn-client-server.mjs:40-49`) as a harmless explicit-override fallback for the remote-fetched case.
4. **Rollback-safe:** backward compatible — a downgraded operator re-materializes the vendor copy on next boot via the unchanged old code path; no forward-incompatible on-disk state is written.

### Latent bug this also fixes

`materializeLocal` only copies a `local:` plugin when the target is **absent** (`:96`, `else if (!existsSync(target))`); `local:` resolution passes no `refresh`, so a present-but-stale `local:` vendor copy is **never updated** and shadows a newer install. The in-place layout eliminates this shadowing class entirely.

## Recommended follow-up

File a `refactor` (or `fix`) implementation issue scoped to:
- `resolveSolverPlugin` branch for in-place bundled/local resolution,
- the best-effort boot GC with the remote-whitelist guard,
- removal of the `JINN_NETWORK_TOOLS_CLIENT_ROOT` injection,
- a regression test: a `bundled:network-tools` plugin resolves to a `root` whose `../..` contains `dist/mcp/server.js` (or `src/mcp/server.ts`), proving the launcher walk works without the env band-aid.

## Key references

- `client/src/plugins/resolvers.ts:14,64-70,79-101,103-141` — vendor root, `bundledRoot`, `materializeLocal` (the copy at `:93`/`:97`), `resolveSolverPlugin`.
- `client/src/plugins/resolvers.ts:96` — `local:` never-refresh shadowing bug.
- `client/src/solver-nets/registry.ts:7,285` — `bundled:network-tools` constant; startup resolve call.
- `client/src/harnesses/engine/engine.ts:1244` — `solverPluginRoots` → per-task ctx.
- `client/src/harnesses/impls/hermes-agent/bootstrap.ts:259-293` — `writePerTaskHermesConfig` (references vendor roots).
- `client/src/harnesses/impls/hermes-agent/config-builder.ts:74-89` — `resolveClientRoot` + `JINN_NETWORK_TOOLS_CLIENT_ROOT` injection (#294 band-aid; comment points to #296).
- `client/plugins/network-tools/mcp/jinn-client-server.mjs:51-67` — `candidateRoots` `../..` walk that fails in the vendor layout.
- `spec/2026-05-01-harness-pack-architecture.md:676` — resolver "materializes into vendor root" rationale; immutable-code vs per-operator-state split.
- `log/decisions/2026-05-19-v0.1.6-stewardship.md` — where #294 was discovered; #299 closed #294 with the band-aid; #296 replaces it.
- Introducing commit `d8d2a80b` / squash `2d6b2676` (*"Complete Task and SolverNet migration (#72)"*).
