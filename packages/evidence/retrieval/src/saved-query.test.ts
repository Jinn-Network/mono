import { describe, expect, test } from "vitest";

import type {
  CandidateCheckpoint,
  CandidateSourceReport,
  JsonValue,
  ProviderQueryCodec,
  SavedEvidenceQuery,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import {
  createQuerySnapshotReceipt,
  createSavedEvidenceQuery,
  decodeSavedEvidenceQuery,
  savedEvidenceQueryDigest,
} from "./saved-query.js";

const codec: ProviderQueryCodec<{ readonly text: string }> = {
  kind: "keyword-query",
  schemaVersion: "2.0.0",
  encode: ({ text }) => ({ text }),
  decode: (value) => ({ text: (value as { readonly text: string }).text }),
};
const source = { id: "plugin-history", version: "3.0.0" };

function savedFixture(options: {
  readonly value?: JsonValue;
} = {}): SavedEvidenceQuery {
  return {
    retrievalSchemaVersion: "1.0.0",
    candidateSourceSet: source,
    providerQuery: {
      kind: codec.kind,
      schemaVersion: codec.schemaVersion,
      value: options.value ?? { text: "evidence" },
    },
    resultLimit: 10,
    candidateBudget: 40,
  };
}

function replayableCheckpoint(id: string): CandidateCheckpoint {
  const checkpointSource = { id, version: "1.0.0" };
  return {
    source: checkpointSource,
    value: { generation: 1 },
    replayable: true,
  };
}

function completeReport(
  id: string,
  checkpoint: CandidateCheckpoint | undefined,
): CandidateSourceReport {
  const reportSource = checkpoint?.source ?? { id, version: "1.0.0" };
  return {
    source: reportSource,
    status: "complete",
    candidatesReturned: 1,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

describe("saved evidence queries", () => {
  test("round-trips a provider query without storing provider objects", () => {
    const saved = createSavedEvidenceQuery({
      candidateSourceSet: source,
      sourceQuery: { text: "evidence" },
      codec,
      resultLimit: 10,
      candidateBudget: 40,
    });
    expect(saved).toEqual({
      retrievalSchemaVersion: "1.0.0",
      candidateSourceSet: source,
      providerQuery: {
        kind: "keyword-query",
        schemaVersion: "2.0.0",
        value: { text: "evidence" },
      },
      resultLimit: 10,
      candidateBudget: 40,
    });
    expect(decodeSavedEvidenceQuery(saved, { source, codec }))
      .toEqual({ text: "evidence" });
    expect(JSON.stringify(saved)).not.toContain("find");
  });

  test("rejects source and provider schema mismatches explicitly", () => {
    const saved = savedFixture();
    expect(() => decodeSavedEvidenceQuery(saved, {
      source: { id: source.id, version: "4.0.0" },
      codec,
    })).toThrowError(/source-set/);
    expect(() => decodeSavedEvidenceQuery(saved, {
      source,
      codec: { ...codec, schemaVersion: "3.0.0" },
    })).toThrowError(/provider query codec/);
  });

  test("digests semantically identical envelopes deterministically", () => {
    const left = savedFixture({ value: { a: 1, b: 2 } });
    const right = savedFixture({ value: { b: 2, a: 1 } });
    expect(savedEvidenceQueryDigest(left)).toBe(savedEvidenceQueryDigest(right));
  });

  test("does not call a non-replayable run a frozen snapshot", () => {
    const receipt = createQuerySnapshotReceipt(
      savedFixture(),
      [
        completeReport("local", replayableCheckpoint("local")),
        completeReport("public", undefined),
      ],
      "2026-07-27T12:00:00.000Z",
    );
    expect(receipt.reproducibility).toBe("not-replayable");
    expect(receipt.evaluatedAt).toBe("2026-07-27T12:00:00.000Z");
  });

  test("rejects a retrieval schema version other than 1.0.0", () => {
    expect(() => savedEvidenceQueryDigest({
      ...savedFixture(),
      retrievalSchemaVersion: "2.0.0" as never,
    })).toThrow(EvidenceRetrievalError);
  });

  test("rejects non-positive or unsafe limits", () => {
    expect(() => createSavedEvidenceQuery({
      candidateSourceSet: source,
      sourceQuery: { text: "evidence" },
      codec,
      resultLimit: 0,
      candidateBudget: 40,
    })).toThrow(EvidenceRetrievalError);
    expect(() => createSavedEvidenceQuery({
      candidateSourceSet: source,
      sourceQuery: { text: "evidence" },
      codec,
      resultLimit: 1.5,
      candidateBudget: 40,
    })).toThrow(EvidenceRetrievalError);
  });

  test("rejects candidateBudget below resultLimit", () => {
    expect(() => createSavedEvidenceQuery({
      candidateSourceSet: source,
      sourceQuery: { text: "evidence" },
      codec,
      resultLimit: 10,
      candidateBudget: 5,
    })).toThrow(EvidenceRetrievalError);
  });

  test("rejects codec encode output that is not JsonValue", () => {
    const brokenCodec: ProviderQueryCodec<{ readonly text: string }> = {
      kind: "broken",
      schemaVersion: "1.0.0",
      encode: () => ({ fn: (() => {}) as never }),
      decode: (value) => value as never,
    };
    expect(() => createSavedEvidenceQuery({
      candidateSourceSet: source,
      sourceQuery: { text: "evidence" },
      codec: brokenCodec,
      resultLimit: 1,
      candidateBudget: 1,
    })).toThrow(EvidenceRetrievalError);
  });

  test.each([
    "credentials", "password", "secret", "token",
    "privateEndpoint", "signedUrl", "privateKey",
  ])("rejects the reserved secret-bearing key %s at any depth", (key) => {
    const secretCodec: ProviderQueryCodec<{ readonly text: string }> = {
      kind: "secret-bearing",
      schemaVersion: "1.0.0",
      encode: () => ({ nested: { [key]: "leaked" } }),
      decode: (value) => value as never,
    };
    expect(() => createSavedEvidenceQuery({
      candidateSourceSet: source,
      sourceQuery: { text: "evidence" },
      codec: secretCodec,
      resultLimit: 1,
      candidateBudget: 1,
    })).toThrow(EvidenceRetrievalError);
  });

  test("rejects mismatched acceptance ID/version during replay", () => {
    const saved: SavedEvidenceQuery = {
      ...savedFixture(),
      acceptancePolicy: { id: "policy-a", version: "1.0.0" },
    };
    expect(() => decodeSavedEvidenceQuery(saved, {
      source,
      codec,
      acceptance: { id: "policy-a", version: "2.0.0" },
    })).toThrow(EvidenceRetrievalError);
    expect(() => decodeSavedEvidenceQuery(saved, {
      source,
      codec,
    })).toThrow(EvidenceRetrievalError);
  });

  test("labels a timestamp-only receipt with no source checkpoints as not-replayable", () => {
    const receipt = createQuerySnapshotReceipt(
      savedFixture(),
      [completeReport("local", undefined)],
      "2026-07-27T12:00:00.000Z",
    );
    expect(receipt.reproducibility).toBe("not-replayable");
    expect(receipt.sources).toEqual([]);
  });

  test("rejects evaluatedAt that is not an ISO-8601 timestamp", () => {
    expect(() => createQuerySnapshotReceipt(
      savedFixture(),
      [completeReport("local", replayableCheckpoint("local"))],
      "not-a-timestamp",
    )).toThrow(EvidenceRetrievalError);
  });
});
