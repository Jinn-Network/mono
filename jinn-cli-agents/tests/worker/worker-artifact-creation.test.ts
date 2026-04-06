/**
 * Worker Artifact Creation Test
 * Tests worker creating artifacts via MCP create_artifact tool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getSharedInfrastructure,
  resetTestEnvironment,
  createTestJob,
  waitForRequestIndexed,
  waitForDelivery,
  waitForArtifact,
  runWorkerOnce,
  reconstructDirCidFromHexIpfsHash,
  fetchJsonWithRetry,
  parseToolText,
  cleanupWorkerProcesses,
} from '../helpers/shared.js';
import { searchArtifacts, getDetails } from 'jinn-node/agent/mcp/tools/index.js';

describe('Worker: Artifact Creation', () => {
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

  afterEach(async () => {
    // Cleanup any lingering worker processes (e.g., from timeout scenarios)
    await cleanupWorkerProcesses();
  });

  it('worker creates artifact via create_artifact MCP tool', async () => {
    const { gqlUrl, controlUrl } = getSharedInfrastructure();
    const artifactName = 'test-report';
    const artifactTopic = 'analysis';
    const artifactContent = `Test artifact created at ${new Date().toISOString()}`;

    // 1) Create job with explicit artifact creation instructions
    const { requestId } = await createTestJob({
      objective: 'Create test artifact via MCP tool',
      context: 'Worker artifact test - validates create_artifact tool usage',
      instructions: `Call create_artifact once with: name="${artifactName}", topic="${artifactTopic}", content="${artifactContent}"`,
      acceptanceCriteria: `Artifact created with name="${artifactName}", topic="${artifactTopic}", content="${artifactContent}"`,
      deliverables: 'Single artifact with specified metadata',
      enabledTools: ['create_artifact']
    });

    // 2) Wait for request to be indexed
    await waitForRequestIndexed(gqlUrl, requestId);

    // 3) Run worker single-shot
    const workerProc = await runWorkerOnce(requestId, {
      gqlUrl,
      controlApiUrl: controlUrl,
      model: 'gemini-2.5-pro',
      timeout: 300_000
    });

    // Wait for worker process to complete
    try {
      await workerProc;
    } catch (error) {
      // Allow non-zero exits; delivery may still have succeeded
      console.log('[test] Worker exited with error (may be expected):', error);
    }

    // 4) Wait for delivery
    const delivery = await waitForDelivery(gqlUrl, requestId, {
      maxAttempts: 40,
      delayMs: 5000
    });

    expect(delivery.id).toBe(requestId);
    expect(typeof delivery.ipfsHash).toBe('string');

    // 5) Fetch delivery JSON from IPFS
    const dirCid = reconstructDirCidFromHexIpfsHash(delivery.ipfsHash);
    expect(dirCid).toBeTruthy();

    const reqPath = `${dirCid}/${requestId}`;
    const url = `https://gateway.autonolas.tech/ipfs/${reqPath}`;
    const deliveryJson = await fetchJsonWithRetry(url, 6, 2000);

    // Verify delivery includes artifacts array
    expect(Array.isArray(deliveryJson?.artifacts)).toBe(true);
    const deliveryArtifact = deliveryJson.artifacts.find((a: any) => a.topic === artifactTopic);
    expect(deliveryArtifact, `Delivery should include artifact with topic ${artifactTopic}`).toBeTruthy();
    expect(typeof deliveryArtifact.cid).toBe('string');

    // 6) Wait for artifact to be indexed in Ponder
    const artifact = await waitForArtifact(gqlUrl, `${requestId}:0`, {
      maxAttempts: 30,
      delayMs: 4000
    });

    expect(artifact.id).toBe(`${requestId}:0`);
    expect(artifact.requestId).toBe(requestId);
    expect(artifact.topic).toBe(artifactTopic);
    if (artifact.name) expect(artifact.name).toBe(artifactName);
    expect(typeof artifact.cid).toBe('string');

    // 7) Test search-artifacts can find the artifact
    const searchByNameRes = await searchArtifacts({ query: artifactName, include_request_context: false });
    const searchByNameParsed = parseToolText(searchByNameRes);
    expect(searchByNameParsed?.data?.length).toBeGreaterThan(0);
    const foundByName = searchByNameParsed.data.find((a: any) => a.id === `${requestId}:0`);
    expect(foundByName).toBeTruthy();
    expect(foundByName.name).toBe(artifactName);
    expect(foundByName.topic).toBe(artifactTopic);

    const searchByTopicRes = await searchArtifacts({ query: artifactTopic, include_request_context: false });
    const searchByTopicParsed = parseToolText(searchByTopicRes);
    expect(searchByTopicParsed?.data?.length).toBeGreaterThan(0);
    const foundByTopic = searchByTopicParsed.data.find((a: any) => a.id === `${requestId}:0`);
    expect(foundByTopic).toBeTruthy();

    // 8) Test get_details returns artifact record
    const detailsRes = await getDetails({ ids: [`${requestId}:0`], resolve_ipfs: false });
    const detailsParsed = parseToolText(detailsRes);
    const artRec = detailsParsed.data.find((x: any) => x.id === `${requestId}:0`);
    expect(artRec).toBeTruthy();
    expect(artRec.topic).toBe(artifactTopic);
    expect(typeof artRec.cid).toBe('string');
  }, 600_000);
});
