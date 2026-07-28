import { compareCodeUnitStrings } from "./order.js";
import { assertIJsonInteger, UndefinedArrayElementError, type JsonValue } from "./json.js";

const encoder = new TextEncoder();

/** Emit RFC 8785 JCS by explicit sorted-key iteration — insertion order is never trusted (§7.14). */
function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { assertIJsonInteger(value); return String(value); }
  if (typeof value === "string") return JSON.stringify(value); // JCS string escaping (I-JSON subset)
  if (Array.isArray(value)) {
    // JCS has no "undefined" token — an array element that is undefined (unlike an object
    // member, it has no key to omit by) is rejected outright rather than silently corrupting
    // the emitted bytes with a literal token (§6.1).
    return `[${value.map((element) => {
      if (element === undefined) throw new UndefinedArrayElementError();
      return serialize(element);
    }).join(",")}]`;
  }
  // Zod's `.loose()` object schemas retain a known-optional key that is present-but-undefined in
  // the input, so `value` can carry `undefined`-valued members here even though `JsonValue`'s
  // type doesn't admit them. Skip them, mirroring `JSON.stringify`'s member omission — two
  // documents differing only by an omitted vs. explicit-undefined optional field must seal to
  // identical bytes (§6.1/§22).
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort(compareCodeUnitStrings); // sorted array drives emission
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k])}`).join(",")}}`;
}

/** RFC 8785 JCS over the I-JSON-integer subset; those bytes are the document forever (§6.1). */
export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(serialize(value));
}
