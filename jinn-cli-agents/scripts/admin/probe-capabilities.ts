#!/usr/bin/env npx tsx
/**
 * Quick probe of /credentials/capabilities to debug why it returns empty.
 */
import 'dotenv/config';
import { createPrivateKeyHttpSigner, resolveChainId, signRequestWithErc8128 } from '../../jinn-node/src/http/erc8128.js';
import { getServicePrivateKey } from '../../jinn-node/src/env/operate-profile.js';

const gatewayUrl = 'https://x402-gateway-production-1b84.up.railway.app';
const key = getServicePrivateKey();
if (!key) { console.error('No key'); process.exit(1); }

const signer = createPrivateKeyHttpSigner(key as `0x${string}`, resolveChainId('base'));
console.log(`Probing as: ${signer.address}`);

const request = await signRequestWithErc8128({
    signer, input: `${gatewayUrl}/credentials/capabilities`,
    init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    },
    signOptions: { label: 'eth', binding: 'request-bound', replay: 'non-replayable', ttlSeconds: 60 },
});

const res = await fetch(request);
const body = await res.text();
console.log(`Status: ${res.status}`);
console.log(`Headers:`, Object.fromEntries(res.headers.entries()));
console.log(`Body: ${body}`);
