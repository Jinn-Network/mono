import { describe, it, expect, vi } from 'vitest';
import { assertReviewIdentities, sessionSpawnEnv } from '../../src/dispatcher/identity.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

/** A runner that resolves `gh api user` to a login keyed by the GH_TOKEN env. */
function loginRunner(byToken: Record<string, string>): CommandRunner {
  return async (_cmd, _args, opts) => `${byToken[opts?.env?.GH_TOKEN ?? ''] ?? ''}\n`;
}

describe('sessionSpawnEnv', () => {
  it('always disables the print-mode background-wait ceiling (0 = wait indefinitely)', () => {
    // Without this the spawned `claude -p` self-terminates once its background
    // subagents pass the 600s default, stranding committed-but-unpushed work.
    expect(sessionSpawnEnv('').env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('0');
    expect(sessionSpawnEnv('tok').env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('0');
  });

  it('inherits the ambient gh account (no GH_TOKEN) when the token is empty', () => {
    const e = sessionSpawnEnv('');
    expect(e.env?.GH_TOKEN).toBeUndefined();
    expect(e.env?.PATH).toBe(process.env.PATH); // ambient preserved
  });

  it('overlays GH_TOKEN (preserving ambient env) when a token is set', () => {
    const e = sessionSpawnEnv('tok-abc');
    expect(e.env?.GH_TOKEN).toBe('tok-abc');
    expect(e.env?.PATH).toBe(process.env.PATH); // ambient preserved
  });
});

describe('assertReviewIdentities', () => {
  const enabled = { ...DEFAULT_CONFIG, reviewBotLogin: 'jinn-review-bot', implGhToken: 'i', reviewGhToken: 'r' };

  it('is a no-op when the review loop is disabled (reviewBotLogin empty)', async () => {
    await expect(
      assertReviewIdentities({ ...DEFAULT_CONFIG, reviewBotLogin: '' }, loginRunner({})),
    ).resolves.toBeUndefined();
  });

  it('throws when review is enabled but the reviewer token is missing', async () => {
    await expect(
      assertReviewIdentities({ ...enabled, reviewGhToken: '' }, loginRunner({})),
    ).rejects.toThrow(/JINN_REVIEW_GH_TOKEN/);
  });

  it('throws when review is enabled but the implementer token is missing', async () => {
    await expect(
      assertReviewIdentities({ ...enabled, implGhToken: '' }, loginRunner({})),
    ).rejects.toThrow(/JINN_IMPL_GH_TOKEN/);
  });

  it('throws when the reviewer token does not resolve to reviewBotLogin (detection would never match)', async () => {
    const runner = loginRunner({ r: 'someone-else', i: 'jinn-impl-bot' });
    await expect(assertReviewIdentities(enabled, runner)).rejects.toThrow(/never match/);
  });

  it('throws when implementer and reviewer are the same account (self-approval)', async () => {
    const runner = loginRunner({ r: 'jinn-review-bot', i: 'jinn-review-bot' });
    await expect(assertReviewIdentities(enabled, runner)).rejects.toThrow(/self-approval|same account/);
  });

  it('passes when reviewer matches reviewBotLogin and differs from the implementer', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = loginRunner({ r: 'jinn-review-bot', i: 'jinn-impl-bot' });
    await expect(assertReviewIdentities(enabled, runner)).resolves.toBeUndefined();
    logSpy.mockRestore();
  });

  it('matches the reviewer login case-insensitively (GitHub logins are case-folded)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // token resolves to a differently-cased spelling of reviewBotLogin
    const runner = loginRunner({ r: 'Jinn-Review-Bot', i: 'jinn-impl-bot' });
    await expect(assertReviewIdentities(enabled, runner)).resolves.toBeUndefined();
    logSpy.mockRestore();
  });
});
