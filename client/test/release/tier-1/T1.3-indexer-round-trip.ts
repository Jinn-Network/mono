import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

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
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string): void => {
    evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  log('T1.3 indexer-round-trip — Ponder spawn helper missing; returning skip');
  log('Tracked: https://github.com/Jinn-Network/mono/issues/341');
  await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));

  return {
    scenarioId: 'T1.3',
    verdict: 'skip',
    wallClockMs: Date.now() - started,
    evidencePath: opts.evidencePath,
    failClass: null,
    failNotes: 'Ponder spawn helper not available — see GH issue #341',
  };
}

describe('T1.3 indexer-round-trip', () => {
  it('returns skip verdict while Ponder helper is missing', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.3-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.3.log');
    try {
      const verdict = await runT13IndexerRoundTrip({ evidencePath });
      expect(verdict.scenarioId).toBe('T1.3');
      expect(verdict.verdict).toBe('skip');
      expect(verdict.failClass).toBeNull();
      expect(verdict.failNotes).toMatch(/Ponder|helper|341/);
      const logContent = await fs.readFile(evidencePath, 'utf-8');
      expect(logContent).toContain('skip');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  });
});
