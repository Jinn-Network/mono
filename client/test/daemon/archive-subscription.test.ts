import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import type { MarketplaceProtocolObservation } from '@jinn-network/marketplace-projector';
import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';
import { buildArchiveSubscription } from '../../src/daemon/archive-subscription.js';
import { mapAnnouncedSubmissionToFacts } from '../../src/daemon/native-submission-facts.js';

const TASK_CREATED_ABI_ITEM = JINN_ROUTER_ABI.find(
  (item): item is Extract<typeof JINN_ROUTER_ABI[number], { name: 'TaskCreated' }> =>
    'name' in item && item.name === 'TaskCreated',
)!;

const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const TX_HASH = `0x${'aa'.repeat(32)}` as const;
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as const;
const CONTRACT = '0x2222222222222222222222222222222222222222' as const;

interface Fixture {
  readonly taskId: bigint;
  readonly manifestDigest: `0x${string}`;
  readonly taskBytes: Uint8Array;
  readonly taskDigest: `sha256:${string}`;
  readonly taskCidDigest: `0x${string}`;
  readonly solutionBudget: bigint;
  readonly logIndex: number;
  readonly log: { data: Hex; topics: readonly Hex[]; logIndex: number };
}

function buildFixture(overrides: Partial<{ taskId: bigint; manifestDigest: `0x${string}` }> = {}): Fixture {
  const taskId = overrides.taskId ?? 7n;
  const manifestDigest = overrides.manifestDigest ?? (`0x${'cc'.repeat(32)}` as const);
  const taskBytes = new TextEncoder().encode(
    JSON.stringify({ protocol: 'https://spec.jinn.network/profiles/task-execution/v1', taskId: taskId.toString() }),
  );
  const taskDigest = documentDigest(taskBytes);
  const taskCidDigest = `0x${taskDigest.slice('sha256:'.length)}` as `0x${string}`;
  const solutionBudget = 1_000_000_000_000n;
  const logIndex = 3;

  const topics = encodeEventTopics({
    abi: [TASK_CREATED_ABI_ITEM],
    eventName: 'TaskCreated',
    args: { creator: CREATOR, taskId, manifestDigest },
  });
  const data = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint256' }, { type: 'uint256' }],
    [taskCidDigest, 5, solutionBudget, 2_000_000_000_000n],
  );

  return {
    taskId,
    manifestDigest,
    taskBytes,
    taskDigest,
    taskCidDigest,
    solutionBudget,
    logIndex,
    log: { data, topics, logIndex },
  };
}

function observationFor(fixture: Fixture, overrides: Partial<MarketplaceProtocolObservation> = {}): MarketplaceProtocolObservation {
  return {
    specversion: '1.0',
    id: `${TX_HASH}:${fixture.logIndex}:network.jinn.task-execution.submission-accepted.v1`,
    source: 'urn:jinn:marketplace-projector:eip155:84532:0x2222222222222222222222222222222222222222',
    subject: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    time: '2026-07-30T00:00:00.000Z',
    datacontenttype: 'application/json',
    sequence: '0000000000000001',
    taskdigest: fixture.taskDigest,
    type: 'network.jinn.task-execution.submission-accepted.v1',
    data: { submission: 'urn:uuid:11111111-1111-4111-8111-111111111111', task: fixture.taskDigest },
    derivation: {
      chainId: 84532,
      contract: CONTRACT,
      event: 'TaskCreated',
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      txHash: TX_HASH,
      logIndex: fixture.logIndex,
      finalityTier: 'finalized',
      contractGeneration: 'today',
    },
    ...overrides,
  } as MarketplaceProtocolObservation;
}

function fakePublicClient(fixture: Fixture) {
  return {
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      if (hash !== TX_HASH) throw new Error(`unexpected tx hash ${hash}`);
      return { logs: [fixture.log] };
    }),
  } as unknown as import('viem').PublicClient;
}

function fakeFetchIpfsBytes(fixture: Fixture) {
  return vi.fn(async (digest: `sha256:${string}`) => (digest === fixture.taskDigest ? fixture.taskBytes : undefined));
}

