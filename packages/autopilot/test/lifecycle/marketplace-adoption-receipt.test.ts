import { describe, expect, it } from 'vitest';
import type {
  AutopilotAdoptionReceipt,
  AutopilotCorrelation,
} from '../../../sdk/src/autopilot-session.js';
import {
  AdoptionReceiptPublicationError,
  formatAdoptionReceiptComment,
  parseAdoptionReceiptComment,
  publishAdoptionReceipt,
  readAdoptionReceiptState,
  type AdoptionReceiptComment,
  type AdoptionReceiptExactFacts,
  type AdoptionReceiptPorts,
  type CreateAdoptionReceiptCommentInput,
  type ReceiptFactsVerificationInput,
} from '../../src/lifecycle/marketplace-adoption-receipt.js';

const CLAIM_OID = '1111111111111111111111111111111111111111';
const EXPECTED_HEAD = '2222222222222222222222222222222222222222';
const RESULTING_HEAD = '3333333333333333333333333333333333333333';
const REVIEW_REF_OID = '4444444444444444444444444444444444444444';
const OTHER_HEAD = '9999999999999999999999999999999999999999';
const V2_ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';
const REVIEW_GENERATION = '123e4567-e89b-42d3-a456-426614174001';

const COMMON = {
  schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
  taskId: 'marketplace-task-501',
  attemptIndex: 0,
  requestId: 'request-abc',
  deliveryEnvelopeCid: 'bafybeiadoptionreceipt',
  v2AttemptId: V2_ATTEMPT_ID,
  claimOid: CLAIM_OID,
  prNumber: 2101,
  expectedHead: EXPECTED_HEAD,
  recordedAt: '2026-07-24T12:00:00.000Z',
} as const;

function acceptedSolution(
  patch: Partial<AutopilotAdoptionReceipt> = {},
): AutopilotAdoptionReceipt {
  return {
    ...COMMON,
    disposition: 'accepted',
    role: 'solution',
    operation: 'implementation-complete',
    resultingHead: RESULTING_HEAD,
    reviewGeneration: REVIEW_GENERATION,
    reviewRefOid: REVIEW_REF_OID,
    ...patch,
  } as AutopilotAdoptionReceipt;
}

function rejectedSolution(
  patch: Partial<AutopilotAdoptionReceipt> = {},
): AutopilotAdoptionReceipt {
  return {
    ...COMMON,
    disposition: 'rejected',
    role: 'solution',
    reason: 'verification-failed',
    detail: 'Focused verification failed.',
    ...patch,
  } as AutopilotAdoptionReceipt;
}

function acceptedVerdict(
  patch: Partial<AutopilotAdoptionReceipt> = {},
): AutopilotAdoptionReceipt {
  return {
    ...COMMON,
    disposition: 'accepted',
    role: 'verdict',
    operation: 'review-verdict',
    reviewedHead: RESULTING_HEAD,
    reviewGeneration: REVIEW_GENERATION,
    reviewRefOid: REVIEW_REF_OID,
    ...patch,
  } as AutopilotAdoptionReceipt;
}

function rejectedVerdict(
  patch: Partial<AutopilotAdoptionReceipt> = {},
): AutopilotAdoptionReceipt {
  return {
    ...COMMON,
    disposition: 'rejected',
    role: 'verdict',
    reason: 'stale-review-generation',
    detail: 'The review generation is no longer current.',
    reviewedHead: RESULTING_HEAD,
    reviewGeneration: REVIEW_GENERATION,
    reviewRefOid: REVIEW_REF_OID,
    ...patch,
  } as AutopilotAdoptionReceipt;
}

function correlationFor(receipt: AutopilotAdoptionReceipt): AutopilotCorrelation {
  return {
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    v2AttemptId: receipt.v2AttemptId,
    claimOid: receipt.claimOid,
    prNumber: receipt.prNumber,
    expectedHead: receipt.expectedHead,
    ...(receipt.resultingHead === undefined
      ? {}
      : { resultingHead: receipt.resultingHead }),
    ...(receipt.reviewedHead === undefined
      ? {}
      : { reviewedHead: receipt.reviewedHead }),
    ...(receipt.reviewGeneration === undefined
      ? {}
      : { reviewGeneration: receipt.reviewGeneration }),
    ...(receipt.reviewRefOid === undefined
      ? {}
      : { reviewRefOid: receipt.reviewRefOid }),
  };
}

function factsFor(receipt: AutopilotAdoptionReceipt): AdoptionReceiptExactFacts {
  return {
    role: receipt.role,
    correlation: correlationFor(receipt),
    prHead: receipt.role === 'verdict'
      ? receipt.reviewedHead
      : receipt.resultingHead ?? receipt.expectedHead,
  };
}

