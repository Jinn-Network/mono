/**
 * Integration Test: Control API Validation Gateway
 *
 * Tests the critical validation boundary between Worker → Control API → Supabase
 * Validates ARQ-005 and ARQ-008: Control API MUST validate requestId against Ponder
 * before allowing writes to Supabase.
 *
 * This test validates JINN-195 fix: Control API as validation gateway preventing
 * invalid lineage and malformed data from reaching the database.
 *
 * Architecture tested:
 * - Worker calls Control API (GraphQL mutations)
 * - Control API validates requestId exists in Ponder
 * - Control API injects lineage fields (request_id, worker_address)
 * - Control API writes to Supabase ONLY if validation passes
 *
 * What makes this a TRUE integration test:
 * ✅ Real Control API server (via ProcessHarness)
 * ✅ Real Supabase database (test schema or cleared tables)
 * ✅ Real Ponder for validation queries
 * ✅ Real HTTP requests (no mocks of boundary)
 * ❌ Mocked blockchain (use Tenderly VNet, not full node)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { withTestEnv } from '../../helpers/env-controller.js';
import { withProcessHarness } from '../../helpers/process-harness.js';
import { withTenderlyVNet } from '../../helpers/tenderly-runner.js';
import { withSuiteEnv } from '../../helpers/suite-env.js';
import { createGitFixture, type GitFixture } from '../../helpers/git-fixture.js';
import { createTestJob } from '../../helpers/mcp-client.js';
import { waitForRequestIndexed, waitForPonderReady } from '../../helpers/ponder-waiters.js';
import { getRequest } from '../../helpers/ponder-queries.js';
import fetch from 'cross-fetch';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPrivateKeyHttpSigner, type EthHttpSigner } from 'jinn-node/http/erc8128';
import { signRequest } from '@slicekit/erc8128';

describe.sequential('Control API: Validation Gateway Integration', () => {
  let gitFixture: GitFixture | null = null;

  // ERC-8128 test signer — ephemeral keypair generated per suite
  let testSigner: EthHttpSigner;
  let TEST_WORKER_ADDRESS: string;

  beforeAll(() => {
    gitFixture = createGitFixture();
    process.env.CODE_METADATA_REPO_ROOT = gitFixture.repoPath;

    // Generate an ephemeral private key for ERC-8128 signed auth in tests
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    testSigner = createPrivateKeyHttpSigner(privateKey, 8453);
    TEST_WORKER_ADDRESS = account.address;
  });

  afterAll(async () => {
    if (gitFixture) {
      gitFixture.cleanup();
      gitFixture = null;
    }
    delete process.env.CODE_METADATA_REPO_ROOT;
  });

  // Cleanup MCP client after each test to ensure new VNet RPC is picked up
  afterEach(async () => {
    // Force disconnect MCP client so next test gets fresh subprocess with correct RPC_URL
    const { disconnectMcpClient } = await import('../../helpers/mcp-client.js');
    await disconnectMcpClient();
  });

  /**
   * Helper to call Control API GraphQL mutation with ERC-8128 signed auth.
   *
   * If a custom signerOverride is provided, it is used instead of the suite-level
   * testSigner (useful for testing different worker addresses).
   */
  async function callControlApi(
    controlUrl: string,
    mutation: string,
    signerOverride?: EthHttpSigner
  ): Promise<any> {
    const signer = signerOverride ?? testSigner;
    const body = JSON.stringify({ query: mutation });
    const url = `${controlUrl}/graphql`;

    // Build a Request and sign it with ERC-8128
    const unsigned = new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const signed = await signRequest(unsigned, signer, {
      binding: 'request-bound',
      replay: 'non-replayable',
      ttlSeconds: 60,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: Object.fromEntries(signed.headers.entries()),
      body,
    });

    const result = await response.json();
    return result;
  }

  /**
   * Helper to query Supabase directly (bypass Control API)
   */
  function getSupabaseClient() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment');
    }

    return createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Test 1: Control API BLOCKS writes when requestId not found in Ponder
   *
   * This is the CRITICAL test from JINN-195 - validates that Control API
   * prevents invalid writes before they reach Supabase.
   */
  it('blocks claim when requestId not found in Ponder', async () => {
    await withSuiteEnv(async () => {
      await withTestEnv(async () => {
        // Use Tenderly VNet even though we don't dispatch - avoids Ponder startup timeout
        // The test just needs Ponder to be empty (no requests), which it will be
        await withTenderlyVNet(async (tenderly) => {
          await withProcessHarness(
            {
              rpcUrl: tenderly.rpcUrl,
              startWorker: false
            },
            async (ctx) => {
              console.log('[Test 1] Starting test: blocks claim when requestId not found');
              console.log('[Test 1] Ponder GQL URL:', ctx.gqlUrl);
              console.log('[Test 1] Control API URL:', ctx.controlUrl);

              // 1. Wait for Ponder to be ready (but empty - no requests seeded)
              console.log('[Test 1] Waiting for Ponder to be ready...');
              await waitForPonderReady(ctx.gqlUrl, { timeoutMs: 10000 });
              console.log('[Test 1] ✅ Ponder is ready');

              // 2. Attempt to claim a request that doesn't exist in Ponder
              const invalidRequestId = `0x${randomUUID().replace(/-/g, '')}`;
              console.log('[Test 1] Attempting to claim invalid request:', invalidRequestId);

              const result = await callControlApi(
                ctx.controlUrl,
                `
              mutation {
                claimRequest(requestId: "${invalidRequestId}") {
                  request_id
                  worker_address
                  status
                }
              }
            `
              );
              console.log('[Test 1] Control API response:', JSON.stringify(result, null, 2));

              // 3. Assert: Control API returned error
              expect(result.errors).toBeDefined();
              expect(result.errors.length).toBeGreaterThan(0);
              // Control API returns generic "Unexpected error." for validation failures
              // The actual validation error is logged but not exposed to client
              expect(result.errors[0].message).toBeDefined();
              console.log('[Test 1] ✅ Control API correctly blocked invalid request');

              // 4. Assert: NO write occurred in Supabase
              const supabase = getSupabaseClient();
              const { data: claims } = await supabase
                .from('onchain_request_claims')
                .select('*')
                .eq('request_id', invalidRequestId);

              expect(claims).toHaveLength(0); // Critical: No database pollution!
              console.log('[Test 1] ✅ No database pollution - test passed!');
            }
          );
        });
      });
    });
  }, 30000); // 30s timeout (reduced from 60s for faster feedback)

  /**
   * Test 2: Control API ALLOWS writes when requestId exists in Ponder
   *
   * Validates the happy path: valid requestId → validation passes → write succeeds
   */
  it('allows claim when requestId exists in Ponder', async () => {
    await withSuiteEnv(async () => {
      await withTestEnv(async () => {
        await withTenderlyVNet(async (tenderly) => {
          await withProcessHarness(
            {
              rpcUrl: tenderly.rpcUrl,
              startWorker: false
            },
            async (ctx) => {
              // 1. Wait for Ponder to be ready
              await waitForPonderReady(ctx.gqlUrl, { timeoutMs: 60000 });

              // 2. Create a real test job via MCP (dispatches to blockchain)
              const { requestId, jobDefId } = await createTestJob({
                blueprint: JSON.stringify({
                  assertions: [{
                    id: 'TEST-001',
                    assertion: 'Validate Control API allows writes for valid requests',
                    examples: { do: ['Test validation gateway'], dont: ['Skip validation'] },
                    commentary: 'Integration test for Control API validation gateway - Control API accepts claim and writes to Supabase'
                  }]
                })
              });

              console.log(`[Test 2] Created test job: ${jobDefId}, request: ${requestId}`);

              // 3. Wait for Ponder to index the request
              await waitForRequestIndexed(ctx.gqlUrl, requestId, { timeoutMs: 45000 });

              // 4. Verify request exists in Ponder before calling Control API
              const ponderRequest = await getRequest(ctx.gqlUrl, requestId);
              expect(ponderRequest).toBeTruthy();
              expect(ponderRequest?.id).toBe(requestId);

              // 5. Call Control API to claim the request
              const result = await callControlApi(ctx.controlUrl, `
              mutation {
                claimRequest(requestId: "${requestId}") {
                  request_id
                  worker_address
                  status
                }
              }
            `);

              // 6. Assert: Control API accepted the claim (no errors)
              expect(result.errors).toBeUndefined();
              expect(result.data?.claimRequest).toBeDefined();
              expect(result.data.claimRequest.request_id).toBe(requestId);
              expect(result.data.claimRequest.worker_address).toBe(TEST_WORKER_ADDRESS);

              // 7. Assert: Write occurred in Supabase
              const supabase = getSupabaseClient();
              const { data: claims, error } = await supabase
                .from('onchain_request_claims')
                .select('*')
                .eq('request_id', requestId);

              expect(error).toBeNull();
              expect(claims).toHaveLength(1);
              expect(claims![0].request_id).toBe(requestId);
              expect(claims![0].worker_address).toBe(TEST_WORKER_ADDRESS);
            }
          );
        });
      });
    });
  }, 240000); // 240s timeout for Git + Tenderly + Ponder + job creation

  /**
   * Test 3: Control API handles idempotent claims correctly
   *
   * Validates that claiming the same request twice doesn't create duplicates.
   * Tests ON CONFLICT DO NOTHING logic in Supabase.
   */
  it('handles idempotent claims (same request claimed twice)', async () => {
    await withSuiteEnv(async () => {
      await withTestEnv(async () => {
        await withTenderlyVNet(async (tenderly) => {
          await withProcessHarness(
            {
              rpcUrl: tenderly.rpcUrl,
              startWorker: false
            },
            async (ctx) => {
              // 1. Wait for Ponder to be ready
              await waitForPonderReady(ctx.gqlUrl, { timeoutMs: 60000 });

              // 2. Create a real test job via MCP
              const { requestId, jobDefId } = await createTestJob({
                blueprint: JSON.stringify({
                  assertions: [{
                    id: 'TEST-002',
                    assertion: 'Test idempotent claims in Control API',
                    examples: { do: ['Test idempotency'], dont: ['Create duplicates'] },
                    commentary: 'Integration test for idempotency handling - Same request can be claimed multiple times without duplicates'
                  }]
                })
              });

              console.log(`[Test 3] Created test job: ${jobDefId}, request: ${requestId}`);

              // 3. Wait for Ponder to index the request
              await waitForRequestIndexed(ctx.gqlUrl, requestId, { timeoutMs: 45000 });

              const claimMutation = `
              mutation {
                claimRequest(requestId: "${requestId}") {
                  request_id
                  worker_address
                  status
                }
              }
            `;

              // 4. Claim the request FIRST time
              const result1 = await callControlApi(ctx.controlUrl, claimMutation);
              expect(result1.errors).toBeUndefined();
              expect(result1.data?.claimRequest?.request_id).toBe(requestId);
              console.log('[Test 3] First claim succeeded');

              // 5. Claim the request SECOND time (idempotent operation)
              const result2 = await callControlApi(ctx.controlUrl, claimMutation);
              expect(result2.errors).toBeUndefined();
              expect(result2.data?.claimRequest?.request_id).toBe(requestId);
              console.log('[Test 3] Second claim succeeded (idempotent)');

              // 6. Verify only ONE claim in database (no duplicates)
              const supabase = getSupabaseClient();
              const { data: claims, error } = await supabase
                .from('onchain_request_claims')
                .select('*')
                .eq('request_id', requestId);

              expect(error).toBeNull();
              expect(claims).toHaveLength(1); // Critical: Only ONE claim!
              expect(claims![0].request_id).toBe(requestId);
              expect(claims![0].worker_address).toBe(TEST_WORKER_ADDRESS);

              console.log('[Test 3] Verified: Only 1 claim in database (idempotency works!)');
            }
          );
        });
      });
    });
  }, 240000); // 240s timeout

  /**
   * Test 4: Control API injects lineage fields automatically
   *
   * Validates that request_id and worker_address are injected by Control API,
   * not manually constructed by worker.
   */
  it('injects lineage fields (request_id, worker_address)', async () => {
    await withSuiteEnv(async () => {
      await withTestEnv(async () => {
        await withTenderlyVNet(async (tenderly) => {
          await withProcessHarness(
            {
              rpcUrl: tenderly.rpcUrl,
              startWorker: false
            },
            async (ctx) => {
              // 1. Wait for Ponder to be ready
              await waitForPonderReady(ctx.gqlUrl, { timeoutMs: 60000 });

              // 2. Create a real test job via MCP
              const { requestId, jobDefId } = await createTestJob({
                blueprint: JSON.stringify({
                  assertions: [{
                    id: 'TEST-003',
                    assertion: 'Test Control API lineage field injection',
                    examples: { do: ['Test lineage tracking'], dont: ['Skip lineage fields'] },
                    commentary: 'Integration test for automatic lineage tracking - Control API injects request_id and worker_address automatically'
                  }]
                })
              });

              console.log(`[Test 4] Created test job: ${jobDefId}, request: ${requestId}`);

              // 3. Wait for Ponder to index the request (increased timeout for 4th test due to cumulative load)
              await waitForRequestIndexed(ctx.gqlUrl, requestId, { timeoutMs: 60000 });

              // 4. Call Control API - NOTE: We do NOT pass request_id or worker_address as parameters
              // ERC-8128 signature carries the worker address cryptographically
              const result = await callControlApi(
                ctx.controlUrl,
                `
                mutation {
                  claimRequest(requestId: "${requestId}") {
                    request_id
                    worker_address
                    status
                  }
                }
              `
              );

              expect(result.errors).toBeUndefined();
              expect(result.data?.claimRequest).toBeDefined();

              // 5. Verify lineage fields were INJECTED by Control API (not sent by worker)
              const supabase = getSupabaseClient();
              const { data: claims, error } = await supabase
                .from('onchain_request_claims')
                .select('*')
                .eq('request_id', requestId);

              expect(error).toBeNull();
              expect(claims).toHaveLength(1);

              // 6. Assert: request_id and worker_address were injected correctly
              const claim = claims![0];
              expect(claim.request_id).toBe(requestId);
              expect(claim.worker_address).toBe(TEST_WORKER_ADDRESS);

              // 7. Additional assertions on injected fields
              expect(claim.request_id).toMatch(/^0x[0-9a-f]{64}$/); // Valid hex string
              expect(claim.worker_address).toMatch(/^0x[0-9a-f]{40}$/i); // Valid Ethereum address

              console.log('[Test 4] Verified: Lineage fields injected correctly!');
              console.log(`  - request_id: ${claim.request_id}`);
              console.log(`  - worker_address: ${claim.worker_address}`);
            }
          );
        });
      });
    });
  }, 240000); // 240s timeout

  /**
   * Test 5: Control API allows re-claiming stale jobs (>5 minutes old)
   *
   * Validates that jobs stuck IN_PROGRESS for >5 minutes can be reclaimed by another worker.
   * Tests fix for JINN-xxx: Stale claim detection and re-claiming.
   */
  it('allows re-claiming stale jobs (IN_PROGRESS >5 minutes)', async () => {
    await withSuiteEnv(async () => {
      await withTestEnv(async () => {
        await withTenderlyVNet(async (tenderly) => {
          await withProcessHarness(
            {
              rpcUrl: tenderly.rpcUrl,
              startWorker: false
            },
            async (ctx) => {
              // 1. Wait for Ponder to be ready
              await waitForPonderReady(ctx.gqlUrl, { timeoutMs: 60000 });

              // 2. Create a real test job via MCP
              const { requestId, jobDefId } = await createTestJob({
                blueprint: JSON.stringify({
                  assertions: [{
                    id: 'TEST-004',
                    assertion: 'Test Control API allows re-claiming stale jobs',
                    examples: { do: ['Test stale detection'], dont: ['Block re-claims'] },
                    commentary: 'Integration test for stale claim handling - Jobs stuck >5 minutes can be reclaimed'
                  }]
                })
              });

              console.log(`[Test 5] Created test job: ${jobDefId}, request: ${requestId}`);

              // 3. Wait for Ponder to index the request
              await waitForRequestIndexed(ctx.gqlUrl, requestId, { timeoutMs: 45000 });

              const supabase = getSupabaseClient();

              // 4. Manually insert a stale claim (>5 minutes old, IN_PROGRESS)
              const STALE_WORKER = '0x9999999999999999999999999999999999999999';
              const FIVE_MINUTES_AGO = new Date(Date.now() - 5.5 * 60 * 1000).toISOString(); // 5.5 minutes ago

              const { error: insertError } = await supabase
                .from('onchain_request_claims')
                .upsert({
                  request_id: requestId,
                  worker_address: STALE_WORKER,
                  status: 'IN_PROGRESS',
                  claimed_at: FIVE_MINUTES_AGO,
                  completed_at: null
                }, { onConflict: 'request_id' });

              expect(insertError).toBeNull();
              console.log('[Test 5] Inserted stale claim (>5 min old)');

              // 5. Verify stale claim exists
              const { data: beforeClaim } = await supabase
                .from('onchain_request_claims')
                .select('*')
                .eq('request_id', requestId)
                .single();

              expect(beforeClaim).toBeTruthy();
              expect(beforeClaim!.worker_address).toBe(STALE_WORKER);
              expect(beforeClaim!.status).toBe('IN_PROGRESS');
              console.log(`[Test 5] Confirmed stale claim: worker=${STALE_WORKER}, age=${Math.floor((Date.now() - new Date(beforeClaim!.claimed_at).getTime()) / 60000)} minutes`);

              // 6. Attempt to claim with NEW worker (should succeed for stale claims)
              const newWorkerKey = generatePrivateKey();
              const newWorkerAccount = privateKeyToAccount(newWorkerKey);
              const NEW_WORKER = newWorkerAccount.address;
              const newWorkerSigner = createPrivateKeyHttpSigner(newWorkerKey, 8453);
              const result = await callControlApi(
                ctx.controlUrl,
                `
                mutation {
                  claimRequest(requestId: "${requestId}") {
                    request_id
                    worker_address
                    status
                    claimed_at
                  }
                }
              `,
                newWorkerSigner
              );

              // 7. Assert: Control API accepted re-claim (no "already claimed" error)
              expect(result.errors).toBeUndefined();
              expect(result.data?.claimRequest).toBeDefined();
              expect(result.data.claimRequest.request_id).toBe(requestId);
              expect(result.data.claimRequest.worker_address).toBe(NEW_WORKER);
              console.log('[Test 5] Re-claim succeeded!');

              // 8. Assert: Supabase record updated with new worker and fresh claimed_at
              const { data: afterClaim, error: fetchError } = await supabase
                .from('onchain_request_claims')
                .select('*')
                .eq('request_id', requestId)
                .single();

              expect(fetchError).toBeNull();
              expect(afterClaim).toBeTruthy();
              expect(afterClaim!.worker_address).toBe(NEW_WORKER);
              expect(afterClaim!.status).toBe('IN_PROGRESS');

              // 9. Assert: claimed_at was updated to a fresh timestamp
              const newClaimedAt = new Date(afterClaim!.claimed_at);
              const oldClaimedAt = new Date(FIVE_MINUTES_AGO);
              expect(newClaimedAt.getTime()).toBeGreaterThan(oldClaimedAt.getTime());
              expect(Date.now() - newClaimedAt.getTime()).toBeLessThan(60000); // Claimed within last minute

              console.log('[Test 5] Verified: Stale job successfully reclaimed!');
              console.log(`  - Old worker: ${STALE_WORKER}`);
              console.log(`  - New worker: ${NEW_WORKER}`);
              console.log(`  - Old claimed_at: ${oldClaimedAt.toISOString()}`);
              console.log(`  - New claimed_at: ${newClaimedAt.toISOString()}`);
            }
          );
        });
      });
    });
  }, 240000); // 240s timeout

  /**
   * Test 6: Control API blocks re-claiming fresh jobs (<5 minutes)
   *
   * Validates that jobs claimed recently (<5 minutes) cannot be stolen by another worker.
   * Ensures the 5-minute threshold is enforced correctly.
   */
  it('blocks re-claiming fresh jobs (IN_PROGRESS <5 minutes)', async () => {
    await withSuiteEnv(async () => {
      await withTestEnv(async () => {
        await withTenderlyVNet(async (tenderly) => {
          await withProcessHarness(
            {
              rpcUrl: tenderly.rpcUrl,
              startWorker: false
            },
            async (ctx) => {
              // 1. Wait for Ponder to be ready
              await waitForPonderReady(ctx.gqlUrl, { timeoutMs: 60000 });

              // 2. Create a real test job via MCP
              const { requestId, jobDefId } = await createTestJob({
                blueprint: JSON.stringify({
                  assertions: [{
                    id: 'TEST-005',
                    assertion: 'Test Control API blocks stealing fresh jobs',
                    examples: { do: ['Test fresh claim protection'], dont: ['Allow job theft'] },
                    commentary: 'Integration test for fresh claim protection - Jobs <5 minutes cannot be stolen'
                  }]
                })
              });

              console.log(`[Test 6] Created test job: ${jobDefId}, request: ${requestId}`);

              // 3. Wait for Ponder to index the request
              await waitForRequestIndexed(ctx.gqlUrl, requestId, { timeoutMs: 45000 });

              // 4. Claim the job with FIRST worker
              const firstWorkerKey = generatePrivateKey();
              const firstWorkerAccount = privateKeyToAccount(firstWorkerKey);
              const FIRST_WORKER = firstWorkerAccount.address;
              const firstWorkerSigner = createPrivateKeyHttpSigner(firstWorkerKey, 8453);
              const result1 = await callControlApi(
                ctx.controlUrl,
                `
                mutation {
                  claimRequest(requestId: "${requestId}") {
                    request_id
                    worker_address
                    status
                  }
                }
              `,
                firstWorkerSigner
              );

              expect(result1.errors).toBeUndefined();
              expect(result1.data?.claimRequest?.worker_address).toBe(FIRST_WORKER);
              console.log('[Test 6] First worker claimed job');

              // 5. Attempt to claim with SECOND worker (should return existing claim)
              const secondWorkerKey = generatePrivateKey();
              const secondWorkerAccount = privateKeyToAccount(secondWorkerKey);
              const SECOND_WORKER = secondWorkerAccount.address;
              const secondWorkerSigner = createPrivateKeyHttpSigner(secondWorkerKey, 8453);
              const result2 = await callControlApi(
                ctx.controlUrl,
                `
                mutation {
                  claimRequest(requestId: "${requestId}") {
                    request_id
                    worker_address
                    status
                  }
                }
              `,
                secondWorkerSigner
              );

              // 6. Assert: Control API returned existing claim (not an error, but not reassigned)
              expect(result2.errors).toBeUndefined();
              expect(result2.data?.claimRequest).toBeDefined();
              expect(result2.data.claimRequest.worker_address).toBe(FIRST_WORKER); // Still owned by FIRST_WORKER

              // 7. Verify in Supabase
              const supabase = getSupabaseClient();
              const { data: claim } = await supabase
                .from('onchain_request_claims')
                .select('*')
                .eq('request_id', requestId)
                .single();

              expect(claim).toBeTruthy();
              expect(claim!.worker_address).toBe(FIRST_WORKER); // Not reassigned

              console.log('[Test 6] Verified: Fresh job protected from theft!');
              console.log(`  - Owner: ${FIRST_WORKER}`);
              console.log(`  - Attempted thief: ${SECOND_WORKER} (blocked)`);
            }
          );
        });
      });
    });
  }, 240000); // 240s timeout
});
