import { describe, it, expect } from 'vitest';
import { encodeAbiParameters } from 'viem';
import {
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
} from '../../src/erc8004/abis.js';

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
