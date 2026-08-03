// SPDX-License-Identifier: MIT

import type { RunRecord } from "@jinn-network/benchmarking-records";
import type { InScopeCell } from "@jinn-network/benchmarking-run";
import { describe, expect, test } from "vitest";
import {
  failClosedTrustResolver,
  localCloseBoundary,
  localInputScope,
  localReportedCost,
  unresolvedTrustResolver,
} from "./scope.js";

function cell(cellKey: string): InScopeCell {
  const [taskDigest, armId, replicate] = cellKey.split("/");
  return {
    cellKey,
    armId: armId!,
    replicate: Number(replicate),
    taskDigest: taskDigest!,
    dispatches: 1,
    verdicts: [],
  };
}

async function drain(scope: ReturnType<typeof localInputScope>, runDigest: string) {
  const collected: InScopeCell[] = [];
  for await (const entry of scope.submissionsForRun(runDigest)) collected.push(entry);
  return collected;
}

describe("localInputScope", () => {
  test("yields the owner-declared cells for the run", async () => {
    const scope = localInputScope({ cellsForRun: () => [cell("a/arm/1"), cell("b/arm/1")] });
    expect((await drain(scope, "sha256:x")).map((entry) => entry.cellKey))
      .toEqual(["a/arm/1", "b/arm/1"]);
  });

  test("passes the run digest through to the declaration", async () => {
    const seen: string[] = [];
    const scope = localInputScope({
      cellsForRun: (runDigest) => {
        seen.push(runDigest);
        return [];
      },
    });
    await drain(scope, "sha256:run");
    expect(seen).toEqual(["sha256:run"]);
  });

  test("accepts an async iterable declaration", async () => {
    async function* cells() {
      yield cell("a/arm/1");
    }
    const scope = localInputScope({ cellsForRun: () => cells() });
    expect((await drain(scope, "sha256:x")).map((entry) => entry.cellKey)).toEqual(["a/arm/1"]);
  });

  test("omits runCancelled unless declared", () => {
    expect(Object.hasOwn(localInputScope({ cellsForRun: () => [] }), "runCancelled")).toBe(false);
    expect(localInputScope({ cellsForRun: () => [], runCancelled: true }).runCancelled).toBe(true);
  });
});

describe("localCloseBoundary", () => {
  test("resolves to the Run's pre-registered closeAt with no anchor", async () => {
    const boundary = await localCloseBoundary()
      .resolve({ closeAt: "2026-08-04T00:00:00Z" } as RunRecord);
    expect(boundary).toEqual({ at: "2026-08-04T00:00:00Z" });
    expect(Object.hasOwn(boundary, "anchor")).toBe(false);
  });
});

describe("trust resolvers", () => {
  test("unresolvedTrustResolver is the honest floor", async () => {
    expect(await unresolvedTrustResolver().resolveAgent({}, new Date())).toBe("unresolved");
  });

  test("failClosedTrustResolver passes a resolved identity through", async () => {
    const wrapped = failClosedTrustResolver({ async resolveAgent() { return "urn:uuid:1"; } });
    expect(await wrapped.resolveAgent({}, new Date())).toBe("urn:uuid:1");
  });

  test("failClosedTrustResolver converts a throw into unresolved", async () => {
    const wrapped = failClosedTrustResolver({
      async resolveAgent() { throw new Error("binding lookup failed"); },
    });
    expect(await wrapped.resolveAgent({}, new Date())).toBe("unresolved");
  });

  test("failClosedTrustResolver rejects an empty identity", async () => {
    const wrapped = failClosedTrustResolver({ async resolveAgent() { return ""; } });
    expect(await wrapped.resolveAgent({}, new Date())).toBe("unresolved");
  });
});

describe("localReportedCost", () => {
  test("always labels the source reported: a local venue never settles", async () => {
    const cost = localReportedCost({ costFor: () => ({ value: "1.50", unit: "USD" }) });
    expect(await cost.costFor(cell("a/arm/1")))
      .toEqual({ value: "1.50", unit: "USD", source: "reported" });
  });

  test("omits cost and latency when the host reports none", async () => {
    const cost = localReportedCost();
    expect(await cost.costFor(cell("a/arm/1"))).toBeUndefined();
    expect(await cost.latencyFor(cell("a/arm/1"))).toBeUndefined();
  });

  test("passes latency through", async () => {
    const cost = localReportedCost({ latencyFor: () => 1234 });
    expect(await cost.latencyFor(cell("a/arm/1"))).toBe(1234);
  });
});
