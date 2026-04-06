/**
 * Supabase Client for x402 Gateway
 *
 * Used for venture ownership verification (ventures table).
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from env.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function initSupabase(): void {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    client = createClient(url, key);
    console.log('[supabase] Gateway Supabase client initialized');
  } else {
    console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — venture ownership checks disabled');
  }
}

initSupabase();

export function getSupabaseClient(): SupabaseClient | null {
  return client;
}

/**
 * Verify that an address owns a venture.
 * Returns the venture if ownership is confirmed, null otherwise.
 */
export async function verifyVentureOwner(
  ventureId: string,
  ownerAddress: string,
): Promise<{ id: string; name: string; owner_address: string } | null> {
  if (!client) throw new Error('Supabase not configured — cannot verify venture ownership');

  const { data, error } = await client
    .from('ventures')
    .select('id, name, owner_address')
    .eq('id', ventureId)
    .single();

  if (error || !data) return null;

  if (data.owner_address.toLowerCase() !== ownerAddress.toLowerCase()) {
    return null;
  }

  return data;
}

/**
 * Look up the venture ID for a workstream's sender address.
 * Used in credential request flow to resolve venture context from requestId.
 */
export async function getVentureByOwner(
  ownerAddress: string,
): Promise<{ id: string; name: string } | null> {
  if (!client) return null;

  const { data, error } = await client
    .from('ventures')
    .select('id, name')
    .eq('owner_address', ownerAddress.toLowerCase())
    .eq('status', 'active')
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}
