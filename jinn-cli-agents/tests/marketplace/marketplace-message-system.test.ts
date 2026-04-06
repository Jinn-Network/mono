/**
 * Worker Message System Test
 * Tests message creation on job dispatch and indexing in Ponder
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getSharedInfrastructure,
  resetTestEnvironment,
  createTestJob,
  waitForRequestIndexed,
  waitForMessage,
  getMcpClient,
  parseToolText,
} from '../helpers/shared.js';
import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/index.js';

describe('Marketplace: Message System', () => {
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

  it('dispatches job with message and verifies indexing', async () => {
    const { gqlUrl } = getSharedInfrastructure();

    // 1) Create parent job first (to establish lineage)
    const { jobDefId: parentJobId, requestId: parentRequestId } = await createTestJob({
      objective: 'Parent job for message test',
      context: 'Parent job that will send messages to child jobs',
      acceptanceCriteria: 'Parent job is indexed',
      enabledTools: []
    });

    await waitForRequestIndexed(gqlUrl, parentRequestId);

    // 2) Create child job with message and lineage via env (production-like)
    const testMessage = 'Test message: verify this gets indexed correctly';
    // Ensure MCP process inherits updated env by reconnecting
    await getMcpClient().disconnect();
    process.env.JINN_REQUEST_ID = parentRequestId;
    process.env.JINN_JOB_DEFINITION_ID = parentJobId;
    await getMcpClient().connect();
    const { requestId, jobDefId: jobDefinitionId } = await createTestJob({
      objective: 'Verify message system indexing',
      context: 'Message system test - validates message creation and subgraph indexing for Work Protocol',
      instructions: 'Create a simple artifact acknowledging receipt of the message',
      acceptanceCriteria: 'Message is indexed in messages table with correct content and recipient',
      enabledTools: ['create_artifact'],
      message: testMessage
    });

    // Clear env variables after child job creation
    delete process.env.JINN_REQUEST_ID;
    delete process.env.JINN_JOB_DEFINITION_ID;

    // 3) Wait for request to be indexed
    await waitForRequestIndexed(gqlUrl, requestId);

    // 4) Wait for message to be indexed
    const message = await waitForMessage(gqlUrl, jobDefinitionId, testMessage, {
      maxAttempts: 15,
      delayMs: 2000
    });

    // 5) Verify message content, recipient, and lineage
    expect(message).toBeTruthy();
    expect(message.content).toBe(testMessage);
    expect(message.to).toBe(jobDefinitionId);
    expect(message.sourceJobDefinitionId).toBe(parentJobId);

    // 6) Dispatch existing job with different message
    const repostMessage = 'Repost message: different context for retry';
    const repostRes = await dispatchExistingJob({
      jobId: jobDefinitionId,
      message: repostMessage
    });
    const repostParsed = parseToolText(repostRes);
    expect(repostParsed?.meta?.ok).toBe(true);
    const repostRequestId: string = repostParsed?.data?.request_ids?.[0];
    expect(repostRequestId).toBeTruthy();

    // 7) Wait for second message to be indexed
    const repostMessage2 = await waitForMessage(gqlUrl, jobDefinitionId, repostMessage, {
      maxAttempts: 15,
      delayMs: 2000
    });

    // 8) Verify both messages indexed correctly
    expect(repostMessage2).toBeTruthy();
    expect(repostMessage2.content).toBe(repostMessage);
    expect(repostMessage2.to).toBe(jobDefinitionId);
    expect(repostMessage2.requestId).toBe(repostRequestId);

    // Both messages should have the same recipient but different content
    expect(message.to).toBe(repostMessage2.to);
    expect(message.content).not.toBe(repostMessage2.content);
  }, 60_000);
});
