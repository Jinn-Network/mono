/**
 * Umami provisioning for x402 gateway
 * Creates Umami websites for tracking customer blogs
 */

export interface UmamiProvisionResult {
  websiteId: string;
  name: string;
  domain: string;
}

/**
 * Login to Umami and get a JWT token
 */
async function umamiLogin(): Promise<string> {
  const host = process.env.UMAMI_HOST;
  const username = process.env.UMAMI_USERNAME;
  const password = process.env.UMAMI_PASSWORD;

  if (!host || !username || !password) {
    throw new Error('UMAMI_HOST, UMAMI_USERNAME, and UMAMI_PASSWORD are required for provisioning');
  }

  const response = await fetch(`${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    throw new Error(`Umami login failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.token) {
    throw new Error('Umami login did not return a token');
  }

  return data.token;
}

/**
 * Check if a website already exists for a domain
 */
export async function findUmamiWebsite(domain: string): Promise<UmamiProvisionResult | null> {
  const host = process.env.UMAMI_HOST;
  if (!host) {
    throw new Error('UMAMI_HOST environment variable is required');
  }

  const token = await umamiLogin();

  const response = await fetch(`${host}/api/websites?search=${encodeURIComponent(domain)}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const existing = data.data?.find((w: any) => w.domain === domain);

  if (existing) {
    return {
      websiteId: existing.id,
      name: existing.name,
      domain: existing.domain,
    };
  }

  return null;
}

/**
 * Create a new Umami website for tracking
 */
export async function provisionUmamiWebsite(
  name: string,
  domain: string
): Promise<UmamiProvisionResult> {
  const host = process.env.UMAMI_HOST;
  if (!host) {
    throw new Error('UMAMI_HOST environment variable is required for provisioning');
  }

  // Check if already exists (idempotent)
  const existing = await findUmamiWebsite(domain);
  if (existing) {
    console.log(`[provision] Umami website for ${domain} already exists: ${existing.websiteId}`);
    return existing;
  }

  console.log(`[provision] Logging into Umami at ${host}...`);
  const token = await umamiLogin();

  console.log(`[provision] Creating Umami website: ${name} (${domain})...`);

  const response = await fetch(`${host}/api/websites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ name, domain }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Umami website creation failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  if (!data.id) {
    throw new Error('Umami website creation did not return an ID');
  }

  console.log(`[provision] Umami website created: ${data.id}`);

  return {
    websiteId: data.id,
    name: data.name,
    domain: data.domain,
  };
}
