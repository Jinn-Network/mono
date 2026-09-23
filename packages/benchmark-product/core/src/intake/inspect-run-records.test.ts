// SPDX-License-Identifier: Apache-2.0

/**
 * Inspect `.eval` named reader for `run import --from inspect` (#3992).
 *
 * The fixture is SYNTHETIC: JSON objects in the official `read_eval_log` dump shape
 * (EvalLog `status`, `eval.model`, `samples[].id` / `epoch` / `scores`). They are not a
 * preserved live Inspect `.eval` zip.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey } from "@jinn-network/benchmarking-records";
import {
  INSPECT_MULTI_SCORER_SELECTION_SCHEMA,
  INSPECT_SELECTION_SCHEMA,
  type InspectSelectionManifest,
} from "../runtime/inspect/manifest.js";
import {
  digestBySampleIdFromSuite,
  sampleIdByDigestFromSuite,
} from "../runtime/suite-protocol/from-inspect.js";
import type { SuiteProtocolSelection } from "../runtime/suite-protocol/manifest.js";
import { readInspectRunRecords } from "./inspect-run-records.js";

const digestHello = "ab".repeat(32);
const digestOracle = "cd".repeat(32);

const suite: SuiteProtocolSelection = {
  schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
  protocol: "inspect-eval",
  coverage: "custom",
  datasetId: "hermetic",
  datasetRevision: "ee".repeat(32),
  selectedTaskNames: ["hello-world", "oracle-fix"],
  datasetTaskCount: 12,
  replicates: 1,
  atifRequired: false,
  items: [
    { taskName: "hello-world", taskSha256: digestHello },
    { taskName: "oracle-fix", taskSha256: digestOracle },
  ],
};

const armId = "one";
const expected = [
  { cellKey: cellKey(digestHello, armId, 1), taskDigest: digestHello, armId, replicate: 1 },
  { cellKey: cellKey(digestOracle, armId, 1), taskDigest: digestOracle, armId, replicate: 1 },
];

const v1Manifest = {
  schema: INSPECT_SELECTION_SCHEMA,
  scorer: { name: "match", passValue: "C" },
  arms: [{ armId, model: "mockllm/one" }],
} as InspectSelectionManifest;

const v2Manifest = {
  schema: INSPECT_MULTI_SCORER_SELECTION_SCHEMA,
  scorers: [
    { name: "correctness", definition: { name: "correctness" } },
    { name: "policy", definition: { name: "policy" } },
  ],
  scoring: {
    projections: [
      { measurementName: "correct", scorerName: "correctness", passValue: "C" },
      { measurementName: "safe", scorerName: "policy", subScoreKey: "safe", passValue: true },
    ],
    verdictRule: {
      all: [
        { threshold: { measurement: "correct", op: "eq", value: true } },
        { threshold: { measurement: "safe", op: "eq", value: true } },
      ],
    },
  },
  arms: [{ armId, model: "mockllm/one" }],
} as InspectSelectionManifest;

let logsDir: string;

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), "bp-inspect-import-"));
});

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

function writeEvalLog(fileName: string, log: Record<string, unknown>): string {
  const path = join(logsDir, fileName);
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(log)}\n`);
  return path;
}

function scoredSample(id: string, value: unknown = "C"): Record<string, unknown> {
  return {
    id,
    epoch: 1,
    scores: { match: { value } },
  };
}

function successLog(input: {
  readonly samples: readonly Record<string, unknown>[];
  readonly model?: string;
  readonly armId?: string;
}): Record<string, unknown> {
  return {
    version: 2,
    status: "success",
    eval: {
      task: "hermetic",
      model: input.model ?? "mockllm/one",
      metadata: input.armId === undefined ? {} : { "jinn.arm_id": input.armId },
    },
    samples: [...input.samples],
  };
}

function readRecords(manifest: InspectSelectionManifest = v1Manifest) {
  return readInspectRunRecords({
    evalLogOrDir: logsDir,
    digestBySampleId: digestBySampleIdFromSuite(suite),
    arms: [{ armId, model: "mockllm/one" }],
    expected,
    scoring: manifest,
  });
}

describe("from-inspect suite mapping is the Inspect import name table", () => {
  test("digestBySampleIdFromSuite is the inverse of sampleIdByDigestFromSuite", () => {
    expect(digestBySampleIdFromSuite(suite)).toEqual({
      "hello-world": digestHello,
      "oracle-fix": digestOracle,
    });
    expect(sampleIdByDigestFromSuite(suite)).toEqual({
      [digestHello]: "hello-world",
      [digestOracle]: "oracle-fix",
    });
  });
});

describe("readInspectRunRecords — read_eval_log shape (synthetic JSON)", () => {
  test("one sample is one per-attempt record; scorer output projects into inspect-score-pass", () => {
    writeEvalLog("hello.eval", successLog({ samples: [scoredSample("hello-world")] }));
    const records = readRecords();
    const hello = records.find((record) => record.cellKey === expected[0]!.cellKey)!;
    const missing = records.find((record) => record.cellKey === expected[1]!.cellKey)!;
    expect(hello.outcome).toBe("graded");
    expect(hello.measurements).toEqual({ "inspect-score-pass": true });
    expect(hello.evidence).toEqual([{ name: "inspect-log.eval", path: "hello.eval" }]);
    expect(missing).toEqual({
      row: expect.any(Number),
      cellKey: expected[1]!.cellKey,
      outcome: "unrun",
      reason: "Inspect eval logs contained no sample for this slot",
    });
    expect(records).toHaveLength(2);
  });

  test("a failing match score is still graded — the sealed spec types the measurement", () => {
    writeEvalLog("hello.eval", successLog({ samples: [scoredSample("hello-world", "I")] }));
    const hello = readRecords().find((record) => record.cellKey === expected[0]!.cellKey)!;
    expect(hello.outcome).toBe("graded");
    expect(hello.measurements).toEqual({ "inspect-score-pass": false });
  });

  test("multi-scorer projections reuse the sealed scoring table, not a second mapper", () => {
    writeEvalLog("hello.eval", {
      version: 2,
      status: "success",
      eval: { task: "hermetic", model: "mockllm/one", metadata: {} },
      samples: [{
        id: "hello-world",
        epoch: 1,
        scores: {
          correctness: { value: "C" },
          policy: { value: { safe: true, note: "ok" } },
        },
      }],
    });
    const hello = readRecords(v2Manifest).find((record) => record.cellKey === expected[0]!.cellKey)!;
    expect(hello.outcome).toBe("graded");
    expect(hello.measurements).toEqual({ correct: true, safe: true });
  });

  test("a missing selected score is ungradeable with the log as evidence, not dropped", () => {
    writeEvalLog("hello.eval", successLog({
      samples: [{ id: "hello-world", epoch: 1, scores: {} }],
    }));
    const records = readRecords();
    expect(records.find((record) => record.cellKey === expected[0]!.cellKey)).toMatchObject({
      outcome: "ungradeable",
      reason: expect.stringMatching(/score/i),
      evidence: [{ name: "inspect-log.eval", path: "hello.eval" }],
    });
    expect(records.find((record) => record.cellKey === expected[1]!.cellKey)).toMatchObject({
      outcome: "unrun",
      reason: "Inspect eval logs contained no sample for this slot",
    });
  });

  test("Inspect timeout on a sample is timeout; the other slot stays unrun in the denominator", () => {
    writeEvalLog("hello.eval", {
      version: 2,
      status: "error",
      eval: { task: "hermetic", model: "mockllm/one", metadata: {} },
      error: { type: "TimeoutError", message: "sample exceeded time_limit" },
      samples: [{
        id: "hello-world",
        epoch: 1,
        error: { type: "TimeoutError", message: "time_limit" },
        scores: {},
      }],
    });
    const records = readRecords();
    expect(records.find((record) => record.cellKey === expected[0]!.cellKey)).toMatchObject({
      outcome: "timeout",
      reason: "TimeoutError",
    });
    expect(records.find((record) => record.cellKey === expected[0]!.cellKey)?.evidence).toBeUndefined();
    expect(records.find((record) => record.cellKey === expected[1]!.cellKey)).toMatchObject({
      outcome: "unrun",
    });
  });

  test("an extra sample is a well-formed cellKey outside the slate (unknown-slot)", () => {
    writeEvalLog("extra.eval", successLog({ samples: [scoredSample("not-on-slate")] }));
    writeEvalLog("hello.eval", successLog({ samples: [scoredSample("hello-world")] }));
    const records = readRecords();
    const extra = records.filter((record) =>
      record.cellKey !== expected[0]!.cellKey && record.cellKey !== expected[1]!.cellKey
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]!.cellKey).toMatch(/^[a-f0-9]{64}\/extra\/1$/u);
  });

  test("two samples with the same id and epoch are left as duplicate-slot rows", () => {
    writeEvalLog("a.eval", successLog({ samples: [scoredSample("hello-world")] }));
    writeEvalLog("b.eval", successLog({ samples: [scoredSample("hello-world")] }));
    const records = readRecords();
    const hellos = records.filter((record) => record.cellKey === expected[0]!.cellKey);
    expect(hellos).toHaveLength(2);
  });

  test("one log with two samples is two records; epochs map onto replicates", () => {
    writeEvalLog("batch.eval", successLog({
      samples: [
        scoredSample("hello-world"),
        { id: "oracle-fix", epoch: 1, scores: { match: { value: "C" } } },
      ],
    }));
    const records = readRecords();
    expect(records.find((record) => record.cellKey === expected[0]!.cellKey)).toMatchObject({
      outcome: "graded",
      evidence: [{ name: "inspect-log.eval", path: "batch.eval" }],
    });
    expect(records.find((record) => record.cellKey === expected[1]!.cellKey)).toMatchObject({
      outcome: "graded",
      evidence: [{ name: "inspect-log.eval", path: "batch.eval" }],
    });
  });

  test("a zip .eval is refused rather than parsed — the reader consumes the JSON EvalLog shape", () => {
    writeFileSync(join(logsDir, "native.eval"), Buffer.from("PK\x03\x04zip-not-json"));
    expect(() => readRecords()).toThrow(/read_eval_log/i);
  });
});
