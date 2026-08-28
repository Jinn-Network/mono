// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvidenceCatalogError, type Sha256Digest } from "@jinn-network/evidence-discovery";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ANNOUNCEMENT_EDGE_MAX_LIMIT,
  announcementEdgesFromCard,
  createSqliteEvidenceCatalog,
} from "./index.js";
import type { AnnouncementEdgeIndexInput, SqliteEvidenceCatalog } from "./types.js";

const generation = {
  catalogSchemaVersion: "1.0.0",
  projectorVersion: "projector-fixture",
  createdAt: "2026-07-25T00:00:00Z",
} as const;

const digest = (seed: string): Sha256Digest =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as Sha256Digest;

// Record kinds and the reference-bearing field names their facts profiles declare. The leaf
// packages' own `profiles.test.ts` pin these same lists against the real profile documents, so
// the two halves of the contract cannot drift apart silently.
const ENVIRONMENT_KIND = "https://spec.jinn.network/records/environment/v1";
const ENVIRONMENT_EDGE_FIELDS = ["image.manifestDigest", "parser.digest"] as const;
const EXECUTION_KIND = "https://spec.jinn.network/records/execution-evidence/v1";
const EXECUTION_EDGE_FIELDS = ["taskDigest", "runtimeDigest", "resultDigests", "nativeTraceDigest"] as const;
const EVALUATION_KIND = "https://spec.jinn.network/records/result-evaluation/v1";
const EVALUATION_EDGE_FIELDS = ["taskDigest", "resultDigests", "supersedesDigests", "disputesDigests"] as const;

const HOLDER = "did:example:holder";

// Three announcement facts cards. Nothing here is a record: these are exactly what a feed
// carries, and the whole test never fetches a single record.
const ENVIRONMENT = digest("e");
const IMAGE = digest("1");
const TASK = digest("7");
const RESULT_A = digest("a");
const RESULT_B = digest("b");
const EXECUTION_ONE = digest("c");
const EXECUTION_TWO = digest("d");
const VERDICT_PASS = digest("2");
const VERDICT_FAIL = digest("3");

const environmentCard = {
  environmentRecordDigest: ENVIRONMENT,
  "source.repo": "example-org/example-lib",
  "image.manifestDigest": IMAGE,
  "parser.digest": digest("9"),
};

const executionCard = (results: readonly Sha256Digest[]) => ({
  executionId: "urn:uuid:11111111-1111-5111-8111-111111111111",
  taskDigest: TASK,
  runtimeDigest: ENVIRONMENT,
  resultDigests: results,
  nativeTraceDigest: digest("8"),
  outcome: "completed",
});

const evaluationCard = (result: Sha256Digest) => ({
  evaluatorId: "urn:uuid:22222222-2222-5222-8222-222222222222",
  verdict: "pass",
  taskDigest: TASK,
  resultDigests: [result],
  supersedesDigests: [],
  disputesDigests: [],
});

function announcement(
  sourceId: string,
  announcementId: string,
  recordKind: string,
  recordDigest: Sha256Digest,
  referenceFields: readonly string[],
  facts: Readonly<Record<string, unknown>>,
): AnnouncementEdgeIndexInput {
  return { sourceId, announcementId, recordKind, recordDigest, referenceFields, facts };
}

let temporaryRoot: string;
let catalog: SqliteEvidenceCatalog;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-catalog-edges-"));
  catalog = await createSqliteEvidenceCatalog({
    databasePath: join(temporaryRoot, `${randomUUID()}.sqlite`),
    generation,
  });
});

