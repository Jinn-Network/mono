import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { CodeMetadata } from '../agent/shared/code_metadata.js';
import { config } from '../config/index.js';

/**
 * Extract repository name from a remote URL
 *
 * Supports various formats:
 * - git@github.com:user/repo.git -> repo
 * - git@host:user/repo.git -> repo
 * - https://github.com/user/repo.git -> repo
 * - https://github.com/user/repo -> repo
 *
 * @param remoteUrl - Git remote URL
 * @returns Repository name or null if cannot be extracted
 */
export function extractRepoName(remoteUrl: string): string | null {
  if (!remoteUrl) return null;

  // Match patterns like:
  // git@github.com:user/repo.git
  // git@host:user/repo.git
  // https://github.com/user/repo.git
  // https://github.com/user/repo
  const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);

  if (!match || !match[2]) return null;

  return match[2];
}

/**
 * Normalize SSH remote URLs to portable format for IPFS storage
 *
 * Custom SSH host aliases (e.g., `ritsukai` in ~/.ssh/config) are machine-specific
 * and won't work on other machines. This function converts them to standard
 * github.com URLs for portability.
 *
 * IMPORTANT: This should be called at DISPATCH time (when storing metadata in IPFS),
 * NOT at clone time. Workers cloning repos should use the already-normalized URL.
 *
 * Converts:
 * - git@ritsukai:owner/repo.git -> git@github.com:owner/repo.git
 * - git@custom-host:owner/repo.git -> git@github.com:owner/repo.git
 *
 * Preserves:
 * - git@github.com:owner/repo.git -> unchanged
 * - https://github.com/owner/repo.git -> unchanged
 *
 * @param remoteUrl - Git remote URL (potentially with custom SSH alias)
 * @returns Normalized URL with github.com as host
 */
export function normalizeSshUrl(remoteUrl: string): string {
  if (!remoteUrl) return remoteUrl;

  // Already HTTPS - no change needed
  if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
    return remoteUrl;
  }

  // Standard git@github.com format - no change needed
  if (remoteUrl.startsWith('git@github.com:')) {
    return remoteUrl;
  }

  // Match custom SSH alias format: git@alias:owner/repo.git
  // Examples:
  //   git@ritsukai:Jinn-Network/jinn-blog.git
  //   git@custom-host:owner/repo.git
  const sshAliasMatch = remoteUrl.match(/^git@([^:]+):(.+)$/);
  if (sshAliasMatch) {
    const [, host, path] = sshAliasMatch;
    // If not already github.com, convert to standard format
    if (host !== 'github.com') {
      return `git@github.com:${path}`;
    }
  }

  // Return unchanged if we can't parse it
  return remoteUrl;
}

/**
 * Get the Jinn workspace directory where ventures are cloned
 * Expands ~ to home directory and creates directory if needed
 *
 * When WORKER_ID is set, returns a worker-specific subdirectory to enable
 * parallel workers on the same workstream without git conflicts.
 *
 * Structure:
 *   ~/.jinn-repos/workers/{worker-id}/{repo-name}/
 *   ~/.jinn-repos/workers/default/{repo-name}/  (single worker fallback)
 *
 * @returns Absolute path to workspace directory
 */
export function getJinnWorkspaceDir(): string {
  const baseDir = config.git.workspaceDir || '~/jinn-repos';
  const workerId = config.dev.workerId || 'default';

  // Expand ~ to home directory
  const expandedBase = baseDir.startsWith('~')
    ? join(homedir(), baseDir.slice(1))
    : baseDir;

  // Include worker ID in path for isolation
  const workspaceDir = join(expandedBase, 'workers', workerId);

  // Create directory if it doesn't exist
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  return workspaceDir;
}

/**
 * Determine the repository root directory for a job
 *
 * Priority order:
 * 1. CODE_METADATA_REPO_ROOT environment variable (for tests/local development override)
 * 2. If codeMetadata.repo.remoteUrl is provided: {JINN_WORKSPACE_DIR}/{repo-name}
 * 3. process.cwd() (fallback)
 *
 * @param codeMetadata - Code metadata containing repository information
 * @returns Absolute path to repository root
 */
export function getRepoRoot(codeMetadata?: CodeMetadata): string {
  // Priority 1: CODE_METADATA_REPO_ROOT env var (tests/local development override)
  if (process.env.CODE_METADATA_REPO_ROOT) {
    return process.env.CODE_METADATA_REPO_ROOT;
  }

  // Priority 2: Derive from remoteUrl (preferred for ventures)
  if (codeMetadata?.repo?.remoteUrl) {
    const repoName = extractRepoName(codeMetadata.repo.remoteUrl);
    if (repoName) {
      const workspaceDir = getJinnWorkspaceDir();
      return join(workspaceDir, repoName);
    }
  }

  // Priority 3: Current working directory (fallback)
  return process.cwd();
}
