/**
 * Keystore Integrity Verification
 *
 * Provides functions to verify that stored keystores are decryptable
 * and match the expected addresses. Used as a safety gate before
 * sending funds to agent EOAs.
 *
 * SAFETY INVARIANT: Never send ETH to an address whose private key
 * we cannot prove we hold.
 */

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { ethers } from 'ethers';
import { decryptKeystoreV3 } from './keystore-decrypt.js';
import { getMiddlewarePath } from './operate-profile.js';
import { workerLogger } from '../logging/index.js';

const log = workerLogger.child({ component: 'KEYSTORE-VERIFY' });

export interface KeyVerifyResult {
    valid: boolean;
    error?: string;
}

/**
 * Verify a keystore JSON string can be decrypted and yields the expected address.
 *
 * @param keystoreJson - Encrypted keystore V3 JSON string
 * @param password - Decryption password
 * @param expectedAddress - The address we expect to recover (checksummed or lowercase)
 */
export function verifyKeystoreIntegrity(
    keystoreJson: string,
    password: string,
    expectedAddress: string,
): KeyVerifyResult {
    try {
        const privateKey = decryptKeystoreV3(keystoreJson, password);
        const wallet = new ethers.Wallet(privateKey);
        const recoveredAddress = wallet.address;

        if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
            return {
                valid: false,
                error: `Address mismatch: decrypted to ${recoveredAddress}, expected ${expectedAddress}`,
            };
        }

        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            error: `Keystore decryption failed: ${(err as Error).message}`,
        };
    }
}

/**
 * Verify that the agent key for a given service is accessible on disk
 * and can be decrypted to the expected address.
 *
 * Checks two locations (same as deploy-mech.ts):
 * 1. keys.json in the service directory (raw hex key)
 * 2. .operate/keys/<address> (encrypted keystore V3)
 *
 * @param serviceConfigId - Service config directory name (sc-...)
 * @param agentAddress - Expected agent EOA address
 * @param password - OPERATE_PASSWORD for keystore decryption
 * @returns true if the agent key is confirmed accessible
 */
export function verifyAgentKeyAccessible(
    serviceConfigId: string,
    agentAddress: string,
    password: string,
): boolean {
    const middlewarePath = getMiddlewarePath();
    if (!middlewarePath) {
        log.warn({ serviceConfigId, agentAddress }, 'Cannot verify agent key: middleware path not found');
        return false;
    }

    // Path 1: keys.json with raw hex key (most reliable)
    const keysJsonPath = join(middlewarePath, '.operate', 'services', serviceConfigId, 'keys.json');
    if (existsSync(keysJsonPath)) {
        try {
            const keys = JSON.parse(readFileSync(keysJsonPath, 'utf-8'));
            const entry = Array.isArray(keys) ? keys[0] : keys;
            if (entry?.private_key?.startsWith('0x')) {
                // Raw hex key — verify address derivation
                const wallet = new ethers.Wallet(entry.private_key);
                if (wallet.address.toLowerCase() === agentAddress.toLowerCase()) {
                    return true;
                }
                log.warn({ serviceConfigId, expected: agentAddress, got: wallet.address },
                    'keys.json hex key derives to wrong address');
                return false;
            }
        } catch {
            // Fall through to encrypted keystore check
        }
    }

    // Path 2: .operate/keys/<address> (encrypted keystore)
    const keyFilePath = join(middlewarePath, '.operate', 'keys', agentAddress);
    if (!existsSync(keyFilePath)) {
        log.warn({ serviceConfigId, agentAddress, keyFilePath },
            'Agent key file not found — cannot verify key accessibility');
        return false;
    }

    try {
        const keyEntry = JSON.parse(readFileSync(keyFilePath, 'utf-8'));
        const keystoreJson = keyEntry.private_key;

        if (!keystoreJson || typeof keystoreJson !== 'string') {
            log.warn({ serviceConfigId, agentAddress },
                'Agent key file has no private_key field');
            return false;
        }

        // If it's a JSON keystore string, verify we can decrypt it
        if (keystoreJson.startsWith('{')) {
            const result = verifyKeystoreIntegrity(keystoreJson, password, agentAddress);
            if (!result.valid) {
                log.warn({ serviceConfigId, agentAddress, error: result.error },
                    'Agent key verification FAILED — will not fund this address');
                return false;
            }
            return true;
        }

        // If starts with 0x, it's a raw hex key
        if (keystoreJson.startsWith('0x')) {
            const wallet = new ethers.Wallet(keystoreJson);
            if (wallet.address.toLowerCase() === agentAddress.toLowerCase()) {
                return true;
            }
            log.warn({ serviceConfigId, expected: agentAddress, got: wallet.address },
                'Key file hex key derives to wrong address');
            return false;
        }

        log.warn({ serviceConfigId, agentAddress },
            'Agent key file has unrecognized private_key format');
        return false;
    } catch (err) {
        log.warn({ serviceConfigId, agentAddress, error: (err as Error).message },
            'Failed to read/verify agent key file');
        return false;
    }
}
