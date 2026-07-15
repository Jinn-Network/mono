import { describeContributionPortContract } from '../../src/testing/contract-kits.js';
import { InMemoryContributionPort } from '../../src/testing/in-memory-contribution.js';
import * as contribution from '../../src/ports/contribution-port.js';
import { createJinnPlugin } from '../../src/plugin.js';
import {
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../../src/testing.js';
import { describe, expect, it } from 'vitest';

describeContributionPortContract(() => new InMemoryContributionPort());

describe('contribution state projection', () => {
  it.each([
    ['recorded', 'disabled', 'recorded'],
    ['minted', 'disabled', 'minted'],
    ['rejected', 'disabled', 'rejected'],
    ['recorded', 'preview-required', 'preview-required'],
    ['minted', 'queued', 'queued'],
    ['minted', 'published', 'published'],
    ['recorded', 'vetoed', 'vetoed'],
  ] as const)('derives %s / %s as %s', (localState, publicationState, expected) => {
    const derive = (contribution as typeof contribution & {
      deriveContributionStatus?: (value: {
        localState: string;
        publicationState: string;
      }) => string;
    }).deriveContributionStatus;
    expect(derive).toBeDefined();
    if (!derive) return;
    expect(derive({ localState, publicationState })).toBe(expected);
  });
});

describe('InMemoryContributionPort forward states', () => {
  it('surfaces optional mint and publication refs without changing source identity', async () => {
    const adapter = new InMemoryContributionPort();
    const recorded = await adapter.recordMineable({
      schemaVersion: 'jinn.contribution-candidate.v1',
      sourceId: 'episode-forward',
      repositorySlug: 'Jinn-Network/mono',
      baseCommit: '0123456789abcdef',
      acceptedDiff: 'diff --git a/a b/a\n+fixed\n',
      testRuns: [],
      intermediateFailureDiffs: [],
      skillEvents: [],
      publishMinedTasksConsent: true,
      createdAt: '2026-07-15T12:00:00.000Z',
    });
    if (recorded.status !== 'ok') throw new Error('recording failed');

    expect(adapter.markMinted).toBeDefined();
    expect(adapter.markPublished).toBeDefined();
    if (!adapter.markMinted || !adapter.markPublished) return;

    adapter.markMinted(recorded.value.recordId, 'mint-1');
    adapter.markPublished(recorded.value.recordId, 'publication-1');

    const ledger = await adapter.ledger();
    expect(ledger).toEqual({
      status: 'ok',
      value: [{
        recordId: recorded.value.recordId,
        sourceId: 'episode-forward',
        repositorySlug: 'Jinn-Network/mono',
        baseCommit: '0123456789abcdef',
        localState: 'minted',
        publicationState: 'published',
        mintRef: 'mint-1',
        publicationRef: 'publication-1',
        status: 'published',
      }],
    });
  });

  it('exposes only sanitized repository facts for first-preview acknowledgement', async () => {
    const adapter = new InMemoryContributionPort();
    await adapter.recordMineable({
      schemaVersion: 'jinn.contribution-candidate.v1',
      sourceId: 'episode-preview',
      repositorySlug: 'Jinn-Network/mono',
      baseCommit: '0123456789abcdef',
      acceptedDiff: 'SECRET_ACCEPTED_DIFF_GOLD',
      testRuns: [],
      intermediateFailureDiffs: ['SECRET_FAILURE'],
      skillEvents: [{ skillRef: 'SECRET_SKILL', action: 'loaded' }],
      publishMinedTasksConsent: true,
      createdAt: '2026-07-15T12:00:00.000Z',
    });
    const plugin = createJinnPlugin({
      corpus: new InMemoryCorpusPort([]),
      evidence: new InMemoryEvidencePort(),
      contribution: adapter,
      localLearning: new InMemoryLocalLearningPort(),
      skills: new InMemorySkillsPort(),
    });

    const preview = await plugin.previewContribution(true);

    expect(preview).toEqual({
      status: 'ok',
      value: {
        recordId: 'record-1',
        repositorySlug: 'Jinn-Network/mono',
        baseCommit: '0123456789abcdef',
        localState: 'recorded',
        publicationState: 'queued',
        status: 'queued',
        acknowledged: true,
      },
    });
    expect(JSON.stringify(preview)).not.toMatch(/SECRET|acceptedDiff|failure|skill/i);
  });
});
