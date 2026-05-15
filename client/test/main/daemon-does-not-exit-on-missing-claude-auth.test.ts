import { describe, expect, it } from 'vitest';

/**
 * Regression test for vh74.2 Task A7: remove the daemon-level Claude auth gate.
 *
 * Before the cutover, `claude-required.ts` existed and `main.ts` imported
 * `configRequiresClaudeAuth` from it, calling `process.exit(11)` when auth
 * was missing.  After the cutover both the source file and the import are gone.
 *
 * This test asserts the post-cutover state: the module no longer resolves.
 * It intentionally fails before the deletion (module resolves fine) and passes
 * after (module is absent).
 */
describe('daemon-level Claude auth gate (vh74.2 cutover)', () => {
  it('claude-required.ts no longer exists — the daemon-level gate is removed', async () => {
    await expect(
      import('../../src/preflight/claude-required.js'),
    ).rejects.toThrow();
  });
});
