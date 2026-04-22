/**
 * e2e-prediction-apy-v0.ts — production-shaped full loop for prediction.apy.v0.
 *
 * This exercises the same adapter-driven lifecycle as production:
 * create restoration job -> watch/claim -> run baseline -> deliver ->
 * watch delivery -> auto-create evaluation job -> watch/claim eval ->
 * run evaluator -> deliver verdict -> watch eval delivery + cleanup.
 */

import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPublicClient, decodeEventLog, encodeAbiParameters, getAddress, http, keccak256, numberToHex, pad, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { MechAdapter } from '../src/adapters/mech/adapter.js';
import { FleetBootstrapper } from '../src/earning/bootstrap.js';
import { getChainConfig } from '../src/earning/contracts.js';
import { decodeMarketplaceRequestLogs, getMechDeliveryRate, getTimeoutBounds, submitRestorationJob } from '../src/adapters/mech/contracts.js';
import { buildDesiredStatePayload, uploadToIpfs, cidToDigestHex } from '../src/adapters/mech/ipfs.js';
import { createClients } from '../src/adapters/mech/safe.js';
import { PredictionApyV0BaselineImpl } from '../src/restorer/impls/prediction-apy-v0-baseline/index.js';
import { PredictionApyV0Evaluator } from '../src/restorer/impls/prediction-apy-v0-evaluator/index.js';
import { signCanonical } from '../src/restorer/engine/signing.js';
import { RESTORATION_INTENT_CID_CONTEXT_KEY } from '../src/restorer/impls/evaluation-context.js';
import type { DesiredState } from '../src/types/desired-state.js';
import type { RestorationContext } from '../src/restorer/types.js';
import type { PredictionApySubmissionManifest } from '../src/types/prediction-apy.js';
import { JINN_ROUTER_ABI, MECH_ABI, MECH_MARKETPLACE_ABI, NATIVE_PAYMENT_TYPE } from '../src/adapters/mech/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const ANVIL_PORT = 8549;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const PASSWORD = 'test-password-pred-apy';

const CHAIN_CONFIG = getChainConfig('base');
const OLAS_TOKEN = CHAIN_CONFIG.olasToken;
const MARKETPLACE_ADDRESS: Address = CHAIN_CONFIG.mechMarketplace as Address;
const ROUTER_ADDRESS: Address = '0xfFa7118A3D820cd4E820010837D65FAfF463181B';

interface PhaseResult { name: string; ok: boolean; ms: number; error?: string }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(description: string, check: () => Promise<boolean>, timeoutMs = 30_000, intervalMs = 500): Promise<void> {
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

function erc20BalanceSlot(holder: string, mappingSlot: bigint = 0n): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(holder) as Address, mappingSlot]));
}

function makeAdapter(agentPk: `0x${string}`, safe: Address, mech: Address): MechAdapter {
  return new MechAdapter({
    rpcUrl: ANVIL_RPC,
    mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
    routerAddress: ROUTER_ADDRESS as `0x${string}`,
    mechContractAddress: mech as `0x${string}`,
    safeAddress: safe as `0x${string}`,
    agentEoaPrivateKey: agentPk,
    ipfsRegistryUrl: 'https://registry.autonolas.tech',
    ipfsGatewayUrl: 'https://gateway.autonolas.tech',
    pollIntervalMs: 500,
    chainId: base.id,
    routerClaimDeliveryVariant: 'v1',
  });
}

