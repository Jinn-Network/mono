// SPDX-License-Identifier: Apache-2.0

/**
 * The export script's drift guard.
 *
 * The published sentences state a shape — 240 items, 80 per class, four strata, six arms, 4,320 of
 * 4,320 cells, 22 counted-neutral results, 7 exclusions all in one arm. The guard's whole job is to
 * make a page whose prose and whose table disagree impossible to emit. So the test builds a
 * synthetic workspace that satisfies the contract exactly, proves the payload comes out, and then
 * moves ONE number at a time and requires a throw that names what moved.
 *
 * The workspace is synthetic rather than the real 2 GB one on purpose: the guard is arithmetic over
 * a sealed Report's own fields, and it must be exercisable in CI with no run material at all.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildLocomoPresentation } from "./locomo-export-presentation.mjs";

const ARMS = ["audited", "backboard", "mem0", "mem0-evidence", "revised", "strict-dial"];
const CLASSES = ["correct", "specific-wrong", "vague-topical-wrong"];
const STRATA = ["category-1", "category-2", "category-3", "category-4"];
const DRAFT = "locomo-judge-report-2026-08-24";
const roots = [];

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function proportion(numerator, denominator) {
  return {
    numerator,
    denominator,
    estimate: (numerator / denominator).toFixed(4),
    wilsonInterval: { low: "0.0000", high: "1.0000" },
  };
}

/** The per-class block the script reads: one `falseAccept`, one `falseReject`, one `parserInvalid`,
 * and the item counts it derives the population from. */
function candidateClassBlock({ items, parserInvalid, excluded }) {
  return {
    agreement: proportion(items - excluded, items - excluded),
    falseAccept: proportion(2, items),
    falseReject: proportion(1, items),
    parserInvalid: proportion(parserInvalid, items * 3),
    item: { expected: items, complete: items - excluded, excluded, unstable: 1 },
    call: { expected: items * 3, evaluated: items * 3, parseInvalid: parserInvalid },
  };
}

/**
 * A sealed Report shaped exactly like the real one on every field the script reads. `overrides`
 * moves one number so a single guard entry fails.
 */
function buildReport(overrides = {}) {
  const {
    itemsPerClass = 80,
    parserInvalidPerArm = { audited: 22 },
    excludedForArm = { "mem0-evidence": { "specific-wrong": 4, "vague-topical-wrong": 2, correct: 1 } },
    arms = ARMS,
    strata = STRATA,
    candidateClasses = CLASSES,
    expected = 4320,
    judged = 4320,
    conflicted = 0,
  } = overrides;
  const excludedTotal = Object.values(excludedForArm)
    .reduce((sum, byClass) => sum + Object.values(byClass).reduce((a, b) => a + b, 0), 0);
  return {
    author: "did:key:zSynthetic",
    limitations: [],
    method: {
      id: "jinn.benchmarking.method/binary-instrument",
      version: "1",
      parameters: { judgeModelProfile: "dated-snapshot-sampling" },
    },
    disclosures: {
      perSubject: [{
        completeness: { expected, judged, floor: 0.995, runOutcome: "complete" },
      }],
    },
    results: {
      perSubject: [{
        results: {
          configuration: {
            candidateClasses,
            strata,
            k: 3,
            reduction: "strict-majority",
            parserInvalidPolicy: "abstain",
            truthAdmission: "screened-operator-sampled",
          },
          conflicted: { count: conflicted, cellKeys: [] },
          excluded: { count: excludedTotal, items: [] },
          arms: Object.fromEntries(arms.map((armId) => {
            const excludedByClass = excludedForArm[armId] ?? {};
            const armExcluded = Object.values(excludedByClass).reduce((a, b) => a + b, 0);
            return [armId, {
              agreement: proportion(itemsPerClass * candidateClasses.length - armExcluded, itemsPerClass * candidateClasses.length - armExcluded),
              item: {
                expected: itemsPerClass * candidateClasses.length,
                complete: itemsPerClass * candidateClasses.length - armExcluded,
                excluded: armExcluded,
                unstable: 1,
              },
              byCandidateClass: Object.fromEntries(candidateClasses.map((candidateClass, index) => [
                candidateClass,
                candidateClassBlock({
                  items: itemsPerClass,
                  // The whole per-arm parser-invalid budget is parked on the first class.
                  parserInvalid: index === 0 ? (parserInvalidPerArm[armId] ?? 0) : 0,
                  excluded: excludedByClass[candidateClass] ?? 0,
                }),
              ])),
              byStratum: Object.fromEntries(strata.map((stratum) => [
                stratum,
                { item: { expected: (itemsPerClass * candidateClasses.length) / strata.length } },
              ])),
            }];
          })),
        },
      }],
    },
  };
}

function buildRun(benchmarkSha256, arms = ARMS) {
  return {
    owner: "did:key:zSynthetic",
    replicates: 3,
    venue: { kind: "self-run" },
    benchmark: { digest: { sha256: benchmarkSha256 } },
    arms: arms.map((armId, index) => ({
      armId,
      pinning: {
        harness: { id: "inspect-ai-judge", version: "1" },
        model: { id: "gpt-4o-mini-2024-07-18" },
        "network.jinn.binary-judgment.instrument": `sha256:${String(index).repeat(64).slice(0, 64)}`,
      },
    })),
  };
}

