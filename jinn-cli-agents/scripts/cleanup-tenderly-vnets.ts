// @ts-nocheck
/**
 * Cleanup script to delete all Tenderly Virtual TestNets
 * 
 * Usage: yarn tsx scripts/cleanup-tenderly-vnets.ts [--dry-run]
 */

import 'dotenv/config';
import { createTenderlyClient } from './lib/tenderly.js';
import { getOptionalTenderlyAccountSlug, getOptionalTenderlyProjectSlug, getOptionalTenderlyAccessKey } from 'jinn-node/agent/mcp/tools/shared/env.js';

interface VnetListItem {
  id: string;
  slug: string;
  display_name: string;
  created_at: string;
}

async function listAllVnets(): Promise<VnetListItem[]> {
  const client = createTenderlyClient();
  
  if (!client.isConfigured()) {
    throw new Error('Tenderly not configured. Set TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, and TENDERLY_PROJECT_SLUG');
  }

  const accountSlug = getOptionalTenderlyAccountSlug();
  const projectSlug = getOptionalTenderlyProjectSlug();
  const accessKey = getOptionalTenderlyAccessKey();

  console.log('📋 Fetching all Virtual TestNets (across all pages)...\n');
  
  const allVnets: VnetListItem[] = [];
  let page = 1;
  const perPage = 20; // Tenderly default page size
  
  while (true) {
    const url = `https://api.tenderly.co/api/v1/account/${accountSlug}/project/${projectSlug}/vnets?page=${page}&per_page=${perPage}`;

    const data = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'X-Access-Key': accessKey!,
      },
    }, {
      timeoutMs: 10_000,
      maxRetries: 2,
      context: { operation: 'listVnets', page }
    }).then(res => res.json());
    
    // The API returns an array of VNets directly, not wrapped in an object
    const pageVnets = Array.isArray(data) ? data : (data.vnets || data.virtual_testnets || data.containers || data.data || []);
    
    if (pageVnets.length === 0) {
      break; // No more pages
    }
    
    console.log(`   📄 Fetched page ${page}: ${pageVnets.length} VNets`);
    allVnets.push(...pageVnets);
    
    // If we got fewer results than perPage, we've reached the last page
    if (pageVnets.length < perPage) {
      break;
    }
    
    page++;
  }
  
  console.log(`\n✅ Total VNets found: ${allVnets.length}\n`);
  return allVnets;
}

async function deleteAllVnets(dryRun: boolean = false): Promise<void> {
  const vnets = await listAllVnets();

  console.log(`Found ${vnets.length} Virtual TestNet(s):\n`);

  if (vnets.length === 0) {
    console.log('✅ No VNets to clean up!');
    return;
  }

  // Display all VNets
  vnets.forEach((vnet, index) => {
    const createdDate = new Date(vnet.created_at).toLocaleString();
    console.log(`${index + 1}. ${vnet.display_name}`);
    console.log(`   ID: ${vnet.id}`);
    console.log(`   Slug: ${vnet.slug}`);
    console.log(`   Created: ${createdDate}\n`);
  });

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No VNets will be deleted');
    console.log('Run without --dry-run to actually delete them\n');
    return;
  }

  // Confirm deletion
  console.log(`⚠️  This will delete ALL ${vnets.length} Virtual TestNet(s)!`);
  console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n');
  
  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('🗑️  Deleting VNets...\n');

  const client = createTenderlyClient();
  let deleted = 0;
  let failed = 0;

  for (const vnet of vnets) {
    try {
      await client.deleteVnet(vnet.id);
      deleted++;
      console.log(`✅ Deleted: ${vnet.display_name} (${vnet.id})`);
    } catch (error) {
      failed++;
      console.error(`❌ Failed to delete ${vnet.display_name} (${vnet.id}):`, error instanceof Error ? error.message : String(error));
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\n📊 Cleanup Summary:`);
  console.log(`   ✅ Deleted: ${deleted}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📋 Total: ${vnets.length}\n`);

  if (deleted > 0) {
    console.log('🎉 Cleanup completed!');
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

deleteAllVnets(dryRun).catch(error => {
  console.error('\n❌ Cleanup failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

