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
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  FROZEN_REPORT_PROSE_FINDINGS,
  REPORT_PROSE_RULES,
  REPORT_PROSE_WORD_CEILING,
  authoredReportProse,
  reportProseWordCount,
  reviewReportProse,
} from "./report-prose-review.js";

const GOLDEN_INDEX = fileURLToPath(
  new URL("../fixtures/public-bundle-conformance-v1/golden/index.html", import.meta.url),
);
const publishedPage = readFileSync(GOLDEN_INDEX, "utf8");

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
    for (const block of authoredReportProse(publishedPage)) {
      const findings = reviewReportProse(page(`<p>${block.replace(/&/gu, "&amp;")}</p>`))
        .filter((finding) => finding.rule === "signs-of-ai-writing");
      expect(findings, block).toEqual([]);
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

  test("does not grow past the pinned prose ceiling", () => {
    expect(reportProseWordCount(publishedPage)).toBeLessThanOrEqual(REPORT_PROSE_WORD_CEILING);
  });
});
