import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_PATH = join(__dirname, '../../src/main.ts');

/**
 * Regression test for vh74.2 Task A7: remove the daemon-level Claude auth gate.
 *
 * Before the cutover, `claude-required.ts` existed and `main.ts` imported
 * `configRequiresClaudeAuth` from it, calling `process.exit(11)` when auth
 * was missing.  After the cutover both the source file and the import are gone.
 *
 * Two assertions:
 *  1. Structural: the deleted gate module no longer resolves.
 *  2. Source-textual: main.ts contains none of the deleted gate's identifiers or
 *     exit patterns. This catches a future-regression-via-new-filename: if a
 *     developer re-introduces a daemon-level Claude auth gate in main.ts under
 *     any naming, this test catches it.
 */
describe('daemon does not exit on missing Claude auth (vh74.2 cutover regression)', () => {
  // Structural: the deleted gate module is gone.
  it('claude-required module is no longer importable', async () => {
    await expect(import('../../src/preflight/claude-required.js')).rejects.toThrow();
  });

  // Behavioral-flavor: main.ts source has no daemon-level claude-auth exit gate.
  // Catches future-regression-via-new-filename: if a developer re-introduces
  // an auth gate in main.ts under any naming, this test catches it as long as
  // the new gate touches the same surface (process.exit on claude auth check).
  it('main.ts contains no daemon-level Claude auth exit gate', () => {
    const source = readFileSync(MAIN_PATH, 'utf8');

    // No imports from the deleted module.
    expect(source).not.toMatch(/from\s+['"][^'"]*claude-required['"]/);
    expect(source).not.toMatch(/configRequiresClaudeAuth/);

    // No invalid_invocation envelope with field: 'claude_auth' (the deleted
    // gate's signature error shape).
    const stripped = source.replace(/\s+/g, ' ');
    expect(stripped).not.toMatch(/field:\s*['"]claude_auth['"]/);

    // No process.exit(11) within ~500 chars of a 'claude' string in the same
    // file (heuristic for a Claude-specific exit gate). This is a structural
    // safeguard, not a full behavioral test — the per-harness readiness
    // composition (A2 + A5) covers the runtime invariant.
    const claudeExitPattern = /claude[\s\S]{0,500}process\.exit\(\s*11\s*\)/;
    const exitClaudePattern = /process\.exit\(\s*11\s*\)[\s\S]{0,500}claude/;
    expect(source).not.toMatch(claudeExitPattern);
    expect(source).not.toMatch(exitClaudePattern);
  });
});
