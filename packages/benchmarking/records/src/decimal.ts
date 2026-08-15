/** Exact sealed decimal arithmetic.  Decimal spellings remain strings at the wire boundary. */
export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: bigint;
}

const DECIMAL = /^\d+(?:\.\d+)?$/;

export function parseExactDecimal(value: string): ExactDecimal | undefined {
  if (!DECIMAL.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: BigInt(fraction.length) };
}

export function exactDecimalInUnitInterval(value: string): boolean {
  const parsed = parseExactDecimal(value);
  return parsed !== undefined && parsed.coefficient > 0n && parsed.coefficient <= 10n ** parsed.scale;
}

/** `numerator / denominator >= decimal`, with no binary-number conversion. */
export function meetsExactDecimalFloor(numerator: number, denominator: number, floor: string): boolean {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return false;
  const parsed = parseExactDecimal(floor);
  return parsed !== undefined
    && BigInt(numerator) * (10n ** parsed.scale) >= BigInt(denominator) * parsed.coefficient;
}

export function scaleDecimal(value: ExactDecimal, scale: bigint): bigint {
  return value.coefficient * (10n ** (scale - value.scale));
}
