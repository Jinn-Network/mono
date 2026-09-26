// SPDX-License-Identifier: Apache-2.0

/**
 * Packet 1 of the dispatch-timestamps design (issue #4614): the `/3` assembly
 * grammar, projection types, exact RFC 3339 comparator reuse, and schema fixtures.
 * Matching §11 rows: source/public member agreement; golden coverage of solve +
 * same-coordinate evaluation pair + unmatched rejected capture; exact comparison
 * of offsets/fractions/leap seconds/equality/clock regression; `/2` goldens stay
 * byte-identical.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  compareCalendarStrictRfc3339Instants as recordsCompare,
} from "@jinn-network/benchmarking-records";
import { BUNDLE_ASSEMBLY_FORMAT, BundleAssemblyHeaderSchema } from "./schema.js";
import {
  BUNDLE_ASSEMBLY_V3_FORMAT,
  BundleAssemblyV3HeaderSchema,
  DispatchBoundaryEvaluationEventSchema,
  DispatchBoundarySolveEventSchema,
  compareCalendarStrictRfc3339Instants,
  dispatchBoundaryCount,
  earliestRecordedDispatch,
  firstDispatchBoundary,
  isCalendarStrictRfc3339,
} from "./assembly-v3.js";

const here = dirname(fileURLToPath(import.meta.url));
const verifyRoot = join(here, "..");
const fixturesDir = join(verifyRoot, "fixtures", "assembly-v3");
const adversarialDir = join(fixturesDir, "adversarial");
const v2SchemaPath = join(verifyRoot, "schemas", "assembly-row.schema.json");
const v3SchemaPath = join(verifyRoot, "schemas", "assembly-row-v3.schema.json");
const v2GoldenAssembly = join(
  verifyRoot,
  "fixtures",
  "public-bundle-conformance-v1",
  "golden",
  "verification",
  "assembly.jsonl",
);
const v2GoldenClaim = join(
  verifyRoot,
  "fixtures",
  "public-bundle-conformance-v1",
  "golden",
  "claim-package.json",
);

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const goldenHeader = loadJson(join(fixturesDir, "golden-header.json")) as {
  format: string;
  graph: {
    solveSubmissions: { sha256: string }[];
    evaluationSubmissions: { sha256: string }[];
    dispatchBoundaries: {
      kind: string;
      journalIndex: number;
      entrySha256: string;
      replicate?: number;
      evalIndex?: number;
      evaluationAttempt?: number;
      dispatch: number;
      submissionSha256: string;
      at: string;
    }[];
  };
};

describe("benchmark-product-assembly/3 grammar (§3.2)", () => {
  test("golden header parses: one matched solve, one unmatched rejected solve, two same-coordinate eval captures", () => {
    const parsed = BundleAssemblyV3HeaderSchema.parse(goldenHeader);
    expect(parsed.format).toBe(BUNDLE_ASSEMBLY_V3_FORMAT);
    const events = parsed.graph.dispatchBoundaries;
    expect(events).toHaveLength(4);

    const solves = events.filter((event) => event.kind === "submission-captured");
    const evals = events.filter((event) => event.kind === "evaluation-submission-captured");
    expect(solves).toHaveLength(2);
    expect(evals).toHaveLength(2);

    expect(evals[0]!.cellKey).toBe(evals[1]!.cellKey);
    expect(evals[0]!.dispatch).toBe(evals[1]!.dispatch);
    expect(evals[0]!.evalIndex).toBe(evals[1]!.evalIndex);
    expect(evals[0]!.evaluationAttempt).toBe(evals[1]!.evaluationAttempt);
    expect(evals[0]!.submissionSha256).not.toBe(evals[1]!.submissionSha256);

    const acceptedSolve = new Set(parsed.graph.solveSubmissions.map((edge) => edge.sha256));
    const acceptedEval = new Set(parsed.graph.evaluationSubmissions.map((edge) => edge.sha256));
    expect(acceptedSolve.has(solves[0]!.submissionSha256)).toBe(true);
    expect(acceptedSolve.has(solves[1]!.submissionSha256)).toBe(false);
    expect(acceptedEval.has(evals[0]!.submissionSha256)).toBe(false);
    expect(acceptedEval.has(evals[1]!.submissionSha256)).toBe(true);
    expect(solves[0]!.publicationSourceSequence).toBe("0000000000000001");
    expect(solves[1]!.publicationSourceSequence).toBeUndefined();
  });

  test("every adversarial schema fixture fails the /3 grammar", () => {
    const names = readdirSync(adversarialDir).filter((name) => name.endsWith(".json")).sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const parsed = BundleAssemblyV3HeaderSchema.safeParse(loadJson(join(adversarialDir, name)));
      expect(parsed.success, name).toBe(false);
    }
  });

  test("at is calendar-strict RFC 3339, not the journal's weaker syntactic check", () => {
    expect(isCalendarStrictRfc3339("2016-12-31T23:59:60Z")).toBe(true);
    expect(isCalendarStrictRfc3339("2026-02-30T00:00:00Z")).toBe(false);
    expect(isCalendarStrictRfc3339("2026-09-06 08:00:00Z")).toBe(false);

    const leap = structuredClone(goldenHeader);
    leap.graph.dispatchBoundaries[0]!.at = "2016-12-31T23:59:60Z";
    expect(BundleAssemblyV3HeaderSchema.safeParse(leap).success).toBe(true);

    const impossible = structuredClone(goldenHeader);
    impossible.graph.dispatchBoundaries[0]!.at = "2026-02-30T00:00:00Z";
    expect(BundleAssemblyV3HeaderSchema.safeParse(impossible).success).toBe(false);
  });

  test("replicate must be a positive integer", () => {
    for (const replicate of [0, -1, 1.5]) {
      const doc = structuredClone(goldenHeader);
      doc.graph.dispatchBoundaries[0]!.replicate = replicate;
      expect(BundleAssemblyV3HeaderSchema.safeParse(doc).success).toBe(false);
    }
  });

  test("journalIndex values must be strictly increasing non-negative safe integers", () => {
    const unsafe = structuredClone(goldenHeader);
    unsafe.graph.dispatchBoundaries[0]!.journalIndex = Number.MAX_SAFE_INTEGER + 1;
    expect(BundleAssemblyV3HeaderSchema.safeParse(unsafe).success).toBe(false);

    const zeroStart = structuredClone(goldenHeader);
    zeroStart.graph.dispatchBoundaries[0]!.journalIndex = 0;
    expect(BundleAssemblyV3HeaderSchema.safeParse(zeroStart).success).toBe(true);
  });
});

describe("exact RFC 3339 comparator reuse (§5.2)", () => {
  test("re-exports the records package function by identity, not a copy", () => {
    expect(compareCalendarStrictRfc3339Instants).toBe(recordsCompare);
  });

  test("covers offsets, arbitrary fractions, leap seconds, equality, and regressing clocks", () => {
    const solve = goldenHeader.graph.dispatchBoundaries[0]!;
    const base = {
      kind: "submission-captured" as const,
      entrySha256: solve.entrySha256,
      cellKey: "cell-a",
      armId: "arm-a",
      replicate: 1,
      dispatch: 1,
      submissionSha256: solve.submissionSha256,
    };

    const offsetEqual = [
      { ...base, journalIndex: 1, at: "2026-07-29T02:30:00.123400+02:30" },
      { ...base, journalIndex: 2, at: "2026-07-29T00:00:00.1234Z" },
    ];
    expect(compareCalendarStrictRfc3339Instants(offsetEqual[0]!.at, offsetEqual[1]!.at)).toBe(0);
    expect(earliestRecordedDispatch(offsetEqual).journalIndex).toBe(1);

    const fractions = [
      { ...base, journalIndex: 1, at: "2026-07-29T00:00:00.0002Z" },
      { ...base, journalIndex: 2, at: "2026-07-29T00:00:00.0001Z" },
    ];
    expect(compareCalendarStrictRfc3339Instants(fractions[1]!.at, fractions[0]!.at)).toBe(-1);
    expect(earliestRecordedDispatch(fractions).journalIndex).toBe(2);

    const leap = [
      { ...base, journalIndex: 1, at: "2017-01-01T00:00:00Z" },
      { ...base, journalIndex: 2, at: "2016-12-31T23:59:60.999999Z" },
    ];
    expect(compareCalendarStrictRfc3339Instants(leap[1]!.at, leap[0]!.at)).toBe(-1);
    expect(earliestRecordedDispatch(leap).journalIndex).toBe(2);

    const regression = [
      { ...base, journalIndex: 4, at: "2026-09-06T09:00:00Z" },
      { ...base, journalIndex: 8, at: "2026-09-06T08:00:00Z" },
    ];
    expect(firstDispatchBoundary(regression).journalIndex).toBe(4);
    expect(earliestRecordedDispatch(regression).journalIndex).toBe(8);
    expect(dispatchBoundaryCount(regression)).toBe(2);
  });
});

describe("/2 byte-identity", () => {
  test("does not move the /2 format constant, public schema, or shipped goldens", () => {
    expect(BUNDLE_ASSEMBLY_FORMAT).toBe("benchmark-product-assembly/2");
    expect(BUNDLE_ASSEMBLY_V3_FORMAT).toBe("benchmark-product-assembly/3");
    expect(sha256File(v2SchemaPath)).toBe(
      "e18eb3dd93834bd5cf27c433b61a8d537d9d8df90af7ad7d37a461596ce19d33",
    );
    expect(sha256File(v2GoldenAssembly)).toBe(
      "e0a0f1fc2d6e7ff3ba51f135d9e6e6f87ea282ea2cfe896ed310f275e9487d29",
    );
    expect(sha256File(v2GoldenClaim)).toBe(
      "a97f1a2a68e20244ba00fccd95a1e5d46ecbd35961e53b11ffc0a4a4384d237c",
    );

    const v2Header = JSON.parse(readFileSync(v2GoldenAssembly, "utf8").split("\n")[0]!);
    expect(BundleAssemblyHeaderSchema.parse(v2Header).format).toBe(BUNDLE_ASSEMBLY_FORMAT);
    expect(BundleAssemblyV3HeaderSchema.safeParse(v2Header).success).toBe(false);
  });
});

describe("source and public /3 schemas agree on every member", () => {
  test("header, graph, and event property names match the published JSON Schema", () => {
    const publicSchema = loadJson(v3SchemaPath) as {
      $defs: {
        header: { properties: { format: { const: string }; graph: { properties: Record<string, unknown> } } };
        solveCapture: { properties: Record<string, unknown> };
        evaluationCapture: { properties: Record<string, unknown> };
      };
    };
    expect(publicSchema.$defs.header.properties.format.const).toBe(BUNDLE_ASSEMBLY_V3_FORMAT);
    expect(Object.keys(publicSchema.$defs.header.properties.graph.properties).sort()).toEqual(
      Object.keys(BundleAssemblyV3HeaderSchema.shape.graph.shape).sort(),
    );
    expect(Object.keys(publicSchema.$defs.solveCapture.properties).sort()).toEqual(
      Object.keys(DispatchBoundarySolveEventSchema.shape).sort(),
    );
    expect(Object.keys(publicSchema.$defs.evaluationCapture.properties).sort()).toEqual(
      Object.keys(DispatchBoundaryEvaluationEventSchema.shape).sort(),
    );
  });
});
