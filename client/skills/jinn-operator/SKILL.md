---
name: jinn-operator
description: Set up and operate a Jinn Network agent. Use when the user wants to install the jinn client, configure MCP tools, run `jinn run`, manage a running daemon, submit Tasks, or understand the Jinn protocol. Activates on mentions of "jinn", "jinn agent", "jinn network", "jinn run", "Task", "SolverNet", "restoration", or "SolverPlugin" in the context of operating an agent.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Jinn Operator Skill

Guides you through installing, configuring, and operating a Jinn Network agent.

## What Is Jinn

Jinn is a training protocol for agentic Tasks. It defines a loop:

```
Creation  -->  Execution  -->  Evaluation  -->  Knowledge
   |                                               |
   +-----------------------------------------------+
```

1. **Creation** — a creator publishes a Task describing work the network should perform
2. **Execution** — a Solver claims the Task and attempts to solve it through the selected SolverNet
3. **Evaluation** — an evaluator independently verifies whether the restoration succeeded
4. **Knowledge** — artifacts (learnings, evidence) accumulate to improve future attempts

Agents earn rewards by participating in this loop. The public testnet runs on Base Sepolia; Base mainnet is reserved for the later Phase 2 graduation.

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
- **Claude Code CLI** — the daemon spawns Claude as a subprocess for restoration work. It must be installed; if auth or runtime setup is needed, `jinn run` opens the operator app and guides the user through it.

### CLI verb reference

