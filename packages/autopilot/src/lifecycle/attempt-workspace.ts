import { randomUUID } from 'node:crypto';
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
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { gitOid, gitRefName, isoTimestamp } from './types.js';
import {
  gitPublicationArgs,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';

export type AttemptPhase = 'implement' | 'review' | 'merge-prep';

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
  readonly pid: number | null;
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
    && !['prNumber', 'reviewGeneration', 'reviewRefOid', 'childStartedAt', 'childExitedAt'].includes(key));
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
    'pid',
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
    pid: nullablePid(manifest.pid),
    paths: decodePaths(manifest.paths),
    timestamps: decodeTimestamps(manifest.timestamps),
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

export function updateAttemptManifest(
  path: string,
  update: (manifest: AttemptManifest) => AttemptManifest,
): AttemptManifest {
  const previous = readAttemptManifest(path);
  const next = decodeAttemptManifest(update(previous));
  if (
    next.version !== previous.version
    || next.attemptId !== previous.attemptId
    || next.runnerId !== previous.runnerId
    || next.phase !== previous.phase
    || next.subject !== previous.subject
    || !samePaths(next.paths, previous.paths)
    || next.timestamps.createdAt !== previous.timestamps.createdAt
  ) {
    throw new Error('Atomic manifest update cannot change attempt identity');
  }
  writeManifestAtomic(path, next);
  return next;
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$GH_TOKEN" ;;
  *) exit 1 ;;
esac
`;

export async function createAttemptWorkspace(
  options: CreateAttemptOptions,
  runner: CommandRunner,
): Promise<AttemptManifest> {
  if (!isAbsolute(options.repositoryPath) || !isAbsolute(options.worktreeBase)) {
    throw new Error('Attempt repository and worktree base must be absolute');
  }
  const attemptId = uuid(options.attemptId ?? randomUUID(), 'attempt ID');
  const runnerId = defaultRunnerId({ configured: options.runnerId });
  const host = filesystemSafeHostname(options.host ?? systemHostname());
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  isoTimestamp(timestamp);
  const subject = safeComponent(options.subject, 'attempt subject');
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
  mkdirSync(phaseDir, { recursive: true, mode: 0o700 });
  mkdirSync(attemptDir, { mode: 0o700 });
  mkdirSync(paths.ghConfigDir, { mode: 0o700 });
  writeFileSync(paths.log, '', { mode: 0o600, flag: 'wx' });
  writeFileSync(paths.askpass, ASKPASS, { mode: 0o700, flag: 'wx' });

  await runner('git', [
    '-C', options.repositoryPath,
    'worktree', 'add', '--detach',
    paths.worktree,
    gitOid(options.expectedHead),
  ]);

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
    pid: options.pid ?? null,
    paths,
    timestamps: {
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  writeManifestAtomic(paths.manifest, manifest);
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
          && manifest.pid !== null
          && manifest.timestamps.childExitedAt === undefined
          && isPidAlive(manifest.pid)
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
  if (manifest.pid !== null && options.isPidAlive(manifest.pid)) {
    return retained('live', 'Attempt child PID is still live.', manifest.attemptId);
  }
  if (!existsSync(manifest.paths.worktree)) {
    rmSync(manifest.paths.attemptDir, { recursive: true });
    return { status: 'removed', attemptId: manifest.attemptId };
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

  try {
    await runner('git', [
      ...gitPublicationArgs(manifest.paths.askpass, []),
      '-C', manifest.paths.worktree,
      'fetch', '--quiet', 'origin',
      `${manifest.branch}:refs/remotes/origin/${manifest.branch}`,
    ], {
      env: {
        ...sanitizedGitHubCommandOverlay(process.env, options.env),
        GH_CONFIG_DIR: manifest.paths.ghConfigDir,
        GIT_ASKPASS: manifest.paths.askpass,
        GIT_TERMINAL_PROMPT: '0',
      },
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
      '-C', manifest.paths.worktree,
      'rev-parse', '--verify', 'HEAD^{commit}',
    ])).trim();
    remoteHead = (await runner('git', [
      '-C', manifest.paths.worktree,
      'rev-parse', '--verify',
      `refs/remotes/origin/${manifest.branch}^{commit}`,
    ])).trim();
    gitOid(head);
    gitOid(remoteHead);
  } catch {
    return retained(
      'missing-object',
      'Local HEAD or expected remote publication object is missing.',
      manifest.attemptId,
    );
  }

  try {
    await runner('git', [
      '-C', manifest.paths.worktree,
      'merge-base', '--is-ancestor', head, remoteHead,
    ]);
  } catch {
    return retained(
      'ahead',
      'Local HEAD is not reachable from the expected remote publication ref.',
      manifest.attemptId,
    );
  }

  try {
    const commonDir = (await runner('git', [
      '-C', manifest.paths.worktree,
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ])).trim();
    if (!isAbsolute(commonDir) || !existsSync(commonDir) || !statSync(commonDir).isDirectory()) {
      return retained('ambiguous', 'Git common directory could not be proven.', manifest.attemptId);
    }
    await runner('git', [
      `--git-dir=${commonDir}`,
      'worktree', 'remove', manifest.paths.worktree,
    ]);
    rmSync(manifest.paths.attemptDir, { recursive: true });
    return { status: 'removed', attemptId: manifest.attemptId };
  } catch {
    return retained('ambiguous', 'Exact worktree removal failed.', manifest.attemptId);
  }
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
        try {
          const manifest = readAttemptManifest(manifestPath);
          if (manifest.host !== host) continue;
        } catch {
          results.push(retained('malformed', 'Attempt manifest could not be strictly decoded.'));
          continue;
        }
        results.push(await cleanupAttempt(manifestPath, runner, options));
      }
    }
  }
  return results;
}
