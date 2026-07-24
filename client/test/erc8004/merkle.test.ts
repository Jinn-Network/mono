import { describe, expect, it } from 'vitest';
import { concat, keccak256, toBytes, type Hex } from 'viem';
import { hashLeaf, merkleProof, merkleRoot, verifyMerkleProof } from '../../src/erc8004/merkle.js';

// Independent re-derivation of parent = keccak256(concat(left, right)).
function parent(left: Hex, right: Hex): Hex {
  return keccak256(concat([left, right]));
}

describe('hashLeaf', () => {
  it('is keccak256 of the UTF-8 bytes of the CID string', () => {
    expect(hashLeaf('bafy-abc')).toBe(keccak256(toBytes('bafy-abc')));
  });
});

describe('merkleRoot', () => {
  it('single leaf: root === the leaf itself (no hashing pass)', () => {
    expect(merkleRoot([hashLeaf('a-cid')])).toBe(hashLeaf('a-cid'));
  });

  it('two leaves: root === keccak256(concat(l0, l1))', () => {
    const l0 = hashLeaf('cid-0');
    const l1 = hashLeaf('cid-1');
    expect(merkleRoot([l0, l1])).toBe(parent(l0, l1));
  });

  it('three leaves: last leaf duplicated on the odd level', () => {
    const l0 = hashLeaf('cid-0');
    const l1 = hashLeaf('cid-1');
    const l2 = hashLeaf('cid-2');
    // level0: [l0,l1,l2] → [p(l0,l1), p(l2,l2)]; level1 odd? no, 2 nodes → p(a,b)
    const a = parent(l0, l1);
    const b = parent(l2, l2);
    expect(merkleRoot([l0, l1, l2])).toBe(parent(a, b));
  });

  it('empty leaves throws', () => {
    expect(() => merkleRoot([])).toThrow();
  });
});

describe('merkleProof + verifyMerkleProof round-trip', () => {
  for (const n of [1, 2, 3, 5]) {
    it(`every index of a ${n}-leaf tree proves against the root`, () => {
      const cids = Array.from({ length: n }, (_, i) => `cid-${i}`);
      const leaves = cids.map(hashLeaf);
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(leaves, i);
        expect(proof.index).toBe(i);
        expect(verifyMerkleProof(cids[i], proof, root)).toBe(true);
      }
    });
  }

  it('merkleProof throws on out-of-range index', () => {
    const leaves = ['cid-0', 'cid-1'].map(hashLeaf);
    expect(() => merkleProof(leaves, 2)).toThrow();
    expect(() => merkleProof(leaves, -1)).toThrow();
  });
});

describe('tamper detection', () => {
  it('wrong CID does not verify', () => {
    const cids = ['cid-0', 'cid-1', 'cid-2'];
    const leaves = cids.map(hashLeaf);
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 1);
    expect(verifyMerkleProof('not-a-real-cid', proof, root)).toBe(false);
  });

  it('mutated sibling does not verify', () => {
    const cids = ['cid-0', 'cid-1', 'cid-2', 'cid-3'];
    const leaves = cids.map(hashLeaf);
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 0);
    const mutated = {
      index: proof.index,
      siblings: [hashLeaf('tampered'), ...proof.siblings.slice(1)] as Hex[],
    };
    expect(verifyMerkleProof(cids[0], mutated, root)).toBe(false);
  });

  it('rejects malformed proof indices and hashes without throwing', () => {
    const cid = 'cid-0';
    const root = hashLeaf(cid);
    expect(verifyMerkleProof(cid, { index: -1, siblings: [] }, root)).toBe(false);
    expect(verifyMerkleProof(cid, { index: 0.5, siblings: [] }, root)).toBe(false);
    expect(
      verifyMerkleProof(cid, { index: Number.MAX_SAFE_INTEGER + 1, siblings: [] }, root),
    ).toBe(false);
    expect(
      verifyMerkleProof(cid, { index: 0, siblings: ['0xab' as Hex] }, root),
    ).toBe(false);
    expect(
      verifyMerkleProof(cid, { index: 0, siblings: [] }, '0xab' as Hex),
    ).toBe(false);
  });
});
