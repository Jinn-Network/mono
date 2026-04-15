import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSecrets } from 'jinn-node/config/secrets.js';

describe('loadSecrets', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore original env
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnv)) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
    });

    it('reads secrets from process.env', () => {
        process.env.GITHUB_TOKEN = 'ghp_test123';
        process.env.OPENAI_API_KEY = 'sk-test456';
        const secrets = loadSecrets();
        expect(secrets.githubToken).toBe('ghp_test123');
        expect(secrets.openaiApiKey).toBe('sk-test456');
    });

    it('returns undefined for unset secrets', () => {
        delete process.env.GITHUB_TOKEN;
        delete process.env.OPENAI_API_KEY;
        const secrets = loadSecrets();
        expect(secrets.githubToken).toBeUndefined();
        expect(secrets.openaiApiKey).toBeUndefined();
    });

    it('parses civitaiAirWait as number', () => {
        process.env.CIVITAI_AIR_WAIT = '30';
        const secrets = loadSecrets();
        expect(secrets.civitaiAirWait).toBe(30);
    });

    it('returns undefined for NaN civitaiAirWait', () => {
        process.env.CIVITAI_AIR_WAIT = 'not-a-number';
        const secrets = loadSecrets();
        expect(secrets.civitaiAirWait).toBeUndefined();
    });

    it('returns undefined for empty civitaiAirWait', () => {
        process.env.CIVITAI_AIR_WAIT = '';
        const secrets = loadSecrets();
        expect(secrets.civitaiAirWait).toBeUndefined();
    });

    it('reads umami credentials', () => {
        process.env.UMAMI_USERNAME = 'admin';
        process.env.UMAMI_PASSWORD = 'secret';
        const secrets = loadSecrets();
        expect(secrets.umamiUsername).toBe('admin');
        expect(secrets.umamiPassword).toBe('secret');
    });
});
