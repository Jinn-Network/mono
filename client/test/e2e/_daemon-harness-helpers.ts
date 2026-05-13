// client/test/e2e/_daemon-harness-helpers.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  http,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
// `spawnPlainAnvil` (plain Anvil, no fork) lives only in task-first-helpers; the
// canonical _support/chain/anvil.ts exports `spawnAnvilFork` (fork mode). Task 1
// intentionally uses plain Anvil — do NOT switch to spawnAnvilFork here.
import {
  ANVIL_PRIVATE_KEYS,
  compileContracts,
  spawnPlainAnvil,
  type AnvilHarness,
} from './task-first-helpers.js';
export { compileContracts };
// jsonRpc comes from the canonical _support/chain/anvil.ts (the direction the codebase is moving).
import { jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';

export type HarnessSelector = 'hermes-agent' | 'claude-code' | 'codex' | 'prediction-v1-baseline';

export interface DaemonHarnessFixture {
  anvil: AnvilHarness;
  publicClient: PublicClient;
  operatorEoa: ReturnType<typeof privateKeyToAccount>;
  workingDirRoot: string;
  implStateRoot: string;
  /** Disposes anvil, deletes scratch dirs, etc. */
  teardown: () => Promise<void>;
}

/** Pick the harness from JINN_E2E_HARNESS, default `hermes-agent`. */
export function harnessSelectorFromEnv(): HarnessSelector {
  const raw = (process.env['JINN_E2E_HARNESS'] ?? 'hermes-agent').trim();
  if (raw === 'hermes-agent' || raw === 'claude-code' || raw === 'codex' || raw === 'prediction-v1-baseline') {
    return raw;
  }
  throw new Error(`JINN_E2E_HARNESS=${raw} not recognised. Use one of: hermes-agent, claude-code, codex, prediction-v1-baseline.`);
}

/**
 * Set up Anvil + fund Anvil-deterministic accounts + assemble scratch dirs.
 * Does NOT run earning bootstrap — that's a separate helper because the
 * production Daemon path uses FleetBootstrapper instead.
 */
export async function setupAnvilFixture(): Promise<DaemonHarnessFixture> {
  await compileContracts();
  const anvil = await spawnPlainAnvil();
  const operatorEoa = privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!); // skip deployer
  const publicClient = createPublicClient({
    chain: base,
    transport: http(anvil.rpcUrl),
  }) as unknown as PublicClient;

  await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
    operatorEoa.address,
    '0x56bc75e2d63100000', // 100 ETH
  ]);

  const workingDirRoot = mkdtempSync(join(tmpdir(), 'jinn-daemon-harness-work-'));
  const implStateRoot = mkdtempSync(join(tmpdir(), 'jinn-daemon-harness-state-'));

  return {
    anvil,
    publicClient,
    operatorEoa,
    workingDirRoot,
    implStateRoot,
    async teardown() {
      try { await anvil.teardown(); } catch {}
      try { rmSync(workingDirRoot, { recursive: true, force: true }); } catch {}
      try { rmSync(implStateRoot, { recursive: true, force: true }); } catch {}
    },
  };
}
