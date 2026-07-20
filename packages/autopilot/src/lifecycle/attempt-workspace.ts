import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname as systemHostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { gitOid, gitRefName, isoTimestamp } from './types.js';
import {
  gitPublicationArgs,
  isolatedGitCommandOverlay,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';

export type AttemptPhase = 'implement' | 'review' | 'merge-prep';
export type AttemptProcessState = 'preparing' | 'running' | 'exited';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_COMPONENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BOOT_ID = randomUUID();

export interface AttemptPaths {
  readonly attemptDir: string;
  readonly worktree: string;
  readonly manifest: string;
  readonly log: string;
  readonly ghConfigDir: string;
  readonly askpass: string;
}

export interface AttemptTimestamps {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly childStartedAt?: string;
  readonly childExitedAt?: string;
}

export interface AttemptRepositoryIdentity {
  readonly root: string;
  readonly gitCommonDir: string;
  readonly remoteName: string;
  readonly remoteUrlHash: string;
}

export interface AttemptManifest {
  readonly version: 2;
  readonly attemptId: string;
  readonly runnerId: string;
  readonly host: string;
  readonly phase: AttemptPhase;
  readonly subject: string;
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly branch: string;
  readonly targetBase: string;
  readonly expectedHead: string;
  readonly claimOid: string;
  readonly reviewGeneration?: string;
  readonly reviewRefOid?: string;
  readonly selectedLogin: string;
  readonly repository: AttemptRepositoryIdentity;
  readonly processState: AttemptProcessState;
  readonly pid: number | null;
  readonly terminalHead?: string;
  readonly paths: AttemptPaths;
  readonly timestamps: AttemptTimestamps;
}

export interface CreateAttemptOptions {
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId?: string;
  readonly phase: AttemptPhase;
  readonly subject: string;
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly branch: string;
  readonly targetBase: string;
  readonly expectedHead: string;
  readonly claimOid: string;
  readonly reviewGeneration?: string;
  readonly reviewRefOid?: string;
  readonly selectedLogin: string;
  readonly remoteName?: string;
  readonly pid?: number | null;
  readonly attemptId?: string;
  readonly host?: string;
  readonly now?: () => Date;
}

export interface RunnerIdOptions {
  readonly configured?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hostname?: string;
  readonly pid?: number;
  readonly bootId?: string;
}

function safeComponent(value: string, name: string): string {
  if (!SAFE_COMPONENT_PATTERN.test(value) || value === '.' || value === '..') {
    throw new Error(`${name} must be filesystem-safe`);
  }
  return value;
}

function filesystemSafeHostname(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safeComponent(safe, 'hostname');
}

function uuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function defaultRunnerId(options: RunnerIdOptions = {}): string {
  const configured = options.configured
    ?? options.environment?.JINN_AUTOPILOT_RUNNER_ID
    ?? process.env.JINN_AUTOPILOT_RUNNER_ID;
  if (configured !== undefined && configured !== '') {
    return safeComponent(configured, 'configured runner ID');
  }
  const host = filesystemSafeHostname(options.hostname ?? systemHostname());
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid runner PID');
  const bootId = uuid(options.bootId ?? BOOT_ID, 'runner boot UUID');
  return `${host}-${pid}-${bootId}`;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function nullablePid(value: unknown): number | null {
  if (value === null) return null;
  return positiveInteger(value, 'PID');
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`Unknown field: ${unknown}`);
  const missing = allowed.find((key) => !Object.hasOwn(record, key)
    && !['prNumber', 'reviewGeneration', 'reviewRefOid', 'terminalHead', 'childStartedAt', 'childExitedAt'].includes(key));
  if (missing !== undefined) throw new Error(`Missing ${name} field: ${missing}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function absolutePath(value: unknown, name: string): string {
  const path = stringField(value, name);
  if (!isAbsolute(path)) throw new Error(`Invalid ${name}`);
  return path;
}

function decodePaths(value: unknown): AttemptPaths {
  const paths = record(value, 'attempt paths');
  exactKeys(paths, [
    'attemptDir',
    'worktree',
    'manifest',
    'log',
    'ghConfigDir',
    'askpass',
  ], 'attempt paths');
  return {
    attemptDir: absolutePath(paths.attemptDir, 'attempt directory'),
    worktree: absolutePath(paths.worktree, 'worktree path'),
    manifest: absolutePath(paths.manifest, 'manifest path'),
    log: absolutePath(paths.log, 'log path'),
    ghConfigDir: absolutePath(paths.ghConfigDir, 'GH config path'),
    askpass: absolutePath(paths.askpass, 'askpass path'),
  };
}

function decodeTimestamps(value: unknown): AttemptTimestamps {
  const timestamps = record(value, 'attempt timestamps');
  exactKeys(timestamps, [
    'createdAt',
    'updatedAt',
    'childStartedAt',
    'childExitedAt',
  ], 'attempt timestamps');
  const createdAt = isoTimestamp(stringField(timestamps.createdAt, 'created timestamp'));
  const updatedAt = isoTimestamp(stringField(timestamps.updatedAt, 'updated timestamp'));
  const childStartedAt = timestamps.childStartedAt === undefined
    ? undefined
    : isoTimestamp(stringField(timestamps.childStartedAt, 'child-started timestamp'));
  const childExitedAt = timestamps.childExitedAt === undefined
    ? undefined
    : isoTimestamp(stringField(timestamps.childExitedAt, 'child-exited timestamp'));
  return {
    createdAt,
    updatedAt,
    ...(childStartedAt === undefined ? {} : { childStartedAt }),
    ...(childExitedAt === undefined ? {} : { childExitedAt }),
  };
}

function decodeRepositoryIdentity(value: unknown): AttemptRepositoryIdentity {
  const repository = record(value, 'attempt repository identity');
  exactKeys(repository, [
    'root',
    'gitCommonDir',
    'remoteName',
    'remoteUrlHash',
  ], 'attempt repository identity');
  const remoteUrlHash = stringField(repository.remoteUrlHash, 'remote URL hash');
  if (!/^[0-9a-f]{64}$/.test(remoteUrlHash)) {
    throw new Error('Invalid remote URL hash');
  }
  return {
    root: absolutePath(repository.root, 'canonical repository root'),
    gitCommonDir: absolutePath(repository.gitCommonDir, 'Git common directory'),
    remoteName: gitRefName(stringField(repository.remoteName, 'remote name')),
    remoteUrlHash,
  };
}

function processState(value: unknown): AttemptProcessState {
  if (value !== 'preparing' && value !== 'running' && value !== 'exited') {
    throw new Error('Invalid attempt process state');
  }
  return value;
}

export function decodeAttemptManifest(value: unknown): AttemptManifest {
  const manifest = record(value, 'attempt manifest');
  exactKeys(manifest, [
    'version',
    'attemptId',
    'runnerId',
    'host',
    'phase',
    'subject',
    'issueNumber',
    'prNumber',
    'branch',
    'targetBase',
    'expectedHead',
    'claimOid',
    'reviewGeneration',
    'reviewRefOid',
    'selectedLogin',
    'repository',
    'processState',
    'pid',
    'terminalHead',
    'paths',
    'timestamps',
  ], 'attempt manifest');
  if (manifest.version !== 2) throw new Error('Unsupported attempt manifest version');
  const phase = manifest.phase;
  if (phase !== 'implement' && phase !== 'review' && phase !== 'merge-prep') {
    throw new Error('Invalid attempt phase');
  }
  const attemptId = uuid(stringField(manifest.attemptId, 'attempt ID'), 'attempt ID');
  const runnerId = safeComponent(stringField(manifest.runnerId, 'runner ID'), 'runner ID');
  const host = filesystemSafeHostname(stringField(manifest.host, 'attempt host'));
  const subject = safeComponent(stringField(manifest.subject, 'attempt subject'), 'attempt subject');
  const issueNumber = positiveInteger(manifest.issueNumber, 'issue number');
  const prNumber = manifest.prNumber === undefined
    ? undefined
    : positiveInteger(manifest.prNumber, 'PR number');
  if (phase !== 'implement' && prNumber === undefined) {
    throw new Error(`${phase} attempt requires a PR number`);
  }
  const expectedSubject = phase === 'implement' ? `issue-${issueNumber}` : `pr-${prNumber}`;
  if (subject !== expectedSubject) throw new Error('Attempt subject does not match phase identity');
  const expectedHead = gitOid(stringField(manifest.expectedHead, 'expected head'));
  const claimOid = gitOid(stringField(manifest.claimOid, 'claim OID'));
  const reviewGeneration = manifest.reviewGeneration === undefined
    ? undefined
    : uuid(stringField(manifest.reviewGeneration, 'review generation'), 'review generation');
  const reviewRefOid = manifest.reviewRefOid === undefined
    ? undefined
    : gitOid(stringField(manifest.reviewRefOid, 'review ref OID'));
  if ((reviewGeneration === undefined) !== (reviewRefOid === undefined)) {
    throw new Error('Review generation and ref OID must appear together');
  }
  if (phase !== 'review' && reviewGeneration !== undefined) {
    throw new Error('Review generation metadata is valid only for review attempts');
  }
  const decodedProcessState = processState(manifest.processState);
  const pid = nullablePid(manifest.pid);
  const terminalHead = manifest.terminalHead === undefined
    ? undefined
    : gitOid(stringField(manifest.terminalHead, 'terminal head'));
  const timestamps = decodeTimestamps(manifest.timestamps);
  if (
    (decodedProcessState === 'preparing'
      && (pid !== null
        || timestamps.childStartedAt !== undefined
        || timestamps.childExitedAt !== undefined))
    || (decodedProcessState === 'running'
      && (pid === null
        || timestamps.childStartedAt === undefined
        || timestamps.childExitedAt !== undefined))
    || (decodedProcessState === 'exited'
      && (pid === null
        || timestamps.childStartedAt === undefined
        || timestamps.childExitedAt === undefined))
  ) {
    throw new Error('Attempt process state, PID, and timestamps disagree');
  }
  if (decodedProcessState !== 'exited' && terminalHead !== undefined) {
    throw new Error('Terminal head is valid only for an exited attempt');
  }
  return {
    version: 2,
    attemptId,
    runnerId,
    host,
    phase,
    subject,
    issueNumber,
    ...(prNumber === undefined ? {} : { prNumber }),
    branch: gitRefName(stringField(manifest.branch, 'branch')),
    targetBase: gitRefName(stringField(manifest.targetBase, 'target base')),
    expectedHead,
    claimOid,
    ...(reviewGeneration === undefined
      ? {}
      : { reviewGeneration, reviewRefOid: reviewRefOid! }),
    selectedLogin: stringField(manifest.selectedLogin, 'selected login'),
    repository: decodeRepositoryIdentity(manifest.repository),
    processState: decodedProcessState,
    pid,
    ...(terminalHead === undefined ? {} : { terminalHead }),
    paths: decodePaths(manifest.paths),
    timestamps,
  };
}

export function readAttemptManifest(path: string): AttemptManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Malformed attempt manifest');
  }
  return decodeAttemptManifest(parsed);
}

function writeManifestAtomic(path: string, manifest: AttemptManifest): void {
  const valid = decodeAttemptManifest(manifest);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function samePaths(left: AttemptPaths, right: AttemptPaths): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof AttemptPaths] === right[key as keyof AttemptPaths],
  );
}

function sameRepositoryIdentity(
  left: AttemptRepositoryIdentity,
  right: AttemptRepositoryIdentity,
): boolean {
  return left.root === right.root
    && left.gitCommonDir === right.gitCommonDir
    && left.remoteName === right.remoteName
    && left.remoteUrlHash === right.remoteUrlHash;
}

export function updateAttemptManifest(
  path: string,
  update: (manifest: AttemptManifest) => AttemptManifest,
): AttemptManifest {
  const previous = readAttemptManifest(path);
  const progressiveManifestFields = new Set([
    'processState',
    'pid',
    'terminalHead',
    'timestamps',
  ]);
  const progressiveTimestampFields = new Set([
    'updatedAt',
    'childStartedAt',
    'childExitedAt',
  ]);
  const staticFields = (manifest: AttemptManifest): Record<string, unknown> => ({
    ...Object.fromEntries(
      Object.entries(manifest)
        .filter(([key]) => !progressiveManifestFields.has(key)),
    ),
    timestamps: Object.fromEntries(
      Object.entries(manifest.timestamps)
        .filter(([key]) => !progressiveTimestampFields.has(key)),
    ),
  });
  const previousStaticFields = structuredClone(staticFields(previous));
  const next = decodeAttemptManifest(update(previous));
  if (!isDeepStrictEqual(staticFields(next), previousStaticFields)) {
    throw new Error('Atomic manifest update cannot change static attempt fields');
  }
  writeManifestAtomic(path, next);
  return next;
}

/**
 * Checkpoint-only manifest transition. The original claim/identity/path
 * binding remains immutable; only the exact progressive publication head and
 * its update timestamp may advance.
 */
export function advanceAttemptExpectedHead(
  path: string,
  expectedHead: string,
  nextHead: string,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const previous = readAttemptManifest(path);
  const expected = gitOid(expectedHead);
  const next = gitOid(nextHead);
  if (previous.expectedHead !== expected) {
    throw new Error('Attempt manifest expected head changed before progressive update');
  }
  const timestamp = transitionTimestamp(now);
  const advanced = decodeAttemptManifest({
    ...previous,
    expectedHead: next,
    timestamps: {
      ...previous.timestamps,
      updatedAt: timestamp,
    },
  });
  writeManifestAtomic(path, advanced);
  return advanced;
}

function transitionTimestamp(now: () => Date): string {
  const timestamp = now().toISOString();
  return isoTimestamp(timestamp);
}

export function markAttemptRunning(
  manifestPath: string,
  pid: number,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const validPid = positiveInteger(pid, 'PID');
  const timestamp = transitionTimestamp(now);
  return updateAttemptManifest(manifestPath, (current) => {
    if (current.processState !== 'preparing') {
      throw new Error('Only a preparing attempt may transition to running');
    }
    return {
      ...current,
      processState: 'running',
      pid: validPid,
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        childStartedAt: timestamp,
      },
    };
  });
}

export function markAttemptExited(
  manifestPath: string,
  now: () => Date = () => new Date(),
  terminalHead?: string,
): AttemptManifest {
  const timestamp = transitionTimestamp(now);
  const validTerminalHead = terminalHead === undefined ? undefined : gitOid(terminalHead);
  return updateAttemptManifest(manifestPath, (current) => {
    if (current.processState !== 'running') {
      throw new Error('Only a running attempt may transition to exited');
    }
    return {
      ...current,
      processState: 'exited',
      ...(validTerminalHead === undefined ? {} : { terminalHead: validTerminalHead }),
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        childExitedAt: timestamp,
      },
    };
  });
}

export interface TrackableAttemptChild {
  readonly pid?: number;
  readonly exitCode?: number | null;
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown;
}

export interface TrackAttemptChildOptions {
  readonly alreadyRunning?: boolean;
  readonly now?: () => Date;
  readonly terminalHead?: string;
}

/**
 * Parent-side lifecycle binding. The exit listener records positive terminal
 * evidence through the same atomic manifest update used by direct callers.
 */
export function trackAttemptChild(
  manifestPath: string,
  child: TrackableAttemptChild,
  options: TrackAttemptChildOptions = {},
): AttemptManifest {
  const pid = positiveInteger(child.pid, 'child PID');
  let exitObserved = child.exitCode !== undefined && child.exitCode !== null;
  let runningRecorded = false;
  let exitedRecorded = false;
  const recordExit = (): void => {
    exitObserved = true;
    if (runningRecorded && !exitedRecorded) {
      markAttemptExited(manifestPath, options.now, options.terminalHead);
      exitedRecorded = true;
    }
  };
  child.once('exit', recordExit);
  const running = options.alreadyRunning === true
    ? readAttemptManifest(manifestPath)
    : markAttemptRunning(manifestPath, pid, options.now);
  if (running.processState !== 'running' || running.pid !== pid) {
    throw new Error('Tracked child does not match the running attempt');
  }
  runningRecorded = true;
  if (exitObserved) recordExit();
  return exitedRecorded ? readAttemptManifest(manifestPath) : running;
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$GH_TOKEN" ;;
  *) exit 1 ;;
esac
`;

function canonicalDirectory(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`Invalid ${name}`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`Invalid ${name}`);
  return canonical;
}

function remoteUrlHash(remoteUrl: string): string {
  return createHash('sha256').update(remoteUrl).digest('hex');
}

async function readRepositoryIdentity(
  repositoryPath: string,
  remoteName: string,
  runner: CommandRunner,
): Promise<AttemptRepositoryIdentity> {
  const validRemoteName = gitRefName(remoteName);
  try {
    const root = canonicalDirectory((await runner('git', [
      '-C', repositoryPath,
      'rev-parse', '--path-format=absolute', '--show-toplevel',
    ])).trim(), 'canonical repository root');
    const gitCommonDir = canonicalDirectory((await runner('git', [
      '-C', repositoryPath,
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ])).trim(), 'Git common directory');
    const remoteUrl = stringField((await runner('git', [
      '-C', repositoryPath,
      'remote', 'get-url', validRemoteName,
    ])).trim(), 'remote URL');
    return decodeRepositoryIdentity({
      root,
      gitCommonDir,
      remoteName: validRemoteName,
      remoteUrlHash: remoteUrlHash(remoteUrl),
    });
  } catch {
    throw new Error('Attempt repository identity could not be established');
  }
}

async function registeredWorktreePaths(
  gitCommonDir: string,
  runner: CommandRunner,
): Promise<string[]> {
  const porcelain = await runner('git', [
    `--git-dir=${gitCommonDir}`,
    'worktree', 'list', '--porcelain', '-z',
  ]);
  return porcelain
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
}

function canonicalProspectivePath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Path has no existing canonical ancestor');
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...suffix);
}

