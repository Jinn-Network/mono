// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import type { DsseSigner } from "@jinn-network/trust-core";

import {
  isGenuineAbortSignal,
  isGenuineUint8Array,
} from "./hostile-reflection.js";
import { InvalidDocumentError } from "./sealing.js";
import type { LinkageMode } from "./identifiers.js";
import type { Timebase } from "./timebase.js";

function invalidPort(message: string): never {
  throw new InvalidDocumentError([{ path: "", message }]);
}

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "property-descriptor trap";
}

function isPlainOrdinaryObject(value: object): boolean {
  if (isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotPortObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
  context: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidPort(`${context} must be a plain object`);
  }
  if (!isPlainOrdinaryObject(value)) {
    invalidPort(`${context} must be a plain object`);
  }

  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (cause) {
    invalidPort(`${context} failed ownKeys inspection: ${trapMessage(cause)}`);
  }

  const snapshot: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      invalidPort(`${context} must not contain symbol keys`);
    }
    if (!allowedKeys.has(key)) {
      invalidPort(`${context} has unknown key "${key}"`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (cause) {
      invalidPort(`${context} key "${key}" failed descriptor inspection: ${trapMessage(cause)}`);
    }
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      invalidPort(`${context} key "${key}" must be a data property`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      invalidPort(`${context} key "${key}" must be a data property`);
    }
    if (!descriptor.enumerable) {
      invalidPort(`${context} key "${key}" must be enumerable`);
    }
    snapshot[key] = descriptor.value;
  }

  for (const required of requiredKeys) {
    if (!Object.hasOwn(snapshot, required)) {
      invalidPort(`${context} missing required key "${required}"`);
    }
  }

  return snapshot;
}

function requireString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string") {
    invalidPort(`${context}.${field} must be a string`);
  }
  return value;
}

function requireUint8Array(value: unknown, field: string, context: string): Uint8Array {
  if (!isGenuineUint8Array(value)) {
    invalidPort(`${context}.${field} must be a Uint8Array`);
  }
  return value;
}

function requireFunction<T extends (...args: never[]) => unknown>(
  value: unknown,
  field: string,
  context: string,
): T {
  if (typeof value !== "function") {
    invalidPort(`${context}.${field} must be a function`);
  }
  return value as T;
}

function optionalAbortSignal(value: unknown, field: string, context: string): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!isGenuineAbortSignal(value)) {
    invalidPort(`${context}.${field} must be an AbortSignal when present`);
  }
  return value;
}

const BUILD_KEYS = new Set([
  "producerId",
  "executionDigest",
  "trajectoryDigest",
  "nativeTraceDigest",
  "formatIri",
  "decoderId",
  "decoderVersion",
  "vocabularyProfile",
  "timebase",
  "linkageMode",
  "derivedAt",
]);

const SEAL_KEYS = new Set(["statement", "signer", "signal"]);
const SEAL_REQUIRED = new Set(["statement", "signer"]);

const VERIFY_KEYS = new Set([
  "envelopeBytes",
  "executionRecordBytes",
  "trajectoryRecordBytes",
  "verifyAuthority",
  "signal",
]);
const VERIFY_REQUIRED = new Set([
  "envelopeBytes",
  "executionRecordBytes",
  "trajectoryRecordBytes",
  "verifyAuthority",
]);

export interface BuildPortSnapshot {
  readonly producerId: string;
  readonly executionDigest: `sha256:${string}`;
  readonly trajectoryDigest: `sha256:${string}`;
  readonly nativeTraceDigest: `sha256:${string}`;
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: string;
  readonly timebase: Timebase;
  readonly linkageMode: LinkageMode;
  readonly derivedAt: string;
}

