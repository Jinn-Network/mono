---
title: Environment Variables Reference
purpose: reference
scope: [worker, gemini-agent, frontend, deployment]
last_verified: 2026-03-02
related_code:
  - config/schema.ts
  - config/loader.ts
  - config/secrets.ts
  - config/context.ts
  - config/aliases.ts
  - env/operate-profile.ts
  - control-api/server.ts
keywords: [environment, config, env vars, secrets, configuration, jinn.yaml]
when_to_read: "When configuring services or looking up configuration options"
---

# Configuration Reference

> **Architecture:** Operator config lives in `jinn.yaml` (auto-generated on first run). Secrets stay in `.env`. Legacy env var names work as overrides.

## Secrets (.env)

These are sensitive values that should **never** be in `jinn.yaml` or committed to git.

### Required

| Variable | Type | Description |
|----------|------|-------------|
| `RPC_URL` | URL | Primary RPC endpoint. Legacy aliases: `MECHX_CHAIN_RPC`, `MECH_RPC_HTTP_URL`, `BASE_RPC_URL` |
| `OPERATE_PASSWORD` | string | Middleware keystore password |

### LLM Authentication (one required)

| Variable | Type | Description |
|----------|------|-------------|
| `GEMINI_API_KEY` | string | Google Gemini API key |
| `GEMINI_OAUTH_CREDENTIALS` | JSON | OAuth creds array (advanced, for rotation) |

Or authenticate via Gemini CLI: `npx @google/gemini-cli auth login`

### Strongly Encouraged

| Variable | Type | Description |
|----------|------|-------------|
| `GITHUB_TOKEN` | string | GitHub PAT for repository operations |
| `GIT_AUTHOR_NAME` | string | Git commit identity |
| `GIT_AUTHOR_EMAIL` | email | Git commit identity |

### Optional Secrets

| Variable | Type | Description |
|----------|------|-------------|
| `OPENAI_API_KEY` | string | OpenAI API key |
| `SUPABASE_URL` | URL | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | string | Full access key |
| `SUPABASE_SERVICE_ANON_KEY` | string | Limited access key |
| `CIVITAI_API_KEY` | string | Civitai API key |
| `ZORA_API_KEY` | string | Zora API key |
| `MOLTBOOK_API_KEY` | string | Moltbook API key |
| `X402_GATEWAY_URL` | URL | Credential bridge URL |
| `TENDERLY_ACCESS_KEY` | string | Tenderly VNet testing |
| `TENDERLY_ACCOUNT_SLUG` | string | Tenderly account |
| `TENDERLY_PROJECT_SLUG` | string | Tenderly project |
| `SNYK_TOKEN` | string | Snyk security scanning |
| `FUNDING_PRIVATE_KEY` | hex | Funding wallet key |

## Configuration (jinn.yaml)

`jinn.yaml` is auto-generated at the jinn-node root on first startup. Edit what you need. Every key can be overridden by env var using `JINN_<SECTION>_<KEY>` or legacy env var names.

### Chain

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `chain.chain_id` | number | `8453` | `CHAIN_ID` | Network ID (8453=Base mainnet) |

### Worker

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `worker.poll_base_ms` | number | `30000` | `WORKER_POLL_BASE_MS` | Base polling interval |
| `worker.poll_max_ms` | number | `300000` | `WORKER_POLL_MAX_MS` | Max idle polling interval |
| `worker.poll_backoff_factor` | number | `1.5` | `WORKER_POLL_BACKOFF_FACTOR` | Exponential backoff multiplier |
| `worker.checkpoint_cycles` | number | `60` | `WORKER_CHECKPOINT_CYCLES` | Staking checkpoint interval |
| `worker.heartbeat_cycles` | number | `16` | `WORKER_HEARTBEAT_CYCLES` | Heartbeat interval |
| `worker.venture_watcher_cycles` | number | `3` | `WORKER_VENTURE_WATCHER_CYCLES` | Venture watcher check interval |
| `worker.fund_check_cycles` | number | `120` | `WORKER_FUND_CHECK_CYCLES` | Balance check interval |
| `worker.repost_check_cycles` | number | `10` | `WORKER_REPOST_CHECK_CYCLES` | Repost check interval |
| `worker.multi_service` | boolean | `false` | `WORKER_MULTI_SERVICE` | Multiple services in .operate |
| `worker.activity_poll_ms` | number | `60000` | `WORKER_ACTIVITY_POLL_MS` | Activity polling interval |
| `worker.activity_cache_ttl_ms` | number | `60000` | `WORKER_ACTIVITY_CACHE_TTL_MS` | Activity cache TTL |
| `worker.staking_refresh_ms` | number | `300000` | `WORKER_STAKING_REFRESH_MS` | Staking cache refresh interval |
| `worker.mech_filter_mode` | enum | `staking` | `WORKER_MECH_FILTER_MODE` | `any` \| `list` \| `single` \| `staking` |
| `worker.auto_restake` | boolean | `true` | `AUTO_RESTAKE` | Auto-restake evicted services |
| `worker.tx_confirmations` | number | `3` | `WORKER_TX_CONFIRMATIONS` | Tx confirmations to wait |
| `worker.job_delay_ms` | number | `0` | `WORKER_JOB_DELAY_MS` | Delay between jobs |
| `worker.max_cycles` | number | `0` | `WORKER_MAX_CYCLES` | 0 = run forever; >0 = exit after N cycles |
| `worker.stuck_exit_cycles` | number | `0` | `WORKER_STUCK_EXIT_CYCLES` | 0 = disabled; >0 = exit if no new work for N cycles |
| `worker.enable_venture_watcher` | boolean | `false` | `ENABLE_VENTURE_WATCHER` | Enable venture watcher |
| `worker.enable_auto_repost` | boolean | `false` | `ENABLE_AUTO_REPOST` | Enable automatic reposting |
| `worker.buzz_only` | boolean | `false` | `BUZZ_ONLY` | Only process heartbeat/buzz jobs |

