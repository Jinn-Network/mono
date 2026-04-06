/**
 * Git-native MCP tools for branch processing
 *
 * SECURITY: All git commands use execFileSync (array form) to prevent shell injection.
 * Branch names are validated against a strict regex before use.
 */

import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { workerLogger } from '../../../logging/index.js';
import { serializeError } from '../../logging/errors.js';
import { getCurrentJobContext } from '../../../agent/mcp/tools/shared/context.js';
import { composeSinglePageResponse, decodeCursor, type ComposeSinglePageResult } from '../../../agent/mcp/tools/shared/context-management.js';
import { config } from '../../../config/index.js';
import { assertValidBranchName } from '../../../shared/git-validation.js';

interface ProcessBranchArgs {
    branch_name: string;
    action: 'merge' | 'reject' | 'checkout' | 'compare';
    rationale: string;
}

interface ProcessBranchResult {
    success: boolean;
    action: string;
    message: string;
    details?: Record<string, any>;
    next_steps?: string;
    error?: string;
    conflicting_files?: string[];
}

/**
 * Get the current git branch
 */
function getCurrentBranch(repoPath: string): string {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
    }).trim();
}

/**
 * Check if there are uncommitted changes
 */
function hasUncommittedChanges(repoPath: string): boolean {
    const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf-8',
    });
    return status.trim().length > 0;
}

/**
 * Check if a branch exists locally
 */
function branchExistsLocally(repoPath: string, branchName: string): boolean {
    try {
        execFileSync('git', ['rev-parse', '--verify', '--', branchName], {
            cwd: repoPath,
            stdio: 'pipe',
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a branch exists on remote
 */
function branchExistsOnRemote(repoPath: string, branchName: string): boolean {
    try {
        execFileSync('git', ['ls-remote', '--heads', 'origin', branchName], {
            cwd: repoPath,
            encoding: 'utf-8',
        });
        return true;
    } catch {
        return false;
    }
}

// Zod schema for process_branch parameters (defined before function to ensure availability)
export const process_branch_params = z.object({
    branch_name: z.string().min(1).regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/,
        'Branch name contains invalid characters. Only alphanumeric, dots, hyphens, underscores, and forward slashes are allowed.'
    ).describe('The full name of the child branch to process (e.g., \'job/abc-123-feature-name\')'),
    action: z.enum(['merge', 'reject', 'checkout', 'compare']).describe('The action to take: merge (integrate), reject (delete), checkout (switch to branch for edits), or compare (view diff without changing state)'),
    rationale: z.string().min(1).describe('A brief explanation of why you are taking this action (required for audit trail)'),
    cursor: z.string().optional().describe('Pagination cursor for compare action. If the diff is large, use the next_cursor from the response to fetch more.'),
});

/**
 * Process a child branch: merge, reject, or checkout
 */
export async function process_branch(args: unknown) {
    // Validate args using Zod schema
    const parseResult = process_branch_params.safeParse(args);
    if (!parseResult.success) {
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    success: false,
                    error: 'Invalid arguments',
                    message: parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
                }),
            }],
        };
    }

    const { branch_name, action, rationale } = parseResult.data;

    // Get context from job context (same pattern as other MCP tools)
    const context = getCurrentJobContext();
    const repoPath = process.env.CODE_METADATA_REPO_ROOT;

    if (!repoPath) {
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    success: false,
                    action,
                    error: 'Repository path not available',
                    message: 'Cannot determine repository path from context',
                }),
            }],
        };
    }

    workerLogger.info(
        { branch_name, action, rationale, requestId: context.requestId },
        `Processing branch with action: ${action}`
    );

    try {
        // Validate branch name beyond Zod regex (git ref rules)
        assertValidBranchName(branch_name);

        let result: string;
        const baseBr = context.baseBranch || process.env.CODE_METADATA_BASE_BRANCH || 'main';
        // Validate base branch too — it comes from job context or env
        assertValidBranchName(baseBr);

        switch (action) {
            case 'merge':
                result = await handleMerge(branch_name, repoPath, baseBr);
                break;
            case 'reject':
                result = await handleReject(branch_name, repoPath);
                break;
            case 'checkout':
                result = await handleCheckout(branch_name, repoPath);
                break;
            case 'compare': {
                const cursor = (parseResult.data as any).cursor;
                result = await handleCompare(branch_name, repoPath, baseBr, cursor);
                break;
            }
            default:
                result = JSON.stringify({
                    success: false,
                    action,
                    error: 'Unknown action',
                    message: `Action '${action}' is not supported`,
                });
        }

        return {
            content: [{
                type: 'text' as const,
                text: result,
            }],
        };
    } catch (error) {
        workerLogger.error(
            { error: serializeError(error), branch_name, action },
            'Error processing branch'
        );
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    success: false,
                    action,
                    error: error instanceof Error ? error.message : String(error),
                    message: `Failed to ${action} branch '${branch_name}'`,
                }),
            }],
        };
    }
}

