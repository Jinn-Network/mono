# @jinn-network/task-execution-launchers

The Executor Launcher contract and the v1 launchers — claude-code, codex, hermes, cursor
(design §8) — for the Jinn Task Execution Protocol (TEP) local execution backend. A launcher is
a pure function from `(TaskView, WorkspacePaths, AttemptIdentity)` to a `LaunchPlan`; it never
spawns, retries, touches secrets beyond declared forwards, or holds state.

Depends on `@jinn-network/task-execution-protocol`, `@jinn-network/task-execution-profiles`,
`@jinn-network/task-execution-supervisor` (for the `AttemptIdentity` type the frozen `plan(...)`
signature takes), and `@jinn-network/task-execution-workspace` (for `TaskView`/`WorkspacePaths`).
It never imports the `backend-local` (assembly) package or any evidence package, and never
spawns a harness directly — the supervisor spawns, through the shim, per the
launchers-plan-supervisor-spawns split. The packaged `credential-exec.mjs` helper is the narrow
exec-time exception: it is itself launched by the supervisor and spawns the already-planned
harness after replacing `secrets/<portable-basename>` references with file contents in the child
environment. It never logs or persists those contents.

## Platform credentials

`makeClaudeCodeLauncher` and `makeCodexLauncher` accept an opt-in typed `credential` option.
`{ kind: "api-key", secretBasename }` maps a durable plan reference to the relevant provider
variable only at exec time. `{ kind: "credential-artifact", secretBasename }` maps to
`CLAUDE_CODE_OAUTH_TOKEN` for Claude, or materializes Codex's `auth.json` into a fresh,
terminal-wiped `$TMPDIR/jinn-codex-local-login` directory. A normal host `CODEX_HOME` is never
copied. Without that option these launchers retain their original zero-forward and fresh-state
plans.

Qualified Claude plans use documented bare/safe noninteractive modes, and qualified Codex plans
ignore user configuration, rules, and plugins and are ephemeral. This package does not invent
undocumented update or telemetry controls: a deployment that needs additional isolation must
qualify and enforce it outside the launcher.

See the design: `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md` §8 (the
Executor Launcher), §14 items 8-9 (frozen interfaces), §15 (packages).

## Status

Milestone B: four harness-specific pure planners implement hermetic invocation, run-pinning,
structured output, correlation declarations, static capabilities, injected dynamic probes,
and exit/signal-authoritative result interpretation. Concrete conformance invocations live
downstream in `@jinn-network/task-execution-testing` per program ruling §7.25.

## Never touches

Spawning, retry, secrets beyond declared forwards, or state (design §5/§8.4).
