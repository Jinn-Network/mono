#!/usr/bin/env node

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export function signManifest(payloadBytes, privateKeyPem, keyId) {
  const payload = Buffer.from(payloadBytes);
  const signature = sign(null, preAuthenticationEncoding(PAYLOAD_TYPE, payload), createPrivateKey(privateKeyPem));
  return {
    payload: payload.toString('base64'),
    payloadType: PAYLOAD_TYPE,
    signatures: [{ keyid: keyId, sig: signature.toString('base64') }],
  };
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const root = args[args.indexOf('--root') + 1];
    if (!args.includes('--root') || !root) throw new Error('--root <profile root directory> is required');
    const privateKeyPem = process.env.JINN_PROFILE_MANIFEST_SIGNING_KEY;
    if (!privateKeyPem) {
      console.log('no profile-manifest signing key provisioned; wrote no sidecar');
    } else {
      const keyId = process.env.JINN_PROFILE_MANIFEST_KEY_ID;
      if (!keyId) throw new Error('JINN_PROFILE_MANIFEST_KEY_ID is required alongside the signing key');
      const payload = readFileSync(join(root, 'manifest.json'));
      const envelope = signManifest(payload, privateKeyPem, keyId);
      writeFileSync(join(root, 'manifest.dsse.json'), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      console.log(`signed manifest.json with key ${keyId}`);
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
