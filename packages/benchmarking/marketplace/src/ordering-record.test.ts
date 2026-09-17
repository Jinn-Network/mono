import { describe, expect, test } from "vitest";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import type { Address, Hex } from "viem";
import { deriveAuthorityProjection } from "./authority-projection.js";
import {
  MARKETPLACE_ORDERING_SCHEMA_ID,
  MarketplaceOrderingParseError,
  eventMemberPath,
  parseMarketplaceOrderingRecord,
  serializeMarketplaceOrderingRecord,
  type MarketplaceOrderingRecord,
} from "./ordering-record.js";
import {
  parseMarketplaceEventBytes,
  serializeMarketplaceEvent,
} from "./ordering-event-json.js";

const ANCHOR = {
  chain: "eip155:84532",
  blockNumber: 105,
  blockHash: "0x1515151515151515151515151515151515151515151515151515151515151515",
};
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const RUN_DIGEST = `sha256:${"c".repeat(64)}` as const;
const TASK = `sha256:${"d".repeat(64)}` as const;

function validRecord(overrides: Partial<MarketplaceOrderingRecord> = {}): MarketplaceOrderingRecord {
  return {
    schema: MARKETPLACE_ORDERING_SCHEMA_ID,
    runDigest: RUN_DIGEST,
    closeAnchor: ANCHOR,
    events: [{
      ordinal: 0,
      sha256: DIGEST_A,
      path: eventMemberPath(0, DIGEST_A),
    }],
    submissions: [{
      submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
      task: TASK,
      sha256: DIGEST_B,
      path: `ordering/submissions/${DIGEST_B}.bin`,
    }],
    transcript: {
      runDigestAnchorAt: "2026-08-03T09:00:00Z",
      earliestCellPostAt: "2026-08-03T09:00:01Z",
    },
    ...overrides,
  };
}

function taskCreated(blockNumber: number, txChar: string): ObservationMarketplaceEvent {
  const TASK_DIGEST = "7777777777777777777777777777777777777777777777777777777777777777";
  const COORDINATOR = "0x1111111111111111111111111111111111111111" as Address;
  return {
    event: "TaskCreated",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "TaskCreated",
      blockNumber,
      blockHash: `0x${"6".repeat(64)}`,
      txHash: `0x${txChar.repeat(64)}`,
      logIndex: 0,
      finalityTier: "finalized",
      contractGeneration: "revised",
    },
    projection: {
      taskCoordinator: COORDINATOR,
      timestamp: "2026-08-01T00:00:00Z",
      submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
      taskDigest: `sha256:${TASK_DIGEST}`,
      effectiveDeadline: "2026-08-04T00:00:00Z",
      dispatchContext: {
        uri: "urn:jinn:marketplace:dispatch-context:42:0",
        digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
      },
    },
    facts: {
      creator: "0x2222222222222222222222222222222222222222",
      taskCidDigest: `0x${TASK_DIGEST}`,
      submissionDigest: `0x${"8".repeat(64)}`,
      taskId: 42n,
      maxTotal: 2,
      maxConcurrent: 2,
      submissionDeadline: 1_800_000_000n,
      closeAt: 0n,
      responseTimeout: 3600n,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
      solutionMaxDeliveryRate: 10n,
      verdictMaxDeliveryRate: 10n,
      solutionBudget: 20n,
      verdictBudget: 20n,
    },
  } as ObservationMarketplaceEvent;
}

