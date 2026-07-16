import { describe, expect, it } from 'vitest';
import {
  createJinnPlugin,
  unavailable,
  type CompleteSessionInput,
  type ContributionCandidateV1,
  type ContributionPort,
  type EvidencePort,
  type JinnPlugin,
} from '../../src/index.js';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../../src/testing.js';
import { makeSampleEpisode } from '../_fixtures/episode.js';

const ACTIVITY = {
  searchedTerms: [] as string[],
  providedRefs: [] as string[],
  surfacedRefs: ['knowledge/surfaced-1'],
  fetchedRefs: ['knowledge/fetched-1'],
  installedSkillRefs: ['skills/tdd@1'],
};

function candidate(
  overrides: Partial<ContributionCandidateV1> = {},
): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId: 'episode-complete',
    repositorySlug: 'Jinn-Network/mono',
    baseCommit: '0123456789abcdef',
    acceptedDiff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
    testRuns: [{ command: 'yarn test', exitCode: 0, at: '2026-07-15T12:00:00.000Z' }],
    intermediateFailureDiffs: [],
    skillEvents: [{ skillRef: 'skills/tdd@1', action: 'invoked' }],
    publishMinedTasksConsent: false,
    createdAt: '2026-07-15T12:01:00.000Z',
    ...overrides,
  };
}

function pluginWith(evidence: EvidencePort, contribution: ContributionPort): JinnPlugin {
  return createJinnPlugin({
    corpus: new InMemoryCorpusPort([]),
    evidence,
    contribution,
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
  });
}

async function invoke(plugin: JinnPlugin, input: CompleteSessionInput) {
  const completeSession = (plugin as JinnPlugin & {
    completeSession?: (value: CompleteSessionInput) => ReturnType<JinnPlugin['completeSession']>;
  }).completeSession;
  expect(completeSession).toBeTypeOf('function');
  if (!completeSession) return undefined;
  return completeSession(input);
}

