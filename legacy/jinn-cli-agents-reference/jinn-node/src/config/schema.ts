/**
 * Zod schemas for jinn.yaml configuration sections.
 *
 * All keys use snake_case (matching YAML convention).
 * The loader transforms to camelCase for the TypeScript API.
 */
import { z } from 'zod';

export type WorkerMechFilterMode = 'any' | 'list' | 'single' | 'staking';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Boolean coercion that correctly handles string values from YAML and env vars.
 * z.coerce.boolean() treats any non-empty string (including 'false') as true,
 * so we need custom logic.
 */
const boolCoerce = z.union([z.boolean(), z.string(), z.number()])
    .transform((val) => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val !== 0;
        const s = String(val).toLowerCase().trim();
        return s !== 'false' && s !== '0' && s !== '';
    });

// ============================================================================
// Section schemas
// ============================================================================

/** Blockchain network settings. */
export const chainSchema = z.object({
    chain_id: z.coerce.number().int().default(8453),
});

/** Worker polling, cycle counts, and operational flags. */
export const workerSchema = z.object({
    poll_base_ms: z.coerce.number().int().positive().default(30000),
    poll_max_ms: z.coerce.number().int().positive().default(300000),
    poll_backoff_factor: z.coerce.number().positive().default(1.5),
    checkpoint_cycles: z.coerce.number().int().positive().default(60),
    heartbeat_cycles: z.coerce.number().int().positive().default(5),
    venture_watcher_cycles: z.coerce.number().int().positive().default(3),
    fund_check_cycles: z.coerce.number().int().positive().default(120),
    repost_check_cycles: z.coerce.number().int().positive().default(10),
    multi_service: boolCoerce.default(false),
    activity_poll_ms: z.coerce.number().int().positive().default(60000),
    activity_cache_ttl_ms: z.coerce.number().int().positive().default(60000),
    staking_refresh_ms: z.coerce.number().int().positive().default(300000),
    /** Which mechs to claim from: 'any'=all, 'list'=explicit list, 'single'=own only, 'staking'=same staking contract */
    mech_filter_mode: z.enum(['any', 'list', 'single', 'staking']).default('staking'),
    auto_restake: boolCoerce.default(true),
    tx_confirmations: z.coerce.number().int().positive().default(3),
    job_delay_ms: z.coerce.number().int().nonnegative().default(0),
    /** 0 = run forever; >0 = exit after N poll cycles */
    max_cycles: z.coerce.number().int().nonnegative().default(0),
    /** 0 = disabled; >0 = exit if no new work claimed for N cycles */
    stuck_exit_cycles: z.coerce.number().int().nonnegative().default(5),
    enable_venture_watcher: boolCoerce.default(false),
    enable_auto_repost: boolCoerce.default(false),
    /** If true, only process heartbeat/buzz jobs — skip real workstreams */
    buzz_only: boolCoerce.default(false),
});

/** OLAS staking contract and program settings. */
export const stakingSchema = z.object({
    contract: z.string().default('0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488'),
    interval_ms_override: z.coerce.number().int().positive().optional(),
    program: z.string().default(''),
});

/** Job filtering — workstream/venture scoping and earning limits. */
export const filteringSchema = z.object({
    workstreams: z.array(z.string()).default([]),
    ventures: z.array(z.string()).default([]),
    venture_template_ids: z.array(z.string()).default([]),
    earning_schedule: z.string().default(''),
    earning_max_jobs: z.coerce.number().int().nonnegative().default(0),
    mech_filter_list: z.string().default(''),
    priority_mech: z.string().default(''),
    target_request_id: z.string().default(''),
    allowlist_config_path: z.string().default(''),
});

/** Agent subprocess settings — sandboxing, output limits, repetition detection. */
export const agentSchema = z.object({
    sandbox: z.enum(['sandbox-exec', 'docker', 'podman', 'false']).default('sandbox-exec'),
    max_stdout_size: z.coerce.number().int().positive().default(5242880),
    max_chunk_size: z.coerce.number().int().positive().default(102400),
    repetition_window: z.coerce.number().int().positive().default(20),
    repetition_threshold: z.coerce.number().int().positive().default(10),
    max_identical_chunks: z.coerce.number().int().positive().default(10),
    max_prompt_arg_bytes: z.coerce.number().int().positive().default(100000),
    additional_include_dirs: z.string().default(''),
    telemetry_dir: z.string().default(''),
});

/** Job dependency resolution — staleness, redispatch, and failure thresholds. */
export const dependenciesSchema = z.object({
    stale_ms: z.coerce.number().int().positive().default(7200000),
    redispatch_cooldown_ms: z.coerce.number().int().positive().default(3600000),
    missing_fail_ms: z.coerce.number().int().positive().default(7200000),
    cancel_cooldown_ms: z.coerce.number().int().positive().default(3600000),
    redispatch: boolCoerce.default(false),
    autofail: boolCoerce.default(true),
});

/** Staking heartbeat throttling. */
export const heartbeatSchema = z.object({
    min_interval_sec: z.coerce.number().int().positive().default(60),
});

