import { describe, expect, it } from 'vitest';
import {
  buildIpfsFetchCidPathCandidates,
  buildIpfsHexCidCandidatesFromPartialHex,
  normalizeIpfsGatewayBase,
} from '../../../src/adapters/mech/ipfs.js';

describe('ipfs gateway + CID helpers (jinn-node parity)', () => {
  it('normalizeIpfsGatewayBase handles origin-only, /ipfs suffix, and trailing slashes', () => {
    expect(normalizeIpfsGatewayBase('https://gateway.autonolas.tech')).toBe(
      'https://gateway.autonolas.tech/ipfs/',
    );
    expect(normalizeIpfsGatewayBase('https://gateway.autonolas.tech/ipfs')).toBe(
      'https://gateway.autonolas.tech/ipfs/',
    );
    expect(normalizeIpfsGatewayBase('https://gateway.autonolas.tech/ipfs/')).toBe(
      'https://gateway.autonolas.tech/ipfs/',
    );
  });

  it('buildIpfsHexCidCandidatesFromPartialHex returns raw then dag-pb for 32-byte digest', () => {
    const d = 'a'.repeat(64);
    expect(buildIpfsHexCidCandidatesFromPartialHex(d)).toEqual([
      `f01551220${d}`,
      `f01701220${d}`,
    ]);
  });

  it('buildIpfsFetchCidPathCandidates expands f015 full hex to both codecs', () => {
    const d = 'b'.repeat(64);
    const f015 = `f01551220${d}`;
    expect(buildIpfsFetchCidPathCandidates(f015)).toEqual([`f01551220${d}`, `f01701220${d}`]);
  });

  it('buildIpfsFetchCidPathCandidates passes through base32 CIDs unchanged', () => {
    const bafy =
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(buildIpfsFetchCidPathCandidates(bafy)).toEqual([bafy]);
  });
});
