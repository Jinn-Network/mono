/**
 * Minimal binary merkle tree over batch-member CIDs (#1829).
 *
 * Used by the `manifest:` anchor path: a bulk substrate batch anchors ONE
 * `manifest:` record whose payload carries a merkle root over the member CIDs,
 * so any single member is provable against the on-chain root without a
 * per-member anchor.
 *
 * Fixed construction rules (the single source of truth — `manifest-consumer.ts`
 * and every test MUST agree):
 *
 *   - Leaf   = keccak256(utf8Bytes(member.cid)) — keccak of the UTF-8 bytes of
 *              the textual CID string, NOT the CID's multihash bytes and NOT the
 *              member body. The CID is already the content-address, so proving a
 *              CID is in the batch is the whole guarantee.
 *   - Order  = leaves stay in members[] insertion order. NOT sorted. The proof
 *              carries a leaf index and is re-derivable directly from members[].
 *   - Odd    = when a level has an odd node count, the last node pairs with
 *              itself (parent = keccak256(concat(last, last))).
 *   - Parent = keccak256(concat(left, right)), left = lower index.
 *   - Root   = a single-leaf tree's root is that leaf (no hashing pass). An
 *              empty leaf set is an error — a batch must have ≥1 member.
 *
 * viem-only. No new dependency (Rule 2 — reuse existing deps).
 */

import { concat, keccak256, toBytes, type Hex } from 'viem';

export interface MerkleProof {
  /** The leaf index this proof is for. */
  index: number;
  /** Sibling hashes bottom-up (one per tree level above the leaf). */
  siblings: Hex[];
}

/** Leaf hash for a member: keccak256 of the UTF-8 bytes of the textual CID. */
export function hashLeaf(cid: string): Hex {
  return keccak256(toBytes(cid));
}

function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concat([left, right]));
}

/**
 * Compute the merkle root over `leaves` (already-hashed 32-byte nodes, in
 * insertion order). Throws on an empty leaf set.
 */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) {
    throw new Error('merkleRoot: cannot build a tree over zero leaves (a batch must have ≥1 member)');
  }
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left; // duplicate last on odd
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Build an inclusion proof for `index` over `leaves`. Siblings are recorded
 * bottom-up; at each level the sibling is the node paired with the current node
 * (its own duplicate when it is the odd last node). Throws on out-of-range index.
 */
export function merkleProof(leaves: Hex[], index: number): MerkleProof {
  if (leaves.length === 0) {
    throw new Error('merkleProof: cannot prove over zero leaves');
  }
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`merkleProof: index ${index} out of range [0, ${leaves.length})`);
  }
  const siblings: Hex[] = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    // On an odd level the odd last node's sibling is itself (duplicate rule).
    const sibling = siblingIdx < level.length ? level[siblingIdx]! : level[idx]!;
    siblings.push(sibling);

    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(hashPair(left, right));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { index, siblings };
}

/**
 * Verify that `leafCid` is included under `root` via `proof`. Recomputes the
 * leaf via `hashLeaf`, folds siblings by index parity, compares to `root`
 * (case-insensitive hex compare). Pure — no chain read.
 */
export function verifyMerkleProof(leafCid: string, proof: MerkleProof, root: Hex): boolean {
  let node = hashLeaf(leafCid);
  let idx = proof.index;
  for (const sibling of proof.siblings) {
    node = idx % 2 === 1 ? hashPair(sibling, node) : hashPair(node, sibling);
    idx = Math.floor(idx / 2);
  }
  return node.toLowerCase() === root.toLowerCase();
}
