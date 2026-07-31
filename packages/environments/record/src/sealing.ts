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
 * `JSON.parse` gives `__proto__` as an ordinary own member, but zod's object copy assigns
 * through the prototype setter and the member never reaches the output. Validation would
 * therefore succeed and the sealed bytes would quietly lack content the producer handed in.
 * A seal that drops a member is worse than one that refuses the document, so this refuses.
 */
function assertNoPrototypeMember(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((element, index) => assertNoPrototypeMember(element, `${path}${path ? "." : ""}${index}`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, member] of Object.entries(value)) {
    const memberPath = `${path}${path ? "." : ""}${key}`;
    if (key === "__proto__") {
      throw new InvalidDocumentError([{
        path: memberPath,
        message: 'a "__proto__" member cannot survive sealing and is refused, never dropped',
      }]);
    }
    assertNoPrototypeMember(member, memberPath);
  }
}

/**
 * Validate against `schema`, then canonicalize **once**. The returned bytes are the record
 * forever; its identity is `environmentRecordDigest` over them.
 */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): Uint8Array {
  assertNoPrototypeMember(document, "");
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
