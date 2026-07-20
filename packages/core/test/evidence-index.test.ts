import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  defaultEvidenceIndexPath,
  EvidenceIndex,
  inspectEvidenceStore,
  reindexEvidenceStore,
  type ReindexReport,
} from '../src/evidence-index.js';
import { createEvidenceAdapter } from '../src/evidence-adapter.js';
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
    retrievalVisible: false,
    session: { sessionId: `session-${id}`, capturedAt, kind: 'user' },
    origin: { writer: 'core-test', build: '1.0.0' },
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
      verificationStrength: 'tests-passed',
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
  it('secures the default private parent and every SQLite file against a permissive umask', () => {
    if (process.platform === 'win32') return;
    const { root, episodesDir, indexPath } = makeStore();
    expect(indexPath).toBe(defaultEvidenceIndexPath(episodesDir));
    chmodSync(root, 0o755);
    writeJson(join(episodesDir, 'private.episode.json'), makeEpisode('private'));
    const previousUmask = process.umask(0);
    try {
      runReindex(episodesDir, indexPath, false);
      const index = new EvidenceIndex({ dbPath: indexPath });
      expect(index.listEpisodes()).toHaveLength(1);
      for (const path of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) {
        expect(existsSync(path), path).toBe(true);
        expect(lstatSync(path).mode & 0o777, path).toBe(0o600);
      }
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      index.close();
    } finally {
      process.umask(previousUmask);
    }
  });

  it('does not chmod an explicitly configured shared index parent', () => {
    if (process.platform === 'win32') return;
    const { root, episodesDir } = makeStore();
    const shared = join(root, 'shared');
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    const indexPath = join(shared, 'evidence-index.sqlite');
    writeJson(join(episodesDir, 'private.episode.json'), makeEpisode('private'));

    runReindex(episodesDir, indexPath, false);

    expect(lstatSync(shared).mode & 0o777).toBe(0o755);
    expect(lstatSync(indexPath).mode & 0o777).toBe(0o600);
  });

  it('rejects symlink and non-regular SQLite destinations', () => {
    const { root, episodesDir } = makeStore();
    writeJson(join(episodesDir, 'private.episode.json'), makeEpisode('private'));
    const target = join(root, 'target.sqlite');
    writeFileSync(target, 'not an index');
    const symlinkPath = join(root, 'symlink.sqlite');
    symlinkSync(target, symlinkPath);
    expect(() => runReindex(episodesDir, symlinkPath, false)).toThrow(/regular file|symlink/i);

    const directoryPath = join(root, 'directory.sqlite');
    mkdirSync(directoryPath);
    expect(() => runReindex(episodesDir, directoryPath, false)).toThrow(/regular file/i);

    const realParent = join(root, 'real-parent');
    mkdirSync(realParent);
    const symlinkParent = join(root, 'symlink-parent');
    symlinkSync(realParent, symlinkParent);
    expect(() => runReindex(episodesDir, join(symlinkParent, 'index.sqlite'), false))
      .toThrow(/parent.*symlink/i);
  });

  it('rejects a symlinked evidence directory and reports symlinked source files', () => {
    const { root, episodesDir, indexPath } = makeStore();
    const realStore = join(root, 'real-store');
    mkdirSync(realStore);
    writeJson(join(realStore, 'private.episode.json'), makeEpisode('private'));
    const linkedStore = join(root, 'linked-store');
    symlinkSync(realStore, linkedStore);

    expect(() => inspectEvidenceStore({ episodesDir: linkedStore }))
      .toThrow(/evidence store.*symlink/i);

    const outside = join(root, 'outside.episode.json');
    writeJson(outside, makeEpisode('outside'));
    symlinkSync(outside, join(episodesDir, 'linked.episode.json'));
    const report = runReindex(episodesDir, indexPath, false);
    expect(report).toMatchObject({ indexedEpisodes: 0, unreadableFiles: 1 });
    expect(report.unreadable[0]).toMatchObject({
      path: join(episodesDir, 'linked.episode.json'),
      reason: expect.stringMatching(/regular file|symlink/i),
    });
  });

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
      legacyUnstampedFiles: 0,
      indexUpdated: true,
    });

    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.journalMode()).toBe('wal');
    expect(index.listEpisodes().map((row) => row.episodeId)).toEqual(['first', 'second']);
    expect(index.listEpisodes()[0]).toMatchObject({
      sourceKind: 'canonical-episode',
      originKind: 'stamped',
      outcomeStatus: 'completed',
      verificationStrength: 'tests-passed',
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
      origin?: unknown;
    };
    raw.outcome.summary = null;
    raw.cost.tokens = null;
    raw.cost.usdEstimate = null;
    raw.lineage = null;
    delete raw.origin;
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
      indexUpdated: true,
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(episodesDir, 'tolerated.episode.json'))).toBe(false);
    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.listEpisodes()[0]?.sourceKind).toBe('misnamed-episode');
    index.close();
  });

  it('inspects readability without creating an index or repairing source files', () => {
    const { episodesDir, indexPath } = makeStore();
    const raw = structuredClone(makeEpisode('inspect-only')) as unknown as {
      outcome: { summary: string | null };
    };
    raw.outcome.summary = null;
    const sourcePath = join(episodesDir, 'inspect-only.json');
    writeJson(sourcePath, raw);
    writeFileSync(join(episodesDir, 'broken.episode.json'), '{not json');
    const before = readFileSync(sourcePath, 'utf8');

    const report = inspectEvidenceStore({ episodesDir });

    expect(report).toMatchObject({
      scannedFiles: 2,
      indexedEpisodes: 1,
      unreadableFiles: 1,
      nullToleratedFiles: 1,
      nullFieldsRemoved: 0,
      misnamedEpisodes: 1,
      renamedFiles: 0,
      indexUpdated: false,
    });
    expect(readFileSync(sourcePath, 'utf8')).toBe(before);
    expect(existsSync(indexPath)).toBe(false);
  });

  it('does not classify unstamped evidence as synthetic from a session id alone', () => {
    const { episodesDir, indexPath } = makeStore();
    const legacy = structuredClone(makeEpisode('short-session'));
    legacy.session.sessionId = 'sA';
    delete legacy.origin;
    writeJson(join(episodesDir, 'short-session.episode.json'), legacy);

    const report = runReindex(episodesDir, indexPath, false);

    expect(report).toMatchObject({
      indexedEpisodes: 1,
      legacyUnstampedFiles: 1,
      unreadableFiles: 0,
    });
    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.listEpisodes()).toMatchObject([{
      episodeId: 'short-session',
      sessionId: 'sA',
      originKind: 'legacy-unstamped',
    }]);
    index.close();
  });

  it('does not clobber a rescue target that is already occupied', () => {
    if (process.platform === 'win32') return;
    const { episodesDir, indexPath } = makeStore();
    const sourcePath = join(episodesDir, 'misnamed.json');
    const targetPath = join(episodesDir, 'misnamed.episode.json');
    writeJson(sourcePath, makeEpisode('misnamed'));
    symlinkSync('concurrent-writer-target', targetPath);

    const report = runReindex(episodesDir, indexPath, true);

    expect(existsSync(sourcePath)).toBe(true);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(report).toMatchObject({ indexedEpisodes: 0, renamedFiles: 0, unreadableFiles: 2 });
    expect(report.unreadable.find((row) => row.path === sourcePath)?.reason)
      .toMatch(/target already exists|EEXIST/i);
  });

  it('excludes every source for an ambiguous duplicate episode id', () => {
    const { episodesDir, indexPath } = makeStore();
    const canonicalPath = join(episodesDir, 'duplicate.episode.json');
    writeJson(canonicalPath, makeEpisode('duplicate'));
    const misnamedPath = join(episodesDir, '000-first.json');
    writeJson(misnamedPath, {
      ...makeEpisode('duplicate'),
      task: { summary: 'different content', distributionTags: [] },
    });

    const report = runReindex(episodesDir, indexPath, false);

    expect(report).toMatchObject({ indexedEpisodes: 0, unreadableFiles: 2 });
    expect(report.unreadable.map((row) => row.path).sort()).toEqual(
      [canonicalPath, misnamedPath].sort(),
    );
    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.listEpisodes()).toEqual([]);
    expect(index.listUnreadable()).toHaveLength(2);
    index.close();
  });

  it.skipIf(process.platform === 'win32')('rejects hardlinked evidence sources during repair', () => {
    const { episodesDir, indexPath } = makeStore();
    const sourcePath = join(episodesDir, 'hardlinked.episode.json');
    const aliasPath = join(episodesDir, 'alias.json');
    writeJson(sourcePath, makeEpisode('hardlinked'));
    linkSync(sourcePath, aliasPath);

    const report = runReindex(episodesDir, indexPath, true);

    expect(report).toMatchObject({ indexedEpisodes: 0, unreadableFiles: 2 });
    expect(report.unreadable.every((row) => /hardlink/i.test(row.reason))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rejects a hardlinked SQLite destination', () => {
    const { root, episodesDir, indexPath } = makeStore();
    runReindex(episodesDir, indexPath, false);
    linkSync(indexPath, join(root, 'index-alias.sqlite'));

    expect(() => runReindex(episodesDir, indexPath, false)).toThrow(/hardlink/i);
  });

  it('repairs accepted source permissions to private mode', () => {
    if (process.platform === 'win32') return;
    const { episodesDir, indexPath } = makeStore();
    const sourcePath = join(episodesDir, 'private.episode.json');
    writeJson(sourcePath, makeEpisode('private'));
    chmodSync(sourcePath, 0o644);

    const report = runReindex(episodesDir, indexPath, true);

    expect(report).toMatchObject({ indexedEpisodes: 1, unreadableFiles: 0 });
    expect(lstatSync(sourcePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(episodesDir).mode & 0o777).toBe(0o700);
  });

  it('refuses to adopt an unrelated SQLite database', () => {
    const { indexPath } = makeStore();
    const unrelated = new Database(indexPath);
    unrelated.exec('CREATE TABLE unrelated (value TEXT)');
    unrelated.close();

    expect(() => new EvidenceIndex({ dbPath: indexPath }))
      .toThrow(/not a Jinn evidence index/i);
  });

  it('refuses a spoofed Jinn schema without the application ownership marker', () => {
    const { indexPath } = makeStore();
    const spoofed = new Database(indexPath);
    spoofed.exec(`
      CREATE TABLE evidence_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO evidence_index_meta(key, value) VALUES ('schema_version', '1');
    `);
    spoofed.close();

    expect(() => new EvidenceIndex({ dbPath: indexPath }))
      .toThrow(/application id|ownership marker|not a Jinn evidence index/i);
  });

  it('rejects a newer index schema without downgrading its marker', () => {
    const { indexPath } = makeStore();
    const initialized = new EvidenceIndex({ dbPath: indexPath });
    initialized.close();
    const future = new Database(indexPath);
    future.prepare(
      "UPDATE evidence_index_meta SET value = '2' WHERE key = 'schema_version'",
    ).run();
    future.close();

    expect(() => new EvidenceIndex({ dbPath: indexPath }))
      .toThrow(/unsupported.*schema version.*2/i);
    const unchanged = new Database(indexPath);
    expect(unchanged.prepare(
      "SELECT value FROM evidence_index_meta WHERE key = 'schema_version'",
    ).pluck().get()).toBe('2');
    unchanged.close();
  });

  it('validates the index before mutating canonical source files', () => {
    const { episodesDir, indexPath } = makeStore();
    const raw = structuredClone(makeEpisode('partial')) as unknown as {
      outcome: { summary: null };
    };
    raw.outcome.summary = null;
    const sourcePath = join(episodesDir, 'partial.json');
    writeJson(sourcePath, raw);
    const unrelated = new Database(indexPath);
    unrelated.exec('CREATE TABLE unrelated (value TEXT)');
    unrelated.close();

    expect(() => runReindex(episodesDir, indexPath, true))
      .toThrow(/not a Jinn evidence index/i);
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(join(episodesDir, 'partial.episode.json'))).toBe(false);
    expect((JSON.parse(readFileSync(sourcePath, 'utf8')) as typeof raw).outcome.summary)
      .toBeNull();
  });

  it('preserves the source mutation report when index publication fails', () => {
    const { episodesDir, indexPath } = makeStore();
    const raw = structuredClone(makeEpisode('partial')) as unknown as {
      outcome: { summary: null };
    };
    raw.outcome.summary = null;
    const sourcePath = join(episodesDir, 'partial.json');
    writeJson(sourcePath, raw);
    const initialized = new EvidenceIndex({ dbPath: indexPath });
    initialized.close();
    const sabotaged = new Database(indexPath);
    sabotaged.exec(`
      CREATE TRIGGER reject_episode_insert
      BEFORE INSERT ON episodes
      BEGIN
        SELECT RAISE(ABORT, 'forced publication failure');
      END;
    `);
    sabotaged.close();

    const report = runReindex(episodesDir, indexPath, true);

    expect(report).toMatchObject({
      indexUpdated: false,
      indexError: expect.stringMatching(/forced publication failure/i),
    });
    expect(report.mutations).toEqual([
      { kind: 'normalized-json', sourcePath, nullFieldsRemoved: 1 },
      {
        kind: 'rescued-misnamed-episode',
        sourcePath,
        targetPath: join(episodesDir, 'partial.episode.json'),
      },
    ]);
  });

  it('refreshes the index after a canonical adapter write', async () => {
    const { episodesDir, indexPath } = makeStore();
    runReindex(episodesDir, indexPath, false);
    const adapter = createEvidenceAdapter({
      capturesDir: episodesDir,
      onStoreChanged: () => {
        runReindex(episodesDir, indexPath, false);
      },
    });

    const episode = structuredClone(makeEpisode('live-write'));
    delete episode.activity;
    const result = await adapter.put(episode);

    expect(result.status).toBe('ok');
    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.listEpisodes().map((row) => row.episodeId)).toEqual(['live-write']);
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
