import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JINN_ROUTER_V3_ABI, SAFE_ABI } from '@jinn-network/marketplace-binding';
import { encodeFunctionData, zeroAddress } from 'viem';
import {
  createBaseSepoliaFinalizedAnchorClient,
  createBaseSepoliaEvaluatorReads,
  createBaseSepoliaRecordTransport,
  createNativeInfrastructure,
  createSolverReads,
  createViemBaseSepoliaReadClients,
  mountBaseSepoliaPublicSource,
  verifyCanonicalTodayTaskCreated,
  inspectBaseSepoliaNativeTarget,
  type NativeBaseSepoliaAnchorReadClient,
  type NativeBaseSepoliaTargetReadClient,
} from '../../src/daemon/native-base-sepolia-infrastructure.js';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import { recordPath } from '@jinn-network/record-discovery-protocol';
import { buildNativeEvaluationSpecResolver } from '../../src/daemon/native-assembly.js';
import type { NativeInfrastructureFactoryInput } from '../../src/daemon/native-infrastructure-bundle.js';
import type { NativeEngagementRow, NativeOperationRow } from '../../src/daemon/native-operator-state.js';

const ADDRESSES = {
  taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  jinnRouter: '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247',
  mechMarketplace: '0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7',
  activityChecker: '0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70',
} as const;
const SAFE = '0x1111111111111111111111111111111111111111' as const;
const OWNER = '0x2222222222222222222222222222222222222222' as const;

function requesterInput(): NativeInfrastructureFactoryInput {
  return {
    network: 'testnet',
    rpcUrl: 'https://base-sepolia.example.invalid',
    role: 'requester',
    safeAddress: SAFE,
    evmCustody: {
      keystorePath: '/var/lib/jinn/requester-keystore.json',
      expectedOwnerAddress: OWNER,
      accountIndex: 7,
    },
    publicBaseUrl: 'https://requester.example.invalid',
    publicListen: { host: '127.0.0.1', port: 18_532 },
    ipfs: { apiUrl: 'https://ipfs.example.invalid' },
    chain: { chainId: 84532, generation: 'today', contracts: ADDRESSES },
    transactionCaps: {
      createTaskMaxWei: '100',
      claimMaxWei: '200',
      solutionSettlementMaxWei: '300',
      evaluationClaimMaxWei: '400',
      verdictSettlementMaxWei: '500',
      escrowMaxWei: '600',
    },
    postingTerms: {
      solutionMaxDeliveryRateWei: '2',
      verdictMaxDeliveryRateWei: '3',
      responseTimeoutSeconds: '60',
      allowSolverSelfEvaluation: false,
    },
    stateDir: '/var/lib/jinn/requester',
    finality: { confirmations: 20 },
  };
}

describe('first-party Base Sepolia target inspection', () => {
  it('constructs bounded read primitives without loading EVM custody or opening a listener', async () => {
    const infrastructure = await createNativeInfrastructure(requesterInput());
    expect(infrastructure).toMatchObject({
      requester: {
        recoverPosting: expect.any(Function),
        canonicalTaskCreated: expect.any(Function),
      },
      anchorClient: { lookupFinalizedAnchor: expect.any(Function) },
      // §2.3c step 5: the deployment path opens the trust catalog with only `infrastructure.*`,
      // so the Safe-ownership read has to be surfaced here or that path cannot supply it.
      settlementOwnership: { isOwner: expect.any(Function) },
      records: {
        byLocation: expect.any(Function),
        byDigest: expect.any(Function),
        byRawCid: expect.any(Function),
      },
      inspectTarget: expect.any(Function),
      mountPublicSource: expect.any(Function),
      activateWrites: expect.any(Function),
      close: expect.any(Function),
    });
    await infrastructure.close();
  });

  it('reads exact contract code, distinct owner/Safe balances, caps, and finalized height', async () => {
    const bytecode = new Map<string, `0x${string}`>([
      [ADDRESSES.taskCoordinator.toLowerCase(), '0x6000'],
      [ADDRESSES.jinnRouter.toLowerCase(), '0x6001'],
      [ADDRESSES.mechMarketplace.toLowerCase(), '0x6002'],
      [ADDRESSES.activityChecker.toLowerCase(), '0x6003'],
    ]);
    const client: NativeBaseSepoliaTargetReadClient = {
      async chainId() { return 84532; },
      async code(address) { return bytecode.get(address.toLowerCase()); },
      async balance(address) {
        if (address.toLowerCase() === OWNER.toLowerCase()) return 1_000n;
        if (address.toLowerCase() === SAFE.toLowerCase()) return 2_000n;
        throw new Error(`unexpected balance address ${address}`);
      },
      async block(tag) {
        return tag === 'latest'
          ? { number: 200n, hash: `0x${'a'.repeat(64)}` as const, timestamp: 2_000n }
          : { number: 180n, hash: `0x${'b'.repeat(64)}` as const, timestamp: 1_800n };
      },
      async marketplaceAgentAuthorization() {
        throw new Error('requester inspection must not query a marketplace agent');
      },
    };

    const result = await inspectBaseSepoliaNativeTarget(requesterInput(), client);

    expect(result).toEqual({
      chainId: 84532,
      contracts: {
        taskCoordinator: {
          address: ADDRESSES.taskCoordinator,
          codeHash: '0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d',
        },
        jinnRouter: {
          address: ADDRESSES.jinnRouter,
          codeHash: '0x309c67890bde4c575dc23d2cc3b5c3a3d599e312e980e9b61b5bc8f3cd87c8bb',
        },
        mechMarketplace: {
          address: ADDRESSES.mechMarketplace,
          codeHash: '0xcde7aac41575d8b30bd84f598371d46d266fadb09c9dcfcdd047fd087ef8763e',
        },
        activityChecker: {
          address: ADDRESSES.activityChecker,
          codeHash: '0x124787cd33af4a91148bc5521374b123cb0c5aaa5b0f02ff8d9bf1bb816791b8',
        },
      },
      safeAddress: SAFE,
      ownerBalanceWei: 1_000n,
      safeBalanceWei: 2_000n,
      escrowRequiredWei: 5n,
      estimatedMaximumWei: {},
      canonicalBlock: 200n,
      finalizedBlock: 180n,
    });
  });

  it('proves solver marketplace-agent authorization and uses only solver transaction caps', async () => {
    const marketplaceAgent = '0x3333333333333333333333333333333333333333' as const;
    const authorizations: unknown[] = [];
    const input: NativeInfrastructureFactoryInput = {
      ...requesterInput(),
      role: 'solver',
      marketplaceAgentAddress: marketplaceAgent,
    };
    const client: NativeBaseSepoliaTargetReadClient = {
      async chainId() { return 84532; },
      async code() { return '0x6000'; },
      async balance(address) { return address.toLowerCase() === OWNER.toLowerCase() ? 900n : 800n; },
      async block(tag) {
        return {
          number: tag === 'latest' ? 300n : 280n,
          hash: `0x${(tag === 'latest' ? 'c' : 'd').repeat(64)}` as `0x${string}`,
          timestamp: tag === 'latest' ? 3_000n : 2_800n,
        };
      },
      async marketplaceAgentAuthorization(value) {
        authorizations.push(value);
        return true;
      },
    };

    const result = await inspectBaseSepoliaNativeTarget(input, client);

    expect(authorizations).toEqual([{
      marketplace: ADDRESSES.mechMarketplace,
      agent: marketplaceAgent,
      safe: SAFE,
    }]);
    expect(result).toMatchObject({
      marketplaceAgentAddress: marketplaceAgent,
      marketplaceAgentAuthorized: true,
      estimatedMaximumWei: {},
    });
    expect(result.estimatedMaximumWei).not.toHaveProperty('createTask');
    expect(result.estimatedMaximumWei).not.toHaveProperty('evaluationClaim');
  });

  it('uses only evaluator claim and verdict-settlement caps for evaluator readiness', async () => {
    const input: NativeInfrastructureFactoryInput = {
      ...requesterInput(),
      role: 'evaluator',
      marketplaceAgentAddress: '0x4444444444444444444444444444444444444444',
    };
    const client: NativeBaseSepoliaTargetReadClient = {
      async chainId() { return 84532; },
      async code() { return '0x6000'; },
      async balance() { return 1_000n; },
      async block(tag) {
        return {
          number: tag === 'latest' ? 400n : 380n,
          hash: `0x${(tag === 'latest' ? 'e' : 'f').repeat(64)}` as `0x${string}`,
          timestamp: tag === 'latest' ? 4_000n : 3_800n,
        };
      },
      async marketplaceAgentAuthorization() { return true; },
    };

    const result = await inspectBaseSepoliaNativeTarget(input, client);

    expect(result.estimatedMaximumWei).toEqual({});
  });
});

