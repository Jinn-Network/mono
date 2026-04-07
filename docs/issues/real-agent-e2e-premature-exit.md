# Real Agent E2E: Process Exits Prematurely During Phase 5

**Date**: 2026-04-06
**Status**: Root cause identified, fix applied
**Severity**: Medium — mock agent e2e works (23/23), only real Claude agent affected

## Summary

When running `JINN_E2E_AGENT=real npx tsx scripts/e2e-validate.ts`, the Node process exits silently immediately after spawning the Claude CLI subprocess in Phase 5. The Claude process starts (PID confirmed alive) but the parent e2e process dies, orphaning the child.

## Symptoms

```
[runner] Spawning agent: claude -p You are restoring... (timeout: 300000ms)
[runner] Agent process spawned (pid: 53531)
client %   <-- process exits here, no error, no output
```

- No uncaught exception (crash guard added, never fires)
- No unhandled rejection (guard added, never fires)
- No error logged from the runner
- The spawned Claude process IS alive (confirmed via `ps -p <pid>`)
- Parent PID becomes 1 (reparented to init)

## What Works

- **Mock agent e2e**: 23/23 phases pass consistently
- **Manual Claude + MCP test**: `claude -p "..." --mcp-config <path> --allowedTools mcp__jinn-client__*` succeeds — Claude calls `get_desired_state` and `submit_restoration_result` correctly
- **Isolated spawn test**: Spawning Claude via `child_process.spawn` with `stdio: ['ignore', 'pipe', 'pipe']` works perfectly — exit/close events fire correctly

## What Doesn't Work

- Running the full e2e with `JINN_E2E_AGENT=real` — parent process exits during Phase 5 while Claude is still working

## Investigation Done

1. **Crash guards**: Added `process.on('uncaughtException')` and `process.on('unhandledRejection')` — neither fires
2. **Event type**: Changed from `child.on('close')` to `child.on('exit')` — no difference
3. **Stdin handling**: Tried `'ignore'` (original), `'pipe'` with immediate `.end()` — no difference
4. **Logging**: Added spawn PID, args, streaming stdout/stderr — confirms spawn succeeds then parent dies
5. **Isolated spawn test**: Created `/tmp/test-spawn.ts` that spawns Claude with a `setInterval` keepalive — works perfectly. Claude runs, outputs, exits cleanly. Both exit and close events fire.

## Root Cause (2026-04-06 investigation)

**Two bugs identified, sharing a common root cause:**

### Bug A: EADDRINUSE crash (seen in `e2e-test-output.log`)

`startApiServer()` wraps `@hono/node-server`'s `serve()` in a Promise that only resolves in the success callback — **it never rejects on error**, and the underlying HTTP server has **no `error` event handler**. When port 7339 is occupied (from a previous crashed e2e run), the server emits an unhandled `error` event, which Node.js throws as an uncaught exception, crashing the process.

### Bug B: Silent exit during real agent (original symptom)

The same missing error handler means ANY server error during Phase 5 (socket reset, connection error from Claude's MCP subprocess hitting the API server, etc.) would crash the process via unhandled `error` event — silently if the error propagation doesn't trigger the `uncaughtException` handler in `tsx`.

### Fixes applied

1. **`client/src/api/server.ts`**: Added `server.on('error')` handler + Promise rejection, and resolved actual bound port from `server.address()` (enabling port 0)
2. **`client/scripts/e2e-validate.ts`**: Use port 0 (OS-assigned) instead of hardcoded 7339 to avoid EADDRINUSE entirely
3. **`client/scripts/e2e-validate.ts`**: Added `process.on('beforeExit')` and `process.on('exit')` diagnostics to distinguish event-loop drain from explicit exit in any future occurrences

## Previous Likely Root Cause (superseded)

Something in the e2e test's execution context causes the Node event loop to drain after the spawn. Candidates:

1. **The `runPhase` try/catch** may be resolving/rejecting the Phase 5 promise without waiting for `processOne()` to complete
2. **Anvil process** — if Anvil dies, it might cascade and cause the parent to exit (Anvil is spawned with `detached: false`)
3. **API server** (`startApiServer` on port 7339) — Hono's `serve()` might close or its keepalive might end ← **CONFIRMED: no error handler**
4. **`process.exit()` at line 2532** — if the main function's flow somehow bypasses the `await` on Phase 5

## How to Debug

1. Add `setInterval(() => console.log('e2e alive'), 5000)` at the top of `main()` to confirm the event loop is draining vs process.exit being called
2. Add `console.log('before processOne')` / `console.log('after processOne')` around the `restorer.processOne()` call in Phase 5 to see if processOne completes prematurely
3. Check if `runPhase` catches the processOne timeout and proceeds to the next phase instead of blocking
4. Check if the mining `setInterval` in Phase 5 is being created before or after the spawn

## Key Files

- `client/src/runner/claude.ts` — `spawnAgent()` function (spawn + event handling)
- `client/scripts/e2e-validate.ts` — Phase 5 (line ~650), `runPhase` function (line ~144)
- `client/src/daemon/restorer.ts` — `processOne()` which calls `runner.run()`

## Reproduction

```bash
cd jinn-mono/client
JINN_E2E_AGENT=real npx tsx scripts/e2e-validate.ts
# Observe: process exits after "Agent process spawned (pid: XXXXX)"
```

## Workaround

Use mock agent for automated testing. For real agent validation, test manually:

```bash
claude -p "You are restoring a desired state. Call get_desired_state, then submit_restoration_result with success=true." \
  --mcp-config /path/to/mcp-config.json \
  --allowedTools 'mcp__jinn-client__*' \
  --model claude-haiku-4-5-20251001
```
