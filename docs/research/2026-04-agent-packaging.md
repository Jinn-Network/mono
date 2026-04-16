# Agent Packaging Research

**Date:** 2026-04-16
**Author:** Claude (research agent)
**Status:** Research — not a spec or commitment

## Problem Statement

A user wants to go from zero to operating an agent on the Jinn Network. The client is a published npm package (`@jinn-network/client`) with a 17-verb CLI, an 11-step fleet bootstrap state machine, and contract deployments on Base Sepolia. A Docker image is also available. The question: what additional packaging and onboarding improvements get an external operator running with minimum friction — particularly for agent-to-agent consumption?

---

## 1. What Exists Today

### 1.1 CLI Surface (`client/src/bin/jinn.ts` → `client/src/cli/`)

The `jinn` CLI already has a complete operator workflow:

| Verb | Purpose |
|------|---------|
| `jinn init` | Generate master wallet, encrypt keystore |
| `jinn doctor` | Preflight checks (Node.js, Claude binary, deployment config) |
| `jinn fund-requirements` | Show exact funding gaps |
| `jinn bootstrap` | Advance fleet state machine |
| `jinn run` | Start daemon (creator + restorer + delivery-watcher loops) |
| `jinn status` | Poll daemon health |
| `jinn submit-intent` | Post a desired state on-chain |
| `jinn fleet` / `jinn balance` / `jinn history` / `jinn rewards` | Inspect state |
| `jinn withdraw` / `jinn keys backup` | Fund management |

The CLI emits structured JSON on stdout (machine-readable by default, `--human` for terminal output) and routes logs to stderr. This is already well-designed for agent consumption — an orchestrating agent can parse stdout JSON directly.

### 1.2 MCP Server (`client/src/mcp/server.ts`)

The existing MCP server is **subprocess-scoped**, not standalone. It is spawned by `ClaudeRunner` as a child process for each restoration/evaluation task, with context passed via env vars:

**Existing tools:**
- `get_desired_state` — read the current task assignment
- `report_progress` — log progress
- `submit_restoration_result` — submit success/failure verdict
- `get_restoration_delivery` — fetch restoration data for evaluation
- `publish_artifact` — store knowledge for future agents
- `search_artifacts` — query past artifacts
- `acquire_artifact` — fetch remote artifacts from peers

**What this MCP server is:** A toolbox for the *inner agent* — the Claude subprocess that performs a single restoration or evaluation. It is tightly coupled to one task execution.

**What this MCP server is NOT:** A general-purpose interface for an external agent to discover, join, and operate on the Jinn network. It cannot init a wallet, bootstrap, submit intents, check status, or manage the fleet.

### 1.3 HTTP API (`client/src/api/server.ts`)

Runs on port 7331 when the daemon is active:
- `GET /v1/status` — daemon health, fleet state, RPC status
- `GET /artifacts/search` — query artifacts
- `GET /artifacts/:id/content` — fetch artifact content
- `POST /artifacts` — publish artifacts
- `GET /x402/artifacts/:id/content` — payment-gated access

### 1.4 npm Package (`package.json`)

Already configured for publishing:
- Name: `@jinn-network/client`
- `bin.jinn` → `./dist/bin/jinn.js`
- `publishConfig.access: "public"`
- `files: ["dist/", "deployments/"]`
- `prepublishOnly` runs build + test
- Library exports via `main`/`types` for programmatic use

### 1.5 Bootstrap State Machine

The `FleetBootstrapper` walks through wallet creation → Safe deployment → service registration → staking → mech deployment. Key properties:
- **Idempotent** — persists state to `~/.jinn-client/earning/earning_state.json`, safe to interrupt and resume
- **Funding gate** — pauses at `awaiting_funding` with a structured envelope telling the operator exactly what needs funding
- **Two staking modes** — `standard` (stOLAS, no OLAS needed) and `self-bond`

### 1.6 Dependencies & Prerequisites

