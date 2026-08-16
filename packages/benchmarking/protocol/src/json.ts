// SPDX-License-Identifier: Apache-2.0

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class IJsonNumberError extends Error {
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

export class IJsonStringError extends Error {
  readonly category = "invalid-document" as const;

  constructor(readonly value: string) {
    super("string contains an unpaired UTF-16 surrogate");
    this.name = "IJsonStringError";
  }
}

export class UndefinedArrayElementError extends Error {
  readonly category = "invalid-document" as const;

  constructor() {
    super("array elements must not be undefined");
    this.name = "UndefinedArrayElementError";
  }
}

export function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}

export function assertIJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new IJsonStringError(value);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new IJsonStringError(value);
    }
  }
}

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

export function isJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    return value.every(
      (entry, index) => index in value && isJsonValue(entry, next),
    );
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== Object.keys(value).length) return false;
  return names.every(
    (key) =>
      Object.prototype.propertyIsEnumerable.call(value, key) &&
      isJsonValue((value as Record<string, unknown>)[key], next),
  );
}
