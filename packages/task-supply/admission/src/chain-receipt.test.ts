// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ChainAdmissionRefusalError } from "./chain-refusals.js";
import {
  ChainAdmissionReceiptV1Schema,
  verifyChainAdmissionReceiptV1,
} from "./chain-receipt.js";
import {
  CHAIN_ADMISSION_POLICY_V1,
  CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION,
} from "./identifiers.js";

const D = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const BASELINE_TRUE = [
  { id: "health-factor-above-1.5", satisfied: true },
  { id: "borrow-event-emitted", satisfied: false },
] as const;

const DO_NOTHING_OBS = {
  successPredicates: [...BASELINE_TRUE],
  safetyConstraints: [{ id: "no-unlimited", satisfied: true }],
  conjunction: false,
  outOfSliceReads: 0,
  envelopeExceeded: false,
  appliedScriptDigest: null,
};

const REFERENCE_OBS = {
  successPredicates: [
    { id: "health-factor-above-1.5", satisfied: true },
    { id: "borrow-event-emitted", satisfied: true },
  ],
  safetyConstraints: [{ id: "no-unlimited", satisfied: true }],
  conjunction: true,
  outOfSliceReads: 0,
  envelopeExceeded: false,
  appliedScriptDigest: D("5"),
};

const golden = {
  schemaVersion: CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION,
  admissionPolicyVersion: CHAIN_ADMISSION_POLICY_V1.admissionPolicyVersion,
  family: "state-predicate" as const,
  issuer: "https://spec.jinn.network/agents/admission-1",
  task: {
    documentDigest: D("1"),
    evaluationSpecDigest: D("2"),
    statementDigest: D("3"),
  },
  referenceScriptDigest: D("5"),
  observations: {
    doNothing: [DO_NOTHING_OBS, DO_NOTHING_OBS],
    reference: [REFERENCE_OBS, REFERENCE_OBS],
  },
  environment: { compositeRecordDigest: D("7") },
  sliceSufficiency: { referenceOutOfSliceReads: 0 as const },
  evalSemanticsVersion: "1",
};

function withDoNothingSatisfied() {
  const satisfied = {
    successPredicates: [
      { id: "health-factor-above-1.5", satisfied: true },
      { id: "borrow-event-emitted", satisfied: true },
    ],
    safetyConstraints: [{ id: "no-unlimited", satisfied: true }],
    conjunction: true,
    outOfSliceReads: 0,
    envelopeExceeded: false,
    appliedScriptDigest: null,
  };
  return {
    ...golden,
    observations: { doNothing: [satisfied, satisfied], reference: golden.observations.reference },
  };
}

function withBaselineTruePredicate() {
  return golden;
}

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof ChainAdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the chain admission receipt is family-discriminated and digest-only", () => {
  it("carries family state-predicate and its own schema version", () => {
    expect(golden.family).toBe("state-predicate");
    expect(golden.schemaVersion).toBe(CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION);
  });

  it("records the reference script as a digest and never as content", () => {
    expect(golden.referenceScriptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const json = JSON.stringify(golden);
    expect(json).not.toContain("transactionIntent");
    expect(json).not.toContain("signedTransaction");
    expect(json).not.toMatch(/0x[0-9a-f]{64,}/);
  });

  it("refuses a receipt whose do-nothing conjunction is true", () => {
    const refusal = refusalOf(() => verifyChainAdmissionReceiptV1(withDoNothingSatisfied()));
    expect(refusal.code).toBe("do-nothing-satisfies");
    expect(refusal.detail).toMatch(/do-nothing-satisfies|conjunction/);
  });

  it("ADMITS a receipt whose do-nothing side has individually satisfied predicates", () => {
    const receipt = withBaselineTruePredicate();
    expect(receipt.observations.doNothing[0]!.successPredicates.some((p) => p.satisfied)).toBe(true);
    expect(verifyChainAdmissionReceiptV1(receipt)).toStrictEqual(receipt);
  });

  it("refuses a receipt whose reference conjunction is false", () => {
    const unsatisfied = {
      ...REFERENCE_OBS,
      successPredicates: [
        { id: "health-factor-above-1.5", satisfied: true },
        { id: "borrow-event-emitted", satisfied: false },
      ],
      conjunction: false,
    };
    const refusal = refusalOf(() => verifyChainAdmissionReceiptV1({
      ...golden,
      observations: { doNothing: golden.observations.doNothing, reference: [unsatisfied, unsatisfied] },
    }));
    expect(refusal.code).toBe("reference-unsatisfied");
  });

  it("refuses a receipt whose reference violated a safety constraint", () => {
    const violated = {
      ...REFERENCE_OBS,
      safetyConstraints: [{ id: "no-unlimited", satisfied: false }],
    };
    const refusal = refusalOf(() => verifyChainAdmissionReceiptV1({
      ...golden,
      observations: { doNothing: golden.observations.doNothing, reference: [violated, violated] },
    }));
    expect(refusal.code).toBe("safety-violated");
  });

  it("refuses a receipt whose reference read outside the slice", () => {
    const outOfSlice = { ...REFERENCE_OBS, outOfSliceReads: 1 };
    const refusal = refusalOf(() => verifyChainAdmissionReceiptV1({
      ...golden,
      observations: { doNothing: golden.observations.doNothing, reference: [outOfSlice, outOfSlice] },
    }));
    expect(refusal.code).toBe("slice-insufficient");
  });

  it("refuses a receipt whose two repeats on a side differ", () => {
    const refusal = refusalOf(() => verifyChainAdmissionReceiptV1({
      ...golden,
      observations: {
        doNothing: [DO_NOTHING_OBS, { ...DO_NOTHING_OBS, conjunction: true }],
        reference: golden.observations.reference,
      },
    }));
    expect(refusal.code).toBe("unstable-observations");
  });

  it("refuses a receipt whose stated conjunction contradicts its own vector", () => {
    const inconsistent = { ...DO_NOTHING_OBS, conjunction: true };
    const refusal = refusalOf(() => verifyChainAdmissionReceiptV1({
      ...golden,
      observations: {
        doNothing: [inconsistent, inconsistent],
        reference: golden.observations.reference,
      },
    }));
    expect(refusal.code).toBe("inconsistent-observation");
  });

  it("refuses a receipt whose sides disagree about which predicate ids exist", () => {
    const differentIds = {
      ...REFERENCE_OBS,
      successPredicates: [{ id: "other-predicate", satisfied: true }],
      conjunction: true,
    };
    const refusal = refusalOf(() => verifyChainAdmissionReceiptV1({
      ...golden,
      observations: { doNothing: golden.observations.doNothing, reference: [differentIds, differentIds] },
    }));
    expect(refusal.code).toBe("inconsistent-observation");
  });

  it("round-trips the golden receipt through policy validation", () => {
    expect(verifyChainAdmissionReceiptV1(golden)).toStrictEqual(golden);
  });

  it("rejects an unknown top-level key", () => {
    expect(ChainAdmissionReceiptV1Schema.safeParse({ ...golden, extra: 1 }).success).toBe(false);
  });
});
