import { recordDigest } from "./hashing.js";

const encoder = new TextEncoder();

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("Sealed JSON strings must not contain unpaired UTF-16 surrogates.");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("Sealed JSON strings must not contain unpaired UTF-16 surrogates.");
    }
  }
}

function cloneCanonicalJsonValue(value: unknown): CanonicalJsonValue {
  const active = new WeakSet<object>();

  const visit = (candidate: unknown): CanonicalJsonValue => {
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      assertUnicodeScalarString(candidate);
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate)) {
        throw new Error(
          "Sealed JSON numbers must be exact I-JSON safe integers; " +
            "fractional or non-safe-integer quantities must be encoded as strings (§7.14).",
        );
      }
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new Error("Sealed documents must contain only JSON values.");
    }
    if (active.has(candidate)) {
      throw new Error("Sealed JSON values must not contain cycles.");
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new Error("Sealed JSON arrays must use the standard Array prototype.");
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
          throw new Error("Sealed JSON arrays must have a valid data-property length.");
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
            throw new Error("Sealed JSON arrays must not contain non-index properties.");
          }
        }
        const output: CanonicalJsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true
          ) {
            throw new Error("Sealed JSON arrays must be dense data-property arrays.");
          }
          output.push(visit(descriptor.value));
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Sealed JSON objects must use a safe plain-object prototype.");
      }
      const output = Object.create(null) as Record<string, CanonicalJsonValue>;
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") {
          throw new Error("Sealed JSON objects must not contain symbol properties.");
        }
        assertUnicodeScalarString(key);
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new Error("Sealed JSON objects must contain only enumerable data properties.");
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

function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function serializeCanonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((element) => serializeCanonicalJson(element)).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareCodeUnitStrings);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function sealJson(value: unknown): { bytes: Uint8Array; digest: `sha256:${string}` } {
  const bytes = encoder.encode(serializeCanonicalJson(cloneCanonicalJsonValue(value)));
  return { bytes, digest: recordDigest(bytes) };
}
