/**
 * Static Credential Providers
 *
 * Maps provider names to static API keys stored in the gateway's environment.
 * Used for credentials that are not OAuth tokens (GitHub PATs, Telegram bot tokens, etc.).
 *
 * The gateway holds these keys because it's a platform service with proper access control.
 * Agents never see the raw keys — they request tokens via the credential bridge,
 * which verifies signatures, checks ACL, enforces rate limits, and audits access.
 */

/** Result from a static credential lookup */
interface StaticCredentialResult {
  access_token: string;
  expires_in: number;
}

/**
 * Static key provider configuration.
 * Each entry maps a provider name to one or more env vars on the gateway.
 */
interface StaticProviderConfig {
  envVars: string[];  // env vars to check (first found wins)
  expiresIn: number;  // how long the client should cache (seconds)
}

const STATIC_PROVIDERS: Record<string, StaticProviderConfig> = {
  // github: operator-level credential — operators provide GITHUB_TOKEN in their .env directly.
  // Not served through the bridge.
  telegram: {
    envVars: ['TELEGRAM_BOT_TOKEN'],
    expiresIn: 3600,
  },
  civitai: {
    envVars: ['CIVITAI_API_TOKEN', 'CIVITAI_API_KEY'],
    expiresIn: 3600,
  },
  fireflies: {
    envVars: ['FIREFLIES_API_KEY'],
    expiresIn: 3600,
  },
  openai: {
    envVars: ['OPENAI_API_KEY'],
    expiresIn: 3600,
  },
  supabase: {
    envVars: ['SUPABASE_SERVICE_ROLE_KEY'],
    expiresIn: 3600,
  },
  railway: {
    envVars: ['RAILWAY_API_TOKEN'],
    expiresIn: 3600,
  },
  moltbook: {
    envVars: ['MOLTBOOK_API_KEY'],
    expiresIn: 3600,
  },
};

/**
 * Umami JWT cache (login-based provider)
 */
let umamiJwtCache: { token: string; expiresAt: number } | null = null;

async function getUmamiToken(): Promise<StaticCredentialResult | null> {
  const host = process.env.UMAMI_HOST;
  const username = process.env.UMAMI_USERNAME;
  const password = process.env.UMAMI_PASSWORD;

  if (!host || !username || !password) {
    console.log(`[static-providers] umami: env vars missing (UMAMI_HOST=${!!host}, UMAMI_USERNAME=${!!username}, UMAMI_PASSWORD=${!!password})`);
    return null;
  }

  // Return cached JWT if still valid (with 5-minute buffer)
  if (umamiJwtCache && umamiJwtCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    const remainingSecs = Math.floor((umamiJwtCache.expiresAt - Date.now()) / 1000);
    return { access_token: umamiJwtCache.token, expires_in: remainingSecs };
  }

  // Login to Umami to get a fresh JWT
  const loginUrl = `${host.replace(/\/$/, '')}/api/auth/login`;
  console.log(`[static-providers] umami: logging in to ${host.replace(/\/$/, '')}`);
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Umami login failed: ${response.status} ${response.statusText} (${loginUrl})`);
  }

  const data = await response.json() as { token: string };
  if (!data.token) {
    throw new Error('Umami login response missing token');
  }

  // Cache for 24 hours (Umami JWTs are long-lived)
  const expiresIn = 86400;
  umamiJwtCache = {
    token: data.token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  console.log(`[static-providers] umami: login successful, JWT cached for ${expiresIn}s`);
  return { access_token: data.token, expires_in: expiresIn };
}

/**
 * Check if a provider has a static credential configured on the gateway.
 * Returns the credential if found, null if not (falls through to Nango).
 */
export async function getStaticCredential(provider: string): Promise<StaticCredentialResult | null> {
  // Special case: Umami requires login to get a JWT
  if (provider === 'umami') {
    return getUmamiToken();
  }

  const config = STATIC_PROVIDERS[provider];
  if (!config) return null;

  for (const envVar of config.envVars) {
    const value = process.env[envVar];
    if (value) {
      return { access_token: value, expires_in: config.expiresIn };
    }
  }

  return null;
}
