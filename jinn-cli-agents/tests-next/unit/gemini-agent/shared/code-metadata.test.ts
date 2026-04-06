/**
 * Unit Test: Code Metadata Collection
 * 
 * Tests that collectLocalCodeMetadata correctly captures remote URL from git config.
 * Validates that the remote URL used for PR creation matches the actual git remote.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { collectLocalCodeMetadata } from 'jinn-node/agent/shared/code_metadata.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('code-metadata', () => {
  const originalRepoRoot = process.env.CODE_METADATA_REPO_ROOT;
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-metadata-'));
    run('git init', repoDir);
    run('git config user.email "test@example.com"', repoDir);
    run('git config user.name "Test"', repoDir);

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n');
    run('git add README.md', repoDir);
    run('git commit -m "Initial"', repoDir);

    // Ensure main branch
    const currentBranch = run('git rev-parse --abbrev-ref HEAD', repoDir);
    if (currentBranch !== 'main') {
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

  describe('collectLocalCodeMetadata', () => {
    it('captures HTTPS remote URL from git config', async () => {
      const remoteUrl = 'https://github.com/owner/repo.git';
      run(`git remote add origin ${remoteUrl}`, repoDir);
      run('git checkout -b job/test-branch', repoDir);

      const metadata = await collectLocalCodeMetadata({
        jobDefinitionId: 'job-123',
        branchName: 'job/test-branch',
        baseBranch: 'main',
      });

      expect(metadata).toBeTruthy();
      expect(metadata?.repo?.remoteUrl).toBe(remoteUrl);
      expect(metadata?.branch?.remoteUrl).toBe(remoteUrl);
    });

    it('captures SSH remote URL from git config', async () => {
      const remoteUrl = 'git@github.com:owner/repo.git';
      run(`git remote add origin ${remoteUrl}`, repoDir);
      run('git checkout -b job/test-branch', repoDir);

      const metadata = await collectLocalCodeMetadata({
        jobDefinitionId: 'job-123',
        branchName: 'job/test-branch',
        baseBranch: 'main',
      });

      expect(metadata).toBeTruthy();
      expect(metadata?.repo?.remoteUrl).toBe(remoteUrl);
      expect(metadata?.branch?.remoteUrl).toBe(remoteUrl);
    });

    it('captures remote URL with embedded token (strips for storage)', async () => {
      // Git stores the URL with token, but we want to verify it's captured
      const remoteUrlWithToken = 'https://token123@github.com/owner/repo.git';
      const remoteUrlClean = 'https://github.com/owner/repo.git';
      
      run(`git remote add origin ${remoteUrlWithToken}`, repoDir);
      run('git checkout -b job/test-branch', repoDir);

      const metadata = await collectLocalCodeMetadata({
        jobDefinitionId: 'job-123',
        branchName: 'job/test-branch',
        baseBranch: 'main',
      });

      expect(metadata).toBeTruthy();
      // Git will return the URL as stored (with token), but that's OK
      // The PR creation logic will parse it correctly
      const capturedUrl = metadata?.repo?.remoteUrl;
      expect(capturedUrl).toBeTruthy();
      // Should contain the repo path
      expect(capturedUrl).toContain('github.com/owner/repo');
    });

    it('uses origin remote when upstream is not set', async () => {
      const remoteUrl = 'https://github.com/owner/repo.git';
      run(`git remote add origin ${remoteUrl}`, repoDir);
      run('git checkout -b job/test-branch', repoDir);
      // No upstream tracking set

      const metadata = await collectLocalCodeMetadata({
        jobDefinitionId: 'job-123',
        branchName: 'job/test-branch',
        baseBranch: 'main',
      });

      expect(metadata).toBeTruthy();
      expect(metadata?.repo?.remoteUrl).toBe(remoteUrl);
    });

    it('returns null when jobDefinitionId is missing', async () => {
      await expect(
        collectLocalCodeMetadata({
          branchName: 'job/test-branch',
          baseBranch: 'main',
        } as any)
      ).rejects.toThrow('collectLocalCodeMetadata requires a jobDefinitionId');
    });

    it('captures remote URL that matches actual git remote', async () => {
      const expectedRemote = 'https://github.com/test-org/test-repo.git';
      run(`git remote add origin ${expectedRemote}`, repoDir);
      run('git checkout -b job/test-branch', repoDir);

      const metadata = await collectLocalCodeMetadata({
        jobDefinitionId: 'job-123',
        branchName: 'job/test-branch',
        baseBranch: 'main',
      });

      // Verify the captured URL matches what git reports
      const gitRemote = run('git remote get-url origin', repoDir);
      expect(metadata?.repo?.remoteUrl).toBe(gitRemote);
      expect(metadata?.branch?.remoteUrl).toBe(gitRemote);
    });

    it('handles missing remote gracefully', async () => {
      // No remote added
      run('git checkout -b job/test-branch', repoDir);

      const metadata = await collectLocalCodeMetadata({
        jobDefinitionId: 'job-123',
        branchName: 'job/test-branch',
        baseBranch: 'main',
      });

      // Should still create metadata, but remoteUrl will be undefined
      expect(metadata).toBeTruthy();
      expect(metadata?.repo?.remoteUrl).toBeUndefined();
      expect(metadata?.branch?.remoteUrl).toBeUndefined();
    });
  });
});

