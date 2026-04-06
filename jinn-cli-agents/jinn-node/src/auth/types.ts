/**
 * Jinn Authentication Types
 *
 * These types define the credential formats used by the AuthManager.
 * They are compatible with OpenClaw's auth-profiles format.
 */

/**
 * Static API key credential (e.g., GEMINI_API_KEY)
 */
export type ApiKeyCredential = {
    type: 'api_key';
    provider: string;
    key: string;
    email?: string;
    source?: string;
};

/**
 * OAuth credential with refresh capability
 */
export type OAuthCredential = {
    type: 'oauth';
    provider: string;
    access: string;
    refresh: string;
    expires: number; // Unix timestamp in milliseconds
    clientId?: string;
    email?: string;
    source?: string;
};

/**
 * Static token credential (e.g., from Claude CLI)
 */
export type TokenCredential = {
    type: 'token';
    provider: string;
    token: string;
    expires?: number; // Optional expiry timestamp
    email?: string;
    source?: string;
};

/**
 * Union of all credential types
 */
export type Credential = ApiKeyCredential | OAuthCredential | TokenCredential;

/**
 * The auth profile store structure (compatible with OpenClaw)
 */
export type AuthProfileStore = {
    version: number;
    profiles: Record<string, Credential>;
    lastGood?: Record<string, string>;
};

/**
 * Sync status tracking
 */
export type SyncStatus = {
    lastSync: Record<string, number>;
};

/**
 * Result of a sync operation
 */
export type SyncResult = {
    profileCount: number;
    sources: string[];
    errors?: string[];
};

/**
 * Auth status for display
 */
export type AuthStatus = {
    profiles: Array<{
        profileId: string;
        provider: string;
        type: 'api_key' | 'oauth' | 'token';
        source?: string;
        email?: string;
        expiresIn?: number; // milliseconds until expiry, undefined if no expiry
        isValid: boolean;
    }>;
    lastSync?: number;
};
