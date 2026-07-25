// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import { EvidenceAnnouncementJournalError } from "./errors.js";

export type Sha256Text = `sha256:${string}`;

function corrupt(message: string): never {
  throw new EvidenceAnnouncementJournalError("JOURNAL_CORRUPT", message);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) corrupt(`${path} must contain finite numbers.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      ancestors.has(value)
    ) {
      corrupt(`${path} must contain safe acyclic arrays.`);
    }
    if (
      Reflect.ownKeys(value).some((key) =>
        typeof key !== "string" ||
        (
          key !== "length" &&
          (
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= value.length ||
            Number(key) > 0xffff_fffe
          )
        ))
    ) {
      corrupt(`${path} must contain only dense array indexes.`);
    }
    ancestors.add(value);
    const normalized: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        corrupt(`${path} must contain dense enumerable data properties.`);
      }
      normalized.push(normalize(descriptor.value, `${path}[${index}]`, ancestors));
    }
    ancestors.delete(value);
    return normalized;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ancestors.has(value) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      corrupt(`${path} must contain safe acyclic plain objects.`);
    }
    ancestors.add(value);
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, descriptor]) => {
        if (!descriptor.enumerable || !("value" in descriptor)) {
          corrupt(`${path}.${key} must be an enumerable data property.`);
        }
        return [key, normalize(descriptor.value, `${path}.${key}`, ancestors)];
      });
    ancestors.delete(value);
    return Object.fromEntries(entries);
  }
  return corrupt(`${path} must contain only JSON values.`);
}

export function deterministicBytes(value: unknown): Uint8Array {
  const normalized = normalize(value, "value");
  return new TextEncoder().encode(`${renderJson(normalized, 0)}\n`);
}

function renderJson(value: unknown, depth: number): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const currentIndent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value
      .map((child) => `${childIndent}${renderJson(child, depth + 1)}`)
      .join(",\n")}\n${currentIndent}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort(compareCodeUnits)
    .map(
      (key) =>
        `${childIndent}${JSON.stringify(key)}: ${renderJson(
          (value as Record<string, unknown>)[key],
          depth + 1,
        )}`,
    );
  return entries.length === 0
    ? "{}"
    : `{\n${entries.join(",\n")}\n${currentIndent}}`;
}

export function digestBytes(bytes: Uint8Array): Sha256Text {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function exactBytesEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function decodeUtf8(bytes: Uint8Array, role: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new EvidenceAnnouncementJournalError(
      "JOURNAL_CORRUPT",
      `${role} is not valid UTF-8.`,
      { cause: error },
    );
  }
}
