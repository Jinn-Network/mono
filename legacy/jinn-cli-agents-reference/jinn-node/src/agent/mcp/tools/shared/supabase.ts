import { createClient } from '@supabase/supabase-js';
export { getCurrentJobContext, setJobContext, clearJobContext, type JobContext } from './context.js';
import { getCredentialBundle } from '../../../shared/credential-client.js';

let cachedClient: any = null;

/**
 * Get the Supabase client from credential bridge token + static provider config.
 */
export async function getSupabase(): Promise<any> {
  if (cachedClient) return cachedClient;

  const bundle = await getCredentialBundle('supabase');
  const supabaseUrl = bundle.config.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('Credential bridge config missing SUPABASE_URL for provider supabase');
  }

  cachedClient = createClient(supabaseUrl, bundle.access_token);
  return cachedClient;
}
