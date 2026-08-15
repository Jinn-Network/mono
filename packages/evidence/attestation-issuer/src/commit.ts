// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRepository } from "@jinn-network/evidence-repository";

import {
  cloneBytes,
  cloneJsonValue,
  deterministicJsonBytes,
} from "./deterministic-json.js";
import {
  assertIssuerOperationActive,
  AttestationIssuerError,
} from "./errors.js";
import { parsePreparedAttestation } from "./prepared.js";
import type {
  AnyPreparedAttestation,
  AttestationCommitReceipt,
  AttestationIssuerOperationOptions,
} from "./types.js";

function bytesEqual(left: unknown, right: Uint8Array): boolean {
  if (!(left instanceof Uint8Array)) return false;
  const leftValues = Uint8Array.prototype.values.call(left);
  const rightValues = Uint8Array.prototype.values.call(right);
  while (true) {
    const leftValue = leftValues.next();
    const rightValue = rightValues.next();
    if (leftValue.done || rightValue.done) {
      return leftValue.done === true && rightValue.done === true;
    }
    if (leftValue.value !== rightValue.value) return false;
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  const a = deterministicJsonBytes(left);
  const b = deterministicJsonBytes(right);
  return bytesEqual(a, b);
}

function invalidPrepared(message: string, cause?: unknown): never {
  throw new AttestationIssuerError(
    "PREPARED_ATTESTATION_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function snapshotDataObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a safe plain object.`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) => typeof key !== "string" || !allowed.includes(key),
    )
  ) {
    throw new TypeError(`${label} contains unsupported fields.`);
  }
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(
        `${label}.${key} must be an enumerable data property.`,
      );
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotPrepared(
  untrusted: unknown,
): {
  readonly family: unknown;
  readonly recordDigest: unknown;
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly value: {
    readonly envelope: ReturnType<typeof cloneJsonValue>;
    readonly statement: ReturnType<typeof cloneJsonValue>;
    readonly payloadBytes: Uint8Array;
  };
} {
  try {
    const top = snapshotDataObject(
      untrusted,
      ["family", "recordDigest", "envelopeBytes", "payloadBytes", "value"],
      "Prepared attestation",
    );
    const value = snapshotDataObject(
      top.value,
      ["envelope", "statement", "payloadBytes"],
      "Prepared attestation value",
    );
    if (
      !(top.envelopeBytes instanceof Uint8Array) ||
      !(top.payloadBytes instanceof Uint8Array) ||
      !(value.payloadBytes instanceof Uint8Array)
    ) {
      throw new TypeError("Prepared attestation bytes must be Uint8Array values.");
    }
    return {
      family: top.family,
      recordDigest: top.recordDigest,
      envelopeBytes: cloneBytes(top.envelopeBytes),
      payloadBytes: cloneBytes(top.payloadBytes),
      value: {
        envelope: cloneJsonValue(value.envelope),
        statement: cloneJsonValue(value.statement),
        payloadBytes: cloneBytes(value.payloadBytes),
      },
    };
  } catch (cause) {
    if (
      cause instanceof AttestationIssuerError &&
      cause.code === "PREPARED_ATTESTATION_INVALID"
    ) {
      throw cause;
    }
    invalidPrepared("Prepared attestation structure is invalid.", cause);
  }
}

function verifyPrepared(
  untrusted: AnyPreparedAttestation,
): AnyPreparedAttestation {
  const accepted = snapshotPrepared(untrusted);
  let reparsed: AnyPreparedAttestation;
  try {
    reparsed = parsePreparedAttestation(accepted.envelopeBytes);
  } catch (cause) {
    invalidPrepared("Prepared envelope bytes no longer validate.", cause);
  }
  try {
    if (
      accepted.family !== reparsed.family ||
      accepted.recordDigest !== reparsed.recordDigest ||
      !bytesEqual(accepted.payloadBytes, reparsed.payloadBytes) ||
      !bytesEqual(accepted.value.payloadBytes, reparsed.value.payloadBytes) ||
      !jsonEqual(accepted.value.envelope, reparsed.value.envelope) ||
      !jsonEqual(accepted.value.statement, reparsed.value.statement)
    ) {
      invalidPrepared("Prepared attestation fields do not match its exact envelope bytes.");
    }
  } catch (cause) {
    if (
      cause instanceof AttestationIssuerError &&
      cause.code === "PREPARED_ATTESTATION_INVALID"
    ) {
      throw cause;
    }
    invalidPrepared("Prepared attestation value is invalid.", cause);
  }
  return reparsed;
}

export async function commitPreparedAttestation<
  TPrepared extends AnyPreparedAttestation,
>(
  prepared: TPrepared,
  repository: EvidenceRepository,
  options?: AttestationIssuerOperationOptions,
): Promise<AttestationCommitReceipt<TPrepared["family"]>> {
  assertIssuerOperationActive(options?.signal);
  const verified = verifyPrepared(prepared);
  assertIssuerOperationActive(options?.signal);
  const repositoryReceipt = await repository.putRecord(
    verified.family,
    cloneBytes(verified.envelopeBytes),
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
  let referenceFamily: unknown;
  let referenceDigest: unknown;
  let size: unknown;
  let status: unknown;
  try {
    if (typeof repositoryReceipt !== "object" || repositoryReceipt === null) {
      throw new TypeError("Repository receipt must be an object.");
    }
    const reference = repositoryReceipt.reference;
    if (typeof reference !== "object" || reference === null) {
      throw new TypeError("Repository receipt reference must be an object.");
    }
    referenceFamily = reference.family;
    referenceDigest = reference.digest;
    size = repositoryReceipt.size;
    status = repositoryReceipt.status;
  } catch (cause) {
    throw new AttestationIssuerError(
      "INTERNAL_FAILURE",
      "Evidence Repository returned a receipt that contradicts the committed bytes.",
      { cause },
    );
  }
  if (
    referenceFamily !== verified.family ||
    referenceDigest !== verified.recordDigest ||
    size !== verified.envelopeBytes.byteLength ||
    (status !== "created" && status !== "existing")
  ) {
    throw new AttestationIssuerError(
      "INTERNAL_FAILURE",
      "Evidence Repository returned a receipt that contradicts the committed bytes.",
    );
  }
  return Object.freeze({
    family: verified.family as TPrepared["family"],
    recordDigest: verified.recordDigest,
    repositoryReceipt: Object.freeze({
      reference: Object.freeze({
        family: verified.family,
        digest: verified.recordDigest,
      }),
      size,
      status,
    }),
  });
}
