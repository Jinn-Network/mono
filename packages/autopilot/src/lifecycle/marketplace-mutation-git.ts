import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  decodeBranchClaimTrailers,
  extractImplementationCompletionSummary,
  terminalBranchClaimTrailers,
} from './codecs.js';
import { gitOid, type BranchClaim, type GitOid } from './types.js';

const MAX_GIT_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 60_000;

export interface MarketplaceMutationCommitIdentity {
  readonly worktreePath: string;
  readonly expectedHead: GitOid;
  readonly artifact: Uint8Array;
  readonly workflow: 'implement' | 'fix-child' | 'reconcile' | 'ci-failure';
  readonly touchedPaths: readonly string[];
  readonly summary: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly v2AttemptId: string;
  readonly childIssueNumber?: number;
  readonly reconcileBase?: GitOid;
  readonly protocolCompletion?: {
    readonly head: GitOid;
    readonly claim: BranchClaim & {
      readonly phase: 'implement';
      readonly phaseComplete: true;
    };
  };
}

export interface MarketplaceMutationGitCommand {
  readonly command: 'git';
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: Uint8Array;
  readonly environment?: Readonly<Record<string, string>>;
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
      readonly tree: GitOid;
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

function validateCommitTopology(input: MarketplaceMutationCommitIdentity): void {
  if (input.artifact.byteLength === 0) {
    throw new Error('Marketplace commit requires the delivered patch');
  }
  if (
    input.workflow === 'reconcile'
      ? input.reconcileBase === undefined
      : input.reconcileBase !== undefined
  ) {
    throw new Error('Marketplace reconcile topology is incomplete');
  }
  if (
    input.protocolCompletion !== undefined
    && input.workflow !== 'implement'
  ) {
    throw new Error('Only implementation may carry a completion marker');
  }
}

async function withTemporaryIndex<T>(
  operation: (environment: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    join(tmpdir(), 'jinn-marketplace-mutation-index-'),
  );
  try {
    return await operation({
      GIT_INDEX_FILE: join(directory, 'index'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectedTreeFromArtifact(
  input: MarketplaceMutationCommitIdentity,
  runGit: MarketplaceMutationGitRunner,
): Promise<GitOid> {
  return withTemporaryIndex(async (environment) => {
    await runSuccessful(runGit, {
      command: 'git',
      args: ['read-tree', input.expectedHead],
      cwd: input.worktreePath,
      environment,
    });
    await runSuccessful(runGit, {
      command: 'git',
      args: ['apply', '--cached', '--whitespace=nowarn', '--'],
      cwd: input.worktreePath,
      stdin: input.artifact,
      environment,
    });
    const tree = await runSuccessful(runGit, {
      command: 'git',
      args: ['write-tree'],
      cwd: input.worktreePath,
      environment,
    });
    return gitOid(outputText(tree).trim());
  });
}

async function worktreeTree(
  input: MarketplaceMutationCommitIdentity,
  paths: readonly string[],
  runGit: MarketplaceMutationGitRunner,
): Promise<GitOid> {
  return withTemporaryIndex(async (environment) => {
    await runSuccessful(runGit, {
      command: 'git',
      args: ['read-tree', input.expectedHead],
      cwd: input.worktreePath,
      environment,
    });
    await runSuccessful(runGit, {
      command: 'git',
      args: ['add', '--all', '--', ...paths],
      cwd: input.worktreePath,
      environment,
    });
    const tree = await runSuccessful(runGit, {
      command: 'git',
      args: ['write-tree'],
      cwd: input.worktreePath,
      environment,
    });
    return gitOid(outputText(tree).trim());
  });
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

function expectedParents(
  input: MarketplaceMutationCommitIdentity,
): readonly GitOid[] {
  return input.workflow === 'reconcile'
    ? [input.expectedHead, input.reconcileBase!]
    : [input.expectedHead];
}

function sameClaim(
  expected: BranchClaim,
  actual: BranchClaim,
): boolean {
  return expected.kind === actual.kind
    && expected.protocolVersion === actual.protocolVersion
    && expected.phase === actual.phase
    && expected.issueNumber === actual.issueNumber
    && expected.prNumber === actual.prNumber
    && expected.attempt === actual.attempt
    && expected.runner === actual.runner
    && expected.login.toLowerCase() === actual.login.toLowerCase()
    && expected.expectedHead === actual.expectedHead
    && expected.targetBase === actual.targetBase
    && expected.claimedAt === actual.claimedAt
    && expected.phaseComplete === actual.phaseComplete;
}

async function exactProtocolCompletionParent(
  input: MarketplaceMutationCommitIdentity,
  head: GitOid,
  runGit: MarketplaceMutationGitRunner,
): Promise<GitOid | null> {
  const completion = input.protocolCompletion;
  if (completion === undefined || completion.head !== head) return null;
  const [parentsResult, messageResult, treeResult] = await Promise.all([
    runSuccessful(runGit, {
      command: 'git',
      args: ['rev-list', '--parents', '-n', '1', 'HEAD'],
      cwd: input.worktreePath,
    }),
    runSuccessful(runGit, {
      command: 'git',
      args: ['show', '-s', '--format=%B', 'HEAD'],
      cwd: input.worktreePath,
    }),
    runSuccessful(runGit, {
      command: 'git',
      args: ['rev-parse', '--verify', 'HEAD^{tree}'],
      cwd: input.worktreePath,
    }),
  ]);
  const commitLine = outputText(parentsResult).trim().split(/\s+/);
  if (commitLine.length !== 2 || commitLine[0] !== head) return null;
  const parent = gitOid(commitLine[1]!);
  const message = outputText(messageResult);
  const trailers = terminalBranchClaimTrailers(message);
  if (trailers === null) return null;
  let claim: BranchClaim;
  let summary: string | null;
  try {
    claim = decodeBranchClaimTrailers(trailers);
    summary = extractImplementationCompletionSummary(message, trailers);
  } catch {
    return null;
  }
  if (
    summary?.trim() !== input.summary.trim()
    || !sameClaim(completion.claim, claim)
    || claim.phase !== 'implement'
    || claim.phaseComplete !== true
    || claim.expectedHead !== parent
  ) {
    return null;
  }
  const parentTree = await runSuccessful(runGit, {
    command: 'git',
    args: ['rev-parse', '--verify', `${parent}^{tree}`],
    cwd: input.worktreePath,
  });
  if (outputText(treeResult).trim() !== outputText(parentTree).trim()) {
    return null;
  }
  return parent;
}

async function readCommittedState(
  input: MarketplaceMutationCommitIdentity,
  head: GitOid,
  localHead: GitOid,
  revision: 'HEAD' | 'HEAD^',
  expectedPaths: readonly string[],
  runGit: MarketplaceMutationGitRunner,
): Promise<MarketplaceMutationGitState> {
  const expectedTree = await expectedTreeFromArtifact(input, runGit);
  const results = await Promise.all([
    runSuccessful(runGit, {
      command: 'git',
      args: ['rev-list', '--parents', '-n', '1', revision],
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
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        input.expectedHead,
        revision,
        '--',
      ],
      cwd: input.worktreePath,
    }),
  ]);
  const [parentsResult, treeResult, messageResult, pathsResult] = results;
  const commitLine = outputText(parentsResult).trim().split(/\s+/);
  const commit = gitOid(commitLine[0]!);
  const parents = commitLine.slice(1).map((value) => gitOid(value));
  const parent = parents[0];
  const tree = gitOid(outputText(treeResult).trim());
  const message = outputText(messageResult).trimEnd();
  const changedPaths = parseNulPaths(pathsResult.stdout);
  if (
    commit !== head
    || parent === undefined
    || !samePaths(parents, expectedParents(input))
    || tree !== expectedTree
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
      validateCommitTopology(input);
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
        const parentHead = await exactProtocolCompletionParent(
          input,
          head,
          options.runGit,
        );
        if (parentHead === null) return direct;
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
      const [expectedTree, candidateTree] = await Promise.all([
        expectedTreeFromArtifact(input, options.runGit),
        worktreeTree(input, expectedPaths, options.runGit),
      ]);
      if (candidateTree !== expectedTree) {
        return {
          status: 'contradiction',
          detail: 'Worktree tree does not match the delivered patch',
        };
      }
      return {
        status: 'pending-change',
        head,
        tree: candidateTree,
        changedPaths,
      };
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
      const stagedTree = await runSuccessful(options.runGit, {
        command: 'git',
        args: ['write-tree'],
        cwd: input.worktreePath,
      });
      if (gitOid(outputText(stagedTree).trim()) !== state.tree) {
        throw new Error('Staged tree differs from the delivered patch');
      }
      if (input.workflow === 'reconcile') {
        const base = await runSuccessful(options.runGit, {
          command: 'git',
          args: [
            'rev-parse',
            '--verify',
            `${input.reconcileBase!}^{commit}`,
          ],
          cwd: input.worktreePath,
        });
        if (gitOid(outputText(base).trim()) !== input.reconcileBase) {
          throw new Error('Reconcile base commit changed');
        }
        const created = await runSuccessful(options.runGit, {
          command: 'git',
          args: [
            'commit-tree',
            state.tree,
            '-p',
            input.expectedHead,
            '-p',
            input.reconcileBase!,
          ],
          cwd: input.worktreePath,
          stdin: new TextEncoder().encode(
            formatMarketplaceMutationCommitMessage(input),
          ),
        });
        const commit = gitOid(outputText(created).trim());
        await runSuccessful(options.runGit, {
          command: 'git',
          args: ['update-ref', 'HEAD', commit, input.expectedHead],
          cwd: input.worktreePath,
        });
      } else {
        await runSuccessful(options.runGit, {
          command: 'git',
          args: ['commit', '--no-verify', '--file=-'],
          cwd: input.worktreePath,
          stdin: new TextEncoder().encode(
            formatMarketplaceMutationCommitMessage(input),
          ),
        });
      }
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
    env: command.environment === undefined
      ? process.env
      : { ...process.env, ...command.environment },
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
