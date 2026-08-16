/**
 * Smoke test for the solver-side round-trip: a swe-rebench-v2.v1 Task
 * dispatched to LearnerHarness, with the Claude subprocess
 * simulated by NoOpHarnessAdapter. The fake "model" writes the full
 * phase pipeline + a `.execute/solution-payload.json` (matching what
 * `submit_typed_payload` would persist), and we assert the resulting
 * `Solution.solutionPayload` validates against the SDK's
 * `SweRebenchV2SolutionPayloadSchema`.
 *
 * Closes the gap surfaced in jinn-mono-zo5m: the existing e2e
 * coverage for swe-rebench-v2 stops at the grading library and
 * settles a hand-crafted envelope on Anvil; the harness-producing-
 * a-Solution path was untested.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
} from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/harnesses/impls/learner/test-utils/noop-adapter.js';
import { fakeFullPipelineRun } from '../../../../src/harnesses/impls/learner/test-utils/fake-plugin-outputs.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';

function buildTask(role: 'restoration' | 'evaluation'): Task {
  return {
    id: `swe-rebench-task-${role}`,
    description: `swe-rebench-v2 ${role} task`,
    solverType: 'swe-rebench-v2.v1',
    role,
    window: { startTs: 0, endTs: Date.now() + 60_000 },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      base_commit: 'a'.repeat(40),
      language: 'c',
      problem_statement: 'fix the netcdf bug',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      round_month: '2026-05',
    },
    ...(role === 'evaluation' ? { context: { restorationResult: '{}' } } : {}),
  };
}

function buildContext(workingDir: string, implStateDir: string, task: Task): HarnessContext {
  return {
    task,
    requestId: 'req-1',
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
    mode: 'train',
  };
}

function writeTypedPayload(workingDir: string, payload: Record<string, unknown>): void {
  const dir = join(workingDir, '.execute');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'solution-payload.json'), JSON.stringify(payload, null, 2));
}

describe('swe-rebench-v2 solver round-trip via LearnerHarness', () => {
  it('claude-code-learner.supports() claims swe-rebench-v2.v1 restoration when routed to it', () => {
    const adapter = new NoOpHarnessAdapter();
    // C6: routing is explicit now — the learner claims the SolverTypes its
    // configuration names and nothing else (product design §10). This test used
    // to construct the harness with no routing at all and rely on the retired
    // wrap-every-SolverType default; the allowlist below is what a deployment
    // that wants the learner on swe-rebench-v2 actually configures.
    const harness = new LearnerHarness({
      adapter,
      pluginRoot: '/tmp/plugin-root',
      routing: { solverTypes: ['swe-rebench-v2.v1'] },
    });
    expect(harness.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
    // Evaluation goes to the dedicated SweRebenchV2EvaluatorHarness, not the learner.
    expect(harness.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('emits a Solution.solutionPayload that validates against the SDK schema (restoration)', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-swe-rebench-roundtrip-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-swe-rebench-impl-'));
    try {
      const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
        // 1. Fake the full claude-code-learner phase pipeline.
        fakeFullPipelineRun(inputs.workingDir, {
          taskId: inputs.taskId,
          solverType: inputs.solverType ?? 'swe-rebench-v2.v1',
        });
        // 2. Simulate the model calling submit_typed_payload — writes the
        //    validated payload to .execute/solution-payload.json.
        writeTypedPayload(inputs.workingDir, {
          schemaVersion: 'swe-rebench-v2-solution.v1',
          patch:
            '--- a/src/example.c\n+++ b/src/example.c\n@@ -1 +1 @@\n-/* before */\n+/* after */\n',
          cost: { totalUsd: 0.21, breakdown: { llm: 0.2, tools: 0.01 } },
        });
      });
      const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/plugin-root' });
      const task = buildTask('restoration');
      const sol = await harness.run(buildContext(workingDir, implStateDir, task));

      // 3. The Solution carries a typed payload that validates against the SDK.
      expect(sol.solutionPayload).toBeDefined();
      expect(() =>
        SweRebenchV2SolutionPayloadSchema.parse(sol.solutionPayload),
      ).not.toThrow();
      expect((sol.solutionPayload as Record<string, unknown>)['schemaVersion']).toBe(
        'swe-rebench-v2-solution.v1',
      );
      expect((sol.solutionPayload as Record<string, unknown>)['patch']).toContain('before');
      // The harness must NOT inject daemon-derived fields into the payload.
      expect(sol.solutionPayload).not.toHaveProperty('trajectory_cid');

      // 4. The artifact entry is keyed by the active solverType + role.
      const artifact = sol.artifacts?.find(
        (a) => a.path === '.execute/solution-payload.json',
      );
      expect(artifact?.artifactType).toBe('swe-rebench-v2_v1_solution');
      expect(artifact?.metadata).toMatchObject({
        schemaVersion: 'swe-rebench-v2-solution.v1',
        solverType: 'swe-rebench-v2.v1',
      });
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('falls through to legacy gating-only Solution when the model never submits a typed payload', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-swe-rebench-noschema-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-swe-rebench-impl-'));
    try {
      // Default NoOp behaviour: write phase artifacts only, no typed payload.
      const adapter = new NoOpHarnessAdapter();
      const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/plugin-root' });
      const task = buildTask('restoration');
      const sol = await harness.run(buildContext(workingDir, implStateDir, task));

      expect(sol.solutionPayload).toBeUndefined();
      expect(sol.gating).toBeDefined();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('documents the harness-neutral fallback payload file and schema shape', () => {
    const skill = readFileSync(
      join(process.cwd(), 'plugins', 'swe-rebench-v2-runtime', 'skills', 'task', 'SKILL.md'),
      'utf8',
    );
    // SKILL.md describes the submission action by intent, not by hardcoded tool
    // name, so the model bridges to whichever the active harness has registered
    // (Claude Code: `mcp__jinn-client__submit_typed_payload`, Hermes:
    // `mcp_jinn_client_submit_typed_payload`, Codex: similar). We assert the
    // intent language plus the fallback file path + schema-shape language.
    expect(skill).toContain('typed structured payload');
    expect(skill).toContain('no typed-payload submission tool at all');
    expect(skill).toContain('Prefer the tool path whenever it exists');
    expect(skill).toContain('.execute/solution-payload.json');

    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-swe-rebench-fallback-'));
    try {
      const payload = {
        schemaVersion: 'swe-rebench-v2-solution.v1',
        patch: '--- a/src/example.c\n+++ b/src/example.c\n@@ -1 +1 @@\n-old\n+new\n',
      };
      writeTypedPayload(workingDir, payload);
      const parsed = JSON.parse(readFileSync(join(workingDir, '.execute', 'solution-payload.json'), 'utf8')) as unknown;

      expect(SweRebenchV2SolutionPayloadSchema.parse(parsed)).toEqual(payload);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('task skill owns repo setup so the harness prompt can stay generic', () => {
    const skill = readFileSync(
      join(process.cwd(), 'plugins', 'swe-rebench-v2-runtime', 'skills', 'task', 'SKILL.md'),
      'utf8',
    );
    // Repo-setup guidance used to live in each harness's prompt.ts (the
    // `sweRebenchV2Guidance` helper that was retired in favour of skill-driven
    // dispatch). The domain-reference task skill now owns it. If this
    // assertion breaks, check that nothing has reintroduced SolverNet
    // branching in the harness prompts — the skill should be the single
    // home for SWE-rebench-specific patterns.
    // Backticks in the SKILL.md wrap inline code spans, so we search for the
    // load-bearing tokens without insisting on a literal "clone https://..."
    // run that the markdown formatting interrupts.
    expect(skill).toContain('$workingDir/repo');
    expect(skill).toContain('Do not reuse a repo');
    expect(skill).toContain('https://github.com/<goal.spec.repo>.git');
    expect(skill).toContain('<goal.spec.base_commit>');
    expect(skill).toContain('harvester reads a `git diff`');
  });

  it('documents SWE execution data retrieval through Network Tools', () => {
    const skill = readFileSync(
      join(process.cwd(), 'plugins', 'swe-rebench-v2-runtime', 'skills', 'task', 'SKILL.md'),
      'utf8',
    );
    // The task skill describes the three corpus-tool actions (find candidates
    // → examine index card → download bytes) by intent. We assert the workflow
    // vocabulary and the typed-restoration filter values, not the literal
    // tool names — those vary by harness MCP namespace.
    expect(skill).toContain('Jinn knowledge corpus');
    expect(skill).toContain('"swe-rebench-v2.v1"');
    expect(skill).toContain('"swe-rebench-v2_v1_solution"');
    expect(skill).toContain('index card');
    expect(skill).not.toContain('.execute/execution-data-retrieval.json');
    expect(skill).not.toContain('jinn.execution_data_retrieval.v1');
    expect(skill).not.toContain('corpus.read');
  });

  it('emits a Solution.verdictPayload (validates against SDK) when role=evaluation', async () => {
    // NB: in production swe-rebench-v2 evaluation tasks go to the dedicated
    // SweRebenchV2EvaluatorHarness, not claude-code-learner. This test
    // verifies the generic harvest path itself can produce a valid
    // verdictPayload for any solverType when the agent submits one — which
    // matters for future SolverNets where the learner handles evaluation.
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-swe-rebench-verdict-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-swe-rebench-impl-'));
    try {
      const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
        fakeFullPipelineRun(inputs.workingDir, {
          taskId: inputs.taskId,
          solverType: inputs.solverType ?? 'swe-rebench-v2.v1',
        });
        writeTypedPayload(inputs.workingDir, {
          schemaVersion: 'swe-rebench-v2-verdict.v1',
          score: 1,
          passed_match: true,
          evaluator_cost_usd: 0,
        });
      });
      // Bypass `supports()` (which excludes evaluation) by invoking run()
      // directly — this is testing the harvest path, not the dispatch path.
      const harness = new LearnerHarness({ adapter, pluginRoot: '/tmp/plugin-root' });
      const task = buildTask('evaluation');
      const sol = await harness.run(buildContext(workingDir, implStateDir, task));

      expect(sol.verdictPayload).toBeDefined();
      expect(sol.solutionPayload).toBeUndefined();
      expect(() =>
        SweRebenchV2VerdictPayloadSchema.parse(sol.verdictPayload),
      ).not.toThrow();
      const artifact = sol.artifacts?.find(
        (a) => a.path === '.execute/solution-payload.json',
      );
      expect(artifact?.artifactType).toBe('swe-rebench-v2_v1_verdict');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });
});
