// SPDX-License-Identifier: Apache-2.0

/**
 * `sealReportPresentation`'s refusals — the produce-side half of the report-presentation contract.
 *
 * The projection in `@colophon-claims/verify` is what stops a reader being shown the wrong page.
 * This is what stops an OPERATOR sealing one: the same failures caught at the moment a human can
 * still fix the file, in the product's own typed error shape, naming the field.
 */

import { describe, expect, test } from "vitest";
import { REPORT_PRESENTATION_SCHEMA_ID } from "@colophon-claims/verify";
import { sealReportPresentation } from "./state.js";

const REPORT_SHA256 = "a".repeat(64);
const REPORT_ENVELOPE_SHA256 = "b".repeat(64);
const SLUG = "judging-the-locomo-judges";

const proportion = {
  numerator: 211,
  denominator: 240,
  estimate: "0.8792",
  wilsonInterval: { low: "0.8318", high: "0.9145" },
};

function payload(): Record<string, any> {
  return {
    schema: REPORT_PRESENTATION_SCHEMA_ID,
    slug: SLUG,
    title: "Judging the LoCoMo judges",
    summary: "Six published judge prompts on one shared bank of 240 answers.",
    sealedAt: "2026-08-28T20:22:04.169Z",
    subject: {
      judgeModel: "gpt-4o-mini-2024-07-18",
      harness: { id: "inspect-ai-judge", version: "1" },
      benchmark: { name: "locomo-judge-bank", description: "240-item bank", sha256: "c".repeat(64) },
      arms: [{ id: "strict-dial", label: "strict-dial", instrumentSha256: `sha256:${"d".repeat(64)}` }],
    },
    question: {
      designUrl: "https://example.invalid/design",
      postedOn: "2026-08-18",
      preRegistered: [{ id: "q1", question: "How often?", answer: "Constantly.", provenBy: "this-bundle" }],
    },
    execution: {
      judgePrompts: { count: 6, provenance: "As posted." },
      modelSnapshot: { id: "gpt-4o-mini-2024-07-18", temperature: "0", profile: "dated-snapshot-sampling" },
      replicates: 3,
      reduction: "strict-majority",
      abstainPolicy: { parserInvalid: "abstain", description: "Neutral, not a rejection." },
      intervals: "95 percent Wilson",
      truthAdmission: "screened-operator-sampled",
      venue: "self-run",
    },
    result: {
      primary: "agreement-with-human-labels",
      perArm: [{
        armId: "strict-dial",
        agreement: proportion,
        acceptsSpecificWrong: proportion,
        acceptsVagueTopicalWrong: proportion,
        rejectsCorrect: proportion,
      }],
      spread: { lowestArmId: "revised", highestArmId: "strict-dial", pointsBetween: "27.1" },
      interpretation: "Swapping the grader moves the score.",
      methodStatement: "It measures graders.",
    },
    population: {
      items: 240,
      perCandidateClass: [{ candidateClass: "correct", items: 80 }],
      perStratum: [{ stratum: "category-1", items: 60 }],
      labels: "Model-proposed and sample-checked.",
    },
    accounting: {
      cells: { expected: 4320, judged: 4320, lost: 0 },
      parserNeutral: { calls: 22, denominator: 4320, policy: "abstain", note: "Traces to the instrument." },
      excludedItems: { count: 7, byArm: [{ armId: "mem0-evidence", items: 7 }] },
      completenessFloor: "0.9950",
      runOutcome: "complete",
    },
    manipulationCheck: {
      replicateInstability: { unstableItems: 23, gradedItems: 1433 },
      conflictedCells: 0,
      companionChecks: [],
    },
    limitations: ["This is one model and one run."],
    selfRunDisclosure: "One operator controls dispatch, execution, and evaluation.",
    verification: {
      bundleFormat: "benchmark-product-public-bundle/7",
      checks: ["manifest"],
      command: "npx @colophon-claims/verify@0.2.1 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@0.2 <bundle-dir>",
      readerAvailability: "available",
      reportSha256: REPORT_SHA256,
      reportEnvelopeSha256: REPORT_ENVELOPE_SHA256,
    },
    provenance: {
      runSha256: "e".repeat(64),
      benchmarkSha256: "c".repeat(64),
      matrixSha256: "f".repeat(64),
      reportSha256: REPORT_SHA256,
      reportEnvelopeSha256: REPORT_ENVELOPE_SHA256,
      anchors: [],
      siblingAnalyses: [],
      companionBundles: [],
    },
  };
}

