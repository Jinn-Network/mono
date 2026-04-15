/**
 * Credential Source Interface
 *
 * Base interface for all credential sources.
 */

import type { Credential } from '../types.js';

/**
 * A credential source that can read credentials from an external location
 */
export interface CredentialSource {
    /**
     * Unique name for this source (e.g., 'gemini-cli', 'openclaw')
     */
    readonly name: string;

    /**
     * Check if this source is available (e.g., files exist)
     */
    isAvailable(): boolean;

    /**
     * Read credentials from this source
     * Returns a map of profileId -> Credential, or null if unable to read
     */
    readCredentials(): Record<string, Credential> | null;
}
