import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/harnesses/impls/learner/test-utils/noop-adapter.js';
import { makeHarnessCtx } from '@test/harness-ctx.js';
import type { Task } from '../../../../src/types/task.js';

const learnSkillDir = fileURLToPath(
  new URL('../../../../plugins/learner/skills/learn/', import.meta.url),
);

function jinnRepoTask(): Task {
  return {
    id: 'autopilot:task-1195-regression',
    description: 'Create only client/docs/marketplace-canary-task-1195.md',
    solverType: 'jinn-repo.v1',
    role: 'restoration',
    window: { startTs: 0, endTs: Date.now() + 60_000 },
    spec: {
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      problem_statement:
        'Create only client/docs/marketplace-canary-task-1195.md.',
    },
  };
}

function nonRepositoryTask(): Task {
  return {
    id: 'portfolio-no-task-workspace',
    description: 'Rebalance a portfolio',
    solverType: 'portfolio.v0',
    role: 'restoration',
    window: { startTs: 0, endTs: Date.now() + 60_000 },
    spec: {},
  };
}

describe('learner task workspace contract', () => {
  it('threads the authoritative repo checkout for jinn-repo restoration while telemetry stays episode-rooted', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-task-workspace-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-task-workspace-state-'));
    try {
      const adapter = new NoOpHarnessAdapter();
      const harness = new LearnerHarness({
        adapter,
        pluginRoot: '/tmp/learner-plugin',
      });

      await harness.run(makeHarnessCtx({
        task: jinnRepoTask(),
        workingDir,
        implStateDir,
      }));

      const invocation = adapter.getInvocations()[0]!;
      expect(invocation.inputs.workingDir).toBe(workingDir);
      expect(invocation.inputs.taskWorkspaceDir).toBe(join(workingDir, 'repo'));
      expect(invocation.inputs.taskWorkspaceDir).not.toBe(workingDir);

      // The separate workspace must not relocate learner phase telemetry.
      expect(existsSync(join(workingDir, '.execute', 'summary.json'))).toBe(true);
      expect(existsSync(join(workingDir, '.debrief', 'analysis.json'))).toBe(true);
      expect(existsSync(join(workingDir, '.improve', 'summary.json'))).toBe(true);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('leaves non-repository task sessions on the existing single-root contract', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-no-task-workspace-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-no-task-workspace-state-'));
    try {
      const adapter = new NoOpHarnessAdapter();
      const harness = new LearnerHarness({
        adapter,
        pluginRoot: '/tmp/learner-plugin',
      });

      await harness.run(makeHarnessCtx({
        task: nonRepositoryTask(),
        workingDir,
        implStateDir,
      }));

      expect(adapter.getInvocations()[0]!.inputs.taskWorkspaceDir).toBeUndefined();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('routes Task 1195-shaped relative paths through planner and worker workspace inputs', () => {
    const skill = readFileSync(join(learnSkillDir, 'SKILL.md'), 'utf8');
    const planner = readFileSync(join(learnSkillDir, 'planner-prompt.md'), 'utf8');
    const worker = readFileSync(join(learnSkillDir, 'step-worker-prompt.md'), 'utf8');

    expect(skill).toContain('taskWorkspaceDir');
    expect(skill).toContain('taskWorkspaceDir = <absolute path or null>');
    expect(skill).toContain('learner telemetry remains under `workingDir`');

    expect(planner).toContain('taskWorkspaceDir');
    expect(planner).toContain('client/docs/<file>.md');
    expect(planner).toContain('absolute path under `taskWorkspaceDir`');
    expect(planner).toContain('learner phase artifacts under `workingDir`');

    expect(worker).toContain('taskWorkspaceDir');
    expect(worker).toContain('client/docs/<file>.md');
    expect(worker).toContain('resolve it against `taskWorkspaceDir`');
    expect(worker).toContain('learner phase artifacts under `workingDir`');
  });
});