export async function createAttemptWorkspace(
  options: CreateAttemptOptions,
  runner: CommandRunner,
): Promise<AttemptManifest> {
  if ((options.reviewGeneration === undefined) !== (options.reviewRefOid === undefined)) {
    throw new Error('Review generation and ref OID must appear together');
  }
  if (!isAbsolute(options.repositoryPath) || !isAbsolute(options.worktreeBase)) {
    throw new Error('Attempt repository and worktree base must be absolute');
  }
  const attemptId = uuid(options.attemptId ?? randomUUID(), 'attempt ID');
  const runnerId = defaultRunnerId({ configured: options.runnerId });
  const host = filesystemSafeHostname(options.host ?? systemHostname());
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  isoTimestamp(timestamp);
  const subject = safeComponent(options.subject, 'attempt subject');
  const repository = await readRepositoryIdentity(
    options.repositoryPath,
    options.remoteName ?? 'origin',
    runner,
  );
  const v2Base = join(options.worktreeBase, 'v2');
  const phaseDir = join(v2Base, runnerId, options.phase);
  const attemptDir = join(phaseDir, `${subject}-${attemptId}`);
  const paths: AttemptPaths = {
    attemptDir,
    worktree: join(attemptDir, 'worktree'),
    manifest: join(attemptDir, 'manifest.json'),
    log: join(attemptDir, 'session.log'),
    ghConfigDir: join(attemptDir, 'gh-config'),
    askpass: join(attemptDir, 'askpass'),
  };
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId,
    runnerId,
    host,
    phase: options.phase,
    subject,
    issueNumber: options.issueNumber,
    ...(options.prNumber === undefined ? {} : { prNumber: options.prNumber }),
    branch: options.branch,
    targetBase: options.targetBase,
    expectedHead: options.expectedHead,
    claimOid: options.claimOid,
    ...(options.reviewGeneration === undefined
      ? {}
      : {
          reviewGeneration: options.reviewGeneration,
          reviewRefOid: options.reviewRefOid,
        }),
    selectedLogin: options.selectedLogin,
    repository,
    processState: options.pid === undefined || options.pid === null
      ? 'preparing'
      : 'running',
    pid: options.pid ?? null,
    paths,
    timestamps: {
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(options.pid === undefined || options.pid === null
        ? {}
        : { childStartedAt: timestamp }),
    },
  });
  const registeredBefore = (await registeredWorktreePaths(
    repository.gitCommonDir,
    runner,
  )).some((path) =>
    canonicalProspectivePath(path) === canonicalProspectivePath(paths.worktree));
  if (registeredBefore) {
    throw new Error('Attempt worktree path is already registered');
  }
  mkdirSync(phaseDir, { recursive: true, mode: 0o700 });
  mkdirSync(attemptDir, { mode: 0o700 });
  mkdirSync(paths.ghConfigDir, { mode: 0o700 });
  writeFileSync(paths.log, '', { mode: 0o600, flag: 'wx' });
  writeFileSync(paths.askpass, ASKPASS, { mode: 0o700, flag: 'wx' });
  writeManifestAtomic(paths.manifest, manifest);
  try {
    await runner('git', [
      '-C', repository.root,
      'worktree', 'add', '--detach',
      paths.worktree,
      manifest.expectedHead,
    ]);
  } catch (error) {
    try {
      await runner('git', [
        `--git-dir=${repository.gitCommonDir}`,
        'worktree', 'remove', paths.worktree,
      ]);
    } catch {
      // Registration may not have happened. Registry read-back below decides
      // whether exact local artifacts are safe to remove.
    }
    let registered = true;
    try {
      registered = (await registeredWorktreePaths(repository.gitCommonDir, runner))
        .some((path) =>
          canonicalProspectivePath(path) === canonicalProspectivePath(paths.worktree));
    } catch {
      // Retain the strict manifest rather than risk a manifestless registered
      // worktree when rollback read-back is ambiguous.
    }
    if (!registered) rmSync(paths.attemptDir, { recursive: true });
    throw error;
  }
  return manifest;
}

