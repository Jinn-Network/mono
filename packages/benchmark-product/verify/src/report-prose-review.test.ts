// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3016: the report page's prose review, and the ratchet that keeps it running.
 *
 * The first test set covers the rules themselves. The second runs the review over the published
 * page — the conformance kit's golden bundle is a complete, real report — and requires its
 * findings to be exactly `FROZEN_REPORT_PROSE_FINDINGS`. That is the criterion's "runs as part of
 * producing a report, not as a one-off cleanup": new prose that repeats a statement, narrates a
 * control, or reads as machine-written fails the build of the package that produces reports, and
 * a frozen finding cannot be quietly forgotten because a dead entry fails too.
 *
 * Issue #4192 widens that from one profile to three. `buildIndex` renders a different prose
 * branch per method, and only wilson's was ever read -- so the binary branch's repetitions lived
 * as a hand-written aside in a ruling instead of as a finding. The other two pages here are
 * rendered by the real `buildPublicAssets` from the golden bundle's own verified facts with one
 * method substituted (see `methodInput`), and each gets its own exact finding list and its own
 * word ceiling.
 *
 * Issue #4193 covers what the review's corpus drops. `unreviewedReportProse` enumerates it and
 * each profile pins the result, so the boundary is visible rather than incidental; the disclosure
 * summaries are additionally held to being record-derived cell labels, which is the reason the
 * corpus passes over them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import type { PublicComparisonCell } from "./comparison.js";
import { verifyPublicBundleSnapshot } from "./verify.js";
import {
  FROZEN_REPORT_PROSE_FINDINGS,
  REPORT_PROSE_RULES,
  REPORT_PROSE_WORD_CEILINGS,
  authoredReportProse,
  reportProseWordCount,
  reviewReportProse,
  unreviewedReportProse,
  type FrozenReportProseFinding,
  type ReportPresentationProfile,
} from "./report-prose-review.js";

const GOLDEN_DIR = fileURLToPath(
  new URL("../fixtures/public-bundle-conformance-v1/golden/", import.meta.url),
);
const publishedPage = readFileSync(join(GOLDEN_DIR, "index.html"), "utf8");

/**
 * The golden bundle's own verified comparison projection. Read in place rather than into a copy:
 * nothing here mutates the fixture (unlike `assets-presentation-profile.test.ts`, which rewrites
 * assets to prove a refusal), so one snapshot verification serves the whole file.
 */
const { comparison } = await verifyPublicBundleSnapshot(GOLDEN_DIR);

/**
 * The golden bundle's asset input, rebuilt from the bundle's own stored records exactly as
 * `assets-presentation-profile.test.ts` does, plus the verified `comparison` the published
 * profile carries. Every digest is read from the bundle, so nothing here is a hand-copied
 * constant that could drift from the fixture -- and the byte-identity test below proves the
 * rebuild is the published page before any substituted profile rests on it.
 */
function goldenAssetInput(): PublicAssetInput {
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(GOLDEN_DIR, name)));
  const claim = JSON.parse(readFileSync(join(GOLDEN_DIR, "claim-package.json"), "utf8")) as PublicAssetInput["claim"] & {
    readonly records: { readonly matrixSha256: string; readonly reportSha256: string };
    readonly conflicted: { readonly cellKeys: readonly string[] };
  };
  const manifest = JSON.parse(readFileSync(join(GOLDEN_DIR, "bundle.json"), "utf8")) as {
    readonly files: readonly { readonly path: string }[];
  };
  return {
    claim,
    matrix: parseMatrix(read("matrix.json")),
    report: parseReport(read("report.json")),
    reportSha256: claim.records.reportSha256,
    matrixSha256: claim.records.matrixSha256,
    recordSha256s: manifest.files.flatMap((file) => {
      const match = /^records\/([a-f0-9]{64})\.bin$/u.exec(file.path);
      return match === null ? [] : [match[1]!];
    }),
    dissentCellKeys: [...claim.conflicted.cellKeys],
    comparison,
  };
}

/**
 * The same input with one method's facts substituted, the way `core/src/bundle/assets.test.ts`
 * reaches a method branch: both the sealed Report's and the stored claim's `method`/`results` are
 * replaced, so `buildPublicAssets` projects the same branch twice -- once as the Report section
 * and once as the Claim mirror, which is where this file's repetition findings live.
 *
 * The result is NOT a bundle, and must never be written into one. Its method facts are synthetic
 * and the pairwise profile keeps the golden's wilson-run `comparison`, so
 * `verifyPublicBundleSnapshot` would refuse it on sight -- that refusal is exactly what
 * `assets-presentation-profile.test.ts` proves for a mismatched profile. What it does prove is
 * what this file needs: every sentence these branches render is read by the rules, in place, on a
 * whole page. That holds because every string on these branches is a literal in `assets.ts` --
 * the values are synthetic, the prose is not.
 */
