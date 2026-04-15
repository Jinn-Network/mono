#!/usr/bin/env tsx
/**
 * One-shot script to reorganize ventures:
 * 1. Delete "DAO productivity" venture
 * 2. Rename "jinn" venture to "The Lamp"
 * 3. Create new "Jinn" venture with growth invariants
 */

import { listVentures, deleteVenture, updateVenture, createVenture } from '../../jinn-node/src/data/ventures.js';

async function main() {
  // Step 0: List all ventures
  console.log('=== Current Ventures ===');
  const ventures = await listVentures();
  for (const v of ventures) {
    console.log(`  ${v.id} | ${v.name} (slug: ${v.slug}) | status: ${v.status}`);
  }
  console.log(`  Total: ${ventures.length}\n`);

  // Step 1: Delete "DAO productivity" venture
  const daoVenture = ventures.find(v =>
    v.name.toLowerCase().includes('dao productivity') ||
    v.slug.includes('dao-productivity')
  );
  if (daoVenture) {
    console.log(`Deleting "DAO productivity" venture: ${daoVenture.id} (${daoVenture.name})`);
    await deleteVenture(daoVenture.id);
    console.log('  Deleted.\n');
  } else {
    console.log('No "DAO productivity" venture found. Skipping delete.\n');
  }

  // Step 2: Rename "jinn" to "The Lamp"
  const jinnVenture = ventures.find(v =>
    v.name.toLowerCase() === 'jinn' || v.slug === 'jinn'
  );
  if (jinnVenture) {
    console.log(`Renaming venture "${jinnVenture.name}" (${jinnVenture.id}) to "The Lamp"`);
    const updated = await updateVenture({
      id: jinnVenture.id,
      name: 'The Lamp',
      slug: 'the-lamp',
      description: 'Growing Jinn by educating people about autonomous software ventures. The Lamp is Jinn\'s thought leadership blog — publishing research, tutorials, and case studies about the autonomous venture ecosystem.',
    });
    console.log(`  Renamed to: ${updated.name} (slug: ${updated.slug})\n`);
  } else {
    console.log('No "jinn" venture found. Skipping rename.\n');
  }

  // Step 3: Create new "Jinn" venture
  const ownerAddress = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421'; // Venture Safe
  console.log('Creating new "Jinn" venture...');
  const newVenture = await createVenture({
    name: 'Jinn',
    slug: 'jinn',
    description: 'The Jinn Network — an autonomous AI venture platform. Jinn coordinates inference and economic activity across its cryptoeconomy, growing both throughput and value week over week.',
    ownerAddress,
    blueprint: {
      invariants: [
        {
          id: 'GROWTH-001',
          form: 'threshold',
          description: '10% week-on-week growth in inference/AI tokens passing through the system. Measured as total AI model calls (LLM inferences, tool invocations, and MCP requests) processed by Jinn workers across all ventures, compared to the prior 7-day period.',
        },
        {
          id: 'GROWTH-002',
          form: 'threshold',
          description: '10% week-on-week growth in net new value entering the Jinn cryptoeconomy. Measured as the sum of new OLAS staked, new venture token market caps, and new marketplace transaction volume (in ETH-equivalent), compared to the prior 7-day period.',
        },
      ],
    },
    status: 'active',
  });
  console.log(`  Created: ${newVenture.id} | ${newVenture.name} (slug: ${newVenture.slug})`);
  console.log(`  Blueprint invariants: ${(newVenture.blueprint as any).invariants.length}`);

  // Final state
  console.log('\n=== Final Ventures ===');
  const final = await listVentures();
  for (const v of final) {
    console.log(`  ${v.id} | ${v.name} (slug: ${v.slug}) | status: ${v.status}`);
  }
  console.log(`  Total: ${final.length}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
