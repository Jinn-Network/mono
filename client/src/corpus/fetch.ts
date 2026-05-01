/**
 * Fetch a manifest envelope from IPFS by CID and parse it under the v1 schema.
 *
 * Spec §2.3 step 2.
 */

import { SignedEnvelopeSchema, type SignedEnvelope } from '../types/envelope.js';
import { fetchFromIpfs } from '../adapters/mech/ipfs.js';
import type { EnvelopeRef, ManifestPreview } from './types.js';
import { ManifestFetchError } from './types.js';

type FetchFromIpfs = (gatewayUrl: string, cid: string) => Promise<unknown>;

export async function fetchManifest(
  ref: EnvelopeRef,
  ipfsGatewayUrl: string,
  fetchImpl: FetchFromIpfs = fetchFromIpfs,
): Promise<ManifestPreview> {
  let raw: unknown;
  try {
    raw = await fetchImpl(ipfsGatewayUrl, ref.manifestCid);
  } catch (err) {
    throw new ManifestFetchError(ref.manifestCid, 'IPFS fetch failed', err);
  }
  const parsed = SignedEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ManifestFetchError(
      ref.manifestCid,
      `schema parse failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const envelope: SignedEnvelope = parsed.data;
  return { ref, envelope };
}
