// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import { InvalidDocumentError } from "./sealing.js";
import { sha256Hex } from "./hashing.js";

export interface TraceIdInput {
  readonly sourceDigest: string;
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: string;
}

const TRACE_ID_KEYS = [
  "sourceDigest",
  "formatIri",
  "decoderId",
  "decoderVersion",
  "vocabularyProfile",
] as const;

const encoder = new TextEncoder();

function invalidTraceIdInput(message: string): never {
  throw new InvalidDocumentError([{ path: "", message }]);
}

function snapshotTraceIdInput(input: TraceIdInput): TraceIdInput {
  if (typeof input !== "object" || input === null) {
    invalidTraceIdInput("trace id input must be a plain object");
  }
  if (isProxy(input)) {
    invalidTraceIdInput("trace id input must not be a Proxy");
  }
  if (Array.isArray(input)) {
    invalidTraceIdInput("trace id input must be a plain object");
  }

  const allowed = new Set<string>(TRACE_ID_KEYS);
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(input);
  } catch {
    invalidTraceIdInput("trace id input failed ownKeys inspection");
  }

  const snapshot: Record<string, string> = {};
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      invalidTraceIdInput("trace id input must not contain symbol keys");
    }
    if (!allowed.has(key)) {
      invalidTraceIdInput(`trace id input has unknown key "${key}"`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      invalidTraceIdInput(`trace id input key "${key}" failed descriptor inspection`);
    }
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      invalidTraceIdInput(`trace id input key "${key}" must be a data property`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      invalidTraceIdInput(`trace id input key "${key}" must be a data property`);
    }
    if (!descriptor.enumerable) {
      invalidTraceIdInput(`trace id input key "${key}" must be enumerable`);
    }
    if (typeof descriptor.value !== "string") {
      invalidTraceIdInput(`trace id input key "${key}" must be a string`);
    }
    snapshot[key] = descriptor.value;
  }

  for (const required of TRACE_ID_KEYS) {
    if (!Object.hasOwn(snapshot, required)) {
      invalidTraceIdInput(`trace id input missing required key "${required}"`);
    }
  }

  return {
    sourceDigest: snapshot.sourceDigest!,
    formatIri: snapshot.formatIri!,
    decoderId: snapshot.decoderId!,
    decoderVersion: snapshot.decoderVersion!,
    vocabularyProfile: snapshot.vocabularyProfile!,
  };
}

/**
 * Length-prefixed framing so that concatenation is injective: no two distinct field
 * tuples share a preimage.
 */
function frame(parts: readonly string[]): Uint8Array {
  return new Uint8Array(encoder.encode(parts.map((part) => `${part.length}:${part}`).join("")));
}

/**
 * Trace identifier — a deterministic order/reference key derived from declared inputs.
 * Byte identity is the sealed record digest; attribution is the derivation attestation.
 */
export function deriveTraceId(input: TraceIdInput): string {
  const port = snapshotTraceIdInput(input);
  return sha256Hex(
    frame([
      "jinn.trajectory.trace",
      port.sourceDigest,
      port.formatIri,
      port.decoderId,
      port.decoderVersion,
      port.vocabularyProfile,
    ]),
  ).slice(0, 32);
}

/** Span identifier — order/reference within a trace, not a security boundary. */
export function deriveSpanId(traceId: string, ordinal: number): string {
  if (typeof traceId !== "string") {
    throw new RangeError("traceId must be a string");
  }
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError("span ordinal must be a non-negative integer");
  }
  return sha256Hex(frame(["jinn.trajectory.span", traceId, String(ordinal)])).slice(0, 16);
}
