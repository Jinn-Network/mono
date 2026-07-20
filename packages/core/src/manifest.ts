/**
 * Client-independent manifest commitment primitives.
 *
 * Both the ERC-8004 consumer and the harness-layer batch publisher use this
 * module so the body schema and merkle construction cannot drift across the
 * frozen package boundary.
 */

import { z } from 'zod';
import {
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Hex,
} from 'viem';

export const MANIFEST_SCHEMA_VERSION = 'jinn.manifest.v0' as const;

const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ManifestMemberSchema = z.strictObject({
  cid: z.string().min(1),
  sha256: Sha256Schema,
  polarity: z.enum(['pass', 'fail']).optional(),
  instanceId: z.string().min(1).optional(),
});

export const ManifestV0Schema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  batchKind: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  merkleRoot: Bytes32Schema,
  members: z.array(ManifestMemberSchema).min(1),
});

export type ManifestMember = z.infer<typeof ManifestMemberSchema>;
export type ManifestV0 = z.infer<typeof ManifestV0Schema>;

export function parseManifestV0(input: unknown): ManifestV0 {
  return ManifestV0Schema.parse(input);
}

export interface MerkleProof {
  index: number;
  siblings: Hex[];
}

export function hashLeaf(cid: string): Hex {
  return keccak256(toBytes(cid));
}

function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concat([left, right]));
}

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) {
    throw new Error('merkleRoot: cannot build a tree over zero leaves (a batch must have ≥1 member)');
  }
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = index + 1 < level.length ? level[index + 1]! : left;
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0]!;
}

export function merkleProof(leaves: Hex[], index: number): MerkleProof {
  if (leaves.length === 0) {
    throw new Error('merkleProof: cannot prove over zero leaves');
  }
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`merkleProof: index ${index} out of range [0, ${leaves.length})`);
  }
  const siblings: Hex[] = [];
  let level = leaves;
  let currentIndex = index;
  while (level.length > 1) {
    const siblingIndex =
      currentIndex % 2 === 1 ? currentIndex - 1 : currentIndex + 1;
    siblings.push(
      siblingIndex < level.length ? level[siblingIndex]! : level[currentIndex]!,
    );

    const next: Hex[] = [];
    for (let levelIndex = 0; levelIndex < level.length; levelIndex += 2) {
      const left = level[levelIndex]!;
      const right =
        levelIndex + 1 < level.length ? level[levelIndex + 1]! : left;
      next.push(hashPair(left, right));
    }
    level = next;
    currentIndex = Math.floor(currentIndex / 2);
  }
  return { index, siblings };
}

export function verifyMerkleProof(
  leafCid: string,
  proof: MerkleProof,
  root: Hex,
): boolean {
  const isHash = (value: unknown): value is Hex =>
    typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
  if (
    !Number.isSafeInteger(proof.index) ||
    proof.index < 0 ||
    !isHash(root) ||
    !Array.isArray(proof.siblings) ||
    !proof.siblings.every(isHash)
  ) {
    return false;
  }

  let node = hashLeaf(leafCid);
  let currentIndex = proof.index;
  for (const sibling of proof.siblings) {
    node =
      currentIndex % 2 === 1
        ? hashPair(sibling, node)
        : hashPair(node, sibling);
    currentIndex = Math.floor(currentIndex / 2);
  }
  return currentIndex === 0 && node.toLowerCase() === root.toLowerCase();
}

export const MANIFEST_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint16' },
  { name: 'merkleRoot', type: 'bytes32' },
  { name: 'memberCount', type: 'uint32' },
  { name: 'createdAt', type: 'uint64' },
] as const;

export interface ManifestPayload {
  version: 0;
  merkleRoot: Hex;
  memberCount: number;
  createdAt: number;
}

export class ManifestPayloadValidationError extends Error {
  constructor(reason: string) {
    super(`manifest payload validation failed: ${reason}`);
    this.name = 'ManifestPayloadValidationError';
  }
}

const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function validateManifestPayload(
  payload: ManifestPayload,
): ManifestPayload {
  if (payload.version !== 0) {
    throw new ManifestPayloadValidationError(
      `version must be 0, got ${payload.version}`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.merkleRoot)) {
    throw new ManifestPayloadValidationError(
      'merkleRoot must be 32-byte hex (0x + 64 hex chars)',
    );
  }
  if (!Number.isInteger(payload.memberCount) || payload.memberCount < 1) {
    throw new ManifestPayloadValidationError(
      `memberCount must be a positive integer (≥1); got ${payload.memberCount}`,
    );
  }
  if (payload.memberCount > MAX_UINT32) {
    throw new ManifestPayloadValidationError(
      `memberCount exceeds uint32 range; got ${payload.memberCount}`,
    );
  }
  if (!Number.isSafeInteger(payload.createdAt) || payload.createdAt < 0) {
    throw new ManifestPayloadValidationError(
      `createdAt must be a non-negative safe integer; got ${payload.createdAt}`,
    );
  }
  if (BigInt(payload.createdAt) > MAX_UINT64) {
    throw new ManifestPayloadValidationError(
      `createdAt exceeds uint64 range; got ${payload.createdAt}`,
    );
  }
  return payload;
}

export function encodeManifestPayload(payload: ManifestPayload): Hex {
  validateManifestPayload(payload);
  return encodeAbiParameters(MANIFEST_PAYLOAD_TUPLE, [
    payload.version,
    payload.merkleRoot,
    payload.memberCount,
    BigInt(payload.createdAt),
  ]);
}

export function decodeManifestPayload(hex: Hex): ManifestPayload {
  const [version, merkleRoot, memberCount, createdAt] = decodeAbiParameters(
    MANIFEST_PAYLOAD_TUPLE,
    hex,
  );
  if (createdAt > MAX_SAFE_INTEGER_BIGINT) {
    throw new ManifestPayloadValidationError(
      `createdAt cannot be represented exactly as a JavaScript number; got ${createdAt}`,
    );
  }
  return validateManifestPayload({
    version: version as 0,
    merkleRoot,
    memberCount: Number(memberCount),
    createdAt: Number(createdAt),
  });
}

export const MANIFEST_METADATA_KEY_PREFIX = 'manifest:';

export function buildManifestMetadataKey(manifestCid: string): string {
  if (typeof manifestCid !== 'string' || manifestCid.length === 0) {
    throw new ManifestPayloadValidationError(
      'manifestCid must be a non-empty string',
    );
  }
  return `${MANIFEST_METADATA_KEY_PREFIX}${manifestCid}`;
}

export function parseManifestMetadataKey(
  key: string,
): { manifestCid: string } | null {
  if (
    typeof key !== 'string' ||
    !key.startsWith(MANIFEST_METADATA_KEY_PREFIX)
  ) {
    return null;
  }
  const manifestCid = key.slice(MANIFEST_METADATA_KEY_PREFIX.length);
  return manifestCid.length === 0 ? null : { manifestCid };
}
