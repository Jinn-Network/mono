import { describe, it, expect } from 'vitest';
import { encodeAbiParameters } from 'viem';
import {
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
} from '../../src/erc8004/abis.js';
import {
  buildPluginMetadataKey,
  encodePluginPayload,
  encodeRevocationPayload,
  validatePluginPayload,
  validateRevocationPayload,
  type PluginPayload,
  type RevocationPayload,
  PluginPayloadValidationError,
} from '../../src/erc8004/plugin-registry.js';

const VALID_PLUGIN_PAYLOAD: PluginPayload = {
  version: 1,
  pluginName: '@builder/swe-skill',
  pluginVersion: '0.1.0',
  pluginSha256: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  supports: ['swe-rebench-v2.v1'],
  publishedAt: 1_715_700_000,
};

describe('PLUGIN_PAYLOAD_TUPLE (1pbc)', () => {
  it('matches the spec §5.2 layout: version,name,version,sha256,supports[],publishedAt', () => {
    const fields = PLUGIN_PAYLOAD_TUPLE.map((f) => `${f.name}:${f.type}`);
    expect(fields).toEqual([
      'version:uint8',
      'pluginName:string',
      'pluginVersion:string',
      'pluginSha256:bytes32',
      'supports:string[]',
      'publishedAt:uint64',
    ]);
  });

  it('encodes a minimal payload without throwing', () => {
    const encoded = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
      1,
      '@builder/swe-skill',
      '0.1.0',
      '0x' + 'ab'.repeat(32) as `0x${string}`,
      ['swe-rebench-v2.v1'],
      1_715_700_000n,
    ]);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/);
    expect(encoded.length).toBeGreaterThan(2);
  });
});

describe('REVOCATION_PAYLOAD_TUPLE (1pbc)', () => {
  it('matches the spec §5.2 revoked-marker layout: version,revoked,reason', () => {
    const fields = REVOCATION_PAYLOAD_TUPLE.map((f) => `${f.name}:${f.type}`);
    expect(fields).toEqual([
      'version:uint8',
      'revoked:bool',
      'reason:string',
    ]);
  });
});

describe('encodePluginPayload (1pbc)', () => {
  it('encodes a valid payload to non-empty hex', () => {
    const encoded = encodePluginPayload(VALID_PLUGIN_PAYLOAD);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/);
  });

  it('round-trips: encode then decode yields the same payload', async () => {
    const { decodeAbiParameters } = await import('viem');
    const encoded = encodePluginPayload(VALID_PLUGIN_PAYLOAD);
    const decoded = decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe('@builder/swe-skill');
    expect(decoded[2]).toBe('0.1.0');
    expect(decoded[3]).toBe(('0x' + 'ab'.repeat(32)).toLowerCase());
    expect(decoded[4]).toEqual(['swe-rebench-v2.v1']);
    expect(decoded[5]).toBe(1_715_700_000n);
  });
});

describe('validatePluginPayload (1pbc)', () => {
  it('accepts the canonical valid payload', () => {
    expect(() => validatePluginPayload(VALID_PLUGIN_PAYLOAD)).not.toThrow();
  });

  it('rejects version != 1', () => {
    expect(() =>
      validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, version: 2 as unknown as 1 }),
    ).toThrow(PluginPayloadValidationError);
  });

  it('rejects empty pluginName', () => {
    expect(() => validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, pluginName: '' })).toThrow(
      /pluginName/i,
    );
  });

  it('rejects empty pluginVersion', () => {
    expect(() => validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, pluginVersion: '' })).toThrow(
      /pluginVersion/i,
    );
  });

  it('rejects malformed pluginSha256 (not 32-byte hex)', () => {
    expect(() =>
      validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, pluginSha256: '0xdead' as `0x${string}` }),
    ).toThrow(/pluginSha256/i);
  });

  it('rejects empty supports array', () => {
    expect(() => validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, supports: [] })).toThrow(
      /supports/i,
    );
  });

  it('rejects publishedAt outside uint64 range', () => {
    expect(() =>
      validatePluginPayload({ ...VALID_PLUGIN_PAYLOAD, publishedAt: -1 }),
    ).toThrow(/publishedAt/i);
  });
});

describe('encodeRevocationPayload + validateRevocationPayload (1pbc)', () => {
  const REV: RevocationPayload = { version: 2, revoked: true, reason: 'security advisory' };

  it('accepts the canonical revoked marker', () => {
    expect(() => validateRevocationPayload(REV)).not.toThrow();
  });

  it('rejects version != 2', () => {
    expect(() =>
      validateRevocationPayload({ ...REV, version: 1 as unknown as 2 }),
    ).toThrow(PluginPayloadValidationError);
  });

  it('rejects revoked=false (revocation payloads must mark revoked)', () => {
    expect(() => validateRevocationPayload({ ...REV, revoked: false })).toThrow(/revoked/i);
  });

  it('rejects empty reason', () => {
    expect(() => validateRevocationPayload({ ...REV, reason: '' })).toThrow(/reason/i);
  });

  it('encodes and round-trips', async () => {
    const { decodeAbiParameters } = await import('viem');
    const encoded = encodeRevocationPayload(REV);
    const decoded = decodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(2);
    expect(decoded[1]).toBe(true);
    expect(decoded[2]).toBe('security advisory');
  });
});

describe('buildPluginMetadataKey (1pbc)', () => {
  it('builds "plugin:<cid>" — never strips, never normalises', () => {
    expect(buildPluginMetadataKey('bafy123')).toBe('plugin:bafy123');
  });

  it('rejects empty CID', () => {
    expect(() => buildPluginMetadataKey('')).toThrow(/cid/i);
  });
});
