# @jinn-network/client

Jinn protocol client. Runs a headless daemon that participates in the Jinn training loop: create, restore, and evaluate desired states, and earn rewards for measured work.

## Install

```bash
npm install -g @jinn-network/client@latest
```

Or with Yarn:

```bash
yarn global add @jinn-network/client@latest
```

## Quick start

```bash
# Generate wallet and keystore
jinn init

# Check environment readiness
jinn doctor

# Start the daemon
JINN_PASSWORD=your-keystore-password jinn run
```

On first run, the bootstrap generates a master wallet and prints a funding address. Send testnet ETH to it, then re-run. The bootstrap is idempotent — it picks up where it left off.

`JINN_PASSWORD` encrypts the local keystore and is env-only; never put it in a config file.

## Try without installing

```bash
npx @jinn-network/client@latest doctor
```

## Docker (Recommended for Operators)

The Jinn daemon runs pure Node, but spawns the Anthropic `claude` CLI as a subprocess for restorations. To keep your costs low, operators should use Claude's OAuth authentication (which leverages prompt caching and app tiers) instead of brute-forcing API keys.

Because the macOS keychain securely encrypts OAuth tokens, you **cannot** simply mount `~/.claude` from a Mac host into Docker. Instead, the most robust way to manage credentials and daemon state is using our included `docker-compose.yml`.

### Zero-Friction Setup

1. **Configure Environment:** Create a `.env` file with your master password:
   ```bash
   echo "JINN_PASSWORD=your-secure-password" > .env
   ```

2. **Authenticate Claude (One-Time):** The image entrypoint is the `jinn` binary, so run the Anthropic CLI directly by overriding the entrypoint. This performs the OAuth flow and saves the token to the persistent `jinn-claude-state` volume (same volumes as the daemon service):
   ```bash
   docker compose run --rm -it --entrypoint claude jinn-daemon auth login
   ```
   Use `-it` so the CLI can open a browser (or show a URL to visit) and receive input. The process stays in the foreground until you finish sign-in.
   *Follow the URL to authenticate in your browser.*

3. **Start the Fleet:** Now that the Docker volume holds the token, start the headless daemon:
   ```bash
   docker compose up -d
   ```

### Quick Test

```bash
docker run --rm ghcr.io/jinn-network/client:latest version --json
```

## Operator commands

### Lifecycle

| Command | Purpose | Idempotent |
|---|---|---|
| `jinn init` | Generate wallet + keystore | Yes |
| `jinn doctor` | Preflight checks without mutation | Yes |
| `jinn bootstrap` | Advance toward a running fleet | Yes |
| `jinn fund-requirements` | List what needs funding | Yes |
| `jinn run` | Start the daemon (foreground) | N/A |
| `jinn stop` | Signal a running daemon to stop | Yes |
| `jinn version` | Version, phase, deployment digest | Yes |

### Monitoring

| Command | Purpose |
|---|---|
| `jinn status` | Daemon liveness + fleet health roll-up |
| `jinn fleet` | Per-service detail: wallets, staking, activity |
| `jinn balance` | Flat per-wallet balance map |
| `jinn history` | Recent protocol activity |
| `jinn rewards` | Earned vs claimed per service |
| `jinn logs` | Structured event stream |

### Actions

All action verbs support `--dry-run` and `--yes`.

| Command | Purpose |
|---|---|
| `jinn submit-intent` | Publish a desired state |
| `jinn claim-rewards` | Pull pending protocol rewards |
| `jinn fleet scale --to N` | Grow or shrink fleet |
| `jinn fleet retire <index>` | Retire one service |
| `jinn withdraw --to <addr>` | Sweep wallets to external address |
| `jinn keys backup --output <path>` | Export mnemonic |

## Output contract

- **JSON by default** for operational verbs unless you pass `--human` (headless- and agent-friendly regardless of TTY).
- Add `--human` for readable terminal output.
- `stderr` is reserved for progress, warnings, and runtime logs.
- Non-zero exits emit a structured error envelope on stdout with `schemaVersion`, `code`, `exitCode`, `message`, `hint`, and `exampleCli`.
- Without a global install, use `npx @jinn-network/client@latest <verb> ...` instead of `jinn ...` (the package name is scoped; `npx jinn` resolves a different package).

See [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md) for the full surface spec.

## Configuration

Config file first, env var override. Default location: `~/.jinn-client/config.json`.

```bash
JINN_PASSWORD=secret jinn run --config ./my-config.json
```

| Config key | Env override | Default |
|---|---|---|
| network | JINN_NETWORK | testnet (flips to mainnet at launch) |
| rpcUrl | BASE_RPC_URL / JINN_RPC_URL | network-appropriate public RPC |
| claudeModel | JINN_CLAUDE_MODEL | claude-haiku-4-5-20251001 |
| claudePath | JINN_CLAUDE_PATH | claude |
| pollIntervalMs | JINN_POLL_INTERVAL_MS | 5000 |
| apiPort | JINN_API_PORT | 7331 |
| dbPath | JINN_DB_PATH | ~/.jinn-client/jinn.db |
| earningDir | JINN_EARNING_DIR | ~/.jinn-client/earning |
| peers | JINN_PEERS | [] |
| desiredStates | JINN_DESIRED_STATES | [health-check] |

`JINN_PASSWORD` is env-only (keystore encryption, never in config files). Alternatively, use `--password-fd <N>` to read from a file descriptor.

## Switching to mainnet

When Phase 2 launches, the default flips. Until then:

```bash
JINN_NETWORK=mainnet JINN_PASSWORD=secret jinn run
```

## How it works

The daemon runs three concurrent loops:

1. **CreatorLoop** — posts desired states as restoration jobs
2. **RestorerLoop** — claims requests, spawns Claude to attempt restoration, submits results
3. **DeliveryWatcherLoop** — claims deliveries, creates evaluation jobs

Each loop call increments on-chain activity counters. Staking contracts read these at checkpoints to determine reward eligibility.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, running from source, and testing.
