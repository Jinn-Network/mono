import { compareCodeUnitStrings } from "./order.js";
import { cloneIJsonValue, type JsonValue } from "./json.js";

const encoder = new TextEncoder();

/** Emit RFC 8785 JCS by explicit sorted-key iteration — insertion order is never trusted (§7.14). */
function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value); // JCS string escaping (I-JSON subset)
  if (Array.isArray(value)) {
    return `[${value.map((element) => serialize(element)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .sort(compareCodeUnitStrings); // sorted array drives emission
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k])}`).join(",")}}`;
}

/** RFC 8785 JCS over the I-JSON-integer subset; those bytes are the document forever (§6.1). */
export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(serialize(cloneIJsonValue(value)));
}
