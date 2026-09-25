// SPDX-License-Identifier: Apache-2.0

/**
 * The `slot-denominators` capability on the `/10` report page (issue #3698).
 *
 * The page is byte-pinned: `verifyPublicBundleSnapshot` rebuilds every presentation asset from the
 * vector `bundle.json` declares and refuses any mismatch. So the load-bearing block is the first
 * one. A wilson `/10` bundle that does not declare the capability keeps the page it was sealed with
 * (operator ruling, 2026-09-24), and that page is pinned here by the digests the golden facts
 * rendered at `/10` before this capability existed, not by comparing two renders of this build.
 *
 * The rest is the feature: declared, the Report's arm table carries the declared denominator, the
 * strict all-slots one, and the planned slots the declared one leaves out, taken from
 * `armDenominators`, and no other byte of any asset moves.
 */

import { createHash } from "node:crypto";
import { BENCHMARKING_METHOD_IDS } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { armDenominators } from "./denominators.js";
import { BUNDLE_FORMAT } from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT } from "./manifest.js";
import { reportProseWordCount, reviewReportProse } from "./report-prose-review.js";
import { expectRefusal } from "./testing/expect-refusal.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The golden facts' five `/10` assets as this package rendered them before `slot-denominators`
 * was registered. A deliberate change to the undeclared `/10` page is a change to bundles already
 * made, and has to be made here, in the open. */
const UNDECLARED_V10_DIGESTS = {
  "index.html": "249cd96b4cfa41e53465b6b122a4c948dffaf2ec9290425744b098d4749efbd7",
  "badge.svg": "030c5f09198857deae3e48367a5ad119f493bf93e88049e08ceb672b8fc16a4b",
  "social-card.svg": "e073b7597569808e32e068a951840384119c2ce90992ca16b341b24354143f15",
  "README.md": "02ac685fe2557a57c9d574d56be7c50dacaad91413957cda6423b89cb127ed4d",
  "share.txt": "a6fdc31f6db9568189569b3b8084a56545d57796ab127c531a62256575be92d5",
};

const golden: PublicAssetInput = await goldenInput(BUNDLE_V10_FORMAT);
const undeclared = buildPublicAssets(golden);
const declared = buildPublicAssets({ ...golden, capabilities: ["slot-denominators"] });

const REPORT_SECTION_START = '<section aria-labelledby="report-heading">';

/** The page before the Report section, the Report section, and the rest. */
function splitAtReportSection(html: string): readonly [string, string, string] {
  const start = html.indexOf(REPORT_SECTION_START);
  const end = html.indexOf("</section>", start) + "</section>".length;
  expect(start).toBeGreaterThan(-1);
  return [html.slice(0, start), html.slice(start, end), html.slice(end)];
}

/** Each arm row of the Report's wilson table, as the undeclared page renders it. */
function reportArms(section: string): { armId: string; n: number }[] {
  return [...section.matchAll(/<tr><th scope="row">([^<]+)<\/th><td>(\d+)<\/td>/gu)]
    .map((match) => ({ armId: match[1]!, n: Number(match[2]) }));
}

describe("undeclared, the /10 page is the page bundles already carry", () => {
  for (const [label, capabilities] of [
    ["an absent vector", undefined],
    ["the empty vector", []],
    ["a vector naming every other capability a wilson run can declare", ["anchoring", "external-import"]],
  ] as const) {
    test(`${label}: all five assets are byte-identical to before the capability existed`, () => {
      const assets = buildPublicAssets(capabilities === undefined ? golden : { ...golden, capabilities });
      expect(Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, sha256(bytes)])))
        .toEqual(UNDECLARED_V10_DIGESTS);
    });
  }
});

