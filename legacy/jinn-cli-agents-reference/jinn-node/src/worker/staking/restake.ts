/**
 * Auto-Restake — Detect and restake evicted services via middleware
 *
 * Routes through OlasOperateWrapper → middleware daemon → Python Safe tx builder.
 * This is the same battle-tested path Pearl uses for staking operations.
 *
 * Used by:
 * - Worker startup (auto-restake evicted services)
 * - CLI script (`yarn wallet:restake`)
 */

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import { join } from 'path';
import { workerLogger } from '../../logging/index.js';
import { createRpcProvider } from '../../config/index.js';
import { OlasOperateWrapper } from '../OlasOperateWrapper.js';
import { SERVICE_CONSTANTS } from '../config/ServiceConfig.js';

const log = workerLogger.child({ component: 'AUTO-RESTAKE' });

const STAKING_ABI = [
  'function getStakingState(uint256 serviceId) view returns (uint8)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
  'function minStakingDuration() view returns (uint256)',
  'function availableRewards() view returns (uint256)',
  'function maxNumServices() view returns (uint256)',
  'function getServiceIds() view returns (uint256[])',
];

export const STAKING_STATE_NAMES: Record<number, string> = {
  0: 'UNSTAKED',
  1: 'STAKED',
  2: 'EVICTED',
};

export interface RestakeResult {
  serviceId: number;
  configId: string;
  previousState: number;
  finalState: number;
  success: boolean;
  reason: string;
  /** Unix timestamp (seconds) when cooldown expires — set when blocked by min staking duration */
  unstakeAvailableAt?: number;
}

export interface CheckAndRestakeOptions {
  rpcUrl: string;
  operatePassword: string;
  /** Restake only this service config ID (default: all evicted) */
  serviceFilter?: string;
  /** Preview without executing */
  dryRun?: boolean;
}

/**
 * Query on-chain staking state for a service.
 */
export async function getServiceStakingInfo(
  provider: ethers.JsonRpcProvider,
  serviceId: number,
  stakingContractAddress: string,
): Promise<{ state: number; canUnstake: boolean; unstakeAvailableAt: number | null }> {
  const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);

  let state: number;
  try {
    state = Number(await staking.getStakingState(serviceId));
  } catch {
    return { state: 0, canUnstake: false, unstakeAvailableAt: null };
  }

  if (state === 0) {
    return { state: 0, canUnstake: false, unstakeAvailableAt: null };
  }

  try {
    const info = await staking.getServiceInfo(serviceId);
    const tsStart = Number(info.tsStart);
    const minDuration = Number(await staking.minStakingDuration());
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - tsStart;
    const canUnstake = elapsed >= minDuration;
    const unstakeAvailableAt = canUnstake ? null : (tsStart + minDuration);
    return { state, canUnstake, unstakeAvailableAt };
  } catch {
    return { state, canUnstake: true, unstakeAvailableAt: null };
  }
}

/**
 * Check staking slot availability.
 */
export async function getStakingSlots(
  provider: ethers.JsonRpcProvider,
  stakingContractAddress: string,
): Promise<{ available: boolean; used: number; max: number }> {
  const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
  try {
    const maxServices = Number(await staking.maxNumServices());
    const serviceIds: bigint[] = await staking.getServiceIds();
    const used = serviceIds.length;
    return { available: used < maxServices, used, max: maxServices };
  } catch {
    return { available: true, used: 0, max: 0 };
  }
}

/**
 * Check if rewards are available in the staking contract.
 */
export async function getRewardsAvailable(
  provider: ethers.JsonRpcProvider,
  stakingContractAddress: string,
): Promise<boolean> {
  const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
  try {
    const rewards = await staking.availableRewards();
    return rewards > 0n;
  } catch {
    return true;
  }
}

// Default Jinn staking contract on Base (from ServiceConfig.ts single source of truth)
const DEFAULT_STAKING_CONTRACT = SERVICE_CONSTANTS.DEFAULT_STAKING_PROGRAM_ID;

/**
 * Read service configs from .operate/services on disk (no daemon needed).
 * Returns parsed configs with serviceId, configId, and staking contract.
 */
async function readServiceConfigsFromDisk(): Promise<Array<{
  configId: string;
  serviceId: number;
  stakingProgramId: string;
}>> {
  const candidates = [
    join(process.cwd(), '.operate', 'services'),
  ];

  let servicesDir: string | null = null;
  for (const dir of candidates) {
    try {
      await fs.access(dir);
      servicesDir = dir;
      break;
    } catch { /* not found, try next */ }
  }

  if (!servicesDir) {
    log.debug('No .operate/services directory found on disk');
    return [];
  }

  const entries = await fs.readdir(servicesDir, { withFileTypes: true });
  const serviceDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('sc-'));
  const configs: Array<{ configId: string; serviceId: number; stakingProgramId: string }> = [];

  for (const dir of serviceDirs) {
    try {
      const configPath = join(servicesDir, dir.name, 'config.json');
      const raw = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);
      const serviceId = config.chain_configs?.base?.chain_data?.token;
      const stakingProgramId =
        config.chain_configs?.base?.chain_data?.user_params?.staking_program_id ||
        DEFAULT_STAKING_CONTRACT;
      if (serviceId) {
        configs.push({ configId: dir.name, serviceId: Number(serviceId), stakingProgramId });
      }
    } catch { /* skip unreadable configs */ }
  }

  return configs;
}

