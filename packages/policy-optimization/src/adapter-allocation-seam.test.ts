// SPDX-License-Identifier: MIT

/**
 * The seam between C8's adapters and C7b's allocator (product §6.2, §8.2).
 *
 * §6.2 says the allocator consumes "the outcomes projection (organic bucket)" and "task
 * informativeness from the curation projection". C7b declared those as **narrow mirrored ports**
 * because the adapters that produce them were a parallel unit. This test is the join those two
 * units otherwise never make:
 *
 *   announcement fixtures
 *     -> curateAnnouncements / deriveOutcomeObservations   (C8's real adapters)
 *     -> projectPolicyOutcomes                             (policy-outcomes' real fold)
 *     -> the allocator's row ports                         (C7b's mirrors)
 *     -> decideAllocation                                  (a coherent decision)
 *
 * Two boundaries are load-bearing and worth stating rather than discovering:
 *
 * - **The tuple is the join key.** The adapter derives a tuple from the (Task, Submission,
 *   profile) triple through `deriveExecutionTuple`; the projection keys rows on its digest; the
 *   allocator keys candidates on the same digest. Nothing coordinates those three — if the
 *   fixture's Submission requirements did not express the admitted candidate's tuple, the rows
 *   would key on a policy the campaign never admitted and the allocator would refuse. The test
 *   asserts the equality directly so a future drift fails here rather than as a silent no-op.
 * - **The curation half stops at the adapter.** C8 deliberately *mirrors*
 *   `@jinn-network/task-curation`'s observation type rather than importing it, and the product's
 *   source boundary denies that tree, so the real curation fold cannot run inside this package.
 *   The informativeness rows below are therefore folded here, from the real adapter's real
 *   observations, using the same `(pass, pass+fail)` definition curation's `CurationRow.passRate`
 *   carries. That is the honest reach of this seam today; see M-C7b-2 in the README.
 */

import { sha256Hex } from "@jinn-network/benchmarking-records";
import { tupleDigest } from "@jinn-network/policy-identity";
import {
  projectPolicyOutcomes,
  type PolicyOutcomesRow,
} from "@jinn-network/policy-outcomes";
import { describe, expect, test } from "vitest";
import { curateAnnouncements, type CurationObservation } from "./adapters/curation-adapter.js";
import {
  deriveOutcomeObservations,
  type AnnouncedPolicyVerdict,
} from "./adapters/outcomes-adapter.js";
import { decideAllocation } from "./allocation.js";
import { CANDIDATE, PARENT, campaignFor, candidateFor } from "./testing/wave-fixtures.js";
import type { AdmittedCandidate, OutcomesProjectionRow, TaskInformativenessRow } from "./wave-types.js";

const THIRD = candidateFor("third", "repo-work-third", "3");
const POPULATION = [PARENT, CANDIDATE, THIRD] as readonly AdmittedCandidate[];

const TASK_A = `sha256:${"a".repeat(64)}`;
const TASK_B = `sha256:${"b".repeat(64)}`;
const PROFILE_URI = "https://jinn.network/task-profiles/policy-c7b-seam/1.0";

/** The profile the fixture Tasks pin, sealed exactly as the deriver re-hashes it. */
const PROFILE_BYTES = new TextEncoder().encode(
  JSON.stringify({ profile: PROFILE_URI, requirementKeys: [] }),
);
const PROFILE = {
  profile: PROFILE_URI,
  sealedBytes: Buffer.from(PROFILE_BYTES).toString("base64"),
  requirementKeys: [] as const,
};
const PROFILE_DIGEST = sha256Hex(PROFILE_BYTES);

let sequence = 0;

/**
 * One announced verdict whose Submission expresses `candidate`'s tuple.
 *
 * `requirements` is the tuple's own axis values, minus `formatToken` — the expression rule from
 * the other direction, and the reason the derived tuple digests back to the admitted candidate.
 */