describe('first-party Base Sepolia public record transport', () => {
  it('retrieves a digest through its raw-codec CID and verifies the exact response bytes', async () => {
    const bytes = new TextEncoder().encode('{"record":"exact"}');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    const fetchImpl = vi.fn(async () => new Response(bytes));
    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      fetchImpl,
    });

    await expect(transport.byDigest(digest)).resolves.toEqual(bytes);
    const requested = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(requested.origin + requested.pathname).toBe('https://ipfs.example.invalid/api/v0/block/get');
    expect(requested.searchParams.get('arg')).toMatch(/^bafkrei/u);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('refuses a digest response whose exact bytes do not match the advertised digest', async () => {
    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      fetchImpl: async () => new Response('tampered'),
    });
    await expect(transport.byDigest(`sha256:${'00'.repeat(32)}`)).rejects.toThrow(/digest mismatch/u);
  });

  it('restricts direct locations to HTTP(S) and bounds every public response', async () => {
    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      maxBytes: 3,
      fetchImpl: async () => new Response('four'),
    });
    await expect(transport.byLocation('file:///private/operator.db')).rejects.toThrow(/HTTP\(S\)/u);
    await expect(transport.byLocation('https://records.example.invalid/one')).rejects.toThrow(/size limit/u);
  });

  // #30: an unpinned eval-spec CID makes kubo `block/get` do a DHT lookup that never returns. With
  // no AbortSignal the fetch hangs the single-threaded solver work loop for minutes (round-17 gate:
  // `loop 'work' stale 325973ms`). The bounded IPFS timeout must abandon the hang FAST so the caller
  // rejects instead of blocking forever. Mutation check: revert the timeout and this test hangs to
  // the vitest timeout (RED) rather than rejecting quickly.
  it('abandons a hanging IPFS block fetch after the bounded timeout instead of blocking forever', async () => {
    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      ipfsFetchTimeoutMs: 20,
      fetchImpl: () => new Promise<Response>(() => { /* DHT lookup that never returns */ }),
    });
    await expect(transport.byDigest(`sha256:${'00'.repeat(32)}`)).rejects.toThrow(/timed out/u);
  });

  it('abandons a hanging HTTP location fetch after the bounded timeout instead of blocking forever', async () => {
    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      httpFetchTimeoutMs: 20,
      fetchImpl: () => new Promise<Response>(() => { /* serving plane that never responds */ }),
    });
    await expect(transport.byLocation('https://records.example.invalid/slow')).rejects.toThrow(/timed out/u);
  });

  // #30 root fix, integrated: the eval-spec resolver's #2559 HTTP-locator fallback only fires on a
  // clean IPFS *rejection*, never on a hang. Once `byDigest` is bounded, a DHT hang becomes a
  // rejection with the SAME shape as a clean miss, so the resolver falls through to the HTTP serving
  // plane and resolves — digest-verified — after the timeout, exactly as round-18's fresh task will.
  it('bounded IPFS timeout lets the eval-spec resolver fall back to the HTTP serving plane on a DHT hang', async () => {
    const specBytes = new TextEncoder().encode('{"kind":"evaluation-spec","for":"#30"}');
    const specDigest = documentDigest(specBytes);
    const servingBase = 'https://requester.example.test';
    const fetchImpl = vi.fn(async (request: string | URL): Promise<Response> => {
      const url = String(request);
      if (url.includes('/api/v0/block/get')) {
        return new Promise<Response>(() => { /* unpinned CID: DHT lookup hangs */ });
      }
      if (url === `${servingBase}${recordPath(specDigest)}`) return new Response(specBytes);
      throw new Error(`unexpected fetch to ${url}`);
    });
    const transport = createBaseSepoliaRecordTransport({
      ipfsApiUrl: 'https://ipfs.example.invalid',
      ipfsFetchTimeoutMs: 20,
      fetchImpl,
    });
    const resolve = buildNativeEvaluationSpecResolver(transport, [servingBase]);

    await expect(resolve(specDigest)).resolves.toEqual(specBytes);
    expect(fetchImpl.mock.calls.some(([request]) => String(request).includes('/api/v0/block/get'))).toBe(true);
    expect(fetchImpl.mock.calls.some(([request]) => String(request) === `${servingBase}${recordPath(specDigest)}`)).toBe(true);
  });
});

