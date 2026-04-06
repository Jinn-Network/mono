#!/usr/bin/env tsx
/**
 * Wallet Fund — Distribute ETH from Master Safe to service agent EOAs and Safes
 *
 * Reads fund_requirements from each service's config.json and tops up addresses
 * that have fallen below the threshold (50% of target).
 *
 * Usage:
 *   yarn wallet:fund              # Fund all services
 *   yarn wallet:fund --dry-run    # Show what would be funded without executing
 *
 * Uses FundDistributor (same logic as the worker's periodic funding loop).
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { createRpcProvider } from '../../src/config/index.js';
import { listServiceConfigs, type ServiceInfo } from '../../src/worker/ServiceConfigReader.js';
import { maybeDistributeFunds } from '../../src/worker/funding/FundDistributor.js';
import { getMasterSafe, getMasterEOA, getMiddlewarePath } from '../../src/env/operate-profile.js';

const DRY_RUN = process.argv.includes('--dry-run');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

function printHelp() {
    console.log(`
  wallet:fund — Distribute ETH from Master Safe to service addresses

  Usage:
    yarn wallet:fund              Fund all services needing ETH
    yarn wallet:fund --dry-run    Show balances without sending transactions

  Reads fund_requirements from each service config and tops up agent EOAs
  and service Safes that have fallen below the 50% threshold.

  Environment:
    OPERATE_PASSWORD   Required — decrypts master key for Safe transactions
    RPC_URL            Required — Base RPC endpoint
  `);
}

async function main() {
    if (HELP) {
        printHelp();
        process.exit(0);
    }

    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
        console.error('❌ RPC_URL not set');
        process.exit(1);
    }

    const masterSafe = getMasterSafe('base');
    const masterEoa = getMasterEOA();
    const provider = createRpcProvider(rpcUrl);

    console.log('');
    console.log('┌──────────────────────────────────────────────────────────┐');
    console.log('│  Wallet Fund Distribution                               │');
    console.log('└──────────────────────────────────────────────────────────┘');
    console.log('');

    if (masterSafe) {
        const safeBal = await provider.getBalance(masterSafe);
        console.log(`  Master Safe:  ${masterSafe}`);
        console.log(`  Safe Balance: ${ethers.formatEther(safeBal)} ETH`);
    }
    if (masterEoa) {
        const eoaBal = await provider.getBalance(masterEoa);
        console.log(`  Master EOA:   ${masterEoa}`);
        console.log(`  EOA Balance:  ${ethers.formatEther(eoaBal)} ETH`);
    }
    console.log('');

    // Load all service configs
    const middlewarePath = getMiddlewarePath();
    if (!middlewarePath) {
        console.error('  ❌ Could not find middleware path (.operate directory)');
        process.exit(1);
    }
    const services = await listServiceConfigs(middlewarePath);

    if (services.length === 0) {
        console.log('  No services found. Run setup first.');
        process.exit(0);
    }

    console.log(`  Found ${services.length} service(s):`);
    for (const svc of services) {
        const agentBal = svc.agentEoaAddress
            ? ethers.formatEther(await provider.getBalance(svc.agentEoaAddress))
            : '?';
        const safeBal = svc.serviceSafeAddress
            ? ethers.formatEther(await provider.getBalance(svc.serviceSafeAddress))
            : '?';
        console.log(`    #${svc.serviceId ?? '?'} (${svc.serviceConfigId})`);
        console.log(`      Agent EOA: ${svc.agentEoaAddress ?? 'unknown'} — ${agentBal} ETH`);
        console.log(`      Safe:      ${svc.serviceSafeAddress ?? 'unknown'} — ${safeBal} ETH`);
    }
    console.log('');

    if (DRY_RUN) {
        console.log('  --dry-run: skipping fund distribution.');
        console.log('  Remove --dry-run to execute transfers.');
        process.exit(0);
    }

    console.log('  [→] Running fund distribution...');
    const result = await maybeDistributeFunds(services, rpcUrl);

    console.log('');
    console.log('  ═══ Results ═══');
    console.log(`  Checked:  ${result.checked} service(s)`);

    if (result.funded.length > 0) {
        console.log(`  Funded:   ${result.funded.length} address(es)`);
        for (const t of result.funded) {
            console.log(`    ✅ ${t.label}: ${ethers.formatEther(t.amountWei)} ETH`);
        }
        if (result.txHash) {
            console.log(`  Last TX:  ${result.txHash}`);
        }
    } else {
        console.log('  Funded:   0 — all addresses adequately funded');
    }

    if (result.skipped.length > 0) {
        console.log(`  Skipped:  ${result.skipped.length}`);
        for (const s of result.skipped) {
            console.log(`    ⚠️  ${s}`);
        }
    }

    if (result.error) {
        console.log(`  Error:    ${result.error}`);
        process.exit(1);
    }

    console.log('');
}

main().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
});
