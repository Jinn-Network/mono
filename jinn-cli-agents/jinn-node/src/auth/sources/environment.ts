/**
 * Environment Variable Credential Source
 *
 * Reads API keys from environment variables
 */

import type { ApiKeyCredential, Credential } from '../types.js';
import type { CredentialSource } from './base.js';

/**
 * Mapping of environment variables to providers
 */
const ENV_MAPPINGS: Array<{ envVar: string; provider: string; profileId: string }> = [
    { envVar: 'GEMINI_API_KEY', provider: 'google-gemini', profileId: 'gemini:env' },
    { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic', profileId: 'anthropic:env' },
    { envVar: 'OPENAI_API_KEY', provider: 'openai', profileId: 'openai:env' },
];

/**
 * Source for environment variable API keys
 */
export class EnvironmentSource implements CredentialSource {
    readonly name = 'environment';

    isAvailable(): boolean {
        // Available if any of the mapped env vars are set
        return ENV_MAPPINGS.some(({ envVar }) => !!process.env[envVar]);
    }

    readCredentials(): Record<string, Credential> | null {
        const credentials: Record<string, Credential> = {};

        for (const { envVar, provider, profileId } of ENV_MAPPINGS) {
            const value = process.env[envVar];
            if (value && value.trim()) {
                const credential: ApiKeyCredential = {
                    type: 'api_key',
                    provider,
                    key: value.trim(),
                    source: this.name,
                };
                credentials[profileId] = credential;
            }
        }

        return Object.keys(credentials).length > 0 ? credentials : null;
    }
}
