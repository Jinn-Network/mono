/**
 * Jinn Auth Module
 *
 * Unified authentication layer for jinn-node.
 * Discovers credentials from external CLI tools and provides a unified API.
 *
 * @example
 * ```typescript
 * import { getAuthManager } from './auth/index.js';
 *
 * const auth = getAuthManager();
 *
 * // Sync credentials from all sources
 * auth.sync();
 *
 * // Get a credential for Gemini
 * const cred = auth.getCredential('google-gemini-cli');
 * if (cred) {
 *   // Use the credential
 * }
 * ```
 */

// Public API
export { AuthManager, getAuthManager } from './manager.js';
export { syncCredentials, syncFromSource } from './sync.js';
export { loadAuthStore, saveAuthStore, resolveAuthDir } from './store.js';

// Types
export type {
    Credential,
    ApiKeyCredential,
    OAuthCredential,
    TokenCredential,
    AuthProfileStore,
    AuthStatus,
    SyncResult,
    SyncStatus,
} from './types.js';

// Sources (for advanced use cases)
export {
    GeminiCliSource,
    OpenClawSource,
    ClaudeCliSource,
    CodexCliSource,
    EnvironmentSource,
} from './sources/index.js';
export type { CredentialSource } from './sources/index.js';