/** External service URLs and connection settings. */
export const servicesSchema = z.object({
    ponder_url: z.string().default('https://indexer.jinn.network/graphql'),
    ponder_port: z.coerce.number().int().positive().default(42069),
    ponder_start_block: z.coerce.number().int().nonnegative().optional(),
    ponder_end_block: z.coerce.number().int().nonnegative().optional(),
    control_api_url: z.string().default('https://control-api-production-c1f5.up.railway.app/graphql'),
    control_api_port: z.coerce.number().int().positive().optional(),

    use_control_api: boolCoerce.default(true),
    ipfs_gateway_url: z.string().default('https://gateway.autonolas.tech/ipfs/'),
    ipfs_fetch_timeout_ms: z.coerce.number().int().positive().default(30000),
    healthcheck_port: z.coerce.number().int().positive().default(8080),
    ponder_index_poll_count: z.coerce.number().int().positive().default(3),
    ponder_index_poll_delay_ms: z.coerce.number().int().positive().default(500),
});

/** Git and GitHub integration settings. */
export const gitSchema = z.object({
    default_base_branch: z.string().default('main'),
    remote_name: z.string().default('origin'),
    github_api_url: z.string().default('https://api.github.com'),
    github_repository: z.string().default(''),
    ssh_host_alias: z.string().default(''),
    workspace_dir: z.string().default(''),
    repo_root: z.string().default(''),
    author_name: z.string().default('Jinn Worker'),
    author_email: z.string().default('worker@jinn.network'),
});

/** Logging output configuration. */
export const loggingSchema = z.object({
    level: z.enum(['error', 'warn', 'info', 'debug', 'trace', 'fatal']).default('info'),
    format: z.enum(['json', 'pretty']).default('pretty'),
    mcp_level: z.enum(['error', 'warn', 'info', 'debug']).default('error'),
    destination: z.string().default('stdout'),
});

/** Prompt builder feature flags — controls which context providers are active. */
export const blueprintSchema = z.object({
    enable_system: boolCoerce.default(true),
    enable_context_assertions: boolCoerce.default(true),
    enable_recognition: boolCoerce.default(false),
    enable_job_context: boolCoerce.default(true),
    enable_progress: boolCoerce.default(false),
    enable_beads: boolCoerce.default(false),
    enable_context_phases: boolCoerce.default(false),
    debug: boolCoerce.default(false),
    log_providers: boolCoerce.default(false),
});

/** LLM quota checking and backoff settings. */
export const llmSchema = z.object({
    quota_check_model: z.string().default(''),
    quota_check_timeout_ms: z.coerce.number().int().positive().optional(),
    quota_backoff_ms: z.coerce.number().int().positive().optional(),
    quota_max_backoff_ms: z.coerce.number().int().positive().optional(),
});

/** Umami analytics integration. */
export const blogSchema = z.object({
    umami_host: z.string().default(''),
    umami_website_id: z.string().default(''),
});

/** Development and testing flags — not for production operators. */
export const devSchema = z.object({
    node_env: z.enum(['development', 'production', 'test']).default('development'),
    runtime_environment: z.enum(['default', 'test', 'review']).default('default'),
    dry_run: boolCoerce.default(false),
    disable_sts_checks: boolCoerce.default(false),

    mcp_debug_mech_client: boolCoerce.default(false),
    use_tsx_mcp: boolCoerce.default(false),
    enable_transaction_executor: boolCoerce.default(false),
    worker_id: z.string().default(''),
});

/** Playwright browser automation settings (used by web-scraping tools). */
export const playwrightSchema = z.object({
    channel: z.string().default(''),
    fast: boolCoerce.default(false),
    headless: boolCoerce.default(true),
    keep_open: boolCoerce.default(false),
    profile_dir: z.string().default(''),
});

// ============================================================================
// Combined config schema
// ============================================================================

export const configSchema = z.object({
    chain: chainSchema.default({}),
    worker: workerSchema.default({}),
    staking: stakingSchema.default({}),
    filtering: filteringSchema.default({}),
    agent: agentSchema.default({}),
    dependencies: dependenciesSchema.default({}),
    heartbeat: heartbeatSchema.default({}),
    services: servicesSchema.default({}),
    git: gitSchema.default({}),
    logging: loggingSchema.default({}),
    blueprint: blueprintSchema.default({}),
    llm: llmSchema.default({}),
    blog: blogSchema.default({}),
    dev: devSchema.default({}),
    playwright: playwrightSchema.default({}),
});

/**
 * Raw config type — uses snake_case keys matching YAML.
 * The loader transforms these to camelCase for the public TypeScript API.
 */
export type RawNodeConfig = z.infer<typeof configSchema>;

// ============================================================================
// Derived camelCase type
// ============================================================================

/** Convert a snake_case string literal to camelCase at the type level. */
type SnakeToCamel<S extends string> = S extends `${infer T}_${infer U}`
    ? `${T}${Capitalize<SnakeToCamel<U>>}`
    : S;

/** Recursively transform all keys of T from snake_case to camelCase. */
type CamelCaseKeys<T> = T extends readonly (infer U)[]
    ? CamelCaseKeys<U>[]
    : T extends object
    ? { [K in keyof T as K extends string ? SnakeToCamel<K> : K]: CamelCaseKeys<T[K]> }
    : T;

/**
 * Public API config type with camelCase keys — derived from the Zod schema.
 * Never manually duplicated; always in sync with RawNodeConfig.
 */
export type NodeConfig = CamelCaseKeys<RawNodeConfig>;
