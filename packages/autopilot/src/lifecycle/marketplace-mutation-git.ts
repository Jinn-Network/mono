import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { gitOid, type GitOid } from './types.js';

const MAX_GIT_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 60_000;

export interface MarketplaceMutationCommitIdentity {
  readonly worktreePath: string;
  readonly expectedHead: GitOid;
  readonly touchedPaths: readonly string[];
  readonly summary: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly v2AttemptId: string;
  readonly childIssueNumber?: number;
}

export interface MarketplaceMutationGitCommand {
  readonly command: 'git';
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: Uint8Array;
}

export interface MarketplaceMutationGitCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export type MarketplaceMutationGitRunner = (
  command: MarketplaceMutationGitCommand,
) => Promise<MarketplaceMutationGitCommandResult>;

export type MarketplaceMutationGitState =
  | {
      readonly status: 'clean';
      readonly head: GitOid;
    }
  | {
      readonly status: 'pending-change';
      readonly head: GitOid;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly status: 'committed';
      readonly head: GitOid;
      readonly localHead: GitOid;
      readonly parent: GitOid;
      readonly tree: GitOid;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly status: 'contradiction';
      readonly detail: string;
    };

export interface MarketplaceMutationGitPort {
  readState(
    input: MarketplaceMutationCommitIdentity,
  ): Promise<MarketplaceMutationGitState>;
  commit(
    input: MarketplaceMutationCommitIdentity,
  ): Promise<Extract<MarketplaceMutationGitState, { readonly status: 'committed' }>>;
}

function safeLine(value: string, field: string): string {
  if (value.length === 0 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`Invalid marketplace commit ${field}`);
  }
  return value;
}

function normalizedTouchedPaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) throw new Error('Marketplace commit requires touched paths');
  const normalized = [...new Set(paths)].sort();
  for (const path of normalized) {
    const segments = path.split('/');
    if (
      path.length === 0
      || isAbsolute(path)
      || path.includes('\\')
      || /[\u0000\r\n]/.test(path)
      || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw new Error(`Invalid marketplace commit path: ${path}`);
    }
  }
  return normalized;
}

export function formatMarketplaceMutationCommitMessage(
  input: MarketplaceMutationCommitIdentity,
): string {
  const summary = input.summary.trim();
  if (summary.length === 0 || /[\u0000\r\n]/.test(summary)) {
    throw new Error('Invalid marketplace commit summary');
  }
  if (
    input.childIssueNumber !== undefined
    && (!Number.isSafeInteger(input.childIssueNumber) || input.childIssueNumber <= 0)
  ) {
    throw new Error('Invalid marketplace commit child issue number');
  }
  return [
    summary,
    '',
    ...(input.childIssueNumber === undefined
      ? []
      : [`Jinn-Autopilot-Issue: ${input.childIssueNumber}`]),
    `jinn-marketplace-task: ${safeLine(input.taskId, 'task ID')}`,
    `jinn-marketplace-request: ${safeLine(input.requestId, 'request ID')}`,
    `jinn-marketplace-envelope: ${safeLine(
      input.deliveryEnvelopeCid,
      'envelope CID',
    )}`,
    `jinn-autopilot-attempt: ${safeLine(input.v2AttemptId, 'attempt ID')}`,
    '',
  ].join('\n');
}

function outputText(result: MarketplaceMutationGitCommandResult): string {
  return new TextDecoder().decode(result.stdout);
}

function commandError(
  command: MarketplaceMutationGitCommand,
  result: MarketplaceMutationGitCommandResult,
): Error {
  const detail = result.stderr.trim();
  return new Error(
    `git ${command.args.join(' ')} exited with ${result.exitCode}`
      + (detail.length === 0 ? '' : `: ${detail}`),
  );
}

async function runSuccessful(
  runGit: MarketplaceMutationGitRunner,
  command: MarketplaceMutationGitCommand,
): Promise<MarketplaceMutationGitCommandResult> {
  const result = await runGit(command);
  if (result.exitCode !== 0) throw commandError(command, result);
  return result;
}

function parseNulPaths(bytes: Uint8Array): readonly string[] {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (value.length === 0) return [];
  if (!value.endsWith('\u0000')) {
    throw new Error('Git path output was not NUL terminated');
  }
  return value.slice(0, -1).split('\u0000').sort();
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((path, index) => path === right[index]);
}

async function currentChangedPaths(
  input: MarketplaceMutationCommitIdentity,
  runGit: MarketplaceMutationGitRunner,
): Promise<readonly string[]> {
  const tracked = await runSuccessful(runGit, {
    command: 'git',
    args: ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'],
    cwd: input.worktreePath,
  });
  const untracked = await runSuccessful(runGit, {
    command: 'git',
    args: ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    cwd: input.worktreePath,
  });
  return [...new Set([
    ...parseNulPaths(tracked.stdout),
    ...parseNulPaths(untracked.stdout),
  ])].sort();
}

async function readHead(
  input: MarketplaceMutationCommitIdentity,
  runGit: MarketplaceMutationGitRunner,
): Promise<GitOid> {
  const result = await runSuccessful(runGit, {
    command: 'git',
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    cwd: input.worktreePath,
  });
  return gitOid(outputText(result).trim());
}

