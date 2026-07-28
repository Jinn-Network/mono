import { createRecordReference } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import {
  CandidateAccumulator,
  referenceKey,
} from "./candidates.js";
import { DEFAULT_RETRIEVAL_HARD_LIMITS } from "./contracts.js";

const source = { id: "keyword", version: "1.0.0" };
const first = createRecordReference(
  "execution-evidence",
  new Uint8Array([1]),
);
const second = createRecordReference(
  "result-evaluation",
  new Uint8Array([2]),
);

describe("candidate accumulation", () => {
  test("preserves first-seen order and every duplicate observation", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    accumulator.append({
      source,
      candidates: [
        { reference: first, providerData: { score: 0.9 } },
        { reference: second, providerData: { score: 0.8 } },
        { reference: first, providerData: { score: 0.7 } },
      ],
    }, 3);
    expect(accumulator.groups.map(({ reference }) => referenceKey(reference)))
      .toEqual([referenceKey(first), referenceKey(second)]);
    expect(accumulator.groups[0]?.observations).toHaveLength(2);
    expect(accumulator.groups[0]?.observations.map(({ ordinal }) => ordinal))
      .toEqual([0, 2]);
    expect(accumulator.examined).toBe(3);
  });

  test("rejects a malformed reference as a provider contract violation", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    expect(() => accumulator.append({
      source,
      candidates: [{
        reference: {
          family: "execution-evidence",
          digest: "sha256:not-canonical",
        },
      }],
    } as never, 1)).toThrowError(/canonical reference/);
  });

  test("rejects pages and cursors from another source identity", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    expect(() => accumulator.append({
      source: { id: "other", version: "1.0.0" },
      candidates: [],
    }, 1)).toThrowError(/source identity/);
    expect(() => accumulator.append({
      source,
      candidates: [],
      nextCursor: {
        source: { id: "other", version: "1.0.0" },
        value: "cursor",
      },
    }, 1)).toThrowError(/cursor/);
  });

  test("bounds page length, metadata, cursor, and diagnostics", () => {
    const limits = {
      ...DEFAULT_RETRIEVAL_HARD_LIMITS,
      maxCandidatePageSize: 1,
      maxProviderMetadataBytes: 8,
      maxCursorBytes: 8,
    };
    expect(() => new CandidateAccumulator(source, limits).append({
      source,
      candidates: [
        { reference: first },
        { reference: second },
      ],
    }, 2)).toThrowError(/page/);
    expect(() => new CandidateAccumulator(source, limits).append({
      source,
      candidates: [{ reference: first, providerData: { long: "value" } }],
    }, 1)).toThrowError(/metadata/);
  });

  test("rejects a repeated continuation cursor to prevent an infinite page loop", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    accumulator.append({
      source,
      candidates: [],
      nextCursor: { source, value: "page-2" },
    }, 1);
    expect(() => accumulator.append({
      source,
      candidates: [],
      nextCursor: { source, value: "page-2" },
    }, 1)).toThrowError(/cursor/);
  });

  test("rejects a checkpoint from another source identity", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    expect(() => accumulator.append({
      source,
      candidates: [],
      checkpoint: {
        source: { id: "other", version: "1.0.0" },
        value: "checkpoint",
        replayable: true,
      },
    }, 1)).toThrowError(/source identity/);
  });

  test("rejects provider data that cannot be JSON encoded", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => accumulator.append({
      source,
      candidates: [{ reference: first, providerData: circular }],
    }, 1)).toThrow();
  });

  test("keeps duplicate references distinct when their families differ", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    const sameDigestBytes = new Uint8Array([9]);
    const executionReference = createRecordReference(
      "execution-evidence",
      sameDigestBytes,
    );
    const evaluationReference = createRecordReference(
      "result-evaluation",
      sameDigestBytes,
    );
    accumulator.append({
      source,
      candidates: [
        { reference: executionReference },
        { reference: evaluationReference },
      ],
    }, 2);
    expect(accumulator.groups).toHaveLength(2);
  });

  test("does not mutate accumulated provenance when the caller mutates its own objects afterward", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    const providerData: { score: number } = { score: 1 };
    const locationHints = [{ sourceId: "keyword", repositoryId: "memory" }];
    accumulator.append({
      source,
      candidates: [{ reference: first, providerData, locationHints }],
    }, 1);
    providerData.score = 999;
    locationHints[0]!.repositoryId = "tampered";
    expect(accumulator.groups[0]?.observations[0]?.providerData)
      .toEqual({ score: 1 });
    expect(accumulator.groups[0]?.locationHints[0]?.repositoryId)
      .toBe("memory");
  });
});