/**
 * Check all services for eviction and restake any that are evicted.
 *
 * Phase 1: Reads service configs from disk and checks on-chain staking state.
 *          This requires only ethers (no Python daemon).
 * Phase 2: Only starts the middleware daemon if a service actually needs restaking.
 *
 * Returns results for every service that needed restaking (evicted or unstaked with staking configured).
 * Services already staked are silently skipped.
 */
export async function checkAndRestakeServices(options: CheckAndRestakeOptions): Promise<RestakeResult[]> {
  const { rpcUrl, operatePassword, serviceFilter, dryRun } = options;
  const results: RestakeResult[] = [];
  const provider = createRpcProvider(rpcUrl);

  // Phase 1: Read from disk + check on-chain state (no daemon needed)
  const diskConfigs = await readServiceConfigsFromDisk();
  if (diskConfigs.length === 0) {
    log.info('No service configs found on disk — skipping restake check');
    return results;
  }

  // Identify services that need restaking
  const needsRestake: Array<{
    configId: string;
    serviceId: number;
    stakingProgramId: string;
    state: number;
    canUnstake: boolean;
    unstakeAvailableAt: number | null;
  }> = [];

  for (const cfg of diskConfigs) {
    if (serviceFilter && cfg.configId !== serviceFilter) continue;

    const { state, canUnstake, unstakeAvailableAt } = await getServiceStakingInfo(
      provider, cfg.serviceId, cfg.stakingProgramId,
    );

    // Skip services that are already staked
    if (state === 1) continue;

    // Only process evicted (2) or unstaked-with-staking (0 with staking configured)
    if (state !== 2 && !(state === 0 && cfg.stakingProgramId)) continue;

    // Pre-flight: cooldown check
    if (state === 2 && !canUnstake) {
      log.info({ serviceId: cfg.serviceId, unstakeAvailableAt: unstakeAvailableAt ? new Date(unstakeAvailableAt * 1000).toISOString() : 'unknown' },
        'Service evicted but cooldown not elapsed');
      results.push({
        serviceId: cfg.serviceId, configId: cfg.configId, previousState: state, finalState: state,
        success: false, reason: 'cooldown not elapsed',
        unstakeAvailableAt: unstakeAvailableAt ?? undefined,
      });
      continue;
    }

    // Pre-flight: staking slots
    const slots = await getStakingSlots(provider, cfg.stakingProgramId);
    if (!slots.available) {
      log.info({ serviceId: cfg.serviceId, used: slots.used, max: slots.max }, 'No staking slots available');
      results.push({
        serviceId: cfg.serviceId, configId: cfg.configId, previousState: state, finalState: state,
        success: false, reason: `no staking slots (${slots.used}/${slots.max})`,
      });
      continue;
    }

    // Dry run — report but don't execute
    if (dryRun) {
      results.push({
        serviceId: cfg.serviceId, configId: cfg.configId, previousState: state, finalState: state,
        success: false, reason: 'dry run',
      });
      continue;
    }

    needsRestake.push({ ...cfg, state, canUnstake, unstakeAvailableAt });
  }

  // If no services need restaking, we're done — no daemon needed
  if (needsRestake.length === 0) {
    log.info({ checkedServices: diskConfigs.length }, 'All services are staked — no restake needed');
    return results;
  }

  // Phase 2: Start daemon only for services that need restaking
  log.info({ servicesToRestake: needsRestake.map(s => `#${s.serviceId}`) }, 'Starting middleware daemon for restake');

  const wrapper = await OlasOperateWrapper.create({ rpcUrl });
  try {
    await wrapper.startServer();
    await wrapper.login(operatePassword);

    for (const svc of needsRestake) {
      // Pre-flight: rewards (warning only, still attempt)
      const rewardsAvailable = await getRewardsAvailable(provider, svc.stakingProgramId);
      if (!rewardsAvailable) {
        log.warn({ serviceId: svc.serviceId }, 'No rewards available in staking contract (will still attempt restake)');
      }

      // Execute restake via middleware
      log.info({ serviceId: svc.serviceId, configId: svc.configId, stakingState: STAKING_STATE_NAMES[svc.state] }, 'Restaking service via middleware');

      try {
        const result = await wrapper.startService(svc.configId);
        if (!result.success) {
          log.debug({ serviceId: svc.serviceId, error: result.error }, 'Middleware returned error (may be expected — local deploy fails for Railway workers)');
        }
      } catch (err: any) {
        log.debug({ serviceId: svc.serviceId, error: err.message }, 'Middleware call threw (checking on-chain state)');
      }

      // Verify on-chain state regardless of middleware response
      const { state: finalState } = await getServiceStakingInfo(provider, svc.serviceId, svc.stakingProgramId);
      const success = finalState === 1;

      log.info({ serviceId: svc.serviceId, previousState: STAKING_STATE_NAMES[svc.state], finalState: STAKING_STATE_NAMES[finalState] ?? finalState, success },
        success ? 'Service restaked successfully' : 'Service restake may have failed');

      results.push({
        serviceId: svc.serviceId, configId: svc.configId, previousState: svc.state, finalState,
        success, reason: success ? 'restaked' : `final state: ${STAKING_STATE_NAMES[finalState] ?? finalState}`,
      });
    }
  } finally {
    await wrapper.stopServer();
  }

  return results;
}
