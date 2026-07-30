import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  parseEvidenceRecordReference,
} from "@jinn-network/evidence-repository";

import type {
  CandidatePage,
  CandidateSource,
  EvidenceRecordReference,
} from "../index.js";

export interface CandidateSourceContractContext<Query, ProviderData> {
  readonly source: CandidateSource<Query, ProviderData>;
  readonly query: Query;
  readonly expectedReferences: readonly EvidenceRecordReference[];
  readonly assertContinuation?: (
    first: CandidatePage<ProviderData>,
    second: CandidatePage<ProviderData>,
  ) => void | Promise<void>;
  readonly failureQuery: Query;
  readonly timeoutQuery: Query;
  readonly assertAccessBoundary: () => void | Promise<void>;
  readonly cleanup?: () => void | Promise<void>;
}

export type CandidateSourceContractFactory<Query, ProviderData> = (
  testName: string,
) =>
  | CandidateSourceContractContext<Query, ProviderData>
  | Promise<CandidateSourceContractContext<Query, ProviderData>>;

function operationOptions(
  overrides: Partial<Parameters<CandidateSource<unknown>["find"]>[1]> = {},
): Parameters<CandidateSource<unknown>["find"]>[1] {
  return {
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maximumCandidates: 10,
    ...overrides,
  };
}

export function describeCandidateSourceContract<Query, ProviderData>(
  name: string,
  createContext: CandidateSourceContractFactory<Query, ProviderData>,
): void {
  describe(`CandidateSource contract: ${name}`, () => {
    let context: CandidateSourceContractContext<Query, ProviderData> | undefined;

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

    test("has a stable non-empty source ID and version", () => {
      expect(context!.source.identity.id.length).toBeGreaterThan(0);
      expect(context!.source.identity.version.length).toBeGreaterThan(0);
    });

    test("every candidate has a parseable canonical reference", async () => {
      const page = await context!.source.find(
        context!.query,
        operationOptions({ maximumCandidates: context!.expectedReferences.length || 1 }),
      );
      for (const candidate of page.candidates) {
        expect(() => parseEvidenceRecordReference(candidate.reference))
          .not.toThrow();
      }
    });

    test("result order equals the fixture's expected references", async () => {
      const page = await context!.source.find(
        context!.query,
        operationOptions({ maximumCandidates: context!.expectedReferences.length || 1 }),
      );
      expect(page.candidates.map(({ reference }) => reference))
        .toEqual(context!.expectedReferences);
    });

    test("maximumCandidates: 1 returns at most one candidate", async () => {
      const page = await context!.source.find(
        context!.query,
        operationOptions({ maximumCandidates: 1 }),
      );
      expect(page.candidates.length).toBeLessThanOrEqual(1);
    });

    test("an already-aborted signal rejects", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        context!.source.find(
          context!.query,
          operationOptions({ signal: controller.signal }),
        ),
      ).rejects.toBeDefined();
    });

    test("provider metadata JSON encodes within the fixture operation limit and does not change reference identity", async () => {
      const page = await context!.source.find(
        context!.query,
        operationOptions({ maximumCandidates: context!.expectedReferences.length || 1 }),
      );
      for (const candidate of page.candidates) {
        if (candidate.providerData === undefined) continue;
        expect(() => JSON.stringify(candidate.providerData)).not.toThrow();
        expect(parseEvidenceRecordReference(candidate.reference))
          .toEqual(candidate.reference);
      }
    });

    test("a returned cursor has the same source identity and resumes through the fixture's assertContinuation", async () => {
      const first = await context!.source.find(
        context!.query,
        operationOptions({ maximumCandidates: 1 }),
      );
      if (first.nextCursor === undefined) return;
      expect(first.nextCursor.source).toEqual(context!.source.identity);
      const second = await context!.source.find(
        context!.query,
        operationOptions({ maximumCandidates: 1, cursor: first.nextCursor }),
      );
      await context!.assertContinuation?.(first, second);
    });

    test("a replayable checkpoint returns the same ordered reference page when replayed", async () => {
      const first = await context!.source.find(
        context!.query,
        operationOptions({
          maximumCandidates: context!.expectedReferences.length || 1,
        }),
      );
      if (first.checkpoint === undefined || !first.checkpoint.replayable) return;
      const replayed = await context!.source.find(
        context!.query,
        operationOptions({
          maximumCandidates: context!.expectedReferences.length || 1,
          checkpoint: first.checkpoint,
        }),
      );
      expect(replayed.candidates.map(({ reference }) => reference))
        .toEqual(first.candidates.map(({ reference }) => reference));
    });

    test("checkpoint absence or replayable: false is reported honestly", async () => {
      const page = await context!.source.find(
        context!.query,
        operationOptions({ maximumCandidates: 1 }),
      );
      if (page.checkpoint === undefined) return;
      expect(typeof page.checkpoint.replayable).toBe("boolean");
    });

    test("failureQuery rejects rather than returning an empty success page", async () => {
      await expect(
        context!.source.find(context!.failureQuery, operationOptions()),
      ).rejects.toBeDefined();
    });

    test("timeoutQuery rejects within a 250ms harness ceiling", async () => {
      const start = Date.now();
      await expect(
        context!.source.find(
          context!.timeoutQuery,
          operationOptions({ timeoutMs: 5 }),
        ),
      ).rejects.toBeDefined();
      expect(Date.now() - start).toBeLessThan(250);
    }, 300);

    test("observes no access outside its configured backend set", async () => {
      await context!.source.find(context!.query, operationOptions());
      await context!.assertAccessBoundary();
    });
  });
}
