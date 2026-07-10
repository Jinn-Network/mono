import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArmHomes } from '../../src/pilot/arm-homes.js';

function makeSourceHome(): string {
  const src = mkdtempSync(join(tmpdir(), 'arm-homes-src-'));
  for (const file of ['auth.json', 'config.yaml', '.env', 'SOUL.md', 'models_dev_cache.json']) {
    writeFileSync(join(src, file), `${file}-content`);
  }
  // Caches/state that must never reach a built home.
  writeFileSync(join(src, '.skills_prompt_snapshot.json'), '{"stale":"manifest"}');
  writeFileSync(join(src, 'state.db'), 'db');
  mkdirSync(join(src, 'sessions'), { recursive: true });
  writeFileSync(join(src, 'sessions', 'old-session.json'), '{}');
  for (const skill of ['builtin-a', 'builtin-b']) {
    mkdirSync(join(src, 'skills', skill), { recursive: true });
    writeFileSync(join(src, 'skills', skill, 'SKILL.md'), `# ${skill}`);
  }
  // Distilled skills are recognized by their jinn.skill.v1 frontmatter, the
  // way real distillate is marked — NOT by the arms union, so a rerun with a
  // reduced arm set can never misclassify leftover distillate as builtin.
  for (const skill of ['haiku-1', 'haiku-2', 'opus-1']) {
    mkdirSync(join(src, 'skills', skill), { recursive: true });
    writeFileSync(
      join(src, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\nmetadata:\n  jinn:\n    schema: jinn.skill.v1\n---\n# ${skill}`,
    );
  }
  return src;
}

const ARMS = [
  { name: 'stock', skills: [] },
  { name: 'haiku', skills: ['haiku-1', 'haiku-2'] },
  { name: 'opus', skills: ['opus-1'] },
];

describe('buildArmHomes', () => {
  it('builds one isolated home per arm: shared built-ins, only that arm\'s distilled set', () => {
    const src = makeSourceHome();
    const dest = mkdtempSync(join(tmpdir(), 'arm-homes-dest-'));

    const arms = buildArmHomes({ armsFile: ARMS, sourceDir: src, destDir: dest });

    const skillsOf = (arm: string): string[] => readdirSync(join(dest, arm, 'skills')).sort();
    expect(skillsOf('stock')).toEqual(['builtin-a', 'builtin-b']);
    expect(skillsOf('haiku')).toEqual(['builtin-a', 'builtin-b', 'haiku-1', 'haiku-2']);
    expect(skillsOf('opus')).toEqual(['builtin-a', 'builtin-b', 'opus-1']);

    for (const arm of ['stock', 'haiku', 'opus']) {
      for (const file of ['auth.json', 'config.yaml', '.env', 'SOUL.md', 'models_dev_cache.json']) {
        expect(readFileSync(join(dest, arm, file), 'utf-8')).toBe(`${file}-content`);
      }
      // The skills-manifest cache and session/db state must not leak in —
      // a copied snapshot would defeat the isolation entirely.
      expect(existsSync(join(dest, arm, '.skills_prompt_snapshot.json'))).toBe(false);
      expect(existsSync(join(dest, arm, 'sessions'))).toBe(false);
      expect(existsSync(join(dest, arm, 'state.db'))).toBe(false);
    }

    expect(arms).toEqual([
      { name: 'stock', skills: [], jinnAgentHome: join(dest, 'stock') },
      { name: 'haiku', skills: ['haiku-1', 'haiku-2'], jinnAgentHome: join(dest, 'haiku') },
      { name: 'opus', skills: ['opus-1'], jinnAgentHome: join(dest, 'opus') },
    ]);
  });

  it('fails loud when an arm names a skill missing from the source home', () => {
    const src = makeSourceHome();
    const dest = mkdtempSync(join(tmpdir(), 'arm-homes-dest-'));
    expect(() => buildArmHomes({
      armsFile: [{ name: 'haiku', skills: ['haiku-1', 'not-installed'] }],
      sourceDir: src,
      destDir: dest,
    })).toThrow(/not-installed/);
  });

  it('rebuilds a home from scratch on rerun (no stale skills from a previous build)', () => {
    const src = makeSourceHome();
    const dest = mkdtempSync(join(tmpdir(), 'arm-homes-dest-'));
    buildArmHomes({ armsFile: [{ name: 'haiku', skills: ['haiku-1', 'haiku-2'] }], sourceDir: src, destDir: dest });
    buildArmHomes({ armsFile: [{ name: 'haiku', skills: ['haiku-1'] }], sourceDir: src, destDir: dest });
    expect(readdirSync(join(dest, 'haiku', 'skills')).sort()).toEqual(['builtin-a', 'builtin-b', 'haiku-1']);
  });
});
