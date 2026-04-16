# Agent Packaging — Planning Prompts

Planning prompts for each implementation item from `docs/research/2026-04-agent-packaging.md`. Each prompt is designed to be handed to a planning session to produce an implementation plan.

---

## 1. Operator Dashboard

```
Plan the implementation of an operator dashboard for the jinn client daemon.

Context: read docs/research/2026-04-agent-packaging.md section 2.5 for the full design rationale.

The daemon already runs a Hono HTTP server on port 7331 (client/src/api/server.ts) with endpoints:
- GET /v1/status — daemon health, fleet state, RPC connectivity
- GET /artifacts/search — query knowledge artifacts
- GET /artifacts/:id/content — fetch artifact content

The dashboard is a single static HTML file served at GET / by this existing server. It polls the API endpoints with vanilla JS — no framework, no build step, no new dependencies. It ships inside the npm package in dist/.

Plan should cover:
- The HTML file structure (client/src/dashboard/index.html) — layout, panels, polling logic
- How to serve it from Hono (static file read at startup? inline string? Hono's serveStatic?)
- What the /v1/status response already contains vs what panels need (read client/src/api/gather-status.ts and client/src/api/status-rollup-build.ts)
- Whether any new API endpoints are needed for v1, or if existing endpoints suffice
- How to copy/include the HTML file in dist/ during yarn build (tsc doesn't copy non-TS files)
- The startup message change: "Dashboard: http://127.0.0.1:7331"
- Visual design direction — this is an operator monitoring tool, not a product frontend, but it should look polished

Scope constraint: v1 is daemon-only. No bootstrap phase visibility. The HTTP server starts after bootstrap completes in daemon.start() — no refactoring of main.ts.
```

---

## 2. Operator MCP Server (Read-Only Tools)

```
Plan the implementation of jinn-mcp, a standalone MCP server exposing operator-level tools for the jinn client.

Context: read docs/research/2026-04-agent-packaging.md sections 2.2, 5.1, 5.2, 5.3, and 8 for the full design rationale.

This is separate from the existing task-scoped MCP server at client/src/mcp/server.ts (which serves the inner agent during restoration). The operator MCP server serves the outer agent — the user's agent managing Jinn operations.

The entry point is a dedicated binary: jinn-mcp (not a CLI subcommand). This follows MCP convention — a standalone process that speaks stdio via StdioServerTransport.

Phase 1 scope — read-only tools plus init:
- jinn_status (wraps jinn status)
- jinn_doctor (wraps jinn doctor)
- jinn_fleet (wraps jinn fleet)
- jinn_balance (wraps jinn balance)
- jinn_history (wraps jinn history)
- jinn_rewards (wraps jinn rewards)
- jinn_init (wraps jinn init)

Plan should cover:
- Architecture decision: import CLI command modules directly (Option B in the doc) vs shell out. The CLI commands already accept injectable { writer, exit } — passing a StringWriter and no-op exit prevents process termination. Read client/src/cli/command.ts for the CommandContext interface.
- File structure: client/src/mcp/operator-server.ts (MCP server), client/src/bin/jinn-mcp.ts (bin entry)
- package.json changes: add "jinn-mcp" to bin field, ensure it's in files
- Password handling: read JINN_PASSWORD from env, same as CLI
- Tool schema design: what Zod schemas for each tool's inputs
- Testing strategy
- How users register it in MCP config (npx pattern)
```

---

## 3. MCP Server Write Tools

```
Plan adding write (mutating) tools to the jinn-mcp operator MCP server.

Context: read docs/research/2026-04-agent-packaging.md sections 5.1 and 5.2. This builds on the read-only MCP server from item 2 — that must be implemented first.

New tools:
- jinn_bootstrap (wraps jinn bootstrap — advances fleet state machine)
- jinn_submit_intent (wraps jinn submit-intent — posts desired state on-chain)
- jinn_start_daemon (starts jinn run as a background process)
- jinn_stop_daemon (wraps jinn stop — sends SIGTERM via pidfile)

Plan should cover:
- Error handling for mutating operations — bootstrap can pause at funding gates, submit-intent can hit transient RPC errors. How should these surface as MCP tool responses vs errors?
- Daemon lifecycle: jinn_start_daemon spawns jinn run as a detached subprocess and returns the PID. The daemon already writes a pidfile to ~/.jinn-client/earning/daemon.pid. jinn_stop_daemon reads the pidfile and sends SIGTERM. Read client/src/cli/commands/run.ts and client/src/cli/commands/stop.ts.
- Confirmation semantics: jinn submit-intent has a --yes flag and --dry-run. In MCP context, should tools always act (implicit --yes) or require explicit confirmation? Consider the agent UX.
- Long-running operations: bootstrap can take minutes (multiple on-chain transactions). Should the tool block until complete, or return immediately with a status to poll?
- Testing: how to test mutating MCP tools without hitting real chains
```

