// Trust primitives for a signed profile manifest, shared by the script that signs one and
// every script that verifies one: the DSSE pre-authentication encoding, envelope
// verification, and the canonical digest a public key is pinned by. There is one
// definition of each so a signer and a verifier can never disagree about what was signed.

import { createHash, createPublicKey, verify } from 'node:crypto';

export const PAYLOAD_TYPE = 'application/vnd.jinn.profile-manifest+json';

export function preAuthenticationEncoding(payloadType, payload) {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `, 'utf8'),
    typeBytes,
    Buffer.from(` ${payload.length} `, 'utf8'),
    payload,
  ]);
}

export function verifyEnvelope(envelope, publicKeyPem) {
  try {
    const payload = Buffer.from(envelope.payload, 'base64');
    const pae = preAuthenticationEncoding(envelope.payloadType, payload);
    return envelope.signatures.some((signature) => verify(
      null,
      pae,
      createPublicKey(publicKeyPem),
      Buffer.from(signature.sig, 'base64'),
    ));
  } catch {
    return false;
  }
}

/**
 * Canonical SHA-256 of a public key: the key is re-exported as SPKI PEM before
 * digesting, so line endings and trailing whitespace in the published file cannot
 * change the pinned value.
 * @returns {{ sha256: string, pem: string } | { error: string }}
 */
export function canonicalPublicKeySha256(pem) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    return { error: `published public key is not a readable key: ${error?.message ?? String(error)}` };
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    return { error: `published public key must be ed25519, got ${String(key.asymmetricKeyType)}` };
  }
  const canonical = key.export({ type: 'spki', format: 'pem' }).toString();
  return { sha256: createHash('sha256').update(canonical).digest('hex'), pem: canonical };
}
