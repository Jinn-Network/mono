/**
 * OpenClaw Credential Source
 *
 * Reads credentials from ~/.openclaw/agents/main/agent/auth-profiles.json
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Credential } from '../types.js';
import type { CredentialSource } from './base.js';

const OPENCLAW_DIR = '.openclaw';
const AUTH_PROFILES_PATH = 'agents/main/agent/auth-profiles.json';

/**
 * Source for OpenClaw auth profiles
 */
export class OpenClawSource implements CredentialSource {
    readonly name = 'openclaw';

    private get authProfilesPath(): string {
        return join(homedir(), OPENCLAW_DIR, AUTH_PROFILES_PATH);
    }

    isAvailable(): boolean {
        return existsSync(this.authProfilesPath);
    }

    readCredentials(): Record<string, Credential> | null {
        if (!this.isAvailable()) {
            return null;
        }

        try {
            const raw = readFileSync(this.authProfilesPath, 'utf8');
            const store = JSON.parse(raw);

            if (!store || !store.profiles || typeof store.profiles !== 'object') {
                return null;
            }

            const credentials: Record<string, Credential> = {};

            for (const [profileId, profile] of Object.entries(store.profiles)) {
                const p = profile as Record<string, unknown>;

                // Map OpenClaw credential types to our types
                if (p.type === 'api_key' && typeof p.key === 'string') {
                    credentials[profileId] = {
                        type: 'api_key',
                        provider: String(p.provider ?? 'unknown'),
                        key: p.key,
                        email: typeof p.email === 'string' ? p.email : undefined,
                        source: this.name,
                    };
                } else if (p.type === 'oauth' && typeof p.access === 'string') {
                    credentials[profileId] = {
                        type: 'oauth',
                        provider: String(p.provider ?? 'unknown'),
                        access: p.access,
                        refresh: typeof p.refresh === 'string' ? p.refresh : '',
                        expires: typeof p.expires === 'number' ? p.expires : Date.now() + 3600000,
                        email: typeof p.email === 'string' ? p.email : undefined,
                        source: this.name,
                    };
                } else if (p.type === 'token' && typeof p.token === 'string') {
                    credentials[profileId] = {
                        type: 'token',
                        provider: String(p.provider ?? 'unknown'),
                        token: p.token,
                        expires: typeof p.expires === 'number' ? p.expires : undefined,
                        email: typeof p.email === 'string' ? p.email : undefined,
                        source: this.name,
                    };
                }
            }

            return Object.keys(credentials).length > 0 ? credentials : null;
        } catch {
            return null;
        }
    }
}
