// SPDX-License-Identifier: MIT

/**
 * The campaign document: validation, the sealing-time seed check, sealing, and exact parsing
 * (product design §5.1).
 *
 * A campaign fixes *what is being optimized, what counts as better, and the budget* — never how
 * candidates are made. It is immutable and sealed once (JCS, sha256), through
 * `@jinn-network/policy-identity`'s canonicalizer rather than a second one written here: the
 * campaign's `frozenAxes` are compared byte-for-byte against execution-policy tuples, and two
 * canonicalizers that agree today are two canonicalizers that can disagree tomorrow.
 *
 * The document is a **product convention**, not a record kind (§5.1). It publishes no schema and
 * registers no media type.
 */

import {
  canonicalJsonBytes,
  canonicalJsonText,
  parseExactCandidateManifest,
  prefixedDigest,
  tupleDigest,
  type ExecutionPolicyTuple,
} from "@jinn-network/policy-identity";
import { z } from "zod";
import {
  childPath,
  issue,
  refuseAll,
  type PolicyOptimizationIssue,
  type ValidationResult,
} from "./errors.js";
import {
  checkBenchmarkDisjointness,
  type CampaignBenchmarkBytes,
} from "./benchmark-disjointness.js";
import { assertExactPin, axisValuesByteShare, isExactPin } from "./frozen-axes.js";
import { CAMPAIGN_FORMAT_TOKEN, CORE_AXES, V0_MUTATION_SURFACE } from "./tokens.js";
import type { CampaignDocument, PolicyRef, SealedCampaign, SeedResolution } from "./types.js";

const Sha256Prefixed = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonEmptyText = z.string().min(1);
/**
 * A budget is a positive integer, never zero. A campaign that may make no proposals or run no
 * cells cannot do the thing it declares, and a zero budget reads as "unset" to every author who
 * did not write it — so the document refuses rather than sealing a campaign that can only stop.
 */
const BudgetCount = z.number().int().min(1);
const Parameters = z.record(z.string(), z.unknown());

const PolicyRefSchema = z.strictObject({
  kind: z.enum(["candidate", "tuple"]),
  digest: Sha256Prefixed,
});

const TargetSchema = z.strictObject({
  taskProfile: NonEmptyText,
  developmentBenchmark: Sha256Prefixed,
  promotionBenchmark: Sha256Prefixed,
  trainingEvidence: z.strictObject({ savedQueryDigest: Sha256Prefixed }).optional(),
});

const MethodRefSchema = z.strictObject({
  id: NonEmptyText,
  version: NonEmptyText,
  parameters: Parameters,
});

const ObjectiveSchema = z.strictObject({
  methods: z.array(MethodRefSchema),
  constraints: z.array(z.strictObject({
    method: MethodRefSchema,
    relation: z.enum(["must-not-decrease", "must-not-increase"]),
  })),
});

const BudgetsSchema = z.strictObject({
  proposal: z.strictObject({ maxProposals: BudgetCount }),
  evaluation: z.strictObject({ maxCells: BudgetCount }),
  hardCap: z.strictObject({ maxCells: BudgetCount }),
});

/**
 * The structural pass. Unknown top-level keys are deliberately *carried through* rather than
 * stripped or rejected here: the namespaced-extension rule is applied separately below, and a
 * validator that rebuilt the document from a known-field allow-list would silently drop the
 * extensions the format promises to preserve (the candidate-manifest precedent, substrate §5.3).
 */
const CampaignShapeSchema = z.looseObject({
  formatToken: z.literal(CAMPAIGN_FORMAT_TOKEN),
  target: TargetSchema,
  seeds: z.array(PolicyRefSchema),
  mutationSurface: z.array(NonEmptyText),
  frozenAxes: z.record(z.string(), z.unknown()),
  objective: ObjectiveSchema,
  budgets: BudgetsSchema,
  allocation: z.strictObject({ policyRef: NonEmptyText, parameters: Parameters }),
  stoppingRule: z.strictObject({ ruleRef: NonEmptyText, parameters: Parameters }),
});

// TEP §21.3's two extension-key spellings, mirrored from `@jinn-network/policy-identity`'s
// manifest rule so a campaign and a candidate agree about what "namespaced" means.
const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const ABSOLUTE_URI_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