describe("declared, the Report's arm table carries the pair", () => {
  test("the four assets other than the report page do not move", () => {
    expect(Object.keys(declared).sort()).toEqual(Object.keys(undeclared).sort());
    for (const name of ["badge.svg", "social-card.svg", "README.md", "share.txt"]) {
      expect(decode(declared[name]!), name).toBe(decode(undeclared[name]!));
    }
  });

  test("only the Report's arm table changes, by exactly the pair from armDenominators", () => {
    const [beforeOld, reportOld, afterOld] = splitAtReportSection(decode(undeclared["index.html"]!));
    const [beforeNew, reportNew, afterNew] = splitAtReportSection(decode(declared["index.html"]!));
    // Everything outside the Report section is untouched, the stored Claim's mirror of the same
    // arms included: the pair is stated once.
    expect(beforeNew).toBe(beforeOld);
    expect(afterNew).toBe(afterOld);

    const arms = reportArms(reportOld);
    expect(arms.length).toBeGreaterThan(0);
    const pairs = armDenominators(arms, golden.matrix.attrition);
    let expected = reportOld.replace(
      '<th scope="col">n</th>',
      '<th scope="col">n</th><th scope="col">All planned slots (Matrix)</th><th scope="col">Planned slots not in n</th>',
    );
    for (const pair of pairs) {
      // Derived, never re-spelled: the strict number is the Matrix's own per-arm `expected`.
      expect(pair.allSlots).toBe(golden.matrix.attrition.perArm[pair.armId]!.expected);
      const row = `<tr><th scope="row">${pair.armId}</th><td>${pair.declared}</td>`;
      expect(expected.split(row)).toHaveLength(2);
      expected = expected.replace(row, `${row}<td>${pair.allSlots}</td><td>${pair.excludedFromDeclared}</td>`);
    }
    expect(reportNew).toBe(expected);
  });

  test("the added cells are data, so the prose review reads the declared page as the undeclared one", () => {
    const [before, after] = [decode(undeclared["index.html"]!), decode(declared["index.html"]!)];
    expect(reportProseWordCount(after)).toBe(reportProseWordCount(before));
    expect(reviewReportProse(after)).toEqual(reviewReportProse(before));
  });

  test("planned slots the declared denominator leaves out are counted, and a negative count is stated", () => {
    // The golden run excluded nothing, so its pair reads 0 on every arm. Planned-slot counts above
    // and below each arm's `n` exercise both directions through the same derivation.
    const [, reportOld] = splitAtReportSection(decode(undeclared["index.html"]!));
    const arms = reportArms(reportOld);
    const perArm = Object.fromEntries(arms.map(({ armId, n }, index) => [
      armId,
      { ...golden.matrix.attrition.perArm[armId]!, expected: index === 0 ? n + 2 : n - 1 },
    ]));
    const matrix = { ...golden.matrix, attrition: { ...golden.matrix.attrition, perArm } };
    const [, report] = splitAtReportSection(decode(buildPublicAssets({
      ...golden,
      capabilities: ["slot-denominators"],
      matrix,
    })["index.html"]!));
    const pairs = armDenominators(arms, matrix.attrition);
    expect(pairs.map((pair) => pair.excludedFromDeclared)).toEqual(arms.map((_, index) => index === 0 ? 2 : -1));
    for (const pair of pairs) {
      expect(report).toContain(
        `<tr><th scope="row">${pair.armId}</th><td>${pair.declared}</td><td>${pair.allSlots}</td><td>${pair.excludedFromDeclared}</td>`,
      );
    }
  });

  test("an arm the Matrix carries no accounting for withholds its strict number rather than reading zero", () => {
    const [, reportOld] = splitAtReportSection(decode(undeclared["index.html"]!));
    const [, report] = splitAtReportSection(decode(buildPublicAssets({
      ...golden,
      capabilities: ["slot-denominators"],
      matrix: { ...golden.matrix, attrition: { ...golden.matrix.attrition, perArm: {} } },
    })["index.html"]!));
    for (const { armId, n } of reportArms(reportOld)) {
      expect(report).toContain(`<tr><th scope="row">${armId}</th><td>${n}</td><td>Not stated</td><td>Not stated</td>`);
    }
  });
});

describe("a declaration the page cannot honor is refused", () => {
  test("declared over a Report that is not wilson@1", () => {
    const results = {
      perSubject: [{
        subjectSha256: golden.matrixSha256,
        results: {
          pairs: [{ armA: "arm-a", armB: "arm-b", n: 6, disagreements: 1, rate: "0.1667", interval: { lower: "0.0100", upper: "0.3200", alpha: "0.05" } }],
          conflicted: { count: 0, cellKeys: [] },
        },
      }],
    };
    const method = { id: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: "1", parameters: {} };
    const pairwise = {
      ...golden,
      report: { ...golden.report, method, results },
      claim: { ...golden.claim, method: { ...golden.claim.method, id: method.id, parameters: {} }, results },
    } as unknown as PublicAssetInput;
    expect(() => buildPublicAssets(pairwise)).not.toThrow();
    const refusal = expectRefusal(() => buildPublicAssets({ ...pairwise, capabilities: ["slot-denominators"] }));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.issues[0]).toEqual(expect.objectContaining({ path: "bundle.manifest.capabilities" }));
    expect(refusal.issues[0]!.message).toContain("slot-denominators");
  });

  test("a vector on a format that states capability by its number", () => {
    const refusal = expectRefusal(() => buildPublicAssets({ ...golden, format: BUNDLE_FORMAT, capabilities: [] }));
    expect(refusal.issues[0]).toEqual(expect.objectContaining({ path: "bundle.presentation" }));
  });

  test("a vector the registry does not admit", () => {
    for (const capabilities of [["zz-unknown"], ["slot-denominators", "anchoring"]]) {
      const refusal = expectRefusal(() => buildPublicAssets({ ...golden, capabilities }));
      expect(refusal.issues[0], JSON.stringify(capabilities))
        .toEqual(expect.objectContaining({ path: "bundle.manifest.capabilities" }));
    }
  });
});
