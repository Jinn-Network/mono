import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { RETRIEVAL_VISIBLE_TAG } from '@jinn-network/plugin';
import {
  auditCuratedSeedBatch,
  type CuratedSeedBatchAudit,
} from '../src/seed-import/curated-batch.js';
import {
  createLocalEpisodeSeedSource,
  type SeedEpisode,
} from '../src/seed-import/episode-fetch.js';

const REPO = 'Jinn-Network/mono';
const FIXTURES_DIR = fileURLToPath(
  new URL('../fixtures/stage1-seeds', import.meta.url),
);

function episode(index: number, overrides: Partial<SeedEpisode> = {}): SeedEpisode {
  const sourceSha = String(index).padStart(40, String(index));
  return {
    id: `mono-curated-${index}`,
    repo: REPO,
    baseCommit: String(index + 3).padStart(40, String(index + 3)),
    taskSummary: `Fix mono regression ${index} with a directly verified scoped test`,
    tags: ['mono', `regression-${index}`, RETRIEVAL_VISIBLE_TAG],
    steps: [
      {
        label: 'failure',
        title: 'reproduce the failure',
        text: `$ yarn test test/mono-${index}.test.ts\nFAIL mono-${index}`,
      },
      {
        label: 'note',
        title: 'diagnose the failure',
        text: 'The failing assertion observes state before the operation settles.',
      },
      {
        label: 'fix',
        title: 'apply the bounded fix',
        text: 'Wait on the operation that owns the state transition.',
      },
      {
        label: 'command',
        title: 'rerun the scoped test',
        text: `$ yarn test test/mono-${index}.test.ts\nPASS mono-${index}`,
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis:
      'The assertion raced the operation that owned the state transition. ' +
      'Waiting on that operation fixed the regression. ' +
      'The scoped test now covers the failure and the corrected behavior.',
    attribution: {
      origin: 'operator-recorded-session',
      sourceUrl: `https://github.com/Jinn-Network/mono/commit/${sourceSha}`,
    },
    ...overrides,
  };
}

function expectOfflineBoundary(report: CuratedSeedBatchAudit): void {
  expect(report.humanCurationRequired).toBe(true);
  expect(report.publishAuthorized).toBe(false);
  expect(report.liveProbe).toEqual({
    status: 'not-run',
    command: 'jinn-layer corpus probe "Jinn-Network/mono" --json',
  });
}

describe('auditCuratedSeedBatch', () => {
  it('passes exactly K mechanically valid, distinct mono records without authorizing curation or publication', async () => {
    const report = await auditCuratedSeedBatch({
      repoSlug: REPO,
      episodes: [episode(1), episode(2), episode(3)],
    });

    expect(report).toMatchObject({
      schemaVersion: 'jinn.curated-seed-audit.v1',
      repoSlug: REPO,
      probeTerms: ['mono'],
      requiredRecords: 3,
      recordCount: 3,
      eligibleRecordCount: 3,
      automatedStatus: 'pass',
      errors: [],
    });
    expect(report.records.map((record) => record.automatedStatus)).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
    expectOfflineBoundary(report);
  });

  it('fails honestly below K and never turns an offline fixture into a live-green claim', async () => {
    const report = await auditCuratedSeedBatch({
      repoSlug: REPO,
      episodes: [episode(1), episode(2)],
    });

    expect(report.automatedStatus).toBe('fail');
    expect(report.eligibleRecordCount).toBe(2);
    expect(report.errors).toContain('need at least 3 mechanically eligible records; found 2');
    expectOfflineBoundary(report);
  });

  it('fails the whole candidate batch when an extra record is invalid even if K valid records remain', async () => {
    const report = await auditCuratedSeedBatch({
      repoSlug: REPO,
      episodes: [
        episode(1),
        episode(2),
        episode(3),
        episode(4, { tags: ['mono', 'unmarked'] }),
      ],
    });

    expect(report.eligibleRecordCount).toBe(3);
    expect(report.automatedStatus).toBe('fail');
    expect(report.errors).toContain('1 record failed automated checks');
    expectOfflineBoundary(report);
  });

  it.each([
    [
      'missing retrieval mark',
      episode(1, { tags: ['mono', 'regression'] }),
      'missing retrieval visibility mark',
    ],
    [
      'wrong repository',
      episode(1, { repo: 'other/repo' }),
      'repo must be Jinn-Network/mono',
    ],
    [
      'missing shared probe vocabulary',
      episode(1, { tags: ['dashboard', RETRIEVAL_VISIBLE_TAG] }),
      'tags must include a shared probe term: mono',
    ],
    [
      'weak verification',
      episode(1, {
        outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
      }),
      'outcome must be completed and tests-passed or evaluator-verified',
    ],
    [
      'missing evidence command',
      episode(1, {
        steps: episode(1).steps.filter((step) => step.label !== 'command'),
      }),
      'steps must include failure, fix, and command evidence',
    ],
    [
      'non-commit provenance',
      episode(1, {
        attribution: {
          origin: 'operator-recorded-session',
          sourceUrl: 'https://github.com/Jinn-Network/mono/pull/123',
        },
      }),
      'sourceUrl must name a full Jinn-Network/mono commit',
    ],
  ])('rejects %s', async (_label, invalid, expectedError) => {
    const report = await auditCuratedSeedBatch({
      repoSlug: REPO,
      episodes: [invalid, episode(2), episode(3)],
    });

    expect(report.automatedStatus).toBe('fail');
    expect(report.records[0]?.errors).toContain(expectedError);
    expect(report.eligibleRecordCount).toBe(2);
    expectOfflineBoundary(report);
  });

  it('rejects duplicate evidence identities and source commits', async () => {
    const first = episode(1);
    const report = await auditCuratedSeedBatch({
      repoSlug: REPO,
      episodes: [
        first,
        episode(2, {
          id: first.id,
          attribution: { ...episode(2).attribution, sourceUrl: first.attribution.sourceUrl },
        }),
        episode(3),
      ],
    });

    expect(report.automatedStatus).toBe('fail');
    expect(report.records[1]?.errors).toEqual(
      expect.arrayContaining([
        `duplicate episode id: ${first.id}`,
        `duplicate sourceUrl: ${first.attribution.sourceUrl}`,
      ]),
    );
    expect(report.eligibleRecordCount).toBe(2);
  });

  it('runs the seed scrub preflight and fails closed on a secret', async () => {
    const report = await auditCuratedSeedBatch({
      repoSlug: REPO,
      episodes: [
        episode(1, {
          steps: [
            ...episode(1).steps,
            {
              label: 'note',
              title: 'unsafe fixture',
              text: 'token is ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012',
            },
          ],
        }),
        episode(2),
        episode(3),
      ],
    });

    expect(report.automatedStatus).toBe('fail');
    expect(report.records[0]?.errors.join('\n')).toMatch(/seed scrub rejected content/);
    expect(report.eligibleRecordCount).toBe(2);
  });

  it('reports the checked-in Stage 1 fixtures as the real one-of-three starting point, not a completed B3 batch', async () => {
    const source = createLocalEpisodeSeedSource(FIXTURES_DIR);
    const report = await auditCuratedSeedBatch({
      repoSlug: REPO,
      episodes: await source.list(),
    });

    expect(report.automatedStatus).toBe('fail');
    expect(report.recordCount).toBe(3);
    expect(report.eligibleRecordCount).toBe(1);
    expect(report.records.find((record) => record.id === 'source-dashboard-flake'))
      .toMatchObject({ automatedStatus: 'pass', errors: [] });
    expect(report.errors).toContain('need at least 3 mechanically eligible records; found 1');
    expectOfflineBoundary(report);
  });
});