- Node.js 22 (hard requirement via `engines` and corepack)
- Claude Code CLI on PATH (checked by `jinn doctor`)
- Foundry only for local dev (Anvil fork); not needed for testnet/mainnet operation
- `JINN_PASSWORD` env var for keystore encryption

---

## 2. Packaging Format Analysis

### 2.1 npm Package with CLI (Shipped)

**Status:** Published as `@jinn-network/client`. `npm install -g @jinn-network/client` gives the user `jinn` on PATH. The CLI has 17 verbs covering the full operator lifecycle.

**Remaining gap:** No guided interactive setup — all config is via env vars or JSON file. A `jinn quickstart` command (section 3.3) would address this.

### 2.2 Standalone MCP Server (High Value — Needs Building)

**What it would be:** A new MCP server entry point that exposes the full operator workflow as MCP tools, designed to be registered in Claude Code, Cursor, Windsurf, or any MCP-compatible agent.

**Why it matters:** MCP is the emerging standard for agent tool discovery. An agent with the jinn MCP server configured can operate on the network without knowing CLI syntax.

**Proposed tools for a standalone MCP server:**

| Tool | Maps to | Notes |
|------|---------|-------|
| `jinn_init` | `jinn init` | Create wallet, return master address |
| `jinn_doctor` | `jinn doctor` | Preflight checks |
| `jinn_fund_requirements` | `jinn fund-requirements` | Show funding gaps |
| `jinn_bootstrap` | `jinn bootstrap` | Advance state machine |
| `jinn_status` | `jinn status` | Daemon + fleet health |
| `jinn_submit_intent` | `jinn submit-intent` | Post desired state on-chain |
| `jinn_fleet` | `jinn fleet` | Fleet overview |
| `jinn_balance` | `jinn balance` | Wallet balances |
| `jinn_history` | `jinn history` | Activity log |
| `jinn_start_daemon` | `jinn run` | Start daemon (long-running — needs careful design) |
| `jinn_stop_daemon` | `jinn stop` | Stop daemon |

**Implementation approach:** Since the CLI already emits structured JSON, the simplest path is a thin MCP wrapper that shells out to `jinn <verb>` and returns the parsed JSON. This avoids duplicating logic and means the MCP server always matches CLI behavior. A `client/src/mcp/operator-server.ts` that imports from `cli/` directly (without spawning a subprocess) would be even cleaner — each MCP tool calls the same `CommandModule.run()` that the CLI uses.

**Entry point — separate bin, not a CLI subcommand.** The MCP convention is a dedicated binary that speaks stdio, not a subcommand of an existing CLI. Since `jinn` is already a CLI dispatcher, the right pattern is a second `bin` entry in package.json:

```json
"bin": {
  "jinn": "./dist/bin/jinn.js",
  "jinn-mcp": "./dist/mcp/operator-server.js"
}
```

**Registration:** Users add to their MCP config:
```json
{
  "mcpServers": {
    "jinn": {
      "command": "npx",
      "args": ["-p", "@jinn-network/client", "jinn-mcp"],
      "env": { "JINN_PASSWORD": "..." }
    }
  }
}
```

Or if installed globally:
```json
{
  "mcpServers": {
    "jinn": {
      "command": "jinn-mcp",
      "env": { "JINN_PASSWORD": "..." }
    }
  }
}
```

This follows the same pattern as `@modelcontextprotocol/server-github` and similar MCP packages — a dedicated binary that starts a `StdioServerTransport` and runs until stdin closes.

### 2.3 Claude Code Skill / Codex Plugin

**What it would be:** A skill file that teaches Claude Code how to use the jinn CLI or MCP server.

**Assessment:** Lower priority than MCP. A skill is just a prompt template — it tells the agent what tools exist but doesn't provide them. If we have the MCP server (2.2), a skill is useful as a discovery/onboarding layer ("you have jinn tools available, here's how the protocol works"). Without the MCP server, a skill could instruct the agent to use `jinn` CLI commands via Bash, but this is fragile and doesn't work in sandboxed environments.

