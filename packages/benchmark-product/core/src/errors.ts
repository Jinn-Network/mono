/**
 * The product's typed error posture (spec §4.3, assumption A8).
 *
 * Every operation returns either a typed result or a typed error — never a silent
 * fallback, never free-text-only failure. Callers branch on `code` (and, where they
 * care, on `issues[].path`), never on `message`: messages are prose and free to
 * change; codes and paths are the contract.
 *
 * The v1 code set refines the spec §4.3 categories per A8 ("refined per operation
 * in BP-10"):
 *
 * - `authority` is realized as `authority-denied` (the operations-boundary refusal).
 * - `journal-integrity`, `not-found`, `conflict`, and `invalid-invocation` are BP-10
 *   refinements: a malformed audit journal, a missing subject, a workspace/draft
 *   collision, and a CLI-level invocation error are four different situations a
 *   machine caller must distinguish.
 * - `venue-unavailable`, `venue-unverifiable`, and `execution` are reserved here so
 *   later packets (venue selection, launch) extend the taxonomy without a breaking
 *   change; BP-10 raises `execution` only as the carrier for untyped throws.
 */

export type ProductErrorCode =
  /** Draft or document content invalid (schema issues carried in `issues`). */
  | "validation"
  /** The operation is not valid in the subject's current lifecycle state. */
  | "illegal-transition"
  /** The acting principal is not a workspace member or lacks the required grant. */
  | "authority-denied"
  /** Stored sealed bytes fail their digest check on read. */
  | "record-integrity"
  /** The audit journal on disk is not well-formed, ordered JSONL. */
  | "journal-integrity"
  /** The named workspace, draft, or record does not exist. */
  | "not-found"
  /** The write collides with existing state (workspace already initialized, draft id taken). */
  | "conflict"
  /** CLI-level: unknown verb, unknown flag, or missing required flag. */
  | "invalid-invocation"
  /** Reserved for later packets (spec §7.3): the selected venue is not available. */
  | "venue-unavailable"
  /** Reserved for later packets (spec §7.3): a venue guarantee cannot be verified. */
  | "venue-unverifiable"
  /** Backend-reported or untyped failure, carried through rather than swallowed. */
  | "execution";

export interface ProductIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The machine-readable error envelope (spec §4.3): the same shape on the library
 * surface and inside the CLI's `--json` output.
 */
export interface ProductErrorEnvelope {
  readonly code: ProductErrorCode;
  readonly detail: string;
  readonly issues?: readonly ProductIssue[];
}

export class BenchmarkProductError extends Error {
  readonly code: ProductErrorCode;
  readonly issues: readonly ProductIssue[];

  constructor(code: ProductErrorCode, message: string, issues: readonly ProductIssue[] = []) {
    super(message);
    this.name = "BenchmarkProductError";
    this.code = code;
    this.issues = issues;
  }
}

/** Throws a typed error carrying a single issue. */
export function refuse(code: ProductErrorCode, path: string, message: string): never {
  throw new BenchmarkProductError(code, message, [{ path, message }]);
}

/** Throws a typed error carrying every issue; the first issue's message leads. */
export function refuseWithIssues(code: ProductErrorCode, issues: readonly ProductIssue[]): never {
  const [first] = issues;
  throw new BenchmarkProductError(code, first === undefined ? code : first.message, issues);
}

/**
 * Adapts any thrown value to the machine-readable envelope. A typed error keeps its
 * code and issues; anything else is carried as `execution` — visible, never swallowed.
 */
export function toErrorEnvelope(cause: unknown): ProductErrorEnvelope {
  if (cause instanceof BenchmarkProductError) {
    return cause.issues.length > 0
      ? { code: cause.code, detail: cause.message, issues: cause.issues }
      : { code: cause.code, detail: cause.message };
  }
  return {
    code: "execution",
    detail: cause instanceof Error ? cause.message : String(cause),
  };
}
