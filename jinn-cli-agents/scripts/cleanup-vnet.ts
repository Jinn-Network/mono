#!/usr/bin/env tsx
/**
 * Tenderly VNet Cleanup Utility
 *
 * Deletes preserved VNets after review is complete.
 *
 * Usage:
 *   yarn cleanup:vnet <vnet-id>                    # Delete specific VNet
 *   yarn cleanup:vnet --session <session-file>     # Delete VNet from session
 *   yarn cleanup:vnet --all                        # Delete all VNets from session files
 */

import { createTenderlyClient } from './lib/tenderly.js';
import { SessionManager } from './lib/session.js';
import { promises as fs } from 'fs';
import { join } from 'path';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage:');
    console.log('  yarn cleanup:vnet <vnet-id>                  # Delete specific VNet');
    console.log('  yarn cleanup:vnet --session <file>           # Delete VNet from session file');
    console.log('  yarn cleanup:vnet --all                      # Delete all session VNets');
    process.exit(0);
  }

  const client = createTenderlyClient();

  if (args[0] === '--session') {
    // Delete VNet from specific session file
    const sessionFile = args[1];
    if (!sessionFile) {
      console.error('Error: --session requires a file path');
      process.exit(1);
    }

    const session = await SessionManager.load(sessionFile);
    console.log(`Deleting VNet from session: ${sessionFile}`);
    console.log(`  VNet ID: ${session.vnetId}`);

    await client.deleteVnet(session.vnetId);
    console.log('✓ VNet deleted successfully');

  } else if (args[0] === '--all') {
    // Delete all VNets from session files
    const files = await fs.readdir(process.cwd());
    const sessionFiles = files.filter(f => f.startsWith('.vnet-session-') && f.endsWith('.json'));

    if (sessionFiles.length === 0) {
      console.log('No session files found');
      process.exit(0);
    }

    console.log(`Found ${sessionFiles.length} session file(s)`);
    for (const file of sessionFiles) {
      try {
        const session = await SessionManager.load(join(process.cwd(), file));
        console.log(`\nDeleting VNet: ${session.vnetId}`);
        console.log(`  From: ${file}`);
        await client.deleteVnet(session.vnetId);
        console.log('  ✓ Deleted');
      } catch (err) {
        console.error(`  ✗ Failed: ${err}`);
      }
    }

  } else {
    // Delete specific VNet ID
    const vnetId = args[0];
    console.log(`Deleting VNet: ${vnetId}`);
    await client.deleteVnet(vnetId);
    console.log('✓ VNet deleted successfully');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
