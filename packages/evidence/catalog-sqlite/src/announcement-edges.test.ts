// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvidenceCatalogError, type Sha256Digest } from "@jinn-network/evidence-discovery";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ANNOUNCEMENT_EDGE_QUERY_LIMIT,
  announcementEdgesFromCard,
  createSqliteEvidenceCatalog,
} from "./index.js";
import type { SqliteEvidenceCatalog } from "./types.js";

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
    const edges = announcementEdgesFromCard({
      recordKind: EXECUTION_KIND,
      recordDigest: EXECUTION_ONE,
      referenceFields: [...EXECUTION_EDGE_FIELDS],
      facts: { taskDigest: TASK, resultDigests: [RESULT_A, RESULT_B] },
    });
    expect(edges).toEqual([
      { recordKind: EXECUTION_KIND, recordDigest: EXECUTION_ONE, field: "taskDigest", ordinal: 0, targetDigest: TASK },
      { recordKind: EXECUTION_KIND, recordDigest: EXECUTION_ONE, field: "resultDigests", ordinal: 0, targetDigest: RESULT_A },
      { recordKind: EXECUTION_KIND, recordDigest: EXECUTION_ONE, field: "resultDigests", ordinal: 1, targetDigest: RESULT_B },
    ]);
  });

  test("treats an absent optional component as no edge, however the card spells absence", () => {
    // A recompute states an absent optional component as an own property with no value.
    const edges = announcementEdgesFromCard({
      recordKind: EXECUTION_KIND,
      recordDigest: EXECUTION_ONE,
      referenceFields: [...EXECUTION_EDGE_FIELDS],
      facts: { taskDigest: TASK, runtimeDigest: undefined, nativeTraceDigest: null },
    });
    expect(edges.map((edge) => edge.field)).toEqual(["taskDigest"]);
  });

  test("rejects a reference-bearing field holding something that is not a digest", () => {
    expect(() =>
      announcementEdgesFromCard({
        recordKind: EXECUTION_KIND,
        recordDigest: EXECUTION_ONE,
        referenceFields: ["taskDigest"],
        facts: { taskDigest: "https://example.test/task" },
      }),
    ).toThrow(EvidenceCatalogError);
  });
});

