#!/usr/bin/env tsx
/**
 * Rewards Summary - OLAS staking rewards tracker
 *
 * Usage: yarn rewards:summary
 *
 * Shows total accrued rewards, per-service breakdown, APY, and health status
 * for all staked services.
 *
 * Requires: RPC_URL environment variable
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { listServiceConfigs } from '../../src/worker/ServiceConfigReader.js';
import { ActivityMonitor, type ServiceCheckInput, type ServiceDashboardStatus } from '../../src/worker/rotation/ActivityMonitor.js';
import { printHeader } from '../../src/setup/display.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

async function resolveMiddlewarePath(): Promise<string> {
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    return resolve(process.env.OLAS_MIDDLEWARE_PATH);
  }
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), '..', '..');
}

function formatOlas(wei: bigint, decimals: number = 4): string {
  return parseFloat(ethers.formatEther(wei)).toFixed(decimals);
}

function formatDate(timestamp: number): string {
  if (timestamp === 0) return 'N/A';
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return `${h} hour${h === 1 ? '' : 's'}`;
}

async function main() {
  printHeader('OLAS Rewards Summary');

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('  RPC_URL environment variable is required.\n');
    process.exit(1);
  }

  const middlewarePath = await resolveMiddlewarePath();
  const allServices = await listServiceConfigs(middlewarePath);

  const stakedServices = allServices.filter(
    s => s.stakingContractAddress && s.serviceId && s.serviceSafeAddress
  );

  if (stakedServices.length === 0) {
    console.log('  No staked services found.\n');
    if (allServices.length > 0) {
      console.log(`  Found ${allServices.length} service(s) but none are staked.`);
      console.log('  Use yarn service:add to add a staked service.\n');
    }
    process.exit(0);
  }

  const monitor = new ActivityMonitor(rpcUrl, 0);
  const inputs: ServiceCheckInput[] = stakedServices.map(s => ({
    serviceConfigId: s.serviceConfigId,
    serviceId: s.serviceId!,
    multisig: s.serviceSafeAddress!,
    stakingContract: s.stakingContractAddress!,
  }));

  let statuses: ServiceDashboardStatus[];
  try {
    statuses = await monitor.getAllDashboardData(inputs);
  } catch (error) {
    console.error(`  Failed to fetch on-chain data: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Total accrued rewards
  const totalAccrued = statuses.reduce((sum, s) => sum + s.accruedRewards, 0n);
  console.log(`  Total Accrued Rewards:  ${formatOlas(totalAccrued)} OLAS\n`);

  // --- Per Service ---
  console.log('  \u2500\u2500 Per Service \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  for (const status of statuses) {
    const svc = stakedServices.find(s => s.serviceConfigId === status.serviceConfigId);
    if (!svc) continue;

    const epochRewardOlas = formatOlas(status.estimatedEpochReward);
    const eligibilityLabel = status.error
      ? 'error'
      : status.isEligibleForRewards
        ? 'eligible'
        : 'in progress';

    const inactivityLabel = status.inactivityCount === 0
      ? 'healthy'
      : status.inactivityCount >= (status.maxInactivityPeriods || 3) - 1
        ? 'AT RISK of eviction'
        : `${status.inactivityCount} epoch${status.inactivityCount === 1 ? '' : 's'}`;

    console.log(`  Service #${status.serviceId} (${status.serviceConfigId})`);
    console.log(`    Accrued:     ${formatOlas(status.accruedRewards)} OLAS`);
    console.log(`    This Epoch:  ~${epochRewardOlas} OLAS (${eligibilityLabel})`);
    console.log(`    Activity:    ${status.eligibleActivities}/${status.requiredActivities} deliveries`);
    console.log(`    Inactivity:  ${inactivityLabel}`);
    console.log(`    Staked Since: ${formatDate(status.tsStart)}`);
    console.log('');
  }

  // --- Contract Details ---
  // Group by staking contract
  const contractGroups = new Map<string, ServiceDashboardStatus[]>();
  for (const s of statuses) {
    const key = s.stakingContract.toLowerCase();
    const group = contractGroups.get(key) || [];
    group.push(s);
    contractGroups.set(key, group);
  }

  console.log('  \u2500\u2500 Contract Details \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  for (const [contractAddr, contractStatuses] of contractGroups) {
    const first = contractStatuses[0];

    // Rewards rate
    const rewardsPerSecondFloat = parseFloat(ethers.formatEther(first.rewardsPerSecond));
    const rewardsPerDay = rewardsPerSecondFloat * 86400;
    console.log(`  Contract:     ${contractAddr}`);
    console.log(`  Rewards Rate: ${rewardsPerSecondFloat.toFixed(6)} OLAS/sec (~${rewardsPerDay.toFixed(2)} OLAS/day)`);

    // APY
    const ONE_YEAR = 365 * 24 * 60 * 60;
    if (first.rewardsPerSecond > 0n && first.minStakingDeposit > 0n) {
      const rewardsPerYear = first.rewardsPerSecond * BigInt(ONE_YEAR);
      const apyBps = (rewardsPerYear * 10000n) / first.minStakingDeposit;
      const apyPct = Number(apyBps) / 100;
      const depositOlas = formatOlas(first.minStakingDeposit, 0);
      console.log(`  APY:          ~${apyPct.toFixed(1)}% (on ${depositOlas} OLAS deposit)`);
    }

    console.log(`  Epoch Length: ${formatDuration(first.livenessPeriod)}`);
    console.log(`  Slots:        ${first.currentStakedCount}/${first.maxNumServices}`);
    console.log('');
  }

  // --- Health Summary ---
  console.log('  \u2500\u2500 Health \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  const maxInactivity = statuses[0]?.maxInactivityPeriods || 3;
  const withInactivity = statuses.filter(s => s.inactivityCount > 0);
  const evicted = statuses.filter(s => s.stakingState === 2);
  const eligible = statuses.filter(s => s.isEligibleForRewards && !s.error);
  const errors = statuses.filter(s => s.error);

  console.log(`  Eviction threshold: ${maxInactivity} consecutive inactive epochs`);

  if (evicted.length > 0) {
    console.log(`  EVICTED: ${evicted.length} service(s) — requires re-staking`);
  }
  if (withInactivity.length > 0) {
    for (const s of withInactivity) {
      console.log(`  WARNING: Service #${s.serviceId} has ${s.inactivityCount} inactive epoch(s)`);
    }
  }
  if (errors.length > 0) {
    console.log(`  ERRORS: ${errors.length} service(s) could not be queried`);
  }

  if (evicted.length === 0 && withInactivity.length === 0 && errors.length === 0) {
    console.log(`  All ${statuses.length} service(s): 0 inactive epochs (healthy)`);
  }

  console.log(`  Eligible this epoch: ${eligible.length}/${statuses.length}`);
  console.log('');
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