/**
 * Handle the 'merge' action
 */
async function handleMerge(
    branchName: string,
    repoPath: string,
    baseBranch: string
): Promise<string> {
    const currentBranch = getCurrentBranch(repoPath);

    // Check for uncommitted changes - auto-commit beads files if they're the only changes
    if (hasUncommittedChanges(repoPath)) {
        // Only attempt beads auto-commit if beads is enabled
        if (config.blueprint.enableBeads) {
            const statusOutput = execFileSync('git', ['status', '--porcelain'], {
                cwd: repoPath,
                encoding: 'utf-8',
            });
            const changedFiles = statusOutput.trim().split('\n').filter(line => line.trim());
            const onlyBeadsChanges = changedFiles.every(line => {
                // Status format: "XY path" - extract the path part
                const filePath = line.slice(3).trim();
                return filePath.startsWith('.beads/') || filePath.startsWith('.beads\\');
            });

            if (onlyBeadsChanges && changedFiles.length > 0) {
                // Auto-commit beads runtime files to unblock the merge
                try {
                    execFileSync('git', ['add', '.beads/'], {
                        cwd: repoPath,
                        stdio: 'pipe',
                    });
                    execFileSync('git', ['commit', '-m', 'chore: sync beads state before merge'], {
                        cwd: repoPath,
                        stdio: 'pipe',
                    });
                    workerLogger.info({ repoPath, filesCommitted: changedFiles.length }, 'Auto-committed beads files before merge');
                } catch (commitError) {
                    // If commit fails, continue with the original error
                    workerLogger.warn({ repoPath, error: serializeError(commitError) }, 'Failed to auto-commit beads files');
                }
            }
        }

        // Re-check after potential auto-commit
        if (hasUncommittedChanges(repoPath)) {
            return JSON.stringify({
                success: false,
                action: 'merge',
                error: 'Uncommitted changes detected',
                message: 'You have uncommitted changes in your working tree. Please commit or stash them before merging.',
                details: {
                    current_branch: currentBranch,
                },
            });
        }
    }

    // Fetch latest state
    try {
        execFileSync('git', ['fetch', 'origin', branchName], {
            cwd: repoPath,
            stdio: 'pipe',
        });
        execFileSync('git', ['fetch', 'origin', baseBranch], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch (fetchError) {
        return JSON.stringify({
            success: false,
            action: 'merge',
            error: 'Failed to fetch branches',
            message: `Could not fetch '${branchName}' or '${baseBranch}' from origin. Ensure the branches exist on remote.`,
        });
    }

    // Checkout base branch
    try {
        execFileSync('git', ['checkout', baseBranch], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch (checkoutError) {
        return JSON.stringify({
            success: false,
            action: 'merge',
            error: 'Failed to checkout base branch',
            message: `Could not checkout base branch '${baseBranch}'. You remain on '${currentBranch}'.`,
        });
    }

    // Pull latest base
    try {
        execFileSync('git', ['pull', 'origin', baseBranch], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch (pullError) {
        // Non-fatal, continue with merge
    }

    // Attempt merge
    try {
        execFileSync('git', [
            'merge', '--no-ff', `origin/${branchName}`,
            '-m', `Merge branch '${branchName}' into '${baseBranch}'`
        ], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch (mergeError: any) {
        // Check if it's a conflict
        const statusOutput = execFileSync('git', ['status'], {
            cwd: repoPath,
            encoding: 'utf-8',
        });

        if (statusOutput.includes('Unmerged paths') || statusOutput.includes('merge conflict')) {
            // Abort the merge
            execFileSync('git', ['merge', '--abort'], {
                cwd: repoPath,
                stdio: 'pipe',
            });

            // Extract conflicting files
            const conflictingFiles: string[] = [];
            const conflictMatches = statusOutput.matchAll(/both modified:\s+(.+)/g);
            for (const match of conflictMatches) {
                conflictingFiles.push(match[1].trim());
            }

            return JSON.stringify({
                success: false,
                action: 'merge',
                error: 'Merge conflict detected - resolution required',
                message: `MERGE CONFLICT: Cannot auto-merge '${branchName}' into '${baseBranch}'. This is normal when multiple jobs modify the same files. Resolve the conflicts to preserve valuable work (only reject if the work is no longer relevant).`,
                conflicting_files: conflictingFiles,
                next_steps: `RESOLUTION WORKFLOW:\n1. Call process_branch({ branch_name: '${branchName}', action: 'checkout', rationale: 'Resolving merge conflicts' })\n2. Run: git merge origin/${baseBranch}\n3. Open each conflicting file and resolve the <<<<<<< / ======= / >>>>>>> markers\n4. Stage and commit: git add . && git commit -m "Resolve merge conflicts with ${baseBranch}"\n5. Return to base and merge: process_branch({ branch_name: '${branchName}', action: 'merge', rationale: 'Conflicts resolved' })`,
                important: 'Conflicts indicate overlapping work, not bad work. Resolve them to preserve valuable changes from both branches.',
            });
        }

        // Other merge error
        return JSON.stringify({
            success: false,
            action: 'merge',
            error: 'Merge failed',
            message: `Failed to merge '${branchName}' into '${baseBranch}': ${mergeError.message}`,
        });
    }

    // Push the merge
    try {
        execFileSync('git', ['push', 'origin', baseBranch], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch (pushError) {
        return JSON.stringify({
            success: false,
            action: 'merge',
            error: 'Push failed',
            message: `Merge succeeded locally, but failed to push to origin. You may need to pull and retry.`,
            details: {
                current_branch: baseBranch,
            },
        });
    }

    // Delete remote branch
    try {
        execFileSync('git', ['push', 'origin', '--delete', branchName], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch {
        // Ignore if branch doesn't exist on remote
    }

    // Delete local branch if it exists
    const deletedLocal = branchExistsLocally(repoPath, branchName);
    if (deletedLocal) {
        try {
            execFileSync('git', ['branch', '-d', branchName], {
                cwd: repoPath,
                stdio: 'pipe',
            });
        } catch {
            // Ignore deletion errors
        }
    }

    const result: ProcessBranchResult = {
        success: true,
        action: 'merge',
        message: `Branch '${branchName}' successfully merged into '${baseBranch}' and deleted.`,
        details: {
            current_branch: baseBranch,
            deleted_branches: [`origin/${branchName}`, ...(deletedLocal ? [branchName] : [])],
        },
        next_steps: `You are now on branch '${baseBranch}'. The child branch has been integrated and cleaned up.`,
    };

    return JSON.stringify(result);
}

/**
 * Handle the 'reject' action
 */
async function handleReject(
    branchName: string,
    repoPath: string
): Promise<string> {
    const currentBranch = getCurrentBranch(repoPath);

    let deletedFromRemote = false;
    let deletedFromLocal = false;

    // Delete from remote
    try {
        execFileSync('git', ['push', 'origin', '--delete', branchName], {
            cwd: repoPath,
            stdio: 'pipe',
        });
        deletedFromRemote = true;
    } catch {
        // Branch may not exist on remote, continue
    }

    // Delete from local
    if (branchExistsLocally(repoPath, branchName)) {
        try {
            execFileSync('git', ['branch', '-D', branchName], {
                cwd: repoPath,
                stdio: 'pipe',
            });
            deletedFromLocal = true;
        } catch {
            // Ignore deletion errors
        }
    }

    const result: ProcessBranchResult = {
        success: true,
        action: 'reject',
        message: `Branch '${branchName}' has been deleted.`,
        details: {
            deleted_from_remote: deletedFromRemote,
            deleted_from_local: deletedFromLocal,
            current_branch: currentBranch,
        },
        next_steps: `The branch and its work have been discarded. You remain on branch '${currentBranch}'.`,
    };

    return JSON.stringify(result);
}

/**
 * Handle the 'checkout' action
 */
async function handleCheckout(
    branchName: string,
    repoPath: string
): Promise<string> {
    const originalBranch = getCurrentBranch(repoPath);

    // Check for uncommitted changes - auto-commit beads files if they're the only changes
    if (hasUncommittedChanges(repoPath)) {
        // Only attempt beads auto-commit if beads is enabled
        if (config.blueprint.enableBeads) {
            const statusOutput = execFileSync('git', ['status', '--porcelain'], {
                cwd: repoPath,
                encoding: 'utf-8',
            });
            const changedFiles = statusOutput.trim().split('\n').filter(line => line.trim());
            const onlyBeadsChanges = changedFiles.every(line => {
                const filePath = line.slice(3).trim();
                return filePath.startsWith('.beads/') || filePath.startsWith('.beads\\');
            });

            if (onlyBeadsChanges && changedFiles.length > 0) {
                try {
                    execFileSync('git', ['add', '.beads/'], {
                        cwd: repoPath,
                        stdio: 'pipe',
                    });
                    execFileSync('git', ['commit', '-m', 'chore: sync beads state before checkout'], {
                        cwd: repoPath,
                        stdio: 'pipe',
                    });
                    workerLogger.info({ repoPath, filesCommitted: changedFiles.length }, 'Auto-committed beads files before checkout');
                } catch (commitError) {
                    workerLogger.warn({ repoPath, error: serializeError(commitError) }, 'Failed to auto-commit beads files');
                }
            }
        }

        if (hasUncommittedChanges(repoPath)) {
            return JSON.stringify({
                success: false,
                action: 'checkout',
                error: 'Uncommitted changes detected',
                message: 'You have uncommitted changes in your working tree. Please commit them before switching branches.',
                details: {
                    current_branch: originalBranch,
                },
            });
        }
    }

    // Fetch the branch
    try {
        execFileSync('git', ['fetch', 'origin', branchName], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch (fetchError) {
        return JSON.stringify({
            success: false,
            action: 'checkout',
            error: 'Failed to fetch branch',
            message: `Could not fetch '${branchName}' from origin. Ensure the branch exists on remote.`,
        });
    }

    // Checkout the branch
    try {
        if (branchExistsLocally(repoPath, branchName)) {
            execFileSync('git', ['checkout', branchName], {
                cwd: repoPath,
                stdio: 'pipe',
            });
        } else {
            execFileSync('git', ['checkout', '-b', branchName, `origin/${branchName}`], {
                cwd: repoPath,
                stdio: 'pipe',
            });
        }
    } catch (checkoutError) {
        return JSON.stringify({
            success: false,
            action: 'checkout',
            error: 'Failed to checkout branch',
            message: `Could not checkout branch '${branchName}'. You remain on '${originalBranch}'.`,
        });
    }

    const result: ProcessBranchResult = {
        success: true,
        action: 'checkout',
        message: `Switched to branch '${branchName}'.`,
        details: {
            previous_branch: originalBranch,
            current_branch: branchName,
            uncommitted_changes: 0,
        },
        next_steps: `You are now on branch '${branchName}'. Make your changes using file tools, then commit them. When ready, call process_branch({ branch_name: '${branchName}', action: 'merge' }) to integrate your changes. To return to '${originalBranch}' without merging, call process_branch({ branch_name: '${originalBranch}', action: 'checkout' }) or use git checkout ${originalBranch}.`,
    };

    return JSON.stringify(result);
}

/**
 * Handle the 'compare' action - compare branch against base without modifying state
 * Supports pagination for large diffs via cursor parameter
 */
async function handleCompare(
    branchName: string,
    repoPath: string,
    baseBranch: string,
    cursor?: string
): Promise<string> {
    // Decode cursor to get offset
    const cursorData = decodeCursor<{ offset: number }>(cursor);
    const startOffset = cursorData?.offset ?? 0;

    // Fetch latest state of both branches
    try {
        execFileSync('git', ['fetch', 'origin', branchName], {
            cwd: repoPath,
            stdio: 'pipe',
        });
        execFileSync('git', ['fetch', 'origin', baseBranch], {
            cwd: repoPath,
            stdio: 'pipe',
        });
    } catch (fetchError) {
        return JSON.stringify({
            success: false,
            action: 'compare',
            error: 'Failed to fetch branches',
            message: `Could not fetch '${branchName}' or '${baseBranch}' from origin. Ensure both branches exist on remote.`,
        });
    }

    // Check merge status using git merge-tree
    const GIT_SHA1_LENGTH = 40;
    let mergeStatus: 'mergeable' | 'conflict' | 'unknown' = 'unknown';
    try {
        const mergeTreeOutput = execFileSync('git', [
            'merge-tree', '--write-tree', `origin/${baseBranch}`, `origin/${branchName}`
        ], {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const mergeTreeHash = mergeTreeOutput.trim();
        mergeStatus = mergeTreeHash.length === GIT_SHA1_LENGTH && /^[0-9a-f]+$/.test(mergeTreeHash)
            ? 'mergeable'
            : 'unknown';
    } catch (mergeTreeError: any) {
        if (mergeTreeError.status !== 0) {
            mergeStatus = 'conflict';
        }
    }

    // Generate full diff
    let diffSummary = '';
    try {
        diffSummary = execFileSync('git', [
            'diff', `origin/${baseBranch}...origin/${branchName}`
        ], {
            cwd: repoPath,
            encoding: 'utf-8',
            maxBuffer: 50 * 1024 * 1024, // 50MB max buffer
        });
    } catch (diffError) {
        workerLogger.warn(
            { error: serializeError(diffError), branchName, baseBranch },
            'Failed to generate diff summary'
        );
        return JSON.stringify({
            success: false,
            action: 'compare',
            error: 'Failed to generate diff',
            message: `Could not generate diff between '${branchName}' and '${baseBranch}'.`,
        });
    }

    // Gather additional stats
    let commitCount = 0;
    const fileStats = { added: 0, modified: 0, deleted: 0 };
    let headSha = '';

    try {
        // Get commit count
        const commitCountOutput = execFileSync('git', [
            'rev-list', '--count', `origin/${baseBranch}..origin/${branchName}`
        ], { cwd: repoPath, encoding: 'utf-8' });
        commitCount = parseInt(commitCountOutput.trim(), 10) || 0;

        // Get file stats using name-status
        const nameStatusOutput = execFileSync('git', [
            'diff', '--name-status', `origin/${baseBranch}...origin/${branchName}`
        ], { cwd: repoPath, encoding: 'utf-8' });
        const statusLines = nameStatusOutput.trim().split('\n').filter(Boolean);
        for (const line of statusLines) {
            const status = line.charAt(0);
            if (status === 'A') fileStats.added++;
            else if (status === 'D') fileStats.deleted++;
            else if (status === 'M' || status === 'R' || status === 'C') fileStats.modified++;
        }

        // Get head SHA
        headSha = execFileSync('git', [
            'rev-parse', `origin/${branchName}`
        ], { cwd: repoPath, encoding: 'utf-8' }).trim();
    } catch (statsError) {
        // Non-fatal: continue with basic details
        workerLogger.warn(
            { error: serializeError(statsError), branchName, baseBranch },
            'Failed to gather extended stats for compare'
        );
    }

    // Split diff into lines for pagination
    const diffLines = diffSummary.split('\n');
    const totalDiffLines = diffLines.length;
    const totalDiffBytes = diffSummary.length;

    // Use pagination for the diff lines
    // Each "item" is a line - we'll rejoin them after pagination
    const paginationResult = composeSinglePageResponse(diffLines, {
        startOffset,
        pageTokenBudget: 12_000,  // ~48KB of diff per page
        truncateChars: -1,        // Don't truncate individual lines
        perFieldMaxChars: 500,    // But cap very long lines
        enforceHardPageBudget: true,
    });

    const paginatedDiffLines = paginationResult.data as string[];
    const paginatedDiff = paginatedDiffLines.join('\n');

    // Build result with pagination info
    const result = {
        success: true,
        action: 'compare',
        message: `Compared '${branchName}' against '${baseBranch}'.`,
        details: {
            head_branch: branchName,
            base_branch: baseBranch,
            merge_status: mergeStatus,
            commit_count: commitCount,
            file_stats: fileStats,
            head_sha: headSha ? headSha.slice(0, 8) : '',
            diff_summary: paginatedDiff,
        },
        pagination: {
            has_more: paginationResult.meta.has_more,
            next_cursor: paginationResult.meta.next_cursor,
            page_tokens: paginationResult.meta.tokens.page_tokens,
            total_diff_lines: totalDiffLines,
            total_diff_bytes: totalDiffBytes,
            showing_lines: `${startOffset + 1}-${startOffset + paginatedDiffLines.length} of ${totalDiffLines}`,
        },
        next_steps: paginationResult.meta.has_more
            ? `Diff is large (${totalDiffLines} lines, ${Math.round(totalDiffBytes / 1024)}KB). ` +
            `Use process_branch({ branch_name: '${branchName}', action: 'compare', cursor: '${paginationResult.meta.next_cursor}', rationale: 'Fetching more diff' }) to see more. ` +
            `Merge status: ${mergeStatus}.`
            : mergeStatus === 'mergeable'
                ? `Branch is mergeable. Use process_branch({ branch_name: '${branchName}', action: 'merge', rationale: '...' }) to integrate, or action: 'reject' to discard.`
                : mergeStatus === 'conflict'
                    ? `Branch has merge conflicts. Resolve conflicts to preserve valuable work. Use process_branch({ branch_name: '${branchName}', action: 'checkout', rationale: 'Resolving conflicts' }) to fix.`
                    : `Merge status unknown. Review the diff and decide whether to merge, reject, or checkout for manual review.`,
    };

    return JSON.stringify(result);
}

// Export tool schema for MCP registration
export const process_branch_schema = {
    name: 'process_branch',
    description: `Process a child job's branch by comparing, merging, rejecting, or checking out for manual intervention.

WORKFLOW:
1. Compare the branch (if Rich Context is stale or unavailable)
2. Decide: merge (approve), reject (delete), or checkout (fix issues)
3. Call this tool with your decision

ACTIONS:

• compare: View the diff and merge status without modifying any state.
  - Use when: You need fresh diff information, or the Rich Context is stale/unavailable.
  - Result: Returns merge status (mergeable/conflict/unknown), full diff, commit count, and file stats.
  - Note: This is a read-only operation. No branches are modified.

• merge: Merge the child branch into the base branch and delete the child branch.
  - Use when: The diff looks good and is ready to integrate.
  - Result: Child branch merged into base, then deleted. You remain on the base branch.
  - Note: If conflicts are detected, you'll be instructed to use 'checkout' to resolve them.

• reject: Delete the child branch without merging.
  - Use when: The work is incorrect, redundant, or not worth integrating.
  - Result: Child branch deleted from remote and local. You remain on your current branch.

• checkout: Switch to the child branch for manual intervention.
  - Use when: You need to fix bugs, resolve conflicts, or make changes before merging.
  - Result: You are moved to the child branch.
  - IMPORTANT: After making changes and committing, call process_branch again with action='merge' to integrate your fixes.
  - To return to your original branch without merging, use standard git commands (git checkout <branch>).

PARAMETERS:
- branch_name: The full name of the child branch (e.g., 'job/abc-123-feature-name')
- action: Your decision (compare, merge, reject, checkout)
- rationale: A brief explanation of why you're taking this action (for audit trail)`,
    inputSchema: process_branch_params.shape,
};
