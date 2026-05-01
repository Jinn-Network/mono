# Path 1 manifest reference (`jinn-plugin.json`)

Every Path 1 plug-in ships a `jinn-plugin.json` at the root of its npm package. This doc is a field-by-field derivation of [`client/schemas/jinn-plugin-v1.json`](../../schemas/jinn-plugin-v1.json) — the JSON schema is the source of truth; if this doc and the schema disagree, the schema wins.

The manifest is validated three times: (1) at install time by `jinn plug-ins add`; (2) at session start when the learner walks `config.learnerPlugIns[]`; (3) by `loadPlugInManifest` whenever a tool consumes the file directly. The same ajv-compiled schema and the same error messages everywhere.

## Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | const `"1.0.0"` | yes | The plug-in manifest's own schema version. Phase A.2 ships `1.0.0`. Future bumps add a new schema file (`jinn-plugin-v2.json`) and accept both with a 12-week deprecation overlap. |
| `name` | string | yes | npm package identity. Pattern `^(@[a-z0-9-]+/)?[a-z0-9][a-z0-9-]*$`. MUST match `package.json`. |
| `version` | string | yes | semver. Pattern `^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$`. MUST match `package.json`. |
| `description` | string | no | Free-form, ≤500 chars. Surfaced in `jinn plug-ins list`. |
| `compatibility` | object | yes | See below. |
| `slots` | array | yes | At least one slot. See below. |
| `author` | object | no | `{ name?: string, url?: string }`. Surfaced in `jinn plug-ins show`. |
| `license` | string | no | SPDX identifier conventionally. |
| `homepage` | string (URI) | no | Surfaced in `jinn plug-ins show`. |

## `compatibility`

```jsonc
{
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0",
    "supportedKinds": ["prediction.v0", "prediction.apy.v0"]
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `claudeCodeLearner` | string | yes | semver range against the bundled learner package's version. Out-of-range plug-ins load with a warning (per `spec/2026-04-30-plug-in-surface.md` §4.4.5); operators see a fleet-status warning. |
| `supportedKinds` | string[] | no | Per `spec/2026-05-schema-versioning.md` grammar: `<domain>.v<major>` (pattern `^[a-z][a-z0-9-]*\.v[0-9]+$`). Declares which kinds the plug-in's slots apply to in the absence of a per-slot `scope.matchKinds`. |

Range examples: `">=0.1.0"`, `">=0.1.0 <0.2.0"`, `"^0.1.0"`.

## `slots[]`

Each entry is one of six slot shapes (see [slot-reference.md](./slot-reference.md) for material descriptions). The `oneOf` in the JSON schema dispatches by the `type` const.

### `phase-agent-override`

```jsonc
{
  "type": "phase-agent-override",
  "phase": "execute",
  "agent": "step-worker",
  "scope": { "matchKinds": ["prediction.v0"] },
  "entry": "agents/calibration-step-worker.md"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | const `"phase-agent-override"` | yes | |
| `phase` | enum | yes | One of `strategize`, `plan`, `execute`, `debrief`, `improve`, `memory-consolidation`. (Orient runs the bundled topic explorers; Orient overrides ship as `topic-explorer` slots.) |
| `agent` | enum | yes | One of `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator`. |
| `scope` | object | no | `{ matchKinds: string[] }`. Filters the override to matching intent kinds. |
| `entry` | string | yes | Path to the markdown agent within the package. Pattern `^[A-Za-z0-9_./-]+\.md$`. |

### `topic-explorer`

```jsonc
{
  "type": "topic-explorer",
  "phase": "orient",
  "topic": "news-context",
  "scope": { "matchKinds": ["prediction.v0"] },
  "entry": "agents/news-context-explorer.md"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | const `"topic-explorer"` | yes | |
| `phase` | enum | yes | `orient` or `debrief`. |
| `topic` | string | yes | Topic name. Pattern `^[a-z][a-z0-9-]*$`. |
| `scope` | object | no | Same shape as above. |
| `entry` | string | yes | Same pattern as above. |

### `mcp-tool`

```jsonc
{
  "type": "mcp-tool",
  "command": "node",
  "args": ["dist/server.js"],
  "namespace": "polymarket"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | const `"mcp-tool"` | yes | |
| `command` | string | yes | Spawn command for the MCP server. |
| `args` | string[] | yes | Args passed to `command`. |
| `namespace` | string | no | Optional tool-name prefix. Pattern `^[a-z][a-z0-9-]*$`. |

### `skill-bundle`

```jsonc
{
  "type": "skill-bundle",
  "skillsDir": "skills/",
  "scope": { "matchKinds": ["prediction.v0"] }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | const `"skill-bundle"` | yes | |
| `skillsDir` | string | yes | Directory holding `<name>/SKILL.md` files. Pattern `^[A-Za-z0-9_./-]+/?$`. |
| `scope` | object | no | Same shape. |

### `memory-backend`

```jsonc
{
  "type": "memory-backend",
  "command": "node",
  "args": ["dist/server.js"],
  "scope": { "matchKinds": ["prediction.v0"] }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | const `"memory-backend"` | yes | |
| `command` | string | yes | Spawn command for the memory MCP server. |
| `args` | string[] | yes | Args passed to `command`. |
| `scope` | object | no | Same shape. |

### `hook`

```jsonc
{
  "type": "hook",
  "event": "pre-phase",
  "phase": "orient",
  "entry": "hooks/prefetch-markets.sh",
  "scope": { "matchKinds": ["prediction.v0"] }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | const `"hook"` | yes | |
| `event` | enum | yes | One of `session-start`, `pre-phase`, `post-phase`, `session-end`. |
| `phase` | enum | no | One of the seven phases. Required only for `pre-phase` / `post-phase` events. |
| `entry` | string | yes | Path to the executable within the package. Pattern `^[A-Za-z0-9_./-]+$`. |
| `scope` | object | no | Same shape. |

## `scope`

```jsonc
{ "scope": { "matchKinds": ["prediction.v0", "prediction.apy.v0"] } }
```

| Field | Type | Notes |
|---|---|---|
| `matchKinds` | string[] | Per `spec/2026-05-schema-versioning.md` grammar. The slot is registered only for sessions whose intent kind intersects the array. Omitted → the slot applies for every kind the plug-in's `compatibility.supportedKinds` covers. |

## Validation

Three points of validation, same ajv schema, same error messages:

1. **`jinn plug-ins add @builder/<pkg>`** — installs the manifest into `~/.jinn-client/config.json` under `learnerPlugIns[]`. Refuses to add if the manifest fails the schema, if `name` / `version` mismatch `package.json`, or if a declared `entry` path doesn't exist.
2. **Session start** — `claude-code-learner` walks `config.learnerPlugIns[]`, re-reads each manifest, validates again, and registers slots into the session's slot registry. A failed validation excludes the plug-in for that session and surfaces a warning via `status.fleet.needsAttention`.
3. **Direct loader use** — internal code that reads a manifest (debug tooling, future fleet introspection) calls `loadPlugInManifest`, which runs the same ajv schema.

## JSON Schema source

[`client/schemas/jinn-plugin-v1.json`](../../schemas/jinn-plugin-v1.json) is the canonical definition. This doc is a derivation. When you're adding a new slot field or a new slot type, edit the schema first and let this doc follow.
