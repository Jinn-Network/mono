// SPDX-License-Identifier: Apache-2.0

/**
 * Ingestion parser for the upstream SWE-rebench-V2 evaluation report. Pure: no process, no
 * filesystem, no clock. The commitment it implements is `fixtures/parsers/swe-rebench-v2.parser.json`,
 * whose digest is this parser's identity.
 */

export interface SweRebenchCheck {
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly detail?: string;
}

export interface SweRebenchGraded {
  readonly kind: "graded";
  readonly instanceId: string;
  readonly passed: boolean;
  readonly failToPassExpected: number;
  readonly failToPassSatisfied: number;
  readonly passToPassExpected: number;
  readonly passToPassBroken: number;
  readonly containerExitCode: number;
  readonly checks: readonly SweRebenchCheck[];
}

export interface SweRebenchUngradeable {
  readonly kind: "ungradeable";
  readonly ungradeableClass: string;
  readonly detail: string;
}

export type SweRebenchOutcome = SweRebenchGraded | SweRebenchUngradeable;

export interface SweRebenchTransitions {
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
}

/**
 * Container-output signatures meaning the evaluation aborted before grading anything — the
 * environment is the problem, not the solution. Transcribed as data from the legacy
 * classification table (`client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:216-242`);
 * the fixtures in `./fixtures.ts` are its regression suite.
 */
const INFRASTRUCTURE_SIGNATURES: readonly {
  readonly pattern: RegExp;
  readonly ungradeableClass: string;
}[] = Object.freeze([
  { pattern: /Cannot connect to the Docker daemon/iu, ungradeableClass: "docker_unavailable" },
  { pattern: /input\/output error/iu, ungradeableClass: "docker_storage_io_error" },
  { pattern: /No such image|manifest unknown|pull access denied/iu, ungradeableClass: "image_pull_failed" },
  { pattern: /error getting credentials/iu, ungradeableClass: "docker_credentials_error" },
  { pattern: /^docker: (?:error|Error response from daemon)/imu, ungradeableClass: "docker_run_failed" },
  { pattern: /error: corrupt patch at line|patch fragment without header/iu, ungradeableClass: "patch_corrupt" },
  { pattern: /patch does not apply|error: patch failed:/iu, ungradeableClass: "patch_does_not_apply" },
  { pattern: /Applied patch to .+ with conflicts|^U \S/mu, ungradeableClass: "patch_merge_conflict" },
  { pattern: /fatal: not a git repository \(or any of the parent directories\): \.git/iu, ungradeableClass: "workdir_not_git_repo" },
  { pattern: /: command not found/iu, ungradeableClass: "test_command_not_found" },
  { pattern: /Failed building editable|Failed to build installable wheels/iu, ungradeableClass: "install_build_failed" },
  { pattern: /No virtual environment found/iu, ungradeableClass: "venv_missing" },
  { pattern: /exec format error|the requested image's platform .* does not match/iu, ungradeableClass: "image_arch_mismatch" },
  { pattern: /Fatal Python error:\s*Illegal instruction|Illegal instruction(?:\s+\(core dumped\))?/iu, ungradeableClass: "image_arch_mismatch" },
  { pattern: /A virtual environment already exists at \S+\.venv\b/iu, ungradeableClass: "venv_collision" },
  { pattern: /No module named pytest\b/iu, ungradeableClass: "pytest_missing" },
  { pattern: /RequestsDependencyWarning/iu, ungradeableClass: "requests_dep_mismatch" },
  { pattern: /ImportError while loading conftest/iu, ungradeableClass: "conftest_import_error" },
]);

export function classifyInfrastructureSignature(log: string): string | undefined {
  for (const { pattern, ungradeableClass } of INFRASTRUCTURE_SIGNATURES) {
    if (pattern.test(log)) return ungradeableClass;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function excerpt(text: string): string {
  return text.length <= 800 ? text : text.slice(-800);
}

export function parseSweRebenchReport(input: {
  readonly report: unknown;
  readonly log: string;
  readonly transitions: SweRebenchTransitions;
}): SweRebenchOutcome {
  const { report, log, transitions } = input;
  if (!isObject(report)) {
    return {
      kind: "ungradeable",
      ungradeableClass: classifyInfrastructureSignature(log) ?? "eval_report_malformed",
      detail: "the evaluation report is not a report item object",
    };
  }
  const declaredError = typeof report["error"] === "string"
    ? report["error"].trim()
    : "";
  if (declaredError.length > 0) {
    return {
      kind: "ungradeable",
      ungradeableClass: "eval_setup_error",
      detail: excerpt(declaredError),
    };
  }
  if (typeof report["exit_code"] !== "number") {
    return {
      kind: "ungradeable",
      ungradeableClass: "eval_report_malformed",
      detail: "the evaluation report item carries no numeric exit_code",
    };
  }

  const containerExitCode = report["exit_code"];
  const satisfied = stringArray(report["from_fail_to_pass"]);
  const broken = stringArray(report["failed_from_pass_to_pass"]);
  const failToPassExpected = transitions.failToPass.length;
  const passToPassExpected = transitions.passToPass.length;

  // Ungradeable iff the container aborted, nothing declared was observed to pass, AND the
  // output matches a classified signature. A wrong-answer run shows an ordinary failing
  // report with no signature; a partially passing run is a real result. Both are verdicts.
  const nothingPassed = satisfied.length === 0 && broken.length >= passToPassExpected;
  if (containerExitCode !== 0 && nothingPassed) {
    const ungradeableClass = classifyInfrastructureSignature(log);
    if (ungradeableClass !== undefined) {
      return { kind: "ungradeable", ungradeableClass, detail: excerpt(log) };
    }
  }

  const failToPassSatisfied = satisfied.length;
  const passToPassBroken = broken.length;
  const failToPassOk = failToPassSatisfied === failToPassExpected;
  const passToPassOk = passToPassBroken === 0;

  return {
    kind: "graded",
    instanceId: typeof report["instance_id"] === "string" ? report["instance_id"] : "",
    passed: failToPassOk && passToPassOk,
    failToPassExpected,
    failToPassSatisfied,
    passToPassExpected,
    passToPassBroken,
    containerExitCode,
    checks: [
      {
        name: "transitions.fail-to-pass",
        status: failToPassOk ? "pass" : "fail",
        detail: `${failToPassSatisfied}/${failToPassExpected} declared fail-to-pass transitions now pass`,
      },
      {
        name: "transitions.pass-to-pass",
        status: passToPassOk ? "pass" : "fail",
        detail: `${passToPassBroken}/${passToPassExpected} declared pass-to-pass transitions broke`,
      },
    ],
  };
}
