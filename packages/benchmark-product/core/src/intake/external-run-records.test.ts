/**
 * Reader coverage for external run-record intake (#2979).
 *
 * Two properties carry the weight here. First, the two dialects are one format: a JSONL dump and
 * the equivalent CSV dump must normalize to the same array, because everything downstream (the
 * slate validator, the journal synthesis) is written against exactly one record shape. Second,
 * every dialect hazard refuses loudly rather than misparsing — an external harness's dump is the
 * denominator of a published claim, and a silently dropped or mis-split field is a wrong number
 * nobody can see.
 */

import { describe, expect, it } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import {
  readExternalRunRecords,
  readExternalRunRecordsCsv,
  readExternalRunRecordsJsonl,
} from "./external-run-records.js";

const BOM = "\uFEFF";
const DIGEST_A = "9f0a".padEnd(64, "0");
const DIGEST_B = "11cd".padEnd(64, "1");
const CELL_A = `${DIGEST_A}/alpha/1`;
const CELL_B = `${DIGEST_B}/alpha/1`;

function refusal(run: () => unknown): BenchmarkProductError {
  try {
    run();
  } catch (error) {
    if (error instanceof BenchmarkProductError) return error;
    throw error;
  }
  throw new Error("expected a refusal, got a value");
}

describe("readExternalRunRecords — the two dialects are one format", () => {
  const jsonl = [
    JSON.stringify({
      cellKey: CELL_A,
      outcome: "graded",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      evidence: [
        { name: "log", path: "logs/a.txt" },
        { name: "patch", path: "p.diff" },
      ],
      measurements: { reward: "1" },
    }),
    JSON.stringify({ cellKey: CELL_B, outcome: "timeout", reason: "wall clock exceeded" }),
  ].join("\n") + "\n";

  const csv = [
    "cellKey,outcome,reason,startedAt,endedAt,durationMs,evidence,m.reward",
    `${CELL_A},graded,,2026-01-01T00:00:00Z,2026-01-01T00:00:01Z,1000,log=logs/a.txt;patch=p.diff,1`,
    `${CELL_B},timeout,wall clock exceeded,,,,,`,
  ].join("\n") + "\n";

  it("produces identical normalized records from equivalent JSONL and CSV", () => {
    expect(readExternalRunRecordsCsv(csv)).toEqual(readExternalRunRecordsJsonl(jsonl));
  });

  it("normalizes an empty CSV field as absent, never as the empty string", () => {
    const [graded, timedOut] = readExternalRunRecordsCsv(csv);
    expect(graded).toEqual({
      row: 1,
      cellKey: CELL_A,
      outcome: "graded",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      evidence: [
        { name: "log", path: "logs/a.txt" },
        { name: "patch", path: "p.diff" },
      ],
      measurements: { reward: "1" },
    });
    expect(Object.keys(graded!)).not.toContain("reason");
    expect(timedOut).toEqual({ row: 2, cellKey: CELL_B, outcome: "timeout", reason: "wall clock exceeded" });
    expect(Object.keys(timedOut!)).not.toContain("measurements");
    expect(Object.keys(timedOut!)).not.toContain("evidence");
  });

  it("numbers data rows from 1 in both dialects, so the header line never shifts a row number", () => {
    expect(readExternalRunRecordsJsonl(jsonl).map((record) => record.row)).toEqual([1, 2]);
    expect(readExternalRunRecordsCsv(csv).map((record) => record.row)).toEqual([1, 2]);
  });

  it("dispatches on the format argument", () => {
    expect(readExternalRunRecords(csv, "csv")).toEqual(readExternalRunRecords(jsonl, "jsonl"));
  });
});

