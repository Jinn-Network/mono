
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobContextProvider } from 'jinn-node/worker/prompt/providers/context/JobContextProvider.js';
import * as fetchChildrenModule from 'jinn-node/worker/prompt/providers/context/fetchChildren.js';
import childProcess from 'node:child_process';
import { BlueprintBuilderConfig } from 'jinn-node/worker/prompt/types.js';

vi.mock('node:child_process');
vi.mock('jinn-node/worker/prompt/providers/context/fetchChildren.js');
vi.mock('jinn-node/worker/logging/index.js', () => ({
    workerLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe('JobContextProvider', () => {
    let provider: JobContextProvider;
    const mockConfig: BlueprintBuilderConfig = {
        enableJobContext: true,
        enableSystemBlueprint: true,
        enableContextAssertions: true,
        enableRecognitionLearnings: true,
        enableProgressCheckpoint: true,
        debug: false,
        logProviders: false,
    };

    beforeEach(() => {
        provider = new JobContextProvider();
        vi.resetAllMocks();
        process.env.CODE_METADATA_REPO_ROOT = '/mock/repo';
        process.env.CODE_METADATA_BRANCH_NAME = 'main';
    });

    afterEach(() => {
        delete process.env.CODE_METADATA_REPO_ROOT;
        delete process.env.CODE_METADATA_BRANCH_NAME;
    });

    it('should identify child as integrated if no branch name', async () => {
        vi.spyOn(fetchChildrenModule, 'fetchAllChildren').mockResolvedValue([
            {
                jobDefinitionId: 'job-1',
                jobName: 'Artificer',
                status: 'COMPLETED',
                branchName: undefined,
            },
        ]);

        const result = await provider.provide({
            metadata: { jobDefinitionId: 'parent-1' } as any,
            requestId: 'req-1',
            config: mockConfig,
        });

        expect(result.hierarchy?.children[0].isIntegrated).toBe(true);
    });

    it('should identify child as integrated if branch deleted (ls-remote empty)', async () => {
        vi.spyOn(fetchChildrenModule, 'fetchAllChildren').mockResolvedValue([
            {
                jobDefinitionId: 'job-2',
                jobName: 'Coder',
                status: 'COMPLETED',
                branchName: 'job/coder',
            },
        ]);

        // Mock execSync to return empty string for ls-remote (branch deleted)
        // First call is batch fetch (ignore), second is ls-remote
        vi.mocked(childProcess.execSync).mockImplementation((command: string) => {
            if (command.includes('ls-remote')) return '';
            return '';
        });

        const result = await provider.provide({
            metadata: { jobDefinitionId: 'parent-1' } as any,
            requestId: 'req-1',
            config: mockConfig,
        });

        expect(result.hierarchy?.children[0].isIntegrated).toBe(true);
    });

    it('should identify child as integrated if branch exists matches ancestor', async () => {
        vi.spyOn(fetchChildrenModule, 'fetchAllChildren').mockResolvedValue([
            {
                jobDefinitionId: 'job-3',
                jobName: 'Reviewer',
                status: 'COMPLETED',
                branchName: 'job/reviewer',
            },
        ]);

        vi.mocked(childProcess.execSync).mockImplementation((command: string) => {
            if (command.includes('ls-remote')) return 'hash refs/heads/job/reviewer';
            if (command.includes('rev-parse')) return 'child-head-hash';
            if (command.includes('merge-base --is-ancestor')) return ''; // No error = success (0 exit code)
            return '';
        });

        const result = await provider.provide({
            metadata: { jobDefinitionId: 'parent-1' } as any,
            requestId: 'req-1',
            config: mockConfig,
        });

        expect(result.hierarchy?.children[0].isIntegrated).toBe(true);
    });

    it('should identify child as NOT integrated if branch exists and NOT ancestor', async () => {
        vi.spyOn(fetchChildrenModule, 'fetchAllChildren').mockResolvedValue([
            {
                jobDefinitionId: 'job-4',
                jobName: 'NewGuy',
                status: 'COMPLETED',
                branchName: 'job/newguy',
            },
        ]);

        vi.mocked(childProcess.execSync).mockImplementation((command: string) => {
            if (command.includes('ls-remote')) return 'hash refs/heads/job/newguy';
            if (command.includes('rev-parse')) return 'child-head-hash';
            if (command.includes('merge-base --is-ancestor')) {
                // Throw error to simulate non-zero exit code (not ancestor)
                throw new Error('Command failed: git merge-base --is-ancestor');
            }
            return '';
        });

        const result = await provider.provide({
            metadata: { jobDefinitionId: 'parent-1' } as any,
            requestId: 'req-1',
            config: mockConfig,
        });

        expect(result.hierarchy?.children[0].isIntegrated).toBe(false);
    });

    it('should batch fetch git branches', async () => {
        vi.spyOn(fetchChildrenModule, 'fetchAllChildren').mockResolvedValue([
            {
                jobDefinitionId: 'job-1',
                jobName: 'J1',
                status: 'COMPLETED',
                branchName: 'job/j1',
            },
            {
                jobDefinitionId: 'job-2',
                jobName: 'J2',
                status: 'COMPLETED',
                branchName: 'job/j2',
            },
        ]);

        const execSpy = vi.mocked(childProcess.execSync).mockReturnValue('');

        await provider.provide({
            metadata: { jobDefinitionId: 'parent-1' } as any,
            requestId: 'req-1',
            config: mockConfig,
        });

        // Check if git fetch was called with multiple branches
        const fetchCall = execSpy.mock.calls.find(call =>
            call[0].toString().includes('git fetch') &&
            call[0].toString().includes('job/j1') &&
            call[0].toString().includes('job/j2')
        );

        expect(fetchCall).toBeDefined();
    });
});
