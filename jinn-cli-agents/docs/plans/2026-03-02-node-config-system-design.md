---
title: Node Config System — Full Rewrite
date: 2026-03-02
status: approved
---

# Node Config System Design

Replace the scattered `process.env` config system with a typed `jinn.yaml` config file and a single `config` object import.

## Problem

- ~100+ env vars scattered across the codebase
- Defaults hidden as inline `parseInt(process.env.X || '30000')` in ~20 files
- Operators don't know what to configure — no single reference
- Validation is lazy (runs on first getter call, not at startup)
- Credential resolution has 3 priority sources with no startup summary
- Legacy env var aliases (`MECHX_CHAIN_RPC`, `MECH_RPC_HTTP_URL`, `BASE_RPC_URL` → `RPC_URL`) confuse operators

## Solution

### Config File: `jinn.yaml`

Lives in jinn-node repo root. Auto-generated with documented defaults on first startup if missing. Operators edit what they need.

```yaml
# jinn.yaml — Node operator configuration
# Auto-generated with defaults. Edit what you need.
# Secrets stay in .env (never committed).

chain:
  rpc_url: ""                      # REQUIRED — Base RPC endpoint
  chain_id: 8453                   # Base mainnet

worker:
  poll_base_ms: 30000
  poll_max_ms: 300000
  poll_backoff_factor: 1.5
  checkpoint_cycles: 60
  heartbeat_cycles: 16
  venture_watcher_cycles: 3
  fund_check_cycles: 120
  repost_check_cycles: 10
  multi_service: false
  activity_poll_ms: 60000
  activity_cache_ttl_ms: 60000
  staking_refresh_ms: 300000
  mech_filter_mode: "single"       # any | list | single | staking
  auto_restake: true
  tx_confirmations: 3
  job_delay_ms: 0

staking:
  contract: ""                     # Staking contract address

filtering:
  workstreams: []                  # Workstream IDs (empty = all)
  ventures: []                     # Venture IDs (empty = all)
  earning_schedule: ""             # "HH:MM-HH:MM" (empty = always)
  earning_max_jobs: 0              # 0 = unlimited

agent:
  sandbox: "sandbox-exec"          # sandbox-exec | docker | podman | false
  max_stdout_size: 5242880
  max_chunk_size: 102400
  repetition_window: 20
  repetition_threshold: 10
  max_identical_chunks: 10
  max_prompt_arg_bytes: 100000

dependencies:
  stale_ms: 7200000                # 2h
  redispatch_cooldown_ms: 3600000  # 1h
  missing_fail_ms: 7200000         # 2h
  cancel_cooldown_ms: 3600000      # 1h
  redispatch: false
  autofail: true

heartbeat:
  min_interval_sec: 60

services:
  ponder_url: "https://indexer.jinn.network/graphql"
  control_api_url: "https://control-api-production-c1f5.up.railway.app/graphql"
  ipfs_gateway_url: "https://gateway.autonolas.tech/ipfs/"
  ipfs_fetch_timeout_ms: 30000

git:
  default_base_branch: "main"
  remote_name: "origin"
  github_api_url: "https://api.github.com"
  ssh_host_alias: ""

logging:
  level: "info"                    # error | warn | info | debug
  format: "pretty"                # json | pretty
  mcp_level: "error"

blueprint:
  enable_system: true
  enable_context_assertions: true
  enable_recognition: false
  enable_job_context: true
  enable_progress: false
  enable_beads: false
  enable_context_phases: false
  debug: false
  log_providers: false
```

### Secrets: `.env`

Secrets stay in `.env`. The config loader reads `.env` for these only:

```bash
OPERATE_PASSWORD=...
GEMINI_API_KEY=...
GEMINI_OAUTH_CREDENTIALS=...
OPENAI_API_KEY=...
GITHUB_TOKEN=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
X402_GATEWAY_URL=...
CIVITAI_API_KEY=...
ZORA_API_KEY=...
MOLTBOOK_API_KEY=...
```

### API: `config` Object

Single import, typed, frozen at startup:

```typescript
import { config } from '../config/index.js';

// Property access — mirrors YAML structure
config.chain.rpcUrl        // string
config.worker.pollBaseMs   // number
config.agent.sandbox       // 'sandbox-exec' | 'docker' | 'podman' | 'false'
config.blueprint.enableBeads // boolean
config.services.ponderUrl  // string
```

### Architecture

```
src/config/
  schema.ts     — Zod schemas for each YAML section
  defaults.ts   — Default YAML content, auto-generation logic
  loader.ts     — YAML loading, .env secret loading, Zod validation
  aliases.ts    — Legacy env var → config path mapping (env overrides)
  index.ts      — Frozen config singleton, startup summary logger
```

**Startup flow:**

1. Find `jinn.yaml` in CWD or walk up to repo root
2. If missing → write default `jinn.yaml`, log "Generated jinn.yaml with defaults"
3. Parse YAML into config object
4. Load `.env` for secrets
5. Apply env var overrides (both canonical `JINN_*` and legacy names via alias table)
6. Validate merged config via Zod — fail fast with clear errors
7. Freeze config object, export singleton
8. Log startup summary: source of each key value (yaml/env/default)

**Env var overrides:** Every config key can be overridden by env var. Convention: `JINN_<SECTION>_<KEY>` in SCREAMING_SNAKE. Legacy env vars (`RPC_URL`, `WORKER_POLL_BASE_MS`, etc.) mapped via alias table for zero-effort migration.

### Runtime Context (JINN_CTX_*)

The ~20 `JINN_CTX_*` variables are NOT part of jinn.yaml — they are set programmatically per-job by the worker. They move to a separate `src/config/context.ts` module with typed getters.

### What Changes

**Clean break — no backwards compatibility layer.**

- All `process.env.X` reads → `config.section.key`
- All `getXxx()` function exports → deleted, replaced by `config.section.key`
- `src/env/index.ts` (dotenv bootstrap) → replaced by loader.ts
- `src/env/control.ts` → deleted (USE_CONTROL_API moves to yaml)
- Scattered `parseInt(process.env.X || 'default')` in mech_worker.ts, agent.ts, heartbeat.ts → deleted
- `.env.template` → trimmed to secrets only
- `.env.example` → trimmed to secrets only

### Migration Phases

**Phase 1: Build new config system**
- Create `schema.ts`, `defaults.ts`, `loader.ts`, `aliases.ts`
- Rewrite `index.ts` to export frozen `config` object
- Create `context.ts` for JINN_CTX_* runtime vars

**Phase 2: Migrate all call sites**
- Replace every `process.env.X` and `getXxx()` call with `config.section.key`
- File by file: mech_worker.ts, agent.ts, heartbeat.ts, epochGate.ts, etc.
- Each file independently testable

**Phase 3: Cleanup**
- Delete `env/index.ts`, `env/control.ts`
- Simplify `env/operate-profile.ts` (remove env var fallbacks that are now in YAML)
- Trim `.env.template` and `.env.example`
- Update skills, runbooks, deploy docs

**Phase 4: Testing**
- Unit tests for loader (YAML parsing, env override, validation errors)
- Integration tests for startup flow (missing yaml, invalid yaml, env overrides)
- E2E: existing test suite passes with jinn.yaml
