import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadToIpfs } from '../../../src/adapters/mech/ipfs.js';

describe('uploadToIpfs raw content addressing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests raw leaves when byte-verifiable content addressing is required', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"Hash":"f01551220deadbeef"}\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await uploadToIpfs(
      'https://registry.autonolas.tech',
      { schemaVersion: 'jinn.manifest.v0' },
      { rawLeaves: true },
    );

    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('raw-leaves')).toBe('true');
    expect(calledUrl.searchParams.get('cid-version')).toBe('1');
    expect(calledUrl.searchParams.get('wrap-with-directory')).toBe('false');
  });

  it('preserves the existing upload URL by default', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"Hash":"bafy-default"}\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await uploadToIpfs('https://registry.autonolas.tech', { hello: 'world' });

    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.has('raw-leaves')).toBe(false);
  });
});
