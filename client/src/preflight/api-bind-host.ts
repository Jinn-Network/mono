/**
 * Resolution + loopback classification for the daemon HTTP API's bind host.
 *
 * Extracted as a small, pure module (mirrors `rpc-network.ts`'s pattern) so
 * it's unit-testable without spinning up `main()` — see
 * `test/preflight/api-bind-host.test.ts`.
 *
 * §14.4 of docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md:
 * `main.ts` used to read only `process.env['JINN_API_BIND_HOST']`, ignoring
 * `config.apiBindHost` entirely — the config-file knob was dead. `loadConfig`
 * (`config.ts`) already folds `JINN_API_BIND_HOST` into `config.apiBindHost`
 * (env wins there too), so `resolveApiBindHost` re-checks the env var
 * directly as a defensive, self-contained resolution rather than depending
 * on that upstream merge — env override wins, else config, else loopback.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Env override wins, else the resolved config value, else the loopback default. */
export function resolveApiBindHost(
  configApiBindHost: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envHost = env['JINN_API_BIND_HOST'];
  if (envHost && envHost.trim() !== '') return envHost;
  if (configApiBindHost && configApiBindHost.trim() !== '') return configApiBindHost;
  return '127.0.0.1';
}

/** True when `host` is a loopback address (the daemon API's safe default). */
export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