const KNOWN_FIELDS = new Set([
  "formatToken", "target", "seeds", "mutationSurface", "frozenAxes",
  "objective", "budgets", "allocation", "stoppingRule",
]);

export function isNamespacedExtensionKey(key: string): boolean {
  return REVERSE_DNS_KEY_PATTERN.test(key) || ABSOLUTE_URI_KEY_PATTERN.test(key);
}

function structuralIssues(input: Record<string, unknown>): PolicyOptimizationIssue[] {
  const parsed = CampaignShapeSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((entry) => issue(
    "invalid-document",
    entry.path.map((segment) => String(segment)).join("."),
    entry.message,
  ));
}

/**
 * Product §5.1's cross-field rules — the ones a shape schema cannot state.
 *
 * The load-bearing one is the axis partition: **every core axis is either frozen or mutable, never
 * both and never neither.** Without it the mutation-surface check at admission (§7.3) is
 * uncomputable for the missing axis, which is exactly the blocker Appendix A records ("the
 * campaign's frozen-axis values were declared nowhere, making the mutation-surface check
 * uncomputable").
 */
function semanticIssues(campaign: CampaignDocument): PolicyOptimizationIssue[] {
  const errors: PolicyOptimizationIssue[] = [];

  if (campaign.target.developmentBenchmark === campaign.target.promotionBenchmark) {
    errors.push(issue("invalid-document", "target.promotionBenchmark",
      "the promotion gate must not be the development slate; a dev wave reveals every item it runs"));
  }

  if (campaign.seeds.length === 0) {
    errors.push(issue("invalid-document", "seeds", "a campaign needs at least one seed policy"));
  }
  const seenSeeds = new Set<string>();
  campaign.seeds.forEach((seed, index) => {
    const identity = `${seed.kind}${seed.digest}`;
    if (seenSeeds.has(identity)) {
      errors.push(issue("invalid-document", childPath("seeds", index), "duplicate seed reference"));
    }
    seenSeeds.add(identity);
  });

  const mutable = new Set(campaign.mutationSurface);
  if (mutable.size !== campaign.mutationSurface.length
    || campaign.mutationSurface.length !== V0_MUTATION_SURFACE.length
    || !V0_MUTATION_SURFACE.every((axis) => mutable.has(axis))) {
    errors.push(issue("mutation-surface", "mutationSurface",
      `v0 campaigns mutate exactly ${JSON.stringify([...V0_MUTATION_SURFACE])}: harness and model are frozen per campaign, and isolationPolicy is a vacuous axis`));
  }

  for (const [axis, value] of Object.entries(campaign.frozenAxes)) {
    const path = childPath("frozenAxes", axis);
    if (axis === "formatToken") {
      errors.push(issue("invalid-document", path,
        "formatToken is document metadata, never an axis (substrate §4.1's reserved member)"));
      continue;
    }
    if (mutable.has(axis)) {
      errors.push(issue("mutation-surface", path, "an axis cannot be both frozen and mutable"));
      continue;
    }
    if (!isExactPin(axis, value)) {
      errors.push(issue("constraint-shaped-pin", path,
        "frozen axes are exact pins, never constraint-shaped values"));
    }
  }

  for (const axis of CORE_AXES) {
    if (mutable.has(axis) || Object.hasOwn(campaign.frozenAxes, axis)) continue;
    errors.push(issue("invalid-document", childPath("frozenAxes", axis),
      "every core axis must be either frozen or mutable; an unclassified axis makes the admission check uncomputable"));
  }

  if (campaign.objective.methods.length === 0) {
    errors.push(issue("invalid-document", "objective.methods",
      "an objective needs at least one benchmarking method-registry reference"));
  }
  const seenMethods = new Set<string>();
  campaign.objective.methods.forEach((method, index) => {
    const identity = `${method.id}${method.version}`;
    if (seenMethods.has(identity)) {
      errors.push(issue("invalid-document", childPath("objective.methods", index),
        "duplicate method reference"));
    }
    seenMethods.add(identity);
  });

  if (campaign.budgets.hardCap.maxCells < campaign.budgets.evaluation.maxCells) {
    errors.push(issue("invalid-document", "budgets.hardCap.maxCells",
      "the hard cap bounds dev waves plus the promotion Run and cannot sit under the evaluation budget"));
  }

  return errors;
}

