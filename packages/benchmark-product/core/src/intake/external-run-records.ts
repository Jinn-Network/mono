// SPDX-License-Identifier: Apache-2.0

/**
 * Readers for an external harness's per-attempt run dump (#2979).
 *
 * Two dialects, one normalized record. A JSONL dump and the equivalent CSV dump must produce an
 * identical `ExternalRunRecord[]`, because everything downstream — the slate validator in
 * `../run/external-import.ts`, and the journal/record synthesis after it — is written against
 * exactly one shape.
 *
 * These readers deliberately do NOT reuse `parseCanonicalJsonl` (`./binary-item-bank.ts`). That
 * helper additionally requires each line to be byte-canonical JSON and the rows to be sorted and
 * unique by key, which is right for records we seal ourselves: byte-stability is what makes a
 * digest reproducible. An external harness's dump is never byte-canonical, and refusing it for
 * that buys no safety — we re-serialize it into our own sealed records anyway. What DOES carry
 * safety is kept: UTF-8 without a BOM, LF endings, exactly one trailing LF, no blank lines, and a
 * refusal that names the 1-based row (and, for CSV, the column).
 *
 * Ordering and duplicate detection are deliberately NOT enforced here. Row order is validated as a
 * set against the sealed slate by the validator, and a duplicate is reported there naming BOTH row
 * numbers — strictly more useful than "rows must be sorted and unique".
 *
 * ## The reader/validator boundary
 *
 * The readers do SYNTAX and NORMALIZATION only. Whether `outcome` is in the closed vocabulary,
 * whether a `reason` is required or forbidden, whether `evidence`/`measurements` belong on this
 * outcome, whether `cellKey` names a real slot, and whether the timings are self-consistent are
 * all the validator's judgments — it needs to see every row to report every problem at once, and a
 * reader that threw on row 1 would defeat that.
 *
 * The one exception: a reader refuses a row it cannot NORMALIZE at all — a `durationMs` that is
 * not a non-negative integer, a malformed `name=path` evidence pair, a measurement value that is
 * not a string/number/boolean. There is no honest normalized form for those, so there is nothing
 * to hand the validator.
 */

import { refuse } from "../errors.js";

/**
 * The closed import outcome vocabulary.
 *
 * `invalidated` and `excluded` are unreachable from import by construction. The first is a
 * pinning-mismatch fact about a run WE executed — we cannot honestly synthesize it from someone
 * else's dump. The second is the flag this feature exists to deny: a slot you cannot supply is
 * reported with `error`, `timeout`, or `unrun` and a reason, and stays in the denominator.
 */
export const EXTERNAL_RUN_IMPORT_OUTCOMES = [
  "graded",
  "ungradeable",
  "error",
  "timeout",
  "unrun",
] as const;

export type ExternalRunImportOutcome = (typeof EXTERNAL_RUN_IMPORT_OUTCOMES)[number];

/** One named artifact the external harness produced for a row. */
export interface ExternalRunEvidenceRef {
  readonly name: string;
  readonly path: string;
}

/**
 * One normalized per-attempt row.
 *
 * `outcome` is a plain string, not `ExternalRunImportOutcome`: the reader carries whatever the
 * dump said so the validator can report an out-of-vocabulary value against its row number.
 * Absent optional fields are ABSENT properties, never `undefined` values and never `""` — the CSV
 * empty field and the omitted JSONL key normalize to the same thing.
 */
export interface ExternalRunRecord {
  /** 1-based DATA row: the CSV header line is not a row, so both dialects agree. */
  readonly row: number;
  readonly cellKey: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly evidence?: readonly ExternalRunEvidenceRef[];
  readonly measurements?: Readonly<Record<string, string | number | boolean>>;
}

export type ExternalRunRecordFormat = "jsonl" | "csv";

/** Evidence names and measurement names share one grammar: safe in a filename and in a column. */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NON_NEGATIVE_INTEGER_RE = /^(0|[1-9][0-9]*)$/;
/** C0 and C1 controls, plus DEL. LF and CR are already excluded by the line hygiene above. */
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
const PADDED_RE = /^\s|\s$/;

const FIXED_COLUMNS = [
  "cellKey",
  "outcome",
  "reason",
  "startedAt",
  "endedAt",
  "durationMs",
  "evidence",
] as const;