function comment(
  id: number,
  receipt: AutopilotAdoptionReceipt,
  authorLogin = 'Jinn-Autopilot',
): AdoptionReceiptComment {
  return {
    id,
    authorLogin,
    body: formatAdoptionReceiptComment(receipt),
    createdAt: '2026-07-24T12:00:01.000Z',
    updatedAt: '2026-07-24T12:00:01.000Z',
  };
}

class MemoryAdoptionReceiptPorts implements AdoptionReceiptPorts {
  readonly comments: AdoptionReceiptComment[] = [];
  readonly listCalls: Array<{ prNumber: number; cursor?: string }> = [];
  readonly createCalls: CreateAdoptionReceiptCommentInput[] = [];
  readonly verificationCalls: ReceiptFactsVerificationInput[] = [];
  pageSize = 100;
  factsVerified = true;
  currentHeads: string[] = [RESULTING_HEAD];
  publisherLogin = 'jinn-autopilot';
  crashAfterNextWrite = false;
  private nextCommentId = 1000;
  private headReadIndex = 0;

  async listPrIssueComments(input: {
    readonly prNumber: number;
    readonly cursor?: string;
  }) {
    this.listCalls.push(input);
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    const rows = this.comments
      .filter((entry) => entry.id > 0)
      .slice(offset, offset + this.pageSize);
    const nextOffset = offset + rows.length;
    return {
      comments: rows,
      ...(nextOffset < this.comments.length
        ? { nextCursor: String(nextOffset) }
        : {}),
    };
  }

  async verifyReceiptFacts(input: ReceiptFactsVerificationInput) {
    this.verificationCalls.push(input);
    return this.factsVerified;
  }

  async readCurrentPrHead() {
    const index = Math.min(this.headReadIndex, this.currentHeads.length - 1);
    this.headReadIndex += 1;
    return this.currentHeads[index]!;
  }

  async createPrComment(input: CreateAdoptionReceiptCommentInput) {
    this.createCalls.push(input);
    const created = {
      id: this.nextCommentId,
      authorLogin: this.publisherLogin,
      body: input.body,
      createdAt: '2026-07-24T12:00:02.000Z',
      updatedAt: '2026-07-24T12:00:02.000Z',
    };
    this.nextCommentId += 1;
    this.comments.push(created);
    if (this.crashAfterNextWrite) {
      this.crashAfterNextWrite = false;
      throw new Error('caller crashed after GitHub accepted the write');
    }
    return { commentId: created.id };
  }
}

const ALLOWED_AUTHORS = ['JINN-AUTOPILOT', 'release-captain'];

describe('marketplace adoption receipt comment format', () => {
  it('deterministically round-trips accepted and rejected Solution and Verdict receipts', () => {
    for (const receipt of [
      acceptedSolution(),
      rejectedSolution(),
      acceptedVerdict(),
      rejectedVerdict(),
    ]) {
      const formatted = formatAdoptionReceiptComment(receipt);
      expect(formatAdoptionReceiptComment(receipt)).toBe(formatted);
      expect(parseAdoptionReceiptComment(formatted)?.receipt).toEqual(receipt);
      expect(formatted).toContain('jinn-autopilot:marketplace-adoption-receipt:v1');
      expect(formatted).toContain('"schemaVersion":"jinn-autopilot-marketplace-adoption.v1"');
    }
  });

  it('rejects malformed payloads and marker-to-payload mismatches', () => {
    const body = formatAdoptionReceiptComment(acceptedSolution());
    const malformed = body.replace(
      '{"schemaVersion":"jinn-autopilot-marketplace-adoption.v1"',
      '{"schemaVersion":',
    );
    const markerMismatch = body.replace('"attemptIndex":0', '"attemptIndex":1');

    expect(parseAdoptionReceiptComment(malformed)).toBeNull();
    expect(parseAdoptionReceiptComment(markerMismatch)).toBeNull();
  });

  it('isolates the exact whole marker instead of matching substrings or loose lookalikes', () => {
    const body = formatAdoptionReceiptComment(acceptedSolution());
    expect(parseAdoptionReceiptComment(`quoted receipt:\n${body}`)).toBeNull();
    expect(parseAdoptionReceiptComment(`${body}\ntrailing prose`)).toBeNull();
    expect(parseAdoptionReceiptComment(
      body.replace('marketplace-adoption-receipt:v1', 'marketplace-adoption-receipt:v10'),
    )).toBeNull();
  });
});