function methodInput(methodId: string, results: unknown, extra: Partial<PublicAssetInput>): PublicAssetInput {
  const base = goldenAssetInput();
  const wrapped = { perSubject: [{ subjectSha256: base.matrixSha256, results }] };
  return {
    ...base,
    report: { ...base.report, method: { id: methodId, version: "1", parameters: {} }, results: wrapped },
    claim: { ...base.claim, method: { ...base.claim.method, id: methodId, parameters: {} }, results: wrapped },
    ...extra,
  } as unknown as PublicAssetInput;
}

/** The binary profile's two arms. Every expectation that names an arm is derived from these. */
const BINARY_ARM_IDS = ["arm-a", "arm-b"] as const;
const binaryInstrumentSha256 = (index: number): string => `sha256:${String(index + 1).repeat(64)}`;

/** Zero-denominator rate and per-bucket projection, lifted from
 * `benchmarking/aggregate/src/binary-instrument-qualification.test.ts` -- the smallest shape
 * `validateBinaryInstrumentQualificationProjection` accepts. */
function zeroRate(): Record<string, unknown> {
  return { numerator: 0, denominator: 0, estimate: null, wilsonInterval: null, withheldReason: "zero-denominator" };
}

function zeroProjection(): Record<string, unknown> {
  return {
    item: { expected: 0, complete: 0, excluded: 0, unstable: 0 },
    call: { expected: 0, evaluated: 0, parseInvalid: 0 },
    confusion: { correctAccepted: 0, correctRejected: 0, wrongAccepted: 0, wrongRejected: 0 },
    agreement: zeroRate(), falseAccept: zeroRate(), falseReject: zeroRate(),
    instability: zeroRate(), parserInvalid: zeroRate(),
  };
}

function binaryQualificationResults(): Record<string, unknown> {
  return {
    configuration: {
      verdictRule: "sole", k: 1, reduction: "strict-majority",
      measurementProfile: "binary-instrument@1", candidateClasses: ["factuality"],
      strata: ["core", "stress"], parserInvalidPolicy: "reject",
      truthAdmission: "two-human-unanimous", intervalAlpha: "0.05",
    },
    arms: Object.fromEntries(BINARY_ARM_IDS.map((armId, index) => [armId, {
      instrumentSha256: binaryInstrumentSha256(index),
      ...zeroProjection(),
      byCandidateClass: { factuality: zeroProjection() },
      byStratum: { core: zeroProjection(), stress: zeroProjection() },
    }])),
    itemDecisions: [],
    excluded: { count: 0, items: [] },
    conflicted: { count: 0, cellKeys: [] },
  };
}

const profilePage: Record<ReportPresentationProfile, string> = {
  wilson: new TextDecoder().decode(buildPublicAssets(goldenAssetInput())["index.html"]!),
  // Keeps `comparison`: a pairwise bundle is non-binary, so the producer derives one for it.
  pairwise: new TextDecoder().decode(buildPublicAssets(methodInput(
    "jinn.benchmarking.method/pairwise-disagreement",
    {
      pairs: [{
        armA: BINARY_ARM_IDS[0], armB: BINARY_ARM_IDS[1], n: 6, disagreements: 1,
        rate: "0.1667", interval: { lower: "0.0100", upper: "0.3200", alpha: "0.05" },
      }],
      conflicted: { count: 0, cellKeys: [] },
    },
    {},
  ))["index.html"]!),
  // Omits `comparison` and carries `binaryQualification` instead -- the qualification-projecting
  // profile's own shape, matching what the verifier assembles for it.
  binary: new TextDecoder().decode(buildPublicAssets(methodInput(
    "jinn.benchmarking.method/binary-instrument",
    binaryQualificationResults(),
    {
      comparison: undefined,
      binaryQualification: {
        publicationGrade: true,
        truthAdmission: "two-human-unanimous",
        sourceManifestSha256: `sha256:${"d".repeat(64)}`,
        admissionManifestSha256: `sha256:${"e".repeat(64)}`,
        exclusions: [],
        instruments: BINARY_ARM_IDS.map((armId, index) => ({
          armId,
          instrumentSha256: binaryInstrumentSha256(index),
          promptTemplateSha256: `sha256:${"f".repeat(64)}`,
        })),
      },
    },
  ))["index.html"]!),
};