/** Shape + cross-field validation. Never resolves seeds — that is `checkSeedAgreement`'s job. */
export function validateCampaign(input: unknown): ValidationResult<CampaignDocument> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [issue("invalid-document", "", "a campaign document must be a JSON object")] };
  }
  const record = input as Record<string, unknown>;
  const errors = structuralIssues(record);
  for (const key of Object.keys(record)) {
    if (KNOWN_FIELDS.has(key) || isNamespacedExtensionKey(key)) continue;
    errors.push(issue("invalid-document", key,
      "unrecognized non-namespaced top-level field; a campaign declares no measurement of its own"));
  }
  if (errors.length > 0) return { ok: false, errors };
  const campaign = record as unknown as CampaignDocument;
  const semantic = semanticIssues(campaign);
  if (semantic.length > 0) return { ok: false, errors: semantic };
  return { ok: true, value: campaign };
}

function resolvedTuple(
  seed: PolicyRef,
  resolution: SeedResolution,
  path: string,
  errors: PolicyOptimizationIssue[],
): ExecutionPolicyTuple | undefined {
  if (resolution.kind !== seed.kind) {
    errors.push(issue("seed-resolution", path, `seed is a ${seed.kind} reference, resolution is a ${resolution.kind}`));
    return undefined;
  }
  try {
    if (resolution.kind === "tuple") {
      // The digest is recomputed, never compared label-to-label: a caller that hands over the wrong
      // tuple under the right digest is exactly the substitution the content addressing exists to
      // catch, and the campaign's whole frozen-axis claim is downstream of this one check.
      const actual = tupleDigest(resolution.tuple);
      if (actual !== seed.digest) {
        errors.push(issue("seed-resolution", path,
          `resolved tuple digest ${actual} does not match the seed reference ${seed.digest}`));
        return undefined;
      }
      return resolution.tuple;
    }
    const actual = prefixedDigest(resolution.manifestBytes);
    if (actual !== seed.digest) {
      errors.push(issue("seed-resolution", path,
        `resolved manifest digest ${actual} does not match the seed reference ${seed.digest}`));
      return undefined;
    }
    return parseExactCandidateManifest(resolution.manifestBytes).policy;
  } catch (cause) {
    errors.push(issue("seed-resolution", path,
      `seed referent is not a well-formed ${resolution.kind}: ${cause instanceof Error ? cause.message : String(cause)}`));
    return undefined;
  }
}

/**
 * Product §5.1's sealing-time check, split out so a *reader* of a sealed campaign who holds the
 * seed referents can re-run exactly what the sealer ran. The document itself carries digests only,
 * so this is the one check that a parse of the bytes alone cannot repeat.
 */
