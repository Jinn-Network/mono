export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

/** True only for an acyclic value that can be represented losslessly as sealed I-JSON. */
export function isJsonValue(value: unknown, ancestors: ReadonlySet<object> = new Set()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.every((element, index) => index in value && isJsonValue(element, nextAncestors));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const propertyNames = Object.getOwnPropertyNames(value);
  if (propertyNames.length !== Object.keys(value).length) return false;
  return propertyNames.every((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key)
    && isJsonValue((value as Record<string, unknown>)[key], nextAncestors)
  );
}

export class IJsonNumberError extends Error {
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

export class IJsonStringError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly value: string) {
    super("string contains an unpaired UTF-16 surrogate and is not an I-JSON Unicode scalar sequence");
    this.name = "IJsonStringError";
  }
}

/** I-JSON strings contain Unicode scalar values, never isolated UTF-16 surrogate code units. */
export function assertIJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new IJsonStringError(value);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new IJsonStringError(value);
    }
  }
}

/** Recursively enforces the I-JSON Unicode-scalar rule over parsed values and member names. */
export function assertIJsonStrings(value: unknown): void {
  if (typeof value === "string") {
    assertIJsonString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) assertIJsonStrings(element);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, member] of Object.entries(value)) {
      assertIJsonString(key);
      assertIJsonStrings(member);
    }
  }
}

/**
 * Thrown when canonicalization reaches an array element that is `undefined`. JCS has no
 * "undefined" token (§6.1) — object members whose value is `undefined` are omitted (mirroring
 * `JSON.stringify`), but an array has no key to omit by, so the only non-corrupting move is to
 * reject. Carries the same `category: "invalid-document"` shape `InvalidDocumentError`
 * (sealing.ts) uses, without importing it — `errors.ts`/`sealing.ts` already depend on
 * `canonical.ts`, so importing back would cycle.
 */
export class UndefinedArrayElementError extends Error {
  readonly category = "invalid-document" as const;
  constructor() {
    super("array elements must not be undefined; JCS has no undefined token (§6.1)");
    this.name = "UndefinedArrayElementError";
  }
}

/** Sealed families admit only exact I-JSON integers; fractional quantities are strings (§6.1). */
export function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}
