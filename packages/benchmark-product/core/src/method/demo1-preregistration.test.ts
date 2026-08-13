import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import {
  DEMO1_PREREGISTRATION_BATCH_KIND,
  DEMO1_PREREGISTRATION_MEDIA_TYPE,
  anchorDemo1Preregistration,
  canonicalDemo1PreregistrationCommitmentBytes,
  canonicalDemo1PreregistrationWitnessBytes,
  verifyDemo1PreregistrationOrdering,
  verifyDemo1PreregistrationPreDispatch,
  verifyDemo1PreregistrationRunOrdering,
  type Demo1PreregistrationAnchorBoundary,
  type Demo1PreregistrationCommitment,
  type Demo1PreregistrationReadBack,
} from "../index.js";
import type { RunJournalEntry } from "../run/journal.js";
import type { RunState } from "../run/state.js";

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const txHash = `0x${"a".repeat(64)}` as const;
const blockHash = `0x${"b".repeat(64)}` as const;

const commitment: Demo1PreregistrationCommitment = {
  runSha256: digest("sealed Run bytes"),
  methodSummarySha256: digest("frozen method summary"),
  graderProgramSha256: digest("sealed grader program"),
  sourceCommit: "c".repeat(40),
};

const external = {
  source: "erc8004-block" as const,
  timestamp: "2026-08-13T09:59:59.000Z",
  chainId: 84532,
  blockNumber: "1234567",
  blockHash,
};

class FakeManifestAnchorBoundary implements Demo1PreregistrationAnchorBoundary {
  readonly calls: string[] = [];
  published?: {
    batchKind: string;
    mediaType: string;
    body: Uint8Array;
    bodySha256: string;
  };
  readBack: Demo1PreregistrationReadBack | null | undefined;

  async publishManifestBody(input: {
    batchKind: string;
    mediaType: string;
    body: Uint8Array;
    bodySha256: string;
  }): Promise<{ manifestCid: string }> {
    this.calls.push("publish");
    this.published = input;
    return { manifestCid: "bafy-demo1-preregistration" };
  }

  async anchorManifest(input: { manifestCid: string }): Promise<{ transactionHash: `0x${string}` }> {
    this.calls.push(`anchor:${input.manifestCid}`);
    return { transactionHash: txHash };
  }

  async readManifestAnchor(input: {
    manifestCid: string;
    transactionHash: `0x${string}`;
  }): Promise<Demo1PreregistrationReadBack | null> {
    this.calls.push(`read:${input.manifestCid}:${input.transactionHash}`);
    return this.readBack === undefined ? {
      manifestCid: input.manifestCid,
      transactionHash: input.transactionHash,
      body: this.published!.body,
      bodySha256: this.published!.bodySha256,
      external,
    } : this.readBack;
  }
}

function lockedRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    draftId: "demo-1",
    specSha256: digest("spec"),
    owner: "urn:demo1:owner",
    runSha256: commitment.runSha256,
    lockedAt: "2026-08-13T09:55:00.000Z",
    ...overrides,
  };
}

