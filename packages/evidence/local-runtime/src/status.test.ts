// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalEvidenceRuntimeError } from "./errors.js";
import { openLocalOperationsStore } from "./operations-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function failureFixture() {
  const root = await mkdtemp(join(tmpdir(), "jinn-runtime-status-"));
  roots.push(root);
  const operations = await openLocalOperationsStore(join(root, "operations.sqlite"));
  const generationId = "urn:uuid:22222222-2222-4222-8222-222222222222";
  const sourceId = "urn:uuid:11111111-1111-4111-8111-111111111111";
  for (const [index, family] of [
    "execution-evidence",
    "result-evaluation",
  ].entries()) {
    const reference = {
      family: family as "execution-evidence" | "result-evaluation",
      digest: `sha256:${String(index + 1).repeat(64)}` as const,
    };
    const observedAt = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    await operations.recordFailureAndCheckpoint({
      generationId,
      sourceId,
      announcementId: `announcement-${index}`,
      reference,
      journalCursor: `cursor-${index}`,
      indexedTotal: 0,
      failedTotal: index + 1,
      observedAt,
      failure: {
        reference,
        category: "content-corrupt",
        sourceCode: "CONTENT_CORRUPT",
        message: "record bytes were corrupt",
        observedAt,
      },
    });
  }
  return { generationId, operations };
}

describe("runtime status contracts", () => {
  it("uses a stable invalid-query error", () => {
    expect(new LocalEvidenceRuntimeError("INVALID_QUERY", "bad")).toMatchObject({
      name: "LocalEvidenceRuntimeError",
      code: "INVALID_QUERY",
    });
  });

  it("emits and accepts an exact canonical failure cursor", async () => {
    const { generationId, operations } = await failureFixture();
    const first = await operations.listFailures(generationId, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual([
      "digest",
      "family",
      "queryHash",
      "updatedAt",
      "version",
    ]);
    expect(decoded).toMatchObject({
      version: 1,
      family: "result-evaluation",
      digest: `sha256:${"2".repeat(64)}`,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(decoded.queryHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(operations.listFailures(generationId, {
      limit: 1,
      cursor: first.nextCursor,
    })).resolves.toMatchObject({ items: [expect.any(Object)] });
    await operations.close();
  });

  it("rejects noncanonical, cross-query, and hostile failure cursors", async () => {
    const { generationId, operations } = await failureFixture();
    const first = await operations.listFailures(generationId, { limit: 1 });
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const reordered = {
      digest: decoded.digest,
      family: decoded.family,
      updatedAt: decoded.updatedAt,
      queryHash: decoded.queryHash,
      version: decoded.version,
    };
    const pretty = Buffer.from(JSON.stringify(decoded, null, 2)).toString("base64url");
    const duplicateKey = Buffer.from(
      JSON.stringify(decoded).replace('"version":1', '"version":1,"version":1'),
    ).toString("base64url");
    const hostile = [
      `${first.nextCursor}=`,
      encode(reordered),
      pretty,
      duplicateKey,
      "A".repeat(4097),
      encode({ ...decoded, extra: true }),
      encode({ ...decoded, version: 2 }),
      encode({ ...decoded, family: "unsupported" }),
      encode({ ...decoded, digest: "sha256:not-a-digest" }),
      encode({ ...decoded, updatedAt: "not-a-timestamp" }),
      encode({ ...decoded, queryHash: "0".repeat(64) }),
      encode([]),
      encode(null),
    ];
    for (const cursor of hostile) {
      await expect(operations.listFailures(generationId, { limit: 1, cursor }))
        .rejects.toMatchObject({ code: "INVALID_QUERY" });
    }
    await expect(operations.listFailures(generationId, {
      limit: 1,
      category: "content-corrupt",
      cursor: first.nextCursor,
    })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await operations.close();
  });

  it("rejects hostile query shapes and reference members", async () => {
    const { generationId, operations } = await failureFixture();
    const hostile: unknown[] = [
      null,
      [],
      { unknown: true },
      { limit: "1" },
      { limit: 0 },
      { limit: 101 },
      { category: "unknown" },
      { cursor: 1 },
      Object.defineProperty({}, "limit", {
        enumerable: true,
        get() {
          throw new Error("getter must not run");
        },
      }),
      Object.defineProperty({}, "limit", {
        enumerable: false,
        value: 1,
      }),
      { [Symbol("limit")]: 1 },
      { reference: null },
      {
        reference: Object.defineProperty({}, "family", {
          enumerable: true,
          get() {
            throw new Error("nested getter must not run");
          },
        }),
      },
      {
        reference: {
          family: "execution-evidence",
          digest: `sha256:${"1".repeat(64)}`,
          extra: true,
        },
      },
      {
        reference: {
          family: "unsupported",
          digest: `sha256:${"1".repeat(64)}`,
        },
      },
    ];
    for (const query of hostile) {
      await expect(operations.listFailures(generationId, query as never))
        .rejects.toMatchObject({ code: "INVALID_QUERY" });
    }
    await operations.close();
  });

  it("scopes public failures to the active generation", async () => {
    const { generationId, operations } = await failureFixture();
    const staleGenerationId = "urn:uuid:33333333-3333-4333-8333-333333333333";
    const reference = {
      family: "execution-evidence" as const,
      digest: `sha256:${"9".repeat(64)}` as const,
    };
    await operations.recordFailureAndCheckpoint({
      generationId: staleGenerationId,
      sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      announcementId: "stale-announcement",
      reference,
      journalCursor: "stale-cursor",
      indexedTotal: 0,
      failedTotal: 1,
      observedAt: "2026-01-03T00:00:00.000Z",
      failure: {
        reference,
        category: "content-corrupt",
        sourceCode: "CONTENT_CORRUPT",
        message: "stale generation failure",
        observedAt: "2026-01-03T00:00:00.000Z",
      },
    });

    const current = await operations.listFailures(generationId);
    const stale = await operations.listFailures(staleGenerationId);
    expect(current.items).toHaveLength(2);
    expect(stale.items).toHaveLength(1);
    expect(current.items).not.toContainEqual(stale.items[0]);
    await operations.close();
  });
});
