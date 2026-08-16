import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import {
  manifestDigestForCid,
  manifestDigestForCidOrDigest,
} from '../../../src/adapters/mech/digest.js';

const MANIFEST_CID = 'bafyfixturecid';

describe('manifestDigestForCid', () => {
  it('derives the same manifest digest used by task posting', () => {
    expect(manifestDigestForCid(MANIFEST_CID)).toBe(keccak256(toBytes(MANIFEST_CID)));
  });
});

describe('manifestDigestForCidOrDigest', () => {
  it('passes a hex digest through without re-hashing', () => {
    const digest = keccak256(toBytes(MANIFEST_CID));
    expect(manifestDigestForCidOrDigest(digest)).toBe(digest.toLowerCase());
  });

  it('hashes a CID the same way as manifestDigestForCid', () => {
    expect(manifestDigestForCidOrDigest(MANIFEST_CID)).toBe(keccak256(toBytes(MANIFEST_CID)));
  });
});
