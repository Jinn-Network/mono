#!/usr/bin/env npx tsx
/**
 * Script to list and cleanup stale Tenderly Virtual TestNets
 * 
 * Usage:
 *   npx tsx scripts/tenderly-cleanup.ts [--dry-run] [--max-age-hours=N]
 * 
 * Options:
 *   --dry-run        Show what would be deleted without actually deleting
 *   --max-age-hours  Maximum age in hours before a vnet is considered stale (default: 1)
 *   --list           Just list all vnets without cleanup
 */

import 'dotenv/config';
import { createTenderlyClient } from './lib/tenderly.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const listOnly = args.includes('--list');
const maxAgeHoursArg = args.find(a => a.startsWith('--max-age-hours='));
const maxAgeHours = maxAgeHoursArg ? parseInt(maxAgeHoursArg.split('=')[1], 10) : 1;

async function main() {
  const client = createTenderlyClient();
  
  console.log('Listing Tenderly Virtual TestNets...\n');
  
  const vnets = await client.listVnets();
  console.log(`Found ${vnets.length} vnets:\n`);
  
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  
  let staleCount = 0;
  for (const vnet of vnets) {
    const isTestVnet = vnet.slug?.startsWith('e2e-test-');
    let age = '?';
    let isStale = false;
    
    if (isTestVnet) {
      const match = vnet.slug.match(/^e2e-test-(\d+)-/);
      if (match) {
        const createdTimestamp = parseInt(match[1], 10);
        const ageMs = now - createdTimestamp;
        const ageMinutes = Math.floor(ageMs / 60000);
        age = ageMinutes < 60 ? `${ageMinutes}m` : `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m`;
        isStale = ageMs > maxAgeMs;
        if (isStale) staleCount++;
      }
    }
    
    const staleMarker = isStale ? ' [STALE]' : '';
    console.log(`  ${vnet.slug || vnet.id}  (age: ${age})${staleMarker}`);
  }
  
  console.log(`\nTotal: ${vnets.length} vnets, ${staleCount} stale (older than ${maxAgeHours}h)`);
  
  if (listOnly) {
    console.log('\n--list mode: Not cleaning up');
    return;
  }
  
  if (staleCount === 0) {
    console.log('\nNo stale vnets to cleanup.');
    return;
  }
  
  console.log(`\n${dryRun ? '[DRY RUN] Would cleanup' : 'Cleaning up'} ${staleCount} stale vnets...`);
  
  const deleted = await client.cleanupOldVnets({ maxAgeMs, dryRun });
  
  console.log(`\n${dryRun ? 'Would have deleted' : 'Deleted'} ${deleted} vnets.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
