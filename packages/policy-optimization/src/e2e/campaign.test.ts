// SPDX-License-Identifier: MIT

/**
 * C9 — the end-to-end campaign, asserted (program §1 C9).
 *
 * The e2e **is** the test: almost everything here is composition of surfaces their own units
 * already cover, so what this file adds is the claim that they compose — that a campaign runs
 * start to finish on the local venue, that the gates bite where the design says they bite, and
 * that the operator ends exactly where they started.
 *
 * The campaign runs once, at module scope. Every `test` below reads the same run, so a failure
 * names which property broke rather than re-running the whole loop per assertion.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTreeLearnerPublicV1, parseExactCandidateManifest, tupleDigest } from "@jinn-network/policy-identity";
import { afterAll, describe, expect, test } from "vitest";
import { openCampaign } from "../journal-store.js";
import { journalEntryText } from "../journal-entry.js";
import { CAMPAIGN_JOURNAL_FILENAME } from "../tokens.js";
import { committedCells } from "../wave.js";
import { readAdoptionLog, archiveLayout, defaultArchiveRoot, readArchiveProjection } from "../archive/index.js";
import { runE2ECampaign, HONESTY_RESIDUALS } from "./campaign.js";
import { loadLearnerCandidateFixture } from "./learner-fixture.js";
import {
  DEVELOPMENT_INSTANCES,
  LEARNER_PROPOSER,
  PROMOTION_INSTANCES,
  SEED_TREE,
  tupleForTree,
} from "./fixtures.js";

const roots: string[] = [];
function scratchDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "jinn-c9-"));
  roots.push(root);
  return join(root, "campaign");
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const learnerCandidate = loadLearnerCandidateFixture();
const outcome = await runE2ECampaign({
  directory: scratchDirectory(),
  learnerCandidate,
});

describe("the campaign walks the whole lifecycle", () => {
  test("DRAFT -> EXPLORING -> CONFIRMING -> CLOSED", () => {
    expect(outcome.handle.state.phase).toBe("CLOSED");
  });

  test("the journal records every product decision, in order", () => {
    expect(outcome.handle.entries.map((entry) => entry.type)).toEqual([
      "created",
      // five admissions, then four refusals
      "candidate-admitted", "candidate-admitted", "candidate-admitted",
      "candidate-admitted", "candidate-admitted",
      "candidate-rejected", "candidate-rejected", "candidate-rejected", "candidate-rejected",
      // the development wave
      "wave-planned", "run-sealed", "matrix-assembled", "report-recorded",
      "allocation-decided",
      // the single promotion Run
      "promotion-run-sealed", "matrix-assembled", "report-recorded",
      // `frontier-updated` precedes `closed` because `closed` is terminal (§5.2) — see F-C9-3.
      "frontier-updated",
      "closed",
    ]);
  });

  test("the campaign's spend is reconstructable from its own journal", () => {
    const arms = outcome.participants.length;
    const survivors = outcome.promotionPlan.arms.length;
    expect(committedCells(outcome.handle.entries)).toEqual({
      development: arms * DEVELOPMENT_INSTANCES.length,
      promotion: survivors * PROMOTION_INSTANCES.length,
      total: arms * DEVELOPMENT_INSTANCES.length + survivors * PROMOTION_INSTANCES.length,
    });
  });

  test("every stage reported a narrative and at least one fact", () => {
    expect(outcome.stages.length).toBeGreaterThanOrEqual(10);
    for (const stage of outcome.stages) {
      expect(stage.title, `stage ${stage.number}`).not.toBe("");
      expect(stage.facts.length, stage.title).toBeGreaterThan(0);
    }
  });
});

describe("admission ran for real, and the gate bit", () => {
  test("all eleven checks reported `pass` — none was skipped into vacuity", () => {
    expect(outcome.checksPassed).toEqual([
      "evidence-bundle",
      "frozen-axes",
      "lexical-scan",
      "manifest",
      "materialization",
      "mutable-paths",
      "mutation-surface",
      "payload-consent",
      "population",
      "signature",
      "smoke-canary",
    ]);
  });

  test("four candidates were refused, each for a different real reason", () => {
    expect(outcome.rejections.map((entry) => entry.failedCheck)).toEqual([
      "lexical-scan",
      "payload-consent",
      "frozen-axes",
      "evidence-bundle",
    ]);
    expect(outcome.rejections.map((entry) => entry.reason)).toEqual([
      "held-out-contamination",
      "payload-consent-required",
      "frozen-axis-disagreement",
      "evidence-bundle-mismatch",
    ]);
  });

  test("a rejection still reports every check, not only the failing one", () => {
    for (const rejection of outcome.rejections) {
      expect(rejection.checks, rejection.label).toBe(11);
    }
  });

  test("population membership is keyed by tupleDigest, one arm per distinct policy", () => {
    const digests = new Set(outcome.participants.map((entry) => entry.candidate.tupleDigest));
    expect(digests.size).toBe(outcome.participants.length);
  });
});

describe("the proposers are interchangeable (§7.2's falsifier)", () => {
  test("the reference proposer produced the candidates the budget allowed", () => {
    const referenceCandidates = outcome.participants.filter((entry) =>
      entry.label.startsWith("ablate "));
    expect(referenceCandidates.length).toBe(3);
  });

  test("the shipped learner's candidate was admitted through the same unmodified gate", () => {
    expect(outcome.learner).toBeDefined();
    expect(outcome.learner!.proposer).toBe(LEARNER_PROPOSER);
    expect(parseExactCandidateManifest(learnerCandidate.manifestBytes).proposer)
      .toBe(LEARNER_PROPOSER);
  });

  test("nothing on a wave arm names which proposer produced it", () => {
    for (const arm of outcome.devPlan.arms) {
      expect(Object.keys(arm).sort()).toEqual(["armId", "pinning", "source", "tupleDigest"]);
      expect(JSON.stringify(arm)).not.toContain("learner");
      expect(JSON.stringify(arm)).not.toContain("reference");
    }
  });
});

describe("the C6 -> C7c seam: the learner's output is admissible input", () => {
  const manifest = parseExactCandidateManifest(learnerCandidate.manifestBytes);

  test("the committed tree hashes to the digest the committed manifest pins", () => {
    // The cross-implementation agreement this fixture exists to prove: `client`'s directory-walking
    // `hashImplStateDir(dir, {profile: 'learner-public.v1'})` and this package's in-memory
    // `hashTreeLearnerPublicV1` are two implementations of one profile, and they agree.
    const loadout = manifest.policy.loadout as Record<string, unknown>;
    expect(loadout["digest"]).toBe(`sha256:${hashTreeLearnerPublicV1(learnerCandidate.tree)}`);
  });

  test("the learner's declared parent really is this campaign's seed policy", () => {
    expect(manifest.parents).toHaveLength(1);
    expect(manifest.parents[0]!.kind).toBe("tuple");
    expect(manifest.parents[0]!.digest).toBe(tupleDigest(tupleForTree(SEED_TREE)));
  });

  test("the learner's tuple byte-shares the campaign's frozen axes", () => {
    for (const [axis, value] of Object.entries(outcome.campaign.frozenAxes)) {
      expect(manifest.policy[axis], axis).toEqual(value);
    }
  });

  test("the manifest carries no score, rating, or self-assessment", () => {
    const text = new TextDecoder().decode(learnerCandidate.manifestBytes).toLowerCase();
    for (const banned of ["score", "rating", "confidence", "selfassessment", "quality"]) {
      expect(text).not.toContain(`"${banned}"`);
    }
  });
});

describe("the development wave, verified cell by honest cell", () => {
  test("the quote named the cells and the keys the venue enforces", () => {
    expect(outcome.devQuote.cells).toBe(
      outcome.participants.length * DEVELOPMENT_INSTANCES.length,
    );
    expect([...outcome.devQuote.requiredKeys].sort())
      .toEqual(["harness", "isolationPolicy", "loadout", "model"]);
  });

  test("every honest cell verifies per-axis through the local pinning bridge", () => {
    for (const cell of outcome.devMatrix.cells) {
      if (cell.cellKey === outcome.swappedCellKey) continue;
      expect(cell.verification, cell.cellKey).toEqual({
        harness: "match",
        model: "match",
        loadout: "match",
        // `match` by VACUITY (substrate §4.3) — the tri-state answers whether the pin was honored,
        // not whether honoring it asserted anything.
        isolation: "match",
        checksFailed: [],
      });
      expect(cell.outcome, cell.cellKey).toBe("judged");
      expect(cell.integrityTier, cell.cellKey).toBe("re-derivable");
    }
  });

  test("the deliberately-swapped cell surfaces as a mismatch and is invalidated", () => {
    const swapped = outcome.devMatrix.cells.find(
      (cell) => cell.cellKey === outcome.swappedCellKey,
    )!;
    expect(swapped.verification.loadout).toBe("mismatch");
    expect(swapped.verification.checksFailed).toContain("pinning-observation");
    // Outcome precedence: a pinning mismatch invalidates the cell even with a valid verdict.
    expect(swapped.outcome).toBe("invalidated");
  });

  test("the development Report is exploratory by construction", () => {
    expect(outcome.devPreregistered).toBe(false);
    expect(outcome.devPlan.run.record.analysisPlan).toBeUndefined();
  });
});

describe("the promotion discipline (§6.3)", () => {
  test("the promotion Run is preregistered, flat, and admitted exactly once", () => {
    expect(outcome.promotionPreregistered).toBe(true);
    expect(outcome.promotionPlan.kind).toBe("promotion");
    expect(outcome.promotionPlan.allocation).toBeUndefined();
    expect(outcome.promotionPlan.run.record.analysisPlan).toHaveLength(1);
    const sealed = outcome.handle.entries.filter((entry) => entry.type === "promotion-run-sealed");
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.payload["revealedItems"]).toBe(PROMOTION_INSTANCES.length);
  });

  test("pruning happened at the dev wave and not at the gate", () => {
    expect(outcome.pruned).toHaveLength(1);
    expect(outcome.promotionPlan.arms.length).toBe(outcome.participants.length - 1);
    // The pruned arm is the one with the worst development record.
    const prunedParticipant = outcome.participants.find(
      (entry) => entry.candidate.tupleDigest === outcome.pruned[0],
    )!;
    const worst = Math.min(...outcome.participants.map((entry) => entry.devPasses));
    expect(prunedParticipant.devPasses).toBe(worst);
  });

  test("the allocation journaled the rows and Reports it consumed", () => {
    const decided = outcome.handle.entries.find((entry) => entry.type === "allocation-decided")!;
    const inputs = decided.payload["inputs"] as { reports: string[]; outcomes: string[] };
    expect(inputs.reports).toHaveLength(1);
    expect(inputs.outcomes).toHaveLength(outcome.participants.length);
  });

  test("the campaign's output is a recommendation plus a signed Report — never an activation", () => {
    const closed = outcome.handle.entries.find((entry) => entry.type === "closed")!;
    expect(closed.payload["recommendation"]).toBe(outcome.recommendation.tupleDigest);
    expect(closed.payload["basis"]).toBe(outcome.promotionReport.digest);
    // The recommended policy is the one that actually won the gate.
    const recommended = outcome.participants.find(
      (entry) => entry.candidate.tupleDigest === outcome.recommendation.tupleDigest,
    )!;
    const best = Math.max(...outcome.promotionPlan.arms.map((arm) =>
      outcome.participants.find((p) => p.candidate.tupleDigest === arm.tupleDigest)!.gatePasses));
    expect(recommended.gatePasses).toBe(best);
  });
});

describe("the archive is derived, and says so", () => {
  test("lineage covers every admitted manifest", () => {
    expect(outcome.lineageNodes).toBe(outcome.participants.length);
  });

  test("the frontier is a non-empty set of non-dominated members", () => {
    expect(outcome.frontier.length).toBeGreaterThan(0);
    expect(new Set(outcome.frontier).size).toBe(outcome.frontier.length);
  });

  test("the projection is written under a directory whose name says it is derived", () => {
    const layout = archiveLayout(defaultArchiveRoot(outcome.directory));
    expect(layout.projectionPath).toContain("derived");
    const projection = readArchiveProjection(layout)!;
    expect(projection.derived).toBe(true);
  });

  test("the adoption log sits outside `derived/` and is labelled non-derivable", () => {
    const layout = archiveLayout(defaultArchiveRoot(outcome.directory));
    expect(layout.adoptionPath).not.toContain("derived");
    expect(readAdoptionLog(layout).nonDerivable).toBe(true);
  });
});

describe("adopt -> rollback leaves the operator byte-identically where they started", () => {
  test("the rollback restored the seed policy", () => {
    expect(outcome.adoption.afterRollbackTuple).toBe(outcome.seed.candidate.tupleDigest);
    expect(outcome.adoption.adoptedTuple).toBe(outcome.recommendation.tupleDigest);
  });

  test("the run pinning the operator ends on is byte-identical to the one they began on", () => {
    expect(outcome.adoption.afterRollbackFragment).toBe(outcome.adoption.baselineFragment);
    expect(outcome.adoption.byteIdentical).toBe(true);
  });

  test("the rollback is appended as a decision, not a deletion", () => {
    const layout = archiveLayout(defaultArchiveRoot(outcome.directory));
    const log = readAdoptionLog(layout);
    expect(log.records).toHaveLength(3);
    expect(log.records[2]!.tupleDigest).toBe(outcome.seed.candidate.tupleDigest);
    // The gate does not re-run on a retreat; the approvals are copied from the restored record.
    expect(log.records[2]!.payloadClassesApproved).toEqual(log.records[0]!.payloadClassesApproved);
  });
});

describe("replaying the journal reconstructs the same campaign", () => {
  test("the reopened entries are byte-identical to the appended ones", () => {
    const reopened = openCampaign(outcome.directory);
    expect(reopened.entries.map(journalEntryText))
      .toEqual(outcome.handle.entries.map(journalEntryText));
    expect(reopened.state).toEqual(outcome.handle.state);
    expect(reopened.digest).toBe(outcome.handle.digest);
  });

  test("the file on disk is exactly the canonical lines, one per entry", () => {
    const text = readFileSync(join(outcome.directory, CAMPAIGN_JOURNAL_FILENAME), "utf8");
    expect(text.split("\n").filter((line) => line !== ""))
      .toEqual(outcome.handle.entries.map(journalEntryText));
  });

  test("the replayed handle derives the same phase and the same spend", () => {
    const reopened = openCampaign(outcome.directory);
    expect(reopened.state.phase).toBe("CLOSED");
    expect(committedCells(reopened.entries)).toEqual(committedCells(outcome.handle.entries));
  });
});

describe("the run states what it does not prove", () => {
  test("every §11 residual is carried as run output, not left to the reader", () => {
    expect(HONESTY_RESIDUALS.length).toBeGreaterThanOrEqual(5);
    const text = HONESTY_RESIDUALS.join(" ").toLowerCase();
    expect(text).toContain("operator-local");
    expect(text).toContain("vacuity");
    expect(text).toContain("discipline, not mechanism");
    expect(text).toContain("anchored-venue");
  });
});
