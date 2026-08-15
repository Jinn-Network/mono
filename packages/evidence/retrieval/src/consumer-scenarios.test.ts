import { describe, expect, test, vi } from "vitest";

import {
  createFederatedCandidateSource,
  createSavedEvidenceQuery,
  type CandidateCheckpoint,
  type CandidateSource,
  type FederatedCandidateAllocation,
  type FederatedOrdering,
  type ValidatedEvidenceResult,
} from "./index.js";
import {
  StaticCandidateSource,
  createSyntheticRetrievalFixture,
} from "./testing.js";

const preserveFixtureOrder: FederatedOrdering<
  { readonly terms: readonly string[] },
  { readonly store: string },
  undefined
> = (groups) => groups.map(({ reference }) => ({ reference }));

const allocateAcrossStores: FederatedCandidateAllocation<unknown> = (
  maximum,
  sources,
) => sources.map((_source, index) =>
  Math.floor(maximum / sources.length)
  + (index < maximum % sources.length ? 1 : 0),
);

async function consumerFixture() {
  const fixture = await createSyntheticRetrievalFixture();
  const ordered = [...fixture.records.values()].map(
    ({ reference }) => reference,
  );
  const localDelegate = new StaticCandidateSource(
    { id: "local-store", version: "1.0.0" },
    ordered.slice(0, 2).map((reference) => ({
      reference,
      providerData: { store: "local" },
    })),
  );
  const publicDelegate = new StaticCandidateSource(
    { id: "public-store", version: "1.0.0" },
    ordered.slice(1).map((reference) => ({
      reference,
      providerData: { store: "public" },
    })),
  );
  const localFind = vi.fn((
    query: { readonly terms: readonly string[] },
    options: Parameters<typeof localDelegate.find>[1],
  ) => localDelegate.find(query, options));
  const publicFind = vi.fn((
    query: { readonly terms: readonly string[] },
    options: Parameters<typeof publicDelegate.find>[1],
  ) => publicDelegate.find(query, options));
  const localSource = {
    identity: { id: "local-store", version: "1.0.0" },
    find: localFind,
  };
  const publicSource = {
    identity: { id: "public-store", version: "1.0.0" },
    find: publicFind,
  };
  return {
    ...fixture,
    localSource,
    publicSource,
    localFind,
    publicFind,
    relationshipSource: new StaticCandidateSource(
      { id: "relationships", version: "1.0.0" },
      ordered.map((reference) => ({ reference })),
    ),
    executionReference: fixture.records.get("execution-evidence")!.reference,
    evaluate: (_results: readonly ValidatedEvidenceResult[]) => ({
      status: "consumer-decided" as const,
    }),
  };
}

async function runSemanticProvider(id: string) {
  const fixture = await createSyntheticRetrievalFixture();
  const candidates = [...fixture.records.values()].map(({ reference }) => ({
    reference,
    providerData: { backend: id, similarity: 0.75 },
  }));
  const outcome = await fixture.retrieval.query({
    candidateSource: new StaticCandidateSource(
      { id, version: "1.0.0" },
      candidates,
    ),
    sourceQuery: { text: "same provider query contract" },
    resultLimit: candidates.length,
    candidateBudget: candidates.length,
  });
  await fixture.cleanup();
  return outcome;
}

async function replayableConsumerFixture() {
  const fixture = await createSyntheticRetrievalFixture();
  const sourceIdentity = { id: "dataset-source", version: "1.0.0" };
  const checkpoint: CandidateCheckpoint = {
    source: sourceIdentity,
    value: { generation: "fixture-1" },
    replayable: true,
  };
  const candidates = [...fixture.records.values()].map(
    ({ reference }) => ({ reference }),
  );
  const source: CandidateSource<{ readonly kind: "dataset" }> = {
    identity: sourceIdentity,
    async find(_query, options) {
      if (
        options.checkpoint !== undefined
        && (
          options.checkpoint.value as { readonly generation?: unknown }
        ).generation !== "fixture-1"
      ) {
        throw new Error("Unknown synthetic checkpoint.");
      }
      return {
        source: sourceIdentity,
        candidates: candidates.slice(0, options.maximumCandidates),
        checkpoint,
      };
    },
  };
  const savedQuery = createSavedEvidenceQuery({
    candidateSourceSet: sourceIdentity,
    sourceQuery: { kind: "dataset" as const },
    codec: {
      kind: "dataset-query",
      schemaVersion: "1.0.0",
      encode: (query) => query,
      decode: () => ({ kind: "dataset" as const }),
    },
    resultLimit: candidates.length,
    candidateBudget: candidates.length,
  });
  return {
    ...fixture,
    query: {
      candidateSource: source,
      sourceQuery: { kind: "dataset" as const },
      resultLimit: candidates.length,
      candidateBudget: candidates.length,
      checkpoint,
      savedQuery,
    },
  };
}

