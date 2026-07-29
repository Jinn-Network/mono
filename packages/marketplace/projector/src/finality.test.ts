import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  dssePreAuthEncoding,
  sealJson,
  type AnnouncementEntry,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, test } from "vitest";
import type { DerivationAnnotation } from "./derivation.js";
import {
  appendSignedReorgCorrection,
  finalityPolicy,
  reorgCorrection,
} from "./finality.js";
import type { ProjectedAnnouncement } from "./announce.js";

const DERIVATION: DerivationAnnotation = {
  chainId: 84532,
  contract: "0x1111111111111111111111111111111111111111",
  event: "TaskCreated",
  blockNumber: 100,
  blockHash: `0x${"2".repeat(64)}`,
  txHash: `0x${"3".repeat(64)}`,
  logIndex: 1,
  finalityTier: "safe",
  contractGeneration: "today",
};

const AVAILABLE: ProjectedAnnouncement = {
  announcementId: "ann-available",
  action: "available",
  record: {
    kind: RECORD_KINDS.submission,
    digest: `sha256:${"4".repeat(64)}`,
  },
  facts: { taskDigest: `sha256:${"5".repeat(64)}` },
  derivation: DERIVATION,
};

describe("finalityPolicy", () => {
  test("announces from safe by default but gates expensive execution until finalized", () => {
    expect(finalityPolicy({ ...DERIVATION, finalityTier: "safe" })).toEqual({
      tier: "safe",
      announce: true,
      gateExecution: false,
    });
    expect(finalityPolicy({ ...DERIVATION, finalityTier: "finalized" })).toEqual({
      tier: "finalized",
      announce: true,
      gateExecution: true,
    });
  });

  test("supports the stricter finalized-only announcement profile explicitly", () => {
    expect(
      finalityPolicy(
        { ...DERIVATION, finalityTier: "safe" },
        { announceAt: "finalized" },
      ),
    ).toEqual({
      tier: "safe",
      announce: false,
      gateExecution: false,
    });
  });
});

describe("reorgCorrection", () => {
  test("returns an append-only retraction without mutating the prior availability", () => {
    const before = structuredClone(AVAILABLE);
    const correction = reorgCorrection(AVAILABLE, DERIVATION.blockHash);

    expect(AVAILABLE).toEqual(before);
    expect(correction).toEqual({
      announcementId: `ann-available-reorged-${DERIVATION.blockHash.slice(2)}`,
      action: "withdrawn",
      retracts: "ann-available",
      reason: "reorged",
      derivation: DERIVATION,
    });
  });

  test("appends and signs a new entry whose previous digest pins the unchanged prior entry", async () => {
    const priorEntry: AnnouncementEntry = {
      protocol: RECORD_DISCOVERY_VERSION,
      source: { agent: "did:key:zProjector", name: "marketplace" },
      sequence: "0000000000000001",
      previous: null,
      timestamp: "2026-07-29T12:00:00Z",
      announcements: [AVAILABLE],
    };
    const signedPae: Uint8Array[] = [];
    const signed = await appendSignedReorgCorrection({
      priorEntry,
      prior: AVAILABLE,
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      signer: {
        scope: DISCOVERY_SIGNING_SCOPE,
        async sign(pae) {
          signedPae.push(pae.slice());
          return [{ keyid: "key-1", sig: new Uint8Array([9, 9]) }];
        },
      },
    });

    expect(signed.entry.sequence).toBe("0000000000000002");
    expect(signed.entry.previous).toBe(sealJson(priorEntry).digest);
    expect(signed.entry.announcements).toEqual([
      expect.objectContaining({
        action: "withdrawn",
        retracts: "ann-available",
        reason: "reorged",
      }),
    ]);
    expect(signed.signature?.payloadType).toBe(MEDIA_ENTRY);
    expect(signedPae).toEqual([
      dssePreAuthEncoding(MEDIA_ENTRY, sealJson(signed.entry).bytes),
    ]);
    expect(priorEntry.announcements).toEqual([AVAILABLE]);
  });

  test("refuses to retract an availability from a different block", () => {
    expect(() =>
      reorgCorrection(AVAILABLE, `0x${"f".repeat(64)}`)
    ).toThrow(/does not match/);
  });
});
