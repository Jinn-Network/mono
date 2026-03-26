/**
 * End-to-end validation script for the JinnRouter production flow on a Base
 * mainnet fork (via Anvil).
 *
 * Validates the complete lifecycle:
 *   Creator posts -> router.createRestorationJob -> marketplace
 *   Restorer picks up -> delivers
 *   Creator claims -> router.claimDelivery -> creates evaluation
 *   Restorer picks up evaluation -> delivers
 *   Creator claims evaluation -> done
 *
 * Uses real IPFS, real JinnRouter, real operator credentials.
 *
 * Usage: npx tsx scripts/e2e-validate.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import {
  decodeMarketplaceRequestLogs,
} from '../src/adapters/mech/contracts.js';
import {
  MECH_MARKETPLACE_ABI,
  MECH_ABI,
  JINN_ROUTER_ABI,
} from '../src/adapters/mech/types.js';
import { MechAdapter } from '../src/adapters/mech/adapter.js';
import {
  uploadToIpfs,
  cidToDigestHex,
  buildResultPayload,
} from '../src/adapters/mech/ipfs.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const ANVIL_PORT = 8546;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

const MARKETPLACE_ADDRESS: Address = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const ROUTER_ADDRESS: Address = '0xfFa7118A3D820cd4E820010837D65FAfF463181B';
const MECH_ADDRESS: Address = '0xD03d75D3B59Ac252F2e8C7Bf4617cf91a102E613';
const OPERATOR_SAFE_ADDRESS: Address = '0x608d976Da1Dd9BC53aeA87Abe74e1306Ab96280c';

const OPERATOR_EOA_KEY: Hex | '' = (process.env['OPERATOR_EOA_KEY'] ?? '') as Hex | '';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${description}`);
}

async function jsonRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`RPC error (${method}): ${body.error.message}`);
  return body.result;
}

// ── Phase runner ─────────────────────────────────────────────────────────────

interface PhaseResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

async function runPhase(name: string, fn: () => Promise<void>): Promise<PhaseResult> {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`  ✓ ${name} (${ms}ms)`);
    return { name, ok: true, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name} (${ms}ms): ${error}`);
    return { name, ok: false, ms, error };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Jinn-Client E2E Validation (JinnRouter Production Flow) ===\n');

  // Check for operator credentials early
  if (!OPERATOR_EOA_KEY) {
    console.log('Set OPERATOR_EOA_KEY to run e2e');
    process.exit(0);
  }

  let anvil: ChildProcess | null = null;
  const results: PhaseResult[] = [];

  // Shared state populated across phases
  let publicClient: PublicClient;
  let adapter: MechAdapter | undefined;
  let restorationRequestId: string | undefined;

  try {
    // ── Phase 1: Infrastructure ──────────────────────────────────────────────

    results.push(
      await runPhase('Phase 1: Infrastructure — spawn Anvil fork, fund accounts', async () => {
        const anvilPath = process.env['ANVIL_PATH'] ?? 'anvil';
        anvil = spawn(anvilPath, [
          '--fork-url', BASE_RPC_URL,
          '--port', String(ANVIL_PORT),
          '--silent',
        ], {
          stdio: 'ignore',
          detached: false,
        });

        anvil.on('error', (err) => {
          throw new Error(`Failed to spawn Anvil: ${err.message}`);
        });

        // Wait for Anvil to be ready
        await waitFor('Anvil RPC ready', async () => {
          try {
            const blockNum = await jsonRpc(ANVIL_RPC, 'eth_blockNumber');
            return typeof blockNum === 'string' && blockNum.startsWith('0x');
          } catch {
            return false;
          }
        });

        publicClient = createPublicClient({
          chain: base,
          transport: http(ANVIL_RPC),
        }) as unknown as PublicClient;

        const blockNumber = await publicClient.getBlockNumber();
        console.log(`    Anvil forked at block ${blockNumber}`);

        // Fund operator EOA and Safe
        const { privateKeyToAccount } = await import('viem/accounts');
        const operatorAccount = privateKeyToAccount(OPERATOR_EOA_KEY as Hex);
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorAccount.address, '0x56BC75E2D63100000']); // 100 ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [OPERATOR_SAFE_ADDRESS, '0x56BC75E2D63100000']); // 100 ETH
        console.log(`    Funded operator EOA (${operatorAccount.address}) and Safe (${OPERATOR_SAFE_ADDRESS})`);

        // Create adapter
        adapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          mechContractAddress: MECH_ADDRESS,
          safeAddress: OPERATOR_SAFE_ADDRESS,
          agentEoaPrivateKey: OPERATOR_EOA_KEY as Hex,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
        });
        await adapter.initialize();
        console.log('    MechAdapter initialized');
      }),
    );

    // ── Phase 2: Creator posts desired state ─────────────────────────────────

    results.push(
      await runPhase('Phase 2: Creator posts desired state', async () => {
        if (!adapter) throw new Error('No adapter from Phase 1');

        restorationRequestId = await adapter.postDesiredState({
          id: 'e2e-test',
          description: 'E2E router flow test',
          type: 'restoration',
          attemptId: 'e2e-test/1',
          attemptNumber: 1,
        });

        // Mine a block to make events visible
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        console.log(`    requestId: ${restorationRequestId}`);

        // Verify MarketplaceRequest event on marketplace
        const currentBlock = await publicClient.getBlockNumber();
        const logs = await publicClient.getLogs({
          address: MARKETPLACE_ADDRESS,
          fromBlock: currentBlock - 5n,
          toBlock: currentBlock,
        });
        const decoded = decodeMarketplaceRequestLogs(logs);
        if (decoded.length === 0) {
          throw new Error('No MarketplaceRequest event found');
        }

        const found = decoded.find(d => d.requestId === restorationRequestId);
        if (!found) {
          throw new Error(`MarketplaceRequest event not found for requestId ${restorationRequestId}`);
        }
        console.log('    MarketplaceRequest event verified on-chain');

        // Verify adapter's pendingEvaluations has the requestId
        const adapterAny = adapter as unknown as { pendingEvaluations: Map<string, unknown> };
        if (!adapterAny.pendingEvaluations.has(restorationRequestId)) {
          throw new Error('pendingEvaluations does not contain the requestId');
        }
        console.log('    pendingEvaluations tracking confirmed');
      }),
    );

    // ── Phase 3: Restorer picks up request and delivers ──────────────────────

    // Create the generators once — they are infinite and carry state
    const requestIter = adapter!.watchForRequests()[Symbol.asyncIterator]();
    const deliveryIter = adapter!.watchForDeliveries()[Symbol.asyncIterator]();

    results.push(
      await runPhase('Phase 3: Restorer picks up request and delivers', async () => {
        if (!adapter || !restorationRequestId) throw new Error('Missing state from prior phases');

        // Mine blocks to advance past the cursor
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Start watching for requests with timeout
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let request: Awaited<ReturnType<typeof requestIter.next>>;
        try {
          request = await Promise.race([
            requestIter.next(),
            sleep(20000).then(() => { throw new Error('watchForRequests timed out after 20s'); }),
          ]);
        } finally {
          clearInterval(miningInterval);
        }

        if (request.done || !request.value) throw new Error('watchForRequests ended unexpectedly');
        const req = request.value;

        if (!req.desiredState.description.includes('E2E router flow test')) {
          throw new Error(`Expected description containing "E2E router flow test", got "${req.desiredState.description}"`);
        }
        console.log(`    watchForRequests yielded requestId: ${req.requestId}`);
        console.log(`    description: "${req.desiredState.description}"`);

        // Read mech operator
        const mechOperator = await publicClient.readContract({
          address: MECH_ADDRESS,
          abi: MECH_ABI,
          functionName: 'getOperator',
        }) as Address;
        console.log(`    Mech operator: ${mechOperator}`);

        // Fund and impersonate operator
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [mechOperator, '0x56BC75E2D63100000']);
        await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [mechOperator]);

        const operatorWallet = createWalletClient({
          chain: base,
          transport: http(ANVIL_RPC),
          account: mechOperator,
        });

        // Build mock delivery data — upload to real IPFS and get CID digest
        const deliveryPayload = buildResultPayload(restorationRequestId, {
          data: 'E2E mock restoration delivery',
        });
        const deliveryCid = await uploadToIpfs('https://registry.autonolas.tech', deliveryPayload);
        const deliveryDigest = cidToDigestHex(deliveryCid);

        // Call AgentMech.deliverToMarketplace as impersonated operator
        const deliverHash = await operatorWallet.writeContract({
          address: MECH_ADDRESS,
          abi: MECH_ABI,
          functionName: 'deliverToMarketplace',
          args: [[restorationRequestId as Hex], [deliveryDigest]],
        });

        await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [mechOperator]);

        const deliverReceipt = await publicClient.waitForTransactionReceipt({ hash: deliverHash });
        if (deliverReceipt.status !== 'success') throw new Error('Deliver transaction reverted');

        // Verify Deliver event in receipt
        let hasDeliverEvent = false;
        for (const log of deliverReceipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: MECH_ABI,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === 'Deliver') hasDeliverEvent = true;
          } catch { /* not our event */ }
        }
        if (!hasDeliverEvent) throw new Error('No Deliver event in receipt');
        console.log('    Deliver event confirmed in receipt');

        // Mine a block
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      }),
    );

    // ── Phase 4: Creator claims delivery + creates evaluation ────────────────

    results.push(
      await runPhase('Phase 4: Creator claims delivery + creates evaluation', async () => {
        if (!adapter || !restorationRequestId) throw new Error('Missing state from prior phases');

        // Mine blocks periodically to advance chain state
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
        try {
          delivery = await Promise.race([
            deliveryIter.next(),
            sleep(20000).then(() => { throw new Error('watchForDeliveries timed out after 20s'); }),
          ]);
        } finally {
          clearInterval(miningInterval);
        }

        if (delivery.done || !delivery.value) throw new Error('watchForDeliveries ended unexpectedly');
        const del = delivery.value;

        // Verify delivered result
        if (del.requestId !== restorationRequestId) {
          throw new Error(`Expected requestId ${restorationRequestId}, got ${del.requestId}`);
        }
        if (del.desiredState.type !== 'restoration') {
          throw new Error(`Expected type 'restoration', got '${del.desiredState.type}'`);
        }
        if (!del.result.data) {
          throw new Error('Expected result.data to be present');
        }
        console.log(`    Delivery claimed for requestId: ${del.requestId}`);
        console.log(`    desiredState.type: ${del.desiredState.type}`);
        console.log(`    result.data: "${del.result.data.slice(0, 80)}"`);

        // Mine to ensure evaluation creation tx is confirmed
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify EvaluationJobCreated event from the router
        const currentBlock = await publicClient.getBlockNumber();
        const routerLogs = await publicClient.getLogs({
          address: ROUTER_ADDRESS,
          fromBlock: currentBlock - 10n,
          toBlock: currentBlock,
        });

        let foundEvalJob = false;
        for (const log of routerLogs) {
          try {
            const decoded = decodeEventLog({
              abi: JINN_ROUTER_ABI,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === 'EvaluationJobCreated') {
              foundEvalJob = true;
              console.log('    EvaluationJobCreated event confirmed on-chain');
            }
          } catch { /* not our event */ }
        }
        if (!foundEvalJob) {
          throw new Error('No EvaluationJobCreated event found on router');
        }
      }),
    );

    // ── Phase 5: Restorer picks up evaluation and delivers ───────────────────

    results.push(
      await runPhase('Phase 5: Restorer picks up evaluation and delivers', async () => {
        if (!adapter) throw new Error('Missing adapter');

        // Mine blocks to advance
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let request: Awaited<ReturnType<typeof requestIter.next>>;
        try {
          request = await Promise.race([
            requestIter.next(),
            sleep(20000).then(() => { throw new Error('watchForRequests timed out after 20s'); }),
          ]);
        } finally {
          clearInterval(miningInterval);
        }

        if (request.done || !request.value) throw new Error('watchForRequests ended unexpectedly');
        const req = request.value;

        console.log(`    watchForRequests yielded evaluation request: ${req.requestId}`);
        console.log(`    type: ${req.desiredState.type}`);

        if (req.desiredState.type !== 'evaluation') {
          throw new Error(`Expected type 'evaluation', got '${req.desiredState.type}'`);
        }

        // Read mech operator
        const mechOperator = await publicClient.readContract({
          address: MECH_ADDRESS,
          abi: MECH_ABI,
          functionName: 'getOperator',
        }) as Address;

        // Impersonate mech operator and deliver evaluation
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [mechOperator, '0x56BC75E2D63100000']);
        await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [mechOperator]);

        const operatorWallet = createWalletClient({
          chain: base,
          transport: http(ANVIL_RPC),
          account: mechOperator,
        });

        // Build evaluation delivery data — upload to real IPFS
        const evalPayload = buildResultPayload(req.requestId, {
          data: JSON.stringify({ verdict: 'pass', score: 0.95 }),
        });
        const evalCid = await uploadToIpfs('https://registry.autonolas.tech', evalPayload);
        const evalDigest = cidToDigestHex(evalCid);

        const deliverHash = await operatorWallet.writeContract({
          address: MECH_ADDRESS,
          abi: MECH_ABI,
          functionName: 'deliverToMarketplace',
          args: [[req.requestId as Hex], [evalDigest]],
        });

        await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [mechOperator]);

        const deliverReceipt = await publicClient.waitForTransactionReceipt({ hash: deliverHash });
        if (deliverReceipt.status !== 'success') throw new Error('Evaluation deliver tx reverted');
        console.log('    Evaluation delivery submitted');

        // Mine a block
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      }),
    );

    // ── Phase 6: Creator claims evaluation delivery ──────────────────────────

    results.push(
      await runPhase('Phase 6: Creator claims evaluation delivery', async () => {
        if (!adapter) throw new Error('Missing adapter');

        // Mine blocks periodically
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
        try {
          delivery = await Promise.race([
            deliveryIter.next(),
            sleep(20000).then(() => { throw new Error('watchForDeliveries timed out after 20s'); }),
          ]);
        } finally {
          clearInterval(miningInterval);
        }

        if (delivery.done || !delivery.value) throw new Error('watchForDeliveries ended unexpectedly');
        const del = delivery.value;

        if (del.desiredState.type !== 'evaluation') {
          throw new Error(`Expected type 'evaluation', got '${del.desiredState.type}'`);
        }
        console.log(`    Evaluation delivery claimed for requestId: ${del.requestId}`);
        console.log(`    desiredState.type: ${del.desiredState.type}`);

        // Verify tracking is clean
        const adapterAny = adapter as unknown as {
          pendingEvaluations: Map<string, unknown>;
          pendingEvaluationClaims: Set<string>;
        };
        if (adapterAny.pendingEvaluationClaims.size !== 0) {
          throw new Error(`Expected pendingEvaluationClaims to be empty, got ${adapterAny.pendingEvaluationClaims.size}`);
        }
        console.log('    pendingEvaluationClaims is empty — lifecycle complete');
      }),
    );

    // ── Phase 7: Full daemon loop (skipped) ──────────────────────────────────
    // The step-by-step phases 2-6 already validate the complete flow.
    // A full daemon test with impersonation + real signing is complex and
    // deferred as a follow-up.

  } finally {
    // ── Phase 8: Cleanup ─────────────────────────────────────────────────────

    results.push(
      await runPhase('Phase 8: Cleanup', async () => {
        if (adapter) {
          await adapter.stop().catch(() => {});
          console.log('    Adapter stopped');
        }
        if (anvil) {
          anvil.kill('SIGTERM');
          await sleep(500);
          if (!anvil.killed) {
            anvil.kill('SIGKILL');
          }
          console.log('    Anvil process terminated');
        }
      }),
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('\n=== Summary ===\n');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const detail = r.error ? ` — ${r.error}` : '';
    console.log(`  ${icon} ${r.name} (${r.ms}ms)${detail}`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed (${totalMs}ms total)\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