function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

export function countRunnerLiveAttempts(
  v2Base: string,
  runnerId: string,
  isPidAlive: (pid: number) => boolean,
): number {
  safeComponent(runnerId, 'runner ID');
  const runnerDir = join(v2Base, runnerId);
  let count = 0;
  for (const phaseDir of directories(runnerDir)) {
    for (const attemptDir of directories(phaseDir)) {
      const manifestPath = join(attemptDir, 'manifest.json');
      try {
        const manifest = readAttemptManifest(manifestPath);
        if (
          manifest.runnerId === runnerId
          && (
            manifest.processState === 'preparing'
            || (
              manifest.processState === 'running'
              && manifest.pid !== null
              && isPidAlive(manifest.pid)
            )
          )
        ) {
          count++;
        }
      } catch {
        // A malformed manifest cannot prove a live child and never affects
        // another runner's local capacity accounting.
      }
    }
  }
  return count;
}

export type CleanupReasonCode =
  | 'live'
  | 'dirty'
  | 'ahead'
  | 'missing-object'
  | 'authentication-failed'
  | 'malformed'
  | 'escaped-path'
  | 'ambiguous';

export type AttemptCleanupResult =
  | { readonly status: 'removed'; readonly attemptId: string }
  | { readonly status: 'already-removed'; readonly attemptId: string }
  | {
      readonly status: 'retained';
      readonly attemptId?: string;
      readonly reason: {
        readonly code: CleanupReasonCode;
        readonly detail: string;
      };
    };

