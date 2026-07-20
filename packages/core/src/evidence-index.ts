import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { EpisodeV1Schema, type EpisodeV1 } from '@jinn-network/plugin';
import { capturedTaskToEpisode, episodeFileName } from './evidence-adapter.js';
import { parseCapturedTask } from './captured-task.js';
import {
  assertRegularStat,
  assertSafeOwner,
  fsyncDirectory,
  identityFrom,
  inspectRegularPath,
  nodeErrorCode,
  openVerifiedRegular,
  sameIdentity,
  secureRegularPath,
  validateDirectory,
  type FileIdentity,
} from './evidence-filesystem.js';
import { withEvidenceStoreLockSync } from './evidence-store-lock.js';

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

export type ReindexMutation =
  | { kind: 'normalized-json'; sourcePath: string; nullFieldsRemoved: number }
  | { kind: 'rescued-misnamed-episode'; sourcePath: string; targetPath: string }
  | { kind: 'rescue-target-published'; sourcePath: string; targetPath: string };

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
  mutations: ReindexMutation[];
  /** False for inspection and for a failed derived-index publication. */
  indexUpdated: boolean;
  /** Present only when source scanning/repair completed but publication failed. */
  indexError?: string;
}

export interface ReindexEvidenceStoreOptions {
  episodesDir: string;
  indexPath: string;
  repair?: boolean;
  /** @internal Deterministic concurrency-test seam; called while the store lock is held. */
  onScanComplete?: () => void;
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

interface EvidenceCandidate {
  sourcePath: string;
  parsed: ParsedEvidence;
  identity: FileIdentity;
  contentSha256: string;
}

const RETENTION = { policy: 'local-private' as const, maxEpisodes: 200 };
const EVIDENCE_INDEX_APPLICATION_ID = 0x4a494e4e;
const EVIDENCE_INDEX_SCHEMA_VERSION = '1';

class EvidenceMutationCommittedError extends Error {
  constructor(
    message: string,
    readonly mutation: ReindexMutation,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = 'EvidenceMutationCommittedError';
  }
}
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

function readableReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readVerifiedJson(path: string): { raw: unknown; identity: FileIdentity } {
  const opened = openVerifiedRegular(path, 'evidence source');
  try {
    return {
      raw: JSON.parse(readFileSync(opened.fd, 'utf8')) as unknown,
      identity: opened.identity,
    };
  } finally {
    closeSync(opened.fd);
  }
}

function repairJson(
  path: string,
  value: unknown,
  expected: FileIdentity,
  mutation: ReindexMutation,
): FileIdentity {
  const directory = dirname(path);
  const tmp = join(directory, `.${randomUUID()}.repair.tmp`);
  let fd: number | undefined;
  let replacementIdentity: FileIdentity | undefined;
  let committed = false;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    fsyncSync(fd);
    replacementIdentity = identityFrom(fstatSync(fd));
    closeSync(fd);
    fd = undefined;

    try {
      const verified = openVerifiedRegular(path, 'evidence source', expected);
      try {
        const sourceAtCommit = lstatSync(path);
        assertRegularStat(sourceAtCommit, path, 'evidence source');
        if (!sameIdentity(identityFrom(sourceAtCommit), verified.identity)) {
          throw new Error(`evidence source changed before normalization: ${path}`);
        }
        renameSync(tmp, path);
        committed = true;
      } finally {
        closeSync(verified.fd);
      }
      if (!replacementIdentity) {
        throw new Error(`normalized evidence replacement identity is unavailable: ${path}`);
      }
      replacementIdentity = secureRegularPath(
        path,
        'normalized evidence source',
        replacementIdentity,
      );
      fsyncDirectory(directory);
    } catch (error) {
      if (!committed) throw error;
      throw new EvidenceMutationCommittedError(
        `evidence JSON was repaired but post-commit validation failed: ${path}: ${readableReason(error)}`,
        mutation,
        error,
      );
    }
    return replacementIdentity;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

function publishNoClobber(
  sourcePath: string,
  targetPath: string,
  expected: FileIdentity,
  mutation: ReindexMutation,
): FileIdentity {
  const opened = openVerifiedRegular(sourcePath, 'evidence source', expected);
  if (process.platform !== 'win32') fchmodSync(opened.fd, 0o600);
  const secured = opened.identity;
  let targetPublished = false;
  let sourceRemoved = false;
  try {
    try {
      linkSync(sourcePath, targetPath);
      targetPublished = true;
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        throw new Error(`cannot rescue misnamed episode: target already exists: ${targetPath}`);
      }
      throw error;
    }

    const sourceAfterLink = lstatSync(sourcePath);
    const targetAfterLink = lstatSync(targetPath);
    const sourceIdentity = identityFrom(sourceAfterLink);
    const targetIdentity = identityFrom(targetAfterLink);
    if (
      !sourceAfterLink.isFile()
      || sourceAfterLink.isSymbolicLink()
      || !targetAfterLink.isFile()
      || targetAfterLink.isSymbolicLink()
      || !sameIdentity(sourceIdentity, secured)
      || !sameIdentity(targetIdentity, secured)
    ) {
      throw new Error(`evidence source changed while rescue was being published: ${sourcePath}`);
    }
    assertSafeOwner(sourceAfterLink, sourcePath, 'evidence source');
    assertSafeOwner(targetAfterLink, targetPath, 'rescue target');

    try {
      const sourceAtUnlink = lstatSync(sourcePath);
      if (!sameIdentity(identityFrom(sourceAtUnlink), secured)) {
        throw new Error(`evidence source changed before rescue unlink: ${sourcePath}`);
      }
      unlinkSync(sourcePath);
      sourceRemoved = true;
      const targetAfterUnlink = lstatSync(targetPath);
      assertRegularStat(targetAfterUnlink, targetPath, 'rescue target');
      if (!sameIdentity(identityFrom(targetAfterUnlink), secured)) {
        throw new Error(`rescue target changed after source unlink: ${targetPath}`);
      }
      fsyncDirectory(dirname(sourcePath));
    } catch (error) {
      if (!sourceRemoved) throw error;
      throw new EvidenceMutationCommittedError(
        `rescue target was published but source finalization failed: ${sourcePath}: ${readableReason(error)}`,
        { kind: 'rescue-target-published', sourcePath, targetPath },
        error,
      );
    }
    return secured;
  } catch (error) {
    if (!targetPublished || error instanceof EvidenceMutationCommittedError) throw error;
    if (!sourceRemoved) {
      try {
        const target = lstatSync(targetPath);
        const source = lstatSync(sourcePath);
        const targetIdentity = identityFrom(target);
        const sourceIdentity = identityFrom(source);
        const canProveCreatedLink = target.isFile()
          && !target.isSymbolicLink()
          && (
            sameIdentity(targetIdentity, secured)
            || (
              source.isFile()
              && !source.isSymbolicLink()
              && sameIdentity(targetIdentity, sourceIdentity)
              && target.nlink >= 2
            )
          );
        if (canProveCreatedLink) {
          const targetAtCleanup = lstatSync(targetPath);
          if (sameIdentity(identityFrom(targetAtCleanup), targetIdentity)) {
            unlinkSync(targetPath);
            fsyncDirectory(dirname(targetPath));
            throw error;
          }
        }
      } catch (cleanupError) {
        if (cleanupError === error) throw error;
      }
    }
    throw new EvidenceMutationCommittedError(
      `rescue target was published but could not be safely rolled back: ${targetPath}: ${readableReason(error)}`,
      { kind: 'rescue-target-published', sourcePath, targetPath },
      error,
    );
  } finally {
    closeSync(opened.fd);
  }
}

interface PreparedIndexDestination {
  created: boolean;
  identity: FileIdentity;
}

function prepareIndexDestination(dbPath: string, secureParent: boolean): PreparedIndexDestination {
  const parent = dirname(dbPath);
  let createdParent = false;
  try {
    validateDirectory(parent, 'evidence index parent', secureParent);
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    createdParent = true;
    validateDirectory(parent, 'evidence index parent', true);
  }
  if (createdParent) fsyncDirectory(dirname(parent));

  const existing = inspectRegularPath(dbPath, 'evidence index destination');
  const wal = inspectRegularPath(`${dbPath}-wal`, 'evidence index sidecar');
  const shm = inspectRegularPath(`${dbPath}-shm`, 'evidence index sidecar');
  if (!existing && (wal || shm)) {
    throw new Error(`refusing orphaned evidence index sidecars without a database: ${dbPath}`);
  }
  if (existing) return { created: false, identity: existing };

  const fd = openSync(
    dbPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(parent);
  const identity = inspectRegularPath(dbPath, 'evidence index destination');
  if (!identity) throw new Error(`evidence index destination disappeared: ${dbPath}`);
  return { created: true, identity };
}

function secureIndexFiles(dbPath: string, expectedMain?: FileIdentity): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (inspectRegularPath(path, 'evidence index file')) {
      secureRegularPath(
        path,
        'evidence index file',
        path === dbPath ? expectedMain : undefined,
      );
    }
  }
}

