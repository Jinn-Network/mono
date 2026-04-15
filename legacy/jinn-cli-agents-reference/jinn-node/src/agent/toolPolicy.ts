/**
 * Centralized tool policy configuration
 * 
 * This module defines which tools are available to agents based on job configuration.
 * It handles both MCP tool inclusion/exclusion and CLI native tool whitelisting.
 * 
 * Tool categories:
 * - Universal tools: Always available to all agents (MCP tools for job management, artifacts, etc.)
 * - Job-specific tools: Explicitly enabled by the job definition
 * - Native tools: File system and shell operations that require CLI whitelisting
 */

/**
 * Base universal tools available to all agents
 * These include job management, artifacts, search, and read-only file tools
 */
export const BASE_UNIVERSAL_TOOLS = [
  // MCP server tools (job management, artifacts, search)
  'list_tools',
  'get_details',
  'inspect_situation',
  'dispatch_new_job',
  'dispatch_existing_job',
  'create_artifact',
  'create_measurement',
  'search_jobs',
  'search_artifacts',
  'google_web_search',
  'web_fetch',
  // Read-only native file tools
  'list_directory',
  'read_file',
  'search_file_content',
  'glob',
  'read_many_files',
] as const;

function normalizeTools(tools?: string[] | null): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0);
}

export const ensureUniversalTools = (tools?: string[] | null): string[] => {
  const merged = [...normalizeTools(tools), ...BASE_UNIVERSAL_TOOLS];
  return Array.from(new Set(merged));
};


/**
 * Coding tools available only to coding jobs
 * These include git workflow and file write/edit operations
 */
export const CODING_UNIVERSAL_TOOLS = [
  'process_branch',
  'write_file',
  'replace',
  'run_shell_command',
  'write_todos'
] as const;

/**
 * Universal tools that every coding agent gets automatically
 * For artifact-only jobs, use BASE_UNIVERSAL_TOOLS instead
 */
export const UNIVERSAL_TOOLS = [
  ...BASE_UNIVERSAL_TOOLS,
  ...CODING_UNIVERSAL_TOOLS
] as const;

/**
 * All native/CLI tools that can be enabled/disabled per job.
 * These are the tools the Gemini CLI expects in its `coreTools` whitelist.
 */
export const NATIVE_TOOLS = [
  'list_directory',
  'read_file',
  'write_file',
  'search_file_content',
  'glob',
  'web_fetch',
  'google_web_search',
  'replace',
  'read_many_files',
  'run_shell_command',
  'save_memory',
  'write_todos',
] as const;

/**
 * Native tools that are always enabled regardless of job configuration
 * These are safe and essential for basic agent operation
 */
export const ALWAYS_ENABLED_NATIVE_TOOLS: readonly (typeof NATIVE_TOOLS[number])[] = [] as const;

/**
 * Chrome DevTools browser automation tools
 * All 26 tools are enabled as a single unit via the 'browser_automation' meta-tool
 * When an agent includes 'browser_automation' in enabledTools, the chrome-devtools MCP server is activated
 */
export const BROWSER_AUTOMATION_TOOLS = [
  // Input automation
  'click', 'drag', 'fill', 'fill_form', 'handle_dialog', 'hover', 'press_key', 'upload_file',
  // Navigation
  'close_page', 'list_pages', 'navigate_page', 'new_page', 'select_page', 'wait_for',
  // Emulation
  'emulate', 'resize_page',
  // Performance
  'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace',
  // Network
  'get_network_request', 'list_network_requests',
  // Debugging
  'evaluate_script', 'get_console_message', 'list_console_messages', 'take_screenshot', 'take_snapshot',
] as const;

/**
 * Check if browser automation is enabled in the tools list
 */
export function hasBrowserAutomation(enabledTools: string[]): boolean {
  return enabledTools.includes('browser_automation');
}

/**
 * @deprecated nano_banana is deprecated — Gemini CLI extension unreliable on Railway.
 */
export const NANO_BANANA_TOOLS = [] as const;

/**
 * @deprecated nano_banana is deprecated.
 */
export function hasNanoBanana(_enabledTools: string[]): boolean {
  return false;
}

/**
 * Check if ventures registry is enabled in the tools list
 */
