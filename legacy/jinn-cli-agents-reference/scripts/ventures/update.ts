#!/usr/bin/env tsx
/**
 * Update an existing venture - CLI wrapper
 * Usage: yarn tsx scripts/ventures/update.ts --id <uuid> [--name "New Name"] [--status "paused"]
 *
 * Business logic is in jinn-node/src/data/ventures.ts
 * This file provides the CLI interface only.
 */

// Re-export everything from jinn-node for backwards compatibility
export {
  updateVenture,
  archiveVenture,
  deleteVenture,
  type UpdateVentureArgs,
  type Venture,
} from 'jinn-node/data/ventures.js';

import { updateVenture, type UpdateVentureArgs } from 'jinn-node/data/ventures.js';

// ============================================================================
// CLI Interface
// ============================================================================

function parseArgs(): UpdateVentureArgs {
  const args = process.argv.slice(2);
  const result: Partial<UpdateVentureArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--id':
        result.id = next;
        i++;
        break;
      case '--name':
        result.name = next;
        i++;
        break;
      case '--slug':
        result.slug = next;
        i++;
        break;
      case '--description':
        result.description = next;
        i++;
        break;
      case '--ownerAddress':
      case '--owner':
        result.ownerAddress = next;
        i++;
        break;
      case '--blueprint':
        result.blueprint = next;
        i++;
        break;
      case '--rootWorkstreamId':
      case '--workstream':
        result.rootWorkstreamId = next === 'null' ? null : next;
        i++;
        break;
      case '--rootJobInstanceId':
      case '--jobInstance':
        result.rootJobInstanceId = next === 'null' ? null : next;
        i++;
        break;
      case '--status':
        result.status = next as 'active' | 'paused' | 'archived';
        i++;
        break;
      case '--dispatch-schedule':
        result.dispatchSchedule = JSON.parse(next);
        i++;
        break;
    }
  }

  if (!result.id) {
    console.error('Error: --id is required');
    printUsage();
    process.exit(1);
  }

  return result as UpdateVentureArgs;
}

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/ventures/update.ts --id <uuid> [options]

Required:
  --id <uuid>                Venture ID to update

Optional (at least one required):
  --name <name>              New venture name
  --slug <slug>              New URL-friendly slug
  --description <text>       New description
  --ownerAddress <address>   New owner address
  --blueprint <json>         New blueprint JSON
  --rootWorkstreamId <id>    New workstream ID (or "null" to clear)
  --rootJobInstanceId <id>   New root job instance ID (or "null" to clear)
  --status <status>          New status: active, paused, archived
  --dispatch-schedule <json> Dispatch schedule as JSON array

Example:
  yarn tsx scripts/ventures/update.ts \\
    --id "123e4567-e89b-12d3-a456-426614174000" \\
    --status "paused" \\
    --description "Updated description"
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  try {
    const args = parseArgs();
    const venture = await updateVenture(args);
    console.log(JSON.stringify({ ok: true, data: venture }, null, 2));
  } catch (err: any) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

// Only run CLI when executed directly (not when imported as module)
const isDirectRun = process.argv[1]?.endsWith('update.ts') || process.argv[1]?.endsWith('update.js');
if (isDirectRun) {
  main();
}