async function main(): Promise<void> {
  console.log('\n=== Prediction.apy.v0 Full E2E (production-shaped) ===\n');

  let anvil: ChildProcess | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  let publicClient!: PublicClient;
  let agentPk!: `0x${string}`;
  let safeAddress!: Address;
  let mechAddress!: Address;
  let adapter!: MechAdapter;
  let restorationRequestId!: string;
  let evalRequestId!: string;
  let intent!: DesiredState;
  let intentCid!: string;
  let window!: { startTs: number; endTs: number };

  try {
    results.push(await runPhase('Phase 1: Spawn Anvil fork + temp dir', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'jinn-e2e-apy-'));
      const forkBlock = process.env['ANVIL_FORK_BLOCK'] ?? '';
      const args = ['--fork-url', BASE_RPC_URL, '--port', String(ANVIL_PORT), '--silent', ...(forkBlock ? ['--fork-block-number', forkBlock] : [])];
      anvil = spawn(process.env['ANVIL_PATH'] ?? 'anvil', args, { stdio: 'ignore' });
      await waitFor('anvil ready', async () => {
        try { const b = await jsonRpc(ANVIL_RPC, 'eth_blockNumber'); return typeof b === 'string' && b.startsWith('0x'); }
        catch { return false; }
      });
      publicClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) }) as unknown as PublicClient;
      console.log(`    Temp dir: ${tmpDir}`);
      console.log(`    Fork block: ${await publicClient.getBlockNumber()}`);
    }));

    results.push(await runPhase('Phase 2: Bootstrap single service', async () => {
      if (!tmpDir) throw new Error('missing temp dir');
      let bootstrapper = new FleetBootstrapper({ earningDir: tmpDir, chain: 'base', rpcUrl: ANVIL_RPC, targetServices: 1 });
      const r1 = await bootstrapper.bootstrap(PASSWORD);
      if (!r1.funding) throw new Error('expected funding requirement');
      const master = r1.funding.master_address;

      await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [master, '0x56BC75E2D63100000']);
      const slot = erc20BalanceSlot(master);
      const olasAmount = 100000n * 10n ** 18n;
      const { encodeFunctionData } = await import('viem');
      await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [OLAS_TOKEN, slot, pad(toHex(olasAmount), { size: 32 })]);
      await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [master]);
      await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{
        from: master,
        to: OLAS_TOKEN,
        data: encodeFunctionData({
          abi: parseAbi(['function approve(address,uint256) returns (bool)']),
          functionName: 'approve',
          args: [CHAIN_CONFIG.stakingContract as Address, olasAmount],
        }),
      }]);
      await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{
        from: master,
        to: CHAIN_CONFIG.stakingContract,
        data: encodeFunctionData({
          abi: parseAbi(['function deposit(uint256)']),
          functionName: 'deposit',
          args: [olasAmount],
        }),
      }]);
      await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [master]);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      bootstrapper = new FleetBootstrapper({ earningDir: tmpDir, chain: 'base', rpcUrl: ANVIL_RPC, targetServices: 1 });
      const r2 = await bootstrapper.bootstrap(PASSWORD);
      if (!r2.ok) throw new Error(`bootstrap failed: ${r2.message}`);
      const svc = r2.fleet_state.services.find(s => s.step === 'complete' && s.safe_address && s.mech_address);
      if (!svc) throw new Error('no completed service');

      const { FleetStateStore } = await import('../src/earning/store.js');
      const { decryptMnemonic, walletPrivateKeyAtIndex } = await import('../src/earning/wallet.js');
      const store = new FleetStateStore(tmpDir);
      const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), PASSWORD);
      agentPk = walletPrivateKeyAtIndex(mnemonic, svc.index) as `0x${string}`;
      safeAddress = getAddress(svc.safe_address!) as Address;
      mechAddress = getAddress(svc.mech_address!) as Address;

      console.log(`    Safe: ${safeAddress}`);
      console.log(`    Mech: ${mechAddress}`);
      await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [safeAddress, '0x56BC75E2D63100000']);
    }));

    results.push(await runPhase('Phase 3: Initialize adapter', async () => {
      adapter = makeAdapter(agentPk, safeAddress, mechAddress);
      await adapter.initialize();
    }));

    results.push(await runPhase('Phase 4: Post prediction.apy.v0 restoration intent on-chain', async () => {
      const now = Date.now();
      window = { startTs: now, endTs: now + 3_600_000 };
      intent = {
        id: 'prediction-apy-v0-e2e',
        description: 'APY full loop',
        type: 'restoration',
        window,
        spec: {
          kind: 'prediction.apy.v0',
          oracle: {
            venue: 'aave-v3-base-sepolia',
            pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
            reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
            reserveSymbol: 'USDC',
          },
          metric: {
            type: 'supply-apy-twa-bps',
            twaWindowSeconds: 3600,
            sampleCount: 12,
            toleranceBps: 100,
          },
          question: { resolveTs: window.endTs + 900_000 },
        },
        eligibility: { maxSubmissionDelayMs: 3_600_000 },
      } as unknown as DesiredState;

      // Use the same path production uses for createRestorationJob payload.
      const payload = buildDesiredStatePayload(intent);
      const cid = await uploadToIpfs('https://registry.autonolas.tech', payload);
      intentCid = `f01551220${cidToDigestHex(cid).slice(2)}`;
      const intentDataHex = cidToDigestHex(cid) as Hex;
      const { walletClient } = createClients(ANVIL_RPC, agentPk, base);
      const [deliveryRate, timeoutBounds] = await Promise.all([
        getMechDeliveryRate(publicClient, mechAddress),
        getTimeoutBounds(publicClient, MARKETPLACE_ADDRESS),
      ]);
      const reqIds = await submitRestorationJob(
        publicClient,
        walletClient,
        safeAddress,
        ROUTER_ADDRESS,
        mechAddress,
        intentDataHex,
        deliveryRate,
        timeoutBounds.max,
      );
      if (reqIds.length === 0) throw new Error('no request id');
      restorationRequestId = reqIds[0]!;
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Ensure adapter tracks this restoration for eval creation path, just like postDesiredState.
      (adapter as any).pendingEvaluations.set(restorationRequestId, {
        ...intent,
        context: { ...(intent.context ?? {}), [RESTORATION_INTENT_CID_CONTEXT_KEY]: intentCid },
      });
      (adapter as any).originalStates.set(restorationRequestId, { ...intent, type: 'restoration' });

      const tip = await publicClient.getBlockNumber();
      const logs = await publicClient.getLogs({ address: MARKETPLACE_ADDRESS, fromBlock: tip - 5n, toBlock: tip });
      const found = decodeMarketplaceRequestLogs(logs).some(l => l.requestId === restorationRequestId);
      if (!found) throw new Error('MarketplaceRequest not observed');
      console.log(`    restorationRequestId: ${restorationRequestId}`);
    }));

    results.push(await runPhase('Phase 5: Restorer watches request, runs baseline, and delivers', async () => {
      const iter = adapter.watchForRequests()[Symbol.asyncIterator]();
      const req = await Promise.race([
        iter.next(),
        sleep(60_000).then(() => { throw new Error('watchForRequests timeout'); }),
      ]);
      if (req.done || !req.value) throw new Error('no restoration request');
      await adapter.claimRequest(req.value.requestId);

      const baseline = new PredictionApyV0BaselineImpl({
        _testDeps: {
          twApyBpsOverWindow: async () => ({ twApyBps: 250, sampleCount: 12 }),
        },
      });
      const workingDir = join(tmpDir!, 'restoration', req.value.requestId);
      const implStateDir = join(tmpDir!, 'impl-state', req.value.requestId);
      mkdirSync(workingDir, { recursive: true });
      mkdirSync(implStateDir, { recursive: true });
      const out = await baseline.run({
        intent,
        intentCid,
        implStateDir,
        workingDir,
        log: () => {},
        abort: new AbortController().signal,
        msUntilEndTs: () => Math.max(0, window.endTs - Date.now()),
        _testDeps: { twApyBpsOverWindow: async () => ({ twApyBps: 250, sampleCount: 12 }) },
      } as unknown as RestorationContext);

      const account = privateKeyToAccount(agentPk);
      const manifestBase = {
        schemaVersion: 'prediction.apy.v0.submission.v1' as const,
        generatedAt: Date.now(),
        intent: {
          cid: intentCid,
          onchainCreationTx: req.value.onchainCreationTx ?? ('0x' + '0'.repeat(64)),
          onchainCreationBlock: req.value.onchainCreationBlock ?? 0,
          requestId: req.value.requestId,
        },
        restorer: {
          safeAddress: safeAddress as `0x${string}`,
          agentEoa: account.address,
        },
        window,
        prediction: {
          predictedBps: String(out.gating['predictedBps']),
          submittedAt: Number(out.gating['submittedAt']),
          modelId: String(out.gating['modelId']),
        },
      };
      const signed = await signCanonical(manifestBase, agentPk, account.address);
      const submission: PredictionApySubmissionManifest = {
        ...manifestBase,
        signature: {
          algo: 'secp256k1',
          signer: account.address,
          hash: signed.hash,
          sig: signed.sig,
        },
      };
      await adapter.submitResult(req.value.requestId, { data: JSON.stringify(submission) });
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log('    restoration delivered');
    }));

    results.push(await runPhase('Phase 6: Adapter processes restoration delivery and auto-creates evaluation job', async () => {
      const dIter = adapter.watchForDeliveries()[Symbol.asyncIterator]();
      await Promise.race([
        dIter.next(),
        sleep(90_000).then(() => { throw new Error('watchForDeliveries timeout for restoration'); }),
      ]);
      const pendingClaims = (adapter as any).pendingEvaluationClaims as Set<string>;
      if (pendingClaims.size === 0) throw new Error('no evaluation request in pendingEvaluationClaims');
      evalRequestId = [...pendingClaims][0]!;
      console.log(`    evalRequestId: ${evalRequestId}`);
      const tip = await publicClient.getBlockNumber();
      const logs = await publicClient.getLogs({ address: ROUTER_ADDRESS, fromBlock: tip - 20n, toBlock: tip });
      const found = logs.some((log) => {
        try {
          const d = decodeEventLog({ abi: JINN_ROUTER_ABI, data: log.data, topics: log.topics });
          return d.eventName === 'EvaluationJobCreated';
        } catch { return false; }
      });
      if (!found) throw new Error('EvaluationJobCreated not observed');
    }));

    results.push(await runPhase('Phase 7: Watch eval request, run APY evaluator, deliver verdict', async () => {
      const iter = adapter.watchForRequests()[Symbol.asyncIterator]();
      let evalReq: { requestId: string; desiredState: DesiredState; intentCid?: string } | undefined;
      const deadline = Date.now() + 60_000;
      while (!evalReq && Date.now() < deadline) {
        const next = await Promise.race([
          iter.next(),
          sleep(3_000).then(() => ({ done: true, value: undefined })),
        ]);
        if (!next.done && next.value?.desiredState?.type === 'evaluation') {
          evalReq = next.value as { requestId: string; desiredState: DesiredState; intentCid?: string };
        }
      }
      if (!evalReq) throw new Error('no evaluation request');
      await adapter.claimRequest(evalReq.requestId);

      const workingDir = join(tmpDir!, 'evaluation', evalReq.requestId);
      const implStateDir = join(tmpDir!, 'eval-impl-state', evalReq.requestId);
      mkdirSync(workingDir, { recursive: true });
      mkdirSync(implStateDir, { recursive: true });
      const evaluator = new PredictionApyV0Evaluator({
        evaluatorPk: agentPk,
        evaluatorSafeAddress: safeAddress as `0x${string}`,
        rpcUrl: ANVIL_RPC,
        _testDeps: {
          twApyBpsOverWindow: async () => ({ twApyBps: 250, sampleCount: 12 }),
        },
      });
      const out = await evaluator.run({
        intent: evalReq.desiredState,
        intentCid: evalReq.intentCid ?? '',
        implStateDir,
        workingDir,
        log: () => {},
        abort: new AbortController().signal,
        msUntilEndTs: () => 0,
        _testDeps: { twApyBpsOverWindow: async () => ({ twApyBps: 250, sampleCount: 12 }) },
      } as unknown as RestorationContext);
      const verdict = String(out.gating['verdict'] ?? 'UNKNOWN');
      if (verdict !== 'PASS') throw new Error(`expected PASS verdict, got ${verdict}`);

      await adapter.submitResult(evalReq.requestId, {
        data: JSON.stringify({
          protocol: 'jinn-client/prediction.apy.v0',
          type: 'evaluation-verdict',
          requestId: evalReq.requestId,
          verdict,
          gating: out.gating,
        }),
      });
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log(`    evaluator delivered verdict: ${verdict}`);
    }));

    results.push(await runPhase('Phase 8: Process evaluation delivery and cleanup tracking', async () => {
      const iter = adapter.watchForDeliveries()[Symbol.asyncIterator]();
      const yielded = await Promise.race([
        iter.next(),
        sleep(90_000).then(() => { throw new Error('watchForDeliveries timeout for evaluation'); }),
      ]);
      if (!yielded.done && yielded.value) {
        const data = yielded.value.result.data;
        try {
          const parsed = JSON.parse(data) as { verdict?: string };
          if (parsed.verdict !== 'PASS') throw new Error(`unexpected verdict payload ${parsed.verdict}`);
        } catch {
          throw new Error('failed to parse evaluation payload from delivery');
        }
      }
      const pendingClaims = (adapter as any).pendingEvaluationClaims as Set<string>;
      if (pendingClaims.has(evalRequestId)) throw new Error('pendingEvaluationClaims still contains eval request');
    }));
  } finally {
    if (adapter) { try { await adapter.stop(); } catch { /**/ } }
    if (anvil) anvil.kill('SIGTERM');
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }

  console.log('\n=== Results ===\n');
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(`  ${icon} ${r.name} (${r.ms}ms)${r.error ? `: ${r.error}` : ''}`);
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`\nE2E FAILED — ${failed.length}/${results.length} phases failed`);
    process.exit(1);
  }
  console.log('\nE2E PASSED — prediction.apy.v0 production-shaped loop verified');
}

main().catch((err) => {
  console.error('[e2e-apy] Fatal:', err);
  process.exit(1);
});

