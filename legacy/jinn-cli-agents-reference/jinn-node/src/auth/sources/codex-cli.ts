/**
 * Codex CLI Credential Source
 *
 * Reads credentials from ~/.codex/auth.json
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Credential, OAuthCredential } from '../types.js';
import type { CredentialSource } from './base.js';

const CODEX_DIR = '.codex';
const AUTH_FILE = 'auth.json';

/**
 * Source for Codex CLI credentials
 */
export class CodexCliSource implements CredentialSource {
    readonly name = 'codex-cli';

    private get authPath(): string {
        return join(homedir(), CODEX_DIR, AUTH_FILE);
    }

    isAvailable(): boolean {
        return existsSync(this.authPath);
    }

    readCredentials(): Record<string, Credential> | null {
        if (!this.isAvailable()) {
            return null;
        }

        try {
            const raw = readFileSync(this.authPath, 'utf8');
            const data = JSON.parse(raw);

            // Codex stores tokens in a 'tokens' object
            if (data.tokens && data.tokens.access_token) {
                // Calculate expiry from last_refresh (tokens last ~1 hour)
                let expires: number;
                if (data.last_refresh) {
                    const lastRefresh = new Date(data.last_refresh).getTime();
                    expires = lastRefresh + 3600000; // 1 hour after last refresh
                } else {
                    expires = Date.now() + 3600000;
                }

                const credential: OAuthCredential = {
                    type: 'oauth',
                    provider: 'openai-codex',
                    access: data.tokens.access_token,
                    refresh: data.tokens.refresh_token ?? '',
                    expires,
                    source: this.name,
                };

                return {
                    'openai:codex-cli': credential,
                };
            }

            // Also check for static OPENAI_API_KEY
            if (data.OPENAI_API_KEY && typeof data.OPENAI_API_KEY === 'string') {
                return {
                    'openai:codex-key': {
                        type: 'api_key',
                        provider: 'openai',
                        key: data.OPENAI_API_KEY,
                        source: this.name,
                    },
                };
            }

            return null;
        } catch {
            return null;
        }
    }
}
