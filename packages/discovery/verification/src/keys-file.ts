// SPDX-License-Identifier: Apache-2.0

import { createPublicKey } from "node:crypto";

import type { DsseVerificationKey } from "./dsse.js";
import { isRecordObject } from "./record-view.js";
import { describeError } from "./results.js";

/** The file cannot be used. It is the caller's input that is wrong, not a record. */
export class KeysFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysFileError";
  }
}

function keyEntries(value: unknown): readonly { readonly keyId: string; readonly spkiDerBase64: string }[] {
  if (Array.isArray(value)) return value.flatMap(keyEntries);
  if (!isRecordObject(value)) return [];
  const { keyId, spkiDerBase64 } = value;
  const own = typeof keyId === "string" && typeof spkiDerBase64 === "string" ? [{ keyId, spkiDerBase64 }] : [];
  return [...own, ...Object.values(value).flatMap(keyEntries)];
}

/**
 * The verification keys in a JSON document. Every object in it, at any depth, with a string `keyId`
 * and a string `spkiDerBase64` supplies one key, so a list of such objects works and so does a
 * larger file that happens to hold some, like a Colophon bundle's `trust/public-keys.json`.
 *
 * Supplying a key says "check signatures under this id with these bytes". It gives the key no
 * standing: a report says a signature verified against a supplied key, and nothing about who holds it.
 */
export function parseKeysFile(text: string): readonly DsseVerificationKey[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new KeysFileError(`the keys file is not JSON: ${describeError(cause)}`);
  }
  const byKeyId = new Map<string, string>();
  for (const { keyId, spkiDerBase64 } of keyEntries(document)) {
    if (byKeyId.has(keyId) && byKeyId.get(keyId) !== spkiDerBase64) {
      throw new KeysFileError(`the keys file gives key ${keyId} two different values`);
    }
    byKeyId.set(keyId, spkiDerBase64);
  }
  if (byKeyId.size === 0) {
    throw new KeysFileError("the keys file holds no keys: it needs objects with keyId and spkiDerBase64");
  }
  return [...byKeyId].map(([keyId, spkiDerBase64]) => {
    try {
      return { keyId, publicKey: createPublicKey({ key: Buffer.from(spkiDerBase64, "base64"), format: "der", type: "spki" }) };
    } catch (cause) {
      throw new KeysFileError(`key ${keyId} is not an SPKI DER public key: ${describeError(cause)}`);
    }
  });
}
