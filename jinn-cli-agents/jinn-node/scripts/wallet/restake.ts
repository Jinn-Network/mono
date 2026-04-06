#!/usr/bin/env tsx
/**
 * Restake — Restake evicted services or migrate to a different staking contract
 *
 * Routes through OlasOperateWrapper → middleware daemon → Python Safe tx builder.
 * This is the same battle-tested path Pearl uses for staking operations.
 *
 * Usage:
 *   yarn wallet:restake                              # Restake all evicted services
 *   yarn wallet:restake --service <config-id>        # Restake specific service
 *   yarn wallet:restake --target jinn_v2             # Migrate all services to v2
 *   yarn wallet:restake --target jinn_v2 --dry-run   # Preview migration
 *
 * The middleware's deploy_service_onchain_from_safe() handles:
 *   - Restake: detect eviction → claim rewards → unstake → approve → restake
 *   - Migration: detect agent_id change → unstake → terminate → unbond →
 *     re-register (new agent_id) → deploy Safe → stake on target contract
 */

import 'dotenv/config';
import { parseArgs } from 'util';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { createRpcProvider } from '../../src/config/index.js';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { getMiddlewarePath } from '../../src/env/operate-profile.js';
import {
  getServiceStakingInfo,
  getStakingSlots,
  getRewardsAvailable,
  checkAndRestakeServices,
  STAKING_STATE_NAMES,
  type RestakeResult,
} from '../../src/worker/staking/restake.js';

// Default Jinn staking contract on Base
const DEFAULT_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';

// Known staking contracts with agent metadata
interface StakingContractInfo {
  address: string;
  agentId: number;
  serviceHash: string; // IPFS hash for the service package (middleware auto-downloads)
  servicePublicId: string;
  agentRelease: { is_aea: boolean; repository: { owner: string; name: string; version: string } };
}

const KNOWN_STAKING_CONTRACTS: Record<string, StakingContractInfo> = {
  jinn: {
    address: '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139',
    agentId: 43,
    serviceHash: 'bafybeihmfr4cqvmyayqiltdxnlmuosvgqfbetpvfccjsuz3uosmi7db2iq',
    servicePublicId: 'dvilela/memeooorr:0.1.0',
    agentRelease: { is_aea: true, repository: { owner: 'valory-xyz', name: 'meme-ooorr', version: 'v2.0.2' } },
  },
  jinn_v2: {
    address: '0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488',
    agentId: 103,
    serviceHash: 'QmY3cVULHaiBavCWZEEgoVWmFJpo4gKWK42YFmyVESpp1r',
    servicePublicId: 'jinn/jinn_node:0.1.0',
    agentRelease: { is_aea: true, repository: { owner: 'Jinn-Network', name: 'jinn_node', version: 'v1.0.0' } },
  },
};

/**
 * Resolve a target staking contract from a name or raw address.
 * Returns the full StakingContractInfo for known contracts, or a minimal entry for raw addresses.
 */
function resolveTarget(target: string): StakingContractInfo {
  const known = KNOWN_STAKING_CONTRACTS[target.toLowerCase()];
  if (known) return known;
  if (ethers.isAddress(target)) {
    // Raw address — caller must ensure agent metadata is correct
    console.warn(`  Warning: Raw address ${target} — agent metadata will not be updated.`);
    console.warn('  Use a known contract name (jinn, jinn_v2) for full migration support.');
    return {
      address: ethers.getAddress(target),
      agentId: 0, // sentinel: don't update
      serviceHash: '',
      servicePublicId: '',
      agentRelease: { is_aea: true, repository: { owner: '', name: '', version: '' } },
    };
  }
  const names = Object.keys(KNOWN_STAKING_CONTRACTS).join(', ');
  console.error(`Unknown target: "${target}". Known contracts: ${names}`);
  console.error('You can also pass a raw contract address (0x...).');
  process.exit(1);
}

/**
 * Update a service config for migration to a target staking contract.
 * Sets staking_program_id, agent_id, service_public_id, package_path, and agent_release.
 * Returns the previous staking_program_id, or null if unchanged.
 */
