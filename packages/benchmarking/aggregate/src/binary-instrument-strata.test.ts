// SPDX-License-Identifier: Apache-2.0
//
// Declared stratum vocabulary (packet P4, issue #2845). Kept in a new file per spec §10.2's
// fixture ruling: `binary-instrument-qualification.test.ts` stays byte-unmodified, so its own
// two-stratum drift coverage keeps refusing the same drift for the same reason, and this file's
// four-category coverage lives alongside it rather than inside it.

import { describe, expect, test } from "vitest";
import {
  BINARY_INSTRUMENT_PARAMETER_SCHEMA,
  projectBinaryInstrumentQualification,
  validateBinaryInstrumentParameters,
  validateBinaryInstrumentQualificationProjection,
} from "./binary-instrument-method.js";
import type { BinaryInstrumentItemDecision, BinaryInstrumentReduction } from "./binary-instrument.js";

const PARAMETERS = {
  verdictRule: "sole",
  k: 1,
  reduction: "strict-majority",
  measurementProfile: "binary-instrument@1",
  candidateClasses: ["factuality"],
  strata: ["category-1", "category-2", "category-3", "category-4"],
  parserInvalidPolicy: "reject",
  truthAdmission: "two-human-unanimous",
  intervalAlpha: "0.05",
} as const;

function issuesOf(
  result: ReturnType<typeof validateBinaryInstrumentParameters>,
): readonly string[] {
  return result.ok ? [] : result.issues;
}

describe("BINARY_INSTRUMENT_PARAMETER_SCHEMA / validateBinaryInstrumentParameters — strata", () => {
  test("the schema's strata property mirrors candidateClasses: open, non-empty, unique, grammar-conforming", () => {
    expect(BINARY_INSTRUMENT_PARAMETER_SCHEMA.properties["strata"]).toEqual(
      BINARY_INSTRUMENT_PARAMETER_SCHEMA.properties["candidateClasses"],
    );
  });

  test("accepts a four-category vocabulary and, byte-compatibly, the legacy core/stress pair", () => {
    expect(validateBinaryInstrumentParameters({
      ...PARAMETERS,
      strata: ["category-1", "category-2", "category-3", "category-4"],
    })).toEqual({ ok: true });
    expect(validateBinaryInstrumentParameters({ ...PARAMETERS, strata: ["core", "stress"] }))
      .toEqual({ ok: true });
  });

  test("refuses an empty, unsorted, duplicate, or non-grammar-conforming vocabulary", () => {
    expect(issuesOf(validateBinaryInstrumentParameters({ ...PARAMETERS, strata: [] })))
      .toContain('parameter "strata" must be a non-empty array of stratum names');
    expect(issuesOf(validateBinaryInstrumentParameters({ ...PARAMETERS, strata: ["stress", "core"] })))
      .toContain('parameter "strata" must be unique and code-unit sorted');
    expect(issuesOf(validateBinaryInstrumentParameters({ ...PARAMETERS, strata: ["core", "core"] })))
      .toContain('parameter "strata" must be unique and code-unit sorted');
    expect(issuesOf(validateBinaryInstrumentParameters({ ...PARAMETERS, strata: ["bad name"] })))
      .toContain('parameter "strata" must be a non-empty array of stratum names');
  });
});

const ARM = "armA";
const INSTRUMENT = "1".repeat(64);

function itemContext(stratum: string, seed: string) {
  return {
    analysisContextSha256: seed.repeat(64),
    truthLabel: "CORRECT" as const,
    candidateClass: "factuality",
    stratum,
    labelResolutionSha256: seed.repeat(64),
  };
}

function item(taskDigest: string, stratum: string, seed: string): BinaryInstrumentItemDecision {
  return {
    taskDigest,
    armId: ARM,
    instrumentSha256: INSTRUMENT,
    context: itemContext(stratum, seed),
    cellKeys: [`${taskDigest}/${ARM}/1`],
    calls: [],
    accepted: 1,
    rejected: 0,
    decision: "ACCEPT",
    unstable: false,
  };
}