function seal(presentation: unknown, slug = SLUG) {
  return sealReportPresentation({
    payload: presentation,
    slug,
    reportSha256: REPORT_SHA256,
    reportEnvelopeSha256: REPORT_ENVELOPE_SHA256,
  });
}

function refusal(run: () => unknown): { readonly code: string; readonly path: string; readonly message: string } {
  try {
    run();
  } catch (cause) {
    const issue = (cause as { readonly issues?: readonly { path?: string; message?: string }[] }).issues?.[0];
    return {
      code: (cause as { readonly code?: string }).code ?? "",
      path: issue?.path ?? "",
      message: issue?.message ?? String(cause),
    };
  }
  throw new Error("NOT REFUSED");
}

describe("sealReportPresentation", () => {
  test("seals a valid payload as its exact canonical encoding", () => {
    const sealed = seal(payload());
    expect(sealed.presentation.slug).toBe(SLUG);
    expect(sealed.sha256).toMatch(/^[a-f0-9]{64}$/u);
    // Canonical by construction: the sealed bytes decode to the presentation returned beside them.
    expect(JSON.parse(new TextDecoder().decode(sealed.bytes))).toEqual(sealed.presentation);
  });

  test("re-sealing byte-identical content yields the same digest", () => {
    expect(seal(payload()).sha256).toBe(seal(payload()).sha256);
  });

  test("refuses an unknown schema id", () => {
    const refused = refusal(() => seal({ ...payload(), schema: "colophon.report-presentation/1" }));
    expect(refused.code).toBe("validation");
    expect(refused.path).toBe("presentation.schema");
  });

  test("refuses a slug that does not match the one named on the command line", () => {
    const refused = refusal(() => seal(payload(), "some-other-report"));
    expect(refused.code).toBe("conflict");
    expect(refused.path).toBe("presentation.slug");
    expect(refused.message).toMatch(/has to be edited, not re-slugged/u);
  });

  test("refuses a missing required field, naming it", () => {
    const missing = payload();
    delete missing.selfRunDisclosure;
    const refused = refusal(() => seal(missing));
    expect(refused.code).toBe("validation");
    expect(refused.path).toBe("presentation.selfRunDisclosure");
  });

  test("refuses a missing nested required field, naming the full path", () => {
    const missing = payload();
    delete missing.result.spread;
    expect(refusal(() => seal(missing)).path).toBe("presentation.result.spread");
  });

  test("refuses an unknown extra field rather than sealing something no consumer reads", () => {
    const extra = { ...payload(), practiceGuidance: "If you publish a score..." };
    expect(refusal(() => seal(extra)).code).toBe("validation");
  });

  test("refuses a payload that presents a different report", () => {
    const foreign = payload();
    foreign.provenance.reportSha256 = "9".repeat(64);
    foreign.verification.reportSha256 = "9".repeat(64);
    const refused = refusal(() => seal(foreign));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toMatch(/but this bundle materializes report/u);
  });

  test("refuses a payload targeting a closure that cannot carry the member", () => {
    const wrongClosure = payload();
    wrongClosure.verification.bundleFormat = "benchmark-product-public-bundle/6";
    const refused = refusal(() => seal(wrongClosure));
    expect(refused.code).toBe("conflict");
    expect(refused.path).toBe("presentation.verification.bundleFormat");
  });
});