### Staking

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `staking.contract` | address | `0x66A9...9488` | `WORKER_STAKING_CONTRACT` | Staking contract address. Legacy: `STAKING_CONTRACT` |
| `staking.interval_ms_override` | number | — | `STAKING_INTERVAL_MS_OVERRIDE` | Override staking interval (optional) |
| `staking.program` | string | `""` | `STAKING_PROGRAM` | Staking program identifier |

### Filtering

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `filtering.workstreams` | string[] | `[]` | `WORKSTREAM_FILTER` | Workstream IDs, comma-separated (empty = all) |
| `filtering.ventures` | string[] | `[]` | `VENTURE_FILTER` | Venture IDs, comma-separated (empty = all) |
| `filtering.venture_template_ids` | string[] | `[]` | `VENTURE_TEMPLATE_IDS` | Template IDs, comma-separated |
| `filtering.earning_schedule` | string | `""` | `EARNING_SCHEDULE` | `HH:MM-HH:MM` (empty = always) |
| `filtering.earning_max_jobs` | number | `0` | `EARNING_MAX_JOBS` | 0 = unlimited |
| `filtering.mech_filter_list` | string | `""` | `WORKER_MECH_FILTER_LIST` | Explicit mech address list |
| `filtering.priority_mech` | string | `""` | `PRIORITY_MECH` | Priority mech address |
| `filtering.target_request_id` | string | `""` | `MECH_TARGET_REQUEST_ID` | Target a specific request |
| `filtering.allowlist_config_path` | string | `""` | `ALLOWLIST_CONFIG_PATH` | Path to allowlist config |

### Agent

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `agent.sandbox` | enum | `sandbox-exec` | `GEMINI_SANDBOX` | `sandbox-exec` \| `docker` \| `podman` \| `false` |
| `agent.max_stdout_size` | number | `5242880` | `AGENT_MAX_STDOUT_SIZE` | Max stdout (5MB) |
| `agent.max_chunk_size` | number | `102400` | `AGENT_MAX_CHUNK_SIZE` | Max output chunk size |
| `agent.repetition_window` | number | `20` | `AGENT_REPETITION_WINDOW` | Repetition detection window |
| `agent.repetition_threshold` | number | `10` | `AGENT_REPETITION_THRESHOLD` | Loop detection threshold |
| `agent.max_identical_chunks` | number | `10` | `AGENT_MAX_IDENTICAL_CHUNKS` | Max identical chunks before abort |
| `agent.max_prompt_arg_bytes` | number | `100000` | `AGENT_MAX_PROMPT_ARG_BYTES` | Max prompt argument size |
| `agent.additional_include_dirs` | string | `""` | `GEMINI_ADDITIONAL_INCLUDE_DIRS` | Extra sandbox include dirs |
| `agent.telemetry_dir` | string | `""` | `JINN_TELEMETRY_DIR` | Telemetry output directory |

### Dependencies

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `dependencies.stale_ms` | number | `7200000` | `WORKER_DEPENDENCY_STALE_MS` | Stale dep threshold (2h) |
| `dependencies.redispatch_cooldown_ms` | number | `3600000` | | Redispatch cooldown (1h) |
| `dependencies.missing_fail_ms` | number | `7200000` | | Auto-cancel threshold (2h) |
| `dependencies.redispatch` | boolean | `false` | `WORKER_DEPENDENCY_REDISPATCH` | Enable auto-redispatch |
| `dependencies.autofail` | boolean | `true` | `WORKER_DEPENDENCY_AUTOFAIL` | Auto-cancel missing deps |