describe("Demo-1 preregistration adapter", () => {
  it("submits only the four-field canonical commitment, anchors it, and verifies exact external read-back", async () => {
    const boundary = new FakeManifestAnchorBoundary();
    const witness = await anchorDemo1Preregistration(commitment, boundary);

    expect(boundary.calls).toEqual([
      "publish",
      "anchor:bafy-demo1-preregistration",
      `read:bafy-demo1-preregistration:${txHash}`,
    ]);
    expect(boundary.published).toEqual({
      batchKind: DEMO1_PREREGISTRATION_BATCH_KIND,
      mediaType: DEMO1_PREREGISTRATION_MEDIA_TYPE,
      body: canonicalJsonBytes(commitment),
      bodySha256: digest(canonicalJsonBytes(commitment)),
    });
    expect(canonicalDemo1PreregistrationCommitmentBytes(commitment)).toEqual(canonicalJsonBytes(commitment));
    expect(witness).toEqual({
      commitment,
      commitmentSha256: digest(canonicalJsonBytes(commitment)),
      manifestCid: "bafy-demo1-preregistration",
      transactionHash: txHash,
      external,
    });
    expect(canonicalDemo1PreregistrationWitnessBytes(witness)).toEqual(canonicalJsonBytes(witness));
  });

  it.each([
    ["unknown input field", { ...commitment, published: true }],
    ["non-canonical Run digest", { ...commitment, runSha256: `sha256:${commitment.runSha256}` }],
    ["abbreviated source commit", { ...commitment, sourceCommit: commitment.sourceCommit.slice(0, 12) }],
  ])("fails before boundary use on %s", async (_label, input) => {
    const boundary = new FakeManifestAnchorBoundary();
    await expect(anchorDemo1Preregistration(input as Demo1PreregistrationCommitment, boundary)).rejects.toMatchObject({
      code: "validation",
    });
    expect(boundary.calls).toEqual([]);
  });

  it("fails closed when the manifest anchor cannot be read back", async () => {
    const boundary = new FakeManifestAnchorBoundary();
    boundary.readBack = null;
    await expect(anchorDemo1Preregistration(commitment, boundary)).rejects.toMatchObject({
      code: "venue-unverifiable",
    });
  });

  it.each([
    ["body bytes", (value: Demo1PreregistrationReadBack) => ({ ...value, body: canonicalJsonBytes({ ...commitment, sourceCommit: "d".repeat(40) }) })],
    ["body digest", (value: Demo1PreregistrationReadBack) => ({ ...value, bodySha256: digest("substituted") })],
    ["manifest CID", (value: Demo1PreregistrationReadBack) => ({ ...value, manifestCid: "bafy-substituted" })],
    ["transaction hash", (value: Demo1PreregistrationReadBack) => ({ ...value, transactionHash: `0x${"d".repeat(64)}` as const })],
  ])("fails closed on mismatching read-back %s", async (_label, mutate) => {
    const boundary = new FakeManifestAnchorBoundary();
    const body = canonicalJsonBytes(commitment);
    boundary.readBack = mutate({
      manifestCid: "bafy-demo1-preregistration",
      transactionHash: txHash,
      body,
      bodySha256: digest(body),
      external,
    });
    await expect(anchorDemo1Preregistration(commitment, boundary)).rejects.toMatchObject({
      code: "venue-unverifiable",
    });
  });

  it("fails closed when read-back timestamp provenance is not an ERC-8004 block", async () => {
    const boundary = new FakeManifestAnchorBoundary();
    const body = canonicalJsonBytes(commitment);
    boundary.readBack = {
      manifestCid: "bafy-demo1-preregistration",
      transactionHash: txHash,
      body,
      bodySha256: digest(body),
      external: { ...external, source: "local-clock" as "erc8004-block" },
    };
    await expect(anchorDemo1Preregistration(commitment, boundary)).rejects.toMatchObject({
      code: "venue-unverifiable",
    });
  });
});

