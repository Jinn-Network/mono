# Operator-facing local app — design

**Status:** draft (Captain-led brainstorm, 2026-05-01)
**Author:** ritsukai (with Claude Opus 4.7)
**Bead:** jinn-mono-3ois
**Related beads:** jinn-mono-95sj (intent enable/disable redesign), jinn-mono-dgi0 (jinn auth split), jinn-mono-2zk.1 (client architecture narrative), jinn-mono-2zk.2 (CLI surface review)

## Summary

A localhost web app served by the Jinn daemon that becomes the front door for an operator's whole lifecycle: first-run setup, daily monitoring, troubleshooting, and operator actions. The app is GUI-first with an embedded Claude Code session (Auto Mode) docked alongside, providing a co-pilot for explanation, troubleshooting, and long-tail actions that don't deserve their own screens.

This is a **v1-Slim** scope. CLI parity beyond status, setup, and a small write-tool surface is deferred. Open-source contribution flows are deferred. Plug-in marketplace UI is deferred.

## Goals

- Replace `client/src/dashboard/index.html` with a richer single-page app served from the same Hono process.
- Make the bootstrap journey visible — every blocking moment becomes a clear, actionable card; every non-blocking step runs in the background and shows progress.
- Give operators a continuous view into what their daemon is doing and what it has just done, beyond a point-in-time status snapshot.
- Provide an in-app Claude Code session (separate from the daemon's runner-spawned Claude subprocesses) that can read daemon state and perform a small set of write operations via MCP, with Auto Mode handling the safety floor.
- Keep the existing CLI surface fully usable — the local app augments, never gates.

## Non-goals (v1)

- Electron / Tauri / native packaging. The app is a localhost web SPA only.
- Remote operation, multi-machine UIs, multi-operator views, RBAC.
- A parallel permission-confirmation modal layer in the UI. The embedded Claude Code session uses Auto Mode (`--enable-auto-mode`); the classifier handles destructive-action gating.
- Self-bond mode. v1 assumes standard mode (operator funds gas only; OLAS provided by the protocol-side staking infrastructure).
- Open-source contribution surface (file issue, submit PR, track contribution). Out of scope for v1.
- Plug-in marketplace UI.
- CLI restructuring (jinn-mono-dgi0 owns that).
- Intent enable/disable model redesign (jinn-mono-95sj owns that).

## Audience

The priority audience is **every operator across their lifecycle**: a new operator going through first-run, an existing operator monitoring daily, an operator troubleshooting a stuck daemon. v1 does not optimize for evaluators / seers reviewing artifacts — that's a different surface and a different role population.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser → http://127.0.0.1:7331                         │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Operator SPA (replaces dashboard/index.html)    │    │
│  │  ┌──────────────────┐ ┌────────────────────────┐ │    │
│  │  │ Status           │ │ Agent panel            │ │    │
│  │  │ Visibility (log) │ │ (Claude Code session,  │ │    │
│  │  │ Setup (touch.)   │ │  Auto Mode, MCP)       │ │    │
│  │  └──────────────────┘ └────────────────────────┘ │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
                          │  HTTP + SSE + WS
                          ▼
┌──────────────────────────────────────────────────────────┐
│  Daemon process (single binary, jinn run)                │
│  • Hono API (existing /v1/status, /artifacts/*)          │
│  • Static SPA assets (replaces dashboard/index.html)     │
│  • /v1/events SSE stream (NEW)                           │
│  • /v1/bootstrap endpoint (NEW)                          │
│  • /auth/handshake endpoint (NEW)                        │
│  • /mcp/operator HTTP-streamable MCP server (NEW)        │
│  • Operator Claude Code subprocess (NEW)                 │
│  • Daemon loops (creator, engine-watcher, delivery)      │
└──────────────────────────────────────────────────────────┘
```

**Single-process model.** The daemon already runs Hono and serves the dashboard; the SPA is static assets it serves. No separate UI server, no Electron, no cross-process state sync.

**Two distinct Claude/MCP surfaces inside the daemon.** Today's `client/src/runner/claude.ts` + `client/src/mcp/server.ts` are *runner-scoped*: spawned per-restoration, MCP tools for working an intent. The new operator surfaces are separate: one persistent Claude Code subprocess for the operator-as-user, MCP tools for inspecting daemon state and performing a small set of operator actions. The runner side is untouched.

**Streaming.** `/v1/status` stays poll-based for the at-a-glance card. A new SSE channel (`/v1/events`) streams structured activity (loop ticks, intent state transitions, errors, log lines) for the visibility region. The agent panel uses a WebSocket to stream the embedded Claude session to/from the browser.

**Localhost-only binding.** The daemon currently binds `0.0.0.0:7331`; v1 narrows to `127.0.0.1`. Remote-access / multi-machine is its own design later.

## Setup-mode daemon

The daemon starts in two states:

- **Setup mode** — Hono, static SPA, `/v1/events`, `/v1/bootstrap`, `/auth/handshake`, `/mcp/operator`, and the operator Claude subprocess come up. Daemon loops (creator, engine-watcher, delivery-watcher) are gated. Reached when keystore is missing or bootstrap is incomplete.
- **Running mode** — Setup-mode services remain up; daemon loops start. Reached when keystore exists, bootstrap is complete, and required preflight passes.

The transition from setup → running happens automatically when bootstrap reaches `complete`. The SPA reflects which mode it's in via a state field in `/v1/status` and renders the relevant region as primary.

## The four regions

### Region 1 — Status

At-a-glance state for an operator who already knows what they're looking at. Single source: `/v1/status` (existing, unchanged shape). Polled at the existing interval.

**Content.** Network + chain banner (mainnet vs testnet), daemon health (running, last poll, version/commit), in-flight intents (count + small table), recent verdicts (last N), earnings (pending + last claim), fleet (services with step + Safe address), master gas runway, recent activity tail.

**Primary actions.** Refresh now, copy address, open Basescan link.

**Empty state.** "Daemon is in setup mode — go to Setup" (when no bootstrap yet). "Daemon is starting up..." (when transitioning).

### Region 2 — Visibility

The "what is the daemon doing right now and what just happened" surface. Two sub-surfaces.

**Now panel.** One line per loop. Examples:
- creator: idle / posting kind=portfolio.v0 (1 of 1)
- engine-watcher: idle / claiming requestId 0xabc... / running impl restorer-v1 (active 14s)
- delivery-watcher: idle / polling / claiming reward for 0xdef...

**Activity timeline.** Stream of structured events via SSE on `/v1/events`. Each event has: timestamp, kind (intent / reward / fleet / system / error), short message, optional tx hash with link, optional requestId, optional errorCode. Filterable by kind. Pin-to-follow toggle. Below it, a collapsible raw-log tail (tail of the daemon log file, or read from stdout/stderr buffers).

**Data sources.** New in-memory ring buffer in the daemon (≤ 1000 events). Populated from existing log/console calls plus a new structured-event emit pass at known transition points (intent claim, deliver, claim, error returns from chain calls). The SSE channel writes from this ring buffer; new clients receive a backfill of the last N events on connect.

**Primary actions.** Filter, pause/resume tail, copy event JSON, open tx hash on Basescan, jump to associated intent in the agent panel.

**Error states.** SSE disconnected → "Reconnecting..." with last-seen timestamp; auto-retry with exponential backoff.

### Region 3 — Setup (touchpoint flows)

Wraps the operator's first-run journey as a visible state machine. The 11-step earning bootstrap is the spine; non-blocking steps run autonomously and just show progress; blocking steps surface a single card with the action zone.

**Top of region.** A "Start me up" primary button that triggers the same flow as `jinn run` (preflight + init + bootstrap, then start the daemon). When pressed, the region expands and shows live progress.

**Card list, top-to-bottom.**
1. wallet — keystore creation. If missing, prompt for password (form). Once created, shows master address.
2. safe_predicted — non-blocking; shows predicted Safe address.
3. **awaiting_funding** — *the* human touchpoint for v1. Single card with one requirement row (in standard mode):
   - **EOA needs ETH.** Address (with QR), copy button, minimum amount, a chain-watcher that polls balance and auto-advances when funds land. CDP faucet link visible. (OLAS for the Safe is provided by the protocol-side staking infrastructure in standard mode; no operator action required.)
4. safe_deployed — non-blocking; deploys when ETH is present.
5. service_created — non-blocking.
6. service_activated — non-blocking.
7. agents_registered — non-blocking.
8. service_deployed — non-blocking.
9. service_staked — non-blocking.
10. mech_deployed — non-blocking.
11. complete — celebrates; daemon transitions to running mode.

Each card shows: icon (done / in-progress / blocked / waiting), one-line explanation, action zone when blocked.

**Errors.** When a step fails, the card surfaces the error and a "Ask the agent about this" button that pre-prompts the agent panel with the error context.

**Data sources.** New `/v1/bootstrap` endpoint reading `~/.jinn-client/earning/earning_state.json` plus on-chain balances for the funding-watcher. SSE updates from `/v1/events` for state transitions.

**Post-bootstrap.** Region collapses to a small "All set" pane. Re-expandable for re-running specific steps (e.g., re-staking) when supported.

### Region 4 — Agent panel

A persistent Claude Code session, distinct from the runner's per-restoration Claude subprocesses. Docked right side of the SPA. Visible in both setup and running modes.

**Embedded session.** A daemon-owned `claude` subprocess started with `--enable-auto-mode`. Streamed to the browser via WebSocket. Renders as a normal chat with tool-call cards. Inline links to the relevant Status / Visibility / Setup region anchors when the agent references state.

**Auto Mode.** Required: Claude Code v2.1.83 or later. Available on Max / Team / Enterprise / API plans (not Pro). When Auto Mode is unavailable, the panel falls back to the default permission mode and shows a banner explaining why prompts will appear; this is informational, not a gate.

**Operator MCP server.** New HTTP-streamable MCP endpoint at `/mcp/operator`. Tools (initial set):

Read tools (un-gated):
- `status.get` — return the current `/v1/status` payload.
- `activity.list` — return recent events from the ring buffer (with filters).
- `intent.get` — return state for a specific intent by requestId.
- `fleet.list` — return fleet/service state.
- `bootstrap.state` — return current bootstrap step + per-step status.
- `logs.tail` — return tail of the daemon log.

Write tools (Auto Mode classifier handles approval):
- `daemon.restart` — restart loops (not the process).
- `loop.pause` / `loop.resume` — gate individual loops.
- `rewards.claim` — invoke the existing rewards-claim flow.
- `intent.kind.enable` / `intent.kind.disable` — to be wired after jinn-mono-95sj ships its new model.

**First-run sequence.**
1. Operator runs `jinn run`.
2. Browser auto-opens to `http://127.0.0.1:7331`.
3. SPA performs `/auth/handshake` to pick up the local session token.
4. SPA reads daemon state. If `claude` is not authenticated, the agent panel shows an authentication panel: it spawns `claude /login` as a daemon subprocess (which opens its own browser tab for OAuth) and polls auth status. In docker-compose / container runtime modes, the panel surfaces the appropriate command for the operator to run inside the container.
5. Once authed, the agent panel comes alive with a state-aware opener message based on bootstrap state ("Looks like your fleet hasn't bootstrapped yet — want me to walk you through it?").

## Launch story

The headline command is `jinn run`. No new top-level commands.

- `jinn run` (default) — auto-opens browser to `http://127.0.0.1:7331`.
  - If keystore + bootstrap not complete, panel renders Setup region as primary; daemon loops gated.
  - If complete, panel renders Status + Visibility + Agent; daemon loops start.
- `jinn run --no-ui` — suppresses auto-open. Headless / scripted / CI.
- `jinn auth`, `jinn quickstart`, `jinn bootstrap`, `jinn init`, all other CLI verbs — unchanged. Power users and existing scripts continue to work.

> **v1.x update (jinn-mono-zqm2).** `jinn quickstart` was removed and `jinn run`
> now subsumes its zero-to-running flow (auto-resolve password, init wallet,
> bootstrap fleet, start daemon, panel). The bullet list above reflects the
> original v1-Slim design — read `jinn quickstart` there as historical
> context. The CLI surface today: `jinn run` is the one-shot first-run command;
> `jinn auth`, `jinn bootstrap`, `jinn init` remain as power-user step-by-step
> escape hatches. The MCP tool was renamed `jinn_run`. See
> `client/README.md` and `docs/operator-testnet.md` for the current operator
> path.

The bare `jinn` invocation continues to print help. Changing it would require its own deprecation cycle.

The CLI restructuring proposed in jinn-mono-dgi0 (splitting `jinn auth` into Claude auth and runtime-mode selection) is independent of this spec — the panel calls operator MCP tools and daemon API, not CLI verbs, so the underlying CLI shape can evolve without affecting the panel.

## Security and auth

**Localhost-only binding.** `127.0.0.1:7331`. Remote access is its own design later.

**Local session token.** On daemon start, the daemon writes a random token to `~/.jinn-client/ui-token` (mode 0600). The browser obtains it via a one-time `/auth/handshake` redirect that uses a short-lived URL parameter the daemon prints to stdout. Subsequent requests include the token in a header. ERC-8128 stays in place for the existing artifact-publish surface; the operator UI uses the local-token scheme.

**MCP transport.** Operator MCP runs as HTTP-streamable on the daemon. The embedded `claude` subprocess is configured with that endpoint. No stdio MCP across process boundaries.

**Keystore handling.** Password never crosses the wire to the SPA. Keystore creation/unlock UI sends the password directly to the daemon over the localhost channel; the SPA forgets it as soon as it is submitted. Same threat model as today's `JINN_PASSWORD` env var, plus the localhost binding.

**Out of scope for v1.** Remote access, multi-operator UI, role-based access control, audit trail.

## Tech choices (deferred pending OSS reuse audit)

The implementation plan must include an OSS reuse audit as the first task, before any framework decision is committed. Categories to survey:

1. **Web UIs around `claude` / Claude Code sessions.** Anyone already piping a Claude Code subprocess into a browser chat — Claudia (getAsterisk), community wrappers, anything that ships an embeddable web component for Claude Code.
2. **Agent chat component libraries.** `assistant-ui`, Vercel AI SDK chat components, CopilotKit — for tool-call rendering, streaming, slash commands.
3. **Terminal-in-browser.** `xterm.js`, `ttyd`, `wetty` — for the "real terminal one click away" affordance.
4. **SPA + dashboard primitives.** shadcn/ui + Tailwind + Tanstack Query is the obvious default; also worth checking if there's a polished operator-console framework worth lifting.
5. **MCP tool-call visualization.** Anything that already renders MCP tool calls as structured cards.

If nothing better surfaces, the default stack:
- **SPA:** Vite + React (or Solid) + Tailwind + shadcn/ui.
- **Data:** Tanstack Query against `/v1/status` and `/v1/bootstrap`; native EventSource for `/v1/events`.
- **Agent panel:** WebSocket + `assistant-ui` (or `xterm.js` if we want a more terminal-flavoured rendering).
- **MCP transport:** HTTP-streamable on a Hono route.
- **SSE structured events:** Hono's built-in streaming response.

The audit may flip any of these.

## Testing

- **Unit.** Existing Vitest suite extends to cover the new endpoints (`/v1/events`, `/v1/bootstrap`, `/auth/handshake`, MCP operator tools), with the existing mock policy (see `docs/runbooks/testing.md`).
- **Integration.** A new Playwright SPA e2e test on top of the Anvil-fork `yarn e2e` flow. Walks the bootstrap touchpoint flow, watches the `awaiting_funding` card auto-advance after funding, confirms verdicts surface in Visibility.
- **Agent panel.** Test the operator MCP tool surface against a stub Claude (no live model) — assert tool-call shapes, read/write tool authorization, and Auto Mode banner behaviour. Live model in CI is out of scope.
- **Test architecture.** Conforms to `docs/superpowers/specs/2026-04-24-test-architecture-design.md` — pyramid, real DB, no daemon mocks for integration tests.

## Acceptance

- Replaces `client/src/dashboard/index.html` with the SPA build output served by Hono.
- Daemon starts in setup mode when keystore or bootstrap incomplete; transitions to running mode automatically.
- `jinn run` auto-opens the browser by default; `--no-ui` suppresses.
- The four regions (Status, Visibility, Setup, Agent) are reachable and functional in both modes.
- The operator MCP server is reachable from the embedded Claude session and exposes the listed read + write tools.
- Auto Mode is enabled when Claude Code v2.1.83+ is available and the plan supports it; otherwise the fallback banner appears.
- The bootstrap touchpoint flow handles `awaiting_funding` end-to-end on Anvil-fork e2e.
- All existing CLI verbs continue to work unchanged.
- All e2e tests pass.

## Out-of-scope follow-ons (file as separate beads)

- v1.x: full CLI parity in the panel (intents submit/list, fleet-scale, keys-backup, plug-ins, doctor, conformance, withdraw).
- v1.x: open-source contribution surface (file issue → opens GitHub, track open PRs).
- v1.x: plug-in marketplace UI.
- v1.x: remote / multi-machine access.
- v1.x: evaluator / seer surfaces.
- v1.x: self-bond mode bootstrap touchpoints.

## Open questions deferred to implementation plan

- Exact UI framework (React vs Solid) — decided after OSS audit.
- Exact agent chat component (assistant-ui vs custom) — decided after OSS audit.
- Whether the auth handshake uses a short-lived URL parameter, a header, or a cookie — decided during implementation.
- Whether `/v1/events` SSE backfill is bounded by event count or by time window — decided during implementation.

## References

- `client/src/dashboard/index.html` — current dashboard (75 lines, replaced by this work).
- `client/src/api/server.ts` — Hono API host.
- `client/src/api/gather-status.ts` — `/v1/status` payload assembly.
- `client/src/earning/bootstrap.ts` — 11-step earning bootstrap state machine.
- `client/src/cli/commands/quickstart.ts` — current zero-to-running flow.
- `client/src/cli/commands/auth.ts` — current Claude auth + runtime mode selection.
- `client/src/cli/commands/run.ts` — current daemon entry.
- `client/src/runner/claude.ts` — existing per-restoration Claude subprocess (untouched).
- `client/src/mcp/server.ts` — existing runner MCP (untouched).
- `BRAND.md`, `DESIGN.md`, `DESIGN.json` — visual spec.
- `docs/runbooks/testing.md` — test SOP.
- [Auto mode for Claude Code](https://claude.com/blog/auto-mode), [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes).
