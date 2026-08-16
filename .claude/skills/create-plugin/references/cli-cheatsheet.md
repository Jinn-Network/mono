# create-plugin CLI cheatsheet

Verbatim commands and exact JSON output shapes. Source-of-truth:
`operator/src/cli/commands/create.ts`, `solver-plugins.ts`,
`solver-plugins-publish.ts`, `solver-nets.ts`. Output shapes are single-line
JSON unless noted (`solver-nets` pretty-prints with 2-space indent).

Run the CLI as `node operator/dist/bin/jinn.js <args>` (built; AC#4 load-probe
also needs the build) or `yarn jinn <args>` (dev, `tsx`). Either works for the
scaffold/validate verbs.

---

## 1. Scaffold — `jinn create plugin`

```
jinn create plugin <packageName> --pattern <p> --solver-type <st> --out-dir <dir>
```

- `<p>`: `solver-type-plugin` (default) or `runtime-plugin`.
- `--solver-type`: default `swe-rebench-v2.v1`; **ignored** for `runtime-plugin`.
- `--out-dir`: default cwd. The package is written to `<out-dir>/<packageName>`.

Stdout (plain text, not JSON):

```
Created <packageName> at <targetRoot>
Next: cd <targetRoot> && yarn install && yarn test
Quickstart: https://github.com/Jinn-Network/mono/blob/next/client/docs/build/quickstart.md
```

Parse `<targetRoot>` from the first line (`Created <name> at <targetRoot>`).

Files emitted (solver-type-plugin): `package.json`, `jinn.plugin.json`,
`skills/example/SKILL.md`, `test/plugin.test.ts`, `README.md`,
`tsconfig.json`, `.gitignore`.

Files emitted (runtime-plugin): `package.json`, `jinn.plugin.json`,
`.mcp.json`, `mcp/server.mjs`, `test/plugin.test.ts`, `README.md`,
`tsconfig.json`, `.gitignore`.

---

## 2. Validate — `jinn solver-plugins validate <source-or-path>`

```
jinn solver-plugins validate <targetRoot>
```

Success (single-line JSON):

```json
{"verb":"solver-plugins validate","ok":true,"plugin":{"name":"@you/name","version":"0.1.0","solverType":"demo.v1","supports":["demo.v1"],"sha256":"<hex>","manifestPath":"<path>"}}
```

Failure (exit 1):

```json
{"verb":"solver-plugins validate","ok":false,"error":{"code":"invalid_solver_plugin","message":"<why>"}}
```

Read `.ok`; on `false` read `.error.message`, fix, re-run. Loop to `ok:true`.

**#1052 materialization note:** validate (and show/pack/publish) resolve the
plug-in through `resolveSolverPlugin`, which **copies the source into
`~/.jinn-client/solver-plugins/<basename>/`** as a side effect — the
`manifestPath` in the output points there, not at your source tree. Editing
your source and re-running validate re-copies (local sources are not refreshed
by digest, so if a stale copy bites you, `rm -rf ~/.jinn-client/solver-plugins/<basename>`
and re-run).

Common failure messages:
- `manifest.jinn.supports must be a non-empty string array` — missing/empty `supports`.
- `SolverNet contracts own canonical solverType and schemas; plugin manifests must declare manifest.jinn.supports only` — you added `jinn.solverType` or `jinn.schemas`. Remove them.
- `manifest.jinn.supports may not mix 'jinn.runtime' with SolverType identifiers` — a runtime plug-in must have `supports: ["jinn.runtime"]` exactly.

---

## 3. Load-probe (AC#4) — `references/load-probe.mjs`

Prereq: `cd operator && yarn build` (the probe imports `operator/dist/plugins/index.js`).

```
node .claude/skills/create-plugin/references/load-probe.mjs <abs-targetRoot> <target>
```

- `<target>` = the `--solver-type` value (solver-type-plugin) or `jinn.runtime`
  (runtime-plugin).

Output (single-line JSON; exit 0 when ok, else 1):

```json
{"ok":true,"resolved":["@you/name"],"target":"demo.v1"}
{"ok":false,"resolved":[],"target":"bogus.v9"}
```

Drives the real daemon path: `loadSolverPlugins([{ source: 'file:<path>' }])`
→ `forSolverType(<target>)`. Require `ok:true` for the probed target.

---

## 4. Publish (GATED) — `jinn solver-plugins publish <source-or-path>`

Writes `plugin:<cid>` on the ERC-8004 IdentityRegistry; lazily completes
Stage-1; needs funding + `JINN_PASSWORD`. Run ONLY on explicit confirmation.

```
JINN_PASSWORD=… jinn solver-plugins publish <targetRoot> [--builder-agent-id <id>]
```

Success:

```json
{"verb":"solver-plugins publish","txHash":"0x…","pluginCid":"…","pluginSha256":"0x…","builderAgentId":"<id>","identityRegistry":"0x…","safeAddress":"0x…","pluginName":"@you/name","pluginVersion":"0.1.0","supports":["demo.v1"],"publishedAt":<unix>}
```

Funding failure (expected when the EOA is unfunded) — relay the hint:

```json
{"error":{"code":"ensure_stage1_failed","message":"<funding hint>"}}
```

Other error codes: `keystore_missing`, `config_load_failed`,
`invalid_solver_plugin`, `pack_failed`, `fleet_identity_missing`,
`publish_failed`.

---

## 5. Join (GATED) — `jinn solver-nets add-plugin <name> <source>`

Run ONLY on explicit confirmation. A daemon restart is required afterward
(no hot-reload).

```
jinn solver-nets add-plugin <solver-net> <source>
```

Output (2-space-indented JSON):

```json
{
  "verb": "solver-nets add-plugin",
  "configPath": "<path>",
  "name": "<solver-net>",
  "source": "<source>"
}
```

`add-plugin` edits the legacy `solverNets` file shape and prints a stderr
WARNING (issue #421); the daemon auto-migrates on next load. Re-join via the
SPA (Operator > SolverNets) to replace synthetic `legacy:*` keys with real
manifest CIDs.

---

## 6. Status — `jinn solver-plugins status <pluginCid>`

Read verb (no password). Summarizes publication state + reputation summary +
local-block flag, via the configured DiscoveryAPI.

```
jinn solver-plugins status <pluginCid>
```

Also useful: `jinn solver-plugins discover [--solver-type <id>] [--builder <agentId>]`
and the explorer `/explore?filter[plugin]=…` curve. For a learning plug-in,
the held-out exam (#824) is the honest "did it improve anything" signal.