### Services

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `services.ponder_url` | URL | `https://indexer.jinn.network/graphql` | `PONDER_GRAPHQL_URL` | Ponder GraphQL endpoint |
| `services.ponder_port` | number | `42069` | `PONDER_PORT` | Local Ponder port |
| `services.ponder_start_block` | number | — | `PONDER_START_BLOCK` | Ponder start block (optional) |
| `services.ponder_end_block` | number | — | `PONDER_END_BLOCK` | Ponder end block (optional) |
| `services.control_api_url` | URL | `https://control-api-production-c1f5.up.railway.app/graphql` | `CONTROL_API_URL` | Control API endpoint |
| `services.control_api_port` | number | — | `CONTROL_API_PORT` | Control API port (optional) |
| `services.use_control_api` | boolean | `true` | `USE_CONTROL_API` | Enable control API |
| `services.ipfs_gateway_url` | URL | `https://gateway.autonolas.tech/ipfs/` | `IPFS_GATEWAY_URL` | IPFS gateway |
| `services.ipfs_fetch_timeout_ms` | number | `30000` | `IPFS_FETCH_TIMEOUT_MS` | IPFS fetch timeout |
| `services.healthcheck_port` | number | `8080` | `HEALTHCHECK_PORT` | Healthcheck server port |
| `services.ponder_index_poll_count` | number | `3` | `PONDER_INDEX_POLL_COUNT` | Indexing lag poll retries |
| `services.ponder_index_poll_delay_ms` | number | `500` | `PONDER_INDEX_POLL_DELAY_MS` | Delay between index polls |

### Git

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `git.default_base_branch` | string | `main` | `CODE_METADATA_DEFAULT_BASE_BRANCH` | Default base branch |
| `git.remote_name` | string | `origin` | `CODE_METADATA_REMOTE_NAME` | Git remote name |
| `git.github_api_url` | URL | `https://api.github.com` | `GITHUB_API_URL` | GitHub API URL |

### Logging

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `logging.level` | enum | `info` | `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` \| `trace` \| `fatal` |
| `logging.format` | enum | `pretty` | `LOG_FORMAT` | `json` \| `pretty` |
| `logging.mcp_level` | enum | `error` | `MCP_LOG_LEVEL` | MCP server log level |
| `logging.destination` | string | `stdout` | `LOG_DESTINATION` | Log output destination |

### Blueprint

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `blueprint.enable_system` | boolean | `true` | `BLUEPRINT_ENABLE_SYSTEM` | Static system assertions |
| `blueprint.enable_context_assertions` | boolean | `true` | `BLUEPRINT_ENABLE_CONTEXT_ASSERTIONS` | Context assertions |
| `blueprint.enable_recognition` | boolean | `false` | `BLUEPRINT_ENABLE_RECOGNITION` | Similar job learnings |
| `blueprint.enable_job_context` | boolean | `true` | `BLUEPRINT_ENABLE_JOB_CONTEXT` | Job hierarchy context |
| `blueprint.enable_progress` | boolean | `false` | `BLUEPRINT_ENABLE_PROGRESS` | Progress checkpointing |
| `blueprint.enable_beads` | boolean | `false` | `BLUEPRINT_ENABLE_BEADS` | Beads issue tracking |
| `blueprint.enable_context_phases` | boolean | `false` | `BLUEPRINT_ENABLE_CONTEXT_PHASES` | Recognition/Reflection phases |
| `blueprint.debug` | boolean | `false` | `BLUEPRINT_BUILDER_DEBUG` | Debug logging |
| `blueprint.log_providers` | boolean | `false` | `BLUEPRINT_LOG_PROVIDERS` | Log provider activity |

### Heartbeat

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `heartbeat.min_interval_sec` | number | `60` | `HEARTBEAT_MIN_INTERVAL_SEC` | Minimum seconds between heartbeats |

### LLM

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `llm.quota_check_model` | string | `""` | `GEMINI_QUOTA_CHECK_MODEL` | Model for quota checks |
| `llm.quota_check_timeout_ms` | number | — | `GEMINI_QUOTA_CHECK_TIMEOUT_MS` | Quota check timeout (optional) |
| `llm.quota_backoff_ms` | number | — | `GEMINI_QUOTA_BACKOFF_MS` | Initial backoff on quota hit (optional) |
| `llm.quota_max_backoff_ms` | number | — | `GEMINI_QUOTA_MAX_BACKOFF_MS` | Max backoff on quota hit (optional) |

### Blog

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `blog.umami_host` | string | `""` | `UMAMI_HOST` | Umami analytics host |
| `blog.umami_website_id` | string | `""` | `UMAMI_WEBSITE_ID` | Umami website ID |