**Verdict:** Nice-to-have after MCP server ships. Could be a single markdown file that describes the protocol and available tools.

### 2.4 Docker Image (Shipped)

**Status:** Available. Useful for operators who don't want Node.js installed and for cloud/Kubernetes deployment.

**Remaining gap:** Claude Code CLI inside the image (large dependency). Operators running the Docker image may need to mount the Claude binary or use an alternative runner.

### 2.5 Operator Dashboard (Needs Building — High Impact, Low Effort)

**What it is:** A static HTML page served by the existing Hono HTTP server at `GET /` (port 7331). Vanilla JS polls the API endpoints that already exist. No framework, no build step, no new dependencies.

**Why it ships fast:** The HTTP server already runs whenever the daemon is running. The data endpoints (`/v1/status`, `/artifacts/search`) already exist. The implementation is a single HTML file with inline CSS/JS, served as a static asset from `dist/`.

**What it shows (v1):**

| Panel | Data source | Status |
|-------|------------|--------|
| Daemon health | `GET /v1/status` | Endpoint exists |
| Fleet overview | Fleet state from status rollup | In status response |
| RPC connectivity | RPC probe from status | In status response |
| Recent artifacts | `GET /artifacts/search` | Endpoint exists |
| Balances | Master ETH, Safe stOLAS | Partially in status; may need `/v1/balances` |
| Activity log | Intents, restorations, evaluations | Needs new `/v1/history` endpoint |

**Scope for v1:** Dashboard only when daemon is running. Bootstrap visibility stays in the CLI (`jinn bootstrap --human`). The HTTP server starts after bootstrap completes in `daemon.start()` — no refactoring of `main.ts` needed.

**v2 follow-up:** Start the HTTP server before bootstrap and show bootstrap progress on the dashboard. Solves the "is it stuck?" problem during onboarding but requires refactoring `main.ts` to start Hono before calling `bootstrap()`.

**Implementation:**
```
client/src/dashboard/index.html   — single file, inline CSS/JS
client/src/api/server.ts          — add: app.get('/', serves dashboard HTML)
```

**Startup message change:**
```
# Before:
[main] Daemon running. Press Ctrl+C to stop.

# After:
[main] Daemon running. Dashboard: http://127.0.0.1:7331
```

### 2.6 Priority Recommendation

Since npm and Docker are already shipped, the remaining packaging work is:

1. **Operator dashboard** — static HTML at `GET /`, polls existing endpoints. One HTML file, zero deps. Fastest path to "see your agent working."
2. **Standalone operator MCP server** (`jinn-mcp` bin) — highest impact for agent consumption
3. **`jinn quickstart` command** — collapse onboarding into one step
4. **Claude Code skill** — discovery and onboarding layer for MCP-equipped agents

---

## 3. Zero-to-Operating User Flow

### 3.1 Current Flow (What Exists)

```
1. Install Node.js 22
2. npm install -g @jinn-network/client
3. Install Claude Code CLI
4. JINN_PASSWORD=secret jinn init
   → Generates wallet, prints master address
5. JINN_PASSWORD=secret jinn doctor
   → Checks environment readiness
6. JINN_PASSWORD=secret jinn fund-requirements
   → Shows: "Master needs 0.01 ETH on Base Sepolia"
7. [MANUAL] Go to faucet, get testnet ETH, send to master address
8. JINN_PASSWORD=secret jinn bootstrap
   → Deploys Safe, registers service, stakes, deploys mech
9. JINN_PASSWORD=secret jinn run
   → Daemon starts, 3 loops running
```

**Pain points:**
- Step 7 is a manual faucet visit — breaks the automated flow
- No single command does steps 4-9
- Password must be set in every command (no session or keyring)
- Default network is testnet (good for onboarding) but config file must be created for any customization

### 3.2 Ideal Flow (What We Should Build)

