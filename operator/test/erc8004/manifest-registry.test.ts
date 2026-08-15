import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, encodeAbiParameters, type Hex } from 'viem';
import { MANIFEST_PAYLOAD_TUPLE } from '../../src/erc8004/abis.js';
import {
  ManifestPayloadValidationError,
  buildManifestMetadataKey,
  decodeManifestPayload,
  encodeManifestPayload,
  parseManifestMetadataKey,
  validateManifestPayload,
  type ManifestPayload,
} from '../../src/erc8004/manifest-registry.js';

const ROOT = ('0x' + 'ab'.repeat(32)) as Hex;

function payload(over: Partial<ManifestPayload> = {}): ManifestPayload {
  return { version: 0, merkleRoot: ROOT, memberCount: 7, createdAt: 1_700_000_000, ...over };
}

describe('buildManifestMetadataKey', () => {
  it('builds manifest:<cid>', () => {
    expect(buildManifestMetadataKey('bafyManifest')).toBe('manifest:bafyManifest');
  });
  it('throws on empty cid', () => {
    expect(() => buildManifestMetadataKey('')).toThrow(ManifestPayloadValidationError);
  });
});

describe('parseManifestMetadataKey', () => {
  it('parses a manifest: key', () => {
    expect(parseManifestMetadataKey('manifest:bafyX')).toEqual({ manifestCid: 'bafyX' });
  });
  it('returns null for a non-manifest key', () => {
    expect(parseManifestMetadataKey('capture:bafyX')).toBeNull();
    expect(parseManifestMetadataKey('manifest:')).toBeNull();
  });
});

describe('encode/decode round-trip', () => {
  it('round-trips every field exactly', () => {
    const p = payload({ memberCount: 7, createdAt: 1_700_000_123 });
    const decoded = decodeManifestPayload(encodeManifestPayload(p));
    expect(decoded).toEqual(p);
  });

  it('encodes against MANIFEST_PAYLOAD_TUPLE', () => {
    const p = payload();
    const raw = encodeAbiParameters(MANIFEST_PAYLOAD_TUPLE, [
      p.version,
      p.merkleRoot,
      p.memberCount,
      BigInt(p.createdAt),
    ]);
    expect(encodeManifestPayload(p)).toBe(raw);
    const back = decodeAbiParameters(MANIFEST_PAYLOAD_TUPLE, raw);
    expect(back[1]).toBe(p.merkleRoot);
  });
});

describe('validateManifestPayload', () => {
  it('rejects a bad root length', () => {
    expect(() => validateManifestPayload(payload({ merkleRoot: '0xabcd' as Hex }))).toThrow(
      ManifestPayloadValidationError,
    );
  });
  it('rejects memberCount = 0', () => {
    expect(() => validateManifestPayload(payload({ memberCount: 0 }))).toThrow(
      ManifestPayloadValidationError,
    );
  });
  it('rejects memberCount over uint32', () => {
    expect(() => validateManifestPayload(payload({ memberCount: 0xffff_ffff + 1 }))).toThrow(
      ManifestPayloadValidationError,
    );
  });
  it('rejects negative createdAt', () => {
    expect(() => validateManifestPayload(payload({ createdAt: -1 }))).toThrow(
      ManifestPayloadValidationError,
    );
  });
  it('rejects a createdAt value that cannot be represented exactly as a number', () => {
    expect(() =>
      validateManifestPayload(payload({ createdAt: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow(ManifestPayloadValidationError);
  });
  it('rejects an encoded uint64 createdAt that would lose precision when decoded', () => {
    const encoded = encodeAbiParameters(MANIFEST_PAYLOAD_TUPLE, [
      0,
      ROOT,
      1,
      0xffff_ffff_ffff_ffffn,
    ]);
    expect(() => decodeManifestPayload(encoded)).toThrow(ManifestPayloadValidationError);
  });
  it('rejects a non-zero version', () => {
    expect(() => validateManifestPayload(payload({ version: 1 as unknown as 0 }))).toThrow(
      ManifestPayloadValidationError,
    );
  });
});
