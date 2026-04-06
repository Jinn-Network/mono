/**
 * Unit Test: GitHub PR Creation
 * 
 * Tests parseGithubRepo and createOrUpdatePullRequest functions.
 * Validates URL parsing, token handling, and PR creation logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import type { CodeMetadata } from 'jinn-node/agent/shared/code_metadata.js';
import { createOrUpdatePullRequest, createPullRequestArtifact } from 'jinn-node/worker/git/pr.js';
import { DEFAULT_BASE_BRANCH } from 'jinn-node/worker/constants.js';
import { createArtifact as controlApiCreateArtifact } from 'jinn-node/worker/control_api_client.js';

// Mock fetch globally
global.fetch = vi.fn();

// Mock config module to avoid RPC_URL/CHAIN_ID validation errors in tests
vi.mock('jinn-node/config/index.js', async () => {
  const actual = await vi.importActual('jinn-node/config/index.js');
  return {
    ...actual,
    getOptionalGithubToken: vi.fn(() => process.env.GITHUB_TOKEN),
    getOptionalGithubRepository: vi.fn(() => process.env.GITHUB_REPOSITORY),
    getGithubApiUrl: vi.fn(() => process.env.GITHUB_API_URL || 'https://api.github.com'),
  };
});

// Mock dependencies that live outside this module
vi.mock('@jinn-network/mech-client-ts/dist/ipfs.js', () => ({
  pushJsonToIpfs: vi.fn(),
}));

vi.mock('jinn-node/worker/control_api_client.js', () => ({
  createArtifact: vi.fn(),
}));

// Mock formatSummaryForPr
vi.mock('jinn-node/worker/git/autoCommit.js', () => ({
  formatSummaryForPr: vi.fn(() => '### Execution Summary\n- Test summary'),
}));

describe('pr', () => {
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGithubRepo = process.env.GITHUB_REPOSITORY;
  const originalGithubApiUrl = process.env.GITHUB_API_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_API_URL;
  });

  afterEach(() => {
    if (originalGithubToken !== undefined) {
      process.env.GITHUB_TOKEN = originalGithubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    if (originalGithubRepo !== undefined) {
      process.env.GITHUB_REPOSITORY = originalGithubRepo;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
    if (originalGithubApiUrl !== undefined) {
      process.env.GITHUB_API_URL = originalGithubApiUrl;
    } else {
      delete process.env.GITHUB_API_URL;
    }
  });

  describe('createOrUpdatePullRequest', () => {
    const baseCodeMetadata: CodeMetadata = {
      branch: {
        name: 'job/test-branch',
        headCommit: 'abc123',
        remoteUrl: 'https://github.com/owner/repo.git',
        status: { isDirty: false },
      },
      repo: {
        remoteUrl: 'https://github.com/owner/repo.git',
      },
      baseBranch: 'main',
      capturedAt: new Date().toISOString(),
      jobDefinitionId: 'job-123',
    };

    it('returns null when GITHUB_TOKEN is missing', async () => {
      // No token set
      const result = await createOrUpdatePullRequest({
        codeMetadata: baseCodeMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
      });

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns null when remote URL cannot be parsed', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      const invalidMetadata: CodeMetadata = {
        ...baseCodeMetadata,
        repo: { remoteUrl: 'invalid-url' },
        branch: {
          ...baseCodeMetadata.branch,
          remoteUrl: 'invalid-url',
        },
      };

      const result = await createOrUpdatePullRequest({
        codeMetadata: invalidMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
      });

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('parses HTTPS GitHub URL correctly', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/owner/repo/pull/1',
        }),
      } as Response);

      const result = await createOrUpdatePullRequest({
        codeMetadata: baseCodeMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
      });

      expect(result).toBe('https://github.com/owner/repo/pull/1');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/owner/repo/pulls'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });

    it('parses SSH GitHub URL correctly', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      const sshMetadata: CodeMetadata = {
        ...baseCodeMetadata,
        repo: { remoteUrl: 'git@github.com:owner/repo.git' },
        branch: {
          ...baseCodeMetadata.branch,
          remoteUrl: 'git@github.com:owner/repo.git',
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/owner/repo/pull/1',
        }),
      } as Response);

      const result = await createOrUpdatePullRequest({
        codeMetadata: sshMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
      });

      expect(result).toBe('https://github.com/owner/repo/pull/1');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/owner/repo/pulls'),
        expect.anything()
      );
    });

    it('strips token from HTTPS URL when parsing', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      const tokenInUrlMetadata: CodeMetadata = {
        ...baseCodeMetadata,
        repo: { remoteUrl: 'https://token123@github.com/owner/repo.git' },
        branch: {
          ...baseCodeMetadata.branch,
          remoteUrl: 'https://token123@github.com/owner/repo.git',
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/owner/repo/pull/1',
        }),
      } as Response);

      const result = await createOrUpdatePullRequest({
        codeMetadata: tokenInUrlMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
      });

      // Should still work - parseGithubRepo should handle URLs with embedded tokens
      expect(result).toBe('https://github.com/owner/repo/pull/1');
    });

    it('returns existing PR URL if PR already exists', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
          },
        ],
      } as Response);

      const result = await createOrUpdatePullRequest({
        codeMetadata: baseCodeMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
      });

      expect(result).toBe('https://github.com/owner/repo/pull/42');
      // Should not create a new PR
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws when GitHub API returns error', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({
          message: 'Validation Failed',
          errors: [{ field: 'base', code: 'invalid' }],
        }),
      } as Response);

      await expect(
        createOrUpdatePullRequest({
          codeMetadata: baseCodeMetadata,
          branchName: 'job/test-branch',
          baseBranch: 'main',
          requestId: 'req-123',
        })
      ).rejects.toThrow('HTTP 422');
    });

    it('uses GITHUB_REPOSITORY env var when remote URL is not available', async () => {
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.GITHUB_REPOSITORY = 'owner/repo';

      const noRemoteMetadata: CodeMetadata = {
        ...baseCodeMetadata,
        repo: {},
        branch: {
          ...baseCodeMetadata.branch,
          remoteUrl: undefined,
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/owner/repo/pull/1',
        }),
      } as Response);

      const result = await createOrUpdatePullRequest({
        codeMetadata: noRemoteMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
      });

      expect(result).toBe('https://github.com/owner/repo/pull/1');
    });

    it('includes execution summary in PR body when provided', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/owner/repo/pull/1',
        }),
      } as Response);

      await createOrUpdatePullRequest({
        codeMetadata: baseCodeMetadata,
        branchName: 'job/test-branch',
        baseBranch: 'main',
        requestId: 'req-123',
        summaryBlock: 'Custom summary',
      });

      const createCall = vi.mocked(global.fetch).mock.calls.find(
        (call) => call[1]?.method === 'POST'
      );
      expect(createCall).toBeTruthy();

      const body = JSON.parse(createCall![1]!.body as string);
      expect(body.body).toContain('Custom summary');
      expect(body.body).toContain('req-123');
      expect(body.body).toContain('job/test-branch');
    });

    describe('createPullRequestArtifact', () => {
      const codeMetadata: CodeMetadata = {
        branch: {
          name: 'job/test-branch',
          headCommit: 'abc123',
          remoteUrl: 'https://github.com/owner/repo.git',
          status: { isDirty: false },
        },
        repo: {
          remoteUrl: 'https://github.com/owner/repo.git',
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-123',
      };

      const baseParams = {
        requestId: '0xreq',
        branchUrl: 'https://github.com/owner/repo/tree/job/test-branch',
        branchName: 'job/test-branch',
        baseBranch: 'main',
        title: '[Job job-123] updates',
        summaryBlock: '### Execution Summary\n- Test summary',
        codeMetadata,
      };

      beforeEach(() => {
        vi.mocked(pushJsonToIpfs).mockResolvedValue(['0xdeadbeef', 'bafyprcid']);
        vi.mocked(controlApiCreateArtifact).mockResolvedValue('artifact-id');
      });

      it('returns artifact record and persists via Control API', async () => {
        const record = await createPullRequestArtifact(baseParams);

        expect(record).toEqual({
          cid: 'bafyprcid',
          topic: 'git/branch',
          name: 'branch-job/test-branch',
          type: 'GIT_BRANCH',
          // New format: "Branch: <branchName> based on <baseBranch> - <summary>"
          contentPreview: `Branch: ${baseParams.branchName} based on ${baseParams.baseBranch} - ${baseParams.summaryBlock!.slice(0, 50)}`,
          content: expect.stringContaining('job/test-branch'),
        });

        expect(pushJsonToIpfs).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'branch-job/test-branch',
            topic: 'git/branch',
            type: 'GIT_BRANCH',
          })
        );
        expect(controlApiCreateArtifact).toHaveBeenCalledWith('0xreq', {
          cid: 'bafyprcid',
          topic: 'git/branch',
          content: null,
        });
      });

      it('still returns record when Control API persistence fails', async () => {
        vi.mocked(controlApiCreateArtifact).mockRejectedValueOnce(new Error('boom'));
        const record = await createPullRequestArtifact(baseParams);
        expect(record).not.toBeNull();
        expect(record?.cid).toBe('bafyprcid');
      });

      it('throws when IPFS upload fails', async () => {
        vi.mocked(pushJsonToIpfs).mockRejectedValueOnce(new Error('ipfs down'));
        // Now throws instead of returning null
        await expect(
          createPullRequestArtifact(baseParams)
        ).rejects.toThrow('Branch artifact creation failed');
        expect(controlApiCreateArtifact).not.toHaveBeenCalled();
      });
    });
  });

});
