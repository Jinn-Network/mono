import { createRecordReference } from "@jinn-network/evidence-repository";
import { describe, expect, test, vi } from "vitest";

import { createFederatedCandidateSource } from "./federation.js";
import {
  candidateOptions,
  equalAllocation,
  failingSourceFixture,
  federated,
  providerOrder,
  sourceFixture,
} from "./test-support.js";

const firstReference = createRecordReference(
  "execution-evidence",
  new Uint8Array([1]),
);
const secondReference = createRecordReference(
  "result-evaluation",
  new Uint8Array([2]),
);

describe("createFederatedCandidateSource", () => {
  test("queries every configured local and public child exactly once", async () => {
    const local = sourceFixture("local", [firstReference]);
    const publicSource = sourceFixture("public", [secondReference]);
    const source = createFederatedCandidateSource({
      identity: { id: "plugin-history", version: "1.0.0" },
      sources: [local.source, publicSource.source],
      allocate: equalAllocation,
      order: providerOrder,
    });
    const page = await source.find(
      { terms: ["retrieval"] },
      candidateOptions(4),
    );
    expect(local.find).toHaveBeenCalledOnce();
    expect(publicSource.find).toHaveBeenCalledOnce();
    expect(page.candidates.map(({ reference }) => reference))
      .toEqual([firstReference, secondReference]);
  });

  test("merges an exact duplicate and preserves both child observations", async () => {
    const local = sourceFixture("local", [firstReference]);
    const publicSource = sourceFixture("public", [firstReference]);
    const page = await federated(local.source, publicSource.source).find(
      { terms: ["same"] },
      candidateOptions(4),
    );
    expect(page.candidates).toHaveLength(1);
    expect(
      (
        page.candidates[0]?.providerData as {
          readonly contributions: readonly { readonly source: { readonly id: string } }[];
        }
      ).contributions.map(({ source }) => source.id),
    ).toEqual(["local", "public"]);
  });

  test("reports one child failure while retaining another child's candidates", async () => {
    const local = sourceFixture("local", [firstReference]);
    const remote = failingSourceFixture("public");
    const page = await federated(local.source, remote.source).find(
      { terms: ["partial"] },
      candidateOptions(4),
    );
    expect(page.candidates).toHaveLength(1);
    expect(page.sourceReports).toContainEqual(
      expect.objectContaining({
        source: remote.source.identity,
        status: "failed",
      }),
    );
  });

  test("never calls an unconfigured source", async () => {
    const local = sourceFixture("local", [firstReference]);
    const unconfigured = sourceFixture("unconfigured", [secondReference]);
    await federated(local.source).find(
      { terms: ["scoped"] },
      candidateOptions(4),
    );
    expect(unconfigured.find).not.toHaveBeenCalled();
  });

  test("keeps distinct derivative digests distinct", async () => {
    const local = sourceFixture("local", [firstReference, secondReference]);
    const page = await federated(local.source).find(
      { terms: ["distinct"] },
      candidateOptions(4),
    );
    expect(page.candidates).toHaveLength(2);
  });

  test("does not use configured source order as relevance order", async () => {
    const local = sourceFixture("local", [firstReference]);
    const publicSource = sourceFixture("public", [secondReference]);
    const reverseOrder = (
      groups: readonly {
        readonly reference: typeof firstReference | typeof secondReference;
      }[],
    ) => [...groups].reverse().map(({ reference }) => ({ reference }));
    const source = createFederatedCandidateSource({
      identity: { id: "reverse", version: "1.0.0" },
      sources: [local.source, publicSource.source],
      allocate: equalAllocation,
      order: reverseOrder,
    });
    const page = await source.find({ terms: ["order"] }, candidateOptions(4));
    expect(page.candidates.map(({ reference }) => reference))
      .toEqual([secondReference, firstReference]);
  });

  test("preserves location hints without letting them affect ordering", async () => {
    const local = {
      identity: { id: "local", version: "1.0.0" },
      find: async (
        _query: unknown,
        options: Parameters<typeof sourceFixture>[1] extends never ? never : any,
      ) => ({
        source: { id: "local", version: "1.0.0" },
        candidates: [{
          reference: firstReference,
          locationHints: [{ sourceId: "local", repositoryId: "memory" }],
        }].slice(0, options.maximumCandidates),
      }),
    };
    const page = await federated(local as any).find(
      { terms: ["hints"] },
      candidateOptions(4),
    );
    expect(page.candidates[0]?.locationHints).toEqual([
      { sourceId: "local", repositoryId: "memory" },
    ]);
  });

  test("requires the allocation callback to allocate at least one candidate per child within the maximum", async () => {
    const local = sourceFixture("local", [firstReference]);
    const publicSource = sourceFixture("public", [secondReference]);
    const overAllocation = () => [3, 3] as const;
    const source = createFederatedCandidateSource({
      identity: { id: "over", version: "1.0.0" },
      sources: [local.source, publicSource.source],
      allocate: overAllocation,
      order: providerOrder,
    });
    await expect(
      source.find({ terms: ["over"] }, candidateOptions(4)),
    ).rejects.toThrow();
  });

  test("rejects a maximum smaller than the number of configured stores", async () => {
    const local = sourceFixture("local", [firstReference]);
    const publicSource = sourceFixture("public", [secondReference]);
    const source = createFederatedCandidateSource({
      identity: { id: "too-small", version: "1.0.0" },
      sources: [local.source, publicSource.source],
      allocate: equalAllocation,
      order: providerOrder,
    });
    await expect(
      source.find({ terms: ["too-small"] }, candidateOptions(1)),
    ).rejects.toThrow();
  });

  test("bounds fan-out concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const sources = ["a", "b", "c", "d"].map((id) => ({
      identity: { id, version: "1.0.0" },
      find: async (
        _query: unknown,
        options: { readonly maximumCandidates: number },
      ) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return {
          source: { id, version: "1.0.0" },
          candidates: [{ reference: firstReference }].slice(
            0,
            options.maximumCandidates,
          ),
        };
      },
    }));
    const source = createFederatedCandidateSource({
      identity: { id: "bounded", version: "1.0.0" },
      sources,
      allocate: equalAllocation,
      order: providerOrder,
      maximumConcurrency: 2,
    });
    await source.find({ terms: ["bounded"] }, candidateOptions(8));
    expect(maximum).toBeLessThanOrEqual(2);
  });

  test("round-trips a composite cursor without exposing physical endpoints", async () => {
    const local = {
      identity: { id: "local", version: "1.0.0" },
      find: async (
        _query: unknown,
        options: { readonly maximumCandidates: number; readonly cursor?: unknown },
      ) => ({
        source: { id: "local", version: "1.0.0" },
        candidates: [{ reference: firstReference }].slice(
          0,
          options.maximumCandidates,
        ),
        nextCursor: {
          source: { id: "local", version: "1.0.0" },
          value: { page: 2 },
        },
      }),
    };
    const source = createFederatedCandidateSource({
      identity: { id: "cursor-round-trip", version: "1.0.0" },
      sources: [local as never],
      allocate: equalAllocation,
      order: providerOrder,
    });
    const page = await source.find(
      { terms: ["cursor"] },
      candidateOptions(4),
    );
    expect(page.nextCursor?.source).toEqual({
      id: "cursor-round-trip",
      version: "1.0.0",
    });
    const resumed = await source.find(
      { terms: ["cursor"] },
      { ...candidateOptions(4), cursor: page.nextCursor },
    );
    expect(resumed.candidates.map(({ reference }) => reference))
      .toEqual([firstReference]);
  });

  test("a composite checkpoint is replayable only if every successful leaf checkpoint is replayable", async () => {
    const replayableLeaf = {
      identity: { id: "replayable", version: "1.0.0" },
      find: async (
        _query: unknown,
        options: { readonly maximumCandidates: number },
      ) => ({
        source: { id: "replayable", version: "1.0.0" },
        candidates: [{ reference: firstReference }].slice(
          0,
          options.maximumCandidates,
        ),
        checkpoint: {
          source: { id: "replayable", version: "1.0.0" },
          value: { generation: 1 },
          replayable: true,
        },
      }),
    };
    const nonReplayableLeaf = {
      identity: { id: "non-replayable", version: "1.0.0" },
      find: async (
        _query: unknown,
        options: { readonly maximumCandidates: number },
      ) => ({
        source: { id: "non-replayable", version: "1.0.0" },
        candidates: [{ reference: secondReference }].slice(
          0,
          options.maximumCandidates,
        ),
        checkpoint: {
          source: { id: "non-replayable", version: "1.0.0" },
          value: { generation: 1 },
          replayable: false,
        },
      }),
    };
    const source = createFederatedCandidateSource({
      identity: { id: "checkpoint-mix", version: "1.0.0" },
      sources: [replayableLeaf as never, nonReplayableLeaf as never],
      allocate: equalAllocation,
      order: providerOrder,
    });
    const page = await source.find(
      { terms: ["checkpoint"] },
      candidateOptions(4),
    );
    expect(page.checkpoint?.replayable).toBe(false);
  });

  test("a composite checkpoint is non-replayable when a configured leaf fails, and a replay attempt never runs that leaf as if it had been captured", async () => {
    const replayableLeaf = {
      identity: { id: "replayable", version: "1.0.0" },
      find: vi.fn(async (
        _query: unknown,
        options: { readonly maximumCandidates: number },
      ) => ({
        source: { id: "replayable", version: "1.0.0" },
        candidates: [{ reference: firstReference }].slice(
          0,
          options.maximumCandidates,
        ),
        checkpoint: {
          source: { id: "replayable", version: "1.0.0" },
          value: { generation: 1 },
          replayable: true,
        },
      })),
    };
    const failingLeaf = {
      identity: { id: "failing", version: "1.0.0" },
      find: vi.fn(async (
        _query: unknown,
        _options: { readonly checkpoint?: unknown },
      ): Promise<never> => {
        throw new Error("Synthetic source failure.");
      }),
    };
    const source = createFederatedCandidateSource({
      identity: { id: "checkpoint-partial-failure", version: "1.0.0" },
      sources: [replayableLeaf as never, failingLeaf as never],
      allocate: equalAllocation,
      order: providerOrder,
    });
    const page = await source.find(
      { terms: ["checkpoint"] },
      candidateOptions(4),
    );
    // Even though the surviving leaf produced a replayable checkpoint, the
    // failed leaf contributed nothing to replay against, so the composite
    // must not claim replayability.
    expect(page.checkpoint?.replayable).toBe(false);

    // A caller that (incorrectly) tries to replay this non-replayable
    // checkpoint anyway must never have the previously-failed leaf silently
    // treated as though its state had been captured: it receives no
    // checkpoint constraint at all and therefore runs against current
    // state, not a frozen historical one.
    await source.find(
      { terms: ["checkpoint"] },
      { ...candidateOptions(4), checkpoint: page.checkpoint },
    );
    expect(failingLeaf.find).toHaveBeenCalledTimes(2);
    const replayCallOptions = failingLeaf.find.mock.calls[1]?.[1] as
      | { readonly checkpoint?: unknown }
      | undefined;
    expect(replayCallOptions?.checkpoint).toBeUndefined();
  });

  test("all child failures produce an empty page with failed source reports, not a successful leaf report", async () => {
    const first = failingSourceFixture("first");
    const second = failingSourceFixture("second");
    const page = await federated(first.source, second.source).find(
      { terms: ["all-failed"] },
      candidateOptions(4),
    );
    expect(page.candidates).toHaveLength(0);
    expect(page.sourceReports).toHaveLength(2);
    expect(page.sourceReports?.every(({ status }) => status === "failed"))
      .toBe(true);
  });

  test("requires at least one configured child", () => {
    expect(() => createFederatedCandidateSource({
      identity: { id: "empty", version: "1.0.0" },
      sources: [],
      allocate: equalAllocation,
      order: providerOrder,
    })).toThrow();
  });
});
