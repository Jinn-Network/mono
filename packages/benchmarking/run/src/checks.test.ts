import { submissionExtensionBlock } from "@jinn-network/benchmarking-records";
import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import {
  assertCellCorrespondence,
  cellCorrespondenceHolds,
  CellCorrespondenceError,
  checkEvaluatorIndependence,
  checkPinningObservation,
  checkPreregistrationAnchoredOrder,
  checkPreregistrationPrecedesDispatchLegA,
  checkPreregistrationPrecedesDispatchLegC,
  checkVerdictRuleConsistency,
  checkVerdictSpecMatch,
} from "./checks.js";

const MINIMAL_SPEC = {
  protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1",
  family: "deterministic-process",
  semanticsVersion: "4",
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
  familyBlock: {
    image: { uri: "https://example.org/img", digest: { sha256: "a".repeat(64) } },
    platform: "linux/amd64",
    timeout: 60,
    workspace: {},
    transitions: { failToPass: [], passToPass: [] },
    testMaterial: [],
    parser: { id: "jinn.parser.x", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` },
  },
  grader: {
    name: "jinn.parser.x",
    digest: { sha256: "b".repeat(64) },
    accessClass: "public",
  },
} as EvaluationSpec;

describe("named checks", () => {
  test("cell-correspondence accepts equal maps and rejects tightened maps", () => {
    const expected = {
      model: { id: "model-a" },
      harness: { id: "kit", version: "1" },
      isolationPolicy: "fixture",
    };
    expect(cellCorrespondenceHolds(expected, { ...expected })).toBe(true);
    expect(cellCorrespondenceHolds(expected, { model: { id: "model-a" } })).toBe(false);
    expect(() => assertCellCorrespondence(expected, { model: { id: "model-a" } })).toThrow(
      CellCorrespondenceError,
    );
  });

  test("preregistration-precedes-dispatch leg (a) positive and hostile", () => {
    const runDigest = `sha256:${"1".repeat(64)}` as const;
    const cellKey = `${"c".repeat(64)}/armA/1`;
    const block = submissionExtensionBlock(runDigest, cellKey, "armA");
    expect(checkPreregistrationPrecedesDispatchLegA({
      preregisteredRunDigest: runDigest,
      cellKey,
      armId: "armA",
      extension: block,
    }).ok).toBe(true);
    expect(checkPreregistrationPrecedesDispatchLegA({
      preregisteredRunDigest: runDigest,
      cellKey,
      armId: "armA",
      extension: submissionExtensionBlock(`sha256:${"2".repeat(64)}`, cellKey, "armA"),
    }).ok).toBe(false);
  });

  test("preregistration-precedes-dispatch leg (c) and anchored order", () => {
    expect(checkPreregistrationPrecedesDispatchLegC({ runAppendedBeforeCells: true })).toEqual({
      ok: true,
      decisionGrade: false,
    });
    expect(checkPreregistrationPrecedesDispatchLegC({ runAppendedBeforeCells: false }).ok).toBe(false);
    expect(checkPreregistrationAnchoredOrder({
      runAnnouncedAt: "2026-08-01T00:00:00Z",
      earliestCellPostAt: "2026-08-01T00:01:00Z",
    }).ok).toBe(true);
    expect(checkPreregistrationAnchoredOrder({
      runAnnouncedAt: "2026-08-01T00:02:00Z",
      earliestCellPostAt: "2026-08-01T00:01:00Z",
    }).ok).toBe(false);
  });

  test("pinning-observation match vs mismatch", () => {
    expect(checkPinningObservation({
      harness: "match",
      model: "match",
      loadout: "match",
      isolation: "match",
    }).ok).toBe(true);
    expect(checkPinningObservation({
      harness: "match",
      model: "mismatch",
      loadout: "match",
      isolation: "match",
    })).toMatchObject({ ok: false, check: "pinning-observation" });
  });

  test("verdict-spec-match exact digest equality", () => {
    const digest = `sha256:${"e".repeat(64)}`;
    expect(checkVerdictSpecMatch({
      verdictEvaluationSpecification: digest,
      taskEvaluationSpecDigest: digest,
    }).ok).toBe(true);
    expect(checkVerdictSpecMatch({
      verdictEvaluationSpecification: `sha256:${"f".repeat(64)}`,
      taskEvaluationSpecDigest: digest,
    })).toMatchObject({ ok: false, check: "verdict-spec-match" });
  });

  test("verdict-consistency hostile mismatch and positive pass", () => {
    expect(checkVerdictRuleConsistency({
      spec: MINIMAL_SPEC,
      delivered: { verdict: "pass" },
      measurements: { passed: true },
    }).ok).toBe(true);
    expect(checkVerdictRuleConsistency({
      spec: MINIMAL_SPEC,
      delivered: { verdict: "pass" },
      measurements: { passed: false },
    })).toMatchObject({ ok: false, check: "verdict-consistency" });
    expect(checkVerdictRuleConsistency({
      spec: undefined,
      delivered: { verdict: "pass" },
      measurements: { passed: true },
    })).toMatchObject({ ok: false, check: "verdict-consistency" });
  });

  test("evaluator-independence fail-closed and distinct", () => {
    expect(checkEvaluatorIndependence({
      solver: "agent://a",
      evaluator: "agent://b",
    }).ok).toBe(true);
    expect(checkEvaluatorIndependence({
      solver: "agent://a",
      evaluator: "agent://a",
    }).ok).toBe(false);
    expect(checkEvaluatorIndependence({
      solver: "unresolved",
      evaluator: "agent://b",
    }).ok).toBe(false);
  });
});
