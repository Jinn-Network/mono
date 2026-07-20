import {
  fetchManifest as fetchCoreManifest,
  type EnvelopeRef,
} from '@jinn-network/core/corpus-read';
import {
  SignedEnvelopeSchema,
  type SignedEnvelope,
} from '../types/envelope.js';
import type { ManifestPreview } from './types.js';

type FetchFromIpfs = (gatewayUrl: string, cid: string) => Promise<unknown>;

export function fetchManifest(
  ref: EnvelopeRef,
  ipfsGatewayUrl: string,
  fetchFromIpfs?: FetchFromIpfs,
): Promise<ManifestPreview> {
  return fetchCoreManifest<SignedEnvelope>(
    ref,
    ipfsGatewayUrl,
    {
      ...(fetchFromIpfs ? { fetchFromIpfs } : {}),
      parseEnvelope(input) {
        return SignedEnvelopeSchema.parse(input);
      },
    },
  );
}
