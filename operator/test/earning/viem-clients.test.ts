/**
 * Tests that the shared viem client factories build a fallback transport when
 * given an array (or comma-string) of URLs, and remain backward-compatible
 * with a single-string input.
 *
 * AC1 (issue #592): every factory must accept string | readonly string[].
 */

import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createJinnPublicClient,
  createJinnWalletClient,
} from '../../src/earning/viem-clients.js';

const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}` as const;

describe('createJinnPublicClient', () => {
  it('builds a fallback transport for an array of URLs', () => {
    const client = createJinnPublicClient(
      ['https://a.example', 'https://b.example'],
      'base-sepolia',
    );
    expect(client.transport.type).toBe('fallback');
  });

  it('still works for a single-string URL (back-compat)', () => {
    const client = createJinnPublicClient('https://a.example', 'base-sepolia');
    // Single URL still routes through the helper, which always returns a
    // fallback transport (1-slot chain). This is the back-compat seam.
    expect(client.transport.type).toBe('fallback');
  });
});

describe('createJinnWalletClient', () => {
  it('builds a fallback transport for an array of URLs', () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const client = createJinnWalletClient(
      ['https://a.example', 'https://b.example'],
      'base-sepolia',
      account,
    );
    expect(client.transport.type).toBe('fallback');
  });
});
