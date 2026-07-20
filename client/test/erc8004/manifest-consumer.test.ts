import { describe, expect, it, vi } from 'vitest';
import { type Hex } from 'viem';
import {
  ManifestAnchorNotFoundError,
  ManifestRootMismatchError,
  enumerateMembers,
  fetchManifest,
  proveMember,
  readManifestAnchor,
  verifyMember,
} from '../../src/erc8004/manifest-consumer.js';
import {
  encodeManifestPayload,
  type ManifestPayload,
} from '../../src/erc8004/manifest-registry.js';
import { hashLeaf, merkleRoot } from '../../src/erc8004/merkle.js';
import type { ManifestV0 } from '../../src/types/manifest.js';

const CIDS = ['bafy-member-a', 'bafy-member-b', 'bafy-member-c'];
const ROOT = merkleRoot(CIDS.map(hashLeaf));
const CREATED_AT = 1_700_000_000;

function manifest(overrides: Partial<ManifestV0> = {}): ManifestV0 {
  return {
    schemaVersion: 'jinn.manifest.v0',
    batchKind: 'bridge',
    createdAt: CREATED_AT,
    merkleRoot: ROOT,
    members: CIDS.map((cid, index) => ({
      cid,
      sha256: String(index + 1).repeat(64),
      polarity: index === 0 ? 'pass' : 'fail',
    })),
    ...overrides,
  };
}

function anchor(overrides: Partial<ManifestPayload> = {}): Hex {
  return encodeManifestPayload({
    version: 0,
    merkleRoot: ROOT,
    memberCount: CIDS.length,
    createdAt: CREATED_AT,
    ...overrides,
  });
}

function deps(body: unknown = manifest(), anchored: Hex | null = anchor()) {
  return {
    agentId: 42n,
    ipfsGet: vi.fn().mockResolvedValue(JSON.stringify(body)),
    getMetadata: vi.fn().mockResolvedValue(anchored),
  };
}

describe('manifest consumer', () => {
  it('fetches, validates against the on-chain commitment, and enumerates in order', async () => {
    const ports = deps();
    const fetched = await fetchManifest('bafy-manifest', ports);

    expect(fetched).toEqual(manifest());
    expect(enumerateMembers(fetched).map((member) => member.cid)).toEqual(CIDS);
    expect(ports.getMetadata).toHaveBeenCalledWith(
      42n,
      'manifest:bafy-manifest',
    );
  });

  it('proves every member against the anchored root and rejects another CID', () => {
    const body = manifest();
    for (const cid of CIDS) {
      const { proof, root } = proveMember(body, cid);
      expect(root).toBe(ROOT);
      expect(verifyMember(cid, proof, ROOT)).toBe(true);
      expect(verifyMember('bafy-not-a-member', proof, ROOT)).toBe(false);
    }
    expect(() => proveMember(body, 'bafy-not-a-member')).toThrow(/not present/);
  });

  it('rejects an anchored root that differs from the body and derived roots', async () => {
    const otherRoot = merkleRoot([hashLeaf('other')]);
    await expect(
      fetchManifest('bafy-manifest', deps(manifest(), anchor({ merkleRoot: otherRoot }))),
    ).rejects.toBeInstanceOf(ManifestRootMismatchError);
  });

  it('rejects a body whose member list no longer derives its declared root', async () => {
    const tampered = manifest({
      members: [
        ...manifest().members.slice(0, 2),
        { ...manifest().members[2]!, cid: 'bafy-tampered' },
      ],
    });
    await expect(
      fetchManifest('bafy-manifest', deps(tampered)),
    ).rejects.toBeInstanceOf(ManifestRootMismatchError);
  });

  it('rejects an anchored member count that differs from the body', async () => {
    await expect(
      fetchManifest('bafy-manifest', deps(manifest(), anchor({ memberCount: 4 }))),
    ).rejects.toThrow(/member count/);
  });

  it('rejects an anchored creation time that differs from the body', async () => {
    await expect(
      fetchManifest(
        'bafy-manifest',
        deps(manifest(), anchor({ createdAt: CREATED_AT + 1 })),
      ),
    ).rejects.toThrow(/createdAt/);
  });

  it('returns null for a missing anchor and fetch fails closed', async () => {
    const ports = deps(manifest(), null);
    await expect(
      readManifestAnchor('bafy-manifest', ports),
    ).resolves.toBeNull();
    await expect(
      fetchManifest('bafy-manifest', ports),
    ).rejects.toBeInstanceOf(ManifestAnchorNotFoundError);
  });
});
