// SPDX-License-Identifier: Apache-2.0

/**
 * The report-presentation projection's refusals.
 *
 * Every case here is a way a reader could be shown page copy that does not belong to the bundle it
 * arrived in. The projection is the only thing standing between those and a passing check list, so
 * each one is asserted directly rather than only through the end-to-end bundle test.
 */

import { describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  REPORT_PRESENTATION_SCHEMA_ID,
  ReportPresentationProjectionError,
  deriveReportPresentation,
} from "./report-presentation.js";

const REPORT_SHA256 = "a".repeat(64);
const REPORT_ENVELOPE_SHA256 = "b".repeat(64);
const BUNDLE_FORMAT = "benchmark-product-public-bundle/7";

/** A FUNCTION, not a constant: every builder call must hand back fresh objects, or a test that
 * mutates one nested value silently poisons every later case in the file. */
const proportion = () => ({
  numerator: 211,
  denominator: 240,
  estimate: "0.8792",
  wilsonInterval: { low: "0.8318", high: "0.9145" },
});

/** A complete, valid payload. Every negative case below is this with one thing changed. */
export function validPresentation(): Record<string, unknown> {
  return {
    schema: REPORT_PRESENTATION_SCHEMA_ID,
    slug: "judging-the-locomo-judges",
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
        agreement: proportion(),
        acceptsSpecificWrong: proportion(),
        acceptsVagueTopicalWrong: proportion(),
        rejectsCorrect: proportion(),
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
      companionChecks: [{ name: "consistency gate", finding: "Three of five.", provenBy: "consistency-gate" }],
    },
    limitations: ["This is one model and one run."],
    selfRunDisclosure: "One operator controls dispatch, execution, and evaluation.",
    verification: {
      bundleFormat: BUNDLE_FORMAT,
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

function derive(payload: unknown, overrides: {
  readonly reportSha256?: string;
  readonly bundleFormat?: string;
  readonly bytes?: Uint8Array;
} = {}) {
  return deriveReportPresentation({
    bytes: overrides.bytes ?? canonicalJsonBytes(payload as never),
    reportSha256: overrides.reportSha256 ?? REPORT_SHA256,
    reportEnvelopeSha256: REPORT_ENVELOPE_SHA256,
    bundleFormat: overrides.bundleFormat ?? BUNDLE_FORMAT,
  });
}

describe("deriveReportPresentation", () => {
  test("accepts a complete, canonically encoded, correctly bound presentation", () => {
    const presentation = derive(validPresentation());
    expect(presentation.schema).toBe(REPORT_PRESENTATION_SCHEMA_ID);
    expect(presentation.slug).toBe("judging-the-locomo-judges");
    expect(presentation.result.perArm[0]!.agreement.estimate).toBe("0.8792");
  });

  test("refuses an unknown schema id before it parses anything else", () => {
    const payload = { ...validPresentation(), schema: "colophon.report-presentation/1" };
    expect(() => derive(payload)).toThrow(ReportPresentationProjectionError);
    expect(() => derive(payload)).toThrow(/unknown report presentation schema/u);
  });

  test("refuses a missing required field, naming it", () => {
    const payload = validPresentation();
    delete (payload as { limitations?: unknown }).limitations;
    expect(() => derive(payload)).toThrow(/limitations/u);
  });

  test("refuses an unknown extra field rather than silently carrying it", () => {
    const payload = { ...validPresentation(), practiceGuidance: "If you publish a score..." };
    expect(() => derive(payload)).toThrow(ReportPresentationProjectionError);
  });

  test("refuses a rate supplied as a JSON number rather than the record's decimal string", () => {
    const payload = validPresentation();
    (payload.result as { perArm: { agreement: { estimate: unknown } }[] }).perArm[0]!.agreement.estimate = 0.8792;
    // Encoded by hand: the canonical encoder refuses a fractional JSON number outright, so a
    // presentation carrying one could only ever reach a reader through some other producer's bytes.
    expect(() => derive(payload, { bytes: new TextEncoder().encode(JSON.stringify(payload)) }))
      .toThrow(/estimate/u);
  });

  test("refuses bytes that are not the exact canonical encoding they decode to", () => {
    const payload = validPresentation();
    const reEncoded = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`);
    expect(() => derive(payload, { bytes: reEncoded }))
      .toThrow(/not the exact canonical encoding/u);
  });

  test("refuses a presentation of a different report", () => {
    expect(() => derive(validPresentation(), { reportSha256: "9".repeat(64) }))
      .toThrow(/but this bundle materializes report/u);
  });

  test("refuses when the two report digests inside the payload disagree with each other", () => {
    const payload = validPresentation();
    (payload.verification as { reportSha256: string }).reportSha256 = "9".repeat(64);
    expect(() => derive(payload)).toThrow(ReportPresentationProjectionError);
  });

  test("refuses a payload advertising a closure this bundle is not on", () => {
    expect(() => derive(validPresentation(), { bundleFormat: "benchmark-product-public-bundle/6" }))
      .toThrow(/advertises benchmark-product-public-bundle\/7/u);
  });

  test("refuses a slug that is not a slug", () => {
    const payload = { ...validPresentation(), slug: "Judging The LoCoMo Judges" };
    expect(() => derive(payload)).toThrow(/slug/u);
  });

  test("refuses bytes that are not JSON at all", () => {
    expect(() => derive(undefined, { bytes: new TextEncoder().encode("not json") }))
      .toThrow(/not valid UTF-8 JSON/u);
  });
});
