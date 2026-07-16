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
import type { ContributionCandidateV1 } from '../src/schemas/contribution-candidate.js';
import type { EpisodeV1 } from '../src/schemas/episode.js';

function candidate(sourceId: string, consent = false): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId,
    repositorySlug: 'Jinn-Network/mono',
    baseCommit: '0123456789abcdef',
    acceptedDiff: 'diff --git a/a b/a\n+fixed\n',
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: consent,
    createdAt: '2026-07-15T12:00:00.000Z',
  };
}

function currentEpisode(overrides: Partial<EpisodeV1> = {}): EpisodeV1 {
  return makeSampleEpisode({
    activity: { searchedTerms: [], providedRefs: [], surfacedRefs: [], fetchedRefs: [], installedSkillRefs: [] },
    eligibility: {
      eligible: false,
      reason: 'no accepted diff',
      checkedAt: '2026-07-14T00:00:00.000Z',
    },
    ...overrides,
  });
}

function buildPlugin(
  evidence: InMemoryEvidencePort,
  contribution = new InMemoryContributionPort(),
  localLearning = new InMemoryLocalLearningPort(),
) {
  return createJinnPlugin({
    corpus: new InMemoryCorpusPort([]),
    evidence,
    contribution,
    localLearning,
    skills: new InMemorySkillsPort(),
  });
}

describe('plugin.history / explain (AC3 — reproducible from port reads)', () => {
  it('is reproducible: two calls over the same port state are deep-equal', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(currentEpisode({ episodeId: 'ep-1' }));
    await evidence.put(currentEpisode({ episodeId: 'ep-2' }));
    const plugin = buildPlugin(evidence);
    const first = await plugin.history();
    const second = await plugin.history();
    expect(second).toEqual(first);
    expect(first.entries).toHaveLength(2);
    expect(first.degraded).toBe(false);
  });

  it('joins contribution state by episodeId', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(currentEpisode({ episodeId: 'ep-1' }));
    const contribution = new InMemoryContributionPort();
    const recorded = await contribution.recordMineable(candidate('ep-1', true));
    if (recorded.status !== 'ok') throw new Error('record failed');
    await contribution.authorize(recorded.value.recordId);
    const plugin = buildPlugin(evidence, contribution);
    const { entries } = await plugin.history();
    const row = entries.find((e) => e.sessionId === currentEpisode().session.sessionId);
    expect(row?.contributionState.status).toBe('queued');
  });

  it('reports legacy eligibility as unavailable — never as a false verdict', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(
      makeSampleEpisode({
        episodeId: 'ep-eligible',
        outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
        retention: { policy: 'contribution-eligible' },
      }),
    );
    const plugin = buildPlugin(evidence);

    const { entries } = await plugin.history();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.eligibility).toBeNull();
    expect(entries[0]?.knowledgeSurfaced).toBeNull();
    expect(entries[0]?.knowledgeUsed).toBeNull();

    const ex = await plugin.explain('sess-fixture-1');
    expect(ex.found).toBe(true);
    expect(ex.eligibility).toBeNull();
  });

  it('projects persisted legacy activity facts (fallback) and the authoritative eligibility verdict', async () => {
    const evidence = new InMemoryEvidencePort();
    const eligibility = {
      eligible: true,
      reason: 'accepted diff on a public repository',
      checkedAt: '2026-07-15T12:00:00.000Z',
    };
    await evidence.put(currentEpisode({
      episodeId: 'ep-enriched',
      activity: {
        searchedTerms: [],
        providedRefs: [],
        surfacedRefs: ['knowledge/a', 'knowledge/b'],
        fetchedRefs: ['knowledge/b'],
        installedSkillRefs: ['skills/tdd@1'],
      },
      eligibility,
    }));
    const plugin = buildPlugin(evidence);

    const history = await plugin.history();
    expect(history.entries[0]).toMatchObject({
      knowledgeSurfaced: 2,
      knowledgeUsed: 1,
      eligibility,
    });

    const explanation = await plugin.explain('sess-fixture-1');
    expect(explanation.surfacedRefs).toEqual(['knowledge/a', 'knowledge/b']);
    expect(explanation.fetchedRefs).toEqual(['knowledge/b']);
    expect(explanation.installedSkillRefs).toEqual(['skills/tdd@1']);
    expect(explanation.eligibility).toEqual(eligibility);
  });

  it('projects provided counts from the evidence-first activity fields (rescope §3.6), no legacy fallback needed', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(currentEpisode({
      episodeId: 'ep-rescoped',
      activity: {
        searchedTerms: ['dashboard', 'vitest', 'flake'],
        providedRefs: ['bafyProvided1'],
        surfacedRefs: [],
        fetchedRefs: [],
        installedSkillRefs: [],
      },
    }));
    const plugin = buildPlugin(evidence);

    const history = await plugin.history();
    expect(history.entries[0]).toMatchObject({ knowledgeSurfaced: 3, knowledgeUsed: 1 });
  });

  it('reports zero/zero for a rescoped nothing-found episode rather than falling back to legacy fields', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(currentEpisode({
      episodeId: 'ep-rescoped-empty',
      activity: {
        searchedTerms: [],
        providedRefs: [],
        surfacedRefs: [],
        fetchedRefs: [],
        installedSkillRefs: [],
      },
    }));
    const plugin = buildPlugin(evidence);

    const history = await plugin.history();
    expect(history.entries[0]).toMatchObject({ knowledgeSurfaced: 0, knowledgeUsed: 0 });
  });

  it('explain returns a structured trace for a session', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(currentEpisode({ episodeId: 'ep-1' }));
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
    await evidence.put(currentEpisode({ episodeId: 'ep-1' }));
    const brokenContribution: ContributionPort = {
      async recordMineable() { return unavailable('down'); },
      async ledger(): Promise<PortResult<ContributionLedgerEntry[]>> { return unavailable('ledger down'); },
      async mintStatus() { return unavailable('down'); },
      async authorize() { return unavailable('down'); },
      async veto() { return unavailable('down'); },
    };
    const plugin = buildPlugin(evidence, brokenContribution as unknown as InMemoryContributionPort);
    const result = await plugin.history();
    expect(result.degraded).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.entries).toHaveLength(1); // partial rows, not a throw
    expect(result.entries[0]?.contributionState.status).toBe('unavailable');
  });

  it('joins installed and staged local skills from their session provenance', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put(currentEpisode({ episodeId: 'ep-skills' }));
    const learning = new InMemoryLocalLearningPort();
    learning.recordSkill({
      ref: 'local-skill:retry-budget',
      sourceSessionIds: ['sess-fixture-1'],
      state: 'installed',
    });
    learning.recordSkill({
      ref: 'local-skill:test-first',
      sourceSessionIds: ['sess-fixture-1'],
      state: 'staged',
    });

    const result = await buildPlugin(evidence, new InMemoryContributionPort(), learning).history();
    expect(result.entries[0]?.distilledSkills).toEqual([
      { ref: 'local-skill:retry-budget', state: 'installed' },
      { ref: 'local-skill:test-first', state: 'staged' },
    ]);
  });
});