describe('first-party Base Sepolia evaluator Delivery correspondence', () => {
  const requestId = `0x${'12'.repeat(32)}` as const;
  const transactionHash = `0x${'34'.repeat(32)}` as const;
  const routerBlockHash = `0x${'56'.repeat(32)}` as const;
  const mechBlockHash = `0x${'78'.repeat(32)}` as const;
  const deliveryMech = '0x9999999999999999999999999999999999999999' as const;
  const operator = SAFE;
  const deliveryBytes = new TextEncoder().encode('{"delivery":"exact"}');
  const advertisedDeliveryDigest = `sha256:${createHash('sha256').update(deliveryBytes).digest('hex')}` as const;
  const expected = {
    chainId: 84532 as const,
    coordinator: ADDRESSES.taskCoordinator,
    router: ADDRESSES.jinnRouter,
    taskId: 42n,
    attemptIndex: 3,
    requestId,
    operator,
    advertisedDeliveryDigest,
  };

  const deliveryLocation = 'https://solver-b.example/records/delivery' as const;

  function fixture(options: {
    readonly duplicateRouter?: boolean;
    readonly mechDigest?: `0x${string}`;
    readonly bytes?: Uint8Array;
    /** When set, the IPFS plane (`byDigest`) misses — mirrors a native record never pinned to IPFS. */
    readonly ipfsMiss?: boolean;
    /** What the HTTP serving plane (`byLocation`) returns; absent means the plane is never reachable. */
    readonly httpBytes?: Uint8Array;
  } = {}) {
    const byDigest = vi.fn(async () => {
      if (options.ipfsMiss) throw new Error('block was not found locally');
      return options.bytes ?? deliveryBytes;
    });
    const byLocation = vi.fn(async () => {
      if (options.httpBytes === undefined) throw new Error('no public replica in this fixture');
      return options.httpBytes;
    });
    const routerEvent = {
      args: { operator, requestId, taskId: 42n, attemptIndex: 3 },
      transactionHash,
      blockHash: routerBlockHash,
      blockNumber: 90n,
    };
    const publicClient = {
      async getBlockNumber() { return 100n; },
      async readContract(input: { functionName: string }) {
        if (input.functionName === 'mapRequestIdInfos') {
          return [deliveryMech, deliveryMech, operator, 60n, 1n, `0x${'00'.repeat(32)}`] as const;
        }
        if (input.functionName === 'getOperator') return operator;
        if (input.functionName === 'mapAgentMechFactories') return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        throw new Error(`unexpected read ${input.functionName}`);
      },
      async getContractEvents(input: { eventName: string; address: string }) {
        if (input.eventName === 'SolutionDeliveryClaimed') {
          return options.duplicateRouter ? [routerEvent, { ...routerEvent }] : [routerEvent];
        }
        expect(input.address.toLowerCase()).toBe(deliveryMech.toLowerCase());
        return [{
          args: {
            requestId,
            mechServiceMultisig: operator,
            data: options.mechDigest ?? `0x${advertisedDeliveryDigest.slice(7)}`,
          },
          transactionHash: `0x${'9a'.repeat(32)}`,
          blockHash: mechBlockHash,
          blockNumber: 80n,
        }];
      },
      async getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
        if (input.blockTag === 'finalized') {
          return { number: 95n, hash: `0x${'bc'.repeat(32)}`, timestamp: 1_000n };
        }
        return {
          number: input.blockNumber!,
          hash: input.blockNumber === 90n ? routerBlockHash : mechBlockHash,
          timestamp: 900n,
        };
      },
    };
    const reads = createBaseSepoliaEvaluatorReads({
      config: { ...requesterInput(), role: 'evaluator', marketplaceAgentAddress: '0x3333333333333333333333333333333333333333' },
      publicClient: publicClient as never,
      records: {
        byDigest,
        byLocation,
        async byRawCid() { throw new Error('unused'); },
      },
    });
    return { reads, byDigest, byLocation };
  }

  it('joins one canonical finalized router settlement to the exact Mech digest and public Delivery bytes', async () => {
    const { reads, byDigest } = fixture();
    await expect(reads.readCanonicalSolutionDelivery(expected)).resolves.toEqual({
      transactionHash,
      blockHash: routerBlockHash,
      blockNumber: 90n,
      finalized: true,
    });
    expect(byDigest).toHaveBeenCalledWith(advertisedDeliveryDigest);
  });

  it('fails closed on ambiguous settlement events, Mech digest mismatch, or tampered public bytes', async () => {
    await expect(fixture({ duplicateRouter: true }).reads.readCanonicalSolutionDelivery(expected)).resolves.toBeNull();
    const wrongDigest = `0x${'ff'.repeat(32)}` as const;
    const mechMismatch = fixture({ mechDigest: wrongDigest });
    await expect(mechMismatch.reads.readCanonicalSolutionDelivery(expected)).resolves.toBeNull();
    expect(mechMismatch.byDigest).not.toHaveBeenCalled();
    await expect(fixture({ bytes: new TextEncoder().encode('tampered') }).reads.readCanonicalSolutionDelivery(expected)).resolves.toBeNull();
  });

  // #2559 sibling (CP6): the delivery payload is a native record published ONLY to the solver's
  // HTTP serving plane and NEVER pinned to IPFS. The re-fetch must resolve it via the delivery
  // card's advertised HTTP locations, not the IPFS-only `byDigest`.
  it('resolves the exact public Delivery via the HTTP locator when the IPFS plane misses', async () => {
    const { reads, byLocation, byDigest } = fixture({ ipfsMiss: true, httpBytes: deliveryBytes });
    await expect(reads.readCanonicalSolutionDelivery({
      ...expected,
      deliveryPublicLocations: [deliveryLocation],
    })).resolves.toEqual({
      transactionHash,
      blockHash: routerBlockHash,
      blockNumber: 90n,
      finalized: true,
    });
    expect(byLocation).toHaveBeenCalledWith(deliveryLocation);
    // The HTTP plane produced the exact bytes, so the IPFS plane is never consulted.
    expect(byDigest).not.toHaveBeenCalled();
  });

  it('rejects forged HTTP Delivery bytes and never accepts a payload off the anchored digest', async () => {
    const forged = new TextEncoder().encode('{"delivery":"forged"}');
    // HTTP serves a digest-mismatched payload and IPFS also misses — no plane yields the anchored
    // bytes, so no canonical fact is returned and no verdict can form on a forged payload.
    const { reads, byLocation } = fixture({ ipfsMiss: true, httpBytes: forged });
    await expect(reads.readCanonicalSolutionDelivery({
      ...expected,
      deliveryPublicLocations: [deliveryLocation],
    })).rejects.toThrow(/not found locally/u);
    expect(byLocation).toHaveBeenCalledWith(deliveryLocation);
  });
});