const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

describe("authoredReportProse", () => {
  test("reads the page's own prose", () => {
    expect(authoredReportProse(page("<p>The venue is self-run.</p><h2>Sealed Report facts</h2>")))
      .toEqual(["The venue is self-run.", "Sealed Report facts"]);
  });

  test("skips record-derived cells and closed disclosure controls", () => {
    const html = page(
      "<p>Authored.</p><ul><li>Record limitation text.</li></ul>"
        + "<table><tr><td>0.102400 solverBrier</td></tr></table>"
        + "<details><summary>cell</summary><p>Forecast 50% Yes</p><h4>Authenticated outputs</h4></details>",
    );
    expect(authoredReportProse(html)).toEqual(["Authored."]);
    // What the strip removed is reported rather than dropped without trace, and reporting is not
    // reviewing -- the cell label below is never handed to a rule. The bare `<li>` and `<td>`
    // carry no authored-shaped child, so nothing is reported for them: this reports the blocks a
    // data-bearing element hides, not the record text it is made of.
    expect(unreviewedReportProse(html)).toEqual([
      { reason: "disclosure-summary", text: "cell" },
      { reason: "nested-in-data-bearing", text: "Forecast 50% Yes" },
      { reason: "nested-in-data-bearing", text: "Authenticated outputs" },
    ]);
  });

  test("skips verbatim blocks and decodes entities", () => {
    expect(authoredReportProse(page("<pre>{\"a\":1}</pre><p>the run&#39;s own owner</p>")))
      .toEqual(["the run's own owner"]);
  });
});

describe("reviewReportProse", () => {
  test("reports a statement the page makes twice, once, with its count", () => {
    const findings = reviewReportProse(page("<p>Built on Jinn.</p><p>Built on Jinn.</p>"));
    expect(findings).toEqual([
      { rule: "repeated-statement", text: "built on jinn", detail: "stated 2 times; issue #3016 requires each fact to appear once" },
    ]);
  });

  test("reports a clause repeated as a sentence elsewhere", () => {
    const findings = reviewReportProse(page(
      "<p>No comparative winner is stated; wilson@1 reports neutral per-arm facts only.</p>"
        + "<p>Its outcomes are synthetic. No comparative winner is stated.</p>",
    ));
    expect(findings.map((finding) => finding.text)).toEqual(["no comparative winner is stated"]);
  });

  test("reports a statement one block makes twice", () => {
    const findings = reviewReportProse(page("<p>Lower is better. The interval is Wilson. Lower is better.</p>"));
    expect(findings).toEqual([
      { rule: "repeated-statement", text: "lower is better", detail: "stated 2 times; issue #3016 requires each fact to appear once" },
    ]);
  });

  test("does not report a statement the page makes once", () => {
    expect(reviewReportProse(page("<p>Lower is better.</p><p>Sealed Report facts</p>"))).toEqual([]);
  });

  test("reports an instruction to operate a self-evident control", () => {
    const findings = reviewReportProse(page("<h3>Open a cell to inspect its evidence</h3>"));
    expect(findings).toEqual([
      { rule: "narrated-control", text: "Open a cell to inspect its evidence", detail: "imperative instruction to operate a control" },
    ]);
  });

  test("does not report an instruction the reader needs", () => {
    expect(reviewReportProse(page("<p>Copy this entire directory. Reproduce publication with the exact verifier:</p>")))
      .toEqual([]);
  });

  test("reports signs of AI writing", () => {
    const signs = [
      "It is important to note that the venue is self-run.",
      "This is a comprehensive account of the run.",
      "The interval underscores the result.",
      "It is not just a tally, but a proof.",
      "Moreover, the venue is self-run.",
      "The venue is self-run, ensuring the operator controls dispatch.",
      "This result is widely regarded as sound.",
    ];
    for (const sign of signs) {
      expect(reviewReportProse(page(`<p>${sign}</p>`)), sign).toHaveLength(1);
      expect(reviewReportProse(page(`<p>${sign}</p>`))[0]!.rule, sign).toBe("signs-of-ai-writing");
    }
  });

  test("leaves each profile's neutral, factual prose alone", () => {
    for (const html of Object.values(profilePage)) {
      for (const block of authoredReportProse(html)) {
        const findings = reviewReportProse(page(`<p>${block.replace(/&/gu, "&amp;")}</p>`))
          .filter((finding) => finding.rule === "signs-of-ai-writing");
        expect(findings, block).toEqual([]);
      }
    }
  });
});

