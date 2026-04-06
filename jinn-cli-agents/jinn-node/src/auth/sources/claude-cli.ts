/**
 * Claude CLI Credential Source
 *
 * Reads credentials from macOS Keychain or ~/.claude/.credentials.json
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import type { Credential, OAuthCredential } from '../types.js';
import type { CredentialSource } from './base.js';

const CLAUDE_DIR = '.claude';
const CREDENTIALS_FILE = '.credentials.json';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Source for Claude CLI credentials
 */
export class ClaudeCliSource implements CredentialSource {
    readonly name = 'claude-cli';

    private get credentialsPath(): string {
        return join(homedir(), CLAUDE_DIR, CREDENTIALS_FILE);
    }

    isAvailable(): boolean {
        // Available if keychain has credentials or file exists
        return this.hasKeychainCredentials() || existsSync(this.credentialsPath);
    }

    private hasKeychainCredentials(): boolean {
        if (process.platform !== 'darwin') {
            return false;
        }

        try {
            execSync(
                `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            return true;
        } catch {
            return false;
        }
    }

    private readFromKeychain(): Record<string, Credential> | null {
        if (process.platform !== 'darwin') {
            return null;
        }

        try {
            const raw = execSync(
                `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();

            const data = JSON.parse(raw);

            // Claude stores OAuth under claudeAiOauth
            if (data.claudeAiOauth) {
                const oauth = data.claudeAiOauth;

                if (!oauth.accessToken) {
                    return null;
                }

                const credential: OAuthCredential = {
                    type: 'oauth',
                    provider: 'anthropic',
                    access: oauth.accessToken,
                    refresh: oauth.refreshToken ?? '',
                    expires: oauth.expiresAt ?? Date.now() + 3600000,
                    source: this.name,
                };

                return {
                    'anthropic:claude-cli': credential,
                };
            }

            return null;
        } catch {
            return null;
        }
    }

    private readFromFile(): Record<string, Credential> | null {
        if (!existsSync(this.credentialsPath)) {
            return null;
        }

        try {
            const raw = readFileSync(this.credentialsPath, 'utf8');
            const data = JSON.parse(raw);

            if (data.claudeAiOauth) {
                const oauth = data.claudeAiOauth;

                if (!oauth.accessToken) {
                    return null;
                }

                const credential: OAuthCredential = {
                    type: 'oauth',
                    provider: 'anthropic',
                    access: oauth.accessToken,
                    refresh: oauth.refreshToken ?? '',
                    expires: oauth.expiresAt ?? Date.now() + 3600000,
                    source: this.name,
                };

                return {
                    'anthropic:claude-cli': credential,
                };
            }

            return null;
        } catch {
            return null;
        }
    }

    readCredentials(): Record<string, Credential> | null {
        // Try keychain first (macOS), then fall back to file
        const keychainCreds = this.readFromKeychain();
        if (keychainCreds) {
            return keychainCreds;
        }

        return this.readFromFile();
    }
}