describe('first-party Base Sepolia solver settlement Delivery re-fetch', () => {
  // Sibling of #2561 (the evaluator path), solver-side. The solver's OWN settlement reconcile
  // re-fetches its delivery payload to bind the on-chain settlement to the exact public Delivery.
  // Native delivery records are published only to the operator's HTTP serving plane and are never
  // pinned to IPFS, so the re-fetch must resolve via the solver's own advertised HTTP location.
  const requestId = `0x${'12'.repeat(32)}` as const;
  const transactionHash = `0x${'34'.repeat(32)}` as const;
  const routerBlockHash = `0x${'56'.repeat(32)}` as const;
  const mechBlockHash = `0x${'78'.repeat(32)}` as const;
  const deliveryMech = '0x9999999999999999999999999999999999999999' as const;
  const operator = SAFE;
  const deliveryBytes = new TextEncoder().encode('{"delivery":"exact"}');
  const advertisedDeliveryDigest = `sha256:${createHash('sha256').update(deliveryBytes).digest('hex')}` as const;
  const solutionDigest = `0x${'ab'.repeat(32)}` as const;
  const deliveryLocation = 'https://solver-b.example:7402/records/delivery' as const;

  const innerData = encodeFunctionData({
    abi: JINN_ROUTER_V3_ABI,
    functionName: 'claimSolutionDelivery',
    args: [requestId, solutionDigest],
  });
  const settlementInput = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [ADDRESSES.jinnRouter, 0n, innerData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  });

  const operation = {
    operationId: 'op-settlement-1',
    engagementId: 'eng-1',
    kind: 'solution-settlement',
    status: 'broadcast',
    txHash: transactionHash,
    priorTxHash: null,
    blockHash: null,
    blockNumber: null,
    detail: { attempt: 'urn:jinn:attempt:1', deliveryDigest: advertisedDeliveryDigest },
    createdAt: '2026-08-10T19:00:00.000Z',
    updatedAt: '2026-08-10T19:00:00.000Z',
  } as unknown as NativeOperationRow;
  const engagement = {
    engagementId: 'eng-1',
    chainId: 84532,
    coordinator: ADDRESSES.taskCoordinator,
    taskId: 42n,
    role: 'solver',
    operatorAgent: 'did:key:solver',
    taskDigest: `sha256:${'aa'.repeat(32)}`,
    submissionUri: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    submissionDigest: `sha256:${'bb'.repeat(32)}`,
    state: 'solution-settlement-pending',
    attemptIndex: 3,
    attemptUri: 'urn:jinn:attempt:1',
    requestId,
    createdAt: '2026-08-10T19:00:00.000Z',
    updatedAt: '2026-08-10T19:00:00.000Z',
  } as unknown as NativeEngagementRow;

  function fixture(options: {
    readonly httpBytes?: Uint8Array;
    readonly correspondenceTransactionHash?: `0x${string}`;
  } = {}) {
    // The IPFS plane always misses — the native delivery record was never pinned there.
    const byDigest = vi.fn(async () => { throw new Error('block was not found locally'); });
    const byLocation = vi.fn(async () => {
      if (options.httpBytes === undefined) throw new Error('no public replica in this fixture');
      return options.httpBytes;
    });
    const routerEvent = {
      args: { operator, requestId, taskId: 42n, attemptIndex: 3 },
      transactionHash,
      blockHash: routerBlockHash,
      blockNumber: 90n,
    };
    const publicClient = {
      async getBlockNumber() { return 100n; },
      async getTransaction() { return { input: settlementInput }; },
      async readContract(input: { functionName: string }) {
        if (input.functionName === 'mapRequestIdInfos') {
          return [deliveryMech, deliveryMech, operator, 60n, 1n, `0x${'00'.repeat(32)}`] as const;
        }
        if (input.functionName === 'getOperator') return operator;
        if (input.functionName === 'mapAgentMechFactories') return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        throw new Error(`unexpected read ${input.functionName}`);
      },
      async getContractEvents(input: {
        eventName: string;
        address?: string;
        args?: { readonly operator?: string };
      }) {
        if (input.eventName === 'SolutionDeliveryClaimed') {
          // The settlement leg scans `SolutionDeliveryClaimed` by `(requestId, taskId)`; the exact
          // Delivery correspondence (`readCanonicalSolutionDelivery`) scans the same event filtered
          // ON `operator` as well. Keying the fixture on that argument lets a case bind the
          // canonical exact Delivery to a DIFFERENT transaction than the settlement leg found.
          return options.correspondenceTransactionHash !== undefined && input.args?.operator !== undefined
            ? [{ ...routerEvent, transactionHash: options.correspondenceTransactionHash }]
            : [routerEvent];
        }
        expect(input.address!.toLowerCase()).toBe(deliveryMech.toLowerCase());
        return [{
          args: { requestId, mechServiceMultisig: operator, data: `0x${advertisedDeliveryDigest.slice(7)}` },
          transactionHash: `0x${'9a'.repeat(32)}`,
          blockHash: mechBlockHash,
          blockNumber: 80n,
        }];
      },
      async getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
        if (input.blockTag === 'finalized') {
          return { number: 95n, hash: `0x${'bc'.repeat(32)}`, timestamp: 1_000n };
        }
        return {
          number: input.blockNumber!,
          hash: input.blockNumber === 90n ? routerBlockHash : input.blockNumber === 80n ? mechBlockHash : `0x${'cd'.repeat(32)}`,
          timestamp: 0n,
        };
      },
    };
    const reads = createSolverReads({
      config: { safeAddress: SAFE, chain: { chainId: 84532, generation: 'today', contracts: ADDRESSES } },
      publicClient: publicClient as never,
      records: {
        byDigest,
        byLocation,
        async byRawCid() { throw new Error('unused'); },
      },
    });
    return { reads, byDigest, byLocation };
  }

  it('resolves the finalized settlement via the solver HTTP locator when the IPFS plane misses', async () => {
    const { reads, byLocation, byDigest } = fixture({ httpBytes: deliveryBytes });
    await expect(reads.solutionSettlementCanonical({
      operation,
      engagement,
      deliveryPublicLocations: [deliveryLocation],
    })).resolves.toMatchObject({ kind: 'finalized', txHash: transactionHash, blockNumber: 90n });
    expect(byLocation).toHaveBeenCalledWith(deliveryLocation);
    // The HTTP plane produced the exact bytes, so the IPFS plane is never consulted.
    expect(byDigest).not.toHaveBeenCalled();
  });

  it('does not complete settlement on forged HTTP Delivery bytes off the anchored digest', async () => {
    const forged = new TextEncoder().encode('{"delivery":"forged"}');
    const { reads, byLocation } = fixture({ httpBytes: forged });
    // HTTP serves a digest-mismatched payload and IPFS also misses — no plane yields the anchored
    // bytes, so the reconcile throws (holds the engagement) rather than settling a forged Delivery.
    await expect(reads.solutionSettlementCanonical({
      operation,
      engagement,
      deliveryPublicLocations: [deliveryLocation],
    })).rejects.toThrow(/not found locally/u);
    expect(byLocation).toHaveBeenCalledWith(deliveryLocation);
  });

  // POSITIVE evidence, and the only orphan verdict this leg still draws after the finalized check:
  // the canonical exact Delivery for this attempt is bound to a transaction that is not the one the
  // settlement leg observed. This branch had no coverage.
  it('orphans a settlement the canonical exact Delivery binds to a different transaction', async () => {
    const otherTransaction = `0x${'5c'.repeat(32)}` as const;
    const { reads } = fixture({
      httpBytes: deliveryBytes,
      correspondenceTransactionHash: otherTransaction,
    });

    await expect(reads.solutionSettlementCanonical({
      operation,
      engagement,
      deliveryPublicLocations: [deliveryLocation],
    })).resolves.toEqual({
      kind: 'orphaned',
      txHash: transactionHash,
      reason: 'solution settlement does not bind the exact public Delivery',
    });
  });

  // #2623: the absence of a digest in the operator's OWN local row is not evidence about the chain.
  // Calling it `orphaned` rolled the engagement back to `solution-published`, and the reopen that
  // followed re-entered this same branch on an operation whose detail the orphan notice had just
  // destroyed — an unbounded loop with no deadline and no attempt ceiling, because the orphan
  // recorder returns normally instead of raising. It must RAISE, so the coordinator's retry
  // machinery (24h deadline, 5 attempts) owns the give-up decision.
  it('raises rather than orphans when local state carries no exact Delivery digest', async () => {
    const { reads } = fixture({ httpBytes: deliveryBytes });
    const poisoned = {
      ...operation,
      // Operator B's live on-disk shape after the orphan notice overwrote the operation identity.
      detail: {
        kind: 'orphaned',
        txHash: transactionHash,
        reason: 'solution operation has no exact Delivery digest',
      },
    } as unknown as NativeOperationRow;

    await expect(reads.solutionSettlementCanonical({
      operation: poisoned,
      engagement,
      deliveryPublicLocations: [deliveryLocation],
    })).rejects.toThrow(/carries no exact Delivery digest/u);
  });
});

