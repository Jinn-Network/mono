// SPDX-License-Identifier: MIT

/**
 * The archive's type vocabulary (product design §8.3, §9).
 *
 * Shapes only — no derivation, no filesystem, no validation. The split that matters here is the
 * one §8.3 draws and this file makes structural: **everything above `AdoptionRecord` is
 * re-derivable** from candidate manifests, Reports, and projection rows, and **`AdoptionRecord` is
 * not**. It is a locally recorded operator decision, the one part of the archive that no
 * re-derivation can reproduce, and it is stored and labeled accordingly (`store.ts`).
 */

import type { PolicyParentRef } from "@jinn-network/policy-identity";
import type { ObjectiveMethodRef } from "../types.js";
import type { OutcomesProjectionRow, WaveReportRow } from "../wave-types.js";

// --- §8.3 the lineage graph --------------------------------------------------------------------

/**
 * One candidate in the local projection.
 *
 * `digest` is derived from the manifest bytes the caller supplied, never read off a label —
 * the same reasoning `openCampaign` applies to `campaign.json`. `tupleDigest` is the population
 * key (§7.3), so two manifests proposing one tuple are two nodes sharing one key, which is
 * exactly the shape the first-admitted attribution rule needs a reader to be able to see.
 */
export interface LineageNode {
  /** `sha256:<64 lowercase hex>` over the candidate manifest's canonical bytes. */
  readonly digest: string;
  /** `sha256:<64 lowercase hex>` over the tuple's canonical bytes — the population key. */
  readonly tupleDigest: string;
  readonly proposer: string;
  /** The manifest's `parents[]`, verbatim and typed (substrate §5.1). */
  readonly parents: readonly PolicyParentRef[];
  /** Candidate-kind parents whose manifests are present in this projection, sorted. */
  readonly resolvedParents: readonly string[];
  /**
   * Typed parent references this projection cannot dereference locally, sorted by digest.
   *
   * Ordinary, not an error: a `tuple`-kind parent has no manifest by construction, and a
   * `candidate`-kind parent may simply live on another host. The archive is a projection over what
   * this operator holds, so "I do not hold that" is a fact about the projection, not a defect in
   * the lineage.
   */
  readonly unresolvedParents: readonly PolicyParentRef[];
  /** Manifest digests naming this node as a candidate-kind parent, sorted. */
  readonly children: readonly string[];
}

export interface LineageGraph {
  /** Every node, sorted by manifest digest. */
  readonly nodes: readonly LineageNode[];
  /** Nodes with no candidate-kind parent resolved here — where this projection's lineage begins. */
  readonly roots: readonly string[];
  /** Nodes no other node in this projection names as a parent. */
  readonly leaves: readonly string[];
}

/** Where one candidate sits in a lineage graph — what `candidate inspect` renders. */
export interface LineagePosition {
  readonly node: LineageNode;
  /** Ancestor manifest digests reachable through resolved candidate parents, sorted. */
  readonly ancestors: readonly string[];
  /** Descendant manifest digests reachable through resolved children, sorted. */
  readonly descendants: readonly string[];
  /** Other nodes in this projection proposing the same tuple, sorted. Population-key siblings. */
  readonly sameTuple: readonly string[];
}

// --- §8.3 per-policy evaluated history ---------------------------------------------------------

/**
 * What this operator has actually measured about one tuple.
 *
 * Every member is carried **verbatim** from what a registry method sealed or an adapter folded.
 * Nothing here is averaged, ranked, or summarized: a summary would be a statistic, and statistics
 * land in `benchmarking-aggregate`'s registry (program ruling R3). The history's job is to put the
 * evidence in one place in a deterministic order, not to draw a conclusion from it.
 */
export interface EvaluatedHistory {
  readonly tupleDigest: string;
  /** Report values naming this tuple, ordered by wave, then method, then Report digest. */
  readonly evaluations: readonly WaveReportRow[];
  /**
   * Observation rows for this tuple, ordered by bucket then input-ref list.
   *
   * §8.1: observation buys *direction*, never a claim; the `organic` bucket is operator-selected
   * and manipulable. They sit beside the evaluations rather than mixed into them.
   */
  readonly observations: readonly OutcomesProjectionRow[];
  /** Wave numbers this tuple has a Report value from, ascending and deduplicated. */
  readonly waves: readonly number[];
}

// --- §8.3 the frontier ------------------------------------------------------------------------

/** Which way is better on one dimension. */
export type FrontierDirection = "maximize" | "minimize";

export interface FrontierDimension {
  readonly key: string;
  readonly direction: FrontierDirection;
}

/**
 * One candidate's position, as exact decimal strings.
 *
 * Decimal strings and not numbers: every comparison the archive makes is exact
 * (`compareExactDecimals`), and a float would make the frontier's membership depend on the
 * caller's parser.
 */