function announcement(input: {
  readonly candidate: AdmittedCandidate;
  readonly taskDigest: string;
  readonly verdict: "pass" | "fail";
  readonly evaluator: string;
  readonly benchmarkRun?: string;
}): AnnouncedPolicyVerdict {
  sequence += 1;
  const suffix = String(sequence).padStart(4, "0");
  const { formatToken: _formatToken, ...axes } = input.candidate.tuple as Record<string, unknown>;
  return {
    record: {
      kind: "https://jinn.network/records/delivery/1.0",
      digest: `sha256:${"4".repeat(60)}${suffix}`,
    },
    provenance: {
      source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
      entry: `sha256:${"3".repeat(60)}${suffix}`,
      announcementId: `ann-seam-${suffix}`,
    },
    entryTimestamp: `2026-08-03T${String(sequence % 24).padStart(2, "0")}:00:00Z`,
    attemptUri: `urn:uuid:0189d1c2-0000-7000-8000-0000000${suffix}0`,
    statementVerdict: input.verdict,
    subjectTaskDigestFromEvaluationTask: input.taskDigest,
    attributionFromChainEvent: input.evaluator,
    ...(input.benchmarkRun === undefined ? {} : { benchmarkRun: input.benchmarkRun }),
    task: {
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: { uri: PROFILE_URI, digest: { sha256: PROFILE_DIGEST } },
      instructions: "Seam fixture task.",
      outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    },
    submission: {
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: `urn:uuid:0189d1c2-0000-7000-8000-0000000${suffix}1`,
      task: { digest: { sha256: input.taskDigest.slice("sha256:".length) } },
      requester: "urn:jinn:agent:seam-requester",
      idempotencyKey: `seam-${suffix}`,
      nonce: suffix,
      deadline: "2026-08-10T00:00:00Z",
      requirements: axes as Record<string, never>,
    },
    profile: PROFILE,
    fidelityEvidence: { harness: "match", model: "match", loadout: "match" },
  } as AnnouncedPolicyVerdict;
}

/**
 * Organic announcements (no `benchmarkRun`) plus a couple of benchmark-pinned ones, so both
 * buckets are populated and the split the design relies on is visible rather than assumed.
 */
function announcements(): readonly AnnouncedPolicyVerdict[] {
  const evaluator = (index: number) => `urn:jinn:agent:evaluator-${index}`;
  return [
    // organic: parent 2/2, candidate 1/2, third 0/2
    announcement({ candidate: PARENT, taskDigest: TASK_A, verdict: "pass", evaluator: evaluator(1) }),
    announcement({ candidate: PARENT, taskDigest: TASK_B, verdict: "pass", evaluator: evaluator(2) }),
    announcement({ candidate: CANDIDATE, taskDigest: TASK_A, verdict: "pass", evaluator: evaluator(3) }),
    announcement({ candidate: CANDIDATE, taskDigest: TASK_B, verdict: "fail", evaluator: evaluator(4) }),
    announcement({ candidate: THIRD, taskDigest: TASK_A, verdict: "fail", evaluator: evaluator(5) }),
    announcement({ candidate: THIRD, taskDigest: TASK_B, verdict: "fail", evaluator: evaluator(6) }),
    // benchmark-pinned: task A is passed by everyone who touches it — a saturated task.
    announcement({ candidate: PARENT, taskDigest: TASK_A, verdict: "pass", evaluator: evaluator(7), benchmarkRun: "run-1" }),
    announcement({ candidate: CANDIDATE, taskDigest: TASK_A, verdict: "pass", evaluator: evaluator(8), benchmarkRun: "run-1" }),
    announcement({ candidate: THIRD, taskDigest: TASK_A, verdict: "pass", evaluator: evaluator(9), benchmarkRun: "run-1" }),
    announcement({ candidate: PARENT, taskDigest: TASK_A, verdict: "pass", evaluator: evaluator(10), benchmarkRun: "run-1" }),
    // ...and task B still discriminates.
    announcement({ candidate: PARENT, taskDigest: TASK_B, verdict: "pass", evaluator: evaluator(11), benchmarkRun: "run-1" }),
    announcement({ candidate: CANDIDATE, taskDigest: TASK_B, verdict: "fail", evaluator: evaluator(12), benchmarkRun: "run-1" }),
    announcement({ candidate: THIRD, taskDigest: TASK_B, verdict: "fail", evaluator: evaluator(13), benchmarkRun: "run-1" }),
    announcement({ candidate: CANDIDATE, taskDigest: TASK_B, verdict: "pass", evaluator: evaluator(14), benchmarkRun: "run-1" }),
  ];
}

