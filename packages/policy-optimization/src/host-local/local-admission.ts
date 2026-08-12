// SPDX-License-Identifier: MIT

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  prefixedDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import {
  DSSE_PAYLOAD_TYPE,
  dssePreAuthEncoding,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import { ensurePrivateDirectory, secureAtomicWrite, secureRead } from "./state.js";

const PRIVATE_KEY_FILE = "admission-ed25519-private.pem";
const PUBLIC_KEY_FILE = "admission-ed25519-public.pem";
export const LOCAL_ADMISSION_ISSUER = "urn:jinn:policy-optimization:local-admission" as const;
export const LOCAL_ADMISSION_PREDICATE =
  "network.jinn.task-execution.local-admission/1.0" as const;

export interface LocalAdmissionAuthority {
  readonly issuer: typeof LOCAL_ADMISSION_ISSUER;
  readonly keyId: string;
  seal(input: {
    readonly taskDigest: string;
    readonly evaluationSpecDigest: string;
    readonly strategyId: string;
    readonly sourceCommitment: string;
  }): Uint8Array;
  verify(input: {
    readonly issuer: string;
    readonly keyId: string;
    readonly preAuthEncoding: Uint8Array;
    readonly signature: Uint8Array;
  }): boolean;
}

function keyId(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `urn:jinn:key:${prefixedDigest(new Uint8Array(der))}`;
}

/** Creates once, then reuses, a purpose-scoped local admission signer in private host state. */
export function localAdmissionAuthority(stateRoot: string): LocalAdmissionAuthority {
  const keyRoot = ensurePrivateDirectory(join(stateRoot, "keys"));
  const privatePath = join(keyRoot, PRIVATE_KEY_FILE);
  const publicPath = join(keyRoot, PUBLIC_KEY_FILE);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(Buffer.from(secureRead(privatePath)));
  } catch {
    const generated = generateKeyPairSync("ed25519");
    const privatePem = generated.privateKey.export({ format: "pem", type: "pkcs8" });
    const publicPem = generated.publicKey.export({ format: "pem", type: "spki" });
    secureAtomicWrite(privatePath, new Uint8Array(Buffer.from(privatePem)), true);
    secureAtomicWrite(publicPath, new Uint8Array(Buffer.from(publicPem)), true);
    privateKey = generated.privateKey;
  }
  const publicKey = createPublicKey(privateKey);
  const expectedPublic = new Uint8Array(Buffer.from(publicKey.export({ format: "pem", type: "spki" })));
  secureAtomicWrite(publicPath, expectedPublic, true);
  const id = keyId(publicKey);

  return {
    issuer: LOCAL_ADMISSION_ISSUER,
    keyId: id,
    seal(input) {
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [
          { name: "evaluation-spec", digest: { sha256: input.evaluationSpecDigest.slice("sha256:".length) } },
          { name: "task", digest: { sha256: input.taskDigest.slice("sha256:".length) } },
        ],
        predicateType: LOCAL_ADMISSION_PREDICATE,
        predicate: {
          admitted: true,
          issuer: LOCAL_ADMISSION_ISSUER,
          sourceCommitment: input.sourceCommitment,
          strategyId: input.strategyId,
        },
      } as const;
      const payloadBytes = canonicalJsonBytes(statement as unknown as JsonValue);
      const signature = sign(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes), privateKey);
      return sealDsseEnvelope({
        payloadType: DSSE_PAYLOAD_TYPE,
        payloadBytes,
        signatures: [{ keyid: id, signature: new Uint8Array(signature) }],
      });
    },
    verify(input) {
      return input.issuer === LOCAL_ADMISSION_ISSUER
        && input.keyId === id
        && verify(null, input.preAuthEncoding, publicKey, input.signature);
    },
  };
}
