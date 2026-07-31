// SPDX-License-Identifier: Apache-2.0

import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import type { DifferentialAdmissionReceiptV3 } from "./receipt.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const BROKEN = { passed: ["keeps"], failed: ["target"], passedMatch: false } as const;
const FIXED = { passed: ["keeps", "target"], failed: [], passedMatch: true } as const;

/** A policy-valid receipt over one discriminating test path. */
export function goldenReceipt(): DifferentialAdmissionReceiptV3 {
  return {
    schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
    admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
    issuer: "https://jinn.network/agents/admission-1",
    task: {
      documentDigest: digest("1"),
      evaluationSpecDigest: digest("2"),
      statementDigest: digest("3"),
      testMaterialDigests: [digest("4")],
      transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    },
    goldPatchHash: digest("5"),
    testPaths: [{
      testPath: "tests/unit/test_thing.py",
      commandHash: digest("6"),
      broken: [{ ...BROKEN, passed: [...BROKEN.passed], failed: [...BROKEN.failed] },
               { ...BROKEN, passed: [...BROKEN.passed], failed: [...BROKEN.failed] }],
      fixed: [{ ...FIXED, passed: [...FIXED.passed], failed: [...FIXED.failed] },
              { ...FIXED, passed: [...FIXED.passed], failed: [...FIXED.failed] }],
      failToPass: ["target"],
      passToPass: ["keeps"],
    }],
    environment: {
      recordDigest: digest("7"),
      inlineMatch: { fields: ["image", "parser", "platform"], specKeyPresent: true },
    },
    evalSemanticsVersion: "4",
  };
}