export interface CleanupAttemptOptions {
  readonly v2Base: string;
  readonly isPidAlive: (pid: number) => boolean;
  readonly env?: Record<string, string>;
}

function retained(
  code: CleanupReasonCode,
  detail: string,
  attemptId?: string,
): AttemptCleanupResult {
  return {
    status: 'retained',
    ...(attemptId === undefined ? {} : { attemptId }),
    reason: { code, detail },
  };
}

function removeAttemptMetadata(manifest: AttemptManifest): AttemptCleanupResult {
  try {
    rmSync(manifest.paths.attemptDir, { recursive: true });
    return { status: 'removed', attemptId: manifest.attemptId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'already-removed', attemptId: manifest.attemptId };
    }
    return retained(
      'ambiguous',
      'Exact attempt metadata removal failed.',
      manifest.attemptId,
    );
  }
}

function isBelow(base: string, target: string): boolean {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return normalizedTarget.startsWith(`${normalizedBase}${sep}`);
}

function expectedPaths(v2Base: string, manifest: AttemptManifest): AttemptPaths {
  const attemptDir = join(
    resolve(v2Base),
    manifest.runnerId,
    manifest.phase,
    `${manifest.subject}-${manifest.attemptId}`,
  );
  return {
    attemptDir,
    worktree: join(attemptDir, 'worktree'),
    manifest: join(attemptDir, 'manifest.json'),
    log: join(attemptDir, 'session.log'),
    ghConfigDir: join(attemptDir, 'gh-config'),
    askpass: join(attemptDir, 'askpass'),
  };
}

