import type { AnnouncementEntry } from "@jinn-network/record-discovery-protocol";
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  dssePreAuthEncoding,
  sealJson,
} from "@jinn-network/record-discovery-protocol";

import type { DsseEnvelope } from "./head.js";
import type { DsseSigner } from "./ports.js";

/** A signer explicitly bound to Record Discovery announcement scope. */
export interface ScopedDiscoverySigner extends DsseSigner {
  readonly scope: typeof DISCOVERY_SIGNING_SCOPE;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Signs the exact sealed Announcement Entry bytes under the protocol entry
 * media type. This is the generic home of the byte-identical operation that
 * marketplace projection previously implemented locally.
 */
export async function signAnnouncementEntry(
  entry: AnnouncementEntry,
  signer: ScopedDiscoverySigner,
): Promise<DsseEnvelope> {
  if (signer.scope !== DISCOVERY_SIGNING_SCOPE) {
    throw new Error(
      `announcement signer must be bound to DISCOVERY_SIGNING_SCOPE "${DISCOVERY_SIGNING_SCOPE}"`,
    );
  }

  const { bytes } = sealJson(entry);
  const signatures = await signer.sign(dssePreAuthEncoding(MEDIA_ENTRY, bytes));
  return {
    payloadType: MEDIA_ENTRY,
    payload: encodeBase64(bytes),
    signatures: signatures.map((signature) => ({
      ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
      sig: encodeBase64(signature.sig),
    })),
  };
}
