// SPDX-License-Identifier: Apache-2.0

import {
  DSSE_PAYLOAD_TYPE,
  dssePreAuthEncoding,
} from "@jinn-network/evidence-protocol";

import {
  cloneBytes,
  deterministicJsonBytes,
  standardBase64,
} from "./deterministic-json.js";
import {
  assertIssuerOperationActive,
  AttestationIssuerError,
} from "./errors.js";
import { createPreparedAttestation } from "./prepared.js";
import {
  buildExecutionVerificationStatement,
  buildResultEvaluationStatement,
} from "./statement.js";
import type {
  DsseProducedSignature,
  DsseSigner,
  PrepareExecutionVerificationInput,
  PreparedExecutionVerification,
  PreparedResultEvaluation,
  PrepareResultEvaluationInput,
  AttestationIssuerOperationOptions,
} from "./types.js";

function normalizeSignatures(value: unknown): {
  readonly keyid?: string;
  readonly sig: string;
}[] {
  const invalidSignerOutput = (message: string, cause?: unknown): never => {
    throw new AttestationIssuerError(
      "INVALID_SIGNER_OUTPUT",
      message,
      cause === undefined ? undefined : { cause },
    );
  };
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return invalidSignerOutput(
        "The DSSE signer must return a standard dense array.",
      );
    }
    const arrayDescriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = arrayDescriptors["length"] as
      | PropertyDescriptor
      | undefined;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 1 ||
      lengthDescriptor.value > 0xffff_ffff
    ) {
      return invalidSignerOutput(
        "The DSSE signer must return at least one signature.",
      );
    }
    const length = lengthDescriptor.value as number;
    for (const key of Reflect.ownKeys(arrayDescriptors)) {
      if (
        typeof key !== "string" ||
        (
          key !== "length" &&
          (
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= length ||
            Number(key) > 0xffff_fffe
          )
        )
      ) {
        return invalidSignerOutput(
          "The DSSE signer output array must not contain non-index properties.",
        );
      }
    }
    const elements: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = arrayDescriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return invalidSignerOutput(
          `Signer output ${index} must be a dense data property.`,
        );
      }
      elements[index] = descriptor.value;
    }
    const normalized: { readonly keyid?: string; readonly sig: string }[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const candidate = elements[index];
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))
      ) {
        return invalidSignerOutput(
          `Signer output ${index} must be a safe plain object.`,
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "signature" && key !== "keyid"),
        )
      ) {
        return invalidSignerOutput(
          `Signer output ${index} contains unsupported fields.`,
        );
      }
      const signatureDescriptor = descriptors.signature;
      const keyidDescriptor = descriptors.keyid;
      if (
        signatureDescriptor === undefined ||
        !("value" in signatureDescriptor) ||
        (keyidDescriptor !== undefined && !("value" in keyidDescriptor))
      ) {
        return invalidSignerOutput(
          `Signer output ${index} must use data properties.`,
        );
      }
      const signature = signatureDescriptor.value;
      const keyid = keyidDescriptor?.value;
      const signatureBytes = (() => {
        try {
          if (!(signature instanceof Uint8Array)) throw new TypeError("not bytes");
          return cloneBytes(signature);
        } catch (cause) {
          return invalidSignerOutput(
            `Signer output ${index} must contain readable Uint8Array signature bytes.`,
            cause,
          );
        }
      })();
      if (signatureBytes.byteLength === 0) {
        return invalidSignerOutput(
          `Signer output ${index} must contain non-empty Uint8Array signature bytes.`,
        );
      }
      if (keyid !== undefined && typeof keyid !== "string") {
        return invalidSignerOutput(
          `Signer output ${index} keyid must be a string when present.`,
        );
      }
      const sig = standardBase64(signatureBytes);
      normalized.push(keyid === undefined ? { sig } : { keyid, sig });
    }
    return normalized;
  } catch (cause) {
    if (
      cause instanceof AttestationIssuerError &&
      cause.code === "INVALID_SIGNER_OUTPUT"
    ) {
      throw cause;
    }
    return invalidSignerOutput(
      "The DSSE signer returned unreadable output.",
      cause,
    );
  }
}

