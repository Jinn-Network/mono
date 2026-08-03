// SPDX-License-Identifier: MIT

/**
 * The deliberately-dumb reference proposer (product design §7.2 item 2).
 *
 * > A deliberately-dumb reference proposer (deterministic skill ablation / recombination over the
 * > parent loadout). Its purpose is architectural falsification: if the campaign engine cannot
 * > accept a second proposer without modification, replaceability was decorative. **It is the
 * > falsifier, not a baseline anyone should beat.**
 *
 * So it is exactly as dumb as advertised: no model call, no network, no clock, no randomness. It
 * enumerates subsets of the parent's skills in a fixed order and repins the loadout. Whether any of
 * them is *better* is a question this file is structurally incapable of asking, which is the point —
 * §4: "a proposer cannot grade its own homework".
 *
 * ## The enumeration
 *
 * Let `S` be the parent tree's skill names, sorted by UTF-16 code unit (the stack's one string
 * order). The proposal sequence is, in order and truncated at `budget.maxProposals`:
 *
 * 1. **Ablations** — `S \ {s}` for each `s ∈ S`, in `S`'s order. |S| variants.
 * 2. **Recombinations** — `S \ {s_i, s_j}` for every `i < j`, in lexicographic index-pair order.
 *    |S|·(|S|-1)/2 variants.
 *
 * Single removals come first because they are the smaller step, and a budget that only affords a
 * few proposals should spend them on the smaller step. Both families are pure functions of `S`, so
 * two hosts running this proposer against one parent tree with one budget emit byte-identical
 * manifests — which is what makes it usable as a fixture in someone else's test.
 *
 * Two variants are dropped before sealing: one whose tree digest equals the parent's (an ablation
 * that removed nothing is not a proposal), and one whose digest repeats an earlier variant's
 * (two spellings of one candidate; population membership is keyed by `tupleDigest` anyway, §7.3, so
 * emitting both would only mean journaling a rejection nobody learned from).
 *
 * A parent with fewer than two skills yields ablations only; a parent with none yields nothing at
 * all, reported honestly as an empty list rather than as an error.
 */

import {
  compareCodeUnitStrings,
  EXECUTION_TUPLE_FORMAT_TOKEN,
  HARNESS_STATE_LOADOUT_KIND,
  hashTreeLearnerPublicV1,
  sealCandidateManifest,
  tupleDigest,
  type CandidateManifest,
  type ExecutionPolicyTuple,
  type SealedDocument,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import { CANDIDATE_MANIFEST_FORMAT_TOKEN } from "@jinn-network/policy-identity";
import { refuse } from "../errors.js";
import type { PolicyProposalRequest, PolicyProposer } from "./contract.js";

/** The identifier a journal entry records for candidates this proposer produced. */
export const REFERENCE_PROPOSER_ID = "urn:jinn:policy-optimization:proposer:reference/1.0" as const;

/** The tree root the enumeration operates on. `skills/<name>/…` is a skill; nothing else is. */
const SKILLS_ROOT = "skills";

export interface ReferenceProposerInput {
  /**
   * The parent policy tree, described in memory. `TreeEntry[]` rather than a directory path: this
   * proposer is pure, and walking a real tree into entries is the host's job — the same posture
   * `@jinn-network/policy-identity`'s hash profile takes.
   */
  readonly parentTree: readonly TreeEntry[];
  /** The parent tuple. Its non-loadout axes are copied verbatim into every variant. */
  readonly parentTuple: ExecutionPolicyTuple;
  /** Agent IRI recorded as the manifest's `proposer`. */
  readonly proposerAgentIri: string;
  /** The loadout pin's `name`. Defaults to the parent's when the parent carries one. */
  readonly loadoutName?: string;
}

/** One enumerated variant: its manifest, its sealed bytes, and the tree the manifest's digest names. */
export interface ReferenceProposal {
  readonly manifest: CandidateManifest;
  readonly sealed: SealedDocument;
  readonly tupleDigest: string;
  /**
   * The candidate policy's bytes. The `PolicyProposer` contract returns manifests only (F-C7c-3),
   * so this is what a host hands to admission's materializer port.
   */
  readonly tree: readonly TreeEntry[];
  /** Skill names this variant removed, sorted. Also the manifest's `declaredChanges.touchedComponents` roots. */
  readonly removed: readonly string[];
}

/** The skill names present in a tree, sorted by UTF-16 code unit and de-duplicated. */
export function skillNames(entries: readonly TreeEntry[]): readonly string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.startsWith(`${SKILLS_ROOT}/`)) continue;
    const rest = entry.path.slice(SKILLS_ROOT.length + 1);
    const separator = rest.indexOf("/");
    // A file sitting directly under `skills/` is not a skill directory. It is left alone by every
    // variant rather than guessed at: removing it would be an ablation nobody described.
    if (separator <= 0) continue;
    names.add(rest.slice(0, separator));
  }
  return [...names].sort(compareCodeUnitStrings);
}

