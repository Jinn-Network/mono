/**
 * Binary-file pin helper for the Autonolas IPFS registry (jinn-mono-1pbc).
 *
 * The existing `uploadToIpfs` in `./ipfs.ts` serialises JSON via JCS, which
 * is wrong for binary tarballs (it forces a JSON parse and re-encode round
 * trip). This module is the sibling helper for the `jinn solver-plugins
 * publish` path: take a local tarball, POST it to the registry's
 * `/api/v0/add` endpoint with `pin=true&cid-version=1`, return the CID.
 *
 * Reuses `normalizeIpfsRegistryAddUrl` and `parseRegistryUploadCid` patterns
 * from `./ipfs.ts` for endpoint resolution and response parsing.
 */

import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { normalizeIpfsRegistryAddUrl, parseRegistryUploadCid } from './ipfs.js';

const IPFS_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Upload a local file to the IPFS registry and return its CID.
 *
 * Used by `jinn solver-plugins publish` to pin the packed plug-in tarball
 * before writing the `plugin:<cid>` metadata record on the IdentityRegistry.
 *
 * @param registryUrl operator-configured `ipfsRegistryUrl` (e.g. `https://registry.autonolas.tech`).
 * @param filePath absolute path to the local file (typically `.tgz`).
 */
export async function pinFileToIpfs(registryUrl: string, filePath: string): Promise<string> {
  const url = new URL(normalizeIpfsRegistryAddUrl(registryUrl));
  url.searchParams.set('pin', 'true');
  url.searchParams.set('cid-version', '1');
  url.searchParams.set('wrap-with-directory', 'false');

  const stream = createReadStream(filePath);
  const blob = await new Response(Readable.toWeb(stream) as ReadableStream).blob();

  const formData = new FormData();
  formData.append('file', blob, basename(filePath));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IPFS_UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (response.status !== 200) {
      throw new Error(
        `IPFS registry upload failed with status ${response.status}: ${responseText.slice(0, 200)}`,
      );
    }
    return parseRegistryUploadCid(responseText);
  } finally {
    clearTimeout(timer);
  }
}
