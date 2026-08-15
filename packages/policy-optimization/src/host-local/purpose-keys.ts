// SPDX-License-Identifier: MIT

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { join } from "node:path";
import { prefixedDigest } from "@jinn-network/policy-identity";
import type { DsseSigner } from "@jinn-network/trust-core";
import { ensurePrivateDirectory, secureAtomicWrite, secureRead } from "./state.js";

export type LiveHostKeyPurpose =
  | "solver-delivery"
  | "evaluator-backend-delivery"
  | "evaluator-verdict"
  | "report-author"
  | "journal-author";

export interface LiveHostPurposeKey {
  readonly purpose: LiveHostKeyPurpose;
  readonly keyId: string;
  readonly identity: string;
  readonly deliverySigningKey: {
    readonly keyId: string;
    sign(payload: Uint8Array): Uint8Array;
  };
  readonly dsseSigner: DsseSigner;
}

function keyIdentity(publicKey: KeyObject): string {
  const bytes = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
  return prefixedDigest(bytes);
}

/** Creates one private Ed25519 key per role and never shares a key object across purposes. */
export function liveHostPurposeKey(stateRoot: string, purpose: LiveHostKeyPurpose): LiveHostPurposeKey {
  const root = ensurePrivateDirectory(join(stateRoot, "keys", purpose));
  const privatePath = join(root, "private.pem");
  const publicPath = join(root, "public.pem");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(Buffer.from(secureRead(privatePath)));
  } catch {
    const generated = generateKeyPairSync("ed25519");
    secureAtomicWrite(privatePath, new Uint8Array(Buffer.from(
      generated.privateKey.export({ format: "pem", type: "pkcs8" }),
    )), true);
    privateKey = generated.privateKey;
  }
  const publicKey = createPublicKey(privateKey);
  secureAtomicWrite(publicPath, new Uint8Array(Buffer.from(
    publicKey.export({ format: "pem", type: "spki" }),
  )), true);
  const digest = keyIdentity(publicKey);
  const keyId = `urn:jinn:key:${purpose}:${digest}`;
  const identity = `urn:jinn:policy-optimization:${purpose}:${digest}`;
  return {
    purpose,
    keyId,
    identity,
    deliverySigningKey: {
      keyId,
      sign: (payload) => new Uint8Array(sign(null, payload, privateKey)),
    },
    dsseSigner: async ({ preAuthEncoding, signal }) => {
      signal?.throwIfAborted();
      const signature = new Uint8Array(sign(null, preAuthEncoding, privateKey));
      signal?.throwIfAborted();
      return [{ keyid: keyId, signature }];
    },
  };
}
