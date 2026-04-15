/**
 * Marketplace Dispatch Test
 * Tests basic dispatch_new_job → IPFS → Ponder indexing flow
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSharedInfrastructure,
  resetTestEnvironment,
  createTestJob,
  waitForJobIndexed,
  waitForRequestIndexed,
  fetchJsonWithRetry,
  parseToolText,
} from '../helpers/shared.js';
import { searchJobs, getDetails } from 'jinn-node/agent/mcp/tools/index.js';

describe('Marketplace: dispatch_new_job → IPFS → Ponder', () => {
  beforeEach(() => {
    resetTestEnvironment();
  });

  it('dispatches job, uploads to IPFS, and indexes in Ponder', async () => {
    const { gqlUrl } = getSharedInfrastructure();
    const enabledTools = ['create_artifact', 'google_web_search'];

    // 1) Create test job
    const { jobDefId, requestId } = await createTestJob({
      objective: 'Verify marketplace dispatch and indexing',
      context: 'Basic marketplace test - validates end-to-end dispatch flow',
      instructions: 'Acknowledge the test and create a simple artifact confirming dispatch succeeded',
      acceptanceCriteria: 'Job definition and request are indexed correctly in Ponder',
      enabledTools
    });

    // 2) Wait for job definition to be indexed
    const jobDef = await waitForJobIndexed(gqlUrl, jobDefId);
    expect(jobDef.id).toBe(jobDefId);
    expect(Array.isArray(jobDef.enabledTools)).toBe(true);
    expect(jobDef.enabledTools.sort()).toEqual(enabledTools.sort());
    expect(typeof jobDef.blueprint).toBe('string');
    expect(jobDef.blueprint.toLowerCase()).toContain('verify marketplace dispatch');

    // 3) Wait for request to be indexed
    const request = await waitForRequestIndexed(gqlUrl, requestId);
    expect(request.id).toBe(requestId);
    expect(request.jobDefinitionId).toBe(jobDefId);
    expect(typeof request.ipfsHash).toBe('string');

    // 4) Fetch and verify IPFS content
    const gatewayUrl = `https://gateway.autonolas.tech/ipfs/${request.ipfsHash}`;
    const ipfsJson = await fetchJsonWithRetry(gatewayUrl, 6, 2000);
    expect(ipfsJson.jobDefinitionId).toBe(jobDefId);
    expect(Array.isArray(ipfsJson.enabledTools)).toBe(true);
    expect(ipfsJson.enabledTools.sort()).toEqual(enabledTools.sort());
    expect(typeof ipfsJson.prompt).toBe('string');
    expect(typeof ipfsJson.nonce).toBe('string');

    // 5) Test search-jobs can find the job by name
    const searchRes = await searchJobs({ query: jobDef.name, include_requests: false });
    const searchParsed = parseToolText(searchRes);
    expect(searchParsed?.data?.length).toBeGreaterThan(0);
    const foundJob = searchParsed.data.find((j: any) => j.id === jobDefId);
    expect(foundJob).toBeTruthy();
    expect(foundJob.name).toBe(jobDef.name);

    // 6) Test get_details returns correct records
    const detailsRes = await getDetails({ ids: [requestId, jobDefId], resolve_ipfs: true });
    const detailsParsed = parseToolText(detailsRes);
    expect(detailsParsed?.data?.length).toBeGreaterThan(0);

    const reqObj = detailsParsed.data.find((r: any) => r.id === requestId);
    expect(reqObj?.ipfsContent?.jobDefinitionId).toBe(jobDefId);
    expect(reqObj?.ipfsContent?.enabledTools?.sort()).toEqual(enabledTools.sort());

    const jobObj = detailsParsed.data.find((j: any) => j.id === jobDefId);
    expect(jobObj?.id).toBe(jobDefId);
  }, 240_000);
});
