import { createHash } from "node:crypto";
import {
  BENCHMARKING_PROTOCOL,
  cellKey,
  compareCodeUnitStrings,
  parseMatrix,
  sealMatrix,
  sealRun,
  type MatrixRecord,
  type Outcome,
} from "@jinn-network/benchmarking-records";
import { sealTask } from "@jinn-network/task-execution-protocol";
import {
  canonicalJsonBytes,
  recordDigest,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { createMethodRegistry } from "./registry.js";
import { MethodInputError } from "./resolved-inputs.js";
import type { MethodComputeInput } from "./method.js";

const INSTRUMENT_KEY = "network.jinn.binary-judgment.instrument";
const ITEM_COMMITMENT_KEY = "network.jinn.binary-judgment.item-sha256";
const INSTRUMENT_PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-instrument/v1";
const ANALYSIS_PROTOCOL = "https://spec.jinn.network/binary-judgment/analysis-context/v1";
const SPEC_PROTOCOL = "https://spec.jinn.network/profiles/evaluation-spec/v1";
const PARSER_ID = "network.jinn.parser.binary-judgment-evaluation";
const PARSER_VERSION = "1.0.0";
const RESPONSE_PARSER_DIGEST = `sha256:${"9".repeat(64)}` as const;
const EVALUATION_METHOD_DIGEST = `sha256:${"8".repeat(64)}` as const;
const RUN_OWNER = "urn:uuid:77777777-7777-5777-8777-777777777777";

const MEASUREMENTS = [
  ["judgeDecision", "string"],
  ["truthLabel", "string"],
  ["agreement", "boolean"],
  ["parseValid", "boolean"],
  ["candidateClass", "string"],
  ["stratum", "string"],
  ["labelResolutionSha256", "string"],
  ["instrumentSha256", "string"],
] as const;

const PARAMETERS = {
  verdictRule: "sole",
  k: 3,
  reduction: "strict-majority",
  measurementProfile: "binary-instrument@1",
  candidateClasses: ["contradiction", "factual"],
  strata: ["core", "stress"],
  parserInvalidPolicy: "reject",
  truthAdmission: "two-human-unanimous",
  intervalAlpha: "0.05",
} as const;

interface ItemFixture {
  readonly taskDigest: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: "factual" | "contradiction";
  readonly stratum: "core" | "stress";
  readonly labelResolutionSha256: `sha256:${string}`;
  readonly analysisContextSha256: `sha256:${string}`;
  readonly evaluationSpecSha256: `sha256:${string}`;
}

interface Tamper {
  readonly cellKey: string;
  readonly kind:
    | "instrument"
    | "truth"
    | "spec"
    | "invalid-accept"
    | "duplicate-measurement"
    | "label-resolution"
    | "task-item";
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceDigest(value: unknown): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(value));
}

function exactUuid(value: string): string {
  return `urn:uuid:${sha(value).slice(0, 8)}-0000-5000-8000-000000000000`;
}

function agreement(decision: "ACCEPT" | "REJECT", truth: "CORRECT" | "WRONG"): boolean {
  return (decision === "ACCEPT" && truth === "CORRECT")
    || (decision === "REJECT" && truth === "WRONG");
}

