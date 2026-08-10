/**
 * Run independent per-source passes so one source's failure cannot take out its siblings (#2533).
 *
 * The same structural lesson as #2529/#2530 (per-source isolation at boot), one layer up in the
 * evaluator's sync. The evaluator's two passes — requester, then solver — were sequential and
 * unguarded, so any requester-side throw skipped the solver sync entirely. Live, the
 * association-key collision threw on every tick, so operator A never ingested a single one of
 * operator B's records: 802 consecutive aborted ticks, the association table pinned to task 1218,
 * and leg 6 blocked regardless of what B delivered.
 *
 * This is isolation, NOT suppression. Every pass gets its turn; every failure is logged with its
 * cause named and its source named; and the first failure is rethrown once all passes have run,
 * so the caller still sees a failing sync. What changes is only that a sibling's progress is no
 * longer collateral damage.
 */

export interface NativeIsolatedPass {
  /** The source this pass belongs to, used verbatim in the log line. */
  readonly name: string;
  run(): Promise<void>;
}

/**
 * The same isolation, one level finer: per ITEM inside a pass (#2539).
 *
 * Per-source isolation (above) stopped a requester failure taking out the solver sync. It did not
 * stop ONE card taking out every other card in its own pass, and that is what stranded the
 * evaluator in round 8: the requester pass indexes its queued cards in a bare `for` loop, card 2
 * refused, and cards 3 and 4 were never reached — on every tick, because nothing acknowledges a
 * card that failed to index. A permanently-refusing card ahead of the queue is a permanent wall.
 *
 * Returns the failures in order instead of throwing, so the caller decides what a failed item
 * means for the pass. Every failure is still logged with the item named and its cause named — this
 * is isolation, not suppression, exactly as `runIsolatedPasses` is.
 */
export interface NativeIsolatedIngestStep {
  /** What this step takes in, used verbatim in the log line. */
  readonly name: string;
  run(): Promise<void>;
}

/**
 * Run the ingest steps that feed a read, and let the read happen either way (#2539).
 *
 * The evaluator's read is derived entirely from a DURABLE index that every entry was verified into
 * and from the local canonical venue repository. Failing to take in NEW material does not
 * invalidate material already indexed, so aborting the whole read because one source refused is
 * pure collateral damage — and it is exactly what stranded the evaluator's source checkpoint at
 * sequence 3 in the live gate's round 8, with a card it had already verified sitting unprocessed
 * behind the refusal.
 *
 * So this reports and continues where `runIsolatedPasses` reports and rethrows. It is still not
 * suppression: every failure is reported at error level, every pass it recurs, with the step named
 * and the cause named. And nothing a failed step would have contributed can appear downstream,
 * because a step that failed indexed nothing.
 */
export async function runIsolatedIngest(
  steps: readonly NativeIsolatedIngestStep[],
  options: { readonly label: string; readonly report?: (message: string) => void },
): Promise<readonly unknown[]> {
  const report = options.report ?? ((message: string) => { console.error(message); });
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      // eslint-disable-next-line no-await-in-loop -- ingest steps are ordered and share one store.
      await step.run();
    } catch (cause) {
      failures.push(cause);
      report(
        `[${options.label}] ${step.name} failed this pass; reading the verified index as it stands: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return failures;
}

export function runIsolatedItems<T>(items: readonly T[], input: {
  readonly label: string;
  /** How this item is named in the log line — an identity, not a description. */
  readonly name: (item: T) => string;
  readonly run: (item: T) => void;
  readonly warn?: (message: string) => void;
}): readonly unknown[] {
  const warn = input.warn ?? ((message: string) => { console.warn(message); });
  const failures: unknown[] = [];
  for (const item of items) {
    try {
      input.run(item);
    } catch (cause) {
      failures.push(cause);
      warn(
        `[${input.label}] ${input.name(item)} failed to index — the rest of this pass still ran, `
        + `retrying next poll: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return failures;
}

export async function runIsolatedPasses(
  passes: readonly NativeIsolatedPass[],
  options: { readonly label: string; readonly warn?: (message: string) => void } = { label: 'native' },
): Promise<void> {
  const warn = options.warn ?? ((message: string) => { console.warn(message); });
  const failures: unknown[] = [];

  for (const pass of passes) {
    try {
      // eslint-disable-next-line no-await-in-loop -- passes are ordered and share one store.
      await pass.run();
    } catch (cause) {
      failures.push(cause);
      const siblings = passes.filter(({ name }) => name !== pass.name).map(({ name }) => name);
      warn(
        `[${options.label}] ${pass.name} source sync failed`
        + (siblings.length > 0 ? ` — ${siblings.join(', ')} still ran this pass` : '')
        + `, retrying next poll: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  if (failures.length > 0) throw failures[0];
}
