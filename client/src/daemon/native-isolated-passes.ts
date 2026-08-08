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
