import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
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
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
  openVerifiedRegularForUpdate,
  readVerifiedText,
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
  | { kind: 'normalization-recovery-retained'; sourcePath: string; journalPath: string }
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
  /** @internal Race-regression seam; called after a source descriptor is pinned. */
  onBeforeSourceMutation?: (
    kind: 'normalize' | 'rescue-remove',
    sourcePath: string,
  ) => void;
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
  sourceText: string;
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

function readVerifiedJson(path: string): {
  raw: unknown;
  text: string;
  identity: FileIdentity;
} {
  const opened = openVerifiedRegular(path, 'evidence source');
  try {
    const text = readFileSync(opened.fd, 'utf8');
    return {
      raw: JSON.parse(text) as unknown,
      text,
      identity: opened.identity,
    };
  } finally {
    closeSync(opened.fd);
  }
}

interface NormalizeJournal {
  version: 1;
  sourceName: string;
  dev: number;
  ino: number;
  originalText: string;
  normalizedText: string;
  mutation: Extract<ReindexMutation, { kind: 'normalized-json' }>;
}

interface RescueJournal {
  version: 1;
  sourceName: string;
  targetName: string;
  quarantineName: string;
  dev: number;
  ino: number;
}

function writeRepairJournal(
  directory: string,
  prefix: string,
  payload: NormalizeJournal | RescueJournal,
  transactionId = randomUUID(),
): string {
  const path = join(directory, `${prefix}${transactionId}.txn`);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fsyncDirectory(directory);
  return path;
}

function removeRepairJournal(path: string): void {
  rmSync(path, { force: true });
  fsyncDirectory(dirname(path));
}

function writeUtf8AtStart(fd: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error('evidence file write made no progress');
    offset += written;
  }
}

