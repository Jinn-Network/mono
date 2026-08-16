// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";

import { serializeCanonicalJson } from "./canonical.js";
import { documentDigest } from "./hashing.js";
import { assertIJsonStrings, type JsonValue } from "./json.js";

export interface SealedRecord {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class InvalidDocumentError extends Error {
  readonly category = "invalid-document" as const;

  constructor(readonly errors: readonly ValidationIssue[]) {
    super("document failed schema validation");
    this.name = "InvalidDocumentError";
  }
}

function issues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function assertSealable(
  value: unknown,
  path = "",
  ancestors: ReadonlySet<object> = new Set(),
  objectMember = false,
): void {
  if (value === undefined && objectMember) return;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new InvalidDocumentError([
      { path, message: "value is not representable as JSON" },
    ]);
  }
  if (ancestors.has(value)) {
    throw new InvalidDocumentError([
      { path, message: "cyclic values are not representable as JSON" },
    ]);
  }
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new InvalidDocumentError([
          { path: `${path}.${index}`, message: "sparse array" },
        ]);
      }
      assertSealable(value[index], `${path}.${index}`, next);
    }
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidDocumentError([
      { path, message: "non-plain object" },
    ]);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new InvalidDocumentError([
      { path, message: "symbol-keyed value" },
    ]);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    assertSealable(
      (value as Record<string, unknown>)[key],
      path === "" ? key : `${path}.${key}`,
      next,
      true,
    );
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function sealRecord(value: JsonValue): SealedRecord {
  const bytes = serializeCanonicalJson(value);
  return { bytes, digest: documentDigest(bytes) };
}

export function sealWithSchema<T>(
  schema: z.ZodType<T>,
  document: unknown,
): SealedRecord {
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw new InvalidDocumentError(issues(parsed.error));
  assertSealable(parsed.data);
  return sealRecord(parsed.data as JsonValue);
}

export function parseExactWithSchema<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array,
): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidDocumentError([
      { path: "", message: "not valid UTF-8 JSON" },
    ]);
  }
  assertIJsonStrings(decoded);
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new InvalidDocumentError(issues(parsed.error));
  const canonical = serializeCanonicalJson(parsed.data as JsonValue);
  if (!equalBytes(canonical, bytes)) {
    throw new InvalidDocumentError([
      { path: "", message: "record is not exact canonical JSON" },
    ]);
  }
  return parsed.data;
}
