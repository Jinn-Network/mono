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
  readonly offsetSign: string | undefined;
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

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction: match[7],
    offsetSign: match[9],
    offsetHour,
    offsetMinute,
  };
}

function epochMilliseconds(parsed: ParsedRfc3339): number | undefined {
  const milliseconds = Number((parsed.fraction ?? "").slice(0, 3).padEnd(3, "0"));
  const local = Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    parsed.hour,
    parsed.minute,
    Math.min(parsed.second, 59),
    milliseconds,
  );
  const localDate = new Date(local);
  localDate.setUTCFullYear(parsed.year);
  const offsetMinutes = parsed.offsetSign === undefined
    ? 0
    : (parsed.offsetHour * 60 + parsed.offsetMinute) * (parsed.offsetSign === "+" ? 1 : -1);
  const instant = localDate.getTime() - offsetMinutes * 60_000;

  if (parsed.second === 60) {
    const preceding = new Date(instant);
    const leapSecondBoundary = preceding.getUTCHours() === 23
      && preceding.getUTCMinutes() === 59
      && (
        (preceding.getUTCMonth() === 5 && preceding.getUTCDate() === 30)
        || (preceding.getUTCMonth() === 11 && preceding.getUTCDate() === 31)
      );
    if (!leapSecondBoundary) return undefined;
  }

  const result = instant + (parsed.second === 60 ? 1_000 : 0);
  return Number.isFinite(result) ? result : undefined;
}

/**
 * Calendar-strict RFC 3339 predicate for every benchmarking authority-bearing timestamp.
 *
 * It validates the represented civil date and every time/offset component independently, so it
 * never inherits a host parser's impossible-date normalization. The caller retains the original
 * string; this predicate does not normalize or rewrite sealed data.
 */
export function isCalendarStrictRfc3339(value: unknown): value is string {
  const parsed = parseCalendarStrictRfc3339(value);
  return parsed !== undefined && epochMilliseconds(parsed) !== undefined;
}

/** Epoch projection for ordering two values only after the same calendar-strict validation. */
export function calendarStrictRfc3339EpochMilliseconds(value: string): number | undefined {
  const parsed = parseCalendarStrictRfc3339(value);
  return parsed === undefined ? undefined : epochMilliseconds(parsed);
}
