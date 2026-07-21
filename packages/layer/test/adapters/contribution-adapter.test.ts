import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeContributionPortContract } from '@jinn-network/plugin/testing';
import { ok, type ContributionCandidateV1, type EpisodeV1 } from '@jinn-network/plugin';
import {
  createContributionAdapter,
  createContributionStatusStore,
} from '../../src/adapters/contribution-adapter.js';

function tmpStatusFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'contrib-adapter-')), 'status.json');
}

function episode(candidate: ContributionCandidateV1): EpisodeV1 {
  return {
    schemaVersion: 'jinn.episode.v1',
    episodeId: candidate.sourceId,
    retrievalVisible: false,
    session: { sessionId: candidate.sourceId, capturedAt: candidate.createdAt, kind: 'user' },
    origin: { writer: 'adapter-test', build: '1' },
    task: { summary: 'adapter test', distributionTags: ['coding'] },
    trajectory: [{
      spanId: 'span', parentSpanId: null, kind: 'jinn.agent_turn', name: 'turn:user',
      startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: {}, redactedKeys: [],
    }],
    environment: {
      harness: { name: 'adapter-test', version: '1' }, model: 'test', tools: [], skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'tests-passed' },
    cost: { durationMs: 1 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    contributionCandidate: candidate,
  };
}

function makeAdapter(candidate?: ContributionCandidateV1) {
  return createContributionAdapter({
    statusStore: createContributionStatusStore(tmpStatusFile()),
    evidence: {
      async get(id) {
        return ok(candidate && id === candidate.sourceId ? episode(candidate) : null);
      },
    },
  });
}

function candidate(sourceId = 'episode-1', acceptedDiff = 'diff --git a/a b/a\n+fixed\n'): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId,
    repositorySlug: 'Jinn-Network/mono',
    baseCommit: 'abc123',
    acceptedDiff,
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: false,
    createdAt: '2026-07-15T12:00:00.000Z',
  };
}

describeContributionPortContract(makeAdapter);

describe('ContributionAdapter — unknown record', () => {
  it('mintStatus on an unknown recordId is unavailable', async () => {
    const adapter = makeAdapter();
    const result = await adapter.mintStatus('nope');
    expect(result.status).toBe('unavailable');
  });

  it('recordMineable refuses to create a dangling reference without its episode', async () => {
    const adapter = makeAdapter();
    const result = await adapter.recordMineable({
      schemaVersion: 'jinn.contribution-candidate.v1',
      sourceId: 'missing-episode',
      repositorySlug: 'Jinn-Network/mono',
      baseCommit: 'abc123',
      acceptedDiff: 'diff --git a/a b/a\n+fixed\n',
      testRuns: [],
      intermediateFailureDiffs: [],
      skillEvents: [],
      publishMinedTasksConsent: false,
      createdAt: '2026-07-15T12:00:00.000Z',
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'canonical contribution episode is unavailable: missing-episode',
    });
  });

  it('recordMineable refuses a candidate that differs from the canonical episode payload', async () => {
    const adapter = makeAdapter(candidate('episode-mismatch', 'canonical diff'));

    const result = await adapter.recordMineable(candidate('episode-mismatch', 'different diff'));

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'canonical contribution candidate mismatch: episode-mismatch',
    });
  });

  it('returns an honest degraded ledger row for a migrated reference whose episode is absent', async () => {
    const statusStore = createContributionStatusStore(tmpStatusFile());
    await statusStore.recordReference('pruned-episode');
    const adapter = createContributionAdapter({
      statusStore,
      evidence: { async get() { return ok(null); } },
    });

    const result = await adapter.ledger();

    expect(result).toEqual({
      status: 'degraded',
      reason: 'unresolved canonical episode: pruned-episode',
      value: [{
        recordId: 'pruned-episode',
        sourceId: 'pruned-episode',
        localState: 'recorded',
        publicationState: 'disabled',
        status: 'recorded',
      }],
    });
  });

  it('veto on an unknown recordId is unavailable', async () => {
    const adapter = makeAdapter();
    const result = await adapter.veto('nope');
    expect(result.status).toBe('unavailable');
  });
});
