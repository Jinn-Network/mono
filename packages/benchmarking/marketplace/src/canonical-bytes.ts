// SPDX-License-Identifier: MIT

import type { ValidationResult } from "@jinn-network/task-execution-protocol";

/** RFC 8785 JCS bytes must round-trip through the authoritative sealer unchanged. */
export function bytesMatchCanonicalSeal(
  bytes: Uint8Array,
  parsed: unknown,
  seal: (document: unknown) => Uint8Array,
  validation: ValidationResult,
): boolean {
  if (!validation.conforms) return false;
  let resealed: Uint8Array;
  try {
    resealed = seal(parsed);
  } catch {
    return false;
  }
  if (resealed.length !== bytes.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== resealed[index]) return false;
  }
  return true;
}

/** Fail closed on malformed UTF-8 or JSON before schema validation. */
export function decodeUtf8Json(bytes: Uint8Array): unknown | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isValidBlockHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSha256Ref(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

/**
 * Bind a sealed Submission document to the catalog or observation identity that
 * named it. Digest-equal sharing of one blob is allowed; a different identity
 * pointing at this document is not.
 */
export function sealedSubmissionMatchesIdentity(
  parsed: unknown,
  submissionUrn: string,
  taskDigest: string,
): boolean {
  if (!isPlainRecord(parsed) || parsed.submission !== submissionUrn) return false;
  const task = parsed.task;
  if (!isPlainRecord(task)) return false;
  const digest = task.digest;
  if (!isPlainRecord(digest) || typeof digest.sha256 !== "string") return false;
  return asSha256Ref(digest.sha256) === asSha256Ref(taskDigest);
}
