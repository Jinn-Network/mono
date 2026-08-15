// SPDX-License-Identifier: Apache-2.0

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DsseSigner } from "@jinn-network/trust-core";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./capture/paths.js";

const KEY_FILE = "key.pem";
const KEYID_FILE = "keyid.txt";
export const CAPTURE_SIGNER_DIRECTORY = "capture-signer";
export const LOCAL_CAPTURE_KEYID = "local-capture-dev";

/**
 * Loads or creates an ephemeral Ed25519 signer under `<home>/capture-signer/`.
 *
 * Gate C7 and local Hermes sessions use this host-owned key material. Production
 * custody (HSM, OS keychain, operator-managed rotation) is a residual — the runtime
 * library still never acquires keys on its own (F-C4-T13-2).
 */
export async function loadOrCreateLocalCaptureSigner(homeDirectory: string): Promise<DsseSigner> {
  const signerDir = join(homeDirectory, CAPTURE_SIGNER_DIRECTORY);
  await ensureOwnerOnlyDirectory(signerDir);
  const keyPath = join(signerDir, KEY_FILE);
  const keyidPath = join(signerDir, KEYID_FILE);

  let privateKeyPem: string;
  let keyid: string;

  try {
    privateKeyPem = await readFile(keyPath, "utf8");
    keyid = (await readFile(keyidPath, "utf8")).trim();
  } catch {
    const { privateKey } = generateKeyPairSync("ed25519");
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    keyid = LOCAL_CAPTURE_KEYID;
    await ensureOwnerOnlyFile(keyPath);
    await writeFile(keyPath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
    await ensureOwnerOnlyFile(keyidPath);
    await writeFile(keyidPath, keyid, { encoding: "utf8", mode: 0o600 });
  }

  const privateKey = createPrivateKey(privateKeyPem);
  return async (request) => {
    const signature = sign(null, request.preAuthEncoding, privateKey);
    return [{ signature: new Uint8Array(signature), keyid }];
  };
}
