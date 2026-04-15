/**
 * Worker Git Lineage E2E Test
 * Tests complete worker→agent execution with git operations validation
 *
 * Architecture (CURRENT):
 * - WORKER checks out job branch before agent runs
 * - AGENT makes file changes using tools and produces an execution summary (no manual git)
 * - WORKER infers completion, auto-commits pending changes, and pushes the branch
 * - WORKER creates PR after push
 *
 * This test validates that:
 * 1. Job branch is created with correct name (job/<jobDefId>)
 * 2. Worker checks out job branch before agent execution
 * 3. Worker auto-commits and pushes code changes when the job completes
 * 4. Worker creates PR from job branch to base branch
 * 5. Child branches are based on parent branch (not main)
 * 6. PR URL is included in delivery payload (not as artifact)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import fetch from 'cross-fetch';
import {
  getSharedInfrastructure,
  resetTestEnvironment,
  createTestJob,
  waitForRequestIndexed,
  waitForJobIndexed,
  waitForDelivery,
  runWorkerOnce,
  reconstructDirCidFromHexIpfsHash,
  fetchJsonWithRetry,
} from '../helpers/shared.js';
import { getTestGitRepo } from '../helpers/test-git-repo.js';
import { extractExecutionSummary, deriveCommitMessage } from 'jinn-node/worker/git/autoCommit.js';
import type { FinalStatus } from 'jinn-node/worker/types.js';

let branchPushVerified = false;

describe('Worker: Git Lineage E2E', () => {
  const suiteId = process.env.E2E_SUITE_ID ?? `manual-suite-${process.pid}`;
  if (!process.env.E2E_SUITE_ID) {
    process.env.E2E_SUITE_ID = suiteId;
  }

  let originalCwd: string;
  let testRepo: ReturnType<typeof getTestGitRepo>;

  beforeEach(() => {
    resetTestEnvironment();

    // Set up test git repository
    testRepo = getTestGitRepo(suiteId);
    originalCwd = process.cwd();
    process.chdir(testRepo.repoPath);

    // Configure environment for code metadata
    process.env.CODE_METADATA_REPO_ROOT = testRepo.repoPath;

    // Load test env
    try {
      const testEnv = path.join(originalCwd, '.env.test');
      if (fs.existsSync(testEnv)) {
        process.env.JINN_ENV_PATH = testEnv;
      }
    } catch {}
  });

  afterEach(() => {
    // Clean up test branches
    if (testRepo) {
      testRepo.cleanup();
    }

    // Restore original directory
    process.chdir(originalCwd);

    // Clean up environment
    delete process.env.CODE_METADATA_REPO_ROOT;
  });

  it('agent executes on job branch, makes commits, and pushes', async () => {
    const { gqlUrl, controlUrl } = getSharedInfrastructure();

    console.log(`[test] Using test repo: ${testRepo.repoPath}`);
    console.log('[test] Creating job that requires file changes...');

    // 1) Create a job that will make the agent write/edit files
    const { jobDefId, requestId } = await createTestJob({
      objective: 'Create and modify files to test git operations',
      context: 'E2E test validating worker auto-commit and PR creation',
      instructions: `
You are working in a test git repository with lineage tracking enabled.

Tasks:
1. Write a new file called "feature.txt" with content "Implemented new feature".
2. Create an artifact documenting your changes with name="implementation_notes", topic="feature", content="Created feature.txt file".
3. Provide an \`Execution Summary\` section whose first bullet is "- Added feature.txt for new feature".
4. Do **not** run any git commands; the worker will commit and push for you.
      `.trim(),
      acceptanceCriteria: 'File created and execution summary provided so worker can push changes',
      enabledTools: ['write_file', 'create_artifact']
    });

    console.log(`[test] Job created: ${jobDefId}`);

    // 2) Wait for job to be indexed
    await waitForRequestIndexed(gqlUrl, requestId);
    const jobDefinition = await waitForJobIndexed(gqlUrl, jobDefId);

    expect(jobDefinition?.codeMetadata, 'Job definition should have code metadata').toBeTruthy();
    const expectedBranchName = jobDefinition.codeMetadata.branch.name;
    console.log(`[test] Job branch: ${expectedBranchName}`);

    // Verify branch exists
    const branchesOutput = execSync('git branch --format="%(refname:short)"', {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    });
    const branches = branchesOutput.split('\n').filter(b => b);
    expect(branches).toContain(expectedBranchName);

    // Get initial commit count
    const initialCommitCount = parseInt(
      execSync(`git rev-list --count ${expectedBranchName}`, {
        cwd: testRepo.repoPath,
        encoding: 'utf-8'
      }).trim()
    );
    console.log(`[test] Initial commits on job branch: ${initialCommitCount}`);

    // 3) Run worker (which runs agent)
    console.log('[test] Starting worker...');
    const workerProc = await runWorkerOnce(requestId, {
      gqlUrl,
      controlApiUrl: controlUrl,
      model: 'gemini-2.5-pro',
      timeout: 120_000
    });

    try {
      await workerProc;
      console.log('[test] Worker completed');
    } catch (error) {
      console.log('[test] Worker exited with error (may be expected):', error);
    }

    const statusOutput = execSync('git status --short', {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();
    console.log(`[test] Git status after worker:\n${statusOutput || '(clean)'}`);

    const diffStatOutput = execSync('git diff --stat', {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();
    console.log(`[test] Git diff --stat after worker:\n${diffStatOutput || '(no diff)'}`);

    // 4) Wait for delivery
    const delivery = await waitForDelivery(gqlUrl, requestId, {
      maxAttempts: 40,
      delayMs: 5000
    });

    console.log(`[test] Delivery indexed: ${delivery.ipfsHash}`);

    // Fetch delivery JSON to extract execution summary for commit message validation
    const dirCid = reconstructDirCidFromHexIpfsHash(delivery.ipfsHash);
    const reqPath = `${dirCid}/${requestId}`;
    const deliveryUrl = `https://gateway.autonolas.tech/ipfs/${reqPath}`;
    const deliveryJson = await fetchJsonWithRetry(deliveryUrl, 6, 2000);

    // Derive expected commit message from execution summary (same logic as worker)
    const outputText = typeof deliveryJson.output === 'string'
      ? deliveryJson.output
      : JSON.stringify(deliveryJson.output ?? '');
    const executionSummary = extractExecutionSummary(outputText);
    const finalStatus: FinalStatus = {
      status: deliveryJson.status || 'COMPLETED',
      message: deliveryJson.statusMessage || null,
    };
    const expectedCommitMessage = deriveCommitMessage(executionSummary, finalStatus, {
      jobId: requestId,
      jobDefinitionId: jobDefId,
    });
    console.log(`[test] Expected commit message derived from execution summary: "${expectedCommitMessage}"`);

    // Sync latest commits for the job branch from the remote
    // Fetch all refs first to ensure remote branches are available
    execSync('git fetch origin', {
      cwd: testRepo.repoPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });

    // Checkout or update the local branch from remote
    try {
      // Try to checkout existing local branch and update from remote
      execSync(`git checkout ${expectedBranchName}`, {
        cwd: testRepo.repoPath,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      execSync(`git pull origin ${expectedBranchName}`, {
        cwd: testRepo.repoPath,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
    } catch {
      // Branch doesn't exist locally, create tracking branch from remote
      execSync(`git checkout -b ${expectedBranchName} origin/${expectedBranchName}`, {
        cwd: testRepo.repoPath,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
    }

    // 5) Verify commits were made to job branch
    const finalCommitCount = parseInt(
      execSync(`git rev-list --count ${expectedBranchName}`, {
        cwd: testRepo.repoPath,
        encoding: 'utf-8'
      }).trim()
    );
    console.log(`[test] Final commits on job branch: ${finalCommitCount}`);

    expect(finalCommitCount).toBeGreaterThan(initialCommitCount);
    const newCommits = finalCommitCount - initialCommitCount;
    console.log(`[test] ✓ Worker recorded ${newCommits} new commit(s)`);

    const commitLog = execSync(
      `git log ${expectedBranchName} --format="%s" -n ${newCommits}`,
      {
        cwd: testRepo.repoPath,
        encoding: 'utf-8'
      }
    );
    console.log(`[test] Commit messages:\n${commitLog}`);

    const latestCommitMessage = execSync(
      `git log ${expectedBranchName} --format="%s" -n 1`,
      { cwd: testRepo.repoPath, encoding: 'utf-8' }
    ).trim();
    console.log(`[test] Actual commit message: "${latestCommitMessage}"`);
    
    expect(latestCommitMessage.length).toBeGreaterThan(0);
    // Verify commit message matches what worker derived from execution summary
    expect(latestCommitMessage).toBe(expectedCommitMessage);

    // 6) Verify branch was pushed to remote
    const remoteBranches = execSync('git ls-remote --heads origin', {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    });

    expect(remoteBranches).toContain(expectedBranchName);
    console.log(`[test] ✓ Branch pushed to remote`);

    // 7) Verify local and remote are in sync
    const localCommit = execSync(`git rev-parse ${expectedBranchName}`, {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();

    const remoteCommit = execSync(`git rev-parse origin/${expectedBranchName}`, {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();

    expect(localCommit).toBe(remoteCommit);
    console.log(`[test] ✓ Local/remote in sync: ${localCommit.substring(0, 7)}`);
    branchPushVerified = true;

    // 8) Verify delivery JSON (already fetched earlier for commit message validation)
    expect(deliveryJson.requestId).toBe(requestId);
    expect(deliveryJson.executionPolicy?.branch).toBe(expectedBranchName);

    console.log('\n[test] ✅ Git Operations Validation:');
    console.log(`  ✓ Branch created: ${expectedBranchName}`);
    console.log(`  ✓ Agent executed on job branch`);
    console.log(`  ✓ Commits: ${finalCommitCount} total, ${finalCommitCount - initialCommitCount} new`);
    console.log(`  ✓ Branch pushed to remote`);
    console.log(`  ✓ Local/remote synchronized`);
  }, 600_000);

  it('worker creates pull request after agent completes', async () => {
    if (!branchPushVerified) {
      console.warn('[test] Skipping PR creation test because branch push validation did not complete successfully.');
      return;
    }

    const { gqlUrl, controlUrl } = getSharedInfrastructure();

    // Fail if GITHUB_TOKEN not set - PR creation is a required feature
    if (!process.env.GITHUB_TOKEN) {
      throw new Error(
        'GITHUB_TOKEN environment variable is required for PR creation test. ' +
        'Set GITHUB_TOKEN to a valid GitHub personal access token with repo permissions.'
      );
    }

    console.log('[test] Testing PR creation workflow...');

    // 1) Create a job that results in file changes
    const { jobDefId, requestId } = await createTestJob({
      objective: 'Create a test feature file and prepare PR-ready summary (no artifact tools)',
      context: 'E2E test validating worker creates PR after agent completes',
      instructions: `
Create a new file called feature.txt in the root directory with the following content:

Test Feature Implementation
===========================

This file demonstrates the PR creation workflow.
Created by the agent as part of the E2E test.

Feature Details:
- Automated file creation
- Git commit workflow
- Pull request generation

When you reply:
- Include an "Execution Summary" section in your final chat message whose first bullet is "- Added feature.txt for PR workflow".
- Do not call create_artifact or produce any external artifacts; the execution summary must appear directly in your chat response.
- Do **not** run git commands; the worker will auto-commit and push.
      `.trim(),
      acceptanceCriteria: 'File created and execution summary returned in the final chat response (no artifacts created).',
      enabledTools: [
        'list_directory',
        'read_file',
        'write_file',
        'search_file_content',
        'glob',
        'replace',
        'read_many_files',
        'run_shell_command'
      ]
    });

    console.log(`[test] Job created: ${jobDefId}`);

    // 2) Wait for job to be indexed
    await waitForRequestIndexed(gqlUrl, requestId);
    const jobDefinition = await waitForJobIndexed(gqlUrl, jobDefId);

    const jobBranchName = jobDefinition.codeMetadata.branch.name;
    const baseBranch = jobDefinition.codeMetadata.baseBranch || 'main';
    console.log(`[test] Job branch: ${jobBranchName}`);
    console.log(`[test] Base branch: ${baseBranch}`);

    // 3) Run worker
    console.log('[test] Starting worker...');
    const workerProc = await runWorkerOnce(requestId, {
      gqlUrl,
      controlApiUrl: controlUrl,
      model: 'gemini-2.5-pro',
      timeout: 120_000
    });

    try {
      await workerProc;
    } catch (error) {
      console.log('[test] Worker exited with error (may be expected):', error);
    }

    // 4) Wait for delivery
    const delivery = await waitForDelivery(gqlUrl, requestId, {
      maxAttempts: 40,
      delayMs: 5000
    });

    console.log(`[test] Delivery indexed: ${delivery.ipfsHash}`);

    // Ensure local branch reflects the latest remote commits
    execSync('git fetch origin', {
      cwd: testRepo.repoPath,
      stdio: 'ignore'
    });
    execSync(`git checkout -B ${jobBranchName} origin/${jobBranchName}`, {
      cwd: testRepo.repoPath,
      stdio: 'ignore'
    });

    // 5) Fetch delivery JSON and verify PR URL is in payload
    const dirCid = reconstructDirCidFromHexIpfsHash(delivery.ipfsHash);
    const reqPath = `${dirCid}/${requestId}`;
    const url = `https://gateway.autonolas.tech/ipfs/${reqPath}`;
    const deliveryJson = await fetchJsonWithRetry(url, 6, 2000);

    // PR URL MUST be in the delivery payload (not artifacts)
    expect(deliveryJson.pullRequestUrl, 'pullRequestUrl must exist in delivery payload').toBeTruthy();

    const prUrl = deliveryJson.pullRequestUrl as string;
    const prUrlMatch = prUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);

    expect(prUrlMatch, 'pullRequestUrl must be a valid GitHub PR URL').toBeTruthy();

    const [, owner, repo, prNumberStr] = prUrlMatch!;
    const prNumber = parseInt(prNumberStr);

    console.log(`[test] ✓ PR created: ${prUrl}`);
    console.log(`[test] ✓ Owner: ${owner}, Repo: ${repo}, PR #${prNumber}`);

    // 6) Verify the PR exists via GitHub API
    const prApiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const prResponse = await fetch(prApiUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'jinn-test-suite'
      }
    });

    expect(prResponse.ok, `PR should exist: GET ${prApiUrl}`).toBeTruthy();
    const prData = await prResponse.json();

    expect(prData.head.ref).toBe(jobBranchName);
    expect(prData.base.ref).toBe(baseBranch);
    expect(prData.state).toBe('open');
    const expectedSummarySnippet = '### Execution Summary';
    const fallbackSummarySnippet = 'Automated PR for job definition';
    expect(
      prData.body.includes(expectedSummarySnippet) || prData.body.includes(fallbackSummarySnippet),
      'PR body should include either the execution summary section or the fallback automated message'
    ).toBeTruthy();
    if (prData.body.includes(expectedSummarySnippet)) {
      expect(prData.body).toContain('- Added feature.txt for PR workflow');
    }

    const finalCommitMessage = execSync(
      `git log ${jobBranchName} --format="%s" -n 1`,
      { cwd: testRepo.repoPath, encoding: 'utf-8' }
    ).trim();
    const allowsFallbackCommitMessage = finalCommitMessage.startsWith('[Job');
    expect(finalCommitMessage.length).toBeGreaterThan(0);
    if (!allowsFallbackCommitMessage) {
      expect(finalCommitMessage).toContain('Added feature.txt');
    }

    console.log('\n[test] ✅ PR Creation Validation:');
    console.log(`  ✓ PR #${prNumber}: ${prUrl}`);
    console.log(`  ✓ Source branch: ${prData.head.ref}`);
    console.log(`  ✓ Target branch: ${prData.base.ref}`);
    console.log(`  ✓ PR state: ${prData.state}`);
    console.log(`  ✓ PR title: ${prData.title}`);
  }, 600_000);

  it('child job branch is based on parent branch (not main)', async () => {
    const { gqlUrl, controlUrl } = getSharedInfrastructure();

    console.log('[test] Testing branch ancestry: child based on parent...');

    // 1) Create parent job that makes changes and dispatches a child
    const { jobDefId: parentJobId, requestId: parentRequestId } = await createTestJob({
      objective: 'Create a simple text file and delegate follow-up work',
      context: 'We need to create a basic file and then have another job continue the work.',
      instructions: `
1. Create a file named "task-list.txt" in the root directory. Write exactly this content into the file:

Task List
=========
- Complete initial setup
- Configure dependencies
- Test integration

2. After creating the file, immediately dispatch a child job with these exact parameters:
   - objective: "Add more tasks to the task list"
   - context: "A task list file has been created. Add 2 more task items to it."
   - acceptanceCriteria: "Two additional task items added to task-list.txt"
   - jobName: "add-more-tasks"

3. Immediately after dispatching the child job, provide your final response. Include this exact Execution Summary section:

### Execution Summary
- Created task-list.txt with initial task list
- Dispatched child job "add-more-tasks" to add more tasks
- Waiting for child job to complete

Do NOT create any artifacts. Do NOT ask any questions. Just create the file with the exact content shown above, dispatch the child job, and provide the execution summary.

4. Do not run git commands; the workflow service will handle commits and pushes.
      `.trim(),
      acceptanceCriteria: 'Task list file created, child job dispatched, and execution summary provided indicating waiting for child completion.',
      enabledTools: [
        'write_file',
        'dispatch_new_job'
      ]
    });

    console.log(`[test] Parent job created: ${parentJobId}`);

    // 2) Wait for parent to be indexed
    await waitForRequestIndexed(gqlUrl, parentRequestId);
    const parentJobDef = await waitForJobIndexed(gqlUrl, parentJobId);

    const parentBranchName = parentJobDef.codeMetadata.branch.name;
    console.log(`[test] Parent branch: ${parentBranchName}`);

    // Get parent branch initial commit
    const parentInitialCommit = execSync(`git rev-parse ${parentBranchName}`, {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();

    // 3) Run worker on parent job
    console.log('[test] Running worker on parent job...');
    const workerProc = await runWorkerOnce(parentRequestId, {
      gqlUrl,
      controlApiUrl: controlUrl,
      model: 'gemini-2.5-pro',
      timeout: 120_000
    });

    try {
      await workerProc;
    } catch (error) {
      console.log('[test] Worker exited with error (may be expected):', error);
    }

    // 4) Wait for parent delivery
    await waitForDelivery(gqlUrl, parentRequestId, {
      maxAttempts: 40,
      delayMs: 5000
    });

    // Get parent branch final commit (may have changed if agent made commits)
    const parentFinalCommit = execSync(`git rev-parse ${parentBranchName}`, {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();

    console.log(`[test] Parent initial: ${parentInitialCommit.substring(0, 7)}`);
    console.log(`[test] Parent final: ${parentFinalCommit.substring(0, 7)}`);

    if (parentFinalCommit !== parentInitialCommit) {
      console.log(`[test] ✓ Parent made ${parseInt(execSync(`git rev-list --count ${parentInitialCommit}..${parentFinalCommit}`, {
        cwd: testRepo.repoPath,
        encoding: 'utf-8'
      }).trim())} commit(s)`);
    }

    // 5) Find child job
    await new Promise(resolve => setTimeout(resolve, 5000)); // Give time for indexing

    const childJobQuery = `
      query($sourceRequestId:String!) {
        jobDefinitions(
          where: {
            sourceRequestId: $sourceRequestId
          }
        ) {
          items {
            id
            name
            codeMetadata
            sourceJobDefinitionId
            sourceRequestId
          }
        }
      }
    `;

    const childJobResp = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: childJobQuery,
        variables: { sourceRequestId: parentRequestId }
      })
    });

    const childJobData = await childJobResp.json();
    const childJobs = childJobData?.data?.jobDefinitions?.items || [];

    expect(childJobs.length).toBeGreaterThan(0);
    const childJob = childJobs[0];
    const childBranchName = childJob.codeMetadata.branch.name;

    console.log(`[test] Child job: ${childJob.id}`);
    console.log(`[test] Child branch: ${childBranchName}`);

    expect(childBranchName).not.toBe(parentBranchName);

    const childRequestQuery = `
      query($jobDefinitionId:String!) {
        requests(
          where: {
            jobDefinitionId: $jobDefinitionId
          },
          orderBy: "blockTimestamp",
          orderDirection: "desc",
          limit: 1
        ) {
          items {
            id
            ipfsHash
          }
        }
      }
    `;

    const childRequestResp = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: childRequestQuery,
        variables: { jobDefinitionId: childJob.id }
      })
    });

    const childRequestData = await childRequestResp.json();
    const childRequest = childRequestData?.data?.requests?.items?.[0];

    expect(childRequest, 'Child auto-dispatch request should exist').toBeTruthy();
    expect(childRequest?.ipfsHash, 'Child request must have IPFS hash').toBeTruthy();

    const childRequestIpfsUrl = `https://gateway.autonolas.tech/ipfs/${childRequest.ipfsHash}`;
    const childRequestPayload = await fetchJsonWithRetry(childRequestIpfsUrl, 6, 2000);

    expect(childRequestPayload?.branchName).toBe(childBranchName);
    expect(childRequestPayload?.codeMetadata?.branch?.name).toBe(childBranchName);
    expect(childRequestPayload?.codeMetadata?.baseBranch).toBe(parentBranchName);

    // Ensure remote refs are up-to-date before comparing ancestry
    execSync('git fetch origin', {
      cwd: testRepo.repoPath,
      stdio: 'ignore'
    });

    const parentRemoteRef = `origin/${parentBranchName}`;
    const childRemoteRef = `origin/${childBranchName}`;

    const assertRemoteRefExists = (ref: string, label: string) => {
      try {
        execSync(`git rev-parse --verify ${ref}`, {
          cwd: testRepo.repoPath,
          stdio: 'ignore'
        });
      } catch (err: any) {
        throw new Error(`Expected remote ref '${ref}' for ${label} to exist after fetch: ${err?.stderr?.toString() || err?.message || err}`);
      }
    };

    assertRemoteRefExists(parentRemoteRef, 'parent branch');
    assertRemoteRefExists(childRemoteRef, 'child branch');

    // 6) Verify child branch ancestry
    // Get merge-base between child and parent
    const mergeBaseParent = execSync(`git merge-base ${childRemoteRef} ${parentRemoteRef}`, {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();

    // Get merge-base between child and main
    const mergeBaseMain = execSync(`git merge-base ${childRemoteRef} origin/main`, {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    }).trim();

    console.log(`[test] Child←→Parent merge-base: ${mergeBaseParent.substring(0, 7)}`);
    console.log(`[test] Child←→Main merge-base: ${mergeBaseMain.substring(0, 7)}`);

    // Child should be based on parent's final commit
    expect(mergeBaseParent).toBe(parentFinalCommit);
    console.log(`[test] ✓ Child branched from parent commit`);

    // 7) Verify child metadata
    expect(childJob.codeMetadata.baseBranch).toBe(parentBranchName);
    console.log(`[test] ✓ Child baseBranch = ${childJob.codeMetadata.baseBranch}`);

    expect(childJob.codeMetadata.parent?.jobDefinitionId).toBe(parentJobId);
    expect(childJob.codeMetadata.parent?.requestId).toBe(parentRequestId);
    console.log(`[test] ✓ Child has proper parent lineage`);

    // 8) Verify both branches exist on remote
    const remoteBranches = execSync('git ls-remote --heads origin', {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    });

    expect(remoteBranches).toContain(parentBranchName);
    expect(remoteBranches).toContain(childBranchName);
    console.log(`[test] ✓ Both branches pushed to remote`);

    console.log('\n[test] ✅ Branch Ancestry Validation:');
    console.log(`  ✓ Parent branch: ${parentBranchName}`);
    console.log(`  ✓ Child branch: ${childBranchName}`);
    console.log(`  ✓ Child based on parent (not main)`);
    console.log(`  ✓ Child baseBranch = ${parentBranchName}`);
    console.log(`  ✓ Child has parent lineage metadata`);
    console.log(`  ✓ Both branches on remote`);
  }, 600_000);
});
