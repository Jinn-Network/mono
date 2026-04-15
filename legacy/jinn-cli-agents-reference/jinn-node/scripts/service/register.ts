#!/usr/bin/env npx tsx
/**
 * Service Registration Script
 *
 * Registers this service's operator address with the credential bridge.
 * Replaces the root-level scripts/admin/grant-operator-access.ts with a
 * jinn-node-local management command.
 *
 * Usage:
 *   # Self-register only (uses worker key from .operate keystore)
 *   OPERATE_PASSWORD=... yarn service:register
 *
 *   # Self-register + admin promote to trusted
 *   OPERATE_PASSWORD=... yarn service:register --admin-key=0x... --promote
 *
 *   # Custom gateway URL
 *   OPERATE_PASSWORD=... yarn service:register --gateway=https://my-gateway.example.com
 *
 *   # Check current registration status
 *   OPERATE_PASSWORD=... yarn service:register --status
 *
 * Environment:
 *   OPERATE_PASSWORD   — Required to decrypt the worker keystore
 *   X402_GATEWAY_URL   — Credential bridge URL (or use --gateway)
 */

import 'dotenv/config';
import { selfRegisterOperator, adminPromoteOperator } from '../../src/worker/register-operator.js';
import { getServicePrivateKey, getMechChainConfig } from '../../src/env/operate-profile.js';
import { createPrivateKeyHttpSigner, resolveChainId, signRequestWithErc8128 } from '../../src/http/erc8128.js';

function parseArgs(args: string[]): Record<string, string | boolean> {
    const parsed: Record<string, string | boolean> = {};
    for (const arg of args) {
        if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
        if (arg === '--promote') { parsed.promote = true; continue; }
        if (arg === '--status') { parsed.status = true; continue; }
        const match = arg.match(/^--([\w-]+)=(.+)$/);
        if (match) parsed[match[1]] = match[2];
    }
    return parsed;
}

function printHelp() {
    console.log(`
Service Registration — Register with the credential bridge

Usage:
  yarn service:register [options]

Options:
  --gateway=<url>       Credential bridge URL (overrides X402_GATEWAY_URL)
  --admin-key=<0x...>   Admin private key for promotion
  --promote             Promote operator to 'trusted' (requires --admin-key)
  --status              Check current registration status
  --help, -h            Show this help

Environment:
  OPERATE_PASSWORD      Required to decrypt the worker keystore
  X402_GATEWAY_URL      Default credential bridge URL

Examples:
  # Self-register only
  OPERATE_PASSWORD=secret yarn service:register

  # Full registration + promotion
  OPERATE_PASSWORD=secret yarn service:register --admin-key=0x... --promote
`);
}

async function checkStatus(gatewayUrl: string): Promise<void> {
    const privateKey = getServicePrivateKey();
    if (!privateKey) {
        console.error('✗ Cannot check status: worker private key not available (set OPERATE_PASSWORD)');
        process.exit(1);
    }

    const chainId = resolveChainId(getMechChainConfig());
    const signer = createPrivateKeyHttpSigner(privateKey as `0x${string}`, chainId);

    console.log(`Checking registration status for ${signer.address}...`);

    const request = await signRequestWithErc8128({
        signer,
        input: `${gatewayUrl}/admin/operators/${signer.address.toLowerCase()}`,
        init: { method: 'GET', headers: { 'Content-Type': 'application/json' } },
        signOptions: { label: 'eth', binding: 'request-bound', replay: 'non-replayable', ttlSeconds: 60 },
    });

    const response = await fetch(request);

    if (response.status === 404) {
        console.log('⚠ Operator not registered');
        return;
    }

    if (!response.ok) {
        const data = await response.json() as Record<string, unknown>;
        console.error(`✗ Failed to check status: ${response.status} ${data.error || ''}`);
        process.exit(1);
    }

    const data = await response.json() as Record<string, unknown>;
    console.log('\n✅ Operator registered:');
    console.log(`  Address:    ${data.address}`);
    console.log(`  Trust tier: ${data.trustTier}`);
    console.log(`  Service ID: ${data.serviceId ?? 'none'}`);
    console.log(`  Registered: ${data.registeredAt}`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.help) {
        printHelp();
        process.exit(0);
    }

    const gatewayUrl = ((opts.gateway as string) || process.env.X402_GATEWAY_URL || '').replace(/\/$/, '');
    if (!gatewayUrl) {
        console.error('✗ Gateway URL required. Set X402_GATEWAY_URL or use --gateway=<url>');
        process.exit(1);
    }

    // Status check mode
    if (opts.status) {
        await checkStatus(gatewayUrl);
        process.exit(0);
    }

    // Step 1: Self-register
    console.log('Step 1: Self-registering with credential bridge...');
    console.log(`  Gateway: ${gatewayUrl}`);

    const regResult = await selfRegisterOperator(gatewayUrl);

    if (!regResult.registered) {
        console.error(`✗ Self-registration failed: ${regResult.error}`);
        process.exit(1);
    }

    console.log(`  Address: ${regResult.address}`);

    if (regResult.alreadyRegistered) {
        console.log('  ✓ Already registered');
    } else {
        console.log(`  ✓ Registered (trust tier: ${regResult.trustTier || 'untrusted'})`);
    }

    // Step 2: Admin promotion (optional)
    if (opts.promote) {
        const adminKey = opts['admin-key'] as string;
        if (!adminKey) {
            console.error('\n✗ --promote requires --admin-key=0x...');
            process.exit(1);
        }

        console.log('\nStep 2: Admin promoting to trusted...');
        const promoteResult = await adminPromoteOperator({
            adminKey,
            targetAddress: regResult.address,
            gatewayUrl,
        });

        if (!promoteResult.success) {
            console.error(`  ✗ Promotion failed: ${promoteResult.error}`);
            process.exit(1);
        }

        console.log('  ✓ Promoted to trusted');
        if (promoteResult.grantsAdded && promoteResult.grantsAdded.length > 0) {
            console.log(`  Auto-provisioned grants: ${promoteResult.grantsAdded.join(', ')}`);
        }
    }

    // Step 3: Verify capabilities
    console.log('\n✅ Registration complete');
}

main().catch((err) => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
});
