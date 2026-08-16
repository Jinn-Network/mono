import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pinFileToIpfs } from '../../../src/adapters/mech/ipfs-pinfile.js';

describe('pinFileToIpfs (1pbc)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('POSTs the file to <registry>/api/v0/add?pin=true&cid-version=1 and returns the CID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pinfile-'));
    dirs.push(dir);
    const tarballPath = join(dir, 'pkg-0.1.0.tgz');
    writeFileSync(tarballPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]));

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        '{"Name":"pkg-0.1.0.tgz","Hash":"bafyTarballCidExample","Size":"6"}\n',
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const cid = await pinFileToIpfs('https://registry.autonolas.tech', tarballPath);
    expect(cid).toBe('bafyTarballCidExample');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('/api/v0/add');
    expect(String(calledUrl)).toContain('pin=true');
    expect(String(calledUrl)).toContain('cid-version=1');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('throws when the registry returns non-200', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pinfile-'));
    dirs.push(dir);
    const tarballPath = join(dir, 'pkg.tgz');
    writeFileSync(tarballPath, Buffer.from([0x00]));

    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 502 })));

    await expect(pinFileToIpfs('https://registry.autonolas.tech', tarballPath)).rejects.toThrow(
      /502/,
    );
  });

  it('throws when the response lacks a Hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pinfile-'));
    dirs.push(dir);
    const tarballPath = join(dir, 'pkg.tgz');
    writeFileSync(tarballPath, Buffer.from([0x00]));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"Name":"pkg.tgz","Size":"1"}\n', { status: 200 }),
    ));

    await expect(pinFileToIpfs('https://registry.autonolas.tech', tarballPath)).rejects.toThrow(
      /did not return a CID/i,
    );
  });
});
