// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral oracles for the swe-rebench parser. Composition design §6.6: legacy behavior
 * enters as fixtures, never as ported code. Each entry cites the exact legacy file and line
 * range it was transcribed from.
 *
 * Provenance verification (2026-07-30): every citation below was checked against the real
 * legacy bytes before this module was written. Two plan-drafted citations pointed at the
 * wrong code and are corrected here (see `fixtures/swe-rebench/README.md` §Provenance
 * corrections for the full account):
 *  - "adversarial-report-is-not-an-object" cited `eval-runner.ts:478-489` (the
 *    `JSON.parse` failure branch, which throws `eval_no_report` or a matched infra reason —
 *    a different code path). The branch that actually classifies a malformed/non-object
 *    report item as `eval_report_malformed` is `eval-runner.ts:491-507` (item defaults to
 *    `{}` when absent, then the missing-`exit_code` check fires); corrected to that range.
 *  - "adversarial-truncated-log-with-no-marker" carried a `failed_from_pass_to_pass: []`
 *    report, which fails the `noTestPassed` gate (`eval-runner.ts:546-547`) before
 *    `matchInfraSignature` is ever called on the truncated log — so the case reached its
 *    expected outcome for the wrong reason. Corrected the report so the gate opens and the
 *    truncated log is genuinely matched against `INFRA_SIGNATURES` (no marker → falls
 *    through to a graded failure), which is what the fixture name and citation claim.
 */

export interface SweRebenchFixture {
  readonly name: string;
  readonly provenance: string;
  readonly transitions: {
    readonly failToPass: readonly string[];
    readonly passToPass: readonly string[];
  };
  readonly report: unknown;
  readonly log: string;
  readonly expect:
    | { readonly kind: "graded"; readonly passed: boolean }
    | { readonly kind: "ungradeable"; readonly ungradeableClass: string };
}

const TRANSITIONS = {
  failToPass: ["tests/test_a.py::test_a"],
  passToPass: ["tests/test_b.py::test_b"],
} as const;

const PYTEST_TAIL = [
  "==================================== PASSES ====================================",
  "PASSED tests/test_a.py::test_a",
  "PASSED tests/test_b.py::test_b",
  "======================== 2 passed, 0 failed in 1.20s ==========================",
].join("\n");

