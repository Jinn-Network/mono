import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { process_branch } from 'jinn-node/worker/mcp/tools/git.js';
import { execSync } from 'node:child_process';

// Mock dependencies
vi.mock('node:child_process');
vi.mock('../../../../logging/index.js', () => ({
    workerLogger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));
vi.mock('../../../../gemini-agent/mcp/tools/shared/context.js', () => ({
    getCurrentJobContext: vi.fn(() => ({
        jobId: 'test-job-id',
        jobDefinitionId: 'test-job-def',
        jobName: 'test-job',
        threadId: null,
        projectRunId: null,
        sourceEventId: null,
        projectDefinitionId: null,
        requestId: 'test-request-id',
        mechAddress: null,
        baseBranch: 'main',
        parentRequestId: null,
        branchName: null,
    })),
}));

describe('process_branch', () => {
    const mockRepoPath = '/test/repo';

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.CODE_METADATA_REPO_ROOT = mockRepoPath;
    });

    afterEach(() => {
        delete process.env.CODE_METADATA_REPO_ROOT;
    });

    describe('Input Validation', () => {
        it('should reject invalid arguments (not an object)', async () => {
            const result = await process_branch(null);
            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Invalid arguments');
        });

        it('should reject missing branch_name', async () => {
            const result = await process_branch({
                action: 'merge',
                rationale: 'Test',
            });
            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Invalid arguments');
        });

        it('should reject invalid action', async () => {
            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'invalid_action',
                rationale: 'Test',
            });
            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Invalid arguments');
        });

        it('should reject missing rationale', async () => {
            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'merge',
                rationale: '',
            });
            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Invalid arguments');
        });

        it('should reject when repo path is not available', async () => {
            delete process.env.CODE_METADATA_REPO_ROOT;

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'merge',
                rationale: 'Test merge',
            });
            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Repository path not available');
        });
    });

    describe('Merge Action', () => {
        it('should successfully merge a branch', async () => {
            const mockExecSync = vi.mocked(execSync);

            // Mock git commands
            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockReturnValueOnce('') // git status --porcelain (no changes)
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin main
                .mockReturnValueOnce(Buffer.from('')) // git checkout main
                .mockReturnValueOnce(Buffer.from('')) // git pull origin main
                .mockReturnValueOnce(Buffer.from('')) // git merge
                .mockReturnValueOnce(Buffer.from('')) // git push origin main
                .mockReturnValueOnce(Buffer.from('')) // git push origin --delete
                .mockReturnValueOnce(Buffer.from('')) // git rev-parse (branchExistsLocally)
                .mockReturnValueOnce(Buffer.from('')); // git branch -d

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'merge',
                rationale: 'Looks good, ready to merge',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('merge');
            expect(parsed.message).toContain('successfully merged');
            expect(parsed.details.current_branch).toBe('main');
        });

        it('should detect and report merge conflicts', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockReturnValueOnce('') // git status --porcelain
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin main
                .mockReturnValueOnce(Buffer.from('')) // git checkout main
                .mockReturnValueOnce(Buffer.from('')) // git pull origin main
                .mockImplementationOnce(() => {
                    // git merge throws error
                    throw new Error('CONFLICT');
                })
                .mockReturnValueOnce('Unmerged paths:\nboth modified:   src/index.ts') // git status (conflict)
                .mockReturnValueOnce(Buffer.from('')); // git merge --abort

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'merge',
                rationale: 'Attempting merge',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Merge conflict detected - resolution required');
            expect(parsed.conflicting_files).toContain('src/index.ts');
            expect(parsed.next_steps).toContain('checkout');
        });

        it('should reject merge when there are uncommitted changes', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockReturnValueOnce(' M src/file.ts') // git status --porcelain (has changes via hasUncommittedChanges)
                .mockReturnValueOnce(' M src/file.ts') // git status --porcelain (for beads check)
                .mockReturnValueOnce(' M src/file.ts'); // git status --porcelain (re-check after auto-commit attempt)

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'merge',
                rationale: 'Merge attempt',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Uncommitted changes detected');
        });
    });

    describe('Reject Action', () => {
        it('should successfully delete a branch', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockReturnValueOnce(Buffer.from('')) // git push origin --delete
                .mockReturnValueOnce(Buffer.from('')) // git rev-parse (branchExistsLocally)
                .mockReturnValueOnce(Buffer.from('')); // git branch -D

            const result = await process_branch({
                branch_name: 'feat/bad-idea',
                action: 'reject',
                rationale: 'This approach was wrong',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('reject');
            expect(parsed.message).toContain('deleted');
            expect(parsed.details.deleted_from_remote).toBe(true);
            expect(parsed.details.deleted_from_local).toBe(true);
        });

        it('should handle case where branch does not exist on remote', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockImplementationOnce(() => {
                    // git push origin --delete throws (branch doesn't exist)
                    throw new Error('remote ref does not exist');
                })
                .mockImplementationOnce(() => {
                    // git rev-parse throws (branch doesn't exist locally)
                    throw new Error('Not a valid object name');
                });

            const result = await process_branch({
                branch_name: 'feat/nonexistent',
                action: 'reject',
                rationale: 'Delete nonexistent branch',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.details.deleted_from_remote).toBe(false);
            expect(parsed.details.deleted_from_local).toBe(false);
        });
    });

    describe('Checkout Action', () => {
        it('should successfully checkout an existing local branch', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // get CurrentBranch
                .mockReturnValueOnce('') // git status --porcelain
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git rev-parse (branchExistsLocally = true)
                .mockReturnValueOnce(Buffer.from('')); // git checkout feat/test

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'checkout',
                rationale: 'Need to fix a bug',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('checkout');
            expect(parsed.details.previous_branch).toBe('main');
            expect(parsed.details.current_branch).toBe('feat/test');
            expect(parsed.next_steps).toContain('Make your changes');
        });

        it('should successfully checkout a new branch from remote', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockReturnValueOnce('') // git status --porcelain
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockImplementationOnce(() => {
                    // git rev-parse throws (branch doesn't exist locally)
                    throw new Error('Not a valid object name');
                })
                .mockReturnValueOnce(Buffer.from('')); // git checkout -b feat/test origin/feat/test

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'checkout',
                rationale: 'Review child work',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('checkout');
        });

        it('should reject checkout when there are uncommitted changes', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockReturnValueOnce(' M src/file.ts') // git status --porcelain (has changes via hasUncommittedChanges)
                .mockReturnValueOnce(' M src/file.ts') // git status --porcelain (for beads check)
                .mockReturnValueOnce(' M src/file.ts'); // git status --porcelain (re-check after auto-commit attempt)

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'checkout',
                rationale: 'Switch branch',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Uncommitted changes detected');
        });

        it('should fail when remote branch does not exist', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce('main') // getCurrentBranch
                .mockReturnValueOnce('') // git status --porcelain
                .mockImplementationOnce(() => {
                    // git fetch origin throws (branch doesn't exist)
                    throw new Error('Remote branch not found');
                });

            const result = await process_branch({
                branch_name: 'feat/nonexistent',
                action: 'checkout',
                rationale: 'Try to checkout',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Failed to fetch branch');
        });
    });

    describe('Compare Action', () => {
        it('should successfully compare a mergeable branch', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin main
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd') // git merge-tree
                .mockReturnValueOnce('diff --git a/src/index.ts b/src/index.ts\n+added line') // git diff
                .mockReturnValueOnce('3') // git rev-list --count
                .mockReturnValueOnce('M\tsrc/index.ts') // git diff --name-status
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd'); // git rev-parse

            const result = await process_branch({
                branch_name: 'feat/test',
                action: 'compare',
                rationale: 'Review changes before merging',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('compare');
            expect(parsed.details.merge_status).toBe('mergeable');
            expect(parsed.details.head_branch).toBe('feat/test');
            expect(parsed.details.base_branch).toBe('main');
            expect(parsed.details.commit_count).toBe(3);
            expect(parsed.details.file_stats.modified).toBe(1);
            expect(parsed.details.diff_summary).toContain('+added line');
            expect(parsed.next_steps).toContain('mergeable');
        });

        it('should detect conflicts in compare', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin main
                .mockImplementationOnce(() => {
                    // git merge-tree exits with non-zero for conflicts
                    const error = new Error('Conflict') as any;
                    error.status = 1;
                    throw error;
                })
                .mockReturnValueOnce('diff content') // git diff
                .mockReturnValueOnce('2') // git rev-list --count
                .mockReturnValueOnce('M\tsrc/file.ts') // git diff --name-status
                .mockReturnValueOnce('def456789012345678901234567890abcdef1234'); // git rev-parse

            const result = await process_branch({
                branch_name: 'feat/conflicting',
                action: 'compare',
                rationale: 'Check for conflicts',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('compare');
            expect(parsed.details.merge_status).toBe('conflict');
            expect(parsed.next_steps).toContain('checkout');
        });

        it('should handle fetch failure gracefully', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockImplementationOnce(() => {
                    throw new Error('Failed to fetch');
                });

            const result = await process_branch({
                branch_name: 'feat/nonexistent',
                action: 'compare',
                rationale: 'Try to compare',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBe('Failed to fetch branches');
        });

        it('should return full diff without truncation', async () => {
            const mockExecSync = vi.mocked(execSync);
            const largeDiff = 'diff --git a/file.ts\n' + 'x'.repeat(10000);

            mockExecSync
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin main
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd') // git merge-tree
                .mockReturnValueOnce(largeDiff) // git diff (full, no truncation)
                .mockReturnValueOnce('1') // git rev-list --count
                .mockReturnValueOnce('A\tsrc/newfile.ts') // git diff --name-status
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd'); // git rev-parse

            const result = await process_branch({
                branch_name: 'feat/large-changes',
                action: 'compare',
                rationale: 'Review large diff',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            // Large diffs may be paginated, check for pagination metadata
            expect(parsed.pagination).toBeDefined();
            expect(parsed.pagination.total_diff_bytes).toBeGreaterThan(10000);
            expect(parsed.details.file_stats.added).toBe(1);
        });

        it('should count file stats correctly', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin main
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd') // git merge-tree
                .mockReturnValueOnce('diff content') // git diff
                .mockReturnValueOnce('5') // git rev-list --count
                .mockReturnValueOnce('A\tsrc/new.ts\nM\tsrc/modified.ts\nD\tsrc/deleted.ts\nM\tsrc/also-modified.ts') // git diff --name-status
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd'); // git rev-parse

            const result = await process_branch({
                branch_name: 'feat/multi-file',
                action: 'compare',
                rationale: 'Review multi-file changes',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.details.file_stats.added).toBe(1);
            expect(parsed.details.file_stats.modified).toBe(2);
            expect(parsed.details.file_stats.deleted).toBe(1);
            expect(parsed.details.commit_count).toBe(5);
        });

        it('should handle renamed and copied files in stats', async () => {
            const mockExecSync = vi.mocked(execSync);

            mockExecSync
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin feat/test
                .mockReturnValueOnce(Buffer.from('')) // git fetch origin main
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd') // git merge-tree
                .mockReturnValueOnce('diff content') // git diff
                .mockReturnValueOnce('2') // git rev-list --count
                .mockReturnValueOnce('R100\tsrc/old.ts\tsrc/new.ts\nC100\tsrc/file.ts\tsrc/copy.ts\nM\tsrc/modified.ts') // git diff --name-status (renamed, copied, modified)
                .mockReturnValueOnce('abc123def456789012345678901234567890abcd'); // git rev-parse

            const result = await process_branch({
                branch_name: 'feat/rename-files',
                action: 'compare',
                rationale: 'Review renamed files',
            });

            const parsed = JSON.parse(result.content[0].text);

            expect(parsed.success).toBe(true);
            expect(parsed.details.file_stats.added).toBe(0);
            expect(parsed.details.file_stats.modified).toBe(3); // R, C, and M all count as modified
            expect(parsed.details.file_stats.deleted).toBe(0);
        });
    });
});
