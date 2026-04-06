/**
 * Unit Test: Operator Registration
 * Module: jinn-node/src/worker/register-operator.ts
 *
 * Tests the ensureOperatorRegistered() startup hook and selfRegisterOperator() function.
 * Mocks fetch and operate-profile to avoid real HTTP calls and keystore access.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before importing
vi.mock('jinn-node/env/operate-profile.js', () => ({
    getServicePrivateKey: vi.fn(),
    getMechChainConfig: vi.fn(() => 'base'),
}));

vi.mock('jinn-node/http/erc8128.js', async () => {
    const actual = await vi.importActual<any>('jinn-node/http/erc8128.js');
    return {
        ...actual,
        resolveChainId: vi.fn(() => 8453),
        createPrivateKeyHttpSigner: vi.fn(() => ({
            address: '0x1234567890abcdef1234567890abcdef12345678',
            chainId: 8453,
            signMessage: vi.fn(),
        })),
        signRequestWithErc8128: vi.fn(async (args: any) => new Request(args.input, args.init)),
    };
});

// Import after mocks
import { ensureOperatorRegistered, selfRegisterOperator } from 'jinn-node/worker/register-operator.js';
import { getServicePrivateKey } from 'jinn-node/env/operate-profile.js';

describe('selfRegisterOperator', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.mocked(getServicePrivateKey).mockReturnValue('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    it('returns error when X402_GATEWAY_URL is not set', async () => {
        delete process.env.X402_GATEWAY_URL;
        const result = await selfRegisterOperator();
        expect(result.registered).toBe(false);
        expect(result.error).toContain('X402_GATEWAY_URL');
    });

    it('returns error when private key is not available', async () => {
        process.env.X402_GATEWAY_URL = 'http://localhost:3000';
        vi.mocked(getServicePrivateKey).mockReturnValue(null);
        const result = await selfRegisterOperator();
        expect(result.registered).toBe(false);
        expect(result.error).toContain('private key');
    });

    it('handles successful registration (201)', async () => {
        process.env.X402_GATEWAY_URL = 'http://localhost:3000';
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ trustTier: 'untrusted', grants: [] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await selfRegisterOperator();
        expect(result.registered).toBe(true);
        expect(result.alreadyRegistered).toBe(false);
        expect(result.address).toBeTruthy();
        expect(result.trustTier).toBe('untrusted');
    });

    it('handles already-registered operator (409)', async () => {
        process.env.X402_GATEWAY_URL = 'http://localhost:3000';
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: 'already registered' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await selfRegisterOperator();
        expect(result.registered).toBe(true);
        expect(result.alreadyRegistered).toBe(true);
    });

    it('handles gateway error (500)', async () => {
        process.env.X402_GATEWAY_URL = 'http://localhost:3000';
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: 'internal error' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await selfRegisterOperator();
        expect(result.registered).toBe(false);
        expect(result.error).toContain('500');
    });
});

describe('ensureOperatorRegistered', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.mocked(getServicePrivateKey).mockReturnValue('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    it('skips silently when X402_GATEWAY_URL is not set', async () => {
        delete process.env.X402_GATEWAY_URL;
        // Should not throw
        await expect(ensureOperatorRegistered()).resolves.toBeUndefined();
    });

    it('does not throw when gateway is unreachable', async () => {
        process.env.X402_GATEWAY_URL = 'http://localhost:99999';
        const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        vi.stubGlobal('fetch', mockFetch);

        // Should catch error and log warning, not throw
        await expect(ensureOperatorRegistered()).resolves.toBeUndefined();
    });

    it('succeeds when gateway returns 201', async () => {
        process.env.X402_GATEWAY_URL = 'http://localhost:3000';
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ trustTier: 'untrusted', grants: [] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        await expect(ensureOperatorRegistered()).resolves.toBeUndefined();
    });
});
