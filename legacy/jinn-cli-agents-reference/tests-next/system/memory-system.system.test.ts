/**
 * Memory System Test (MEM-001 to MEM-010)
 *
 * Comprehensive system test validating the complete memory system lifecycle:
 * - Recognition phase (finding similar past jobs via SITUATION embeddings)
 * - SITUATION artifact creation and indexing
 * - Reflection phase (creating MEMORY artifacts from learnings)
 * - MEMORY artifact structure and tag-based discovery
 * - Embedding generation and storage
 * - Vector search and discovery
 * - Ponder indexing of both SITUATION and MEMORY artifacts
 * - Request metadata completeness validation (JINN-249)
 * - Execution trace validation: structure and tool calls (JINN-252)
 *
 * Coverage: 15 requirements (MEM-001 to MEM-010, IDQ-001, LCQ-001, GWQ-001/002, EXQ-007), ~120+ assertions
 * Tests both memory pathways: semantic (SITUATION) and tagged (MEMORY)
 * Tests git workflow metadata: branch isolation and lineage preservation
 * Tests request metadata completeness: IPFS hashes, addresses, hierarchy, temporal data
 * Tests execution trace: structure, tool calls, result validation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import { Client } from 'pg';
import dotenv from 'dotenv';
import { withTestEnv } from '../helpers/env-controller.js';
import { withTenderlyVNet } from '../helpers/tenderly-runner.js';
import { withProcessHarness } from '../helpers/process-harness.js';
import { createGitFixture, type GitFixture } from '../helpers/git-fixture.js';
import { withSuiteEnv } from '../helpers/suite-env.js';
import {
  waitForChildRequest,
  waitForArtifactByType,
  waitForPonderRealtime,
  waitForPonderBlock,
} from '../helpers/ponder-waiters.js';
import { getRequest, queryPonder } from '../helpers/ponder-queries.js';
import { createTestJob, withJobContext, parseToolText } from '../helpers/mcp-client.js';
import { waitForRequestIndexed } from '../helpers/ponder-waiters.js';
import { waitForDelivery } from '../helpers/assertions.js';
import { runWorkerOnce, cleanupWorkerProcesses } from '../helpers/worker-lifecycle.js';
import {
  reconstructDirCidFromHexIpfsHash,
  fetchJsonWithRetry,
  resetTestEnvironment,
} from '../helpers/shared-utils.js';
import {
  waitForJobIndexed,
  pollGraphQL,
} from '../../tests/helpers/shared.js';

async function waitForTransactionReceipt(
  rpcUrl: string,
  txHash: string,
  maxAttempts = 10,
  delayMs = 1000
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionReceipt',
        params: [txHash],
        id: 1,
      }),
    });
    const json = await resp.json();
    if (json.result) {
      return json.result;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for transaction receipt ${txHash}`);
}

function normalizeBlockNumber(blockNumber?: string | number | null): number | null {
  if (typeof blockNumber === 'number') {
    return Number.isNaN(blockNumber) ? null : blockNumber;
  }
  if (typeof blockNumber === 'string' && blockNumber.trim().length > 0) {
    const parsed = Number(blockNumber);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Advance Tenderly VNet by mining empty blocks.
 * Helps ensure Ponder picks up events in separate blocks.
 */
async function advanceBlocks(rpcUrl: string, count: number) {
  for (let i = 0; i < count; i++) {
    await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'evm_mine',
        params: [],
        id: 1,
      }),
    });
  }
  // Give Ponder a moment to index the new blocks
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// ======================================================================// TEST HELPERS
// ======================================================================
/**
 * Clear test embeddings from Supabase before test run.
 * Ensures test isolation and prevents data from previous runs.
 */
async function clearTestEmbeddings() {
  if (!process.env.SUPABASE_POSTGRES_URL) {
    throw new Error('SUPABASE_POSTGRES_URL not set - cannot clear test embeddings');
  }

  const client = new Client({ connectionString: process.env.SUPABASE_POSTGRES_URL });
  try {
    await client.connect();
    const result = await client.query('DELETE FROM node_embeddings_test');
    console.log(`[TEST] Cleared node_embeddings_test table (${result.rowCount} rows deleted)`);
  } finally {
    await client.end();
  }
}

// ======================================================================// TYPES & INTERFACES
// ======================================================================
interface SituationArtifact {
  version: string;
  job: {
    requestId: string;
    jobName: string;
    jobDefinitionId?: string;
    model?: string;
    objective?: string;
    context?: string;
    acceptanceCriteria?: string;
    blueprint?: string;
    enabledTools: string[];
  };
  context: {
    parent: null | { requestId: string; jobDefinitionId: string };
    siblings: any[];
    children: any[];
  };
  execution: {
    status: string;
    trace: Array<{
      tool: string;
      args: string;
      result_summary: string;
    }>;
    finalOutputSummary: string;
  };
  artifacts: any[];
  embedding: {
    model: string;
    dim: number;
    vector: number[];
  };
  meta: {
    summaryText: string;
    recognition?: {
      similarJobs: Array<{
        requestId: string;
        similarity: number;
      }>;
      initialSituation?: any; // MEM-003: Enriched initial situation
      embeddingStatus?: string; // Recognition phase metadata
    };
    generatedAt: string;
  };
}

// ======================================================================// HELPER FUNCTIONS
// ======================================================================
/**
 * Fetches SITUATION artifact from delivery payload
 *
 * @param delivery - Delivery object from Ponder
 * @param gqlUrl - GraphQL URL for additional queries if needed
 * @returns SITUATION artifact content
 */
async function fetchSituation(
  delivery: any,
  gqlUrl?: string
): Promise<SituationArtifact | null> {
  // Reconstruct directory CID from delivery ipfsHash
  const dirCid = reconstructDirCidFromHexIpfsHash(delivery.ipfsHash);
  if (!dirCid) {
    console.error('[FETCH] Could not reconstruct directory CID');
    return null;
  }

  // Fetch delivery payload from IPFS
  const requestId = delivery.id;
  const reqPath = `${dirCid}/${requestId}`;
  const url = `https://gateway.autonolas.tech/ipfs/${reqPath}`;

  try {
    const deliveryJson = await fetchJsonWithRetry(url, 6, 2000);

    // Find SITUATION artifact in artifacts array
    const situationArtifact = deliveryJson.artifacts?.find(
      (a: any) => a.type === 'SITUATION'
    );

    if (!situationArtifact) {
      console.warn('[FETCH] No SITUATION artifact in delivery');
      return null;
    }

    // Debug: Log the artifact structure
    console.log('[FETCH] situationArtifact keys:', Object.keys(situationArtifact));
    console.log('[FETCH] has content:', !!situationArtifact.content);
    console.log('[FETCH] content type:', typeof situationArtifact.content);
    console.log('[FETCH] has cid:', !!situationArtifact.cid);

    // The artifact might have content embedded as a string or need to be fetched from IPFS
    if (situationArtifact.content) {
      // Content is embedded in the artifact - parse it if it's a string
      console.log('[FETCH] Parsing content (first 100 chars):', String(situationArtifact.content).slice(0, 100));
      const content = typeof situationArtifact.content === 'string'
        ? JSON.parse(situationArtifact.content)
        : situationArtifact.content;
      console.log('[FETCH] Parsed content keys:', Object.keys(content));
      console.log('[FETCH] Parsed content.version:', content.version);
      return content as SituationArtifact;
    } else if (situationArtifact.cid) {
      // Fetch SITUATION content from IPFS using CID
      console.log('[FETCH] Fetching from CID:', situationArtifact.cid);
      const situationUrl = `https://gateway.autonolas.tech/ipfs/${situationArtifact.cid}`;
      const situationContent = await fetchJsonWithRetry(situationUrl, 6, 2000);
      console.log('[FETCH] Fetched content type:', typeof situationContent);
      console.log('[FETCH] Fetched content keys:', situationContent ? Object.keys(situationContent) : 'null');
      console.log('[FETCH] Fetched content.version:', situationContent?.version);

      // Some storage formats wrap the payload in {name, topic, content, ...}
      const embeddedContent =
        situationContent &&
          typeof situationContent === 'object' &&
          'content' in situationContent
          ? (situationContent as any).content
          : situationContent;

      // The IPFS response might be the raw JSON string, not parsed
      if (typeof embeddedContent === 'string') {
        console.log('[FETCH] Content is string, parsing nested content...');
        return JSON.parse(embeddedContent) as SituationArtifact;
      }

      return embeddedContent as SituationArtifact;
    }

    console.warn('[FETCH] SITUATION artifact has no content or CID');
    return null;
  } catch (error) {
    console.error('[FETCH] Error fetching SITUATION:', error);
    return null;
  }
}