function repairJson(
  path: string,
  value: unknown,
  expected: FileIdentity,
  originalText: string,
  mutation: ReindexMutation,
  onBeforeSourceMutation?: ReindexEvidenceStoreOptions['onBeforeSourceMutation'],
): FileIdentity {
  const directory = dirname(path);
  const normalizedText = `${JSON.stringify(value, null, 2)}\n`;
  const journalPath = writeRepairJournal(directory, '.jinn-normalize-', {
    version: 1,
    sourceName: basename(path),
    dev: expected.dev,
    ino: expected.ino,
    originalText,
    normalizedText,
    mutation: mutation as Extract<ReindexMutation, { kind: 'normalized-json' }>,
  });
  let fd: number | undefined;
  let writeStarted = false;
  try {
    const verified = openVerifiedRegularForUpdate(path, 'evidence source', expected);
    fd = verified.fd;
    onBeforeSourceMutation?.('normalize', path);
    writeStarted = true;
    ftruncateSync(fd, 0);
    writeUtf8AtStart(fd, normalizedText);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    assertRegularStat(written, path, 'normalized evidence source');
    if (!sameIdentity(identityFrom(written), expected)) {
      throw new Error(`evidence source descriptor changed during normalization: ${path}`);
    }
    const sourceAtCommit = lstatSync(path);
    assertRegularStat(sourceAtCommit, path, 'normalized evidence source');
    if (!sameIdentity(identityFrom(sourceAtCommit), expected)) {
      throw new EvidenceMutationCommittedError(
        `evidence source changed while its pinned descriptor was normalized: ${path}`,
        { kind: 'normalization-recovery-retained', sourcePath: path, journalPath },
        new Error(`pathname identity changed during normalization: ${path}`),
      );
    }
    removeRepairJournal(journalPath);
    return identityFrom(written);
  } catch (error) {
    if (!writeStarted || error instanceof EvidenceMutationCommittedError) throw error;
    try {
      if (fd === undefined) throw new Error('normalization descriptor is unavailable');
      ftruncateSync(fd, 0);
      writeUtf8AtStart(fd, originalText);
      fsyncSync(fd);
      const restoredPath = lstatSync(path);
      if (!sameIdentity(identityFrom(restoredPath), expected)) {
        throw new Error(`evidence source path changed before normalization rollback: ${path}`);
      }
      removeRepairJournal(journalPath);
      throw error;
    } catch (rollbackError) {
      if (rollbackError === error) throw error;
      throw new EvidenceMutationCommittedError(
        `evidence normalization was interrupted and its recovery journal was retained: `
          + `${journalPath}: ${readableReason(error)}; rollback failed: `
          + readableReason(rollbackError),
        { kind: 'normalization-recovery-retained', sourcePath: path, journalPath },
        error,
      );
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publishNoClobber(
  sourcePath: string,
  targetPath: string,
  expected: FileIdentity,
  mutation: ReindexMutation,
  onBeforeSourceMutation?: ReindexEvidenceStoreOptions['onBeforeSourceMutation'],
): FileIdentity {
  const opened = openVerifiedRegular(sourcePath, 'evidence source', expected);
  if (process.platform !== 'win32') fchmodSync(opened.fd, 0o600);
  const secured = opened.identity;
  const directory = dirname(sourcePath);
  const transactionId = randomUUID();
  const quarantineName = `.jinn-rescue-source-${transactionId}.hold`;
  const journalPath = writeRepairJournal(directory, '.jinn-rescue-', {
    version: 1,
    sourceName: basename(sourcePath),
    targetName: basename(targetPath),
    quarantineName,
    dev: secured.dev,
    ino: secured.ino,
  }, transactionId);
  let targetPublished = false;
  try {
    try {
      linkSync(sourcePath, targetPath);
      targetPublished = true;
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        removeRepairJournal(journalPath);
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
    fsyncDirectory(directory);

    onBeforeSourceMutation?.('rescue-remove', sourcePath);
    const quarantinePath = join(directory, quarantineName);
    renameSync(sourcePath, quarantinePath);
    const moved = lstatSync(quarantinePath);
    if (!moved.isFile() || moved.isSymbolicLink()) {
      throw new Error(`evidence source changed to an unsafe type before rescue: ${sourcePath}`);
    }
    assertSafeOwner(moved, quarantinePath, 'moved rescue source');
    const movedIdentity = identityFrom(moved);
    if (!sameIdentity(movedIdentity, secured)) {
      // The source pathname was replaced after its descriptor was pinned.
      // Restore that replacement with no-clobber link publication, then remove
      // only the proven random quarantine alias. The canonical rescue target
      // remains the original, descriptor-verified evidence.
      try {
        linkSync(quarantinePath, sourcePath);
        const restored = lstatSync(sourcePath);
        const quarantined = lstatSync(quarantinePath);
        if (
          !sameIdentity(identityFrom(restored), movedIdentity)
          || !sameIdentity(identityFrom(quarantined), movedIdentity)
        ) {
          throw new Error(`pathname replacement changed while being restored: ${sourcePath}`);
        }
        unlinkSync(quarantinePath);
        fsyncDirectory(directory);
        secureRegularPath(sourcePath, 'restored pathname replacement', movedIdentity);
        removeRepairJournal(journalPath);
      } catch (restoreError) {
        throw new EvidenceMutationCommittedError(
          `rescue target was published; a concurrent pathname replacement is retained at `
            + `${quarantinePath}: ${readableReason(restoreError)}`,
          { kind: 'rescue-target-published', sourcePath, targetPath },
          restoreError,
        );
      }
      throw new EvidenceMutationCommittedError(
        `rescue target was published without deleting a concurrent pathname replacement: `
          + sourcePath,
        { kind: 'rescue-target-published', sourcePath, targetPath },
        new Error(`evidence source changed before rescue finalization: ${sourcePath}`),
      );
    }

    unlinkSync(quarantinePath);
    const targetAfterUnlink = lstatSync(targetPath);
    assertRegularStat(targetAfterUnlink, targetPath, 'rescue target');
    if (!sameIdentity(identityFrom(targetAfterUnlink), secured)) {
      throw new Error(`rescue target changed after source finalization: ${targetPath}`);
    }
    fsyncDirectory(directory);
    removeRepairJournal(journalPath);
    return secured;
  } catch (error) {
    if (!targetPublished) {
      removeRepairJournal(journalPath);
      throw error;
    }
    if (error instanceof EvidenceMutationCommittedError) throw error;
    throw new EvidenceMutationCommittedError(
      `rescue target was published and its recovery journal was retained: `
        + `${journalPath}: ${readableReason(error)}`,
      { kind: 'rescue-target-published', sourcePath, targetPath },
      error,
    );
  } finally {
    closeSync(opened.fd);
  }
}

function safeJournalEntryName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && basename(value) === value;
}

function readJournal(path: string): unknown {
  return JSON.parse(readVerifiedText(path, 'evidence repair journal').text) as unknown;
}

function asNormalizeJournal(value: unknown): NormalizeJournal | undefined {
  const object = asObject(value);
  const mutation = asObject(object?.['mutation']);
  if (
    object?.['version'] !== 1
    || !safeJournalEntryName(object['sourceName'])
    || typeof object['dev'] !== 'number'
    || typeof object['ino'] !== 'number'
    || typeof object['originalText'] !== 'string'
    || typeof object['normalizedText'] !== 'string'
    || mutation?.['kind'] !== 'normalized-json'
    || typeof mutation['sourcePath'] !== 'string'
    || typeof mutation['nullFieldsRemoved'] !== 'number'
  ) {
    return undefined;
  }
  return object as unknown as NormalizeJournal;
}

function asRescueJournal(value: unknown): RescueJournal | undefined {
  const object = asObject(value);
  if (
    object?.['version'] !== 1
    || !safeJournalEntryName(object['sourceName'])
    || !safeJournalEntryName(object['targetName'])
    || !safeJournalEntryName(object['quarantineName'])
    || typeof object['dev'] !== 'number'
    || typeof object['ino'] !== 'number'
  ) {
    return undefined;
  }
  return object as unknown as RescueJournal;
}

function rawOwnedRegularIdentity(path: string, label: string): FileIdentity | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${label} must be a regular file: ${path}`);
    }
    assertSafeOwner(info, path, label);
    return identityFrom(info);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function recoverInterruptedRepairs(directory: string): {
  mutations: ReindexMutation[];
  unreadable: UnreadableEvidence[];
} {
  const mutations: ReindexMutation[] = [];
  const unreadable: UnreadableEvidence[] = [];
  const names = readdirSync(directory).sort();

  for (const name of names.filter((entry) =>
    /^\.jinn-normalize-[0-9a-f-]{36}\.txn$/i.test(entry))) {
    const journalPath = join(directory, name);
    try {
      const journal = asNormalizeJournal(readJournal(journalPath));
      if (!journal) throw new Error(`invalid evidence normalization journal: ${journalPath}`);
      const sourcePath = join(directory, journal.sourceName);
      if (
        resolve(journal.mutation.sourcePath) !== resolve(sourcePath)
        || !Number.isSafeInteger(journal.dev)
        || !Number.isSafeInteger(journal.ino)
        || !Number.isSafeInteger(journal.mutation.nullFieldsRemoved)
        || journal.mutation.nullFieldsRemoved < 1
      ) {
        throw new Error(`inconsistent evidence normalization journal: ${journalPath}`);
      }
      const expected: FileIdentity = {
        dev: journal.dev,
        ino: journal.ino,
        uid: process.platform === 'win32' ? 0 : process.getuid?.() ?? 0,
        nlink: 1,
      };
      const current = inspectRegularPath(sourcePath, 'journaled evidence source');
      if (!current || !sameIdentity(current, expected)) {
        throw new Error(
          `journaled evidence source changed; recovery retained for inspection: ${sourcePath}`,
        );
      }
      const opened = openVerifiedRegularForUpdate(
        sourcePath,
        'journaled evidence source',
        expected,
      );
      try {
        const text = readFileSync(opened.fd, 'utf8');
        if (text === journal.normalizedText) {
          mutations.push(journal.mutation);
        } else if (text !== journal.originalText) {
          ftruncateSync(opened.fd, 0);
          writeUtf8AtStart(opened.fd, journal.originalText);
          fsyncSync(opened.fd);
        }
      } finally {
        closeSync(opened.fd);
      }
      secureRegularPath(sourcePath, 'recovered evidence source', expected);
      removeRepairJournal(journalPath);
    } catch (error) {
      unreadable.push({ sourcePath: journalPath, reason: readableReason(error) });
    }
  }

  for (const name of names.filter((entry) =>
    /^\.jinn-rescue-[0-9a-f-]{36}\.txn$/i.test(entry))) {
    const journalPath = join(directory, name);
    try {
      const journal = asRescueJournal(readJournal(journalPath));
      if (!journal) throw new Error(`invalid evidence rescue journal: ${journalPath}`);
      const transactionId = name.slice(
        '.jinn-rescue-'.length,
        -'.txn'.length,
      );
      if (
        !journal.sourceName.endsWith('.json')
        || journal.sourceName.endsWith('.episode.json')
        || !journal.targetName.endsWith('.episode.json')
        || journal.quarantineName !== `.jinn-rescue-source-${transactionId}.hold`
        || !Number.isSafeInteger(journal.dev)
        || !Number.isSafeInteger(journal.ino)
      ) {
        throw new Error(`inconsistent evidence rescue journal: ${journalPath}`);
      }
      const sourcePath = join(directory, journal.sourceName);
      const targetPath = join(directory, journal.targetName);
      const quarantinePath = join(directory, journal.quarantineName);
      const expected: FileIdentity = {
        dev: journal.dev,
        ino: journal.ino,
        uid: process.platform === 'win32' ? 0 : process.getuid?.() ?? 0,
        nlink: 1,
      };
      let source = rawOwnedRegularIdentity(sourcePath, 'journaled rescue source');
      let target = rawOwnedRegularIdentity(targetPath, 'journaled rescue target');
      let quarantine = rawOwnedRegularIdentity(
        quarantinePath,
        'journaled rescue quarantine',
      );
      let sourceMatches = source !== undefined && sameIdentity(source, expected);
      const targetMatches = target !== undefined && sameIdentity(target, expected);

      if (!target && sourceMatches && source?.nlink === 1 && !quarantine) {
        removeRepairJournal(journalPath);
        continue;
      }
      if (!targetMatches) {
        throw new Error(
          `journaled rescue target changed; recovery retained for inspection: ${targetPath}`,
        );
      }
      if (quarantine) {
        if (sameIdentity(quarantine, expected)) {
          if (target?.nlink !== 2) {
            throw new Error(`journaled rescue quarantine has an unsafe link count: ${targetPath}`);
          }
          unlinkSync(quarantinePath);
          fsyncDirectory(directory);
        } else {
          if (target?.nlink !== 1) {
            throw new Error(
              `journaled pathname replacement has an unsafe target link count: ${targetPath}`,
            );
          }
          if (!source) {
            linkSync(quarantinePath, sourcePath);
            source = rawOwnedRegularIdentity(sourcePath, 'restored pathname replacement');
          }
          if (
            !source
            || !sameIdentity(source, quarantine)
            || source.nlink !== 2
            || quarantine.nlink !== 2
          ) {
            throw new Error(
              `journaled pathname replacement could not be safely restored: ${sourcePath}`,
            );
          }
          unlinkSync(quarantinePath);
          fsyncDirectory(directory);
          secureRegularPath(sourcePath, 'restored pathname replacement', source);
        }
        source = rawOwnedRegularIdentity(sourcePath, 'journaled rescue source');
        target = rawOwnedRegularIdentity(targetPath, 'journaled rescue target');
        quarantine = rawOwnedRegularIdentity(
          quarantinePath,
          'journaled rescue quarantine',
        );
        sourceMatches = source !== undefined && sameIdentity(source, expected);
        if (quarantine) {
          throw new Error(`journaled rescue quarantine was not removed: ${quarantinePath}`);
        }
      }
      if (sourceMatches) {
        if (source?.nlink !== 2 || target?.nlink !== 2) {
          throw new Error(`journaled rescue link count is inconsistent: ${targetPath}`);
        }
        renameSync(sourcePath, quarantinePath);
        const moved = rawOwnedRegularIdentity(quarantinePath, 'journaled rescue source');
        if (!moved || !sameIdentity(moved, expected)) {
          throw new Error(`journaled rescue source changed during recovery: ${sourcePath}`);
        }
        unlinkSync(quarantinePath);
        fsyncDirectory(directory);
      } else if (target?.nlink !== 1) {
        throw new Error(`journaled rescue target has an unsafe link count: ${targetPath}`);
      }
      secureRegularPath(targetPath, 'recovered rescue target', expected);
      removeRepairJournal(journalPath);
      mutations.push({
        kind: 'rescued-misnamed-episode',
        sourcePath,
        targetPath,
      });
    } catch (error) {
      unreadable.push({ sourcePath: journalPath, reason: readableReason(error) });
    }
  }

  return { mutations, unreadable };
}

function isInterruptedRepairArtifact(name: string): boolean {
  return /^\.jinn-(?:normalize|rescue)-[0-9a-f-]{36}\.txn$/i.test(name)
    || /^\.jinn-rescue-source-[0-9a-f-]{36}\.hold$/i.test(name);
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

function scanEvidenceStore(
  episodesDirInput: string,
  repair: boolean,
  onBeforeSourceMutation?: ReindexEvidenceStoreOptions['onBeforeSourceMutation'],
): EvidenceScanResult {
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
    if (repair) {
      const recovered = recoverInterruptedRepairs(episodesDir);
      mutations.push(...recovered.mutations);
      unreadable.push(...recovered.unreadable);
      scannedFiles += recovered.unreadable.length;
      for (const mutation of recovered.mutations) {
        if (mutation.kind === 'normalized-json') {
          nullToleratedFiles += 1;
          nullFieldsRemoved += mutation.nullFieldsRemoved;
        } else if (mutation.kind === 'rescued-misnamed-episode') {
          misnamedEpisodes += 1;
          renamedFiles += 1;
        }
      }
    }
    const entries = readdirSync(episodesDir).sort();
    const reported = new Set(unreadable.map((row) => resolve(row.sourcePath)));
    for (const name of entries.filter(isInterruptedRepairArtifact)) {
      const artifactPath = join(episodesDir, name);
      if (reported.has(resolve(artifactPath))) continue;
      unreadable.push({
        sourcePath: artifactPath,
        reason: 'interrupted evidence repair state requires reindex --repair --json',
      });
      scannedFiles += 1;
    }
    files = entries.filter((name) => name.endsWith('.json'));
  }

  for (const name of files) {
    scannedFiles += 1;
    const sourcePath = join(episodesDir, name);
    try {
      if (repair) secureRegularPath(sourcePath, 'evidence source');
      const { raw, text, identity } = readVerifiedJson(sourcePath);
      const parsed = parseFile(raw, name.endsWith('.episode.json'));
      if (parsed.nullCount > 0) nullToleratedFiles += 1;
      if (parsed.sourceKind === 'misnamed-episode') misnamedEpisodes += 1;
      const episodeJson = JSON.stringify(parsed.episode);
      const episodeCandidates = candidates.get(parsed.episode.episodeId) ?? [];
      episodeCandidates.push({
        sourcePath,
        sourceText: text,
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
    const { sourcePath, sourceText, parsed } = candidate;
    let identity = candidate.identity;
    let finalPath = sourcePath;
    try {
      if (repair && parsed.nullCount > 0) {
        const mutation: ReindexMutation = {
          kind: 'normalized-json',
          sourcePath,
          nullFieldsRemoved: parsed.nullCount,
        };
        identity = repairJson(
          sourcePath,
          parsed.normalizedRaw,
          identity,
          sourceText,
          mutation,
          onBeforeSourceMutation,
        );
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
        identity = publishNoClobber(
          sourcePath,
          targetPath,
          identity,
          mutation,
          onBeforeSourceMutation,
        );
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
      scan = scanEvidenceStore(
        episodesDir,
        options.repair ?? false,
        options.onBeforeSourceMutation,
      );
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
