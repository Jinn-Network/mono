#!/usr/bin/env tsx
/**
 * Mint (create) a new venture - CLI wrapper
 * Usage: yarn tsx scripts/ventures/mint.ts --name "My Venture" --ownerAddress "0x..." --blueprint '{...}'
 *
 * Business logic is in jinn-node/src/data/ventures.ts
 * This file provides the CLI interface only.
 */

// Re-export everything from jinn-node for backwards compatibility
export {
  createVenture,
  getVenture,
  getVentureBySlug,
  listVentures,
  type CreateVentureArgs,
  type ListVenturesOptions,
  type Venture,
} from 'jinn-node/data/ventures.js';

import { createVenture, type CreateVentureArgs } from 'jinn-node/data/ventures.js';

// ============================================================================
// CLI Interface
// ============================================================================

function parseArgs(): CreateVentureArgs {
  const args = process.argv.slice(2);
  const result: Partial<CreateVentureArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
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
        result.rootWorkstreamId = next;
        i++;
        break;
      case '--rootJobInstanceId':
      case '--jobInstance':
        result.rootJobInstanceId = next;
        i++;
        break;
      case '--status':
        result.status = next as 'active' | 'paused' | 'archived';
        i++;
        break;
    }
  }

  if (!result.name) {
    console.error('Error: --name is required');
    printUsage();
    process.exit(1);
  }
  if (!result.ownerAddress) {
    console.error('Error: --ownerAddress is required');
    printUsage();
    process.exit(1);
  }
  if (!result.blueprint) {
    console.error('Error: --blueprint is required');
    printUsage();
    process.exit(1);
  }

  return result as CreateVentureArgs;
}

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/ventures/mint.ts [options]

Required:
  --name <name>              Venture name
  --ownerAddress <address>   Ethereum address of the owner
  --blueprint <json>         Blueprint JSON with invariants array

Optional:
  --slug <slug>              URL-friendly slug (auto-generated if not provided)
  --description <text>       Venture description
  --rootWorkstreamId <id>    Workstream ID
  --rootJobInstanceId <id>   Root job instance ID
  --status <status>          Status: active, paused, archived

Example:
  yarn tsx scripts/ventures/mint.ts \\
    --name "My Venture" \\
    --ownerAddress "0x1234..." \\
    --blueprint '{"invariants":[{"id":"GOAL-001","form":"constraint","description":"Test invariant"}]}'
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  try {
    const args = parseArgs();
    const venture = await createVenture(args);
    console.log(JSON.stringify({ ok: true, data: venture }, null, 2));
  } catch (err: any) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

// Only run CLI when executed directly (not when imported as module)
const isDirectRun = process.argv[1]?.endsWith('mint.ts') || process.argv[1]?.endsWith('mint.js');
if (isDirectRun) {
  main();
}
