import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  getSharedInfrastructure,
  resetTestEnvironment,
  createTestJob,
  waitForRequestIndexed,
  waitForJobIndexed,
  waitForDelivery,
  runWorkerOnce,
} from '../helpers/shared.js';
import { getTestGitRepo } from '../helpers/test-git-repo.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

describe('Worker: Git Auto-Commit Flow', () => {
  const suiteId = process.env.E2E_SUITE_ID ?? `manual-suite-${process.pid}`;
  if (!process.env.E2E_SUITE_ID) {
    process.env.E2E_SUITE_ID = suiteId;
  }

  let originalCwd: string;
  let testRepo: ReturnType<typeof getTestGitRepo>;

  beforeEach(() => {
    resetTestEnvironment();

    testRepo = getTestGitRepo(suiteId);
    originalCwd = process.cwd();
    process.chdir(testRepo.repoPath);

    process.env.CODE_METADATA_REPO_ROOT = testRepo.repoPath;

    try {
      const testEnv = path.join(originalCwd, '.env.test');
      if (fs.existsSync(testEnv)) {
        process.env.JINN_ENV_PATH = testEnv;
      }
    } catch {}
  });

  afterEach(() => {
    if (testRepo) {
      testRepo.cleanup();
    }

    process.chdir(originalCwd);
    delete process.env.CODE_METADATA_REPO_ROOT;
  });

  it('auto-commits file edits and pushes branch when job completes', async () => {
    const { gqlUrl, controlUrl } = getSharedInfrastructure();

    const { jobDefId, requestId } = await createTestJob({
      objective: 'Create a feature file for auto-commit validation',
      context: 'Ensures worker auto-commit logic runs after successful execution',
      instructions: `
1. Create a file named "feature.txt" in the repository root with exactly this content:

Auto commit validation

2. Immediately provide your final response. Do NOT create any artifacts. Do NOT ask any questions. Include the following Execution Summary section verbatim in your final chat message:

### Execution Summary
- Added feature.txt for auto-commit flow
- Ready for auto-commit validation

3. Do not run git commands; the worker will commit and push.
      `.trim(),
      acceptanceCriteria: 'feature.txt created with the specified content and execution summary returned in the chat response',
      enabledTools: [
        'write_file'
      ]
    });

    await waitForRequestIndexed(gqlUrl, requestId);
    const jobDefinition = await waitForJobIndexed(gqlUrl, jobDefId);

    const expectedBranchName = jobDefinition.codeMetadata.branch.name;

    const initialCommitCount = parseInt(run(`git rev-list --count ${expectedBranchName}`, testRepo.repoPath));

    const workerProc = await runWorkerOnce(requestId, {
      gqlUrl,
      controlApiUrl: controlUrl,
      model: 'gemini-2.5-pro',
      timeout: 300_000
    });

    try {
      await workerProc;
    } catch (error) {
      console.log('[test] Worker exited with error (may be expected):', error);
    }

    await waitForDelivery(gqlUrl, requestId, {
      maxAttempts: 40,
      delayMs: 5000
    });

    // Ensure we have the latest remote commits
    run('git fetch origin', testRepo.repoPath);

    const finalCommitCount = parseInt(run(`git rev-list --count ${expectedBranchName}`, testRepo.repoPath));
    expect(finalCommitCount).toBeGreaterThan(initialCommitCount);

    const newCommits = finalCommitCount - initialCommitCount;
    const commitLog = run(`git log ${expectedBranchName} --format="%s" -n ${newCommits}`, testRepo.repoPath);
    expect(commitLog.length).toBeGreaterThan(0);
    expect(commitLog).toMatch(/Added feature\.txt for auto-commit flow/);
  }, 600_000);
});
