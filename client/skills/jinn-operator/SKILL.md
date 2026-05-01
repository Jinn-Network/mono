---
name: jinn-operator
description: Set up and operate a Jinn Network agent. Use when the user wants to install the jinn client, configure MCP tools, run `jinn run`, manage a running daemon, submit intents, or understand the Jinn protocol. Activates on mentions of "jinn", "jinn agent", "jinn network", "jinn run", "desired state", "restoration", or "intent" in the context of operating an agent.
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

This gives you the `jinn` operator CLI. The built-in MCP server is invoked via `jinn mcp` (see Phase 2).

### Prerequisites

- **Node.js 22+** — `node --version` to check
- **Claude Code CLI** — the daemon spawns Claude as a subprocess for restoration work. Must be installed and authenticated separately.

### CLI verb reference

<!-- skill:cli-table:start -->
| Verb | What it does |
|------|--------------|
| `jinn version` | Print client version, protocol phase, and resolved token map |
| `jinn doctor` | Preflight checks: answers "would jinn run work?" without running it |
| `jinn init` | Generate the master wallet and write the encrypted keystore |
| `jinn auth` | Check Claude authentication and persist how the operator runs the daemon |
| `jinn bootstrap` | Advance the fleet state machine toward a running daemon |
| `jinn fund-requirements` | List addresses that need funding before the next bootstrap step |
| `jinn run` | Zero-to-running in one command: init, fund, bootstrap, then start the daemon in the foreground (stops on SIGINT/SIGTERM) |
| `jinn stop` | Signal a running jinn daemon to shut down gracefully |
| `jinn status` | Daemon liveness + roll-up (poll this for monitoring; pull detail separately) |
| `jinn fleet` | Per-service fleet detail (wallets, staking, rewards, attention) |
| `jinn balance` | Flat per-wallet balance map across master and service wallets |
| `jinn history` | Recent protocol activity (intents, claims, deliveries, evaluations, rewards) |
| `jinn rewards` | Earned vs claimed per service, per asset; next checkpoint time |
| `jinn logs` | Structured event log (one JSON object per line) |
| `jinn submit-intent` | Post a desired state (restoration job) to the protocol |
| `jinn claim-rewards` | Pull pending protocol rewards to the fleet multisigs |
| `jinn withdraw` | Sweep master / agents per withdraw flags |
| `jinn keys` | Keystore management: backup, change-password |
| `jinn plugin` | Configure AI tools to use Jinn MCP server and operator skill |
| `jinn update` | Update the client package and refresh plugins in all configured AI tools |
| `jinn intents` | List, enable, or disable restoration of specific intent kinds. |
| `jinn mcp` | Run the operator MCP server over stdio |
| `jinn migrate-agent-id` | Backfill ERC-8004 agent_id on legacy complete services (jinn-mono-jgp) |
| `jinn conformance` | Run the envelope + trajectory conformance suite against a signed envelope CID |
<!-- skill:cli-table:end -->

## Phase 2: MCP Configuration

If the user wants their agent (Claude Code, Cursor, etc.) to operate jinn programmatically, configure the MCP server:

**For Claude Code** — run `jinn plugin install` (installs automatically) or add to project/user MCP settings manually:
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

