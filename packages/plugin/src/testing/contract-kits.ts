import { describe, expect, it } from 'vitest';
import type { ContributionPort } from '../ports/contribution-port.js';
import type { CorpusPort } from '../ports/corpus-port.js';
import type { EvidencePort } from '../ports/evidence-port.js';
import type { LocalLearningPort } from '../ports/local-learning-port.js';
import type { SkillsPort } from '../ports/skills-port.js';
import type { EpisodeV1 } from '../schemas/episode.js';

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
    it('recordMineable() then mintStatus() reports queued', async () => {
      const adapter = makeAdapter();
      const recordResult = await adapter.recordMineable('episode-1');
      expect(recordResult.status).toBe('ok');
      if (recordResult.status !== 'ok') return;
      const statusResult = await adapter.mintStatus(recordResult.value.recordId);
      expect(statusResult).toEqual({ status: 'ok', value: { status: 'queued' } });
    });

    it('veto() transitions status to vetoed', async () => {
      const adapter = makeAdapter();
      const recordResult = await adapter.recordMineable('episode-1');
      if (recordResult.status !== 'ok') throw new Error('recordMineable failed');
      const vetoResult = await adapter.veto(recordResult.value.recordId);
      expect(vetoResult.status).toBe('ok');
      const statusResult = await adapter.mintStatus(recordResult.value.recordId);
      expect(statusResult).toEqual({ status: 'ok', value: { status: 'vetoed' } });
    });

    it('ledger() lists recorded entries', async () => {
      const adapter = makeAdapter();
      await adapter.recordMineable('episode-1');
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
