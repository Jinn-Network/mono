import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIpfsFetchCidPathCandidates,
  buildIpfsHexCidCandidatesFromPartialHex,
  normalizeIpfsGatewayBase,
  normalizeIpfsRegistryAddUrl,
  uploadToIpfs,
} from '../../../src/adapters/mech/ipfs.js';

describe('ipfs gateway + CID helpers (jinn-node parity)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('normalizeIpfsRegistryAddUrl handles origin-only and full add endpoint URLs', () => {
    expect(normalizeIpfsRegistryAddUrl('https://registry.autonolas.tech')).toBe(
      'https://registry.autonolas.tech/api/v0/add',
    );
    expect(normalizeIpfsRegistryAddUrl('https://registry.autonolas.tech/api/v0/add')).toBe(
      'https://registry.autonolas.tech/api/v0/add',
    );
  });

  it('uploadToIpfs posts JSON to the configured registry and returns the last Hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        [
          JSON.stringify({ Name: 'content.json', Hash: 'bafyfirst' }),
          JSON.stringify({ Name: '', Hash: 'bafylast' }),
        ].join('\n'),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadToIpfs('https://registry.example', { ok: true })).resolves.toBe('bafylast');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://registry.example/api/v0/add?pin=true&cid-version=1&wrap-with-directory=false',
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('uploadToIpfs rejects registry responses without a CID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    await expect(uploadToIpfs('https://registry.example', { ok: true })).rejects.toThrow(
      'IPFS registry upload did not return a CID',
    );
  });
});
