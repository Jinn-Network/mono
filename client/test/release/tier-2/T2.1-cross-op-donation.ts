/**
 * T2.1 — cross-operator corpus donation scenario.
 *
 * Scenario contract (from scenario-cross-op-donation.md):
 *   op-a produces a corpus artifact, indexer attributes it,
 *   op-b discovers + queries it (402 unpaid), op-b pays x402, op-b retrieves
 *   the bytes (200 + ERC-8128-signed envelope), USDC balance deltas verified.
 *
 * Real daemon API surface (the speculative `/v1/corpus/*` REST endpoints in the
 * original scenario plan were never built — corpus production is a side effect
 * of task execution, not a REST call). This rewrite drives the *real* surface
 * proven by `client/test/e2e/corpus-x402.ts`:
 *
 *   - GET  /v1/artifacts/:sha256/content   x402-gated serving (client/src/x402/handler.ts)
 *   - the `Corpus` library's `DiscoveryAPI` for envelope discovery
 *     (Ponder HTTP primary + on-chain MetadataSet-log floor via withFallback)
 *   - `acquireArtifactWithPayment` for the buyer-side x402 dance
 *
 * Structure: T2.1 is `corpus-x402.ts` re-hosted into the Tier 2 scenario shape.
 * `setupTier2Scenario` supplies the substrate workspace + an Anvil fork of Base
 * Sepolia + two booted operator daemons (proving substrate ops come up against
 * the fork). The donation handshake itself runs against an in-test x402
 * `ApiServer` for the producer side — the production daemon does not wire x402
 * onto its own `ApiServer` (`DaemonConfig.x402` is never set in `main.ts`), so
 * the x402-gated serving route only exists when an `ApiServer` is started with
 * an explicit `x402` config, exactly as `corpus-x402.ts` does. Per the issue
 * #349 investigation, the producer's served-artifact store is seeded directly
 * (`saveServedArtifact` + a hand-built `SignedEnvelope`) rather than by driving
 * a full task execution — the latter adds Anvil task-lifecycle flakiness for no
 * extra coverage of the donation handshake.
 *
 * Closes https://github.com/Jinn-Network/mono/issues/349.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  padHex,
  parseUnits,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import { startApiServer, type ApiServer } from '../../../src/api/server.js';
import { createCorpus } from '../../../src/corpus/index.js';
import { createOnchainDiscoveryAPI } from '../../../src/discovery/onchain.js';
import { DiscoveryUnavailableError, type DiscoveryAPI } from '../../../src/discovery/types.js';
import { withFallback } from '../../../src/discovery/with-fallback.js';
import { encodeExecutionPayload } from '../../../src/erc8004/identity.js';
import { canonicalJson } from '../../../src/harnesses/engine/canonical-json.js';
import { signCanonical } from '../../../src/harnesses/engine/signing.js';
import { Store } from '../../../src/store/store.js';
import { SignedEnvelopeSchema, type SignedEnvelope } from '../../../src/types/envelope.js';
import { acquireArtifactWithPayment } from '../../../src/x402/acquire.js';
import { jsonRpc as anvilJsonRpc, type AnvilHarness } from '../../_support/chain/anvil.js';
import { allocateAnvilPort } from '../../_support/chain/port-allocator.js';

import { setupTier2Scenario, type Tier2Handle } from './tier-2-helpers.js';
import { EvidenceLog, passVerdict, skipVerdict, failVerdict } from './scenario-evidence.js';
import type { ScenarioVerdict, ScenarioOptions } from '../../../scripts/release/scenario-types.js';

// ── Constants ────────────────────────────────────────────────────────────────
// Base Sepolia USDC (Circle FiatTokenV2 proxy — same storage layout as mainnet,
// so the ERC-20 balances mapping lives at slot 9).
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const USDC_BALANCE_SLOT = 9n;
const X402_NETWORK = 'eip155:84532' as const;
// MetadataSet-emitter shim address — see metadataLogEmitterRuntime().
const MOCK_IDENTITY_REGISTRY = '0x1000000000000000000000000000000000008004' as const;
// Deterministic test keys for producer (op-a) and consumer (op-b) — funded on
// the fork via anvil cheatcodes. Reused verbatim from corpus-x402.ts.
const PRODUCER_PRIVATE_KEY = '0xe8995487b20e0a75915567c5c8976b9deaed52d78b75ab5e04ce69c380007ea6' as const;
const CONSUMER_PRIVATE_KEY = '0x2a1a0e4897413cbd6f28fd0571ce6538fbce72a9a9cc189ec9d7f843ab2b7ba4' as const;
const PRICE_USDC = '0.001';
const SOLVER_TYPE = 'corpus-donation.t2.1';
const ARTIFACT_TYPE = 't2.1.corpus.donation.bytes';
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeIpfsCid(payload: unknown): string {
  return `bafy${sha256Hex(Buffer.from(canonicalJson(payload))).slice(0, 52)}`;
}

/** In-process IPFS double — keeps the donation handshake self-contained. */
function createInProcessIpfs(): {
  upload(data: unknown): Promise<string>;
  fetch(_gatewayUrl: string, cid: string): Promise<unknown>;
} {
  const blobs = new Map<string, unknown>();
  return {
    async upload(data) {
      const canonical = canonicalJson(data);
      const cid = fakeIpfsCid(data);
      blobs.set(cid, JSON.parse(canonical));
      return cid;
    },
    async fetch(_gatewayUrl, cid) {
      const data = blobs.get(cid);
      if (data === undefined) throw new Error(`IPFS fixture missing CID ${cid}`);
      return data;
    },
  };
}