describe("consumer boundary scenarios", () => {
  test("plugin host searches configured local and public stores uniformly", async () => {
    const fixture = await consumerFixture();
    const source = createFederatedCandidateSource({
      identity: { id: "plugin-history", version: "1.0.0" },
      sources: [fixture.localSource, fixture.publicSource],
      allocate: allocateAcrossStores,
      order: preserveFixtureOrder,
    });
    const outcome = await fixture.retrieval.query({
      candidateSource: source,
      sourceQuery: { terms: ["matching", "history"] },
      resultLimit: 2,
      candidateBudget: 4,
    });
    expect(fixture.localFind).toHaveBeenCalledOnce();
    expect(fixture.publicFind).toHaveBeenCalledOnce();

    // This projection is deliberately consumer-owned.
    const packet = {
      evidence: outcome.results.map(({ reference, validatedRecord }) => ({
        reference,
        family: validatedRecord.family,
      })),
    };
    expect(packet.evidence).toHaveLength(2);
    expect(JSON.stringify(packet)).not.toContain("snippet");
  });

  test("an evaluator receives relationships but owns its verdict", async () => {
    const fixture = await consumerFixture();
    const outcome = await fixture.retrieval.query({
      candidateSource: fixture.relationshipSource,
      sourceQuery: { executionId: "urn:uuid:22222222-2222-4222-8222-222222222222" },
      resultLimit: 3,
      candidateBudget: 3,
    });
    expect(outcome.results.map(({ validatedRecord }) => validatedRecord.family))
      .toEqual([
        "execution-evidence",
        "result-evaluation",
        "execution-verification",
      ]);
    const verdict = fixture.evaluate(outcome.results);
    expect(verdict).toEqual({ status: "consumer-decided" });
    expect(outcome).not.toHaveProperty("verdict");
  });

  test("a miner requests exact artifacts and publishes nothing through Retrieval", async () => {
    const fixture = await consumerFixture();
    const putRecord = vi.spyOn(fixture.repository, "putRecord");
    const outcome = await fixture.retrieval.retrieve({
      reference: fixture.executionReference,
      artifacts: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "required",
        }],
      },
    });
    expect(outcome).toMatchObject({
      status: "validated",
      result: {
        artifacts: expect.arrayContaining([
          expect.objectContaining({ status: "verified" }),
        ]),
      },
    });
    expect(putRecord).not.toHaveBeenCalled();
  });

  test("equivalent semantic providers do not change Evidence identity", async () => {
    const first = await runSemanticProvider("vector-a");
    const replacement = await runSemanticProvider("vector-b");
    expect(first.results.map(({ reference }) => reference))
      .toEqual(replacement.results.map(({ reference }) => reference));
    expect(first.results.map(({ canonicalBytes }) => canonicalBytes))
      .toEqual(replacement.results.map(({ canonicalBytes }) => canonicalBytes));
  });

  test("a dataset consumer materializes references outside Retrieval", async () => {
    const fixture = await replayableConsumerFixture();
    const outcome = await fixture.retrieval.query(fixture.query);
    expect(outcome.snapshotReceipt?.reproducibility).toBe("replayable");
    const manifest = {
      snapshot: outcome.snapshotReceipt,
      records: outcome.results.map(({ reference }) => reference),
    };
    expect(manifest.records).toHaveLength(outcome.results.length);
    expect(fixture.retrieval).not.toHaveProperty("publishDataset");
  });
});
