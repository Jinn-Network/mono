// SPDX-License-Identifier: Apache-2.0

import {
  EvaluationOperationalError,
  type ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { describe, expect, test } from "vitest";
import { SWE_REBENCH_FIXTURES } from "./fixtures.js";
import { SWE_REBENCH_PARSER } from "../parser-identity.js";
import {
  contextGraderReportSource,
  createSweRebenchEvaluatorAdapter,
  type GraderReportSource,
  type RawGraderReport,
} from "./adapter.js";

const encoder = new TextEncoder();

const ATTEMPT: AttemptIdentity = {
  attemptUri: "urn:uuid:22222222-2222-4222-8222-222222222222" as AttemptIdentity["attemptUri"],
  nonce: "evaluation-nonce",
  attemptNumber: 1,
};

function material(name: string, text: string): ExactEvaluationMaterial {
  return {
    descriptor: { name, digest: { sha256: "1".repeat(64) } },
    bytes: encoder.encode(text),
  };
}

function specification(transitions: {
  failToPass: readonly string[];
  passToPass: readonly string[];
}): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: SWE_REBENCH_PARSER.id,
      digest: { sha256: SWE_REBENCH_PARSER.digest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "grader-image", digest: { sha256: "2".repeat(64) } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser: SWE_REBENCH_PARSER,
      transitions: {
        failToPass: [...transitions.failToPass],
        passToPass: [...transitions.passToPass],
      },
      timeout: 1800,
    },
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [{
      name: "environment-setup-failure",
      disposition: "retryable-infrastructure",
    }],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

function source(raw: RawGraderReport): GraderReportSource {
  return { async read() { return raw; } };
}

describe("createSweRebenchEvaluatorAdapter", () => {
  test.each(SWE_REBENCH_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s maps to the harness verdict shape",
    async (_name, fixture) => {
      const adapter = createSweRebenchEvaluatorAdapter({
        graderReportSource: source({ report: fixture.report, log: fixture.log }),
        now: () => new Date("2026-07-30T09:00:00.000Z"),
      });
      const evaluate = adapter.evaluate(
        material("subject-task.json", "{}"),
        [material("result.patch", "diff --git a/a b/a\n")],
        specification(fixture.transitions),
        {},
        ATTEMPT,
        new AbortController().signal,
      );

      if (fixture.expect.kind === "ungradeable") {
        const error = await evaluate.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(EvaluationOperationalError);
        const operational = error as EvaluationOperationalError;
        expect(operational.reason).toBe("provider-unavailable");
        expect(operational.recoveryAdvice).toBe("new-attempt-required");
        expect(operational.safeDetail).toContain(fixture.expect.ungradeableClass);
        return;
      }

      const completed = await evaluate;
      expect(completed.verdict).toBe(fixture.expect.passed ? "pass" : "fail");
      expect(completed.evaluatedAt).toBe("2026-07-30T09:00:00.000Z");
      expect(completed.measurements).toEqual([
        { name: "passed", value: fixture.expect.passed },
      ]);
    },
  );

  test("the detailed outcome carries per-check results and the transition counts", async () => {
    const fixture = SWE_REBENCH_FIXTURES.find(
      (entry) => entry.name === "unresolved-pass-to-pass-broken",
    )!;
    const adapter = createSweRebenchEvaluatorAdapter({
      graderReportSource: source({ report: fixture.report, log: fixture.log }),
    });
    const completed = await adapter.evaluate(
      material("subject-task.json", "{}"),
      [material("result.patch", "diff --git a/a b/a\n")],
      specification(fixture.transitions),
      {},
      ATTEMPT,
      new AbortController().signal,
    );
    expect(completed.detailedOutcome).toMatchObject({
      checks: [
        { name: "transitions.fail-to-pass", status: "pass" },
        { name: "transitions.pass-to-pass", status: "fail" },
      ],
      passToPassBroken: 1,
      containerExitCode: 1,
    });
  });

  test("the capped test log rides as claim evidence", async () => {
    const fixture = SWE_REBENCH_FIXTURES[0]!;
    const adapter = createSweRebenchEvaluatorAdapter({
      graderReportSource: source({ report: fixture.report, log: fixture.log }),
    });
    const completed = await adapter.evaluate(
      material("subject-task.json", "{}"),
      [material("result.patch", "diff --git a/a b/a\n")],
      specification(fixture.transitions),
      {},
      ATTEMPT,
      new AbortController().signal,
    );
    expect(completed.claimEvidence).toHaveLength(1);
    const evidence = completed.claimEvidence![0]!;
    expect(evidence.kind).toBe("content");
    if (evidence.kind !== "content") return;
    expect(evidence.name).toBe("test-log.txt");
    expect(evidence.mediaType).toBe("text/plain; charset=utf-8");
  });

  test("an oversize log is tail-capped, never dropped", async () => {
    const adapter = createSweRebenchEvaluatorAdapter({
      graderReportSource: source({
        report: SWE_REBENCH_FIXTURES[0]!.report,
        log: `${"x".repeat(4096)}TAIL`,
      }),
      maxTestLogBytes: 64,
    });
    const completed = await adapter.evaluate(
      material("subject-task.json", "{}"),
      [material("result.patch", "diff --git a/a b/a\n")],
      specification(SWE_REBENCH_FIXTURES[0]!.transitions),
      {},
      ATTEMPT,
      new AbortController().signal,
    );
    const evidence = completed.claimEvidence![0]!;
    if (evidence.kind !== "content") throw new Error("expected content evidence");
    expect(evidence.bytes.byteLength).toBeLessThanOrEqual(64);
    expect(new TextDecoder().decode(evidence.bytes)).toContain("TAIL");
  });

  test("a non-deterministic-process specification is refused", async () => {
    const adapter = createSweRebenchEvaluatorAdapter({
      graderReportSource: source({ report: {}, log: "" }),
    });
    const modelGraded = {
      ...specification({ failToPass: [], passToPass: [] }),
      family: "model-graded",
    } as unknown as EvaluationSpec;
    const error = await adapter.evaluate(
      material("subject-task.json", "{}"),
      [material("result.patch", "")],
      modelGraded,
      {},
      ATTEMPT,
      new AbortController().signal,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason)
      .toBe("unsupported-specification");
  });

  test("an already-aborted deadline yields the cancellation path, not a verdict", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createSweRebenchEvaluatorAdapter({
      graderReportSource: source({
        report: SWE_REBENCH_FIXTURES[0]!.report,
        log: SWE_REBENCH_FIXTURES[0]!.log,
      }),
    });
    const error = await adapter.evaluate(
      material("subject-task.json", "{}"),
      [material("result.patch", "")],
      specification(SWE_REBENCH_FIXTURES[0]!.transitions),
      {},
      ATTEMPT,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).canonicalCode).toBe("CANCELLED");
  });
});

describe("contextGraderReportSource", () => {
  test("reads the grader report from the harness-supplied evaluation context", async () => {
    const raw = await contextGraderReportSource().read({
      specification: specification({ failToPass: [], passToPass: [] }),
      task: material("subject-task.json", "{}"),
      results: [],
      context: {
        graderReport: { instance_id: "acme__widget-1", exit_code: 0, error: "" },
        graderLog: "PASSED",
      },
      attempt: ATTEMPT,
      deadlineSignal: new AbortController().signal,
    });
    expect(raw).toEqual({
      report: { instance_id: "acme__widget-1", exit_code: 0, error: "" },
      log: "PASSED",
    });
  });

  test("a context without a grader report is an operational failure, not a fail verdict", async () => {
    const error = await contextGraderReportSource().read({
      specification: specification({ failToPass: [], passToPass: [] }),
      task: material("subject-task.json", "{}"),
      results: [],
      context: {},
      attempt: ATTEMPT,
      deadlineSignal: new AbortController().signal,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationOperationalError);
    expect((error as EvaluationOperationalError).reason).toBe("provider-unavailable");
  });
});
