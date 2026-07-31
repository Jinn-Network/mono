/**
 * The evidence driver loop (cutover stage 1, Task 11): does what the assembly package
 * refuses to own — drives `sync()` on the local evidence runtime, decides publication
 * under contract 6's policy, and surfaces indexing failures for the `/v1/status`
 * indexing-failure rollup.
 */
import type { Store } from '../store/store.js';
import { runLoop } from './loop-heartbeat.js';
import type { OperatorEvidence } from './evidence-join.js';

export type PublicationDecision =
  | { readonly publish: true }
  | {
      readonly publish: false;
      readonly reason:
        | 'not-sealed-for-delivery'
        | 'capability-grant-material'
        | 'secret-forward'
        | 'already-published';
    };

/**
 * Contract 6 as a pure function so the policy is testable without a runtime.
 * Capability-grant material and secret forwards are never published, regardless of
 * sealing; a record not sealed for delivery or announcement is withheld; publication
 * is idempotent by digest.
 */
export function decidePublication(
  record: {
    readonly digest: `sha256:${string}`;
    readonly sealedFor: 'delivery' | 'announcement' | 'none';
    readonly containsCapabilityGrantMaterial: boolean;
    readonly containsSecretForward: boolean;
  },
  alreadyPublished: ReadonlySet<string>,
): PublicationDecision {
  if (record.containsCapabilityGrantMaterial) {
    return { publish: false, reason: 'capability-grant-material' };
  }
  if (record.containsSecretForward) return { publish: false, reason: 'secret-forward' };
  if (record.sealedFor === 'none') return { publish: false, reason: 'not-sealed-for-delivery' };
  if (alreadyPublished.has(record.digest)) return { publish: false, reason: 'already-published' };
  return { publish: true };
}

/** One indexing failure, projected for the `/v1/status` rollup. */
export interface EvidenceIndexingFailureSummary {
  readonly reference: string;
  readonly category: string;
  readonly message: string;
}

/** The `/v1/status` indexing-failure rollup shape (see `gather-status.ts`). */
export interface EvidenceIndexingStatus {
  readonly failures: readonly EvidenceIndexingFailureSummary[];
  readonly pending: number;
}

export interface EvidenceDriverConfig {
  readonly evidence: OperatorEvidence;
  readonly intervalMs: number;
  readonly store: Store;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

/**
 * A `LocalIndexingFailure.reference` is an `EvidenceRecordReference` object
 * (`{ family, digest }`), not a string — projected to a stable string for the
 * public, JSON-serializable rollup shape. Already-string references (as
 * produced by test doubles) pass through unchanged.
 */
function referenceToString(reference: unknown): string {
  if (typeof reference === 'string') return reference;
  if (
    reference !== null &&
    typeof reference === 'object' &&
    'family' in reference &&
    'digest' in reference
  ) {
    const { family, digest } = reference as { family: unknown; digest: unknown };
    return `${String(family)}:${String(digest)}`;
  }
  return String(reference);
}

export class EvidenceDriverLoop {
  private stopped = false;
  private latestFailures: readonly EvidenceIndexingFailureSummary[] = [];
  private latestPending = 0;
  private readonly warnedReferences = new Set<string>();

  constructor(private readonly config: EvidenceDriverConfig) {}

  async tick(): Promise<{ readonly indexed: number; readonly failed: number; readonly pending: number }> {
    const runtime = this.config.evidence.runtime;
    const report = await runtime.sync();
    const status = await runtime.getStatus();
    const page = await runtime.listIndexingFailures({ limit: 25 });

    this.latestFailures = page.items.map((item) => ({
      reference: referenceToString(item.reference),
      category: String(item.category),
      message: item.message,
    }));
    this.latestPending = status.pendingAnnouncements;

    for (const failure of this.latestFailures) {
      if (this.warnedReferences.has(failure.reference)) continue;
      this.warnedReferences.add(failure.reference);
      this.config.logger?.warn(
        `[evidence-driver] indexing failure for ${failure.reference} (${failure.category}): ${failure.message}`,
      );
    }

    return { indexed: report.indexed, failed: report.failed, pending: status.pendingAnnouncements };
  }

  async run(): Promise<void> {
    await runLoop({
      name: 'evidence-driver',
      store: this.config.store,
      tick: () => this.tick().then(() => undefined),
      intervalMs: this.config.intervalMs,
      stopSignal: () => this.stopped,
      emitSource: 'evidence-driver',
      onError: (err) => {
        this.config.logger?.warn(
          `[evidence-driver] tick failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /** Feeds the `/v1/status` indexing-failure rollup. */
  async failures(): Promise<readonly EvidenceIndexingFailureSummary[]> {
    return this.latestFailures;
  }

  /** Feeds the `/v1/status` indexing-failure rollup's `pending` count. */
  pending(): number {
    return this.latestPending;
  }
}
