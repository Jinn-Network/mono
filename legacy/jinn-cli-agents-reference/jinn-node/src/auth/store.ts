/**
 * Jinn Auth Store
 *
 * Handles reading and writing the auth profile store at ~/.jinn/auth/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AuthProfileStore, SyncStatus } from './types.js';

const AUTH_STORE_VERSION = 1;
const AUTH_DIR_NAME = '.jinn';
const AUTH_SUBDIR_NAME = 'auth';
const PROFILES_FILENAME = 'profiles.json';
const SYNC_STATUS_FILENAME = 'sync-status.json';

/**
 * Get the auth directory path (~/.jinn/auth/)
 */
export function resolveAuthDir(): string {
    return join(homedir(), AUTH_DIR_NAME, AUTH_SUBDIR_NAME);
}

/**
 * Get the profiles.json path
 */
export function resolveProfilesPath(): string {
    return join(resolveAuthDir(), PROFILES_FILENAME);
}

/**
 * Get the sync-status.json path
 */
export function resolveSyncStatusPath(): string {
    return join(resolveAuthDir(), SYNC_STATUS_FILENAME);
}

/**
 * Ensure the auth directory exists
 */
export function ensureAuthDir(): void {
    const authDir = resolveAuthDir();
    if (!existsSync(authDir)) {
        mkdirSync(authDir, { recursive: true });
    }
}

/**
 * Load the auth profile store from disk
 */
export function loadAuthStore(): AuthProfileStore {
    const profilesPath = resolveProfilesPath();

    if (!existsSync(profilesPath)) {
        return {
            version: AUTH_STORE_VERSION,
            profiles: {},
        };
    }

    try {
        const raw = readFileSync(profilesPath, 'utf8');
        const parsed = JSON.parse(raw);

        // Validate structure
        if (!parsed || typeof parsed !== 'object') {
            return { version: AUTH_STORE_VERSION, profiles: {} };
        }

        return {
            version: parsed.version ?? AUTH_STORE_VERSION,
            profiles: parsed.profiles ?? {},
            lastGood: parsed.lastGood,
        };
    } catch {
        return { version: AUTH_STORE_VERSION, profiles: {} };
    }
}

/**
 * Save the auth profile store to disk
 */
export function saveAuthStore(store: AuthProfileStore): void {
    ensureAuthDir();
    const profilesPath = resolveProfilesPath();

    const payload = {
        version: AUTH_STORE_VERSION,
        profiles: store.profiles,
        ...(store.lastGood ? { lastGood: store.lastGood } : {}),
    };

    writeFileSync(profilesPath, JSON.stringify(payload, null, 2));
}

/**
 * Load sync status from disk
 */
export function loadSyncStatus(): SyncStatus {
    const statusPath = resolveSyncStatusPath();

    if (!existsSync(statusPath)) {
        return { lastSync: {} };
    }

    try {
        const raw = readFileSync(statusPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            lastSync: parsed.lastSync ?? {},
        };
    } catch {
        return { lastSync: {} };
    }
}

/**
 * Save sync status to disk
 */
export function saveSyncStatus(status: SyncStatus): void {
    ensureAuthDir();
    const statusPath = resolveSyncStatusPath();
    writeFileSync(statusPath, JSON.stringify(status, null, 2));
}
