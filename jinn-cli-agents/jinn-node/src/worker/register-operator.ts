/**
 * Operator Registration
 *
 * Self-registers the worker as an operator with the credential bridge (x402-gateway).
 * Called automatically at worker startup and available as a standalone script.
 *
 * The registration is idempotent (upsert) — safe to call on every boot.
 * Operators start as 'untrusted'; admin promotion is required for credential grants.
 *
 * Environment:
 *   X402_GATEWAY_URL — Credential bridge base URL (required)
 *   OPERATE_PASSWORD — Decrypts the worker's keystore (required)
 */

import { getServicePrivateKey, getMechChainConfig } from '../env/operate-profile.js';
import { createPrivateKeyHttpSigner, resolveChainId, signRequestWithErc8128, type Erc8128Signer } from '../http/erc8128.js';
import { secrets } from '../config/index.js';
import { workerLogger } from '../logging/index.js';

export interface RegistrationResult {
    registered: boolean;
    alreadyRegistered: boolean;
    address: string;
    trustTier?: string;
    grantsAdded?: string[];
    error?: string;
}

/**
 * Build an ERC-8128 signed request and send it via fetch.
 */
async function signedFetch(
    method: string,
    url: string,
    body: Record<string, unknown>,
    signer: Erc8128Signer,
): Promise<Response> {
    const request = await signRequestWithErc8128({
        signer,
        input: url,
        init: {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        signOptions: {
            label: 'eth',
            binding: 'request-bound',
            replay: 'non-replayable',
            ttlSeconds: 60,
        },
    });
    return fetch(request);
}

/**
 * Self-register this worker as an operator at the credential bridge.
 *
 * @param gatewayUrl - Override for X402_GATEWAY_URL
 * @returns Registration result
 */
export async function selfRegisterOperator(gatewayUrl?: string): Promise<RegistrationResult> {
    const gateway = (gatewayUrl || secrets.x402GatewayUrl || '').replace(/\/$/, '');
    if (!gateway) {
        return { registered: false, alreadyRegistered: false, address: '', error: 'X402_GATEWAY_URL not set' };
    }

    const privateKey = getServicePrivateKey();
    if (!privateKey) {
        return { registered: false, alreadyRegistered: false, address: '', error: 'Worker private key not available' };
    }

    const chainConfig = getMechChainConfig();
    const chainId = resolveChainId(chainConfig);
    const signer = createPrivateKeyHttpSigner(privateKey as `0x${string}`, chainId);

    const url = `${gateway}/admin/operators`;

    const response = await signedFetch('POST', url, {}, signer);
    const data = await response.json() as Record<string, unknown>;

    if (response.ok || response.status === 201) {
        return {
            registered: true,
            alreadyRegistered: false,
            address: signer.address,
            trustTier: data.trustTier as string | undefined,
            grantsAdded: data.grants as string[] | undefined,
        };
    }

    if (response.status === 409) {
        // Already registered — this is fine (idempotent)
        return {
            registered: true,
            alreadyRegistered: true,
            address: signer.address,
        };
    }

    return {
        registered: false,
        alreadyRegistered: false,
        address: signer.address,
        error: `HTTP ${response.status}: ${data.error || JSON.stringify(data)}`,
    };
}

/**
 * Admin-promote an operator to a trust tier.
 *
 * @param adminKey - Admin private key (0x-prefixed hex)
 * @param targetAddress - Operator address to promote
 * @param tierOverride - Trust tier to set (default: 'trusted')
 * @param gatewayUrl - Override for X402_GATEWAY_URL
 */
export async function adminPromoteOperator(opts: {
    adminKey: string;
    targetAddress: string;
    tierOverride?: string;
    gatewayUrl?: string;
}): Promise<{ success: boolean; operator?: Record<string, unknown>; grantsAdded?: string[]; error?: string }> {
    const gateway = (opts.gatewayUrl || secrets.x402GatewayUrl || '').replace(/\/$/, '');
    if (!gateway) {
        return { success: false, error: 'X402_GATEWAY_URL not set' };
    }

    const chainConfig = getMechChainConfig();
    const chainId = resolveChainId(chainConfig);
    const adminSigner = createPrivateKeyHttpSigner(opts.adminKey as `0x${string}`, chainId);

    const url = `${gateway}/admin/operators/${opts.targetAddress.toLowerCase()}`;
    const body = { tierOverride: opts.tierOverride || 'trusted' };

    const response = await signedFetch('PUT', url, body, adminSigner);
    const data = await response.json() as Record<string, unknown>;

    if (response.ok) {
        return {
            success: true,
            operator: data.operator as Record<string, unknown>,
            grantsAdded: data.grantsAdded as string[],
        };
    }

    return {
        success: false,
        error: `HTTP ${response.status}: ${data.error || JSON.stringify(data)}`,
    };
}

/**
 * Ensure the worker is registered as an operator.
 * Called once at worker startup. Non-blocking: logs and continues on failure.
 */
export async function ensureOperatorRegistered(): Promise<void> {
    const gateway = secrets.x402GatewayUrl;
    if (!gateway) {
        workerLogger.debug('X402_GATEWAY_URL not set — skipping operator self-registration');
        return;
    }

    try {
        const result = await selfRegisterOperator();

        if (!result.registered) {
            workerLogger.warn(
                { error: result.error },
                'Operator self-registration failed (non-fatal) — credential bridge may deny requests',
            );
            return;
        }

        if (result.alreadyRegistered) {
            workerLogger.debug(
                { address: result.address },
                'Operator already registered with credential bridge',
            );
        } else {
            workerLogger.info(
                { address: result.address, trustTier: result.trustTier, grants: result.grantsAdded },
                'Operator self-registered with credential bridge',
            );
        }
    } catch (err: any) {
        workerLogger.warn(
            { error: err?.message || String(err) },
            'Operator self-registration failed (non-fatal) — gateway unreachable',
        );
    }
}
