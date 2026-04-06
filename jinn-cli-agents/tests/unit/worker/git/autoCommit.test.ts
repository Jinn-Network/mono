import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { CodeMetadata } from 'jinn-node/agent/shared/code_metadata.js';
import {
  autoCommitIfNeeded,
  deriveCommitMessage,
  extractExecutionSummary,
  formatSummaryForPr,
} from 'jinn-node/worker/git/autoCommit.js';
import type { FinalStatus } from 'jinn-node/worker/types.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('autoCommit', () => {
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
    } catch {}
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

  it('throws error when commit message is empty', async () => {
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

    await expect(autoCommitIfNeeded(metadata, '')).rejects.toThrow('commit message is empty');
    await expect(autoCommitIfNeeded(metadata, '   ')).rejects.toThrow('commit message is empty');
  });

  describe('deriveCommitMessage', () => {
    it('uses execution summary line when available', () => {
      const summary = {
        heading: '## Execution Summary',
        lines: ['- Added feature.txt for PR workflow', '* Reviewed tests'],
        text: ''
      };
      const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Job completed' };
      const fallback = { jobId: '123', jobDefinitionId: 'job-456' };

      const message = deriveCommitMessage(summary, finalStatus, fallback);
      expect(message).toBe('Added feature.txt for PR workflow');
    });

    it('uses finalStatus message when no summary', () => {
      const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Job completed successfully' };
      const fallback = { jobId: '123', jobDefinitionId: 'job-456' };

      const message = deriveCommitMessage(null, finalStatus, fallback);
      expect(message).toBe('Job completed successfully');
    });

    it('uses job definition fallback when no status message', () => {
      const finalStatus: FinalStatus = { status: 'COMPLETED', message: '' };
      const fallback = { jobId: '123', jobDefinitionId: 'job-456' };

      const message = deriveCommitMessage(null, finalStatus, fallback);
      expect(message).toBe('[Job job-456] auto-commit');
    });

    it('truncates long messages to 72 characters', () => {
      const summary = {
        heading: '## Execution Summary',
        lines: ['- ' + 'x'.repeat(100)],
        text: ''
      };
      const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Job completed' };
      const fallback = { jobId: '123', jobDefinitionId: 'job-456' };

      const message = deriveCommitMessage(summary, finalStatus, fallback);
      expect(message.length).toBeLessThanOrEqual(72);
      expect(message).toContain('...');
    });
  });

  describe('extractExecutionSummary', () => {
    it('extracts execution summary from output', () => {
      const output = `
Some preamble text

## Execution Summary
- Added feature.txt for PR workflow
- Reviewed tests
- Fixed bugs

FinalStatus: COMPLETED
`;

      const summary = extractExecutionSummary(output);
      expect(summary).not.toBeNull();
      expect(summary?.heading).toBe('## Execution Summary');
      expect(summary?.lines).toHaveLength(3);
      expect(summary?.lines[0]).toContain('Added feature.txt');
    });

    it('returns null when no execution summary found', () => {
      const output = 'Just some regular output without summary';
      const summary = extractExecutionSummary(output);
      expect(summary).toBeNull();
    });

    it('handles empty output', () => {
      expect(extractExecutionSummary('')).toBeNull();
      expect(extractExecutionSummary(null as any)).toBeNull();
    });
  });

  describe('formatSummaryForPr', () => {
    it('formats execution summary bullets', () => {
      const summary = {
        heading: '## Execution Summary',
        lines: [
          '- Added feature.txt for PR workflow',
          '* Reviewed tests'
        ],
        text: ''
      };

      const summaryBlock = formatSummaryForPr(summary);

      expect(summaryBlock).toContain('### Execution Summary');
      expect(summaryBlock).toContain('- Added feature.txt for PR workflow');
      expect(summaryBlock).toContain('- Reviewed tests');
    });

    it('returns null when summary is null', () => {
      expect(formatSummaryForPr(null)).toBeNull();
    });

    it('returns null when summary has no lines', () => {
      const summary = {
        heading: '## Execution Summary',
        lines: [],
        text: ''
      };
      expect(formatSummaryForPr(summary)).toBeNull();
    });
  });
});

