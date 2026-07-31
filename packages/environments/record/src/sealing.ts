import type { z } from "zod";

import { serializeCanonicalJson } from "./canonical.js";
import { assertIJsonStrings, type JsonValue } from "./json.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Thrown when a document fails schema validation at sealing time, or when bytes handed to
 * `parseExactWithSchema` are not the one exact canonical encoding. Re-implemented locally
 * per the per-package sealing rule — the same plain `{ category: "invalid-document",
 * errors }` shape the rest of the stack carries, without importing it.
 */
export class InvalidDocumentError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly errors: readonly ValidationIssue[]) {
    super("document failed validation at the sealing boundary");
    this.name = "InvalidDocumentError";
  }
}

function validationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Validate against `schema`, then canonicalize **once**. The returned bytes are the record
 * forever; its identity is `environmentRecordDigest` over them.
 */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): Uint8Array {
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw new InvalidDocumentError(validationIssues(parsed.error));
  return serializeCanonicalJson(parsed.data as JsonValue);
}

/**
 * Decode, validate, and require the input to be the one exact canonical encoding — a
 * consumer never re-canonicalizes to check a digest, because re-canonicalizing would let
 * two distinct byte strings present as the same record.
 */
export function parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "bytes are not valid UTF-8 JSON" }]);
  }
  assertIJsonStrings(json);

  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidDocumentError(validationIssues(parsed.error));

  if (!bytesEqual(serializeCanonicalJson(parsed.data as JsonValue), bytes)) {
    throw new InvalidDocumentError([{
      path: "",
      message: "bytes are not the exact canonical JSON encoding of this record",
    }]);
  }
  return parsed.data;
}
