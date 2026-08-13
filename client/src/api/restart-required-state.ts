/**
 * Explicit restart-required flag (issue #2408, PR #2424 review finding F1).
 *
 * Spec §6.5's parenthetical mechanism sketch was "config-file-newer-than-boot" (mtime
 * comparison). That fires PERMANENTLY for any operator who completes onboarding or edits
 * pricing: both `main.ts`'s `markOnboardingComplete` write path and
 * `operator-artifacts-endpoint.ts`'s `POST /v1/operator/pricing` bump the config file's mtime
 * WHILE ALSO hot-applying in-memory (`config.onOperatorConfigUpdated`) — no restart is actually
 * needed, but mtime can't distinguish "wrote and hot-applied" from "wrote and needs a restart".
 * There is also a stale-`daemonStartedAt` edge in setup mode. See the PR #2424 review.
 *
 * **Ruling: the mechanism changes; the semantic stays.** This is an explicit, in-memory flag
 * set ONLY by the three write paths that the daemon has never hot-applied — exactly what the
 * pre-#2408 browser `RestartPendingContext` / `onRestartPending` callback tracked:
 *   - `claim-policy-endpoints.ts`'s two PUT handlers (claim policy / execution wiring) — always
 *     restart-required, no hot-apply path exists.
 *   - `setup-endpoints.ts`'s join-SolverNet endpoint, but only on the branch where hot-apply via
 *     a hot-apply path is unavailable (mirrors that endpoint's own
 *     `restartRequired` response field exactly).
 *   - `setup-endpoints.ts`'s leave-SolverNet and rpcUrl (network config) endpoints — always
 *     restart-required, no hot-apply path exists.
 *
 * This deliberately diverges from spec §6.5's parenthetical; the spec-side amendment is
 * tracked separately (see PR #2424's description). Out-of-band manual edits to the config file
 * (an operator hand-editing `config.json` outside the SPA) no longer produce the notification —
 * accepted: they never did under the browser-era flag either (that was a same-session UI
 * gesture, never a filesystem watch).
 *
 * Cleared implicitly at boot: a fresh daemon process gets a fresh module-level `false` — no
 * persistence, matching the browser flag's "lost on reload" character, just server-side now so
 * every consumer (not only the SPA tab that made the edit) sees the same answer.
 */
let restartRequired = false;

export function markRestartRequired(): void {
  restartRequired = true;
}

export function isRestartRequired(): boolean {
  return restartRequired;
}

/** Test-only: the module is a process-wide singleton otherwise. */
export function resetRestartRequiredForTest(): void {
  restartRequired = false;
}
