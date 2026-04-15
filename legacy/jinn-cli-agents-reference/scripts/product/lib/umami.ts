/**
 * Umami API helper for blog provisioning
 * Creates Umami websites for tracking customer blogs
 */

export interface UmamiWebsiteResult {
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
        throw new Error('UMAMI_HOST, UMAMI_USERNAME, and UMAMI_PASSWORD are required');
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
 * Create a new Umami website for tracking
 */
export async function createUmamiWebsite(
    name: string,
    domain: string,
    options: { dryRun?: boolean } = {}
): Promise<UmamiWebsiteResult> {
    if (options.dryRun) {
        console.log(`[DRY RUN] Would create Umami website: ${name}`);
        console.log(`[DRY RUN] Domain: ${domain}`);
        return {
            websiteId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            name,
            domain,
        };
    }

    const host = process.env.UMAMI_HOST;
    if (!host) {
        throw new Error('UMAMI_HOST environment variable is required');
    }

    console.log(`Logging into Umami at ${host}...`);
    const token = await umamiLogin();

    console.log(`Creating Umami website: ${name} (${domain})...`);

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

    console.log(`Umami website created: ${data.id}`);

    return {
        websiteId: data.id,
        name: data.name,
        domain: data.domain,
    };
}

/**
 * Check if a website already exists for a domain
 */
export async function findUmamiWebsite(domain: string): Promise<UmamiWebsiteResult | null> {
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
