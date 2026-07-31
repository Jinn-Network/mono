// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";

import { type JsonValue, serializeCanonicalJson } from "./canonical.js";
import { documentDigest } from "./hashing.js";

export interface SealedRecord {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class InvalidDocumentError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly errors: readonly ValidationIssue[]) {
    super("document failed validation at sealing");
    this.name = "InvalidDocumentError";
  }
}

/** Canonicalize once; the resulting bytes are the record forever. */
export function sealRecord(value: JsonValue): SealedRecord {
  const bytes = serializeCanonicalJson(value);
  return { bytes, digest: documentDigest(bytes) };
}

function issues(error: z.ZodError): readonly ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/** Validate against `schema`, then seal. Throws `InvalidDocumentError` on failure. */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): SealedRecord {
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw new InvalidDocumentError(issues(parsed.error));
  return sealRecord(parsed.data as JsonValue);
}

/**
 * Decode, validate, and require the input to be the one exact canonical encoding —
 * no consumer re-canonicalizes to check a digest.
 */
export function parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "bytes are not valid UTF-8" }]);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "bytes are not valid JSON" }]);
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new InvalidDocumentError(issues(parsed.error));

  const recanonicalized = serializeCanonicalJson(parsed.data as JsonValue);
  if (new TextDecoder().decode(recanonicalized) !== text) {
    throw new InvalidDocumentError([
      { path: "", message: "bytes are not the canonical encoding of this document" },
    ]);
  }
  return parsed.data;
}