/** `PolicyOutcomesRow` -> the allocator's port. The whole of the mirror, in one place. */
function outcomesPort(rows: readonly PolicyOutcomesRow[]): readonly OutcomesProjectionRow[] {
  return rows.map((row) => ({
    inputRefs: row.inputRefs.map((ref) => ref.record),
    tupleDigest: row.tupleDigest,
    bucket: row.bucket,
    passRate: row.passRate,
  }));
}

/**
 * `CurationObservation[]` -> the allocator's informativeness port, folded here for the reason the
 * module note gives. `passRate` counts decision-grade verdicts only, exactly as `CurationRow` does.
 */
function informativenessPort(
  observations: readonly CurationObservation[],
): readonly TaskInformativenessRow[] {
  const rows = new Map<string, { refs: string[]; pass: number; decisive: number }>();
  for (const observation of observations) {
    const bucket = observation.benchmarkRun === undefined ? "organic" : "benchmark";
    const key = `${bucket}/${observation.taskDigest}`;
    const row = rows.get(key) ?? { refs: [], pass: 0, decisive: 0 };
    row.refs.push(observation.ref.record);
    if (observation.verdict === "pass" || observation.verdict === "fail") row.decisive += 1;
    if (observation.verdict === "pass") row.pass += 1;
    rows.set(key, row);
  }
  return [...rows].map(([key, row]) => {
    const [bucket, taskDigest] = key.split("/");
    return {
      inputRefs: row.refs,
      taskDigest: taskDigest!,
      bucket: bucket as "benchmark" | "organic",
      passRate: { num: row.pass, den: row.decisive },
    };
  });
}

const ANNOUNCEMENTS = announcements();
const OUTCOMES = deriveOutcomeObservations(ANNOUNCEMENTS);
const CURATION = curateAnnouncements(ANNOUNCEMENTS);
const PROJECTION = projectPolicyOutcomes(OUTCOMES.observations);