function reductionWith(items: readonly BinaryInstrumentItemDecision[]): BinaryInstrumentReduction {
  return {
    subjectSha256: "0".repeat(64),
    k: 1,
    items,
    evaluatedCalls: [],
    excluded: [],
    conflicted: { count: 0, cellKeys: [] },
  };
}

describe("projectBinaryInstrumentQualification — declared stratum vocabulary", () => {
  // Three declared strata carry an admitted item; the fourth, "category-4", carries none.
  const items = [
    item("a".repeat(64), "category-1", "1"),
    item("b".repeat(64), "category-2", "2"),
    item("c".repeat(64), "category-3", "3"),
  ];
  const result = projectBinaryInstrumentQualification({
    parameters: PARAMETERS,
    reduction: reductionWith(items),
    instruments: [{ armId: ARM, instrumentSha256: INSTRUMENT }],
  }) as {
    readonly arms: Record<string, { readonly byStratum: Record<string, unknown> }>;
  };

  test("emits exactly one byStratum slice per declared stratum, in the sealed order", () => {
    expect(Object.keys(result.arms[ARM]!.byStratum)).toEqual([
      "category-1",
      "category-2",
      "category-3",
      "category-4",
    ]);
  });

  test("a declared stratum with zero admitted items still emits its slice with its counts and withholds the interval", () => {
    const slice = result.arms[ARM]!.byStratum["category-4"] as {
      readonly item: unknown;
      readonly agreement: unknown;
    };
    expect(slice.item).toEqual({ expected: 0, complete: 0, excluded: 0, unstable: 0 });
    expect(slice.agreement).toEqual({
      numerator: 0,
      denominator: 0,
      estimate: null,
      wilsonInterval: null,
      withheldReason: "zero-denominator",
    });
  });
});

function zeroRate() {
  return { numerator: 0, denominator: 0, estimate: null, wilsonInterval: null, withheldReason: "zero-denominator" };
}

function zeroProjection() {
  return {
    item: { expected: 0, complete: 0, excluded: 0, unstable: 0 },
    call: { expected: 0, evaluated: 0, parseInvalid: 0 },
    confusion: { correctAccepted: 0, correctRejected: 0, wrongAccepted: 0, wrongRejected: 0 },
    agreement: zeroRate(), falseAccept: zeroRate(), falseReject: zeroRate(),
    instability: zeroRate(), parserInvalid: zeroRate(),
  };
}

const STRATA = ["category-1", "category-2", "category-3", "category-4"];

function fourStratumQualification(): Record<string, unknown> {
  const armIds = ["arm-a", "arm-b"];
  const arms = Object.fromEntries(armIds.map((armId, index) => [armId, {
    instrumentSha256: `sha256:${String(index + 1).repeat(64)}`,
    ...zeroProjection(),
    byCandidateClass: { factuality: zeroProjection() },
    byStratum: Object.fromEntries(STRATA.map((stratum) => [stratum, zeroProjection()])),
  }]));
  return {
    configuration: {
      verdictRule: "sole", k: 1, reduction: "strict-majority",
      measurementProfile: "binary-instrument@1", candidateClasses: ["factuality"],
      strata: STRATA, parserInvalidPolicy: "reject",
      truthAdmission: "two-human-unanimous", intervalAlpha: "0.05",
    },
    arms,
    itemDecisions: [],
    excluded: { count: 0, items: [] },
    conflicted: { count: 0, cellKeys: [] },
  };
}

describe("validateBinaryInstrumentQualificationProjection — declared stratum vocabulary", () => {
  test("accepts a qualification whose byStratum carries all four declared slices", () => {
    expect(validateBinaryInstrumentQualificationProjection(fourStratumQualification())).toEqual({ ok: true });
  });

  test("refuses a qualification whose byStratum drops a declared slice", () => {
    const dropped = structuredClone(fourStratumQualification()) as any;
    delete dropped.arms["arm-a"].byStratum["category-4"];
    expect(validateBinaryInstrumentQualificationProjection(dropped)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        "qualification.arms.arm-a.byStratum must exactly match the registered slice vocabulary",
      ]),
    });
  });
});