function pathsAgree(
  manifestPath: string,
  manifest: AttemptManifest,
  v2Base: string,
): boolean {
  const expected = expectedPaths(v2Base, manifest);
  if (!samePaths(expected, manifest.paths)) return false;
  if (resolve(manifestPath) !== expected.manifest) return false;
  if (!isBelow(v2Base, expected.attemptDir)) return false;
  try {
    const realAttemptDir = realpathSync(expected.attemptDir);
    const realBase = realpathSync(resolve(v2Base));
    if (
      !isBelow(realBase, realAttemptDir)
      || lstatSync(expected.attemptDir).isSymbolicLink()
      || !lstatSync(expected.attemptDir).isDirectory()
    ) {
      return false;
    }
    for (const file of [expected.manifest, expected.log, expected.askpass]) {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile()) return false;
      if (!isBelow(realAttemptDir, realpathSync(file))) return false;
    }
    const configInfo = lstatSync(expected.ghConfigDir);
    if (configInfo.isSymbolicLink() || !configInfo.isDirectory()) return false;
    if (!isBelow(realAttemptDir, realpathSync(expected.ghConfigDir))) return false;
    if (existsSync(expected.worktree)) {
      const worktreeInfo = lstatSync(expected.worktree);
      if (worktreeInfo.isSymbolicLink() || !worktreeInfo.isDirectory()) return false;
      if (!isBelow(realAttemptDir, realpathSync(expected.worktree))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function authFailure(error: unknown): boolean {
  return /auth|credential|permission denied|could not read username|terminal prompts disabled/i
    .test(String(error));
}

function cleanupGitEnvironment(
  manifest: AttemptManifest,
  options: CleanupAttemptOptions,
): Record<string, string> {
  return {
    ...sanitizedGitHubCommandOverlay(process.env, options.env),
    ...isolatedGitCommandOverlay(process.env, manifest.paths.askpass),
    GH_CONFIG_DIR: manifest.paths.ghConfigDir,
  };
}

async function provePublicationReachability(
  manifest: AttemptManifest,
  runner: CommandRunner,
  options: CleanupAttemptOptions,
  gitContext: readonly string[],
  localHeadSpec: string,
): Promise<AttemptCleanupResult | null> {
  try {
    await runner('git', [
      ...gitPublicationArgs(manifest.paths.askpass, []),
      ...gitContext,
      'fetch', '--quiet', manifest.repository.remoteName,
      `${manifest.branch}:refs/remotes/${manifest.repository.remoteName}/${manifest.branch}`,
    ], {
      env: cleanupGitEnvironment(manifest, options),
    });
  } catch (error) {
    return retained(
      authFailure(error) ? 'authentication-failed' : 'ambiguous',
      authFailure(error)
        ? 'Remote publication ref could not be authenticated.'
        : 'Remote publication ref could not be refreshed.',
      manifest.attemptId,
    );
  }

  let head: string;
  let remoteHead: string;
  try {
    head = (await runner('git', [
      ...gitContext,
      'rev-parse', '--verify', `${localHeadSpec}^{commit}`,
    ])).trim();
    remoteHead = (await runner('git', [
      ...gitContext,
      'rev-parse', '--verify',
      `refs/remotes/${manifest.repository.remoteName}/${manifest.branch}^{commit}`,
    ])).trim();
    gitOid(head);
    gitOid(remoteHead);
  } catch {
    return retained(
      'missing-object',
      'Recorded local HEAD or expected remote publication object is missing.',
      manifest.attemptId,
    );
  }

  try {
    await runner('git', [
      ...gitContext,
      'merge-base', '--is-ancestor', head, remoteHead,
    ]);
  } catch {
    return retained(
      'ahead',
      'Recorded local HEAD is not reachable from the expected remote publication ref.',
      manifest.attemptId,
    );
  }
  return null;
}

export async function cleanupAttempt(
  manifestPath: string,
  runner: CommandRunner,
  options: CleanupAttemptOptions,
): Promise<AttemptCleanupResult> {
  let manifest: AttemptManifest;
  try {
    manifest = readAttemptManifest(manifestPath);
  } catch {
    return retained('malformed', 'Attempt manifest could not be strictly decoded.');
  }
  if (!pathsAgree(manifestPath, manifest, options.v2Base)) {
    return retained(
      'escaped-path',
      'Manifest path or attempt identity does not match the exact v2 attempt directory.',
      manifest.attemptId,
    );
  }
  if (manifest.processState === 'preparing') {
    return retained(
      'ambiguous',
      'Attempt is still preparing and has no positive terminal process evidence.',
      manifest.attemptId,
    );
  }
  if (manifest.processState === 'running') {
    if (manifest.pid === null) {
      return retained(
        'ambiguous',
        'Running attempt has no recorded child PID.',
        manifest.attemptId,
      );
    }
    if (options.isPidAlive(manifest.pid)) {
      return retained('live', 'Attempt child PID is still live.', manifest.attemptId);
    }
  }
  let actualRepository: AttemptRepositoryIdentity;
  try {
    actualRepository = await readRepositoryIdentity(
      manifest.repository.root,
      manifest.repository.remoteName,
      runner,
    );
  } catch {
    return retained(
      'ambiguous',
      'Creating repository identity could not be re-established.',
      manifest.attemptId,
    );
  }
  if (!sameRepositoryIdentity(actualRepository, manifest.repository)) {
    return retained(
      'ambiguous',
      'Creating repository identity no longer matches the attempt manifest.',
      manifest.attemptId,
    );
  }
  if (existsSync(manifest.paths.worktree)) {
    try {
      const worktreeCommonDir = canonicalDirectory((await runner('git', [
        '-C', manifest.paths.worktree,
        'rev-parse', '--path-format=absolute', '--git-common-dir',
      ])).trim(), 'worktree Git common directory');
      if (worktreeCommonDir !== manifest.repository.gitCommonDir) {
        return retained(
          'ambiguous',
          'Attempt worktree belongs to a different Git common directory.',
          manifest.attemptId,
        );
      }
    } catch {
      return retained(
        'ambiguous',
        'Attempt worktree repository identity could not be proven.',
        manifest.attemptId,
      );
    }
  }
  if (!existsSync(manifest.paths.worktree)) {
    if (manifest.terminalHead === undefined) {
      return retained(
        'ambiguous',
        'Missing worktree has no recorded terminal HEAD.',
        manifest.attemptId,
      );
    }
    let registered: boolean;
    try {
      registered = (await registeredWorktreePaths(
        manifest.repository.gitCommonDir,
        runner,
      )).some((path) =>
        canonicalProspectivePath(path) === canonicalProspectivePath(manifest.paths.worktree));
    } catch {
      return retained(
        'ambiguous',
        'Missing worktree could not be checked against the Git worktree registry.',
        manifest.attemptId,
      );
    }
    if (registered) {
      return retained(
        'ambiguous',
        'Missing worktree remains registered in the creating repository.',
        manifest.attemptId,
      );
    }
    const proofFailure = await provePublicationReachability(
      manifest,
      runner,
      options,
      [`--git-dir=${manifest.repository.gitCommonDir}`],
      manifest.terminalHead,
    );
    if (proofFailure !== null) return proofFailure;
    return removeAttemptMetadata(manifest);
  }

  try {
    const status = await runner('git', [
      '-C', manifest.paths.worktree,
      'status', '--porcelain', '--untracked-files=all',
    ]);
    if (status.trim() !== '') {
      return retained('dirty', 'Worktree contains uncommitted changes.', manifest.attemptId);
    }
  } catch {
    return retained('ambiguous', 'Git cleanliness inspection failed.', manifest.attemptId);
  }

  const proofFailure = await provePublicationReachability(
    manifest,
    runner,
    options,
    ['-C', manifest.paths.worktree],
    'HEAD',
  );
  if (proofFailure !== null) return proofFailure;

  try {
    await runner('git', [
      `--git-dir=${manifest.repository.gitCommonDir}`,
      'worktree', 'remove', manifest.paths.worktree,
    ]);
  } catch {
    return retained('ambiguous', 'Exact worktree removal failed.', manifest.attemptId);
  }
  return removeAttemptMetadata(manifest);
}

export interface SweepDeadAttemptsOptions extends CleanupAttemptOptions {
  readonly host?: string;
}

export async function sweepDeadAttempts(
  runner: CommandRunner,
  options: SweepDeadAttemptsOptions,
): Promise<AttemptCleanupResult[]> {
  const host = filesystemSafeHostname(options.host ?? systemHostname());
  const results: AttemptCleanupResult[] = [];
  for (const runnerDir of directories(options.v2Base)) {
    for (const phaseDir of directories(runnerDir)) {
      for (const attemptDir of directories(phaseDir)) {
        const manifestPath = join(attemptDir, 'manifest.json');
        let manifest: AttemptManifest;
        try {
          manifest = readAttemptManifest(manifestPath);
          if (manifest.host !== host) continue;
        } catch {
          results.push(retained('malformed', 'Attempt manifest could not be strictly decoded.'));
          continue;
        }
        try {
          results.push(await cleanupAttempt(manifestPath, runner, options));
        } catch {
          results.push(retained(
            'ambiguous',
            'Attempt cleanup failed unexpectedly and was isolated.',
            manifest.attemptId,
          ));
        }
      }
    }
  }
  return results;
}
