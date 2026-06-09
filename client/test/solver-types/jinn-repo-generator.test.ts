import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeJinnRepoGenerator } from '../../src/solver-types/jinn-repo-auto.js';
import type { JinnRepoPoolItem } from '../../src/solver-types/_jinn-repo-pool.js';

function poolItem(n: number): JinnRepoPoolItem {
  return {
    schemaVersion: 'jinn-repo.v1',
    instance_id: `jinn__mono-${n}`,
    repo: 'Jinn-Network/mono',
    base_commit: 'a'.repeat(40),
    merged_pr: 1000 + n,
    language: 'typescript',
    problem_statement: `Fix bug number ${n}`,
    test_files: [`test/bug-${n}.test.ts`],
    test_cmd: `yarn vitest run test/bug-${n}.test.ts`,
    gold_tests: { [`test/bug-${n}.test.ts`]: 'expect(true).toBe(true)' },
    solution_patch: `--- a/src/bug-${n}.ts\n+++ b/src/bug-${n}.ts\n`,
  };
}

async function writeSlate(dir: string, version: string, instanceIds: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const artifact = {
    schemaVersion: 'held-out-slate.v1',
    solverType: 'jinn-repo.v1',
    version,
    generatedAt: new Date().toISOString(),
    instanceIds,
  };
  await writeFile(join(dir, `held-out-slate.jinn-repo.${version}.json`), JSON.stringify(artifact));
}

describe('makeJinnRepoGenerator', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'jinn-repo-gen-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('(a) no slate → whole pool is train; emits leak-controlled restoration tasks', async () => {
    const pool = [poolItem(1), poolItem(2), poolItem(3)];
    const gen = makeJinnRepoGenerator({ stateDir, loadPool: () => pool });
    const tasks = await gen();
    expect(tasks).not.toBeNull();
    expect(tasks!.length).toBe(3);
    for (const task of tasks!) {
      expect(task.solverType).toBe('jinn-repo.v1');
      expect(task.role).toBe('restoration');
      expect(task.contractId).toBe('jinn-repo');
      expect(task.contractVersion).toBe('v1');
      // Leak control: solver-visible spec only — no evaluator-side secrets.
      expect(task.spec).not.toHaveProperty('gold_tests');
      expect(task.spec).not.toHaveProperty('solution_patch');
      expect(task.spec).not.toHaveProperty('test_files');
      expect(task.spec).not.toHaveProperty('test_cmd');
      expect(task.spec).toHaveProperty('problem_statement');
      expect(task.eligibility).toHaveProperty('instance_id');
    }
  });

  it('(b) second tick (state persisted, target 1) returns null', async () => {
    const pool = [poolItem(1), poolItem(2), poolItem(3)];
    const make = () => makeJinnRepoGenerator({ stateDir, loadPool: () => pool, targetSuccessesPerInstance: 1 });
    expect((await make()())!.length).toBe(3);
    expect(await make()()).toBeNull();
  });

  it('(c) maxPerTick:2 with 3 items → 2, then 1, then null', async () => {
    const pool = [poolItem(1), poolItem(2), poolItem(3)];
    const make = () => makeJinnRepoGenerator({ stateDir, loadPool: () => pool, maxPerTick: 2 });
    expect((await make()())!.length).toBe(2);
    expect((await make()())!.length).toBe(1);
    expect(await make()()).toBeNull();
  });

  it('(d) slate excludes 1 instance → never emitted', async () => {
    const slateDir = join(stateDir, 'slates');
    await writeSlate(slateDir, 'v1', ['jinn__mono-2']);
    const pool = [poolItem(1), poolItem(2), poolItem(3)];
    const gen = makeJinnRepoGenerator({ stateDir, loadPool: () => pool, slateDir });
    const tasks = await gen();
    expect(tasks!.length).toBe(2);
    const ids = tasks!.map((t) => (t.eligibility as { instance_id: string }).instance_id);
    expect(ids).not.toContain('jinn__mono-2');
    expect(ids).toEqual(['jinn__mono-1', 'jinn__mono-3']);
  });

  it('(e) solverNetManifestCid is threaded onto every emitted Task', async () => {
    const pool = [poolItem(1), poolItem(2)];
    const gen = makeJinnRepoGenerator({
      stateDir,
      loadPool: () => pool,
      solverNetManifestCid: 'bafyTestManifestCid',
    });
    const tasks = await gen();
    for (const task of tasks!) {
      expect(task.solverNetManifestCid).toBe('bafyTestManifestCid');
    }
  });
});