async function readCommittedState(
  input: MarketplaceMutationCommitIdentity,
  head: GitOid,
  localHead: GitOid,
  revision: 'HEAD' | 'HEAD^',
  expectedPaths: readonly string[],
  runGit: MarketplaceMutationGitRunner,
): Promise<MarketplaceMutationGitState> {
  const results = await Promise.all([
    runSuccessful(runGit, {
      command: 'git',
      args: ['rev-parse', '--verify', `${revision}^`],
      cwd: input.worktreePath,
    }),
    runSuccessful(runGit, {
      command: 'git',
      args: ['rev-parse', '--verify', `${revision}^{tree}`],
      cwd: input.worktreePath,
    }),
    runSuccessful(runGit, {
      command: 'git',
      args: ['show', '-s', '--format=%B', revision],
      cwd: input.worktreePath,
    }),
    runSuccessful(runGit, {
      command: 'git',
      args: [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '-r',
        '-z',
        revision,
      ],
      cwd: input.worktreePath,
    }),
  ]);
  const [parentResult, treeResult, messageResult, pathsResult] = results;
  const parent = gitOid(outputText(parentResult).trim());
  const tree = gitOid(outputText(treeResult).trim());
  const message = outputText(messageResult).trimEnd();
  const changedPaths = parseNulPaths(pathsResult.stdout);
  if (
    parent !== input.expectedHead
    || message !== formatMarketplaceMutationCommitMessage(input).trimEnd()
    || !samePaths(changedPaths, expectedPaths)
    || (await currentChangedPaths(input, runGit)).length !== 0
  ) {
    return {
      status: 'contradiction',
      detail: 'Local HEAD is not the exact marketplace host commit',
    };
  }
  return {
    status: 'committed',
    head,
    localHead,
    parent,
    tree,
    changedPaths,
  };
}

export function makeMarketplaceMutationGitPort(options: {
  readonly runGit: MarketplaceMutationGitRunner;
}): MarketplaceMutationGitPort {
  return {
    async readState(input) {
      const expectedPaths = normalizedTouchedPaths(input.touchedPaths);
      const head = await readHead(input, options.runGit);
      if (head !== input.expectedHead) {
        const direct = await readCommittedState(
          input,
          head,
          head,
          'HEAD',
          expectedPaths,
          options.runGit,
        );
        if (direct.status === 'committed') return direct;
        const parent = await runSuccessful(options.runGit, {
          command: 'git',
          args: ['rev-parse', '--verify', 'HEAD^'],
          cwd: input.worktreePath,
        });
        const parentHead = gitOid(outputText(parent).trim());
        if (parentHead === input.expectedHead) return direct;
        return readCommittedState(
          input,
          parentHead,
          head,
          'HEAD^',
          expectedPaths,
          options.runGit,
        );
      }
      const changedPaths = await currentChangedPaths(input, options.runGit);
      if (changedPaths.length === 0) return { status: 'clean', head };
      if (!samePaths(changedPaths, expectedPaths)) {
        return {
          status: 'contradiction',
          detail: 'Worktree changes are not exactly the delivered patch paths',
        };
      }
      return { status: 'pending-change', head, changedPaths };
    },

    async commit(input) {
      const state = await this.readState(input);
      if (state.status === 'committed') return state;
      if (state.status !== 'pending-change') {
        throw new Error(
          state.status === 'contradiction'
            ? state.detail
            : 'Marketplace host commit requires a real tree change',
        );
      }
      const touchedPaths = normalizedTouchedPaths(input.touchedPaths);
      await runSuccessful(options.runGit, {
        command: 'git',
        args: ['add', '--all', '--', ...touchedPaths],
        cwd: input.worktreePath,
      });
      const staged = await options.runGit({
        command: 'git',
        args: ['diff', '--cached', '--quiet', '--exit-code'],
        cwd: input.worktreePath,
      });
      if (staged.exitCode === 0) {
        throw new Error('Marketplace host commit requires a real tree change');
      }
      if (staged.exitCode !== 1) {
        throw commandError({
          command: 'git',
          args: ['diff', '--cached', '--quiet', '--exit-code'],
          cwd: input.worktreePath,
        }, staged);
      }
      await runSuccessful(options.runGit, {
        command: 'git',
        args: ['commit', '--no-verify', '--file=-'],
        cwd: input.worktreePath,
        stdin: new TextEncoder().encode(formatMarketplaceMutationCommitMessage(input)),
      });
      const committed = await this.readState(input);
      if (committed.status !== 'committed') {
        throw new Error('Marketplace host commit did not reconstruct after creation');
      }
      return committed;
    },
  };
}

export const defaultMarketplaceMutationGitRunner: MarketplaceMutationGitRunner = (
  command,
) => new Promise((resolve, reject) => {
  const child = spawn(command.command, [...command.args], {
    cwd: command.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  const settleReject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(error);
  };
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    settleReject(new Error('Git command exceeded the marketplace safety timeout'));
  }, GIT_COMMAND_TIMEOUT_MS);

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_GIT_STDOUT_BYTES) {
      child.kill('SIGKILL');
      settleReject(new Error('Git command output exceeded the marketplace safety limit'));
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = MAX_GIT_STDERR_BYTES - stderrBytes;
    if (remaining <= 0) return;
    const retained = chunk.subarray(0, remaining);
    stderr.push(retained);
    stderrBytes += retained.byteLength;
  });
  child.on('error', settleReject);
  child.stdin.on('error', settleReject);
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
  });
  child.stdin.end(
    command.stdin === undefined ? undefined : Buffer.from(command.stdin),
  );
});
