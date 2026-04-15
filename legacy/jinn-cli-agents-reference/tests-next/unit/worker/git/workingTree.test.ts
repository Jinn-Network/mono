/**
 * Unit Test: Git Working Tree Operations
 * Migrated from: tests/unit/worker/git/workingTree.test.ts
 * Migration Date: November 7, 2025
 *
 * Tests git working tree operations (status, staging, commit counting).
 * Uses real temp git repos - acceptable for git operations testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { CodeMetadata } from 'jinn-node/agent/shared/code_metadata.js';
import {
  hasUncommittedChanges,
  stageAllChanges,
  getGitStatus,
  getCommitCount,
} from 'jinn-node/worker/git/workingTree.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('workingTree', () => {
  const originalRepoRoot = process.env.CODE_METADATA_REPO_ROOT;
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-working-tree-'));
    run('git init', repoDir);
    run('git config user.email "test@example.com"', repoDir);
    run('git config user.name "Worker Test"', repoDir);

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo\n');
    run('git add README.md', repoDir);
    run('git commit -m "Initial commit"', repoDir);
    run('git checkout -b job/test-branch', repoDir);

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

  describe('hasUncommittedChanges', () => {
    it('returns false when working tree is clean', async () => {
      const metadata: CodeMetadata = {
        branch: {
          name: 'job/test-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const hasChanges = await hasUncommittedChanges(metadata);
      expect(hasChanges).toBe(false);
    });

    it('returns true when there are uncommitted changes', async () => {
      fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'content');

      const metadata: CodeMetadata = {
        branch: {
          name: 'job/test-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: true }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const hasChanges = await hasUncommittedChanges(metadata);
      expect(hasChanges).toBe(true);
    });
  });

  describe('stageAllChanges', () => {
    it('stages all changes in working tree', async () => {
      fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'content');
      fs.writeFileSync(path.join(repoDir, 'modified.txt'), 'original');
      run('git add modified.txt', repoDir);
      run('git commit -m "Add modified"', repoDir);
      fs.writeFileSync(path.join(repoDir, 'modified.txt'), 'modified');

      const metadata: CodeMetadata = {
        branch: {
          name: 'job/test-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: true }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      await stageAllChanges(metadata);

      const status = run('git status --porcelain', repoDir);
      // All files should be staged (no '?' prefix)
      expect(status).not.toContain('??');
      expect(status).toContain('new-file.txt');
      expect(status).toContain('modified.txt');
    });
  });

  describe('getGitStatus', () => {
    it('returns empty string when working tree is clean', async () => {
      const metadata: CodeMetadata = {
        branch: {
          name: 'job/test-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const status = await getGitStatus(metadata);
      expect(status).toBe('');
    });

    it('returns status output when there are changes', async () => {
      fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'content');

      const metadata: CodeMetadata = {
        branch: {
          name: 'job/test-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: true }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const status = await getGitStatus(metadata);
      expect(status).toContain('new-file.txt');
    });
  });

  describe('getCommitCount', () => {
    it('returns correct commit count for HEAD', async () => {
      const metadata: CodeMetadata = {
        branch: {
          name: 'job/test-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const count = await getCommitCount(metadata);
      expect(count).toBeGreaterThan(0);
    });

    it('returns count for specific branch', async () => {
      run('git checkout -b other-branch', repoDir);
      fs.writeFileSync(path.join(repoDir, 'branch-file.txt'), 'content');
      run('git add branch-file.txt', repoDir);
      run('git commit -m "Branch commit"', repoDir);

      const metadata: CodeMetadata = {
        branch: {
          name: 'other-branch',
          headCommit: run('git rev-parse HEAD', repoDir),
          status: { isDirty: false }
        },
        baseBranch: 'main',
        capturedAt: new Date().toISOString(),
        jobDefinitionId: 'job-test'
      };

      const count = await getCommitCount(metadata, 'other-branch');
      expect(count).toBeGreaterThan(1);
    });
  });
});

