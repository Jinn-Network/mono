/**
 * G3 — jinn-repo solver-side harvest materializer.
 *
 * The daemon harvests the working-tree `git diff` over `$workingDir/repo` into
 * a `jinn-repo-solution.v1` typed payload for a `jinn-repo.v1` restoration
 * task. Mirrors the swe-rebench-v2 materializer: source-file changes become the
 * patch, test-file hunks are stripped (the gold tests are held out, so the
 * solver must not be able to satisfy them by editing test files), and the
 * materializer no-ops for non-jinn-repo / evaluation / empty-diff cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harvestOutput } from '../../../src/harnesses/impls/learner/harvest.js';

function makeRepo(workingDir: string): string {
  const repoDir = join(workingDir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  return repoDir;
}

function commitBase(repoDir: string): void {
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repoDir });
}

function jinnRepoTask(role: 'restoration' | 'evaluation' = 'restoration') {
  return {
    id: 'task-1',
    description: 'd',
    solverType: 'jinn-repo.v1',
    role,
  } as never;
}

const SESSION = {
  schemaVersion: 'jinn-autopilot-session.v1',
  workflow: 'implement',
  repository: 'Jinn-Network/mono',
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  issueNumber: 2253,
  prNumber: 2255,
  targetBase: 'next',
  branch: 'autopilot/2253',
  claimOid: '1'.repeat(40),
  expectedHead: '2'.repeat(40),
  v2AttemptId: '11111111-1111-4111-8111-111111111111',
  runnerId: 'marketplace-canary',
  taskSnapshot: {
    title: 'Canary',
    body: 'Clarify the command.',
    prBody: 'Closes #2253',
    baseSha: '3'.repeat(40),
    targetBaseOid: '3'.repeat(40),
  },
  workflowContract: {
    skill: 'implement-issue',
    version: 'v2',
    resultSchema: 'jinn-autopilot-mutation-result.v1',
  },
  deadline: '2026-07-28T12:00:00.000Z',
  receiptAuthors: ['ritsukai'],
} as const;

function autopilotTask() {
  return {
    id: `autopilot:${SESSION.v2AttemptId}`,
    description: 'Canary',
    solverType: 'jinn-repo.v1',
    role: 'restoration',
    spec: {
      schemaVersion: 'jinn-repo.v1',
      source: 'autopilot-session',
      instance_id: `autopilot:${SESSION.v2AttemptId}`,
      repo: 'Jinn-Network/mono',
      base_commit: SESSION.expectedHead,
      problem_statement: 'Clarify the command.',
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      session: SESSION,
    },
  } as never;
}

describe('harvestOutput — jinn-repo materializer', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-repo-harvest-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('materializes a typed Autopilot mutation result from the worktree diff', async () => {
    const repoDir = makeRepo(workingDir);
    writeFileSync(join(repoDir, 'README.md'), 'before\n');
    commitBase(repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'after\n');

    const out = await harvestOutput(
      workingDir,
      undefined,
      autopilotTask(),
      {
        taskId: '1192',
        attemptIndex: 0,
        requestId: `0x${'4'.repeat(64)}`,
      },
    );

    expect(out.solutionPayload).toMatchObject({
      schemaVersion: 'jinn-autopilot-mutation-result.v1',
      outcome: 'mutation-complete',
      correlation: {
        taskId: '1192',
        attemptIndex: 0,
        requestId: `0x${'4'.repeat(64)}`,
        v2AttemptId: SESSION.v2AttemptId,
        claimOid: SESSION.claimOid,
        prNumber: SESSION.prNumber,
        expectedHead: SESSION.expectedHead,
      },
    });
    expect(
      (out.solutionPayload?.correlation as Record<string, unknown>)
        .deliveryEnvelopeCid,
    ).toBeUndefined();
  });

  it('fails closed when an Autopilot session lacks runtime attempt identity', async () => {
    const repoDir = makeRepo(workingDir);
    writeFileSync(join(repoDir, 'README.md'), 'before\n');
    commitBase(repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'after\n');

    await expect(
      harvestOutput(workingDir, undefined, autopilotTask()),
    ).rejects.toThrow(/Autopilot runtime attempt identity/);
  });

  it('(a) materializes a jinn-repo-solution.v1 payload from a source-file working-tree change', async () => {
    const repoDir = makeRepo(workingDir);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 1;\n');
    commitBase(repoDir);
    // Solver fixes the source in the working tree (uncommitted, per SKILL).
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 2;\n');

    const out = await harvestOutput(workingDir, undefined, jinnRepoTask());

    expect(out.solutionPayload).toMatchObject({ schemaVersion: 'jinn-repo-solution.v1' });
    const patch = (out.solutionPayload as Record<string, unknown>).patch as string;
    expect(patch).toContain('src/example.ts');
    expect(patch).toContain('value = 1');
    expect(patch).toContain('value = 2');
    const payloadPath = join(workingDir, '.execute', 'solution-payload.json');
    expect(existsSync(payloadPath)).toBe(true);
    expect(JSON.parse(readFileSync(payloadPath, 'utf8'))).toEqual(out.solutionPayload);
  });

  it('(b) strips test-file hunks from the materialized patch', async () => {
    const repoDir = makeRepo(workingDir);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 1;\n');
    writeFileSync(join(repoDir, 'src', 'example.test.ts'), "it('value', () => {});\n");
    commitBase(repoDir);
    // Solver edits source AND tampers with the test file.
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 2;\n');
    writeFileSync(
      join(repoDir, 'src', 'example.test.ts'),
      "it('value', () => {});\nit('tampered', () => {});\n",
    );

    const out = await harvestOutput(workingDir, undefined, jinnRepoTask());

    const patch = (out.solutionPayload as Record<string, unknown>).patch as string;
    expect(patch).toContain('src/example.ts');
    expect(patch).toContain('value = 2');
    expect(patch).not.toContain('example.test.ts');
    expect(patch).not.toContain('tampered');
  });

  it('(c) returns no solution payload for the evaluation role', async () => {
    const repoDir = makeRepo(workingDir);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 1;\n');
    commitBase(repoDir);
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 2;\n');

    // solve-only range: no phase artifacts required, so the only thing under
    // test is whether the materializer emits a solution payload.
    const out = await harvestOutput(workingDir, 'solve-only', jinnRepoTask('evaluation'));

    expect(out.solutionPayload).toBeUndefined();
  });

  it('(d) returns no jinn-repo solution payload for a non-jinn-repo solverType', async () => {
    const repoDir = makeRepo(workingDir);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 1;\n');
    commitBase(repoDir);
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 2;\n');

    const out = await harvestOutput(workingDir, 'solve-only', {
      id: 'task-1',
      description: 'd',
      role: 'restoration',
    } as never);

    // No solverType → the jinn-repo materializer no-ops; the diff is not
    // harvested as a jinn-repo-solution.v1 payload.
    expect(
      (out.solutionPayload as Record<string, unknown> | undefined)?.schemaVersion,
    ).not.toBe('jinn-repo-solution.v1');
  });

  it('(e) returns no solution payload for an empty (no-change) working tree', async () => {
    const repoDir = makeRepo(workingDir);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'example.ts'), 'export const value = 1;\n');
    commitBase(repoDir);
    // No working-tree edits → empty diff.

    const out = await harvestOutput(workingDir, 'solve-only', jinnRepoTask());

    expect(out.solutionPayload).toBeUndefined();
  });
});
