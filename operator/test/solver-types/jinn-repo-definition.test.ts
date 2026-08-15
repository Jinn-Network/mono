import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLVER_TYPES } from '../../src/solver-types/index.js';
import { SOLVER_TYPE_PAYLOADS } from '../../src/types/payloads/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const validJinnRepoTask = {
  schemaVersion: 'jinn-repo.v1',
  instance_id: 'jinn-network__mono-1109',
  repo: 'Jinn-Network/mono',
  base_commit: '0'.repeat(40),
  merged_pr: 1109,
  language: 'typescript',
  problem_statement: 'Fix the thing.',
  test_files: ['operator/test/foo.test.ts'],
  test_cmd: 'yarn vitest run operator/test/foo.test.ts',
};

const validLiveIssueTask = {
  schemaVersion: 'jinn-repo.v1',
  source: 'live-issue' as const,
  instance_id: 'jinn-network__mono-1889',
  repo: 'Jinn-Network/mono',
  base_commit: '0'.repeat(40),
  language: 'typescript',
  problem_statement: 'Live issue: fix the thing.',
  issue_number: 1889,
};

/**
 * Reproduces the `--spec-file` wrapper `jinn tasks submit` builds around a
 * raw JSON file (operator/src/cli/commands/tasks.ts) — the raw file's
 * top-level fields, plus `id`/`description`/`solverType`/`spec`, are merged
 * before being handed to `parseSpec`. jinn-repo fixtures are flat (unlike
 * prediction.v1's nested `spec`), so `raw['spec']` is absent and `rawSpec`
 * resolves to `{}` here.
 */
function simulateSpecFileWrapper(raw: Record<string, unknown>): Record<string, unknown> {
  const solverTypeStr = typeof raw['solverType'] === 'string' ? raw['solverType'] : undefined;
  return {
    id: 'cli-submitted-task',
    description: 'CLI-submitted task',
    ...raw,
    solverType: solverTypeStr,
    spec: {},
  };
}

describe('jinn-repo SolverTypeDefinition registration', () => {
  it('is registered in SOLVER_TYPES under "jinn-repo.v1"', () => {
    const def = SOLVER_TYPES['jinn-repo.v1'];
    expect(def).toBeDefined();
    expect(def.solverType).toBe('jinn-repo.v1');
  });

  it('parseSpec resolves a valid merged-pr task into .spec', async () => {
    const overlay = await SOLVER_TYPES['jinn-repo.v1'].parseSpec(validJinnRepoTask);
    expect(overlay.spec).toMatchObject({ instance_id: 'jinn-network__mono-1109', source: 'merged-pr' });
  });

  it('parseSpec resolves a valid live-issue task into .spec', async () => {
    const overlay = await SOLVER_TYPES['jinn-repo.v1'].parseSpec(validLiveIssueTask);
    expect(overlay.spec).toMatchObject({
      instance_id: 'jinn-network__mono-1889',
      source: 'live-issue',
      issue_number: 1889,
    });
  });

  it('parseSpec rejects a live-issue task missing issue_number', async () => {
    const { issue_number: _issue_number, ...missing } = validLiveIssueTask;
    await expect(SOLVER_TYPES['jinn-repo.v1'].parseSpec(missing)).rejects.toThrow();
  });

  it('the shipped jinn-repo-live-issue-task.example.json fixture posts via the --spec-file wrapper (AC1)', async () => {
    const fixturePath = join(__dirname, '../../fixtures/jinn-repo-live-issue-task.example.json');
    const raw = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
    const parserInput = simulateSpecFileWrapper(raw);
    const overlay = await SOLVER_TYPES['jinn-repo.v1'].parseSpec(parserInput);
    expect(overlay.spec).toMatchObject({
      source: 'live-issue',
      instance_id: 'Jinn-Network__mono-1889',
      issue_number: 1889,
    });
  });

  it('buildGenerator yields a real generator (G4); empty train split yields no tasks', async () => {
    const def = SOLVER_TYPES['jinn-repo.v1'];
    expect(def.buildGenerator).toBeDefined();
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-repo-def-'));
    try {
      const gen = def.buildGenerator!({ stateDir, loadPool: () => [] });
      await expect(gen()).resolves.toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('SOLVER_TYPE_PAYLOADS["jinn-repo.v1"].solution parses a valid solution payload', () => {
    const schema = SOLVER_TYPE_PAYLOADS['jinn-repo.v1']?.solution;
    expect(schema).toBeDefined();
    expect(() =>
      schema!.parse({ schemaVersion: 'jinn-repo-solution.v1', patch: 'diff ...' }),
    ).not.toThrow();
  });
});
