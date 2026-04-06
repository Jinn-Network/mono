/**
 * Auth Manager
 *
 * Main API for credential management in jinn-node
 */

import { loadAuthStore, loadSyncStatus } from './store.js';
import { syncCredentials as doSync } from './sync.js';
import type { AuthProfileStore, AuthStatus, Credential, SyncResult } from './types.js';

/**
 * AuthManager provides a unified interface for credential management
 */
export class AuthManager {
    private store: AuthProfileStore | null = null;
    private lastLoad = 0;
    private readonly CACHE_TTL_MS = 5000; // 5 seconds

    /**
     * Load the store (with caching)
     */
    private ensureStore(): AuthProfileStore {
        const now = Date.now();
        if (!this.store || now - this.lastLoad > this.CACHE_TTL_MS) {
            this.store = loadAuthStore();
            this.lastLoad = now;
        }
        return this.store;
    }

    /**
     * Invalidate the cache to force a reload
     */
    invalidateCache(): void {
        this.store = null;
        this.lastLoad = 0;
    }

    /**
     * Get the best credential for a provider
     */
    getCredential(provider: string): Credential | null {
        const store = this.ensureStore();

        // First, check lastGood for this provider
        if (store.lastGood?.[provider]) {
            const lastGoodId = store.lastGood[provider];
            const cred = store.profiles[lastGoodId];
            if (cred && this.isCredentialValid(cred)) {
                return cred;
            }
        }

        // Otherwise, find any valid credential for this provider
        for (const cred of Object.values(store.profiles)) {
            if (cred.provider === provider && this.isCredentialValid(cred)) {
                return cred;
            }
        }

        return null;
    }

    /**
     * Get all credentials for a provider (for rotation)
     */
    getCredentials(provider: string): Credential[] {
        const store = this.ensureStore();
        return Object.values(store.profiles).filter(
            (cred) => cred.provider === provider && this.isCredentialValid(cred)
        );
    }

    /**
     * Get a credential by its profile ID
     */
    getCredentialById(profileId: string): Credential | null {
        const store = this.ensureStore();
        return store.profiles[profileId] ?? null;
    }

    /**
     * Check if a credential is valid (not expired)
     */
    isCredentialValid(credential: Credential): boolean {
        // API keys never expire
        if (credential.type === 'api_key') {
            return true;
        }

        // Tokens may have optional expiry
        if (credential.type === 'token') {
            if (!credential.expires) {
                return true;
            }
            return Date.now() < credential.expires;
        }

        // OAuth credentials have expiry
        if (credential.type === 'oauth') {
            // Add a 5-minute buffer
            return Date.now() < credential.expires - 5 * 60 * 1000;
        }

        return false;
    }

    /**
     * Get status of all credentials
     */
    getStatus(): AuthStatus {
        const store = this.ensureStore();
        const syncStatus = loadSyncStatus();

        const profiles: AuthStatus['profiles'] = [];

        for (const [profileId, cred] of Object.entries(store.profiles)) {
            let expiresIn: number | undefined;

            if (cred.type === 'oauth') {
                expiresIn = Math.max(0, cred.expires - Date.now());
            } else if (cred.type === 'token' && cred.expires) {
                expiresIn = Math.max(0, cred.expires - Date.now());
            }

            profiles.push({
                profileId,
                provider: cred.provider,
                type: cred.type,
                source: cred.source,
                email: cred.email,
                expiresIn,
                isValid: this.isCredentialValid(cred),
            });
        }

        // Get the most recent sync time
        const syncTimes = Object.values(syncStatus.lastSync);
        const lastSync = syncTimes.length > 0 ? Math.max(...syncTimes) : undefined;

        return { profiles, lastSync };
    }

    /**
     * Trigger a sync from external sources
     */
    sync(): SyncResult {
        const result = doSync();
        this.invalidateCache();
        return result;
    }

    /**
     * Get all profile IDs
     */
    getProfileIds(): string[] {
        const store = this.ensureStore();
        return Object.keys(store.profiles);
    }
}

// Singleton instance
let authManagerInstance: AuthManager | null = null;

/**
 * Get the singleton AuthManager instance
 */
export function getAuthManager(): AuthManager {
    if (!authManagerInstance) {
        authManagerInstance = new AuthManager();
    }
    return authManagerInstance;
}
