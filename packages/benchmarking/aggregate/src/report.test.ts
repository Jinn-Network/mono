import { createHash } from "node:crypto";
import {
  loadGoldenJson,
  parseMatrix,
  sealMatrix,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";
import type { DsseSigningRequest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { createMethodRegistry } from "./registry.js";
import { deriveDisclosures, produceReport, verifyReport, type DsseSigner } from "./report.js";
import type { VerdictOutcome } from "./method.js";

const RUN_DESCRIPTOR = { digest: { sha256: "a".repeat(64) } };
const CLOSE_BOUNDARY = { at: "2026-08-04T00:00:00Z" };
const ASSEMBLY = { procedure: "jinn.benchmarking.assembly", version: "1.0" };
const MATCH_ALL = { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] };

function sha256Hex(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}
function taskDigest(label: string): string {
  return sha256Hex(`task/${label}`);
}
function digest(label: string): string {
  return `sha256:${sha256Hex(`verdict/${label}`)}`;
}
function cellKey(task: string, armId: string, replicate: number): string {
  return `${task}/${armId}/${replicate}`;
}

function cell(taskLabel: string, armId: string, outcome: string, verdicts: string[] = []): Record<string, unknown> {
  const task = taskDigest(taskLabel);
  return {
    cellKey: cellKey(task, armId, 1),
    taskDigest: task,
    armId,
    replicate: 1,
    dispatches: 1,
    accounted: 1,
    verdicts,
    validVerdicts: verdicts,
    outcome,
    verification: MATCH_ALL,
    integrityTier: "re-derivable",
  };
}

function buildMatrix(cells: Record<string, unknown>[], run: unknown = RUN_DESCRIPTOR): MatrixRecord {
  const perArm: Record<string, Record<string, number>> = {};
  for (const c of cells) {
    const armId = c["armId"] as string;
    const outcome = c["outcome"] as string;
    perArm[armId] ??= { expected: 0, judged: 0, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 };
    perArm[armId]!["expected"] += 1;
    perArm[armId]![outcome] += 1;
  }
  const document = {
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
    run,
    closeBoundary: CLOSE_BOUNDARY,
    cells,
    exclusions: [],
    attrition: { perArm, asymmetryFlags: [] },
    completeness: { expected: cells.length, judged: cells.filter((c) => c["outcome"] === "judged").length, floor: "0.5", runOutcome: "complete" },
    assembly: ASSEMBLY,
  };
  return parseMatrix(sealMatrix(document).bytes);
}

const fakeSigner: DsseSigner = async (request: DsseSigningRequest) => [
  { signature: new TextEncoder().encode(`sig-over-${request.payloadBytes.length}-bytes`), keyid: "test-key" },
];

describe("deriveDisclosures", () => {
  test("reproduces the M1 golden fixture pair exactly: report/valid.json's disclosures from matrix/valid.json", async () => {
    const matrixJson = await loadGoldenJson("matrix", "valid");
    const reportJson = (await loadGoldenJson("report", "valid")) as { disclosures: unknown };
    const matrix = parseMatrix(sealMatrix(matrixJson).bytes);
    const derived = deriveDisclosures([matrix]);
    expect(derived).toEqual(reportJson.disclosures);
  });
});

describe("produceReport / verifyReport round trip", () => {
  const registry = createMethodRegistry();
  const matrix = buildMatrix([
    cell("t1", "armA", "judged", [digest("t1")]),
    cell("t2", "armA", "judged", [digest("t2")]),
  ]);
  const outcomes = new Map<string, VerdictOutcome>([
    [digest("t1"), { verdict: "pass" }],
    [digest("t2"), { verdict: "fail" }],
  ]);
  const resolveVerdict = (d: string): VerdictOutcome | undefined => outcomes.get(d);
  const resolveBenchmarkDigest = (): string => "benchmark-digest-1";

  test("a produced Report verifies OK against its own subjects", async () => {
    const { record } = await produceReport(
      {
        subjects: [matrix],
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    );
    expect(record.protocol).toBe("https://jinn.network/protocols/benchmarking/1.0");
    expect(record.method.parameters["verdictRule"]).toBe("unanimous");

    const result = verifyReport(record, [matrix], { resolveVerdict, registry, resolveBenchmarkDigest });
    expect(result).toEqual({ ok: true });
  });

  test("the DSSE envelope round-trips: payload equals the sealed record bytes, one signature present", async () => {
    const { bytes, envelope } = await produceReport(
      {
        subjects: [matrix],
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    );
    const envelopeJson = JSON.parse(new TextDecoder().decode(envelope)) as { payloadType: string; payload: string; signatures: unknown[] };
    expect(envelopeJson.payloadType).toBe("application/vnd.jinn.benchmarking.report.v1+json");
    expect(envelopeJson.signatures.length).toBe(1);
    const decodedPayload = Uint8Array.from(atob(envelopeJson.payload), (c) => c.charCodeAt(0));
    expect(decodedPayload).toEqual(bytes);
  });

  test("a tampered results block is caught by report-recompute", async () => {
    const { record } = await produceReport(
      {
        subjects: [matrix],
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    );
    const tamperedRecord = { ...record, results: { ...(record.results as object), arms: {} } };
    const result = verifyReport(tamperedRecord, [matrix], { resolveVerdict, registry, resolveBenchmarkDigest });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.check).toBe("report-recompute");
  });

  test("a tampered disclosures block is caught by disclosures-faithfulness", async () => {
    const { record } = await produceReport(
      {
        subjects: [matrix],
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    );
    const tamperedRecord = { ...record, disclosures: { ...record.disclosures!, independence: 999 } };
    const result = verifyReport(tamperedRecord, [matrix], { resolveVerdict, registry, resolveBenchmarkDigest });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.check).toBe("disclosures-faithfulness");
  });

  test("a benchmark-comparability violation (two subjects, distinct Benchmark digests, non-version-robust) fails", async () => {
    const matrixA = buildMatrix([cell("t1", "armA", "judged", [digest("t1")])], { digest: { sha256: "b".repeat(64) } });
    const matrixB = buildMatrix([cell("t1", "armA", "judged", [digest("t1")])], { digest: { sha256: "c".repeat(64) } });
    const { record } = await produceReport(
      {
        subjects: [matrixA, matrixB],
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    );
    const runToBenchmark = new Map([["b".repeat(64), "benchmark-A"], ["c".repeat(64), "benchmark-B"]]);
    const result = verifyReport(record, [matrixA, matrixB], {
      resolveVerdict,
      registry,
      resolveBenchmarkDigest: (runDigest) => runToBenchmark.get(runDigest),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.check).toBe("benchmark-comparability");
  });

  test("a Report cannot verify against matrices other than its sealed subjects", async () => {
    const { record } = await produceReport(
      {
        subjects: [matrix],
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    );
    const otherMatrix = buildMatrix([cell("other", "armA", "judged", [digest("t1")])]);
    const result = verifyReport(record, [otherMatrix], { resolveVerdict, registry, resolveBenchmarkDigest });
    expect(result).toEqual({
      ok: false,
      check: "report-recompute",
      detail: "provided subjects do not match the sealed Report subjects",
    });
  });

  test("produceReport rejects a caller-supplied disclosures block that hides matrix facts", async () => {
    await expect(produceReport(
      {
        subjects: [matrix],
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        disclosures: {
          perSubject: deriveDisclosures([matrix]).perSubject.map((entry) => ({ ...entry, independence: 1 })),
        },
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    )).rejects.toThrow("disclosures must be derived faithfully from the subject matrices");
  });

  test("produceReport throws for an unregistered method", async () => {
    await expect(produceReport(
      {
        subjects: [matrix],
        method: { id: "jinn.benchmarking.method/does-not-exist", version: "1", parameters: {} },
        verdictRule: "unanimous",
        resolveVerdict,
        registry,
        author: "urn:uuid:11111111-1111-5111-8111-111111111111",
      },
      fakeSigner,
    )).rejects.toThrow(/not registered/);
  });
});
