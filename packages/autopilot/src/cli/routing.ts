// Side-effect-free routing helper extracted from `scripts/run-autopilot.ts`
// so unit tests (and any other consumer) can import it WITHOUT triggering the
// script's top-level `main().catch(...)` — which would spawn `gh project
// field-list` during `yarn test`, surfacing noisy stderr locally and hanging
// CI runs that lack `gh` auth. Keep this module zero-side-effect.

/**
 * Routing helper for the `sessions` subcommand (#587). Returns true when the
 * dispatcher entrypoint should hand off to `runSessionsCli` instead of
 * running its normal cycle loop. Exported so the routing branch can be
 * pinned by a unit test.
 */
export function shouldRouteToSessions(argv: string[]): boolean {
  return argv[2] === 'sessions';
}

/** Route the singular, attempt-internal lifecycle protocol shell. */
export function shouldRouteToSession(argv: string[]): boolean {
  return argv[2] === 'session';
}
