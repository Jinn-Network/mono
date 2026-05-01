# Worked example: hook

**Example package:** [`examples/learner-plug-ins/@jinn-examples/prefetch-markets-hook`](../../../../examples/learner-plug-ins/@jinn-examples/prefetch-markets-hook)

## Recruit shape

You're an infrastructure-tool author. You have a pre-fetch optimisation, a session-start audit, a post-phase report uploader — anything that runs at a lifecycle boundary, not inside a phase agent. You don't ship reasoning; you ship plumbing.

The `hook` slot is your shape: a shell script or Node executable, declared with an event + (optional) phase, invoked by the harness at the boundary.

## What the slot does

The harness invokes the hook at the declared event:

- `session-start` — once per session, before any phase runs.
- `pre-phase` (with `phase`) — before that phase starts.
- `post-phase` (with `phase`) — after that phase finishes.
- `session-end` — once per session, after every phase has finished.

Hooks run as separate processes with the daemon's user-level capabilities. They receive context environment variables (working dir, impl state dir, intent ID, phase name) and write side effects (filesystem, network) + an exit code. Non-zero exits log a warning but do not abort the session.

The prefetch-markets-hook example runs at `pre-phase` for `orient` on `prediction.v0` intents. It pre-fetches the relevant Polymarket / Kalshi market state into `workingDir/.cache/markets.json` so Orient's explorers (and any topic-explorers from other plug-ins) read from the cache instead of re-fetching. Saves budget on the time-sensitive boundary.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/prefetch-markets-hook",
  "version": "0.1.0",
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0",
    "supportedKinds": ["prediction.v0"]
  },
  "slots": [
    {
      "type": "hook",
      "event": "pre-phase",
      "phase": "orient",
      "entry": "hooks/pre-orient",
      "scope": { "matchKinds": ["prediction.v0"] }
    }
  ]
}
```

`entry` points at an executable (any interpreter — shebang + chmod +x; or a Node script the harness invokes via `node entry`). The harness invokes it with stdio inherited and the context env vars set.

## Slot entry walkthrough

`hooks/pre-orient` is a shell script (or Node executable). It reads `JINN_INTENT_ID`, `JINN_WORKING_DIR`, etc. from its environment, fetches market state, writes `$JINN_WORKING_DIR/.cache/markets.json`, and exits 0.

The companion convention is `client/plugins/claude-code-learner/hooks/session-start` in the bundled learner — same hook surface, same env conventions. Path 1 hooks plug into the same lifecycle.

## Test → install → run

```bash
cd examples/learner-plug-ins/@jinn-examples/prefetch-markets-hook
yarn install
yarn test          # validates manifest + that the entry script exists and is executable

cd ~/your-daemon-config
yarn add file:.../examples/learner-plug-ins/@jinn-examples/prefetch-markets-hook
jinn plug-ins add @jinn-examples/prefetch-markets-hook

# Restart daemon. Pre-orient hook fires on every prediction.v0 attempt.
```

## Replace the stub

1. **Replace the script body** — implement your real pre-fetch / audit / uploader. Read the env vars the harness sets; write under `workingDir/**` (the only filesystem location the constraint surface allows).
2. **Pick the right event.** `session-start` runs once; `pre-phase` runs N times if you don't restrict by `phase`; `post-phase` is the right place for "after Debrief, ship the artefact somewhere."
3. **Handle non-zero exits sanely.** The harness logs and continues; it does not abort the session. If your hook's failure should abort, document that the operator must monitor logs — the harness won't enforce it.
4. **Don't smuggle capabilities.** Hooks run with the daemon user's capabilities (network, filesystem). The host-inheritance trust model means the operator vouched by installing; if your hook does something the operator didn't expect, that's a README failure on your side.

Hooks compose well with `mcp-tool` slots: a `pre-phase` hook that warms a cache, plus an `mcp-tool` server that reads from it, gives the harness a fast read-path with no per-phase fetch latency.
