/**
 * Nango Client
 *
 * Thin wrapper around Nango's REST API to retrieve fresh OAuth tokens.
 * Nango handles token refresh automatically — when we request a connection,
 * it returns a valid (refreshed if needed) access token.
 */

interface NangoCredentials {
  type: 'OAUTH2';
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  raw: Record<string, unknown>;
}

interface NangoConnectionResponse {
  id: number;
  connection_id: string;
  provider_config_key: string;
  credentials: NangoCredentials;
  connection_config: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
}

function getNangoConfig() {
  const host = process.env.NANGO_HOST;
  const secretKey = process.env.NANGO_SECRET_KEY;

  if (!host) throw new Error('NANGO_HOST environment variable is required');
  if (!secretKey) throw new Error('NANGO_SECRET_KEY environment variable is required');

  return { host: host.replace(/\/$/, ''), secretKey };
}

/** Validate that an identifier contains only safe characters (no path traversal) */
function validateIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: must contain only alphanumeric characters, hyphens, and underscores`);
  }
}

/**
 * Get a fresh access token for a Nango connection.
 * Nango automatically refreshes expired tokens before returning.
 */
export async function getNangoAccessToken(connectionId: string, providerConfigKey?: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const { host, secretKey } = getNangoConfig();

  validateIdentifier(connectionId, 'connectionId');
  if (providerConfigKey) validateIdentifier(providerConfigKey, 'providerConfigKey');

  const params = providerConfigKey ? `?provider_config_key=${encodeURIComponent(providerConfigKey)}` : '';
  const response = await fetch(`${host}/connection/${encodeURIComponent(connectionId)}${params}`, {
    headers: {
      'Authorization': `Bearer ${secretKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    console.error(`[nango] API error for connection ${connectionId}: ${response.status} ${response.statusText}`);
    throw new Error('Failed to fetch OAuth token from provider');
  }

  const data = await response.json() as NangoConnectionResponse;

  if (!data.credentials?.access_token) {
    throw new Error(`Nango connection ${connectionId} has no access_token`);
  }

  // Calculate expires_in from expires_at if available
  let expires_in = 7200; // Default 2 hours
  if (data.credentials.expires_at) {
    const expiresAt = new Date(data.credentials.expires_at).getTime();
    expires_in = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  }

  return {
    access_token: data.credentials.access_token,
    expires_in,
  };
}

/**
 * Check if Nango is healthy and reachable.
 */
export async function checkNangoHealth(): Promise<boolean> {
  try {
    const { host } = getNangoConfig();
    const response = await fetch(`${host}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
