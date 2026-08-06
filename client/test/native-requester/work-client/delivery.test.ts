import { describe, expect, it, vi } from 'vitest';
import {
  documentDigest,
  sealDelivery,
  type DeliveryRecord,
} from '@jinn-network/task-execution-protocol';
import { TaskExecutionError, type DeliveryRef, type ObservationSnapshot } from '@jinn-network/task-execution-backend';
import {
  adoptPostedTask,
  isRequesterError,
  observeDeliveries,
  verifyDeliveryRef,
  type AdoptionDecision,
  type AdoptedTaskFacts,
  type DeliveryObservePort,
} from '../../../src/native-requester/work-client/index.js';

const ATTEMPT = 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as const;
const SUBMISSION = 'urn:uuid:11111111-2222-3333-4444-555555555555' as const;
const TASK_DIGEST = `sha256:${'a'.repeat(64)}` as const;

/** A canonical DeliveryRecord bound to the posted Attempt + Task. */
function makeDelivery(overrides: Partial<DeliveryRecord> = {}): { record: DeliveryRecord; bytes: Uint8Array; digest: `sha256:${string}` } {
  const record = DeliveryRecordSchemaBuild({
    protocol: 'https://spec.jinn.network/task-execution/v1',
    attempt: ATTEMPT,
    task: TASK_DIGEST,
    outputs: [],
    outcome: 'fulfilled',
    createdAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  });
  const bytes = sealDelivery(record);
  return { record, bytes, digest: documentDigest(bytes) };
}

// The schema is `.loose()`, so this is just a typed passthrough; sealDelivery canonicalizes.
function DeliveryRecordSchemaBuild(value: DeliveryRecord): DeliveryRecord {
  return value;
}

function descriptorFor(deliveryDigests: readonly `sha256:${string}`[], overrides?: {
  submission?: string;
  task?: `sha256:${string}`;
  contradictory?: boolean;
}): ObservationSnapshot {
  return {
    descriptor: {
      attempt: ATTEMPT,
      task: overrides?.task ?? TASK_DIGEST,
      submission: (overrides?.submission ?? SUBMISSION) as `urn:uuid:${string}`,
      derived: {
        state: 'delivered',
        terminal: true,
        contradictory: overrides?.contradictory ?? false,
        cancelRequested: false,
        executionIds: [],
        deliveries: deliveryDigests.map((digest) => ({ digest })),
      },
    },
    cursor: { sequence: '1' },
    observations: [],
  };
}

/** A fake observe port over an in-memory delivery table. */
function fakePort(input: {
  snapshot?: ObservationSnapshot | (() => Promise<ObservationSnapshot>);
  refs?: DeliveryRef[];
  bytesByDigest?: Map<string, Uint8Array>;
  receipts?: { publish: (d: AdoptionDecision) => Promise<void> };
}): DeliveryObservePort & { receipts: { publish: (d: AdoptionDecision) => Promise<void> } } {
  return {
    observe: async () => {
      if (typeof input.snapshot === 'function') return input.snapshot();
      if (input.snapshot === undefined) throw new TaskExecutionError('attempt-not-found');
      return input.snapshot;
    },
    deliveries: async () => input.refs ?? [],
    fetchDelivery: async (ref) => {
      const bytes = input.bytesByDigest?.get(ref.digest);
      if (bytes === undefined) throw new TaskExecutionError('result-unavailable');
      return bytes;
    },
    receipts: input.receipts ?? { publish: async () => {} },
  };
}

const FACTS: AdoptedTaskFacts = { taskId: 42n, taskDigest: TASK_DIGEST, submissionUri: SUBMISSION };