**Fully automated — zero manual intervention:**
```
npm install -g @jinn-network/client
jinn quickstart
```

That's it. The `quickstart` command:
1. Auto-generates a keystore password, saves to `~/.jinn-client/keystore-password`
2. Creates wallet (idempotent)
3. Funds master wallet via CDP faucet (shipped API key)
4. Bootstraps (Safe → service → staking → mech)
5. Starts daemon
6. Prints:
   ```
   Your agent is running.
   Dashboard: http://127.0.0.1:7331

   Your keystore password was auto-generated and saved to:
     ~/.jinn-client/keystore-password
   To set your own password: jinn keys change-password
   ```

The only prerequisite is Claude Code installed and authenticated (the daemon spawns it as a subprocess for restoration work).

**For MCP-first users:**
```
1. Add to MCP config:
   { "mcpServers": { "jinn": { "command": "npx", "args": ["-p", "@jinn-network/client", "jinn-mcp"] } } }
2. Tell your agent: "Set up a Jinn agent on testnet"
3. Agent calls jinn_quickstart → fully automated, same as above
```

### 3.3 Proposed `jinn quickstart` Command

A new CLI verb that combines init + fund + bootstrap + run into a fully automated flow:

```
jinn quickstart [--no-daemon]

Steps:
  1. password    — generate random password, save to ~/.jinn-client/keystore-password
                   (skip if JINN_PASSWORD is set — respect explicit operator choice)
  2. init        — create wallet with generated/provided password (idempotent)
  3. fund-check  — check balances
  4. auto-fund   — attempt Coinbase CDP faucet (shipped key; operator can override via CDP env vars)
  5. wait-fund   — if auto-fund fails, print address + faucet URL, poll until funded
  6. bootstrap   — advance state machine to completion
  7. run         — start daemon (unless --no-daemon)
```

This doesn't replace the individual verbs — operators still need granular control. But it collapses the 80% case into a single command with zero manual steps.

### 3.4 Proposed `jinn keys change-password` Command

Allows operators to replace the auto-generated password with their own:

```
jinn keys change-password

Steps:
  1. Read current password from ~/.jinn-client/keystore-password (or JINN_PASSWORD)
  2. Decrypt mnemonic
  3. Prompt for new password (or read from --password-fd / JINN_NEW_PASSWORD)
  4. Re-encrypt mnemonic with new password
  5. Overwrite mnemonic.keystore.json
  6. Delete keystore-password file
  7. Print: "Password changed. Set JINN_PASSWORD for future commands."
```

The wallet, Safe, staking, and all on-chain state are unchanged — the password only protects the local keystore file. This is the expected path for operators moving from testnet to mainnet: run `quickstart` with auto-generated password, then `change-password` before real funds are involved.

---

## 4. What Can Be Automated vs. What Needs Human Input

### 4.1 Fully Automatable

| Step | How |
|------|-----|
| Wallet creation | `jinn init` — deterministic from password |
| Safe prediction + deployment | Bootstrap state machine |
| Service registration + staking | Bootstrap state machine |
| Mech deployment | Bootstrap state machine |
| Config generation | Defaults cover testnet; `jinn init` creates keystore dir |
| RPC endpoint | Defaults to `https://sepolia.base.org` for testnet |
| Daemon startup | `jinn run` |

### 4.2 Automatable with External Dependency

| Step | Dependency | Automation Path |
|------|-----------|-----------------|
| Testnet ETH funding | Coinbase CDP API key | `cdp.evm.requestFaucet({ address, network: "base-sepolia", token: "eth" })` — free tier, 1 claim/24h/address |
| Claude API access | User's Anthropic API key or Claude Max subscription | Claude Code CLI handles this; user must have it configured separately |

### 4.3 Requires Human Decision

