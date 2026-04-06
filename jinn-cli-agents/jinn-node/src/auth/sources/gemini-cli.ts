/**
 * Gemini CLI Credential Source
 *
 * Reads OAuth credentials from ~/.gemini/oauth_creds.json
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Credential, OAuthCredential } from '../types.js';
import type { CredentialSource } from './base.js';

const GEMINI_DIR = '.gemini';
const OAUTH_CREDS_FILE = 'oauth_creds.json';
const GOOGLE_ACCOUNTS_FILE = 'google_accounts.json';

/**
 * Source for Gemini CLI OAuth credentials
 */
export class GeminiCliSource implements CredentialSource {
    readonly name = 'gemini-cli';

    private get geminiDir(): string {
        return join(homedir(), GEMINI_DIR);
    }

    private get oauthCredsPath(): string {
        return join(this.geminiDir, OAUTH_CREDS_FILE);
    }

    private get googleAccountsPath(): string {
        return join(this.geminiDir, GOOGLE_ACCOUNTS_FILE);
    }

    isAvailable(): boolean {
        return existsSync(this.oauthCredsPath);
    }

    readCredentials(): Record<string, Credential> | null {
        if (!this.isAvailable()) {
            return null;
        }

        try {
            const raw = readFileSync(this.oauthCredsPath, 'utf8');
            const creds = JSON.parse(raw);

            // Validate required fields
            if (!creds.access_token || !creds.refresh_token) {
                return null;
            }

            // Try to read the active email from google_accounts.json
            let email: string | undefined;
            try {
                if (existsSync(this.googleAccountsPath)) {
                    const accountsRaw = readFileSync(this.googleAccountsPath, 'utf8');
                    const accounts = JSON.parse(accountsRaw);
                    email = accounts.active;
                }
            } catch {
                // Ignore - email is optional
            }

            const credential: OAuthCredential = {
                type: 'oauth',
                provider: 'google-gemini-cli',
                access: creds.access_token,
                refresh: creds.refresh_token,
                expires: creds.expiry_date ?? Date.now() + 3600000, // Default 1 hour if not set
                email,
                source: this.name,
            };

            return {
                'gemini:cli': credential,
            };
        } catch {
            return null;
        }
    }
}