export function hasVenturesRegistry(enabledTools: string[]): boolean {
  return enabledTools.includes('ventures_registry');
}

/**
 * Check if templates registry is enabled in the tools list
 */
export function hasTemplatesRegistry(enabledTools: string[]): boolean {
  return enabledTools.includes('templates_registry');
}

/**
 * Check if services registry is enabled in the tools list
 */
export function hasServicesRegistry(enabledTools: string[]): boolean {
  return enabledTools.includes('services_registry');
}

/**
 * Extension meta-tools that trigger workspace extension installation
 *
 * These are Gemini CLI extensions installed via `gemini extension install <url>`.
 * When an agent includes the meta-tool name in enabledTools:
 * 1. The extension is installed to GEMINI_HOME/extensions/<extensionName>/
 * 2. The meta-tool is expanded to its individual tools for MCP configuration
 * 3. excludedTools are added to settings.json to block unsafe tools
 */
/**
 * Ventures registry MCP tools
 * Full CRUD for ventures in the Jinn platform
 */
export const VENTURES_REGISTRY_TOOLS = [
  'venture_mint',
  'venture_query',
  'venture_update',
  'venture_delete',
] as const;

/**
 * Templates registry MCP tools
 * Full CRUD for reusable template definitions
 */
export const TEMPLATES_REGISTRY_TOOLS = [
  'template_create',
  'template_query',
  'template_update',
  'template_delete',
] as const;

/**
 * Services registry MCP tools
 * Full CRUD for services, deployments, interfaces, and docs
 */
export const SERVICES_REGISTRY_TOOLS = [
  'service_registry',
] as const;

export const EXTENSION_META_TOOLS = {
  browser_automation: {
    installUrl: 'https://github.com/nickmyatt/chrome-devtools-mcp',
    extensionName: 'chrome-devtools-mcp',
    requiredEnv: [],
    tools: [...BROWSER_AUTOMATION_TOOLS] as string[],
  },
  // nano_banana: deprecated — Gemini CLI extension unreliable on Railway
  workstream_analysis: {
    installUrl: 'local:gemini-extension',
    extensionName: 'jinn-extensions',
    requiredEnv: [] as readonly string[],
    tools: ['inspect_workstream', 'inspect_job_run', 'inspect_job'] as string[],
  },
  ventures_registry: {
    installUrl: 'local:gemini-extension',
    extensionName: 'jinn-extensions',
    requiredEnv: [] as readonly string[],
    tools: [...VENTURES_REGISTRY_TOOLS] as string[],
  },
  templates_registry: {
    installUrl: 'local:gemini-extension',
    extensionName: 'jinn-extensions',
    requiredEnv: [] as readonly string[],
    tools: [...TEMPLATES_REGISTRY_TOOLS] as string[],
  },
  services_registry: {
    installUrl: 'local:gemini-extension',
    extensionName: 'jinn-extensions',
    requiredEnv: [] as readonly string[],
    tools: [...SERVICES_REGISTRY_TOOLS] as string[],
  },
} as const;

export type ExtensionMetaTool = keyof typeof EXTENSION_META_TOOLS;

/**
 * Get all enabled extension meta-tools from the tools list
 */
export function getEnabledExtensions(enabledTools: string[]): ExtensionMetaTool[] {
  return (Object.keys(EXTENSION_META_TOOLS) as ExtensionMetaTool[])
    .filter(ext => enabledTools.includes(ext));
}

/**
 * Moltbook agent social network tools (custom MCP tools)
 * Requires MOLTBOOK_API_KEY env var
 */
export const MOLTBOOK_TOOLS = [
  'moltbook_search',
  'moltbook_get_feed',
  'moltbook_get_submolt',
  'moltbook_list_submolts',
  'moltbook_subscribe',
  'moltbook_create_post',
  'moltbook_get_post',
  'moltbook_create_comment',
  'moltbook_upvote',
  'moltbook_get_profile',
] as const;

/**
 * Check if moltbook is enabled in the tools list
 */
export function hasMoltbook(enabledTools: string[]): boolean {
  return enabledTools.includes('moltbook');
}

/**
 * Telegram messaging tools (custom MCP tools)
 * Reads chat_id from JINN_JOB_TELEGRAM_CHAT_ID payload env var
 */
