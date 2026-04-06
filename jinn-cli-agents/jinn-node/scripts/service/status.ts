#!/usr/bin/env tsx
/**
 * Service Status Dashboard - Comprehensive view of all OLAS services
 *
 * Usage: yarn service:status [--service <configId>] [--json]
 *
 * Shows epoch progress, activity requirements, staking health, balances,
 * and alerts for all services managed by this node.
 *
 * Requires: RPC_URL environment variable
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { listServiceConfigs, type ServiceInfo } from '../../src/worker/ServiceConfigReader.js';
import { ActivityMonitor, type ServiceCheckInput, type ServiceDashboardStatus } from '../../src/worker/rotation/ActivityMonitor.js';
import { printHeader } from '../../src/setup/display.js';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { createRpcProvider } from '../../src/config/index.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// Alert thresholds
const LOW_SAFE_ETH = ethers.parseEther('0.002');
const LOW_AGENT_ETH = ethers.parseEther('0.001');

function parseArgs(): { serviceFilter?: string; json: boolean } {
  const args = process.argv.slice(2);
  let serviceFilter: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service' && args[i + 1]) {
      serviceFilter = args[++i];
    } else if (args[i] === '--json') {
      json = true;
    }
  }
  return { serviceFilter, json };
}

async function resolveMiddlewarePath(): Promise<string> {
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    return resolve(process.env.OLAS_MIDDLEWARE_PATH);
  }
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), '..', '..');
}

async function getBalances(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<{ eth: string; ethRaw: bigint; olas: string }> {
  try {
    const ethBalance = await provider.getBalance(address);
    const olasContract = new ethers.Contract(OLAS_TOKEN_BASE, ERC20_ABI, provider);
    const olasBalance = await olasContract.balanceOf(address);
    return {
      eth: parseFloat(ethers.formatEther(ethBalance)).toFixed(6),
      ethRaw: ethBalance,
      olas: parseFloat(ethers.formatEther(olasBalance)).toFixed(2),
    };
  } catch {
    return { eth: '?', ethRaw: 0n, olas: '?' };
  }
}

function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'overdue';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderProgressBar(pct: number, width: number = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

async function main() {
  const { serviceFilter, json } = parseArgs();

  if (!json) printHeader('JINN Node Service Dashboard');

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('  RPC_URL environment variable is required.\n');
    process.exit(1);
  }

  const provider = createRpcProvider(rpcUrl);
  const middlewarePath = await resolveMiddlewarePath();
  const allServices = await listServiceConfigs(middlewarePath);

  if (allServices.length === 0) {
    if (json) { console.log(JSON.stringify({ error: 'No services found' })); }
    else { console.log('  No services found. Run initial setup first.\n'); }
    process.exit(0);
  }

  const services = serviceFilter
    ? allServices.filter(s => s.serviceConfigId === serviceFilter)
    : allServices;

  if (services.length === 0) {
    if (json) { console.log(JSON.stringify({ error: `Service "${serviceFilter}" not found` })); }
    else { console.log(`  Service "${serviceFilter}" not found.\n`); }
    process.exit(1);
  }

  const stakedServices = services.filter(
    s => s.stakingContractAddress && s.serviceId && s.serviceSafeAddress
  );

  let dashboardStatuses: ServiceDashboardStatus[] = [];

  if (stakedServices.length > 0) {
    const monitor = new ActivityMonitor(rpcUrl, 0); // No cache for dashboard
    const inputs: ServiceCheckInput[] = stakedServices.map(s => ({
      serviceConfigId: s.serviceConfigId,
      serviceId: s.serviceId!,
      multisig: s.serviceSafeAddress!,
      stakingContract: s.stakingContractAddress!,
    }));

    try {
      dashboardStatuses = await monitor.getAllDashboardData(inputs);
    } catch (error) {
      if (!json) {
        console.log(`  Warning: Could not fetch on-chain data: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const alerts: string[] = [];

  // Collect per-service balances and alerts
  interface ServiceData {
    svc: ServiceInfo;
    dashboard?: ServiceDashboardStatus;
    safeEth: string;
    safeEthRaw: bigint;
    safeOlas: string;
    agentEth: string;
    agentEthRaw: bigint;
  }

  const serviceDataList: ServiceData[] = [];
  for (const svc of services) {
    const dashboard = dashboardStatuses.find(d => d.serviceConfigId === svc.serviceConfigId);
    let safeEth = '?'; let safeEthRaw = 0n; let safeOlas = '?';
    let agentEth = '?'; let agentEthRaw = 0n;

    if (svc.serviceSafeAddress) {
      const b = await getBalances(provider, svc.serviceSafeAddress);
      safeEth = b.eth; safeEthRaw = b.ethRaw; safeOlas = b.olas;
    }
    if ((svc as any).agentEoaAddress) {
      const b = await getBalances(provider, (svc as any).agentEoaAddress);
      agentEth = b.eth; agentEthRaw = b.ethRaw;
    }

    // Alert collection
    if (dashboard && !dashboard.error) {
      if (dashboard.stakingState === 2) {
        alerts.push(`#${svc.serviceId}: EVICTED from staking`);
      } else if (dashboard.inactivityCount > 0) {
        const threshold = dashboard.maxInactivityPeriods || 3;
        if (dashboard.inactivityCount >= threshold - 1) {
          alerts.push(`#${svc.serviceId}: ${dashboard.inactivityCount}/${threshold} inactive epochs (EVICTION IMMINENT)`);
        } else {
          alerts.push(`#${svc.serviceId}: ${dashboard.inactivityCount}/${threshold} inactive epochs`);
        }
      }
    }
    if (safeEthRaw > 0n && safeEthRaw < LOW_SAFE_ETH) {
      alerts.push(`#${svc.serviceId}: Safe ETH < ${ethers.formatEther(LOW_SAFE_ETH)} (fund soon)`);
    }
    if (agentEthRaw > 0n && agentEthRaw < LOW_AGENT_ETH && (svc as any).agentEoaAddress) {
      alerts.push(`#${svc.serviceId}: Agent ETH < ${ethers.formatEther(LOW_AGENT_ETH)} (fund soon)`);
    }

    serviceDataList.push({ svc, dashboard, safeEth, safeEthRaw, safeOlas, agentEth, agentEthRaw });
  }

  // ── JSON output ──
  if (json) {
    const first = dashboardStatuses[0];
    const ONE_YEAR = 365 * 24 * 60 * 60;
    let apyPct = 0;
    if (first?.rewardsPerSecond > 0n && first?.minStakingDeposit > 0n) {
      const rewardsPerYear = first.rewardsPerSecond * BigInt(ONE_YEAR);
      const apyBps = (rewardsPerYear * 10000n) / first.minStakingDeposit;
      apyPct = Number(apyBps) / 100;
    }

    const jsonRows = serviceDataList.map(({ svc, dashboard, safeEth, agentEth }) => ({
      serviceId: svc.serviceId,
      configId: svc.serviceConfigId,
      deliveries: dashboard ? `${dashboard.eligibleActivities}/${dashboard.requiredActivities}` : 'N/A',
      status: !dashboard || dashboard.error
        ? 'ERROR'
        : dashboard.stakingState === 2
          ? 'EVICTED'
          : dashboard.isEligibleForRewards
            ? 'ELIGIBLE'
            : `NEEDS ${dashboard.activitiesNeeded}`,
      safeEth,
      agentEth,
      rewards: dashboard ? parseFloat(ethers.formatEther(dashboard.accruedRewards)).toFixed(4) : '0',
      inactivityCount: dashboard?.inactivityCount ?? 0,
      maxInactivityPeriods: dashboard?.maxInactivityPeriods ?? 0,
    }));

    const eligible = jsonRows.filter(r => r.status === 'ELIGIBLE').length;
    const evicted = jsonRows.filter(r => r.status === 'EVICTED').length;
    const totalDeliveries = jsonRows.reduce((sum, r) => sum + (parseInt(r.deliveries.split('/')[0], 10) || 0), 0);
    const totalRequired = jsonRows.reduce((sum, r) => sum + (parseInt(r.deliveries.split('/')[1], 10) || 0), 0);

    const output = {
      timestamp: new Date().toISOString(),
      epoch: first ? {
        number: first.currentEpoch,
        progressPct: first.epochProgressPct,
        remainingSeconds: Math.max(0, first.epochEndTimestamp - now),
      } : null,
      staking: first ? {
        contract: first.stakingContract,
        slotsUsed: first.currentStakedCount,
        slotsTotal: first.maxNumServices,
        apyPct,
        depositOlas: parseFloat(ethers.formatEther(first.minStakingDeposit)),
      } : null,
      summary: {
        total: jsonRows.length,
        eligible,
        needsWork: jsonRows.length - eligible - evicted,
        evicted,
        totalDeliveries,
        totalRequired,
      },
      services: jsonRows,
      alerts,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Terminal output ──

  // --- Epoch Info ---
  if (dashboardStatuses.length > 0) {
    const first = dashboardStatuses[0];
    const remainingSec = Math.max(0, first.epochEndTimestamp - now);
    console.log(`  Epoch #${first.currentEpoch}  ${renderProgressBar(first.epochProgressPct)} ${first.epochProgressPct}%  (${formatTimeRemaining(remainingSec)} remaining)\n`);
  }

  // --- Per-Service Status ---
  console.log('  \u2500\u2500 Services \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  for (const { svc, dashboard, safeEth, safeOlas, agentEth } of serviceDataList) {
    if (dashboard && !dashboard.error) {
      const icon = dashboard.isEligibleForRewards ? '+' : '-';
      const statusLabel = dashboard.isEligibleForRewards
        ? 'ELIGIBLE'
        : dashboard.stakingState === 2
          ? 'EVICTED'
          : `NEEDS ${dashboard.activitiesNeeded} MORE DELIVER${dashboard.activitiesNeeded === 1 ? 'Y' : 'IES'}`;

      const rewardsOlas = parseFloat(ethers.formatEther(dashboard.accruedRewards)).toFixed(4);
      const requestsDisplay = dashboard.isEligibleForRewards
        ? `${dashboard.eligibleActivities}/${dashboard.requiredActivities} (${dashboard.eligibleActivities - dashboard.requiredActivities} extra)`
        : `${dashboard.eligibleActivities}/${dashboard.requiredActivities}`;

      console.log(`  [${icon}] ${svc.serviceConfigId}  Service #${svc.serviceId}  ${statusLabel}`);
      console.log(`      Requests: ${requestsDisplay}  |  Rewards: ${rewardsOlas} OLAS`);

      if (dashboard.inactivityCount > 0) {
        const threshold = dashboard.maxInactivityPeriods || 3;
        const severity = dashboard.inactivityCount >= threshold - 1 ? 'CRITICAL' : 'WARNING';
        console.log(`      ${severity}: ${dashboard.inactivityCount}/${threshold} inactive epochs (eviction at ${threshold})`);
      }

      if (svc.serviceSafeAddress) {
        console.log(`      Safe:  ${formatAddress(svc.serviceSafeAddress)}  ETH: ${safeEth}  OLAS: ${safeOlas}`);
      }
      if ((svc as any).agentEoaAddress) {
        console.log(`      Agent: ${formatAddress((svc as any).agentEoaAddress)}  ETH: ${agentEth}`);
      }
    } else {
      const errorMsg = dashboard?.error ? ` (${dashboard.error})` : '';
      console.log(`  [?] ${svc.serviceConfigId}  Service #${svc.serviceId ?? 'N/A'}  ${svc.stakingContractAddress ? 'ERROR' + errorMsg : 'NOT STAKED'}`);
      if (svc.serviceSafeAddress) {
        console.log(`      Safe:  ${formatAddress(svc.serviceSafeAddress)}  ETH: ${safeEth}  OLAS: ${safeOlas}`);
      }
    }
    console.log('');
  }

  // --- Staking Health ---
  if (dashboardStatuses.length > 0) {
    const contractGroups = new Map<string, ServiceDashboardStatus[]>();
    for (const d of dashboardStatuses) {
      const key = d.stakingContract.toLowerCase();
      const group = contractGroups.get(key) || [];
      group.push(d);
      contractGroups.set(key, group);
    }

    console.log('  \u2500\u2500 Staking Health \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

    for (const [contractAddr, statuses] of contractGroups) {
      const first = statuses[0];
      const depositOlas = parseFloat(ethers.formatEther(first.minStakingDeposit)).toFixed(0);

      const ONE_YEAR = 365 * 24 * 60 * 60;
      let apyStr = 'N/A';
      if (first.rewardsPerSecond > 0n && first.minStakingDeposit > 0n) {
        const rewardsPerYear = first.rewardsPerSecond * BigInt(ONE_YEAR);
        const apyBps = (rewardsPerYear * 10000n) / first.minStakingDeposit;
        const apyPct = Number(apyBps) / 100;
        apyStr = `~${apyPct.toFixed(1)}%`;
      }

      console.log(`  Contract: ${formatAddress(contractAddr)}`);
      console.log(`  Slots:    ${first.currentStakedCount}/${first.maxNumServices} used`);
      console.log(`  APY:      ${apyStr}`);
      console.log(`  Deposit:  ${depositOlas} OLAS per service`);
      console.log('');
    }
  }

  // --- Wallet Balances ---
  console.log('  \u2500\u2500 Wallet Balances \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  const password = process.env.OPERATE_PASSWORD;
  if (password) {
    try {
      const wrapper = await OlasOperateWrapper.create({ rpcUrl });
      await wrapper.startServer();
      try {
        await wrapper.login(password);
        const walletInfo = await wrapper.getWalletInfo();

        if (walletInfo.success && walletInfo.wallets?.length) {
          const wallet = walletInfo.wallets[0];
          const eoaBalances = await getBalances(provider, wallet.address);
          console.log(`  Master EOA:  ${formatAddress(wallet.address)}  ETH: ${eoaBalances.eth}`);

          if (wallet.safes?.base) {
            const safeBalances = await getBalances(provider, wallet.safes.base);
            console.log(`  Master Safe: ${formatAddress(wallet.safes.base)}  ETH: ${safeBalances.eth}  OLAS: ${safeBalances.olas}`);
          }
        }
      } finally {
        await wrapper.stopServer();
      }
    } catch {
      console.log('  (Set OPERATE_PASSWORD to see wallet balances)');
    }
  } else {
    console.log('  (Set OPERATE_PASSWORD to see wallet balances)');
  }

  // --- Alerts ---
  if (alerts.length > 0) {
    console.log('\n  \u2500\u2500 Alerts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');
    for (const alert of alerts) {
      console.log(`  ! ${alert}`);
    }
  }

  console.log('');
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
