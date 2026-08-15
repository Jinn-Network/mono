import type { z } from "zod";

import { serializeCanonicalJson } from "./canonical.js";
import { assertIJsonString, type JsonValue } from "./json.js";

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

function invalidInput(path: string, message: string): never {
  throw new InvalidDocumentError([{ path, message }]);
}

function childPath(path: string, child: string): string {
  return path === "" ? child : `${path}.${child}`;
}

function keyPath(path: string, key: PropertyKey): string {
  return typeof key === "string"
    ? childPath(path, key)
    : childPath(path, `[${String(key)}]`);
}

function ownKeys(value: object, path: string): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return invalidInput(path, "must expose a stable own-property graph");
  }
}

function ownDescriptor(value: object, key: PropertyKey, path: string): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return invalidInput(path, "must expose a stable own-property graph");
    }
    return descriptor;
  } catch {
    return invalidInput(path, "must expose a stable own-property graph");
  }
}

function prototypeOf(value: object, path: string): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return invalidInput(path, "must have an ordinary object prototype");
  }
}

function enumerableDataDescriptor(
  value: object,
  key: PropertyKey,
  path: string,
): PropertyDescriptor & { value: unknown } {
  const descriptor = ownDescriptor(value, key, path);
  if (!descriptor.enumerable || !("value" in descriptor)) {
    return invalidInput(path, "must be an enumerable data property");
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

/**
 * Copy only the supported I-JSON-integer graph before Zod reads it. Zod's loose-object path
 * can preserve values that the canonical serializer would omit or coerce, particularly inside
 * namespaced extensions; sealing must reject those inputs instead of changing their bytes.
 */
function cloneIJsonValue(value: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    try {
      assertIJsonString(value);
    } catch {
      return invalidInput(path, "must be an I-JSON scalar string");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      return invalidInput(path, "must be an exact I-JSON integer");
    }
    return value;
  }
  if (typeof value !== "object") {
    return invalidInput(path, `must be an I-JSON value, not ${typeof value}`);
  }

  if (ancestors.has(value)) {
    return invalidInput(path, "must not contain a cycle");
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? cloneIJsonArray(value, path, ancestors)
      : cloneIJsonObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function cloneIJsonArray(value: unknown[], path: string, ancestors: WeakSet<object>): JsonValue[] {
  if (prototypeOf(value, path) !== Array.prototype) {
    return invalidInput(path, "must be an ordinary array");
  }
  const lengthDescriptor = ownDescriptor(value, "length", path);
  if (!("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
    return invalidInput(path, "must have an ordinary array length");
  }
  const length = lengthDescriptor.value;
  const present = new Set<number>();
  for (const key of ownKeys(value, path)) {
    if (key === "length") continue;
    const memberPath = keyPath(path, key);
    if (typeof key !== "string") {
      return invalidInput(memberPath, "array members must use numeric string indexes");
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return invalidInput(memberPath, "array must not contain unexpected properties");
    }
    enumerableDataDescriptor(value, key, memberPath);
    present.add(index);
  }

  const copied: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const memberPath = childPath(path, String(index));
    if (!present.has(index)) {
      return invalidInput(memberPath, "array must not contain holes");
    }
    copied.push(cloneIJsonValue(
      enumerableDataDescriptor(value, String(index), memberPath).value,
      memberPath,
      ancestors,
    ));
  }
  return copied;
}

function cloneIJsonObject(
  value: object,
  path: string,
  ancestors: WeakSet<object>,
): { [key: string]: JsonValue } {
  const prototype = prototypeOf(value, path);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput(path, "must be a plain object with no custom prototype");
  }
  const copied: { [key: string]: JsonValue } = Object.create(null);
  for (const key of ownKeys(value, path)) {
    const memberPath = keyPath(path, key);
    if (typeof key !== "string") {
      return invalidInput(memberPath, "object members must use string keys");
    }
    if (key === "__proto__") {
      return invalidInput(memberPath, 'a "__proto__" member cannot survive sealing and is refused');
    }
    try {
      assertIJsonString(key);
    } catch {
      return invalidInput(memberPath, "object member names must be I-JSON scalar strings");
    }
    copied[key] = cloneIJsonValue(
      enumerableDataDescriptor(value, key, memberPath).value,
      memberPath,
      ancestors,
    );
  }
  return copied;
}

/**
 * Validate against `schema`, then canonicalize **once**. The returned bytes are the record
 * forever; its identity is `informationWorldRecordDigest` over them.
 */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): Uint8Array {
  const input = cloneIJsonValue(document, "", new WeakSet());
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InvalidDocumentError(validationIssues(parsed.error));
  return serializeCanonicalJson(parsed.data as JsonValue);
}

/**
 * Decode, validate, and require the input to be the one exact canonical encoding — a
 * consumer never re-canonicalizes to check a digest, because re-canonicalizing would let
 * two distinct byte strings present as the same record.
 */
export function parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "bytes are not valid UTF-8 JSON" }]);
  }
  const json = cloneIJsonValue(decoded, "", new WeakSet());

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
