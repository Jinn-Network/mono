#!/usr/bin/env npx tsx
/**
 * Clone and set up a jinn-node instance for E2E testing.
 *
 * Clones the repo to a temp directory, installs dependencies, verifies tsx,
 * copies .env.example, and configures the clone's .env with VNet settings.
 * Writes CLONE_DIR to .env.e2e for use by other E2E scripts.
 *
 * Usage:
 *   yarn test:e2e:clone                          # clone main branch
 *   yarn test:e2e:clone --branch feature/foo      # clone specific branch
 *   yarn test:e2e:clone --list-branches           # list available branches
 *
 * Requires:
 *   - .env.e2e with RPC_URL (run "yarn test:e2e:vnet create" first)
 */

import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import dotenv from 'dotenv';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..');
const E2E_ENV_FILE = resolve(MONOREPO_ROOT, '.env.e2e');
const REPO_URL = 'https://github.com/Jinn-Network/jinn-node.git';
const OPERATE_PASSWORD = 'e2e-test-password-2024';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { flags: Record<string, string>; boolFlags: Set<string> } {
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        boolFlags.add(key);
      }
    }
  }
  return { flags, boolFlags };
}

function run(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, {
    cwd: opts?.cwd ?? MONOREPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function runLoud(cmd: string, opts?: { cwd?: string }): void {
  execSync(cmd, {
    cwd: opts?.cwd ?? MONOREPO_ROOT,
    stdio: 'inherit',
  });
}

async function readEnvE2e(): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  try {
    const content = await fs.readFile(E2E_ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match) vars[match[1]] = match[2];
    }
  } catch { /* file doesn't exist */ }
  return vars;
}

async function appendEnvE2e(vars: Record<string, string>): Promise<void> {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  await fs.appendFile(E2E_ENV_FILE, lines.join('\n') + '\n');
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function listBranches() {
  console.log('Available branches:');
  const output = run(`git ls-remote --heads ${REPO_URL}`);
  for (const line of output.split('\n')) {
    const branch = line.replace(/.*refs\/heads\//, '').trim();
    if (branch) console.log(`  ${branch}`);
  }
}

export async function setupClone(branch: string): Promise<{ cloneDir: string }> {
  // 1. Read RPC_URL from .env.e2e
  const e2eVars = await readEnvE2e();
  const rpcUrl = e2eVars.RPC_URL;
  if (!rpcUrl) {
    throw new Error('No RPC_URL in .env.e2e — run "yarn test:e2e:vnet create" first.');
  }

  // 2. Create temp directory and clone
  const tmpBase = run('mktemp -d');
  const cloneDir = join(tmpBase, 'jinn-node');

  console.log(`Cloning jinn-node (branch: ${branch})...`);
  console.log(`  Target: ${cloneDir}`);
  runLoud(`git clone -b ${branch} ${REPO_URL} "${cloneDir}"`);

  // 3. Install dependencies
  console.log('\nInstalling dependencies...');
  runLoud(`yarn install`, { cwd: cloneDir });

  // 4. Verify tsx
  try {
    const tsxPath = join(cloneDir, 'node_modules', '.bin', 'tsx');
    await fs.access(tsxPath);
    console.log('  tsx: OK');
  } catch {
    throw new Error(
      `tsx not found in ${cloneDir}/node_modules/.bin/tsx\n` +
      'yarn install may have failed silently.'
    );
  }

  // 5. Configure .env — start from .env.example, override E2E-specific values
  const envExamplePath = join(cloneDir, '.env.example');
  const envPath = join(cloneDir, '.env');
  let envContent = await fs.readFile(envExamplePath, 'utf-8');

  const overrides: Record<string, string> = {
    RPC_URL: rpcUrl,
    OPERATE_PASSWORD,
    PONDER_GRAPHQL_URL: 'http://localhost:42069/graphql',
    CONTROL_API_URL: 'http://localhost:4001/graphql',
    X402_GATEWAY_URL: 'http://localhost:3001',
  };

  // Forward GITHUB_TOKEN from host env if available (operator-level credential).
  if (process.env.GITHUB_TOKEN) {
    overrides.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  for (const [key, value] of Object.entries(overrides)) {
    // Replace existing key=value lines (including commented-out ones)
    const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `${key}=${value}\n`;
    }
  }

  await fs.writeFile(envPath, envContent);
  console.log(`  .env configured with VNet RPC`);

  // 6. Save CLONE_DIR to .env.e2e
  await appendEnvE2e({
    CLONE_DIR: cloneDir,
    OPERATE_PASSWORD,
  });
  console.log(`  CLONE_DIR saved to .env.e2e`);

  // 7. Summary
  console.log(`\nClone ready:`);
  console.log(`  Directory:  ${cloneDir}`);
  console.log(`  Branch:     ${branch}`);
  console.log(`  RPC URL:    ${rpcUrl}`);
  console.log(`\nNext: run "yarn --cwd '${cloneDir}' setup" (may need funding iterations)`);

  return { cloneDir };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { flags, boolFlags } = parseArgs(process.argv.slice(2));

  if (boolFlags.has('list-branches')) {
    return listBranches();
  }

  const branch = flags.branch || 'main';
  await setupClone(branch);
}

// Only run CLI when executed directly (not when imported as library)
const isDirectRun = process.argv[1]?.includes('setup-clone');
if (isDirectRun) {
  main().catch(e => {
    console.error('FAILED:', e.message || e);
    process.exit(1);
  });
}
