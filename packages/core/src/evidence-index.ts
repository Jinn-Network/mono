import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { EpisodeV1Schema, type EpisodeV1 } from '@jinn-network/plugin';
import { capturedTaskToEpisode, episodeFileName } from './evidence-adapter.js';
import { parseCapturedTask } from './captured-task.js';

export type EvidenceSourceKind =
  | 'canonical-episode'
  | 'misnamed-episode'
  | 'legacy-capture';
export type EvidenceOriginKind = 'stamped' | 'legacy-unstamped';

export interface IndexedEpisode {
  episodeId: string;
  sessionId: string;
  capturedAt: string;
  sourcePath: string;
  sourceKind: EvidenceSourceKind;
  originKind: EvidenceOriginKind;
  originWriter?: string;
  originBuild?: string;
  outcomeStatus: EpisodeV1['outcome']['status'];
  verificationStrength: EpisodeV1['outcome']['verificationStrength'];
  durationMs: number;
  activity: EpisodeV1['activity'] | null;
  episode: EpisodeV1;
  contentSha256: string;
}

export interface UnreadableEvidence {
  sourcePath: string;
  reason: string;
}

export interface ReindexReport {
  scannedFiles: number;
  indexedEpisodes: number;
  unreadableFiles: number;
  unreadable: Array<{ path: string; reason: string }>;
  nullToleratedFiles: number;
  nullFieldsRemoved: number;
  misnamedEpisodes: number;
  renamedFiles: number;
  legacyUnstampedFiles: number;
}

export interface ReindexEvidenceStoreOptions {
  episodesDir: string;
  indexPath: string;
  repair?: boolean;
}

export interface InspectEvidenceStoreOptions {
  episodesDir: string;
}

export function defaultEvidenceIndexPath(episodesDir: string): string {
  return join(dirname(resolve(episodesDir)), 'evidence-index.sqlite');
}

interface MutableJson {
  [key: string]: unknown;
}

interface ParsedEvidence {
  episode: EpisodeV1;
  normalizedRaw: unknown;
  nullCount: number;
  sourceKind: EvidenceSourceKind;
  originKind: EvidenceOriginKind;
  originWriter?: string;
  originBuild?: string;
}

const RETENTION = { policy: 'local-private' as const, maxEpisodes: 200 };

function asObject(value: unknown): MutableJson | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as MutableJson
    : undefined;
}

/**
 * The affected operator files carry null in exactly these four optional
 * fields (#1811). Keep required nullable fields (notably parentSpanId) intact.
 */
export function tolerateNullQuartet(value: unknown): { value: unknown; removed: number } {
  const copy = structuredClone(value);
  const root = asObject(copy);
  if (!root) return { value: copy, removed: 0 };
  let removed = 0;
  const outcome = asObject(root['outcome']);
  if (outcome?.['summary'] === null) {
    delete outcome['summary'];
    removed += 1;
  }
  const cost = asObject(root['cost']);
  for (const key of ['tokens', 'usdEstimate'] as const) {
    if (cost?.[key] === null) {
      delete cost[key];
      removed += 1;
    }
  }
  if (root['lineage'] === null) {
    delete root['lineage'];
    removed += 1;
  }
  return { value: copy, removed };
}

function originFrom(raw: unknown): Pick<
  ParsedEvidence,
  'originKind' | 'originWriter' | 'originBuild'
> {
  const origin = asObject(asObject(raw)?.['origin']);
  const writer = typeof origin?.['writer'] === 'string' ? origin['writer'] : undefined;
  const build = typeof origin?.['build'] === 'string' ? origin['build'] : undefined;
  return writer && build
    ? { originKind: 'stamped', originWriter: writer, originBuild: build }
    : { originKind: 'legacy-unstamped' };
}

function parseFile(raw: unknown, canonicalName: boolean): ParsedEvidence {
  const tolerated = tolerateNullQuartet(raw);
  const episodeResult = EpisodeV1Schema.safeParse(tolerated.value);
  if (episodeResult.success) {
    return {
      episode: episodeResult.data,
      normalizedRaw: tolerated.value,
      nullCount: tolerated.removed,
      sourceKind: canonicalName ? 'canonical-episode' : 'misnamed-episode',
      ...originFrom(raw),
    };
  }
  if (canonicalName) throw episodeResult.error;

  const task = parseCapturedTask(tolerated.value);
  return {
    episode: capturedTaskToEpisode(task, RETENTION),
    normalizedRaw: tolerated.value,
    nullCount: tolerated.removed,
    sourceKind: 'legacy-capture',
    ...originFrom(raw),
  };
}