<!-- skill:cli-table:start -->
| Verb | What it does |
|------|--------------|
| `jinn version` | Print client version, protocol phase, and resolved token map |
| `jinn doctor` | Preflight checks: answers "would jinn run work?" without running it |
| `jinn init` | Generate the master wallet and write the encrypted keystore |
| `jinn quickstart` | Legacy compatibility alias for zero-to-running setup; prefer jinn run |
| `jinn auth` | Legacy compatibility: check Claude authentication and persist daemon runtime mode |
| `jinn bootstrap` | Advance the fleet state machine toward a running daemon |
| `jinn fund-requirements` | List addresses that need funding before the next bootstrap step |
| `jinn run` | Start the daemon in the foreground; stops on SIGINT/SIGTERM |
| `jinn stop` | Signal a running jinn daemon to shut down gracefully |
| `jinn kill` | Force-terminate jinn daemon processes discovered by cmdline enumeration |
| `jinn status` | Daemon liveness + roll-up (poll this for monitoring; pull detail separately) |
| `jinn fleet` | Per-service fleet detail (wallets, staking, rewards, attention) |
| `jinn balance` | Flat per-wallet balance map across master and service wallets |
| `jinn history` | Recent protocol activity (Tasks, claims, deliveries, evaluations, rewards) |
| `jinn rewards` | Staking collector queue per service; next checkpoint time |
| `jinn logs` | Structured event log (one JSON object per line) |
| `jinn claim-rewards` | Pull pending protocol rewards to the fleet multisigs |
| `jinn withdraw` | Sweep master / agents per withdraw flags |
| `jinn keys` | Keystore management: backup, change-password |
| `jinn update` | Update the client package, run local Task-native preflight, and refresh integrations |
| `jinn mcp` | Run the operator MCP server over stdio |
| `jinn migrate-agent-id` | Backfill ERC-8004 agent_id on legacy complete services (jinn-mono-jgp) |
| `jinn backfill-failed-deliveries` | Reclassify FAILED runs as COMPLETE when their delivery tx actually succeeded (#506) |
| `jinn conformance` | Run the envelope + trajectory conformance suite against a signed envelope CID |
| `jinn evidence` | Read delivered evidence — resolve a task id to an envelope, and an envelope to its result |
| `jinn create` | Scaffold a new Jinn external harness or SolverPlugin package |
| `jinn ui` | Open the operator panel in your browser (assumes daemon is running) |
| `jinn tasks` | Submit and inspect Tasks |
| `jinn solver-nets` | Manage SolverNet activation, Harness selection, and SolverNet-scoped plugins |
| `jinn prediction-scoreboard` | Render the Prediction SolverNet Brier scoreboard Markdown report |
| `jinn capture` | Import local capture traces or transcripts |
| `jinn harnesses` | Manage operator-supplied external Harnesses |
| `jinn solver-plugins` | Inspect, validate, pack, publish, and revoke SolverPlugin packages |
| `jinn integrations` | Configure host AI tool integrations for Jinn |
| `jinn codedigest-revert-check` | Decide whether an Improve commit regressed the pass rate (per-codeDigest, #764) |
| `jinn eval` | Run a held-out slate against a checkpoint and compare its resolved rate vs the parent (#818) |
| `jinn scrub` | Scrub eval + review tooling |
| `jinn native-vertical` | Native requester vertical for Base Sepolia |
<!-- skill:cli-table:end -->

## Phase 2: MCP Configuration

If the user wants their agent (Claude Code, Cursor, etc.) to operate jinn programmatically, configure the MCP server:

**For Claude Code** — run `jinn integrations install` (installs automatically) or add to project/user MCP settings manually:
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
| `jinn_auth` | Read-only diagnostic: check Claude authentication status and the resolved runtime mode (bare/docker-compose/container). Does NOT attempt login — it only probes and reports. Do not use this as first-run setup; call jinn_run and complete auth in the app if prompted. Returns authenticated:true + context + email on success; returns an error envelope if not authenticated. Fast (<1s). |
| `jinn_doctor` | Preflight checks: node version, claude binary, keystore, deployment config. Read-only. Fast (<5s). |
| `jinn_fund_requirements` | Read-only: list addresses and amounts that need funding before bootstrap can advance. Note: the underlying command may hydrate wallet state as a side effect of checking funding. Returns an array of funding gaps; empty array means all funded. |
| `jinn_status` | Daemon liveness and fleet health roll-up. Read-only. Poll this to monitor progress. Fast (<2s). |
| `jinn_fleet` | Per-service fleet detail: wallets, staking status, activity counts. Read-only. Fast (<5s). |
| `jinn_balance` | Flat per-wallet balance map across master and service wallets. Read-only. Requires RPC. Fast (<5s). |
| `jinn_history` | Recent protocol activity: tasks, claims, deliveries, evaluations, rewards. Read-only from local DB. Fast (<2s). |
| `jinn_logs` | Recent activity event log from the local SQLite store. Read-only. Fast (<2s). Returns events with ts, level, component, msg fields. Call with limit=100 for monitoring; increase for deeper history. |
| `jinn_rewards` | Pending and claimed reward balances per staked service. Read-only. Requires RPC access. Fast (<5s). Returns per-service pending/claimed amounts and next checkpoint time. |
| `jinn_solver_nets_list` | List configured SolverNets with their enabled state. Read-only. Fast (<2s). |
| `jinn_solver_nets_show` | Detailed status for one SolverNet. Read-only. Fast (<2s). |
| `jinn_solver_nets_enable` | MUTATING: Enable a SolverNet. Idempotent. Optionally selects the restoration Harness for that SolverNet. |
| `jinn_solver_nets_disable` | MUTATING: Disable a SolverNet. Writes config. Idempotent. Fast (<1s). |
| `jinn_init` | MUTATING. Create the master wallet and write the encrypted keystore. Idempotent: re-runs return the existing master address. Requires confirm: true; default is preview (no filesystem write). |
| `jinn_run` | MUTATING: Run the Jinn daemon end-to-end. Initializes the keystore (if missing), bootstraps the fleet (with funding poll), and starts the daemon loops. Idempotent — safe to call repeatedly; resumes from the last completed step. Long-running: can take up to 30 minutes if funding is required. Returns a progress stream via --json-progress; poll jinn_status to monitor after this returns. Use no_daemon=true to exit after bootstrap (useful for CI or when the daemon is managed separately). Requires confirm: true; default is preview (no mutation). |
| `jinn_bootstrap` | MUTATING. Advance the fleet state machine. Idempotent. May take several minutes; can post on-chain transactions and request testnet faucet funds. Returns funding_required if a wallet needs ETH. Requires confirm: true; default is preview (no chain or filesystem mutation). |
| `jinn_tasks_submit` | MUTATING. Post a Task to the protocol. Idempotent by id. Sends an on-chain transaction and pays gas when confirmed. Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action). |
| `jinn_claim_rewards` | MUTATING. Pull pending protocol rewards to the fleet multisigs. Idempotent: zero-delta exits 0. Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action). |
| `jinn_update` | MUTATING: Update the client package and refresh host integrations. Step 1: npm update -g @jinn-network/client Step 2: jinn integrations install (refreshes skills in all configured AI tools). May take 1-2 minutes. Use skip_npm=true to only refresh integrations with the current version. |
| `jinn_start_daemon` | MUTATING. Start the jinn daemon as a detached background process. Spawns a long-lived child process and writes a pidfile. Requires confirm: true; default is preview (does not spawn a process). |
| `jinn_stop_daemon` | MUTATING. Stop the running jinn daemon. Idempotent: returns success even if already stopped. Requires confirm: true; default is preview (does not signal any process). |
| `activity_list` | List recent structured daemon events. Filter by kinds: intent, reward, fleet, system, error, log. |
| `bootstrap_state` | Get the current bootstrap state machine: mode (setup|running|uninitialized), current step, services, master address, chain. |
| `daemon_restart` | Request a daemon restart. Requires confirm=true. The daemon will shut down gracefully and the process will exit; the supervising shell or systemd unit must restart it. |
| `loop_pause` | Pause a daemon loop by name (creator | engine_watcher | engine_tick | delivery_watcher | reward_claim | balance_topup | jinn_claim | peer_sync). NOTE: stubbed in v1-Slim; returns not_implemented. |
| `loop_resume` | Resume a previously-paused daemon loop. NOTE: stubbed in v1-Slim; returns not_implemented. |
<!-- skill:mcp-table:end -->

## Phase 3: Zero to Running

The canonical first-run path:

```bash
# Zero-to-running: opens the app, auto-generates a keystore password,
# then init → fund → bootstrap → run.
jinn run
```

If Claude Code authentication or runtime setup is needed, complete it in the
operator app that `jinn run` opens. `jinn run` then:
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

## Phase 3.5: Opting In to SolverNets

After `jinn run` brings the fleet up, the Prediction SolverNet is enabled by default. Other
SolverNets are off by default because they may require operator-specific
credentials, APIs, or Harness choices.

### Generic flow

Start with `list`. It tells you which SolverNets are enabled, which SolverType
each one serves, and which Harness each one uses.

```bash
jinn solver-nets list
```

Example output for a fresh operator:
```
name          solverType       enabled   harness
prediction    prediction.v0    yes       claude-code-learner
```

### Enabling a SolverNet

```bash
jinn solver-nets enable <name> [--harness <name>]
```

SolverPlugins are scoped to SolverNets, not injected globally into Harnesses:

- `jinn solver-nets set-harness prediction <harness>` changes the Harness used for restoration Tasks.
- `jinn solver-nets add-plugin prediction <source>` attaches an extra SolverPlugin to only that SolverNet.
- `jinn solver-nets doctor prediction` validates the configured runtime plugins, the schemas the SolverNet contract registry pins, and Harness wiring. Add `--human` for a readable summary instead of JSON.

### Disabling

```bash
jinn solver-nets disable <name>
```

Removes the SolverNet from the operator's claim rotation. It does not uninstall
the Harness or delete SolverPlugin packages.

### Runtime guardrail

The daemon checks SolverNet and Harness readiness before spending gas on a claim
transaction. If a Task arrives for an unknown or disabled SolverNet, the daemon
does not claim it.

## Phase 4: Ongoing Operation

### Monitoring

- **Dashboard:** `http://localhost:7331` (when daemon is running)
- **CLI:** `jinn status` for a quick health check
- **Fleet detail:** `jinn fleet` shows each service's step, Safe, mech, staking status
- **Balances:** `jinn balance` shows master and service wallet balances

### Submitting Tasks

To post a Task for the network to work on:

```bash
jinn tasks submit --id my-task --description "The service publishes a daily summary" --solver-net prediction --yes
```

Or via MCP: call `jinn_tasks_submit` with `id`, `description`, and either
`solver_net` or `solver_type`. Mutating MCP tools default to a preview envelope;
pass `confirm: true` to actually post on-chain. Other mutating tools
(`jinn_init`, `jinn_bootstrap`, `jinn_start_daemon`, `jinn_stop_daemon`) follow
the same `confirm: true` rule.

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
- **`jinn tasks submit`** is the main action verb. This is how you create work on the network.
- **`jinn solver-nets`** is how you choose which SolverNets this operator participates in and which Harness each SolverNet uses.
- **`jinn fleet`** tells you about your staked services and their state.
- **`jinn bootstrap`** is idempotent. If anything is stuck, re-running it is always safe.
- **`funding_required`** means "the wallet needs ETH." On testnet, this should auto-resolve via faucet. If not, the user needs to fund manually.
- The daemon runs three loops: creator (posts Tasks), Solver (claims and solves Tasks), delivery-watcher (evaluates results). All three run automatically once the daemon starts.

## Network Details

| | Testnet (default) | Mainnet |
|---|---|---|
| Chain | Base Sepolia | Base |
| RPC default | `https://sepolia.base.org` | `https://mainnet.base.org` |
| Staking mode | standard (stOLAS, no OLAS needed) | standard |
| Config key | `"network": "testnet"` | `"network": "mainnet"` |