// Round 26 (CP6 live gate, Base Sepolia): the multi-provider RPC fallback chain served
// `finalized` heads that disagreed by 130-500 blocks between consecutive polls, and operator B's
// solution-settlement row was flipped to `status='orphaned'` with a NULL block number at
// 22:25:58Z even though its settlement transaction (0xc5d458e1…, block 45401836) was mined,
// successful, and finalized. Every classifier below must therefore treat ABSENCE — a lookup the
// polled provider cannot answer — as "not yet", and reserve `orphaned` for POSITIVE evidence
// (a receipt that reverted, or a block hash the canonical chain does not carry).
describe('transaction classification under multi-provider replica lag', () => {
  const txHash = `0x${'c5'.repeat(32)}` as const;
  const minedBlockHash = `0x${'d1'.repeat(32)}` as const;
  const displacedBlockHash = `0x${'e2'.repeat(32)}` as const;
  const unusedRecords = {
    async byDigest() { throw new Error('unused'); },
    async byLocation() { throw new Error('unused'); },
    async byRawCid() { throw new Error('unused'); },
  };

  function evaluatorChain(publicClient: unknown) {
    return createBaseSepoliaEvaluatorReads({
      config: {
        ...requesterInput(),
        role: 'evaluator',
        marketplaceAgentAddress: '0x3333333333333333333333333333333333333333',
      },
      publicClient: publicClient as never,
      records: unusedRecords,
    }).chain;
  }

  it('classifies a transaction the polled provider cannot see as pending, never orphaned', async () => {
    // Both lookups fail exactly as they do against a lagging replica in the fallback chain: the
    // slot that answers has neither the receipt nor the transaction in its own view. That is
    // indistinguishable from a genuinely dropped transaction, so it must NOT be classified as a
    // reorg — the destructive rollback on the evaluator legs NULLs the attempt identity.
    const chain = evaluatorChain({
      async getTransactionReceipt() { throw new Error('Transaction receipt could not be found.'); },
      async getTransaction() { throw new Error('Transaction could not be found.'); },
      async getBlock() { throw new Error('the classifier must not need a block read to say pending'); },
    });
    await expect(chain.transactionStatus(txHash)).resolves.toEqual({ kind: 'pending' });
  });

  it('still classifies a reverted receipt as orphaned', async () => {
    const chain = evaluatorChain({
      async getTransactionReceipt() {
        return { status: 'reverted', blockNumber: 90n, blockHash: minedBlockHash };
      },
      async getBlock() { return { number: 90n, hash: minedBlockHash, timestamp: 0n }; },
    });
    await expect(chain.transactionStatus(txHash)).resolves.toMatchObject({ kind: 'orphaned' });
  });

  it('still classifies a receipt whose block the canonical chain displaced as orphaned', async () => {
    const chain = evaluatorChain({
      async getTransactionReceipt() {
        return { status: 'success', blockNumber: 90n, blockHash: displacedBlockHash };
      },
      async getBlock() { return { number: 90n, hash: minedBlockHash, timestamp: 0n }; },
    });
    await expect(chain.transactionStatus(txHash)).resolves.toMatchObject({ kind: 'orphaned' });
  });

  it('classifies a successful receipt in a canonical block as canonical', async () => {
    const chain = evaluatorChain({
      async getTransactionReceipt() {
        return { status: 'success', blockNumber: 90n, blockHash: minedBlockHash };
      },
      async getBlock() { return { number: 90n, hash: minedBlockHash, timestamp: 0n }; },
    });
    await expect(chain.transactionStatus(txHash)).resolves.toEqual({ kind: 'canonical' });
  });

  const claimOperation = {
    operationId: 'op-claim-1',
    engagementId: 'eng-1',
    kind: 'claim',
    status: 'broadcast',
    txHash,
    priorTxHash: null,
    blockHash: null,
    blockNumber: null,
    detail: {},
    createdAt: '2026-08-10T19:00:00.000Z',
    updatedAt: '2026-08-10T19:00:00.000Z',
  } as unknown as NativeOperationRow;
  const claimEngagement = {
    engagementId: 'eng-1',
    chainId: 84532,
    coordinator: ADDRESSES.taskCoordinator,
    taskId: 42n,
    role: 'solver',
    operatorAgent: 'did:key:solver',
    taskDigest: `sha256:${'aa'.repeat(32)}`,
    submissionUri: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    submissionDigest: `sha256:${'bb'.repeat(32)}`,
    state: 'claim-pending',
    attemptIndex: null,
    attemptUri: null,
    requestId: null,
    createdAt: '2026-08-10T19:00:00.000Z',
    updatedAt: '2026-08-10T19:00:00.000Z',
  } as unknown as NativeEngagementRow;

  function solverReads(publicClient: unknown) {
    return createSolverReads({
      config: { safeAddress: SAFE, chain: { chainId: 84532, generation: 'today', contracts: ADDRESSES } },
      publicClient: publicClient as never,
      records: unusedRecords,
    });
  }

  it('holds a claim the polled provider cannot see as broadcast, never orphaned', async () => {
    // A false claim orphan is the most expensive misclassification in the stack:
    // `recordClaimOrphaned` NULLs the engagement's attempt index, attempt URI, and request id and
    // returns it to `eligible`, and the retry then broadcasts a SECOND claim for work the first
    // claim may already own.
    const reads = solverReads({
      async getBlockNumber() { return 100n; },
      async getBlock(input: { blockNumber?: bigint }) {
        return { number: input.blockNumber ?? 100n, hash: minedBlockHash, timestamp: 0n };
      },
      async getContractEvents() { return []; },
      async getTransactionReceipt() { throw new Error('Transaction receipt could not be found.'); },
      async getTransaction() { throw new Error('Transaction could not be found.'); },
    });
    await expect(reads.claimCanonical.read({ operation: claimOperation, engagement: claimEngagement }))
      .resolves.toEqual({ kind: 'broadcast', txHash });
  });

  it('still classifies a claim receipt in a displaced block as orphaned', async () => {
    const reads = solverReads({
      async getBlockNumber() { return 100n; },
      async getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
        if (input.blockTag === 'finalized') return { number: 95n, hash: minedBlockHash, timestamp: 0n };
        return { number: input.blockNumber!, hash: minedBlockHash, timestamp: 0n };
      },
      async getContractEvents() { return []; },
      async getTransactionReceipt() {
        return { status: 'success', blockNumber: 90n, blockHash: displacedBlockHash };
      },
    });
    await expect(reads.claimCanonical.read({ operation: claimOperation, engagement: claimEngagement }))
      .resolves.toMatchObject({ kind: 'orphaned', txHash });
  });

  const settlementRequestId = `0x${'12'.repeat(32)}` as const;
  const settlementBlockHash = `0x${'56'.repeat(32)}` as const;
  const settlementDeliveryBytes = new TextEncoder().encode('{"delivery":"exact"}');
  const settlementDeliveryDigest =
    `sha256:${createHash('sha256').update(settlementDeliveryBytes).digest('hex')}` as const;
  const settlementInnerData = encodeFunctionData({
    abi: JINN_ROUTER_V3_ABI,
    functionName: 'claimSolutionDelivery',
    args: [settlementRequestId, `0x${'ab'.repeat(32)}`],
  });
  const settlementCalldata = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [ADDRESSES.jinnRouter, 0n, settlementInnerData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  });
  const settlementOperation = {
    operationId: 'op-settlement-1',
    engagementId: 'eng-1',
    kind: 'solution-settlement',
    status: 'broadcast',
    txHash,
    priorTxHash: null,
    blockHash: null,
    blockNumber: null,
    detail: { attempt: 'urn:jinn:attempt:1', deliveryDigest: settlementDeliveryDigest },
    createdAt: '2026-08-10T19:00:00.000Z',
    updatedAt: '2026-08-10T19:00:00.000Z',
  } as unknown as NativeOperationRow;
  const settlementEngagement = {
    ...(claimEngagement as unknown as Record<string, unknown>),
    state: 'solution-settlement-pending',
    attemptIndex: 3,
    attemptUri: 'urn:jinn:attempt:1',
    requestId: settlementRequestId,
  } as unknown as NativeEngagementRow;

  /**
   * A settlement whose own event is canonical and finalized, polled through a fallback chain whose
   * `finalized` head REGRESSES between reads — the live round-26 signature. The exact-Delivery
   * re-fetch then reads a head below the settlement block and yields no correspondence, which is
   * replica lag, not a reorg.
   */
  function flappingSettlementReads(options: { readonly displaced?: boolean } = {}) {
    let finalizedReads = 0;
    return solverReads({
      async getBlockNumber() { return 100n; },
      async getTransaction() { return { input: settlementCalldata }; },
      async getContractEvents(input: { eventName: string }) {
        if (input.eventName !== 'SolutionDeliveryClaimed') return [];
        return [{
          args: { operator: SAFE, requestId: settlementRequestId, taskId: 42n, attemptIndex: 3 },
          transactionHash: txHash,
          blockHash: options.displaced ? displacedBlockHash : settlementBlockHash,
          blockNumber: 90n,
        }];
      },
      async readContract(input: { functionName: string }) {
        if (input.functionName === 'mapRequestIdInfos') {
          return [SAFE, SAFE, SAFE, 60n, 1n, `0x${'00'.repeat(32)}`] as const;
        }
        if (input.functionName === 'getOperator') return SAFE;
        if (input.functionName === 'mapAgentMechFactories') return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        throw new Error(`unexpected read ${input.functionName}`);
      },
      async getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
        if (input.blockTag === 'finalized') {
          finalizedReads += 1;
          // First poll: the settlement block is finalized. Next poll rotates to a replica that is
          // 35 blocks behind and reports a head BELOW it.
          return { number: finalizedReads === 1 ? 95n : 60n, hash: minedBlockHash, timestamp: 0n };
        }
        return { number: input.blockNumber!, hash: settlementBlockHash, timestamp: 0n };
      },
    });
  }

  it('holds a settlement whose re-fetch loses to a regressing finalized head as broadcast', async () => {
    await expect(flappingSettlementReads().solutionSettlementCanonical({
      operation: settlementOperation,
      engagement: settlementEngagement,
      deliveryPublicLocations: [],
    })).resolves.toEqual({ kind: 'broadcast', txHash });
  });

  it('still classifies a settlement event in a displaced block as orphaned', async () => {
    await expect(flappingSettlementReads({ displaced: true }).solutionSettlementCanonical({
      operation: settlementOperation,
      engagement: settlementEngagement,
      deliveryPublicLocations: [],
    })).resolves.toMatchObject({ kind: 'orphaned', txHash });
  });
});

