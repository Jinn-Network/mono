---
name: jinn-operator
description: Reference for how a Jinn Network operator ran. The operator network is parked and is not running tasks, so use this to explain the jinn CLI, the MCP tools, and the Jinn protocol, not to set up, fund, or start an operator. Activates on mentions of "jinn", "jinn agent", "jinn network", "jinn run", "Task", "SolverNet", "restoration", or "SolverPlugin" in the context of operating an agent.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Jinn Operator Skill

**Status: parked.** The operator network and the task marketplace it served are parked until there is demand for them. The marketplace on Base Sepolia is not running tasks. Its last settled work was on 13 August 2026. A daemon started today finds no work and earns nothing. There is no mainnet operator flow.

This skill is kept as the record of how operators ran. It is not an invitation to run an operator, fund a wallet, stake OLAS, or move to mainnet. Do not fund any account because of it, and do not start a daemon to follow it. The [operator README](https://github.com/Jinn-Network/mono/blob/next/operator/README.md) describes the current state, and the [testnet runbook](https://github.com/Jinn-Network/mono/blob/next/docs/operator-testnet.md) is the runbook as it stood when the marketplace was parked.

Everything below documents how an operator installed, configured, and ran a Jinn Network agent.

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

While the marketplace ran, operators took part in this loop on the public testnet, Base Sepolia.

## Phase 1: Installation

How operators installed the CLI. Installing does not start an operator.

Check if jinn is already installed:

```bash
jinn --help
```

If not installed:

```bash
npm install -g @jinn-network/operator
```

This gives you the `jinn` operator CLI. The built-in MCP server is invoked via `jinn mcp` (see Phase 2).

### Prerequisites

- **Node.js 22+** — `node --version` to check
- **Claude Code CLI** — the daemon spawns Claude as a subprocess for restoration work. It must be installed; if auth or runtime setup is needed, `jinn run` opens the operator app and guides the user through it.

### CLI verb reference

The package still ships this CLI. The commands that start the daemon (`jinn run`), bootstrap a fleet (`jinn bootstrap`), or act on tasks, rewards, and fleet wallets (`jinn tasks submit`, `jinn claim-rewards`, `jinn fleet scale`, `jinn withdraw`) belong to the marketplace as it ran. There is no work for a daemon to take on today.

<!-- skill:cli-table:start -->
| Verb | What it does |
|------|--------------|
| `jinn version` | Print client version, protocol phase, and resolved token map |
| `jinn doctor` | Preflight checks: answers "would jinn run work?" without running it |
| `jinn init` | Generate the master wallet and write the encrypted keystore |
| `jinn quickstart` | Legacy compatibility alias for zero-to-running setup; prefer jinn run |
| `jinn auth` | Pairing and legacy Claude-auth: `jinn auth rotate` / `jinn auth token`, plus runtime mode |
| `jinn bootstrap` | Advance the fleet state machine toward a running daemon |
| `jinn bootstrap-retry` | Signal a running, halted daemon to retry its bootstrap state machine |
| `jinn onboarding-complete` | Mark onboarding complete (daemon control route if running, config file otherwise) |
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
| `jinn conformance` | Run the envelope + trajectory conformance suite against a signed envelope CID |
| `jinn evidence` | Read delivered evidence — resolve a task id to an envelope, and an envelope to its result |
| `jinn create` | Scaffold a new Jinn external harness or SolverPlugin package |
| `jinn ui` | Open the operator console in your browser (assumes the console is running) |
| `jinn tasks` | Submit and inspect Tasks |
| `jinn solver-nets` | Manage SolverNet activation, Harness selection, and SolverNet-scoped plugins |
| `jinn prediction-scoreboard` | Render the Prediction SolverNet Brier scoreboard Markdown report |
| `jinn capture` | Import local capture traces or transcripts |
| `jinn harnesses` | Manage operator-supplied external Harnesses |
| `jinn solver-plugins` | Inspect, validate, pack, publish, and revoke SolverPlugin packages |
| `jinn integrations` | Configure host AI tool integrations for Jinn |
| `jinn eval` | Run a held-out slate against a checkpoint and compare its resolved rate vs the parent (#818) |
| `jinn scrub` | Scrub eval + review tooling |
| `jinn native-vertical` | Native requester vertical and role-identity keygen for Base Sepolia |
| `jinn ceremony` | Provision native trust artifacts: role custody, on-chain anchor, and the shared trust catalog |
| `jinn policy` | Show or set the resolved claim policy |
| `jinn wiring` | Show or set execution-wiring and posting entries |
| `jinn restart` | Ask a running daemon to restart via POST /api/admin/restart |
| `jinn supply` | Show current requestable SolverNet supply from indexed native evidence |
| `jinn requester` | Requester-only onboarding: wallet, keystore, and creator Safe |
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
      "args": ["-y", "-p", "@jinn-network/operator", "jinn", "mcp"]
    }
  }
}
```

Once configured, these MCP tools become available. The mutating ones (`jinn_run`, `jinn_bootstrap`, `jinn_tasks_submit`, `jinn_claim_rewards`, `jinn_start_daemon`) belong to the marketplace as it ran: do not call them to get started, and do not fund any account because a tool reports a funding gap.

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
| `jinn_init` | MUTATING. Create the master wallet and write the encrypted keystore. Idempotent: re-runs return the existing master address. Requires confirm: true; default is preview (no filesystem write). |
| `jinn_run` | MUTATING: Run the Jinn daemon end-to-end. Initializes the keystore (if missing), bootstraps the fleet (with funding poll), and starts the daemon loops. Idempotent — safe to call repeatedly; resumes from the last completed step. Long-running: can take up to 30 minutes if funding is required. Returns a progress stream via --json-progress; poll jinn_status to monitor after this returns. Use no_daemon=true to exit after bootstrap (useful for CI or when the daemon is managed separately). Requires confirm: true; default is preview (no mutation). |
| `jinn_bootstrap` | MUTATING. Advance the fleet state machine. Idempotent. May take several minutes; can post on-chain transactions and request testnet faucet funds. Returns funding_required if a wallet needs ETH. Requires confirm: true; default is preview (no chain or filesystem mutation). |
| `jinn_tasks_submit` | MUTATING. Post a Task to the protocol. Idempotent by id. Sends an on-chain transaction and pays gas when confirmed. Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action). |
| `jinn_claim_rewards` | MUTATING. Pull pending protocol rewards to the fleet multisigs. Idempotent: zero-delta exits 0. Requires confirm: true; default is preview (uses CLI --dry-run, no on-chain action). |
| `jinn_update` | MUTATING: Update the operator package and refresh host integrations. Step 1: npm update -g @jinn-network/operator Step 2: jinn integrations install (refreshes skills in all configured AI tools). May take 1-2 minutes. Use skip_npm=true to only refresh integrations with the current version. |
| `jinn_start_daemon` | MUTATING. Start the jinn daemon as a detached background process. Spawns a long-lived child process and writes a pidfile. Requires confirm: true; default is preview (does not spawn a process). |
| `jinn_stop_daemon` | MUTATING. Stop the running jinn daemon. Idempotent: returns success even if already stopped. Requires confirm: true; default is preview (does not signal any process). |
| `activity_list` | List recent structured daemon events. Filter by kinds: intent, reward, fleet, system, error, log. |
| `bootstrap_state` | Get the current bootstrap state machine: mode (setup|running|uninitialized), current step, services, master address, chain. |
| `daemon_restart` | Request a daemon restart. Requires confirm=true. The daemon will shut down gracefully and the process will exit; the supervising shell or systemd unit must restart it. |
<!-- skill:mcp-table:end -->

## Phase 3: How a New Operator Started

On Base Sepolia, a new operator ran one command. Starting it today finds no work and earns nothing, so this describes the command; it is not a step to follow.

```bash
# Historical: the one-shot first run. Opens the app, auto-generates a keystore
# password, then init → funding check → bootstrap → run. Do not run it to start
# an operator.
jinn run
```

If Claude Code authentication or runtime setup was needed, it was completed in the
operator app that `jinn run` opened. `jinn run` then:
1. Generated a random keystore password (saved to `~/.jinn-client/keystore-password`, mode 0600)
2. Created the master wallet
3. Checked funding. On testnet a Coinbase CDP faucet request covered it automatically.
4. Bootstrapped the fleet (Safe wallet, service registration, staking, mech deployment)
5. Started the daemon

While the marketplace ran, the daemon served its own dashboard and `jinn ui` opened it. Both changed after the last settled work: the daemon in this package is headless, its API answers `GET /` with `{ "error": "no_human_surface" }`, and `jinn ui` opens the separate operator console (`apps/operator-console`).

### Advanced / CI: explicit password

An operator who wanted to manage the password themselves (recommended for production or CI pipelines) set `JINN_PASSWORD` before calling `jinn run`, and no file was written to disk:

```bash
# Historical: supply the keystore password yourself. Do not run it to start an operator.
JINN_PASSWORD=their-password jinn run
```

For CI, the password was read from a file descriptor: `--password-fd N`.

### If `jinn run` stopped at "funding required":

The automatic faucet could rate-limit (1 claim per 24 hours per address). The operator then waited 24 hours and re-ran `jinn run`, or sent testnet ETH from a web faucet to the printed master address and re-ran. There is nothing to resolve on the parked network: do not fund any account.

## Phase 3.5: Opting In to SolverNets

While the marketplace ran, the Prediction SolverNet was enabled by default after `jinn run` brought the fleet up. Other
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

- **Operator console:** `jinn ui` opens it. The daemon itself has no human surface.
- **CLI:** `jinn status` for a quick health check
- **Fleet detail:** `jinn fleet` shows each service's step, Safe, mech, staking status
- **Balances:** `jinn balance` shows master and service wallet balances

### Submitting Tasks

This is how a Task was posted for the network to work on. The marketplace is not running tasks, so do not post one now.

```bash
# Historical: posts a Task on-chain. Do not run it.
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
# Historical: stop and restart a daemon. Do not run it to start an operator.
jinn stop       # stop the daemon
jinn run        # start in foreground
```

## Troubleshooting

### `jinn doctor` fails on claude_binary

Claude Code CLI is not installed or not on PATH. Install it separately — see https://claude.ai/code.

### Bootstrap stuck at "awaiting funding"

The master wallet needed testnet ETH. The cause was one of:
- The CDP faucet rate-limited (a 24 hour wait)
- The faucet SDK (`@coinbase/cdp-sdk`) was not installed
- The operator had to fund the wallet from a web faucet

Do not fund any account for the parked network.

### Daemon starts but no activity

On the parked network no activity is expected: the marketplace is not running tasks. While it ran, the first check was `jinn status`: if `rpc.ok` was false, the RPC endpoint was down. The default testnet RPC is a fallback chain of five free providers (`DEFAULT_TESTNET_RPC_URLS` in `operator/src/config.ts`). An operator with an RPC endpoint of their own put it first in the `rpcUrl` array of the existing config file, or in `JINN_RPC_URL`, as the operator README describes.

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
- **`funding_required`** meant "the wallet needs ETH." On testnet, this auto-resolved via faucet. Do not fund any account for the parked network.
- The daemon runs three loops: creator (posts Tasks), Solver (claims and solves Tasks), delivery-watcher (evaluates results). All three run automatically once the daemon starts.

## Network Details

How the two networks were configured while the marketplace ran. The marketplace is parked, and there is no mainnet operator flow ([`docs/operator-mainnet.md`](https://github.com/Jinn-Network/mono/blob/next/docs/operator-mainnet.md)).

| | Testnet (default) | Mainnet |
|---|---|---|
| Chain | Base Sepolia | Base |
| RPC default | Five-provider fallback chain headed by https://base-sepolia.publicnode.com | Five-provider fallback chain headed by https://mainnet.base.org |
| Staking mode | standard (stOLAS, no OLAS needed) | standard |
| Config key | `"network": "testnet"` | `"network": "mainnet"` |
