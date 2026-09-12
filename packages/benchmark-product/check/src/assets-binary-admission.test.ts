// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the published-claim fix (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.8a Group A, ruling C-5).
 *
 * Before this fix, `binaryAdmissionHtml`/`binaryAdmissionMarkdown` branched on the
 * `publicationGrade` BOOLEAN alone, printing the literal words "Yes -- two-human unanimous"
 * whenever `publicationGrade` is true. A screened-operator-sampled bundle is publication-grade
 * under §6.8, so before this fix a screened bundle's public page would have printed a false
 * two-human-unanimous claim. Both render functions now branch on `truthAdmission` (three modes,
 * three wordings) instead of the boolean (two wordings). The two existing strings keep their
 * exact bytes -- half of the byte-compatibility proof; this file asserts that directly.
 *
 * `binaryAdmissionHtml`/`binaryAdmissionMarkdown` only ever read `input.binaryQualification`, so
 * the rest of `PublicAssetInput` is never dereferenced by these two functions and is safely cast
 * away rather than constructed -- building a full binary-instrument qualification projection
 * (confusion matrices, per-arm slices, etc.) would test unrelated machinery this packet does not
 * touch.
 */

import { describe, expect, test } from "vitest";
import { binaryAdmissionHtml, binaryAdmissionMarkdown, type PublicAssetInput } from "./assets.js";

type Admission = NonNullable<PublicAssetInput["binaryQualification"]>;

function inputFor(truthAdmission: Admission["truthAdmission"], publicationGrade: boolean): PublicAssetInput {
  const admission: Admission = {
    publicationGrade,
    truthAdmission,
    sourceManifestSha256: "sha256:" + "1".repeat(64),
    admissionManifestSha256: "sha256:" + "2".repeat(64),
    exclusions: [],
    instruments: [],
  };
  return { binaryQualification: admission } as unknown as PublicAssetInput;
}

describe("binaryAdmissionHtml / binaryAdmissionMarkdown (§6.8a Group A, ruling C-5)", () => {
  test("two-human-unanimous keeps its exact existing HTML bytes", () => {
    const html = binaryAdmissionHtml(inputFor("two-human-unanimous", true));
    expect(html).toContain("<dt>Publication grade</dt><dd>Yes — two-human unanimous</dd>");
  });

  test("operator-only keeps its exact existing HTML bytes", () => {
    const html = binaryAdmissionHtml(inputFor("operator-only", false));
    expect(html).toContain("<dt>Publication grade</dt><dd>No — operator-only</dd>");
  });

  test("screened-operator-sampled renders the new wording, never the two-human claim", () => {
    const html = binaryAdmissionHtml(inputFor("screened-operator-sampled", true));
    expect(html).toContain("<dt>Publication grade</dt><dd>Yes — screened and operator-sampled</dd>");
    expect(html).not.toContain("two-human unanimous");
  });

  test("two-human-unanimous keeps its exact existing Markdown bytes", () => {
    const markdown = binaryAdmissionMarkdown(inputFor("two-human-unanimous", true));
    expect(markdown).toContain("- Publication grade: yes — two-human unanimous\n");
  });

  test("operator-only keeps its exact existing Markdown bytes", () => {
    const markdown = binaryAdmissionMarkdown(inputFor("operator-only", false));
    expect(markdown).toContain("- Publication grade: no — operator-only\n");
  });

  test("screened-operator-sampled renders the new wording, never the two-human claim", () => {
    const markdown = binaryAdmissionMarkdown(inputFor("screened-operator-sampled", true));
    expect(markdown).toContain("- Publication grade: yes — screened and operator-sampled\n");
    expect(markdown).not.toContain("two-human unanimous");
  });

  test("the overclaim test: the publication-grade claim itself never says human, unanimous, or independent", () => {
    // Scoped to the claim line itself, not the whole section -- the section also carries an
    // unrelated, pre-existing "Human disagreement and deterministic replacements" heading (the
    // replacement-ledger sub-heading, present for every admission mode including operator-only
    // today) that §6.1's overclaim test does not govern and this packet does not touch.
    const html = binaryAdmissionHtml(inputFor("screened-operator-sampled", true));
    const htmlClaim = /<dt>Publication grade<\/dt><dd>([^<]+)<\/dd>/.exec(html)?.[1];
    const markdown = binaryAdmissionMarkdown(inputFor("screened-operator-sampled", true));
    const markdownClaim = /^- Publication grade: (.+)$/mu.exec(markdown)?.[1];
    for (const claim of [htmlClaim, markdownClaim]) {
      expect(claim).toBeDefined();
      const lower = claim!.toLowerCase();
      expect(lower).not.toContain("human");
      expect(lower).not.toContain("unanimous");
      expect(lower).not.toContain("independent");
    }
  });
});
