// SPDX-License-Identifier: MIT

/**
 * The one rejection type this package throws, and the one issue shape it reports.
 *
 * Adopted from `@jinn-network/policy-identity`'s `errors.ts` rather than re-invented: callers
 * branch on `category` (and, where they care, on `errors[].path`), never on `message`. Messages
 * are prose and are free to change; categories and paths are the contract.
 */

export type PolicyOptimizationErrorCategory =
  /** Structural rejection of an input document. */
  | "invalid-document"
  /** Product §5.1 — a seed tuple does not byte-share one of the campaign's `frozenAxes` values. */
  | "frozen-axis-disagreement"
  /** Product §5.1 — a frozen or mutable axis carries a constraint-shaped value instead of an exact pin. */
  | "constraint-shaped-pin"
  /** Product §5.1 — the mutation surface is not the v0 surface, or overlaps `frozenAxes`. */
  | "mutation-surface"
  /** Product §5.1 — a seed carries an axis that is neither frozen nor mutable, so nothing checks it. */
  | "unclassified-axis"
  /** Product §5.1 — a seed could not be resolved to the exact tuple its typed reference names. */
  | "seed-resolution"
  /** Product §6.3 — the promotion Benchmark is absent, not committed, revealed, or does not bind. */
  | "promotion-benchmark"
  /** Product §5.2 — a replayed journal entry disagrees with the entry already recorded at its sequence. */
  | "journal-conflict"
  /** Product §5.2 — the journal on disk is not a well-formed, unbroken chain. */
  | "journal-integrity"
  /** Product §5.2 — the appended event is illegal in the campaign's derived lifecycle phase. */
  | "lifecycle-violation"
  /** Product §6.1 — the wave's arms, Benchmark, or Run could not be composed from the inputs. */
  | "wave-composition"
  /** Product §5.1 — the wave would spend past `budgets.evaluation` or `budgets.hardCap`. */
  | "budget-exceeded"
  /** Product §6.2 — the campaign names an allocation policy this package does not implement, or misparameterizes it. */
  | "allocation-policy"
  /** Product §6.3 — the promotion Run's preregistration, reveal, or flat-sampling discipline was violated. */
  | "promotion-discipline"
  /** Product §8.3 — the archive's inputs cannot be projected (a self-parent, a duplicate, an unorderable value). */
  | "archive-derivation"
  /** Product §9/§7.4 — an adoption was refused: an unapproved payload class, or nothing to roll back to. */
  | "adoption-gate";

export interface PolicyOptimizationIssue {
  readonly path: string;
  readonly code: PolicyOptimizationErrorCategory;
  readonly message: string;
}

export class PolicyOptimizationError extends Error {
  readonly category: PolicyOptimizationErrorCategory;
  readonly errors: readonly PolicyOptimizationIssue[];

  constructor(category: PolicyOptimizationErrorCategory, errors: readonly PolicyOptimizationIssue[]) {
    const [first] = errors;
    super(first === undefined ? category : `${first.path}: ${first.message}`);
    this.name = "PolicyOptimizationError";
    this.category = category;
    this.errors = errors;
  }
}

/** Builds one issue. `path` is dotted and rooted at the document (`""` is the document itself). */
export function issue(
  code: PolicyOptimizationErrorCategory,
  path: string,
  message: string,
): PolicyOptimizationIssue {
  return { path, code, message };
}

/** Refuses with a single issue. The category of the throw is that issue's code. */
export function refuse(
  code: PolicyOptimizationErrorCategory,
  path: string,
  message: string,
): never {
  throw new PolicyOptimizationError(code, [issue(code, path, message)]);
}

/** Refuses with an already-collected issue list; the first issue's code sets the category. */
export function refuseAll(errors: readonly PolicyOptimizationIssue[]): never {
  const [first] = errors;
  if (first === undefined) throw new PolicyOptimizationError("invalid-document", []);
  throw new PolicyOptimizationError(first.code, errors);
}

/** Joins a parent path and a member name into the dotted path the tests pin. */
export function childPath(parent: string, member: string | number): string {
  return parent === "" ? String(member) : `${parent}.${member}`;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly PolicyOptimizationIssue[] };
