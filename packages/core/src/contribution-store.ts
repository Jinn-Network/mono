import {
  access,
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  ContributionCandidateV1Schema,
  ContributionCandidateV1ProjectionSchema,
  EpisodeV1Schema,
  type ContributionCandidateV1,
  type EpisodeV1,
  type ContributionLocalState,
  type ContributionPublicationState,
} from '@jinn-network/plugin';
import { fsyncDirectory } from './evidence-filesystem.js';

export const CONTRIBUTION_STORE_SCHEMA_VERSION = 'jinn.contribution-store.v3' as const;
const CONTRIBUTION_STORE_V2_SCHEMA_VERSION = 'jinn.contribution-store.v2' as const;
export const CONTRIBUTION_STORE_FILE = 'mineable-traces.json' as const;
export const CONTRIBUTION_PUBLICATION_DISABLED_FILE = 'publication-disabled' as const;
export const CONTRIBUTION_PUBLICATION_SCHEMA_VERSION = 'jinn.contribution-publication.v1' as const;
export const DEFAULT_CONTRIBUTION_STATE_DIR = join(homedir(), '.jinn-client', 'mineable');

export function resolveContributionStateDir(
  env: { JINN_MINEABLE_STATE_DIR?: string } = process.env,
): string {
  const configured = env.JINN_MINEABLE_STATE_DIR?.trim();
  return configured || DEFAULT_CONTRIBUTION_STATE_DIR;
}

export interface ContributionLocalMetadata {
  /** Compatibility-only task kind; never included in an outbound projection. */
  kind?: 'solvernet-execution' | 'harness-session';
  /** Compatibility-only source task reference for second-generation guards. */
  sourceInstanceId?: string;
}

export interface ContributionStoreRecord {
  recordId: string;
  localState: ContributionLocalState;
  publicationState: ContributionPublicationState;
  mintRef?: string;
  publicationRef?: string;
  rejectionReason?: string;
}

interface ContributionStoreFile {
  schemaVersion: typeof CONTRIBUTION_STORE_SCHEMA_VERSION;
  firstSharePreviewAcknowledgedAt?: string;
  records: Record<string, ContributionStoreRecord>;
}

export interface ContributionPublicationV1 {
  schemaVersion: typeof CONTRIBUTION_PUBLICATION_SCHEMA_VERSION;
  repositorySlug: string;
  baseCommit: string;
  mintRef: string;
}

export interface ContributionStoreLockOptions {
  retryDelayMs?: number;
  maxRetries?: number;
  staleAfterMs?: number;
}

export interface ContributionStoreOptions {
  stateDir?: string;
  filePath?: string;
  lock?: ContributionStoreLockOptions;
  publicationLock?: ContributionStoreLockOptions;
  /** Lock-clock seam only. Candidate timestamps always come from the caller. */
  nowMs?: () => number;
}

export interface ContributionStoreRecordOptions {
  publicationState?: 'vetoed';
}

export interface ContributionStoreReferenceOptions extends ContributionStoreRecordOptions {
  /** Transition input only; never serialized in the reference store. */
  publishMinedTasksConsent?: boolean;
}

const DEFAULT_LOCK = {
  retryDelayMs: 20,
  maxRetries: 50,
  staleAfterMs: 120_000,
};

const localLockTails = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function freshStore(): ContributionStoreFile {
  return { schemaVersion: CONTRIBUTION_STORE_SCHEMA_VERSION, records: Object.create(null) };
}

function contributionRecordMap(
  entries: Array<[string, ContributionStoreRecord]>,
): Record<string, ContributionStoreRecord> {
  const records: Record<string, ContributionStoreRecord> = Object.create(null);
  for (const [recordId, record] of entries) records[recordId] = record;
  return records;
}

