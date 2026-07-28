export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export class IJsonNumberError extends Error {
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
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
