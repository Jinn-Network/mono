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
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    submission: SUBMISSION_URN,
    task: { digest: { sha256: taskDigestHex } },
    requester: CREATOR,
    idempotencyKey: 'idem-1',
    nonce: 'nonce-1',
    deadline: DEADLINE,
  }));
}

const LEGACY_WINDOW_END_TS = Math.floor(Date.parse(DEADLINE) / 1000);

/** A legacy `SignedTaskV1` document -- what the legacy `CreatorLoop` actually posts (finding E32). */
function legacySignedTaskV1Bytes(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 'task.v1',
    id: 'legacy-task-1',
    solverType: 'prediction.v1',
    solverNetManifestCid: 'bafySolverNetManifest',
    contractId: 'prediction',
    contractVersion: 'v1',
    role: 'restoration',
    description: 'restore service health',
    window: { startTs: LEGACY_WINDOW_END_TS - 3600, endTs: LEGACY_WINDOW_END_TS },
    spec: {},
    eligibility: {},
    claimPolicy: { maxClaims: 2 },
    creator: { safeAddress: CREATOR, agentEoa: CREATOR },
    createdAt: LEGACY_WINDOW_END_TS - 3600,
    signature: {
      algo: 'secp256k1',
      signer: CREATOR,
      hash: `0x${'a'.repeat(64)}`,
      sig: `0x${'b'.repeat(130)}`,
    },
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

  // The dispatch context is sealed into the engagement ledger at CLAIM time, but `TaskCreated` is
  // the event that triggers the claim — so requiring a resolved descriptor for it made the flow
  // circular and dropped every task. Only the `attempt-engaged` emission dereferences the field
  // (`packages/marketplace/projector/src/observe.ts:824`), and that emission is driven by events
  // that exist because a claim already happened. So the drop is scoped to those events, and
  // `TaskCreated` carries an explicitly unengaged descriptor it never reads.
  it('admits a TaskCreated with an unengaged descriptor when no dispatch context exists yet', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    // No dispatch context registered — none can exist before the claim this event triggers.

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeDefined();
    expect(enriched!.projection.dispatchContext.uri).toContain('unengaged');
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

  it('resolves a native today-mode Deliver whose content is HTTP-served but absent from the IPFS gateway', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    const delivery = content({ result: 'service restored', evidence: ['probe-1'] });
    const requestId = `0x${'a'.repeat(64)}` as Hex;
    const onChainKeccak = keccakEvidenceHash(delivery.bytes);

    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);
    store.todayDeliveryFacts.set(requestId.toLowerCase(), { taskId: TASK_ID, attemptIndex: 0, onChainKeccak });
    // Delivery bytes live ONLY behind the HTTP record source, never on the IPFS gateway.
    const httpRecords = new Map<string, Uint8Array>([[delivery.digest, delivery.bytes]]);

    const enrich = createProjectorEnrich(buildPorts(store, {
      fetchDeliveryBytes: async (digest) => httpRecords.get(digest),
    }));
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

    expect(enriched?.projection.deliveryCorrespondence).toEqual({
      sha256Digest: delivery.digest,
      keccakEvidenceHash: onChainKeccak,
      onChainSha256CidDigest: delivery.digest,
      onChainKeccak,
    });
  });

  it('rejects forged HTTP-served Deliver bytes that do not hash to the on-chain anchor', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    const delivery = content({ result: 'service restored', evidence: ['probe-1'] });
    const forged = content({ result: 'tampered', evidence: ['forged'] });
    const requestId = `0x${'a'.repeat(64)}` as Hex;

    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);
    store.todayDeliveryFacts.set(requestId.toLowerCase(), {
      taskId: TASK_ID,
      attemptIndex: 0,
      onChainKeccak: keccakEvidenceHash(delivery.bytes),
    });

    const enrich = createProjectorEnrich(buildPorts(store, {
      // The HTTP source returns bytes that do not hash to the on-chain sha256 anchor.
      fetchDeliveryBytes: async () => forged.bytes,
    }));
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

    // Fail closed: forged bytes are dropped, not admitted with a bogus correspondence.
    expect(await enrich(deliverEvent)).toBeUndefined();
  });

  // Bridge synthesis path (finding E32 / ruling E32): the legacy `CreatorLoop` posts a
  // `SignedTaskV1` document directly, with no sealed TEP Submission. A previously-strict
  // `SubmissionRecordSchema`-only validation dropped every one of these events; the ruling
  // relaxes exactly this one case.
  it('admits a today-mode TaskCreated whose resolved document is a legacy SignedTaskV1, synthesizing a bridge Submission-equivalent', async () => {
    const store = buildFixtureStore();
    const legacyTaskBytes = legacySignedTaskV1Bytes();
    const legacyTaskDigest = computeRawCodecCid(legacyTaskBytes).sha256Digest;
    // No separate Submission→Task indirection for the bridge path: `resolveSubmissionBytes`
    // resolves the SignedTaskV1 bytes themselves, and there is nothing further to fetch from
    // IPFS -- deliberately no `store.ipfs` entry.
    store.submissionsByTask.set(TASK_ID.toString(), legacyTaskBytes);
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(legacyTaskDigest.slice('sha256:'.length)));

    expect(enriched).toBeDefined();
    expect(enriched?.projection.taskDigest).toBe(legacyTaskDigest);
    expect(enriched?.projection.effectiveDeadline).toBe(new Date(LEGACY_WINDOW_END_TS * 1000).toISOString());
    expect(enriched?.projection.submission).toMatch(/^urn:uuid:/);
    expect(enriched?.projection.dispatchContext).toEqual(DISPATCH_CONTEXT);
  });

  it('never invokes the SignedTaskV1 bridge fallback when the native requester mode disables it', async () => {
    const store = buildFixtureStore();
    const legacyTaskBytes = legacySignedTaskV1Bytes();
    const legacyTaskDigest = computeRawCodecCid(legacyTaskBytes).sha256Digest;
    store.submissionsByTask.set(TASK_ID.toString(), legacyTaskBytes);
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store, { allowLegacySignedTaskV1: false }));
    const enriched = await enrich(taskCreatedEvent(legacyTaskDigest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('still drops a today-mode TaskCreated whose resolved document is neither a valid Submission nor a valid SignedTaskV1', async () => {
    const store = buildFixtureStore();
    const garbage = new TextEncoder().encode(JSON.stringify({ not: 'a recognized document shape' }));
    const garbageDigest = computeRawCodecCid(garbage).sha256Digest;
    store.submissionsByTask.set(TASK_ID.toString(), garbage);
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(garbageDigest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('drops a legacy SignedTaskV1 whose on-chain taskCidDigest anchor disagrees with the resolved document itself', async () => {
    const store = buildFixtureStore();
    const legacyTaskBytes = legacySignedTaskV1Bytes();
    const otherTask = content({ instructions: 'a completely different task' });
    store.submissionsByTask.set(TASK_ID.toString(), legacyTaskBytes);
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    const enrich = createProjectorEnrich(buildPorts(store));
    // On-chain anchor names a digest unrelated to the resolved legacy document's own digest.
    const enriched = await enrich(taskCreatedEvent(otherTask.digest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  // Defect #47, third resolver miss. Exactly the `fetchDeliveryBytes` (#23/#2559/#2561) class, one
  // leg further up the digest join: a NATIVE Task document is HTTP-served off the requester's own
  // record plane and need never reach the IPFS gateway. Before `fetchTaskBytes`, the join's
  // content-fetch step went straight to `fetchIpfsBytes`, so every event for a native task dropped
  // at "Task content ... unresolvable" even once its Submission resolved.
  it('resolves a Task document that is HTTP-served but absent from the IPFS gateway', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);
    // Task bytes live ONLY behind the record source -- deliberately no `store.ipfs` entry.
    const httpRecords = new Map<string, Uint8Array>([[task.digest, task.bytes]]);

    const enrich = createProjectorEnrich(buildPorts(store, {
      fetchTaskBytes: async (digest) => httpRecords.get(digest),
    }));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeDefined();
    expect(enriched?.projection.taskDigest).toBe(task.digest);
  });

  it('still re-derives the digest of record-plane Task bytes and drops them when they do not match the claim', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    const forged = content({ instructions: 'a different task entirely' });
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);
    // The record plane serves the WRONG bytes under the claimed Task digest.
    const httpRecords = new Map<string, Uint8Array>([[task.digest, forged.bytes]]);

    const enrich = createProjectorEnrich(buildPorts(store, {
      fetchTaskBytes: async (digest) => httpRecords.get(digest),
    }));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched).toBeUndefined();
  });

  it('falls back to the IPFS gateway for Task content when no record-plane resolver is wired', async () => {
    const store = buildFixtureStore();
    const task = content({ instructions: 'restore service health' });
    store.ipfs.set(task.digest, task.bytes);
    store.submissionsByTask.set(TASK_ID.toString(), submissionRecordBytes(task.digest.slice('sha256:'.length)));
    store.dispatchContexts.set(TASK_ID.toString(), DISPATCH_CONTEXT);

    // No `fetchTaskBytes` -- the legacy composition has no record source.
    const enrich = createProjectorEnrich(buildPorts(store));
    const enriched = await enrich(taskCreatedEvent(task.digest.slice('sha256:'.length)));

    expect(enriched?.projection.taskDigest).toBe(task.digest);
  });

  // Defect #47 diagnosability: a drop is PERMANENT (the chain-log cursor is committed before
  // `poll()` returns), so the one log line it emits has to name the block the replay must reach.
  it('names the event kind and block in the drop line so the replay range is recoverable from logs', async () => {
    const store = buildFixtureStore();
    const warn = vi.fn();
    const enrich = createProjectorEnrich(buildPorts(store, { logger: { warn } }));

    // No Submission resolvable for this task -- the exact round-28 drop.
    await enrich(taskCreatedEvent('a'.repeat(64), { blockNumber: 45_420_025 }));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('TaskCreated at block 45420025'),
    );
  });
});
