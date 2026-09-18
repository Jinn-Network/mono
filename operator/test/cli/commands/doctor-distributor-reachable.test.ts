/**
 * Isolated from doctor.test.ts so `vi.mock('viem')` cannot poison DI
 * integration tests that import `createDoctorCommand`.
 *
 * Issue #4549: the distributor probe catch interpolated `err.message`. A
 * viem HttpRequestError-shaped failure embeds the RPC URL (userinfo +
 * path key). The detail must keep the hostname and drop credentials.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: async () => {
        throw new Error(
          'HTTP request failed. URL: https://u:pw@host/v2/SECRETKEYSECRETKEY01',
        );
      },
    })),
  };
});

import { checkDistributorReachable } from '@/cli/commands/doctor.js';

describe('checkDistributorReachable', () => {
  it('sanitizes planted RPC credentials in the catch detail while keeping the host (#4549)', async () => {
    const result = await checkDistributorReachable({
      network: 'testnet',
      rpcUrl: 'https://example.invalid',
    } as any);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('distributor_reachable');
    expect(result!.ok).toBe(true);
    expect(result!.detail).toContain('host');
    expect(result!.detail).not.toContain('SECRETKEYSECRETKEY01');
    expect(result!.detail).not.toContain('u:pw');
    expect(result!.detail).not.toContain('https://u:pw@host/v2/SECRETKEYSECRETKEY01');
  });
});
