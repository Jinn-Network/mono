// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3016: the report page's prose review, and the ratchet that keeps it running.
 *
 * The first test set covers the rules themselves. The second runs the review over the page the
 * product actually renders and requires its findings to be exactly
 * `FROZEN_REPORT_PROSE_FINDINGS`. That is the criterion's "runs as part of producing a report,
 * not as a one-off cleanup": new prose that repeats a statement, narrates a control, or reads as
 * machine-written fails the build of the package that produces reports, and a frozen finding
 * cannot be quietly forgotten because a dead entry fails too.
 *
 * That subject is the composed `/10` rendering, not the golden bundle's published `/2` bytes
 * (issue #4191). The frozen list was never a waiver list: it recorded findings a byte-pinned page
 * still carried together with the wording that replaces them, and `/10` renders the replacement.
 * Reviewing `/2` from here would freeze the ratchet against a page no future revision can change.
 * The proof that those published bytes did not move lives in `assets-report-prose.test.ts`, which
 * builds its page from the same `goldenInput` helper so the two suites cannot pin different pages.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { buildPublicAssets } from "./assets.js";
import { BUNDLE_V10_FORMAT } from "./manifest.js";
import {
  FROZEN_REPORT_PROSE_FINDINGS,
  REPORT_PROSE_RULES,
  REPORT_PROSE_WORD_CEILING,
  authoredReportProse,
  reportProseWordCount,
  reviewReportProse,
} from "./report-prose-review.js";
import { goldenInput } from "./testing/golden-asset-input.js";

/** The golden bundle's own verified facts, rendered at the current presentation format. */
let composedPage: string;

beforeAll(async () => {
  composedPage = new TextDecoder().decode(
    buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT))["index.html"]!,
  );
});

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

  test("leaves the page's neutral, factual prose alone", () => {
    for (const block of authoredReportProse(composedPage)) {
      const findings = reviewReportProse(page(`<p>${block.replace(/&/gu, "&amp;")}</p>`))
        .filter((finding) => finding.rule === "signs-of-ai-writing");
      expect(findings, block).toEqual([]);
    }
  });
});

describe("the report page this revision renders", () => {
  test("carries exactly the findings the frozen list still records", () => {
    expect(reviewReportProse(composedPage).map(({ rule, text }) => ({ rule, text })))
      .toEqual(FROZEN_REPORT_PROSE_FINDINGS.map(({ rule, text }) => ({ rule, text })));
  });

  test("every frozen finding names a rule that still exists", () => {
    // Vacuous while the frozen list is empty (issue #4191 retired all four): the page this
    // revision renders carries no finding, so this asserts nothing today. It is kept armed rather
    // than deleted because the list is the mechanism, not a one-off -- the next presentation
    // revision that defers a finding refills it, and this is the check that stops a deferral from
    // naming a rule the review no longer runs.
    const ruleIds = new Set(REPORT_PROSE_RULES.map((rule) => rule.id));
    for (const frozen of FROZEN_REPORT_PROSE_FINDINGS) expect(ruleIds, frozen.text).toContain(frozen.rule);
  });

  test("does not grow past the pinned prose ceiling", () => {
    expect(reportProseWordCount(composedPage)).toBeLessThanOrEqual(REPORT_PROSE_WORD_CEILING);
  });
});