describe('buildArchiveSubscription', () => {
  it('yields a card from a real persisted submission-accepted observation', async () => {
    const fixture = buildFixture();
    const observation = observationFor(fixture);
    const archive = buildArchiveSubscription({
      readObservations: () => [observation],
      publicClient: fakePublicClient(fixture),
      fetchIpfsBytes: fakeFetchIpfsBytes(fixture),
    });

    const cards = await archive.since('');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.chain.taskId).toBe(fixture.taskId);
  });

  it('produces a legacy-derived card carrying derivationKind and legacyManifestDigest, accepted by mapAnnouncedSubmissionToFacts', async () => {
    const fixture = buildFixture({ manifestDigest: `0x${'dd'.repeat(32)}` });
    const observation = observationFor(fixture);
    const archive = buildArchiveSubscription({
      readObservations: () => [observation],
      publicClient: fakePublicClient(fixture),
      fetchIpfsBytes: fakeFetchIpfsBytes(fixture),
    });

    const [card] = await archive.since('');
    expect(card).toBeDefined();
    expect(card!.derivationKind).toBe('legacy');
    expect(card!.legacyManifestDigest).toBe(fixture.manifestDigest);

    const result = mapAnnouncedSubmissionToFacts(card!, {
      estimateAiUnits: () => 1,
      acceptLegacyCards: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.facts.taskId).toBe(fixture.taskId);
    expect(result.facts.legacyManifestDigest).toBe(fixture.manifestDigest);
  });

  it('ignores observations of a different type', async () => {
    const fixture = buildFixture();
    const observation = observationFor(fixture, {
      type: 'network.jinn.task-execution.submission-closed.v1',
      data: { reason: 'capacity' },
    } as never);
    const archive = buildArchiveSubscription({
      readObservations: () => [observation],
      publicClient: fakePublicClient(fixture),
      fetchIpfsBytes: fakeFetchIpfsBytes(fixture),
    });

    expect(await archive.since('')).toEqual([]);
  });

  it('filters observations at or before the supplied afterSequence watermark', async () => {
    const fixture = buildFixture();
    const observation = observationFor(fixture, { sequence: '0000000000000001' });
    const archive = buildArchiveSubscription({
      readObservations: () => [observation],
      publicClient: fakePublicClient(fixture),
      fetchIpfsBytes: fakeFetchIpfsBytes(fixture),
    });

    expect(await archive.since('0000000000000001')).toEqual([]);
    expect(await archive.since('0000000000000000')).toHaveLength(1);
  });

  it('skips (does not fabricate) a card when the decoded taskCidDigest does not match the observation digest', async () => {
    const fixture = buildFixture();
    const mismatched = observationFor(fixture, { taskdigest: `sha256:${'0'.repeat(64)}` } as never);
    const archive = buildArchiveSubscription({
      readObservations: () => [mismatched],
      publicClient: fakePublicClient(fixture),
      fetchIpfsBytes: fakeFetchIpfsBytes(fixture),
      logger: { info: () => undefined, warn: () => undefined },
    });

    expect(await archive.since('')).toEqual([]);
  });

  it('skips a card when the fetched task bytes do not hash to the observation digest', async () => {
    const fixture = buildFixture();
    const observation = observationFor(fixture);
    const archive = buildArchiveSubscription({
      readObservations: () => [observation],
      publicClient: fakePublicClient(fixture),
      fetchIpfsBytes: vi.fn(async () => new TextEncoder().encode('not the right bytes')),
      logger: { info: () => undefined, warn: () => undefined },
    });

    expect(await archive.since('')).toEqual([]);
  });

  it('skips a card when no log exists at the observation-derived logIndex', async () => {
    const fixture = buildFixture();
    const observation = observationFor(fixture, {
      derivation: {
        chainId: 84532,
        contract: CONTRACT,
        event: 'TaskCreated',
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        txHash: TX_HASH,
        logIndex: 999,
        finalityTier: 'finalized',
        contractGeneration: 'today',
      },
    } as never);
    const archive = buildArchiveSubscription({
      readObservations: () => [observation],
      publicClient: fakePublicClient(fixture),
      fetchIpfsBytes: fakeFetchIpfsBytes(fixture),
      logger: { info: () => undefined, warn: () => undefined },
    });

    expect(await archive.since('')).toEqual([]);
  });
});