function updateServiceStakingConfig(
  serviceConfigId: string,
  target: StakingContractInfo,
): string | null {
  const mwPath = getMiddlewarePath();
  if (!mwPath) {
    console.error('Cannot find .operate directory. Set OPERATE_PROFILE_DIR if needed.');
    process.exit(1);
  }

  const configPath = join(mwPath, '.operate', 'services', serviceConfigId, 'config.json');
  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);

  const homeChain = config.home_chain || 'base';
  const userParams = config.chain_configs?.[homeChain]?.chain_data?.user_params;
  if (!userParams) {
    console.error(`  No user_params found in config for chain ${homeChain}`);
    return null;
  }

  const previous = userParams.staking_program_id;
  if (previous?.toLowerCase() === target.address.toLowerCase()) {
    return null; // already on target
  }

  // Update staking contract
  userParams.staking_program_id = target.address;

  // Update agent metadata (when migrating between contracts with different agents)
  if (target.agentId > 0) {
    userParams.agent_id = target.agentId;
    config.service_public_id = target.servicePublicId;
    config.agent_release = target.agentRelease;
    config.hash = target.serviceHash;

    // Delete old local package so middleware re-downloads the correct one from IPFS.
    // The middleware's _ensure_package_exists() auto-downloads when the dir is missing.
    const serviceDir = join(mwPath, '.operate', 'services', serviceConfigId);
    const oldPkgPath = config.package_path;
    if (oldPkgPath) {
      const oldPkgDir = join(serviceDir, oldPkgPath);
      if (existsSync(oldPkgDir)) {
        rmSync(oldPkgDir, { recursive: true });
        console.log(`  Removed old package dir: ${oldPkgPath}/`);
      }
    }
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return previous;
}

