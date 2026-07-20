import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertRawSha256CidMatches } from '../src/ipfs-cid.js';

describe('assertRawSha256CidMatches', () => {
  it('accepts Kubo base32 and base16 raw CIDs for the exact body bytes', () => {
    const empty = new Uint8Array();
    const emptyRawCid =
      'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
    expect(() => assertRawSha256CidMatches(emptyRawCid, empty)).not.toThrow();

    const body = new TextEncoder().encode('canonical manifest bytes');
    const digest = createHash('sha256').update(body).digest('hex');
    expect(() =>
      assertRawSha256CidMatches(`f01551220${digest}`, body),
    ).not.toThrow();
  });

  it('rejects dag-pb, malformed multihashes, and body digest mismatches', () => {
    const body = new TextEncoder().encode('canonical manifest bytes');
    const digest = createHash('sha256').update(body).digest('hex');

    expect(() =>
      assertRawSha256CidMatches(`f01701220${digest}`, body),
    ).toThrow(/raw codec/i);
    expect(() =>
      assertRawSha256CidMatches(`f0155121f${digest.slice(0, 62)}`, body),
    ).toThrow(/sha2-256/i);
    expect(() =>
      assertRawSha256CidMatches(`f01551220${'0'.repeat(64)}`, body),
    ).toThrow(/digest/i);
  });
});