describe('JinnPlugin.completeSession()', () => {
  it('augments an already-captured episode without changing captured identity or provenance', async () => {
    const episode = makeSampleEpisode({
      episodeId: 'episode-complete',
      session: { sessionId: 'session-original', capturedAt: '2026-07-15T11:59:00.000Z' },
      provenance: 'imported',
    });
    const original = structuredClone(episode);
    const evidence = new InMemoryEvidencePort();
    const contribution = new InMemoryContributionPort();

    const result = await invoke(pluginWith(evidence, contribution), {
      contractVersion: 1,
      episode,
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate(),
    });
    if (!result) return;

    expect(episode).toEqual(original);
    expect(result.episodeRef).toBe('episode-complete');
    expect(result.persistence.status).toBe('ok');
    expect(result.contribution?.status).toBe('ok');
    expect(result.contribution).toMatchObject({
      status: 'ok',
      value: {
        localState: 'recorded',
        publicationState: 'disabled',
        status: 'recorded',
      },
    });
    const stored = await evidence.get('episode-complete');
    expect(stored.status).toBe('ok');
    if (stored.status !== 'ok' || !stored.value) return;
    expect(stored.value.episodeId).toBe(original.episodeId);
    expect(stored.value.session).toEqual(original.session);
    expect(stored.value.trajectory).toEqual(original.trajectory);
    expect(stored.value.provenance).toBe(original.provenance);
    expect(stored.value.activity).toEqual(ACTIVITY);
    expect(stored.value.eligibility).toEqual(result.eligibility);

    if (result.contribution?.status === 'ok') {
      expect(contribution.getCandidate(result.contribution.value.recordId)).toEqual(candidate());
    }
  });

  it('persists evidence when contribution recording is unavailable', async () => {
    const evidence = new InMemoryEvidencePort();
    const contribution: ContributionPort = {
      async recordMineable() { return unavailable('contribution store offline'); },
      async ledger() { return unavailable('offline'); },
      async mintStatus() { return unavailable('offline'); },
      async authorize() { return unavailable('offline'); },
      async veto() { return unavailable('offline'); },
    };

    const result = await invoke(pluginWith(evidence, contribution), {
      contractVersion: 1,
      episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate(),
    });
    if (!result) return;

    expect(result.persistence.status).toBe('ok');
    expect(result.contribution).toEqual({
      status: 'unavailable',
      reason: 'contribution store offline',
    });
    expect((await evidence.get('episode-complete')).status).toBe('ok');
  });

  it('records the candidate when evidence persistence is unavailable', async () => {
    const contribution = new InMemoryContributionPort();
    const evidence: EvidencePort = {
      async put() { return unavailable('evidence store offline'); },
      async get() { return { status: 'ok', value: null }; },
      async list() { return { status: 'ok', value: [] }; },
      async retention() {
        return { status: 'ok', value: { policy: 'local-private', maxEpisodes: 200 } };
      },
    };

    const result = await invoke(pluginWith(evidence, contribution), {
      contractVersion: 1,
      episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate(),
    });
    if (!result) return;

    expect(result.persistence).toEqual({ status: 'unavailable', reason: 'evidence store offline' });
    expect(result.contribution?.status).toBe('ok');
    if (result.contribution?.status === 'ok') {
      expect(contribution.getCandidate(result.contribution.value.recordId)).toEqual(candidate());
    }
  });

  it('keeps a recorded candidate when its immediate status projection is unavailable', async () => {
    class StatusUnavailablePort extends InMemoryContributionPort {
      override async mintStatus() {
        return unavailable('sidecar status unavailable');
      }
    }
    const contribution = new StatusUnavailablePort();

    const result = await invoke(pluginWith(new InMemoryEvidencePort(), contribution), {
      contractVersion: 1,
      episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate(),
    });
    if (!result) return;

    expect(result.contribution).toEqual({
      status: 'degraded',
      reason: 'sidecar status unavailable',
      value: { recordId: 'record-1' },
    });
    expect(contribution.getCandidate('record-1')).toEqual(candidate());
  });

  it('rejects a cross-episode candidate attachment without losing the episode', async () => {
    const evidence = new InMemoryEvidencePort();
    const contribution = new InMemoryContributionPort();

    const result = await invoke(pluginWith(evidence, contribution), {
      contractVersion: 1,
      episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate({ sourceId: 'different-episode' }),
    });
    if (!result) return;

    expect(result.persistence.status).toBe('ok');
    expect(result.contribution).toEqual({
      status: 'unavailable',
      reason: 'contribution candidate sourceId must match episodeId',
    });
    expect((await contribution.ledger())).toEqual({ status: 'ok', value: [] });
    expect((await evidence.get('episode-complete')).status).toBe('ok');
  });

  it('records a candidate before applying a per-task veto', async () => {
    const evidence = new InMemoryEvidencePort();
    const contribution = new InMemoryContributionPort();

    const result = await invoke(pluginWith(evidence, contribution), {
      contractVersion: 1,
      episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate(),
      contributionVetoed: true,
    });
    if (!result) return;

    expect(result.persistence.status).toBe('ok');
    expect(result.contribution).toEqual({
      status: 'ok',
      value: {
        recordId: 'record-1',
        publicationState: 'vetoed',
        status: 'vetoed',
      },
    });
    expect(contribution.getCandidate('record-1')).toEqual(candidate());
    expect(await contribution.ledger()).toEqual({
      status: 'ok',
      value: [{
        recordId: 'record-1',
        sourceId: 'episode-complete',
        createdAt: '2026-07-15T12:01:00.000Z',
        verifiabilityTier: 'tests-passed',
        repositorySlug: 'Jinn-Network/mono',
        baseCommit: '0123456789abcdef',
        localState: 'recorded',
        publicationState: 'vetoed',
        status: 'vetoed',
      }],
    });
    expect((await evidence.get('episode-complete')).status).toBe('ok');
  });

  it('does not call veto when recording fails', async () => {
    let vetoCalls = 0;
    const contribution: ContributionPort = {
      async recordMineable() { return unavailable('record failed'); },
      async ledger() { return { status: 'ok', value: [] }; },
      async mintStatus() { return unavailable('missing'); },
      async authorize() { return unavailable('missing'); },
      async veto() {
        vetoCalls += 1;
        return unavailable('must not be called');
      },
    };

    const result = await invoke(pluginWith(new InMemoryEvidencePort(), contribution), {
      contractVersion: 1,
      episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate(),
      contributionVetoed: true,
    });
    if (!result) return;

    expect(result.contribution).toEqual({ status: 'unavailable', reason: 'record failed' });
    expect(vetoCalls).toBe(0);
  });

  it('persists a fail-closed veto atomically even when the follow-up veto call is unavailable', async () => {
    class VetoUnavailablePort extends InMemoryContributionPort {
      override async veto() {
        return unavailable('veto adapter unavailable');
      }
    }
    const contribution = new VetoUnavailablePort();
    const result = await invoke(pluginWith(new InMemoryEvidencePort(), contribution), {
      contractVersion: 1,
      episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
      activity: ACTIVITY,
      eligibilityInputs: { publicRepo: true, acceptedDiff: true },
      contributionCandidate: candidate({ publishMinedTasksConsent: true }),
      contributionVetoed: true,
    });
    if (!result) return;

    expect(result.contribution).toEqual({
      status: 'degraded',
      reason: 'veto adapter unavailable',
      value: { recordId: 'record-1' },
    });
    expect(await contribution.mintStatus('record-1')).toEqual({
      status: 'ok',
      value: {
        localState: 'recorded',
        publicationState: 'vetoed',
        status: 'vetoed',
      },
    });
  });

  it.each([
    ['omitted', {}],
    ['false', { contributionVetoed: false }],
  ] as const)('leaves the recorded contribution unchanged when veto is %s', async (_name, extra) => {
    const contribution = new InMemoryContributionPort();

    const result = await invoke(
      pluginWith(new InMemoryEvidencePort(), contribution),
      {
        contractVersion: 1,
        episode: makeSampleEpisode({ episodeId: 'episode-complete' }),
        activity: ACTIVITY,
        eligibilityInputs: { publicRepo: true, acceptedDiff: true },
        contributionCandidate: candidate(),
        ...extra,
      },
    );
    if (!result || result.contribution?.status !== 'ok') return;

    expect(await contribution.mintStatus(result.contribution.value.recordId)).toEqual({
      status: 'ok',
      value: {
        localState: 'recorded',
        publicationState: 'disabled',
        status: 'recorded',
      },
    });
  });
});