export const TELEGRAM_TOOLS = [
  'telegram_send_message',
  'telegram_send_photo',
  'telegram_send_document',
  'telegram_get_updates',
] as const;

/**
 * Check if telegram messaging is enabled in the tools list
 */
export function hasTelegramMessaging(enabledTools: string[]): boolean {
  return enabledTools.includes('telegram_messaging');
}

/**
 * Content stream discovery and reading tools (custom MCP tools)
 * Used to discover and read FEED:* content streams between templates
 */
export const CONTENT_STREAM_TOOLS = [
  'search_content_streams',
  'read_content_stream',
] as const;

/**
 * Check if content streams are enabled in the tools list
 */
export function hasContentStreams(enabledTools: string[]): boolean {
  return enabledTools.includes('content_streams');
}

/**
 * Fireflies meeting intelligence tools (via remote MCP server)
 * Content-focused subset only — raw transcripts with speaker attribution are excluded for privacy
 */
export const FIREFLIES_TOOLS = [
  'fireflies_search',
  'fireflies_get_transcripts',
  'fireflies_get_summary',
] as const;

/**
 * Check if fireflies meetings is enabled in the tools list
 */
export function hasFirefliesMeetings(enabledTools: string[]): boolean {
  return enabledTools.includes('fireflies_meetings');
}

/**
 * Railway deployment tools (from @anthropic/railway-mcp)
 * Agent-safe subset: service management only, no project-level operations
 */
export const RAILWAY_TOOLS = [
  // Environment discovery (needed to get environmentId)
  'environment-list',
  'environment-info',
  'project_environments',
  // Service Management (within pre-created project)
  'service_list',
  'service_info',
  'service_create_from_repo',
  'service_create_from_image',
  'service_restart',
  'service_update',
  'service_delete',
  'template-deploy',
  // Domains (to get/create service URLs)
  'domain_list',
  'domain_create',
  'domain_check',
  // Variables
  'list_service_variables',
  'variable_set',
  'variable_delete',
  'variable_bulk_set',
  // Monitoring & Logs
  'deployment_list',
  'deployment_trigger',
  'deployment_logs',
  'deployment_status',
  'logs-deployment',
  // Database
  'database_list_types',
  'database_deploy_from_template',
] as const;

/**
 * Check if railway deployment is enabled in the tools list
 */
export function hasRailwayDeployment(enabledTools: string[]): boolean {
  return enabledTools.includes('railway_deployment');
}

/**
 * Get all excluded tools from enabled extensions
 */
export function getExtensionExcludedTools(enabledTools: string[]): string[] {
  const excludedTools: string[] = [];
  for (const metaTool of getEnabledExtensions(enabledTools)) {
    const config = EXTENSION_META_TOOLS[metaTool];
    if (config && 'excludedTools' in config) {
      excludedTools.push(...(config as { excludedTools: string[] }).excludedTools);
    }
  }
  return excludedTools;
}

/**
 * Result of tool policy computation
 */
export interface ToolPolicyResult {
  /** MCP tools to include (universal + job-specific, deduplicated) */
  mcpIncludeTools: string[];
  /** Native tools to exclude from MCP (tools not in the include list) */
  mcpExcludeTools: string[];
  /** Native tools to whitelist for CLI --allowed-tools flag */
  cliAllowedTools: string[];
}

/**
 * Tools that reflection agents should NOT have access to.
 * Reflection agents run without full job context (no requestId, workstreamId),
 * so they must not dispatch jobs which would create orphaned workstreams.
 */
export const REFLECTION_EXCLUDED_TOOLS = [
  'dispatch_new_job',      // Would create jobs without workstream context
  'dispatch_existing_job', // Would dispatch jobs without workstream context
  'google_web_search',     // Not needed for reflection, wastes time/tokens
  'web_fetch',             // Not needed for reflection, wastes time/tokens
] as const;

