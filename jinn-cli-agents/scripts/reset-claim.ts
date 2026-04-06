import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const requestId = process.argv[2];
if (!requestId) {
  console.error('Usage: tsx scripts/reset-claim.ts <requestId>');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(`\n🔍 Checking claim status for: ${requestId}\n`);

  // Check current claim
  const { data: claim, error: fetchError } = await supabase
    .from('onchain_request_claims')
    .select('*')
    .eq('request_id', requestId)
    .maybeSingle();

  if (fetchError) {
    console.error('❌ Error fetching claim:', fetchError);
    process.exit(1);
  }

  if (!claim) {
    console.log('✓ No claim found - request is unclaimed');
    return;
  }

  console.log('Current claim status:');
  console.log(`  Status: ${claim.status}`);
  console.log(`  Worker: ${claim.worker_address}`);
  console.log(`  Claimed at: ${claim.claimed_at}`);
  console.log(`  Completed at: ${claim.completed_at || 'not yet'}`);

  if (claim.status === 'IN_PROGRESS') {
    const claimedAt = new Date(claim.claimed_at).getTime();
    const ageMinutes = Math.floor((Date.now() - claimedAt) / 60000);
    console.log(`  Age: ${ageMinutes} minutes\n`);

    console.log('⚠️  Claim is IN_PROGRESS. Delete to allow re-claiming? (y/n)');
    
    // For non-interactive use, check env var or just do it
    const shouldDelete = process.env.AUTO_CONFIRM === 'true' || process.argv.includes('--force');
    
    if (shouldDelete) {
      console.log('\n🗑️  Deleting claim...');
      const { error: deleteError } = await supabase
        .from('onchain_request_claims')
        .delete()
        .eq('request_id', requestId);

      if (deleteError) {
        console.error('❌ Error deleting claim:', deleteError);
        process.exit(1);
      }

      console.log('✓ Claim deleted - request is now unclaimed');
    } else {
      console.log('\nℹ️  Run with --force to delete automatically');
    }
  } else {
    console.log(`\nℹ️  Claim status is ${claim.status} (not IN_PROGRESS)`);
  }
}

main().catch(console.error);