describe('first-party Base Sepolia viem readers', () => {
  it('requires both marketplace registration and matching Mech operator ownership', async () => {
    const reads: string[] = [];
    const { target } = createViemBaseSepoliaReadClients({
      async getChainId() { return 84532; },
      async getBytecode() { return '0x6000'; },
      async getBalance() { return 1n; },
      async getBlock() { return { number: 1n, hash: `0x${'11'.repeat(32)}`, timestamp: 2n }; },
      async readContract(input: { functionName: string; address: string }) {
        reads.push(`${input.functionName}:${input.address.toLowerCase()}`);
        return input.functionName === 'mapAgentMechFactories'
          ? '0x6666666666666666666666666666666666666666'
          : SAFE;
      },
      async getTransaction() { throw new Error('unused'); },
      async getTransactionReceipt() { throw new Error('unused'); },
      async getBlockNumber() { return 1n; },
    } as never);

    await expect(target.marketplaceAgentAuthorization({
      marketplace: ADDRESSES.mechMarketplace,
      agent: '0x3333333333333333333333333333333333333333',
      safe: SAFE,
    })).resolves.toBe(true);
    expect(reads).toEqual([
      `mapAgentMechFactories:${ADDRESSES.mechMarketplace.toLowerCase()}`,
      'getOperator:0x3333333333333333333333333333333333333333',
    ]);
  });
});

