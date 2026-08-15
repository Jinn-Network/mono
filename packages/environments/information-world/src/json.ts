export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export class IJsonNumberError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

export class IJsonStringError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly value: string) {
    super("string contains an unpaired UTF-16 surrogate and is not an I-JSON scalar sequence");
    this.name = "IJsonStringError";
  }
}

/**
 * Thrown when canonicalization reaches an array element that is `undefined`. JCS has no
 * "undefined" token: an object member whose value is `undefined` is omitted (mirroring
 * `JSON.stringify`), but an array has no key to omit by, so the only non-corrupting move is
 * to reject.
 */
export class UndefinedArrayElementError extends Error {
  readonly category = "invalid-document" as const;
  constructor() {
    super("array elements must not be undefined; JCS has no undefined token");
    this.name = "UndefinedArrayElementError";
  }
}

/** I-JSON strings carry Unicode scalar values, never isolated UTF-16 surrogate code units. */
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

/** Recursively enforces the I-JSON scalar rule over parsed values and member names. */
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

/** Sealed records admit only exact I-JSON integers; fractional quantities are decimal strings. */
export function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}
