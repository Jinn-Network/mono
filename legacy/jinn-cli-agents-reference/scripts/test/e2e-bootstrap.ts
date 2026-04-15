#!/usr/bin/env npx tsx
/**
 * E2E Bootstrap — One-command infrastructure + clone setup.
 *
 * Consolidates Phase 0 (VNet + local stack) and Phase 1 clone into a single command.
 * After this completes, the agent/user runs `yarn setup`, funding, ACL seeding,
 * and Docker build manually (operator workflow).
 *
 * Usage:
 *   yarn test:e2e:bootstrap --branch feature/oauth-credential-store
 *   yarn test:e2e:bootstrap                # defaults to main
 *
 * What it does:
 *   1. Cleans up stale VNets
 *   2. Creates a fresh Tenderly VNet (Base fork)
 *   3. Starts local stack (Ponder, Control API, Gateway) as detached processes
 *   4. Waits for all health checks
 *   5. Clones jinn-node at the specified branch, installs deps, configures .env
 *
 * After bootstrap, continue with:
 *   cd "$CLONE_DIR" && yarn setup
 *   yarn test:e2e:vnet fund <address> --eth <amount> --olas <amount>
 *   cd "$CLONE_DIR" && yarn setup
 *   yarn test:e2e:vnet seed-acl "$CLONE_DIR"
 *   docker build -f jinn-node/Dockerfile jinn-node/ -t jinn-node:e2e
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { cmdCreate, cmdCleanup } from './e2e-harness.js';
import { startStack } from './start-e2e-stack.js';
import { setupClone } from './setup-clone.js';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..');

// Load env files for Tenderly creds etc.
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.test'), override: true, quiet: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { branch: string } {
  let branch = 'main';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--branch' && i + 1 < args.length) {
      branch = args[++i];
    } else if (args[i].startsWith('--branch=')) {
      branch = args[i].split('=')[1];
    }
  }
  return { branch };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { branch } = parseArgs(process.argv.slice(2));

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║              E2E Bootstrap                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Branch: ${branch}\n`);

  // ── Phase 0: Infrastructure ──────────────────────────────────────────

  console.log('── Phase 0: Infrastructure ──\n');

  // 1. Cleanup stale VNets
  console.log('Step 1: Cleaning up stale VNets...');
  await cmdCleanup({ 'max-age-hours': '0' });

  // 2. Create fresh VNet
  console.log('\nStep 2: Creating fresh VNet...');
  const { rpcUrl, vnetId } = await cmdCreate({});

  // 3-4. Start local stack + wait for health checks
  console.log('\nStep 3: Starting local stack...');
  const { pm, pids } = await startStack(rpcUrl);

  // Register signal handlers now — covers the clone step (longest operation)
  process.on('SIGINT', async () => {
    console.log('\nShutting down stack (SIGINT)...');
    await pm.killAll();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\nParent exiting (SIGTERM) — stack services continue on their ports.');
    process.exit(0);
  });

  // ── Phase 1: Clone ──────────────────────────────────────────────────

  console.log('\n── Phase 1: Clone ──\n');

  // 4. Clone jinn-node
  console.log(`Step 4: Cloning jinn-node (branch: ${branch})...`);
  let cloneDir: string;
  try {
    ({ cloneDir } = await setupClone(branch));
  } catch (e) {
    console.error('\nClone failed — killing stack...');
    await pm.killAll();
    throw e;
  }

  // ── Summary ──────────────────────────────────────────────────────────

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║              Bootstrap Complete                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  VNet ID:   ${vnetId}`);
  console.log(`  RPC URL:   ${rpcUrl}`);
  console.log(`  Clone:     ${cloneDir}`);
  for (const [name, pid] of pids) {
    console.log(`  ${name} PID: ${pid}`);
  }
  console.log('\n── Next Steps ──\n');
  console.log(`  cd "${cloneDir}" && yarn setup`);
  console.log(`  # Fund the addresses printed by setup:`);
  console.log(`  yarn test:e2e:vnet fund <address> --eth <amount> --olas <amount>`);
  console.log(`  cd "${cloneDir}" && yarn setup`);
  console.log(`  yarn test:e2e:vnet seed-acl "${cloneDir}"`);
  console.log(`  docker build -f jinn-node/Dockerfile jinn-node/ -t jinn-node:e2e`);
  console.log(`  # Test credential permissions (including venture matrix):`);
  console.log(`  yarn test:e2e:permissions --cwd "${cloneDir}" --venture`);
  console.log('');

  // Exit cleanly — stack services continue as detached processes on their ports.
  // Without this, the child process pipes keep the Node event loop alive.
  process.exit(0);
}

main().catch(e => {
  console.error('BOOTSTRAP FAILED:', e.message || e);
  process.exit(1);
});
