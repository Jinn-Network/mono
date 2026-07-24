import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createContributionAdapter,
  createContributionStatusStore,
  createEvidenceAdapter,
} from '@jinn-network/jinn-layer';
import type { ContributionCandidateV1, EpisodeV1 } from '@jinn-network/plugin';
import {
  MineableTraceStore,
  buildMineableRecord,
  type MineableTraceRecord,
} from '../../src/solver-types/_swe-rebench-v2-mineable-store.js';

function record(overrides: Partial<MineableTraceRecord> = {}): MineableTraceRecord {
  return {
    sourceId: 'src-1',
    kind: 'solvernet-execution',
    repo: 'acme/widget',
    baseCommit: 'abc123',
    acceptedDiff: 'diff --git a/x b/x\n+1\n',
    testRuns: [{ cmd: 'pytest', exitCode: 0, at: '2026-07-01T00:00:00.000Z' }],
    intermediateFailureDiffs: ['diff --git a/x b/x\n-1\n'],
    skillEvents: [{ skill: 'systematic-debugging', action: 'invoked' }],
    sourceInstanceId: 'inst-1',
    publishMinedTasksConsent: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function candidateFromRecord(value: MineableTraceRecord): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId: value.sourceId,
    repositorySlug: value.repo,
    baseCommit: value.baseCommit,
    acceptedDiff: value.acceptedDiff,
    testRuns: value.testRuns.map((run) => ({ command: run.cmd, exitCode: run.exitCode, at: run.at })),
    intermediateFailureDiffs: value.intermediateFailureDiffs,
    skillEvents: value.skillEvents.map((event) => ({ skillRef: event.skill, action: event.action })),
    publishMinedTasksConsent: value.publishMinedTasksConsent,
    createdAt: value.createdAt,
  };
}

