/**
 * Worker-side Supabase client.
 *
 * This creates a direct Supabase client using env vars available to the
 * worker process. NOT for agent use — agents must go through the credential
 * bridge via the shared/supabase.ts module.
 */
import { createClient } from '@supabase/supabase-js';
import { secrets } from '../config/index.js';

const supabaseUrl = secrets.supabaseUrl;
const supabaseKey = secrets.supabaseServiceRoleKey;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[data/supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.');
}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;