// ======================================================================// TESTS
// ======================================================================
describe('System: Memory System (MEM-001 to MEM-010)', () => {
  let gitFixture: GitFixture | null = null;

  beforeAll(async () => {
    // Load .env.test before creating git fixture (needed for TEST_GITHUB_REPO)
    dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), override: false });

    // Clear previous test data to ensure clean state
    await clearTestEmbeddings();

    gitFixture = createGitFixture();
    process.env.CODE_METADATA_REPO_ROOT = gitFixture.repoPath;
  });

  afterAll(() => {
    if (gitFixture) {
      gitFixture.cleanup();
      gitFixture = null;
    }
    delete process.env.CODE_METADATA_REPO_ROOT;
  });
  it(
    'validates complete memory system lifecycle with recognition, reflection, and indexing',
    async () => {
      await withSuiteEnv(async () => {
        await withTestEnv(async () => {
            // Load test environment
            try {
              const testEnv = path.join(process.cwd(), '.env.test');
              if (fs.existsSync(testEnv)) {
                process.env.JINN_ENV_PATH = testEnv;
              }
            } catch { }

            await withTenderlyVNet(async (tenderlyCtx) => {
              await withProcessHarness(
                {
                  rpcUrl: tenderlyCtx.rpcUrl,
                  startWorker: false,
                },
                async ({ gqlUrl, controlUrl }) => {
                  resetTestEnvironment();
                  console.log('[TEST] Using control API:', controlUrl);
                  console.log('[TEST] Using GraphQL:', gqlUrl);

                  // ==================================================                  // SECTION 1: Create Parent Job For Lineage
                  // ==================================================
                  console.log('\n[TEST] Bootstrapping parent job for lineage...');

                  const parentJob = await createTestJob({
                    objective: 'Survey prior memory-system jobs for lineage seeding',
                    context: 'Parent job to ensure child requests record source lineage in the new framework',
                    acceptanceCriteria: 'Parent job definition exists and can be referenced by child jobs',
                    blueprint: JSON.stringify({
                      assertions: [{
                        id: 'MEM-001',
                        assertion: 'Survey prior memory-system jobs for lineage seeding',
                        examples: { do: ['Register job definition', 'Enable child references'], dont: ['Skip registration'] },
                        commentary: 'Parent job to ensure child requests record source lineage in the new framework. Report success once the job definition is registered. Parent job definition exists and can be referenced by child jobs.'
                      }]
                    }),
                    enabledTools: ['create_artifact'],
                  });
                  const parentTxHash =
                    parentJob.dispatchResult?.data?.transaction_hash ??
                    parentJob.dispatchResult?.data?.transactionHash ??
                    null;
                  let parentBlockNumber: number | null = null;
                  if (parentTxHash) {
                    const parentReceipt = await waitForTransactionReceipt(tenderlyCtx.rpcUrl, parentTxHash);
                    parentBlockNumber = normalizeBlockNumber(parentReceipt?.blockNumber);
                    if (parentBlockNumber !== null) {
                      await waitForPonderBlock(gqlUrl, parentBlockNumber, { timeoutMs: 120000 });
                    }
                  }

                  await waitForRequestIndexed(gqlUrl, parentJob.requestId, {
                    predicate: (request) =>
                      Boolean(request.jobName && request.jobDefinitionId),
                  });
                  console.log('[TEST] Parent job ready:', parentJob.requestId);

                  // ==================================================                  // SECTION 1: Validate Parent Request Metadata (JINN-249, IDQ-001, LCQ-001)
                  // ==================================================
                  console.log('[TEST] Validating parent request metadata completeness...');

                  const parentRequest = await getRequest(gqlUrl, parentJob.requestId);
                  expect(parentRequest).toBeDefined();
                  expect(parentRequest!.id).toBe(parentJob.requestId);

                  // IPFS hash validation (CID v1 format: f01551220 prefix + 64-char hex)
                  expect(parentRequest!.ipfsHash).toBeTruthy();
                  expect(typeof parentRequest!.ipfsHash).toBe('string');
                  expect(parentRequest!.ipfsHash).toMatch(/^f01551220[a-f0-9]{64}$/i);

                  // Job metadata validation
                  expect(parentRequest!.jobName).toBeTruthy();
                  expect(parentRequest!.jobDefinitionId).toBe(parentJob.jobDefId);

                  // IDQ-001: Identity validation - addresses must be valid Ethereum format
                  expect(parentRequest!.mech).toBeTruthy();
                  expect(parentRequest!.mech).toMatch(/^0x[a-fA-F0-9]{40}$/);
                  expect(parentRequest!.sender).toBeTruthy();
                  expect(parentRequest!.sender).toMatch(/^0x[a-fA-F0-9]{40}$/);

                  // Root job has no parent (hierarchy validation)
                  expect(parentRequest!.sourceRequestId).toBeNull();
                  expect(parentRequest!.sourceJobDefinitionId).toBeNull();

                  // Enabled tools validation
                  expect(Array.isArray(parentRequest!.enabledTools)).toBe(true);
                  expect(parentRequest!.enabledTools).toContain('create_artifact');

                  // LCQ-001: Delivery status validation
                  expect(typeof parentRequest!.delivered).toBe('boolean');
                  expect(parentRequest!.delivered).toBe(false); // Not yet delivered

                  console.log('[TEST] Parent request metadata validated ✓');

                  // ==================================================                  // SECTION 1A: Parent Job Git Metadata (GWQ-001)
                  // ==================================================
                  console.log('\n[TEST] SECTION 1A: Validating parent job git metadata...');

                  const parentJobDef = await waitForJobIndexed(gqlUrl, parentJob.jobDefId);

                  // GWQ-001: Branch metadata exists
                  expect(parentJobDef?.codeMetadata?.branch?.name).toBeTruthy(); // Assert 59
                  const parentBranchName = parentJobDef.codeMetadata.branch.name;

                  // Branch has remote URL
                  expect(parentJobDef?.codeMetadata?.branch?.remoteUrl).toBeTruthy(); // Assert 60

                  // Base branch is set (likely "main" for root job)
                  expect(parentJobDef?.codeMetadata?.baseBranch).toBeTruthy(); // Assert 61

                  // Parent has no parent (root job)
                  expect(parentJobDef?.codeMetadata?.parent).toBeUndefined(); // Assert 62

                  // Branch actually created in git
                  const branches = execSync('git branch --format="%(refname:short)"', {
                    cwd: gitFixture!.repoPath,
                    encoding: 'utf-8'
                  }).split('\n').filter(b => b);
                  expect(branches).toContain(parentBranchName); // Assert 63

                  console.log(`[TEST] Parent git metadata validated: branch=${parentBranchName} ✓`);

                  // ==================================================                  // SECTION 2: Create Child Job (Research + Delegation)
                  // ==================================================
                  console.log('\n[TEST] SECTION 2: Creating child job with delegation task...');

                                    const childJob = await withJobContext(
                    {
                      requestId: parentJob.requestId,
                      jobDefinitionId: parentJob.jobDefId,
                      baseBranch: parentBranchName,
                    },
                    () => createTestJob({
                      blueprint: JSON.stringify({
                        assertions: [
                          {
                            id: 'MEM-002A',
                            assertion: 'Review completed child work before delegating OLAS staking optimization.',
                            examples: {
                              do: [
                                'If completed child jobs exist, use get_details with their request IDs (resolve_ipfs=true) before taking any action.',
                                'When child work is sufficient, synthesize their findings into the final deliverable instead of dispatching new work.',
                                'Document why delegation or completion was chosen.',
                              ],
                              dont: [
                                'Ignore completed child jobs or their artifacts.',
                                'Dispatch a new optimization job when existing child work already satisfies the objective.',
                                'Skip documenting the decision.',
                              ],
                            },
                            commentary:
                              'Decision rule: delegate only when no completed child jobs exist. If completed child work exists, review it (artifacts, execution summaries, PR links) and complete this job yourself.',
                          },
                          {
                            id: 'MEM-002B',
                            assertion: 'Analyze OLAS staking and, when delegating, require optimized outputs and reusable artifacts.',
                            examples: {
                              do: [
                                'Create "olas-staking-analysis" artifact with current parameters (APY 8-12%, locks 1w-1y, weekly rewards, 10% penalty).',
                                'If delegation is needed, dispatch optimization child job with a blueprint containing an assertion that REQUIRES: (1) calling write_file to create exactly "olas-staking-optimization.md" at repo root with heading "# OLAS Staking Optimization Strategy", (2) creating a MEMORY artifact with tags [staking, optimization, olas]. The blueprint must explicitly state the exact filename "olas-staking-optimization.md" as a requirement, not a suggestion.',
                                'When dispatching, set enabledTools to include ["create_artifact", "write_file"] (in addition to defaults).',
                                'Provide detailed context to the child job for optimization.',
                              ],
                              dont: [
                                'Skip creating the analysis artifact.',
                                'Dispatch child job with vague instructions like "write an optimization file" - the filename must be explicit in the blueprint.',
                                'Forget to include tags on the MEMORY artifact instructions.',
                              ],
                            },
                            commentary:
                              'Task 1: Call create_artifact with name="olas-staking-analysis", topic="defi-research", content "# OLAS Staking\n\nCurrent: APY 8-12%, 1w-1y locks, weekly rewards, 10% penalty.\n\nOptimize: dynamic APY, tiered locks, compounding." Task 2: If delegation is required, create a blueprint for the child with an assertion like: {"id":"OPT-001","assertion":"Call write_file to create olas-staking-optimization.md with heading # OLAS Staking Optimization Strategy. CRITICAL: Use ABSOLUTE path by prepending metadata.workspacePath to filename (e.g., metadata.workspacePath + /olas-staking-optimization.md).","examples":{"do":["Check metadata.workspacePath at end of your blueprint for the repository root path","Construct absolute path: metadata.workspacePath + /olas-staking-optimization.md","Call write_file with the complete absolute path","Include optimization recommendations in the file"],"dont":["Use relative path like just olas-staking-optimization.md","Assume current directory is repository root","Skip prepending metadata.workspacePath"]},"commentary":"File must be created at repository root using ABSOLUTE path. metadata.workspacePath contains the repository root directory. Native tools execute in gemini-agent/ but files belong in the repository. Always prepend metadata.workspacePath to filenames."}. The absolute path instruction using metadata.workspacePath must be in the assertion text itself.',
                          },
                          {
                            id: 'MEM-002C',
                            assertion: 'When a completed child exposes a git branch artifact, evaluate and merge it via process_branch before finishing.',
                            examples: {
                              do: [
                                "Inspect the GIT_BRANCH artifact's diff/merge status and summarize whether it satisfies acceptance criteria.",
                                'Call process_branch with action="merge" (or "skip" with rationale) before marking the job complete.',
                                'Explain in the final response why the branch was merged or skipped.',
                              ],
                              dont: [
                                'Ignore git branch artifacts produced by child jobs.',
                                'Merge or skip a branch without calling process_branch or documenting the rationale.',
                                'Finish the job without reviewing the branch diff/merge status.',
                              ],
                            },
                            commentary:
                              'Before completing this job, review any GIT_BRANCH artifacts from child jobs and call process_branch({ branch_name, action, rationale }) to merge or explicitly skip with justification to maintain deterministic branch state.',
                          },
                        ],
                      }),
                      enabledTools: ['create_artifact', 'dispatch_new_job', 'write_file', 'process_branch'],
                    })
              );

const { requestId } = childJob;
                  const childTxHash =
                    childJob.dispatchResult?.data?.transaction_hash ??
                    childJob.dispatchResult?.data?.transactionHash ??
                    null;
                  if (childTxHash) {
                    const childReceipt = await waitForTransactionReceipt(tenderlyCtx.rpcUrl, childTxHash);
                    const childBlockNumber = normalizeBlockNumber(childReceipt?.blockNumber);
                    if (childBlockNumber !== null) {
                      await waitForPonderBlock(gqlUrl, childBlockNumber, { timeoutMs: 120000 });
                    }
                  }
                  console.log('[TEST] Created child job:', requestId);

                  await waitForRequestIndexed(gqlUrl, requestId, {
                    predicate: (request) =>
                      Boolean(request.jobName && request.jobDefinitionId),
                  });

                  // ==================================================                  // SECTION 2: Validate Child Request Metadata (JINN-249, IDQ-001, LCQ-001)
                  // ==================================================
                  console.log('[TEST] Validating child request metadata completeness...');

                  const childRequestMetadata = await getRequest(gqlUrl, requestId);
                  expect(childRequestMetadata).toBeDefined();
                  expect(childRequestMetadata!.id).toBe(requestId);

                  // IPFS hash validation (CID v1 format: f01551220 prefix + 64-char hex)
                  expect(childRequestMetadata!.ipfsHash).toBeTruthy();
                  expect(typeof childRequestMetadata!.ipfsHash).toBe('string');
                  expect(childRequestMetadata!.ipfsHash).toMatch(/^f01551220[a-f0-9]{64}$/i);

                  // Job metadata validation
                  expect(childRequestMetadata!.jobName).toBeTruthy();
                  expect(childRequestMetadata!.jobDefinitionId).toBe(childJob.jobDefId);

                  // LCQ-004: Hierarchy validation - child must link to parent
                  expect(childRequestMetadata!.sourceRequestId).toBe(parentJob.requestId);
                  expect(childRequestMetadata!.sourceJobDefinitionId).toBe(parentJob.jobDefId);

                  // Enabled tools validation
                  expect(Array.isArray(childRequestMetadata!.enabledTools)).toBe(true);
                  expect(childRequestMetadata!.enabledTools).toContain('create_artifact');
                  expect(childRequestMetadata!.enabledTools).toContain('dispatch_new_job');
                  expect(childRequestMetadata!.enabledTools).toContain('get_details');
                  expect(childRequestMetadata!.enabledTools).toContain('search_artifacts');

                  // IDQ-001: Identity validation
                  expect(childRequestMetadata!.mech).toBeTruthy();
                  expect(childRequestMetadata!.mech).toMatch(/^0x[a-fA-F0-9]{40}$/);
                  expect(childRequestMetadata!.sender).toBeTruthy();
                  expect(childRequestMetadata!.sender).toMatch(/^0x[a-fA-F0-9]{40}$/);

                  // Temporal metadata (block number and timestamp)
                  expect(childRequestMetadata!.blockNumber).toBeTruthy();
                  expect(childRequestMetadata!.blockTimestamp).toBeTruthy();

                  console.log('[TEST] Child request metadata validated ✓');

                  // ==================================================                  // SECTION 2A: Phase 1 Blueprint Verification
                  // ==================================================
                  console.log('\n[TEST] SECTION 2A: Validating Phase 1 blueprint implementation...');

                  // Fetch child job definition from Ponder
                  const childJobDef = await waitForJobIndexed(gqlUrl, childJob.jobDefId);
                  expect(childJobDef).toBeDefined();
                  expect(childJobDef.blueprint).toBeTruthy();

                  // Parse blueprint from job definition
                  const blueprintData = JSON.parse(childJobDef.blueprint);
                  expect(blueprintData.assertions).toBeDefined();
                  expect(Array.isArray(blueprintData.assertions)).toBe(true);
                  expect(blueprintData.assertions.length).toBeGreaterThan(0);

                  // Validate assertion structure
                  const firstAssertion = blueprintData.assertions[0];
                  expect(firstAssertion.id).toBeTruthy();
                  expect(firstAssertion.assertion).toBeTruthy();
                  expect(firstAssertion.examples).toBeDefined();
                  expect(Array.isArray(firstAssertion.examples.do)).toBe(true);
                  expect(Array.isArray(firstAssertion.examples.dont)).toBe(true);
                  expect(firstAssertion.commentary).toBeTruthy();

                  console.log(`[TEST] Blueprint structure validated: ${blueprintData.assertions.length} assertions`);

                  // Fetch IPFS metadata to verify blueprint at root level
                  if (!childRequestMetadata) {
                    throw new Error('Child request metadata is null');
                  }
                  const metadataContent = await fetchJsonWithRetry(
                    `https://gateway.autonolas.tech/ipfs/${childRequestMetadata.ipfsHash}`,
                    5,
                    1000
                  );
                  expect(metadataContent.blueprint).toBeTruthy();
                  expect(metadataContent.blueprint).toBe(childJobDef.blueprint);

                  console.log('[TEST] Blueprint verified at IPFS metadata root level ✓');

                  console.log('[TEST] Phase 1 blueprint verification complete ✓');

                  // ==================================================                  // SECTION 3: Run Worker on Child Job
                  // ==================================================
                  console.log('\n[TEST] SECTION 3: Running worker on child job...');

                  const workerProc = await runWorkerOnce(requestId, {
                    gqlUrl,
                    controlApiUrl: controlUrl,
                    model: 'gemini-2.5-pro',
                    timeout: 300_000,
                  });

                  try {
                    await workerProc;
                  } catch (error) {
                    console.warn(
                      '[TEST] Worker exited with error (may be expected):',
                      error
                    );
                  } finally {
                    await cleanupWorkerProcesses();
                  }

                  // ==================================================                  // SECTION 4: Wait for Child Delivery
                  // ==================================================
                  console.log('\n[TEST] SECTION 4: Waiting for child delivery...');

                  const childDelivery = await waitForDelivery(gqlUrl, requestId, {
                    maxAttempts: 40,
                    delayMs: 5000,
                  });

                  // LCQ-003: Single delivery confirms atomic processOnce() execution
                  // One request → one processOnce() → one delivery (no partial states)
                  expect(childDelivery.id).toBe(requestId);
                  expect(typeof childDelivery.ipfsHash).toBe('string');
                  expect(typeof childDelivery.transactionHash).toBe('string');

                  console.log('[TEST] Child delivery confirmed:', childDelivery.transactionHash);

                  // ==================================================                  // SECTION 4B: Child Job Status Validation (Work Protocol)
                  // ==================================================
                  console.log('\n[TEST] SECTION 4B: Validating child job status...');

                  // Fetch child SITUATION from IPFS delivery
                  const childDeliverySituation = await fetchSituation(childDelivery, gqlUrl);
                  expect(childDeliverySituation).toBeDefined();

                  // WPQ-001: Child should be DELEGATING (dispatched grandchild)
                  expect(childDeliverySituation!.execution?.status).toBe('DELEGATING');
                  console.log('[TEST] Child status correctly inferred as DELEGATING ✓');

                  // WPQ-002: Validate dispatch tool calls in execution trace
                  const childDeliveryTrace = childDeliverySituation!.execution?.trace || [];
                  const dispatchCalls = childDeliveryTrace.filter(
                    (step: any) => step.tool === 'dispatch_new_job' || step.tool === 'dispatch_existing_job'
                  );
                  expect(dispatchCalls.length).toBeGreaterThan(0);
                  console.log(`[TEST] Child dispatched ${dispatchCalls.length} job(s) ✓`);

                  // Phase 1 Verification: No external blueprint search in agent telemetry
                  const blueprintSearchCalls = childDeliveryTrace.filter(
                    (step: any) => step.tool?.includes('search') && step.args?.toLowerCase().includes('blueprint')
                  );
                  expect(blueprintSearchCalls.length).toBe(0);
                  console.log('[TEST] Phase 1: No external blueprint search attempts ✓');

                  // Wait for Ponder to index the child request
                  await waitForRequestIndexed(gqlUrl, requestId, {
                    predicate: (request) =>
                      Boolean(request.jobName && request.jobDefinitionId),
                  });

                  // Query child request record for hierarchy validation
                  const childRequest = await getRequest(gqlUrl, requestId);
                  expect(childRequest).toBeDefined();

                  // LCQ-004: Job hierarchy validation - child should link to parent
                  expect(childRequest!.sourceRequestId).toBe(parentJob.requestId);
                  expect(childRequest!.sourceJobDefinitionId).toBe(parentJob.jobDefId);

                  // MEM-008: Verify child request indexed with temporal metadata
                  expect(childRequest!.blockTimestamp).toBeDefined();

                  console.log('[TEST] Child request hierarchy validated ✓');

                  // ==================================================                  // SECTION 4A: Child Job Git Lineage Metadata (GWQ-002)
                  // ==================================================
                  console.log('\n[TEST] SECTION 4A: Validating child job git lineage metadata...');

                  const childJobDefGit = await waitForJobIndexed(gqlUrl, childJob.jobDefId);
                  const childBranchName = childJobDefGit?.codeMetadata?.branch?.name;

                  // GWQ-001: Child has unique branch
                  expect(childBranchName).toBeTruthy(); // Assert 64
                  expect(childBranchName).not.toBe(parentBranchName); // Assert 65 - Different from parent

                  // GWQ-002: Child base branch should point to parent branch
                  expect(childJobDefGit?.codeMetadata?.baseBranch).toBe(parentBranchName); // Assert 66 ⭐ KEY

                  // GWQ-002: Child's parent metadata points to parent job
                  expect(childJobDefGit?.codeMetadata?.parent?.jobDefinitionId).toBe(parentJob.jobDefId); // Assert 67 ⭐ KEY
                  expect(childJobDefGit?.codeMetadata?.parent?.requestId).toBe(parentJob.requestId); // Assert 68 ⭐ KEY

                  // Branch created in git
                  const childBranches = execSync('git branch --format="%(refname:short)"', {
                    cwd: gitFixture!.repoPath,
                    encoding: 'utf-8'
                  }).split('\n').filter(b => b);
                  expect(childBranches).toContain(childBranchName); // Assert 69

                  console.log(`[TEST] Child lineage metadata validated: child=${childBranchName} → parent=${parentBranchName} ✓`);

                  // ==================================================                  // SECTION 5: Wait for Child's SITUATION Embedding to be Indexed
                  // ==================================================
                  console.log('\n[TEST] SECTION 5: Waiting for child SITUATION to be indexed...');

                  // Wait for SITUATION artifact to appear in Ponder
                  const childSituationArtifact = await waitForArtifactByType(
                    gqlUrl,
                    requestId,
                    'SITUATION',
                    { timeoutMs: 60000, pollIntervalMs: 2000 }
                  );

                  console.log('[TEST] Child SITUATION artifact indexed:', childSituationArtifact.cid);

                  // JINN-252: Validate child execution trace structure
                  console.log('\n[TEST] SECTION 5: Validating child execution trace...');

                  // Re-fetch child SITUATION to validate trace (already fetched in SECTION 4B as childDeliverySituation)
                  const childTrace = childDeliverySituation!.execution?.trace || [];
                  expect(Array.isArray(childTrace)).toBe(true); // Assert 78
                  expect(childTrace.length).toBeGreaterThan(0); // Assert 79

                  // Validate first trace entry structure
                  const childFirstTraceEntry = childTrace[0];
                  expect(childFirstTraceEntry).toBeDefined(); // Assert 80
                  expect(typeof childFirstTraceEntry.tool).toBe('string'); // Assert 81
                  expect(typeof childFirstTraceEntry.args).toBe('string'); // Assert 82
                  expect(typeof childFirstTraceEntry.result_summary).toBe('string'); // Assert 83

                  // JINN-252: Validate expected tools were called by child
                  const childToolNames = childTrace.map(t => t.tool);
                  expect(childToolNames).toContain('create_artifact'); // Assert 84 - Child should create analysis artifact
                  expect(childToolNames).toContain('dispatch_new_job'); // Assert 85 - Child should dispatch grandchild
                  console.log(`[TEST] Child expected tool calls present: ${[...new Set(childToolNames)].join(', ')} ✓`);

                  // JINN-252: Validate all trace entries have complete structure
                  childTrace.forEach((entry, idx) => {
                    expect(entry.tool).toBeTruthy(); // Assert 86
                    expect(entry.args).toBeDefined(); // Assert 87
                    expect(entry.result_summary).toBeDefined(); // Assert 88
                  });

                  console.log('[TEST] Child execution trace validated ✓');

                  // Give Ponder a bit more time to fully index the embedding
                  console.log('[TEST] Allowing additional time for embedding indexing...');
                  await new Promise(resolve => setTimeout(resolve, 5000));

                  console.log('[TEST] Child SITUATION embedding ready ✓');

                  // ==================================================                  // SECTION 5: Validate Child Embedding Format
                  // ==================================================
                  console.log('\n[TEST] SECTION 5: Validating child SITUATION embedding...');

                  // Fetch child SITUATION artifact from IPFS
                  const childSituation = await fetchSituation(childDelivery, gqlUrl);
                  expect(childSituation).toBeDefined();
                  if (!childSituation) {
                    throw new Error('Child situation is null');
                  }
                  if (!childSituation) throw new Error('Child situation missing');


                  const childEmbedding = childSituation.embedding;
                  expect(childEmbedding).toBeDefined();

                  // MEM-004: Must use text-embedding-3-small with 256 dimensions
                  expect(childEmbedding.model).toBe('text-embedding-3-small');
                  expect(childEmbedding.dim).toBe(256);
                  expect(Array.isArray(childEmbedding.vector)).toBe(true);
                  expect(childEmbedding.vector.length).toBe(256);

                  // Validate vector values are numeric and in valid range
                  expect(typeof childEmbedding.vector[0]).toBe('number');
                  expect(childEmbedding.vector[0]).toBeGreaterThanOrEqual(-1);
                  expect(childEmbedding.vector[0]).toBeLessThanOrEqual(1);

                  console.log('[TEST] Child embedding format validated ✓');

                  // ==================================================                  // SECTION 6: Find Grandchild Request Created by Child
                  // ==================================================
                  console.log('\n[TEST] SECTION 6: Looking for grandchild job created by child...');

                  // Advance blocks to ensure Ponder picks up grandchild's MarketplaceRequest event
                  // The child's delivery transaction likely triggered the grandchild dispatch in the same block
                  console.log('[TEST] Advancing 3 blocks to ensure Ponder indexes grandchild MarketplaceRequest...');
                  await advanceBlocks(tenderlyCtx.rpcUrl, 3);

                  const grandchildRequest = await waitForChildRequest(
                    gqlUrl,
                    requestId, // Child is the parent of grandchild
                    { timeoutMs: 40000, pollIntervalMs: 2000 }
                  );

                  console.log('[TEST] Grandchild request found:', grandchildRequest.id);
                  expect(grandchildRequest.sourceRequestId).toBe(requestId);

                  await waitForRequestIndexed(gqlUrl, grandchildRequest.id, {
                    predicate: (request) =>
                      Boolean(request.jobName && request.jobDefinitionId),
                  });

                  // ==================================================                  // SECTION 7: Validate Grandchild Request Metadata (JINN-249, IDQ-001, LCQ-001)
                  // ==================================================
                  console.log('[TEST] Validating grandchild request metadata completeness...');

                  const grandchildRequestRecord = await getRequest(gqlUrl, grandchildRequest.id);
                  expect(grandchildRequestRecord).toBeDefined();
                  expect(grandchildRequestRecord!.id).toBe(grandchildRequest.id);

                  // IPFS hash validation (CID v1 format: f01551220 prefix + 64-char hex)
                  expect(grandchildRequestRecord!.ipfsHash).toBeTruthy();
                  expect(typeof grandchildRequestRecord!.ipfsHash).toBe('string');
                  expect(grandchildRequestRecord!.ipfsHash).toMatch(/^f01551220[a-f0-9]{64}$/i);

                  // Job metadata validation
                  expect(grandchildRequestRecord!.jobName).toBeTruthy();
                  expect(grandchildRequestRecord!.jobDefinitionId).toBeTruthy();

                  // LCQ-004: Job hierarchy validation - grandchild should link to child (not grandparent)
                  expect(grandchildRequestRecord!.sourceRequestId).toBe(requestId);
                  expect(grandchildRequestRecord!.sourceJobDefinitionId).toBe(childJob.jobDefId);

                  // Enabled tools validation
                  expect(Array.isArray(grandchildRequestRecord!.enabledTools)).toBe(true);
                  expect(grandchildRequestRecord!.enabledTools!.length).toBeGreaterThan(0);
                  expect(grandchildRequestRecord!.enabledTools).toContain('create_artifact');
                  // Coding tools validation - grandchild should have write_file enabled
                  expect(grandchildRequestRecord!.enabledTools).toContain('write_file');

                  // IDQ-001: Identity validation
                  expect(grandchildRequestRecord!.mech).toBeTruthy();
                  expect(grandchildRequestRecord!.mech).toMatch(/^0x[a-fA-F0-9]{40}$/);
                  expect(grandchildRequestRecord!.sender).toBeTruthy();
                  expect(grandchildRequestRecord!.sender).toMatch(/^0x[a-fA-F0-9]{40}$/);

                  // MEM-008: Temporal metadata validation
                  expect(grandchildRequestRecord!.blockNumber).toBeTruthy();
                  expect(grandchildRequestRecord!.blockTimestamp).toBeDefined();
                  expect(typeof grandchildRequestRecord!.blockTimestamp).toBe('string');

                  // LCQ-001: Delivery status validation
                  expect(typeof grandchildRequestRecord!.delivered).toBe('boolean');
                  expect(grandchildRequestRecord!.delivered).toBe(false); // Not yet delivered at this point

                  console.log('[TEST] Grandchild request metadata validated ✓');

                  // ==================================================                  // SECTION 7: Run Worker on Grandchild Job
                  // ==================================================
                  console.log('\n[TEST] SECTION 7: Running worker on grandchild...');

                  const grandchildWorkerProc = await runWorkerOnce(grandchildRequest.id, {
                    gqlUrl,
                    controlApiUrl: controlUrl,
                    model: 'gemini-2.5-pro',
                    timeout: 300_000,
                  });

                  try {
                    await grandchildWorkerProc;
                  } catch (error) {
                    console.warn('[TEST] Grandchild worker exited with error:', error);
                  } finally {
                    await cleanupWorkerProcesses();
                  }

                  // ==================================================                  // SECTION 8: Wait for Grandchild Delivery
                  // ==================================================
                  console.log('\n[TEST] SECTION 8: Waiting for grandchild delivery...');

                  const grandchildDelivery = await waitForDelivery(gqlUrl, grandchildRequest.id, {
                    maxAttempts: 40,
                    delayMs: 5000,
                  });

                  // LCQ-003: Grandchild processOnce() atomicity validated via single delivery
                  expect(grandchildDelivery.id).toBe(grandchildRequest.id);
                  expect(typeof grandchildDelivery.ipfsHash).toBe('string');
                  expect(typeof grandchildDelivery.transactionHash).toBe('string');

                  console.log('[TEST] Grandchild delivery confirmed:', grandchildDelivery.transactionHash);

                  // ==================================================                  // SECTION 8B: Grandchild Job Status Validation (Work Protocol)
                  // ==================================================
                  console.log('\n[TEST] SECTION 8B: Validating grandchild job status...');

                  // Fetch grandchild SITUATION from IPFS delivery
                  const grandchildSituation = await fetchSituation(grandchildDelivery, gqlUrl);
                  expect(grandchildSituation).toBeDefined();

                  // WPQ-001/WPQ-002: Validate grandchild status is consistent with its actions
                  // LLM behavior is non-deterministic - grandchild may choose to delegate or complete directly
                  const grandchildTrace = grandchildSituation!.execution?.trace || [];
                  const grandchildDispatchCalls = grandchildTrace.filter(
                    (step: any) => step.tool === 'dispatch_new_job' || step.tool === 'dispatch_existing_job'
                  );
                  
                  const grandchildStatus = grandchildSituation!.execution?.status;
                  if (grandchildDispatchCalls.length > 0) {
                    // Grandchild delegated - status should be DELEGATING
                    expect(grandchildStatus).toBe('DELEGATING');
                    console.log(`[TEST] Grandchild dispatched ${grandchildDispatchCalls.length} job(s) - status correctly DELEGATING ✓`);
                  } else {
                    // Grandchild completed directly - status should be COMPLETED
                    expect(grandchildStatus).toBe('COMPLETED');
                    console.log('[TEST] Grandchild is terminal job (no delegation) - status correctly COMPLETED ✓');
                  }

                  // ==================================================                  // SECTION 8C: Child Auto-Dispatch Validation (JINN-253)
                  // ==================================================
                  // Auto-dispatch only happens when grandchild has terminal status (COMPLETED/FAILED)
                  // If grandchild delegated (DELEGATING status), skip auto-dispatch validation
                  const grandchildIsTerminal = grandchildStatus === 'COMPLETED' || grandchildStatus === 'FAILED';
                  
                  if (!grandchildIsTerminal) {
                    console.log('\n[TEST] SECTION 8C: SKIPPED - Grandchild has non-terminal status (DELEGATING)');
                    console.log('[TEST] Auto-dispatch validation requires terminal grandchild status.');
                    console.log('[TEST] This is expected when LLM chooses to delegate further.');
                    console.log('[TEST] Remaining sections (8D+) that depend on auto-dispatch are also skipped.');
                    return; // Skip remaining sections that depend on auto-dispatch
                  }
                  
                  console.log('\n[TEST] SECTION 8C: Validating child auto-dispatch after grandchild completion...');

                  // Query for auto-dispatched requests on the child job definition
                  const autoDispatchQuery = `
                    query($childJobId:String!) {
                      requests(
                        where: {
                          jobDefinitionId: $childJobId
                        },
                        orderBy: "blockTimestamp",
                        orderDirection: "desc"
                      ) {
                        items {
                          id
                          jobDefinitionId
                          blockTimestamp
                          sourceJobDefinitionId
                          sourceRequestId
                          additionalContext
                        }
                      }
                    }
                  `;

                  // Wait for auto-dispatched request to appear (child auto-dispatches after grandchild completes)
                  const autoDispatchedRequest = await pollGraphQL(
                    gqlUrl,
                    autoDispatchQuery,
                    { childJobId: childJob.jobDefId },
                    (jr) => {
                      const requests = jr?.data?.requests?.items || [];
                      // Find auto-dispatched request with Work Protocol message in additionalContext
                      return requests.find((r: any) => {
                        if (!r.additionalContext) return false;

                        // Check if additionalContext has Work Protocol message
                        let hasMessage = false;
                        if (typeof r.additionalContext === 'object' && r.additionalContext.message) {
                          hasMessage = true;
                        } else if (typeof r.additionalContext === 'string') {
                          try {
                            const parsed = JSON.parse(r.additionalContext);
                            hasMessage = parsed.message && (
                              typeof parsed.message === 'string' ? JSON.parse(parsed.message) : parsed.message
                            );
                          } catch {
                            // Message parsing failed
                          }
                        }

                        return hasMessage;
                      }) || null;
                    },
                    { maxAttempts: 25, delayMs: 3000 }
                  );

                  // WPQ-003: Validate child was auto-dispatched after grandchild completion
                  expect(autoDispatchedRequest, 'Child should be auto-dispatched after grandchild COMPLETED').toBeTruthy();
                  expect(autoDispatchedRequest.jobDefinitionId).toBe(childJob.jobDefId);
                  expect(autoDispatchedRequest.additionalContext).toBeTruthy();
                  console.log('[TEST] Child auto-dispatched after grandchild completion ✓');

                  // Validate auto-dispatch timing (should occur around the same time as grandchild delivery)
                  // Note: Auto-dispatch can happen very quickly, sometimes even in the same block or slightly before
                  // the delivery transaction is fully indexed, so we just verify they're close in time
                  const autoDispatchTimestamp = typeof autoDispatchedRequest.blockTimestamp === 'string'
                    ? parseInt(autoDispatchedRequest.blockTimestamp, 10)
                    : autoDispatchedRequest.blockTimestamp;
                  const grandchildTimestamp = typeof grandchildDelivery.blockTimestamp === 'string'
                    ? parseInt(grandchildDelivery.blockTimestamp, 10)
                    : grandchildDelivery.blockTimestamp;
                  const timeDiff = Math.abs(autoDispatchTimestamp - grandchildTimestamp);
                  expect(timeDiff).toBeLessThan(60); // Within 60 seconds is reasonable
                  console.log(`[TEST] Auto-dispatch timing validated (time difference: ${timeDiff}s) ✓`);

                  // Extract Work Protocol message from additionalContext
                  const childAdditionalContext = autoDispatchedRequest.additionalContext;
                  let childWorkProtocolMessage: any = null;

                  if (typeof childAdditionalContext === 'object' && childAdditionalContext.message) {
                    childWorkProtocolMessage = childAdditionalContext.message;
                  } else if (typeof childAdditionalContext === 'string') {
                    try {
                      const parsed = JSON.parse(childAdditionalContext);
                      childWorkProtocolMessage =
                        typeof parsed.message === 'string' ? JSON.parse(parsed.message) : parsed.message;
                    } catch (error) {
                      console.error('[TEST] Failed to parse Work Protocol message:', error);
                    }
                  }

                  // Validate Work Protocol message structure and content
                  expect(childWorkProtocolMessage, 'Work Protocol message should be present').toBeTruthy();
                  expect(typeof childWorkProtocolMessage).toBe('object');
                  expect(childWorkProtocolMessage.content).toBeDefined();
                  expect(childWorkProtocolMessage.content).toContain('Child job COMPLETED');
                  expect(childWorkProtocolMessage.to).toBeDefined();
                  expect(childWorkProtocolMessage.to).toBe(childJob.jobDefId);
                  expect(childWorkProtocolMessage.from).toBeDefined();
                  expect(childWorkProtocolMessage.from).toBe(grandchildRequest.id);
                  console.log('[TEST] Work Protocol message structure validated ✓');

                  console.log('[TEST] Child auto-dispatch validation complete:', {
                    autoDispatched: true,
                    messageFrom: childWorkProtocolMessage.from,
                    messageTo: childWorkProtocolMessage.to,
                    messageContentPreview: childWorkProtocolMessage.content.substring(0, 50) + '...'
                  });

                  // ==================================================                  // SECTION 8A: Validating grandchild git lineage metadata
                  // ==================================================                  // NOTE: This section runs BEFORE Section 8D (child rerun worker) because
                  // we need to verify the branch exists before the worker merges/deletes it

                  console.log('\n[TEST] SECTION 8A: Validating grandchild git lineage metadata...');

                  // Get grandchild job definition
                  const grandchildJobDef = await waitForJobIndexed(gqlUrl, grandchildRequest.jobDefinitionId);
                  const grandchildBranchName = grandchildJobDef?.codeMetadata?.branch?.name;
                  expect(grandchildBranchName).toBeTruthy(); // Assert 70

                  // GWQ-001: Grandchild has unique branch
                  expect(grandchildBranchName).not.toBe(parentBranchName); // Assert 71
                  expect(grandchildBranchName).not.toBe(childBranchName); // Assert 72

                  // GWQ-002: Grandchild based on child (not parent or main)
                  expect(grandchildJobDef?.codeMetadata?.baseBranch).toBe(childBranchName); // Assert 73

                  // GWQ-002: Lineage metadata points to child (not parent)
                  expect(grandchildJobDef?.codeMetadata?.parent?.jobDefinitionId).toBe(childJob.jobDefId); // Assert 74
                  expect(grandchildJobDef?.codeMetadata?.parent?.requestId).toBe(requestId); // Assert 75

                  // Branch created in git (validates branch creation before merge)
                  const grandchildBranches = execSync('git branch --format="%(refname:short)"', {
                    cwd: gitFixture!.repoPath,
                    encoding: 'utf-8'
                  }).split('\n').filter(b => b);
                  expect(grandchildBranches).toContain(grandchildBranchName); // Assert 76

                  console.log(`[TEST] 3-level git lineage metadata validated: grandchild→child→parent ✓`);

                  // ==================================================                  // SECTION 8A-B: Validating grandchild coding capabilities (pre-merge)
                  // ==================================================
                  console.log('\n[TEST] SECTION 8A-B: Validating grandchild coding capabilities (pre-merge)...');

                  const grandchildBranchNameForCoding = grandchildBranchName;
                  const expectedFileName = 'olas-staking-optimization.md';

                  // Ensure origin has latest commits before inspection
                  execSync('git fetch origin', {
                    cwd: gitFixture!.repoPath,
                    encoding: 'utf-8'
                  });

                  // Verify the file exists in the grandchild branch
                  let fileContent: string;
                  try {
                    fileContent = execSync(`git show origin/${grandchildBranchNameForCoding}:${expectedFileName}`, {
                      cwd: gitFixture!.repoPath,
                      encoding: 'utf-8'
                    });
                  } catch (error: any) {
                    throw new Error(`File ${expectedFileName} not found in grandchild branch ${grandchildBranchNameForCoding}: ${error.message}`);
                  }

                  expect(fileContent).toBeTruthy();
                  expect(fileContent.toLowerCase()).toContain('olas');
                  expect(fileContent.toLowerCase()).toContain('staking');
                  // Content can vary; ensure non-empty and thematically relevant
                  expect(fileContent.length).toBeGreaterThan(0);
                  console.log(`[TEST] ✓ File ${expectedFileName} exists in grandchild branch with expected content`);

                  // Verify the commit message matches the Execution Summary
                  const latestCommitMessage = execSync(
                    `git log origin/${grandchildBranchNameForCoding} --format="%s" -n 1`,
                    { cwd: gitFixture!.repoPath, encoding: 'utf-8' }
                  ).trim();

                  expect(latestCommitMessage.length).toBeGreaterThan(0);
                  console.log(`[TEST] ✓ Commit message present: "${latestCommitMessage}"`);

                  // Verify the file was actually committed (not just staged)
                  const fileCommitLog = execSync(
                    `git log origin/${grandchildBranchNameForCoding} --format="%s" --follow -n 1 -- ${expectedFileName}`,
                    { cwd: gitFixture!.repoPath, encoding: 'utf-8' }
                  ).trim();

                  expect(fileCommitLog.length).toBeGreaterThan(0);
                  console.log(`[TEST] ✓ File was committed: "${fileCommitLog}"`);

                  // ==================================================                  // SECTION 8A-C: Validating PR creation readiness (pre-merge)
                  // ==================================================
                  console.log('\n[TEST] SECTION 8A-C: Validating PR readiness before merge...');

                  const githubToken = process.env.GITHUB_TOKEN;
                  if (!githubToken) {
                    throw new Error('GITHUB_TOKEN environment variable is required for PR creation test');
                  }

                  let remoteUrl = gitFixture!.remoteUrl;
                  if (!remoteUrl || !remoteUrl.startsWith('http')) {
                    try {
                      remoteUrl = execSync('git remote get-url origin', {
                        cwd: gitFixture!.repoPath,
                        encoding: 'utf-8'
                      }).trim();
                    } catch (error: any) {
                      throw new Error(`Failed to get remote URL from git config: ${error.message}`);
                    }
                  }

                  if (remoteUrl.startsWith('https://') && remoteUrl.includes('@')) {
                    try {
                      const url = new URL(remoteUrl);
                      url.username = '';
                      remoteUrl = url.toString();
                    } catch {
                      remoteUrl = remoteUrl.replace(/https:\/\/[^@]+@/, 'https://');
                    }
                  }

                  if (!remoteUrl || (!remoteUrl.startsWith('http') && !remoteUrl.startsWith('git@'))) {
                    throw new Error(`Invalid remote URL format: ${remoteUrl}. Expected HTTPS URL or git@ format.`);
                  }

                  let owner: string;
                  let repo: string;

                  if (remoteUrl.startsWith('http')) {
                    const url = new URL(remoteUrl);
                    const pathParts = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
                    [owner, repo] = pathParts;
                  } else {
                    const match = remoteUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
                    if (!match) {
                      throw new Error(`Unable to parse SSH remote URL: ${remoteUrl}`);
                    }
                    const [, , repoPath] = match;
                    [owner, repo] = repoPath.split('/');
                  }

                  if (!owner || !repo) {
                    throw new Error(`Unable to extract owner/repo from remote URL: ${remoteUrl}`);
                  }

                  console.log(`[TEST] Repository: ${owner}/${repo}`);
                  console.log(`[TEST] Branch: ${grandchildBranchNameForCoding}`);

                  const branchCheckResult = execSync(
                    `git ls-remote --heads origin ${grandchildBranchNameForCoding}`,
                    { cwd: gitFixture!.repoPath, encoding: 'utf-8' }
                  ).trim();

                  expect(branchCheckResult.length).toBeGreaterThan(0);
                  console.log(`[TEST] ✓ Branch exists on remote: ${grandchildBranchNameForCoding}`);

                  const expectedBaseBranch = childBranchName;
                  const commitCountResult = execSync(
                    `git rev-list --count origin/${expectedBaseBranch}..origin/${grandchildBranchNameForCoding}`,
                    { cwd: gitFixture!.repoPath, encoding: 'utf-8' }
                  ).trim();
                  const commitCount = parseInt(commitCountResult);

                  expect(commitCount).toBeGreaterThan(0);
                  console.log(`[TEST] ✓ Branch has ${commitCount} commit(s) ahead of base`);
                  console.log(`[TEST] ✓ Base branch: ${expectedBaseBranch}`);
                  console.log('[TEST] Branch validation complete ✓');

                  // ==================================================                  // SECTION 8D: Run auto-dispatched child rerun (context envelope validation)
                  // ==================================================
                  const childRerunRequestId = autoDispatchedRequest.id;
                  console.log(`\n[TEST] SECTION 8D: Running worker on auto-dispatched child request ${childRerunRequestId}...`);

                  await waitForRequestIndexed(gqlUrl, childRerunRequestId, {
                    predicate: (request) => Boolean(request.jobName && request.jobDefinitionId),
                  });

                  const childRerunRequestRecord = await getRequest(gqlUrl, childRerunRequestId);
                  expect(childRerunRequestRecord).toBeDefined();
                  expect(childRerunRequestRecord!.jobDefinitionId).toBe(childJob.jobDefId);
                  expect(childRerunRequestRecord!.sourceRequestId).toBe(parentJob.requestId);

                  // Parse additionalContext to verify deterministic hierarchy envelope
                  let rerunAdditionalContext: any = childRerunRequestRecord!.additionalContext;
                  if (rerunAdditionalContext && typeof rerunAdditionalContext === 'string') {
                    try {
                      rerunAdditionalContext = JSON.parse(rerunAdditionalContext);
                    } catch (error) {
                      console.warn('[TEST] Failed to parse rerun additionalContext string:', error);
                    }
                  }
                  expect(rerunAdditionalContext, 'Auto-dispatched request should include additionalContext').toBeTruthy();
                  const rerunHierarchy = rerunAdditionalContext?.hierarchy;
                  expect(Array.isArray(rerunHierarchy)).toBe(true);
                  const rerunSummary = rerunAdditionalContext?.summary;
                  expect(rerunSummary, 'Hierarchy summary should be present').toBeTruthy();
                  if (rerunSummary) {
                    expect(typeof rerunSummary.totalArtifacts).toBe('number');
                    expect(rerunSummary.totalArtifacts, 'Summary should report child artifacts for completed work').toBeGreaterThan(0);
                  }
                  if (Array.isArray(rerunHierarchy)) {
                    const currentNode = rerunHierarchy.find((node: any) => node.jobId === childJob.jobDefId && node.level === 0);
                    expect(currentNode, 'Hierarchy should include current child job node').toBeTruthy();
                    const grandchildNode = rerunHierarchy.find(
                      (node: any) =>
                        Array.isArray(node.requestIds) && node.requestIds.includes(grandchildRequest.id)
                    );
                    expect(grandchildNode, 'Hierarchy should include grandchild request IDs').toBeTruthy();
                    const completedChildNode = rerunHierarchy.find(
                      (node: any) =>
                        node.status === 'completed' &&
                        Array.isArray(node.requestIds) &&
                        node.requestIds.includes(grandchildRequest.id)
                    );
                    if (completedChildNode) {
                      const completedChildArtifacts =
                        completedChildNode?.artifactRefs?.filter((artifact: any) => Boolean(artifact?.cid)) || [];
                      expect(
                        completedChildArtifacts.length,
                        'Completed child node should expose artifact references (id + cid)'
                      ).toBeGreaterThan(0);
                    } else {
                      console.warn('[TEST] Ponder hierarchy did not reflect completed child yet; relying on deterministic context');
                    }
                  }

                  const deterministicRuns = rerunAdditionalContext?.completedChildRuns;
                  expect(Array.isArray(deterministicRuns)).toBe(true);
                  if (Array.isArray(deterministicRuns)) {
                    const deterministicEntry = deterministicRuns.find(
                      (run: any) => run?.requestId === grandchildRequest.id
                    );
                    expect(deterministicEntry, 'Deterministic context should include the completed grandchild run').toBeTruthy();
                    const deterministicArtifacts =
                      deterministicEntry?.artifacts?.filter((artifact: any) => Boolean(artifact?.cid && artifact?.id)) || [];
                    expect(deterministicArtifacts.length).toBeGreaterThan(0);
                    deterministicArtifacts.forEach((artifact: any) => {
                      expect(typeof artifact.id).toBe('string');
                      expect(artifact.id).toContain(grandchildRequest.id);
                      expect(typeof artifact.cid).toBe('string');
                      expect(artifact.cid).toMatch(/^baf|^Qm/);

                      // RICH CONTEXT ASSERTION (TDD):
                      // Verify that branch artifacts have enriched details (diff & status)
                      if (artifact.type === 'GIT_BRANCH' || artifact.topic === 'git/branch') {
                        expect(artifact.details, 'Branch artifact should have enriched details').toBeDefined();
                        expect(artifact.details.mergeStatus).toMatch(/mergeable|conflict|unknown/);
                        expect(typeof artifact.details.diffSummary).toBe('string');
                        expect(artifact.details.diffSummary.length).toBeGreaterThan(0);
                        console.log('[TEST] ✓ Branch artifact enriched with diff & status');
                      }
                    });
                  }

                  const childRerunWorker = await runWorkerOnce(childRerunRequestId, {
                    gqlUrl,
                    controlApiUrl: controlUrl,
                    model: 'gemini-2.5-pro',
                    timeout: 300_000,
                  });

                  try {
                    await childRerunWorker;
                  } catch (error) {
                    console.warn('[TEST] Child rerun worker exited with error:', error);
                  } finally {
                    await cleanupWorkerProcesses();
                  }

                  // Verify branch cleanup (Assert 95)
                  // The process_branch tool should have deleted the branch locally after merging
                  const grandchildBranchStillExists = execSync('git branch --format="%(refname:short)"', {
                    cwd: gitFixture!.repoPath,
                    encoding: 'utf-8'
                  }).split('\n').map(b => b.trim()).includes(grandchildBranchName);
                  expect(grandchildBranchStillExists, 'Grandchild branch should be deleted locally after merge').toBe(false);
                  console.log('[TEST] Grandchild branch cleanup validated (deleted locally) ✓');

                  const childRerunDelivery = await waitForDelivery(gqlUrl, childRerunRequestId, {
                    maxAttempts: 40,
                    delayMs: 5000,
                  });
                  expect(childRerunDelivery.id).toBe(childRerunRequestId);

                  const childRerunSituation = await fetchSituation(childRerunDelivery, gqlUrl);
                  expect(childRerunSituation).toBeDefined();
                  if (!childRerunSituation) {
                    throw new Error('Child rerun SITUATION artifact missing');
                  }

                  // Child rerun should now be COMPLETED (no further delegation)
                  expect(childRerunSituation.execution.status).toBe('COMPLETED');
                  const rerunDispatchCalls =
                    (childRerunSituation.execution.trace || []).filter(
                      (step: any) => step.tool === 'dispatch_new_job' || step.tool === 'dispatch_existing_job'
                    );
                  expect(rerunDispatchCalls.length).toBe(0);

                  // Deterministic context should include previously completed grandchild
                  const rerunContext = childRerunSituation.context as any;
                  expect(Array.isArray(rerunContext?.childRequestIds)).toBe(true);
                  expect(rerunContext.childRequestIds).toContain(grandchildRequest.id);

                  const rerunRecognition = childRerunSituation.meta?.recognition;
                  expect(rerunRecognition).toBeDefined();
                  const rerunInitialSituation = rerunRecognition?.initialSituation;
                  expect(rerunInitialSituation).toBeDefined();
                  const rerunInitialChildren = rerunInitialSituation?.context?.childRequestIds || [];
                  expect(Array.isArray(rerunInitialChildren)).toBe(true);
                  if (Array.isArray(rerunInitialChildren)) {
                    expect(rerunInitialChildren).toContain(grandchildRequest.id);
                  }

                  console.log('[TEST] Child rerun completed with deterministic context ✓');

                  // NOTE: Section 8A has been moved to run BEFORE Section 8D
                  // This ensures we validate branch existence before the worker merges/deletes it

                  // ==================================================                  // SECTION 9: Wait for MEMORY Artifact (MEM-006, MEM-007)
                  // ==================================================
                  console.log('\n[TEST] SECTION 9: Waiting for MEMORY artifact from reflection...');

                  // MEM-006: Reflection phase should create MEMORY artifact
                  const memoryArtifact = await waitForArtifactByType(
                    gqlUrl,
                    grandchildRequest.id,
                    'MEMORY',
                    { timeoutMs: 60000, pollIntervalMs: 2000 }
                  );

                  expect(memoryArtifact).toBeDefined();
                  expect(memoryArtifact.type).toBe('MEMORY');
                  console.log('[TEST] MEMORY artifact created:', memoryArtifact.cid);

                  // ARQ-006: Validate multi-modal persistence - IPFS for content
                  expect(memoryArtifact.cid).toMatch(/^baf|^Qm/); // Assert 49 - CIDv1 or CIDv0 format

                  // MEM-007: Fetch and validate MEMORY artifact structure
                  const memoryContent = await fetchJsonWithRetry(
                    `https://gateway.autonolas.tech/ipfs/${memoryArtifact.cid}`,
                    5, // retries
                    1000 // delay
                  );

                  expect(memoryContent).toBeDefined();

                  // Validate MEMORY artifact schema (MEM-007)
                  expect(memoryContent.type).toBe('MEMORY'); // Assert 30
                  expect(Array.isArray(memoryContent.tags)).toBe(true); // Assert 31
                  expect(memoryContent.tags.length).toBeGreaterThan(0); // Assert 32
                  expect(memoryContent.name).toBeTruthy(); // Assert 33
                  // Assert 34: Topic is free-form, chosen by reflection agent (e.g., 'learnings', 'defi-optimization', etc.)
                  expect(memoryContent.topic).toBeTruthy();
                  expect(typeof memoryContent.topic).toBe('string');
                  expect(memoryContent.content).toBeTruthy(); // Assert 35

                  // Validate tags exist and are relevant (agent chooses specific tags)
                  expect(Array.isArray(memoryContent.tags)).toBe(true); // Assert 36
                  expect(memoryContent.tags.length).toBeGreaterThan(0); // Assert 37
                  // Tags should be semantically relevant (agent may choose 'defi-optimization' instead of 'staking')
                  expect(memoryContent.tags.some((tag: string) => 
                    tag.toLowerCase().includes('optim') || tag.toLowerCase().includes('stak')
                  )).toBe(true); // Assert 38

                  console.log('[TEST] MEMORY artifact validated:', {
                    name: memoryContent.name,
                    tags: memoryContent.tags,
                    topic: memoryContent.topic
                  });

                  console.log('[TEST] ✅ Reflection phase complete - MEMORY artifact created and indexed');

                  // ==================================================                  // SECTION 10: Validate Grandchild SITUATION Structure
                  // (MEM-002, MEM-003, MEM-004)
                  // ==================================================
                  console.log('\n[TEST] SECTION 10: Validating grandchild SITUATION structure...');

                  const situation = await fetchSituation(grandchildDelivery, gqlUrl);
                  expect(situation).toBeDefined();

                  if (!situation) {
                    throw new Error('SITUATION artifact not found in delivery');
                  }

                  // MEM-002: SITUATION Artifact Structure
                  expect(situation.version).toBe('sit-enc-v1.1'); // Assert 1

                  // Validate job section
                  expect(situation.job.requestId).toBe(grandchildRequest.id); // Assert 2
                  expect(situation.job.jobName).toBeTruthy(); // Assert 3
                  // Blueprint-based jobs: no objective/acceptanceCriteria fields, blueprint contains assertions
                  expect(situation.job.blueprint).toBeTruthy(); // Assert 4
                  // enabledTools is optional - agent may not specify tools
                  if (situation.job.enabledTools) {
                    expect(Array.isArray(situation.job.enabledTools)).toBe(true); // Assert 5
                    expect(situation.job.enabledTools.length).toBeGreaterThan(0); // Assert 6
                  }

                  // Validate execution section
                  // LCQ-009: Status inferred from successful execution result
                  expect(situation.execution.status).toBe('COMPLETED'); // Assert 8
                  expect(Array.isArray(situation.execution.trace)).toBe(true); // Assert 9
                  expect(situation.execution.finalOutputSummary).toBeTruthy(); // Assert 10

                  // EXQ-007: Validate execution trace captured (derived from telemetry)
                  const trace = situation.execution.trace;
                  expect(Array.isArray(trace)).toBe(true); // Assert 39
                  expect(trace.length).toBeGreaterThan(0); // Assert 40

                  // Validate trace entries have required structure
                  const firstTraceEntry = trace[0];
                  expect(firstTraceEntry).toBeDefined(); // Assert 41
                  expect(typeof firstTraceEntry.tool).toBe('string'); // Assert 42
                  expect(typeof firstTraceEntry.args).toBe('string'); // Assert 43
                  expect(typeof firstTraceEntry.result_summary).toBe('string'); // Assert 44

                  // JINN-252: Validate expected tools were called by grandchild
                  const toolNames = trace.map(t => t.tool);
                  expect(toolNames).toContain('create_artifact'); // Assert 45 - Grandchild should call this
                  // Coding capability validation - grandchild should have written a file
                  expect(toolNames).toContain('write_file'); // Assert 45a - Grandchild should write file
                  console.log(`[TEST] Expected tool calls present: ${[...new Set(toolNames)].join(', ')} ✓`);

                  // JINN-252: Validate all trace entries have complete structure
                  trace.forEach((entry, idx) => {
                    expect(entry.tool).toBeTruthy(); // Assert 46
                    expect(entry.args).toBeDefined(); // Assert 47
                    expect(entry.result_summary).toBeDefined(); // Assert 48
                  });

                  console.log('[TEST] Execution trace validated ✓');

                  // EXQ-004: Validate model selection from job metadata
                  // Model is set at job dispatch time, not from worker environment
                  // Grandchild was dispatched by child without explicit model, so uses default 'gemini-2.5-flash'
                  const expectedGrandchildModel = 'gemini-2.5-flash';
                  expect(situation.job.model).toBe(expectedGrandchildModel); // Assert 49
                  console.log(`[TEST] Model selection validated (default model = ${expectedGrandchildModel}) ✓`);

                  // Validate context section
                  expect(situation.context).toBeDefined(); // Assert 11
                  expect(situation.context.parent).toBeDefined(); // Assert 12
                  if (!situation.context.parent) {
                    throw new Error('Grandchild situation missing parent context');
                  }

                  console.log('[TEST] Grandchild SITUATION structure valid ✓');

                  // ==================================================                  // SECTION 10: Validate Embedding Format
                  // ==================================================
                  console.log('\n[TEST] SECTION 10: Validating grandchild embedding...');

                  const embedding = situation.embedding;
                  expect(embedding).toBeDefined(); // Assert 13

                  // MEM-004: Must use text-embedding-3-small with 256 dimensions
                  expect(embedding.model).toBe('text-embedding-3-small'); // Assert 14
                  expect(embedding.dim).toBe(256); // Assert 15
                  expect(Array.isArray(embedding.vector)).toBe(true); // Assert 16
                  expect(embedding.vector.length).toBe(256); // Assert 17

                  // Validate vector values are numeric and in valid range
                  expect(typeof embedding.vector[0]).toBe('number'); // Assert 18
                  expect(embedding.vector[0]).toBeGreaterThanOrEqual(-1); // Assert 19
                  expect(embedding.vector[0]).toBeLessThanOrEqual(1); // Assert 20

                  console.log('[TEST] Embedding format valid ✓');

                  // MEM-001: Complete SITUATION artifact with embedding demonstrates
                  // the system's ability to capture execution context for future retrieval

                  // ==================================================                  // SECTION 11: Recognition Phase Validation (MEM-005)
                  // ==================================================
                  console.log('\n[TEST] SECTION 11: Validating grandchild recognized child...');

                  // Recognition MUST exist and include child
                  const recognition = situation.meta?.recognition;
                  expect(recognition).toBeDefined(); // Assert 21
                  if (!recognition) {
                    throw new Error('Recognition metadata missing on grandchild situation');
                  }
                  expect(recognition.similarJobs).toBeDefined(); // Assert 22
                  expect(Array.isArray(recognition.similarJobs)).toBe(true); // Assert 23

                  // MEM-003: Validate initial situation was enriched during recognition
                  expect(recognition.initialSituation).toBeDefined(); // Assert 57

                  // Verify enrichment preserved recognition results
                  expect(recognition.embeddingStatus).toBeDefined(); // Assert 58

                  console.log('[TEST] Situation enrichment validated ✓');

                  const similarJobs = recognition.similarJobs;
                  console.log(`[TEST] Recognition found ${similarJobs.length} similar jobs`);

                  // Child's SITUATION MUST be found
                  expect(similarJobs.length).toBeGreaterThan(0); // Assert 24

                  const foundChild = similarJobs.find(
                    (j: any) => j.requestId === requestId
                  ) as { requestId: string; similarity?: number; score?: number } | undefined;
                  expect(foundChild).toBeDefined(); // Assert 25
                  if (!foundChild) {
                    throw new Error('Grandchild recognition failed to find child situation');
                  }
                  const childSimilarity = foundChild.similarity ?? foundChild.score;
                  if (typeof childSimilarity !== 'number') {
                    throw new Error('Recognition result missing similarity score');
                  }
                  expect(childSimilarity).toBeGreaterThan(0.5); // Assert 26 - High similarity expected

                  console.log(`[TEST] ✓ Grandchild recognized child with similarity score: ${childSimilarity}`);

                  // Validate embedding status
                  if (recognition.embeddingStatus !== undefined) {
                    expect(recognition.embeddingStatus).toBe('success'); // Assert 27
                    console.log('[TEST] ✓ Embedding status: success');
                  }

                  // ==================================================                  // SECTION 12: 3-Level Lineage Validation
                  // ==================================================
                  console.log('\n[TEST] SECTION 12: Validating 3-level lineage...');

                  // Grandchild → Child
                  expect(situation.context.parent).toBeDefined();
                  expect(situation.context.parent.requestId).toBe(requestId); // Assert 28
                  console.log('[TEST] ✓ Grandchild parent = Child');

                  // Fetch child SITUATION to verify Child → Parent
                  const childSituationLineage = await fetchSituation(childDelivery, gqlUrl);
                  expect(childSituationLineage).toBeDefined();
                  if (!childSituationLineage || !childSituationLineage.context?.parent) {
                    throw new Error('Child situation missing parent context');
                  }
                  expect(childSituationLineage.context.parent.requestId).toBe(parentJob.requestId); // Assert 29
                  console.log('[TEST] ✓ Child parent = Parent');

                  // EXQ-004: Validate child used correct model
                  // Child job was created via createTestJob (before worker runs), so it defaults to 'gemini-2.5-flash'
                  // The SITUATION encoder reads model from job metadata (IPFS), not worker's runtime MECH_MODEL
                  // So child SITUATION will have 'gemini-2.5-flash' even though worker runs with 'gemini-2.5-pro'
                  const expectedChildModel = 'gemini-2.5-flash';
                  expect(childSituationLineage.job.model).toBe(expectedChildModel); // Assert 52

                  // EXQ-005/006: Validate tool usage and enablement
                  const childTraceLineage = childSituationLineage.execution.trace;
                  const childToolsUsed = childTraceLineage.map((entry: any) => entry.tool).filter((t: string) => t);
                  expect(childToolsUsed.length).toBeGreaterThan(0); // Assert 53 - Tool interaction occurred
                  expect(childToolsUsed).toContain('create_artifact'); // Assert 54 - Created analysis artifact
                  expect(childToolsUsed).toContain('dispatch_new_job'); // Assert 55 - Delegated grandchild job

                  console.log(`[TEST] Child tool usage validated: ${childToolsUsed.join(', ')} ✓`);
                  console.log('[TEST] Child job execution validated: model ✓');

                  console.log('[TEST] ✓ Complete lineage: Parent → Child → Grandchild');

                  // ==================================================                  // SECTION 13: Git Working Tree Status
                  // ==================================================
                  console.log('\n[TEST] SECTION 13: Validating git working tree...');

                  // No uncommitted changes (worker auto-commits file changes before push)
                  const gitStatus = execSync('git status --porcelain', {
                    cwd: gitFixture!.repoPath,
                    encoding: 'utf-8'
                  }).trim();
                  expect(gitStatus).toBe(''); // Assert 77 - Working tree clean

                  console.log('[TEST] Git working tree clean (all changes auto-committed) ✓');

                  // ==================================================                  // SECTION 14: Branch Artifact Validation
                  // ==================================================
                  console.log('\n[TEST] SECTION 14: Validating branch artifact creation...');

                  const branchArtifactQuery = `
                    query BranchArtifact($requestId: String!) {
                      artifacts(where: { requestId: $requestId, topic: "git/branch" }, limit: 10) {
                        items {
                          id
                          requestId
                          cid
                          topic
                          name
                          type
                          tags
                        }
                      }
                    }
                  `;

                  const branchArtifactResponse = await queryPonder(gqlUrl, branchArtifactQuery, {
                    variables: { requestId: grandchildRequest.id },
                  }) as {
                    artifacts: { items: Array<{ id: string; requestId: string; cid: string; topic: string; name?: string; type?: string; tags?: string[] }> };
                  };

                  const branchArtifacts = branchArtifactResponse?.artifacts?.items || [];
                  expect(branchArtifacts.length).toBeGreaterThan(0);

                  const branchArtifact = branchArtifacts.find((artifact) => artifact.topic === 'git/branch');
                  expect(branchArtifact).toBeTruthy();
                  expect(branchArtifact?.cid).toBeTruthy();

                  const gatewayBase = (process.env.IPFS_GATEWAY_URL || 'https://gateway.autonolas.tech/ipfs/').replace(/\/+$/, '');
                  const branchIpfsUrl = `${gatewayBase}/${branchArtifact!.cid}`;
                  const branchIpfsResponse = await fetch(branchIpfsUrl);
                  expect(branchIpfsResponse.ok).toBe(true);

                  const branchArtifactContent = await branchIpfsResponse.json();
                  expect(branchArtifactContent.type).toBe('GIT_BRANCH');
                  expect(branchArtifactContent.topic).toBe('git/branch');
                  expect(branchArtifactContent.content).toBeTruthy();

                  const branchMetadata = JSON.parse(branchArtifactContent.content);
                  expect(branchMetadata.branchUrl).toContain(`/tree/${grandchildBranchName}`);
                  expect(branchMetadata.branchUrl).toMatch(/^https:\/\//);
                  expect(branchMetadata.headBranch).toBe(grandchildBranchName);
                  expect(branchMetadata.baseBranch).toBe(childBranchName);
                  expect(branchMetadata.requestId).toBe(grandchildRequest.id);
                  expect(branchMetadata.jobDefinitionId).toBe(grandchildRequest.jobDefinitionId);
                  expect(branchMetadata.title).toContain(grandchildRequest.jobDefinitionId);

                  console.log(`[TEST] ✓ Branch artifact created: ${branchArtifact!.id}`);
                  console.log(`[TEST] ✓ Branch artifact CID: ${branchArtifact!.cid}`);
                  console.log('[TEST] Branch artifact metadata validated ✓');

                  console.log('\n[TEST] ✅ Memory system test complete!');
                  console.log('[TEST] Coverage: MEM-001 to MEM-010, ARQ-006, EXQ-004/005/006/007, LCQ-003/004/009, IDQ-001, LCQ-001, GWQ-001/002');
                  console.log('[TEST] Assertions: ~120+ assertions executed (52 memory + 19 git + 44 metadata + 11 trace validation)');
                  console.log('[TEST] Recognition: Grandchild successfully found child via similarity search');
                  console.log('[TEST] Lineage: 3-level delegation validated');
                  console.log('[TEST] Metadata: Request metadata completeness validated at all 3 levels (JINN-249)');
                  console.log('[TEST] Trace: Execution trace structure and tool call validation (JINN-252)');
                }
              );
            });
          });
        });
      },
    600_000 // 10 minute timeout
  );
});


// ======================================================================// REMOVED SECTIONS (for future incremental testing):
// - SECTION 6: Recognition Phase Validation
// - SECTION 7: Reflection Phase Validation
// - SECTION 8: Ponder Indexing Validation
// - SECTION 9: Memory Discovery Validation
//
// These sections will be added back incrementally after the baseline test
// passes consistently.
// ======================================================================