/**
 * The removal sets, in the order the module header fixes. Exported so a test can pin the ORDER
 * itself — the enumeration being deterministic is the property, and a test that only checked the
 * resulting digests would pass on any permutation.
 */
export function enumerateRemovalSets(names: readonly string[]): readonly (readonly string[])[] {
  const sets: string[][] = names.map((name) => [name]);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      sets.push([names[i]!, names[j]!]);
    }
  }
  return sets;
}

function withoutSkills(
  entries: readonly TreeEntry[],
  removed: readonly string[],
): readonly TreeEntry[] {
  const drop = new Set(removed.map((name) => `${SKILLS_ROOT}/${name}/`));
  return entries.filter((entry) => ![...drop].some((prefix) => entry.path.startsWith(prefix)));
}

function loadoutNameOf(tuple: ExecutionPolicyTuple, override: string | undefined): string {
  if (override !== undefined) return override;
  const loadout = tuple.loadout;
  if (typeof loadout === "object" && loadout !== null && !Array.isArray(loadout)) {
    const name = (loadout as Record<string, unknown>)["name"];
    if (typeof name === "string" && name !== "") return name;
  }
  return "harness-state";
}

/**
 * The enumeration, as data. `propose` is a thin adapter over this.
 *
 * Kept separate because the contract's return type cannot carry the trees (F-C7c-3), and a host
 * driving admission needs them. A caller that only wants manifests calls `propose`.
 */
export function enumerateReferenceCandidates(
  input: ReferenceProposerInput,
  request: PolicyProposalRequest,
): readonly ReferenceProposal[] {
  if (!Number.isSafeInteger(request.budget.maxProposals) || request.budget.maxProposals < 0) {
    refuse("invalid-document", "budget.maxProposals", "maxProposals must be a non-negative integer");
  }
  // The one thing this proposer varies is the loadout. A campaign that does not permit it gets an
  // empty list rather than a candidate that would be refused at admission's mutation-surface check:
  // proposing into a closed axis is the proposer's mistake to avoid, not the owner's to journal.
  if (!request.mutationSurface.includes("loadout")) return [];
  if (request.budget.maxProposals === 0) return [];

  const parentDigest = hashTreeLearnerPublicV1(input.parentTree);
  const loadoutName = loadoutNameOf(input.parentTuple, input.loadoutName);
  const seen = new Set<string>([parentDigest]);
  const proposals: ReferenceProposal[] = [];

  for (const removed of enumerateRemovalSets(skillNames(input.parentTree))) {
    if (proposals.length >= request.budget.maxProposals) break;
    const tree = withoutSkills(input.parentTree, removed);
    const digest = hashTreeLearnerPublicV1(tree);
    if (seen.has(digest)) continue;
    seen.add(digest);

    const policy: ExecutionPolicyTuple = {
      ...input.parentTuple,
      formatToken: EXECUTION_TUPLE_FORMAT_TOKEN,
      // F9: the profile emits bare hex; the pin carries the `sha256:` spelling.
      loadout: { kind: HARNESS_STATE_LOADOUT_KIND, name: loadoutName, digest: `sha256:${digest}` },
    };
    const manifest: CandidateManifest = {
      formatToken: CANDIDATE_MANIFEST_FORMAT_TOKEN,
      policy,
      parents: [...request.parents],
      proposer: input.proposerAgentIri,
      evidenceProvenance: request.evidence.provenance,
      declaredChanges: {
        // Declared, never verified (substrate §5.1) — but here it happens to be exactly true, which
        // is the one advantage of a proposer too dumb to do anything it cannot describe.
        summary: removed.length === 1
          ? `Ablated skill ${removed[0]} from the parent loadout.`
          : `Ablated skills ${removed.join(" and ")} from the parent loadout.`,
        touchedComponents: removed.map((name) => `${SKILLS_ROOT}/${name}`),
      },
    };

    proposals.push({
      manifest,
      sealed: sealCandidateManifest(manifest),
      tupleDigest: tupleDigest(policy),
      tree,
      removed,
    });
  }
  return proposals;
}

/**
 * Builds the `PolicyProposer` for one parent.
 *
 * The parent is bound at construction and the campaign's arguments arrive per call, which is what
 * lets the campaign engine hold a `PolicyProposer` it knows nothing else about — the replaceability
 * the falsifier exists to demonstrate.
 */
export function createReferenceProposer(input: ReferenceProposerInput): PolicyProposer & {
  enumerate(request: PolicyProposalRequest): readonly ReferenceProposal[];
} {
  return {
    id: REFERENCE_PROPOSER_ID,
    enumerate: (request) => enumerateReferenceCandidates(input, request),
    propose: (request) => enumerateReferenceCandidates(input, request).map((p) => p.manifest),
  };
}
