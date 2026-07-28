import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  CandidateSource,
  EvidenceRecordReference,
  EvidenceRetrieval,
} from "../index.js";

export interface EvidenceRetrievalContractContext<Query, ProviderData> {
  readonly retrieval: EvidenceRetrieval;
  readonly records: ReadonlyMap<
    EvidenceRecordReference["family"],
    {
      readonly reference: EvidenceRecordReference;
      readonly bytes: Uint8Array;
    }
  >;
  readonly source: CandidateSource<Query, ProviderData>;
  readonly sourceQuery: Query;
  readonly cleanup?: () => void | Promise<void>;
}

export type EvidenceRetrievalContractFactory<Query, ProviderData> = (
  testName: string,
) =>
  | EvidenceRetrievalContractContext<Query, ProviderData>
  | Promise<EvidenceRetrievalContractContext<Query, ProviderData>>;

export function describeEvidenceRetrievalContract<Query, ProviderData>(
  name: string,
  createContext: EvidenceRetrievalContractFactory<Query, ProviderData>,
): void {
  describe(`EvidenceRetrieval contract: ${name}`, () => {
    let context: EvidenceRetrievalContractContext<Query, ProviderData> | undefined;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
    });

    afterEach(async () => {
      try {
        await context?.cleanup?.();
      } finally {
        context = undefined;
      }
    });

    test("performs known-reference retrieval for all three families", async () => {
      for (const { reference } of context!.records.values()) {
        const outcome = await context!.retrieval.retrieve({ reference });
        expect(outcome.status).toBe("validated");
      }
    });

    test("canonical bytes equal fixture bytes but use a defensive buffer", async () => {
      const fixture = [...context!.records.values()][0]!;
      const outcome = await context!.retrieval.retrieve({
        reference: fixture.reference,
      });
      expect(outcome.status).toBe("validated");
      if (outcome.status !== "validated") return;
      expect(outcome.result.canonicalBytes).toEqual(fixture.bytes);
      expect(outcome.result.canonicalBytes).not.toBe(fixture.bytes);
    });

    test("query returns all fixture references in source order", async () => {
      const expected = [...context!.records.values()].map(
        ({ reference }) => reference,
      );
      const outcome = await context!.retrieval.query({
        candidateSource: context!.source,
        sourceQuery: context!.sourceQuery,
        resultLimit: expected.length,
        candidateBudget: expected.length,
      });
      expect(outcome.results.map(({ reference }) => reference)).toEqual(expected);
    });

    test("no artifact read occurs without explicit selection", async () => {
      const fixture = [...context!.records.values()][0]!;
      const outcome = await context!.retrieval.retrieve({
        reference: fixture.reference,
      });
      expect(outcome.status).toBe("validated");
      if (outcome.status !== "validated") return;
      expect(
        outcome.result.artifacts.every(({ status }) => status === "not-requested"),
      ).toBe(true);
    });

    test("malformed or mismatched bytes never appear as a successful result", async () => {
      const fixture = [...context!.records.values()][0]!;
      const forged = {
        family: fixture.reference.family,
        digest: fixture.reference.digest.slice(0, -1) + "0",
      } as EvidenceRecordReference;
      const outcome = await context!.retrieval.retrieve({ reference: forged });
      expect(outcome.status).toBe("failed");
    });

    test("cancellation is observable", async () => {
      const controller = new AbortController();
      controller.abort();
      const fixture = [...context!.records.values()][0]!;
      const outcome = await context!.retrieval.retrieve(
        { reference: fixture.reference },
        { signal: controller.signal },
      );
      expect(outcome.status).toBe("failed");
    });

    test("resultLimit and candidateBudget are enforced", async () => {
      const outcome = await context!.retrieval.query({
        candidateSource: context!.source,
        sourceQuery: context!.sourceQuery,
        resultLimit: 1,
        candidateBudget: 1,
      });
      expect(outcome.results.length).toBeLessThanOrEqual(1);
    });

    test("source metadata remains provenance and never becomes canonical data", async () => {
      const outcome = await context!.retrieval.query({
        candidateSource: context!.source,
        sourceQuery: context!.sourceQuery,
        resultLimit: context!.records.size,
        candidateBudget: context!.records.size,
      });
      for (const result of outcome.results) {
        expect(result.discoveryProvenance.every(
          (observation) => observation.source.id === context!.source.identity.id,
        )).toBe(true);
      }
    });
  });
}