export const SWE_REBENCH_FIXTURES: readonly SweRebenchFixture[] = Object.freeze([
  {
    name: "resolved-all-transitions",
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:555-559",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: ["tests/test_a.py::test_a"],
      failed_from_pass_to_pass: [],
      passed_match: true,
      exit_code: 0,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: PYTEST_TAIL,
    expect: { kind: "graded", passed: true },
  },
  {
    name: "resolved-despite-extra-unlisted-test-failing",
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:270-283",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: ["tests/test_a.py::test_a"],
      failed_from_pass_to_pass: [],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: [
      "FAILED tests/test_unlisted.py::test_unlisted",
      "PASSED tests/test_a.py::test_a",
      "PASSED tests/test_b.py::test_b",
      "=================== 2 passed, 1 failed in 2.10s ===============================",
    ].join("\n"),
    expect: { kind: "graded", passed: true },
  },
  {
    name: "unresolved-fail-to-pass-still-failing",
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:284-295",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: [],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: [
      "FAILED tests/test_a.py::test_a - AssertionError",
      "PASSED tests/test_b.py::test_b",
      "=================== 1 passed, 1 failed in 1.80s ===============================",
    ].join("\n"),
    expect: { kind: "graded", passed: false },
  },
  {
    name: "unresolved-pass-to-pass-broken",
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:555-559",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: ["tests/test_a.py::test_a"],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: [
      "PASSED tests/test_a.py::test_a",
      "FAILED tests/test_b.py::test_b - RegressionError",
      "=================== 1 passed, 1 failed in 1.90s ===============================",
    ].join("\n"),
    expect: { kind: "graded", passed: false },
  },
  {
    name: "ungradeable-docker-unavailable",
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:318-331",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 125,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
    expect: { kind: "ungradeable", ungradeableClass: "docker_unavailable" },
  },
  {
    name: "ungradeable-patch-corrupt",
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:333-346",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "error: corrupt patch at line 7",
    expect: { kind: "ungradeable", ungradeableClass: "patch_corrupt" },
  },
  {
    name: "ungradeable-patch-does-not-apply",
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:229",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "error: patch failed: src/widget.py:14\nerror: patch does not apply",
    expect: { kind: "ungradeable", ungradeableClass: "patch_does_not_apply" },
  },
  {
    name: "ungradeable-workdir-not-git-repo",
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:348-361",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 128,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "fatal: not a git repository (or any of the parent directories): .git",
    expect: { kind: "ungradeable", ungradeableClass: "workdir_not_git_repo" },
  },
  {
    name: "ungradeable-venv-collision",
    // Verified against the real file: the VENV_COLLISION triage constant is declared at
    // eval-runner.test.ts:578-582 (the plan's cited :576-580 is the section comment plus the
    // first two array lines, missing the constant's third line and its `.join()`).
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:578-582",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 2,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: [
      "error: Failed to create virtual environment.",
      "  Caused by: A virtual environment already exists at /testbed/.venv",
      "  Use --clear to replace it",
    ].join("\n"),
    expect: { kind: "ungradeable", ungradeableClass: "venv_collision" },
  },
  {
    name: "ungradeable-pytest-missing",
    // Verified: MISSING_PYTEST is declared at eval-runner.test.ts:584-585 (the plan's cited
    // :582-583 is the tail of the VENV_COLLISION block, two lines early).
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:584-585",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "/opt/conda/bin/python: No module named pytest",
    expect: { kind: "ungradeable", ungradeableClass: "pytest_missing" },
  },
  {
    name: "ungradeable-requests-dep-mismatch",
    // Verified: REQUESTS_DEP_WARNING is declared at eval-runner.test.ts:587-588 (the plan's
    // cited :585-586 is the MISSING_PYTEST line plus a blank line, two lines early).
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:587-588",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log:
      "requests.exceptions.RequestsDependencyWarning: urllib3 (2.2.2) or "
      + "chardet (7.4.3)/charset_normalizer (3.3.2) doesn't match a supported version!",
    expect: { kind: "ungradeable", ungradeableClass: "requests_dep_mismatch" },
  },
  {
    name: "ungradeable-conftest-import-error",
    // Verified: CONFTEST_IMPORT_ERROR is declared at eval-runner.test.ts:590-591 (the plan's
    // cited :588-589 is the REQUESTS_DEP_WARNING line plus a blank line, two lines early).
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:590-591",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "ImportError while loading conftest '/testbed/tests/conftest.py'.",
    expect: { kind: "ungradeable", ungradeableClass: "conftest_import_error" },
  },
  {
    name: "ungradeable-upstream-setup-error",
    provenance: "operator/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts:363-370",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      error: "missing image_name",
    },
    log: "",
    expect: { kind: "ungradeable", ungradeableClass: "eval_setup_error" },
  },
  {
    name: "adversarial-report-lacks-exit-code",
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:501-507",
    transitions: TRANSITIONS,
    report: { instance_id: "acme__widget-1", from_fail_to_pass: [], failed_from_pass_to_pass: [] },
    log: "",
    expect: { kind: "ungradeable", ungradeableClass: "eval_report_malformed" },
  },
  {
    name: "adversarial-report-is-not-an-object",
    // Corrected from the plan's :478-489 (the `JSON.parse` failure branch, which throws
    // `eval_no_report` or a matched infra reason — not this case). A non-object item falls
    // through the same `?? {}` default and missing-`exit_code` check as a malformed item:
    // eval-runner.ts:491-507.
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:491-507",
    transitions: TRANSITIONS,
    report: "the upstream harness crashed before writing a report",
    log: "",
    expect: { kind: "ungradeable", ungradeableClass: "eval_report_malformed" },
  },
  {
    name: "adversarial-transition-arrays-carry-non-strings",
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:251-253",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [null, 7, "tests/test_a.py::test_a"],
      failed_from_pass_to_pass: [{ nested: true }],
      passed_match: false,
      exit_code: 0,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: PYTEST_TAIL,
    expect: { kind: "graded", passed: true },
  },
  {
    name: "adversarial-truncated-log-with-no-marker",
    // Corrected report data: the plan's `failed_from_pass_to_pass: []` fails the
    // `noTestPassed` gate (eval-runner.ts:546-547) before `matchInfraSignature` is ever
    // called, so the case reached "graded, failed" without exercising the log-truncation
    // path its name and citation claim. Reporting the declared pass-to-pass test as broken
    // opens the gate so the truncated, marker-less log is genuinely matched against
    // `INFRA_SIGNATURES` (eval-runner.ts:216-242) and falls through, ungradeable-free, to a
    // graded failure — eval-runner.ts:256-261 (capLogTail) confirms the log is truncated
    // before matching, not after.
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:256-261",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "[… 4194304 bytes truncated …]\ncollecting ... ",
    expect: { kind: "graded", passed: false },
  },
  {
    name: "adversarial-empty-log-non-zero-exit-no-signature",
    provenance: "operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:539-553",
    transitions: TRANSITIONS,
    report: {
      instance_id: "acme__widget-1",
      from_fail_to_pass: [],
      failed_from_pass_to_pass: ["tests/test_b.py::test_b"],
      passed_match: false,
      exit_code: 1,
      log_path: "logs/acme__widget-1_log.txt",
      error: "",
    },
    log: "",
    expect: { kind: "graded", passed: false },
  },
]);
