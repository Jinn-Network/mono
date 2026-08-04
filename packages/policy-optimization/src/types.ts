// SPDX-License-Identifier: MIT

/**
 * The type vocabulary of the campaign state layer (product design §5.1–§5.2).
 *
 * This file carries shapes only — no validation, no canonicalization, no lifecycle logic.
 */

import type { ExecutionPolicyTuple, JsonValue } from "@jinn-network/policy-identity";

export type { ExecutionPolicyTuple, JsonValue };

/**
 * Substrate §5.1's typed reference, reused verbatim for `seeds[]`: a candidate-manifest digest or
 * a bare execution-tuple digest, discriminated so a consumer knows how to dereference each.
 * Product §5.1 spells seeds as "initial policy tuples or candidate-manifest digests"; the typed
 * reference is that sum type with the discriminant made explicit rather than sniffed.
 */
export interface PolicyRef {
  readonly kind: "candidate" | "tuple";
  /** `sha256:<64 lowercase hex>`. */
  readonly digest: string;
}

/** Product §5.1 — what is being optimized, and against what. */
export interface CampaignTarget {
  /** The task profile URI whose `requirementKeys` bound the tuple's axis set (substrate §4.1 step 2). */
  readonly taskProfile: string;
  /** Benchmark record digest — the development slate dev waves run against. */
  readonly developmentBenchmark: string;
  /** Benchmark record digest — the **committed** promotion gate (§6.3). */
  readonly promotionBenchmark: string;
  /** Optional saved-query reference naming the frozen evidence proposers may consume. */
  readonly trainingEvidence?: { readonly savedQueryDigest: string };
}

/**
 * Product §5.1 — a benchmarking method-registry reference. Never a privately-implemented method
 * (program ruling R3): the id/version pair names an entry in `@jinn-network/benchmarking-aggregate`'s
 * registry, so every policy-value estimate stays third-party recomputable.
 */
export interface ObjectiveMethodRef {
  readonly id: string;
  readonly version: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

/**
 * Product §5.1 — a protected measurement that must not regress. The constraint names the registry
 * method that produces the measurement and the direction that counts as a regression; it carries
 * **no numeric threshold**, because a threshold is an adoption decision and adoption is
 * operator-local (§9). Evaluating a constraint against Reports is the wave engine's job (C7b).
 */
export interface ObjectiveConstraint {
  readonly method: ObjectiveMethodRef;
  readonly relation: "must-not-decrease" | "must-not-increase";
}

export interface CampaignObjective {
  readonly methods: readonly ObjectiveMethodRef[];
  readonly constraints: readonly ObjectiveConstraint[];
}

/**
 * Product §5.1 — proposal, evaluation, and hard cap. Each budget declares its own unit so the cap
 * comparison means something: proposal budget counts proposer invocations, evaluation and hard cap
 * count Run cells, and `hardCap.maxCells` bounds dev waves *plus* the promotion Run.
 */
export interface CampaignBudgets {
  readonly proposal: { readonly maxProposals: number };
  readonly evaluation: { readonly maxCells: number };
  readonly hardCap: { readonly maxCells: number };
}

/**
 * Product §5.1/§6.2 — the dev-wave allocation policy. A product-local reference, deliberately not
 * a benchmarking registry method: allocation is product policy, and only the *estimates* it
 * consumes must be recomputable (product §16).
 */
export interface CampaignAllocation {
  readonly policyRef: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

/** Product §5.1 — mandatory; exploration cannot run open-ended. Evaluated by the wave engine (C7b). */
export interface CampaignStoppingRule {
  readonly ruleRef: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

/**
 * Product §5.1 — the campaign document. Immutable and sealed (JCS-once, sha256).
 *
 * Namespaced (reverse-DNS or absolute-URI) top-level extension keys are tolerated and preserved;
 * an unrecognized **non-namespaced** top-level field is rejected, exactly as the candidate manifest
 * does (substrate §5.3).
 */
export interface CampaignDocument {
  readonly formatToken: string;
  readonly target: CampaignTarget;
  readonly seeds: readonly PolicyRef[];
  /** Which tuple axes candidates may vary. v0: `["loadout"]`. */
  readonly mutationSurface: readonly string[];
  /** Byte-exact values for every non-mutable axis. Exact pins, never constraint-shaped. */
  readonly frozenAxes: Readonly<Record<string, JsonValue>>;
  readonly objective: CampaignObjective;
  readonly budgets: CampaignBudgets;
  readonly allocation: CampaignAllocation;
  readonly stoppingRule: CampaignStoppingRule;
  readonly [namespacedExtension: string]: unknown;
}

/** The output of `sealCampaign` — the exact bytes and the digest that names them. */
export interface SealedCampaign {
  readonly bytes: Uint8Array;
  /** `sha256:<64 lowercase hex>`. */
  readonly digest: string;
  readonly campaign: CampaignDocument;
}

/**
 * What a seed's typed reference resolves to. The campaign document carries digests only, so the
 * §5.1 sealing-time check ("all seeds MUST byte-share `frozenAxes`") is uncomputable from the
 * document alone: the sealer supplies the referent, and this package **verifies** it against the
 * digest rather than trusting the label.
 */
export type SeedResolution =
  | { readonly kind: "tuple"; readonly digest: string; readonly tuple: ExecutionPolicyTuple }
  | { readonly kind: "candidate"; readonly digest: string; readonly manifestBytes: Uint8Array };