---

## 4. `jinn quickstart` Command

```
Plan the implementation of jinn quickstart — a single command that takes a user from zero to a running daemon with no manual steps.

Context: read docs/research/2026-04-agent-packaging.md sections 3.2, 3.3, and 3.4.

The flow:
1. Generate a random keystore password, save to ~/.jinn-client/keystore-password
   (skip if JINN_PASSWORD is already set — respect explicit operator choice)
2. jinn init — create wallet with that password (idempotent)
3. Check balances
4. Auto-fund via Coinbase CDP faucet (shipped API key; see item 5)
5. If auto-fund fails: print master address + faucet URL, poll until funded
6. jinn bootstrap — advance state machine to completion
7. jinn run — start daemon
8. Print dashboard URL + password location + change-password hint

Plan should cover:
- New file: client/src/cli/commands/quickstart.ts
- Password generation: crypto.randomBytes, save as plaintext to ~/.jinn-client/keystore-password. File permissions (0600).
- How to call existing command modules (init, bootstrap) programmatically — they're CommandModules with run(ctx). Can we call them directly, or do we need to extract shared logic?
- Faucet integration dependency: quickstart should work without the faucet (falls back to manual funding + polling). The faucet integration (item 5) is a separate deliverable that plugs in here.
- Polling for funding: how often, what endpoint, timeout behavior
- Daemon startup: foreground (quickstart blocks) vs background (quickstart returns). Consider that the user wants to see it working — foreground with the dashboard URL is probably right.
- Output format: structured JSON on stdout (matching CLI convention) or human-friendly for this command? Since quickstart is inherently interactive, --human should be the default.
- Idempotency: re-running quickstart after partial completion should resume, not restart. The underlying commands (init, bootstrap) are already idempotent.
```

---

## 5. Testnet Faucet Integration

```
Plan integrating the Coinbase CDP faucet for automatic Base Sepolia testnet funding.

Context: read docs/research/2026-04-agent-packaging.md section 4.4.

The Coinbase Developer Platform provides a programmatic faucet:
  await cdp.evm.requestFaucet({ address, network: "base-sepolia", token: "eth" })

We plan to ship a Jinn-project CDP API key as a default so testnet onboarding requires zero user signup. Operators can override with their own key via CDP_API_KEY_ID / CDP_API_KEY_SECRET env vars.

Plan should cover:
- Where the shipped API key lives: hardcoded default in source? Bundled config file? Environment variable with fallback?
- @coinbase/cdp-sdk as an optional dependency — dynamic import so the package doesn't fail to install if the SDK has platform-specific issues. Helpful error message if import fails.
- Faucet call wrapper: client/src/earning/faucet.ts or similar. Inputs: address, network. Outputs: success/failure + tx hash. Handles rate limit errors (1 claim/24h/address) gracefully.
- Integration points: called from jinn quickstart (item 4) and potentially jinn bootstrap when it detects a funding gap.
- Rate limit handling: if the faucet returns a rate limit error, fall back to printing the manual faucet URL. Don't retry in a loop.
- Security: the shipped API key grants testnet faucet access only. No mainnet, no wallet control. Document this in code comments.
- Key rotation: how to update the shipped key if it gets revoked. Should be a code change + npm publish, not a config update.
- Testing: mock the CDP SDK in tests. Test the fallback path (SDK unavailable, rate limited, network error).
```

---

## 6. `jinn keys change-password` Command

