import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { manifestDigestForCid } from '../../../src/adapters/mech/digest.js';

const MANIFEST_CID = 'bafyfixturecid';

describe('manifestDigestForCid', () => {
  it('derives the same manifest digest used by task posting', () => {
    expect(manifestDigestForCid(MANIFEST_CID)).toBe(keccak256(toBytes(MANIFEST_CID)));
  });
});