describe("parseMarketplaceOrderingRecord", () => {
  test("accepts a canonical record and round-trips through JCS bytes", () => {
    const record = validRecord();
    const bytes = serializeMarketplaceOrderingRecord(record);
    const parsed = parseMarketplaceOrderingRecord(JSON.parse(new TextDecoder().decode(bytes)));
    expect(parsed).toEqual(record);
    expect(parsed.schema).toBe(MARKETPLACE_ORDERING_SCHEMA_ID);
  });

  test("rejects unknown keys", () => {
    expect(() => parseMarketplaceOrderingRecord({
      ...validRecord(),
      extra: true,
    })).toThrow(MarketplaceOrderingParseError);
  });

  test("rejects noncontiguous ordinals and ordinal/index disagreement", () => {
    expect(() => parseMarketplaceOrderingRecord(validRecord({
      events: [{
        ordinal: 1,
        sha256: DIGEST_A,
        path: eventMemberPath(1, DIGEST_A),
      }],
    }))).toThrow(/ordinal must equal its array index/);
    expect(() => parseMarketplaceOrderingRecord(validRecord({
      events: [
        { ordinal: 0, sha256: DIGEST_A, path: eventMemberPath(0, DIGEST_A) },
        { ordinal: 2, sha256: DIGEST_B, path: eventMemberPath(2, DIGEST_B) },
      ],
    }))).toThrow(/ordinal must equal its array index/);
  });

  test("rejects a five-digit ordinal pad as a non-canonical path", () => {
    expect(() => parseMarketplaceOrderingRecord(validRecord({
      events: [{
        ordinal: 0,
        sha256: DIGEST_A,
        path: `ordering/events/00000-${DIGEST_A}.json`,
      }],
    }))).toThrow(/unsafe or non-canonical/);
  });

  test("rejects unsorted submissions", () => {
    expect(() => parseMarketplaceOrderingRecord(validRecord({
      submissions: [
        {
          submission: "urn:uuid:22222222-2222-4222-8222-222222222222",
          task: TASK,
          sha256: DIGEST_B,
          path: `ordering/submissions/${DIGEST_B}.bin`,
        },
        {
          submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
          task: TASK,
          sha256: DIGEST_A,
          path: `ordering/submissions/${DIGEST_A}.bin`,
        },
      ],
    }))).toThrow(/not sorted/);
  });

  test("rejects conflicting Submission identities", () => {
    expect(() => parseMarketplaceOrderingRecord(validRecord({
      submissions: [
        {
          submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
          task: TASK,
          sha256: DIGEST_A,
          path: `ordering/submissions/${DIGEST_A}.bin`,
        },
        {
          submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
          task: TASK,
          sha256: DIGEST_B,
          path: `ordering/submissions/${DIGEST_B}.bin`,
        },
      ],
    }))).toThrow(/conflicting Submission identities/);
  });

  test("rejects malformed RFC 3339 transcript timestamps", () => {
    expect(() => parseMarketplaceOrderingRecord(validRecord({
      transcript: {
        runDigestAnchorAt: "2026-13-01T00:00:00Z",
        earliestCellPostAt: "2026-08-03T09:00:01Z",
      },
    }))).toThrow(/RFC 3339/);
  });

  test("rejects parent-directory event paths", () => {
    expect(() => parseMarketplaceOrderingRecord(validRecord({
      events: [{
        ordinal: 0,
        sha256: DIGEST_A,
        path: `ordering/events/../${DIGEST_A}.json`,
      }],
    }))).toThrow(/unsafe or non-canonical/);
  });
});

describe("marketplace event canonical bytes", () => {
  test("round-trip preserves bigint facts and projector input order", () => {
    const first = taskCreated(99, "1");
    const second = taskCreated(100, "2");
    const firstBytes = serializeMarketplaceEvent(first);
    const revived = parseMarketplaceEventBytes(firstBytes);
    const facts = revived.facts as Record<string, unknown>;
    expect(facts.taskId).toBe(42n);
    expect(facts.maxTotal).toBe(2);
    expect(serializeMarketplaceEvent(revived)).toEqual(firstBytes);

    const forward = deriveAuthorityProjection([first, second], ANCHOR);
    const reversed = deriveAuthorityProjection([second, first], ANCHOR);
    expect(forward.events.map((event) => event.derivation.txHash))
      .not.toEqual(reversed.events.map((event) => event.derivation.txHash));
  });
});
