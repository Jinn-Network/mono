import { describe, expect, test } from "vitest";

import type { EvidenceCandidate, EvidenceRecordReference } from "./contracts.js";
import { queryEvidence } from "./query.js";
import {
  createQueryReferenceSet,
  queryFixture,
  runQuery,
} from "./test-support.js";

const {
  firstValidReference,
  secondValidReference,
  unavailableReference,
  nonconformingReference,
} = await createQueryReferenceSet();

const candidate = <ProviderData>(
  reference: EvidenceRecordReference,
  providerData?: ProviderData,
): EvidenceCandidate<ProviderData> => ({
  reference,
  ...(providerData === undefined ? {} : { providerData }),
});

describe("queryEvidence", () => {
  test("over-fetches through invalid candidates until resultLimit is filled", async () => {
    const fixture = await queryFixture({
      pages: [
        [unavailableReference, firstValidReference],
        [nonconformingReference, secondValidReference],
      ],
    });
    const outcome = await queryEvidence(
      fixture.dependencies,
      {
        candidateSource: fixture.source,
        sourceQuery: { text: "history" },
        resultLimit: 2,
        candidateBudget: 4,
        diagnostics: "detailed",
      },
    );
    expect(outcome.results.map(({ reference }) => reference)).toEqual([
      firstValidReference,
      secondValidReference,
    ]);
    expect(fixture.find).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("partial");
    expect(outcome.diagnostics?.examinedCandidates).toBe(4);
  });

  test("preserves provider order instead of sorting scores", async () => {
    const fixture = await queryFixture({
      pages: [[
        candidate(secondValidReference, { score: 0.1 }),
        candidate(firstValidReference, { score: 999 }),
      ]],
    });
    const outcome = await runQuery(fixture, { resultLimit: 2, candidateBudget: 2 });
    expect(outcome.results.map(({ reference }) => reference)).toEqual([
      secondValidReference,
      firstValidReference,
    ]);
  });

  test("deduplicates an exact reference and retains all examined observations", async () => {
    const fixture = await queryFixture({
      pages: [[
        candidate(firstValidReference, { store: "local" }),
        candidate(firstValidReference, { store: "public" }),
      ]],
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 2 });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.discoveryProvenance).toHaveLength(2);
  });

  test("stops at candidateBudget and reports why the limit was not filled", async () => {
    const fixture = await queryFixture({
      pages: [
        [candidate(unavailableReference)],
        [candidate(firstValidReference)],
      ],
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
    expect(outcome).toMatchObject({
      status: "partial",
      results: [],
      diagnostics: {
        failures: expect.arrayContaining([
          expect.objectContaining({ code: "CANDIDATE_BUDGET_EXCEEDED" }),
        ]),
      },
    });
    expect(fixture.find).toHaveBeenCalledOnce();
  });

  test("a successful empty source returns complete with an empty result set", async () => {
    const fixture = await queryFixture({ pages: [[]] });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
    expect(outcome.status).toBe("complete");
    expect(outcome.results).toEqual([]);
  });

  test("all leaf source reports failed returns failed", async () => {
    const fixture = await queryFixture({ pages: [[]] });
    fixture.find.mockImplementationOnce(async () => {
      throw new Error("synthetic source failure");
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
    expect(outcome.status).toBe("failed");
    expect(outcome.results).toEqual([]);
  });

  test("one failed and one successful federated leaf returns partial and keeps validated results", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(firstValidReference)]],
      sourceReports: [
        { source: { id: "local", version: "1.0.0" }, status: "complete", candidatesReturned: 1 },
        { source: { id: "public", version: "1.0.0" }, status: "failed", candidatesReturned: 0 },
      ],
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
    expect(outcome.status).toBe("partial");
    expect(outcome.results.map(({ reference }) => reference)).toEqual([
      firstValidReference,
    ]);
  });

  test("a record failure makes a meaningful response partial", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(unavailableReference), candidate(firstValidReference)]],
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 2 });
    expect(outcome.status).toBe("partial");
    expect(outcome.results.map(({ reference }) => reference)).toEqual([
      firstValidReference,
    ]);
  });

  test("resultLimit is never exceeded", async () => {
    const fixture = await queryFixture({
      pages: [[
        candidate(firstValidReference),
        candidate(secondValidReference),
      ]],
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 2 });
    expect(outcome.results).toHaveLength(1);
  });

  test("page requests use min(remaining candidate budget, maxCandidatePageSize)", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(firstValidReference)]],
    });
    await runQuery(fixture, { resultLimit: 1, candidateBudget: 3 });
    expect(fixture.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maximumCandidates: 3 }),
    );
  });

  test("cursor continuation is opaque, source-bound, and returned unchanged except by the provider", async () => {
    const fixture = await queryFixture({
      pages: [
        [candidate(unavailableReference)],
        [candidate(firstValidReference)],
      ],
    });
    const outcome = await runQuery(fixture, { resultLimit: 5, candidateBudget: 5 });
    expect(outcome.nextCursor).toBeUndefined();
    expect(outcome.status).toBe("partial");
  });

  test("checkpoint is passed to every provider page", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(firstValidReference)]],
    });
    const checkpoint = {
      source: fixture.source.identity,
      value: { generation: 1 },
      replayable: true,
    };
    await queryEvidence(fixture.dependencies, {
      candidateSource: fixture.source,
      sourceQuery: { kind: "fixture" },
      resultLimit: 1,
      candidateBudget: 1,
      checkpoint,
    });
    expect(fixture.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ checkpoint }),
    );
  });

  test("a provider returning the same cursor twice becomes PROVIDER_CONTRACT_VIOLATION, not an infinite loop", async () => {
    const identity = { id: "loop-fixture", version: "1.0.0" };
    const find = async () => ({
      source: identity,
      candidates: [candidate(unavailableReference)],
      nextCursor: { source: identity, value: 0 },
    });
    const source = { identity, find };
    const outcome = await queryEvidence(
      {
        locator: { locate: async () => [] },
        locationPolicy: { select: () => [] },
        repositoryResolver: { resolve: async () => null },
        hardLimits: (await queryFixture({ pages: [[]] })).dependencies.hardLimits,
      },
      {
        candidateSource: source,
        sourceQuery: { kind: "loop" },
        resultLimit: 1,
        candidateBudget: 10,
        diagnostics: "detailed",
      },
    );
    expect(outcome.status).not.toBe("complete");
  });

  test("unknown provider data survives into discoveryProvenance", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(firstValidReference, { snippet: "hello" })]],
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
    expect(outcome.results[0]?.discoveryProvenance[0]?.providerData).toEqual({
      snippet: "hello",
    });
  });

  test("acceptance runs only after Protocol validation and rejects post-validation", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(firstValidReference)]],
    });
    const evaluate = async () => ({ status: "rejected" as const, reasonCode: "policy" });
    const outcome = await queryEvidence(fixture.dependencies, {
      candidateSource: fixture.source,
      sourceQuery: { kind: "fixture" },
      resultLimit: 1,
      candidateBudget: 1,
      acceptance: { id: "policy", version: "1.0.0", evaluate },
      diagnostics: "detailed",
    });
    expect(outcome.results).toEqual([]);
    expect(outcome.diagnostics?.failures).toContainEqual(
      expect.objectContaining({ code: "ACCEPTANCE_REJECTED" }),
    );
  });

  test("a savedQuery source identity, result limit, candidate budget, and acceptance identity must match the live invocation", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(firstValidReference)]],
    });
    const savedQuery = {
      retrievalSchemaVersion: "1.0.0" as const,
      candidateSourceSet: { id: "different-source", version: "1.0.0" },
      providerQuery: { kind: "fixture", schemaVersion: "1.0.0", value: null },
      resultLimit: 1,
      candidateBudget: 1,
    };
    await expect(queryEvidence(fixture.dependencies, {
      candidateSource: fixture.source,
      sourceQuery: { kind: "fixture" },
      resultLimit: 1,
      candidateBudget: 1,
      savedQuery,
    })).rejects.toThrow();
  });

  test("a snapshot receipt is emitted only from the actual reports for that run", async () => {
    const fixture = await queryFixture({
      pages: [[candidate(firstValidReference)]],
      sourceReports: [{
        source: pagedFixtureIdentity(),
        status: "complete",
        candidatesReturned: 1,
        checkpoint: {
          source: pagedFixtureIdentity(),
          value: { generation: 1 },
          replayable: true,
        },
      }],
    });
    const savedQuery = {
      retrievalSchemaVersion: "1.0.0" as const,
      candidateSourceSet: fixture.source.identity,
      providerQuery: { kind: "fixture", schemaVersion: "1.0.0", value: null },
      resultLimit: 1,
      candidateBudget: 1,
    };
    const outcome = await queryEvidence(fixture.dependencies, {
      candidateSource: fixture.source,
      sourceQuery: { kind: "fixture" },
      resultLimit: 1,
      candidateBudget: 1,
      savedQuery,
    });
    expect(outcome.snapshotReceipt).toBeDefined();
    expect(outcome.snapshotReceipt?.reproducibility).toBe("replayable");
  });
});

function pagedFixtureIdentity() {
  return { id: "paged-fixture", version: "1.0.0" };
}