type FixedColumn = (typeof FIXED_COLUMNS)[number];

/** Splits shared line hygiene from the dialects: both refuse identically, and first. */
function splitLines(text: string, label: string): string[] {
  if (text.length === 0) refuse("validation", label, `${label} must contain at least one row`);
  if (text.charCodeAt(0) === 0xfeff) {
    refuse("validation", label, `${label} must not begin with a byte order mark (UTF-8, no BOM)`);
  }
  if (text.includes("\r")) refuse("validation", label, `${label} must use LF line endings`);
  if (!text.endsWith("\n")) refuse("validation", label, `${label} must end with one LF`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    refuse("validation", label, `${label} must not contain blank lines`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------------------------

const JSONL_LABEL = "external run records";

export function readExternalRunRecordsJsonl(text: string): ExternalRunRecord[] {
  const lines = splitLines(text, JSONL_LABEL);
  return lines.map((line, index) => readJsonlRow(line, index + 1));
}

function readJsonlRow(line: string, row: number): ExternalRunRecord {
  const path = `row ${row}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    refuse("validation", path, `${path}: line is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("validation", path, `${path}: line must be a JSON object`);
  }
  const source = parsed as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    if (!(FIXED_COLUMNS as readonly string[]).includes(key) && key !== "measurements") {
      refuse("validation", path, `${path}: unknown field "${key}"`);
    }
  }

  const cellKey = requiredJsonlString(source, "cellKey", path);
  const outcome = requiredJsonlString(source, "outcome", path);

  const record: {
    -readonly [K in keyof ExternalRunRecord]: ExternalRunRecord[K];
  } = { row, cellKey, outcome };

  const reason = optionalJsonlString(source, "reason", path);
  if (reason !== undefined) record.reason = reason;
  const startedAt = optionalJsonlString(source, "startedAt", path);
  if (startedAt !== undefined) record.startedAt = startedAt;
  const endedAt = optionalJsonlString(source, "endedAt", path);
  if (endedAt !== undefined) record.endedAt = endedAt;

  if (source.durationMs !== undefined) {
    const duration = source.durationMs;
    if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0) {
      refuse("validation", path, `${path}: durationMs must be a non-negative integer`);
    }
    record.durationMs = duration;
  }

  if (source.evidence !== undefined) {
    if (!Array.isArray(source.evidence)) {
      refuse("validation", path, `${path}: evidence must be a list of {name, path} objects`);
    }
    if (source.evidence.length === 0) {
      refuse("validation", path, `${path}: evidence must not be empty (omit the field instead)`);
    }
    record.evidence = source.evidence.map((entry): ExternalRunEvidenceRef => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        refuse("validation", path, `${path}: evidence entries must be {name, path} objects`);
      }
      const candidate = entry as Record<string, unknown>;
      for (const key of Object.keys(candidate)) {
        if (key !== "name" && key !== "path") {
          refuse("validation", path, `${path}: evidence entry has unknown field "${key}"`);
        }
      }
      const name = candidate.name;
      const location = candidate.path;
      if (typeof name !== "string" || typeof location !== "string") {
        refuse("validation", path, `${path}: evidence entries must be {name, path} objects`);
      }
      return normalizeEvidenceEntry(name, location, path);
    });
    assertUniqueEvidenceNames(record.evidence, path);
  }

  if (source.measurements !== undefined) {
    const measurements = source.measurements;
    if (typeof measurements !== "object" || measurements === null || Array.isArray(measurements)) {
      refuse("validation", path, `${path}: measurements must be an object`);
    }
    const entries = Object.entries(measurements as Record<string, unknown>);
    if (entries.length === 0) {
      refuse("validation", path, `${path}: measurements must not be empty (omit the field instead)`);
    }
    const normalized: Record<string, string | number | boolean> = {};
    for (const [name, value] of entries) {
      if (!NAME_RE.test(name)) {
        refuse("validation", path, `${path}: measurement name "${name}" must match ${NAME_RE.source}`);
      }
      if (typeof value === "string") {
        assertNoControls(value, path, `measurement "${name}"`);
        normalized[name] = value;
      } else if (typeof value === "boolean") {
        normalized[name] = value;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        normalized[name] = value;
      } else {
        refuse(
          "validation",
          path,
          `${path}: measurement "${name}" must be a string, a finite number, or a boolean`,
        );
      }
    }
    record.measurements = normalized;
  }

  return record;
}

