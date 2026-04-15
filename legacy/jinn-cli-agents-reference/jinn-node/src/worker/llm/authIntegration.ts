/**
 * Auth Integration Helper
 *
 * Bridges the AuthManager with geminiQuota credential checking.
 * Provides a unified way to get Gemini credentials from either:
 * 1. Environment variables (legacy, highest priority)
 * 2. AuthManager discovery (from CLI tools)
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getAuthManager, type OAuthCredential } from '../../auth/index.js';
import { workerLogger } from '../../logging/index.js';

/**
 * Credential set compatible with geminiQuota's expected format
 */
export interface GeminiCredentialSet {
    oauth_creds: {
        access_token: string;
        refresh_token: string;
        expiry_date: number;
        scope?: string;
        token_type?: string;
    };
    google_accounts: {
        active: string;
    };
}

/**
 * Try to get Gemini credentials from the AuthManager.
 * Returns null if no valid credentials are found.
 */
export function getGeminiCredentialFromAuthManager(): GeminiCredentialSet | null {
    try {
        const auth = getAuthManager();

        // Find a Gemini credential
        const cred = auth.getCredential('google-gemini-cli');
        if (!cred || cred.type !== 'oauth') {
            return null;
        }

        const oauthCred = cred as OAuthCredential;

        // Check if it's valid (not expired)
        if (!auth.isCredentialValid(cred)) {
            workerLogger.debug({ profileId: 'gemini:cli' }, 'Gemini credential from AuthManager is expired');
            return null;
        }

        return {
            oauth_creds: {
                access_token: oauthCred.access,
                refresh_token: oauthCred.refresh,
                expiry_date: oauthCred.expires,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                token_type: 'Bearer',
            },
            google_accounts: {
                active: oauthCred.email || 'unknown',
            },
        };
    } catch (error) {
        workerLogger.debug(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to get Gemini credential from AuthManager'
        );
        return null;
    }
}

/**
 * Sync credentials on startup and optionally write to ~/.gemini/
 */
export function syncAndWriteGeminiCredentials(): boolean {
    try {
        const auth = getAuthManager();

        // Sync from external sources
        const result = auth.sync();
        workerLogger.info(
            { profileCount: result.profileCount, sources: result.sources },
            'Synced credentials from external sources'
        );

        // Try to get a Gemini credential
        const credSet = getGeminiCredentialFromAuthManager();
        if (!credSet) {
            workerLogger.debug({}, 'No Gemini credential available from AuthManager');
            return false;
        }

        // Write to ~/.gemini/ for Gemini CLI to use
        const userGeminiDir = join(homedir(), '.gemini');
        mkdirSync(userGeminiDir, { recursive: true });

        writeFileSync(
            join(userGeminiDir, 'oauth_creds.json'),
            JSON.stringify(credSet.oauth_creds, null, 2)
        );
        writeFileSync(
            join(userGeminiDir, 'google_accounts.json'),
            JSON.stringify(credSet.google_accounts, null, 2)
        );

        workerLogger.info(
            { account: credSet.google_accounts.active },
            'Wrote Gemini credentials from AuthManager to ~/.gemini/'
        );
        return true;
    } catch (error) {
        workerLogger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to sync/write Gemini credentials'
        );
        return false;
    }
}

/**
 * Check if AuthManager has Gemini credentials
 */
export function hasAuthManagerCredentials(): boolean {
    try {
        const auth = getAuthManager();
        const cred = auth.getCredential('google-gemini-cli');
        return cred !== null && auth.isCredentialValid(cred);
    } catch {
        return false;
    }
}
