// Usage: yarn tsx scripts/skills-bench/pin-skill.ts --name tdd \
//          --source https://github.com/mattpocock/skills --commit <sha> \
//          --skill-path skills/tdd [--dest ../bench/skills-under-test]
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { pinSkill } from '../../src/skills-bench/skill-pin.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pin = await pinSkill({
  name: arg('name'),
  source: arg('source'),
  commit: arg('commit'),
  skillPath: arg('skill-path'),
  destRoot: resolve(arg('dest', join(repoRoot, 'bench', 'skills-under-test'))),
});
console.log(JSON.stringify(pin, null, 2));
