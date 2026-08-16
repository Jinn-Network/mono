import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type Hex } from 'viem';
import {
  ManifestAnchorNotFoundError,
  ManifestContentAddressMismatchError,
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
import { canonicalJson } from '../../src/util/canonical-json.js';
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

function cidFor(body: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return `f01551220${digest}`;
}

function cidV0AliasFor(body: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(body)).digest();
  const multihash = Uint8Array.from([0x12, 0x20, ...digest]);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const byte of multihash) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index]! << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return digits.reverse().map((digit) => alphabet[digit]).join('');
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
    const body = manifest();
    const manifestCid = cidFor(body);
    const ports = deps(body);
    const fetched = await fetchManifest(manifestCid, ports);

    expect(fetched).toEqual(body);
    expect(enumerateMembers(fetched).map((member) => member.cid)).toEqual(CIDS);
    expect(ports.getMetadata).toHaveBeenCalledWith(
      42n,
      `manifest:${manifestCid}`,
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
    const body = manifest();
    await expect(
      fetchManifest(cidFor(body), deps(body, anchor({ merkleRoot: otherRoot }))),
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
      fetchManifest(cidFor(tampered), deps(tampered)),
    ).rejects.toBeInstanceOf(ManifestRootMismatchError);
  });

  it('rejects an anchored member count that differs from the body', async () => {
    const body = manifest();
    await expect(
      fetchManifest(cidFor(body), deps(body, anchor({ memberCount: 4 }))),
    ).rejects.toThrow(/member count/);
  });

  it('rejects an anchored creation time that differs from the body', async () => {
    const body = manifest();
    await expect(
      fetchManifest(
        cidFor(body),
        deps(body, anchor({ createdAt: CREATED_AT + 1 })),
      ),
    ).rejects.toThrow(/createdAt/);
  });

  it('returns null for a missing anchor and fetch fails closed', async () => {
    const body = manifest();
    const manifestCid = cidFor(body);
    const ports = deps(body, null);
    await expect(
      readManifestAnchor(manifestCid, ports),
    ).resolves.toBeNull();
    await expect(
      fetchManifest(manifestCid, ports),
    ).rejects.toBeInstanceOf(ManifestAnchorNotFoundError);
  });

  it('rejects substituted manifest fields even when the member root is unchanged', async () => {
    const original = manifest();
    const substituted = manifest({
      batchKind: 'substituted',
      members: original.members.map((member, index) =>
        index === 0
          ? { ...member, sha256: 'f'.repeat(64), polarity: 'fail' as const }
          : member,
      ),
    });

    await expect(
      fetchManifest(cidFor(original), deps(substituted)),
    ).rejects.toBeInstanceOf(ManifestContentAddressMismatchError);
  });

  it('rejects a CIDv0 digest alias before trusting its metadata namespace', async () => {
    const body = manifest();
    const ports = deps(body);

    await expect(
      fetchManifest(cidV0AliasFor(body), ports),
    ).rejects.toBeInstanceOf(ManifestContentAddressMismatchError);
    expect(ports.ipfsGet).not.toHaveBeenCalled();
    expect(ports.getMetadata).not.toHaveBeenCalled();
  });
});
