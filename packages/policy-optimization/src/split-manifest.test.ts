import { canonicalJsonBytes, prefixedDigest } from "@jinn-network/policy-identity";
import { describe, expect, test } from "vitest";
import {
  consumePromotionGroups,
  formPolicyOptimizationSplit,
  parseExactPolicyOptimizationSplitManifest,
  type SplitPoolCandidate,
} from "./split-manifest.js";

const digestBytes = (label: string) => {
  const bytes = new TextEncoder().encode(label);
  return { bytes, digest: prefixedDigest(bytes) };
};

function candidate(index: number, overrides: Partial<SplitPoolCandidate> = {}): SplitPoolCandidate {
  const task = digestBytes(`task-${index}`);
  const evaluationSpec = digestBytes(`evaluation-${index}`);
  const receipt = digestBytes(`receipt-${index}`);
  return {
    id: `work-${String(index).padStart(2, "0")}`,
    task,
    evaluationSpec,
    admission: {
      receiptBytes: receipt.bytes,
      receiptDigest: receipt.digest,
      verified: true,
      positive: true,
      taskDigest: task.digest,
      evaluationSpecDigest: evaluationSpec.digest,
    },
    repository: `org/repo-${index}`,
    sourceLineage: [`source-${index}`],
    workIdentity: `upstream-${index}`,
    tupleClass: "repository-work/1.0",
    compatible: true,
    previouslyAttempted: false,
    contaminated: false,
    scorable: true,
    ...overrides,
  };
}

const seed = { tupleDigest: `sha256:${"1".repeat(64)}`, snapshotDigest: `sha256:${"2".repeat(64)}` };

describe("PolicyOptimizationSplitManifest/1.0", () => {
  test("forms connected components and gives every extra group to promotion", () => {
    const candidates = Array.from({ length: 14 }, (_, index) => candidate(index));
    candidates.push(candidate(14, { repository: "org/repo-0", sourceLineage: ["source-14"] }));
    const sealed = formPolicyOptimizationSplit({ candidates, tupleClass: "repository-work/1.0", seed });
    expect(sealed.manifest.groups).toHaveLength(14);
    expect(sealed.manifest.assignments.training).toHaveLength(3);
    expect(sealed.manifest.assignments.development).toHaveLength(3);
    expect(sealed.manifest.assignments.promotion).toHaveLength(8);
    expect(parseExactPolicyOptimizationSplitManifest(sealed.bytes)).toEqual(sealed.manifest);
  });

  test("records fail-closed exclusions and never pads a shortfall", () => {
    const candidates = Array.from({ length: 13 }, (_, index) => candidate(index));
    candidates.push(candidate(20, { contaminated: true }));
    candidates.push(candidate(21, { workIdentity: "upstream-0" }));
    const sealed = formPolicyOptimizationSplit({ candidates, tupleClass: "repository-work/1.0", seed });
    expect(sealed.manifest.exclusions).toEqual([
      { id: "work-20", reason: "contaminated" },
      { id: "work-21", reason: "duplicate-lineage" },
    ]);
    expect(() => formPolicyOptimizationSplit({
      candidates: candidates.slice(0, 11), tupleClass: "repository-work/1.0", seed,
    })).toThrow(/never split or padded/u);
  });

  test("refuses digest substitution, unknown fields, and duplicate-key encodings", () => {
    const candidates = Array.from({ length: 13 }, (_, index) => candidate(index));
    candidates[0] = candidate(0, { task: { ...candidate(0).task, digest: `sha256:${"0".repeat(64)}` } });
    const substituted = formPolicyOptimizationSplit({ candidates, tupleClass: "repository-work/1.0", seed });
    expect(substituted.manifest.exclusions[0]).toEqual({ id: "work-00", reason: "malformed" });

    const valid = formPolicyOptimizationSplit({
      candidates: Array.from({ length: 12 }, (_, index) => candidate(index)),
      tupleClass: "repository-work/1.0", seed,
    });
    const withUnknown = canonicalJsonBytes({ ...valid.manifest, surprise: true });
    expect(() => parseExactPolicyOptimizationSplitManifest(withUnknown)).toThrow(/splitManifest/u);
    const text = new TextDecoder().decode(valid.bytes);
    const duplicate = new TextEncoder().encode(text.replace("{", `{"formatToken":"${valid.manifest.formatToken}",`));
    expect(() => parseExactPolicyOptimizationSplitManifest(duplicate)).toThrow(/canonical/u);

    const changedGroup = JSON.parse(JSON.stringify(valid.manifest));
    changedGroup.groups[0]!.repositories[0] = "org/substituted";
    expect(() => parseExactPolicyOptimizationSplitManifest(canonicalJsonBytes(changedGroup)))
      .toThrow(/groupId/u);

    const changedPool = JSON.parse(JSON.stringify(valid.manifest));
    changedPool.poolSnapshot.entries[0]!.taskDigest = `sha256:${"9".repeat(64)}`;
    expect(() => parseExactPolicyOptimizationSplitManifest(canonicalJsonBytes(changedPool)))
      .toThrow(/snapshot digest/u);

    const changedAssignment = JSON.parse(JSON.stringify(valid.manifest));
    [changedAssignment.assignments.training[0], changedAssignment.assignments.development[0]] =
      [changedAssignment.assignments.development[0]!, changedAssignment.assignments.training[0]!];
    changedAssignment.assignments.training.sort();
    changedAssignment.assignments.development.sort();
    expect(() => parseExactPolicyOptimizationSplitManifest(canonicalJsonBytes(changedAssignment)))
      .toThrow(/allocation algorithm/u);
  });

  test("excludes an admission receipt that was not cryptographically verified", () => {
    const candidates = Array.from({ length: 13 }, (_, index) => candidate(index));
    candidates[0] = candidate(0, { admission: { ...candidate(0).admission, verified: false } });
    const sealed = formPolicyOptimizationSplit({
      candidates, tupleClass: "repository-work/1.0", seed,
    });
    expect(sealed.manifest.exclusions).toContainEqual({ id: "work-00", reason: "malformed" });
  });

  test("consumes promotion on first reveal and never restores it after cancellation", () => {
    const first = consumePromotionGroups({
      manifestDigest: `sha256:${"3".repeat(64)}`,
      promotionGroupIds: [`sha256:${"4".repeat(64)}`],
      cause: "revealed",
      prior: [],
    });
    expect(() => consumePromotionGroups({
      manifestDigest: `sha256:${"3".repeat(64)}`,
      promotionGroupIds: [`sha256:${"4".repeat(64)}`],
      cause: "dispatched",
      prior: first,
    })).toThrow(/already consumed/u);
  });
});
