import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PressureCase } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', 'pressure-tests');

/** Each pressure-test directory name maps to its full skill identifier. */
const SKILL_ID: Record<string, string> = {
  brainstorming: 'superpowers:brainstorming',
  'writing-plans': 'superpowers:writing-plans',
  'test-driven-development': 'superpowers:test-driven-development',
  'executing-plans': 'superpowers:executing-plans',
  'verification-before-completion': 'superpowers:verification-before-completion',
  'requesting-code-review': 'superpowers:requesting-code-review',
};

/** Discover every scenario `.md` under the pressure-tests tree. */
export function discoverCases(): PressureCase[] {
  const cases: PressureCase[] = [];
  for (const dir of Object.keys(SKILL_ID)) {
    const dirPath = join(ROOT, dir);
    if (!existsSync(dirPath)) continue;
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.md')) continue;
      const scenario = readFileSync(join(dirPath, file), 'utf8');
      cases.push({
        skill: SKILL_ID[dir]!,
        scenarioName: file.replace(/\.md$/, ''),
        scenario,
        // The scenario states its expected deliverable; the check looks for a
        // file under the named directory created during the run.
        deliverableCheck: (cwd) => deliverableExists(scenario, cwd),
      });
    }
  }
  return cases;
}

/** True if the scenario's "Expected deliverable" directory gained a file. */
function deliverableExists(scenario: string, cwd: string): boolean {
  const m = scenario.match(/Expected deliverable:[^`]*`([^`]+)`/);
  if (!m) return false;
  const target = join(cwd, m[1]!);
  if (existsSync(target) && !target.endsWith('/')) return true;
  // Directory form: deliverable is "a file under <dir>/".
  const dir = target.replace(/\/$/, '');
  return existsSync(dir) && readdirSync(dir).length > 0;
}