describe('verifyDeliveryRef', () => {
  it('accepts a delivery whose bytes hash to the claimed digest', async () => {
    const { bytes, digest } = makeDelivery();
    const port = fakePort({ bytesByDigest: new Map([[digest, bytes]]) });
    const observed = await verifyDeliveryRef({ attempt: ATTEMPT, digest }, ATTEMPT, port);
    expect(observed.digest).toBe(digest);
    expect(observed.delivery.task).toBe(TASK_DIGEST);
  });

  it('REFUSES a tampered delivery (bytes do not hash to the claimed digest)', async () => {
    const { bytes } = makeDelivery();
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 2] ^= 0xff; // flip a byte inside the payload
    const claimedDigest = documentDigest(bytes); // ref still claims the ORIGINAL digest
    const port = fakePort({ bytesByDigest: new Map([[claimedDigest, tampered]]) });
    await expect(verifyDeliveryRef({ attempt: ATTEMPT, digest: claimedDigest }, ATTEMPT, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.category === 'delivery' && err.code === 'digest-mismatch');
  });

  it('REFUSES bytes that are not a canonical DeliveryRecord', async () => {
    const junk = new TextEncoder().encode('{"not":"a delivery"}');
    const digest = documentDigest(junk);
    const port = fakePort({ bytesByDigest: new Map([[digest, junk]]) });
    await expect(verifyDeliveryRef({ attempt: ATTEMPT, digest }, ATTEMPT, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'invalid-delivery');
  });

  it('REFUSES a ref that names a different attempt', async () => {
    const { bytes, digest } = makeDelivery();
    const port = fakePort({ bytesByDigest: new Map([[digest, bytes]]) });
    await expect(verifyDeliveryRef({ attempt: 'urn:uuid:00000000-0000-0000-0000-000000000000', digest }, ATTEMPT, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'attempt-mismatch');
  });
});

describe('observeDeliveries', () => {
  it('returns [] when no delivery is recorded yet', async () => {
    const port = fakePort({ refs: [] });
    expect(await observeDeliveries(ATTEMPT, port)).toEqual([]);
  });

  it('verifies each recorded delivery', async () => {
    const { bytes, digest } = makeDelivery();
    const port = fakePort({ refs: [{ attempt: ATTEMPT, digest }], bytesByDigest: new Map([[digest, bytes]]) });
    const observed = await observeDeliveries(ATTEMPT, port);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.digest).toBe(digest);
  });
});

describe('adoptPostedTask', () => {
  it('adopts a matching delivery and records the decision durably', async () => {
    const { bytes, digest } = makeDelivery();
    const publish = vi.fn(async () => {});
    const port = fakePort({
      snapshot: descriptorFor([digest]),
      refs: [{ attempt: ATTEMPT, digest }],
      bytesByDigest: new Map([[digest, bytes]]),
      receipts: { publish },
    });
    const decision = await adoptPostedTask({ facts: FACTS, now: () => new Date('2026-08-06T12:00:00.000Z') }, port);
    expect(decision).toEqual({
      attempt: ATTEMPT,
      taskId: '42',
      disposition: 'accepted',
      deliveryDigest: digest,
      decidedAt: '2026-08-06T12:00:00.000Z',
    });
    expect(publish).toHaveBeenCalledWith(decision);
  });

  it('returns null (quiet) when the Submission has no engaged Attempt yet', async () => {
    const publish = vi.fn(async () => {});
    const port = fakePort({ snapshot: undefined, receipts: { publish } }); // observe throws attempt-not-found
    expect(await adoptPostedTask({ facts: FACTS }, port)).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns null when the Attempt is engaged but no delivery is recorded', async () => {
    const port = fakePort({ snapshot: descriptorFor([]), refs: [] });
    expect(await adoptPostedTask({ facts: FACTS }, port)).toBeNull();
  });

  it('REFUSES a tampered delivery — never records an adoption', async () => {
    const { bytes, digest } = makeDelivery();
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 2] ^= 0xff;
    const publish = vi.fn(async () => {});
    const port = fakePort({
      snapshot: descriptorFor([digest]),
      refs: [{ attempt: ATTEMPT, digest }],
      bytesByDigest: new Map([[digest, tampered]]),
      receipts: { publish },
    });
    await expect(adoptPostedTask({ facts: FACTS }, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.category === 'delivery' && err.code === 'digest-mismatch');
    expect(publish).not.toHaveBeenCalled();
  });

  it('REFUSES a delivery whose Attempt names a different Submission', async () => {
    const { bytes, digest } = makeDelivery();
    const port = fakePort({
      snapshot: descriptorFor([digest], { submission: 'urn:uuid:99999999-9999-9999-9999-999999999999' }),
      refs: [{ attempt: ATTEMPT, digest }],
      bytesByDigest: new Map([[digest, bytes]]),
    });
    await expect(adoptPostedTask({ facts: FACTS }, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.category === 'adoption' && err.code === 'submission-uri-divergence');
  });

  it('REFUSES a delivery whose Attempt names a different Task', async () => {
    const { bytes, digest } = makeDelivery();
    const port = fakePort({
      snapshot: descriptorFor([digest], { task: `sha256:${'b'.repeat(64)}` }),
      refs: [{ attempt: ATTEMPT, digest }],
      bytesByDigest: new Map([[digest, bytes]]),
    });
    await expect(adoptPostedTask({ facts: FACTS }, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'task-digest-divergence');
  });

  it('REFUSES a delivery the canonical observation log never recorded', async () => {
    const { bytes, digest } = makeDelivery();
    const port = fakePort({
      snapshot: descriptorFor([]), // log records NO deliveries, but the bytes store returns one
      refs: [{ attempt: ATTEMPT, digest }],
      bytesByDigest: new Map([[digest, bytes]]),
    });
    await expect(adoptPostedTask({ facts: FACTS }, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'delivery-not-recorded');
  });

  it('REFUSES a contradictory-terminal Attempt', async () => {
    const { bytes, digest } = makeDelivery();
    const port = fakePort({
      snapshot: descriptorFor([digest], { contradictory: true }),
      refs: [{ attempt: ATTEMPT, digest }],
      bytesByDigest: new Map([[digest, bytes]]),
    });
    await expect(adoptPostedTask({ facts: FACTS }, port))
      .rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'attempt-contradictory');
  });
});