/** Writes a synthetic workspace whose sealed records are the ones above. */
function workspace(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "locomo-export-"));
  roots.push(root);
  mkdirSync(join(root, "records"), { recursive: true });
  mkdirSync(join(root, "runs"), { recursive: true });

  const seal = (document) => {
    const bytes = Buffer.from(JSON.stringify(document));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(root, "records", `${sha256}.bin`), bytes);
    return sha256;
  };

  const benchmarkSha256 = seal({ name: "locomo-judge-bank", description: "Synthetic 240-item bank" });
  const reportSha256 = seal(buildReport(overrides));
  const runSha256 = seal(buildRun(benchmarkSha256, overrides.arms ?? ARMS));
  writeFileSync(join(root, "runs", `${DRAFT}.json`), JSON.stringify({
    draftId: DRAFT,
    runSha256,
    matrixSha256: "f".repeat(64),
    reportSha256,
    reportEnvelopeSha256: "b".repeat(64),
    reportedAt: "2026-08-28T20:22:04.169Z",
    anchors: [{
      subject: "lock",
      provider: "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1",
      recordSha256: "1".repeat(64),
    }],
    additionalReports: [
      { method: "jinn.benchmarking.method/pairwise-disagreement", version: "1", reportSha256: "2".repeat(64), reportEnvelopeSha256: "3".repeat(64) },
    ],
  }));
  return root;
}

describe("locomo-export-presentation", () => {
  test("emits a complete payload whose every number is read from the sealed record", () => {
    const presentation = buildLocomoPresentation({ workspaceDir: workspace(), draftId: DRAFT });

    assert.equal(presentation.schema, "colophon.report-presentation/2");
    assert.equal(presentation.slug, "judging-the-locomo-judges");
    assert.equal(presentation.population.items, 240);
    assert.equal(presentation.population.perCandidateClass.length, 3);
    assert.equal(presentation.population.perStratum.length, 4);
    assert.equal(presentation.result.perArm.length, 6);
    assert.equal(presentation.accounting.cells.expected, 4320);
    assert.equal(presentation.accounting.cells.judged, 4320);
    assert.equal(presentation.accounting.cells.lost, 0);
    assert.equal(presentation.accounting.parserNeutral.calls, 22);
    assert.equal(presentation.accounting.excludedItems.count, 7);
    assert.deepEqual(presentation.accounting.excludedItems.byArm, [{ armId: "mem0-evidence", items: 7 }]);
    assert.equal(presentation.subject.judgeModel, "gpt-4o-mini-2024-07-18");
    assert.equal(presentation.subject.harness.id, "inspect-ai-judge");
    assert.equal(presentation.execution.replicates, 3);
    // The eighth check is the presentation's own, and it is what a reader of THIS bundle sees.
    assert.ok(presentation.verification.checks.includes("report-presentation"));
    assert.equal(presentation.verification.bundleFormat, "benchmark-product-public-bundle/7");
    // Provenance is carried from the run, not typed.
    assert.equal(presentation.provenance.anchors.length, 1);
    assert.equal(presentation.provenance.siblingAnalyses.length, 1);
    assert.equal(presentation.question.preRegistered.length, 5);
    assert.equal(presentation.limitations.length, 10);
  });

  const drifts = [
    ["the item bank changes size", { itemsPerClass: 60 }, /items: sealed 180/],
    ["a candidate class is added", { candidateClasses: [...CLASSES, "extra"] }, /candidateClasses: sealed 4/],
    ["a stratum is dropped", { strata: STRATA.slice(0, 3) }, /strata: sealed 3/],
    ["an arm is dropped", { arms: ARMS.slice(0, 5) }, /arms: sealed 5/],
    ["a cell goes missing", { judged: 4319 }, /judgedCells: sealed 4319[\s\S]*lostCells: sealed 1/],
    ["the neutral count moves", { parserInvalidPerArm: { audited: 21 } }, /parserNeutralCalls: sealed 21/],
    ["an exclusion appears in a second arm", {
      excludedForArm: { "mem0-evidence": { "specific-wrong": 4, "vague-topical-wrong": 2 }, revised: { correct: 1 } },
    }, /excludedArms: sealed 2/],
    ["a conflicted cell appears", { conflicted: 1 }, /conflictedCells: sealed 1/],
  ];

  for (const [label, overrides, expected] of drifts) {
    test(`refuses to emit when ${label}`, () => {
      assert.throws(
        () => buildLocomoPresentation({ workspaceDir: workspace(overrides), draftId: DRAFT }),
        (error) => /no longer matches the published presentation contract/u.test(error.message)
          && expected.test(error.message),
      );
    });
  }

  test("refuses a report that is not the binary-instrument analysis", () => {
    const root = workspace();
    // Re-point the run at a report whose method is a sibling analysis.
    const runsPath = join(root, "runs", `${DRAFT}.json`);
    const state = JSON.parse(readFileSync(runsPath, "utf8"));
    const report = buildReport();
    report.method.id = "jinn.benchmarking.method/pairwise-disagreement";
    const bytes = Buffer.from(JSON.stringify(report));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(root, "records", `${sha256}.bin`), bytes);
    state.reportSha256 = sha256;
    writeFileSync(runsPath, JSON.stringify(state));

    assert.throws(
      () => buildLocomoPresentation({ workspaceDir: root, draftId: DRAFT }),
      /projects a binary-instrument report/u,
    );
  });

  test("refuses a run that has not been reported", () => {
    const root = workspace();
    const runsPath = join(root, "runs", `${DRAFT}.json`);
    const state = JSON.parse(readFileSync(runsPath, "utf8"));
    delete state.reportSha256;
    writeFileSync(runsPath, JSON.stringify(state));

    assert.throws(
      () => buildLocomoPresentation({ workspaceDir: root, draftId: DRAFT }),
      /report it before presenting it/u,
    );
  });
});
