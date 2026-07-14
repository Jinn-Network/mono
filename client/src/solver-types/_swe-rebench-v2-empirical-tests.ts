/**
 * Empirical F2P/P2P derivation — double-run Docker grading.
 * Spec §5.3, PR 2.2.
 */

import type { EvalRunner } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';

export interface EmpiricalTestDerivationInput {
  instance_id: string;
  repo: string;
  image: string;
  test_patch: string;
  install?: string[];
  test_cmd: string | string[];
  log_parser: string;
  gold_patch: string;
  /** Patch that produces the broken state B' (may be empty for base). */
  broken_patch: string;
}

export interface EmpiricalTestDerivationResult {
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  dead: boolean;
  /** Exact before/after observations for a bound evidence receipt. */
  before?: EvalReportLike;
  after?: EvalReportLike;
}

export interface EvalReportLike {
  passed: string[];
  failed: string[];
  passed_match: boolean;
}

export interface TargetedEmpiricalTestDerivationInput extends EmpiricalTestDerivationInput {
  /** Already-normalized repository path bound to the targeted test command. */
  normalizedTestPath: string;
}

export interface TargetedEmpiricalTestDerivationResult {
  testPath: string;
  broken: [EvalReportLike, EvalReportLike];
  fixed: [EvalReportLike, EvalReportLike];
}

function reportSnapshot(report: { passed: string[]; failed: string[]; passed_match: boolean }): EvalReportLike {
  return { passed: report.passed, failed: report.failed, passed_match: report.passed_match };
}

export function deriveF2pP2pFromReports(
  before: EvalReportLike,
  after: EvalReportLike,
  allTests: string[],
): EmpiricalTestDerivationResult {
  const beforePass = new Set(before.passed);
  const afterPass = new Set(after.passed);
  const FAIL_TO_PASS = allTests.filter((t) => !beforePass.has(t) && afterPass.has(t));
  const PASS_TO_PASS = allTests.filter((t) => beforePass.has(t) && afterPass.has(t));
  return {
    FAIL_TO_PASS,
    PASS_TO_PASS,
    dead: FAIL_TO_PASS.length === 0,
  };
}

export async function runEmpiricalTestDerivation(
  input: EmpiricalTestDerivationInput,
  runner: EvalRunner,
): Promise<EmpiricalTestDerivationResult> {
  const baseArgs = {
    instance_id: input.instance_id,
    repo: input.repo,
    image: input.image,
    test_patch: input.test_patch,
    install: input.install,
    test_cmd: input.test_cmd,
    log_parser: input.log_parser,
    fail_to_pass: [] as string[],
    pass_to_pass: [] as string[],
  };
  const before = await runner.runEval({ ...baseArgs, patch: input.broken_patch });
  const after = await runner.runEval({ ...baseArgs, patch: input.gold_patch });
  const allTests = [...new Set([...before.passed, ...before.failed, ...after.passed, ...after.failed])];
  return {
    ...deriveF2pP2pFromReports(before, after, allTests),
    before: reportSnapshot(before),
    after: reportSnapshot(after),
  };
}

/**
 * Execute the hardened evidence matrix for one already-targeted test command.
 * Deliberately returns parser observations rather than deriving verdict sets:
 * the differential receipt owns stability, uniqueness, and F2P policy.
 */
export async function runTargetedEmpiricalTestDerivation(
  input: TargetedEmpiricalTestDerivationInput,
  runner: EvalRunner,
): Promise<TargetedEmpiricalTestDerivationResult> {
  const baseArgs = {
    instance_id: input.instance_id,
    repo: input.repo,
    image: input.image,
    test_patch: input.test_patch,
    install: input.install,
    test_cmd: input.test_cmd,
    log_parser: input.log_parser,
    fail_to_pass: [] as string[],
    pass_to_pass: [] as string[],
  };
  const firstBroken = reportSnapshot(await runner.runEval({ ...baseArgs, patch: input.broken_patch }));
  const secondBroken = reportSnapshot(await runner.runEval({ ...baseArgs, patch: input.broken_patch }));
  const firstFixed = reportSnapshot(await runner.runEval({ ...baseArgs, patch: input.gold_patch }));
  const secondFixed = reportSnapshot(await runner.runEval({ ...baseArgs, patch: input.gold_patch }));
  return {
    testPath: input.normalizedTestPath,
    broken: [firstBroken, secondBroken],
    fixed: [firstFixed, secondFixed],
  };
}
