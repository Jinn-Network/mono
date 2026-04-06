/**
 * Pull request creation and updates
 */

import { workerLogger } from '../../logging/index.js';
import type { CodeMetadata } from '../../agent/shared/code_metadata.js';
import { GITHUB_API_URL, DEFAULT_BASE_BRANCH } from '../constants.js';
import { serializeError } from '../logging/errors.js';
import { formatSummaryForPr } from './autoCommit.js';
import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { createArtifact } from '../control_api_client.js';
import { fetchWithRetry } from '../../http/client.js';
import { config, secrets } from '../../config/index.js';

// Re-export for use in other modules
export { formatSummaryForPr };

/**
 * Branch artifact metadata structure
 */
export interface BranchArtifactContent {
  branchUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  summary?: string;
  requestId: string;
  jobDefinitionId: string;
  createdAt: string;
  mergeStatus?: 'mergeable' | 'conflict' | 'unknown';
}

// Keep old interface for backward compatibility
export type PullRequestArtifactContent = BranchArtifactContent;

/**
 * Parse GitHub repository info from remote URL
 */
function parseGithubRepo(remoteUrl: string | undefined, branchName: string): { owner: string; repo: string; head: string } | null {
  const normalizeRepository = (value?: string | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim().replace(/\.git$/i, '');
    if (!trimmed.includes('/')) return null;
    return trimmed;
  };

  const inferRepositoryFromRemote = (url?: string): string | null => {
    if (!url) return null;

    // SSH format: git@host:owner/repo.git
    const sshMatch = url.match(/^git@([^:]+?):(.+?)$/);
    if (sshMatch) {
      return normalizeRepository(sshMatch[2]);
    }

    // SCP-like shorthand without scheme: host:owner/repo.git
    const scpMatch = url.match(/^([^@]+?):(.+?)$/);
    if (scpMatch && !url.includes('://')) {
      return normalizeRepository(scpMatch[2]);
    }

    // HTTPS/SSH URL forms: https://host/owner/repo.git or ssh://...
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.replace(/^\/+/, '');
      return normalizeRepository(pathname);
    } catch {
      return null;
    }
  };

  const repository = normalizeRepository(config.git.githubRepository) ?? inferRepositoryFromRemote(remoteUrl);
  if (config.git.githubRepository) {
    workerLogger.debug({ repository }, 'Using GITHUB_REPOSITORY from environment');
  } else if (repository) {
    workerLogger.debug({ repository, remoteUrl }, 'Inferred repository from remote URL');
  }
  if (!repository) return null;

  const [owner, repo] = repository.split('/', 2);
  if (!owner || !repo) return null;
  return { owner, repo, head: `${owner}:${branchName}` };
}

/**
 * Generate a branch URL for viewing on the remote (e.g., GitHub)
 * Converts git remote URL to HTTPS branch URL
 * 
 * Supported formats:
 * - SSH: git@github.com:owner/repo.git
 * - SSH alias: alias:owner/repo.git (uses github.com as default host)
 * - HTTPS: https://github.com/owner/repo.git
 */
export function generateBranchUrl(codeMetadata: CodeMetadata, branchName: string): string | null {
  try {
    const remoteUrl = codeMetadata.repo?.remoteUrl || codeMetadata.branch?.remoteUrl;
    if (!remoteUrl) {
      workerLogger.warn('No remote URL available to generate branch URL');
      return null;
    }

    let httpsBase: string;

    // Handle SSH format: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(\.git)?$/);
    if (sshMatch) {
      const [, host, path] = sshMatch;
      httpsBase = `https://${host}/${path}`;
    }
    // Handle HTTPS format: https://github.com/owner/repo.git
    else if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
      httpsBase = remoteUrl.replace(/\.git$/, '');
    }
    // Handle SSH alias format: alias:owner/repo.git (e.g., ritsukai:ritsukai/local-arcade.git)
    // This format is used with SSH config host aliases - we assume github.com as the host
    else {
      const aliasMatch = remoteUrl.match(/^([^:@]+):(.+?)(\.git)?$/);
      if (aliasMatch) {
        const [, , path] = aliasMatch;
        // SSH aliases typically point to GitHub; use github.com as default host
        httpsBase = `https://github.com/${path}`;
        workerLogger.debug({ remoteUrl, httpsBase }, 'Generated branch URL from SSH alias format');
      } else {
        workerLogger.warn({ remoteUrl }, 'Unknown git remote URL format');
        return null;
      }
    }

    return `${httpsBase}/tree/${branchName}`;
  } catch (error) {
    workerLogger.error({ error: serializeError(error) }, 'Failed to generate branch URL');
    return null;
  }
}