describe('first-party native public source owner', () => {
  it('owns one explicit listener and closes it idempotently', async () => {
    const owner = await mountBaseSepoliaPublicSource({
      listen: { host: '127.0.0.1', port: 0 },
      publicBaseUrl: 'http://127.0.0.1',
      handler: async () => new Response('ok'),
    });
    await expect(owner.ready()).resolves.toBe(true);
    await owner.close();
    await owner.close();
    await expect(owner.ready()).resolves.toBe(false);
  });
});

describe('canonical today-mode requester association', () => {
  const taskDigest = `sha256:${'ab'.repeat(32)}` as const;
  const txHash = `0x${'cd'.repeat(32)}` as const;
  const blockHash = `0x${'ef'.repeat(32)}` as const;
  const expected = {
    chainId: 84532,
    coordinator: ADDRESSES.taskCoordinator,
    creator: SAFE,
    taskId: 7n,
    taskDigest,
    txHash,
    terms: {
      solutionMaxDeliveryRateWei: 2n,
      verdictMaxDeliveryRateWei: 3n,
      responseTimeoutSeconds: 60n,
      allowSolverSelfEvaluation: false,
    },
    maxClaims: 1 as const,
  };
  const facts = {
    transaction: { hash: txHash, blockNumber: 90n, blockHash, status: 'success' as const },
    canonicalBlockHash: blockHash,
    finalizedBlock: 100n,
    event: {
      creator: SAFE,
      taskId: 7n,
      taskDigest,
      maxClaims: 1,
      solutionBudget: 2n,
      verdictBudget: 3n,
    },
    task: {
      creator: SAFE,
      taskDigest,
      maxClaims: 1,
      allowSolverSelfEvaluation: false,
    },
    payment: {
      creator: SAFE,
      taskDigest,
      solutionMaxDeliveryRateWei: 2n,
      verdictMaxDeliveryRateWei: 3n,
      responseTimeoutSeconds: 60n,
    },
  };

  it('accepts only the exact finalized transaction, TaskCoordinator record, payment, and terms', () => {
    expect(verifyCanonicalTodayTaskCreated(expected, facts)).toEqual({
      canonical: true,
      ...expected,
    });
  });

  // #2531 F4. `unfinalized` used to sit in this table and return `null` — the same `null` as a
  // forged taskId or a substituted payment — and the requester raised the lot as
  // "refuses non-canonical or mismatched TaskCreated association". It is now its own state.
  it('reports a mined-but-unfinalized transaction as awaiting finality, not as a refusal', () => {
    expect(verifyCanonicalTodayTaskCreated(expected, { ...facts, finalizedBlock: 89n })).toEqual({
      canonical: false,
      pending: 'awaiting-finality',
      blockNumber: 90n,
      finalizedBlock: 89n,
    });
  });

  it('accepts the moment the finalized head reaches the block, boundary included', () => {
    expect(verifyCanonicalTodayTaskCreated(expected, { ...facts, finalizedBlock: 90n }))
      .toEqual({ canonical: true, ...expected });
  });

  // The other half of the mandate: EVERY mismatch predicate is evaluated before finality, so a
  // tampered association can never disguise itself as merely pending. Each row is a refusal that
  // must stay a refusal, and each is asserted against an UNFINALIZED block so the pending branch
  // is the one it has to beat.
  it.each([
    ['reverted transaction', { transaction: { ...facts.transaction, status: 'reverted' as const } }],
    ['wrong transaction hash', { transaction: { ...facts.transaction, hash: `0x${'99'.repeat(32)}` } }],
    ['orphaned', { canonicalBlockHash: `0x${'01'.repeat(32)}` }],
    ['wrong event creator', { event: { ...facts.event, creator: `0x${'22'.repeat(20)}` } }],
    ['wrong taskId', { event: { ...facts.event, taskId: 8n } }],
    ['wrong event task digest', { event: { ...facts.event, taskDigest: `sha256:${'ba'.repeat(32)}` } }],
    ['wrong maxClaims', { event: { ...facts.event, maxClaims: 2 } }],
    ['wrong solution budget', { event: { ...facts.event, solutionBudget: 4n } }],
    ['wrong budget', { event: { ...facts.event, verdictBudget: 4n } }],
    ['wrong task creator', { task: { ...facts.task, creator: `0x${'22'.repeat(20)}` } }],
    ['wrong task digest', { task: { ...facts.task, taskDigest: `sha256:${'ba'.repeat(32)}` } }],
    ['wrong task maxClaims', { task: { ...facts.task, maxClaims: 2 } }],
    ['self evaluation', { task: { ...facts.task, allowSolverSelfEvaluation: true } }],
    ['wrong payment creator', { payment: { ...facts.payment, creator: `0x${'22'.repeat(20)}` } }],
    ['wrong payment task digest', { payment: { ...facts.payment, taskDigest: `sha256:${'ba'.repeat(32)}` } }],
    ['wrong rate', { payment: { ...facts.payment, solutionMaxDeliveryRateWei: 4n } }],
    ['wrong verdict rate', { payment: { ...facts.payment, verdictMaxDeliveryRateWei: 4n } }],
    ['wrong response timeout', { payment: { ...facts.payment, responseTimeoutSeconds: 61n } }],
  ])('refuses %s outright, even while unfinalized', (_label, override) => {
    expect(
      verifyCanonicalTodayTaskCreated(expected, { ...facts, finalizedBlock: 89n, ...override }),
    ).toBeNull();
  });

  it('refuses a foreign chain id outright', () => {
    expect(verifyCanonicalTodayTaskCreated({ ...expected, chainId: 8453 }, facts)).toBeNull();
  });
});

