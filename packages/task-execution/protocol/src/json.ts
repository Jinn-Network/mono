export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export class IJsonNumberError extends Error {
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

/** Sealed families admit only exact I-JSON integers; fractional quantities are strings (§6.1). */
export function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}