function requiredJsonlString(source: Record<string, unknown>, field: string, path: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    refuse("validation", path, `${path}: ${field} is required and must be a non-empty string`);
  }
  assertNoControls(value, path, field);
  return value;
}

function optionalJsonlString(
  source: Record<string, unknown>,
  field: string,
  path: string,
): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") refuse("validation", path, `${path}: ${field} must be a string`);
  assertNoControls(value, path, field);
  return value;
}

// ---------------------------------------------------------------------------------------------
// CSV — a deliberately restricted dialect
// ---------------------------------------------------------------------------------------------

const CSV_LABEL = "external run records CSV";

/**
 * Reads the restricted CSV dialect: one `,` separator, NO quoting, NO escapes.
 *
 * This repo has no CSV parser, and RFC 4180 quoting is exactly where a silent misparse turns into
 * a wrong denominator. Rather than write a half-parser, the dialect forbids everything ambiguous:
 * a field may not contain `,`, `"`, or any control character, and may not be padded with
 * whitespace. An unquoted embedded comma therefore surfaces as a field-count disagreement with the
 * header — refused, naming the row — rather than as a silently shifted column.
 */
export function readExternalRunRecordsCsv(text: string): ExternalRunRecord[] {
  const lines = splitLines(text, CSV_LABEL);
  const [headerLine, ...dataLines] = lines;
  const columns = readCsvHeader(headerLine!);
  if (dataLines.length === 0) {
    refuse("validation", CSV_LABEL, `${CSV_LABEL} must contain at least one row after the header`);
  }
  return dataLines.map((line, index) => readCsvRow(line, index + 1, columns));
}

interface CsvColumns {
  readonly names: readonly string[];
  readonly fixed: ReadonlyMap<FixedColumn, number>;
  readonly measurements: ReadonlyMap<string, number>;
}

function readCsvHeader(headerLine: string): CsvColumns {
  const names = headerLine.split(",");
  const fixed = new Map<FixedColumn, number>();
  const measurements = new Map<string, number>();
  const seen = new Set<string>();

  names.forEach((name, index) => {
    if (seen.has(name)) {
      refuse("validation", "header", `${CSV_LABEL}: duplicate column "${name}"`);
    }
    seen.add(name);
    if ((FIXED_COLUMNS as readonly string[]).includes(name)) {
      fixed.set(name as FixedColumn, index);
      return;
    }
    if (name.startsWith("m.")) {
      const measurementName = name.slice(2);
      if (!NAME_RE.test(measurementName)) {
        refuse(
          "validation",
          "header",
          `${CSV_LABEL}: measurement column "${name}" must be "m." followed by ${NAME_RE.source}`,
        );
      }
      measurements.set(measurementName, index);
      return;
    }
    refuse(
      "validation",
      "header",
      `${CSV_LABEL}: unknown column "${name}" (expected one of ${FIXED_COLUMNS.join(", ")}, or an "m.<name>" measurement column)`,
    );
  });

  if (!fixed.has("cellKey")) {
    refuse("validation", "header", `${CSV_LABEL}: header must declare "cellKey"`);
  }
  if (!fixed.has("outcome")) {
    refuse("validation", "header", `${CSV_LABEL}: header must declare "outcome"`);
  }
  return { names, fixed, measurements };
}

