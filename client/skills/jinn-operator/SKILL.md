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

This gives you one binary:
- `jinn` — the operator CLI (17 verbs); run `jinn mcp` to start the MCP server

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
      "command": "jinn",
      "args": ["mcp"]
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
      "args": ["-y", "-p", "@jinn-network/client", "jinn", "mcp"]
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

## Phase 3.5: Opting In to Intent Kinds

After quickstart, the daemon participates in `legacy` (health-check) and `prediction.v0` intents by default. Other intent kinds are **off by default** because they require operator-specific credentials (exchange authorizations, API keys, etc.).

### Generic flow (applies to every intent kind with external deps)

**Always start with `list`.** It tells you what's enabled, what's ready, and for disabled kinds, what running `enable` would need.

```bash
jinn intents list --human
```

Example output for a fresh operator:
```
kind           enabled   ready   notes
portfolio.v0   no        no      HL api-wallet not provisioned
prediction.v0  yes       yes
```

### Enabling a kind (idempotent state machine)

```bash
jinn intents enable <kind> [--key=value ...]
```

The command is idempotent. Rerun the same command until the response has `"status": "ready"`. Intermediate states tell you exactly what to do:

- `"status": "missing_args"` — the envelope lists `required` args. Re-run with them. Shape:
  ```json
  {
    "status": "missing_args",
    "required": [{"name": "hl-master", "description": "...", "required": true}],
    "example": {"cli": "jinn intents enable portfolio.v0 --hl-master 0x..."}
  }
  ```

- `"status": "waiting_for_external_action"` — the operator needs to do something out-of-band (e.g., approve an api-wallet on an exchange). Show the `action.description` and `action.url` to the operator. When they confirm done, run the command in `nextInvocation.cli`. Shape:
  ```json
  {
    "status": "waiting_for_external_action",
    "action": {"description": "...", "url": "https://..."},
    "details": {"apiWalletAddress": "0x..."},
    "nextInvocation": {"cli": "jinn intents enable <kind> --confirm-approved", "purpose": "..."}
  }
  ```

- `"status": "ready"` — the kind is enabled. The daemon will now claim intents of this kind. No further action.

- `"status": "error"` — surface `message` to the operator.

### Disabling

```bash
jinn intents disable <kind>
```

Removes the kind from the operator's claim rotation. Preserves any generated key material so a later `enable` doesn't re-initialize exchange approvals.

### Example: enabling portfolio.v0

portfolio.v0 requires a Hyperliquid master account (holds USDC) and an approved HL api-wallet (agent key). The enable flow walks the operator through it:

1. Run list to see what's needed:
   ```bash
   jinn intents list --human
   jinn intents status portfolio.v0 --human
   ```

2. First invocation generates the api-wallet keypair and returns `waiting_for_external_action` with the wallet address and the HL URL:
   ```bash
   jinn intents enable portfolio.v0 --hl-master 0xYOUR_HL_MASTER
   ```

3. Surface the wallet address and URL to the operator. They approve the address on HL (Settings → API Wallets → Add).

4. Once they confirm, re-run with `--confirm-approved`:
   ```bash
   jinn intents enable portfolio.v0 --confirm-approved
   ```
   Envelope returns `"status": "ready"`. Config is updated. Daemon will claim future portfolio.v0 requests.

### Runtime guardrail

The daemon checks each impl's readiness before spending gas on a claim transaction. If a portfolio.v0 request arrives and the api-wallet is missing/unapproved, the intent is marked FAILED locally with a reason pointing back to `jinn intents enable portfolio.v0 ...`. No gas wasted.

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