describe("readExternalRunRecordsJsonl — hygiene refusals", () => {
  const good = JSON.stringify({ cellKey: CELL_A, outcome: "unrun", reason: "not attempted" });

  it("refuses empty input", () => {
    expect(refusal(() => readExternalRunRecordsJsonl("")).message).toMatch(/at least one row/);
  });

  it("refuses CR anywhere", () => {
    expect(refusal(() => readExternalRunRecordsJsonl(`${good}\r\n`)).message).toMatch(/LF line endings/);
  });

  it("refuses a BOM", () => {
    expect(refusal(() => readExternalRunRecordsJsonl(`${BOM}${good}\n`)).message).toMatch(/byte order mark/i);
  });

  it("refuses a missing trailing LF", () => {
    expect(refusal(() => readExternalRunRecordsJsonl(good)).message).toMatch(/must end with one LF/);
  });

  it("refuses a blank line", () => {
    expect(refusal(() => readExternalRunRecordsJsonl(`${good}\n\n`)).message).toMatch(/blank lines/);
  });

  it("refuses a line that is not valid JSON, naming the 1-based row", () => {
    const error = refusal(() => readExternalRunRecordsJsonl(`${good}\n{oops\n`));
    expect(error.message).toMatch(/not valid JSON/);
    expect(error.issues[0]!.path).toBe("row 2");
  });

  it("refuses a line that is not a JSON object", () => {
    const error = refusal(() => readExternalRunRecordsJsonl(`[1,2]\n`));
    expect(error.message).toMatch(/must be a JSON object/);
    expect(error.issues[0]!.path).toBe("row 1");
  });

  it("refuses an unknown field", () => {
    const line = JSON.stringify({ cellKey: CELL_A, outcome: "unrun", reason: "x", excluded: true });
    expect(refusal(() => readExternalRunRecordsJsonl(`${line}\n`)).message).toMatch(/unknown field "excluded"/);
  });

  it("accepts unsorted rows and duplicate cellKeys — ordering and duplicates are the validator's job", () => {
    const rows = [
      JSON.stringify({ cellKey: CELL_B, outcome: "unrun", reason: "x" }),
      JSON.stringify({ cellKey: CELL_A, outcome: "unrun", reason: "y" }),
      JSON.stringify({ cellKey: CELL_A, outcome: "unrun", reason: "z" }),
    ].join("\n") + "\n";
    expect(readExternalRunRecordsJsonl(rows).map((record) => record.cellKey)).toEqual([CELL_B, CELL_A, CELL_A]);
  });

  it("accepts an outcome outside the vocabulary — the vocabulary is the validator's job", () => {
    const line = JSON.stringify({ cellKey: CELL_A, outcome: "skipped" });
    expect(readExternalRunRecordsJsonl(`${line}\n`)[0]!.outcome).toBe("skipped");
  });

  it("refuses a non-integer durationMs", () => {
    const line = JSON.stringify({ cellKey: CELL_A, outcome: "unrun", reason: "x", durationMs: 1.5 });
    expect(refusal(() => readExternalRunRecordsJsonl(`${line}\n`)).message).toMatch(/non-negative integer/);
  });

  it("refuses a malformed evidence entry", () => {
    const line = JSON.stringify({ cellKey: CELL_A, outcome: "graded", evidence: [{ name: "log" }] });
    expect(refusal(() => readExternalRunRecordsJsonl(`${line}\n`)).message).toMatch(/evidence/);
  });

  it("refuses duplicate evidence names within a row", () => {
    const line = JSON.stringify({
      cellKey: CELL_A,
      outcome: "graded",
      evidence: [{ name: "log", path: "a" }, { name: "log", path: "b" }],
    });
    expect(refusal(() => readExternalRunRecordsJsonl(`${line}\n`)).message).toMatch(/duplicate evidence name/);
  });

  it("refuses an empty evidence list and an empty measurements map rather than inventing an absent/empty distinction CSV cannot express", () => {
    const emptyEvidence = JSON.stringify({ cellKey: CELL_A, outcome: "graded", evidence: [] });
    const emptyMeasurements = JSON.stringify({ cellKey: CELL_A, outcome: "graded", measurements: {} });
    expect(refusal(() => readExternalRunRecordsJsonl(`${emptyEvidence}\n`)).message).toMatch(/must not be empty/);
    expect(refusal(() => readExternalRunRecordsJsonl(`${emptyMeasurements}\n`)).message).toMatch(/must not be empty/);
  });
});

