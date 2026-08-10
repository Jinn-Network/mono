// SPDX-License-Identifier: MIT

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  prefixedDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import { z } from "zod";
import { refuse } from "./errors.js";

export const POLICY_OPTIMIZATION_SPLIT_MANIFEST_FORMAT_TOKEN =
  "network.jinn.policy-optimization.split-manifest/1.0" as const;
export const POLICY_OPTIMIZATION_ALLOCATION_ALGORITHM = {
  id: "configurable-confirmation-first-connected-components",
  version: "2",
} as const;
export const POLICY_OPTIMIZATION_ALLOCATION_PRESETS = [
  "balanced-3-3-6@1",
  "test-this-change@1",
  "custom@1",
] as const;

export type PolicyOptimizationAllocationPreset =
  (typeof POLICY_OPTIMIZATION_ALLOCATION_PRESETS)[number];
export type PolicyOptimizationJourney = "explore-confirm" | "confirm-only";

/**
 * The split's resolved learning strategy. The old 3/3/6 layout is the balanced default, not a
 * protocol floor. Confirmation always receives unallocated groups so asking for more evidence can
 * only strengthen the fresh comparison; a group is never split or padded.
 */
export interface PolicyOptimizationSplitAllocation {
  readonly preset: PolicyOptimizationAllocationPreset;
  readonly journey: PolicyOptimizationJourney;
  readonly exploration: {
    readonly proposalGroups: number;
    readonly selectionGroups: number;
  };
  readonly confirmation: {
    readonly minimumGroups: number;
  };
  readonly remainder: "confirmation";
}

export type PolicyOptimizationAllocationRequest =
  | { readonly preset: "balanced-3-3-6@1" }
  | { readonly preset: "test-this-change@1" }
  | {
      readonly preset: "custom@1";
      readonly journey: PolicyOptimizationJourney;
      readonly proposalGroups: number;
      readonly selectionGroups: number;
      readonly confirmationGroups: number;
    };

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const Digest = z.string().regex(DIGEST);
const NonEmpty = z.string().min(1);

export type SplitExclusionReason =
  | "malformed"
  | "incompatible"
  | "previously-attempted"
  | "contaminated"
  | "duplicate-lineage"
  | "unscorable";

export interface SplitPoolCandidate {
  readonly id: string;
  readonly task: { readonly bytes: Uint8Array; readonly digest: string };
  readonly evaluationSpec: { readonly bytes: Uint8Array; readonly digest: string };
  readonly admission: {
    readonly receiptBytes: Uint8Array;
    readonly receiptDigest: string;
    /** Set only by the private host after exact DSSE and trust verification. */
    readonly verified: boolean;
    readonly positive: boolean;
    readonly taskDigest: string;
    readonly evaluationSpecDigest: string;
  };
  readonly repository: string;
  readonly sourceLineage: readonly string[];
  /** Stable identity of the upstream work item, used to exclude duplicate copies. */
  readonly workIdentity: string;
  readonly tupleClass: string;
  readonly compatible: boolean;
  readonly previouslyAttempted: boolean;
  readonly contaminated: boolean;
  readonly scorable: boolean;
}

export interface PolicyOptimizationSplitManifest {
  readonly formatToken: typeof POLICY_OPTIMIZATION_SPLIT_MANIFEST_FORMAT_TOKEN;
  readonly poolSnapshot: {
    readonly digest: string;
    readonly entries: readonly {
      readonly id: string;
      readonly taskDigest: string;
      readonly evaluationSpecDigest: string;
      readonly receiptDigest: string;
    }[];
  };
  readonly exclusions: readonly { readonly id: string; readonly reason: SplitExclusionReason }[];
  readonly tupleClass: string;
  readonly allocationAlgorithm: typeof POLICY_OPTIMIZATION_ALLOCATION_ALGORITHM;
  readonly allocation: PolicyOptimizationSplitAllocation;
  readonly seed: { readonly tupleDigest: string; readonly snapshotDigest: string };
  readonly groups: readonly {
    readonly groupId: string;
    readonly repositories: readonly string[];
    readonly sourceLineage: readonly string[];
    readonly members: readonly string[];
  }[];
  readonly assignments: {
    readonly training: readonly string[];
    readonly development: readonly string[];
    readonly promotion: readonly string[];
  };
}