| Step | Why |
|------|-----|
| Claude Code CLI installation | Separate product, separate auth flow — must be done before `jinn quickstart` |
| Mainnet ETH funding | Real money; no faucet |
| Custom desired states | Domain-specific; operator defines what their agent should do |
| Network choice (testnet vs mainnet) | Operational decision (default testnet is correct for onboarding) |
| Password change (optional) | Auto-generated for quickstart; operator should change before mainnet via `jinn keys change-password` |

### 4.4 Coinbase CDP Faucet — Implementation Notes

The Coinbase Developer Platform provides a programmatic faucet for Base Sepolia:

```typescript
// Using @coinbase/cdp-sdk
import { CdpClient } from '@coinbase/cdp-sdk';

const cdp = new CdpClient(); // Uses CDP_API_KEY_ID + CDP_API_KEY_SECRET env vars
await cdp.evm.requestFaucet({
  address: masterAddress,
  network: "base-sepolia",
  token: "eth"
});
```

**Constraints:**
- **Requires a free CDP API key** — sign up at cdp.coinbase.com, then set `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` env vars. This is an extra signup step, which weakens the "just works" story.
- Rate limited: 1 claim per 24 hours per address
- Only testnet — not a mainnet solution
- Dispenses a small amount (~0.1 ETH, varies) which is sufficient for bootstrap gas

**Bottom line on testnet funding:** There is no zero-auth programmatic faucet for Base Sepolia. Every option requires either a CDP API key signup (Coinbase) or a manual web UI visit (Alchemy, Circle).

**Ship a Jinn-project CDP API key in the package?** Yes — this is the cleanest path to zero-friction onboarding. Create a dedicated CDP API key under a Jinn project account and embed it as a default in the client. The key is free-tier and rate-limited (1 claim/24h/address), so abuse risk is bounded. Operators can override with their own key via `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` env vars.

Considerations for shipping a public key:
- CDP free tier rate limits are per-address, not per-key — an attacker can't drain the faucet for all users
- The key only grants testnet faucet access (no mainnet, no wallet control)
- If Coinbase revokes the key, `jinn quickstart` falls back to printing the manual faucet URL — not a hard failure
- Monitor usage via the CDP dashboard; rotate if abused

**Integration recommendation:** Ship a default CDP API key for testnet auto-funding. Allow override via env vars. Don't add `@coinbase/cdp-sdk` as a hard dependency — dynamic import with a helpful error message if missing. Fall back to manual faucet URL (`https://faucet.circle.com/` or `https://www.coinbase.com/faucets/base-ethereum/sepolia`) if the SDK isn't installed or the faucet call fails.

**Alternative faucets (web-only, no API):**
- Alchemy Base Sepolia faucet — web UI only, 1 claim/24h
- Circle faucet (faucet.circle.com) — web UI, supports Base Sepolia

---

## 5. Standalone MCP Server Design (Detailed)

### 5.1 Architecture Decision: CLI Wrapper vs. Direct Integration

**Option A — Shell out to `jinn` CLI:**
```typescript
// Simple but requires jinn on PATH
const result = execSync('jinn status --json', { env: { JINN_PASSWORD: password } });
return JSON.parse(result.toString());
```

Pros: Zero code duplication, always matches CLI behavior.
Cons: Requires global install, subprocess overhead, can't manage daemon lifecycle easily.

**Option B — Import CLI command modules directly:**
```typescript
// Direct integration, no subprocess
import statusCommand from './cli/commands/status.js';
const output = new StringWriter();
await statusCommand.run({ argv: [], writer: output, ... });
return JSON.parse(output.toString());
```

Pros: No subprocess overhead, single process, can share state.
Cons: CLI commands call `process.exit()` on errors (via `emitEnvelope`), need to refactor exit behavior.

**Option C — Import library layer, bypass CLI:**
```typescript
// Use exports from index.ts directly
import { FleetBootstrapper, Daemon, MechAdapter, ClaudeRunner, loadConfig } from '@jinn-network/client';
```

Pros: Cleanest, most flexible.
Cons: Most work — need to reimplement the orchestration that `main.ts` does.