/**
 * Create or update pull request for job branch
 */
export async function createOrUpdatePullRequest(params: {
  codeMetadata: CodeMetadata;
  branchName: string;
  baseBranch: string;
  requestId: string;
  summaryBlock?: string;
}): Promise<string | null> {
  const { codeMetadata, branchName, baseBranch, requestId, summaryBlock } = params;
  const token = secrets.githubToken;
  if (!token) {
    workerLogger.warn('Missing GITHUB_TOKEN; skipping PR creation');
    return null;
  }

  const repoInfo = parseGithubRepo(codeMetadata.repo?.remoteUrl || codeMetadata.branch.remoteUrl, branchName);
  if (!repoInfo) {
    workerLogger.warn('Unable to infer GitHub repository from remote; skipping PR creation');
    return null;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'jinn-mech-worker',
  };

  const searchUrl = `${GITHUB_API_URL}/repos/${repoInfo.owner}/${repoInfo.repo}/pulls?head=${encodeURIComponent(repoInfo.head)}&state=open`;
  try {
    const res = await fetchWithRetry(searchUrl, { headers }, {
      timeoutMs: 10000,
      maxRetries: 2,
      context: { operation: 'searchPRs', branchName }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        workerLogger.info({ branchName, pr: data[0]?.number }, 'Existing PR found for branch');
        return data[0]?.html_url || null;
      }
    } else {
      workerLogger.warn({ status: res.status, statusText: res.statusText }, 'Failed to query existing PRs');
    }
  } catch (error) {
    workerLogger.warn({ error: serializeError(error) }, 'Error querying GitHub for existing PR');
  }

  const title = `[Job ${codeMetadata.jobDefinitionId}] updates`;
  const bodyLines = [
    `Automated PR for job definition ${codeMetadata.jobDefinitionId}.`,
    '',
    `- Request ID: ${requestId}`,
    `- Branch: \`${branchName}\``,
    `- Base: \`${baseBranch}\``,
    '',
    'This PR was generated by the mech worker after successful validation.',
  ];

  // Add execution summary if provided
  const formattedSummary = summaryBlock || formatSummaryForPr(null);
  if (formattedSummary) {
    bodyLines.push('', formattedSummary);
  }

  try {
    const res = await fetchWithRetry(
      `${GITHUB_API_URL}/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          head: branchName,
          base: baseBranch,
          body: bodyLines.join('\n'),
        }),
      },
      {
        timeoutMs: 15000,
        maxRetries: 3,
        context: { operation: 'createPR', branchName, requestId }
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub PR creation failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const prUrl = data?.html_url as string | undefined;
    workerLogger.info({ branchName, prUrl }, 'Created GitHub PR');
    return prUrl || null;
  } catch (error) {
    workerLogger.error({
      error: serializeError(error)
    }, 'Failed to create pull request');
    throw error;  // Let caller handle PR creation failure
  }
}

/**
 * Create a branch artifact for a child job's branch
 */
export interface BranchArtifactRecord {
  cid: string;
  topic: string;
  name: string;
  type: 'GIT_BRANCH';
  contentPreview?: string;
  content?: string;
}

// Keep old interface name for backward compatibility
export type PullRequestArtifactRecord = BranchArtifactRecord;

export async function createBranchArtifact(params: {
  requestId: string;
  branchUrl: string;
  branchName: string;
  baseBranch: string;
  title: string;
  summaryBlock?: string;
  codeMetadata: CodeMetadata;
}): Promise<BranchArtifactRecord | null> {
  const { requestId, branchUrl, branchName, baseBranch, title, summaryBlock, codeMetadata } = params;

  try {
    const artifactName = `branch-${branchName}`;
    // Generate contentPreview in format expected by getDependencyBranchInfo parser
    // Format: "Branch: <branchName> based on <baseBranch>"
    // This ensures regex parsing works as fallback if JSON parsing fails
    const contentPreview = `Branch: ${branchName} based on ${baseBranch}${summaryBlock ? ` - ${summaryBlock.slice(0, 50)}` : ''}`;

    const artifactPayload = {
      name: artifactName,
      topic: 'git/branch',
      content: JSON.stringify({
        branchUrl,
        headBranch: branchName,
        baseBranch,
        title,
        summary: summaryBlock || undefined,
        requestId,
        jobDefinitionId: codeMetadata.jobDefinitionId,
        createdAt: new Date().toISOString(),
      } as BranchArtifactContent),
      mimeType: 'application/json',
      type: 'GIT_BRANCH',
      tags: ['git-branch', 'git', branchName, baseBranch].filter(Boolean),
    };

    // Upload to IPFS first; without a CID we can't surface the artifact anywhere else.
    const [, cid] = await pushJsonToIpfs(artifactPayload);

    const artifactRecord: BranchArtifactRecord = {
      cid,
      topic: 'git/branch',
      name: artifactName,
      type: 'GIT_BRANCH',
      contentPreview,
      content: artifactPayload.content,
    };

    // Persist through Control API, but don't fail the artifact if persistence flakes.
    try {
      await createArtifact(requestId, {
        cid,
        topic: 'git/branch',
        content: null,
      });
    } catch (controlApiError: any) {
      workerLogger.warn(
        {
          requestId,
          branchUrl,
          error: serializeError(controlApiError),
        },
        'Failed to persist branch artifact via Control API'
      );
    }

    workerLogger.info(
      { requestId, branchUrl, branchName, cid },
      'Created branch artifact'
    );

    return artifactRecord;
  } catch (error: any) {
    workerLogger.error(  // Change warn → error
      { requestId, branchUrl, error: serializeError(error) },
      'Failed to create branch artifact'
    );
    throw new Error(`Branch artifact creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Export backward-compatible function name
export const createPullRequestArtifact = createBranchArtifact;

/**
 * Fetch branch details (merge status + diff) using Git-native commands
 * This removes the dependency on GitHub API for reviewing branches
 */
export async function fetchBranchDetails(params: {
  headBranch: string;
  baseBranch: string;
  repoPath: string;
}): Promise<{
  mergeStatus: 'mergeable' | 'conflict' | 'unknown';
  diffSummary: string;
} | null> {
  const { headBranch, baseBranch, repoPath } = params;

  try {
    const { execFileSync } = await import('node:child_process');

    // 1. Fetch the latest state of both branches from origin
    try {
      execFileSync('git', ['fetch', 'origin', headBranch], {
        cwd: repoPath,
        stdio: 'pipe',
      });
      execFileSync('git', ['fetch', 'origin', baseBranch], {
        cwd: repoPath,
        stdio: 'pipe',
      });
    } catch (fetchError) {
      workerLogger.warn(
        { error: serializeError(fetchError), headBranch, baseBranch },
        'Failed to fetch branches from origin'
      );
      return null;
    }

    // 2. Check for merge conflicts using git merge-tree
    // Git merge-tree returns a single 40-character SHA-1 tree hash if mergeable
    const GIT_SHA1_LENGTH = 40;
    let mergeStatus: 'mergeable' | 'conflict' | 'unknown' = 'unknown';
    try {
      const mergeTreeOutput = execFileSync('git', [
        'merge-tree', '--write-tree', `origin/${baseBranch}`, `origin/${headBranch}`
      ], {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // If merge-tree succeeds without conflicts, status is mergeable
      // The output is just a tree hash if there are no conflicts
      const mergeTreeHash = mergeTreeOutput.trim();
      mergeStatus = mergeTreeHash.length === GIT_SHA1_LENGTH && /^[0-9a-f]+$/.test(mergeTreeHash)
        ? 'mergeable'
        : 'unknown';
    } catch (mergeTreeError: any) {
      // If merge-tree exits with non-zero, there are conflicts
      if (mergeTreeError.status !== 0) {
        mergeStatus = 'conflict';
      }
    }

    // 3. Generate diff summary
    let diffSummary = '';
    try {
      const diffText = execFileSync('git', [
        'diff', `origin/${baseBranch}...origin/${headBranch}`
      ], {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024, // 5MB max
      });
      // Truncate diff if too large (e.g., 2000 chars) to avoid blowing up context
      diffSummary = diffText.length > 2000
        ? diffText.slice(0, 2000) + '\n... (diff truncated)'
        : diffText;
    } catch (diffError) {
      workerLogger.warn(
        { error: serializeError(diffError), headBranch, baseBranch },
        'Failed to generate diff summary'
      );
      diffSummary = '(unable to generate diff)';
    }

    return { mergeStatus, diffSummary };
  } catch (error) {
    workerLogger.warn(
      { error: serializeError(error), headBranch, baseBranch },
      'Failed to fetch branch details'
    );
    return null;
  }
}
