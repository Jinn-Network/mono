// SPDX-License-Identifier: Apache-2.0
//
// Declared stratum vocabulary (packet P4, issue #2845). A small, hand-built cohort fixture (not
// the crypto-sealed golden replay in golden-lifecycle.test.ts) proving the reduction context
// carries a four-category stratum end to end: EvidenceBinaryInstrumentContext to reduced item
// context to the projected byStratum slice keyed by the sealed vocabulary.

import { describe, expect, test } from "vitest";
import {
  computeEvidenceBinaryInstrumentQualification,
  reduceEvidenceBinaryInstrument,
  type EvidenceBinaryInstrumentInput,
} from "./binary-instrument.js";
import type { VerifiedCohortMember, VerifiedEvidenceCohort } from "./types.js";

const EVALUATION_DIGEST = "c".repeat(64);
const LABEL_DIGEST = "b".repeat(64);
const INSTRUMENT_DIGEST = "1".repeat(64);
const TASK_DIGEST = "a".repeat(64);

// The NUL character joining family and digest in @jinn-network/benchmarking-protocol's
// evidenceReferenceKey, spelled with fromCharCode to keep an unescaped control byte out of source.
const NUL = String.fromCharCode(0);

function evidenceReferenceKey(family: string, sha256: string): string {
  return family + NUL + sha256;
}

const evaluationKey = evidenceReferenceKey("result-evaluation", EVALUATION_DIGEST);
const labelKey = evidenceReferenceKey("human-label-resolution", LABEL_DIGEST);

const member = {
  member: {
    memberKey: "member-1",
    taskDigest: `sha256:${TASK_DIGEST}`,
    labelResolutions: {
      considered: [],
      admitted: [{
        family: "human-label-resolution",
        record: { name: "label", digest: { sha256: LABEL_DIGEST } },
      }],
      excluded: [],
    },
    evaluations: {
      considered: [],
      admitted: [{
        family: "result-evaluation",
        record: { name: "eval", digest: { sha256: EVALUATION_DIGEST } },
      }],
      excluded: [],
    },
  },
  evaluations: new Map([
    [evaluationKey, {
      statement: {
        predicate: {
          measurements: [
            { name: "judgeDecision", value: "ACCEPT" },
            { name: "parseValid", value: true },
          ],
          evaluationMethod: { digest: { sha256: INSTRUMENT_DIGEST } },
        },
      },
    }],
  ]),
  labelResolutions: new Map([
    [labelKey, {
      resolution: { status: "admitted", label: "ACCEPT" },
    }],
  ]),
} as unknown as VerifiedCohortMember;

const cohort = { members: [member] } as unknown as VerifiedEvidenceCohort;

const input: EvidenceBinaryInstrumentInput = {
  cohort,
  parameters: {
    verdictRule: "sole",
    k: 1,
    reduction: "strict-majority",
    measurementProfile: "binary-instrument@1",
    candidateClasses: ["factuality"],
    strata: ["category-1", "category-2", "category-3", "category-4"],
    parserInvalidPolicy: "reject",
    truthAdmission: "two-human-unanimous",
    intervalAlpha: "0.05",
  },
  instruments: [
    { armId: "armA", instrumentSha256: `sha256:${INSTRUMENT_DIGEST}` },
    // A second, unused arm: validateBinaryInstrumentQualificationProjection requires two or more
    // arms (spec §1.6), unrelated to this file's stratum-vocabulary coverage.
    { armId: "armB", instrumentSha256: `sha256:${"2".repeat(64)}` },
  ],
  contexts: [{ memberKey: "member-1", candidateClass: "factuality", stratum: "category-3" }],
  analysisContextSha256: `sha256:${"e".repeat(64)}`,
};

describe("reduceEvidenceBinaryInstrument -- declared stratum vocabulary", () => {
  test("carries a four-category stratum name through to the reduced item context", () => {
    const reduction = reduceEvidenceBinaryInstrument(input);
    expect(reduction.items).toHaveLength(1);
    expect(reduction.items[0]!.context.stratum).toBe("category-3");
  });

  test("carries the stratum through to the projected byStratum slice, keyed by the sealed vocabulary", () => {
    const qualification = computeEvidenceBinaryInstrumentQualification(input) as {
      readonly arms: Record<string, { readonly byStratum: Record<string, { readonly item: { readonly complete: number } }> }>;
    };
    expect(Object.keys(qualification.arms["armA"]!.byStratum)).toEqual([
      "category-1",
      "category-2",
      "category-3",
      "category-4",
    ]);
    expect(qualification.arms["armA"]!.byStratum["category-3"]!.item.complete).toBe(1);
    expect(qualification.arms["armA"]!.byStratum["category-1"]!.item.complete).toBe(0);
  });
});