function repairJson(path: string, value: unknown): void {
  const tmp = join(dirname(path), `.${randomUUID()}.repair.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readableReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface EvidenceIndexOptions {
  dbPath: string;
}

export class EvidenceIndex {
  private readonly db: Database.Database;

  constructor(options: EvidenceIndexOptions) {
    const dbPath = resolve(options.dbPath);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episodes (
        episode_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        origin_kind TEXT NOT NULL,
        origin_writer TEXT,
        origin_build TEXT,
        outcome_status TEXT NOT NULL,
        verification_strength TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        activity_json TEXT,
        episode_json TEXT NOT NULL,
        content_sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS episodes_captured_at
        ON episodes(captured_at DESC, episode_id ASC);
      CREATE TABLE IF NOT EXISTS unreadable_records (
        source_path TEXT PRIMARY KEY,
        reason TEXT NOT NULL
      );
    `);
    this.db.prepare(`
      INSERT INTO evidence_index_meta(key, value) VALUES ('schema_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  }

  journalMode(): string {
    const row = this.db.pragma('journal_mode', { simple: true });
    return String(row).toLowerCase();
  }

  replace(rows: IndexedEpisode[], unreadable: UnreadableEvidence[]): void {
    const insertEpisode = this.db.prepare(`
      INSERT INTO episodes (
        episode_id, session_id, captured_at, source_path, source_kind,
        origin_kind, origin_writer, origin_build, outcome_status,
        verification_strength, duration_ms, activity_json, episode_json,
        content_sha256
      ) VALUES (
        @episodeId, @sessionId, @capturedAt, @sourcePath, @sourceKind,
        @originKind, @originWriter, @originBuild, @outcomeStatus,
        @verificationStrength, @durationMs, @activityJson, @episodeJson,
        @contentSha256
      )
    `);
    const insertUnreadable = this.db.prepare(`
      INSERT INTO unreadable_records(source_path, reason)
      VALUES (@sourcePath, @reason)
    `);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM episodes').run();
      this.db.prepare('DELETE FROM unreadable_records').run();
      for (const row of rows) {
        insertEpisode.run({
          ...row,
          originWriter: row.originWriter ?? null,
          originBuild: row.originBuild ?? null,
          activityJson: row.activity === null ? null : JSON.stringify(row.activity),
          episodeJson: JSON.stringify(row.episode),
        });
      }
      for (const row of unreadable) insertUnreadable.run(row);
    })();
  }

  listEpisodes(): IndexedEpisode[] {
    const rows = this.db.prepare(`
      SELECT
        episode_id AS episodeId,
        session_id AS sessionId,
        captured_at AS capturedAt,
        source_path AS sourcePath,
        source_kind AS sourceKind,
        origin_kind AS originKind,
        origin_writer AS originWriter,
        origin_build AS originBuild,
        outcome_status AS outcomeStatus,
        verification_strength AS verificationStrength,
        duration_ms AS durationMs,
        activity_json AS activityJson,
        episode_json AS episodeJson,
        content_sha256 AS contentSha256
      FROM episodes
      ORDER BY episode_id ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      episodeId: String(row['episodeId']),
      sessionId: String(row['sessionId']),
      capturedAt: String(row['capturedAt']),
      sourcePath: String(row['sourcePath']),
      sourceKind: row['sourceKind'] as EvidenceSourceKind,
      originKind: row['originKind'] as EvidenceOriginKind,
      ...(row['originWriter'] === null ? {} : { originWriter: String(row['originWriter']) }),
      ...(row['originBuild'] === null ? {} : { originBuild: String(row['originBuild']) }),
      outcomeStatus: row['outcomeStatus'] as EpisodeV1['outcome']['status'],
      verificationStrength: row['verificationStrength'] as EpisodeV1['outcome']['verificationStrength'],
      durationMs: Number(row['durationMs']),
      activity: row['activityJson'] === null
        ? null
        : JSON.parse(String(row['activityJson'])) as EpisodeV1['activity'],
      episode: EpisodeV1Schema.parse(JSON.parse(String(row['episodeJson']))),
      contentSha256: String(row['contentSha256']),
    }));
  }

  listUnreadable(): UnreadableEvidence[] {
    return this.db.prepare(`
      SELECT source_path AS sourcePath, reason
      FROM unreadable_records
      ORDER BY source_path ASC
    `).all() as UnreadableEvidence[];
  }

  close(): void {
    this.db.close();
  }
}

interface EvidenceScanResult {
  indexed: IndexedEpisode[];
  unreadable: UnreadableEvidence[];
  report: ReindexReport;
}

