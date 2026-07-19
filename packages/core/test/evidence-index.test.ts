import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EvidenceIndex,
  reindexEvidenceStore,
  type ReindexReport,
} from '../src/evidence-index.js';
import { EPISODE_SCHEMA_VERSION, EpisodeV1Schema, type EpisodeV1 } from '@jinn-network/plugin';

const tempDirs: string[] = [];

function makeStore(): { root: string; episodesDir: string; indexPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'jinn-evidence-index-'));
  tempDirs.push(root);
  const episodesDir = join(root, 'episodes');
  mkdirSync(episodesDir);
  return {
    root,
    episodesDir,
    indexPath: join(root, 'evidence-index.sqlite'),
  };
}

function makeEpisode(id: string, capturedAt = '2026-07-19T00:00:00.000Z'): EpisodeV1 {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: id,
    session: { sessionId: `session-${id}`, capturedAt },
    task: { summary: `Task ${id}`, distributionTags: ['coding'] },
    trajectory: [{
      spanId: `span-${id}`,
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '2000000000',
      attributes: { role: 'user' },
      redactedKeys: [],
    }],
    environment: {
      harness: { name: 'hermes', version: '1.0.0' },
      model: 'test-model',
      tools: ['bash'],
      skillsLoadout: [],
    },
    outcome: {
      status: 'completed',
      verifiabilityTier: 'tests-passed',
      summary: 'complete',
    },
    cost: {
      durationMs: 1_000,
      tokens: { input: 12, output: 3 },
      usdEstimate: '0.01',
    },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    lineage: { episodeId: id, mintRef: 'mint-1' },
    activity: {
      searchedTerms: ['sqlite'],
      providedRefs: ['record-1'],
      surfacedRefs: [],
      fetchedRefs: [],
      installedSkillRefs: [],
    },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runReindex(
  episodesDir: string,
  indexPath: string,
  repair: boolean,
): ReindexReport {
  return reindexEvidenceStore({ episodesDir, indexPath, repair });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('machine-local evidence index', () => {
  it('uses SQLite WAL and is a derived view rebuilt only from canonical files', () => {
    const { episodesDir, indexPath } = makeStore();
    writeJson(join(episodesDir, 'first.episode.json'), makeEpisode('first'));
    writeJson(
      join(episodesDir, 'second.episode.json'),
      makeEpisode('second', '2026-07-20T00:00:00.000Z'),
    );

    const first = runReindex(episodesDir, indexPath, false);
    expect(first).toMatchObject({
      scannedFiles: 2,
      indexedEpisodes: 2,
      unreadableFiles: 0,
      legacyUnstampedFiles: 2,
    });

    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.journalMode()).toBe('wal');
    expect(index.listEpisodes().map((row) => row.episodeId)).toEqual(['first', 'second']);
    expect(index.listEpisodes()[0]).toMatchObject({
      sourceKind: 'canonical-episode',
      originKind: 'legacy-unstamped',
      outcomeStatus: 'completed',
    });
    expect(index.listUnreadable()).toEqual([]);
    index.close();

    rmSync(join(episodesDir, 'first.episode.json'));
    const rebuilt = runReindex(episodesDir, indexPath, false);
    expect(rebuilt.indexedEpisodes).toBe(1);
    const rebuiltIndex = new EvidenceIndex({ dbPath: indexPath });
    expect(rebuiltIndex.listEpisodes().map((row) => row.episodeId)).toEqual(['second']);
    rebuiltIndex.close();
  });

  it('repairs the null quartet, rescues misnamed episodes, tags unstamped files, and surfaces unreadable counts', () => {
    const { episodesDir, indexPath } = makeStore();
    const nullQuartet = structuredClone(makeEpisode('rescued'));
    const raw = nullQuartet as unknown as {
      outcome: { summary: string | null };
      cost: { tokens: unknown; usdEstimate: string | null };
      lineage: unknown;
    };
    raw.outcome.summary = null;
    raw.cost.tokens = null;
    raw.cost.usdEstimate = null;
    raw.lineage = null;
    const misnamedPath = join(episodesDir, 'rescued.json');
    writeJson(misnamedPath, raw);
    writeFileSync(join(episodesDir, 'broken.episode.json'), '{not json');

    const report = runReindex(episodesDir, indexPath, true);

    expect(report).toMatchObject({
      scannedFiles: 2,
      indexedEpisodes: 1,
      unreadableFiles: 1,
      nullToleratedFiles: 1,
      nullFieldsRemoved: 4,
      misnamedEpisodes: 1,
      renamedFiles: 1,
      legacyUnstampedFiles: 1,
    });
    expect(report.unreadable).toHaveLength(1);
    expect(report.unreadable[0]?.path).toBe(join(episodesDir, 'broken.episode.json'));
    expect(report.unreadable[0]?.reason).toMatch(/JSON|parse|Unexpected/i);

    const canonicalPath = join(episodesDir, 'rescued.episode.json');
    expect(existsSync(misnamedPath)).toBe(false);
    expect(existsSync(canonicalPath)).toBe(true);
    const repaired = JSON.parse(readFileSync(canonicalPath, 'utf8'));
    expect(() => EpisodeV1Schema.parse(repaired)).not.toThrow();
    expect(repaired.outcome).not.toHaveProperty('summary');
    expect(repaired.cost).not.toHaveProperty('tokens');
    expect(repaired.cost).not.toHaveProperty('usdEstimate');
    expect(repaired).not.toHaveProperty('lineage');
    expect(repaired.trajectory[0].parentSpanId).toBeNull();

    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.listEpisodes()).toHaveLength(1);
    expect(index.listEpisodes()[0]).toMatchObject({
      episodeId: 'rescued',
      sourcePath: canonicalPath,
      sourceKind: 'canonical-episode',
      originKind: 'legacy-unstamped',
    });
    expect(index.listUnreadable()).toEqual([{
      sourcePath: join(episodesDir, 'broken.episode.json'),
      reason: expect.stringMatching(/JSON|parse|Unexpected/i),
    }]);
    index.close();
  });

  it('indexes tolerantly without mutating files when repair is disabled', () => {
    const { episodesDir, indexPath } = makeStore();
    const raw = structuredClone(makeEpisode('tolerated')) as unknown as {
      outcome: { summary: string | null };
    };
    raw.outcome.summary = null;
    const path = join(episodesDir, 'tolerated.json');
    writeJson(path, raw);
    const before = readFileSync(path, 'utf8');

    const report = runReindex(episodesDir, indexPath, false);

    expect(report).toMatchObject({
      indexedEpisodes: 1,
      nullToleratedFiles: 1,
      nullFieldsRemoved: 0,
      misnamedEpisodes: 1,
      renamedFiles: 0,
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(episodesDir, 'tolerated.episode.json'))).toBe(false);
    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.listEpisodes()[0]?.sourceKind).toBe('misnamed-episode');
    index.close();
  });

  it('rebuilds deterministically and a second repair is a no-op', () => {
    const { episodesDir, indexPath } = makeStore();
    writeJson(join(episodesDir, 'stable.json'), makeEpisode('stable'));

    const first = runReindex(episodesDir, indexPath, true);
    const firstIndex = new EvidenceIndex({ dbPath: indexPath });
    const firstRows = firstIndex.listEpisodes();
    firstIndex.close();

    const second = runReindex(episodesDir, indexPath, true);
    const secondIndex = new EvidenceIndex({ dbPath: indexPath });
    const secondRows = secondIndex.listEpisodes();
    secondIndex.close();

    expect(first).toMatchObject({ renamedFiles: 1, misnamedEpisodes: 1 });
    expect(second).toMatchObject({
      renamedFiles: 0,
      misnamedEpisodes: 0,
      nullFieldsRemoved: 0,
      unreadableFiles: 0,
    });
    expect(secondRows).toEqual(firstRows);
  });
});
