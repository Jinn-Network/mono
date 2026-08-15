const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

interface ParsedRfc3339 {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string | undefined;
  readonly offsetSign: "+" | "-" | undefined;
  readonly offsetHour: number;
  readonly offsetMinute: number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const SECONDS_PER_DAY = 86_400n;

function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function positiveModulo(dividend: bigint, divisor: bigint): bigint {
  const remainder = dividend % divisor;
  return remainder < 0n ? remainder + divisor : remainder;
}

function daysBeforeYear(year: number): bigint {
  const preceding = BigInt(year - 1);
  return 365n * preceding
    + floorDiv(preceding, 4n)
    - floorDiv(preceding, 100n)
    + floorDiv(preceding, 400n);
}

function dayIndex(year: number, month: number, day: number): bigint {
  const daysBeforeMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334] as const;
  const leapAdjustment = month > 2 && isLeapYear(year) ? 1 : 0;
  return daysBeforeYear(year)
    + BigInt(daysBeforeMonth[month - 1]! + leapAdjustment + day - 1);
}

function localSecondAt(
  parsed: ParsedRfc3339,
  second: number,
): bigint {
  const offsetMinutes = parsed.offsetSign === undefined
    ? 0
    : (parsed.offsetHour * 60 + parsed.offsetMinute) * (parsed.offsetSign === "+" ? 1 : -1);
  return dayIndex(parsed.year, parsed.month, parsed.day) * SECONDS_PER_DAY
    + BigInt(parsed.hour * 3_600 + parsed.minute * 60 + second)
    - BigInt(offsetMinutes * 60);
}

function isLeapSecondBoundary(parsed: ParsedRfc3339): boolean {
  const preceding = localSecondAt(parsed, 59);
  if (positiveModulo(preceding, SECONDS_PER_DAY) !== 86_399n) return false;
  const utcDay = floorDiv(preceding, SECONDS_PER_DAY);
  for (const candidateYear of [parsed.year - 1, parsed.year, parsed.year + 1]) {
    if (
      utcDay === dayIndex(candidateYear, 6, 30)
      || utcDay === dayIndex(candidateYear, 12, 31)
    ) {
      return true;
    }
  }
  return false;
}

function parseCalendarStrictRfc3339(value: unknown): ParsedRfc3339 | undefined {
  if (typeof value !== "string") return undefined;
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);

  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 60
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return undefined;
  }

  const parsed: ParsedRfc3339 = {
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction: match[7],
    offsetSign: match[9] as "+" | "-" | undefined,
    offsetHour,
    offsetMinute,
  };
  return parsed.second === 60 && !isLeapSecondBoundary(parsed) ? undefined : parsed;
}

/**
 * Calendar-strict RFC 3339 predicate for every benchmarking authority-bearing timestamp.
 *
 * It validates the represented civil date and every time/offset component independently, so it
 * never inherits a host parser's impossible-date normalization. The caller retains the original
 * string; this predicate does not normalize or rewrite sealed data.
 */
export function isCalendarStrictRfc3339(value: unknown): value is string {
  return parseCalendarStrictRfc3339(value) !== undefined;
}

function compareFractions(left: string | undefined, right: string | undefined): -1 | 0 | 1 {
  const width = Math.max(left?.length ?? 0, right?.length ?? 0);
  const leftPadded = (left ?? "").padEnd(width, "0");
  const rightPadded = (right ?? "").padEnd(width, "0");
  return leftPadded < rightPadded ? -1 : leftPadded > rightPadded ? 1 : 0;
}

/**
 * Exact comparison for two calendar-strict RFC 3339 instants.
 *
 * The result is undefined when either input is invalid. Numeric offsets are applied without a
 * host date parser; arbitrary decimal tails are compared exactly and retained only for the
 * comparison. A leap second occupies its own interval immediately before the following civil
 * second, even though both share the same nominal Gregorian second boundary.
 */
export function compareCalendarStrictRfc3339Instants(
  left: string,
  right: string,
): -1 | 0 | 1 | undefined {
  const parsedLeft = parseCalendarStrictRfc3339(left);
  const parsedRight = parseCalendarStrictRfc3339(right);
  if (parsedLeft === undefined || parsedRight === undefined) return undefined;

  const leftLeap = parsedLeft.second === 60;
  const rightLeap = parsedRight.second === 60;
  const leftSecond = localSecondAt(parsedLeft, Math.min(parsedLeft.second, 59))
    + (leftLeap ? 1n : 0n);
  const rightSecond = localSecondAt(parsedRight, Math.min(parsedRight.second, 59))
    + (rightLeap ? 1n : 0n);
  if (leftSecond !== rightSecond) return leftSecond < rightSecond ? -1 : 1;
  if (leftLeap !== rightLeap) return leftLeap ? -1 : 1;
  return compareFractions(parsedLeft.fraction, parsedRight.fraction);
}