### Dev

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `dev.node_env` | enum | `development` | `NODE_ENV` | `development` \| `production` \| `test` |
| `dev.runtime_environment` | enum | `default` | `RUNTIME_ENVIRONMENT` | `default` \| `test` \| `review` |
| `dev.dry_run` | boolean | `false` | `DRY_RUN` | Log-only mode |
| `dev.disable_sts_checks` | boolean | `false` | `DISABLE_STS_CHECKS` | Disable STS safety checks |
| `dev.mcp_debug_mech_client` | boolean | `false` | `MCP_DEBUG_MECH_CLIENT` | Debug mech client in MCP |
| `dev.use_tsx_mcp` | boolean | `false` | `USE_TSX_MCP` | Use tsx for MCP subprocess |
| `dev.enable_transaction_executor` | boolean | `false` | `ENABLE_TRANSACTION_EXECUTOR` | Enable tx executor |
| `dev.worker_id` | string | `""` | `WORKER_ID` | Worker instance identifier |

### Playwright

| YAML Key | Type | Default | Env Override | Description |
|----------|------|---------|-------------|-------------|
| `playwright.channel` | string | `""` | `PLAYWRIGHT_CHANNEL` | Browser channel |
| `playwright.fast` | boolean | `false` | `PLAYWRIGHT_FAST` | Fast mode (skip waits) |
| `playwright.headless` | boolean | `true` | `PLAYWRIGHT_HEADLESS` | Run headless |
| `playwright.keep_open` | boolean | `false` | `PLAYWRIGHT_KEEP_OPEN` | Keep browser open after job |
| `playwright.profile_dir` | string | `""` | `PLAYWRIGHT_PROFILE_DIR` | Chrome profile directory |

## Service Profile (OLAS Operate)

These are resolved from `.operate/` at runtime, not from jinn.yaml:

| Variable | Type | Description |
|----------|------|-------------|
| `JINN_SERVICE_MECH_ADDRESS` | address | Override mech contract (falls back to `.operate`) |
| `JINN_SERVICE_SAFE_ADDRESS` | address | Override Safe (falls back to `.operate`) |
| `OPERATE_PROFILE_DIR` | path | Override `.operate` directory location |

### On-Chain Derived (Auto-Resolved)

These are **automatically derived** from `JINN_SERVICE_MECH_ADDRESS` + `RPC_URL` at worker startup. They no longer need to be set.

| Variable | Derived From | Description |
|----------|-------------|-------------|
| `WORKER_SERVICE_ID` | `mech.tokenId()` | OLAS service ID |
| `WORKER_STAKING_CONTRACT` | ServiceRegistry chain | Staking contract |
| `JINN_SERVICE_SAFE_ADDRESS` | `getService().multisig` | Gnosis Safe (fallback) |
| `MECH_MARKETPLACE_ADDRESS_BASE` | `mech.mechMarketplace()` | Marketplace contract |

## Runtime Context (JINN_CTX_*)

Set programmatically by the worker before each job execution. Not operator-configurable.

| Variable | Type | Description |
|----------|------|-------------|
| `JINN_CTX_REQUEST_ID` | string | Mech request ID |
| `JINN_CTX_MECH_ADDRESS` | address | Mech contract address |
| `JINN_CTX_JOB_DEFINITION_ID` | uuid | Job definition ID |
| `JINN_CTX_WORKSTREAM_ID` | string | Workstream context |
| `JINN_CTX_VENTURE_ID` | string | Venture context |
| `JINN_CTX_PARENT_REQUEST_ID` | string | Parent job's request ID |
| `JINN_CTX_BASE_BRANCH` | string | Git base branch |
| `JINN_CTX_BRANCH_NAME` | string | Git branch for this job |
| `JINN_CTX_COMPLETED_CHILDREN` | JSON | Completed child request IDs |
| `JINN_CTX_CHILD_WORK_REVIEWED` | boolean | Whether child work reviewed |
| `JINN_CTX_REQUIRED_TOOLS` | JSON | Required tools from template |
| `JINN_CTX_AVAILABLE_TOOLS` | JSON | Available tools from template |
| `JINN_CTX_BLUEPRINT_INVARIANT_IDS` | JSON | Blueprint invariant IDs |
| `JINN_CTX_ALLOWED_MODELS` | JSON | Allowed Gemini model names |
| `JINN_CTX_DEFAULT_MODEL` | string | Default model override |
| `JINN_CTX_INHERITED_ENV` | JSON | Inherited env from parent job |

## Other Environment Variables

| Variable | Type | Description |
|----------|------|-------------|
| `TEST_RPC_URL` | URL | Override RPC for testing |
| `JINN_CONFIG` | path | Override jinn.yaml location |
| `WORKER_STOP_FILE` | path | Inter-process stop signal file |
