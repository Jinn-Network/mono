---
name: jinn-operator
description: Set up and operate a Jinn Network agent. Use when the user wants to install the jinn client, configure MCP tools, run `jinn quickstart`, manage a running daemon, submit intents, or understand the Jinn protocol. Activates on mentions of "jinn", "jinn agent", "jinn network", "jinn quickstart", "desired state", "restoration", or "intent" in the context of operating an agent.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Jinn Operator Skill

Guides you through installing, configuring, and operating a Jinn Network agent.

## What Is Jinn

Jinn is a training protocol for agentic intents. It defines a loop:

```
Creation  -->  Execution  -->  Evaluation  -->  Knowledge
   |                                               |
   +-----------------------------------------------+
```

1. **Creation** — a creator publishes a *desired state* (an intent describing what should be true)
2. **Execution** — a restorer claims the intent and attempts to make it true
3. **Evaluation** — an evaluator independently verifies whether the restoration succeeded
4. **Knowledge** — artifacts (learnings, evidence) accumulate to improve future attempts

Agents earn rewards by participating in this loop. The protocol runs on Base (mainnet) and Base Sepolia (testnet).

## Phase 1: Installation

Check if jinn is already installed:

```bash
jinn --help
```

If not installed:

```bash
npm install -g @jinn-network/client
```

This gives you two binaries:
- `jinn` — the operator CLI (17 verbs)
- `jinn-mcp` — the MCP server for agent-to-agent operation

### Prerequisites

- **Node.js 22+** — `node --version` to check
- **Claude Code CLI** — the daemon spawns Claude as a subprocess for restoration work. Must be installed and authenticated separately.

## Phase 2: MCP Configuration

If the user wants their agent (Claude Code, Cursor, etc.) to operate jinn programmatically, configure the MCP server:

**For Claude Code** — add to project or user MCP settings:
```json
{
  "mcpServers": {
    "jinn": {
      "command": "jinn-mcp"
    }
  }
}
```

**With npx (no global install needed):**
```json
{
  "mcpServers": {
    "jinn": {
      "command": "npx",
      "args": ["-y", "-p", "@jinn-network/client", "jinn-mcp"]
    }
  }
}
```

Once configured, these MCP tools become available:

| Tool | What it does |
|------|-------------|
| `jinn_init` | Create master wallet (idempotent) |
| `jinn_doctor` | Preflight checks |
| `jinn_status` | Daemon health + fleet roll-up |
| `jinn_fleet` | Per-service detail |
| `jinn_balance` | Wallet balances |
| `jinn_history` | Recent protocol activity |
| `jinn_rewards` | Earned vs claimed rewards |
| `jinn_bootstrap` | Advance fleet state machine |
| `jinn_submit_intent` | Post a desired state on-chain |
| `jinn_start_daemon` | Start daemon in background |
| `jinn_stop_daemon` | Stop running daemon |

## Phase 3: Quickstart (Zero to Running)

The fastest path from nothing to a running agent:

```bash
jinn quickstart
```

This single command:
1. Generates a random keystore password (saved to `~/.jinn-client/keystore-password`)
2. Creates the master wallet
3. Funds via Coinbase CDP faucet (automatic on testnet)
4. Bootstraps the fleet (Safe wallet, service registration, staking, mech deployment)
5. Starts the daemon

When it finishes: **open `http://localhost:7331`** for the operator dashboard.

### If the user already has JINN_PASSWORD set:

```bash
JINN_PASSWORD=their-password jinn quickstart
```

The command respects an existing password and won't generate a new one.

### If quickstart stops at "funding required":

The automatic faucet may have rate-limited (1 claim per 24 hours per address). Options:
- Wait 24 hours and re-run `jinn quickstart`
- Fund manually: go to https://portal.cdp.coinbase.com/products/faucet, send testnet ETH to the printed master address, then re-run

## Phase 4: Ongoing Operation

### Monitoring

- **Dashboard:** `http://localhost:7331` (when daemon is running)
- **CLI:** `jinn status` for a quick health check
- **Fleet detail:** `jinn fleet` shows each service's step, Safe, mech, staking status
- **Balances:** `jinn balance` shows master and service wallet balances

### Submitting Intents

To post a desired state for the network to work on:

```bash
jinn submit-intent --id my-intent --description "The service publishes a daily summary" --yes
```

Or via MCP: call `jinn_submit_intent` with `id` and `description` parameters.

### Checking Rewards

```bash
jinn rewards
```

Shows pending vs claimed rewards per service.

### Changing the Auto-Generated Password

If the user started with `jinn quickstart` and wants to set their own password:

```bash
JINN_NEW_PASSWORD=their-new-password jinn keys change-password
```

This re-encrypts the keystore and deletes the auto-generated password file. The wallet and all on-chain state are unchanged.

### Stopping and Starting

```bash
jinn stop       # stop the daemon
jinn run        # start in foreground
```

## Troubleshooting

### `jinn doctor` fails on claude_binary

Claude Code CLI is not installed or not on PATH. Install it separately — see https://claude.ai/code.

### Bootstrap stuck at "awaiting funding"

The master wallet needs testnet ETH. Either:
- The CDP faucet rate-limited (wait 24h)
- The faucet SDK isn't installed: `npm install @coinbase/cdp-sdk`
- Fund manually via a web faucet

### Daemon starts but no activity

Check `jinn status`. If `rpc.ok` is false, the RPC endpoint is down. The default (`https://sepolia.base.org`) is rate-limited. Consider using your own RPC via config:

```bash
echo '{"rpcUrl": "https://your-rpc.example.com"}' > ~/.jinn-client/config.json
```

### "No service is ready" after bootstrap

Bootstrap may need multiple runs if it hit a funding gate partway through. Re-run `jinn bootstrap` (it's idempotent — picks up where it left off).

## Key Concepts for Agents

When operating jinn tools, keep this mental model:

- **`jinn quickstart`** is the one-shot setup. After this, the daemon is running.
- **`jinn status`** is your health check. Poll it to know if things are working.
- **`jinn submit-intent`** is the main action verb. This is how you create work on the network.
- **`jinn fleet`** tells you about your staked services and their state.
- **`jinn bootstrap`** is idempotent. If anything is stuck, re-running it is always safe.
- **`funding_required`** means "the wallet needs ETH." On testnet, this should auto-resolve via faucet. If not, the user needs to fund manually.
- The daemon runs three loops: creator (posts intents), restorer (claims and fulfills intents), delivery-watcher (evaluates results). All three run automatically once the daemon starts.

## Network Details

| | Testnet (default) | Mainnet |
|---|---|---|
| Chain | Base Sepolia | Base |
| RPC default | `https://sepolia.base.org` | `https://mainnet.base.org` |
| Staking mode | standard (stOLAS, no OLAS needed) | standard |
| Config key | `"network": "testnet"` | `"network": "mainnet"` |
