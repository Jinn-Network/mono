#!/usr/bin/env npx tsx
/**
 * Grant Operator Access via Admin API
 *
 * Two-step flow:
 * 1. Target self-registers (signs with its own key)
 * 2. Admin promotes target to 'trusted' (signs with admin key)
 *
 * Usage:
 *   OPERATE_PASSWORD=... tsx scripts/admin/grant-operator-access.ts \
 *     --admin-key=0x... \
 *     --gateway=https://x402-gateway-production-1b84.up.railway.app
 */

import 'dotenv/config';
import { createPrivateKeyHttpSigner, resolveChainId, signRequestWithErc8128 } from '../../jinn-node/src/http/erc8128.js';
import { getServicePrivateKey } from '../../jinn-node/src/env/operate-profile.js';

function parseArgs(args: string[]): Record<string, string> {
    const parsed: Record<string, string> = {};
    for (const arg of args) {
        const match = arg.match(/^--([\w-]+)=(.+)$/);
        if (match) parsed[match[1]] = match[2];
    }
    return parsed;
}

const opts = parseArgs(process.argv.slice(2));
const gatewayUrl = (opts.gateway || '').replace(/\/$/, '');
const adminKey = opts['admin-key'];

if (!gatewayUrl || !adminKey) {
    console.error('Usage: OPERATE_PASSWORD=... tsx scripts/admin/grant-operator-access.ts \\');
    console.error('  --admin-key=0x<admin-private-key> --gateway=<url>');
    process.exit(1);
}

type Signer = ReturnType<typeof createPrivateKeyHttpSigner>;

async function signedRequest(method: string, url: string, body: Record<string, unknown>, signer: Signer): Promise<Response> {
    const request = await signRequestWithErc8128({
        signer, input: url,
        init: {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        signOptions: { label: 'eth', binding: 'request-bound', replay: 'non-replayable', ttlSeconds: 60 },
    });
    return fetch(request);
}

async function main() {
    const chainId = resolveChainId('base');

    // Get target (worker) private key from operate keystore
    const targetKey = getServicePrivateKey();
    if (!targetKey) {
        console.error('Could not decrypt worker key. Set OPERATE_PASSWORD.');
        process.exit(1);
    }

    const adminSigner = createPrivateKeyHttpSigner(adminKey as `0x${string}`, chainId);
    const targetSigner = createPrivateKeyHttpSigner(targetKey as `0x${string}`, chainId);

    console.log(`Admin signer:  ${adminSigner.address}`);
    console.log(`Target worker: ${targetSigner.address}`);
    console.log(`Gateway:       ${gatewayUrl}\n`);

    // Step 1: Target self-registers as operator
    console.log('Step 1: Target self-registering as operator...');
    const reg = await signedRequest('POST', `${gatewayUrl}/admin/operators`, {}, targetSigner);
    const regData = await reg.json();
    console.log(`  ${reg.status}:`, JSON.stringify(regData));

    if (!reg.ok && reg.status !== 409 && reg.status !== 201) {
        console.error('  Self-registration failed. Aborting.');
        process.exit(1);
    }

    // Step 2: Admin promotes target to trusted
    console.log('\nStep 2: Admin promoting to trusted...');
    const promote = await signedRequest('PUT', `${gatewayUrl}/admin/operators/${targetSigner.address}`, { tierOverride: 'trusted' }, adminSigner);
    const promoteData = await promote.json();
    console.log(`  ${promote.status}:`, JSON.stringify(promoteData, null, 2));

    if (!promote.ok) {
        console.error('  Promotion failed.');
        process.exit(1);
    }

    console.log('\n✅ Operator promoted to trusted!');
    if (promoteData.grantsAdded?.length > 0) {
        console.log('Auto-provisioned grants:', promoteData.grantsAdded);
    }

    // Step 3: Verify target capabilities via credential bridge
    console.log('\nStep 3: Verifying target capabilities...');
    const cap = await signedRequest('POST', `${gatewayUrl}/credentials/capabilities`, {}, targetSigner);
    const capData = await cap.json();
    console.log(`  ${cap.status}: providers =`, capData.providers || []);
}

main().catch(err => { console.error('Fatal:', err.message || err); process.exit(1); });