function resultEvaluation(input: {
  readonly task: ItemFixture;
  readonly instrumentSha256: `sha256:${string}`;
  readonly decision: "ACCEPT" | "REJECT";
  readonly parseValid: boolean;
  readonly cellKey: string;
  readonly tamper?: Tamper;
}): Uint8Array {
  let truthLabel: "CORRECT" | "WRONG" = input.task.truthLabel;
  let instrumentSha256: string = input.instrumentSha256;
  let evaluationSpecSha256 = input.task.evaluationSpecSha256.slice("sha256:".length);
  let decision = input.decision;
  if (input.tamper?.cellKey === input.cellKey) {
    if (input.tamper.kind === "truth") truthLabel = truthLabel === "CORRECT" ? "WRONG" : "CORRECT";
    if (input.tamper.kind === "instrument") instrumentSha256 = `sha256:${"f".repeat(64)}`;
    if (input.tamper.kind === "spec") evaluationSpecSha256 = "f".repeat(64);
    if (input.tamper.kind === "invalid-accept") decision = "ACCEPT";
  }
  const agrees = agreement(decision, truthLabel);
  const measurements: { name: string; value: string | boolean }[] = [
    { name: "judgeDecision", value: decision },
    { name: "truthLabel", value: truthLabel },
    { name: "agreement", value: agrees },
    { name: "parseValid", value: input.parseValid },
    { name: "candidateClass", value: input.task.candidateClass },
    { name: "stratum", value: input.task.stratum },
    { name: "labelResolutionSha256", value: input.task.labelResolutionSha256 },
    { name: "instrumentSha256", value: instrumentSha256 },
  ];
  if (input.tamper?.cellKey === input.cellKey && input.tamper.kind === "duplicate-measurement") {
    measurements[7] = { ...measurements[0]! };
  }
  const responseSha256 = sha(`response:${input.cellKey}`);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "task.json", digest: { sha256: input.task.taskDigest } },
      { name: "judge-response", digest: { sha256: responseSha256 } },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-08-15T00:00:00Z",
      evaluator: { id: "did:key:zBinaryInstrumentFixture" },
      evaluationMethod: {
        name: PARSER_ID,
        digest: { sha256: EVALUATION_METHOD_DIGEST.slice("sha256:".length) },
      },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: evaluationSpecSha256 },
      },
      taskSubject: "task.json",
      resultSubjects: ["judge-response"],
      verdict: agrees ? "pass" : "fail",
      measurements,
    },
  };
  return sealDsseEnvelope({
    payloadBytes: canonicalJsonBytes(statement),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "did:key:zBinaryInstrumentFixture", signature: Uint8Array.of(1) }],
  });
}

