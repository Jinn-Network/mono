import { describe, it, expect } from 'vitest';
import { buildSafeSignature } from '../../../src/adapters/mech/safe.js';

describe('Safe utilities', () => {
  it('builds a pre-validated signature from an EOA address', () => {
    const address = '0x1234567890123456789012345678901234567890';
    const sig = buildSafeSignature(address);
    expect(sig).toMatch(/^0x/);
    expect(sig.length).toBe(2 + 130); // 0x + 65 bytes hex
  });
});