describe("the published report page", () => {
  test("carries exactly the findings the presentation revision retires", () => {
    expect(reviewReportProse(publishedPage).map(({ rule, text }) => ({ rule, text })))
      .toEqual(FROZEN_REPORT_PROSE_FINDINGS.map(({ rule, text }) => ({ rule, text })));
  });

  test("every frozen finding names a rule that still exists", () => {
    const ruleIds = new Set(REPORT_PROSE_RULES.map((rule) => rule.id));
    for (const frozen of FROZEN_REPORT_PROSE_FINDINGS) expect(ruleIds, frozen.text).toContain(frozen.rule);
  });

  test("the derived wilson input rebuilds the published page byte for byte", () => {
    expect(profilePage.wilson).toBe(publishedPage);
  });
});

/**
 * The pairwise branch's own frozen list, in the same register as `FROZEN_REPORT_PROSE_FINDINGS`
 * and read off a real run of the review, not transcribed from a design. Three of the five restate
 * the published page's own entries and cross-reference their rulings; the fourth is a defect this
 * review is the first thing to see.
 */
const PAIRWISE_PROFILE_FINDINGS: readonly FrozenReportProseFinding[] = [
  {
    rule: "repeated-statement",
    text: "no comparative winner is stated",
    ruling: "As on the published page: the claim line in the header states it once.",
  },
  {
    rule: "repeated-statement",
    text: "values below are copied without reconciliation",
    ruling: "As on the published page: stated once, on the first sealed-source section.",
  },
  {
    rule: "repeated-statement",
    text: "exact pairwise-disagreement@1 values from the sealed report",
    ruling:
      "`pairwiseDisagreementFactsHtml` hard-codes this caption and discards the per-source caption "
      + "`armResultsHtml` already hands it, so the Claim section's mirror captions its table as "
      + "coming from the sealed Report. Threading the parameter through retires the repetition "
      + "and the false provenance label together.",
  },
  {
    rule: "repeated-statement",
    text: "built on jinn",
    ruling: "As on the published page: attribution renders once, in the footer imprint.",
  },
  {
    rule: "narrated-control",
    text: "Open a cell to inspect its evidence",
    ruling: "As on the published page: cut.",
  },
] as const;

/**
 * The binary branch's frozen list. Two entries name this fixture's own arms, so they are built
 * from its constants rather than written down -- a fixture with different arms re-derives them.
 */
const BINARY_PROFILE_FINDINGS: readonly FrozenReportProseFinding[] = [
  {
    rule: "repeated-statement",
    text: "facts are presented per instrument without comparative conclusions",
    ruling:
      "Cut from `binaryFactsHtml`. It is a page-level statement `neutralClaimHtml` already makes "
      + "in the header, so the section that repeats it with \"Qualification \" in front says "
      + "nothing new -- and cutting it retires this entry and the twice-stated one below together.",
  },
  {
    rule: "repeated-statement",
    text: "values below are copied without reconciliation",
    ruling: "As on the published page: stated once, on the first sealed-source section.",
  },
  {
    rule: "repeated-statement",
    text: "qualification facts are presented per instrument without comparative conclusions",
    ruling: "Cut with the restatement above; see that entry's ruling.",
  },
  {
    rule: "repeated-statement",
    text: `instrument ${binaryInstrumentSha256(0)}`,
    ruling:
      "Each arm's instrument digest moves into that arm's `<dl class=\"facts\">` as a "
      + "`<dd class=\"digest\">`, where every other digest on the page already lives, so the "
      + "Report section and the Claim mirror stop stating it as prose.",
  },
  {
    rule: "repeated-statement",
    text: "five registered rates with exact denominators and wilson intervals",
    ruling:
      "The rate table takes its caption from `armResultsHtml`'s `wilsonCaption` parameter, as for "
      + "the pairwise profile, so each arm's table names its own source instead of repeating one "
      + "fixed line once per arm per section.",
  },
  {
    rule: "repeated-statement",
    text: `instrument ${binaryInstrumentSha256(1)}`,
    ruling: "As for the first arm's digest; the same move retires both.",
  },
  {
    rule: "repeated-statement",
    text: "built on jinn",
    ruling: "As on the published page: attribution renders once, in the footer imprint.",
  },
] as const;

/**
 * The two profiles the published bundle does not render. Their pages come from `buildPublicAssets`
 * over a substituted-method input (see `methodInput`), so the prose under review is the real
 * literal text of `assets.ts`'s branches, whole-page and in place.
 */
