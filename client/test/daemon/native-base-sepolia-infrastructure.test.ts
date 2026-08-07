import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createBaseSepoliaFinalizedAnchorClient,
  createBaseSepoliaEvaluatorReads,
  createBaseSepoliaRecordTransport,
  createNativeInfrastructure,
  createViemBaseSepoliaReadClients,
  mountBaseSepoliaPublicSource,
  verifyCanonicalTodayTaskCreated,
  inspectBaseSepoliaNativeTarget,
  type NativeBaseSepoliaAnchorReadClient,
  type NativeBaseSepoliaTargetReadClient,
} from '../../src/daemon/native-base-sepolia-infrastructure.js';
import type { NativeInfrastructureFactoryInput } from '../../src/daemon/native-infrastructure-bundle.js';

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

  function fixture(options: {
    readonly duplicateRouter?: boolean;
    readonly mechDigest?: `0x${string}`;
    readonly bytes?: Uint8Array;
  } = {}) {
    const byDigest = vi.fn(async () => options.bytes ?? deliveryBytes);
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
        async byLocation() { throw new Error('unused'); },
        async byRawCid() { throw new Error('unused'); },
      },
    });
    return { reads, byDigest };
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

  it.each([
    ['unfinalized', { finalizedBlock: 89n }],
    ['orphaned', { canonicalBlockHash: `0x${'01'.repeat(32)}` }],
    ['wrong rate', { payment: { ...facts.payment, solutionMaxDeliveryRateWei: 4n } }],
    ['self evaluation', { task: { ...facts.task, allowSolverSelfEvaluation: true } }],
    ['wrong budget', { event: { ...facts.event, verdictBudget: 4n } }],
  ])('refuses %s facts', (_label, override) => {
    expect(verifyCanonicalTodayTaskCreated(expected, { ...facts, ...override })).toBeNull();
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