/**
 * Minimal EVM runtime that re-emits its calldata as a `MetadataSet` log, so the
 * on-chain `DiscoveryAPI` floor has a real attribution event to index off the
 * Anvil fork (no deployed IdentityRegistry on a fresh Base Sepolia fork).
 */
function metadataLogEmitterRuntime(): Hex {
  const topic0 = keccak256(toBytes('MetadataSet(uint256,string,string,bytes)'));
  return `0x6040360360406000376020356000357f${topic0.slice(2)}604036036000a300` as Hex;
}

function usdcBalanceSlot(account: Address): Hex {
  return keccak256(concatHex([
    padHex(account, { size: 32 }),
    padHex(toHex(USDC_BALANCE_SLOT), { size: 32 }),
  ]));
}

async function setUsdcBalance(rpcUrl: string, account: Address, amount: bigint): Promise<void> {
  await anvilJsonRpc(rpcUrl, 'anvil_setStorageAt', [
    BASE_SEPOLIA_USDC,
    usdcBalanceSlot(account),
    padHex(toHex(amount), { size: 32 }),
  ]);
}

async function usdcBalance(publicClient: PublicClient, account: Address): Promise<bigint> {
  return publicClient.readContract({
    address: BASE_SEPOLIA_USDC,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [account],
  });
}

/** Align the fork head timestamp to wall-clock so x402 payment deadlines hold. */
async function alignForkTimestampToWallClock(anvil: AnvilHarness): Promise<void> {
  const forkNow = BigInt(await anvil.now());
  const wallClockNow = BigInt(Math.floor(Date.now() / 1000));
  if (forkNow >= wallClockNow) return;
  await anvilJsonRpc(anvil.rpcUrl, 'evm_setNextBlockTimestamp', [toHex(wallClockNow)]);
  await anvilJsonRpc(anvil.rpcUrl, 'anvil_mine', ['0x1']);
}

