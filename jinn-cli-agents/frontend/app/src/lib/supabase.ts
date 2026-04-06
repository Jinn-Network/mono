const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function supabaseQuery<T>(
  table: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('Supabase not configured', {
      url: !!SUPABASE_URL,
      anon: !!SUPABASE_ANON_KEY
    });
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
      next: { revalidate: 30 },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase query failed: ${response.status}`, errorText);
      return [];
    }

    return response.json();
  } catch (error) {
    console.error('Supabase fetch error:', error);
    return [];
  }
}

export async function supabaseAdminQuery<T>(
  table: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase Admin not configured, falling back to anon query');
    return supabaseQuery<T>(table, params);
  }

  const searchParams = new URLSearchParams(params);
  const url = `${SUPABASE_URL}/rest/v1/${table}?${searchParams}`;

  try {
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      next: { revalidate: 0 }, // No cache for admin
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase Admin query failed: ${response.status}`, errorText);
      if (response.status === 401 || response.status === 403) {
        console.warn('Supabase Admin query unauthorized, falling back to anon query');
        return supabaseQuery<T>(table, params);
      }
      return [];
    }

    return response.json();
  } catch (error) {
    console.error('Supabase Admin fetch error:', error);
    return [];
  }
}

type HttpMethod = 'POST' | 'PATCH' | 'DELETE';

interface MutationResult<T> {
  data?: T;
  error?: string;
}

export async function supabaseMutate<T>(
  table: string,
  method: HttpMethod,
  data?: object,
  id?: string,
  queryParams?: Record<string, string>
): Promise<MutationResult<T>> {
  const url_base = SUPABASE_URL;
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

  if (!url_base || !key) {
    return { error: 'Supabase not configured' };
  }

  let url = `${url_base}/rest/v1/${table}`;
  const searchParams = new URLSearchParams(queryParams);

  if (id) {
    searchParams.append('id', `eq.${id}`);
  }

  if (searchParams.toString()) {
    url += `?${searchParams.toString()}`;
  }

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase ${method} failed:`, response.status, errorText);
      if (response.status === 409) {
        return { error: 'A record with this name already exists. Please choose a different name.' };
      }
      return { error: `Database error: ${response.status}` };
    }

    if (method === 'DELETE') {
      return { data: undefined as T };
    }

    const result = await response.json();
    const row = Array.isArray(result) ? result[0] : result;

    if (method === 'POST' && !row) {
      console.error(`Supabase POST to ${table} returned empty result — likely RLS policy blocking insert`);
      return { error: 'Insert was blocked. Check database permissions.' };
    }

    return { data: row };
  } catch (e) {
    console.error(`Supabase ${method} error:`, e);
    return { error: 'Network error' };
  }
}