<!-- skill:mcp-table:start -->
| Tool | What it does |
|------|--------------|
| `jinn_auth` | Read-only: check Claude authentication status and the resolved runtime mode (bare/docker-compose/container). Does NOT attempt login — it only probes and reports. Use this as the first call to verify the agent path is ready. Returns authenticated:true + context + email on success; returns an error envelope if not authenticated. Fast (<1s). |
| `jinn_doctor` | Preflight checks: node version, claude binary, keystore, deployment config. Read-only. Fast (<5s). |
| `jinn_fund_requirements` | Read-only: list addresses and amounts that need funding before bootstrap can advance. Note: the underlying command may hydrate wallet state as a side effect of checking funding. Returns an array of funding gaps; empty array means all funded. |
| `jinn_status` | Daemon liveness and fleet health roll-up. Read-only. Poll this to monitor progress. Fast (<2s). |
| `jinn_fleet` | Per-service fleet detail: wallets, staking status, activity counts. Read-only. Fast (<5s). |
| `jinn_balance` | Flat per-wallet balance map across master and service wallets. Read-only. Requires RPC. Fast (<5s). |
| `jinn_history` | Recent protocol activity: intents, claims, deliveries, evaluations, rewards. Read-only from local DB. Fast (<2s). |
| `jinn_logs` | Recent activity event log from the local SQLite store. Read-only. Fast (<2s). Returns events with ts, level, component, msg fields. Call with limit=100 for monitoring; increase for deeper history. |
| `jinn_rewards` | Pending and claimed reward balances per staked service. Read-only. Requires RPC access. Fast (<5s). Returns per-service pending/claimed amounts and next checkpoint time. |
| `jinn_intents_list` | List all registered intent kinds with their enabled/ready state. Read-only. Fast (<2s). |
| `jinn_intents_status` | Detailed status for one intent kind: impl, enabled, ready, nextStep. Read-only. Fast (<2s). |
| `jinn_intents_enable` | MUTATING: Opt in to restoring a specific intent kind. Idempotent. Calls impl.onEnable which may write config. Fast unless impl requires external action. Pass extra_args as space-separated "--key=value" pairs for impl-specific options (e.g. "--hl-master=0x..."). |
| `jinn_intents_disable` | MUTATING: Opt out of restoring a specific intent kind. Writes config. Idempotent. Fast (<1s). |
| `jinn_init` | MUTATING. Create the master wallet and write the encrypted keystore. Idempotent: re-runs return the existing master address. Requires confirm: true; default is preview (no filesystem write). |
| `jinn_run` | MUTATING: Zero-to-running in one call: resolve/generate password, init wallet, bootstrap fleet, start daemon. Idempotent — safe to call repeatedly; resumes from last completed step. Long-running: can take up to 30 minutes if funding is required. Returns a progress stream via --json-progress; poll jinn_status to monitor after this returns. Use no_daemon=true to skip starting the daemon (useful for CI or when the daemon is managed separately). |
| `jinn_bootstrap` | MUTATING. Advance the fleet state machine. Idempotent. May take several minutes; can post on-chain transactions and request testnet faucet funds. Returns funding_required if a wallet needs ETH. Requires confirm: true; default is preview (no chain or filesystem mutation). |
| `jinn_submit_intent` | MUTATING. Post a desired state (restoration job) to the protocol. Idempotent by id. Sends an on-chain transaction and pays gas when confirmed. Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action). |
| `jinn_claim_rewards` | MUTATING. Pull pending protocol rewards to the fleet multisigs. Idempotent: zero-delta exits 0. Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action). |
| `jinn_update` | MUTATING: Update the client package and refresh installed plugins. Step 1: npm update -g @jinn-network/client Step 2: jinn plugin install (refreshes skills in all configured AI tools). May take 1-2 minutes. Use skip_npm=true to only refresh plugins with the current version. |
| `jinn_start_daemon` | MUTATING. Start the jinn daemon as a detached background process. Spawns a long-lived child process and writes a pidfile. Requires confirm: true; default is preview (does not spawn a process). |
| `jinn_stop_daemon` | MUTATING. Stop the running jinn daemon. Idempotent: returns success even if already stopped. Requires confirm: true; default is preview (does not signal any process). |
<!-- skill:mcp-table:end -->

## Phase 3: Zero to Running

The canonical first-run path — run these two commands in order:

```bash
# Step 1 — one-time: pick runtime mode and authenticate Claude Code (interactive TTY required).
jinn auth

# Step 2 — zero-to-running: auto-generates a keystore password, then init → fund → bootstrap → run.
jinn run
```

`jinn auth` persists the runtime-mode choice so all subsequent commands agree on how to spawn Claude.
`jinn run` then:
1. Generates a random keystore password (saved to `~/.jinn-client/keystore-password`, mode 0600)
2. Creates the master wallet
3. Funds via Coinbase CDP faucet (automatic on testnet)
4. Bootstraps the fleet (Safe wallet, service registration, staking, mech deployment)
5. Starts the daemon

When it finishes: **open `http://localhost:7331`** for the operator dashboard.

### Advanced / CI: explicit password

If you want to manage the password yourself (recommended for production or CI pipelines), set `JINN_PASSWORD` before calling `jinn run`. No file will be written to disk:

```bash
JINN_PASSWORD=their-password jinn run
```

For CI, prefer reading the password from a file descriptor: `--password-fd N`.

### If `jinn run` stops at "funding required":

The automatic faucet may have rate-limited (1 claim per 24 hours per address). Options:
- Wait 24 hours and re-run `jinn run`
- Fund manually: go to https://portal.cdp.coinbase.com/products/faucet, send testnet ETH to the printed master address, then re-run

## Phase 3.5: Opting In to Intent Kinds

After `jinn run` brings the fleet up, the daemon participates in `legacy` (health-check) and `prediction.v0` intents by default. Other intent kinds are **off by default** because they require operator-specific credentials (exchange authorizations, API keys, etc.).

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

Or via MCP: call `jinn_submit_intent` with `id` and `description`. Mutating MCP tools default to a preview envelope; pass `confirm: true` to actually post on-chain. Other mutating tools (`jinn_init`, `jinn_bootstrap`, `jinn_start_daemon`, `jinn_stop_daemon`) follow the same `confirm: true` rule.

### Checking Rewards

```bash
jinn rewards
```

Shows pending vs claimed rewards per service.

### Changing the Auto-Generated Password

If the user started with `jinn run` and wants to set their own password:

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

- **`jinn run`** is the one-shot setup. After this, the daemon is running.
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
