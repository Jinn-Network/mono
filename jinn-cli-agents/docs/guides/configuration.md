# Configuration Guide

How the jinn-node configuration system works.

## Overview

Configuration flows through a pipeline:

```
jinn.yaml → env var overrides → Zod validation → frozen typed singleton
```

- **`jinn.yaml`** — operator-facing config file (auto-generated on first run)
- **`.env`** — secrets only (API keys, passwords, RPC URLs)
- **`config` singleton** — frozen, typed object available everywhere via `import { config } from '../config/index.js'`

## File Layout

```
src/config/
  schema.ts     — Zod schemas for each YAML section + derived NodeConfig type
  loader.ts     — YAML loading, env merge, Zod validation, snake→camel transform, freeze
  aliases.ts    — Env var → YAML path mapping (canonical + legacy names)
  secrets.ts    — Loads sensitive values from process.env (.env file)
  context.ts    — Per-job runtime context (JINN_CTX_* vars, in-memory)
  defaults.ts   — Auto-generates jinn.yaml with documented defaults
  index.ts      — Singleton exports: config, secrets, context functions
```

## Startup Flow

1. **Find `jinn.yaml`** — checks `JINN_CONFIG` env var, then walks up from CWD (max 5 levels)
2. **Auto-generate** — if no file found, writes default `jinn.yaml` to CWD
3. **Parse YAML** — reads file into a raw object
4. **Build env overrides** — scans `process.env` using the alias table (`aliases.ts`)
5. **Deep merge** — env overrides layered on top of YAML values
6. **Zod validate** — validates merged object, fills defaults for missing keys, coerces types
7. **Transform** — snake_case keys → camelCase for the TypeScript API
8. **Freeze** — deep-freeze the object to prevent runtime mutation

## Secrets vs Config

| Category | File | Committed? | Example |
|----------|------|-----------|---------|
| Config | `jinn.yaml` | Yes | `worker.poll_base_ms: 30000` |
| Secrets | `.env` | Never | `RPC_URL=https://...` |

**Rule:** If it contains an API key, password, or URL with embedded credentials, it goes in `.env`. Everything else goes in `jinn.yaml`.

Access in code:
```typescript
import { config, secrets } from '../config/index.js';

config.worker.pollBaseMs     // from jinn.yaml (or env override)
secrets.rpcUrl               // from .env
secrets.operatePassword      // from .env
```

## Env Var Overrides

Every YAML key can be overridden by an environment variable. The mapping is defined in `aliases.ts`. When both YAML and env var are set, **env var wins**.

Examples:
| Env Var | YAML Path | Notes |
|---------|-----------|-------|
| `CHAIN_ID` | `chain.chain_id` | |
| `WORKER_POLL_BASE_MS` | `worker.poll_base_ms` | |
| `WORKER_STAKING_CONTRACT` | `staking.contract` | Canonical name |
| `STAKING_CONTRACT` | `staking.contract` | Legacy alias (lower priority) |
| `WORKSTREAM_FILTER` | `filtering.workstreams` | Comma-separated → array |

When two env vars target the same config path (e.g., `WORKER_STAKING_CONTRACT` and `STAKING_CONTRACT`), the canonical name (priority 0) wins.

## Job Context (JINN_CTX_*)

Per-job runtime state is **not** part of `jinn.yaml`. It lives in memory and is managed by `context.ts`:

```typescript
import { setJobContext, getJobContext, clearJobContext } from '../config/index.js';

// Worker sets context before each job
setJobContext({ requestId: '0x...', mechAddress: '0x...' });

// MCP tools read it
const ctx = getJobContext();
ctx.requestId; // '0x...'

// Worker clears after job
clearJobContext();
```

For agent subprocesses, `writeContextToEnv()` serializes context to `JINN_CTX_*` env vars at spawn time. The agent reads them back with `readContextFromEnv()`.

## Adding a New Config Field

1. **Add to schema** (`schema.ts`):
   ```typescript
   export const workerSchema = z.object({
       // ... existing fields ...
       my_new_field: z.coerce.number().int().positive().default(5000),
   });
   ```

2. **Add env alias** (`aliases.ts`):
   ```typescript
   { env: 'WORKER_MY_NEW_FIELD', path: 'worker.my_new_field', priority: 0 },
   ```
   For array fields, add `isArray: true`.

3. **Use in code**:
   ```typescript
   import { config } from '../config/index.js';
   config.worker.myNewField; // number — auto-derived camelCase type
   ```

4. **Update docs** — add to `docs/reference/environment-variables.md`

The `NodeConfig` type is automatically derived from the Zod schema — no manual type duplication needed.

## YAML Sections

| Section | Purpose |
|---------|---------|
| `chain` | Blockchain network (chain ID) |
| `worker` | Polling intervals, cycle counts, feature flags |
| `staking` | Staking contract address, program |
| `filtering` | Workstream/venture filters, earning schedule |
| `agent` | Sandbox mode, stdout limits, repetition detection |
| `dependencies` | Dependency staleness, redispatch settings |
| `heartbeat` | Minimum heartbeat interval |
| `services` | Ponder, Control API, IPFS gateway URLs and ports |
| `git` | Branch defaults, SSH aliases, GitHub config |
| `logging` | Log level, format, destination |
| `blueprint` | Feature flags for prompt builder components |
| `llm` | Quota check model and backoff settings |
| `blog` | Umami analytics config |
| `dev` | Development flags (dry_run, node_env, etc.) |
| `playwright` | Browser automation settings |

See `docs/reference/environment-variables.md` for the complete field reference.
