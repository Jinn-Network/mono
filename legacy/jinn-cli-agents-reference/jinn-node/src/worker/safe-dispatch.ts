/**
 * Safe-Based Marketplace Dispatch
 *
 * Thin wrapper around submitMarketplaceRequest from MechMarketplaceRequester
 * that handles IPFS upload (via pushJsonToIpfs) and loops individual requests
 * to satisfy the activity checker's `diffRequestsCounts <= diffNonces` constraint.
 *
 * Currently scoped to native payment mechs only.
 */

import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { logger } from '../logging/index.js';
import { submitMarketplaceRequest } from './MechMarketplaceRequester.js';

const log = logger.child({ component: 'SAFE-DISPATCH' });

// ── Types ───────────────────────────────────────────────────────────────────

export interface SafeDispatchParams {
    /** Safe multisig address that will be msg.sender on-chain */
    serviceSafeAddress: string;
    /** Agent EOA private key — used to sign the Safe transaction */
    agentEoaPrivateKey: string;
    /** Priority mech address — caller chooses routing (e.g. getRandomStakedMech) */
    priorityMech: string;
    /** MechMarketplace contract address */
    mechMarketplaceAddress: string;
    /** JSON-RPC URL */
    rpcUrl: string;
    /** Pre-built IPFS payload objects (one per request) */
    ipfsJsonContents: unknown[];
    /** Caller's response timeout in seconds (clamped to contract bounds) */
    responseTimeout?: number;
}

export interface SafeDispatchResult {
    /** On-chain request IDs — matches marketplaceInteract return shape */
    request_ids: string[];
    /** Transaction hash(es) from the Safe execTransaction call(s) */
    transactionHash: string;
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Dispatch marketplace requests through the Gnosis Safe.
 *
 * Each request is sent as an individual Safe execTransaction + marketplace.request()
 * call. This ensures the activity checker's `diffRequestsCounts <= diffNonces`
 * constraint is satisfied (1 request = 1 Safe nonce increment).
 *
 * Delegates the actual Safe signing and execution to submitMarketplaceRequest.
 *
 * @throws If Safe address is missing, payment type is non-native, or tx fails
 */
export async function dispatchViaSafe(params: SafeDispatchParams): Promise<SafeDispatchResult> {
    const {
        serviceSafeAddress,
        agentEoaPrivateKey,
        priorityMech,
        mechMarketplaceAddress,
        rpcUrl,
        ipfsJsonContents,
        responseTimeout,
    } = params;

    if (!serviceSafeAddress) {
        throw new Error(
            'Safe address is required for marketplace dispatch. ' +
            'Check JINN_SERVICE_SAFE_ADDRESS or service config.'
        );
    }

    log.info({
        safe: serviceSafeAddress,
        priorityMech,
        marketplace: mechMarketplaceAddress,
        numPayloads: ipfsJsonContents.length,
    }, 'Dispatching marketplace request(s) via Safe');

    // 1. Upload IPFS payloads
    const ipfsHashes: string[] = [];
    for (let i = 0; i < ipfsJsonContents.length; i++) {
        const [truncatedHash, cidString] = await pushJsonToIpfs(ipfsJsonContents[i]);
        ipfsHashes.push(truncatedHash);
        log.debug({ index: i, ipfsUrl: `https://gateway.autonolas.tech/ipfs/${cidString}` }, 'Payload uploaded to IPFS');
    }

    // 2. Send individual request() per Safe tx (activity checker nonce constraint)
    const allRequestIds: string[] = [];
    let lastTxHash = '';

    for (let i = 0; i < ipfsHashes.length; i++) {
        log.debug({ index: i, total: ipfsHashes.length }, 'Submitting request via Safe');

        const result = await submitMarketplaceRequest({
            serviceSafeAddress,
            agentEoaPrivateKey,
            mechContractAddress: priorityMech,
            mechMarketplaceAddress,
            rpcUrl,
            requestData: ipfsHashes[i],
            responseTimeout: responseTimeout ?? 300,
            validateNativePayment: true,
        });

        if (!result.success) {
            throw new Error(
                `Safe dispatch failed for request ${i + 1}/${ipfsHashes.length}: ${result.error}`
            );
        }

        if (result.requestIds) {
            allRequestIds.push(...result.requestIds);
        }
        lastTxHash = result.transactionHash || lastTxHash;

        log.info({
            index: i,
            txHash: result.transactionHash,
            gasUsed: result.gasUsed,
            requestIds: result.requestIds,
        }, 'Safe dispatch successful');
    }

    log.info({
        totalRequests: allRequestIds.length,
        request_ids: allRequestIds,
        safeAddress: serviceSafeAddress,
    }, 'All marketplace requests dispatched via Safe');

    return {
        request_ids: allRequestIds,
        transactionHash: lastTxHash,
    };
}
