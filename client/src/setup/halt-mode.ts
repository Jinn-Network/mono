/**
 * Halt-and-resume gate (jinn-mono-hjex.6).
 *
 * When bootstrap fails after the setup API has come up, we want the dashboard
 * to stay alive so the operator can click Retry from `BootstrapErrorCard`
 * (see `main.ts` halt-and-resume loop). That mode is only safe when there is
 * actually a human (or watcher) on the other side; in CI / agent-driven flows
 * driven with `JINN_NO_UI=1` or `JINN_NO_DAEMON=1` no Retry click is coming,
 * so a halt must surface as a fatal exit immediately rather than suspending
 * in the retry loop forever.
 *
 * This predicate is the single source of truth for that gate.
 */
export function keepSetupUiOnBootstrapError(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['JINN_NO_UI'] !== '1' && env['JINN_NO_DAEMON'] !== '1';
}
