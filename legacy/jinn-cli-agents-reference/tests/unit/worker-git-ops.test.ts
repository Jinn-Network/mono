import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { CodeMetadata } from 'jinn-node/agent/shared/code_metadata.js';
import { autoCommitIfNeeded, formatSummaryForPr } from 'jinn-node/worker/git/autoCommit.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('Worker Git Operations', () => {
  const originalRepoRoot = process.env.CODE_METADATA_REPO_ROOT;
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-git-ops-'));
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
    } catch { }
  });

  it('autoCommitIfNeeded commits pending changes and leaves clean state', async () => {
    fs.writeFileSync(path.join(repoDir, 'notes.txt'), 'Some notes\n', 'utf-8');

    const metadata: CodeMetadata = {
      branch: {
        name: 'job/test-branch',
        headCommit: run('git rev-parse HEAD', repoDir),
        status: { isDirty: true }
      },
      baseBranch: 'main',
      capturedAt: new Date().toISOString(),
      jobDefinitionId: 'job-auto-commit'
    };

    const commitMessage = 'Auto commit from unit test';
    const madeCommit = await autoCommitIfNeeded(metadata, commitMessage);
    expect(madeCommit).toBe(true);

    const latestMessage = run('git log -1 --pretty=%s', repoDir);
    expect(latestMessage).toBe(commitMessage);

    const statusAfter = run('git status --porcelain', repoDir);
    expect(statusAfter).toBe('');
  });

  it('autoCommitIfNeeded returns false when there is nothing to commit', async () => {
    const metadata: CodeMetadata = {
      branch: {
        name: 'job/test-branch',
        headCommit: run('git rev-parse HEAD', repoDir),
        status: { isDirty: false }
      },
      baseBranch: 'main',
      capturedAt: new Date().toISOString(),
      jobDefinitionId: 'job-auto-commit'
    };

    const madeCommit = await autoCommitIfNeeded(metadata, 'No changes commit');
    expect(madeCommit).toBe(false);
  });

  it('formatSummaryForPr formats execution summary bullets', () => {
    const summaryBlock = formatSummaryForPr({
      heading: '## Execution Summary',
      lines: [
        '- Added feature.txt for PR workflow',
        '* Reviewed tests'
      ],
      text: ''
    });

    expect(summaryBlock).toContain('### Execution Summary');
    expect(summaryBlock).toContain('- Added feature.txt for PR workflow');
    expect(summaryBlock).toContain('- Reviewed tests');
  });

  it('checkoutJobBranch clears build cache directories after checkout', async () => {
    // Switch back to main first so we can checkout to a new branch
    // Note: beforeEach creates main as the initial branch and then checks out job/test-branch
    run('git checkout main', repoDir);

    // Create cache directories that would become stale
    const nextDir = path.join(repoDir, '.next');
    const contentlayerDir = path.join(repoDir, '.contentlayer');
    const turboDir = path.join(repoDir, '.turbo');
    fs.mkdirSync(nextDir);
    fs.mkdirSync(contentlayerDir);
    fs.mkdirSync(turboDir);
    fs.writeFileSync(path.join(nextDir, 'cache.json'), '{"stale": true}');
    fs.writeFileSync(path.join(contentlayerDir, 'generated.json'), '{}');

    // Import and call checkoutJobBranch
    const { checkoutJobBranch } = await import('../../worker/git/branch.js');
    const metadata: CodeMetadata = {
      branch: { name: 'job/cache-test-branch', headCommit: '', status: { isDirty: false } },
      baseBranch: 'main',
      capturedAt: new Date().toISOString(),
      jobDefinitionId: 'job-cache-clear-test'
    };

    await checkoutJobBranch(metadata);

    // Verify cache directories are gone
    expect(fs.existsSync(nextDir)).toBe(false);
    expect(fs.existsSync(contentlayerDir)).toBe(false);
    expect(fs.existsSync(turboDir)).toBe(false);
  });
});