function removeNewIndexAfterInitializationFailure(
  dbPath: string,
  expectedMain: FileIdentity,
): void {
  const current = inspectRegularPath(dbPath, 'failed evidence index');
  if (!current || !sameIdentity(current, expectedMain)) return;
  for (const path of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (inspectRegularPath(path, 'failed evidence index sidecar')) unlinkSync(path);
  }
  unlinkSync(dbPath);
  fsyncDirectory(dirname(dbPath));
}

export interface EvidenceIndexOptions {
  dbPath: string;
  /** Only the default dedicated state parent is safe to normalize to 0700. */
  secureParent?: boolean;
}

export class EvidenceIndex {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private readonly dbIdentity: FileIdentity;

  constructor(options: EvidenceIndexOptions) {
    const dbPath = resolve(options.dbPath);
    this.dbPath = dbPath;
    const prepared = prepareIndexDestination(dbPath, options.secureParent ?? false);
    const db = new Database(dbPath);
    this.db = db;
    try {
      const afterOpen = inspectRegularPath(dbPath, 'evidence index destination');
      if (!afterOpen || !sameIdentity(afterOpen, prepared.identity)) {
        throw new Error(`evidence index destination changed while opening: ${dbPath}`);
      }
      this.dbIdentity = afterOpen;

      const applicationId = Number(db.pragma('application_id', { simple: true }));
      if (prepared.created) {
        if (applicationId !== 0) {
          throw new Error(`new evidence index has an unexpected application id: ${applicationId}`);
        }
        db.pragma(`application_id = ${EVIDENCE_INDEX_APPLICATION_ID}`);
        db.exec(`
          CREATE TABLE evidence_index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE episodes (
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
          CREATE INDEX episodes_captured_at
            ON episodes(captured_at DESC, episode_id ASC);
          CREATE TABLE unreadable_records (
            source_path TEXT PRIMARY KEY,
            reason TEXT NOT NULL
          );
          INSERT INTO evidence_index_meta(key, value)
          VALUES ('schema_version', '${EVIDENCE_INDEX_SCHEMA_VERSION}');
        `);
      } else {
        if (applicationId !== EVIDENCE_INDEX_APPLICATION_ID) {
          throw new Error(
            `refusing database that is not a Jinn evidence index (application id missing): ${dbPath}`,
          );
        }
        const tables = db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name ASC
        `).all() as Array<{ name: string }>;
        const tableNames = tables.map((row) => row.name);
        if (JSON.stringify(tableNames) !== JSON.stringify([
          'episodes',
          'evidence_index_meta',
          'unreadable_records',
        ].sort())) {
          throw new Error(`refusing database with an unexpected Jinn evidence index schema: ${dbPath}`);
        }
        const version = db.prepare(
          "SELECT value FROM evidence_index_meta WHERE key = 'schema_version'",
        ).get() as { value?: unknown } | undefined;
        if (version?.value !== EVIDENCE_INDEX_SCHEMA_VERSION) {
          throw new Error(`unsupported Jinn evidence index schema version: ${String(version?.value)}`);
        }
      }

      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      secureIndexFiles(dbPath, this.dbIdentity);
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the initialization failure.
      }
      if (prepared.created) {
        try {
          removeNewIndexAfterInitializationFailure(dbPath, prepared.identity);
        } catch {
          // Remove only fully verified files; otherwise preserve them for diagnosis.
        }
      }
      throw error;
    }
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
    secureIndexFiles(this.dbPath, this.dbIdentity);
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
    let failure: unknown;
    try {
      secureIndexFiles(this.dbPath, this.dbIdentity);
    } catch (error) {
      failure = error;
    }
    try {
      this.db.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      secureIndexFiles(this.dbPath, this.dbIdentity);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
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
  const candidates = new Map<string, EvidenceCandidate[]>();
  const indexed: IndexedEpisode[] = [];
  const mutations: ReindexMutation[] = [];
  let scannedFiles = 0;
  let nullToleratedFiles = 0;
  let nullFieldsRemoved = 0;
  let misnamedEpisodes = 0;
  let renamedFiles = 0;
  let legacyUnstampedFiles = 0;

  let files: string[] = [];
  if (existsSync(episodesDir)) {
    validateDirectory(episodesDir, 'evidence store', repair);
    files = readdirSync(episodesDir).filter((name) => name.endsWith('.json')).sort();
  }

  for (const name of files) {
    scannedFiles += 1;
    const sourcePath = join(episodesDir, name);
    try {
      if (repair) secureRegularPath(sourcePath, 'evidence source');
      const { raw, identity } = readVerifiedJson(sourcePath);
      const parsed = parseFile(raw, name.endsWith('.episode.json'));
      if (parsed.nullCount > 0) nullToleratedFiles += 1;
      if (parsed.sourceKind === 'misnamed-episode') misnamedEpisodes += 1;
      const episodeJson = JSON.stringify(parsed.episode);
      const episodeCandidates = candidates.get(parsed.episode.episodeId) ?? [];
      episodeCandidates.push({
        sourcePath,
        parsed,
        identity,
        contentSha256: createHash('sha256').update(episodeJson).digest('hex'),
      });
      candidates.set(parsed.episode.episodeId, episodeCandidates);
    } catch (error) {
      unreadable.push({ sourcePath, reason: readableReason(error) });
    }
  }

  for (const [episodeId, episodeCandidates] of [...candidates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (episodeCandidates.length > 1) {
      const conflicts = episodeCandidates
        .map((candidate) => `${candidate.sourcePath} sha256=${candidate.contentSha256}`)
        .join(', ');
      for (const candidate of episodeCandidates) {
        unreadable.push({
          sourcePath: candidate.sourcePath,
          reason: `duplicate episodeId: ${episodeId}; conflicting sources: ${conflicts}`,
        });
      }
      continue;
    }

    const candidate = episodeCandidates[0]!;
    const { sourcePath, parsed } = candidate;
    let identity = candidate.identity;
    let finalPath = sourcePath;
    try {
      if (repair && parsed.nullCount > 0) {
        const mutation: ReindexMutation = {
          kind: 'normalized-json',
          sourcePath,
          nullFieldsRemoved: parsed.nullCount,
        };
        identity = repairJson(sourcePath, parsed.normalizedRaw, identity, mutation);
        nullFieldsRemoved += parsed.nullCount;
        mutations.push(mutation);
      } else if (repair) {
        identity = secureRegularPath(sourcePath, 'evidence source', identity);
      }

      if (repair && parsed.sourceKind === 'misnamed-episode') {
        const targetPath = join(episodesDir, episodeFileName(episodeId));
        const mutation: ReindexMutation = {
          kind: 'rescued-misnamed-episode',
          sourcePath,
          targetPath,
        };
        identity = publishNoClobber(sourcePath, targetPath, identity, mutation);
        finalPath = targetPath;
        renamedFiles += 1;
        mutations.push(mutation);
      }

      if (parsed.originKind === 'legacy-unstamped') legacyUnstampedFiles += 1;
      indexed.push({
        episodeId,
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
        contentSha256: candidate.contentSha256,
      });
    } catch (error) {
      if (error instanceof EvidenceMutationCommittedError) {
        mutations.push(error.mutation);
        if (error.mutation.kind === 'normalized-json') {
          nullFieldsRemoved += error.mutation.nullFieldsRemoved;
        } else if (error.mutation.kind === 'rescued-misnamed-episode') {
          renamedFiles += 1;
        }
      }
      unreadable.push({ sourcePath, reason: readableReason(error) });
    }
  }

  unreadable.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  indexed.sort((left, right) => left.episodeId.localeCompare(right.episodeId));

  return {
    indexed,
    unreadable,
    report: {
      scannedFiles,
      indexedEpisodes: indexed.length,
      unreadableFiles: unreadable.length,
      unreadable: unreadable.map((row) => ({ path: row.sourcePath, reason: row.reason })),
      nullToleratedFiles,
      nullFieldsRemoved,
      misnamedEpisodes,
      renamedFiles,
      legacyUnstampedFiles,
      mutations,
      indexUpdated: false,
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
  const episodesDir = resolve(options.episodesDir);
  const indexPath = resolve(options.indexPath);
  return withEvidenceStoreLockSync(episodesDir, () => {
    const index = new EvidenceIndex({
      dbPath: indexPath,
      secureParent: indexPath === resolve(defaultEvidenceIndexPath(episodesDir)),
    });

    let scan: EvidenceScanResult;
    try {
      scan = scanEvidenceStore(episodesDir, options.repair ?? false);
      options.onScanComplete?.();
    } catch (error) {
      try {
        index.close();
      } catch {
        // Preserve the source-validation error; no source mutation occurred.
      }
      throw error;
    }

    try {
      index.replace(scan.indexed, scan.unreadable);
      scan.report.indexUpdated = true;
    } catch (error) {
      scan.report.indexUpdated = false;
      scan.report.indexError = readableReason(error);
    }

    try {
      index.close();
    } catch (error) {
      scan.report.indexUpdated = false;
      scan.report.indexError = scan.report.indexError
        ? `${scan.report.indexError}; close failed: ${readableReason(error)}`
        : `close failed: ${readableReason(error)}`;
    }
    return scan.report;
  });
}