function ownRecord(
  file: ContributionStoreFile,
  recordId: string,
): ContributionStoreRecord | undefined {
  return Object.prototype.hasOwnProperty.call(file.records, recordId)
    ? file.records[recordId]
    : undefined;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid contribution store ${field}`);
  }
  return value;
}

function parseLocalState(value: unknown): ContributionLocalState {
  if (value === 'recorded' || value === 'minted' || value === 'rejected') return value;
  throw new Error(`invalid contribution local state: ${String(value)}`);
}

function parsePublicationState(value: unknown): ContributionPublicationState {
  if (
    value === 'disabled' ||
    value === 'preview-required' ||
    value === 'queued' ||
    value === 'published' ||
    value === 'vetoed'
  ) return value;
  throw new Error(`invalid contribution publication state: ${String(value)}`);
}

function parseRecord(recordId: string, value: unknown): ContributionStoreRecord {
  if (!value || typeof value !== 'object') throw new Error(`invalid contribution record ${recordId}`);
  const raw = value as Record<string, unknown>;
  if (raw['recordId'] !== recordId) throw new Error(`contribution record key/id mismatch: ${recordId}`);
  const allowed = new Set([
    'recordId',
    'localState',
    'publicationState',
    'mintRef',
    'publicationRef',
    'rejectionReason',
  ]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`invalid contribution record ${recordId}: unexpected fields ${unknown.join(', ')}`);
  }
  const mintRef = optionalNonEmptyString(raw['mintRef'], 'mintRef');
  const publicationRef = optionalNonEmptyString(raw['publicationRef'], 'publicationRef');
  const rejectionReason = optionalNonEmptyString(raw['rejectionReason'], 'rejectionReason');
  return {
    recordId,
    localState: parseLocalState(raw['localState']),
    publicationState: parsePublicationState(raw['publicationState']),
    ...(mintRef ? { mintRef } : {}),
    ...(publicationRef ? { publicationRef } : {}),
    ...(rejectionReason ? { rejectionReason } : {}),
  };
}

function parseV3File(raw: unknown): ContributionStoreFile {
  if (!raw || typeof raw !== 'object') throw new Error('invalid contribution store: expected object');
  const value = raw as Record<string, unknown>;
  if (value['schemaVersion'] !== CONTRIBUTION_STORE_SCHEMA_VERSION) {
    throw new Error(`unsupported contribution store schema: ${String(value['schemaVersion'])}`);
  }
  if (!value['records'] || typeof value['records'] !== 'object' || Array.isArray(value['records'])) {
    throw new Error('invalid contribution store records');
  }
  const previewAt = optionalNonEmptyString(
    value['firstSharePreviewAcknowledgedAt'],
    'firstSharePreviewAcknowledgedAt',
  );
  return {
    schemaVersion: CONTRIBUTION_STORE_SCHEMA_VERSION,
    ...(previewAt ? { firstSharePreviewAcknowledgedAt: previewAt } : {}),
    records: contributionRecordMap(
      Object.entries(value['records'] as Record<string, unknown>)
        .map(([id, record]): [string, ContributionStoreRecord] => [id, parseRecord(id, record)]),
    ),
  };
}

function migrateLegacyRecord(recordId: string, rawValue: unknown): ContributionStoreRecord {
  if (!rawValue || typeof rawValue !== 'object') throw new Error(`invalid v1 record ${recordId}`);
  const raw = rawValue as Record<string, unknown>;
  const sourceId = typeof raw['sourceId'] === 'string' && raw['sourceId'].length > 0
    ? raw['sourceId']
    : recordId;
  if (sourceId !== recordId) {
    throw new Error(`v1 contribution record key/sourceId mismatch: ${recordId}`);
  }
  // Validate the payload before preserving it in the loss-safe backup only.
  ContributionCandidateV1Schema.parse({
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId,
    repositorySlug: raw['repo'],
    baseCommit: raw['baseCommit'],
    acceptedDiff: raw['acceptedDiff'],
    testRuns: Array.isArray(raw['testRuns']) ? raw['testRuns'].map((run) => {
      const value = run as Record<string, unknown>;
      return { command: value['command'] ?? value['cmd'], exitCode: value['exitCode'], at: value['at'] };
    }) : [],
    intermediateFailureDiffs: Array.isArray(raw['intermediateFailureDiffs'])
      ? raw['intermediateFailureDiffs']
      : [],
    skillEvents: Array.isArray(raw['skillEvents']) ? raw['skillEvents'].map((event) => {
      const value = event as Record<string, unknown>;
      return { skillRef: value['skillRef'] ?? value['skill'], action: value['action'] };
    }) : [],
    // Legacy consent never becomes durable v2 publication authorization.
    publishMinedTasksConsent: false,
    createdAt: raw['createdAt'],
  });
  const processed = raw['mined'] === true;
  return {
    recordId,
    localState: processed ? 'rejected' : 'recorded',
    publicationState: 'disabled',
    ...(processed ? { rejectionReason: 'legacy-processed-unavailable' } : {}),
  };
}

function migrateV1File(raw: unknown): ContributionStoreFile {
  if (!raw || typeof raw !== 'object') throw new Error('invalid v1 mineable store: expected object');
  const value = raw as Record<string, unknown>;
  if (value['schemaVersion'] !== 'mineable-trace-store.v1') {
    throw new Error(`unsupported contribution store schema: ${String(value['schemaVersion'])}`);
  }
  if (!value['records'] || typeof value['records'] !== 'object' || Array.isArray(value['records'])) {
    throw new Error('invalid v1 mineable store records');
  }
  return {
    schemaVersion: CONTRIBUTION_STORE_SCHEMA_VERSION,
    records: contributionRecordMap(
      Object.entries(value['records'] as Record<string, unknown>)
        .map(([id, record]): [string, ContributionStoreRecord] => [id, migrateLegacyRecord(id, record)]),
    ),
  };
}

function migrateV2Record(recordId: string, rawValue: unknown): ContributionStoreRecord {
  if (!rawValue || typeof rawValue !== 'object') throw new Error(`invalid v2 record ${recordId}`);
  const raw = rawValue as Record<string, unknown>;
  if (raw['recordId'] !== recordId) {
    throw new Error(`v2 contribution record key/id mismatch: ${recordId}`);
  }
  const candidate = ContributionCandidateV1Schema.parse(raw['candidate']);
  if (candidate.sourceId !== recordId) {
    throw new Error(`v2 contribution record key/sourceId mismatch: ${recordId}`);
  }
  const publicationState = parsePublicationState(raw['publicationState']);
  const mintRef = optionalNonEmptyString(raw['mintRef'], 'mintRef');
  const publicationRef = optionalNonEmptyString(raw['publicationRef'], 'publicationRef');
  const rejectionReason = optionalNonEmptyString(raw['rejectionReason'], 'rejectionReason');
  return {
    recordId,
    localState: parseLocalState(raw['localState']),
    publicationState:
      publicationState === 'preview-required' || publicationState === 'queued'
        ? 'disabled'
        : publicationState,
    ...(mintRef ? { mintRef } : {}),
    ...(publicationRef ? { publicationRef } : {}),
    ...(rejectionReason ? { rejectionReason } : {}),
  };
}

function migrateV2File(raw: unknown): ContributionStoreFile {
  if (!raw || typeof raw !== 'object') throw new Error('invalid v2 contribution store: expected object');
  const value = raw as Record<string, unknown>;
  if (value['schemaVersion'] !== CONTRIBUTION_STORE_V2_SCHEMA_VERSION) {
    throw new Error(`unsupported contribution store schema: ${String(value['schemaVersion'])}`);
  }
  if (!value['records'] || typeof value['records'] !== 'object' || Array.isArray(value['records'])) {
    throw new Error('invalid v2 contribution store records');
  }
  const previewAt = optionalNonEmptyString(
    value['firstSharePreviewAcknowledgedAt'],
    'firstSharePreviewAcknowledgedAt',
  );
  return {
    schemaVersion: CONTRIBUTION_STORE_SCHEMA_VERSION,
    ...(previewAt ? { firstSharePreviewAcknowledgedAt: previewAt } : {}),
    records: contributionRecordMap(
      Object.entries(value['records'] as Record<string, unknown>)
        .map(([id, record]): [string, ContributionStoreRecord] => [id, migrateV2Record(id, record)]),
    ),
  };
}

/**
 * Cacheless, cross-process-safe contribution store. Every mutation acquires a
 * mkdir-based lock and performs a fresh read-modify-atomic-rename cycle.
 */
export class ContributionStore {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly publicationLockPath: string;
  private readonly publicationDisabledPath: string;
  private readonly lock: Required<ContributionStoreLockOptions>;
  private readonly publicationLock: Required<ContributionStoreLockOptions>;
  private readonly nowMs: () => number;

  constructor(options: ContributionStoreOptions) {
    if (!options.filePath && !options.stateDir) {
      throw new Error('ContributionStore requires stateDir or filePath');
    }
    this.filePath = resolvePath(options.filePath ?? join(options.stateDir!, CONTRIBUTION_STORE_FILE));
    this.lockPath = `${this.filePath}.lock`;
    this.publicationLockPath = `${this.filePath}.publication.lock`;
    this.publicationDisabledPath = join(dirname(this.filePath), CONTRIBUTION_PUBLICATION_DISABLED_FILE);
    this.lock = { ...DEFAULT_LOCK, ...options.lock };
    this.publicationLock = {
      ...DEFAULT_LOCK,
      maxRetries: 3_000,
      ...options.publicationLock,
    };
    this.nowMs = options.nowMs ?? Date.now;
  }

  private async tryRecoverStaleLock(
    lockPath: string,
    options: Required<ContributionStoreLockOptions>,
  ): Promise<boolean> {
    const recoveryPath = `${lockPath}.recovery`;
    const recoveryOwner = await this.acquireRecoveryGuard(recoveryPath, options);
    if (!recoveryOwner) return false;
    try {
      let lockStat;
      try {
        lockStat = await stat(lockPath);
      } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') return true;
        throw error;
      }
      if (this.nowMs() - lockStat.mtimeMs <= options.staleAfterMs) return false;

      let ownerAlive = false;
      try {
        const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };
        if (typeof owner.pid === 'number' && Number.isInteger(owner.pid)) {
          try {
            process.kill(owner.pid, 0);
            ownerAlive = true;
          } catch (error) {
            ownerAlive = nodeErrorCode(error) === 'EPERM';
          }
        }
      } catch {
        // An ownerless stale directory is safe to recover while this exclusive
        // recovery lock prevents a second contender deleting its successor.
      }
      if (ownerAlive) return false;
      await rm(lockPath, { recursive: true, force: true });
      return true;
    } finally {
      try {
        await access(join(recoveryPath, recoveryOwner));
        await rm(recoveryPath, { recursive: true, force: true });
      } catch {
        // A guard may only disappear after a later stale owner claimed it.
        // Never remove a recovery directory we can no longer prove is ours.
      }
    }
  }

  private ownerProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return nodeErrorCode(error) === 'EPERM';
    }
  }

  private recoveryOwnerName(kind: 'owner' | 'claim'): string {
    return `${kind}.${Math.trunc(this.nowMs())}.${process.pid}.${randomUUID()}.json`;
  }

  private recoveryOwnerMetadata(name: string): { createdAtMs: number; pid: number } | null {
    const match = /^(?:owner|claim)\.(-?\d+)\.(\d+)\.[0-9a-f-]+\.json$/u.exec(name);
    if (!match) return null;
    const createdAtMs = Number(match[1]);
    const pid = Number(match[2]);
    return Number.isFinite(createdAtMs) && Number.isInteger(pid) ? { createdAtMs, pid } : null;
  }

  private async acquireRecoveryGuard(
    recoveryPath: string,
    options: Required<ContributionStoreLockOptions>,
  ): Promise<string | null> {
    const ownerName = this.recoveryOwnerName('owner');
    try {
      await mkdir(recoveryPath, { mode: 0o700 });
      await writeFile(join(recoveryPath, ownerName), '', { flag: 'wx', mode: 0o600 });
      return ownerName;
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') {
        // If mkdir succeeded but the owner write did not, leave an ownerless
        // directory for the conservative stale protocol below.
        throw error;
      }
    }

    let names: string[];
    try {
      names = await readdir(recoveryPath);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return null;
      throw error;
    }
    const namedOwner = names
      .map((name) => ({ name, metadata: this.recoveryOwnerMetadata(name) }))
      .find((entry) => entry.metadata !== null);
    if (namedOwner?.metadata) {
      if (
        this.nowMs() - namedOwner.metadata.createdAtMs <= options.staleAfterMs ||
        this.ownerProcessAlive(namedOwner.metadata.pid)
      ) return null;
      const claimName = this.recoveryOwnerName('claim');
      try {
        await rename(join(recoveryPath, namedOwner.name), join(recoveryPath, claimName));
        return claimName;
      } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') return null;
        throw error;
      }
    }

    const ownerlessClaim = join(recoveryPath, 'ownerless.claim');
    if (names.includes('ownerless.claim')) {
      try {
        const raw = JSON.parse(await readFile(ownerlessClaim, 'utf8')) as {
          createdAtMs?: unknown;
          pid?: unknown;
        };
        if (
          typeof raw.createdAtMs === 'number' &&
          typeof raw.pid === 'number' &&
          (this.nowMs() - raw.createdAtMs <= options.staleAfterMs || this.ownerProcessAlive(raw.pid))
        ) return null;
      } catch {
        const claimStat = await stat(ownerlessClaim).catch(() => null);
        if (claimStat && this.nowMs() - claimStat.mtimeMs <= options.staleAfterMs) return null;
      }
      const claimName = this.recoveryOwnerName('claim');
      try {
        await rename(ownerlessClaim, join(recoveryPath, claimName));
        return claimName;
      } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') return null;
        throw error;
      }
    }

    const recoveryStat = await stat(recoveryPath).catch(() => null);
    if (!recoveryStat || this.nowMs() - recoveryStat.mtimeMs <= options.staleAfterMs) return null;
    try {
      await writeFile(ownerlessClaim, JSON.stringify({
        createdAtMs: this.nowMs(),
        pid: process.pid,
      }), { flag: 'wx', mode: 0o600 });
      return 'ownerless.claim';
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') return null;
      throw error;
    }
  }

  private async acquireLockAt(
    lockPath: string,
    options: Required<ContributionStoreLockOptions>,
  ): Promise<string> {
    const parent = dirname(this.filePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    let retries = 0;
    while (true) {
      try {
        const token = randomUUID();
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeFile(
            join(lockPath, 'owner.json'),
            JSON.stringify({ token, pid: process.pid }),
            { encoding: 'utf8', mode: 0o600 },
          );
        } catch (ownerError) {
          await rm(lockPath, { recursive: true, force: true });
          throw ownerError;
        }
        return token;
      } catch (error) {
        if (nodeErrorCode(error) !== 'EEXIST') throw error;
        if (await this.tryRecoverStaleLock(lockPath, options)) continue;
        if (retries >= options.maxRetries) {
          throw new Error(`contribution store lock acquisition failed after ${options.maxRetries} retries`);
        }
        retries += 1;
        await sleep(options.retryDelayMs);
      }
    }
  }

  private async withLockAt<T>(
    lockPath: string,
    options: Required<ContributionStoreLockOptions>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = localLockTails.get(lockPath) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => turn);
    localLockTails.set(lockPath, tail);
    await previous.catch(() => undefined);
    try {
      const token = await this.acquireLockAt(lockPath, options);
      try {
        return await operation();
      } finally {
        try {
          const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { token?: unknown };
          if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
        } catch (error) {
          // A missing/corrupt owner record is never permission to remove a lock
          // we cannot prove is ours. Stale recovery handles it later.
        }
      }
    } finally {
      release();
      if (localLockTails.get(lockPath) === tail) localLockTails.delete(lockPath);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLockAt(this.lockPath, this.lock, operation);
  }

  private async withPublicationLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLockAt(this.publicationLockPath, this.publicationLock, operation);
  }

  private async writeAtomic(file: ContributionStoreFile): Promise<void> {
    const tmp = `${this.filePath}.${process.pid}.${this.nowMs()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private async preserveMigrationBackup(
    version: 'v1' | 'v2',
    sourceText: string,
  ): Promise<void> {
    const backupPath = `${this.filePath}.${version}.bak`;
    const tempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(sourceText, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(tempPath, backupPath);
      fsyncDirectory(dirname(backupPath));
      await rm(tempPath, { force: true });
      fsyncDirectory(dirname(backupPath));
      return;
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true });
    }
    const existing = await readFile(backupPath, 'utf8');
    if (existing !== sourceText) {
      throw new Error(
        `existing contribution store ${version} backup does not match active store; refusing migration`,
      );
    }
    const existingHandle = await open(backupPath, 'r+');
    try {
      await existingHandle.chmod(0o600);
      await existingHandle.sync();
    } finally {
      await existingHandle.close();
    }
    fsyncDirectory(dirname(backupPath));
  }

  private async loadUnlocked(): Promise<ContributionStoreFile> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return freshStore();
      throw error;
    }
    const raw = JSON.parse(text) as unknown;
    const schemaVersion = raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)['schemaVersion']
      : undefined;
    if (schemaVersion === 'mineable-trace-store.v1') {
      await this.preserveMigrationBackup('v1', text);
      const migrated = migrateV1File(raw);
      await this.writeAtomic(migrated);
      return migrated;
    }
    if (schemaVersion === CONTRIBUTION_STORE_V2_SCHEMA_VERSION) {
      await this.preserveMigrationBackup('v2', text);
      const migrated = migrateV2File(raw);
      await this.writeAtomic(migrated);
      return migrated;
    }
    return parseV3File(raw);
  }

  private async mutate<T>(operation: (file: ContributionStoreFile) => T): Promise<T> {
    return this.withLock(async () => {
      const file = await this.loadUnlocked();
      const result = operation(file);
      await this.writeAtomic(file);
      return result;
    });
  }

  private async publicationDisabledUnlocked(): Promise<boolean> {
    try {
      await access(this.publicationDisabledPath);
      return true;
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async record(
    candidateInput: ContributionCandidateV1,
    _localMetadata?: ContributionLocalMetadata,
    options?: ContributionStoreRecordOptions,
  ): Promise<ContributionStoreRecord> {
    const candidate = ContributionCandidateV1Schema.parse(candidateInput);
    return this.recordReference(candidate.sourceId, {
      publishMinedTasksConsent: candidate.publishMinedTasksConsent,
      ...options,
    });
  }

  async recordReference(
    episodeId: string,
    options: ContributionStoreReferenceOptions = {},
  ): Promise<ContributionStoreRecord> {
    if (typeof episodeId !== 'string' || episodeId.length === 0) {
      throw new Error('contribution episode reference must not be empty');
    }
    return this.withLock(async () => {
      const file = await this.loadUnlocked();
      const existing = ownRecord(file, episodeId);
      if (existing) return existing;
      const globallyDisabled = await this.publicationDisabledUnlocked();
      const record: ContributionStoreRecord = {
        recordId: episodeId,
        localState: 'recorded',
        publicationState: options?.publicationState ??
          (options.publishMinedTasksConsent && !globallyDisabled
            ? (file.firstSharePreviewAcknowledgedAt ? 'queued' : 'preview-required')
            : 'disabled'),
      };
      file.records[record.recordId] = record;
      await this.writeAtomic(file);
      return record;
    });
  }

  async get(recordId: string): Promise<ContributionStoreRecord | undefined> {
    return this.withLock(async () => (await this.loadUnlocked()).records[recordId]);
  }

  async list(): Promise<ContributionStoreRecord[]> {
    return this.withLock(async () => Object.values((await this.loadUnlocked()).records));
  }

  async listRecorded(): Promise<ContributionStoreRecord[]> {
    return (await this.list()).filter((record) => record.localState === 'recorded');
  }

  async authorize(recordId: string, acknowledgedAt: string): Promise<ContributionStoreRecord> {
    return this.withLock(async () => {
      const file = await this.loadUnlocked();
      if (await this.publicationDisabledUnlocked()) {
        throw new Error('contribution publication is globally disabled');
      }
      const record = this.requireRecord(file, recordId);
      if (record.publicationState === 'published') this.throwPublishedImmutable(recordId);
      if (record.publicationState === 'vetoed') throw new Error(`contribution ${recordId} is vetoed`);
      if (record.localState === 'rejected') throw new Error(`contribution ${recordId} is rejected`);
      if (record.publicationState === 'disabled') throw new Error(`contribution ${recordId} publication is disabled`);
      if (record.publicationState === 'preview-required') {
        file.firstSharePreviewAcknowledgedAt = acknowledgedAt;
        for (const candidate of Object.values(file.records)) {
          if (candidate.publicationState === 'preview-required' && candidate.localState !== 'rejected') {
            candidate.publicationState = 'queued';
          }
        }
      }
      await this.writeAtomic(file);
      return record;
    });
  }

  async markMinted(recordId: string, mintRef?: string): Promise<ContributionStoreRecord> {
    return this.mutate((file) => {
      const record = this.requireRecord(file, recordId);
      if (record.publicationState === 'published') this.throwPublishedImmutable(recordId);
      if (record.localState === 'rejected') throw new Error(`contribution ${recordId} is rejected`);
      record.localState = 'minted';
      if (mintRef !== undefined) {
        if (mintRef.length === 0) throw new Error('mintRef must not be empty');
        record.mintRef = mintRef;
      }
      return record;
    });
  }

  async markRejected(recordId: string, reason?: string): Promise<ContributionStoreRecord> {
    return this.withPublicationLock(async () => this.mutate((file) => {
        const record = this.requireRecord(file, recordId);
        if (record.publicationState === 'published') this.throwPublishedImmutable(recordId);
        if (record.localState === 'minted') throw new Error(`contribution ${recordId} is already minted`);
        record.localState = 'rejected';
        if (record.publicationState !== 'vetoed') record.publicationState = 'disabled';
        if (reason !== undefined) {
          if (reason.length === 0) throw new Error('rejection reason must not be empty');
          record.rejectionReason = reason;
        }
        return record;
      }));
  }

  async veto(recordId: string): Promise<ContributionStoreRecord> {
    return this.withPublicationLock(async () => this.mutate((file) => {
      const record = this.requireRecord(file, recordId);
      if (record.publicationState === 'published') this.throwPublishedImmutable(recordId);
      record.publicationState = 'vetoed';
      return record;
    }));
  }

  async disableUnpublished(): Promise<string[]> {
    return this.withPublicationLock(async () => this.withLock(async () => {
      const file = await this.loadUnlocked();
      await writeFile(this.publicationDisabledPath, 'disabled\n', { encoding: 'utf8', mode: 0o600 });
      await chmod(this.publicationDisabledPath, 0o600);
      const disabled: string[] = [];
      for (const record of Object.values(file.records)) {
        if (record.publicationState === 'preview-required' || record.publicationState === 'queued') {
          record.publicationState = 'disabled';
          disabled.push(record.recordId);
        }
      }
      await this.writeAtomic(file);
      return disabled;
    }));
  }

  async enablePublication(): Promise<void> {
    await this.withPublicationLock(async () => this.withLock(async () => {
      await rm(this.publicationDisabledPath, { force: true });
    }));
  }

  async publishAuthorized<T>(
    recordId: string,
    operation: () => Promise<{
      value: T;
      mintRef: string;
      publicationRef: string;
    }>,
  ): Promise<T> {
    return this.withPublicationLock(async () => {
      await this.withLock(async () => {
        const file = await this.loadUnlocked();
        if (await this.publicationDisabledUnlocked()) {
          throw new Error('contribution publication is globally disabled');
        }
        const record = this.requireRecord(file, recordId);
        if (record.publicationState === 'published') this.throwPublishedImmutable(recordId);
        if (record.publicationState !== 'queued') {
          throw new Error(`contribution ${recordId} is not authorized for publication`);
        }
        if (record.localState === 'rejected') throw new Error(`contribution ${recordId} is rejected`);
      });
      const result = await operation();
      if (!result.mintRef || !result.publicationRef) {
        throw new Error('authorized publication must return non-empty mint and publication refs');
      }
      await this.withLock(async () => {
        const file = await this.loadUnlocked();
        const record = this.requireRecord(file, recordId);
        if (record.publicationState !== 'queued' || record.localState === 'rejected') {
          throw new Error(`contribution ${recordId} lost publication authorization`);
        }
        record.localState = 'minted';
        record.mintRef = result.mintRef;
        record.publicationState = 'published';
        record.publicationRef = result.publicationRef;
        await this.writeAtomic(file);
      });
      return result.value;
    });
  }

  async markPublished(recordId: string, publicationRef: string): Promise<ContributionStoreRecord> {
    return this.withPublicationLock(async () => this.mutate((file) => {
      const record = this.requireRecord(file, recordId);
      if (record.publicationState === 'published') {
        if (record.publicationRef === publicationRef) return record;
        this.throwPublishedImmutable(recordId);
      }
      if (record.localState !== 'minted' || record.publicationState !== 'queued') {
        throw new Error(`contribution ${recordId} is not a queued local mint`);
      }
      if (publicationRef.length === 0) throw new Error('publicationRef must not be empty');
      record.publicationState = 'published';
      record.publicationRef = publicationRef;
      return record;
    }));
  }

  toOutboundProjection(
    record: ContributionStoreRecord,
    episodeInput: EpisodeV1,
  ): ContributionPublicationV1 {
    if (record.localState !== 'minted' || record.publicationState !== 'queued' || !record.mintRef) {
      throw new Error(`contribution ${record.recordId} is not ready for outbound publication`);
    }
    const episode = EpisodeV1Schema.parse(episodeInput);
    if (episode.episodeId !== record.recordId) {
      throw new Error(`contribution ${record.recordId} does not match episode ${episode.episodeId}`);
    }
    const candidate = ContributionCandidateV1ProjectionSchema.safeParse(episode.contributionCandidate);
    if (!candidate.success || candidate.data.sourceId !== record.recordId) {
      throw new Error(`canonical episode ${record.recordId} has no matching contribution candidate`);
    }
    return {
      schemaVersion: CONTRIBUTION_PUBLICATION_SCHEMA_VERSION,
      repositorySlug: candidate.data.repositorySlug,
      baseCommit: candidate.data.baseCommit,
      mintRef: record.mintRef,
    };
  }

  private requireRecord(file: ContributionStoreFile, recordId: string): ContributionStoreRecord {
    const record = ownRecord(file, recordId);
    if (!record) throw new Error(`no such contribution record: ${recordId}`);
    return record;
  }

  private throwPublishedImmutable(recordId: string): never {
    throw new Error(`contribution ${recordId} is published and immutable`);
  }
}
