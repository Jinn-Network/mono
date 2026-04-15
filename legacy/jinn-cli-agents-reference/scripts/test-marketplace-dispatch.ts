#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Standalone test script to verify mech-client marketplace dispatch works in isolation
 * This bypasses the MCP layer and directly calls marketplaceInteract
 */

import { marketplaceInteract } from '../packages/mech-client-ts/dist/marketplace_interact.js';
import { getMechAddress, getMechChainConfig, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
import { randomUUID } from 'node:crypto';

async function testMarketplaceDispatch() {
  console.log('=== Testing Marketplace Dispatch in Isolation ===\n');

  // Get configuration
  const mechAddress = getMechAddress();
  const chainConfig = getMechChainConfig();
  const privateKey = getServicePrivateKey();

  if (!mechAddress) {
    throw new Error('MECH address not configured');
  }
  if (!privateKey) {
    throw new Error('Private key not found');
  }

  console.log('Configuration:');
  console.log('  Mech:', mechAddress);
  console.log('  Chain:', chainConfig);
  console.log('  Private key:', privateKey.substring(0, 10) + '...');
  console.log('');

  // Create a simple test job
  const jobDefinitionId = randomUUID();
  const jobName = 'test-marketplace-dispatch';
  const blueprint = JSON.stringify({
    assertions: [{
      id: 'TEST-001',
      assertion: 'This is a test job to verify marketplace dispatch',
      examples: {
        do: ['Test successfully'],
        dont: ['Fail silently']
      },
      commentary: 'Testing marketplace interaction'
    }]
  });

  const ipfsJsonContents = [{
    blueprint,
    jobName,
    model: 'gemini-2.5-flash',
    enabledTools: ['create_artifact'],
    jobDefinitionId,
    nonce: randomUUID(),
  }];

  console.log('Test Job:');
  console.log('  Job Definition ID:', jobDefinitionId);
  console.log('  Job Name:', jobName);
  console.log('  IPFS Contents:', JSON.stringify(ipfsJsonContents, null, 2));
  console.log('');

  console.log('Calling marketplaceInteract with postOnly: true...\n');

  try {
    const result = await marketplaceInteract({
      prompts: [blueprint],
      priorityMech: mechAddress,
      tools: ['create_artifact'],
      ipfsJsonContents,
      chainConfig,
      keyConfig: { source: 'value', value: privateKey },
      postOnly: true,
    });

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    // Validate result
    if (!result) {
      console.error('❌ FAILURE: marketplaceInteract returned null/undefined');
      process.exit(1);
    }

    if (!result.request_ids || !Array.isArray(result.request_ids) || result.request_ids.length === 0) {
      console.error('❌ FAILURE: No request_ids in result');
      console.error('Result keys:', Object.keys(result));
      console.error('Full result:', result);
      process.exit(1);
    }

    if (!result.transaction_hash) {
      console.error('⚠️  WARNING: No transaction_hash in result');
    }

    console.log('✅ SUCCESS: Marketplace dispatch completed');
    console.log('  Transaction:', result.transaction_hash);
    console.log('  Transaction URL:', result.transaction_url);
    console.log('  Request IDs:', result.request_ids);
    console.log('  Request ID Ints:', result.request_id_ints);

  } catch (error: any) {
    console.error('\n❌ EXCEPTION CAUGHT:');
    console.error('  Message:', error.message);
    console.error('  Stack:', error.stack);
    console.error('  Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    process.exit(1);
  }
}

// Run test
testMarketplaceDispatch().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

