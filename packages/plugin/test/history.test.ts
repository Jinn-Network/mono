import { describe, expect, it } from 'vitest';
import { createJinnPlugin } from '../src/index.js';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../src/testing.js';
import { makeSampleEpisode } from './_fixtures/episode.js';
import type { ContributionPort } from '../src/ports/contribution-port.js';
import { unavailable, type PortResult } from '../src/outcome.js';
import type { ContributionLedgerEntry } from '../src/ports/contribution-port.js';

function buildPlugin(evidence: InMemoryEvidencePort, contribution = new InMemoryContributionPort()) {
  return createJinnPlugin({
    corpus: new InMemoryCorpusPort([]),
    evidence,
    contribution,
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
  });
}

describe('plugin.history / explain (AC3 — reproducible from port reads)', () => {
  it('is reproducible: two calls over the same port state are deep-equal', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(makeSampleEpisode({ episodeId: 'ep-1' }));
    await evidence.put(makeSampleEpisode({ episodeId: 'ep-2' }));
    const plugin = buildPlugin(evidence);
    const first = await plugin.history();
    const second = await plugin.history();
    expect(second).toEqual(first);
    expect(first.entries).toHaveLength(2);
    expect(first.degraded).toBe(false);
  });

  it('joins contribution state by episodeId', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(makeSampleEpisode({ episodeId: 'ep-1' }));
    const contribution = new InMemoryContributionPort();
    await contribution.recordMineable('ep-1'); // → status 'queued'
    const plugin = buildPlugin(evidence, contribution);
    const { entries } = await plugin.history();
    const row = entries.find((e) => e.sessionId === makeSampleEpisode().session.sessionId);
    expect(row?.contributionState.status).toBe('queued');
  });

  it('reports eligibility as indeterminate — never a silently-recomputed verdict', async () => {
    // A completed + contribution-eligible episode: at end() the accepted-diff
    // signal made it eligible, but that signal is NOT persisted on the episode,
    // so history must not assert a verdict it can't derive (would read false).
    const evidence = new InMemoryEvidencePort();
    await evidence.put(
      makeSampleEpisode({
        episodeId: 'ep-eligible',
        outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
        retention: { policy: 'contribution-eligible' },
      }),
    );
    const plugin = buildPlugin(evidence);

    const indeterminate =
      'eligibility indeterminate from episode (contribution signals not persisted)';

    const { entries } = await plugin.history();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.eligibility.eligible).toBe(false);
    expect(entries[0]?.eligibility.reason).toBe(indeterminate);

    const ex = await plugin.explain('sess-fixture-1');
    expect(ex.found).toBe(true);
    expect(ex.eligibility?.eligible).toBe(false);
    expect(ex.eligibility?.reason).toBe(indeterminate);
  });

  it('explain returns a structured trace for a session', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(makeSampleEpisode({ episodeId: 'ep-1' }));
    const plugin = buildPlugin(evidence);
    const ex = await plugin.explain('sess-fixture-1');
    expect(ex.sessionRef).toBe('sess-fixture-1');
    expect(ex.captureStatus).toBe('captured');
    expect(ex.degraded).toBe(false);
    expect(Array.isArray(ex.surfacedRefs)).toBe(true);
  });

  it('explain marks an unknown session not-captured', async () => {
    const plugin = buildPlugin(new InMemoryEvidencePort());
    const ex = await plugin.explain('nope');
    expect(ex.captureStatus).toBe('not-captured');
    expect(ex.found).toBe(false);
  });

  it('folds a degraded contribution read into degraded history (no throw)', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(makeSampleEpisode({ episodeId: 'ep-1' }));
    const brokenContribution: ContributionPort = {
      async recordMineable() { return unavailable('down'); },
      async ledger(): Promise<PortResult<ContributionLedgerEntry[]>> { return unavailable('ledger down'); },
      async mintStatus() { return unavailable('down'); },
      async veto() { return unavailable('down'); },
    };
    const plugin = buildPlugin(evidence, brokenContribution as unknown as InMemoryContributionPort);
    const result = await plugin.history();
    expect(result.degraded).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.entries).toHaveLength(1); // partial rows, not a throw
  });
});
