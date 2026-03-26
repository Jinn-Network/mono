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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
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
  JINN_ROUTER_ABI,
} from '../src/adapters/mech/types.js';
import { MechAdapter } from '../src/adapters/mech/adapter.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

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

    // ── Phase 3: Restorer picks up and delivers via RestorerLoop + ClaudeRunner ──

    const { RestorerLoop } = await import('../src/daemon/restorer.js');
    const { ClaudeRunner } = await import('../src/runner/claude.js');
    const { Store } = await import('../src/store/store.js');

    const store = new Store(':memory:');
    const mockAgentPath = join(__dirname, 'mock-agent.sh');
    const runner = new ClaudeRunner({ claudePath: mockAgentPath });
    const restorer = new RestorerLoop(adapter!, runner, store);

    // Create the delivery iterator once — it is infinite and carries state
    const deliveryIter = adapter!.watchForDeliveries()[Symbol.asyncIterator]();

    results.push(
      await runPhase('Phase 3: Restorer picks up request and delivers via ClaudeRunner', async () => {
        if (!adapter || !restorationRequestId) throw new Error('Missing state from prior phases');

        // Mine blocks so the restorer sees the request
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Mine blocks continuously while processOne runs
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          // processOne: watchForRequests → ClaudeRunner → mock-agent.sh → submitResult
          const processed = await Promise.race([
            restorer.processOne(),
            sleep(60000).then(() => { throw new Error('restorer.processOne timed out after 60s'); }),
          ]);
          if (!processed) throw new Error('processOne returned false — no request found');
        } finally {
          clearInterval(miningInterval);
        }

        console.log('    RestorerLoop.processOne() completed');

        // Mine a block to confirm the delivery transaction
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify on-chain: mapRequestIdInfos should show a non-zero deliveryMech
        const info = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [restorationRequestId as Hex],
        }) as [string, string, string, bigint, bigint, string];

        const deliveryMech = info[1];
        if (deliveryMech === '0x0000000000000000000000000000000000000000') {
          throw new Error('deliveryMech is zero — delivery did not happen');
        }
        console.log(`    Delivery confirmed on-chain, deliveryMech: ${deliveryMech}`);
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
      await runPhase('Phase 5: Restorer picks up evaluation and delivers via ClaudeRunner', async () => {
        if (!adapter) throw new Error('Missing adapter');

        // Mine blocks so the restorer sees the evaluation request
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Mine blocks continuously while processOne runs
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          // processOne: watchForRequests yields evaluation → ClaudeRunner → mock-agent.sh → submitResult
          const processed = await Promise.race([
            restorer.processOne(),
            sleep(60000).then(() => { throw new Error('restorer.processOne timed out after 60s'); }),
          ]);
          if (!processed) throw new Error('processOne returned false — no evaluation request found');
        } finally {
          clearInterval(miningInterval);
        }

        console.log('    RestorerLoop.processOne() completed for evaluation');

        // Mine a block to confirm
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

    // ── Phase 7: Full daemon loop ──────────────────────────────────────────────

    results.push(
      await runPhase('Phase 7: Full daemon loop — all three concurrent loops', async () => {
        const { Daemon } = await import('../src/daemon/daemon.js');

        // Fresh adapter for daemon — independent state from phases 2-6
        const daemonAdapter = new MechAdapter({
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
        await daemonAdapter.initialize();

        const daemon = new Daemon({
          adapter: daemonAdapter,
          runner: new ClaudeRunner({ claudePath: mockAgentPath }),
          desiredStates: [{ id: 'daemon-e2e', description: 'Daemon full loop test' }],
          dbPath: ':memory:',
          shutdownTimeoutMs: 10000,
        });

        await daemon.start();
        console.log('    Daemon started with all three loops');

        // Mine blocks continuously so on-chain state advances
        const mineInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          // Record block before daemon activity for event scanning
          const startBlock = await publicClient.getBlockNumber();

          // Wait for the full cycle: restoration + evaluation both claimed
          await waitFor('Daemon completes full cycle', async () => {
            const currentBlock = await publicClient.getBlockNumber();
            if (currentBlock <= startBlock) return false;

            const logs = await publicClient.getLogs({
              address: ROUTER_ADDRESS,
              fromBlock: startBlock,
              toBlock: currentBlock,
            });

            let claimCount = 0;
            for (const log of logs) {
              try {
                const decoded = decodeEventLog({
                  abi: JINN_ROUTER_ABI,
                  data: log.data,
                  topics: log.topics,
                });
                if (decoded.eventName === 'DeliveryClaimed') claimCount++;
              } catch { /* not our event */ }
            }

            console.log(`    DeliveryClaimed events so far: ${claimCount}`);
            return claimCount >= 2;
          }, 120000, 3000);

          console.log('    Daemon completed full restoration + evaluation cycle');
        } finally {
          clearInterval(mineInterval);
          await daemon.stop();
          console.log('    Daemon stopped');
        }
      }),
    );

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