describe("Demo-1 preregistration dispatch gates", () => {
  it("passes the explicit post-lock/pre-dispatch gate only for the exact sealed Run and an empty run journal", async () => {
    const witness = await anchorDemo1Preregistration(commitment, new FakeManifestAnchorBoundary());
    expect(verifyDemo1PreregistrationPreDispatch({ commitment, witness, runState: lockedRunState(), journal: [] }))
      .toEqual({
        stage: "post-lock-pre-dispatch",
        ready: true,
        runSha256: commitment.runSha256,
        manifestCid: "bafy-demo1-preregistration",
        transactionHash: txHash,
        externalTimestamp: external.timestamp,
      });
  });

  it.each([
    ["not locked", lockedRunState({ lockedAt: undefined }), []],
    ["wrong sealed Run", lockedRunState({ runSha256: digest("other Run") }), []],
    ["launch already began", lockedRunState({ launchedAt: "2026-08-13T10:00:00.000Z" }), []],
    ["any run journal activity", lockedRunState(), [{ kind: "launched", at: "2026-08-13T10:00:00.000Z" }]],
  ] satisfies Array<[string, RunState, RunJournalEntry[]]>)
    ("refuses pre-dispatch readiness when %s", async (_label, runState, journal) => {
      const witness = await anchorDemo1Preregistration(commitment, new FakeManifestAnchorBoundary());
      expect(() => verifyDemo1PreregistrationPreDispatch({ commitment, witness, runState, journal }))
        .toThrowError();
    });

  it("refuses a chain block timestamp that does not prove the anchor happened after lock", async () => {
    const boundary = new FakeManifestAnchorBoundary();
    const body = canonicalJsonBytes(commitment);
    boundary.readBack = {
      manifestCid: "bafy-demo1-preregistration",
      transactionHash: txHash,
      body,
      bodySha256: digest(body),
      external: { ...external, timestamp: "2026-08-13T09:54:59.999Z" },
    };
    const witness = await anchorDemo1Preregistration(commitment, boundary);
    expect(() => verifyDemo1PreregistrationPreDispatch({ commitment, witness, runState: lockedRunState(), journal: [] }))
      .toThrowError();
  });

  it("verifies the external block timestamp strictly precedes the actual first official dispatch", async () => {
    const witness = await anchorDemo1Preregistration(commitment, new FakeManifestAnchorBoundary());
    expect(verifyDemo1PreregistrationOrdering({
      commitment,
      witness,
      firstOfficialDispatchAt: "2026-08-13T10:00:00.000Z",
    })).toEqual({
      ordered: true,
      externalTimestamp: external.timestamp,
      firstOfficialDispatchAt: "2026-08-13T10:00:00.000Z",
    });
  });

  it.each([
    ["equal", external.timestamp],
    ["late", "2026-08-13T09:59:58.999Z"],
    ["missing", undefined],
  ])("fails closed on a %s first-dispatch witness", async (_label, firstOfficialDispatchAt) => {
    const witness = await anchorDemo1Preregistration(commitment, new FakeManifestAnchorBoundary());
    expect(() => verifyDemo1PreregistrationOrdering({ commitment, witness, firstOfficialDispatchAt }))
      .toThrowError();
  });

  it("derives the actual first official dispatch from the append-only journal instead of accepting a caller-selected time", async () => {
    const witness = await anchorDemo1Preregistration(commitment, new FakeManifestAnchorBoundary());
    const journal: RunJournalEntry[] = [
      {
        kind: "driver-started",
        at: "2026-08-13T10:00:00.000Z",
        operation: "launch",
        generation: "generation-1",
      },
      {
        kind: "submission-accepted",
        at: "2026-08-13T10:00:00.100Z",
        cellKey: "task-1:arm-a:1",
        dispatch: 1,
        submissionSha256: digest("submission"),
        leg: "solve",
      },
      {
        kind: "cell-event",
        at: "2026-08-13T10:00:00.200Z",
        event: { cellKey: "task-1:arm-a:1", armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch" },
      },
    ];
    expect(verifyDemo1PreregistrationRunOrdering({ commitment, witness, journal })).toEqual({
      ordered: true,
      externalTimestamp: external.timestamp,
      firstOfficialDispatchAt: "2026-08-13T10:00:00.100Z",
      firstOfficialDispatchEvidence: {
        journalIndex: 1,
        entrySha256: digest(canonicalJsonBytes(journal[1])),
        kind: "solve-submission-accepted",
        cellKey: "task-1:arm-a:1",
        dispatch: 1,
      },
    });
    expect(() => verifyDemo1PreregistrationRunOrdering({ commitment, witness, journal: journal.slice(0, 1) }))
      .toThrowError();
    expect(() => verifyDemo1PreregistrationRunOrdering({
      commitment,
      witness,
      journal: [{
        kind: "submission-accepted",
        at: "2026-08-13T10:00:00.050Z",
        cellKey: "evaluation-only",
        dispatch: 1,
        submissionSha256: digest("evaluation submission"),
        leg: "evaluation",
      }],
    })).toThrowError();
  });

  it("uses the earliest qualifying timestamp across the full journal and binds its exact evidence identity", async () => {
    const boundary = new FakeManifestAnchorBoundary();
    boundary.readBack = {
      manifestCid: "bafy-demo1-preregistration",
      transactionHash: txHash,
      body: canonicalJsonBytes(commitment),
      bodySha256: digest(canonicalJsonBytes(commitment)),
      external: { ...external, timestamp: "2026-08-13T10:00:00.150Z" },
    };
    const witness = await anchorDemo1Preregistration(commitment, boundary);
    const journal: RunJournalEntry[] = [
      {
        kind: "cell-event",
        at: "2026-08-13T10:00:00.200Z",
        event: { cellKey: "task-later", armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch" },
      },
      {
        kind: "submission-accepted",
        at: "2026-08-13T10:00:00.100Z",
        cellKey: "task-earlier",
        dispatch: 1,
        submissionSha256: digest("earlier submission"),
        leg: "solve",
      },
    ];
    expect(() => verifyDemo1PreregistrationRunOrdering({ commitment, witness, journal }))
      .toThrowError(/strictly precede/u);

    boundary.readBack = {
      ...boundary.readBack,
      external: { ...external, timestamp: "2026-08-13T10:00:00.050Z" },
    };
    const orderedWitness = await anchorDemo1Preregistration(commitment, boundary);
    expect(verifyDemo1PreregistrationRunOrdering({ commitment, witness: orderedWitness, journal }))
      .toMatchObject({
        firstOfficialDispatchAt: "2026-08-13T10:00:00.100Z",
        firstOfficialDispatchEvidence: {
          journalIndex: 1,
          entrySha256: digest(canonicalJsonBytes(journal[1])),
          kind: "solve-submission-accepted",
          cellKey: "task-earlier",
          dispatch: 1,
        },
      });
  });

  it("binds the first journal identity when multiple qualifiers have the same earliest timestamp", async () => {
    const witness = await anchorDemo1Preregistration(commitment, new FakeManifestAnchorBoundary());
    const journal: RunJournalEntry[] = [
      {
        kind: "cell-event",
        at: "2026-08-13T10:00:00.100Z",
        event: { cellKey: "task-event", armId: "arm-a", replicate: 1, dispatch: 1, kind: "dispatch" },
      },
      {
        kind: "submission-accepted",
        at: "2026-08-13T10:00:00.100Z",
        cellKey: "task-submission",
        dispatch: 1,
        submissionSha256: digest("same-time submission"),
        leg: "solve",
      },
    ];
    expect(verifyDemo1PreregistrationRunOrdering({ commitment, witness, journal }))
      .toMatchObject({
        firstOfficialDispatchAt: "2026-08-13T10:00:00.100Z",
        firstOfficialDispatchEvidence: {
          journalIndex: 0,
          entrySha256: digest(canonicalJsonBytes(journal[0])),
          kind: "cell-event-dispatch",
          cellKey: "task-event",
          dispatch: 1,
        },
      });
  });

  it("fails closed when the external timestamp equals the journal-derived earliest dispatch", async () => {
    const boundary = new FakeManifestAnchorBoundary();
    boundary.readBack = {
      manifestCid: "bafy-demo1-preregistration",
      transactionHash: txHash,
      body: canonicalJsonBytes(commitment),
      bodySha256: digest(canonicalJsonBytes(commitment)),
      external: { ...external, timestamp: "2026-08-13T10:00:00.100Z" },
    };
    const witness = await anchorDemo1Preregistration(commitment, boundary);
    expect(() => verifyDemo1PreregistrationRunOrdering({
      commitment,
      witness,
      journal: [{
        kind: "submission-accepted",
        at: "2026-08-13T10:00:00.100Z",
        cellKey: "task-equal",
        dispatch: 1,
        submissionSha256: digest("equal submission"),
        leg: "solve",
      }],
    })).toThrowError(/strictly precede/u);
  });
});