describe('readAdoptionReceiptState', () => {
  it('reads exact accepted and rejected states for both roles', async () => {
    for (const receipt of [
      acceptedSolution(),
      rejectedSolution(),
      acceptedVerdict(),
      rejectedVerdict(),
    ]) {
      const ports = new MemoryAdoptionReceiptPorts();
      ports.comments.push(comment(1, receipt, 'jinn-autopilot'));

      const state = await readAdoptionReceiptState(
        factsFor(receipt),
        ALLOWED_AUTHORS,
        ports,
      );

      expect(state.status).toBe(
        receipt.disposition === 'accepted' ? 'exact-accepted' : 'exact-rejected',
      );
    }
  });

  it('does not accept forged authors or receipts rejected by the facts verifier', async () => {
    const receipt = acceptedSolution();
    const forged = new MemoryAdoptionReceiptPorts();
    forged.comments.push(comment(1, receipt, 'forged-bot'));
    expect(await readAdoptionReceiptState(
      factsFor(receipt),
      ALLOWED_AUTHORS,
      forged,
    )).toEqual({ status: 'pending', reason: 'not-found' });

    for (const unverifiedReceipt of [acceptedSolution(), rejectedVerdict()]) {
      const unverified = new MemoryAdoptionReceiptPorts();
      unverified.factsVerified = false;
      unverified.comments.push(comment(1, unverifiedReceipt));
      expect(await readAdoptionReceiptState(
        factsFor(unverifiedReceipt),
        ALLOWED_AUTHORS,
        unverified,
      )).toEqual({ status: 'pending', reason: 'facts-unverified' });
    }
  });

  it('requires the complete requested correlation and PR head', async () => {
    const receipt = acceptedVerdict();
    const ports = new MemoryAdoptionReceiptPorts();
    ports.comments.push(comment(1, receipt));
    const exact = factsFor(receipt);

    expect(await readAdoptionReceiptState(
      {
        ...exact,
        correlation: { ...exact.correlation, requestId: 'another-request' },
      },
      ALLOWED_AUTHORS,
      ports,
    )).toEqual({ status: 'pending', reason: 'not-found' });
    expect(await readAdoptionReceiptState(
      { ...exact, prHead: OTHER_HEAD },
      ALLOWED_AUTHORS,
      ports,
    )).toEqual({ status: 'pending', reason: 'not-found' });
  });

  it('deduplicates duplicate events and paginates until the exact comment is found', async () => {
    const receipt = acceptedSolution();
    const ports = new MemoryAdoptionReceiptPorts();
    ports.pageSize = 1;
    ports.comments.push(
      {
        ...comment(1, receipt),
        body: 'unrelated comment containing marketplace-adoption-receipt',
      },
      comment(2, receipt),
      comment(3, receipt, 'JINN-AUTOPILOT'),
    );

    const state = await readAdoptionReceiptState(
      factsFor(receipt),
      ALLOWED_AUTHORS,
      ports,
    );

    expect(state.status).toBe('exact-accepted');
    if (state.status === 'exact-accepted') {
      expect(state.comments.map(({ id }) => id)).toEqual([2, 3]);
    }
    expect(ports.listCalls).toHaveLength(3);
  });

  it('fails closed on accepted/rejected and different-accepted contradictions', async () => {
    const accepted = acceptedSolution();
    const rejected = rejectedSolution({
      resultingHead: RESULTING_HEAD,
      reviewGeneration: REVIEW_GENERATION,
      reviewRefOid: REVIEW_REF_OID,
    });
    const mixed = new MemoryAdoptionReceiptPorts();
    mixed.comments.push(comment(1, accepted), comment(2, rejected));
    expect(await readAdoptionReceiptState(
      factsFor(accepted),
      ALLOWED_AUTHORS,
      mixed,
    )).toMatchObject({
      status: 'contradiction',
      reason: 'accepted-and-rejected',
    });

    const twoAccepted = new MemoryAdoptionReceiptPorts();
    twoAccepted.comments.push(
      comment(1, accepted),
      comment(2, acceptedSolution({ recordedAt: '2026-07-24T12:01:00.000Z' })),
    );
    expect(await readAdoptionReceiptState(
      factsFor(accepted),
      ALLOWED_AUTHORS,
      twoAccepted,
    )).toMatchObject({
      status: 'contradiction',
      reason: 'different-accepted-receipts',
    });
  });
});

