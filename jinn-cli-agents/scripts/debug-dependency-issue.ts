#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Debug script to check why ethereum-contextual-analysis isn't being picked up
 */

import 'dotenv/config';
import { graphQLRequest } from 'jinn-node/http/client.js';
import { createClient } from '@supabase/supabase-js';

const PONDER_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const WORKSTREAM_ID = '0x4aab5a8cf94776dd05be3909ac3ceaefc1981919fe3f49c78b8def5296f1f9da';

async function main() {
  console.log('🔍 Debug: Checking dependency issue\n');

  // 1. Check what Ponder sees
  console.log('📊 Step 1: Query Ponder for requests in workstream');
  const ponderQuery = `
    query CheckWorkstream($workstreamId: String!) {
      requests(
        where: { workstreamId: $workstreamId }
        orderBy: "blockTimestamp"
        orderDirection: "desc"
        limit: 10
      ) {
        items {
          id
          jobName
          jobDefinitionId
          delivered
          dependencies
          blockTimestamp
        }
      }
    }
  `;

  try {
    const ponderData = await graphQLRequest<{ requests: { items: any[] } }>({
      url: PONDER_URL,
      query: ponderQuery,
      variables: { workstreamId: WORKSTREAM_ID },
      context: { operation: 'debug' }
    });

    const requests = ponderData?.requests?.items || [];
    console.log(`Found ${requests.length} requests in workstream:\n`);

    for (const req of requests) {
      console.log(`  ${req.jobName}`);
      console.log(`    ID: ${req.id}`);
      console.log(`    Job Def ID: ${req.jobDefinitionId}`);
      console.log(`    Delivered: ${req.delivered ? '✓' : '✗'}`);
      console.log(`    Dependencies: ${req.dependencies ? JSON.stringify(req.dependencies) : 'none'}`);
      console.log(`    Timestamp: ${new Date(Number(req.blockTimestamp) * 1000).toISOString()}`);
      console.log('');
    }

    // 2. Check Supabase claims
    console.log('\n📋 Step 2: Check Supabase claims');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });

    const requestIds = requests.map(r => r.id);
    if (requestIds.length > 0) {
      const { data: claims, error } = await supabase
        .from('onchain_request_claims')
        .select('*')
        .in('request_id', requestIds);

      if (error) {
        console.error('❌ Error querying claims:', error.message);
      } else {
        console.log(`Found ${claims?.length || 0} claims:\n`);
        for (const claim of claims || []) {
          const req = requests.find(r => r.id === claim.request_id);
          console.log(`  ${req?.jobName || claim.request_id}`);
          console.log(`    Status: ${claim.status}`);
          console.log(`    Worker: ${claim.worker_address}`);
          console.log(`    Claimed: ${claim.claimed_at}`);
          console.log(`    Completed: ${claim.completed_at || 'not yet'}`);
          console.log('');
        }
      }
    }

    // 3. Check specific dependencies
    console.log('\n🔗 Step 3: Check ethereum-contextual-analysis dependencies');
    const contextualAnalysis = requests.find(r => r.jobName === 'ethereum-contextual-analysis');
    
    if (!contextualAnalysis) {
      console.log('❌ ethereum-contextual-analysis not found in workstream!');
      return;
    }

    console.log(`Found ethereum-contextual-analysis: ${contextualAnalysis.id}`);
    console.log(`Dependencies: ${JSON.stringify(contextualAnalysis.dependencies)}\n`);

    if (contextualAnalysis.dependencies && contextualAnalysis.dependencies.length > 0) {
      for (const depId of contextualAnalysis.dependencies) {
        console.log(`\n  Checking dependency: ${depId}`);
        
        // Check if it's a UUID or job name
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isUUID = UUID_REGEX.test(depId);
        console.log(`    Format: ${isUUID ? 'UUID ✓' : 'Job Name (WRONG!) ✗'}`);

        // Query for this dependency
        const depQuery = isUUID
          ? `query($id: String!) {
              jobDefinitions(where: { id: $id }) {
                items {
                  id
                  name
                }
              }
              requests(where: { jobDefinitionId: $id }) {
                items {
                  id
                  jobName
                  delivered
                }
              }
            }`
          : `query($name: String!, $workstreamId: String!) {
              requests(where: { jobName: $name, workstreamId: $workstreamId }) {
                items {
                  id
                  jobDefinitionId
                  jobName
                  delivered
                }
              }
            }`;

        const depVars = isUUID 
          ? { id: depId }
          : { name: depId, workstreamId: WORKSTREAM_ID };

        const depData = await graphQLRequest<any>({
          url: PONDER_URL,
          query: depQuery,
          variables: depVars,
          context: { operation: 'checkDep' }
        });

        if (isUUID) {
          const jobDef = depData?.jobDefinitions?.items?.[0];
          const requests = depData?.requests?.items || [];
          
          if (!jobDef) {
            console.log(`    ❌ Job definition NOT FOUND`);
          } else {
            console.log(`    ✓ Job definition found: ${jobDef.name}`);
            console.log(`    Requests: ${requests.length}`);
            const deliveredCount = requests.filter((r: any) => r.delivered).length;
            console.log(`    Delivered: ${deliveredCount}/${requests.length}`);
            console.log(`    Complete: ${deliveredCount > 0 ? '✓' : '✗'}`);
          }
        } else {
          const requests = depData?.requests?.items || [];
          console.log(`    Found ${requests.length} requests with this job name`);
          if (requests.length > 0) {
            const delivered = requests.filter((r: any) => r.delivered).length;
            console.log(`    Delivered: ${delivered}/${requests.length}`);
            console.log(`    Job Def IDs: ${requests.map((r: any) => r.jobDefinitionId).join(', ')}`);
          }
        }
      }
    }

    // 4. Check why it's not being returned
    console.log('\n\n🤔 Step 4: Why is request not returned?');
    console.log('Checking filters:');
    console.log(`  - Workstream: ${contextualAnalysis.workstreamId === WORKSTREAM_ID ? '✓' : '✗'}`);
    console.log(`  - Delivered: ${!contextualAnalysis.delivered ? '✓ (undelivered)' : '✗ (already delivered)'}`);
    
    const claim = claims?.find((c: any) => c.request_id === contextualAnalysis.id);
    console.log(`  - Unclaimed: ${!claim || claim.status === 'COMPLETED' ? '✓' : `✗ (${claim?.status})`}`);
    
    const cutoff = Math.floor(Date.now() / 1000) - 240;
    const timestamp = Number(contextualAnalysis.blockTimestamp);
    console.log(`  - Recent (within 240s): ${timestamp > cutoff ? '✓' : `✗ (${Math.floor((Date.now() / 1000 - timestamp))}s ago)`}`);

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

main().catch(console.error);