describe("C8's adapters feed C7b's allocator through the real projection", () => {
  test("every announcement joins; nothing is refused and nothing diverges", () => {
    expect(OUTCOMES.refusals).toEqual([]);
    expect(OUTCOMES.divergentRecordDigestGroups).toEqual([]);
    expect(CURATION.refusals).toEqual([]);
    expect(OUTCOMES.observations).toHaveLength(ANNOUNCEMENTS.length);
    expect(CURATION.observations).toHaveLength(ANNOUNCEMENTS.length);
  });

  test("the adapter's derived tuple is the campaign's admitted policy, digest for digest", () => {
    // The join key. Without this equality the rows below would key on a policy nobody admitted.
    const derived = new Set(OUTCOMES.observations.map((observation) => tupleDigest(observation.tuple)));
    expect([...derived].sort()).toEqual(
      POPULATION.map((candidate) => candidate.tupleDigest).sort(),
    );
  });

  test("the real fold produces one row per (tupleDigest, bucket), with exact ratios", () => {
    const organic = PROJECTION.rows.filter((row) => row.bucket === "organic");
    expect(organic).toHaveLength(3);
    const byTuple = new Map(organic.map((row) => [String(row.tupleDigest), row] as const));
    expect(byTuple.get(PARENT.tupleDigest)!.passRate).toEqual({ num: 2, den: 2 });
    expect(byTuple.get(CANDIDATE.tupleDigest)!.passRate).toEqual({ num: 1, den: 2 });
    expect(byTuple.get(THIRD.tupleDigest)!.passRate).toEqual({ num: 0, den: 2 });
    // Every row carries the announcements it was folded from — what the allocator journals.
    for (const row of organic) expect(row.inputRefs.length).toBeGreaterThan(0);
  });

  test("the mirror lines up with the real row: the port is a projection, not a translation", () => {
    const port = outcomesPort(PROJECTION.rows);
    expect(port).toHaveLength(PROJECTION.rows.length);
    for (const [index, row] of PROJECTION.rows.entries()) {
      const mirrored = port[index]!;
      expect(mirrored.tupleDigest).toBe(row.tupleDigest);
      expect(mirrored.bucket).toBe(row.bucket);
      expect(mirrored.passRate).toEqual(row.passRate);
      expect(mirrored.inputRefs).toEqual(row.inputRefs.map((ref) => ref.record));
    }
  });

  test("drop-bottom-k over real rows prunes on the experiment and journals the real refs", () => {
    // Report rows stand in for the wave the campaign has not run here; the organic rows and the
    // curation rows are the real ones. Ties are what the organic bucket decides.
    const campaign = campaignFor({
      developmentBenchmark: `sha256:${"d".repeat(64)}`,
      promotionBenchmark: `sha256:${"e".repeat(64)}`,
      seeds: [PARENT],
      allocation: { policyRef: "drop-bottom-k/1.0", parameters: { k: 1 } },
    });
    const reportDigest = `sha256:${"9".repeat(64)}`;
    const decision = decideAllocation({
      campaign,
      waveNumber: 2,
      population: POPULATION,
      taskDigests: [TASK_A.slice("sha256:".length), TASK_B.slice("sha256:".length)],
      reports: POPULATION.map((candidate) => ({
        reportDigest,
        waveNumber: 1,
        tupleDigest: candidate.tupleDigest,
        method: campaign.objective.methods[0]!,
        value: candidate.tupleDigest === THIRD.tupleDigest ? "0.1000" : "0.8000",
      })),
      outcomes: outcomesPort(PROJECTION.rows),
      informativeness: informativenessPort(CURATION.observations),
    });

    expect(decision.pruned.map((entry) => entry.tupleDigest)).toEqual([THIRD.tupleDigest]);
    expect(decision.retained).toHaveLength(2);
    // The journaled provenance is the real announcements' record digests, deduped and sorted.
    const organicRefs = PROJECTION.rows
      .filter((row) => row.bucket === "organic")
      .flatMap((row) => row.inputRefs.map((ref) => ref.record));
    expect(decision.inputs.outcomes).toEqual(
      [...new Set([...organicRefs, ...PROJECTION.rows
        .filter((row) => row.bucket === "benchmark")
        .flatMap((row) => row.inputRefs.map((ref) => ref.record))])].sort(),
    );
    expect(decision.inputs.informativeness.length).toBe(ANNOUNCEMENTS.length);
    expect(decision.inputs.reports).toEqual([reportDigest]);
  });

  test("informativeness over real curation observations drops the saturated task", () => {
    const campaign = campaignFor({
      developmentBenchmark: `sha256:${"d".repeat(64)}`,
      promotionBenchmark: `sha256:${"e".repeat(64)}`,
      seeds: [PARENT],
      allocation: {
        policyRef: "informativeness/1.0",
        parameters: { minVerdicts: 4, lower: { num: 2, den: 100 }, upper: { num: 70, den: 100 } },
      },
    });
    const decision = decideAllocation({
      campaign,
      waveNumber: 2,
      population: POPULATION,
      taskDigests: [TASK_A.slice("sha256:".length), TASK_B.slice("sha256:".length)],
      informativeness: informativenessPort(CURATION.observations),
    });
    // Task A's benchmark bucket is 4/4 — everyone passes it, so it discriminates nothing.
    expect(decision.taskDigests).toEqual([TASK_B.slice("sha256:".length)]);
    expect(decision.droppedTasks.map((entry) => entry.taskDigest))
      .toEqual([TASK_A.slice("sha256:".length)]);
    expect(decision.retained).toHaveLength(3);
  });
});