```
Plan the implementation of jinn keys change-password — allows operators to replace an auto-generated keystore password with their own.

Context: read docs/research/2026-04-agent-packaging.md section 3.4.

The command:
1. Read current password from ~/.jinn-client/keystore-password file, or from JINN_PASSWORD env var
2. Decrypt mnemonic from mnemonic.keystore.json
3. Prompt for new password (or read from --password-fd / JINN_NEW_PASSWORD env var)
4. Re-encrypt mnemonic with new password
5. Overwrite mnemonic.keystore.json
6. Delete ~/.jinn-client/keystore-password file (if it exists)
7. Print confirmation

Plan should cover:
- This is an extension of the existing jinn keys backup command (client/src/cli/commands/keys-backup.ts). Should change-password be a subverb of keys (jinn keys change-password) or its own top-level verb?
- The wallet functions already exist: decryptMnemonic, encryptMnemonic in client/src/earning/wallet.ts. The FleetStateStore has loadMnemonicKeystore/saveMnemonicKeystore.
- Password file reading: check ~/.jinn-client/keystore-password first, then JINN_PASSWORD. If neither exists, error with guidance.
- New password input: interactive prompt (process.stdin) or env var (JINN_NEW_PASSWORD) or --password-fd. The CLI is generally non-interactive, so env var / fd is more consistent, but this is a security operation where a prompt feels right.
- Confirmation: require typing the new password twice? Or single entry with a --yes flag?
- Daemon interaction: if the daemon is running, changing the password doesn't affect it (it already has the mnemonic in memory). But the next jinn run will need the new password. Should we warn if the daemon is running?
- Testing: test the decrypt-reencrypt round trip. Test that the keystore-password file is deleted.
```

---

## 7. Dashboard v2 — Bootstrap Visibility

```
Plan extending the operator dashboard to show bootstrap progress before the daemon is fully running.

Context: read docs/research/2026-04-agent-packaging.md section 2.5 (v2 follow-up note) and section 7.3.

Currently the Hono HTTP server starts inside daemon.start(), which is called after bootstrap completes in main.ts. This means the dashboard is only available once the daemon is running — operators get no visibility during the bootstrap phase, which can take minutes (multiple on-chain transactions, funding gates).

Plan should cover:
- Refactoring main.ts to start Hono before calling bootstrap(). The HTTP server would initially show bootstrap status, then transition to the full dashboard once the daemon starts.
- What bootstrap progress data to expose: current step, next step, funding requirements, transaction hashes. The FleetBootstrapper already has this state — how to surface it via an API endpoint.
- Proposed endpoint: GET /v1/bootstrap-status (or extend /v1/status to include bootstrap state)
- Dashboard UX: show a bootstrap progress view (step list with checkmarks) that transitions to the full daemon dashboard when bootstrap completes.
- The funding gate: when bootstrap pauses at awaiting_funding, the dashboard should show the address that needs funding + the amount + a link to the faucet. This is the "is it stuck?" moment.
- Architecture impact: starting Hono before the daemon means the API server setup moves out of Daemon.start() and into main.ts. Consider what this means for the separation between daemon and main.
```

---

## 8. Claude Code Skill

```
Plan creating a Claude Code skill that teaches agents how to use jinn MCP tools and operate on the Jinn network.

Context: read docs/research/2026-04-agent-packaging.md section 2.3.

A skill is a markdown file that gets loaded into the agent's context when invoked. It's a prompt template — it describes what tools are available and how the protocol works, so the agent can make informed decisions about which tools to call and in what order.

This skill assumes the jinn-mcp operator MCP server (items 2-3) is already registered in the agent's MCP config.

Plan should cover:
- Skill content: protocol overview (creation → restoration → evaluation → knowledge loop), available MCP tools and when to use each, the quickstart flow, common operator tasks
- Distribution: ship as a file in the npm package? Separate skill registry? A URL the agent can fetch?
- Skill format: follow the Claude Code skill format (name, description, trigger conditions in frontmatter, instructions in body)
- Trigger conditions: when should the skill activate? When the user mentions "jinn", "intent", "restoration"? When jinn MCP tools are available?
- The skill should teach the agent the operational mental model: init → fund → bootstrap → run is the lifecycle; status/fleet/balance are monitoring; submit-intent is the main action verb
- Testing: how to verify the skill produces good agent behavior
```