export interface FrontierEntry {
  readonly tupleDigest: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * §8.3's three dimensions, named. The keys are labels the caller populates from its own
 * measurements — the archive fixes the *directions*, because "cheaper is better" is not a
 * campaign's choice to make, while what counts as quality is exactly the campaign objective's.
 */
export const PRODUCT_FRONTIER_DIMENSIONS: readonly FrontierDimension[] = [
  { key: "quality", direction: "maximize" },
  { key: "cost", direction: "minimize" },
  { key: "latency", direction: "minimize" },
];

// --- §9 adoption — the non-derivable part -------------------------------------------------------

/**
 * §7.4's transfer-security gradient as a closed vocabulary: prompts < skills (injection surface)
 * < hooks / tool configs (arbitrary code execution) < harness forks (their runtime).
 *
 * `unclassified` is the fail-closed member. A touched component the archive cannot place is not
 * quietly filed under the cheapest class; it gets a name the operator has to approve on purpose.
 */
export const ADOPTION_COMPONENT_CLASSES = [
  "prompt",
  "skill",
  "tool-config",
  "hook",
  "harness-fork",
  "unclassified",
] as const;

export type AdoptionComponentClass = (typeof ADOPTION_COMPONENT_CLASSES)[number];

/** Which task route an adoption applies to (§9: "pin the tuple for a task route"). */
export interface AdoptionScope {
  /** The task profile URI whose `requirementKeys` bound the adopted tuple's axis set. */
  readonly taskProfile: string;
  /** An operator-local route label, when one profile carries more than one route. */
  readonly route?: string;
}

/**
 * One locally recorded operator adoption decision (§9; F-C6-2).
 *
 * **Not re-derivable.** Everything else in the archive is a projection over records that exist
 * independently; this is a decision that exists nowhere but here. §8.3 says so in as many words,
 * and the storage layer labels the file rather than leaving the distinction to a reader's memory.
 *
 * `priorTuple` is what makes rollback expressible: an adoption records what it displaced, so
 * restoring it is reading one field rather than reconstructing a history. `null` on the first
 * adoption for a scope.
 *
 * The record carries **no verdict and no score**. Whether the adopted tuple is better is
 * established by the Reports the archive projects, never by the act of adopting it.
 */
export interface AdoptionRecord {
  readonly formatToken: string;
  /** `sha256:<64 lowercase hex>` over the adopted tuple's canonical bytes — the population key. */
  readonly tupleDigest: string;
  /** RFC 3339 with an offset. Absent when the operator recorded the decision without one. */
  readonly adoptedAt?: string;
  readonly scope: AdoptionScope;
  /** The tuple this adoption displaced, or `null` when the scope had no adoption before it. */
  readonly priorTuple: string | null;
  /**
   * The payload classes the operator explicitly consented to, sorted, deduplicated.
   *
   * §7.4: adopting a stranger's candidate is installing their code, and the gate distinguishes
   * classes within one bundle. The record keeps the approval so a later reader can see what was
   * consented to rather than inferring it from what the candidate turned out to contain.
   */
  readonly payloadClassesApproved: readonly AdoptionComponentClass[];
  /** Evidence label at consent time. Added for the guided host; absent on replay-era records. */
  readonly recommendationStatus?: "proven" | "promising" | "inconclusive";
  /** Present only for the advanced non-proven override path (`--override-inconclusive`). */
  readonly overrideReason?: string;
  /** Exact configuration revision the prepared change and rollback target. */
  readonly baseConfigurationRevision?: string;
  /** Exact recomputable recommendation inputs consent was based on. */
  readonly recommendationBasis?: {
    readonly runDigest: string;
    readonly matrixDigest: string;
    readonly reportDigests: readonly string[];
    readonly methodRefs: readonly ObjectiveMethodRef[];
  };
  /** Binds every affected-route record written as one local adoption decision. */
  readonly sharedDecisionId?: string;
}

/** The adoption log: one campaign's (or one operator's) ordered adoption decisions. */
export interface AdoptionLog {
  readonly formatToken: string;
  /** Always `true`. The §8.3 label, in the file rather than only in the documentation. */
  readonly nonDerivable: true;
  readonly note: string;
  /** Append-only, oldest first. */
  readonly records: readonly AdoptionRecord[];
}

// --- the derived projection --------------------------------------------------------------------

/**
 * The whole re-derivable half of the archive, in one document.
 *
 * Written under `derived/` and safe to delete at any moment: every member of it can be rebuilt
 * from the manifests, Reports, and rows it was built from. Nothing reads it as authority.
 */
export interface ArchiveProjection {
  readonly formatToken: string;
  /** Always `true`. The counterpart label to `AdoptionLog.nonDerivable`. */
  readonly derived: true;
  readonly note: string;
  readonly lineage: LineageGraph;
  readonly histories: readonly EvaluatedHistory[];
  /** The frontier as a sorted membership list. Sorted for byte-stability, never as a ranking. */
  readonly frontier: readonly string[];
  readonly dimensions: readonly FrontierDimension[];
}