export interface SealedPolicyOptimizationSplitManifest {
  readonly manifest: PolicyOptimizationSplitManifest;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

const ExclusionReason = z.enum([
  "malformed", "incompatible", "previously-attempted", "contaminated",
  "duplicate-lineage", "unscorable",
]);
const Group = z.strictObject({
  groupId: Digest,
  repositories: z.array(NonEmpty),
  sourceLineage: z.array(NonEmpty),
  members: z.array(NonEmpty),
});
const SafeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ManifestSchema = z.strictObject({
  formatToken: z.literal(POLICY_OPTIMIZATION_SPLIT_MANIFEST_FORMAT_TOKEN),
  poolSnapshot: z.strictObject({
    digest: Digest,
    entries: z.array(z.strictObject({
      id: NonEmpty,
      taskDigest: Digest,
      evaluationSpecDigest: Digest,
      receiptDigest: Digest,
    })),
  }),
  exclusions: z.array(z.strictObject({ id: NonEmpty, reason: ExclusionReason })),
  tupleClass: NonEmpty,
  allocationAlgorithm: z.strictObject({
    id: z.literal(POLICY_OPTIMIZATION_ALLOCATION_ALGORITHM.id),
    version: z.literal(POLICY_OPTIMIZATION_ALLOCATION_ALGORITHM.version),
  }),
  allocation: z.strictObject({
    preset: z.enum(POLICY_OPTIMIZATION_ALLOCATION_PRESETS),
    journey: z.enum(["explore-confirm", "confirm-only"]),
    exploration: z.strictObject({
      proposalGroups: SafeCount,
      selectionGroups: SafeCount,
    }),
    confirmation: z.strictObject({ minimumGroups: SafeCount }),
    remainder: z.literal("confirmation"),
  }),
  seed: z.strictObject({ tupleDigest: Digest, snapshotDigest: Digest }),
  groups: z.array(Group),
  assignments: z.strictObject({
    training: z.array(Digest),
    development: z.array(Digest),
    promotion: z.array(Digest),
  }),
});

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnitStrings);
}

function exactDigest(bytes: Uint8Array, declared: string): boolean {
  return bytes instanceof Uint8Array && bytes.length > 0 && prefixedDigest(bytes) === declared;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return sameBytes(canonicalJsonBytes(left), canonicalJsonBytes(right));
}

function resolvedAllocation(
  request: PolicyOptimizationAllocationRequest | undefined,
): PolicyOptimizationSplitAllocation {
  if (request === undefined || request.preset === "balanced-3-3-6@1") {
    return {
      preset: "balanced-3-3-6@1",
      journey: "explore-confirm",
      exploration: { proposalGroups: 3, selectionGroups: 3 },
      confirmation: { minimumGroups: 6 },
      remainder: "confirmation",
    };
  }
  if (request.preset === "test-this-change@1") {
    return {
      preset: "test-this-change@1",
      journey: "confirm-only",
      exploration: { proposalGroups: 0, selectionGroups: 0 },
      confirmation: { minimumGroups: 1 },
      remainder: "confirmation",
    };
  }
  const counts = [request.proposalGroups, request.selectionGroups, request.confirmationGroups];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    refuse("invalid-document", "allocation", "custom allocation counts must be non-negative safe integers");
  }
  if (request.confirmationGroups < 1) {
    refuse("invalid-document", "allocation.confirmationGroups", "every campaign needs at least one fresh confirmation group");
  }
  if (request.journey === "explore-confirm"
    && (request.proposalGroups < 1 || request.selectionGroups < 1)) {
    refuse("invalid-document", "allocation", "explore-confirm needs at least one proposal and one selection group");
  }
  if (request.journey === "confirm-only"
    && (request.proposalGroups !== 0 || request.selectionGroups !== 0)) {
    refuse("invalid-document", "allocation", "confirm-only cannot reveal proposal or selection evidence");
  }
  return {
    preset: "custom@1",
    journey: request.journey,
    exploration: {
      proposalGroups: request.proposalGroups,
      selectionGroups: request.selectionGroups,
    },
    confirmation: { minimumGroups: request.confirmationGroups },
    remainder: "confirmation",
  };
}

