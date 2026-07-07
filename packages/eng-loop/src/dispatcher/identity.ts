import type { CommandRunner } from './issue-source.js';
import type { DispatcherConfig } from './types.js';

/**
 * Spawn-opts overlay that makes a session authenticate as a specific GitHub
 * identity (DR-2026-06-15). Returns `{ env: { ...process.env, GH_TOKEN } }`
 * when a token is given, or `{}` (inherit the ambient `gh` account) when it is
 * empty. Spread into the `spawn` opts; the production spawn lambda forwards
 * `env` to Node's `child_process.spawn`.
 */
export function sessionTokenEnv(token: string): { env?: NodeJS.ProcessEnv } {
  if (!token) return {};
  return { env: { ...process.env, GH_TOKEN: token } };
}

async function resolveLogin(runner: CommandRunner, token: string): Promise<string> {
  const out = await runner('gh', ['api', 'user', '--jq', '.login'], { env: { GH_TOKEN: token } });
  return out.trim();
}

/**
 * Fail-loud boot check for the dual-identity review loop (DR-2026-06-15, gate 5).
 *
 * No-op when the review loop is disabled (`reviewBotLogin` empty). When enabled,
 * both tokens must be present and must resolve (via `gh api user`) such that:
 *
 *  - the reviewer token's account === `reviewBotLogin` — otherwise review
 *    *detection* (`hasCurrentReview`) would never match the posted review and
 *    the loop would re-review the same PR every cycle; and
 *  - the implementer and reviewer accounts differ — GitHub forbids approving
 *    your own PR, so identical accounts make every approval fail.
 *
 * Throws on any violation so the dispatcher refuses to start a misconfigured
 * review loop rather than spinning silently.
 */
export async function assertReviewIdentities(
  cfg: DispatcherConfig,
  runner: CommandRunner,
): Promise<void> {
  if (cfg.reviewBotLogin.length === 0) return; // review loop disabled — nothing to check

  if (!cfg.reviewGhToken) {
    throw new Error(
      '[eng:loop] review loop enabled (JINN_REVIEW_BOT_LOGIN set) but JINN_REVIEW_GH_TOKEN is unset — ' +
        'the review session cannot authenticate as the reviewer identity.',
    );
  }
  if (!cfg.implGhToken) {
    throw new Error(
      '[eng:loop] review loop enabled but JINN_IMPL_GH_TOKEN is unset — a distinct implementer identity ' +
        'is required so the reviewer is never the PR author (GitHub forbids self-approval).',
    );
  }

  const [reviewLogin, implLogin] = await Promise.all([
    resolveLogin(runner, cfg.reviewGhToken),
    resolveLogin(runner, cfg.implGhToken),
  ]);

  // GitHub logins are case-insensitive; compare case-folded so a config typo in
  // letter-case is not mistaken for a different account.
  if (reviewLogin.toLowerCase() !== cfg.reviewBotLogin.toLowerCase()) {
    throw new Error(
      `[eng:loop] JINN_REVIEW_GH_TOKEN resolves to '${reviewLogin}' but JINN_REVIEW_BOT_LOGIN='${cfg.reviewBotLogin}' — ` +
        'review detection would never match the posted review (infinite re-review). Make them the same account.',
    );
  }
  if (implLogin.toLowerCase() === reviewLogin.toLowerCase()) {
    throw new Error(
      `[eng:loop] implementer and reviewer are the same account '${implLogin}' — GitHub forbids approving your own PR. ` +
        'Configure JINN_IMPL_GH_TOKEN and JINN_REVIEW_GH_TOKEN as two distinct accounts.',
    );
  }

  console.log(`[eng:loop] dual identity OK: implementer=${implLogin}, reviewer=${reviewLogin}`);
}
