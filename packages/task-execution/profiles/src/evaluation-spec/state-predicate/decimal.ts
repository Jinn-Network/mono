import { DECIMAL_STRING_PATTERN } from "../verdict-rule.js";

/**
 * Exact decimal arithmetic for the state-predicate comparators. Every quantity this family
 * compares (wei, gas, token amounts, chain seconds) is a decimal STRING — sealed bytes admit
 * only I-JSON safe integers (src/bytes.ts), and wei exceeds that range by 200+ bits. All
 * comparison is scaled-BigInt: no float, no epsilon, no locale.
 */
export interface DecimalParts {
  readonly negative: boolean;
  readonly intDigits: string;
  readonly fracDigits: string;
}

export function parseDecimal(operand: string): DecimalParts | undefined {
  if (!DECIMAL_STRING_PATTERN.test(operand)) return undefined;
  const negative = operand.startsWith("-");
  const unsigned = negative ? operand.slice(1) : operand;
  const [intDigits, fracDigits = ""] = unsigned.split(".");
  return { negative, intDigits: intDigits ?? "0", fracDigits };
}

function scaled(parts: DecimalParts, scale: number): bigint {
  return BigInt(
    (parts.negative ? "-" : "") + parts.intDigits + parts.fracDigits.padEnd(scale, "0"),
  );
}

function alignedPair(left: string, right: string): [bigint, bigint] | undefined {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (a === undefined || b === undefined) return undefined;
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length);
  return [scaled(a, scale), scaled(b, scale)];
}

/** -1 | 0 | 1 when both operands parse as decimals; `undefined` when either does not. */
export function compareDecimalExact(left: string, right: string): -1 | 0 | 1 | undefined {
  const pair = alignedPair(left, right);
  if (pair === undefined) return undefined;
  const [a, b] = pair;
  return a < b ? -1 : a > b ? 1 : 0;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** |observed - expected| <= tolerance, exactly. `undefined` when any operand is not decimal. */
export function withinAbsolute(
  observed: string,
  expected: string,
  tolerance: string,
): boolean | undefined {
  const a = parseDecimal(observed);
  const b = parseDecimal(expected);
  const t = parseDecimal(tolerance);
  if (a === undefined || b === undefined || t === undefined) return undefined;
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length, t.fracDigits.length);
  return absolute(scaled(a, scale) - scaled(b, scale)) <= absolute(scaled(t, scale));
}

/** |observed - expected| <= |expected| * tolerance, exactly (tolerance is a fraction: "0.01" = 1%). */
export function withinRelative(
  observed: string,
  expected: string,
  tolerance: string,
): boolean | undefined {
  const a = parseDecimal(observed);
  const b = parseDecimal(expected);
  const t = parseDecimal(tolerance);
  if (a === undefined || b === undefined || t === undefined) return undefined;
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length);
  const toleranceScale = t.fracDigits.length;
  const difference = absolute(scaled(a, scale) - scaled(b, scale)) * 10n ** BigInt(toleranceScale);
  const bound = absolute(scaled(b, scale)) * absolute(scaled(t, toleranceScale));
  return difference <= bound;
}

const HEX_WORD = /^0x[0-9a-f]{64}$/;

/** A 32-byte big-endian word as an unsigned decimal string; `undefined` if not a word. */
export function decodeUint256(word: string): string | undefined {
  if (!HEX_WORD.test(word)) return undefined;
  return BigInt(word).toString(10);
}

/** A 32-byte big-endian word as a two's-complement signed decimal string. */
export function decodeInt256(word: string): string | undefined {
  if (!HEX_WORD.test(word)) return undefined;
  const raw = BigInt(word);
  const limit = 1n << 255n;
  return (raw >= limit ? raw - (1n << 256n) : raw).toString(10);
}

/** A non-negative count as a decimal string (measurements are never JSON numbers). */
export function formatUint(value: number | bigint): string {
  return BigInt(value).toString(10);
}