afterAll(async () => {
  await catalog.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("announcementEdgesFromCard", () => {
  test("reads a scalar edge, an array edge in order, and skips an unannounced field", () => {
    const edges = announcementEdgesFromCard(announcement(
      HOLDER, "ann-1", EXECUTION_KIND, EXECUTION_ONE, EXECUTION_EDGE_FIELDS,
      { taskDigest: TASK, resultDigests: [RESULT_A, RESULT_B] },
    ));
    expect(edges.map((edge) => [edge.field, edge.ordinal, edge.targetDigest])).toEqual([
      ["taskDigest", 0, TASK],
      ["resultDigests", 0, RESULT_A],
      ["resultDigests", 1, RESULT_B],
    ]);
    expect(edges.every((edge) => edge.sourceId === HOLDER && edge.announcementId === "ann-1")).toBe(true);
  });

  test("treats an absent optional component as no edge, however the card spells absence", () => {
    const edges = announcementEdgesFromCard(announcement(
      HOLDER, "ann-1", EXECUTION_KIND, EXECUTION_ONE, EXECUTION_EDGE_FIELDS,
      { taskDigest: TASK, runtimeDigest: undefined, nativeTraceDigest: null },
    ));
    expect(edges.map((edge) => edge.field)).toEqual(["taskDigest"]);
  });

  test("rejects a reference-bearing field holding something that is not a digest", () => {
    expect(() => announcementEdgesFromCard(announcement(
      HOLDER, "ann-1", EXECUTION_KIND, EXECUTION_ONE, ["taskDigest"],
      { taskDigest: "https://example.test/task" },
    ))).toThrow(EvidenceCatalogError);
  });

  test("refuses a card that names no announcing source", () => {
    expect(() => announcementEdgesFromCard(announcement(
      "", "ann-1", EXECUTION_KIND, EXECUTION_ONE, ["taskDigest"], { taskDigest: TASK },
    ))).toThrow(EvidenceCatalogError);
  });
});

describe("the SQLite announcement-edge index", () => {
  test("assembles an environment's attempt-and-verdict graph from cards alone", async () => {
    // Index exactly what a feed carries: one environment, two executions on it, two verdicts.
    await catalog.indexAnnouncementEdges(announcement(
      HOLDER, "ann-env", ENVIRONMENT_KIND, ENVIRONMENT, ENVIRONMENT_EDGE_FIELDS, environmentCard,
    ));
    for (const [execution, results] of [
      [EXECUTION_ONE, [RESULT_A]],
      [EXECUTION_TWO, [RESULT_B]],
    ] as const) {
      await catalog.indexAnnouncementEdges(announcement(
        HOLDER, `ann-${execution}`, EXECUTION_KIND, execution, EXECUTION_EDGE_FIELDS,
        executionCard(results),
      ));
    }
    for (const [verdict, result] of [
      [VERDICT_PASS, RESULT_A],
      [VERDICT_FAIL, RESULT_B],
    ] as const) {
      await catalog.indexAnnouncementEdges(announcement(
        HOLDER, `ann-${verdict}`, EVALUATION_KIND, verdict, EVALUATION_EDGE_FIELDS,
        evaluationCard(result),
      ));
    }

    // Hop 1: which executions ran on this environment? (the referrers inversion)
    const attempts = await catalog.queryAnnouncementEdges({
      targetDigest: ENVIRONMENT,
      field: "runtimeDigest",
    });
    expect(attempts.items.map((edge) => edge.recordDigest)).toEqual([EXECUTION_ONE, EXECUTION_TWO]);
    expect(attempts.nextCursor).toBeUndefined();

    // Hop 2 and 3: each attempt's results, then the verdicts about those results.
    const graph: Record<string, { results: string[]; verdicts: string[] }> = {};
    for (const attempt of attempts.items) {
      const results = await catalog.queryAnnouncementEdges({
        recordDigest: attempt.recordDigest,
        field: "resultDigests",
      });
      const verdicts: string[] = [];
      for (const result of results.items) {
        const judged = await catalog.queryAnnouncementEdges({
          targetDigest: result.targetDigest,
          field: "resultDigests",
          recordKind: EVALUATION_KIND,
        });
        verdicts.push(...judged.items.map((edge) => edge.recordDigest));
      }
      graph[attempt.recordDigest] = {
        results: results.items.map((edge) => edge.targetDigest),
        verdicts,
      };
    }

    expect(graph).toEqual({
      [EXECUTION_ONE]: { results: [RESULT_A], verdicts: [VERDICT_PASS] },
      [EXECUTION_TWO]: { results: [RESULT_B], verdicts: [VERDICT_FAIL] },
    });
  });

  test("re-indexing a record replaces that source's edges, so replaying a feed is idempotent", async () => {
    const replayed = await catalog.indexAnnouncementEdges(announcement(
      HOLDER, "ann-replay", EXECUTION_KIND, EXECUTION_ONE, EXECUTION_EDGE_FIELDS,
      executionCard([RESULT_A]),
    ));
    expect(replayed.indexed).toBe(4);
    const results = await catalog.queryAnnouncementEdges({
      recordDigest: EXECUTION_ONE,
      field: "resultDigests",
    });
    expect(results.items).toHaveLength(1);
  });

  test("one source cannot displace another source's edges for the same record", async () => {
    const contested = digest("6");
    await catalog.indexAnnouncementEdges(announcement(
      HOLDER, "ann-honest", EXECUTION_KIND, contested, EXECUTION_EDGE_FIELDS,
      executionCard([RESULT_A]),
    ));
    // A hostile feed announces the same record digest with a single, different edge.
    await catalog.indexAnnouncementEdges(announcement(
      "did:example:hostile", "ann-hostile", EXECUTION_KIND, contested, EXECUTION_EDGE_FIELDS,
      { taskDigest: digest("5") },
    ));
    const honest = await catalog.queryAnnouncementEdges({
      recordDigest: contested,
      sourceId: HOLDER,
    });
    expect(honest.items).toHaveLength(4);
    expect(honest.items.find((edge) => edge.field === "taskDigest")?.targetDigest).toBe(TASK);
    const both = await catalog.queryAnnouncementEdges({ recordDigest: contested });
    expect(new Set(both.items.map((edge) => edge.sourceId))).toEqual(
      new Set([HOLDER, "did:example:hostile"]),
    );
  });

  test("refuses an unfiltered query rather than scanning the whole index", async () => {
    await expect(catalog.queryAnnouncementEdges({})).rejects.toThrow(EvidenceCatalogError);
  });

  test("indexes nothing for a card that announces none of its declared edges", async () => {
    const receipt = await catalog.indexAnnouncementEdges(announcement(
      HOLDER, "ann-bare", ENVIRONMENT_KIND, digest("f"), ENVIRONMENT_EDGE_FIELDS,
      { "source.repo": "example-org/other" },
    ));
    expect(receipt.indexed).toBe(0);
  });
});

describe("paging a heavily referenced target", () => {
  const popular = digest("4");
  const referrerCount = ANNOUNCEMENT_EDGE_MAX_LIMIT + 5;

  beforeAll(async () => {
    for (let index = 0; index < referrerCount; index += 1) {
      await catalog.indexAnnouncementEdges(announcement(
        HOLDER,
        `ann-popular-${index}`,
        EXECUTION_KIND,
        `sha256:${index.toString(16).padStart(64, "0")}` as Sha256Digest,
        ["taskDigest"],
        { taskDigest: popular },
      ));
    }
  });

  test("hands back a cursor rather than silently truncating", async () => {
    const first = await catalog.queryAnnouncementEdges({
      targetDigest: popular,
      limit: ANNOUNCEMENT_EDGE_MAX_LIMIT,
    });
    expect(first.items).toHaveLength(ANNOUNCEMENT_EDGE_MAX_LIMIT);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await catalog.queryAnnouncementEdges({
      targetDigest: popular,
      limit: ANNOUNCEMENT_EDGE_MAX_LIMIT,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(referrerCount - ANNOUNCEMENT_EDGE_MAX_LIMIT);
    expect(second.nextCursor).toBeUndefined();

    const walked = [...first.items, ...second.items].map((edge) => edge.recordDigest);
    expect(new Set(walked).size).toBe(referrerCount);
  });

  test("a page that exactly exhausts its rows carries no cursor", async () => {
    const lonely = digest("0");
    await catalog.indexAnnouncementEdges(announcement(
      HOLDER, "ann-lonely", EXECUTION_KIND, digest("cd"), ["taskDigest"], { taskDigest: lonely },
    ));
    const exact = await catalog.queryAnnouncementEdges({ targetDigest: lonely, limit: 1 });
    expect(exact.items).toHaveLength(1);
    expect(exact.nextCursor).toBeUndefined();
  });

  test("refuses a cursor minted for a different query", async () => {
    const first = await catalog.queryAnnouncementEdges({ targetDigest: popular, limit: 5 });
    await expect(catalog.queryAnnouncementEdges({
      targetDigest: TASK,
      cursor: first.nextCursor,
    })).rejects.toThrow(EvidenceCatalogError);
  });

  test("refuses a limit outside the supported range", async () => {
    await expect(catalog.queryAnnouncementEdges({
      targetDigest: popular,
      limit: ANNOUNCEMENT_EDGE_MAX_LIMIT + 1,
    })).rejects.toThrow(EvidenceCatalogError);
  });
});