/**
 * Complete set of valid tool names that can appear in enabledTools from IPFS metadata.
 * Unknown tools are dropped with a warning to prevent arbitrary tool injection.
 *
 * ── Credential bridge (x402) tools ──────────────────────────────────
 * The following tools require credential bridge access and are NOT
 * available to external untrusted operators:
 *
 *  • Blog (umami/supabase): blog_get_stats, blog_get_top_pages,
 *    blog_get_referrers, blog_get_metrics, blog_get_pageviews,
 *    blog_get_performance_summary, blog_create_post, blog_list_posts,
 *    blog_get_post, blog_delete_post
 *  • Registry (supabase): venture_mint, venture_query, venture_update,
 *    venture_delete, template_create, template_query, template_update,
 *    template_delete, service_registry
 *  • Telegram: telegram_messaging (meta-tool)
 *  • Fireflies: fireflies_meetings (meta-tool)
 *  • Railway: railway_deployment (meta-tool)
 *  • Twitter: twitter_post_tweet, twitter_get_mentions, twitter_get_timeline
 *  • OpenAI: embed_text
 *  • Civitai: civitai_generate_image
 *  • Schedule: read_dispatch_schedule, update_dispatch_schedule
 *
 * When authoring blueprints, do NOT mark credentialled tools as
 * `required: true` — this blocks the entire workstream for external
 * operators. Use `required: false` instead so they remain available
 * when a trusted operator processes the job.
 */
export const VALID_JOB_TOOLS: ReadonlySet<string> = new Set([
  // Universal tools (always available)
  ...BASE_UNIVERSAL_TOOLS,
  ...CODING_UNIVERSAL_TOOLS,
  // Native CLI tools
  ...NATIVE_TOOLS,
  // Meta-tools (expand to individual tools)
  ...Object.keys(EXTENSION_META_TOOLS),
  'telegram_messaging',
  'railway_deployment',
  'fireflies_meetings',
  'content_streams',
  'nano_banana', // Deprecated but accepted (silently stripped later)
  // Individual tools from meta-tool expansions
  ...BROWSER_AUTOMATION_TOOLS,
  ...VENTURES_REGISTRY_TOOLS,
  ...TEMPLATES_REGISTRY_TOOLS,
  ...SERVICES_REGISTRY_TOOLS,
  ...TELEGRAM_TOOLS,
  ...FIREFLIES_TOOLS,
  ...RAILWAY_TOOLS,
  ...CONTENT_STREAM_TOOLS,
  // Dispatch schedule tools (venture orchestration)
  'read_dispatch_schedule',
  'update_dispatch_schedule',
  // Extension tools
  'inspect_workstream',
  'inspect_job_run',
  'inspect_job',
  // GitHub (operator-level: reads GITHUB_TOKEN from env)
  'get_file_contents',
  'search_code',
  'list_commits',
  // Blog analytics (blog-analytics.ts → getCredential('umami'))
  'blog_get_stats',
  'blog_get_top_pages',
  'blog_get_referrers',
  'blog_get_metrics',
  'blog_get_pageviews',
  'blog_get_performance_summary',
  // OpenAI (shared/openai.ts → getCredential('openai'))
  'embed_text',
  // Civitai (shared/civitai.ts → getCredential('civitai'))
  'civitai_generate_image',
  // Twitter (twitter-social.ts → getCredential('twitter'))
  'twitter_post_tweet',
  'twitter_get_mentions',
  'twitter_get_timeline',
  // Moltbook (moltbook.ts → getCredential('moltbook'))
  'moltbook',
  ...MOLTBOOK_TOOLS,
]);

/**
 * Compute tool policy for a job based on its enabled tools and job type
 *
 * @param jobEnabledTools - Tools explicitly enabled by the job definition (may be empty)
 * @param options - Configuration options including whether this is a coding job or reflection agent
 * @returns Tool policy result with MCP and CLI configurations
 */