describe('first-party Base Sepolia finalized trust anchors', () => {
  const digest = `sha256:${'12'.repeat(32)}` as const;
  const transactionHash = `0x${'34'.repeat(32)}` as const;
  const blockHash = `0x${'56'.repeat(32)}` as const;
  const contractAddress = '0x5555555555555555555555555555555555555555' as const;

  function anchorReads(overrides: Partial<NativeBaseSepoliaAnchorReadClient> = {}): NativeBaseSepoliaAnchorReadClient {
    return {
      async transaction() {
        return {
          hash: transactionHash,
          to: contractAddress,
          input: `0xdeadbeef${'12'.repeat(32)}00`,
          blockHash,
          blockNumber: 90n,
        };
      },
      async receipt() {
        return { status: 'success', blockHash, blockNumber: 90n };
      },
      async block(number) {
        expect(number).toBe(90n);
        return { number: 90n, hash: blockHash, timestamp: 1_800_000_000n };
      },
      async finalizedBlockNumber() { return 100n; },
      ...overrides,
    };
  }

  it('derives anchor time only from a successful canonical transaction below the finalized head', async () => {
    const result = await createBaseSepoliaFinalizedAnchorClient(anchorReads()).lookupFinalizedAnchor({
      digest,
      locator: {
        profile: 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1',
        chainId: 84532,
        transactionHash,
        contractAddress,
        inputByteOffset: 4,
      },
    });

    expect(result).toEqual({
      digest,
      anchorTime: '2027-01-15T08:00:00.000Z',
      chainId: 84532,
      transactionHash,
      blockHash,
      blockNumber: 90n,
      finalized: true,
    });
  });

  it.each([
    ['wrong input offset', { inputByteOffset: 5 }, {}],
    ['wrong contract', {}, { transaction: async () => ({
      hash: transactionHash,
      to: SAFE,
      input: `0xdeadbeef${'12'.repeat(32)}00` as const,
      blockHash,
      blockNumber: 90n,
    }) }],
    ['failed receipt', {}, { receipt: async () => ({ status: 'reverted' as const, blockHash, blockNumber: 90n }) }],
    ['non-canonical block', {}, { block: async () => ({
      number: 90n,
      hash: `0x${'78'.repeat(32)}` as const,
      timestamp: 1_800_000_000n,
    }) }],
    ['unfinalized transaction', {}, { finalizedBlockNumber: async () => 89n }],
  ])('refuses %s', async (_label, locatorOverride, clientOverride) => {
    const result = await createBaseSepoliaFinalizedAnchorClient(anchorReads(
      clientOverride as Partial<NativeBaseSepoliaAnchorReadClient>,
    )).lookupFinalizedAnchor({
      digest,
      locator: {
        profile: 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1',
        chainId: 84532,
        transactionHash,
        contractAddress,
        inputByteOffset: 4,
        ...locatorOverride,
      },
    });

    expect(result).toBeNull();
  });
});