describe("readExternalRunRecordsCsv — dialect refusals", () => {
  const header = "cellKey,outcome,reason";
  const body = `${CELL_A},unrun,not attempted`;
  const good = `${header}\n${body}\n`;

  it("reads the restricted dialect", () => {
    expect(readExternalRunRecordsCsv(good)).toEqual([
      { row: 1, cellKey: CELL_A, outcome: "unrun", reason: "not attempted" },
    ]);
  });

  it("refuses a BOM", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`${BOM}${good}`)).message).toMatch(/byte order mark/i);
  });

  it("refuses CR", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`${header}\r\n${body}\r\n`)).message).toMatch(/LF line endings/);
  });

  it("refuses a header alone with no data rows", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`${header}\n`)).message).toMatch(/at least one row/);
  });

  it("refuses an unknown column", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header},excluded\n${body},yes\n`));
    expect(error.message).toMatch(/unknown column "excluded"/);
    expect(error.issues[0]!.path).toBe("header");
  });

  it("refuses a duplicate column", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`${header},reason\n${body},again\n`)).message)
      .toMatch(/duplicate column "reason"/);
  });

  it("refuses a header missing cellKey or outcome", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`cellKey,reason\n${CELL_A},x\n`)).message)
      .toMatch(/must declare "outcome"/);
  });

  it("refuses a row whose field count disagrees with the header — this is what an unquoted embedded comma becomes", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header}\n${CELL_A},unrun,ran out, of time\n`));
    expect(error.message).toMatch(/4 fields[\s\S]*header declares 3/);
    expect(error.issues[0]!.path).toBe("row 1");
  });

  it("refuses an embedded quote, naming row and column", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header}\n${CELL_A},unrun,it said "no"\n`));
    expect(error.message).toMatch(/must not contain/);
    expect(error.issues[0]!.path).toBe("row 1, column reason");
  });

  it("refuses an embedded control character, naming row and column", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header}\n${CELL_A},unrun,a\u0007b\n`));
    expect(error.issues[0]!.path).toBe("row 1, column reason");
  });

  it("refuses a whitespace-padded field rather than silently trimming it", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header}\n${CELL_A},unrun, padded\n`));
    expect(error.message).toMatch(/leading or trailing whitespace/);
    expect(error.issues[0]!.path).toBe("row 1, column reason");
  });

  it("refuses a non-integer durationMs, naming row and column", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header},durationMs\n${body},1.5\n`));
    expect(error.message).toMatch(/non-negative integer/);
    expect(error.issues[0]!.path).toBe("row 1, column durationMs");
  });

  it("refuses a malformed evidence pair", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header},evidence\n${body},logs/a.txt\n`));
    expect(error.message).toMatch(/name=path/);
    expect(error.issues[0]!.path).toBe("row 1, column evidence");
  });

  it("refuses an evidence pair whose path carries a separator", () => {
    const error = refusal(() => readExternalRunRecordsCsv(`${header},evidence\n${body},log=a=b\n`));
    expect(error.issues[0]!.path).toBe("row 1, column evidence");
  });

  it("refuses a blank line", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`${good}\n`)).message).toMatch(/blank lines/);
  });

  it("refuses a missing trailing LF", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`${header}\n${body}`)).message).toMatch(/must end with one LF/);
  });

  it("refuses an unknown measurement column name", () => {
    expect(refusal(() => readExternalRunRecordsCsv(`${header},m.bad name\n${body},1\n`)).message)
      .toMatch(/unknown column|measurement column/);
  });
});