export function computeToolPolicy(
  jobEnabledTools: string[] = [],
  options?: { isCodingJob?: boolean; isReflectionAgent?: boolean }
): ToolPolicyResult {
  // Determine if this is a coding job (default to true for backward compatibility)
  const isCodingJob = options?.isCodingJob !== false;
  const isReflectionAgent = options?.isReflectionAgent === true;

  // Select the appropriate universal tools based on job type
  const baseUniversalTools = isCodingJob
    ? UNIVERSAL_TOOLS
    : BASE_UNIVERSAL_TOOLS;

  // Filter out excluded tools for reflection agents
  const effectiveUniversalTools = isReflectionAgent
    ? baseUniversalTools.filter(t => !REFLECTION_EXCLUDED_TOOLS.includes(t as any))
    : baseUniversalTools;

  // Validate job-enabled tools against known set
  const validatedJobTools: string[] = [];
  for (const tool of jobEnabledTools) {
    if (VALID_JOB_TOOLS.has(tool)) {
      validatedJobTools.push(tool);
    } else {
      console.warn(`[toolPolicy] Dropping unknown tool from enabledTools: '${tool}'`);
    }
  }

  // Merge universal tools with validated job-specific tools
  const allTools = [...effectiveUniversalTools, ...validatedJobTools];

  // Expand browser_automation meta-tool to individual tools
  // This ensures chrome-devtools server receives actual tool names in includeTools
  let expandedTools = allTools;
  if (allTools.includes('browser_automation')) {
    expandedTools = [
      ...allTools.filter(t => t !== 'browser_automation'),
      ...BROWSER_AUTOMATION_TOOLS
    ];
  }

  // Expand extension meta-tools to their individual tools
  // This allows extension tools to be whitelisted in MCP includeTools
  for (const [metaTool, config] of Object.entries(EXTENSION_META_TOOLS)) {
    if (expandedTools.includes(metaTool) && config && typeof config === 'object' && 'tools' in config) {
      expandedTools = [
        ...expandedTools.filter(t => t !== metaTool),
        ...(config as { tools: string[] }).tools
      ];
    }
  }

  // Expand moltbook meta-tool to Moltbook MCP tools
  if (expandedTools.includes('moltbook')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'moltbook'),
      ...MOLTBOOK_TOOLS
    ];
  }

  // Expand telegram_messaging meta-tool to custom MCP tools
  if (expandedTools.includes('telegram_messaging')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'telegram_messaging'),
      ...TELEGRAM_TOOLS
    ];
  }

  // Expand railway_deployment meta-tool to Railway MCP tools
  if (expandedTools.includes('railway_deployment')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'railway_deployment'),
      ...RAILWAY_TOOLS
    ];
  }

  // Expand fireflies_meetings meta-tool to Fireflies MCP tools
  if (expandedTools.includes('fireflies_meetings')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'fireflies_meetings'),
      ...FIREFLIES_TOOLS
    ];
  }

  // Expand content_streams meta-tool to Content Stream MCP tools
  if (expandedTools.includes('content_streams')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'content_streams'),
      ...CONTENT_STREAM_TOOLS
    ];
  }

  // nano_banana: deprecated — silently strip from enabledTools
  expandedTools = expandedTools.filter(t => t !== 'nano_banana');

  // Expand ventures_registry meta-tool to Ventures MCP tools
  if (expandedTools.includes('ventures_registry')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'ventures_registry'),
      ...VENTURES_REGISTRY_TOOLS
    ];
  }

  // Expand services_registry meta-tool to Services MCP tools
  if (expandedTools.includes('services_registry')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'services_registry'),
      ...SERVICES_REGISTRY_TOOLS
    ];
  }

  const uniqueTools = [...new Set(expandedTools)];

  // MCP include: all tools the agent should have access to
  const mcpIncludeTools = uniqueTools;

  // MCP exclude: native tools that are NOT in the include list AND NOT always-enabled
  const nativeToolsToExclude = NATIVE_TOOLS.filter(tool =>
    !uniqueTools.includes(tool) && !ALWAYS_ENABLED_NATIVE_TOOLS.includes(tool)
  );

  // CLI allowed tools: native tools that ARE in the include list OR are always-enabled
  // These are the tools that need --allowed-tools flag for auto-approval
  // Note: Always-enabled tools must be included even if they're not in NATIVE_TOOLS
  const cliAllowedTools = [
    ...NATIVE_TOOLS.filter(tool => uniqueTools.includes(tool)),
    ...ALWAYS_ENABLED_NATIVE_TOOLS
  ];
  // Remove duplicates while preserving order
  const uniqueCliAllowedTools = [...new Set(cliAllowedTools)];

  return {
    mcpIncludeTools,
    mcpExcludeTools: nativeToolsToExclude,
    cliAllowedTools: uniqueCliAllowedTools
  };
}