function readCsvRow(line: string, row: number, columns: CsvColumns): ExternalRunRecord {
  const rowPath = `row ${row}`;
  const fields = line.split(",");
  if (fields.length !== columns.names.length) {
    refuse(
      "validation",
      rowPath,
      `${rowPath} has ${fields.length} fields but the header declares ${columns.names.length}` +
        ` — this dialect has no quoting, so a field may not contain ","`,
    );
  }

  /** Reads one column, refusing on the dialect hazards. An empty field means ABSENT. */
  const read = (column: FixedColumn): string | undefined => {
    const index = columns.fixed.get(column);
    if (index === undefined) return undefined;
    return readCsvField(fields[index]!, row, column);
  };

  const cellKey = read("cellKey");
  if (cellKey === undefined) {
    refuse("validation", `${rowPath}, column cellKey`, `${rowPath}: cellKey must not be empty`);
  }
  const outcome = read("outcome");
  if (outcome === undefined) {
    refuse("validation", `${rowPath}, column outcome`, `${rowPath}: outcome must not be empty`);
  }

  const record: {
    -readonly [K in keyof ExternalRunRecord]: ExternalRunRecord[K];
  } = { row, cellKey, outcome };

  const reason = read("reason");
  if (reason !== undefined) record.reason = reason;
  const startedAt = read("startedAt");
  if (startedAt !== undefined) record.startedAt = startedAt;
  const endedAt = read("endedAt");
  if (endedAt !== undefined) record.endedAt = endedAt;

  const durationMs = read("durationMs");
  if (durationMs !== undefined) {
    if (!NON_NEGATIVE_INTEGER_RE.test(durationMs) || !Number.isSafeInteger(Number(durationMs))) {
      refuse(
        "validation",
        `${rowPath}, column durationMs`,
        `${rowPath}: durationMs must be a non-negative integer, got "${durationMs}"`,
      );
    }
    record.durationMs = Number(durationMs);
  }

  const evidence = read("evidence");
  if (evidence !== undefined) {
    const path = `${rowPath}, column evidence`;
    const refs = evidence.split(";").map((pair) => {
      const halves = pair.split("=");
      if (halves.length !== 2) {
        refuse(
          "validation",
          path,
          `${rowPath}: evidence must be "name=path" pairs separated by ";", got "${pair}"`,
        );
      }
      return normalizeEvidenceEntry(halves[0]!, halves[1]!, path);
    });
    assertUniqueEvidenceNames(refs, path);
    record.evidence = refs;
  }

  const measurements: Record<string, string | number | boolean> = {};
  for (const [name, index] of columns.measurements) {
    const value = readCsvField(fields[index]!, row, `m.${name}`);
    // CSV carries no type information, so every measurement read from CSV is a string. A JSONL
    // dump wanting numeric or boolean measurements says so in its own types.
    if (value !== undefined) measurements[name] = value;
  }
  if (Object.keys(measurements).length > 0) record.measurements = measurements;

  return record;
}

function readCsvField(field: string, row: number, column: string): string | undefined {
  const path = `row ${row}, column ${column}`;
  if (field.length === 0) return undefined;
  if (PADDED_RE.test(field)) {
    refuse(
      "validation",
      path,
      `${path}: field has leading or trailing whitespace; this dialect never trims silently`,
    );
  }
  if (field.includes('"')) {
    refuse("validation", path, `${path}: field must not contain '"' (this dialect has no quoting)`);
  }
  if (CONTROL_RE.test(field)) {
    refuse("validation", path, `${path}: field must not contain control characters`);
  }
  return field;
}

// ---------------------------------------------------------------------------------------------
// Shared normalization
// ---------------------------------------------------------------------------------------------

function normalizeEvidenceEntry(name: string, location: string, path: string): ExternalRunEvidenceRef {
  if (!NAME_RE.test(name)) {
    refuse("validation", path, `${path}: evidence name "${name}" must match ${NAME_RE.source}`);
  }
  if (location.length === 0) {
    refuse("validation", path, `${path}: evidence "${name}" has an empty path`);
  }
  if (location.includes(";") || location.includes("=")) {
    refuse("validation", path, `${path}: evidence path for "${name}" must not contain ";" or "="`);
  }
  assertNoControls(location, path, `evidence path for "${name}"`);
  return { name, path: location };
}

function assertUniqueEvidenceNames(refs: readonly ExternalRunEvidenceRef[], path: string): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.name)) {
      refuse("validation", path, `${path}: duplicate evidence name "${ref.name}"`);
    }
    seen.add(ref.name);
  }
}

function assertNoControls(value: string, path: string, what: string): void {
  if (CONTROL_RE.test(value)) {
    refuse("validation", path, `${path}: ${what} must not contain control characters`);
  }
}

/** Dispatches on the declared format; the two readers agree on the normalized output. */
export function readExternalRunRecords(
  text: string,
  format: ExternalRunRecordFormat,
): ExternalRunRecord[] {
  return format === "jsonl" ? readExternalRunRecordsJsonl(text) : readExternalRunRecordsCsv(text);
}
