/**
 * Shared credential requirements for MCP tools.
 *
 * This is the single source of truth for bridge-backed tool credential routing.
 * Worker-side job filtering and CI verification both consume this mapping.
 */

export const CREDENTIAL_PROVIDER_ALLOWLIST = [
  'telegram',
  'twitter',
  'umami',
  'openai',
  'civitai',
  'supabase',
  'fireflies',
  'railway',
  'moltbook',
] as const;

export type CredentialProvider = (typeof CREDENTIAL_PROVIDER_ALLOWLIST)[number];

/**
 * Operator-level capabilities are local worker runtime capabilities
 * (not bridge-backed venture credentials).
 */
export const OPERATOR_CAPABILITY_ALLOWLIST = [
  'github',
] as const;

export type OperatorCapability = (typeof OPERATOR_CAPABILITY_ALLOWLIST)[number];

/**
 * Meta-tools in enabledTools that are not MCP server tool registrations but still
 * imply credential requirements for expansion/runtime.
 */
export const CREDENTIAL_META_TOOLS = [
  'telegram_messaging',
  'fireflies_meetings',
  'railway_deployment',
  'ventures_registry',
  'services_registry',
  'moltbook',
] as const;

/**
 * Maps tool names to required credential providers.
 * Provider names must match credential bridge provider names.
 */
export const TOOL_CREDENTIAL_REQUIREMENTS = {
  // Telegram tools
  telegram_send_message: ['telegram'],
  telegram_send_photo: ['telegram'],
  telegram_send_document: ['telegram'],

  // Twitter tools
  twitter_post_tweet: ['twitter'],
  twitter_get_mentions: ['twitter'],
  twitter_get_timeline: ['twitter'],

  // Blog analytics (Umami)
  blog_get_stats: ['umami'],
  blog_get_top_pages: ['umami'],
  blog_get_referrers: ['umami'],
  blog_get_metrics: ['umami'],
  blog_get_pageviews: ['umami'],
  blog_get_performance_summary: ['umami'],

  // OpenAI tools
  embed_text: ['openai'],
  search_similar_situations: ['openai'],

  // Civitai tools
  civitai_generate_image: ['civitai'],

  // Supabase-backed tools
  venture_mint: ['supabase'],
  venture_query: ['supabase'],
  venture_update: ['supabase'],
  venture_delete: ['supabase'],
  search_services: ['supabase'],
  service_registry: ['supabase'],

  // Moltbook tools
  moltbook_search: ['moltbook'],
  moltbook_get_feed: ['moltbook'],
  moltbook_get_submolt: ['moltbook'],
  moltbook_list_submolts: ['moltbook'],
  moltbook_subscribe: ['moltbook'],
  moltbook_create_post: ['moltbook'],
  moltbook_get_post: ['moltbook'],
  moltbook_create_comment: ['moltbook'],
  moltbook_upvote: ['moltbook'],
  moltbook_get_profile: ['moltbook'],

  // Meta-tools
  ventures_registry: ['supabase'],
  services_registry: ['supabase'],
  telegram_messaging: ['telegram'],
  fireflies_meetings: ['fireflies'],
  railway_deployment: ['railway'],
  moltbook: ['moltbook'],
} as const satisfies Record<string, readonly CredentialProvider[]>;

// Legacy alias used by existing tests/imports.
export const TOOL_CREDENTIAL_MAP = TOOL_CREDENTIAL_REQUIREMENTS;

/**
 * Maps tool names to operator-local capabilities.
 * These capabilities are discovered by worker-local probing (e.g. token validation),
 * not by credential bridge ACL.
 */
export const TOOL_OPERATOR_CAPABILITY_REQUIREMENTS = {
  get_file_contents: ['github'],
  search_code: ['github'],
  list_commits: ['github'],
  process_branch: ['github'],
} as const satisfies Record<string, readonly OperatorCapability[]>;

// Legacy-style alias for symmetry with bridge credential map usage.
export const TOOL_OPERATOR_CAPABILITY_MAP = TOOL_OPERATOR_CAPABILITY_REQUIREMENTS;

// High-risk invariants that must never regress.
const REQUIRED_SUPABASE_TOOL_MAP_KEYS = [
  'venture_mint',
  'venture_query',
  'venture_update',
  'venture_delete',
  'search_services',
  'service_registry',
  'ventures_registry',
  'services_registry',
] as const;

const REQUIRED_GITHUB_OPERATOR_TOOL_MAP_KEYS = [
  'get_file_contents',
  'search_code',
  'list_commits',
  'process_branch',
] as const;

for (const tool of REQUIRED_SUPABASE_TOOL_MAP_KEYS) {
  const providers = TOOL_CREDENTIAL_REQUIREMENTS[tool];
  if (!providers || !providers.includes('supabase')) {
    throw new Error(`TOOL_CREDENTIAL_REQUIREMENTS is missing required supabase mapping for "${tool}"`);
  }
}

for (const tool of REQUIRED_GITHUB_OPERATOR_TOOL_MAP_KEYS) {
  const capabilities = TOOL_OPERATOR_CAPABILITY_REQUIREMENTS[tool];
  if (!capabilities || !capabilities.includes('github')) {
    throw new Error(`TOOL_OPERATOR_CAPABILITY_REQUIREMENTS is missing required github mapping for "${tool}"`);
  }
}

/**
 * Resolve required providers for an enabledTools list.
 */
export function getRequiredCredentialProviders(enabledTools: string[]): CredentialProvider[] {
  const providers = new Set<CredentialProvider>();
  for (const tool of enabledTools) {
    const required = TOOL_CREDENTIAL_REQUIREMENTS[tool as keyof typeof TOOL_CREDENTIAL_REQUIREMENTS];
    if (!required) continue;
    for (const provider of required) {
      providers.add(provider);
    }
  }
  return [...providers];
}

/**
 * Resolve required operator capabilities for an enabledTools list.
 */
export function getRequiredOperatorCapabilities(enabledTools: string[]): OperatorCapability[] {
  const capabilities = new Set<OperatorCapability>();
  for (const tool of enabledTools) {
    const required = TOOL_OPERATOR_CAPABILITY_REQUIREMENTS[tool as keyof typeof TOOL_OPERATOR_CAPABILITY_REQUIREMENTS];
    if (!required) continue;
    for (const capability of required) {
      capabilities.add(capability);
    }
  }
  return [...capabilities];
}