function scanEvidenceStore(episodesDirInput: string, repair: boolean): EvidenceScanResult {
  const episodesDir = resolve(episodesDirInput);
  const unreadable: UnreadableEvidence[] = [];
  const indexed = new Map<string, IndexedEpisode>();
  let scannedFiles = 0;
  let nullToleratedFiles = 0;
  let nullFieldsRemoved = 0;
  let misnamedEpisodes = 0;
  let renamedFiles = 0;
  let legacyUnstampedFiles = 0;

  const files = existsSync(episodesDir)
    ? readdirSync(episodesDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  for (const name of files) {
    scannedFiles += 1;
    const sourcePath = join(episodesDir, name);
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('evidence source must be a regular file, not a symlink');
      }
      const raw = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
      const canonicalName = name.endsWith('.episode.json');
      const parsed = parseFile(raw, canonicalName);
      if (parsed.nullCount > 0) nullToleratedFiles += 1;
      if (parsed.sourceKind === 'misnamed-episode') misnamedEpisodes += 1;
      if (indexed.has(parsed.episode.episodeId)) {
        throw new Error(`duplicate episodeId: ${parsed.episode.episodeId}`);
      }

      let finalPath = sourcePath;
      const rescueTarget = parsed.sourceKind === 'misnamed-episode'
        ? join(episodesDir, episodeFileName(parsed.episode.episodeId))
        : sourcePath;
      if (repair && rescueTarget !== sourcePath && existsSync(rescueTarget)) {
        throw new Error(`cannot rescue misnamed episode: target already exists: ${rescueTarget}`);
      }
      if (repair && parsed.nullCount > 0) {
        repairJson(sourcePath, parsed.normalizedRaw);
        nullFieldsRemoved += parsed.nullCount;
      }
      if (repair && rescueTarget !== sourcePath) {
        renameSync(sourcePath, rescueTarget);
        if (process.platform !== 'win32') chmodSync(rescueTarget, 0o600);
        finalPath = rescueTarget;
        renamedFiles += 1;
      }

      if (parsed.originKind === 'legacy-unstamped') legacyUnstampedFiles += 1;
      const episodeJson = JSON.stringify(parsed.episode);
      indexed.set(parsed.episode.episodeId, {
        episodeId: parsed.episode.episodeId,
        sessionId: parsed.episode.session.sessionId,
        capturedAt: parsed.episode.session.capturedAt,
        sourcePath: finalPath,
        sourceKind: repair && parsed.sourceKind === 'misnamed-episode'
          ? 'canonical-episode'
          : parsed.sourceKind,
        originKind: parsed.originKind,
        ...(parsed.originWriter ? { originWriter: parsed.originWriter } : {}),
        ...(parsed.originBuild ? { originBuild: parsed.originBuild } : {}),
        outcomeStatus: parsed.episode.outcome.status,
        verificationStrength: parsed.episode.outcome.verificationStrength,
        durationMs: parsed.episode.cost.durationMs,
        activity: parsed.episode.activity ?? null,
        episode: parsed.episode,
        contentSha256: createHash('sha256').update(episodeJson).digest('hex'),
      });
    } catch (error) {
      unreadable.push({ sourcePath, reason: readableReason(error) });
    }
  }

  return {
    indexed: [...indexed.values()].sort((a, b) => a.episodeId.localeCompare(b.episodeId)),
    unreadable,
    report: {
      scannedFiles,
      indexedEpisodes: indexed.size,
      unreadableFiles: unreadable.length,
      unreadable: unreadable.map((row) => ({ path: row.sourcePath, reason: row.reason })),
      nullToleratedFiles,
      nullFieldsRemoved,
      misnamedEpisodes,
      renamedFiles,
      legacyUnstampedFiles,
    },
  };
}

/**
 * Read-only store inspection for doctor/status surfaces. It deliberately
 * shares the reindex scanner while neither opening SQLite nor repairing files.
 */
export function inspectEvidenceStore(options: InspectEvidenceStoreOptions): ReindexReport {
  return scanEvidenceStore(options.episodesDir, false).report;
}

export function reindexEvidenceStore(options: ReindexEvidenceStoreOptions): ReindexReport {
  const scan = scanEvidenceStore(options.episodesDir, options.repair ?? false);
  const indexPath = resolve(options.indexPath);
  const index = new EvidenceIndex({ dbPath: indexPath });
  try {
    index.replace(scan.indexed, scan.unreadable);
  } finally {
    index.close();
  }
  return scan.report;
}
