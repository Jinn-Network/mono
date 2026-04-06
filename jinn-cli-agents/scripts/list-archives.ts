#!/usr/bin/env tsx
/**
 * List all archived dev-vnet runs
 *
 * Shows summary information for each archived run.
 *
 * Usage:
 *   yarn list:archives
 */

import { join } from 'path';
import { readdir, readFile } from 'fs/promises';

const ARCHIVES_DIR = join(process.cwd(), 'ponder/.ponder/archives');

interface ArchiveMetadata {
  runId: string;
  timestamp: string;
  vnetId: string;
  vnetDashboard: string;
  quotaExhausted: boolean;
  startBlock: number;
  stats: {
    marketplaceRequests: number;
    deliveries: number;
    artifacts: number;
  };
  reason?: string;
}

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('Available dev-vnet run archives');
  console.log('='.repeat(60));
  console.log('');

  try {
    const entries = await readdir(ARCHIVES_DIR, { withFileTypes: true });
    const archives = entries.filter(e => e.isDirectory() && e.name.startsWith('run-'));

    if (archives.length === 0) {
      console.log('No archives found.');
      console.log('Run `yarn dev:vnet` to create your first archived run.');
      console.log('');
      return;
    }

    // Sort by newest first
    archives.sort((a, b) => b.name.localeCompare(a.name));

    for (const archive of archives) {
      const runId = archive.name.replace('run-', '');
      const metadataPath = join(ARCHIVES_DIR, archive.name, 'metadata.json');

      try {
        const metadata: ArchiveMetadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
        const date = new Date(metadata.timestamp);
        const dateStr = date.toLocaleString();

        console.log(`  ${runId} (${dateStr})`);
        console.log(`    VNet: ${metadata.vnetId}`);
        console.log(`    Dashboard: ${metadata.vnetDashboard}`);
        console.log(`    Start Block: ${metadata.startBlock}`);
        console.log(`    Requests: ${metadata.stats.marketplaceRequests}, Deliveries: ${metadata.stats.deliveries}, Artifacts: ${metadata.stats.artifacts}`);

        const statusParts: string[] = [];
        if (metadata.quotaExhausted) {
          statusParts.push('quota exhausted');
        }
        if (metadata.reason) {
          statusParts.push(metadata.reason.replace('_', ' '));
        }
        if (statusParts.length > 0) {
          console.log(`    Status: ${statusParts.join(', ')}`);
        }

        console.log('');
      } catch (error) {
        console.log(`  ${runId} (metadata unavailable)`);
        console.log('');
      }
    }

    console.log('To review a run: yarn review:vnet <run-id>');
    console.log('');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log('No archives directory found.');
      console.log('Run `yarn dev:vnet` to create your first archived run.');
      console.log('');
    } else {
      console.error('Error listing archives:', error.message);
      console.log('');
    }
  }
}

main().catch(console.error);
