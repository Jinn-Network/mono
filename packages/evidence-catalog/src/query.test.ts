// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";

import { deterministicJson } from "./keys.js";
import {
  paginateEntityRecords,
  paginateExecutions,
} from "./query.js";
import { createCatalogContractFixtures } from "./testing.js";

describe("Catalog queries", () => {
  const fixtures = createCatalogContractFixtures();

  test("rejects invalid limits and cursor reuse across filters", () => {
    expect(() => paginateExecutions([], { limit: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
    expect(() => paginateExecutions([], { limit: 101 })).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );

    const first = paginateExecutions(
      [fixtures.privateExecution, fixtures.publicDerivative],
      { limit: 1 },
    );
    expect(first.nextCursor).toBeDefined();
    expect(() =>
      paginateExecutions(
        [fixtures.privateExecution, fixtures.publicDerivative],
        { limit: 1, cursor: `${first.nextCursor}!` },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(() =>
      paginateExecutions(
        [fixtures.privateExecution, fixtures.publicDerivative],
        { limit: 1, cursor: first.nextCursor, executorId: "urn:agent:other" },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
  });

  test("binds cursors to the reader method and entity identity", () => {
    const values = [fixtures.privateExecution, fixtures.publicDerivative];
    const execution = paginateExecutions(values, { limit: 1 });
    expect(() =>
      paginateEntityRecords(
        values,
        { limit: 1, cursor: execution.nextCursor },
        fixtures.privateExecution.executionId,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));

    const entity = paginateEntityRecords(
      values,
      { limit: 1 },
      fixtures.privateExecution.executionId,
    );
    expect(() =>
      paginateEntityRecords(
        values,
        { limit: 1, cursor: entity.nextCursor },
        fixtures.privateExecution.task.entityId,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
  });

  test("normalizes object keys by locale-independent code-unit order", () => {
    expect(deterministicJson({ "ä": 1, z: 2, a: 3 })).toBe(
      '{"a":3,"z":2,"ä":1}',
    );
  });

  test("orders equivalent instants by digest and has an empty final page", () => {
    const laterOffset = {
      ...fixtures.publicDerivative,
      startedAt: "2026-07-24T12:00:00+02:00",
    };
    const first = paginateExecutions(
      [laterOffset, fixtures.privateExecution],
      { limit: 1 },
    );
    expect(first.items[0]?.reference.digest).toBe(
      fixtures.privateExecution.reference.digest,
    );
    const second = paginateExecutions(
      [laterOffset, fixtures.privateExecution],
      { limit: 1, cursor: first.nextCursor },
    );
    expect(second.items).toHaveLength(1);
    const final = paginateExecutions(
      [laterOffset, fixtures.privateExecution],
      { limit: 1, cursor: second.nextCursor },
    );
    expect(final.items).toEqual([]);
  });

  test("rejects calendar-impossible timestamps", () => {
    expect(() =>
      paginateExecutions([fixtures.privateExecution], {
        startedAfter: "2026-02-30T10:00:00Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(() =>
      paginateExecutions(
        [
          {
            ...fixtures.privateExecution,
            startedAt: "2026-04-31T10:00:00Z",
          },
        ],
        {},
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
  });

  test("requires Result ID and digest filters to match the same Result", () => {
    const first = fixtures.privateExecution.results[0]!;
    const second = {
      ...first,
      entityId: "results/second.patch",
      digest: `sha256:${"f".repeat(64)}` as const,
    };
    const projection = {
      ...fixtures.privateExecution,
      results: [first, second],
    };
    expect(paginateExecutions([projection], {
      resultId: first.entityId,
      resultDigest: second.digest,
    }).items).toEqual([]);
    expect(paginateExecutions([projection], {
      resultId: second.entityId,
      resultDigest: second.digest,
    }).items).toEqual([projection]);
  });

  test("rejects hostile, oversized, and unknown query input", () => {
    expect(() => paginateExecutions([], null as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
    expect(() => paginateExecutions([], {
      cursor: "x".repeat(16_385),
    })).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(() => paginateExecutions([], {
      trustScore: 1,
    } as never)).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(() => paginateExecutions([], Object.defineProperty({}, "limit", {
      enumerable: true,
      get: () => 1,
    }) as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
  });
});
