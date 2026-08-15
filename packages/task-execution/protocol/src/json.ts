export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export class IJsonNumberError extends Error {
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

class InvalidIJsonValueError extends Error {
  readonly category = "invalid-document" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidIJsonValueError";
  }
}

/**
 * Retained public error for callers that distinguish malformed arrays. Explicit `undefined`
 * elements and holes both violate the stack-wide dense-array rule (§7.1/§7.24).
 */
export class UndefinedArrayElementError extends InvalidIJsonValueError {
  constructor() {
    super("sealed JSON arrays must be dense and must not contain undefined");
    this.name = "UndefinedArrayElementError";
  }
}

/** Sealed families admit only exact I-JSON integers; fractional quantities are strings (§6.1). */
export function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new InvalidIJsonValueError("sealed JSON strings must not contain unpaired surrogates");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new InvalidIJsonValueError("sealed JSON strings must not contain unpaired surrogates");
    }
  }
}

/** Validate and snapshot the fail-closed JSON value domain before canonical emission. */
export function cloneIJsonValue(value: unknown): JsonValue {
  const active = new WeakSet<object>();

  const visit = (candidate: unknown): JsonValue => {
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      assertUnicodeScalarString(candidate);
      return candidate;
    }
    if (typeof candidate === "number") {
      assertIJsonInteger(candidate);
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new InvalidIJsonValueError("sealed documents must contain only JSON values");
    }

    if (active.has(candidate)) {
      throw new InvalidIJsonValueError("sealed JSON values must not contain cycles");
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new InvalidIJsonValueError("sealed JSON arrays must use the standard prototype");
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > 0xffff_ffff
        ) {
          throw new InvalidIJsonValueError("sealed JSON arrays must have a valid length");
        }
        const length = lengthDescriptor.value as number;
        for (const key of Reflect.ownKeys(descriptors)) {
          if (
            typeof key !== "string" ||
            (
              key !== "length" &&
              (
                !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
                Number(key) >= length ||
                Number(key) > 0xffff_fffe
              )
            )
          ) {
            throw new InvalidIJsonValueError("sealed JSON arrays must not have non-index properties");
          }
        }
        const output: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true ||
            descriptor.value === undefined
          ) {
            throw new UndefinedArrayElementError();
          }
          output.push(visit(descriptor.value));
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidIJsonValueError("sealed JSON objects must use a plain-object prototype");
      }
      const output = Object.create(null) as Record<string, JsonValue>;
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") {
          throw new InvalidIJsonValueError("sealed JSON objects must not contain symbol properties");
        }
        assertUnicodeScalarString(key);
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new InvalidIJsonValueError(
            "sealed JSON objects must contain only enumerable data properties",
          );
        }
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value),
          writable: true,
        });
      }
      return output;
    } finally {
      active.delete(candidate);
    }
  };

  return visit(value);
}
