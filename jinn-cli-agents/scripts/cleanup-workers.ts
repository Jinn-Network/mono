#!/usr/bin/env tsx
/**
 * Worker Directory Cleanup Script
 *
 * Removes orphaned worker directories created by parallel worker runs.
 * Preserves the 'default' directory unless --include-default is specified.
 *
 * Usage:
 *   yarn cleanup:workers           # Interactive (prompts before delete)
 *   yarn cleanup:workers --force   # No prompt
 *   yarn cleanup:workers --dry-run # Show what would be deleted
 */

import { readdirSync, rmSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as readline from 'readline';

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

function getDirSize(dirPath: string): string {
  try {
    const result = execSync(`du -sh "${dirPath}" 2>/dev/null`, { encoding: 'utf-8' });
    return result.split('\t')[0].trim();
  } catch {
    return '?';
  }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('force', {
      alias: 'f',
      type: 'boolean',
      default: false,
      description: 'Delete without prompting',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      description: 'Show what would be deleted without deleting',
    })
    .option('include-default', {
      type: 'boolean',
      default: false,
      description: 'Also delete the default worker directory',
    })
    .example('$0', 'Interactive cleanup')
    .example('$0 --dry-run', 'Preview what would be deleted')
    .example('$0 --force', 'Delete all without prompting')
    .help()
    .parse();

  // Worker directory locations
  const workerPaths = [
    join(homedir(), 'jinn-repos', 'workers'),
    join(homedir(), '.jinn', 'workstreams', 'workers'),
  ];

  let totalDeleted = 0;

  for (const basePath of workerPaths) {
    if (!existsSync(basePath)) {
      continue;
    }

    // Get worker directories
    const entries = readdirSync(basePath, { withFileTypes: true });
    const workerDirs = entries
      .filter((e) => e.isDirectory())
      .filter((e) => argv.includeDefault || e.name !== 'default')
      .map((e) => e.name);

    if (workerDirs.length === 0) {
      console.log(`No worker directories found in ${basePath}`);
      continue;
    }

    console.log(`\nFound ${workerDirs.length} worker dir(s) in ${basePath}:`);

    // Show directories with sizes
    for (const dir of workerDirs) {
      const fullPath = join(basePath, dir);
      const size = getDirSize(fullPath);
      console.log(`  - ${dir} (${size})`);
    }

    if (argv.dryRun) {
      console.log('\n[dry-run] Would delete the above directories.');
      continue;
    }

    // Confirm deletion
    if (!argv.force) {
      const proceed = await confirm('\nDelete these directories?');
      if (!proceed) {
        console.log('Skipped.');
        continue;
      }
    }

    // Delete directories
    for (const dir of workerDirs) {
      const fullPath = join(basePath, dir);
      try {
        rmSync(fullPath, { recursive: true, force: true });
        console.log(`  Deleted: ${dir}`);
        totalDeleted++;
      } catch (err) {
        console.error(`  Failed to delete ${dir}:`, err);
      }
    }
  }

  if (argv.dryRun) {
    console.log('\n[dry-run] No directories were deleted.');
  } else if (totalDeleted > 0) {
    console.log(`\nDeleted ${totalDeleted} worker director${totalDeleted === 1 ? 'y' : 'ies'}.`);
  } else {
    console.log('\nNo directories to delete.');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
