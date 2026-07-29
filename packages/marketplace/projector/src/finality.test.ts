import {
  foldObservations,
  type ProtocolObservation,
} from "@jinn-network/task-execution-protocol";
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
  foldCanonicalMarketplaceObservations,
  projectReorgObservation,
  reorgCorrection,
  selectCanonicalMarketplaceObservations,
} from "./finality.js";
import type { ProjectedAnnouncement } from "./announce.js";
import { createMarketplaceProjectionState } from "./observe.js";

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

const ATTEMPT = "urn:uuid:2868f518-bc8c-5703-992d-51afdfb53e4b";
const SOURCE = "urn:jinn:marketplace-projector:eip155:84532:0x1111111111111111111111111111111111111111";
const ENGAGED: ProtocolObservation = {
  specversion: "1.0",
  id: "engaged-1",
  source: SOURCE,
  subject: ATTEMPT,
  time: "2026-07-29T12:00:00Z",
  datacontenttype: "application/json",
  sequence: "0000000000000001",
  taskdigest: `sha256:${"5".repeat(64)}`,
  derivation: { ...DERIVATION, event: "TaskAttemptCreated" },
  type: "network.jinn.task-execution.attempt-engaged.v1",
  data: {
    attempt: ATTEMPT,
    task: `sha256:${"5".repeat(64)}`,
    submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
    effectiveDeadline: "2026-07-30T12:00:00Z",
    source: SOURCE,
    dispatchContext: {
      uri: "urn:jinn:marketplace:dispatch-context:42:3",
      digest: { sha256: "8".repeat(64) },
    },
  },
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

  test("attempt-scoped reorg appends lost on the same source/Attempt and a later real terminal supersedes it", () => {
    const state = createMarketplaceProjectionState();
    const priorBefore = structuredClone(ENGAGED);
    const corrected = projectReorgObservation({
      priorObservation: ENGAGED,
      derivation: { ...DERIVATION, event: "TaskAttemptCreated" },
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state,
    });

    expect(ENGAGED).toEqual(priorBefore);
    expect(corrected.observation).toEqual({
      specversion: "1.0",
      id: `reorg:${ENGAGED.id}:${DERIVATION.blockHash}`,
      source: SOURCE,
      subject: ATTEMPT,
      time: "2026-07-29T12:05:00Z",
      datacontenttype: "application/json",
      sequence: "0000000000000002",
      taskdigest: ENGAGED.taskdigest,
      derivation: { ...DERIVATION, event: "TaskAttemptCreated" },
      correction: {
        retractsObservationId: ENGAGED.id,
        orphanedBlockHash: DERIVATION.blockHash,
      },
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "lost" },
    });

    const delivered: ProtocolObservation = {
      specversion: "1.0",
      id: "canonical-delivered",
      source: SOURCE,
      subject: ATTEMPT,
      datacontenttype: "application/json",
      sequence: "0000000000000003",
      time: "2026-07-29T12:10:00Z",
      taskdigest: ENGAGED.taskdigest,
      derivation: {
        ...DERIVATION,
        event: "VerdictDeliveryClaimed",
        blockHash: `0x${"4".repeat(64)}`,
      },
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "delivered" },
    };
    expect(
      foldObservations([ENGAGED, corrected.observation!, delivered]),
    ).toMatchObject({
      state: "delivered",
      terminal: true,
      contradictory: false,
    });

    const replay = projectReorgObservation({
      priorObservation: ENGAGED,
      derivation: { ...DERIVATION, event: "TaskAttemptCreated" },
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state: corrected.state,
    });
    expect(replay.observation).toBeUndefined();
    expect(replay.state).toEqual(corrected.state);
  });

  test("TaskCreated reorg emits no synthetic TEP rejection or close", () => {
    const accepted: ProtocolObservation = {
      ...ENGAGED,
      id: "submission-accepted",
      subject: "urn:uuid:11111111-1111-4111-8111-111111111111",
      derivation: DERIVATION,
      type: "network.jinn.task-execution.submission-accepted.v1",
      data: {
        submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
        task: `sha256:${"5".repeat(64)}`,
      },
    };
    const state = createMarketplaceProjectionState();
    const result = projectReorgObservation({
      priorObservation: accepted,
      derivation: DERIVATION,
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state,
    });

    expect(result.observation).toBeUndefined();
    expect(result.state).toEqual(state);
  });

  test("canonical selector filters an orphaned old terminal, retains lost, and permits later correction without touching raw history", () => {
    const canonicalEngaged: ProtocolObservation = {
      ...ENGAGED,
      derivation: {
        ...DERIVATION,
        event: "TaskAttemptCreated",
        blockHash: `0x${"1".repeat(64)}`,
      },
    };
    const orphanedTerminal: ProtocolObservation = {
      specversion: "1.0",
      id: "orphaned-verdict",
      source: SOURCE,
      subject: ATTEMPT,
      time: "2026-07-29T12:04:00Z",
      datacontenttype: "application/json",
      sequence: "0000000000000002",
      taskdigest: ENGAGED.taskdigest,
      derivation: { ...DERIVATION, event: "VerdictDeliveryClaimed" },
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "delivered" },
    };
    const corrected = projectReorgObservation({
      priorObservation: orphanedTerminal,
      derivation: { ...DERIVATION, event: "VerdictDeliveryClaimed" },
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state: createMarketplaceProjectionState(),
    });
    const lost = corrected.observation!;
    const raw = [canonicalEngaged, orphanedTerminal, lost];
    const rawBytes = raw.map((observation) => JSON.stringify(observation));

    expect(foldObservations(raw)).toMatchObject({
      state: "delivered",
      contradictory: true,
    });
    const selected = selectCanonicalMarketplaceObservations(
      raw,
      new Set([DERIVATION.blockHash]),
    );
    expect(selected).toHaveLength(2);
    expect(selected[0]).toBe(canonicalEngaged);
    expect(selected[1]).toBe(lost);
    expect(raw.map((observation) => JSON.stringify(observation))).toEqual(rawBytes);
    expect(
      foldCanonicalMarketplaceObservations(
        raw,
        new Set([DERIVATION.blockHash]),
      ),
    ).toMatchObject({
      state: "lost",
      terminal: true,
      contradictory: false,
    });

    const laterTerminal: ProtocolObservation = {
      ...orphanedTerminal,
      id: "canonical-verdict",
      sequence: "0000000000000004",
      time: "2026-07-29T12:10:00Z",
      derivation: {
        ...DERIVATION,
        event: "VerdictDeliveryClaimed",
        blockHash: `0x${"4".repeat(64)}`,
        txHash: `0x${"5".repeat(64)}`,
      },
    };
    expect(
      foldCanonicalMarketplaceObservations(
        [...raw, laterTerminal],
        new Set([DERIVATION.blockHash]),
      ),
    ).toMatchObject({
      state: "delivered",
      terminal: true,
      contradictory: false,
    });
  });

  test("canonical selector refuses observations without exact derivation provenance", () => {
    const missing = { ...ENGAGED };
    delete (missing as { derivation?: unknown }).derivation;
    expect(() =>
      selectCanonicalMarketplaceObservations([missing], new Set())
    ).toThrow(/missing exact derivation provenance/);
  });

  test("canonical selector refuses a correction whose target is absent", () => {
    const corrected = projectReorgObservation({
      priorObservation: ENGAGED,
      derivation: ENGAGED.derivation as DerivationAnnotation,
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state: createMarketplaceProjectionState(),
    });

    expect(() =>
      selectCanonicalMarketplaceObservations(
        [corrected.observation!],
        new Set([DERIVATION.blockHash]),
      )
    ).toThrow(/exactly one ordinary target/);
  });

  test("canonical selector refuses a correction whose target id is duplicated", () => {
    const corrected = projectReorgObservation({
      priorObservation: ENGAGED,
      derivation: ENGAGED.derivation as DerivationAnnotation,
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state: createMarketplaceProjectionState(),
    });
    const duplicate = structuredClone(ENGAGED);

    expect(() =>
      selectCanonicalMarketplaceObservations(
        [ENGAGED, duplicate, corrected.observation!],
        new Set([DERIVATION.blockHash]),
      )
    ).toThrow(/exactly one ordinary target/);
  });

  test("canonical selector refuses a correction outside the orphaned-hash substrate", () => {
    const corrected = projectReorgObservation({
      priorObservation: ENGAGED,
      derivation: ENGAGED.derivation as DerivationAnnotation,
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state: createMarketplaceProjectionState(),
    });

    expect(() =>
      selectCanonicalMarketplaceObservations(
        [ENGAGED, corrected.observation!],
        new Set(),
      )
    ).toThrow(/orphaned-hash substrate/);
  });

  test.each([
    ["source", { source: "urn:jinn:marketplace-projector:other" }],
    ["subject", { subject: "urn:uuid:99999999-9999-4999-8999-999999999999" }],
  ])("canonical selector refuses a correction with the wrong target %s", (_field, override) => {
    const corrected = projectReorgObservation({
      priorObservation: ENGAGED,
      derivation: ENGAGED.derivation as DerivationAnnotation,
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state: createMarketplaceProjectionState(),
    });
    const mismatched = { ...corrected.observation!, ...override };

    expect(() =>
      selectCanonicalMarketplaceObservations(
        [ENGAGED, mismatched],
        new Set([DERIVATION.blockHash]),
      )
    ).toThrow(/source and subject/);
  });

  test("canonical selector refuses a correction whose target derivation names another block", () => {
    const corrected = projectReorgObservation({
      priorObservation: ENGAGED,
      derivation: ENGAGED.derivation as DerivationAnnotation,
      reorgedBlockHash: DERIVATION.blockHash,
      timestamp: "2026-07-29T12:05:00Z",
      state: createMarketplaceProjectionState(),
    });
    const target = {
      ...ENGAGED,
      derivation: {
        ...(ENGAGED.derivation as DerivationAnnotation),
        blockHash: `0x${"9".repeat(64)}`,
      },
    } as ProtocolObservation;

    expect(() =>
      selectCanonicalMarketplaceObservations(
        [target, corrected.observation!],
        new Set([DERIVATION.blockHash]),
      )
    ).toThrow(/target derivation block/);
  });

  test("reorg projection refuses derivation that differs from the prior observation", () => {
    expect(() =>
      projectReorgObservation({
        priorObservation: ENGAGED,
        derivation: {
          ...(ENGAGED.derivation as DerivationAnnotation),
          event: "VerdictDeliveryClaimed",
        },
        reorgedBlockHash: DERIVATION.blockHash,
        timestamp: "2026-07-29T12:05:00Z",
        state: createMarketplaceProjectionState(),
      })
    ).toThrow(/does not exactly match prior observation/);
  });
});
