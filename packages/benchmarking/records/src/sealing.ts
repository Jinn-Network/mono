import type { z } from "zod";
import { serializeCanonicalJson } from "./canonical.js";
import { documentDigest } from "./hashing.js";
import type { JsonValue } from "./json.js";

export interface SealedRecord {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
}

/** Validate → I-JSON enforce → JCS → exact bytes. Those bytes are the record forever (§6.1). */
export function sealRecord(value: JsonValue): SealedRecord {
  const bytes = serializeCanonicalJson(value);
  return { bytes, digest: documentDigest(bytes) };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Thrown when a document fails schema validation at sealing time (§6.1), or a `.superRefine`
 * structural constraint fails (e.g. a Run record missing `closeAt`, §16). Re-implemented locally
 * per the per-package sealing rule (program §7.1) — the same plain
 * `{ category: "invalid-document", errors }` shape TEP protocol's `InvalidDocumentError` carries.
 */
export class InvalidDocumentError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly errors: readonly ValidationIssue[]) {
    super("document failed schema validation at sealing (§6.1)");
    this.name = "InvalidDocumentError";
  }
}

/** Parse against `schema`, throwing `InvalidDocumentError` on failure; else seal the parsed data. */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): SealedRecord {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new InvalidDocumentError(errors);
  }
  // I-JSON integer enforcement happens inside serializeCanonicalJson; a non-integer number
  // throws IJsonNumberError, uncaught here (§6.1).
  return sealRecord(parsed.data as JsonValue);
}