**Recommendation:** Option B for most tools (the CLI commands already do JSON I/O with injectable writers and exits), with Option C for daemon lifecycle (start/stop need in-process control). The `emitEnvelope` function already accepts `{ writer, exit }` — passing a no-op exit function prevents process termination.

### 5.2 Daemon Lifecycle in MCP Context

The daemon (`jinn run`) is a long-running process. In MCP, tools are request/response. Two approaches:

**A. Background process management:**
- `jinn_start_daemon` spawns `jinn run` as a detached subprocess, returns PID
- `jinn_stop_daemon` sends SIGTERM to the PID (pidfile already written to `~/.jinn-client/earning/daemon.pid`)
- `jinn_status` reads from the HTTP API at `:7331/v1/status`

**B. In-process daemon:**
- The MCP server itself hosts the daemon (long-lived MCP server = long-lived daemon)
- Tools like `jinn_status` query in-process state
- MCP server shutdown = daemon shutdown

Option A is simpler and matches existing architecture. The daemon already writes a pidfile and `jinn stop` already exists.

### 5.3 MCP Server Entry Point

New bin: `jinn-mcp` (not a CLI subcommand — separate binary, per MCP convention)

```
jinn-mcp

Starts an MCP server on stdio (StdioServerTransport).
Exposes operator-level tools for agent consumption.
Long-lived — runs until stdin closes or SIGTERM.
Reads JINN_PASSWORD from env (same as jinn CLI).
```

Implementation: a new file at `client/src/mcp/operator-server.ts` with a corresponding `client/src/bin/jinn-mcp.ts` entry point. Add `"jinn-mcp": "./dist/bin/jinn-mcp.js"` to the `bin` field in package.json.

---

## 6. Comparison: How Other Agent Ecosystems Handle Onboarding

### 6.1 LangChain Tools

- Published as pip packages (`pip install langchain-community`)
- Each tool is a Python class with `_run()` method
- Configuration via constructor args or env vars
- No daemon — stateless tool invocations
- **Lesson:** Stateless tools are easiest to distribute. Jinn's protocol requires state (wallet, staking), which adds irreducible complexity.

### 6.2 CrewAI Tools

- Published as pip packages (`pip install crewai-tools`)
- Tools are decorated functions
- Config via env vars
- **Lesson:** Simple tool surface, but doesn't solve the "persistent service" problem that Jinn has.

### 6.3 MCP Ecosystem (Anthropic)

- MCP servers published as npm packages
- Registered in `~/.claude/mcp.json` or project-level config
- `npx` as the standard launch mechanism (no global install needed)
- Examples: `@modelcontextprotocol/server-github`, `@modelcontextprotocol/server-filesystem`
- **Lesson:** `npx` launch is the convention. The MCP config JSON is the discovery mechanism. This is the right model for Jinn.

### 6.4 OLAS (Jinn's Current Foundation)

- Agents packaged as Docker images registered on-chain
- Complex setup: Safe wallet, service registration, staking, mech deployment
- Managed via `autonomy` CLI (Python)
- **Lesson:** Jinn's `jinn` CLI already simplifies this significantly vs. raw OLAS tooling. The bootstrap state machine is a major improvement.

---

## 7. Recommendations

### 7.1 Immediate (This Sprint)

1. **Operator dashboard.** Single HTML file served at `GET /` by the existing Hono server. Polls `/v1/status` and `/artifacts/search`. Zero new dependencies, ships in the npm package. v1 scope: daemon-only (no bootstrap view). Changes the startup message from "Press Ctrl+C to stop" to "Dashboard: http://127.0.0.1:7331".

2. **Add `jinn-mcp` bin entry.** Thin MCP server wrapping CLI commands via a dedicated binary (per MCP convention). Start with read-only tools (`jinn_status`, `jinn_doctor`, `jinn_fleet`, `jinn_balance`, `jinn_history`) plus `jinn_init`.