function validateResolvedAllocation(allocation: PolicyOptimizationSplitAllocation): void {
  const counts = [
    allocation.exploration.proposalGroups,
    allocation.exploration.selectionGroups,
    allocation.confirmation.minimumGroups,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || allocation.confirmation.minimumGroups < 1) {
    refuse("invalid-document", "splitManifest.allocation", "allocation counts are invalid");
  }
  if (!Number.isSafeInteger(counts.reduce((total, count) => total + count, 0))) {
    refuse("invalid-document", "splitManifest.allocation", "the combined allocation exceeds the safe integer range");
  }
  if (allocation.preset === "balanced-3-3-6@1"
    && (allocation.journey !== "explore-confirm"
      || allocation.exploration.proposalGroups !== 3
      || allocation.exploration.selectionGroups !== 3
      || allocation.confirmation.minimumGroups !== 6)) {
    refuse("invalid-document", "splitManifest.allocation", "balanced-3-3-6@1 has fixed 3/3/6 defaults");
  }
  if (allocation.preset === "test-this-change@1"
    && (allocation.journey !== "confirm-only"
      || allocation.exploration.proposalGroups !== 0
      || allocation.exploration.selectionGroups !== 0
      || allocation.confirmation.minimumGroups !== 1)) {
    refuse("invalid-document", "splitManifest.allocation", "test-this-change@1 sends every eligible group directly to confirmation");
  }
  if (allocation.journey === "explore-confirm"
    && (allocation.exploration.proposalGroups < 1 || allocation.exploration.selectionGroups < 1)) {
    refuse("invalid-document", "splitManifest.allocation", "explore-confirm needs proposal and selection evidence");
  }
  if (allocation.journey === "confirm-only"
    && (allocation.exploration.proposalGroups !== 0 || allocation.exploration.selectionGroups !== 0)) {
    refuse("invalid-document", "splitManifest.allocation", "confirm-only cannot carry exploration evidence");
  }
}

function requestedGroupCount(allocation: PolicyOptimizationSplitAllocation): number {
  const count = allocation.exploration.proposalGroups
    + allocation.exploration.selectionGroups
    + allocation.confirmation.minimumGroups;
  if (!Number.isSafeInteger(count)) {
    refuse("invalid-document", "allocation", "the combined allocation exceeds the safe integer range");
  }
  return count;
}

function firstIneligibility(
  candidate: SplitPoolCandidate,
  tupleClass: string,
): SplitExclusionReason | undefined {
  if (
    candidate.id.length === 0
    || candidate.repository.length === 0
    || candidate.workIdentity.length === 0
    || candidate.sourceLineage.length === 0
    || candidate.sourceLineage.some((value) => value.length === 0)
    || !exactDigest(candidate.task.bytes, candidate.task.digest)
    || !exactDigest(candidate.evaluationSpec.bytes, candidate.evaluationSpec.digest)
    || !exactDigest(candidate.admission.receiptBytes, candidate.admission.receiptDigest)
    || !candidate.admission.verified
    || !candidate.admission.positive
    || candidate.admission.taskDigest !== candidate.task.digest
    || candidate.admission.evaluationSpecDigest !== candidate.evaluationSpec.digest
  ) return "malformed";
  if (!candidate.compatible || candidate.tupleClass !== tupleClass) return "incompatible";
  if (candidate.previouslyAttempted) return "previously-attempted";
  if (candidate.contaminated) return "contaminated";
  if (!candidate.scorable) return "unscorable";
  return undefined;
}

class Components {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(index: number): number {
    const parent = this.parent[index]!;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }
  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b);
  }
}

