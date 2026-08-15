import { describe, expect, it } from 'vitest';
import {
  MANIFEST_SCHEMA_VERSION,
  ManifestV0Schema,
  parseManifestV0,
} from '../../src/types/manifest.js';

const ROOT = `0x${'ab'.repeat(32)}`;
const SHA256 = 'cd'.repeat(32);

function validManifest() {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    batchKind: 'bridge',
    createdAt: 1_700_000_000,
    merkleRoot: ROOT,
    members: [
      {
        cid: 'bafy-member-1',
        sha256: SHA256,
        polarity: 'pass',
        instanceId: 'Jinn-Network__mono-1829',
      },
    ],
  };
}

describe('ManifestV0Schema', () => {
  it('parses a valid enumerable manifest body', () => {
    expect(parseManifestV0(validManifest())).toEqual(validManifest());
  });

  it('rejects a wrong schema version', () => {
    expect(() =>
      ManifestV0Schema.parse({
        ...validManifest(),
        schemaVersion: 'jinn.manifest.v1',
      }),
    ).toThrow();
  });

  it('rejects an empty member list', () => {
    expect(() =>
      ManifestV0Schema.parse({ ...validManifest(), members: [] }),
    ).toThrow();
  });

  it('requires each member CID while allowing optional discovery hints to be absent', () => {
    const withoutHints = validManifest();
    withoutHints.members = [{ cid: 'bafy-member-1', sha256: SHA256 }];
    expect(parseManifestV0(withoutHints).members[0]).toEqual({
      cid: 'bafy-member-1',
      sha256: SHA256,
    });

    expect(() =>
      ManifestV0Schema.parse({
        ...validManifest(),
        members: [{ sha256: SHA256 }],
      }),
    ).toThrow();
  });
});
