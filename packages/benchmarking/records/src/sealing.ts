import type { z } from "zod";
import { serializeCanonicalJson } from "./canonical.js";
import { documentDigest } from "./hashing.js";
import { assertIJsonStrings, type JsonValue } from "./json.js";

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

function validationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function assertSealableValue(
  value: unknown,
  path = "",
  ancestors: ReadonlySet<object> = new Set(),
  objectMember = false,
): void {
  if (value === undefined && objectMember) return;
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) return;
  if (typeof value !== "object") {
    throw new InvalidDocumentError([{ path, message: "value is not representable as JSON" }]);
  }
  if (ancestors.has(value)) {
    throw new InvalidDocumentError([{ path, message: "cyclic values are not representable as JSON" }]);
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new InvalidDocumentError([{
          path: path === "" ? String(index) : `${path}.${index}`,
          message: "sparse arrays are not representable as JSON",
        }]);
      }
      assertSealableValue(value[index], path === "" ? String(index) : `${path}.${index}`, nextAncestors);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidDocumentError([{ path, message: "non-plain objects are not representable as JSON" }]);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new InvalidDocumentError([{ path, message: "symbol-keyed values are not representable as JSON" }]);
  }
  const propertyNames = Object.getOwnPropertyNames(value);
  if (propertyNames.length !== Object.keys(value).length) {
    throw new InvalidDocumentError([{ path, message: "non-enumerable values are not representable as JSON" }]);
  }
  for (const key of propertyNames) {
    assertSealableValue(
      (value as Record<string, unknown>)[key],
      path === "" ? key : `${path}.${key}`,
      nextAncestors,
      true,
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Decode, validate, and require the input bytes to be the one exact canonical encoding. */
export function parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "not valid UTF-8 JSON" }]);
  }
  assertIJsonStrings(json);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidDocumentError(validationIssues(parsed.error));

  const canonical = serializeCanonicalJson(parsed.data as JsonValue);
  if (!bytesEqual(canonical, bytes)) {
    throw new InvalidDocumentError([{
      path: "",
      message: "record bytes are not the exact canonical JSON encoding",
    }]);
  }
  return parsed.data;
}

/** Parse against `schema`, throwing `InvalidDocumentError` on failure; else seal the parsed data. */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): SealedRecord {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw new InvalidDocumentError(validationIssues(parsed.error));
  }
  assertSealableValue(parsed.data);
  // I-JSON integer enforcement happens inside serializeCanonicalJson; a non-integer number
  // throws IJsonNumberError, uncaught here (§6.1).
  return sealRecord(parsed.data as JsonValue);
}