function shuffledGroups(
  groups: PolicyOptimizationSplitManifest["groups"],
  seed: PolicyOptimizationSplitManifest["seed"],
): PolicyOptimizationSplitManifest["groups"] {
  const domain = `${POLICY_OPTIMIZATION_ALLOCATION_ALGORITHM.id}/${POLICY_OPTIMIZATION_ALLOCATION_ALGORITHM.version}\0${seed.snapshotDigest}\0${seed.tupleDigest}\0`;
  return [...groups].sort((left, right) => {
    const a = prefixedDigest(new TextEncoder().encode(`${domain}${left.groupId}`));
    const b = prefixedDigest(new TextEncoder().encode(`${domain}${right.groupId}`));
    const byRank = compareCodeUnitStrings(a, b);
    return byRank === 0 ? compareCodeUnitStrings(left.groupId, right.groupId) : byRank;
  });
}

export function formPolicyOptimizationSplit(input: {
  readonly candidates: readonly SplitPoolCandidate[];
  readonly tupleClass: string;
  readonly seed: PolicyOptimizationSplitManifest["seed"];
  readonly allocation?: PolicyOptimizationAllocationRequest;
}): SealedPolicyOptimizationSplitManifest {
  if (input.tupleClass.length === 0
    || !DIGEST.test(input.seed.tupleDigest) || !DIGEST.test(input.seed.snapshotDigest)) {
    refuse("invalid-document", "split", "tupleClass and exact seed digests are required");
  }

  const exclusions: { id: string; reason: SplitExclusionReason }[] = [];
  const eligible: SplitPoolCandidate[] = [];
  const workIdentities = new Set<string>();
  for (const candidate of [...input.candidates].sort((a, b) => compareCodeUnitStrings(a.id, b.id))) {
    const reason = firstIneligibility(candidate, input.tupleClass);
    if (reason !== undefined) {
      exclusions.push({ id: candidate.id || "<missing-id>", reason });
      continue;
    }
    if (workIdentities.has(candidate.workIdentity)) {
      exclusions.push({ id: candidate.id, reason: "duplicate-lineage" });
      continue;
    }
    workIdentities.add(candidate.workIdentity);
    eligible.push(candidate);
  }

  const components = new Components(eligible.length);
  const repositoryOwner = new Map<string, number>();
  const lineageOwner = new Map<string, number>();
  eligible.forEach((candidate, index) => {
    const repository = repositoryOwner.get(candidate.repository);
    if (repository === undefined) repositoryOwner.set(candidate.repository, index);
    else components.union(index, repository);
    for (const lineage of sortedUnique(candidate.sourceLineage)) {
      const owner = lineageOwner.get(lineage);
      if (owner === undefined) lineageOwner.set(lineage, index);
      else components.union(index, owner);
    }
  });
  const buckets = new Map<number, SplitPoolCandidate[]>();
  eligible.forEach((candidate, index) => {
    const root = components.find(index);
    const bucket = buckets.get(root) ?? [];
    bucket.push(candidate);
    buckets.set(root, bucket);
  });
  const groups = [...buckets.values()].map((members) => {
    const body = {
      repositories: sortedUnique(members.map((candidate) => candidate.repository)),
      sourceLineage: sortedUnique(members.flatMap((candidate) => candidate.sourceLineage)),
      members: sortedUnique(members.map((candidate) => candidate.id)),
    };
    return { groupId: prefixedDigest(canonicalJsonBytes(body)), ...body };
  }).sort((left, right) => compareCodeUnitStrings(left.groupId, right.groupId));

  const allocation = resolvedAllocation(input.allocation);
  const requestedGroups = requestedGroupCount(allocation);
  if (groups.length < requestedGroups) {
    refuse("invalid-document", "groups",
      `${groups.length} eligible connected groups cannot satisfy the selected allocation's ${requestedGroups}-group minimum; groups are never split or padded`);
  }
  const ranked = shuffledGroups(groups, input.seed);
  const promotionCount = allocation.confirmation.minimumGroups + (ranked.length - requestedGroups);
  const developmentEnd = promotionCount + allocation.exploration.selectionGroups;
  const promotion = ranked.slice(0, promotionCount).map((group) => group.groupId).sort(compareCodeUnitStrings);
  const development = ranked.slice(promotionCount, developmentEnd).map((group) => group.groupId).sort(compareCodeUnitStrings);
  const training = ranked.slice(developmentEnd).map((group) => group.groupId).sort(compareCodeUnitStrings);

  const poolEntries = [...input.candidates].map((candidate) => ({
    id: candidate.id || "<missing-id>",
    taskDigest: candidate.task.digest,
    evaluationSpecDigest: candidate.evaluationSpec.digest,
    receiptDigest: candidate.admission.receiptDigest,
  })).sort((a, b) => compareCodeUnitStrings(a.id, b.id));
  const poolSnapshotDigest = prefixedDigest(canonicalJsonBytes({ entries: poolEntries }));
  const manifest: PolicyOptimizationSplitManifest = {
    formatToken: POLICY_OPTIMIZATION_SPLIT_MANIFEST_FORMAT_TOKEN,
    poolSnapshot: { digest: poolSnapshotDigest, entries: poolEntries },
    exclusions: exclusions.sort((a, b) => compareCodeUnitStrings(a.id, b.id)),
    tupleClass: input.tupleClass,
    allocationAlgorithm: POLICY_OPTIMIZATION_ALLOCATION_ALGORITHM,
    allocation,
    seed: input.seed,
    groups,
    assignments: { training, development, promotion },
  };
  const parsed = ManifestSchema.parse(manifest) as PolicyOptimizationSplitManifest;
  const bytes = canonicalJsonBytes(parsed as unknown as JsonValue);
  return { manifest: parsed, bytes, digest: prefixedDigest(bytes) };
}

