import { compareCodeUnitStrings } from "./order.js";
import {
  assertIJsonInteger,
  assertIJsonString,
  UndefinedArrayElementError,
  type JsonValue,
} from "./json.js";

const encoder = new TextEncoder();

/** Emit RFC 8785 JCS by explicit sorted-key iteration — insertion order is never trusted. */
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
    return `[${value.map((element) => {
      if (element === undefined) throw new UndefinedArrayElementError();
      return serialize(element);
    }).join(",")}]`;
  }
  // Zod's loose object schemas retain a known-optional key that is present-but-undefined in
  // the input. Skip those members, mirroring `JSON.stringify`: two documents differing only
  // by an omitted vs. explicit-undefined optional field must seal to identical bytes.
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(compareCodeUnitStrings);
  return `{${keys.map((key) => {
    assertIJsonString(key);
    return `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`;
  }).join(",")}}`;
}

/** RFC 8785 JCS over the I-JSON-integer subset; those bytes are the record forever (§4.1). */
export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(serialize(value));
}
