import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'

loadEnv()

const SUPABASE_URL = process.env.SUPABASE_URL as string
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

async function main() {
  // First, get all IN_PROGRESS claims
  const { data: claims, error: fetchError } = await supabase
    .from('onchain_request_claims')
    .select('request_id, status, claimed_at, worker_address')
    .eq('status', 'IN_PROGRESS')

  if (fetchError) {
    console.error('Error fetching claims:', fetchError)
    process.exit(1)
  }

  console.log('Found IN_PROGRESS claims:', claims)

  // Update all except the specific one to FAILED
  const claimsToFail = claims.filter(
    c => c.request_id !== '0x9e392dc0f2213e6f0ccf989e1fd957cd653792c32f135f1683e20597817d7f3d'
  )

  console.log(`\nMarking ${claimsToFail.length} claims as FAILED...`)
  
  for (const claim of claimsToFail) {
    const { error } = await supabase
      .from('onchain_request_claims')
      .update({ 
        status: 'FAILED',
        completed_at: new Date().toISOString()
      })
      .eq('request_id', claim.request_id)

    if (error) {
      console.error(`Error updating ${claim.request_id}:`, error)
    } else {
      console.log(`✓ Marked ${claim.request_id} as FAILED`)
    }
  }

  // Update the specific one to PENDING (by deleting the claim)
  const specificClaim = claims.find(
    c => c.request_id === '0x9e392dc0f2213e6f0ccf989e1fd957cd653792c32f135f1683e20597817d7f3d'
  )

  if (specificClaim) {
    console.log(`\nDeleting claim for 0x9e392dc0f2213e6f0ccf989e1fd957cd653792c32f135f1683e20597817d7f3d to mark as PENDING...`)
    const { error } = await supabase
      .from('onchain_request_claims')
      .delete()
      .eq('request_id', '0x9e392dc0f2213e6f0ccf989e1fd957cd653792c32f135f1683e20597817d7f3d')

    if (error) {
      console.error('Error deleting claim:', error)
    } else {
      console.log('✓ Deleted claim (now PENDING)')
    }
  } else {
    console.log('\nSpecific request ID not found in IN_PROGRESS claims')
  }

  console.log('\n✅ Done!')
}

main().catch(console.error)
