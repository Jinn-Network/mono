/**
 * Marketplace Lineage Test
 * Tests sourceRequestId/sourceJobDefinitionId propagation through IPFS and subgraph
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fetch from 'cross-fetch';
import {
  getSharedInfrastructure,
  resetTestEnvironment,
  createTestJob,
  waitForJobIndexed,
  waitForRequestIndexed,
  fetchJsonWithRetry,
  parseToolText,
  getMcpClient,
} from '../helpers/shared.js';

describe('Marketplace: Lineage Propagation', () => {
  beforeEach(() => {
    // Clear environment variables before each test to prevent pollution
    resetTestEnvironment();

    // Prefer .env.test if present to provide MECH/Safe settings under test
    try {
      const testEnv = path.join(process.cwd(), '.env.test');
      if (fs.existsSync(testEnv)) {
        process.env.JINN_ENV_PATH = testEnv;
      }
    } catch {}
  });

  afterEach(async () => {
    // Clean up lineage env vars that this test sets
    delete process.env.JINN_REQUEST_ID;
    delete process.env.JINN_JOB_DEFINITION_ID;

    // Note: We used to disconnect/reconnect MCP client here to pick up env changes,
    // but tests do this inline when needed (see disconnect/connect within test body)
  });

  it('propagates lineage context through IPFS and Ponder', async () => {
    const { gqlUrl } = getSharedInfrastructure();

    // 1) Create parent job first
    const { jobDefId: parentJobId, requestId: parentRequestId } = await createTestJob({
      objective: 'Parent job for lineage testing',
      context: 'Parent job that will spawn child jobs',
      instructions: 'Create a simple parent job that will be used to test lineage propagation to child jobs',
      acceptanceCriteria: 'Parent job is indexed',
      enabledTools: []
    });

    await waitForJobIndexed(gqlUrl, parentJobId);

    // 2) Create child job with lineage via env (production-like)
    // Ensure MCP process inherits updated env by reconnecting
    await getMcpClient().disconnect();
    process.env.JINN_REQUEST_ID = parentRequestId;
    process.env.JINN_JOB_DEFINITION_ID = parentJobId;
    await getMcpClient().connect();
    const { jobDefId: childJobId, requestId: childRequestId } = await createTestJob({
      objective: 'Child job with lineage context',
      context: 'Child job spawned by parent - should inherit lineage',
      instructions: 'Create a child job that explicitly sets lineage parameters to test propagation through IPFS and subgraph',
      acceptanceCriteria: 'Child job has correct sourceRequestId and sourceJobDefinitionId',
      enabledTools: [],
    });

    // 3) Wait for child request to be indexed
    const childRequest = await waitForRequestIndexed(gqlUrl, childRequestId);
    expect(childRequest.id).toBe(childRequestId);
    expect(typeof childRequest.ipfsHash).toBe('string');

    // 4) Fetch IPFS content and verify lineage
    const gatewayUrl = `https://gateway.autonolas.tech/ipfs/${childRequest.ipfsHash}`;
    const ipfsJson = await fetchJsonWithRetry(gatewayUrl, 6, 2000);
    expect(ipfsJson.sourceRequestId).toBe(parentRequestId);
    expect(ipfsJson.sourceJobDefinitionId).toBe(parentJobId);

    // 5) Verify subgraph jobDefinition contains lineage
    const childJobDef = await waitForJobIndexed(gqlUrl, childJobId);
    expect(childJobDef.sourceRequestId).toBe(parentRequestId);
    expect(childJobDef.sourceJobDefinitionId).toBe(parentJobId);

    // 6) Verify subgraph request contains lineage
    const query = 'query($id:String!){ request(id:$id){ id sourceRequestId sourceJobDefinitionId } }';
    const resp = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: childRequestId } })
    });
    expect(resp.ok).toBe(true);
    const jr = await resp.json();
    const reqObj = jr?.data?.request;
    expect(reqObj?.sourceRequestId).toBe(parentRequestId);
    expect(reqObj?.sourceJobDefinitionId).toBe(parentJobId);
  }, 240_000);

  it('preserves job definition lineage on repost while using poster context for request', async () => {
    const { gqlUrl } = getSharedInfrastructure();

    // Disconnect/reconnect to pick up clean environment from beforeEach
    const client = getMcpClient();
    await client.disconnect();
    await client.connect();

    // 1) Create initial job without lineage
    const { jobDefId } = await createTestJob({
      objective: 'Job to be reposted',
      context: 'Test job for repost lineage behavior',
      instructions: 'Create a job without lineage that will be reposted with different lineage context',
      acceptanceCriteria: 'Job is created without lineage',
      enabledTools: []
    });

    await waitForJobIndexed(gqlUrl, jobDefId);

    // 2) Repost with different lineage context (set via env, like production)
    const newLineageRequest = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const newLineageJob = 'aaaaaaaa-1111-1111-1111-111111111111';

    // Ensure MCP process inherits updated env by reconnecting
    await client.disconnect();
    process.env.JINN_REQUEST_ID = newLineageRequest;
    process.env.JINN_JOB_DEFINITION_ID = newLineageJob;
    await client.connect();
    const repostRes = await client.callTool('dispatch_existing_job', {
      jobId: jobDefId,
    });
    const parsed = parseToolText(repostRes);
    if (!parsed?.meta?.ok) {
      console.error('[TEST] dispatch_existing_job failed:', JSON.stringify(parsed, null, 2));
    }
    expect(parsed?.meta?.ok).toBe(true);
    const repostRequestId = parsed.data.request_ids[0];

    // 3) Verify reposted request uses new lineage context
    const repostRequest = await waitForRequestIndexed(gqlUrl, repostRequestId);
    expect(repostRequest.sourceRequestId).toBe(newLineageRequest);
    expect(repostRequest.sourceJobDefinitionId).toBe(newLineageJob);

    // 4) Verify job definition lineage remains unchanged (null)
    const jobDef = await waitForJobIndexed(gqlUrl, jobDefId);
    expect(jobDef.sourceRequestId ?? null).toBe(null);
    expect(jobDef.sourceJobDefinitionId ?? null).toBe(null);
  }, 180_000);
});
