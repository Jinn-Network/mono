/**
 * Isolated from doctor.test.ts so `vi.mock('viem')` cannot poison DI
 * integration tests that import `createDoctorCommand`.
 *
 * After merging origin/next, `checkDistributorReachable` accepts an
 * injectable `readBalance` (covered by doctor.test.ts). This file still
 * plants the failure through the default `createPublicClient` path.
 *
 * Issue #4549: the distributor probe catch interpolated `err.message`. A
 * viem HttpRequestError-shaped failure embeds the RPC URL (userinfo +
 * path key). The detail must keep the hostname and drop credentials.
 */
import { describe, expect, it, vi } from 'vitest';

const { HOST, SECRET, LEAKY_URL } = vi.hoisted(() => {
  const HOST = 'rpc.example';
  const SECRET = 'SECRETKEYSECRETKEY01';
  return { HOST, SECRET, LEAKY_URL: `https://u:pw@${HOST}/v2/${SECRET}` };
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: async () => {
        throw new Error(`HTTP request failed. URL: ${LEAKY_URL}`);
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
    expect(result!.detail).toBe(`distributor probe failed: HTTP request failed. URL: ${HOST}`);
    expect(result!.detail).not.toContain(SECRET);
    expect(result!.detail).not.toContain('u:pw');
    expect(result!.detail).not.toContain(LEAKY_URL);
  });
});
