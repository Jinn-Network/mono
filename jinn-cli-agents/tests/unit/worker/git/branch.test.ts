import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { CodeMetadata } from 'jinn-node/agent/shared/code_metadata.js';
import {
  checkoutJobBranch,
  buildJobBranchName,
  ensureJobBranch,
} from 'jinn-node/worker/git/branch.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('branch', () => {
  const originalRepoRoot = process.env.CODE_METADATA_REPO_ROOT;
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-branch-'));
    run('git init', repoDir);
    run('git config user.email "test@example.com"', repoDir);
    run('git config user.name "Worker Test"', repoDir);

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo\n');
    run('git add README.md', repoDir);
    run('git commit -m "Initial commit"', repoDir);
    // Ensure we're on main branch (git init creates it by default, but may be named 'master' in older git)
    const currentBranch = run('git rev-parse --abbrev-ref HEAD', repoDir);
    if (currentBranch !== 'main') {
      // Rename to main if it's master
      run('git branch -m main', repoDir);
    }

    process.env.CODE_METADATA_REPO_ROOT = repoDir;
  });

  afterEach(() => {
    if (originalRepoRoot === undefined) {
      delete process.env.CODE_METADATA_REPO_ROOT;
    } else {
      process.env.CODE_METADATA_REPO_ROOT = originalRepoRoot;
    }
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

  describe('checkoutJobBranch', () => {
    it('creates new branch from baseBranch when branch does not exist', async () => {
      const metadata: CodeMetadata = {
        branch: {
          name: 'job/new-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const result = await checkoutJobBranch(metadata);
      expect(result.branchName).toBe('job/new-branch');
      expect(result.wasNewlyCreated).toBe(true);

      const currentBranch = run('git rev-parse --abbrev-ref HEAD', repoDir);
      expect(currentBranch).toBe('job/new-branch');
    });

    it('checks out existing local branch', async () => {
      run('git checkout -b job/existing-branch', repoDir);
      run('git checkout main', repoDir);

      const metadata: CodeMetadata = {
        branch: {
          name: 'job/existing-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const result = await checkoutJobBranch(metadata);
      expect(result.branchName).toBe('job/existing-branch');
      expect(result.wasNewlyCreated).toBe(false);

      const currentBranch = run('git rev-parse --abbrev-ref HEAD', repoDir);
      expect(currentBranch).toBe('job/existing-branch');
    });

    it('throws error when branch name is missing', async () => {
      const metadata: CodeMetadata = {
        branch: {
          name: '',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      await expect(checkoutJobBranch(metadata)).rejects.toThrow('branch.name is required');
    });
  });

  describe('buildJobBranchName', () => {
    it('builds branch name from job definition ID', () => {
      const name = buildJobBranchName({
        jobDefinitionId: 'job-123-456',
      });
      expect(name).toBe('job/job-123-456');
    });

    it('includes job name slug when provided', () => {
      const name = buildJobBranchName({
        jobDefinitionId: 'job-123-456',
        jobName: 'My Test Job',
      });
      expect(name).toContain('job/job-123-456');
      expect(name).toContain('-');
    });
  });

  describe('ensureJobBranch', () => {
    it('wraps checkoutJobBranch correctly', async () => {
      const metadata: CodeMetadata = {
        branch: {
          name: 'job/ensure-test',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const result = await ensureJobBranch(metadata);
      expect(result.branchName).toBe('job/ensure-test');
      expect(result.wasNewlyCreated).toBe(true);
    });
  });
});

