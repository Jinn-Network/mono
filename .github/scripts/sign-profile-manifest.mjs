#!/usr/bin/env node

import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAYLOAD_TYPE, preAuthenticationEncoding } from './dsse.mjs';

export { PAYLOAD_TYPE, preAuthenticationEncoding, verifyEnvelope } from './dsse.mjs';
export const SIGNATURE_FILE_NAME = 'manifest.dsse.json';

export function signManifest(payloadBytes, privateKeyPem, keyId) {
  const payload = Buffer.from(payloadBytes);
  const signature = sign(null, preAuthenticationEncoding(PAYLOAD_TYPE, payload), createPrivateKey(privateKeyPem));
  return {
    payload: payload.toString('base64'),
    payloadType: PAYLOAD_TYPE,
    signatures: [{ keyid: keyId, sig: signature.toString('base64') }],
  };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
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
      writeFileSync(join(root, SIGNATURE_FILE_NAME), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      console.log(`signed manifest.json with key ${keyId}`);
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