/** Publish a `MetadataSet` attribution event linking `manifestCid` to op-a. */
async function publishEnvelopeMetadata(args: {
  publicClient: PublicClient;
  rpcUrl: string;
  publisher: PrivateKeyAccount;
  agentId: bigint;
  manifestCid: string;
  manifestHash: Hex;
}): Promise<Hex> {
  await anvilJsonRpc(args.rpcUrl, 'anvil_setCode', [
    MOCK_IDENTITY_REGISTRY,
    metadataLogEmitterRuntime(),
  ]);
  const wallet = createWalletClient({
    account: args.publisher,
    chain: baseSepolia,
    transport: http(args.rpcUrl),
  });
  const metadataKey = `envelope:${args.manifestCid}`;
  const metadataValue = encodeExecutionPayload({
    version: 1,
    tier: 1,
    manifestHash: args.manifestHash,
    attestationQuoteCid: '0x',
    sourceMeasurement: ZERO_BYTES32,
  });
  const eventData = encodeAbiParameters(
    [{ type: 'string' }, { type: 'bytes' }],
    [metadataKey, metadataValue],
  );
  const data = concatHex([
    padHex(toHex(args.agentId), { size: 32 }),
    keccak256(toBytes(metadataKey)),
    eventData,
  ]);
  const txHash = await wallet.sendTransaction({
    to: MOCK_IDENTITY_REGISTRY,
    data,
    account: args.publisher,
    chain: baseSepolia,
    gas: 1_000_000n,
  });
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash: txHash });
  assert(receipt.status === 'success', `MetadataSet tx reverted: ${txHash}`);
  return txHash;
}

