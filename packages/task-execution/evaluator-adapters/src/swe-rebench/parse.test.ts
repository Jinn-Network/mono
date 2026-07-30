// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { SWE_REBENCH_FIXTURES } from "./fixtures.js";
import {
  classifyInfrastructureSignature,
  parseSweRebenchReport,
} from "./parse.js";

describe("parseSweRebenchReport", () => {
  test.each(SWE_REBENCH_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s reproduces the legacy outcome",
    (_name, fixture) => {
      const outcome = parseSweRebenchReport({
        report: fixture.report,
        log: fixture.log,
        transitions: fixture.transitions,
      });
      if (fixture.expect.kind === "graded") {
        expect(outcome.kind).toBe("graded");
        if (outcome.kind !== "graded") return;
        expect(outcome.passed).toBe(fixture.expect.passed);
      } else {
        expect(outcome.kind).toBe("ungradeable");
        if (outcome.kind !== "ungradeable") return;
        expect(outcome.ungradeableClass).toBe(fixture.expect.ungradeableClass);
      }
    },
  );

  test("a graded outcome carries per-check results, never a bare boolean", () => {
    const outcome = parseSweRebenchReport({
      report: SWE_REBENCH_FIXTURES[3]!.report,
      log: SWE_REBENCH_FIXTURES[3]!.log,
      transitions: SWE_REBENCH_FIXTURES[3]!.transitions,
    });
    expect(outcome.kind).toBe("graded");
    if (outcome.kind !== "graded") return;
    expect(outcome.checks.map((check) => check.name)).toEqual([
      "transitions.fail-to-pass",
      "transitions.pass-to-pass",
    ]);
    expect(outcome.checks[0]!.status).toBe("pass");
    expect(outcome.checks[1]!.status).toBe("fail");
    expect(outcome.passToPassBroken).toBe(1);
  });

  test("the upstream passed_match field is never trusted", () => {
    const outcome = parseSweRebenchReport({
      report: {
        instance_id: "acme__widget-1",
        from_fail_to_pass: ["tests/test_a.py::test_a"],
        failed_from_pass_to_pass: [],
        passed_match: false,
        exit_code: 1,
        error: "",
      },
      log: "PASSED tests/test_a.py::test_a",
      transitions: { failToPass: ["tests/test_a.py::test_a"], passToPass: [] },
    });
    expect(outcome.kind === "graded" && outcome.passed).toBe(true);
  });

  test("a non-UTF-8-decodable log is classified, never crashed on", () => {
    const outcome = parseSweRebenchReport({
      report: {
        instance_id: "acme__widget-1",
        from_fail_to_pass: [],
        failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
        exit_code: 1,
        error: "",
      },
      log: "�� Cannot connect to the Docker daemon �",
      transitions: { failToPass: ["a"], passToPass: ["tests/test_b.py::test_b"] },
    });
    expect(outcome.kind === "ungradeable" && outcome.ungradeableClass)
      .toBe("docker_unavailable");
  });
});

describe("classifyInfrastructureSignature", () => {
  test("returns undefined for an ordinary pytest failure report", () => {
    expect(classifyInfrastructureSignature(
      "FAILED tests/test_a.py::test_a - AssertionError\n1 failed in 0.40s",
    )).toBeUndefined();
  });

  test("classifies a docker-CLI abort", () => {
    // Not "docker: Error response from daemon: no such image" (the plan's literal) — that
    // string also matches the earlier image_pull_failed pattern ("No such image"), and
    // INFRASTRUCTURE_SIGNATURES is order-sensitive (first match wins), so it would resolve
    // to image_pull_failed instead of exercising docker_run_failed as this test intends. The
    // real legacy test hits the same ambiguity for a similar string
    // (eval-runner.test.ts:628-632) and deliberately asserts only `.not.toBeNull()`. Using a
    // daemon-error string with no other signature's substring exercises docker_run_failed
    // unambiguously without reordering the transcribed table.
    expect(classifyInfrastructureSignature(
      "docker: Error response from daemon: conflict: unable to remove repository reference",
    )).toBe("docker_run_failed");
  });
});
