import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../../config/index.js';
import { normalizeSshUrl } from '../../shared/repo_utils.js';

const execFileAsync = promisify(execFile);

// Increased timeout for git operations - push to remote can take 10-30 seconds
const GIT_TIMEOUT_MS = 30_000;

// Helper to get repo root dynamically (for test environment compatibility)
function getRepoRoot(): string {
  return config.git.repoRoot;
}

type Nullable<T> = T | null | undefined;

type GitArgs = string[];

export interface BranchStatus {
  isDirty: boolean;
  ahead?: number;
  behind?: number;
}

export interface BranchSnapshot {
  name: string;
  headCommit: string;
  upstream?: string;
  remoteUrl?: string;
  status?: BranchStatus;
}

export interface RepoMetadata {
  // Note: root field removed for security reasons (prevents leaking local paths on-chain)
  // Use JINN_WORKSPACE_DIR env var or CODE_METADATA_REPO_ROOT instead
  remoteUrl?: string;
}

export interface CodeLineageRef {
  jobDefinitionId?: string;
  requestId?: string;
}

export interface CodeMetadata {
  branch: BranchSnapshot;
  repo?: RepoMetadata;
  baseBranch?: string;
  capturedAt: string;
  jobDefinitionId: string;
  requestId?: string;
  parent?: CodeLineageRef;
  root?: CodeLineageRef;
  annotations?: Record<string, unknown>;
}

export interface CodeMetadataHints {
  jobDefinitionId: string;
  requestId?: string;
  parent?: CodeLineageRef;
  root?: CodeLineageRef;
  annotations?: Record<string, unknown>;
  baseBranch?: string;
  branchName?: string; // Explicit branch name to use instead of querying git HEAD
}

export interface BranchNamingOptions {
  jobDefinitionId: string;
  jobName?: Nullable<string>;
  maxSlugLength?: number;
}

export interface EnsureBranchOptions extends BranchNamingOptions {
  baseBranch?: string;
  remoteName?: string;
}

export interface EnsureBranchResult {
  branchName: string;
  created: boolean;
  pushed: boolean;
}

function debugLog(...args: unknown[]): void {
  if (false) {
    console.debug('[code-metadata]', ...args);
  }
}

async function runGit(args: GitArgs, opts: { cwd?: string; throwOnError?: boolean } = {}): Promise<string | undefined> {
  const cwd = opts.cwd || getRepoRoot();
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error: any) {
    const gitCommand = `git ${args.join(' ')}`;

    // Enhanced error message with context
    if (opts.throwOnError) {
      let errorMessage = `Git command failed in ${cwd}: ${gitCommand}\n`;

      if (error.stderr) {
        errorMessage += `Error output: ${error.stderr}\n`;
      }

      if (error.message) {
        errorMessage += `Details: ${error.message}\n`;
      }

      // Add helpful hints for common errors
      if (error.stderr?.includes('Permission denied') || error.stderr?.includes('publickey')) {
        errorMessage += '\n💡 Hint: SSH authentication failed. Ensure your SSH key is added:\n';
        errorMessage += '   ssh-add ~/.ssh/id_ed25519  # or your key path\n';
        errorMessage += '   ssh-add -l  # verify key is loaded\n';
      }

      if (error.stderr?.includes('could not read Username') || error.stderr?.includes('authentication')) {
        errorMessage += '\n💡 Hint: Git authentication required. You may need to configure credentials.\n';
      }

      if (args[0] === 'push' && error.stderr) {
        errorMessage += '\n💡 Hint: Check that remote is accessible and you have push permissions.\n';
      }

      throw new Error(errorMessage);
    }

    debugLog('git command failed', args.join(' '), error);
    return undefined;
  }
}

function parseAheadBehind(value?: string): BranchStatus | undefined {
  if (!value) return undefined;
  const [behindStr, aheadStr] = value.trim().split(/\s+/, 2);
  const behind = Number(behindStr);
  const ahead = Number(aheadStr);
  if (Number.isNaN(behind) && Number.isNaN(ahead)) return undefined;
  return {
    isDirty: false,
    behind: Number.isNaN(behind) ? undefined : behind,
    ahead: Number.isNaN(ahead) ? undefined : ahead,
  };
}

function parseRemoteFromUpstream(upstream?: string): string | undefined {
  if (!upstream) return undefined;
  const slashIndex = upstream.indexOf('/');
  if (slashIndex <= 0) return undefined;
  return upstream.slice(0, slashIndex);
}

function normalizeSlug(value: string, maxLength: number = 50): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;

  const sanitized = trimmed
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!sanitized) return undefined;
  return sanitized.slice(0, maxLength);
}

export function buildJobBranchName(options: BranchNamingOptions): string {
  const { jobDefinitionId, jobName, maxSlugLength = 20 } = options;
  const base = `job/${jobDefinitionId}`;
  const slug = jobName ? normalizeSlug(jobName, maxSlugLength) : undefined;
  return slug ? `${base}-${slug}` : base;
}

async function branchExists(branchName: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', branchName]);
  return Boolean(result);
}

async function remoteBranchExists(remote: string, branchName: string): Promise<boolean> {
  const result = await runGit(['ls-remote', '--heads', remote, branchName]);
  return Boolean(result);
}