/** Hand-build the producer's ERC-8128-signed corpus envelope. */
async function buildSignedEnvelope(args: {
  producer: PrivateKeyAccount;
  producerPrivateKey: Hex;
  producerSafe: Address;
  endpoint: string;
  artifactSha256: string;
  artifactBytes: Buffer;
}): Promise<SignedEnvelope> {
  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: SOLVER_TYPE,
    role: 'restoration' as const,
    generatedAt: Date.now(),
    task: {
      cid: 'bafy-t2.1-cross-op-donation-task',
      onchainCreationTx: `0x${'11'.repeat(32)}` as Hex,
      onchainCreationBlock: 1,
      requestId: `0x${'22'.repeat(32)}` as Hex,
    },
    participant: {
      safeAddress: args.producerSafe,
      agentEoa: args.producer.address,
    },
    window: {
      startTs: Math.floor(Date.now() / 1000) - 60,
      endTs: Math.floor(Date.now() / 1000) + 60,
    },
    executor: {
      implName: 't2.1-cross-op-donation-producer',
      implVersion: '1.0.0',
      clientGitSha: 'release-gate-t2.1',
      codeDigest: `sha256:${'33'.repeat(32)}`,
      runtimeBundleDigest: `sha256:${'44'.repeat(32)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: args.producer.address },
    },
    evidenceTier: 'committed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [{
      artifactType: ARTIFACT_TYPE,
      sha256: args.artifactSha256,
      metadata: {
        description: 'T2.1 cross-operator corpus donation artifact',
        tags: ['corpus', 'x402', 't2.1'],
      },
      access: {
        endpoint: args.endpoint,
        priceUsdc: PRICE_USDC,
      },
    }],
    payload: {
      ok: true,
      bytesSha256: args.artifactSha256,
      byteLength: args.artifactBytes.length,
    },
  };
  const signed = await signCanonical(unsigned, args.producerPrivateKey, args.producer.address);
  return SignedEnvelopeSchema.parse({
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: args.producer.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  });
}

/** A DiscoveryAPI that always fails — forces the consumer onto the on-chain floor. */
function unavailableDiscovery(onQuery: () => void): DiscoveryAPI {
  const fail = async (): Promise<never> => {
    throw new DiscoveryUnavailableError('synthetic indexer outage for T2.1');
  };
  return {
    findClaimableTasks: fail,
    listLaunchedSolverNets: fail,
    getLifecycleStatus: fail,
    async queryEnvelopes() {
      onQuery();
      throw new DiscoveryUnavailableError('synthetic indexer outage for T2.1');
    },
  };
}

// ── Callable entry point for the orchestrator ────────────────────────────────

export async function runT21CrossOpDonation(
  opts: ScenarioOptions,
): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidence = new EvidenceLog(opts.evidencePath);
  const log = (msg: string): void => evidence.log(msg);

  let handle: Tier2Handle | null = null;
  let producerApi: ApiServer | null = null;
  let producerStore: Store | null = null;
  let consumerStore: Store | null = null;

  // ── Prerequisite: BASE_SEPOLIA_RPC_URL ────────────────────────────────────
  // setupTier2Scenario throws if the env var is absent; guard early so the
  // skip message is T2.1-specific.
  if (!process.env['BASE_SEPOLIA_RPC_URL']) {
    log('SKIP: BASE_SEPOLIA_RPC_URL not set; cannot fork Base Sepolia for T2.1.');
    log('Set BASE_SEPOLIA_RPC_URL to a Base Sepolia RPC endpoint and re-run.');
    await evidence.flush();
    return skipVerdict({
      scenarioId: 'T2.1',
      startedAt: started,
      evidencePath: opts.evidencePath,
      failNotes: 'BASE_SEPOLIA_RPC_URL not set; cannot fork Base Sepolia for T2.1',
    });
  }

  try {
    // ── Step 1: substrate workspace + Anvil fork + booted op daemons ────────
    log('Step 1: setup substrate workspace + Anvil fork of Base Sepolia + op-a/op-b daemons');
    handle = await setupTier2Scenario({ scenarioId: 'T2.1', portBase: 7750 });
    log(`  workspace: ${handle.workspace.workspaceRoot}`);
    log(`  anvil rpc: ${handle.anvilRpcUrl}`);
    log(`  op-a daemon api: http://127.0.0.1:${handle.daemons.daemons['op-a']!.apiPort}`);
    log(`  op-b daemon api: http://127.0.0.1:${handle.daemons.daemons['op-b']!.apiPort}`);
    const rpcUrl = handle.anvilRpcUrl;
    await alignForkTimestampToWallClock(handle.anvil);

    const producer = privateKeyToAccount(PRODUCER_PRIVATE_KEY);
    const consumer = privateKeyToAccount(CONSUMER_PRIVATE_KEY);
    const priceUnits = parseUnits(PRICE_USDC, 6);

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    }) as unknown as PublicClient;

    // ── Step 2: fund producer (gas) + consumer (USDC) on the fork ───────────
    log('Step 2: fund producer ETH + consumer USDC on the fork');
    await anvilJsonRpc(rpcUrl, 'anvil_setBalance', [
      producer.address,
      toHex(parseUnits('10', 18)),
    ]);
    const fundedConsumerUsdc = parseUnits('10', 6);
    await setUsdcBalance(rpcUrl, consumer.address, fundedConsumerUsdc);
    const consumerFunded = await usdcBalance(publicClient, consumer.address);
    assert(
      consumerFunded === fundedConsumerUsdc,
      `consumer USDC after funding=${formatUnits(consumerFunded, 6)} expected ${formatUnits(fundedConsumerUsdc, 6)}`,
    );
    log(`  producer ${producer.address}: 10 ETH`);
    log(`  consumer ${consumer.address}: ${formatUnits(consumerFunded, 6)} USDC`);

    // ── Step 3: op-a produces a corpus artifact (x402-gated serving) ────────
    // The production daemon never wires x402 onto its own ApiServer, so the
    // x402-gated serving route only exists on an ApiServer started with an
    // explicit x402 config. We host op-a's served-artifact store + ApiServer
    // inside the substrate workspace, exactly as corpus-x402.ts does.
    log('Step 3: op-a produces a corpus artifact + serves it x402-gated');
    const workspaceDir = handle.workspace.opPaths['op-a']!;
    producerStore = new Store(join(workspaceDir, 't2.1-producer.sqlite'));
    consumerStore = new Store(join(handle.workspace.opPaths['op-b']!, 't2.1-consumer.sqlite'));

    producerApi = await startApiServer({
      port: await allocateAnvilPort(),
      store: producerStore,
      apiToken: 't2.1-producer-token',
      x402: {
        privateKey: PRODUCER_PRIVATE_KEY,
        recipientAddress: producer.address,
        network: X402_NETWORK,
        rpcUrl,
      },
    });
    const endpoint = `http://127.0.0.1:${producerApi.port}`;
    log(`  op-a x402 serving endpoint: ${endpoint}`);

    const artifactBytes = Buffer.from(`t2.1 corpus donation artifact ${new Date().toISOString()}`, 'utf-8');
    const artifactSha256 = sha256Hex(artifactBytes);
    producerStore.saveServedArtifact({
      sha256: artifactSha256,
      artifactType: ARTIFACT_TYPE,
      requestId: 't2.1-cross-op-donation-request',
      content: artifactBytes,
      priceUsdc: PRICE_USDC,
      createdAt: new Date().toISOString(),
    });

    const envelope = await buildSignedEnvelope({
      producer,
      producerPrivateKey: PRODUCER_PRIVATE_KEY,
      producerSafe: producer.address,
      endpoint,
      artifactSha256,
      artifactBytes,
    });
    const ipfs = createInProcessIpfs();
    const manifestCid = await ipfs.upload(envelope);
    producerStore.setServedArtifactEnvelopeCid(artifactSha256, manifestCid);
    log(`  artifactSha256=${artifactSha256}`);
    log(`  manifestCid=${manifestCid}`);

    // ── Step 4: indexer attributes the artifact to op-a ─────────────────────
    log('Step 4: publish on-chain MetadataSet attribution + index via DiscoveryAPI floor');
    const metadataTxHash = await publishEnvelopeMetadata({
      publicClient,
      rpcUrl,
      publisher: producer,
      agentId: 1n,
      manifestCid,
      manifestHash: envelope.signature.hash as Hex,
    });
    log(`  MetadataSet tx: ${metadataTxHash}`);

    const floor = createOnchainDiscoveryAPI({
      rpcUrl,
      chainId: baseSepolia.id,
      identityRegistryAddress: MOCK_IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0n,
      chunkBlocks: 1_999n,
    });
    let degradedPrimaryQueries = 0;
    let routeResolverCalls = 0;
    let acquireCalls = 0;
    const discovery = withFallback(
      unavailableDiscovery(() => { degradedPrimaryQueries += 1; }),
      floor,
      { unhealthyThreshold: 1, retryAfterMs: 60_000 },
    );
    const corpus = createCorpus({
      ipfsGatewayUrl: 'fixture://ipfs',
      store: consumerStore,
      signer: { privateKey: CONSUMER_PRIVATE_KEY },
      selfSafeAddress: consumer.address,
      discovery,
      routeResolver: {
        async resolve() {
          routeResolverCalls += 1;
          return null;
        },
      },
    }, {
      fetchFromIpfs: ipfs.fetch,
      async acquireFn(endpointArg, shaArg, privateKeyArg) {
        acquireCalls += 1;
        return acquireArtifactWithPayment(endpointArg, shaArg, privateKeyArg);
      },
    });

    // ── Step 5: op-b discovers + pays x402 + retrieves the bytes ─────────────
    log('Step 5: op-b discovers the envelope, pays x402, retrieves + verifies the bytes');
    const [producerBalanceBefore, consumerBalanceBefore] = await Promise.all([
      usdcBalance(publicClient, producer.address),
      usdcBalance(publicClient, consumer.address),
    ]);
    const discovered = await corpus.read({
      query: {
        solverType: SOLVER_TYPE,
        manifestHash: envelope.signature.hash,
        limit: 1,
      },
    });
    assert(degradedPrimaryQueries === 1, `expected degraded primary discovery once, got ${degradedPrimaryQueries}`);
    assert(discovered.length === 1, `expected one discovered envelope, got ${discovered.length}`);
    const content = discovered[0]!.artifactContents.get(artifactSha256);
    assert(content, 'op-b read did not return artifact content');
    assert(content.bytes.length > 0, 'op-b read returned empty bytes');
    assert(sha256Hex(content.bytes) === artifactSha256, 'op-b read bytes failed sha256 verification');
    assert(content.source === 'origin', `op-b read source=${content.source}, expected origin`);
    assert(content.paidAmountUsdc === PRICE_USDC, `op-b read paid=${content.paidAmountUsdc}, expected ${PRICE_USDC}`);
    assert(routeResolverCalls === 1, `route resolver calls after read=${routeResolverCalls}`);
    assert(acquireCalls === 1, `acquire calls after read=${acquireCalls}`);
    log(`  op-b retrieved ${content.bytes.length} bytes (sha256 verified, source=origin)`);

    // ERC-8128: the discovered envelope carries a verified secp256k1 signature.
    const discoveredSig = discovered[0]!.envelope.signature;
    assert(
      discoveredSig.signer.toLowerCase() === producer.address.toLowerCase(),
      `envelope signer=${discoveredSig.signer}, expected ${producer.address}`,
    );
    log(`  envelope signature verified — signer=${discoveredSig.signer}, algo=${discoveredSig.algo}`);

    // ── Step 6: verify USDC balance deltas + paid-serve access event ─────────
    log('Step 6: verify USDC balance deltas + producer paid-serve access event');
    const [producerBalanceAfter, consumerBalanceAfter] = await Promise.all([
      usdcBalance(publicClient, producer.address),
      usdcBalance(publicClient, consumer.address),
    ]);
    assert(
      producerBalanceAfter - producerBalanceBefore === priceUnits,
      `producer USDC delta=${formatUnits(producerBalanceAfter - producerBalanceBefore, 6)} expected ${PRICE_USDC}`,
    );
    assert(
      consumerBalanceBefore - consumerBalanceAfter === priceUnits,
      `consumer USDC delta=${formatUnits(consumerBalanceBefore - consumerBalanceAfter, 6)} expected ${PRICE_USDC}`,
    );
    log(`  producer USDC +${formatUnits(producerBalanceAfter - producerBalanceBefore, 6)}`);
    log(`  consumer USDC -${formatUnits(consumerBalanceBefore - consumerBalanceAfter, 6)}`);

    const paidEvents = producerStore
      .listArtifactAccessEvents({ sha256: artifactSha256 })
      .filter((event) => event.outcome === 'paid_served');
    assert(paidEvents.length === 1, `paid_served access events=${paidEvents.length}, expected 1`);
    const paidEvent = paidEvents[0]!;
    assert(
      paidEvent.payer?.toLowerCase() === consumer.address.toLowerCase(),
      `paid_served payer=${paidEvent.payer}, expected ${consumer.address}`,
    );
    assert(paidEvent.settlementTx, 'paid_served event missing settlement tx');
    log(`  producer recorded paid_served event — payer=${paidEvent.payer}, settlementTx=${paidEvent.settlementTx}`);

    log('');
    log('Verdict: pass — cross-operator corpus donation handshake completed end-to-end.');
    return passVerdict({
      scenarioId: 'T2.1',
      startedAt: started,
      evidencePath: opts.evidencePath,
    });
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return failVerdict({
      scenarioId: 'T2.1',
      startedAt: started,
      evidencePath: opts.evidencePath,
      error: err,
    });
  } finally {
    if (producerApi) {
      try { await producerApi.close(); } catch {}
    }
    try { producerStore?.close(); } catch {}
    try { consumerStore?.close(); } catch {}
    if (handle) {
      try { await handle.teardown(); } catch {}
    }
    // flush() last — captures any line a teardown step logged. Best-effort.
    await evidence.flush();
  }
}
