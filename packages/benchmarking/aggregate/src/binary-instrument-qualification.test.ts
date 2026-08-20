import { describe, expect, test } from "vitest";
import { validateBinaryInstrumentQualificationProjection } from "./binary-instrument-method.js";

const TASK = "a".repeat(64);
const CONTEXT = {
  analysisContextSha256: `sha256:${"b".repeat(64)}`,
  truthLabel: "CORRECT",
  candidateClass: "factuality",
  stratum: "core",
  labelResolutionSha256: `sha256:${"c".repeat(64)}`,
} as const;

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

function qualification(withItems = false, armCount = 4): Record<string, unknown> {
  const armIds = Array.from({ length: armCount }, (_, index) => `arm-${String.fromCharCode(97 + index)}`);
  const arms = Object.fromEntries(armIds.map((armId, index) => [armId, {
    instrumentSha256: `sha256:${String(index + 1).repeat(64)}`,
    ...zeroProjection(),
    byCandidateClass: { factuality: zeroProjection() },
    byStratum: { core: zeroProjection(), stress: zeroProjection() },
  }]));
  return {
    configuration: {
      verdictRule: "sole", k: 1, reduction: "strict-majority",
      measurementProfile: "binary-instrument@1", candidateClasses: ["factuality"],
      strata: ["core", "stress"], parserInvalidPolicy: "reject",
      truthAdmission: "two-human-unanimous", intervalAlpha: "0.05",
    },
    arms,
    itemDecisions: withItems ? armIds.map((armId, index) => ({
      taskDigest: TASK,
      armId,
      instrumentSha256: `sha256:${String(index + 1).repeat(64)}`,
      context: { ...CONTEXT },
      cellKeys: [`${TASK}/${armId}/1`],
      accepted: 1,
      rejected: 0,
      decision: "ACCEPT",
      unstable: false,
    })) : [],
    excluded: { count: 0, items: [] },
    conflicted: { count: 0, cellKeys: [] },
  };
}

describe("binary-instrument public qualification schema", () => {
  test("accepts the complete closed F6 projection", () => {
    expect(validateBinaryInstrumentQualificationProjection(qualification(true))).toEqual({ ok: true });
  });

  // §1.6: arm cardinality is never a literal count. Sites 5 and 6 must accept any arm set of
  // size two or more, of distinct instruments, and refuse below the floor of two.
  test("accepts a two-arm projection", () => {
    expect(validateBinaryInstrumentQualificationProjection(qualification(true, 2))).toEqual({ ok: true });
  });

  test("accepts a six-arm projection", () => {
    expect(validateBinaryInstrumentQualificationProjection(qualification(true, 6))).toEqual({ ok: true });
  });

  test("refuses a one-arm projection", () => {
    expect(validateBinaryInstrumentQualificationProjection(qualification(true, 1)).ok).toBe(false);
  });

  test("refuses N arms binding fewer than N distinct instruments", () => {
    const collidingInstruments = structuredClone(qualification(true, 3)) as any;
    // Force arm-b to pin the same instrument as arm-a: three arms, two distinct instruments.
    collidingInstruments.arms["arm-b"].instrumentSha256 = collidingInstruments.arms["arm-a"].instrumentSha256;
    collidingInstruments.itemDecisions[1].instrumentSha256 = collidingInstruments.arms["arm-a"].instrumentSha256;
    expect(validateBinaryInstrumentQualificationProjection(collidingInstruments).ok).toBe(false);
  });

  test("rejects conclusion fields, slice drift, and noncanonical rate values", () => {
    const ranked = { ...qualification(), ranking: ["arm-a"] };
    expect(validateBinaryInstrumentQualificationProjection(ranked).ok).toBe(false);

    const sliceDrift = structuredClone(qualification()) as any;
    delete sliceDrift.arms["arm-a"].byStratum.stress;
    sliceDrift.arms["arm-a"].byStratum.unknown = zeroProjection();
    expect(validateBinaryInstrumentQualificationProjection(sliceDrift).ok).toBe(false);

    const falseRate = structuredClone(qualification()) as any;
    falseRate.arms["arm-a"].agreement.estimate = "0.00000";
    expect(validateBinaryInstrumentQualificationProjection(falseRate).ok).toBe(false);
  });

  test("rejects nested context, majority, cell-order, and exclusion-reason drift", () => {
    const badContext = structuredClone(qualification(true)) as any;
    badContext.itemDecisions[0].context.truthLabel = "MAYBE";
    expect(validateBinaryInstrumentQualificationProjection(badContext).ok).toBe(false);

    const badMajority = structuredClone(qualification(true)) as any;
    badMajority.itemDecisions[0].accepted = 0;
    expect(validateBinaryInstrumentQualificationProjection(badMajority).ok).toBe(false);

    const duplicateCell = structuredClone(qualification(true)) as any;
    duplicateCell.itemDecisions[1].cellKeys = [...duplicateCell.itemDecisions[0].cellKeys];
    expect(validateBinaryInstrumentQualificationProjection(duplicateCell).ok).toBe(false);

    const badExclusion = structuredClone(qualification(true)) as any;
    const removed = badExclusion.itemDecisions.shift();
    badExclusion.excluded = {
      count: 1,
      items: [{
        taskDigest: removed.taskDigest,
        armId: removed.armId,
        instrumentSha256: removed.instrumentSha256,
        context: removed.context,
        cellKeys: removed.cellKeys,
        reasons: [{ reason: "invented-reason", cellKeys: removed.cellKeys }],
      }],
    };
    expect(validateBinaryInstrumentQualificationProjection(badExclusion).ok).toBe(false);
  });
});