function episode(candidate: ContributionCandidateV1, instanceId?: string): EpisodeV1 {
  return {
    schemaVersion: 'jinn.episode.v1',
    episodeId: candidate.sourceId,
    retrievalVisible: false,
    session: { sessionId: candidate.sourceId, capturedAt: candidate.createdAt, kind: 'user' },
    origin: { writer: 'mineable-store-test', build: '1' },
    task: {
      summary: 'mineable store compatibility test',
      distributionTags: ['coding'],
      ...(instanceId ? { instanceId } : {}),
    },
    trajectory: [{
      spanId: 'span', parentSpanId: null, kind: 'jinn.agent_turn', name: 'turn:user',
      startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: {}, redactedKeys: [],
    }],
    environment: {
      harness: { name: 'mineable-store-test', version: '1' },
      model: 'test',
      tools: [],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'tests-passed' },
    cost: { durationMs: 1 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    contributionCandidate: candidate,
  };
}

async function persistCanonicalEpisode(
  episodesDir: string,
  value: MineableTraceRecord,
): Promise<void> {
  const result = await createEvidenceAdapter({ capturesDir: episodesDir }).put(
    episode(candidateFromRecord(value), value.sourceInstanceId),
  );
  expect(result.status).toBe('ok');
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mineable-trace-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('MineableTraceStore', () => {
  it('reads a canonical candidate written by the jinn-layer contribution adapter', async () => {
    await withTmpDir(async (dir) => {
      const episodesDir = join(dir, 'episodes');
      const evidence = createEvidenceAdapter({ capturesDir: episodesDir });
      const candidate = candidateFromRecord(record({
        sourceId: 'adapter-source',
        kind: 'harness-session',
        sourceInstanceId: undefined,
        acceptedDiff: 'diff --git a/x b/x\n+adapter\n',
        intermediateFailureDiffs: ['diff --git a/x b/x\n-adapter\n'],
      }));
      expect((await evidence.put(episode(candidate))).status).toBe('ok');
      const statusStore = createContributionStatusStore(join(dir, 'mineable-traces.json'));
      const adapter = createContributionAdapter({ statusStore, evidence });
      const result = await adapter.recordMineable(candidate);
      expect(result.status).toBe('ok');

      const daemonReader = new MineableTraceStore({ stateDir: dir, episodesDir });
      expect(await daemonReader.listUnmined()).toEqual([{
        sourceId: 'adapter-source',
        kind: 'harness-session',
        repo: 'acme/widget',
        baseCommit: 'abc123',
        acceptedDiff: 'diff --git a/x b/x\n+adapter\n',
        testRuns: [{ cmd: 'pytest', exitCode: 0, at: '2026-07-01T00:00:00.000Z' }],
        intermediateFailureDiffs: ['diff --git a/x b/x\n-adapter\n'],
        skillEvents: [{ skill: 'systematic-debugging', action: 'invoked' }],
        publishMinedTasksConsent: false,
        createdAt: '2026-07-01T00:00:00.000Z',
      }]);
    });
  });

  it('registers an existing canonical episode in the local reference queue', async () => {
    await withTmpDir(async (dir) => {
      const episodesDir = join(dir, 'episodes');
      const store = new MineableTraceStore({ stateDir: dir, episodesDir });
      const r = record();
      await persistCanonicalEpisode(episodesDir, r);
      await store.append(r);
      const [got] = await store.listUnmined();
      expect(got).toEqual({ ...r, kind: 'harness-session' });
      expect(existsSync(join(dir, 'mineable-traces.json'))).toBe(true);
      const raw = await readFile(join(dir, 'mineable-traces.json'), 'utf8');
      expect(JSON.parse(raw).schemaVersion).toBe('jinn.contribution-store.v3');
      expect(raw).not.toContain('candidate');
      expect(raw).not.toContain('localMetadata');
    });
  });

  it('round-trips all five contract fields', async () => {
    await withTmpDir(async (dir) => {
      const episodesDir = join(dir, 'episodes');
      const store = new MineableTraceStore({ stateDir: dir, episodesDir });
      const r = record();
      await persistCanonicalEpisode(episodesDir, r);
      await store.append(r);
      const [got] = await store.listUnmined();
      expect(got).toEqual({ ...r, kind: 'harness-session' });
    });
  });

  it('markMined removes from the unmined list but keeps the record on disk', async () => {
    await withTmpDir(async (dir) => {
      const episodesDir = join(dir, 'episodes');
      const store = new MineableTraceStore({ stateDir: dir, episodesDir });
      const r = record({ sourceId: 's1' });
      await persistCanonicalEpisode(episodesDir, r);
      await store.append(r);
      await store.markMined('s1');
      expect(await store.listUnmined()).toEqual([]);
    });
  });
});

describe('buildMineableRecord', () => {
  it('fills optional contract fields with empty defaults and stamps createdAt from now()', () => {
    const got = buildMineableRecord({
      sourceId: 'req-1',
      kind: 'solvernet-execution',
      repo: 'acme/widget',
      baseCommit: 'a'.repeat(40),
      acceptedDiff: 'diff --git a/x b/x\n+1\n',
      publishMinedTasksConsent: false,
      now: () => '2026-07-13T00:00:00.000Z',
    });
    expect(got).toEqual({
      sourceId: 'req-1',
      kind: 'solvernet-execution',
      repo: 'acme/widget',
      baseCommit: 'a'.repeat(40),
      acceptedDiff: 'diff --git a/x b/x\n+1\n',
      testRuns: [],
      intermediateFailureDiffs: [],
      skillEvents: [],
      publishMinedTasksConsent: false,
      createdAt: '2026-07-13T00:00:00.000Z',
    });
    expect(got.sourceInstanceId).toBeUndefined();
  });

  it('carries through explicit optional fields, including sourceInstanceId', () => {
    const got = buildMineableRecord({
      sourceId: 'req-2',
      kind: 'solvernet-execution',
      repo: 'acme/widget',
      baseCommit: 'b'.repeat(40),
      acceptedDiff: 'diff --git a/y b/y\n+2\n',
      testRuns: [{ cmd: 'pytest', exitCode: 0, at: '2026-07-01T00:00:00.000Z' }],
      intermediateFailureDiffs: ['diff --git a/y b/y\n-2\n'],
      skillEvents: [{ skill: 'systematic-debugging', action: 'invoked' }],
      sourceInstanceId: 'org__widget-1',
      publishMinedTasksConsent: true,
      now: () => '2026-07-13T00:00:00.000Z',
    });
    expect(got.sourceInstanceId).toBe('org__widget-1');
    expect(got.testRuns).toEqual([{ cmd: 'pytest', exitCode: 0, at: '2026-07-01T00:00:00.000Z' }]);
    expect(got.intermediateFailureDiffs).toEqual(['diff --git a/y b/y\n-2\n']);
    expect(got.skillEvents).toEqual([{ skill: 'systematic-debugging', action: 'invoked' }]);
    expect(got.publishMinedTasksConsent).toBe(true);
  });
});
