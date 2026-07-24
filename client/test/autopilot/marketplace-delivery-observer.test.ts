import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  AutopilotCorrelation,
  AutopilotMutationResult,
  AutopilotReviewResult,
  AutopilotSessionCapsule,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  createAutopilotMarketplaceDeliveryObserver,
  type AutopilotMarketplaceDeliveryExpectation,
} from '../../src/autopilot/marketplace-delivery-observer.js';
import { MECH_DELIVER_EVENT } from '../../src/adapters/mech/contracts.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
import type {
  AutopilotDeliveryCandidateLookup,
  DiscoveryAPI,
} from '../../src/discovery/types.js';

const CHAIN_ID = 84532;
const TASK_ID = '501';
const TASK_CID_DIGEST = `0x${'33'.repeat(32)}` as Hex;
const TASK_CID = `f01551220${'33'.repeat(32)}`;
const TASK_TX = `0x${'44'.repeat(32)}` as Hex;
const REQUEST_ID = `0x${'11'.repeat(32)}` as Hex;
const ENVELOPE_DIGEST = `0x${'55'.repeat(32)}` as Hex;
const ENVELOPE_CID = `f01551220${'55'.repeat(32)}`;
const OPERATOR = `0x${'22'.repeat(20)}` as Address;
const EVALUATOR = `0x${'23'.repeat(20)}` as Address;
const MECH = `0x${'aa'.repeat(20)}` as Address;
const DELIVERY_TX = `0x${'77'.repeat(32)}` as Hex;
const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const AGENT_EOA = privateKeyToAccount(PRIVATE_KEY).address;
const CLAIM_OID = '2'.repeat(40);
const EXPECTED_HEAD = '3'.repeat(40);
const RESULTING_HEAD = '5'.repeat(40);
const REVIEWED_HEAD = '6'.repeat(40);
const REVIEW_REF_OID = '7'.repeat(40);
const V2_ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';
const REVIEW_GENERATION = '123e4567-e89b-42d3-a456-426614174001';

const session: AutopilotSessionCapsule = {
  schemaVersion: 'jinn-autopilot-session.v1',
  workflow: 'implement',
  repository: 'Jinn-Network/mono',
  issueNumber: 1901,
  prNumber: 1902,
  targetBase: 'next',
  branch: 'codex/marketplace-test',
  claimOid: CLAIM_OID,
  expectedHead: EXPECTED_HEAD,
  v2AttemptId: V2_ATTEMPT_ID,
  runnerId: 'runner-test',
  taskSnapshot: {
    title: 'Implement exact delivery observation',
    body: 'Use exact marketplace facts.',
    prBody: 'Closes the issue.',
    baseSha: '1'.repeat(40),
  },
  workflowContract: {
    skill: 'implement-issue',
    version: 'v2',
    resultSchema: 'jinn-autopilot-mutation-result.v1',
  },
  deadline: '2026-07-24T12:00:00.000Z',
  receiptAuthors: ['jinn-autopilot'],
};

function correlation(
  extension: Partial<AutopilotCorrelation> = {},
): AutopilotCorrelation {
  return {
    taskId: TASK_ID,
    attemptIndex: 0,
    requestId: REQUEST_ID,
    deliveryEnvelopeCid: ENVELOPE_CID,
    v2AttemptId: V2_ATTEMPT_ID,
    claimOid: CLAIM_OID,
    prNumber: session.prNumber,
    expectedHead: EXPECTED_HEAD,
    ...extension,
  };
}

