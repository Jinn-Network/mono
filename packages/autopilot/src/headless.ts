import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The canonical headless-override block, injected into every headless session. */
export function headlessOverride(): string {
  return readFileSync(join(HERE, '..', 'headless-override.md'), 'utf8').trim();
}

/** Compose a headless prompt: the override block, then a skill invocation, then the scenario. */
export function buildHeadlessPrompt(skill: string, scenario: string): string {
  return [
    headlessOverride(),
    '',
    `Use the ${skill} skill for the following task.`,
    '',
    scenario.trim(),
  ].join('\n');
}
