import { describe, expect, it } from "vitest";
import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { AdmissionRefusalError } from "./refusals.js";
import {
  DifferentialAdmissionReceiptV3Schema,
  verifyDifferentialAdmissionReceiptV3,
} from "./receipt.js";

const D = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const broken = { passed: ["keeps"], failed: ["target"], passedMatch: false };
const fixed = { passed: ["keeps", "target"], failed: [], passedMatch: true };

const receipt = {
  schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
  admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
  issuer: "https://jinn.network/agents/admission-1",
  task: {
    documentDigest: D("1"),
    evaluationSpecDigest: D("2"),
    statementDigest: D("3"),
    testMaterialDigests: [D("4")],
    transitions: { failToPass: ["target"], passToPass: ["keeps"] },
  },
  goldPatchHash: D("5"),
  testPaths: [{
    testPath: "tests/unit/test_thing.py",
    commandHash: D("6"),
    broken: [broken, broken],
    fixed: [fixed, fixed],
    failToPass: ["target"],
    passToPass: ["keeps"],
  }],
  environment: {
    recordDigest: D("7"),
    inlineMatch: { fields: ["image", "parser", "platform"], specKeyPresent: true },
  },
  evalSemanticsVersion: "4",
};

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("DifferentialAdmissionReceiptV3", () => {
  it("round-trips a golden receipt through parse and policy validation", () => {
    expect(verifyDifferentialAdmissionReceiptV3(receipt)).toStrictEqual(receipt);
  });

  it("GOLD-DIGEST-ONLY: rejects any receipt carrying patch bytes", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({
      ...receipt, goldPatch: "diff --git a/x b/x\n",
    }).success).toBe(false);
    expect(JSON.stringify(verifyDifferentialAdmissionReceiptV3(receipt))).not.toContain("diff --git");
  });

  it("rejects an unknown top-level key", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({ ...receipt, extra: 1 }).success).toBe(false);
  });

  it("rejects a bare-hex digest where the receipt body requires the sha256: spelling", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({
      ...receipt, goldPatchHash: receipt.goldPatchHash.slice("sha256:".length),
    }).success).toBe(false);
  });

  it("refuses a path whose declared transitions do not match its observations", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{ ...receipt.testPaths[0], passToPass: [] }],
    }));
    expect(refusal.code).toBe("no-discrimination");
    expect(refusal.detail).toContain("do not match its observations");
  });

  it("refuses a path with no fail-to-pass assertion", () => {
    const inert = { passed: ["keeps"], failed: [], passedMatch: true };
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{
        ...receipt.testPaths[0],
        broken: [inert, inert], fixed: [inert, inert],
        failToPass: [], passToPass: ["keeps"],
      }],
    }));
    expect(refusal.code).toBe("no-discrimination");
    expect(refusal.detail).toContain("no fail-to-pass assertion");
  });

  it("refuses unstable repeats inside a stored receipt", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{ ...receipt.testPaths[0], fixed: [fixed, { ...fixed, passedMatch: false }] }],
    }));
    expect(refusal.code).toBe("unstable-observations");
  });

  it("refuses an assertion identifier shared across two test paths", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [
        receipt.testPaths[0],
        { ...receipt.testPaths[0], testPath: "tests/unit/test_other.py" },
      ],
    }));
    expect(refusal.code).toBe("duplicate-assertion-id");
    expect(refusal.detail).toContain("keeps");
  });

  it("refuses a receipt whose declared fail-to-pass is not proven by any path", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      task: { ...receipt.task, transitions: { failToPass: ["phantom"], passToPass: ["keeps"] } },
    }));
    expect(refusal.code).toBe("transitions-mismatch");
    expect(refusal.detail).toContain("phantom");
  });

  it("refuses a receipt whose declared pass-to-pass is not proven by any path", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      task: { ...receipt.task, transitions: { failToPass: ["target"], passToPass: ["absent"] } },
    }));
    expect(refusal.code).toBe("transitions-mismatch");
    expect(refusal.detail).toContain("absent");
  });

  it("refuses a receipt that declares no fail-to-pass assertion at all", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      task: { ...receipt.task, transitions: { failToPass: [], passToPass: ["keeps"] } },
    }));
    expect(refusal.code).toBe("no-discrimination");
  });

  it("refuses a repeated or unnormalized test path", () => {
    expect(refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt, testPaths: [receipt.testPaths[0], receipt.testPaths[0]],
    })).code).toBe("invalid-candidate");
    expect(refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{ ...receipt.testPaths[0], testPath: "tests/./unit/test_thing.py" }],
    })).code).toBe("invalid-candidate");
  });

  it("refuses a foreign schema or policy version", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({ ...receipt, schemaVersion: "v2" }).success).toBe(false);
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({
      ...receipt, admissionPolicyVersion: "swe-rebench-v2-differential-admission.v2",
    }).success).toBe(false);
  });
});
