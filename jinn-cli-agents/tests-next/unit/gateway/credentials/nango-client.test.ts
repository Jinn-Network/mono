/**
 * Unit Test: Nango Client Security
 * Module: services/x402-gateway/credentials/nango-client.ts
 *
 * Tests input validation (path traversal prevention) and error sanitization.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    NANGO_HOST: 'https://nango.example.com',
    NANGO_SECRET_KEY: 'test-secret-key',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

describe('getNangoAccessToken', () => {
  describe('path traversal prevention', () => {
    it('rejects connectionId containing path separators', async () => {
      const { getNangoAccessToken } = await import(
        '../../../../services/x402-gateway/credentials/nango-client.js'
      );
      await expect(getNangoAccessToken('../admin/keys')).rejects.toThrow(
        'Invalid connectionId',
      );
    });

    it('rejects connectionId containing dots', async () => {
      const { getNangoAccessToken } = await import(
        '../../../../services/x402-gateway/credentials/nango-client.js'
      );
      await expect(getNangoAccessToken('..%2fadmin')).rejects.toThrow(
        'Invalid connectionId',
      );
    });

    it('rejects providerConfigKey with special characters', async () => {
      const { getNangoAccessToken } = await import(
        '../../../../services/x402-gateway/credentials/nango-client.js'
      );
      await expect(
        getNangoAccessToken('valid-id', '../secret'),
      ).rejects.toThrow('Invalid providerConfigKey');
    });

    it('accepts valid connectionId with alphanumeric, hyphens, underscores', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            credentials: {
              access_token: 'tok_123',
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { getNangoAccessToken } = await import(
        '../../../../services/x402-gateway/credentials/nango-client.js'
      );
      const result = await getNangoAccessToken('my-valid_connection123');
      expect(result.access_token).toBe('tok_123');
    });
  });

  describe('error sanitization', () => {
    it('does not expose raw Nango error text in thrown error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () =>
          Promise.resolve(
            'Internal: db connection to postgres://admin:secret@internal:5432 failed',
          ),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { getNangoAccessToken } = await import(
        '../../../../services/x402-gateway/credentials/nango-client.js'
      );
      await expect(getNangoAccessToken('valid-id')).rejects.toThrow(
        'Failed to fetch OAuth token from provider',
      );
      // The generic message should NOT contain the internal DB connection string
      try {
        await getNangoAccessToken('valid-id');
      } catch (err) {
        expect((err as Error).message).not.toContain('postgres://');
        expect((err as Error).message).not.toContain('secret');
      }
    });
  });
});