function makeFixture(options: {
  readonly expireCell?: string;
  readonly tamper?: Tamper;
  readonly truthAdmission?: "two-human-unanimous" | "operator-only";
  readonly labelTruthAdmission?: "two-human-unanimous" | "operator-only";
} = {}): {
  readonly input: MethodComputeInput;
  readonly matrix: MatrixRecord;
  readonly wrongTaskDigest: string;
  readonly parserInvalidCellKey: string;
} {
  const truthAdmission = options.truthAdmission ?? "two-human-unanimous";
  const labelTruthAdmission = options.labelTruthAdmission ?? truthAdmission;
  const parameters = { ...PARAMETERS, truthAdmission };
  const records = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array): `sha256:${string}` => {
    const digest = recordDigest(bytes) as `sha256:${string}`;
    records.set(digest, bytes);
    return digest;
  };
  const instruments = new Map<string, `sha256:${string}`>();
  for (const armId of ["armA", "armB"]) {
    instruments.set(armId, put(canonicalJsonBytes({
      protocol: INSTRUMENT_PROTOCOL,
      instrumentId: armId,
      response: {
        parser: {
          id: "network.jinn.parser.binary-accept-reject",
          version: "1.0.0",
          digest: RESPONSE_PARSER_DIGEST,
        },
        invalidOutputDecision: "REJECT",
      },
    })));
  }

  const items: ItemFixture[] = [];
  for (const seed of [
    { id: "correct", truthLabel: "CORRECT", candidateClass: "factual", stratum: "core" },
    { id: "wrong", truthLabel: "WRONG", candidateClass: "contradiction", stratum: "stress" },
  ] as const) {
    const itemSha256 = resourceDigest({ itemId: seed.id });
    const labelTruth = options.tamper?.kind === "label-resolution" && seed.id === "correct"
      ? "WRONG"
      : seed.truthLabel;
    const labelResolutionSha256 = put(canonicalJsonBytes({
      protocol: "https://spec.jinn.network/binary-judgment/label-resolution/v1",
      itemSha256,
      itemId: exactUuid(seed.id),
      humanReviewEvaluationSpecSha256: `sha256:${"1".repeat(64)}`,
      truthLabel: labelTruth,
      candidateClass: seed.candidateClass,
      stratum: seed.stratum,
      resolvedAt: "2026-08-14T23:00:00Z",
      truthAdmission: labelTruthAdmission,
      ...(labelTruthAdmission === "two-human-unanimous" ? {
        reviewVerdictSha256s: [`sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`],
        reviewerRosterSha256: `sha256:${"4".repeat(64)}`,
        visibilityReceiptSha256s: [`sha256:${"5".repeat(64)}`, `sha256:${"6".repeat(64)}`],
        revealReceiptSha256: `sha256:${"7".repeat(64)}`,
      } : {
        operatorAssertionSha256: `sha256:${"2".repeat(64)}`,
      }),
    }));
    const analysisContextSha256 = put(canonicalJsonBytes({
      protocol: ANALYSIS_PROTOCOL,
      itemSha256,
      itemId: exactUuid(seed.id),
      labelResolutionSha256,
      truthLabel: seed.truthLabel,
      candidateClass: seed.candidateClass,
      stratum: seed.stratum,
    }));
    const evaluationSpecSha256 = put(canonicalJsonBytes({
      protocol: SPEC_PROTOCOL,
      semanticsVersion: "4",
      family: "deterministic-process",
      grader: {
        name: PARSER_ID,
        digest: { sha256: EVALUATION_METHOD_DIGEST.slice("sha256:".length) },
        accessClass: "public",
      },
      familyBlock: {
        parser: { id: PARSER_ID, version: PARSER_VERSION, digest: EVALUATION_METHOD_DIGEST },
        testMaterial: [{
          name: "analysis-context.json",
          digest: { sha256: analysisContextSha256.slice("sha256:".length) },
          accessClass: "private",
        }],
      },
      measurements: MEASUREMENTS.map(([name, type]) => ({ name, type, required: true })),
      verdictRule: { threshold: { measurement: "agreement", op: "eq", value: true } },
      unscorable: [],
      evidenceConventions: { requiredRefs: [] },
    }));
    const taskBytes = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: { digest: { sha256: "7".repeat(64) } },
      instructions: "Return one binary decision.",
      payload: { itemId: exactUuid(seed.id) },
      outputs: [{ name: "judge-response", mediaType: "text/plain; charset=utf-8", required: true }],
      evaluation: { digest: { sha256: evaluationSpecSha256.slice("sha256:".length) } },
      [ITEM_COMMITMENT_KEY]: options.tamper?.kind === "task-item" && seed.id === "correct"
        ? `sha256:${"f".repeat(64)}`
        : itemSha256,
    });
    const taskWire = put(taskBytes);
    items.push({
      ...seed,
      taskDigest: taskWire.slice("sha256:".length),
      labelResolutionSha256,
      analysisContextSha256,
      evaluationSpecSha256,
    });
  }

  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "6".repeat(64) } },
    owner: RUN_OWNER,
    arms: [...instruments.entries()].map(([armId, instrument]) => ({
      armId,
      pinning: { [INSTRUMENT_KEY]: instrument },
    })),
    replicates: 3,
    policy: {
      completenessFloor: "1",
      cellWindow: 60,
      replacement: { allowed: true, maxPerCell: 1 },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      submissionBaseline: {},
    },
    analysisPlan: [{
      method: "jinn.benchmarking.method/binary-instrument",
      version: "1",
      parameters,
    }],
    closeAt: "2026-08-15T01:00:00Z",
  });
  records.set(run.digest, run.bytes);

  const decisions = new Map<string, readonly ["ACCEPT" | "REJECT", boolean][]>();
  decisions.set(`${items[0]!.taskDigest}/armA`, [["ACCEPT", true], ["ACCEPT", true], ["ACCEPT", true]]);
  decisions.set(`${items[1]!.taskDigest}/armA`, [["ACCEPT", true], ["ACCEPT", true], ["REJECT", false]]);
  decisions.set(`${items[0]!.taskDigest}/armB`, [["REJECT", true], ["REJECT", true], ["ACCEPT", true]]);
  decisions.set(`${items[1]!.taskDigest}/armB`, [["REJECT", true], ["REJECT", true], ["REJECT", false]]);

  const cells = items.flatMap((item) => [...instruments.keys()].flatMap((armId) =>
    Array.from({ length: 3 }, (_, offset) => {
      const replicate = offset + 1;
      const key = cellKey(item.taskDigest, armId, replicate);
      const expired = key === options.expireCell;
      const [decision, parseValid] = decisions.get(`${item.taskDigest}/${armId}`)![offset]!;
      const verdictBytes = expired ? undefined : resultEvaluation({
        task: item,
        instrumentSha256: instruments.get(armId)!,
        decision,
        parseValid,
        cellKey: key,
        tamper: options.tamper,
      });
      const verdictDigest = verdictBytes === undefined ? undefined : put(verdictBytes);
      return {
        cellKey: key,
        taskDigest: item.taskDigest,
        armId,
        replicate,
        dispatches: 1,
        accounted: 1,
        submission: `sha256:${sha(`submission:${key}`)}` as const,
        ...(expired ? {} : {
          attempt: exactUuid(`attempt:${key}`),
          delivery: `sha256:${sha(`delivery:${key}`)}` as const,
        }),
        verdicts: verdictDigest === undefined ? [] : [verdictDigest],
        validVerdicts: verdictDigest === undefined ? [] : [verdictDigest],
        outcome: (expired ? "expired" : "judged") as Outcome,
        verification: {
          harness: "match" as const,
          model: "match" as const,
          loadout: "match" as const,
          isolation: "match" as const,
          checksFailed: [],
        },
        integrityTier: "re-derivable" as const,
      };
    }),
  )).sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey));
  const perArm = Object.fromEntries([...instruments.keys()].map((armId) => {
    const armCells = cells.filter((cell) => cell.armId === armId);
    const count = (outcome: Outcome): number => armCells.filter((cell) => cell.outcome === outcome).length;
    return [armId, {
      expected: armCells.length,
      judged: count("judged"),
      unjudged: count("unjudged"),
      unscorable: count("unscorable"),
      expired: count("expired"),
      invalidated: count("invalidated"),
      excluded: count("excluded"),
      replacements: 0,
    }];
  }));
  const judged = cells.filter((cell) => cell.outcome === "judged").length;
  const matrixSealed = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-15T01:00:00Z" },
    cells,
    exclusions: [],
    attrition: { perArm, asymmetryFlags: options.expireCell === undefined ? [] : ["arm-asymmetry"] },
    completeness: {
      expected: cells.length,
      judged,
      floor: "1",
      runOutcome: judged === cells.length ? "complete" : "partial",
    },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });
  const matrix = parseMatrix(matrixSealed.bytes);
  const resolve = (digest: string): Uint8Array | undefined => records.get(digest);
  return {
    matrix,
    wrongTaskDigest: items[1]!.taskDigest,
    parserInvalidCellKey: cellKey(items[1]!.taskDigest, "armA", 3),
    input: {
      subjects: [{
        subjectSha256: matrixSealed.digest.slice("sha256:".length),
        matrix,
      }],
      parameters,
      verdictRule: "sole",
      resolveVerdictBytes: resolve,
      resolveRunBytes: resolve,
      resolveTaskBytes: resolve,
      resolveRecordBytes: resolve,
    },
  };
}

