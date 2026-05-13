// client/test/e2e/_daemon-harness-helpers.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  spawnAnvilFork,
  jsonRpc as anvilJsonRpc,
  type AnvilHarness,
} from '../_support/chain/anvil.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import {
  SERVICE_REGISTRY_L2_ABI,
  getChainConfig,
} from '../../src/earning/contracts.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { decryptMnemonic, walletPrivateKeyAtIndex } from '../../src/earning/wallet.js';
import {
  ANVIL_PRIVATE_KEYS,
  compileContracts,
} from './task-first-helpers.js';
export { compileContracts };

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';

const CHAIN_CONFIG = getChainConfig('base');

const PASSWORD = 'test-password';

// ── Types ─────────────────────────────────────────────────────────────────────

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

export interface BootstrappedOperator {
  /** Agent EOA private key — held in the test process, not on disk. */
  agentPrivateKey: `0x${string}`;
  agentAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress: `0x${string}`;
  serviceId: bigint;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pick the harness from JINN_E2E_HARNESS, default `hermes-agent`. */
export function harnessSelectorFromEnv(): HarnessSelector {
  const raw = (process.env['JINN_E2E_HARNESS'] ?? 'hermes-agent').trim();
  if (raw === 'hermes-agent' || raw === 'claude-code' || raw === 'codex' || raw === 'prediction-v1-baseline') {
    return raw;
  }
  throw new Error(`JINN_E2E_HARNESS=${raw} not recognised. Use one of: hermes-agent, claude-code, codex, prediction-v1-baseline.`);
}

/**
 * Spawns an Anvil fork of Base mainnet, funds Anvil-deterministic accounts,
 * and assembles scratch dirs. Does NOT run earning bootstrap — that's a
 * separate helper because the production Daemon path uses FleetBootstrapper
 * instead.
 */
export async function setupAnvilFixture(): Promise<DaemonHarnessFixture> {
  await compileContracts();
  const anvil = await spawnAnvilFork({ forkUrl: BASE_RPC_URL, silent: true });
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

/**
 * Run the FleetBootstrapper 11-step lifecycle to `complete` on the Anvil fork.
 * Funds the EOA via Anvil's anvil_setBalance (stOLAS mode — the distributor
 * funds the OLAS bond on-chain, so only ETH is required on the master EOA).
 *
 * Pattern lifted from `client/test/e2e/staking.ts` — see that file for the
 * canonical funding sequence.
 *
 * Returns the on-chain identifiers downstream Daemon construction needs.
 */
export async function bootstrapStakedOperator(
  fixture: DaemonHarnessFixture,
): Promise<BootstrappedOperator> {
  const rpcUrl = fixture.anvil.rpcUrl;

  // Step 1: Create a temp earning dir under implStateRoot.
  const earningDir = await mkdtemp(join(fixture.implStateRoot, 'earning-'));

  // Step 2: Construct bootstrapper — run to awaiting_funding to learn the EOA address.
  const bootstrapper = new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl,
  });

  const firstResult = await bootstrapper.bootstrap(PASSWORD);

  if (!firstResult.funding) {
    // Unexpectedly completed on first pass (shouldn't happen with a fresh earningDir).
    if (!firstResult.ok) {
      throw new Error(`FleetBootstrapper failed before funding gate: ${firstResult.message}`);
    }
    // Already complete — unlikely but handle it below.
  }

  // Step 3: Fund master EOA with 100 ETH so it can pay gas for all 11 steps.
  // stOLAS mode: the distributor handles OLAS bond — only ETH is needed on the EOA.
  const masterAddress = firstResult.funding?.master_address ?? firstResult.fleet_state.master_address;
  if (!masterAddress) {
    throw new Error('FleetBootstrapper did not expose a master EOA address');
  }

  await anvilJsonRpc(rpcUrl, 'anvil_setBalance', [
    getAddress(masterAddress) as Address,
    '0x56BC75E2D63100000', // 100 ETH in hex — exact value from staking.ts
  ]);

  // Mine a block so the provider sees the new balance.
  await anvilJsonRpc(rpcUrl, 'evm_mine', []);

  // Step 4: Re-create bootstrapper with a fresh provider (avoids stale balance cache)
  // and run to completion.
  const bootstrapper2 = new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl,
  });

  const result = await bootstrapper2.bootstrap(PASSWORD);

  if (!result.ok) {
    throw new Error(`FleetBootstrapper did not reach complete: ${result.message}`);
  }

  // Step 5: Extract per-service state.
  const service = result.fleet_state.services.find(
    (svc) => svc.safe_address && svc.mech_address,
  );
  if (!service?.safe_address || !service.mech_address || service.service_id == null) {
    throw new Error(
      `Bootstrap completed but missing required service fields: ` +
      `safe=${service?.safe_address ?? 'null'} ` +
      `mech=${service?.mech_address ?? 'null'} ` +
      `serviceId=${service?.service_id ?? 'null'}`,
    );
  }

  // Step 6: Decrypt mnemonic to derive agent private key.
  const store = new FleetStateStore(earningDir);
  const mnemonic = await decryptMnemonic(
    await store.loadMnemonicKeystore(),
    PASSWORD,
  );
  const agentPrivateKey = walletPrivateKeyAtIndex(mnemonic, service.index);
  const agentAddress = getAddress(service.agent_address) as `0x${string}`;

  const serviceId = BigInt(service.service_id);

  // Step 7 (sanity check): verify service is staked on-chain — mirrors staking.ts Phase 5.
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const serviceState = await publicClient.readContract({
    address: CHAIN_CONFIG.serviceRegistry as Address,
    abi: SERVICE_REGISTRY_L2_ABI,
    functionName: 'getService',
    args: [serviceId],
  });
  if (Number(serviceState.state) !== 4) {
    throw new Error(
      `Expected service state 4 (Deployed), got ${serviceState.state} for serviceId=${serviceId}`,
    );
  }

  const stakingAbi = parseAbi([
    'function getServiceIds() view returns (uint256[])',
  ]);
  const stakedIds = await publicClient.readContract({
    address: CHAIN_CONFIG.stakingContract as Address,
    abi: stakingAbi,
    functionName: 'getServiceIds',
  });
  if (!stakedIds.includes(serviceId)) {
    throw new Error(
      `Service ${serviceId} not found in staking contract's getServiceIds()`,
    );
  }

  return {
    agentPrivateKey: agentPrivateKey as `0x${string}`,
    agentAddress,
    safeAddress: getAddress(service.safe_address) as `0x${string}`,
    mechAddress: getAddress(service.mech_address) as `0x${string}`,
    serviceId,
  };
}
