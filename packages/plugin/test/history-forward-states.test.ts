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
  async recordMineable(candidate: Parameters<ContributionPort['recordMineable']>[0]) {
    const recordId = `record-${this.entries.length + 1}`;
    this.entries.push({
      recordId,
      sourceId: candidate.sourceId,
      localState: 'recorded',
      publicationState: candidate.publishMinedTasksConsent ? 'preview-required' : 'disabled',
      status: candidate.publishMinedTasksConsent ? 'preview-required' : 'recorded',
    });
    return ok({ recordId });
  }
  async ledger() {
    return ok(this.entries);
  }
  async mintStatus(recordId: string) {
    const found = this.entries.find((e) => e.recordId === recordId);
    return found ? ok(found) : ok({
      localState: 'recorded' as const,
      publicationState: 'disabled' as const,
      status: 'recorded' as const,
    });
  }
  async authorize(recordId: string) {
    return ok({ recordId, publicationState: 'queued' as const, status: 'queued' as const });
  }
  async veto(recordId: string) {
    return ok({
      recordId,
      publicationState: 'vetoed' as const,
      status: 'vetoed' as const,
    });
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

describe('plugin.history — two-axis contribution-state projection', () => {
  it('projects local and publication states onto their derived user-facing status', async () => {
    const evidence = new InMemoryEvidencePort();
    const states: Array<Omit<ContributionLedgerEntry, 'recordId' | 'sourceId'>> = [
      { localState: 'recorded', publicationState: 'disabled', status: 'recorded' },
      { localState: 'minted', publicationState: 'disabled', status: 'minted', mintRef: 'mint-1' },
      { localState: 'rejected', publicationState: 'disabled', status: 'rejected' },
      { localState: 'recorded', publicationState: 'preview-required', status: 'preview-required' },
      { localState: 'minted', publicationState: 'queued', status: 'queued', mintRef: 'mint-2' },
      {
        localState: 'minted',
        publicationState: 'published',
        status: 'published',
        mintRef: 'mint-3',
        publicationRef: 'publication-1',
      },
      { localState: 'recorded', publicationState: 'vetoed', status: 'vetoed' },
    ];
    const ledger: ContributionLedgerEntry[] = [];
    for (const state of states) {
      const status = state.status;
      await evidence.put(
        makeSampleEpisode({
          episodeId: `ep-${status}`,
          session: { sessionId: `sess-${status}`, capturedAt: '2026-07-14T00:00:00.000Z' },
        }),
      );
      ledger.push({ recordId: `rec-${status}`, sourceId: `ep-${status}`, ...state });
    }
    const plugin = buildPlugin(evidence, new StubContributionPort(ledger));

    const { entries } = await plugin.history();
    for (const { status } of states) {
      const row = entries.find((e) => e.sessionId === `sess-${status}`);
      expect(row?.contributionState.status).toBe(status);
    }
    expect(entries.find((e) => e.sessionId === 'sess-published')?.contributionState.anchorRef)
      .toBe('publication-1');
  });
});