interface ServiceInfo {
  serviceConfigId: string;
  name: string;
  serviceId: number;
  multisig: string;
  stakingProgramId: string;
  stakingState: number;
  stakingStateName: string;
  canUnstake: boolean;
  unstakeAvailableAt: number | null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      service: { type: 'string', short: 's' },
      target: { type: 'string', short: 't' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
Restake evicted services or migrate to a different staking contract.

Usage:
  yarn wallet:restake                              # Restake all evicted services
  yarn wallet:restake --service <config-id>        # Restake specific service
  yarn wallet:restake --target jinn_v2             # Migrate all services to v2
  yarn wallet:restake --target jinn_v2 --dry-run   # Preview migration

Options:
  --service, -s    Service config ID (default: all eligible)
  --target, -t     Target staking contract name or address for migration
  --dry-run        Preview without executing
  --help, -h       Show this help message

Known staking contracts:
${Object.entries(KNOWN_STAKING_CONTRACTS).map(([k, v]) => `  ${k}: ${v.address} (agent ${v.agentId})`).join('\n')}

Without --target: restakes evicted/unstaked services on their current contract.
With --target: migrates services to the target contract. The middleware handles
the full lifecycle (terminate, unbond, re-register, deploy, stake) automatically.
`);
    process.exit(0);
  }

  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    console.error('Error: OPERATE_PASSWORD environment variable is required');
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('Error: RPC_URL environment variable is required');
    process.exit(1);
  }

  const dryRun = values['dry-run'];
  const targetService = values.service;
  const targetInfo = values.target ? resolveTarget(values.target) : null;
  const isMigration = !!targetInfo;

  const title = isMigration
    ? `MIGRATE SERVICES → ${values.target?.toUpperCase()}`
    : 'RESTAKE EVICTED SERVICES';

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`              ${title} ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════════');
  if (isMigration) {
    console.log(`  Target contract: ${targetInfo!.address}`);
  }
  console.log('');

  // For the CLI, we do a verbose flow: list services, show states, pre-flight, then restake.
  // This gives operators full visibility. The core logic is in checkAndRestakeServices().

  const wrapper = await OlasOperateWrapper.create({ rpcUrl });
  const provider = createRpcProvider(rpcUrl);

  try {
    await wrapper.startServer();
    await wrapper.login(password);

    // Step 1: List services
    console.log('Step 1: Fetching services...');
    const servicesResult = await wrapper.getServices();
    if (!servicesResult.success || !servicesResult.services?.length) {
      console.error('Failed to get services:', servicesResult.error || 'No services found');
      process.exit(1);
    }

    // Step 2: Check staking state for each service
    console.log('\nStep 2: Checking staking states...\n');

    const serviceInfos: ServiceInfo[] = [];

    for (const svc of servicesResult.services) {
      const configId = svc.service_config_id;
      const serviceId = svc.chain_configs?.base?.chain_data?.token;
      const multisig = svc.chain_configs?.base?.chain_data?.multisig || '';
      const stakingProgramId =
        svc.chain_configs?.base?.chain_data?.user_params?.staking_program_id ||
        DEFAULT_STAKING_CONTRACT;

      if (!serviceId) {
        console.log(`  ${configId}: No on-chain service ID, skipping`);
        continue;
      }

      const { state, canUnstake, unstakeAvailableAt } = await getServiceStakingInfo(
        provider, serviceId, stakingProgramId,
      );

      const info: ServiceInfo = {
        serviceConfigId: configId,
        name: svc.name || configId,
        serviceId,
        multisig,
        stakingProgramId,
        stakingState: state,
        stakingStateName: STAKING_STATE_NAMES[state] || `UNKNOWN(${state})`,
        canUnstake,
        unstakeAvailableAt,
      };

      serviceInfos.push(info);

      const stateEmoji = state === 2 ? '!!' : state === 1 ? 'ok' : '--';
      console.log(
        `  [${stateEmoji}] Service #${serviceId} (${configId.slice(0, 20)}...): ${info.stakingStateName}`,
      );
      if (state === 2 && !canUnstake && unstakeAvailableAt) {
        console.log(`       Cannot unstake yet — available at ${new Date(unstakeAvailableAt * 1000).toISOString()}`);
      }
    }

    // Filter to target service if specified
    let candidates = serviceInfos;
    if (targetService) {
      candidates = candidates.filter((s) => s.serviceConfigId === targetService);
      if (candidates.length === 0) {
        console.error(`\nError: Service "${targetService}" not found.`);
        console.error(
          `Available: ${serviceInfos.map((s) => s.serviceConfigId).join(', ')}`,
        );
        process.exit(1);
      }
    }

    // Filter to services that need work
    let needsRestaking: ServiceInfo[];
    if (isMigration) {
      // Migration: include services staked on a DIFFERENT contract, evicted, or unstaked
      needsRestaking = candidates.filter((s) => {
        // Skip services already on the target contract and staked
        if (s.stakingProgramId.toLowerCase() === targetInfo!.address.toLowerCase() && s.stakingState === 1) {
          return false;
        }
        // Include: staked on different contract, evicted, or unstaked
        return s.stakingState === 1 || s.stakingState === 2 || (s.stakingState === 0 && s.stakingProgramId);
      });

      const alreadyOnTarget = candidates.filter(
        (s) => s.stakingProgramId.toLowerCase() === targetInfo!.address.toLowerCase() && s.stakingState === 1,
      );
      if (alreadyOnTarget.length > 0) {
        console.log(`\n  ${alreadyOnTarget.length} service(s) already staked on target — skipping`);
      }
    } else {
      // Restake: only evicted or unstaked services
      needsRestaking = candidates.filter(
        (s) => s.stakingState === 2 || (s.stakingState === 0 && s.stakingProgramId),
      );

      const alreadyStaked = candidates.filter((s) => s.stakingState === 1);
      if (alreadyStaked.length > 0) {
        console.log(`\n  ${alreadyStaked.length} service(s) already staked — skipping`);
      }
    }

    if (needsRestaking.length === 0) {
      console.log(`\n  No services need ${isMigration ? 'migration' : 'restaking'}.`);
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }

    // Step 3: Pre-flight checks
    console.log(`\nStep 3: Pre-flight checks for ${needsRestaking.length} service(s)...`);

    // For migration, check target contract slots once upfront
    if (isMigration) {
      const targetSlots = await getStakingSlots(provider, targetInfo!.address);
      console.log(`  Target contract slots: ${targetSlots.used}/${targetSlots.max}`);
      if (!targetSlots.available) {
        console.error('  Target staking contract is full. Cannot migrate.');
        process.exit(1);
      }
      console.log(`  ${targetSlots.max - targetSlots.used} slot(s) available`);
    }

    const blocked: ServiceInfo[] = [];
    const ready: ServiceInfo[] = [];

    for (const svc of needsRestaking) {
      // For restake (not migration), check if evicted service can unstake
      if (!isMigration && svc.stakingState === 2 && !svc.canUnstake) {
        blocked.push(svc);
        console.log(`  Service #${svc.serviceId}: BLOCKED — minimum staking duration not elapsed`);
        continue;
      }

      // Check slots on the contract we're staking INTO
      const stakingTarget = isMigration ? targetInfo!.address : svc.stakingProgramId;
      if (!isMigration) {
        // For restake, check slots per-service (each may be on different contracts)
        const slots = await getStakingSlots(provider, stakingTarget);
        if (!slots.available) {
          blocked.push(svc);
          console.log(
            `  Service #${svc.serviceId}: BLOCKED — no staking slots available (${slots.used}/${slots.max})`,
          );
          continue;
        }
      }

      const rewardsAvailable = await getRewardsAvailable(provider, stakingTarget);
      if (!rewardsAvailable) {
        console.log(
          `  Service #${svc.serviceId}: WARNING — no rewards available (will still attempt)`,
        );
      }

      ready.push(svc);
      console.log(`  Service #${svc.serviceId}: READY for ${isMigration ? 'migration' : 'restaking'}`);
    }

    if (ready.length === 0) {
      console.log('\n  No services are ready for restaking.');
      if (blocked.length > 0) {
        console.log(`  ${blocked.length} service(s) blocked (see above).`);
      }
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(1);
    }

    // Dry run — stop here
    if (dryRun) {
      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('DRY RUN COMPLETE — No transactions executed');
      console.log('');
      const action = isMigration ? 'migrate' : 'restake';
      console.log(`Would ${action} ${ready.length} service(s):`);
      for (const svc of ready) {
        if (isMigration) {
          console.log(
            `  - Service #${svc.serviceId} (${svc.stakingProgramId.slice(0, 10)}... → ${targetInfo!.address.slice(0, 10)}...)`,
          );
        } else {
          console.log(
            `  - Service #${svc.serviceId} (${svc.stakingStateName} → STAKED)`,
          );
        }
      }
      if (blocked.length > 0) {
        console.log(`\n${blocked.length} service(s) blocked:`);
        for (const svc of blocked) {
          const reason = !svc.canUnstake
            ? `min duration not elapsed (available ${svc.unstakeAvailableAt ? new Date(svc.unstakeAvailableAt * 1000).toISOString() : 'unknown'})`
            : 'no slots available';
          console.log(`  - Service #${svc.serviceId}: ${reason}`);
        }
      }
      console.log(`\nRemove --dry-run to execute ${action}`);
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }

    // Step 4: Execute via middleware
    const action = isMigration ? 'Migrating' : 'Restaking';
    console.log(`\nStep 4: ${action} ${ready.length} service(s) via middleware...`);

    const results: Array<{ serviceId: number; configId: string; success: boolean; finalState: string }> = [];

    for (const svc of ready) {
      console.log(`\n  ${action} Service #${svc.serviceId} (${svc.serviceConfigId})...`);

      // For migration: update config to point to target contract before calling middleware
      if (isMigration) {
        const previousContract = updateServiceStakingConfig(svc.serviceConfigId, targetInfo!);
        if (previousContract) {
          console.log(`  Config updated: staking_program_id ${previousContract.slice(0, 10)}... → ${targetInfo!.address.slice(0, 10)}...`);
        } else {
          console.log('  Config already points to target contract');
        }
      }

      console.log('  Calling middleware deploy_service_onchain_from_safe...');

      try {
        const result = await wrapper.startService(svc.serviceConfigId);

        if (result.success) {
          console.log('  Middleware returned success');
        } else {
          console.log(`  Middleware returned error: ${result.error}`);
          console.log('  (This may be expected — local Docker deploy fails for Railway workers)');
          console.log('  Checking on-chain state...');
        }
      } catch (err: any) {
        console.log(`  Middleware call failed: ${err.message}`);
        console.log('  Checking on-chain state...');
      }

      // Verify on-chain state — check against target contract for migration, source for restake
      const verifyContract = isMigration ? targetInfo!.address : svc.stakingProgramId;
      const { state: finalState } = await getServiceStakingInfo(
        provider, svc.serviceId, verifyContract,
      );
      const finalStateName = STAKING_STATE_NAMES[finalState] || `UNKNOWN(${finalState})`;

      const success = finalState === 1;
      results.push({
        serviceId: svc.serviceId,
        configId: svc.serviceConfigId,
        success,
        finalState: finalStateName,
      });

      if (success) {
        console.log(`  Service #${svc.serviceId}: STAKED ${isMigration ? '(migration successful)' : '(restake successful)'}`);
      } else {
        console.log(`  Service #${svc.serviceId}: ${finalStateName} (${isMigration ? 'migration' : 'restake'} may have failed)`);
      }
    }

    // Summary
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                        SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    for (const r of results) {
      const icon = r.success ? 'ok' : 'FAIL';
      console.log(`  [${icon}] Service #${r.serviceId}: ${r.finalState}`);
    }

    console.log('');
    console.log(`  ${succeeded.length} succeeded, ${failed.length} failed, ${blocked.length} blocked`);

    if (failed.length > 0) {
      console.log('');
      console.log('  Failed services may need manual intervention.');
      console.log('  Check: yarn wallet:unstake --service-id <id>');
      console.log('  Or use the olas-staking skill for guided restaking.');
    }

    console.log('═══════════════════════════════════════════════════════════════');

    if (failed.length > 0) {
      process.exit(1);
    }
  } finally {
    await wrapper.stopServer();
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
