import { describe, expect, it } from 'vitest';
import { isAcceptedIpfsCid, isIpfsCid } from '../../src/task-creator/proofs/ipfs-cid.js';

describe('task-creator IPFS CID boundary', () => {
  it('accepts a CIDv0 and rejects a readable but non-CID publication label', () => {
    expect(isIpfsCid('QmYwAPJzv5CZsnAzt8auVTLF9rYx8S1R52eX5GJH2RGfZp')).toBe(true);
    expect(isIpfsCid('bafy-prepublished-receipt')).toBe(false);
  });

  it('keeps hermetic test-only fixture labels separate from operator CID acceptance', () => {
    expect(isAcceptedIpfsCid('bafy-test-only-jinn-differential-receipt')).toBe(true);
  });
});
