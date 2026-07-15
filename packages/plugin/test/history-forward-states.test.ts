import { describe, expect, it } from 'vitest';
import { createJinnPlugin } from '../src/index.js';
import {
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../src/testing.js';
import { makeSampleEpisode } from './_fixtures/episode.js';
import { ok } from '../src/outcome.js';
import type {
  ContributionLedgerEntry,
  ContributionPort,
} from '../src/ports/contribution-port.js';

/**
 * AC1 — history projection foundation folds four contribution states from the ledger.
 * The in-memory testing port only authors `queued`/`vetoed`, so this stub
 * seeds `minted`/`published` directly to prove the fold surfaces them.
 */
class StubContributionPort implements ContributionPort {
  constructor(private readonly entries: ContributionLedgerEntry[]) {}
  async recordMineable(episodeId: string) {
    const recordId = `record-${this.entries.length + 1}`;
    this.entries.push({ recordId, episodeId, status: 'queued' });
    return ok({ recordId });
  }
  async ledger() {
    return ok(this.entries);
  }
  async mintStatus(recordId: string) {
    const found = this.entries.find((e) => e.recordId === recordId);
    return found ? ok({ status: found.status }) : ok({ status: 'queued' as const });
  }
  async veto(recordId: string) {
    return ok({ recordId, status: 'vetoed' as const });
  }
}

function buildPlugin(evidence: InMemoryEvidencePort, contribution: ContributionPort) {
  return createJinnPlugin({
    corpus: new InMemoryCorpusPort([]),
    evidence,
    contribution,
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
  });
}

describe('plugin.history — contribution-state projection foundation (AC1)', () => {
  it('projects queued / minted / published / vetoed onto history rows', async () => {
    const evidence = new InMemoryEvidencePort();
    const statuses = ['queued', 'minted', 'published', 'vetoed'] as const;
    const ledger: ContributionLedgerEntry[] = [];
    for (const status of statuses) {
      await evidence.put(
        makeSampleEpisode({
          episodeId: `ep-${status}`,
          session: { sessionId: `sess-${status}`, capturedAt: '2026-07-14T00:00:00.000Z' },
        }),
      );
      ledger.push({ recordId: `rec-${status}`, episodeId: `ep-${status}`, status });
    }
    const plugin = buildPlugin(evidence, new StubContributionPort(ledger));

    const { entries } = await plugin.history();
    for (const status of statuses) {
      const row = entries.find((e) => e.sessionId === `sess-${status}`);
      expect(row?.contributionState.status).toBe(status);
    }
  });
});
