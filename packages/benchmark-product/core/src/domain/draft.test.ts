import { describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import {
  ASSURANCE_PRESETS,
  DRAFT_SPEC_DEFAULTS,
  DraftDocumentSchema,
  DraftSpecSchema,
  draftIdFromName,
  parseDraftDocument,
  parseDraftSpec,
  resolveAssurance,
  type Assurance,
} from "./draft.js";

const VALID_SPEC = {
  name: "Prediction Baseline vs Claude Code",
  description: "Compares two arms on the imported task set.",
  taskSet: {
    kind: "benchmark",
    benchmarkSha256: "a".repeat(64),
  },
  arms: [
    { armId: "prediction-v1-baseline", pinning: { harness: "prediction-v1-baseline", isolationPolicy: "unrestricted" } },
    { armId: "claude-code", pinning: { harness: "claude-code", isolationPolicy: "unrestricted" }, notes: "control arm" },
  ],
  replicates: 3,
  assurance: { preset: "separate-evaluator" },
  policy: {
    completenessFloor: "0.9",
    cellWindowMs: 3_600_000,
    replacement: { allowed: true, maxPerCell: 2 },
    closeAfterMs: 86_400_000,
  },
  budget: {
    perCell: { solve: "0.5", evaluate: "0.1" },
    hardCap: "100",
    unit: "OLAS",
  },
  venue: "self-run",
};

describe("DraftSpecSchema — a full valid spec", () => {
  test("parses without issues", () => {
    const parsed = parseDraftSpec(VALID_SPEC);
    expect(parsed.name).toBe(VALID_SPEC.name);
    expect(parsed.arms).toHaveLength(2);
    expect(parsed.arms[0]).toEqual({
      armId: "prediction-v1-baseline",
      pinning: { harness: "prediction-v1-baseline", isolationPolicy: "unrestricted" },
    });
    expect(parsed.arms[1]?.notes).toBe("control arm");
    expect(parsed.venue).toBe("self-run");
  });

  test("accepts an opaque runtime selection binding without interpreting its manifest", () => {
    const parsed = parseDraftSpec({
      ...VALID_SPEC,
      evaluationRuntime: {
        adapterId: "inspect",
        selectionManifestSha256: "b".repeat(64),
      },
    });

    expect(parsed.evaluationRuntime).toEqual({
      adapterId: "inspect",
      selectionManifestSha256: "b".repeat(64),
    });
  });

  test("rejects malformed runtime adapter ids and manifest digests", () => {
    expect(() => parseDraftSpec({
      ...VALID_SPEC,
      evaluationRuntime: { adapterId: "Inspect Runtime", selectionManifestSha256: "not-a-digest" },
    })).toThrow(BenchmarkProductError);
  });
});

describe("DraftSpecSchema — taskSet", () => {
  test("a benchmark taskSet with a well-formed 64-hex digest parses", () => {
    const spec = { ...VALID_SPEC, taskSet: { kind: "benchmark", benchmarkSha256: "0".repeat(64) } };
    expect(() => parseDraftSpec(spec)).not.toThrow();
  });

  test("a benchmark taskSet with a bad digest refuses", () => {
    const spec = { ...VALID_SPEC, taskSet: { kind: "benchmark", benchmarkSha256: "not-a-digest" } };
    expect(() => parseDraftSpec(spec)).toThrow(BenchmarkProductError);
    try {
      parseDraftSpec(spec);
      throw new Error("expected parseDraftSpec to throw");
    } catch (cause) {
      const error = cause as BenchmarkProductError;
      expect(error.code).toBe("validation");
      expect(error.issues.some((issue) => issue.path.startsWith("taskSet"))).toBe(true);
    }
  });

  test("a pendingSample taskSet parses with no digest required", () => {
    const spec = { ...VALID_SPEC, taskSet: { kind: "pendingSample" } };
    expect(() => parseDraftSpec(spec)).not.toThrow();
  });
});

describe("parseDraftSpec — invalid specs refuse with structured issues", () => {
  test("throws BenchmarkProductError with code validation", () => {
    try {
      parseDraftSpec({ ...VALID_SPEC, name: "" });
      throw new Error("expected parseDraftSpec to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      const error = cause as BenchmarkProductError;
      expect(error.code).toBe("validation");
      expect(error.issues.length).toBeGreaterThan(0);
    }
  });

  test("issues carry dotted paths for nested fields", () => {
    const spec = { ...VALID_SPEC, arms: [{ armId: "bad id with spaces", pinning: {} }] };
    try {
      parseDraftSpec(spec);
      throw new Error("expected parseDraftSpec to throw");
    } catch (cause) {
      const error = cause as BenchmarkProductError;
      expect(error.issues.some((issue) => issue.path === "arms.0.armId")).toBe(true);
    }
  });

  test("a missing required field is reported at the root-relative dotted path", () => {
    const { name: _name, ...withoutName } = VALID_SPEC;
    try {
      parseDraftSpec(withoutName);
      throw new Error("expected parseDraftSpec to throw");
    } catch (cause) {
      const error = cause as BenchmarkProductError;
      expect(error.issues.some((issue) => issue.path === "name")).toBe(true);
    }
  });
});

describe("completenessFloor — decimal in (0, 1]", () => {
  test("\"0\" refuses", () => {
    const spec = { ...VALID_SPEC, policy: { ...VALID_SPEC.policy, completenessFloor: "0" } };
    expect(() => parseDraftSpec(spec)).toThrow(BenchmarkProductError);
  });

  test("\"1.5\" refuses", () => {
    const spec = { ...VALID_SPEC, policy: { ...VALID_SPEC.policy, completenessFloor: "1.5" } };
    expect(() => parseDraftSpec(spec)).toThrow(BenchmarkProductError);
  });

  test("\"0.9\" passes", () => {
    const spec = { ...VALID_SPEC, policy: { ...VALID_SPEC.policy, completenessFloor: "0.9" } };
    expect(() => parseDraftSpec(spec)).not.toThrow();
  });

  test("\"1\" passes", () => {
    const spec = { ...VALID_SPEC, policy: { ...VALID_SPEC.policy, completenessFloor: "1" } };
    expect(() => parseDraftSpec(spec)).not.toThrow();
  });
});

describe("resolveAssurance", () => {
  test("direct-check resolves exactly", () => {
    expect(resolveAssurance({ preset: "direct-check" })).toEqual({
      independence: "disclosed",
      minVerdicts: 1,
      distinctEvaluator: false,
      verdictRule: "sole",
    });
  });

  test("separate-evaluator resolves exactly", () => {
    expect(resolveAssurance({ preset: "separate-evaluator" })).toEqual({
      independence: "gating",
      minVerdicts: 1,
      distinctEvaluator: true,
      verdictRule: "sole",
    });
  });

  test("evaluator-panel resolves exactly", () => {
    expect(resolveAssurance({ preset: "evaluator-panel" })).toEqual({
      independence: "gating",
      minVerdicts: 2,
      distinctEvaluator: true,
      verdictRule: "majority",
    });
  });

  test("strict-agreement resolves exactly", () => {
    expect(resolveAssurance({ preset: "strict-agreement" })).toEqual({
      independence: "gating",
      minVerdicts: 2,
      distinctEvaluator: true,
      verdictRule: "unanimous",
    });
  });

  test("every preset name is covered by the ASSURANCE_PRESETS constant", () => {
    expect(ASSURANCE_PRESETS).toEqual(["direct-check", "separate-evaluator", "evaluator-panel", "strict-agreement"]);
  });

  test("overrides apply field-wise on top of the preset base: evaluator-panel raised to minVerdicts 3", () => {
    const assurance: Assurance = { preset: "evaluator-panel", overrides: { minVerdicts: 3 } };
    expect(resolveAssurance(assurance)).toEqual({
      independence: "gating",
      minVerdicts: 3,
      distinctEvaluator: true,
      verdictRule: "majority",
    });
  });

  test("overrides apply field-wise on top of the preset base: direct-check flipped to independence gating", () => {
    const assurance: Assurance = { preset: "direct-check", overrides: { independence: "gating" } };
    expect(resolveAssurance(assurance)).toEqual({
      independence: "gating",
      minVerdicts: 1,
      distinctEvaluator: false,
      verdictRule: "sole",
    });
  });
});

describe("DRAFT_SPEC_DEFAULTS", () => {
  test("defaults plus a name parse via DraftSpecSchema", () => {
    const spec = { ...DRAFT_SPEC_DEFAULTS, name: "Default Draft" };
    const result = DraftSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });
});

describe("draftIdFromName", () => {
  test('"My Benchmark  v2!" becomes "my-benchmark-v2"', () => {
    expect(draftIdFromName("My Benchmark  v2!")).toBe("my-benchmark-v2");
  });

  test("empty input refuses", () => {
    expect(() => draftIdFromName("")).toThrow(BenchmarkProductError);
  });

  test("symbol-only input refuses", () => {
    expect(() => draftIdFromName("!!! ??? ***")).toThrow(BenchmarkProductError);
    try {
      draftIdFromName("!!!");
      throw new Error("expected draftIdFromName to throw");
    } catch (cause) {
      const error = cause as BenchmarkProductError;
      expect(error.code).toBe("validation");
    }
  });

  test("a 100-character input is capped to at most 64 characters", () => {
    const longName = "a".repeat(100);
    const id = draftIdFromName(longName);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toBe("a".repeat(64));
  });
});

describe("DraftDocumentSchema", () => {
  test("round-trips a document in state draft", () => {
    const document = {
      draftId: draftIdFromName(VALID_SPEC.name),
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      state: "draft",
      spec: VALID_SPEC,
    };
    const parsed = parseDraftDocument(document);
    expect(parsed.state).toBe("draft");
    expect(parsed.draftId).toBe(document.draftId);
    expect(parsed.spec.name).toBe(VALID_SPEC.name);
  });

  test("refuses an unknown lifecycle state", () => {
    const document = {
      draftId: "some-draft",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      state: "archived",
      spec: VALID_SPEC,
    };
    expect(() => parseDraftDocument(document)).toThrow(BenchmarkProductError);
  });
});