async function prepare(
  family: "result-evaluation" | "execution-verification",
  statement: unknown,
  signer: DsseSigner,
  options?: AttestationIssuerOperationOptions,
) {
  assertIssuerOperationActive(options?.signal);
  const payloadBytes = deterministicJsonBytes(statement);
  const preAuthEncoding = dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes);
  let produced: unknown;
  try {
    produced = await signer({
      payloadType: DSSE_PAYLOAD_TYPE,
      payloadBytes: cloneBytes(payloadBytes),
      preAuthEncoding: cloneBytes(preAuthEncoding),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    throw new AttestationIssuerError(
      "SIGNING_FAILED",
      "The injected DSSE signer failed.",
      { cause },
    );
  }
  assertIssuerOperationActive(options?.signal);
  // ISSUER-CONTRACT ENCODING NOTE (defect #34 follow-up): this ENVELOPE deliberately serializes
  // via `deterministicJsonBytes` -- sorted keys but PRETTY-PRINTED (2-space indent, `": "`
  // separators, trailing newline) -- the same convention as the payload above, and the exact
  // bytes pinned by `fixtures/issuer-contract-v1/` ("the exact envelope bytes are the retry
  // unit", README). These bytes are NOT compatible with `@jinn-network/trust-core`'s
  // authority-bearing `parseExactDsseEnvelope`, which accepts only `sealDsseEnvelope`'s compact
  // RFC 8785 JCS encoding and refuses this spelling on whitespace alone. No native-path
  // consumer routes these envelopes to that strict parser today (evidence-protocol validation is
  // structural). Do not point a strict-parse consumer at these bytes, and do not change this
  // encoding, without a new issuer-contract fixture version (v2) and regenerated
  // expected-digests -- changing it moves every digest derived from these envelope bytes.
  const envelopeBytes = deterministicJsonBytes({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: standardBase64(payloadBytes),
    signatures: normalizeSignatures(produced),
  });
  return createPreparedAttestation(
    family,
    envelopeBytes,
    "PROTOCOL_CONFORMANCE_FAILED",
  );
}

export async function prepareResultEvaluation(
  input: PrepareResultEvaluationInput,
  signer: DsseSigner,
  options?: AttestationIssuerOperationOptions,
): Promise<PreparedResultEvaluation> {
  assertIssuerOperationActive(options?.signal);
  const statement = buildResultEvaluationStatement(input);
  return await prepare(
    "result-evaluation",
    statement,
    signer,
    options,
  ) as PreparedResultEvaluation;
}

/**
 * Builds the exact canonical ResultEvaluationStatement payload without signing it. This is the
 * child-process boundary used by the native evaluator: an untrusted grader may calculate a
 * statement, while only the backend host is allowed to seal that payload as a DSSE envelope.
 */
export function buildResultEvaluationPayload(
  input: PrepareResultEvaluationInput,
): Uint8Array {
  return deterministicJsonBytes(buildResultEvaluationStatement(input));
}

/** Exact byte convention used by attestation payload producers and host-side verifiers. */
export function canonicalAttestationJsonBytes(value: unknown): Uint8Array {
  return deterministicJsonBytes(value);
}

export async function prepareExecutionVerification(
  input: PrepareExecutionVerificationInput,
  signer: DsseSigner,
  options?: AttestationIssuerOperationOptions,
): Promise<PreparedExecutionVerification> {
  assertIssuerOperationActive(options?.signal);
  const statement = buildExecutionVerificationStatement(input);
  return await prepare(
    "execution-verification",
    statement,
    signer,
    options,
  ) as PreparedExecutionVerification;
}