describe.each([
  ["pairwise", PAIRWISE_PROFILE_FINDINGS],
  ["binary", BINARY_PROFILE_FINDINGS],
] as const)("the %s presentation profile", (profile, expected) => {
  test("carries exactly the findings the presentation revision retires", () => {
    expect(reviewReportProse(profilePage[profile]).map(({ rule, text }) => ({ rule, text })))
      .toEqual(expected.map(({ rule, text }) => ({ rule, text })));
  });

  test("every frozen finding names a rule that still exists", () => {
    const ruleIds = new Set(REPORT_PROSE_RULES.map((rule) => rule.id));
    for (const frozen of expected) expect(ruleIds, frozen.text).toContain(frozen.rule);
  });
});

describe.each(["wilson", "pairwise", "binary"] as const)("%s prose length", (profile) => {
  test("does not grow past the pinned prose ceiling", () => {
    expect(reportProseWordCount(profilePage[profile])).toBeLessThanOrEqual(REPORT_PROSE_WORD_CEILINGS[profile]);
  });
});

/**
 * `assets.ts`'s `cellScore`, duplicated deliberately rather than exported for this test. The
 * point of the assertions below is that the rendered bytes match a label derived independently
 * from the verified records; sharing the renderer's own helper would only assert it equals
 * itself.
 */
function cellScore(cell: PublicComparisonCell): string {
  return cell.primaryScore === undefined
    ? "No primary score"
    : `${cell.primaryScore.value} ${cell.primaryScore.name} (${cell.primaryScore.direction})`;
}

function summaryLabel(cell: PublicComparisonCell): string {
  return `${cell.armId} · Task ${cell.taskDigest.slice(0, 12)} · replicate ${cell.replicate} · ${cellScore(cell)}`;
}

describe("unreviewedReportProse", () => {
  // The comparison section is the only place the product nests authored-shaped blocks inside a
  // data-bearing element, and it renders one disclosure control per verified cell -- so the whole
  // expected list is derived from the cells rather than written down.
  test.each(["wilson", "pairwise"] as const)(
    "reports exactly the authored blocks the %s page's data-bearing strip removes",
    (profile) => {
      expect(unreviewedReportProse(profilePage[profile])).toEqual(
        (comparison?.cells ?? []).flatMap((cell) => [
          { reason: "disclosure-summary", text: summaryLabel(cell) },
          { reason: "nested-in-data-bearing", text: cell.outputSummary },
          { reason: "nested-in-data-bearing", text: "Authenticated outputs" },
          { reason: "nested-in-data-bearing", text: "Authenticated verdict evidence" },
        ]),
      );
    },
  );

  test("reports nothing on the binary page, which renders no comparison section", () => {
    expect(unreviewedReportProse(profilePage.binary)).toEqual([]);
  });

  // The enforcement of the reason `DATA_BEARING` gives for passing over `summary` content: it is
  // a record-derived cell label, so one authored word inside a summary fails here.
  test("every disclosure summary is a record-derived cell label", () => {
    expect(unreviewedReportProse(profilePage.wilson)
      .filter((entry) => entry.reason === "disclosure-summary")
      .map((entry) => entry.text))
      .toEqual((comparison?.cells ?? []).map(summaryLabel));
  });

  test("reports an authored block nested in a list item, and reviews none of it", () => {
    const html = page("<ul><li><p>Authored inside a list item.</p></li></ul>");
    expect(authoredReportProse(html)).toEqual([]);
    expect(unreviewedReportProse(html))
      .toEqual([{ reason: "nested-in-data-bearing", text: "Authored inside a list item." }]);
    expect(reviewReportProse(html)).toEqual([]);
  });

  test("reports an authored block nested in a table cell", () => {
    const html = page("<table><tr><td><p>Authored inside a cell.</p></td></tr></table>");
    expect(authoredReportProse(html)).toEqual([]);
    expect(unreviewedReportProse(html))
      .toEqual([{ reason: "nested-in-data-bearing", text: "Authored inside a cell." }]);
  });

  // The summary text is deliberately narration-shaped: it is the exact prose the `narrated-control`
  // rule fails on the published page. Reporting it produces no finding, which is what pins that
  // this function reports rather than reviews.
  test("reports a disclosure summary and the blocks it hides, without reviewing either", () => {
    const html = page("<details><summary>Open the evidence</summary><p>x</p></details>");
    expect(authoredReportProse(html)).toEqual([]);
    expect(unreviewedReportProse(html)).toEqual([
      { reason: "disclosure-summary", text: "Open the evidence" },
      { reason: "nested-in-data-bearing", text: "x" },
    ]);
    expect(reviewReportProse(html)).toEqual([]);
  });
});
