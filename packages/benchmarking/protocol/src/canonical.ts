// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "./order.js";
import {
  assertIJsonInteger,
  assertIJsonString,
  UndefinedArrayElementError,
  type JsonValue,
} from "./json.js";

const encoder = new TextEncoder();

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    assertIJsonInteger(value);
    return String(value);
  }
  if (typeof value === "string") {
    assertIJsonString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => {
        if (entry === undefined) throw new UndefinedArrayElementError();
        return serialize(entry);
      })
      .join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(compareCodeUnitStrings);
  return `{${keys
    .map((key) => {
      assertIJsonString(key);
      return `${JSON.stringify(key)}:${serialize(value[key]!)}`;
    })
    .join(",")}}`;
}

export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(serialize(value));
}
