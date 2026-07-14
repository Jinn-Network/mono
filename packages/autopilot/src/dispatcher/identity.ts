import type { CommandRunner } from './issue-source.js';
import type { DispatcherConfig } from './types.js';

/**
 * Spawn-opts overlay for a dispatched `claude -p` session. Spread into the
 * `spawn` opts; the production spawn lambda forwards `env` to Node's
 * `child_process.spawn`. Always sets an explicit `env` (a copy of
 * `process.env` plus the keys below):
 *
 *  - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` — print-mode otherwise terminates
 *    a session once its background subagents have run past the 600s default,
 *    which strands committed-but-unpushed work before the push/PR stage. `0` =
 *    wait indefinitely, so a session runs its inner pipeline to completion. The
 *    autopilot wall-clock (hours, pause-not-kill) remains the runaway backstop.
 *  - `GH_TOKEN` — set only when a per-identity token is configured
 *    (DR-2026-06-15); when empty the ambient `gh` account is inherited via the
 *    copied `process.env`.
 */
export function sessionSpawnEnv(token: string): { env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
  if (token) env.GH_TOKEN = token;
  return { env };
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
      '[autopilot] review loop enabled (JINN_REVIEW_BOT_LOGIN set) but JINN_REVIEW_GH_TOKEN is unset — ' +
        'the review session cannot authenticate as the reviewer identity.',
    );
  }
  if (!cfg.implGhToken) {
    throw new Error(
      '[autopilot] review loop enabled but JINN_IMPL_GH_TOKEN is unset — a distinct implementer identity ' +
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
      `[autopilot] JINN_REVIEW_GH_TOKEN resolves to '${reviewLogin}' but JINN_REVIEW_BOT_LOGIN='${cfg.reviewBotLogin}' — ` +
        'review detection would never match the posted review (infinite re-review). Make them the same account.',
    );
  }
  if (implLogin.toLowerCase() === reviewLogin.toLowerCase()) {
    throw new Error(
      `[autopilot] implementer and reviewer are the same account '${implLogin}' — GitHub forbids approving your own PR. ` +
        'Configure JINN_IMPL_GH_TOKEN and JINN_REVIEW_GH_TOKEN as two distinct accounts.',
    );
  }

  console.log(`[autopilot] dual identity OK: implementer=${implLogin}, reviewer=${reviewLogin}`);
}