describe("binary-instrument@1 registration and parameters", () => {
  test("registers the exact method metadata and closed analysis parameters", () => {
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(method).toMatchObject({
      computeAvailability: "available",
      deterministic: true,
      referenceSet: "v1-reference",
      versionRobust: false,
    });
    expect(method.validateParameters(PARAMETERS)).toEqual({ ok: true });
    expect(method.validateParameters({ ...PARAMETERS, k: 2 }).ok).toBe(false);
    expect(method.validateParameters({
      ...PARAMETERS,
      candidateClasses: ["factual", "contradiction"],
    }).ok).toBe(false);
    expect(method.validateParameters({ ...PARAMETERS, instrument: "armA" }).ok).toBe(false);
  });
});

describe("binary-instrument@1 qualification oracle", () => {
  test("derives item-majority confusion, Wilson rates, parser failures, instability, and slices", () => {
    const fixture = makeFixture();
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(Object.keys(result.arms)).toEqual(["armA", "armB"]);
    expect(result.arms.armA).toMatchObject({
      item: { expected: 2, complete: 2, excluded: 0, unstable: 1 },
      call: { expected: 6, evaluated: 6, parseInvalid: 1 },
      confusion: {
        correctAccepted: 1,
        correctRejected: 0,
        wrongAccepted: 1,
        wrongRejected: 0,
      },
      agreement: { numerator: 1, denominator: 2, estimate: "0.5000" },
      falseAccept: { numerator: 1, denominator: 1, estimate: "1.0000" },
      falseReject: { numerator: 0, denominator: 1, estimate: "0.0000" },
      instability: { numerator: 1, denominator: 2, estimate: "0.5000" },
      parserInvalid: { numerator: 1, denominator: 6, estimate: "0.1667" },
    });
    expect(result.arms.armA.agreement.wilsonInterval).toEqual({ low: "0.0945", high: "0.9055" });
    expect(result.arms.armB.confusion).toEqual({
      correctAccepted: 0,
      correctRejected: 1,
      wrongAccepted: 0,
      wrongRejected: 1,
    });
    expect(result.arms.armA.byCandidateClass.factual.falseAccept).toEqual({
      numerator: 0,
      denominator: 0,
      estimate: null,
      wilsonInterval: null,
      withheldReason: "zero-denominator",
    });
    expect(result.arms.armA.byStratum.stress.falseAccept.estimate).toBe("1.0000");
    expect(result.itemDecisions).toHaveLength(4);
    expect(result.itemDecisions.filter((item: any) => item.unstable)).toHaveLength(2);
    expect(result.excluded).toEqual({ count: 0, items: [] });
    expect(result).not.toHaveProperty("ranking");
    expect(result).not.toHaveProperty("selectedInstrument");
  });

  test("keeps transport attrition as an exact item-arm exclusion and withholds zero denominators", () => {
    const preview = makeFixture();
    const expired = cellKey(preview.wrongTaskDigest, "armB", 2);
    const fixture = makeFixture({ expireCell: expired });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(result.arms.armB).toMatchObject({
      item: { expected: 2, complete: 1, excluded: 1, unstable: 1 },
      call: { expected: 6, evaluated: 5, parseInvalid: 1 },
      falseAccept: {
        numerator: 0,
        denominator: 0,
        estimate: null,
        wilsonInterval: null,
        withheldReason: "zero-denominator",
      },
    });
    expect(result.excluded.count).toBe(1);
    expect(result.excluded.items[0]).toMatchObject({
      armId: "armB",
      reasons: [{ reason: "cell-not-judged", cellKeys: [expired] }],
    });
  });

  test("accepts the exact operator-only label-resolution variant when registered", () => {
    const fixture = makeFixture({ truthAdmission: "operator-only" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const result = method.compute!(fixture.input).perSubject[0]!.results as any;

    expect(result.configuration.truthAdmission).toBe("operator-only");
    expect(result.itemDecisions).toHaveLength(4);
  });
});

describe("binary-instrument@1 tamper refusals", () => {
  test.each([
    "instrument",
    "truth",
    "spec",
    "invalid-accept",
    "duplicate-measurement",
    "label-resolution",
    "task-item",
  ] as const)("rejects %s drift before aggregation", (kind) => {
    const preview = makeFixture();
    const target = kind === "invalid-accept"
      ? preview.parserInvalidCellKey
      : preview.matrix.cells[0]!.cellKey;
    const fixture = makeFixture({ tamper: { cellKey: target, kind } });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(fixture.input)).toThrow(MethodInputError);
  });

  test("requires the generic exact-record resolver without affecting legacy method inputs", () => {
    const fixture = makeFixture();
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    const { resolveRecordBytes: _resolveRecordBytes, ...withoutRecordResolver } = fixture.input;
    expect(() => method.compute!(withoutRecordResolver)).toThrow(expect.objectContaining({
      code: "binary-record-unavailable",
    }));
  });

  test("rejects an exact label-resolution whose truth admission drifts from method parameters", () => {
    const fixture = makeFixture({ labelTruthAdmission: "operator-only" });
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;

    expect(() => method.compute!(fixture.input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });

  test("rejects reuse of one signed Result Evaluation across scientific replicate cells", () => {
    const fixture = makeFixture();
    const source = fixture.matrix.cells[0]!;
    const target = fixture.matrix.cells.find((cell) =>
      cell.taskDigest === source.taskDigest
      && cell.armId === source.armId
      && cell.cellKey !== source.cellKey)!;
    const duplicateDigest = source.validVerdicts[0]!;
    const resealed = sealMatrix({
      ...fixture.matrix,
      cells: fixture.matrix.cells.map((cell) => cell.cellKey === target.cellKey
        ? { ...cell, verdicts: [duplicateDigest], validVerdicts: [duplicateDigest] }
        : cell),
    });
    const matrix = parseMatrix(resealed.bytes);
    const input: MethodComputeInput = {
      ...fixture.input,
      subjects: [{
        subjectSha256: resealed.digest.slice("sha256:".length),
        matrix,
      }],
    };
    const method = createMethodRegistry().get("jinn.benchmarking.method/binary-instrument", "1")!;
    expect(() => method.compute!(input)).toThrow(expect.objectContaining({
      code: "binary-binding-mismatch",
    }));
  });
});
