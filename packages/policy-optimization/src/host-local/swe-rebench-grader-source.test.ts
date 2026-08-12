import { describe, expect, test } from "vitest";
import {
  exactSweRebenchTestCommands,
  LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN,
  SWE_REBENCH_OCI_GRADER_PROGRAM,
} from "./swe-rebench-grader-source.js";

describe("live SWE-rebench grader program", () => {
  test("versions the sealed-command grader behavior separately from the legacy selector behavior", () => {
    expect(LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN).toBe(
      "network.jinn.policy-optimization.swe-rebench-oci-evaluator/1.1",
    );
  });

  test("binds grading to the preregistered base commit", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain('base_commit = config["base_commit"]');
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain('["git", "rev-parse", "HEAD"]');
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      '["git", "reset", "--hard", base_commit]',
    );
  });

  test("checks and applies exact patch bytes without the bind-mount-sensitive index fallback", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      '["git", "apply", "--check", "--recount", "--whitespace=nowarn"',
    );
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).not.toContain('"--3way"');
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).not.toContain('"--ignore-space-change"');
  });

  test("restores benchmark-owned test files before applying the public test patch", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      '["git", "apply", "--numstat", "-z", str(patch)]',
    );
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      '["git", "checkout", base_commit, "--", source]',
    );
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      'path.is_absolute() or "." in path.parts or ".." in path.parts',
    );
  });

  test("uses the immutable environment baked into the pinned evaluation image", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      'source /opt/conda/bin/activate && conda activate testbed && ',
    );
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).not.toContain('config["install"]');
  });

  test("classifies each preregistered pytest transition instead of using the process exit globally", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain('config["log_parser"]');
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain("statuses = parse_pytest(log)");
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      "original for normalized, original in f2p_normalized.items() if normalized in passed_actual",
    );
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain(
      "original for normalized, original in p2p_normalized.items() if normalized not in passed_actual",
    );
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).not.toContain(
      '"failed_from_pass_to_pass": [] if passed else p2p',
    );
  });

  test("runs the sealed source command instead of treating parser-normalized names as node ids", () => {
    const command = "pytest -rA tests/test_factor.py";
    expect(exactSweRebenchTestCommands({
      commands: [command],
      logParser: "parse_log_pytest",
    })).toEqual([command]);
    expect(exactSweRebenchTestCommands({
      commands: ["pytest -rA tests/test_factor.py::test_case[Expand {1,2}, keep spaces]"],
      logParser: "parse_log_pytest",
    })).toEqual(["pytest -rA tests/test_factor.py::test_case[Expand {1,2}, keep spaces]"]);
  });
});