### 7.2 Near-term (Next 2 Weeks)

3. **Add write tools to MCP server.** `jinn_bootstrap`, `jinn_submit_intent`, `jinn_start_daemon`, `jinn_stop_daemon`. These require careful error handling since they mutate state.

4. **Add `jinn quickstart` verb.** Guided flow combining init + fund-check + bootstrap + run.

5. **Testnet faucet integration.** Ship a Jinn-project CDP API key for auto-funding (see section 4.4). Dynamic import of `@coinbase/cdp-sdk`, falls back to manual faucet URL if unavailable.

### 7.3 Medium-term

6. **Dashboard v2 — bootstrap visibility.** Start Hono before `bootstrap()`, show bootstrap progress on the dashboard. Addresses the "is it stuck?" problem during onboarding.

7. **Claude Code skill.** A markdown skill file that describes the Jinn protocol and teaches agents how to use the MCP tools. Distributable via the npm package or a separate skill registry.

6. **Codex / Cursor / Windsurf plugin manifests.** These ecosystems are converging on MCP, so the MCP server covers them. If any require custom plugin formats, create thin wrappers.

### 7.4 Architecture Principle

**The CLI is the source of truth.** Every packaging format (MCP server, skill, Docker, plugin) should delegate to the CLI or its underlying modules. This prevents behavioral divergence and means testing the CLI tests everything.

---

## 8. Gap Analysis: Existing MCP Server vs. Complete Agent Experience

| Capability | Task MCP (existing) | Operator MCP (proposed) |
|------------|-------------------|------------------------|
| Understand current task | `get_desired_state` | N/A (operator level) |
| Submit work result | `submit_restoration_result` | N/A (daemon handles) |
| Search knowledge | `search_artifacts`, `acquire_artifact` | `jinn_history` |
| Create wallet | - | `jinn_init` |
| Check readiness | - | `jinn_doctor` |
| Fund wallet | - | `jinn_fund_requirements` |
| Bootstrap infra | - | `jinn_bootstrap` |
| Start operating | - | `jinn_start_daemon` |
| Monitor health | - | `jinn_status` |
| Submit intents | - | `jinn_submit_intent` |
| Check earnings | - | `jinn_rewards`, `jinn_balance` |

The existing task MCP server and the proposed operator MCP server serve different roles and different agents. The task MCP server is for the *inner agent* (Claude subprocess doing restoration work). The operator MCP server is for the *outer agent* (the user's agent that manages Jinn operations). Both should exist.

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MCP server daemon management is fragile | Medium | Medium | Use existing pidfile + HTTP API pattern |
| Shipped CDP API key gets revoked/abused | Low | Low | Rate limits are per-address; fallback to manual faucet URL; monitor via CDP dashboard |
| CDP faucet rate limits block multi-service bootstrap | High | Low | Only need ~0.01 ETH; one faucet claim is sufficient |
| Claude Code CLI not installed | High | High (can't run daemon) | `jinn doctor` already checks this; clear error message |
| Testnet contracts redeploy breaks config | Medium | High | Ship deployment artifacts in npm package (`deployments/` is in `files`) |

---

## 10. Open Questions

1. **Should the MCP server manage its own daemon, or require a separate `jinn run` process?** Background process management (Option A in 5.2) is simpler but means two processes. In-process (Option B) is cleaner but couples MCP lifetime to daemon lifetime.

2. **Is `@jinn-network/client` the right package name for external operators?** Consider whether a separate `@jinn-network/agent` package with fewer dependencies (no Hardhat, no test fixtures) would be better for distribution.

3. **Should quickstart default to stOLAS (standard) staking mode?** Standard mode doesn't require OLAS tokens, lowering the funding barrier. This is already the default.

4. **Do we need a hosted RPC endpoint?** The default `https://sepolia.base.org` is rate-limited. For onboarding, it works. For production, operators will need their own. Should we provide one during testnet phase?
