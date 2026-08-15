import { createHash } from 'node:crypto';
import type { Hex } from 'viem';
import { rawSha256CidToDigestHex } from '../adapters/mech/ipfs.js';
import { canonicalJson } from '../util/canonical-json.js';
import {
  decodeManifestPayload,
  buildManifestMetadataKey,
} from './manifest-registry.js';
import {
  hashLeaf,
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
  type MerkleProof,
} from './merkle.js';
import {
  parseManifestV0,
  type ManifestMember,
  type ManifestV0,
} from '../types/manifest.js';

export interface ManifestAnchorReadDeps {
  agentId: bigint;
  getMetadata(agentId: bigint, metadataKey: string): Promise<Hex | null>;
}

export interface ManifestFetchDeps extends ManifestAnchorReadDeps {
  ipfsGet(manifestCid: string): Promise<unknown>;
}

export interface ManifestAnchor {
  merkleRoot: Hex;
  memberCount: number;
  createdAt: number;
}

export class ManifestRootMismatchError extends Error {
  constructor(reason: string) {
    super(`manifest commitment mismatch: ${reason}`);
    this.name = 'ManifestRootMismatchError';
  }
}

export class ManifestAnchorNotFoundError extends Error {
  constructor(manifestCid: string) {
    super(`manifest anchor not found: ${manifestCid}`);
    this.name = 'ManifestAnchorNotFoundError';
  }
}

export class ManifestContentAddressMismatchError extends Error {
  constructor(reason: string) {
    super(`manifest content address mismatch: ${reason}`);
    this.name = 'ManifestContentAddressMismatchError';
  }
}

function parseIpfsJson(input: unknown): unknown {
  if (typeof input === 'string') return JSON.parse(input);
  if (input instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(input));
  }
  return input;
}

export async function readManifestAnchor(
  manifestCid: string,
  deps: ManifestAnchorReadDeps,
): Promise<ManifestAnchor | null> {
  const encoded = await deps.getMetadata(
    deps.agentId,
    buildManifestMetadataKey(manifestCid),
  );
  if (encoded === null) return null;
  const payload = decodeManifestPayload(encoded);
  return {
    merkleRoot: payload.merkleRoot,
    memberCount: payload.memberCount,
    createdAt: payload.createdAt,
  };
}

export async function fetchManifest(
  manifestCid: string,
  deps: ManifestFetchDeps,
): Promise<ManifestV0> {
  let addressedDigest: string;
  try {
    addressedDigest = rawSha256CidToDigestHex(manifestCid).toLowerCase();
  } catch (error) {
    throw new ManifestContentAddressMismatchError(
      `cannot decode CID ${manifestCid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parseManifestV0(parseIpfsJson(await deps.ipfsGet(manifestCid)));
  const actualDigest = `0x${createHash('sha256')
    .update(canonicalJson(manifest))
    .digest('hex')}`.toLowerCase();
  if (actualDigest !== addressedDigest) {
    throw new ManifestContentAddressMismatchError(
      `CID digest ${addressedDigest} does not match canonical body digest ${actualDigest}`,
    );
  }
  const derivedRoot = merkleRoot(manifest.members.map((member) => hashLeaf(member.cid)));
  if (derivedRoot.toLowerCase() !== manifest.merkleRoot.toLowerCase()) {
    throw new ManifestRootMismatchError(
      `body root ${manifest.merkleRoot} does not match members-derived root ${derivedRoot}`,
    );
  }

  const anchor = await readManifestAnchor(manifestCid, deps);
  if (anchor === null) throw new ManifestAnchorNotFoundError(manifestCid);
  if (anchor.merkleRoot.toLowerCase() !== manifest.merkleRoot.toLowerCase()) {
    throw new ManifestRootMismatchError(
      `anchored root ${anchor.merkleRoot} does not match body root ${manifest.merkleRoot}`,
    );
  }
  if (anchor.memberCount !== manifest.members.length) {
    throw new ManifestRootMismatchError(
      `anchored member count ${anchor.memberCount} does not match body member count ${manifest.members.length}`,
    );
  }
  if (anchor.createdAt !== manifest.createdAt) {
    throw new ManifestRootMismatchError(
      `anchored createdAt ${anchor.createdAt} does not match body createdAt ${manifest.createdAt}`,
    );
  }
  return manifest;
}

export function enumerateMembers(manifest: ManifestV0): ManifestMember[] {
  return [...manifest.members];
}

export function proveMember(
  manifest: ManifestV0,
  memberCid: string,
): { proof: MerkleProof; root: Hex } {
  const leaves = manifest.members.map((member) => hashLeaf(member.cid));
  const root = merkleRoot(leaves);
  if (root.toLowerCase() !== manifest.merkleRoot.toLowerCase()) {
    throw new ManifestRootMismatchError(
      `body root ${manifest.merkleRoot} does not match members-derived root ${root}`,
    );
  }
  const index = manifest.members.findIndex((member) => member.cid === memberCid);
  if (index < 0) {
    throw new Error(`manifest member not present: ${memberCid}`);
  }
  return { proof: merkleProof(leaves, index), root };
}

export function verifyMember(
  memberCid: string,
  proof: MerkleProof,
  anchoredRoot: Hex,
): boolean {
  return verifyMerkleProof(memberCid, proof, anchoredRoot);
}
