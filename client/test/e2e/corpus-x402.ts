/**
 * Cross-operator corpus read e2e with real x402 USDC settlement.
 *
 * Public command: `yarn e2e:corpus`
 *
 * The fixture keeps IPFS in-process but uses a real Base Anvil fork, real Base
 * USDC bytecode, the real x402 client/facilitator, and the on-chain
 * DiscoveryAPI floor reading MetadataSet logs from Anvil RPC.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { base } from 'viem/chains';

import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { createCorpus } from '../../src/corpus/index.js';
import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';
import { DiscoveryUnavailableError, type DiscoveryAPI } from '../../src/discovery/types.js';
import { withFallback } from '../../src/discovery/with-fallback.js';
import { encodeExecutionPayload } from '../../src/erc8004/identity.js';
import { canonicalJson } from '../../src/harnesses/engine/canonical-json.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
import { Store } from '../../src/store/store.js';
import { SignedEnvelopeSchema, type SignedEnvelope } from '../../src/types/envelope.js';
import { acquireArtifactWithPayment } from '../../src/x402/acquire.js';
import { jsonRpc as anvilJsonRpc, spawnAnvilFork, type AnvilHarness } from '../_support/chain/anvil.js';
import { allocateAnvilPort } from '../_support/chain/port-allocator.js';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const BASE_USDC_BALANCE_SLOT = 9n;
const DEFAULT_BASE_FORK_BLOCK = 45_930_000;
const MOCK_IDENTITY_REGISTRY = '0x1000000000000000000000000000000000008004' as const;
const PRODUCER_PRIVATE_KEY = '0xe8995487b20e0a75915567c5c8976b9deaed52d78b75ab5e04ce69c380007ea6' as const;
const CONSUMER_PRIVATE_KEY = '0x2a1a0e4897413cbd6f28fd0571ce6538fbce72a9a9cc189ec9d7f843ab2b7ba4' as const;
const PRICE_USDC = '0.001';
const SOLVER_TYPE = 'corpus-x402.e2e';
const ARTIFACT_TYPE = 'e2e.corpus.x402.bytes';
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

function corpusForkBlock(): number {
  const raw = process.env['JINN_CORPUS_X402_FORK_BLOCK'];
  if (raw === undefined || raw === '') return DEFAULT_BASE_FORK_BLOCK;
  const block = Number(raw);
  assert(Number.isSafeInteger(block) && block > 0, `invalid JINN_CORPUS_X402_FORK_BLOCK=${raw}`);
  return block;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeIpfsCid(payload: unknown): string {
  return `bafy${sha256Hex(Buffer.from(canonicalJson(payload))).slice(0, 52)}`;
}

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

function metadataLogEmitterRuntime(): Hex {
  const topic0 = keccak256(toBytes('MetadataSet(uint256,string,string,bytes)'));
  // Fallback calldata layout:
  //   bytes32 topic1 agentId
  //   bytes32 topic2 keccak256(metadataKey)
  //   bytes   ABI-encoded event data: (string metadataKey, bytes metadataValue)
  return `0x6040360360406000376020356000357f${topic0.slice(2)}604036036000a300` as Hex;
}

function usdcBalanceSlot(account: Address): Hex {
  return keccak256(concatHex([
    padHex(account, { size: 32 }),
    padHex(toHex(BASE_USDC_BALANCE_SLOT), { size: 32 }),
  ]));
}

async function setBaseUsdcBalance(rpcUrl: string, account: Address, amount: bigint): Promise<void> {
  await anvilJsonRpc(rpcUrl, 'anvil_setStorageAt', [
    BASE_USDC,
    usdcBalanceSlot(account),
    padHex(toHex(amount), { size: 32 }),
  ]);
}

async function usdcBalance(publicClient: PublicClient, account: Address): Promise<bigint> {
  return publicClient.readContract({
    address: BASE_USDC,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [account],
  });
}

async function alignForkTimestampToWallClock(anvil: AnvilHarness): Promise<void> {
  const forkNow = BigInt(await anvil.now());
  const wallClockNow = BigInt(Math.floor(Date.now() / 1000));
  if (forkNow >= wallClockNow) return;
  await anvilJsonRpc(anvil.rpcUrl, 'evm_setNextBlockTimestamp', [toHex(wallClockNow)]);
  await anvilJsonRpc(anvil.rpcUrl, 'anvil_mine', ['0x1']);
}

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
    chain: base,
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
    chain: base,
    gas: 1_000_000n,
  });
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash: txHash });
  assert(receipt.status === 'success', `MetadataSet tx reverted: ${txHash}`);
  return txHash;
}

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
      cid: 'bafy-corpus-x402-e2e-task',
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
      implName: 'corpus-x402-e2e-producer',
      implVersion: '1.0.0',
      clientGitSha: 'dev-e2e',
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
        description: 'x402 paid corpus e2e artifact',
        tags: ['corpus', 'x402', 'e2e'],
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

function unavailableDiscovery(onQuery: () => void): DiscoveryAPI {
  const fail = async (): Promise<never> => {
    throw new DiscoveryUnavailableError('synthetic indexer outage for corpus-x402 e2e');
  };
  return {
    findClaimableTasks: fail,
    listLaunchedSolverNets: fail,
    getLifecycleStatus: fail,
    async queryEnvelopes() {
      onQuery();
      throw new DiscoveryUnavailableError('synthetic indexer outage for corpus-x402 e2e');
    },
  };
}

async function run(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'jinn-corpus-x402-e2e-'));
  const producer = privateKeyToAccount(PRODUCER_PRIVATE_KEY);
  const consumer = privateKeyToAccount(CONSUMER_PRIVATE_KEY);
  const priceUnits = parseUnits(PRICE_USDC, 6);

  let anvil: AnvilHarness | null = null;
  let producerApi: ApiServer | null = null;
  let producerStore: Store | null = null;
  let consumerStore: Store | null = null;

  try {
    anvil = await spawnAnvilFork({
      forkUrl: process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org',
      forkBlock: corpusForkBlock(),
      chain: base,
      silent: true,
      readyTimeoutMs: 30_000,
    });
    await alignForkTimestampToWallClock(anvil);
    const publicClient = createPublicClient({
      chain: base,
      transport: http(anvil.rpcUrl),
    }) as unknown as PublicClient;
    const [producerCode, consumerCode] = await Promise.all([
      publicClient.getCode({ address: producer.address }),
      publicClient.getCode({ address: consumer.address }),
    ]);
    assert(!producerCode || producerCode === '0x', `producer ${producer.address} has code on the fork`);
    assert(!consumerCode || consumerCode === '0x', `consumer ${consumer.address} has code on the fork`);

    await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
      producer.address,
      toHex(parseUnits('10', 18)),
    ]);
    const fundedConsumerUsdc = parseUnits('10', 6);
    await setBaseUsdcBalance(anvil.rpcUrl, consumer.address, fundedConsumerUsdc);
    const consumerBalanceAfterFunding = await usdcBalance(publicClient, consumer.address);
    assert(
      consumerBalanceAfterFunding === fundedConsumerUsdc,
      `consumer funded USDC balance=${formatUnits(consumerBalanceAfterFunding, 6)} expected ${formatUnits(fundedConsumerUsdc, 6)}`,
    );

    producerStore = new Store(join(tmpDir, 'producer.sqlite'));
    consumerStore = new Store(join(tmpDir, 'consumer.sqlite'));

    producerApi = await startApiServer({
      port: await allocateAnvilPort(),
      store: producerStore,
      apiToken: 'producer-e2e-token',
      x402: {
        privateKey: PRODUCER_PRIVATE_KEY,
        recipientAddress: producer.address,
        network: 'eip155:8453',
        rpcUrl: anvil.rpcUrl,
      },
    });

    const endpoint = `http://127.0.0.1:${producerApi.port}`;
    const artifactBytes = Buffer.from(`paid corpus artifact ${new Date().toISOString()}`, 'utf-8');
    const artifactSha256 = sha256Hex(artifactBytes);
    producerStore.saveServedArtifact({
      sha256: artifactSha256,
      artifactType: ARTIFACT_TYPE,
      requestId: 'corpus-x402-e2e-request',
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

    const metadataTxHash = await publishEnvelopeMetadata({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      publisher: producer,
      agentId: 1n,
      manifestCid,
      manifestHash: envelope.signature.hash as Hex,
    });

    const floor = createOnchainDiscoveryAPI({
      rpcUrl: anvil.rpcUrl,
      chainId: base.id,
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

    const [producerBalanceBefore, consumerBalanceBefore] = await Promise.all([
      usdcBalance(publicClient, producer.address),
      usdcBalance(publicClient, consumer.address),
    ]);
    assert(
      consumerBalanceBefore === fundedConsumerUsdc,
      `consumer USDC before first read=${formatUnits(consumerBalanceBefore, 6)} expected ${formatUnits(fundedConsumerUsdc, 6)}`,
    );
    let first: Awaited<ReturnType<typeof corpus.read>>;
    try {
      first = await corpus.read({
        query: {
          solverType: SOLVER_TYPE,
          manifestHash: envelope.signature.hash,
          limit: 1,
        },
      });
    } catch (err) {
      process.stderr.write(
        `producer access events: ${JSON.stringify(producerStore.listArtifactAccessEvents({ sha256: artifactSha256 }), null, 2)}\n`,
      );
      throw err;
    }
    assert(degradedPrimaryQueries === 1, `expected degraded primary discovery once, got ${degradedPrimaryQueries}`);
    assert(first.length === 1, `expected one discovered envelope, got ${first.length}`);
    const firstContent = first[0]!.artifactContents.get(artifactSha256);
    assert(firstContent, 'first read did not return artifact content');
    assert(firstContent.bytes.length > 0, 'first read returned empty bytes');
    assert(sha256Hex(firstContent.bytes) === artifactSha256, 'first read bytes failed sha256 verification');
    assert(firstContent.source === 'origin', `first read source=${firstContent.source}, expected origin`);
    assert(firstContent.paidAmountUsdc === PRICE_USDC, `first read paid=${firstContent.paidAmountUsdc}`);
    assert(routeResolverCalls === 1, `route resolver calls after first read=${routeResolverCalls}`);
    assert(acquireCalls === 1, `acquire calls after first read=${acquireCalls}`);

    const networkRow = consumerStore.getNetworkArtifact(artifactSha256);
    assert(networkRow, 'consumer network_artifacts row missing');
    assert(networkRow.source === 'origin', `network_artifacts source=${networkRow.source}`);
    assert(networkRow.paidAmountUsdc === PRICE_USDC, `network_artifacts paid=${networkRow.paidAmountUsdc}`);
    assert(networkRow.content.equals(artifactBytes), 'network_artifacts bytes mismatch');

    const [producerBalanceAfterFirst, consumerBalanceAfterFirst] = await Promise.all([
      usdcBalance(publicClient, producer.address),
      usdcBalance(publicClient, consumer.address),
    ]);
    assert(
      producerBalanceAfterFirst - producerBalanceBefore === priceUnits,
      `producer USDC delta=${formatUnits(producerBalanceAfterFirst - producerBalanceBefore, 6)} expected ${PRICE_USDC}`,
    );
    assert(
      consumerBalanceBefore - consumerBalanceAfterFirst === priceUnits,
      `consumer USDC delta=${formatUnits(consumerBalanceBefore - consumerBalanceAfterFirst, 6)} expected ${PRICE_USDC}`,
    );
    const paidEventsAfterFirst = producerStore
      .listArtifactAccessEvents({ sha256: artifactSha256 })
      .filter((event) => event.outcome === 'paid_served');
    assert(paidEventsAfterFirst.length === 1, `paid serve events after first read=${paidEventsAfterFirst.length}`);
    const paidEventAfterFirst = paidEventsAfterFirst[0]!;
    assert(
      paidEventAfterFirst.payer?.toLowerCase() === consumer.address.toLowerCase(),
      `paid serve payer=${paidEventAfterFirst.payer}, expected ${consumer.address}`,
    );
    assert(paidEventAfterFirst.settlementTx, 'paid serve event missing settlement tx');

    const second = await corpus.read({
      query: {
        solverType: SOLVER_TYPE,
        manifestHash: envelope.signature.hash,
        limit: 1,
      },
    });
    assert(second.length === 1, `expected one cached envelope, got ${second.length}`);
    const secondContent = second[0]!.artifactContents.get(artifactSha256);
    assert(secondContent, 'second read did not return artifact content');
    assert(secondContent.source === 'cache', `second read source=${secondContent.source}, expected cache`);
    assert(sha256Hex(secondContent.bytes) === artifactSha256, 'second read bytes failed sha256 verification');
    assert(routeResolverCalls === 1, `route resolver was called on cache hit (${routeResolverCalls})`);
    assert(acquireCalls === 1, `acquire was called on cache hit (${acquireCalls})`);

    const [producerBalanceAfterSecond, consumerBalanceAfterSecond] = await Promise.all([
      usdcBalance(publicClient, producer.address),
      usdcBalance(publicClient, consumer.address),
    ]);
    assert(
      producerBalanceAfterSecond === producerBalanceAfterFirst,
      'producer USDC balance changed on cached read',
    );
    assert(
      consumerBalanceAfterSecond === consumerBalanceAfterFirst,
      'consumer USDC balance changed on cached read',
    );
    const paidEventsAfterSecond = producerStore
      .listArtifactAccessEvents({ sha256: artifactSha256 })
      .filter((event) => event.outcome === 'paid_served');
    assert(paidEventsAfterSecond.length === 1, `paid serve events after second read=${paidEventsAfterSecond.length}`);

    process.stdout.write(
      [
        'corpus x402 e2e passed',
        `manifestCid=${manifestCid}`,
        `metadataTx=${metadataTxHash}`,
        `artifactSha256=${artifactSha256}`,
        `paid=${PRICE_USDC}`,
        `producerUsdcDelta=${formatUnits(producerBalanceAfterFirst - producerBalanceBefore, 6)}`,
        `consumerUsdcDelta=${formatUnits(consumerBalanceBefore - consumerBalanceAfterFirst, 6)}`,
      ].join(' ') + '\n',
    );
  } finally {
    await producerApi?.close();
    producerStore?.close();
    consumerStore?.close();
    await anvil?.teardown();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
