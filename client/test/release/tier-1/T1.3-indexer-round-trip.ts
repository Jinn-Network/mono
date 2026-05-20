import { runScenario, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

const SKIP_REASON = 'Ponder spawn helper not available — see GH issue #341';

/**
 * T1.3 — indexer round-trip.
 *
 * Designed to catch the fufn-class regression (indexer schema drift vs. what
 * the daemon writes). Implementation requires a local Ponder spawn helper at
 * `client/test/_support/indexer/ponder.ts` (boots a Ponder process against
 * an Anvil-forked chain, exposes a GraphQL URL + teardown handle).
 *
 * That helper does not exist yet. Tracked at GH issue #341 (label:
 * release-readiness). Until it lands this scenario returns `verdict: 'skip'`
 * so the orchestrator does not block on it.
 */
export async function runT13IndexerRoundTrip(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  return runScenario('T1.3', opts, async ({ log }) => {
    log('T1.3 indexer-round-trip — Ponder spawn helper missing; returning skip');
    log('Tracked: https://github.com/Jinn-Network/mono/issues/341');
    return { verdict: 'skip', failNotes: SKIP_REASON };
  });
}

