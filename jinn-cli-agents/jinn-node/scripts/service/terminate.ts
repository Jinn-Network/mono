#!/usr/bin/env tsx
/**
 * Terminate Service — Unstake, terminate on-chain, and drain funds to Master Safe
 *
 * Usage:
 *   yarn service:terminate --config-id <configId>   # Terminate a specific service
 *   yarn service:terminate --all                     # Terminate all services
 *   yarn service:terminate --config-id <id> --dry-run
 *
 * Prerequisites:
 *   OPERATE_PASSWORD — Required to decrypt master wallet
 *   RPC_URL — RPC endpoint
 *
 * This calls the middleware's terminate_and_withdraw endpoint which:
 *   1. Unstakes from the staking contract (if staked/evicted)
 *   2. Terminates the service on the ServiceRegistry
 *   3. Drains all funds (ETH + OLAS bond) back to the Master Safe
 */

import 'dotenv/config';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { listServiceConfigs } from '../../src/worker/ServiceConfigReader.js';
import { printHeader, printStep, printError } from '../../src/setup/display.js';
import { getMasterSafe } from '../../src/env/operate-profile.js';

function parseArgs(): {
    configId?: string;
    all: boolean;
    dryRun: boolean;
    help: boolean;
} {
    const args = process.argv.slice(2);
    let configId: string | undefined;
    let all = false;
    let dryRun = false;
    let help = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--config-id=')) {
            configId = args[i].slice('--config-id='.length);
        } else if (args[i] === '--config-id' && args[i + 1]) {
            configId = args[++i];
        } else if (args[i] === '--all') {
            all = true;
        } else if (args[i] === '--dry-run') {
            dryRun = true;
        } else if (args[i] === '--help' || args[i] === '-h') {
            help = true;
        }
    }

    return { configId, all, dryRun, help };
}

async function main() {
    const { configId, all, dryRun, help } = parseArgs();

    if (help) {
        console.log(`
Terminate Service — Unstake, terminate, and drain funds to Master Safe

Usage:
  yarn service:terminate --config-id <configId>   Terminate a specific service
  yarn service:terminate --all                     Terminate all services
  yarn service:terminate --dry-run                 Preview without executing

Options:
  --config-id <id>   Service config ID (e.g. sc-4355d24a-...)
  --all              Terminate all services
  --dry-run          Show what would be terminated without executing
  --help, -h         Show this help

Funds (OLAS bond + ETH) are drained back to the Master Safe.
After terminating, use 'yarn service:add' to create fresh services.
`);
        process.exit(0);
    }

    if (!configId && !all) {
        printError('Specify --config-id <id> or --all');
        process.exit(1);
    }

    printHeader('Terminate Service');

    const password = process.env.OPERATE_PASSWORD;
    const rpcUrl = process.env.RPC_URL;

    if (!password) {
        printError('OPERATE_PASSWORD environment variable is required');
        process.exit(1);
    }
    if (!rpcUrl) {
        printError('RPC_URL environment variable is required');
        process.exit(1);
    }

    // Resolve Master Safe address for withdrawal
    const masterSafe = getMasterSafe('base');
    if (!masterSafe) {
        printError('No Master Safe found. Run initial setup first (yarn setup).');
        process.exit(1);
    }

    printStep('active', 'Starting middleware daemon...');

    const wrapper = await OlasOperateWrapper.create({
        rpcUrl,
        defaultEnv: {
            operatePassword: password,
            chainLedgerRpc: { base: rpcUrl },
            attended: false,
        },
    });

    try {
        await wrapper.startServer();

        // Login
        const loginResult = await wrapper.login(password);
        if (!loginResult.success) {
            const setupResult = await wrapper.setupUserAccount(password);
            if (!setupResult.success && !setupResult.error?.includes('Account already exists')) {
                printError(`Authentication failed: ${setupResult.error}`);
                process.exit(1);
            }
        }
        printStep('done', 'Middleware daemon started');

        // Determine which services to terminate
        let configIds: string[] = [];

        if (all) {
            printStep('active', 'Listing all services...');
            const middlewarePath = wrapper.getMiddlewarePath();
            const services = await listServiceConfigs(middlewarePath);
            configIds = services.map(s => s.serviceConfigId);
            printStep('done', `Found ${configIds.length} service(s)`);
            for (const svc of services) {
                console.log(`      - ${svc.serviceConfigId} (service #${svc.serviceId ?? 'N/A'})`);
            }
        } else if (configId) {
            configIds = [configId];
        }

        if (configIds.length === 0) {
            printStep('done', 'No services to terminate');
            return;
        }

        if (dryRun) {
            console.log('\n  DRY RUN — would terminate:');
            for (const id of configIds) {
                console.log(`    - ${id}`);
            }
            console.log(`\n  Funds would drain to Master Safe: ${masterSafe}`);
            console.log('  Run without --dry-run to execute.\n');
            return;
        }

        // Terminate each service
        for (const id of configIds) {
            printStep('active', `Terminating ${id}...`);
            console.log(`      Withdrawal to Master Safe: ${masterSafe}`);

            const result = await wrapper.terminateAndWithdraw(id, masterSafe);

            if (result.success) {
                printStep('done', `Terminated ${id}`, 'Funds drained to Master Safe');
            } else {
                printError(`Failed to terminate ${id}: ${result.error}`);
                // Continue with remaining services
            }
        }

        console.log('\n  ✅ Termination complete. Funds returned to Master Safe.');
        console.log('  Next: run "yarn service:add" to create fresh services.\n');

    } finally {
        await wrapper.stopServer();
    }
}

main().catch(error => {
    printError(error.message);
    process.exit(1);
});