describe('publishAdoptionReceipt', () => {
  it('publishes once and reads back its authored receipt for every receipt branch', async () => {
    for (const receipt of [
      acceptedSolution(),
      rejectedSolution(),
      acceptedVerdict(),
      rejectedVerdict(),
    ]) {
      const ports = new MemoryAdoptionReceiptPorts();
      const exactFacts = factsFor(receipt);
      ports.currentHeads = [exactFacts.prHead, exactFacts.prHead];

      const result = await publishAdoptionReceipt(
        {
          receipt,
          exactFacts,
          allowedAuthors: ALLOWED_AUTHORS,
          publisherLogin: 'Jinn-Autopilot',
        },
        ports,
      );

      expect(result.status).toBe('published');
      expect(ports.createCalls).toHaveLength(1);
      expect(ports.createCalls[0]).toMatchObject({
        prNumber: receipt.prNumber,
        expectedHead: exactFacts.prHead,
      });
      expect(ports.verificationCalls.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('is idempotent when the exact same authorized receipt already exists', async () => {
    const receipt = rejectedVerdict();
    const ports = new MemoryAdoptionReceiptPorts();
    ports.comments.push(comment(42, receipt, 'Release-Captain'));

    const result = await publishAdoptionReceipt(
      {
        receipt,
        exactFacts: factsFor(receipt),
        allowedAuthors: ALLOWED_AUTHORS,
        publisherLogin: 'jinn-autopilot',
      },
      ports,
    );

    expect(result).toMatchObject({ status: 'already-published' });
    expect(ports.createCalls).toHaveLength(0);
  });

  it('reconstructs a crash-after-write retry without publishing a duplicate', async () => {
    const receipt = rejectedSolution();
    const ports = new MemoryAdoptionReceiptPorts();
    ports.currentHeads = [EXPECTED_HEAD, EXPECTED_HEAD];
    ports.crashAfterNextWrite = true;

    await expect(publishAdoptionReceipt(
      {
        receipt,
        exactFacts: factsFor(receipt),
        allowedAuthors: ALLOWED_AUTHORS,
        publisherLogin: 'jinn-autopilot',
      },
      ports,
    )).rejects.toThrow('caller crashed');

    const retry = await publishAdoptionReceipt(
      {
        receipt,
        exactFacts: factsFor(receipt),
        allowedAuthors: ALLOWED_AUTHORS,
        publisherLogin: 'jinn-autopilot',
      },
      ports,
    );

    expect(retry.status).toBe('already-published');
    expect(ports.createCalls).toHaveLength(1);
  });

  it('refuses stale heads and a head change between the two pre-write reads', async () => {
    const receipt = acceptedSolution();
    for (const heads of [[OTHER_HEAD], [RESULTING_HEAD, OTHER_HEAD]]) {
      const ports = new MemoryAdoptionReceiptPorts();
      ports.currentHeads = heads;

      await expect(publishAdoptionReceipt(
        {
          receipt,
          exactFacts: factsFor(receipt),
          allowedAuthors: ALLOWED_AUTHORS,
          publisherLogin: 'jinn-autopilot',
        },
        ports,
      )).rejects.toMatchObject({
        code: 'stale-head',
      } satisfies Partial<AdoptionReceiptPublicationError>);
      expect(ports.createCalls).toHaveLength(0);
    }
  });

  it('refuses contradictions, different dispositions, and different exact receipts', async () => {
    const accepted = acceptedSolution();
    const rejected = rejectedSolution({
      resultingHead: RESULTING_HEAD,
      reviewGeneration: REVIEW_GENERATION,
      reviewRefOid: REVIEW_REF_OID,
    });

    const opposite = new MemoryAdoptionReceiptPorts();
    opposite.comments.push(comment(1, rejected));
    await expect(publishAdoptionReceipt(
      {
        receipt: accepted,
        exactFacts: factsFor(accepted),
        allowedAuthors: ALLOWED_AUTHORS,
        publisherLogin: 'jinn-autopilot',
      },
      opposite,
    )).rejects.toMatchObject({
      code: 'different-disposition',
    } satisfies Partial<AdoptionReceiptPublicationError>);

    const different = new MemoryAdoptionReceiptPorts();
    different.comments.push(
      comment(1, acceptedSolution({ recordedAt: '2026-07-24T12:01:00.000Z' })),
    );
    await expect(publishAdoptionReceipt(
      {
        receipt: accepted,
        exactFacts: factsFor(accepted),
        allowedAuthors: ALLOWED_AUTHORS,
        publisherLogin: 'jinn-autopilot',
      },
      different,
    )).rejects.toMatchObject({
      code: 'different-receipt',
    } satisfies Partial<AdoptionReceiptPublicationError>);

    const contradiction = new MemoryAdoptionReceiptPorts();
    contradiction.comments.push(comment(1, accepted), comment(2, rejected));
    await expect(publishAdoptionReceipt(
      {
        receipt: accepted,
        exactFacts: factsFor(accepted),
        allowedAuthors: ALLOWED_AUTHORS,
        publisherLogin: 'jinn-autopilot',
      },
      contradiction,
    )).rejects.toMatchObject({
      code: 'receipt-contradiction',
    } satisfies Partial<AdoptionReceiptPublicationError>);
  });
});
