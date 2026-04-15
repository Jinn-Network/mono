/**
 * Legacy env var → config path mapping.
 *
 * Maps canonical and legacy environment variable names to their location
 * in the YAML config structure. Used by the loader to apply env var overrides
 * on top of YAML values.
 *
 * Priority: first matching canonical name wins when the same config key
 * is targeted by multiple env vars.
 */

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
type PartialConfig = DeepPartial<import('./schema.js').RawNodeConfig>;

interface AliasEntry {
    /** Env var name */
    env: string;
    /** Dot-path into config object, e.g. 'chain.rpc_url' */
    path: string;
    /** Lower priority = checked first. Canonical names have priority 0. */
    priority: number;
    /** If true, split comma-separated env value into an array. */
    isArray?: boolean;
}

/**
 * Complete alias table mapping env vars to config paths.
 * Ordered: canonical names first (priority 0), legacy aliases after (priority 1+).
 */
const ALIAS_TABLE: AliasEntry[] = [
    // chain
    { env: 'CHAIN_ID', path: 'chain.chain_id', priority: 0 },

    // worker
    { env: 'WORKER_POLL_BASE_MS', path: 'worker.poll_base_ms', priority: 0 },
    { env: 'WORKER_POLL_MAX_MS', path: 'worker.poll_max_ms', priority: 0 },
    { env: 'WORKER_POLL_BACKOFF_FACTOR', path: 'worker.poll_backoff_factor', priority: 0 },
    { env: 'WORKER_CHECKPOINT_CYCLES', path: 'worker.checkpoint_cycles', priority: 0 },
    { env: 'WORKER_HEARTBEAT_CYCLES', path: 'worker.heartbeat_cycles', priority: 0 },
    { env: 'WORKER_VENTURE_WATCHER_CYCLES', path: 'worker.venture_watcher_cycles', priority: 0 },
    { env: 'WORKER_FUND_CHECK_CYCLES', path: 'worker.fund_check_cycles', priority: 0 },
    { env: 'WORKER_REPOST_CHECK_CYCLES', path: 'worker.repost_check_cycles', priority: 0 },
    { env: 'WORKER_MULTI_SERVICE', path: 'worker.multi_service', priority: 0 },
    { env: 'WORKER_ACTIVITY_POLL_MS', path: 'worker.activity_poll_ms', priority: 0 },
    { env: 'WORKER_ACTIVITY_CACHE_TTL_MS', path: 'worker.activity_cache_ttl_ms', priority: 0 },
    { env: 'WORKER_STAKING_REFRESH_MS', path: 'worker.staking_refresh_ms', priority: 0 },
    { env: 'WORKER_MECH_FILTER_MODE', path: 'worker.mech_filter_mode', priority: 0 },
    { env: 'AUTO_RESTAKE', path: 'worker.auto_restake', priority: 0 },
    { env: 'WORKER_TX_CONFIRMATIONS', path: 'worker.tx_confirmations', priority: 0 },
    { env: 'WORKER_JOB_DELAY_MS', path: 'worker.job_delay_ms', priority: 0 },
    { env: 'WORKER_MAX_CYCLES', path: 'worker.max_cycles', priority: 0 },
    { env: 'WORKER_STUCK_EXIT_CYCLES', path: 'worker.stuck_exit_cycles', priority: 0 },
    { env: 'ENABLE_VENTURE_WATCHER', path: 'worker.enable_venture_watcher', priority: 0 },
    { env: 'ENABLE_AUTO_REPOST', path: 'worker.enable_auto_repost', priority: 0 },
    { env: 'BUZZ_ONLY', path: 'worker.buzz_only', priority: 0 },

    // staking
    { env: 'WORKER_STAKING_CONTRACT', path: 'staking.contract', priority: 0 },
    { env: 'STAKING_CONTRACT', path: 'staking.contract', priority: 1 },
    { env: 'STAKING_INTERVAL_MS_OVERRIDE', path: 'staking.interval_ms_override', priority: 0 },
    { env: 'STAKING_PROGRAM', path: 'staking.program', priority: 0 },

    // filtering
    { env: 'WORKSTREAM_FILTER', path: 'filtering.workstreams', priority: 0, isArray: true },
    { env: 'VENTURE_FILTER', path: 'filtering.ventures', priority: 0, isArray: true },
    { env: 'VENTURE_TEMPLATE_IDS', path: 'filtering.venture_template_ids', priority: 0, isArray: true },
    { env: 'EARNING_SCHEDULE', path: 'filtering.earning_schedule', priority: 0 },
    { env: 'EARNING_MAX_JOBS', path: 'filtering.earning_max_jobs', priority: 0 },
    { env: 'WORKER_MECH_FILTER_LIST', path: 'filtering.mech_filter_list', priority: 0 },
    { env: 'PRIORITY_MECH', path: 'filtering.priority_mech', priority: 0 },
    { env: 'MECH_TARGET_REQUEST_ID', path: 'filtering.target_request_id', priority: 0 },
    { env: 'ALLOWLIST_CONFIG_PATH', path: 'filtering.allowlist_config_path', priority: 0 },

    // agent
    { env: 'GEMINI_SANDBOX', path: 'agent.sandbox', priority: 0 },
    { env: 'AGENT_MAX_STDOUT_SIZE', path: 'agent.max_stdout_size', priority: 0 },
    { env: 'AGENT_MAX_CHUNK_SIZE', path: 'agent.max_chunk_size', priority: 0 },
    { env: 'AGENT_REPETITION_WINDOW', path: 'agent.repetition_window', priority: 0 },
    { env: 'AGENT_REPETITION_THRESHOLD', path: 'agent.repetition_threshold', priority: 0 },
    { env: 'AGENT_MAX_IDENTICAL_CHUNKS', path: 'agent.max_identical_chunks', priority: 0 },
    { env: 'AGENT_MAX_PROMPT_ARG_BYTES', path: 'agent.max_prompt_arg_bytes', priority: 0 },
    { env: 'GEMINI_ADDITIONAL_INCLUDE_DIRS', path: 'agent.additional_include_dirs', priority: 0 },
    { env: 'JINN_TELEMETRY_DIR', path: 'agent.telemetry_dir', priority: 0 },

    // dependencies
    { env: 'WORKER_DEPENDENCY_STALE_MS', path: 'dependencies.stale_ms', priority: 0 },
    { env: 'WORKER_DEPENDENCY_REDISPATCH_COOLDOWN_MS', path: 'dependencies.redispatch_cooldown_ms', priority: 0 },
    { env: 'WORKER_DEPENDENCY_MISSING_FAIL_MS', path: 'dependencies.missing_fail_ms', priority: 0 },
    { env: 'WORKER_DEPENDENCY_CANCEL_COOLDOWN_MS', path: 'dependencies.cancel_cooldown_ms', priority: 0 },
    { env: 'WORKER_DEPENDENCY_REDISPATCH', path: 'dependencies.redispatch', priority: 0 },
    { env: 'WORKER_DEPENDENCY_AUTOFAIL', path: 'dependencies.autofail', priority: 0 },

    // heartbeat
    { env: 'HEARTBEAT_MIN_INTERVAL_SEC', path: 'heartbeat.min_interval_sec', priority: 0 },

    // services
    { env: 'PONDER_GRAPHQL_URL', path: 'services.ponder_url', priority: 0 },
    { env: 'PONDER_PORT', path: 'services.ponder_port', priority: 0 },
    { env: 'PONDER_START_BLOCK', path: 'services.ponder_start_block', priority: 0 },
    { env: 'PONDER_END_BLOCK', path: 'services.ponder_end_block', priority: 0 },
    { env: 'CONTROL_API_URL', path: 'services.control_api_url', priority: 0 },
    { env: 'CONTROL_API_PORT', path: 'services.control_api_port', priority: 0 },

    { env: 'USE_CONTROL_API', path: 'services.use_control_api', priority: 0 },
    { env: 'IPFS_GATEWAY_URL', path: 'services.ipfs_gateway_url', priority: 0 },
    { env: 'IPFS_FETCH_TIMEOUT_MS', path: 'services.ipfs_fetch_timeout_ms', priority: 0 },
    { env: 'HEALTHCHECK_PORT', path: 'services.healthcheck_port', priority: 0 },
    { env: 'PONDER_INDEX_POLL_COUNT', path: 'services.ponder_index_poll_count', priority: 0 },
    { env: 'PONDER_INDEX_POLL_DELAY_MS', path: 'services.ponder_index_poll_delay_ms', priority: 0 },

    // git
    { env: 'CODE_METADATA_DEFAULT_BASE_BRANCH', path: 'git.default_base_branch', priority: 0 },
    { env: 'CODE_METADATA_REMOTE_NAME', path: 'git.remote_name', priority: 0 },
    { env: 'GITHUB_API_URL', path: 'git.github_api_url', priority: 0 },
    { env: 'GITHUB_REPOSITORY', path: 'git.github_repository', priority: 0 },
    { env: 'GIT_SSH_HOST_ALIAS', path: 'git.ssh_host_alias', priority: 0 },
    { env: 'JINN_WORKSPACE_DIR', path: 'git.workspace_dir', priority: 0 },
    { env: 'CODE_METADATA_REPO_ROOT', path: 'git.repo_root', priority: 0 },
    { env: 'JINN_REPO_ROOT', path: 'git.repo_root', priority: 1 },
    { env: 'GIT_AUTHOR_NAME', path: 'git.author_name', priority: 0 },
    { env: 'GIT_AUTHOR_EMAIL', path: 'git.author_email', priority: 0 },

    // logging
    { env: 'LOG_LEVEL', path: 'logging.level', priority: 0 },
    { env: 'LOG_FORMAT', path: 'logging.format', priority: 0 },
    { env: 'MCP_LOG_LEVEL', path: 'logging.mcp_level', priority: 0 },
    { env: 'LOG_DESTINATION', path: 'logging.destination', priority: 0 },

    // blueprint
    { env: 'BLUEPRINT_ENABLE_SYSTEM', path: 'blueprint.enable_system', priority: 0 },
    { env: 'BLUEPRINT_ENABLE_CONTEXT_ASSERTIONS', path: 'blueprint.enable_context_assertions', priority: 0 },
    { env: 'BLUEPRINT_ENABLE_RECOGNITION', path: 'blueprint.enable_recognition', priority: 0 },
    { env: 'BLUEPRINT_ENABLE_JOB_CONTEXT', path: 'blueprint.enable_job_context', priority: 0 },
    { env: 'BLUEPRINT_ENABLE_PROGRESS', path: 'blueprint.enable_progress', priority: 0 },
    { env: 'BLUEPRINT_ENABLE_BEADS', path: 'blueprint.enable_beads', priority: 0 },
    { env: 'BLUEPRINT_ENABLE_CONTEXT_PHASES', path: 'blueprint.enable_context_phases', priority: 0 },
    { env: 'BLUEPRINT_BUILDER_DEBUG', path: 'blueprint.debug', priority: 0 },
    { env: 'BLUEPRINT_LOG_PROVIDERS', path: 'blueprint.log_providers', priority: 0 },

    // llm
    { env: 'GEMINI_QUOTA_CHECK_MODEL', path: 'llm.quota_check_model', priority: 0 },
    { env: 'GEMINI_QUOTA_CHECK_TIMEOUT_MS', path: 'llm.quota_check_timeout_ms', priority: 0 },
    { env: 'GEMINI_QUOTA_BACKOFF_MS', path: 'llm.quota_backoff_ms', priority: 0 },
    { env: 'GEMINI_QUOTA_MAX_BACKOFF_MS', path: 'llm.quota_max_backoff_ms', priority: 0 },

    // blog
    { env: 'UMAMI_HOST', path: 'blog.umami_host', priority: 0 },
    { env: 'UMAMI_WEBSITE_ID', path: 'blog.umami_website_id', priority: 0 },

    // dev
    { env: 'NODE_ENV', path: 'dev.node_env', priority: 0 },
    { env: 'RUNTIME_ENVIRONMENT', path: 'dev.runtime_environment', priority: 0 },
    { env: 'DRY_RUN', path: 'dev.dry_run', priority: 0 },
    { env: 'DISABLE_STS_CHECKS', path: 'dev.disable_sts_checks', priority: 0 },

    { env: 'MCP_DEBUG_MECH_CLIENT', path: 'dev.mcp_debug_mech_client', priority: 0 },
    { env: 'USE_TSX_MCP', path: 'dev.use_tsx_mcp', priority: 0 },
    { env: 'ENABLE_TRANSACTION_EXECUTOR', path: 'dev.enable_transaction_executor', priority: 0 },
    { env: 'WORKER_ID', path: 'dev.worker_id', priority: 0 },

    // playwright
    { env: 'PLAYWRIGHT_CHANNEL', path: 'playwright.channel', priority: 0 },
    { env: 'PLAYWRIGHT_FAST', path: 'playwright.fast', priority: 0 },
    { env: 'PLAYWRIGHT_HEADLESS', path: 'playwright.headless', priority: 0 },
    { env: 'PLAYWRIGHT_KEEP_OPEN', path: 'playwright.keep_open', priority: 0 },
    { env: 'PLAYWRIGHT_PROFILE_DIR', path: 'playwright.profile_dir', priority: 0 },
];

/**
 * Set a value at a dot-path in a nested object, creating intermediate objects as needed.
 */
function setPath(obj: Record<string, any>, path: string, value: string, isArray?: boolean): void {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current)) {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    // Only set if not already set (canonical wins over legacy)
    if (!(lastKey in current)) {
        if (isArray) {
            current[lastKey] = value.split(',').map(s => s.trim()).filter(Boolean);
        } else {
            current[lastKey] = value;
        }
    }
}

/**
 * Build a partial config object from env vars using the alias table.
 * Canonical names take priority over legacy aliases.
 */
export function resolveEnvOverrides(env: Record<string, string | undefined>): PartialConfig {
    const result: Record<string, any> = {};

    // Sort by priority so canonical names (priority 0) are processed first
    const sorted = [...ALIAS_TABLE].sort((a, b) => a.priority - b.priority);

    for (const entry of sorted) {
        const value = env[entry.env];
        if (value !== undefined && value !== '') {
            setPath(result, entry.path, value, entry.isArray);
        }
    }

    return result as PartialConfig;
}

/**
 * Export the alias table for introspection (startup summary, docs).
 */
export { ALIAS_TABLE };
