/**
 * Marketplace Code Metadata Test
 * Ensures dispatch embeds code metadata and execution policy in IPFS + subgraph
 */

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
  fetchJsonWithRetry,
} from '../helpers/shared.js';
import { getTestGitRepo } from '../helpers/test-git-repo.js';

describe('Marketplace: Code Metadata', () => {
  const suiteId = process.env.E2E_SUITE_ID ?? `manual-suite-${process.pid}`;
  if (!process.env.E2E_SUITE_ID) {
    process.env.E2E_SUITE_ID = suiteId;
  }

  let originalCwd: string;
  let testRepo: ReturnType<typeof getTestGitRepo>;

  beforeEach(() => {
    resetTestEnvironment();

    // Get test repo and switch to it
    testRepo = getTestGitRepo(suiteId);
    originalCwd = process.cwd();
    process.chdir(testRepo.repoPath);

    // Ensure CODE_METADATA_REPO_ROOT points to test repo
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
  });

  it('embeds code metadata and execution policy in dispatch payload', async () => {
    const { gqlUrl } = getSharedInfrastructure();

    console.log(`[test] Using test repo: ${testRepo.repoPath}`);
    console.log('[test] Creating test job with code metadata...');

    const { jobDefId, requestId } = await createTestJob({
      objective: 'Validate code metadata propagation',
      context: 'Spawn a job to verify branch metadata and execution policy',
      instructions: 'Acknowledge and finalize successfully.',
      acceptanceCriteria: 'IPFS payload contains code metadata and execution policy',
      enabledTools: [],
    });

    console.log(`[test] Job created: ${jobDefId}, Request: ${requestId}`);

    // Verify branch was created in test repo
    const branches = execSync('git branch --format="%(refname:short)"', {
      cwd: testRepo.repoPath,
      encoding: 'utf-8'
    });
    console.log(`[test] Branches in test repo:\n${branches}`);

    const request = await waitForRequestIndexed(gqlUrl, requestId);
    expect(request?.jobDefinitionId).toBe(jobDefId);

    const jobDefinition = await waitForJobIndexed(gqlUrl, jobDefId);
    expect(jobDefinition?.codeMetadata, 'Job definition should expose code metadata').toBeTruthy();

    const gatewayUrl = `https://gateway.autonolas.tech/ipfs/${request.ipfsHash}`;
    const ipfsJson = await fetchJsonWithRetry(gatewayUrl, 6, 2000);

    console.log(`[test] IPFS codeMetadata:`, JSON.stringify(ipfsJson.codeMetadata, null, 2));
    console.log(`[test] Expected branch prefix: job/${jobDefId}`);
    console.log(`[test] Actual branch name: ${ipfsJson.codeMetadata?.branch?.name}`);

    // Verify metadata structure
    expect(ipfsJson.codeMetadata?.jobDefinitionId).toBe(jobDefId);
    expect(typeof ipfsJson.codeMetadata?.branch?.name).toBe('string');
    expect(ipfsJson.codeMetadata.branch.name.startsWith(`job/${jobDefId}`)).toBe(true);
    expect(typeof ipfsJson.codeMetadata.branch.headCommit).toBe('string');
    expect(ipfsJson.codeMetadata.baseBranch || 'main').toBe(jobDefinition.codeMetadata?.baseBranch || 'main');

    // Verify execution policy
    expect(ipfsJson.executionPolicy).toBeTruthy();
    expect(ipfsJson.executionPolicy.branch).toBe(ipfsJson.codeMetadata.branch.name);
    expect(ipfsJson.executionPolicy.ensureTestsPass).toBe(true);

    // Verify Ponder indexed correctly - codeMetadata accessible through jobDefinition
    expect(jobDefinition.codeMetadata.branch?.name).toBe(ipfsJson.codeMetadata.branch.name);
    expect(jobDefinition.codeMetadata.jobDefinitionId).toBe(jobDefId);
  }, 240_000);
});
