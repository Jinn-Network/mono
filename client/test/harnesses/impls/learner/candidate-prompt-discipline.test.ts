/**
 * C6 acceptance — grep-level check that no prompt file instructs mid-run
 * mutation of the ACTIVE `implStateDir` under candidate mode.
 *
 * This is a prompt-surface regression test, and it is deliberately mechanical.
 * The behavioural guarantee (the active directory stays byte-identical) is
 * proved by `candidate-mode.test.ts` through the freeze-fence. But the fence
 * catches a violation *after* it happens, at the cost of a discarded run — the
 * prompts are what stop it happening. A future edit that reintroduces
 * "write to implStateDir" into the promoter or consolidator would keep every
 * behavioural test green while quietly making every candidate run fail against
 * a real model.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../plugins/learner');
const SKILL_DIR = join(PLUGIN_ROOT, 'skills', 'learn');

/** The two roles that write. Everything else in the pipeline is read-only by contract. */
const WRITING_ROLE_PROMPTS = ['promoter-prompt.md', 'consolidator-prompt.md'];

/**
 * Write-instruction shapes naming the active directory. `implStateDirSha*` are
 * promotion/consolidation record FIELD names (historical, deliberately stable)
 * and are not write instructions, so the patterns below require a path
 * separator or an explicit verb rather than matching the bare identifier.
 */
const ACTIVE_DIR_WRITE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a path under implStateDir/', pattern: /implStateDir\/(?!\*\*`\))[A-Za-z.<]/ },
  { name: 'cd into IMPL_STATE_DIR', pattern: /cd "\$IMPL_STATE_DIR"/ },
  { name: 'an IMPL_STATE_DIR shell binding', pattern: /IMPL_STATE_DIR="/ },
  { name: 'write/commit verb aimed at implStateDir', pattern: /(?:write|writes|commit|commits|mutate|mutates|modify|modifies)\s+(?:directly\s+)?(?:into|to|on)\s+`?implStateDir/i },
];

/**
 * A line that *forbids* writing to the active directory is the opposite of a
 * write instruction, and these prompts deliberately contain several. Scan line
 * by line and skip the prohibitions rather than trying to express "not preceded
 * by a negation" inside each pattern.
 */
const PROHIBITION = /\b(?:never|not|no longer|read-only|forbidden|instead of|rather than|do NOT)\b/i;

function writeInstructionLines(text: string): string[] {
  return text.split('\n').filter((line) => !PROHIBITION.test(line));
}

describe('candidate mode — prompt write-path discipline', () => {
  it.each(WRITING_ROLE_PROMPTS)('%s issues no write instruction naming the active implStateDir', (file) => {
    const lines = writeInstructionLines(readFileSync(join(SKILL_DIR, file), 'utf-8'));
    for (const { name, pattern } of ACTIVE_DIR_WRITE_PATTERNS) {
      const offending = lines.find((line) => pattern.test(line));
      expect(
        offending ?? null,
        `${file} contains ${name} — write instructions must name stateDir`,
      ).toBeNull();
    }
  });

  it.each(WRITING_ROLE_PROMPTS)('%s names stateDir as its write target', (file) => {
    const text = readFileSync(join(SKILL_DIR, file), 'utf-8');
    expect(text).toMatch(/`stateDir`/);
    expect(text).toMatch(/candidate/i);
  });

  it('the promoter allowlist permits stateDir and not the active directory', () => {
    const text = readFileSync(join(SKILL_DIR, 'promoter-prompt.md'), 'utf-8');
    expect(text).toContain(
      'Allowed write paths: `stateDir/**`, `workingDir/.improve/**`, `workingDir/.operator-requests/**`.',
    );
  });

  it('SKILL.md defines the write target for all three modes', () => {
    const text = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(text).toContain('### Write target');
    expect(text).toMatch(/\|\s*`train`\s*\|\s*`implStateDir`/);
    expect(text).toMatch(/\|\s*`candidate`\s*\|\s*`candidateStateDir`/);
    // Candidate mode runs the self-improving phases; only frozen skips them.
    expect(text).toContain('Run this section when `mode = train` or `mode = candidate`');
  });

  it('the session-start hook steers candidate mode away from the active directory', () => {
    const hook = readFileSync(join(PLUGIN_ROOT, 'hooks', 'session-start'), 'utf-8');
    expect(hook).toContain('JINN_HARNESS_MODE:-train}" == "candidate"');
    expect(hook).toContain('implStateDir is READ-ONLY for this entire run');
    expect(hook).toContain('JINN_LEARNER_CANDIDATE_DIR');
  });

  it('every prompt in the skill directory is valid UTF-8 with no mojibake', () => {
    // Cheap tripwire: bulk prompt edits are easy to corrupt, and a mangled
    // em-dash survives every behavioural test while degrading the prompt.
    for (const file of readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(join(SKILL_DIR, file), 'utf-8');
      expect(text, `${file} contains mojibake`).not.toMatch(/[ÂÃ][-¿]/u);
    }
  });
});
