/**
 * Credential Sync Module
 *
 * Orchestrates syncing credentials from all external sources
 */

import { loadAuthStore, saveAuthStore, loadSyncStatus, saveSyncStatus } from './store.js';
import type { AuthProfileStore, Credential, SyncResult } from './types.js';
import {
    GeminiCliSource,
    OpenClawSource,
    ClaudeCliSource,
    CodexCliSource,
    EnvironmentSource,
    type CredentialSource,
} from './sources/index.js';

/**
 * Get all credential sources in priority order
 */
function getAllSources(): CredentialSource[] {
    return [
        new OpenClawSource(),
        new GeminiCliSource(),
        new ClaudeCliSource(),
        new CodexCliSource(),
        new EnvironmentSource(),
    ];
}

/**
 * Merge credentials into the store
 * Later sources don't overwrite existing credentials (priority order matters)
 */
function mergeCredentials(
    store: AuthProfileStore,
    newCredentials: Record<string, Credential>,
    overwriteExisting = false
): void {
    for (const [profileId, credential] of Object.entries(newCredentials)) {
        // Don't overwrite existing credentials unless explicitly requested
        if (!overwriteExisting && store.profiles[profileId]) {
            continue;
        }
        store.profiles[profileId] = credential;
    }
}

/**
 * Sync credentials from all external sources
 */
export function syncCredentials(): SyncResult {
    const store = loadAuthStore();
    const sources = getAllSources();
    const syncedSources: string[] = [];
    const errors: string[] = [];

    for (const source of sources) {
        try {
            if (!source.isAvailable()) {
                continue;
            }

            const credentials = source.readCredentials();
            if (credentials) {
                mergeCredentials(store, credentials);
                syncedSources.push(source.name);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            errors.push(`${source.name}: ${msg}`);
        }
    }

    // Save the merged store
    saveAuthStore(store);

    // Update sync timestamps
    const syncStatus = loadSyncStatus();
    const now = Date.now();
    for (const sourceName of syncedSources) {
        syncStatus.lastSync[sourceName] = now;
    }
    saveSyncStatus(syncStatus);

    return {
        profileCount: Object.keys(store.profiles).length,
        sources: syncedSources,
        errors: errors.length > 0 ? errors : undefined,
    };
}

/**
 * Force sync from a specific source
 */
export function syncFromSource(sourceName: string): SyncResult {
    const sources = getAllSources();
    const source = sources.find((s) => s.name === sourceName);

    if (!source) {
        return {
            profileCount: 0,
            sources: [],
            errors: [`Unknown source: ${sourceName}`],
        };
    }

    if (!source.isAvailable()) {
        return {
            profileCount: 0,
            sources: [],
            errors: [`Source not available: ${sourceName}`],
        };
    }

    const store = loadAuthStore();

    try {
        const credentials = source.readCredentials();
        if (credentials) {
            mergeCredentials(store, credentials, true); // Overwrite for explicit sync
            saveAuthStore(store);

            const syncStatus = loadSyncStatus();
            syncStatus.lastSync[sourceName] = Date.now();
            saveSyncStatus(syncStatus);

            return {
                profileCount: Object.keys(credentials).length,
                sources: [sourceName],
            };
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
            profileCount: 0,
            sources: [],
            errors: [`${sourceName}: ${msg}`],
        };
    }

    return {
        profileCount: 0,
        sources: [],
    };
}
