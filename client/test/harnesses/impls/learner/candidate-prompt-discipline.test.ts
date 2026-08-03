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
  { name: 'cd into IMPL_STATE_DIR', pattern: /cd\s+"?\$\{?IMPL_STATE_DIR/ },
  { name: 'an IMPL_STATE_DIR shell binding', pattern: /IMPL_STATE_DIR="/ },
  { name: 'git -C against IMPL_STATE_DIR', pattern: /git\s+-C\s+"?\$\{?IMPL_STATE_DIR/ },
  { name: 'a shell path under $IMPL_STATE_DIR/', pattern: /\$\{?IMPL_STATE_DIR\}?\// },
  { name: 'write/commit verb aimed at implStateDir', pattern: /(?:write|writes|commit|commits|mutate|mutates|modify|modifies)\s+(?:directly\s+)?(?:into|to|on)\s+`?implStateDir/i },
];

/**
 * A line that *forbids* writing to the active directory is the opposite of a
 * write instruction, and these prompts deliberately contain several. Scan line
 * by line and skip the prohibitions rather than trying to express "not preceded
 * by a negation" inside each pattern.
 *
 * A bare `not` is deliberately NOT in this list. It matched far too much
 * ordinary prose ("does not change the next run's prompts", "if the skill is
 * not present"), so any real write instruction sharing a line with an incidental
 * "not" was skipped unexamined — the exemption was wider than the rule. Each
 * alternative below has to be an explicit prohibition on its own.
 */
const PROHIBITION = /\b(?:never|read-only|forbidden|do NOT|must not|rather than|instead of)\b/i;

function writeInstructionLines(text: string): string[] {
  return text.split('\n').filter((line) => !PROHIBITION.test(line));
}

/** True when any pattern fires on any non-prohibition line — the guard's verdict. */
function guardFlags(text: string): boolean {
  const lines = writeInstructionLines(text);
  return ACTIVE_DIR_WRITE_PATTERNS.some(({ pattern }) => lines.some((line) => pattern.test(line)));
}

/**
 * The review's missed-fixture set: write instructions the first version of this
 * guard let through. Every entry must be caught.
 */
const MUST_BE_CAUGHT: readonly { name: string; line: string }[] = [
  { name: 'git -C with a bare var', line: 'git -C $IMPL_STATE_DIR add -A' },
  { name: 'git -C quoted', line: 'git -C "$IMPL_STATE_DIR" commit -m improve' },
  { name: 'git -C braced', line: 'git -C "${IMPL_STATE_DIR}" revert abc123' },
  { name: 'cd unquoted', line: 'cd $IMPL_STATE_DIR' },
  { name: 'cd braced', line: 'cd "${IMPL_STATE_DIR}"' },
  { name: 'shell path under the var', line: 'echo hi > $IMPL_STATE_DIR/notes/lesson.md' },
  { name: 'braced shell path', line: 'mkdir -p "${IMPL_STATE_DIR}/skills/new"' },
];

/** Prose that must NOT trip the guard, or the rule becomes unusable. */
const MUST_NOT_BE_CAUGHT: readonly { name: string; line: string }[] = [
  { name: 'a record field name', line: '  "implStateDirShaAfter": "<git rev-parse HEAD post-commit>",' },
  { name: 'an explicit prohibition', line: '- Never write outside `stateDir/**`, and never write to `implStateDir`' },
  { name: 'a read-only declaration', line: '- `implStateDir` — read-only in candidate mode' },
  { name: 'the resolved write target', line: 'STATE_DIR="<stateDir from spawn input>"' },
  { name: 'an incidental "not" beside no write', line: 'That does not change the next run behaviour.' },
];

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

  it('SKILL.md refuses to fall back to the active directory when the candidate dir is unset', () => {
    // The fallback class the grep cannot see: `STATE_DIR="$JINN_LEARNER_CANDIDATE_DIR"`
    // with the variable unset expands to empty, and every downstream write then
    // lands somewhere unintended rather than failing.
    const text = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(text).toContain('${JINN_LEARNER_CANDIDATE_DIR:?candidate dir unset}');
    expect(text).toContain('Never fall back to `implStateDir`');
    expect(text).toMatch(/workingDir\/\.errors\/candidate\.json/);
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

  // The guard is only worth its green tick if it fails on the things it exists
  // to catch. These self-tests are the C4 mirror-guard precedent: assert the
  // detector against known-bad and known-good input, so a future "simplification"
  // of the patterns cannot quietly turn the guard into a no-op.
  describe('the guard itself', () => {
    it.each(MUST_BE_CAUGHT)('flags $name', ({ line }) => {
      expect(guardFlags(line)).toBe(true);
    });

    it.each(MUST_NOT_BE_CAUGHT)('does not flag $name', ({ line }) => {
      expect(guardFlags(line)).toBe(false);
    });

    it('flags a pre-C6-shaped prompt excerpt', () => {
      // A verbatim excerpt of the promoter prompt as it stood before this unit.
      // Held as a literal rather than read from git history: a fixture that
      // resolves through `git show HEAD:` changes meaning the moment this commit
      // lands, which is precisely when the guard needs to stay pinned.
      const preC6 = [
        '## Action surface (in increasing risk order)',
        '',
        '1. **Skill edits** — modify `implStateDir/skills/<name>/SKILL.md`',
        '',
        'Allowed write paths: `implStateDir/**`, `workingDir/.improve/**`.',
        '',
        '```bash',
        'IMPL_STATE_DIR="<implStateDir from spawn input>"',
        'cd "$IMPL_STATE_DIR"',
        'git add -A',
        '```',
      ].join('\n');
      expect(guardFlags(preC6)).toBe(true);
    });
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
