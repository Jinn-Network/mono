#!/usr/bin/env tsx
/**
 * List Services - Show all OLAS services and their rotation status
 *
 * Usage: yarn service:list
 *
 * If RPC_URL is set, also queries on-chain activity status for staked services.
 */

import 'dotenv/config';
import { listServiceConfigs, type ServiceInfo } from '../../src/worker/ServiceConfigReader.js';
import { ActivityMonitor, type ServiceCheckInput } from '../../src/worker/rotation/ActivityMonitor.js';
import { printHeader } from '../../src/setup/display.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

async function resolveMiddlewarePath(): Promise<string> {
  // Check env var first
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    return resolve(process.env.OLAS_MIDDLEWARE_PATH);
  }

  // Default: jinn-node root (where .operate lives when using Poetry)
  const currentFile = fileURLToPath(import.meta.url);
  const scriptsDir = dirname(currentFile);
  const jinnNodeRoot = resolve(scriptsDir, '..', '..');
  return jinnNodeRoot;
}

function formatAddress(addr: string | undefined): string {
  if (!addr) return 'N/A';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function main() {
  printHeader('OLAS Service List');

  const middlewarePath = await resolveMiddlewarePath();
  const services = await listServiceConfigs(middlewarePath);

  if (services.length === 0) {
    console.log('  No services found in .operate/services/');
    console.log('  Run initial setup first (yarn setup).\n');
    process.exit(0);
  }

  const rpcUrl = process.env.RPC_URL;

  // Table header
  console.log('  ┌─────────────────────────────────────────────────────────────────────────────────┐');
  console.log('  │ #   Config ID          Svc ID   Mech              Safe              Staking     │');
  console.log('  ├─────────────────────────────────────────────────────────────────────────────────┤');

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const num = String(i + 1).padEnd(4);
    const configId = (svc.serviceConfigId || 'N/A').slice(0, 18).padEnd(20);
    const serviceId = String(svc.serviceId ?? 'N/A').padEnd(9);
    const mech = formatAddress(svc.mechContractAddress).padEnd(18);
    const safe = formatAddress(svc.serviceSafeAddress).padEnd(18);
    const staking = svc.stakingContractAddress ? formatAddress(svc.stakingContractAddress) : 'none';

    console.log(`  │ ${num}${configId}${serviceId}${mech}${safe}${staking.padEnd(12)}│`);
  }

  console.log('  └─────────────────────────────────────────────────────────────────────────────────┘');
  console.log(`\n  Total: ${services.length} service(s)\n`);

  // Detail view for each service
  for (const svc of services) {
    console.log(`  ── ${svc.serviceConfigId} ──`);
    console.log(`     Service Name:     ${svc.serviceName}`);
    console.log(`     Service ID:       ${svc.serviceId ?? 'N/A'}`);
    console.log(`     Chain:            ${svc.chain}`);
    console.log(`     Mech Address:     ${svc.mechContractAddress ?? 'N/A'}`);
    console.log(`     Service Safe:     ${svc.serviceSafeAddress ?? 'N/A'}`);
    console.log(`     Agent EOA:        ${svc.agentEoaAddress ?? 'N/A'}`);
    console.log(`     Staking Contract: ${svc.stakingContractAddress ?? 'none'}`);
    console.log(`     Agent Key:        ${svc.agentPrivateKey ? 'present' : 'missing'}`);
    console.log('');
  }

  // If RPC_URL is set, query on-chain activity status
  if (rpcUrl) {
    const stakedServices = services.filter(
      s => s.stakingContractAddress && s.serviceId && s.serviceSafeAddress
    );

    if (stakedServices.length > 0) {
      console.log('  ── On-Chain Activity Status ──\n');

      const monitor = new ActivityMonitor(rpcUrl, 0); // No cache for listing

      const inputs: ServiceCheckInput[] = stakedServices.map(s => ({
        serviceConfigId: s.serviceConfigId,
        serviceId: s.serviceId!,
        multisig: s.serviceSafeAddress!,
        stakingContract: s.stakingContractAddress!,
      }));

      try {
        const statuses = await monitor.checkAllServices(inputs);

        for (const status of statuses) {
          const icon = status.error ? 'x' : status.isEligibleForRewards ? '+' : '-';
          const label = status.error
            ? `ERROR: ${status.error}`
            : status.isEligibleForRewards
              ? `ELIGIBLE (${status.eligibleActivities}/${status.requiredActivities} deliveries)`
              : `NEEDS WORK (${status.activitiesNeeded} more deliveries needed, ${status.eligibleActivities}/${status.requiredActivities})`;

          console.log(`  [${icon}] Service #${status.serviceId} (${status.serviceConfigId})`);
          console.log(`      ${label}`);
          console.log('');
        }

        const eligible = statuses.filter(s => s.isEligibleForRewards && !s.error).length;
        const needsWork = statuses.filter(s => !s.isEligibleForRewards && !s.error).length;
        const errors = statuses.filter(s => s.error).length;

        console.log(`  Summary: ${eligible} eligible, ${needsWork} needs work, ${errors} errors\n`);
      } catch (error) {
        console.log(`  Could not query activity status: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } else {
    console.log('  Set RPC_URL to see on-chain activity status.\n');
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
