import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve(import.meta.dirname, 'sync-skills.sh');
const repoRoot = resolve(import.meta.dirname, '..');
const MIRRORS = ['.agents/skills', '.cursor/skills', '.codex/skills'];
const REL = '../../.claude/skills';

function run(root, args = []) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SYNC_SKILLS_ROOT: root },
  });
}

function writeSkill(root, name, body = `---\nname: ${name}\ndescription: test\n---\n`) {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

function fixture(names = ['eng-day', 'implement-issue']) {
  const root = mkdtempSync(join(tmpdir(), 'sync-skills-'));
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'README.md'), 'canonical only\n');
  mkdirSync(join(root, '.claude', 'skills', 'not-a-skill'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'not-a-skill', 'notes.md'), 'no SKILL.md\n');
  for (const name of names) writeSkill(root, name);
  return root;
}

function mirrorLink(root, mirror, name) {
  return join(root, mirror, name);
}

test('write mirrors canonical skills into .agents, .cursor, and .codex', () => {
  const root = fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const mirror of MIRRORS) {
      for (const name of ['eng-day', 'implement-issue']) {
        const link = mirrorLink(root, mirror, name);
        assert.ok(lstatSync(link).isSymbolicLink(), `${link} must be a symlink`);
        assert.equal(readlinkSync(link), `${REL}/${name}`);
      }
      assert.equal(existsSync(mirrorLink(root, mirror, 'not-a-skill')), false);
      assert.equal(existsSync(mirrorLink(root, mirror, 'README.md')), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write is idempotent', () => {
  const root = fixture();
  try {
    assert.equal(run(root).status, 0);
    const first = run(root);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const check = run(root, ['--check']);
    assert.equal(check.status, 0, check.stderr || check.stdout);
    for (const mirror of MIRRORS) {
      assert.equal(readlinkSync(mirrorLink(root, mirror, 'eng-day')), `${REL}/eng-day`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write prunes stale extra entries', () => {
  const root = fixture(['eng-day']);
  try {
    assert.equal(run(root).status, 0);
    const stale = mirrorLink(root, '.agents/skills', 'cluster-model');
    symlinkSync(`${REL}/cluster-model`, stale);
    assert.equal(existsSync(stale) || lstatSync(stale).isSymbolicLink(), true);
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(stale), false);
    assert.ok(lstatSync(mirrorLink(root, '.agents/skills', 'eng-day')).isSymbolicLink());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check fails when .agents/skills is missing', () => {
  const root = fixture();
  try {
    const result = run(root, ['--check']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /drift/i);
    assert.equal(existsSync(join(root, '.agents')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check fails on extra, missing, and wrong-target drift without writing', () => {
  const root = fixture(['eng-day', 'implement-issue']);
  try {
    assert.equal(run(root).status, 0);

    const extra = mirrorLink(root, '.codex/skills', 'stale-skill');
    symlinkSync(`${REL}/stale-skill`, extra);
    const extraResult = run(root, ['--check']);
    assert.notEqual(extraResult.status, 0);
    assert.match(extraResult.stderr, /stale-skill/);
    assert.ok(lstatSync(extra).isSymbolicLink(), '--check must not prune');

    rmSync(extra);
    rmSync(mirrorLink(root, '.agents/skills', 'implement-issue'));
    const missingResult = run(root, ['--check']);
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /implement-issue/);
    assert.equal(existsSync(mirrorLink(root, '.agents/skills', 'implement-issue')), false);

    rmSync(mirrorLink(root, '.cursor/skills', 'eng-day'));
    symlinkSync('../../wrong/eng-day', mirrorLink(root, '.cursor/skills', 'eng-day'));
    const wrongResult = run(root, ['--check']);
    assert.notEqual(wrongResult.status, 0);
    assert.match(wrongResult.stderr, /eng-day/);
    assert.equal(readlinkSync(mirrorLink(root, '.cursor/skills', 'eng-day')), '../../wrong/eng-day');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check fails when a non-symlink occupies a skill name', () => {
  const root = fixture(['eng-day']);
  try {
    assert.equal(run(root).status, 0);
    const occupied = mirrorLink(root, '.agents/skills', 'eng-day');
    rmSync(occupied);
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'SKILL.md'), 'forked body\n');
    const result = run(root, ['--check']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a symlink/);
    assert.equal(lstatSync(occupied).isDirectory(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown arguments exit 2 and do not write', () => {
  const root = fixture();
  try {
    const result = run(root, ['--please-sync']);
    assert.equal(result.status, 2);
    assert.equal(existsSync(join(root, '.agents')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the checked-in worktree mirrors match the canonical set', () => {
  const result = spawnSync('bash', [script, '--check'], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('write replaces a forked directory with the canonical symlink', () => {
  const root = fixture(['eng-day']);
  try {
    mkdirSync(join(root, '.agents', 'skills', 'eng-day'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'eng-day', 'SKILL.md'), 'do not fork\n');
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const link = mirrorLink(root, '.agents/skills', 'eng-day');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), `${REL}/eng-day`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
