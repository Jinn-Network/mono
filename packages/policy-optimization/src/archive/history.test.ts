// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { OutcomesProjectionRow, WaveReportRow } from "../wave-types.js";
import { evaluatedHistory } from "./history.js";

const METHOD = { id: "urn:jinn:benchmarking:method:avg-at-k", version: "1.0.0" };
const SUBJECT = `sha256:${"1".repeat(64)}`;
const OTHER = `sha256:${"2".repeat(64)}`;

function report(waveNumber: number, value: string, fill = "0", tupleDigest = SUBJECT): WaveReportRow {
  return {
    reportDigest: `sha256:${fill.repeat(64).slice(0, 64)}`,
    waveNumber,
    tupleDigest,
    method: METHOD,
    value,
  };
}

function outcome(
  bucket: OutcomesProjectionRow["bucket"],
  inputRefs: readonly string[],
  tupleDigest = SUBJECT,
): OutcomesProjectionRow {
  return { inputRefs, tupleDigest, bucket, passRate: { num: 1, den: 2 } };
}

describe("evaluatedHistory", () => {
  it("selects only the named tuple's rows", () => {
    const history = evaluatedHistory(
      [report(1, "0.5", "a"), report(1, "0.9", "b", OTHER)],
      [outcome("organic", ["sha256:x"]), outcome("organic", ["sha256:y"], OTHER)],
      SUBJECT,
    );
    expect(history.tupleDigest).toBe(SUBJECT);
    expect(history.evaluations.map((row) => row.value)).toEqual(["0.5"]);
    expect(history.observations.map((row) => row.inputRefs)).toEqual([["sha256:x"]]);
  });

  it("carries Report values verbatim — no statistic, no summary", () => {
    const history = evaluatedHistory([report(1, "0.500"), report(2, "0.75")], [], SUBJECT);
    expect(history.evaluations.map((row) => row.value)).toEqual(["0.500", "0.75"]);
    expect(Object.keys(history).sort())
      .toEqual(["evaluations", "observations", "tupleDigest", "waves"]);
  });

  it("orders by wave, then method, then Report digest, regardless of input order", () => {
    const rows = [report(3, "0.3", "c"), report(1, "0.1", "b"), report(1, "0.1", "a")];
    expect(evaluatedHistory(rows, [], SUBJECT).evaluations.map((row) => row.reportDigest))
      .toEqual(evaluatedHistory([...rows].reverse(), [], SUBJECT)
        .evaluations.map((row) => row.reportDigest));
    expect(evaluatedHistory(rows, [], SUBJECT).evaluations.map((row) => row.waveNumber))
      .toEqual([1, 1, 3]);
  });

  it("deduplicates and ascends the wave list", () => {
    expect(evaluatedHistory([report(2, "a", "a"), report(1, "b", "b"), report(2, "c", "c")], [], SUBJECT).waves)
      .toEqual([1, 2]);
  });

  it("keeps observations beside evaluations rather than mixed into them", () => {
    const history = evaluatedHistory(
      [report(1, "0.5", "a")],
      [outcome("organic", ["sha256:z"]), outcome("benchmark", ["sha256:y"])],
      SUBJECT,
    );
    expect(history.observations.map((row) => row.bucket)).toEqual(["benchmark", "organic"]);
    expect(history.evaluations).toHaveLength(1);
  });

  it("is empty, not absent, for a tuple nothing has measured", () => {
    expect(evaluatedHistory([], [], SUBJECT))
      .toEqual({ tupleDigest: SUBJECT, evaluations: [], observations: [], waves: [] });
  });
});
