import { describe, it, expect } from 'vitest';
import { baseSepolia } from 'viem/chains';
import { buildSafeSignature, createClients } from '../../../src/adapters/mech/safe.js';

const TEST_PRIVATE_KEY = `0x${'22'.repeat(32)}` as const;

describe('Safe utilities', () => {
  it('builds a pre-validated signature from an EOA address', () => {
    const address = '0x1234567890123456789012345678901234567890';
    const sig = buildSafeSignature(address);
    expect(sig).toMatch(/^0x/);
    expect(sig.length).toBe(2 + 130); // 0x + 65 bytes hex
  });
});

describe('createClients (AC1: string-or-array RPC input)', () => {
  it('builds a fallback transport for an array of URLs', () => {
    const { publicClient, walletClient } = createClients(
      ['https://a.example', 'https://b.example'],
      TEST_PRIVATE_KEY,
      baseSepolia,
    );
    expect(publicClient.transport.type).toBe('fallback');
    expect(walletClient.transport.type).toBe('fallback');
  });

  it('still works for a single-string URL (back-compat)', () => {
    const { publicClient } = createClients('https://a.example', TEST_PRIVATE_KEY, baseSepolia);
    // Single URL still routes through the helper → 1-slot fallback.
    expect(publicClient.transport.type).toBe('fallback');
  });
});