export function parseExactPolicyOptimizationSplitManifest(
  bytes: Uint8Array,
): PolicyOptimizationSplitManifest {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse("invalid-document", "splitManifest", "bytes must be UTF-8 JSON"); }
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) refuse("invalid-document", "splitManifest", parsed.error.message);
  const canonical = canonicalJsonBytes(parsed.data as JsonValue);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    refuse("invalid-document", "splitManifest", "bytes are not the exact canonical encoding");
  }
  const manifest = parsed.data as PolicyOptimizationSplitManifest;
  validateResolvedAllocation(manifest.allocation);
  const poolEntries = [...manifest.poolSnapshot.entries]
    .sort((left, right) => compareCodeUnitStrings(left.id, right.id));
  if (prefixedDigest(canonicalJsonBytes({ entries: poolEntries })) !== manifest.poolSnapshot.digest
    || !sameJson(poolEntries as unknown as JsonValue, manifest.poolSnapshot.entries as unknown as JsonValue)) {
    refuse("invalid-document", "splitManifest.poolSnapshot", "pool entries must be normalized and match the snapshot digest");
  }
  const entryIds = manifest.poolSnapshot.entries.map((entry) => entry.id);
  if (new Set(entryIds).size !== entryIds.length) {
    refuse("invalid-document", "splitManifest.poolSnapshot", "pool entry identities must be unique");
  }

  const repositories = new Set<string>();
  const lineage = new Set<string>();
  const members = new Set<string>();
  let previousGroupId: string | undefined;
  for (const group of manifest.groups) {
    if (previousGroupId !== undefined && compareCodeUnitStrings(previousGroupId, group.groupId) >= 0) {
      refuse("invalid-document", "splitManifest.groups", "groups must be uniquely sorted by groupId");
    }
    previousGroupId = group.groupId;
    const normalized = {
      repositories: sortedUnique(group.repositories),
      sourceLineage: sortedUnique(group.sourceLineage),
      members: sortedUnique(group.members),
    };
    if (normalized.repositories.length === 0 || normalized.sourceLineage.length === 0
      || normalized.members.length === 0
      || !sameJson(normalized, {
          repositories: group.repositories,
          sourceLineage: group.sourceLineage,
          members: group.members,
        } as unknown as JsonValue)
      || prefixedDigest(canonicalJsonBytes(normalized)) !== group.groupId) {
      refuse("invalid-document", "splitManifest.groups", "group content must be normalized and match its groupId");
    }
    for (const repository of group.repositories) {
      if (repositories.has(repository)) {
        refuse("invalid-document", "splitManifest.groups", "repository-equivalent work cannot be split across groups");
      }
      repositories.add(repository);
    }
    for (const source of group.sourceLineage) {
      if (lineage.has(source)) {
        refuse("invalid-document", "splitManifest.groups", "source-lineage-equivalent work cannot be split across groups");
      }
      lineage.add(source);
    }
    for (const member of group.members) {
      if (members.has(member)) {
        refuse("invalid-document", "splitManifest.groups", "one pool member cannot occur in multiple groups");
      }
      members.add(member);
    }
  }

  const exclusions = manifest.exclusions.map((entry) => entry.id);
  const normalizedExclusions = [...manifest.exclusions]
    .sort((left, right) => compareCodeUnitStrings(left.id, right.id));
  if (new Set(exclusions).size !== exclusions.length
    || !sameJson(normalizedExclusions as unknown as JsonValue, manifest.exclusions as unknown as JsonValue)) {
    refuse("invalid-document", "splitManifest.exclusions", "exclusions must be uniquely sorted by identity");
  }
  const classified = [...members, ...exclusions].sort(compareCodeUnitStrings);
  if (new Set(classified).size !== classified.length
    || !sameJson(classified, entryIds)) {
    refuse("invalid-document", "splitManifest", "every pool entry must be classified exactly once");
  }

  const all = [...manifest.assignments.training, ...manifest.assignments.development, ...manifest.assignments.promotion];
  if (new Set(all).size !== all.length || all.length !== manifest.groups.length) {
    refuse("invalid-document", "splitManifest.assignments", "every group must be assigned exactly once");
  }
  const declared = new Set(manifest.groups.map((group) => group.groupId));
  if (all.some((group) => !declared.has(group))) {
    refuse("invalid-document", "splitManifest.assignments", "an assignment names an unknown group");
  }
  const requestedGroups = requestedGroupCount(manifest.allocation);
  if (manifest.groups.length < requestedGroups) {
    refuse("invalid-document", "splitManifest.assignments", "the selected allocation cannot be satisfied without splitting or padding groups");
  }
  const ranked = shuffledGroups(manifest.groups, manifest.seed);
  const promotionCount = manifest.allocation.confirmation.minimumGroups
    + (ranked.length - requestedGroups);
  const developmentEnd = promotionCount + manifest.allocation.exploration.selectionGroups;
  const expectedAssignments = {
    training: ranked.slice(developmentEnd).map((group) => group.groupId).sort(compareCodeUnitStrings),
    development: ranked.slice(promotionCount, developmentEnd).map((group) => group.groupId).sort(compareCodeUnitStrings),
    promotion: ranked.slice(0, promotionCount).map((group) => group.groupId).sort(compareCodeUnitStrings),
  };
  const actualAssignmentBytes = canonicalJsonBytes(manifest.assignments);
  const expectedAssignmentBytes = canonicalJsonBytes(expectedAssignments);
  if (actualAssignmentBytes.length !== expectedAssignmentBytes.length
    || actualAssignmentBytes.some((byte, index) => byte !== expectedAssignmentBytes[index])) {
    refuse("invalid-document", "splitManifest.assignments", "assignments do not match the declared deterministic allocation algorithm");
  }
  return manifest;
}

export interface PromotionConsumption {
  readonly manifestDigest: string;
  readonly groupId: string;
  readonly cause: "revealed" | "dispatched";
}

/** Must be durably appended before promotion bytes are revealed or work is dispatched. */
export function consumePromotionGroups(input: {
  readonly manifestDigest: string;
  readonly promotionGroupIds: readonly string[];
  readonly cause: PromotionConsumption["cause"];
  readonly prior: readonly PromotionConsumption[];
}): readonly PromotionConsumption[] {
  const consumed = new Set(input.prior.map((entry) => entry.groupId));
  const additions = sortedUnique(input.promotionGroupIds).map((groupId) => {
    if (consumed.has(groupId)) {
      refuse("promotion-discipline", "promotionGroups", `${groupId} was already consumed; cancellation and inconclusive results never make promotion reusable`);
    }
    consumed.add(groupId);
    return { manifestDigest: input.manifestDigest, groupId, cause: input.cause } as const;
  });
  return [...input.prior, ...additions];
}
