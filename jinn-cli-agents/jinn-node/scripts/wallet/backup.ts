#!/usr/bin/env tsx
/**
 * Backup - Create encrypted backup of .operate directory
 *
 * Usage:
 *   yarn wallet:backup                           # Backup to default filename
 *   yarn wallet:backup --output backup.tar.gz   # Backup to specific file
 *
 * The .operate directory contains:
 * - Encrypted wallet keys
 * - Service configurations
 * - SSL certificates
 *
 * Keep backups secure - they contain your encrypted private keys!
 */

import 'dotenv/config';
import { parseArgs } from 'util';
import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';

function getOperateHome(): string {
  if (process.env.OPERATE_HOME) {
    return process.env.OPERATE_HOME;
  }
  return join(process.cwd(), '.operate');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function createBackup(operateHome: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use tar to create compressed archive
    const tar = spawn('tar', [
      '-czvf',
      outputPath,
      '-C',
      join(operateHome, '..'),
      '.operate'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';

    tar.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    tar.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar failed with code ${code}: ${stderr}`));
      }
    });

    tar.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });

  if (values.help) {
    console.log(`
Backup the .operate directory containing wallet keys and configs.

Usage:
  yarn wallet:backup                           # Backup to timestamped file
  yarn wallet:backup --output backup.tar.gz   # Backup to specific file

Options:
  --output, -o   Output filename (default: jinn-backup-<timestamp>.tar.gz)
  --help, -h     Show this help message

The backup includes:
  - Encrypted wallet private keys
  - Service configurations
  - SSL certificates

⚠️  Keep backups secure! They contain encrypted private keys.
    Anyone with the backup AND your OPERATE_PASSWORD can access your funds.
`);
    process.exit(0);
  }

  const operateHome = getOperateHome();

  // Check if .operate exists
  if (!existsSync(operateHome)) {
    console.error(`Error: .operate directory not found at ${operateHome}`);
    console.error('Run setup first to create wallet.');
    process.exit(1);
  }

  // Generate default output filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outputPath = values.output || `jinn-backup-${timestamp}.tar.gz`;
  const absoluteOutput = resolve(process.cwd(), outputPath);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    WALLET BACKUP                              ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Source:      ${operateHome}`);
  console.log(`Destination: ${absoluteOutput}`);
  console.log('');
  console.log('Creating backup...');

  try {
    await createBackup(operateHome, absoluteOutput);

    // Get backup file size
    const stats = statSync(absoluteOutput);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ Backup created successfully!');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`File: ${absoluteOutput}`);
    console.log(`Size: ${formatBytes(stats.size)}`);
    console.log('');
    console.log('⚠️  IMPORTANT:');
    console.log('   - Store this backup securely (encrypted storage, safe deposit box)');
    console.log('   - You need OPERATE_PASSWORD to restore from this backup');
    console.log('   - Never share the backup file or password');
    console.log('');
    console.log('To restore:');
    console.log(`   tar -xzvf ${outputPath} -C ~`);
    console.log('');

  } catch (error) {
    console.error('❌ Backup failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
