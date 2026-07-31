import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { BASE_SEPOLIA_TODAY, computeRawCodecCid, keccakEvidenceHash } from '@jinn-network/marketplace-binding';
import type { MarketplaceEvent } from '@jinn-network/marketplace-projector';
import { createProjectorEnrich, type ProjectorEnrichPorts } from '../../src/daemon/projector-enrich.js';

// Far from `Date.now()` (2026-07-31 or so at the time this test was written) -- proves the
// resolved `projection.timestamp` came from the (fake) block, never the wall clock.
const BLOCK_TIMESTAMP_SECONDS = 1_000_000_000n; // 2001-09-09T01:46:40.000Z
const BLOCK_TIMESTAMP_ISO = new Date(Number(BLOCK_TIMESTAMP_SECONDS * 1000n)).toISOString();

const TASK_ID = 42n;
const CREATOR = '0x5555555555555555555555555555555555555555' satisfies Address;
const SUBMISSION_URN = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const DEADLINE = '2026-07-31T12:00:00Z';
const DISPATCH_CONTEXT = {
  uri: 'urn:jinn:marketplace:dispatch-context:42:0',
  digest: { sha256: '8'.repeat(64) },
};

function derivation(overrides: Partial<MarketplaceEvent['derivation']> = {}): MarketplaceEvent['derivation'] {
  return {
    chainId: BASE_SEPOLIA_TODAY.chainId,
    contract: BASE_SEPOLIA_TODAY.jinnRouter,
    event: 'TaskCreated',
    blockNumber: 120,
    blockHash: `0x${'1'.repeat(64)}` as Hex,
    txHash: `0x${'2'.repeat(64)}` as Hex,
    logIndex: 0,
    finalityTier: 'safe',
    contractGeneration: 'today',
    ...overrides,
  };
}

