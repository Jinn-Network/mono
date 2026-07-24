import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AutopilotRuntime } from './autopilot-runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The CLI reference in headless-override.md's opening framing line. Swapped
 *  out for non-claude coordinators (see buildHermesHeadlessPrompt). */
const CLAUDE_CLI_TOKEN = '`claude -p` / `--print`';
const CURSOR_CLI_TOKEN = '`agent -p`';

/** The canonical headless-override block, injected into every headless session. */
export function headlessOverride(): string {
  return readFileSync(join(HERE, '..', 'headless-override.md'), 'utf8').trim();
}

/** Render the shared override with runtime-specific CLI framing. */
export function headlessOverrideFor(runtime: AutopilotRuntime): string {
  const block = headlessOverride();
  if (runtime === 'hermes') {
    return block.replace(CLAUDE_CLI_TOKEN, '`hermes chat -q`');
  }
  if (runtime === 'cursor') {
    return block.replace(CLAUDE_CLI_TOKEN, CURSOR_CLI_TOKEN);
  }
  return block;
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

/**
 * Same composition for a `hermes chat -q` coordinator session. The override
 * block's only claude-specific line is its opening framing ("`claude -p` /
 * --print"); every rule in it (decide-don't-ask, always produce the artifact,
 * log decisions, escalate rather than stall) is agent-generic, so it is reused
 * verbatim under a reworded opener. Hermes loads the named skill through its
 * own SKILL.md scanner (`skills.external_dirs`, pointed at the repo's
 * `.claude/skills` by `prepareHermesHome`).
 */
export function buildHermesHeadlessPrompt(skill: string, scenario: string): string {
  return [
    headlessOverrideFor('hermes'),
    '',
    `Use the ${skill} skill for the following task.`,
    '',
    scenario.trim(),
  ].join('\n');
}

/**
 * Same composition for a Cursor `agent -p` coordinator session.
 */
export function buildCursorHeadlessPrompt(skill: string, scenario: string): string {
  return [
    headlessOverrideFor('cursor'),
    '',
    `Use the ${skill} skill for the following task.`,
    '',
    scenario.trim(),
  ].join('\n');
}
