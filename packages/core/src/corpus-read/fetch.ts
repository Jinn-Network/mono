/**
 * Fetch a manifest envelope from IPFS by CID and parse it under the v1 schema.
 *
 * Spec §2.3 step 2.
 */

import { fetchFromIpfs } from './ipfs.js';
import type { CorpusManifest, EnvelopeRef, ManifestPreview } from './types.js';
import { ManifestFetchError } from './types.js';

type FetchFromIpfs = (gatewayUrl: string, cid: string) => Promise<unknown>;

export async function fetchManifest<TEnvelope extends CorpusManifest>(
  ref: EnvelopeRef,
  ipfsGatewayUrl: string,
  ports: {
    fetchFromIpfs?: FetchFromIpfs;
    parseEnvelope(input: unknown): TEnvelope;
  },
): Promise<ManifestPreview<TEnvelope>> {
  let raw: unknown;
  try {
    raw = await (ports.fetchFromIpfs ?? fetchFromIpfs)(ipfsGatewayUrl, ref.manifestCid);
  } catch (err) {
    throw new ManifestFetchError(ref.manifestCid, 'IPFS fetch failed', err);
  }
  let envelope: TEnvelope;
  try {
    envelope = ports.parseEnvelope(raw);
  } catch (error) {
    throw new ManifestFetchError(
      ref.manifestCid,
      `schema parse failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  return { ref, envelope };
}
