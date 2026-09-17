/**
 * #4397: boot-time convergence for nonterminal attempts no coordinator will `recover`. Shared by
 * the three compositions that construct a `LocalTaskExecutionBackend` so each logs the same
 * per-attempt line under its own prefix and logger.
 */
import type { NonterminalSweepEntry } from '@jinn-network/task-execution-backend-local';

export async function reconcileNonterminalAtBoot(
  backend: { reconcileNonterminal(): Promise<readonly NonterminalSweepEntry[]> },
  prefix: string,
  logger: { info(message: string): void; warn(message: string): void } | undefined,
): Promise<void> {
  for (const entry of await backend.reconcileNonterminal()) {
    if (entry.outcome === 'failed') {
      logger?.warn(`${prefix} boot reconciliation failed for ${entry.attempt}: ${entry.detail ?? 'unknown'}`);
    } else {
      logger?.info(`${prefix} boot reconciliation ${entry.classification} for ${entry.attempt}${entry.detail === undefined ? '' : ` (${entry.detail})`}`);
    }
  }
}
