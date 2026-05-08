/**
 * SWE-rebench v2 evaluator. Wraps the upstream `scripts/eval.py` (MIT) to
 * grade Solver patches against the per-instance Docker test suite.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.4
 */

import type {
  SweRebenchV2Task,
  SweRebenchV2SolutionPayload,
  SweRebenchV2VerdictPayload,
} from '@jinn-network/sdk/solvernets/swe-rebench-v2';

export interface HfRow {
  instance_id: string;
  image_name: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  test_patch: string;
  install_config: { test_cmd: string | string[]; log_parser: string };
}

export interface HfFetcher {
  fetchTaskRow(args: { hf_dataset: string; hf_split: string; instance_id: string }): Promise<HfRow>;
}

export interface EvalRunner {
  runEval(args: {
    image: string;
    patch: string;
    test_patch: string;
    test_cmd: string | string[];
    log_parser: string;
    fail_to_pass: string[];
    pass_to_pass: string[];
  }): Promise<{
    passed_match: boolean;
    passed: string[];
    failed: string[];
    log: string;
    exitCode: number;
  }>;
}

export interface GradeArgs {
  task: SweRebenchV2Task;
  solutionPayload: SweRebenchV2SolutionPayload;
}

export class SweRebenchV2Evaluator {
  constructor(
    private readonly deps: { fetcher: HfFetcher; runner: EvalRunner },
  ) {}

  async grade(args: GradeArgs): Promise<SweRebenchV2VerdictPayload & { test_log: string }> {
    const row = await this.deps.fetcher.fetchTaskRow({
      hf_dataset: args.task.hf_dataset,
      hf_split: args.task.hf_split,
      instance_id: args.task.instance_id,
    });
    if (!row.image_name) {
      throw new Error(`HF row for ${args.task.instance_id} missing image_name`);
    }
    const result = await this.deps.runner.runEval({
      image: row.image_name,
      patch: args.solutionPayload.patch,
      test_patch: row.test_patch,
      test_cmd: row.install_config.test_cmd,
      log_parser: row.install_config.log_parser,
      fail_to_pass: row.FAIL_TO_PASS,
      pass_to_pass: row.PASS_TO_PASS,
    });
    return {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: result.passed_match ? 1 : 0,
      passed_match: result.passed_match,
      evaluator_cost_usd: 0,  // populated by caller from runtime metrics
      test_log: result.log,
    };
  }
}
