import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pinSkill } from '../../src/skills-bench/skill-pin.js';

const exec = promisify(execFile);

async function makeFixtureRepo(): Promise<{ repoDir: string; commit: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), 'skill-fixture-'));
  await exec('git', ['init', '-q'], { cwd: repoDir });
  await exec('git', ['-C', repoDir, 'config', 'user.email', 't@t'], {});
  await exec('git', ['-C', repoDir, 'config', 'user.name', 't'], {});
  await mkdir(join(repoDir, 'skills', 'tdd'), { recursive: true });
  await writeFile(
    join(repoDir, 'skills', 'tdd', 'SKILL.md'),
    '---\nname: tdd\ndescription: Test-driven development workflow. Use when implementing features.\nlicense: MIT\n---\n\nBody.\n',
  );
  await exec('git', ['-C', repoDir, 'add', '-A'], {});
  await exec('git', ['-C', repoDir, 'commit', '-q', '-m', 'fixture'], {});
  const { stdout } = await exec('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {});
  return { repoDir, commit: stdout.trim() };
}

describe('pinSkill', () => {
  it('vendors the skill dir at the pinned commit and writes pin.json', async () => {
    const { repoDir, commit } = await makeFixtureRepo();
    const destRoot = await mkdtemp(join(tmpdir(), 'pins-'));
    const pin = await pinSkill({
      name: 'tdd',
      source: repoDir,        // local path or git URL — both go through `git clone`
      commit,
      skillPath: 'skills/tdd',
      destRoot,
    });
    expect(pin.commit).toBe(commit);
    expect(pin.license).toBe('MIT');
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(destRoot, 'tdd', 'SKILL.md'))).toBe(true);
    const onDisk = JSON.parse(await readFile(join(destRoot, 'tdd', 'pin.json'), 'utf8'));
    expect(onDisk.commit).toBe(commit);
  });

  it('fails loud when the skill path is missing at the commit', async () => {
    const { repoDir, commit } = await makeFixtureRepo();
    const destRoot = await mkdtemp(join(tmpdir(), 'pins-'));
    await expect(
      pinSkill({ name: 'nope', source: repoDir, commit, skillPath: 'skills/nope', destRoot }),
    ).rejects.toThrow(/skills\/nope/);
  });

  it('resolves a branch name to its 40-hex commit sha rather than recording the branch name', async () => {
    const { repoDir, commit } = await makeFixtureRepo();
    const { stdout } = await exec('git', ['-C', repoDir, 'branch', '--show-current'], {});
    const branch = stdout.trim();
    expect(branch).not.toBe(''); // sanity: fixture repo must be on a named branch
    const destRoot = await mkdtemp(join(tmpdir(), 'pins-'));
    const pin = await pinSkill({
      name: 'tdd',
      source: repoDir,
      commit: branch,
      skillPath: 'skills/tdd',
      destRoot,
    });
    expect(pin.commit).toBe(commit);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.commit).not.toBe(branch);
  });
});