/** Builds real (bytes, digest) content for the fixture IPFS store -- never a raw guessed digest. */
function content(payload: unknown): { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` } {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return { bytes, digest: computeRawCodecCid(bytes).sha256Digest };
}

function submissionRecordBytes(taskDigestHex: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    protocol: 'https://jinn.network/tep/v1',
    submission: SUBMISSION_URN,
    task: { digest: { sha256: taskDigestHex } },
    requester: CREATOR,
    idempotencyKey: 'idem-1',
    nonce: 'nonce-1',
    deadline: DEADLINE,
  }));
}

interface FixtureStore {
  readonly ipfs: Map<string, Uint8Array>;
  readonly submissionsByTask: Map<string, Uint8Array>;
  readonly dispatchContexts: Map<string, typeof DISPATCH_CONTEXT>;
  readonly todayDeliveryFacts: Map<string, { taskId: bigint; attemptIndex: number; onChainKeccak: Hex }>;
}

function buildFixtureStore(): FixtureStore {
  return {
    ipfs: new Map(),
    submissionsByTask: new Map(),
    dispatchContexts: new Map(),
    todayDeliveryFacts: new Map(),
  };
}

function buildPorts(store: FixtureStore, overrides: Partial<ProjectorEnrichPorts> = {}): ProjectorEnrichPorts {
  return {
    chain: BASE_SEPOLIA_TODAY,
    publicClient: {
      getBlock: vi.fn(async () => ({ timestamp: BLOCK_TIMESTAMP_SECONDS }) as never),
    },
    fetchIpfsBytes: async (digest) => store.ipfs.get(digest),
    resolveSubmissionBytes: async (input) => store.submissionsByTask.get(input.taskId.toString()),
    resolveDispatchContext: async (input) => store.dispatchContexts.get(input.taskId.toString()),
    readTodayDeliveryFacts: async (requestId) => store.todayDeliveryFacts.get(requestId.toLowerCase()),
    ...overrides,
  };
}

function taskCreatedEvent(taskCidDigestHex: string, overrides: Partial<MarketplaceEvent['derivation']> = {}): MarketplaceEvent {
  return {
    event: 'TaskCreated',
    facts: {
      creator: CREATOR,
      taskId: TASK_ID,
      manifestDigest: `0x${'9'.repeat(64)}` as Hex,
      taskCidDigest: `0x${taskCidDigestHex}` as Hex,
      maxClaims: 2,
      solutionBudget: 100n,
      verdictBudget: 20n,
    },
    derivation: derivation(overrides),
  } as MarketplaceEvent;
}

describe('createProjectorEnrich', () => {
  it('enriches a real TaskCreated against a fixture IPFS store', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const event = taskCreatedEvent(task.digest.slice('sha256:'.length));
    const enriched = await enrich(event);

    expect(enriched).toBeDefined();
    expect(enriched?.projection).toEqual({
      taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      timestamp: BLOCK_TIMESTAMP_ISO,
      submission: SUBMISSION_URN,
      taskDigest: task.digest,
      effectiveDeadline: DEADLINE,
      dispatchContext: DISPATCH_CONTEXT,
    });
  });

  it('sources the timestamp from the block, never the wall clock', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    const now = Date.now();
    const resolved = new Date(enriched?.projection.timestamp ?? 0).getTime();
    expect(enriched?.projection.timestamp).toBe(BLOCK_TIMESTAMP_ISO);
    // BLOCK_TIMESTAMP_SECONDS is ~25 years before "now" at the time this test was written --
    // any wall-clock leak (e.g. `new Date()` standing in for the block read) would land within
    // milliseconds of `now`, not decades away.
    expect(Math.abs(now - resolved)).toBeGreaterThan(1000 * 60 * 60 * 24 * 365);
  });

  it('caches the block timestamp per block hash rather than re-fetching per event', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const getBlock = vi.fn(async () => ({ timestamp: BLOCK_TIMESTAMP_SECONDS }) as never);
    const enrich = createProjectorEnrich(buildPorts(store, { publicClient: { getBlock } }));

    await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));
    await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length), { logIndex: 1 }));

    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it('drops an event whose signed Submission cannot be resolved', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.ipfs.set(task.digest, task.bytes);
    // Deliberately no `submissionsByTask` entry -- the host cannot resolve the signed record.
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('drops an event whose fetched Task content is missing from the IPFS store', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    // Submission resolves and claims a task digest, but the Task bytes themselves are never
    // pinned into the fixture store -- an honest "signed record unresolvable" case.
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('drops on a digest-join mismatch between the on-chain anchor and the Submission claim, rather than warning', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    const otherTask = content({ instructions: 'a completely different task' });
    store.ipfs.set(task.digest, task.bytes);
    store.ipfs.set(otherTask.digest, otherTask.bytes);
    // Submission claims `otherTask`'s digest, but the on-chain TaskCreated event anchors `task`'s
    // digest -- the on-chain leg and the Submission leg of the join disagree.
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(otherTask.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('drops when the fetched Task bytes do not actually hash to the digest the Submission claimed', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    const wrongBytes = new TextEncoder().encode(JSON.stringify({ instructions: 'tampered content' }));
    // The gateway (fixture) returns different bytes than the digest actually names -- a corrupt
    // or dishonest content source, not a missing one.
    store.ipfs.set(task.digest, wrongBytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('drops an event whose dispatch context cannot be resolved', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    // No dispatch context registered.

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('enriches a real today-mode Mech Deliver, producing deliveryCorrespondence', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    const delivery = content({ result: 'service restored', evidence: ['probe-1'] });
    const requestId = `0x${'a'.repeat(64)}` as Hex;
    const onChainKeccak = keccakEvidenceHash(delivery.bytes);

    store.ipfs.set(task.digest, task.bytes);
    store.ipfs.set(delivery.digest, delivery.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);
    store.todayDeliveryFacts.set(requestId.toLowerCase(), { taskId: TASK_ID, attemptIndex: 0, onChainKeccak });

    const enrich = createProjectorEnrich(buildPorts(store));
    const deliverEvent: MarketplaceEvent = {
      event: 'Deliver',
      facts: {
        mech: '0x6666666666666666666666666666666666666666' as Address,
        mechServiceMultisig: '0x7777777777777777777777777777777777777777' as Address,
        requestId,
        deliveryRate: 10n,
        data: `0x${delivery.digest.slice('sha256:'.length)}` as Hex,
      },
      derivation: derivation({ event: 'Deliver' }),
    } as MarketplaceEvent;

    const enriched = await enrich(deliverEvent);

    expect(enriched).toBeDefined();
    expect(enriched?.projection.deliveryCorrespondence).toEqual({
      sha256Digest: delivery.digest,
      keccakEvidenceHash: onChainKeccak,
      onChainSha256CidDigest: delivery.digest,
      onChainKeccak,
    });
    // Deliver events still carry the full projection context -- resolved for real, not faked --
    // even though the reducer does not read it for this event kind.
    expect(enriched?.projection.submission).toBe(SUBMISSION_URN);
    expect(enriched?.projection.taskDigest).toBe(task.digest);
  });

  it('drops a today-mode Deliver whose requestId has no on-chain reference yet', async () => {
    const store = buildFixtureStore();
    const enrich = createProjectorEnrich(buildPorts(store));
    const deliverEvent: MarketplaceEvent = {
      event: 'Deliver',
      facts: {
        mech: '0x6666666666666666666666666666666666666666' as Address,
        mechServiceMultisig: '0x7777777777777777777777777777777777777777' as Address,
        requestId: `0x${'b'.repeat(64)}` as Hex,
        deliveryRate: 10n,
        data: `0x${'c'.repeat(64)}` as Hex,
      },
      derivation: derivation({ event: 'Deliver' }),
    } as MarketplaceEvent;

    const enriched = await enrich(deliverEvent);

    expect(enriched).toBeUndefined();
  });

  it('drops a today-mode Deliver whose delivered content is unresolvable, rather than admitting it without deliveryCorrespondence', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    const requestId = `0x${'d'.repeat(64)}` as Hex;

    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);
    store.todayDeliveryFacts.set(requestId.toLowerCase(), {
      taskId: TASK_ID,
      attemptIndex: 0,
      onChainKeccak: `0x${'e'.repeat(64)}` as Hex,
    });
    // Deliberately no IPFS entry for the delivered content's digest.

    const enrich = createProjectorEnrich(buildPorts(store));
    const deliverEvent: MarketplaceEvent = {
      event: 'Deliver',
      facts: {
        mech: '0x6666666666666666666666666666666666666666' as Address,
        mechServiceMultisig: '0x7777777777777777777777777777777777777777' as Address,
        requestId,
        deliveryRate: 10n,
        data: `0x${'f'.repeat(64)}` as Hex,
      },
      derivation: derivation({ event: 'Deliver' }),
    } as MarketplaceEvent;

    const enriched = await enrich(deliverEvent);

    // Unresolvable-right-now is treated as transient (a retry next tick can supply it once IPFS
    // catches up), not as a confirmed absence -- admitting it here would permanently mark the log
    // id processed with no correspondence, indistinguishable from a genuine content-corruption
    // rejection that a retry could never have fixed.
    expect(enriched).toBeUndefined();
  });
});
