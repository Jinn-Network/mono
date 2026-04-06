/**
 * Worker Context Envelope Test
 * Tests dispatch_existing_job includes hierarchical context from child jobs and artifacts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getSharedInfrastructure,
  resetTestEnvironment,
  createTestJob,
  waitForJobIndexed,
  waitForRequestIndexed,
  fetchJsonWithRetry,
  pollGraphQL,
  getMcpClient,
  parseToolText,
} from '../helpers/shared.js';
import { dispatchExistingJob, createArtifact } from 'jinn-node/agent/mcp/tools/index.js';

describe('Marketplace: Context Envelope', () => {
  beforeEach(() => {
    // Prefer .env.test if present to provide MECH/Safe settings under test
    try {
      const testEnv = path.join(process.cwd(), '.env.test');
      if (fs.existsSync(testEnv)) {
        process.env.JINN_ENV_PATH = testEnv;
      }
    } catch {}
    resetTestEnvironment();
  });

  it('dispatch_existing_job includes hierarchical context from child jobs', async () => {
    const { gqlUrl } = getSharedInfrastructure();

    // 1) Create parent job
    const { jobDefId: parentJobId, requestId: parentRequestId } = await createTestJob({
      objective: 'Coordinate data analysis workflow',
      context: 'Context envelope test - parent job that spawns children',
      acceptanceCriteria: 'Child jobs complete and context is captured',
      enabledTools: ['dispatch_new_job', 'create_artifact']
    });

    await waitForJobIndexed(gqlUrl, parentJobId);

    // 2) Create 2 child jobs with lineage via env (production-like)
    let child1JobId: string;
    let child2JobId: string;

    // Child 1: Data Analysis
    // Ensure MCP process inherits updated env by reconnecting
    await getMcpClient().disconnect();
    process.env.JINN_REQUEST_ID = parentRequestId;
    process.env.JINN_JOB_DEFINITION_ID = parentJobId;
    await getMcpClient().connect();
    const child1 = await createTestJob({
      objective: 'Analyze sample data and generate insights',
      context: 'First child - intermediate analysis step',
      instructions: 'Create an artifact with topic="analysis" containing simple insights, then finalize with status=WAITING',
      acceptanceCriteria: 'Analysis artifact created',
      enabledTools: ['create_artifact']
    });
    child1JobId = child1.jobDefId;

    // Child 2: Report Generation
    const child2 = await createTestJob({
      objective: 'Generate summary report from analysis',
      context: 'Second child - report generation step',
      instructions: 'Create an artifact with topic="report" containing a summary, then finalize with status=WAITING',
      acceptanceCriteria: 'Summary report artifact created',
      enabledTools: ['create_artifact']
    });
    child2JobId = child2.jobDefId;

    // Clear env variables after child job creation
    delete process.env.JINN_REQUEST_ID;
    delete process.env.JINN_JOB_DEFINITION_ID;

    // 3) Create artifacts to simulate child outputs
    const artifact1 = await createArtifact({
      name: 'analysis-results',
      topic: 'data-analysis',
      content: JSON.stringify({
        insights: ['Pattern A detected', 'Trend B identified'],
        metrics: { accuracy: 0.95, completeness: 0.87 }
      })
    });
    const artifact1Parsed = parseToolText(artifact1);
    expect(artifact1Parsed?.data?.cid).toBeTruthy();

    const artifact2 = await createArtifact({
      name: 'summary-report',
      topic: 'reporting',
      content: JSON.stringify({
        summary: 'Analysis completed successfully',
        recommendations: ['Continue monitoring Pattern A']
      })
    });
    const artifact2Parsed = parseToolText(artifact2);
    expect(artifact2Parsed?.data?.cid).toBeTruthy();

    // 4) Wait for child jobs to be indexed with lineage
    const child1Job = await waitForJobIndexed(gqlUrl, child1JobId);
    expect(child1Job.sourceJobDefinitionId).toBe(parentJobId);
    expect(child1Job.sourceRequestId).toBe(parentRequestId);

    const child2Job = await waitForJobIndexed(gqlUrl, child2JobId);
    expect(child2Job.sourceJobDefinitionId).toBe(parentJobId);
    expect(child2Job.sourceRequestId).toBe(parentRequestId);

    // 5) Redispatch parent job - should include context envelope
    const repostRes = await dispatchExistingJob({ jobId: parentJobId });
    const repostParsed = parseToolText(repostRes);
    expect(repostParsed?.meta?.ok).toBe(true);
    const repostRequestId = repostParsed.data.request_ids[0];

    // 6) Wait for reposted request to be indexed WITH additionalContext populated
    const query = `
      query($id:String!) {
        request(id:$id) {
          id
          ipfsHash
          additionalContext
        }
      }
    `;
    const repostRequest = await pollGraphQL(
      gqlUrl,
      query,
      { id: repostRequestId },
      (jr) => {
        const req = jr?.data?.request;
        // Only return when request exists AND additionalContext is populated
        if (req?.id && req.additionalContext) {
          return req;
        }
        return null;
      },
      { maxAttempts: 30, delayMs: 2000 } // Increased timeout for IPFS fetch
    );
    expect(repostRequest.id).toBe(repostRequestId);
    expect(typeof repostRequest.ipfsHash).toBe('string');

    // 7) Fetch IPFS content and verify context envelope
    const gatewayUrl = `https://gateway.autonolas.tech/ipfs/${repostRequest.ipfsHash}`;
    const ipfsJson = await fetchJsonWithRetry(gatewayUrl, 6, 2000);

    expect(ipfsJson.jobDefinitionId).toBe(parentJobId);
    expect(ipfsJson.additionalContext, 'IPFS should contain additionalContext').toBeTruthy();

    // 8) Verify context envelope structure
    const context = ipfsJson.additionalContext;
    expect(context.hierarchy, 'Context should contain hierarchy').toBeTruthy();
    expect(context.summary, 'Context should contain summary').toBeTruthy();
    expect(Array.isArray(context.hierarchy)).toBe(true);
    expect(context.hierarchy.length).toBeGreaterThan(0);

    // 9) Verify hierarchy contains parent and child jobs
    const hierarchyIds = context.hierarchy.map((job: any) => job.jobId);
    expect(hierarchyIds).toContain(parentJobId);

    // Check for child jobs at level > 0
    const hasChildJob = context.hierarchy.some((job: any) => job.level > 0);
    expect(hasChildJob, 'Hierarchy should contain child jobs at level > 0').toBe(true);

    // 10) Verify summary statistics
    expect(typeof context.summary.totalJobs).toBe('number');
    expect(typeof context.summary.completedJobs).toBe('number');
    expect(typeof context.summary.activeJobs).toBe('number');
    expect(typeof context.summary.totalArtifacts).toBe('number');
    expect(context.summary.totalJobs).toBeGreaterThan(0);

    // 11) Verify Ponder indexed additionalContext
    expect(repostRequest.additionalContext, 'Ponder should index additionalContext').toBeTruthy();
    const indexedContext = repostRequest.additionalContext;
    expect(indexedContext.hierarchy).toBeTruthy();
    expect(indexedContext.summary).toBeTruthy();
    expect(Array.isArray(indexedContext.hierarchy)).toBe(true);

    console.log(JSON.stringify({
      audit: {
        step: 'context_envelope_verification',
        parent_job_id: parentJobId,
        repost_request_id: repostRequestId,
        context_summary: context.summary,
        hierarchy_job_count: context.hierarchy.length,
        hierarchy_levels: [...new Set(context.hierarchy.map((j: any) => j.level))].sort(),
        context_envelope_present: true,
        indexed_context_present: true
      }
    }, null, 2));
  }, 300_000);
});
