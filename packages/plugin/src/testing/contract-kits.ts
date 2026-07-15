import { describe, expect, it } from 'vitest';
import type { ContributionPort } from '../ports/contribution-port.js';
import type { CorpusPort } from '../ports/corpus-port.js';
import type { EvidencePort } from '../ports/evidence-port.js';
import type { LocalLearningPort } from '../ports/local-learning-port.js';
import type { SkillsPort } from '../ports/skills-port.js';
import type { EpisodeV1 } from '../schemas/episode.js';
import type { ContributionCandidateV1 } from '../schemas/contribution-candidate.js';

function contributionCandidate(
  overrides: Partial<ContributionCandidateV1> = {},
): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId: 'episode-1',
    repositorySlug: 'Jinn-Network/mono',
    baseCommit: '0123456789abcdef',
    acceptedDiff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: false,
    createdAt: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

export function describeCorpusPortContract(makeAdapter: () => CorpusPort): void {
  describe('CorpusPort contract', () => {
    it('search() returns an ok PortResult with an array value', async () => {
      const adapter = makeAdapter();
      const result = await adapter.search('anything');
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(Array.isArray(result.value)).toBe(true);
    });

    it('get() on an unknown ref returns ok(null)', async () => {
      const adapter = makeAdapter();
      const result = await adapter.get('does-not-exist');
      expect(result).toEqual({ status: 'ok', value: null });
    });
  });
}

export function describeEvidencePortContract(
  makeAdapter: () => EvidencePort,
  sampleEpisode: EpisodeV1,
): void {
  describe('EvidencePort contract', () => {
    it('put() then get() round-trips the episode', async () => {
      const adapter = makeAdapter();
      const putResult = await adapter.put(sampleEpisode);
      expect(putResult.status).toBe('ok');
      const getResult = await adapter.get(sampleEpisode.episodeId);
      expect(getResult).toEqual({ status: 'ok', value: sampleEpisode });
    });

    it('list() includes a put episode', async () => {
      const adapter = makeAdapter();
      await adapter.put(sampleEpisode);
      const listResult = await adapter.list();
      expect(listResult.status).toBe('ok');
      if (listResult.status === 'ok') {
        expect(listResult.value.map((e) => e.episodeId)).toContain(sampleEpisode.episodeId);
      }
    });

    it('retention() returns a policy result', async () => {
      const adapter = makeAdapter();
      const result = await adapter.retention();
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(['local-private', 'contribution-eligible']).toContain(result.value.policy);
      }
    });
  });
}

export function describeContributionPortContract(makeAdapter: () => ContributionPort): void {
  describe('ContributionPort contract', () => {
    it('records a candidate locally even when publication consent is disabled', async () => {
      const adapter = makeAdapter();
      const recordResult = await adapter.recordMineable(contributionCandidate());
      expect(recordResult.status).toBe('ok');
      if (recordResult.status !== 'ok') return;
      const statusResult = await adapter.mintStatus(recordResult.value.recordId);
      expect(statusResult).toEqual({
        status: 'ok',
        value: {
          localState: 'recorded',
          publicationState: 'disabled',
          status: 'recorded',
        },
      });

      const ledgerResult = await adapter.ledger();
      expect(ledgerResult.status).toBe('ok');
      if (ledgerResult.status === 'ok') {
        expect(ledgerResult.value).toContainEqual({
          recordId: recordResult.value.recordId,
          sourceId: 'episode-1',
          repositorySlug: 'Jinn-Network/mono',
          baseCommit: '0123456789abcdef',
          localState: 'recorded',
          publicationState: 'disabled',
          status: 'recorded',
        });
      }
    });

    it('requires preview authorization before a consented candidate is queued', async () => {
      const adapter = makeAdapter();
      const recordResult = await adapter.recordMineable(contributionCandidate({
        publishMinedTasksConsent: true,
      }));
      if (recordResult.status !== 'ok') throw new Error('recordMineable failed');
      expect(await adapter.mintStatus(recordResult.value.recordId)).toEqual({
        status: 'ok',
        value: {
          localState: 'recorded',
          publicationState: 'preview-required',
          status: 'preview-required',
        },
      });

      const authorizeResult = await adapter.authorize(recordResult.value.recordId);
      expect(authorizeResult).toEqual({
        status: 'ok',
        value: { recordId: recordResult.value.recordId, publicationState: 'queued', status: 'queued' },
      });
    });

    it('veto() changes only publication state and preserves the local record', async () => {
      const adapter = makeAdapter();
      const recordResult = await adapter.recordMineable(contributionCandidate({
        publishMinedTasksConsent: true,
      }));
      if (recordResult.status !== 'ok') throw new Error('recordMineable failed');
      const vetoResult = await adapter.veto(recordResult.value.recordId);
      expect(vetoResult).toEqual({
        status: 'ok',
        value: { recordId: recordResult.value.recordId, publicationState: 'vetoed', status: 'vetoed' },
      });
      const statusResult = await adapter.mintStatus(recordResult.value.recordId);
      expect(statusResult).toEqual({
        status: 'ok',
        value: { localState: 'recorded', publicationState: 'vetoed', status: 'vetoed' },
      });
    });

    it('ledger() lists recorded entries', async () => {
      const adapter = makeAdapter();
      await adapter.recordMineable(contributionCandidate());
      const ledgerResult = await adapter.ledger();
      expect(ledgerResult.status).toBe('ok');
      if (ledgerResult.status === 'ok') expect(ledgerResult.value.length).toBeGreaterThan(0);
    });
  });
}

export function describeLocalLearningPortContract(makeAdapter: () => LocalLearningPort): void {
  describe('LocalLearningPort contract', () => {
    it('run() then status() reports the run', async () => {
      const adapter = makeAdapter();
      const runResult = await adapter.run({ episodeIds: ['episode-1'] });
      expect(runResult.status).toBe('ok');
      if (runResult.status !== 'ok') return;
      const statusResult = await adapter.status(runResult.value.runId);
      expect(statusResult.status).toBe('ok');
    });

    it('list() includes a started run', async () => {
      const adapter = makeAdapter();
      const runResult = await adapter.run({ episodeIds: [] });
      if (runResult.status !== 'ok') throw new Error('run failed');
      const listResult = await adapter.list();
      expect(listResult.status).toBe('ok');
      if (listResult.status === 'ok') {
        expect(listResult.value.map((r) => r.runId)).toContain(runResult.value.runId);
      }
    });
  });
}

export function describeSkillsPortContract(makeAdapter: () => SkillsPort): void {
  describe('SkillsPort contract', () => {
    it('install() then list() includes the skill', async () => {
      const adapter = makeAdapter();
      const installResult = await adapter.install('org/skill@1.0.0');
      expect(installResult.status).toBe('ok');
      const listResult = await adapter.list();
      expect(listResult.status).toBe('ok');
      if (listResult.status === 'ok') {
        expect(listResult.value.map((s) => s.ref)).toContain('org/skill@1.0.0');
      }
    });

    it('uninstall() removes the skill', async () => {
      const adapter = makeAdapter();
      await adapter.install('org/skill@1.0.0');
      await adapter.uninstall('org/skill@1.0.0');
      const listResult = await adapter.list();
      expect(listResult.status).toBe('ok');
      if (listResult.status === 'ok') {
        expect(listResult.value.map((s) => s.ref)).not.toContain('org/skill@1.0.0');
      }
    });
  });
}
