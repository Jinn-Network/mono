/**
 * The `/v1/status` evidence-indexing rollup shapes, and the narrow port `gather-status.ts` reads
 * them through.
 *
 * These live under `src/types/` rather than beside the evidence driver because of the #1584
 * api → daemon boundary (`client/test/architecture/api-daemon-boundary.test.ts`): no module under
 * `src/api/` may import from `src/daemon/`, not even a type. The API tier depends on this shape,
 * the daemon tier produces it, and neither owns it.
 */

/** One indexing failure, projected for the `/v1/status` rollup. */
export interface EvidenceIndexingFailureSummary {
  readonly reference: string;
  readonly category: string;
  readonly message: string;
}

/** The `/v1/status` indexing-failure rollup shape. */
export interface EvidenceIndexingStatus {
  readonly failures: readonly EvidenceIndexingFailureSummary[];
  readonly pending: number;
}

/**
 * What `gather-status.ts` needs from the running evidence driver — nothing more. Structurally
 * satisfied by `EvidenceDriverLoop` without the API tier ever naming that class.
 */
export interface EvidenceIndexingSource {
  failures(): Promise<readonly EvidenceIndexingFailureSummary[]>;
  pending(): number;
}
