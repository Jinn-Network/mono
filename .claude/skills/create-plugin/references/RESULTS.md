# create-plugin dry-run results

Captured live on 2026-06-14 against the built client (`cd operator && yarn build`).
Both scenarios were taken through scaffold → fill → validate (`ok:true`) →
load-probe (positive + negative). Publish and SolverNet-join were **not** run
(no chain writes, no funds). Temp dirs and `~/.jinn-client/solver-plugins/`
vendored dirs were cleaned up afterward.

Invocation form used: `node operator/dist/bin/jinn.js <args>` (the built binary).

---

## Scenario A — solver-type-plugin (`@jinn-dryrun/st`, `demo.v1`)

### 1. Scaffold

```
$ node operator/dist/bin/jinn.js create plugin @jinn-dryrun/st \
    --pattern solver-type-plugin --solver-type demo.v1 --out-dir "$DRY"
Created @jinn-dryrun/st at $DRY/@jinn-dryrun/st
Next: cd $DRY/@jinn-dryrun/st && yarn install && yarn test
Quickstart: https://github.com/Jinn-Network/mono/blob/next/client/docs/build/quickstart.md
```

### 2. Fill the placeholder

`skills/example/SKILL.md` shipped with one `placeholder` occurrence
(`grep -c placeholder` → `1`). After rewriting the frontmatter description and
body with real `demo.v1` content, `grep -c placeholder` → `0`.

### 3. Validate (`ok:true`)

```
$ node operator/dist/bin/jinn.js solver-plugins validate "$ST"
{"verb":"solver-plugins validate","ok":true,"plugin":{"name":"@jinn-dryrun/st","version":"0.1.0","solverType":"demo.v1","supports":["demo.v1"],"sha256":"ad45753f9457debeb07387a3896aef6219275f7a42ab6a5b5976577cb1d6cf0a","manifestPath":"/Users/.../.jinn-client/solver-plugins/st/jinn.plugin.json"}}
```

Note the `manifestPath` — validate materialized the plug-in into
`~/.jinn-client/solver-plugins/st/` (papercut #1052).

### 4. Load-probe (positive + negative)

```
$ node .claude/skills/create-plugin/references/load-probe.mjs "$ST" demo.v1
{"ok":true,"resolved":["@jinn-dryrun/st"],"target":"demo.v1"}    # exit 0

$ node .claude/skills/create-plugin/references/load-probe.mjs "$ST" bogus.v9
{"ok":false,"resolved":[],"target":"bogus.v9"}                   # exit 1
```

---

## Scenario B — runtime-plugin (`@jinn-dryrun/rt`, `jinn.runtime`)

### 1. Scaffold

```
$ node operator/dist/bin/jinn.js create plugin @jinn-dryrun/rt \
    --pattern runtime-plugin --out-dir "$DRYB"
Created @jinn-dryrun/rt at $DRYB/@jinn-dryrun/rt
```

(`--solver-type` is ignored for `runtime-plugin`; the manifest hard-codes
`supports: ["jinn.runtime"]`.)

### 2. Fill

Rewrote `jinn.plugin.json` `jinn.description` and the
`jinn.capabilities.tools` tool name to describe the real MCP tool. The
scaffolded `mcp/server.mjs` is already a working stub; left as-is for the
dry-run. Did **not** add `jinn.solverType` or `jinn.schemas` (validator
rejects them — see below).

### 3. Validate (`ok:true`)

```
$ node operator/dist/bin/jinn.js solver-plugins validate "$RT"
{"verb":"solver-plugins validate","ok":true,"plugin":{"name":"@jinn-dryrun/rt","version":"0.1.0","solverType":"jinn.runtime","supports":["jinn.runtime"],"sha256":"3e49703900c8deace6667dcd3a4f0cb4655aebc319e820194998f1d361a29101","manifestPath":"/Users/.../.jinn-client/solver-plugins/rt/jinn.plugin.json"}}
```

### 4. Load-probe (positive + negative)

```
$ node .claude/skills/create-plugin/references/load-probe.mjs "$RT" jinn.runtime
{"ok":true,"resolved":["@jinn-dryrun/rt"],"target":"jinn.runtime"}   # exit 0

$ node .claude/skills/create-plugin/references/load-probe.mjs "$RT" demo.v1
{"ok":false,"resolved":[],"target":"demo.v1"}                        # exit 1
```

---

## Validate-failure example (the loop the skill runs)

Adding the forbidden `jinn.solverType` key to a manifest makes validate fail
with a clear message the skill reads, fixes, and re-runs:

```
$ node operator/dist/bin/jinn.js solver-plugins validate "$BADP"
{"verb":"solver-plugins validate","ok":false,"error":{"code":"invalid_solver_plugin","message":"SolverNet contracts own canonical solverType and schemas; plugin manifests must declare manifest.jinn.supports only"}}
```