function mutationResult(
  override: Partial<AutopilotMutationResult> = {},
): AutopilotMutationResult {
  return {
    schemaVersion: 'jinn-autopilot-mutation-result.v1',
    outcome: 'mutation-complete',
    correlation: correlation(),
    patch: [
      'diff --git a/example.ts b/example.ts',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'),
    summary: 'Implemented the exact change.',
    evidence: { commands: ['yarn test'], tests: ['focused tests passed'] },
    ...override,
  } as AutopilotMutationResult;
}

function reviewResult(): AutopilotReviewResult {
  return {
    schemaVersion: 'jinn-autopilot-review-result.v1',
    outcome: 'approve',
    correlation: correlation({
      resultingHead: REVIEWED_HEAD,
      reviewedHead: REVIEWED_HEAD,
      reviewGeneration: REVIEW_GENERATION,
      reviewRefOid: REVIEW_REF_OID,
    }),
    body: 'The complete exact head is approved.',
  };
}

async function signedEnvelope(
  role: 'solution' | 'verdict',
  payload: unknown,
  override: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const unsigned = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'jinn-repo.v1',
    role,
    generatedAt: 1_753_350_000,
    task: {
      cid: TASK_CID,
      onchainCreationTx: TASK_TX,
      onchainCreationBlock: 90,
      requestId: REQUEST_ID,
    },
    participant: {
      safeAddress: role === 'verdict' ? EVALUATOR : OPERATOR,
      agentEoa: AGENT_EOA,
    },
    window: { startTs: 1_753_349_000, endTs: 1_753_351_000 },
    executor: {
      implName: 'jinn-repo-autopilot',
      implVersion: '1.0.0',
      clientGitSha: '8'.repeat(40),
      codeDigest: `sha256:${'9'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'a'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: AGENT_EOA },
      mode: 'frozen',
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload,
    ...override,
  };
  const signature = await signCanonical(unsigned, PRIVATE_KEY, AGENT_EOA);
  return {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: signature.signer,
      hash: signature.hash,
      sig: signature.sig,
    },
  };
}

function deliverLog(args: {
  requestId?: Hex;
  digest?: Hex;
  operator?: Address;
  transactionHash?: Hex | null;
  blockNumber?: bigint | null;
} = {}) {
  const topics = encodeEventTopics({
    abi: [MECH_DELIVER_EVENT],
    eventName: 'Deliver',
    args: {
      mech: MECH,
      mechServiceMultisig: args.operator ?? OPERATOR,
    },
  });
  const data = encodeAbiParameters(
    [
      { name: 'requestId', type: 'bytes32' },
      { name: 'deliveryRate', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    [args.requestId ?? REQUEST_ID, 1n, args.digest ?? ENVELOPE_DIGEST],
  );
  return {
    address: MECH,
    topics,
    data,
    transactionHash: args.transactionHash === undefined ? DELIVERY_TX : args.transactionHash,
    blockNumber: args.blockNumber === undefined ? 120n : args.blockNumber,
  };
}

interface HarnessOptions {
  role?: 'solution' | 'verdict';
  payload?: unknown;
  envelopeOverride?: Record<string, unknown>;
  mutateEnvelope?: (envelope: Record<string, unknown>) => void;
  discoveryResult?: AutopilotDeliveryCandidateLookup;
  discoveryError?: Error;
  logs?: unknown[];
  rpcError?: Error;
  ipfsError?: Error;
  publisherSafe?: Address;
  publisherError?: Error;
  expectation?: Partial<AutopilotMarketplaceDeliveryExpectation>;
}

async function harness(options: HarnessOptions = {}) {
  const role = options.role ?? 'solution';
  const payload = options.payload ?? (
    role === 'solution' ? mutationResult() : reviewResult()
  );
  const envelope = await signedEnvelope(role, payload, options.envelopeOverride);
  options.mutateEnvelope?.(envelope);
  const signature = envelope.signature as { hash: Hex };
  const ready: AutopilotDeliveryCandidateLookup = {
    status: 'ready',
    role,
    task: {
      taskId: TASK_ID,
      taskCidDigest: TASK_CID_DIGEST,
      createdAtBlock: 90,
      createdAtTx: TASK_TX,
    },
    attempt: {
      taskId: TASK_ID,
      attemptIndex: 0,
      requestId: REQUEST_ID,
      operator: role === 'verdict' ? EVALUATOR : OPERATOR,
      createdAtBlock: role === 'verdict' ? null : 100,
    },
    solutionOperator: OPERATOR,
    envelope: {
      requestId: REQUEST_ID,
      manifestCid: ENVELOPE_CID,
      publisherAgentId: '7',
      manifestHash: signature.hash,
      enrichedAtBlock: 121,
    },
  };
  const discovery = {
    getAutopilotDeliveryCandidates: options.discoveryError
      ? vi.fn().mockRejectedValue(options.discoveryError)
      : vi.fn().mockResolvedValue(options.discoveryResult ?? ready),
  } as unknown as DiscoveryAPI;
  const getLogs = options.rpcError
    ? vi.fn().mockRejectedValue(options.rpcError)
    : vi.fn().mockResolvedValue(options.logs ?? [deliverLog()]);
  const fetchEnvelopeBytes = options.ipfsError
    ? vi.fn().mockRejectedValue(options.ipfsError)
    : vi.fn().mockResolvedValue(new TextEncoder().encode(JSON.stringify(envelope)));
  const resolvePublisherSafe = options.publisherError
    ? vi.fn().mockRejectedValue(options.publisherError)
    : vi.fn().mockResolvedValue(
        options.publisherSafe ?? (role === 'verdict' ? EVALUATOR : OPERATOR),
      );
  const observer = createAutopilotMarketplaceDeliveryObserver({
    discovery,
    publicClient: { getLogs } as unknown as PublicClient,
    mechContractAddress: MECH,
    fetchEnvelopeBytes,
    resolvePublisherSafe,
  });
  const expectedCorrelation = role === 'verdict'
    ? {
        resultingHead: REVIEWED_HEAD,
        reviewedHead: REVIEWED_HEAD,
        reviewGeneration: REVIEW_GENERATION,
        reviewRefOid: REVIEW_REF_OID,
      }
    : {};
  const expectation: AutopilotMarketplaceDeliveryExpectation = {
    chainId: CHAIN_ID,
    role,
    taskId: TASK_ID,
    taskCid: TASK_CID,
    session,
    fromBlock: 100n,
    toBlock: 150n,
    expectedCorrelation,
    ...(role === 'verdict' ? { solutionOperator: OPERATOR } : {}),
    ...options.expectation,
  };
  return {
    observer,
    expectation,
    discovery,
    getLogs,
    fetchEnvelopeBytes,
    resolvePublisherSafe,
    envelope,
  };
}

describe('Autopilot marketplace delivery observer', () => {
  it('verifies the exact indexed, Deliver, envelope, result, and session tuple', async () => {
    const fixture = await harness();

    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'verified',
      role: 'solution',
      task: { taskId: TASK_ID, taskCid: TASK_CID },
      attempt: { attemptIndex: 0, requestId: REQUEST_ID, operator: OPERATOR },
      delivery: {
        envelopeCid: ENVELOPE_CID,
        envelopeDigest: ENVELOPE_DIGEST,
        publisherAgentId: '7',
        transactionHash: DELIVERY_TX,
        blockNumber: 120n,
      },
      result: {
        schemaVersion: 'jinn-autopilot-mutation-result.v1',
        outcome: 'mutation-complete',
      },
    });
    expect(fixture.discovery.getAutopilotDeliveryCandidates).toHaveBeenCalledWith({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    });
    expect(fixture.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: MECH,
      fromBlock: 100n,
      toBlock: 150n,
    }));
    expect(fixture.fetchEnvelopeBytes).toHaveBeenCalledWith(ENVELOPE_CID);
    expect(fixture.resolvePublisherSafe).toHaveBeenCalledWith(
      CHAIN_ID,
      '7',
      121n,
    );
  });

  it('keeps not-yet-observable and transport failures pending', async () => {
    const indexedPending = await harness({
      discoveryResult: {
        status: 'pending',
        reason: 'attempt-not-indexed',
        taskId: TASK_ID,
        role: 'solution',
      },
    });
    await expect(indexedPending.observer.observe(indexedPending.expectation))
      .resolves.toMatchObject({ status: 'pending', reason: 'attempt-not-indexed' });

    const indexerDown = await harness({ discoveryError: new Error('indexer down') });
    await expect(indexerDown.observer.observe(indexerDown.expectation))
      .resolves.toMatchObject({ status: 'pending', reason: 'discovery-unavailable' });

    const noDelivery = await harness({ logs: [] });
    await expect(noDelivery.observer.observe(noDelivery.expectation))
      .resolves.toMatchObject({ status: 'pending', reason: 'delivery-not-found' });

    const unrelatedDelivery = await harness({
      logs: [deliverLog({ requestId: `0x${'88'.repeat(32)}` })],
    });
    await expect(unrelatedDelivery.observer.observe(unrelatedDelivery.expectation))
      .resolves.toMatchObject({ status: 'pending', reason: 'delivery-not-found' });

    const rpcDown = await harness({ rpcError: new Error('RPC down') });
    await expect(rpcDown.observer.observe(rpcDown.expectation))
      .resolves.toMatchObject({ status: 'pending', reason: 'rpc-unavailable' });

    const ipfsDown = await harness({ ipfsError: new TypeError('fetch failed') });
    await expect(ipfsDown.observer.observe(ipfsDown.expectation))
      .resolves.toMatchObject({ status: 'pending', reason: 'envelope-unavailable' });

    const identityRpcDown = await harness({ publisherError: new Error('RPC down') });
    await expect(identityRpcDown.observer.observe(identityRpcDown.expectation))
      .resolves.toMatchObject({ status: 'pending', reason: 'publisher-identity-unavailable' });
  });

  it('propagates exact discovery contradictions without touching RPC', async () => {
    const fixture = await harness({
      discoveryResult: {
        status: 'contradiction',
        reason: 'multiple-attempts',
        taskId: TASK_ID,
        role: 'solution',
      },
    });

    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'multiple-attempts',
    });
    expect(fixture.getLogs).not.toHaveBeenCalled();
  });

  it.each([
    ['attempt index', { attemptIndex: 1, requestId: REQUEST_ID }, 'stale-attempt'],
    ['request id', { attemptIndex: 0, requestId: `0x${'99'.repeat(32)}` }, 'stale-attempt'],
    ['envelope CID', { deliveryEnvelopeCid: `f01551220${'88'.repeat(32)}` }, 'stale-delivery'],
    ['delivery transaction', { deliveryTransactionHash: `0x${'88'.repeat(32)}` }, 'stale-delivery'],
    ['delivery block', { deliveryBlockNumber: 119n }, 'stale-delivery'],
  ] as const)(
    'rejects a persisted %s mismatch',
    async (_label, expectation, reason) => {
      const fixture = await harness({ expectation });
      await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
        status: 'contradiction',
        reason,
      });
    },
  );

  it.each([
    ['digest', { digest: `0x${'88'.repeat(32)}` as Hex }],
    ['operator', { operator: `0x${'88'.repeat(20)}` as Address }],
    ['missing transaction', { transactionHash: null }],
    ['missing block', { blockNumber: null }],
    ['block below bounds', { blockNumber: 99n }],
  ] as const)(
    'rejects a Deliver event with mismatched %s',
    async (_label, logArgs) => {
      const fixture = await harness({ logs: [deliverLog(logArgs)] });
      await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
        status: 'contradiction',
        reason: 'delivery-mismatch',
      });
    },
  );

  it('rejects a task CID whose digest does not match TaskCreated', async () => {
    const fixture = await harness({
      expectation: { taskCid: `f01551220${'88'.repeat(32)}` },
    });
    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'task-mismatch',
    });
  });

  it.each([
    ['solver type', { solverType: 'prediction.v0' }],
    ['role', { role: 'verdict' }],
    ['task CID', { task: { cid: `f01551220${'88'.repeat(32)}`, onchainCreationTx: TASK_TX, onchainCreationBlock: 90, requestId: REQUEST_ID } }],
    ['task transaction', { task: { cid: TASK_CID, onchainCreationTx: `0x${'88'.repeat(32)}`, onchainCreationBlock: 90, requestId: REQUEST_ID } }],
    ['task block', { task: { cid: TASK_CID, onchainCreationTx: TASK_TX, onchainCreationBlock: 91, requestId: REQUEST_ID } }],
    ['task request', { task: { cid: TASK_CID, onchainCreationTx: TASK_TX, onchainCreationBlock: 90, requestId: `0x${'88'.repeat(32)}` } }],
    ['participant Safe', { participant: { safeAddress: `0x${'88'.repeat(20)}`, agentEoa: AGENT_EOA } }],
  ] as const)(
    'rejects an authenticated envelope with mismatched %s',
    async (_label, envelopeOverride) => {
      const fixture = await harness({ envelopeOverride });
      await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
        status: 'contradiction',
        reason: 'envelope-mismatch',
      });
    },
  );

  it('rejects malformed bytes, invalid signatures, metadata hashes, and payload schemas', async () => {
    const malformed = await harness();
    malformed.fetchEnvelopeBytes.mockResolvedValue(
      new Uint8Array([0xc3, 0x28]),
    );
    await expect(malformed.observer.observe(malformed.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'invalid-envelope',
    });

    const malformedJson = await harness();
    malformedJson.fetchEnvelopeBytes.mockResolvedValue(
      new TextEncoder().encode('{'),
    );
    await expect(malformedJson.observer.observe(malformedJson.expectation))
      .resolves.toMatchObject({ status: 'contradiction', reason: 'invalid-envelope' });

    const tampered = await harness({
      mutateEnvelope: (envelope) => {
        envelope.generatedAt = 1;
      },
    });
    await expect(tampered.observer.observe(tampered.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'invalid-envelope',
    });

    const metadataHash = await harness();
    const ready = await metadataHash.discovery.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    }) as Extract<AutopilotDeliveryCandidateLookup, { status: 'ready' }>;
    metadataHash.discovery.getAutopilotDeliveryCandidates = vi.fn().mockResolvedValue({
      ...ready,
      envelope: { ...ready.envelope, manifestHash: `0x${'88'.repeat(32)}` },
    });
    await expect(metadataHash.observer.observe(metadataHash.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'envelope-mismatch',
    });

    const invalidPayload = await harness({
      payload: { schemaVersion: 'jinn-autopilot-mutation-result.v1', outcome: 'surprise' },
    });
    await expect(invalidPayload.observer.observe(invalidPayload.expectation))
      .resolves.toMatchObject({ status: 'contradiction', reason: 'invalid-result' });
  });

  it.each([
    ['taskId', { taskId: '999' }],
    ['attemptIndex', { attemptIndex: 2 }],
    ['requestId', { requestId: `0x${'88'.repeat(32)}` }],
    ['deliveryEnvelopeCid', { deliveryEnvelopeCid: `f01551220${'88'.repeat(32)}` }],
    ['v2AttemptId', { v2AttemptId: '123e4567-e89b-42d3-a456-426614174099' }],
    ['claimOid', { claimOid: '8'.repeat(40) }],
    ['prNumber', { prNumber: 999 }],
    ['expectedHead', { expectedHead: '8'.repeat(40) }],
  ] as const)(
    'rejects a result with mismatched correlation.%s',
    async (_field, override) => {
      const fixture = await harness({
        payload: mutationResult({
          correlation: correlation(override as Partial<AutopilotCorrelation>),
        }),
      });
      await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
        status: 'contradiction',
        reason: 'correlation-mismatch',
      });
    },
  );

  it('validates the additive Verdict result schema and review correlation', async () => {
    const fixture = await harness({ role: 'verdict' });
    fixture.getLogs.mockResolvedValue([deliverLog({ operator: EVALUATOR })]);

    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'verified',
      role: 'verdict',
      attempt: { operator: EVALUATOR },
      result: {
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'approve',
        correlation: {
          resultingHead: REVIEWED_HEAD,
          reviewedHead: REVIEWED_HEAD,
          reviewGeneration: REVIEW_GENERATION,
          reviewRefOid: REVIEW_REF_OID,
        },
      },
    });
  });

  it('rejects a forged publisher agent whose historical Safe is not the delivery operator', async () => {
    const fixture = await harness({
      publisherSafe: `0x${'88'.repeat(20)}` as Address,
    });

    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'publisher-mismatch',
    });
    expect(fixture.getLogs).not.toHaveBeenCalled();
  });

  it('rejects a verdict evaluator that is also the solution operator', async () => {
    const fixture = await harness({ role: 'verdict' });
    const ready = await fixture.discovery.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    }) as Extract<AutopilotDeliveryCandidateLookup, { status: 'ready' }>;
    fixture.discovery.getAutopilotDeliveryCandidates = vi.fn().mockResolvedValue({
      ...ready,
      attempt: { ...ready.attempt, operator: OPERATOR },
      solutionOperator: OPERATOR,
    });

    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'evaluator-is-solver',
    });
    expect(fixture.getLogs).not.toHaveBeenCalled();
  });

  it('rejects a discovered solution operator that differs from the authoritative expectation', async () => {
    const fixture = await harness({
      expectation: {
        solutionOperator: `0x${'88'.repeat(20)}`,
      },
    });

    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'discovery-mismatch',
    });
    expect(fixture.resolvePublisherSafe).not.toHaveBeenCalled();
  });

  it('rejects invalid expectations before performing discovery', async () => {
    const fixture = await harness({
      expectation: {
        fromBlock: 151n,
        toBlock: 150n,
      },
    });
    await expect(fixture.observer.observe(fixture.expectation)).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'invalid-expectation',
    });
    expect(fixture.discovery.getAutopilotDeliveryCandidates).not.toHaveBeenCalled();
  });
});