export function snapshotBuildPort(input: unknown): BuildPortSnapshot {
  const snapshot = snapshotPortObject(input, BUILD_KEYS, BUILD_KEYS, "derivation statement input");
  return {
    producerId: requireString(snapshot.producerId, "producerId", "derivation statement input"),
    executionDigest: requireString(
      snapshot.executionDigest,
      "executionDigest",
      "derivation statement input",
    ) as `sha256:${string}`,
    trajectoryDigest: requireString(
      snapshot.trajectoryDigest,
      "trajectoryDigest",
      "derivation statement input",
    ) as `sha256:${string}`,
    nativeTraceDigest: requireString(
      snapshot.nativeTraceDigest,
      "nativeTraceDigest",
      "derivation statement input",
    ) as `sha256:${string}`,
    formatIri: requireString(snapshot.formatIri, "formatIri", "derivation statement input"),
    decoderId: requireString(snapshot.decoderId, "decoderId", "derivation statement input"),
    decoderVersion: requireString(
      snapshot.decoderVersion,
      "decoderVersion",
      "derivation statement input",
    ),
    vocabularyProfile: requireString(
      snapshot.vocabularyProfile,
      "vocabularyProfile",
      "derivation statement input",
    ),
    timebase: requireString(
      snapshot.timebase,
      "timebase",
      "derivation statement input",
    ) as Timebase,
    linkageMode: requireString(
      snapshot.linkageMode,
      "linkageMode",
      "derivation statement input",
    ) as LinkageMode,
    derivedAt: requireString(snapshot.derivedAt, "derivedAt", "derivation statement input"),
  };
}

export interface SealPortSnapshot {
  readonly statement: unknown;
  readonly signer: DsseSigner;
  readonly signal?: AbortSignal;
}

export function snapshotSealPort(input: unknown): SealPortSnapshot {
  const snapshot = snapshotPortObject(input, SEAL_KEYS, SEAL_REQUIRED, "derivation seal input");
  if (typeof snapshot.statement !== "object" || snapshot.statement === null || Array.isArray(snapshot.statement)) {
    invalidPort("derivation seal input.statement must be an object");
  }
  const signal = optionalAbortSignal(snapshot.signal, "signal", "derivation seal input");
  return {
    statement: snapshot.statement,
    signer: requireFunction(snapshot.signer, "signer", "derivation seal input"),
    ...(signal === undefined ? {} : { signal }),
  };
}

export type TrajectoryDerivationAuthorityVerifier = (
  input: {
    readonly envelopeBytes: Uint8Array;
    readonly payloadType: string;
    readonly payloadBytes: Uint8Array;
    readonly preAuthEncoding: Uint8Array;
    readonly producerId: string;
    readonly derivedAt: string;
    readonly signal?: AbortSignal;
  },
) => Promise<
  | { readonly verified: true; readonly signerKeyIds: readonly string[]; readonly detail?: string }
  | {
      readonly verified: false;
      readonly signerKeyIds?: readonly string[];
      readonly reason: string;
      readonly detail?: string;
    }
>;

export interface VerifyPortSnapshot {
  readonly envelopeBytes: Uint8Array;
  readonly executionRecordBytes: Uint8Array;
  readonly trajectoryRecordBytes: Uint8Array;
  readonly verifyAuthority: TrajectoryDerivationAuthorityVerifier;
  readonly signal?: AbortSignal;
}

export function snapshotVerifyPort(input: unknown): VerifyPortSnapshot {
  const snapshot = snapshotPortObject(input, VERIFY_KEYS, VERIFY_REQUIRED, "derivation verify input");
  const signal = optionalAbortSignal(snapshot.signal, "signal", "derivation verify input");
  return {
    envelopeBytes: requireUint8Array(snapshot.envelopeBytes, "envelopeBytes", "derivation verify input"),
    executionRecordBytes: requireUint8Array(
      snapshot.executionRecordBytes,
      "executionRecordBytes",
      "derivation verify input",
    ),
    trajectoryRecordBytes: requireUint8Array(
      snapshot.trajectoryRecordBytes,
      "trajectoryRecordBytes",
      "derivation verify input",
    ),
    verifyAuthority: requireFunction(
      snapshot.verifyAuthority,
      "verifyAuthority",
      "derivation verify input",
    ),
    ...(signal === undefined ? {} : { signal }),
  };
}