async function createBranchLocal(branchName: string, baseBranch: string): Promise<void> {
  // When running inside a job (parent branch hasn't been pushed yet),
  // use HEAD commit instead of branch name to avoid "not a valid object name" error
  let baseRef = baseBranch;

  // Check if baseBranch looks like a job branch (job/uuid-slug pattern)
  const isJobBranch = /^job\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(baseBranch);

  if (isJobBranch) {
    // Verify if the branch exists as a git reference
    const branchRefExists = await runGit(['rev-parse', '--verify', baseBranch]);

    if (!branchRefExists) {
      // Branch doesn't exist yet (parent hasn't been pushed) - use current HEAD commit
      const headCommit = await runGit(['rev-parse', 'HEAD']);
      if (headCommit) {
        debugLog(`Parent branch ${baseBranch} not found, using HEAD commit ${headCommit.substring(0, 7)}`);
        baseRef = headCommit;
      } else {
        throw new Error(`Cannot create branch ${branchName}: neither ${baseBranch} nor HEAD could be resolved`);
      }
    } else {
      debugLog(`Using existing parent branch ${baseBranch} as base`);
    }
  } else {
    // For non-job branches (e.g., main, master), prefer origin/{branch} to ensure latest
    const remoteRef = `origin/${baseBranch}`;
    const remoteRefExists = await runGit(['rev-parse', '--verify', remoteRef]);

    if (remoteRefExists) {
      // Use remote ref to ensure we branch from latest
      baseRef = remoteRef;
      debugLog(`Using remote ${remoteRef} as base for ${branchName}`);
    } else {
      // Fall back to local if remote doesn't exist (offline mode / new repo)
      const localRefExists = await runGit(['rev-parse', '--verify', baseBranch]);
      if (!localRefExists) {
        throw new Error(
          `Cannot create branch ${branchName}: base branch '${baseBranch}' does not exist.\n\n` +
          `💡 This repository needs a '${baseBranch}' branch to branch from.\n` +
          `   Please create it with:\n` +
          `   git checkout -b ${baseBranch}\n` +
          `   git commit --allow-empty -m "Initial commit"\n` +
          `   git push -u origin ${baseBranch}\n`
        );
      }
      debugLog(`Remote ${remoteRef} not found, falling back to local ${baseBranch}`);
    }
  }

  await runGit(['branch', branchName, baseRef], { throwOnError: true });
  if (!(await branchExists(branchName))) {
    throw new Error(`Failed to create branch ${branchName} from ${baseRef}`);
  }

  debugLog(`Created branch ${branchName} from ${baseRef}`);
}

async function pushBranch(remote: string, branchName: string): Promise<boolean> {
  // Verify branch has commits before trying to push
  const hasCommits = await runGit(['rev-list', '--count', branchName]);
  if (!hasCommits || parseInt(hasCommits) === 0) {
    throw new Error(`Cannot push branch ${branchName}: branch has no commits`);
  }

  // Verify remote exists
  const remoteExists = await runGit(['remote', 'get-url', remote]);
  if (!remoteExists) {
    throw new Error(`Cannot push: remote "${remote}" is not configured`);
  }

  // Attempt push with enhanced error handling
  const result = await runGit(['push', '-u', remote, `${branchName}:${branchName}`], { throwOnError: true });
  return Boolean(result);
}

export async function ensureJobBranch(
  options: EnsureBranchOptions,
): Promise<EnsureBranchResult> {
  const branchName = buildJobBranchName(options);
  const baseBranch = options.baseBranch || config.git.defaultBaseBranch;
  const remoteName = options.remoteName || 'origin';

  let created = false;
  let pushed = false;

  if (!(await branchExists(branchName))) {
    await createBranchLocal(branchName, baseBranch);
    created = true;
  }

  if (!(await remoteBranchExists(remoteName, branchName))) {
    pushed = await pushBranch(remoteName, branchName);
  }

  return { branchName, created, pushed };
}

export async function collectLocalCodeMetadata(
  hints: CodeMetadataHints,
): Promise<CodeMetadata | null> {
  if (!hints?.jobDefinitionId) {
    throw new Error('collectLocalCodeMetadata requires a jobDefinitionId');
  }

  // Use explicitly provided branch name if available, otherwise query git
  const branchName = hints.branchName || await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const headCommit = await runGit(['rev-parse', 'HEAD']);

  if (!branchName || !headCommit) {
    debugLog('Unable to resolve branch/commit; returning null');
    return null;
  }

  const upstream = await runGit(['rev-parse', '--abbrev-ref', '@{u}']);

  // Get the raw remote URL and normalize it for portability
  // Custom SSH aliases (e.g., git@ritsukai:) are converted to git@github.com:
  const rawRemoteUrl = await runGit([
    'remote',
    'get-url',
    parseRemoteFromUpstream(upstream) || 'origin',
  ]);
  const remoteCandidate = rawRemoteUrl ? normalizeSshUrl(rawRemoteUrl) : undefined;

  const porcelain = await runGit(['status', '--porcelain']);
  const aheadBehindRaw = upstream
    ? await runGit(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
    : undefined;
  const aheadBehind = parseAheadBehind(aheadBehindRaw);

  const status: BranchStatus = {
    isDirty: Boolean(porcelain && porcelain.length > 0),
    ahead: aheadBehind?.ahead,
    behind: aheadBehind?.behind,
  };

  const branchSnapshot: BranchSnapshot = {
    name: branchName,
    headCommit,
    upstream: upstream || undefined,
    remoteUrl: remoteCandidate,
    status,
  };

  const metadata: CodeMetadata = {
    branch: branchSnapshot,
    repo: {
      // Note: root field removed for security (prevents leaking local paths on-chain)
      remoteUrl: remoteCandidate,
    },
    baseBranch: hints.baseBranch || config.git.defaultBaseBranch,
    capturedAt: new Date().toISOString(),
    jobDefinitionId: hints.jobDefinitionId,
  };

  if (hints.requestId) metadata.requestId = hints.requestId;
  if (hints.parent) metadata.parent = hints.parent;
  if (hints.root) metadata.root = hints.root;
  if (hints.annotations) metadata.annotations = hints.annotations;

  return metadata;
}
