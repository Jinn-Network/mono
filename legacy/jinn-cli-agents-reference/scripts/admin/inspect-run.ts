import 'dotenv/config';
import { createPrivateKeyHttpSigner, resolveChainId, signRequestWithErc8128 } from '../../jinn-node/src/http/erc8128.js';
import { getServicePrivateKey } from '../../jinn-node/src/env/operate-profile.js';

const requestId = process.argv[2] || '0xce7574c7049f36778d3f05c552e1cda085d283a0eaec486f6e6d322d9d75ece6';

async function main() {
    const key = getServicePrivateKey()!;
    const signer = createPrivateKeyHttpSigner(key as `0x${string}`, resolveChainId('base'));

    const q = JSON.stringify({
        query: `{ getRequestClaim(requestId: "${requestId}") { request_id status claimed_at situation_cid } }`
    });

    const req = await signRequestWithErc8128({
        signer, input: 'https://control-api-production-c1f5.up.railway.app/graphql',
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: q },
        signOptions: { label: 'eth', binding: 'request-bound', replay: 'non-replayable', ttlSeconds: 60 },
    });

    const res = await fetch(req);
    const d = await res.json() as any;
    const claim = d?.data?.getRequestClaim;

    if (!claim) {
        console.log('No claim found:', JSON.stringify(d, null, 2));
        return;
    }

    console.log('Status:', claim.status);
    console.log('Situation CID:', claim.situation_cid);

    if (claim.situation_cid) {
        console.log('\n--- SITUATION ARTIFACT ---');
        const sitRes = await fetch('https://gateway.autonolas.tech/ipfs/' + claim.situation_cid);
        const sit = await sitRes.json() as any;

        // Print content (the agent's execution summary)
        if (sit.content) {
            console.log('\n=== CONTENT ===');
            console.log(sit.content.substring(0, 4000));
        }

        // Print tool errors
        if (sit.toolErrors && sit.toolErrors.length > 0) {
            console.log('\n=== TOOL ERRORS ===');
            for (const err of sit.toolErrors) {
                console.log(`- Tool: ${err.tool}, Error: ${err.error?.substring(0, 200)}`);
            }
        }

        // Print measurements
        if (sit.measurements && sit.measurements.length > 0) {
            console.log('\n=== MEASUREMENTS ===');
            for (const m of sit.measurements) {
                console.log(`- ${m.name}: ${m.value} (${m.score})`);
            }
        }

        // Print artifacts
        if (sit.artifacts && sit.artifacts.length > 0) {
            console.log('\n=== ARTIFACTS ===');
            for (const a of sit.artifacts) {
                console.log(`- ${a.name} (${a.topic || 'no topic'}): ${a.cid}`);
            }
        }

        // Print status/message
        if (sit.status) console.log('\nFinal Status:', sit.status);
        if (sit.message) console.log('Message:', sit.message);
    }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