describe("the SQLite announcement-edge index", () => {
  test("assembles an environment's attempt-and-verdict graph from cards alone", async () => {
    // Index exactly what a feed carries: one environment, two executions on it, two verdicts.
    await catalog.indexAnnouncementEdges({
      recordKind: ENVIRONMENT_KIND,
      recordDigest: ENVIRONMENT,
      referenceFields: [...ENVIRONMENT_EDGE_FIELDS],
      facts: environmentCard,
    });
    for (const [execution, results] of [
      [EXECUTION_ONE, [RESULT_A]],
      [EXECUTION_TWO, [RESULT_B]],
    ] as const) {
      await catalog.indexAnnouncementEdges({
        recordKind: EXECUTION_KIND,
        recordDigest: execution,
        referenceFields: [...EXECUTION_EDGE_FIELDS],
        facts: executionCard(results),
      });
    }
    for (const [verdict, result] of [
      [VERDICT_PASS, RESULT_A],
      [VERDICT_FAIL, RESULT_B],
    ] as const) {
      await catalog.indexAnnouncementEdges({
        recordKind: EVALUATION_KIND,
        recordDigest: verdict,
        referenceFields: [...EVALUATION_EDGE_FIELDS],
        facts: evaluationCard(result),
      });
    }

    // Hop 1: which executions ran on this environment? (the referrers inversion)
    const attempts = await catalog.queryAnnouncementEdges({
      targetDigest: ENVIRONMENT,
      field: "runtimeDigest",
    });
    expect(attempts.map((edge) => edge.recordDigest)).toEqual([EXECUTION_ONE, EXECUTION_TWO]);

    // Hop 2 and 3: each attempt's results, then the verdicts about those results.
    const graph: Record<string, { results: string[]; verdicts: string[] }> = {};
    for (const attempt of attempts) {
      const results = await catalog.queryAnnouncementEdges({
        recordDigest: attempt.recordDigest,
        field: "resultDigests",
      });
      const verdicts: string[] = [];
      for (const result of results) {
        const judged = await catalog.queryAnnouncementEdges({
          targetDigest: result.targetDigest,
          field: "resultDigests",
          recordKind: EVALUATION_KIND,
        });
        verdicts.push(...judged.map((edge) => edge.recordDigest));
      }
      graph[attempt.recordDigest] = { results: results.map((edge) => edge.targetDigest), verdicts };
    }

    expect(graph).toEqual({
      [EXECUTION_ONE]: { results: [RESULT_A], verdicts: [VERDICT_PASS] },
      [EXECUTION_TWO]: { results: [RESULT_B], verdicts: [VERDICT_FAIL] },
    });
  });

  test("re-indexing one record replaces its edges, so replaying a feed is idempotent", async () => {
    const replayed = await catalog.indexAnnouncementEdges({
      recordKind: EXECUTION_KIND,
      recordDigest: EXECUTION_ONE,
      referenceFields: [...EXECUTION_EDGE_FIELDS],
      facts: executionCard([RESULT_A]),
    });
    expect(replayed.indexed).toBe(4);
    const results = await catalog.queryAnnouncementEdges({
      recordDigest: EXECUTION_ONE,
      field: "resultDigests",
    });
    expect(results).toHaveLength(1);
  });

  test("refuses an unfiltered query rather than scanning the whole index", async () => {
    await expect(catalog.queryAnnouncementEdges({})).rejects.toThrow(EvidenceCatalogError);
  });

  test("indexes nothing for a card that announces none of its declared edges", async () => {
    const receipt = await catalog.indexAnnouncementEdges({
      recordKind: ENVIRONMENT_KIND,
      recordDigest: digest("f"),
      referenceFields: [...ENVIRONMENT_EDGE_FIELDS],
      facts: { "source.repo": "example-org/other" },
    });
    expect(receipt.indexed).toBe(0);
  });
});

describe("the edge index's bounds", () => {
  test("re-indexing a digest replaces its edges even when the card claims a different kind", async () => {
    const digestUnderTwoKinds = digest("7");
    await catalog.indexAnnouncementEdges({
      recordKind: EXECUTION_KIND,
      recordDigest: digestUnderTwoKinds,
      referenceFields: [...EXECUTION_EDGE_FIELDS],
      facts: { taskDigest: TASK, resultDigests: [RESULT_A] },
    });
    await catalog.indexAnnouncementEdges({
      recordKind: EVALUATION_KIND,
      recordDigest: digestUnderTwoKinds,
      referenceFields: [...EVALUATION_EDGE_FIELDS],
      facts: { taskDigest: TASK },
    });
    const edges = await catalog.queryAnnouncementEdges({ recordDigest: digestUnderTwoKinds });
    expect(edges.map((edge) => [edge.recordKind, edge.field])).toEqual([[EVALUATION_KIND, "taskDigest"]]);
  });

  test("bounds a read on a heavily referenced target", async () => {
    const popular = digest("9");
    for (let index = 0; index < ANNOUNCEMENT_EDGE_QUERY_LIMIT + 5; index += 1) {
      await catalog.indexAnnouncementEdges({
        recordKind: EXECUTION_KIND,
        recordDigest: digest(index.toString(16).padStart(2, "0").repeat(2)),
        referenceFields: ["taskDigest"],
        facts: { taskDigest: popular },
      });
    }
    const referrers = await catalog.queryAnnouncementEdges({ targetDigest: popular });
    expect(referrers).toHaveLength(ANNOUNCEMENT_EDGE_QUERY_LIMIT);
  });
});
