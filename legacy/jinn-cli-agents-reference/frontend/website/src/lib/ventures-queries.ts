/**
 * Ventures Queries
 *
 * Fetches ventures from Supabase via REST API.
 * Uses NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
 */

export interface Venture {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_address: string;
  blueprint: {
    invariants: Array<{
      id: string;
      name: string;
      description?: string;
      type?: string;
    }>;
  };
  root_workstream_id: string | null;
  root_job_instance_id: string | null;
  status: 'proposed' | 'bonding' | 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
  token_address: string | null;
  token_symbol: string | null;
  token_name: string | null;
  staking_contract_address: string | null;
  token_launch_platform: string | null;
  token_metadata: Record<string, unknown> | null;
  governance_address: string | null;
  pool_address: string | null;
}

const EXCLUDED_VENTURE_SLUGS = new Set(['amp2']);

// Supabase REST API helper
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function supabaseQuery<T>(
  table: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('Supabase not configured, returning empty array');
    return [];
  }

  const searchParams = new URLSearchParams(params);
  const url = `${SUPABASE_URL}/rest/v1/${table}?${searchParams}`;

  try {
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      next: { revalidate: 60 }, // Cache for 60 seconds
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase query failed: ${response.status}`, {
        url,
        error: errorText,
      });
      return [];
    }

    return response.json();
  } catch (error) {
    console.error('Supabase fetch error:', error);
    return [];
  }
}

/**
 * Fetch tokenized ventures (ventures with tokens)
 * 
 * PostgREST syntax: column=operator.value
 * Examples: status=eq.active, token_address=not.is.null
 */
export async function getTokenizedVentures(limit: number = 10): Promise<Venture[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('Supabase not configured - NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
    return [];
  }

  // Build query parameters - PostgREST uses column=operator.value format
  // The format in the URL will be: ?select=*&status=eq.active&token_address=not.is.null&order=created_at.desc
  const params: Record<string, string> = {
    select: '*',
    status: 'eq.active',
    token_address: 'not.is.null',
    order: 'created_at.desc',
  };
  
  if (limit > 0) {
    params.limit = limit.toString();
  }
  
  const results = await supabaseQuery<Venture>('ventures', params);

  return results;
}

/**
 * Fetch active ventures (same base list used by Explorer > Ventures).
 */
export async function getActiveVentures(limit: number = 0): Promise<Venture[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('Supabase not configured - NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
    return [];
  }

  const params: Record<string, string> = {
    select: '*',
    status: 'eq.active',
    order: 'created_at.desc',
  };

  if (limit > 0) {
    params.limit = limit.toString();
  }

  return supabaseQuery<Venture>('ventures', params);
}

/**
 * Fetch website featured ventures:
 * - uses Explorer's active ventures list
 * - applies Explorer's current exclusions
 * - returns a random sample (up to `limit`)
 */
export async function getFeaturedVentures(limit: number = 6): Promise<Venture[]> {
  const ventures = await getActiveVentures();
  const filtered = ventures.filter(
    (venture) => !EXCLUDED_VENTURE_SLUGS.has(venture.slug.toLowerCase())
  );

  if (limit <= 0 || filtered.length <= limit) {
    return filtered;
  }

  const randomized = [...filtered];
  for (let i = randomized.length - 1; i > 0; i -= 1) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [randomized[i], randomized[randomIndex]] = [randomized[randomIndex], randomized[i]];
  }

  return randomized.slice(0, limit);
}

/**
 * Fetch seed ventures (proposed, not yet tokenized) from the launchpad
 */
export async function getSeedVentures(limit: number = 6): Promise<Venture[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return [];
  }

  const params: Record<string, string> = {
    select: '*',
    status: 'eq.proposed',
    order: 'created_at.desc',
  };

  if (limit > 0) {
    params.limit = limit.toString();
  }

  return supabaseQuery<Venture>('ventures', params);
}