export function checkSeedAgreement(
  campaign: CampaignDocument,
  resolutions: readonly SeedResolution[],
): ValidationResult<readonly ExecutionPolicyTuple[]> {
  const errors: PolicyOptimizationIssue[] = [];
  const mutable = new Set(campaign.mutationSurface);
  const byDigest = new Map<string, SeedResolution>();
  for (const resolution of resolutions) {
    byDigest.set(`${resolution.kind}${resolution.digest}`, resolution);
  }
  const consumed = new Set<string>();
  const tuples: ExecutionPolicyTuple[] = [];

  campaign.seeds.forEach((seed, index) => {
    const path = childPath("seeds", index);
    const key = `${seed.kind}${seed.digest}`;
    const resolution = byDigest.get(key);
    if (resolution === undefined) {
      errors.push(issue("seed-resolution", path,
        `no resolution supplied for ${seed.kind} ${seed.digest}; the frozen-axis check cannot be run without the referent`));
      return;
    }
    consumed.add(key);
    const tuple = resolvedTuple(seed, resolution, path, errors);
    if (tuple === undefined) return;
    tuples.push(tuple);

    for (const [axis, frozen] of Object.entries(campaign.frozenAxes)) {
      const actual = Object.hasOwn(tuple, axis) ? (tuple as Record<string, unknown>)[axis] : undefined;
      if (axisValuesByteShare(actual, frozen)) continue;
      errors.push(issue("frozen-axis-disagreement", childPath(path, axis),
        `seed does not byte-share the campaign's frozen ${axis}: ${canonicalJsonText(actual === undefined ? null : actual)} vs ${canonicalJsonText(frozen)}`));
    }
    for (const axis of campaign.mutationSurface) {
      const actual = Object.hasOwn(tuple, axis) ? (tuple as Record<string, unknown>)[axis] : undefined;
      if (isExactPin(axis, actual)) continue;
      errors.push(issue("constraint-shaped-pin", childPath(path, axis),
        `seed's mutable axis ${axis} must carry an exact pin; the search dimension is what the arms are compared on`));
    }

    // BLOCKER-1. The two loops above check the axes the *campaign* names. A tuple carries more
    // than that: substrate §4.1 step 2 admits every profile-declared `requirementKey` present in
    // the effective requirements, so a `repository-work/1.0` seed carries `effort` alongside the
    // four core axes. An axis in neither list is checked by nothing — two seeds differing only on
    // `effort` would seal cleanly and then be compared as though they shared a treatment, which is
    // precisely the uncomputable-check blocker §5.1's `frozenAxes` exists to close. §5.1 says
    // frozen axes are "every non-mutable axis", not "every non-mutable core axis", so the fix is a
    // refusal that names the axis: the owner freezes it, or moves it into the mutation surface.
    for (const axis of Object.keys(tuple)) {
      if (axis === "formatToken") continue;
      if (Object.hasOwn(campaign.frozenAxes, axis) || mutable.has(axis)) continue;
      errors.push(issue("unclassified-axis", childPath(path, axis),
        `seed carries axis ${axis}, which the campaign neither freezes nor mutates; add it to frozenAxes or to mutationSurface`));
    }
  });

  for (const resolution of resolutions) {
    const key = `${resolution.kind}${resolution.digest}`;
    if (consumed.has(key)) continue;
    errors.push(issue("seed-resolution", "seeds",
      `resolution for ${resolution.kind} ${resolution.digest} matches no seed reference`));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: tuples };
}

/**
 * Validate → check the seeds → seal. Sealing validates first, so an invalid campaign never
 * acquires a digest that could be quoted or journaled before anyone notices.
 */
export function sealCampaign(
  campaign: CampaignDocument,
  seedResolutions: readonly SeedResolution[],
  benchmarks?: CampaignBenchmarkBytes,
): SealedCampaign {
  const validated = validateCampaign(campaign);
  if (!validated.ok) refuseAll(validated.errors);
  // Review disposition M4. Optional here and mandatory at `DRAFT -> EXPLORING`, for the same
  // reason the seed check takes referents: the document carries digests, so a sealer that does not
  // hold the two slates' bytes cannot run this. One that does should not have to wait for the
  // gate to tell it the campaign was never viable.
  if (benchmarks !== undefined) {
    const disjointness = checkBenchmarkDisjointness(validated.value.target, benchmarks);
    if (!disjointness.ok) {
      refuseAll([issue(
        disjointness.reason === "shared-items" ? "benchmark-overlap" : "invalid-document",
        "target.promotionBenchmark",
        disjointness.detail,
      )]);
    }
  }
  for (const [axis, value] of Object.entries(validated.value.frozenAxes)) {
    assertExactPin(axis, value, childPath("frozenAxes", axis));
  }
  const agreement = checkSeedAgreement(validated.value, seedResolutions);
  if (!agreement.ok) refuseAll(agreement.errors);
  const bytes = canonicalJsonBytes(validated.value);
  return { bytes, digest: prefixedDigest(bytes), campaign: validated.value };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Parses bytes that must already BE the sealed form. Sealed once: re-canonicalizing untrusted
 * bytes and calling the result "the same campaign" is how two hosts end up with two digests for one
 * campaign, so any deviation is a refusal rather than a normalization.
 */
export function parseExactCampaign(bytes: Uint8Array): CampaignDocument {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    refuseAll([issue("invalid-document", "", "sealed campaign bytes are not valid UTF-8")]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuseAll([issue("invalid-document", "", "sealed campaign bytes are not valid JSON")]);
  }
  const result = validateCampaign(parsed);
  if (!result.ok) refuseAll(result.errors);
  if (canonicalJsonText(result.value) !== text) {
    refuseAll([issue("invalid-document", "",
      "these bytes are not the canonical sealed form of the campaign they carry")]);
  }
  return result.value;
}
