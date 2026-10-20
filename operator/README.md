# @jinn-network/operator

The Jinn operator daemon: a headless program built to take on tasks from the Jinn task marketplace, solve them through Harnesses, and evaluate other operators' Solutions.

**Status: parked.** The operator network and the task marketplace it served are parked until there is demand for them. The marketplace on Base Sepolia is not running tasks. Its last settled work was on 13 August 2026, and every settled task and verdict up to then is on the [Jinn network explorer](https://jinn-indexer-production.up.railway.app/). A daemon started today finds no work and earns nothing. There is no mainnet operator flow ([`docs/operator-mainnet.md`](https://github.com/Jinn-Network/mono/blob/next/docs/operator-mainnet.md)).

The software is retained, not offered. Nothing in this README is an invitation to run an operator, fund a wallet, stake OLAS, or move to mainnet. Do not fund any account because of it.

## What you can still do here

- **Read how it works.** [`operator/ARCHITECTURE.md`](https://github.com/Jinn-Network/mono/blob/next/operator/ARCHITECTURE.md) is the integrating narrative: the operator app, CLI, daemon loops, task lifecycle, and extension points, with code pointers for each layer. [`SPEC.md`](https://github.com/Jinn-Network/mono/blob/next/SPEC.md) is the design of the Base network and its parked task marketplace.
- **Read the record of how operators ran.** [`docs/operator-testnet.md`](https://github.com/Jinn-Network/mono/blob/next/docs/operator-testnet.md) is the testnet runbook as it stood when the marketplace was parked. The reference below keeps the commands and settings it relied on.
- **Build it and run its tests.** [`CONTRIBUTING.md`](https://github.com/Jinn-Network/mono/blob/next/operator/CONTRIBUTING.md) covers development setup, running from source, and testing. `yarn e2e` runs the loop end to end against a local Anvil fork (it needs Foundry), with no real funds.
- **Look for what works today.** The [root README](https://github.com/Jinn-Network/mono/blob/next/README.md) lists it.

## Reference: how an operator ran

Everything below documents how the operator ran while the marketplace was live. It is kept so a returning operator can see what each command and setting did. It is not a current offer. The commands that start a daemon, bootstrap a fleet, stake, or move funds act on a network that is not running tasks: do not run them to get started, and do not fund any account because of them.

### Operator console (separate app)

The daemon is headless. Running `jinn run` starts the API on
`http://127.0.0.1:7331` (`GET /` returns `{ "error": "no_human_surface" }`).
The operator console lives at `apps/operator-console` and talks to the daemon
with `x-jinn-ui-token` (see [`DEPLOY.md`](https://github.com/Jinn-Network/mono/blob/next/DEPLOY.md) and headless §9).

On first launch `jinn run` may open `http://127.0.0.1:3000`. Use `jinn ui`
later. Use `jinn run --no-ui` to suppress auto-open.

Mint a token with `jinn auth token` (or `jinn auth rotate`). Start the console:

```bash
cd apps/operator-console
NEXT_PUBLIC_JINN_OPERATOR_URL=http://127.0.0.1:7331 \
NEXT_PUBLIC_JINN_UI_TOKEN=<token> \
yarn dev
```

While fleet bootstrap is incomplete, the API surface comes up immediately and
the daemon's intent loops are gated until bootstrap reaches `complete`. The
console Overview page renders that 11-step machine and funding as projections.

### Install

How operators installed the CLI. Installing does not start an operator.

```bash
npm install -g @jinn-network/operator@latest
```

Or with Yarn:

```bash
yarn global add @jinn-network/operator@latest
```

### How a new operator started

On Base Sepolia, a new operator ran one command. Starting it today finds no work and earns nothing, so this describes the command; it is not a step to follow.

```bash
# Historical: the one-shot first run. Opens the app, then wallet + funding check
# + bootstrap + run. Do not run it to start an operator.
jinn run
```

On first run, `jinn run` generates a random keystore password, saves
it to `~/.jinn-operator/keystore-password` (mode 0600; read-fallback from
`~/.jinn-client` when the new directory is empty), and prints a summary
with the master address and a pointer to back up the mnemonic. Subsequent
verbs (`jinn run`, `jinn bootstrap`, `jinn claim-rewards`, …) pick up the
password from that file automatically, with no env var needed.
If Claude Code authentication or runtime setup is needed, it is completed in the
operator app that `jinn run` opens.

An operator with an existing keystore can export its mnemonic:

```bash
jinn keys backup --output ~/jinn-mnemonic.txt  # mode 0600; treat as seed material
```

**Advanced / CI: manage the password yourself.** Set `JINN_PASSWORD` before
`jinn run` and no file is written to disk. Use `--password-fd N` for
CI pipelines that read from a secret manager:

```bash
# Historical: supply the keystore password yourself. Do not run it to start an operator.
JINN_PASSWORD=your-secret jinn run
```

**Step by step** (what `jinn run` did, one verb at a time):

```bash
# Historical: the step-by-step first run. Do not run it to start an operator.

# 1. Generate the encrypted keystore (picks an HD wallet deterministically).
JINN_PASSWORD=your-secret jinn init

# 2. Verify the environment and resolved deployment.
jinn doctor --human

# 3. List exact funding gaps. On testnet this was ETH only: the staking pool
#    was managed protocol-side and operators did not hold bond tokens directly.
jinn fund-requirements --human

# 4. The operator then sent the listed testnet funds to the printed master
#    address (do not fund any account for the parked network) and ran:
jinn bootstrap

# 5. Start the daemon.
jinn run
```

`jinn init`, `jinn fund-requirements`, `jinn bootstrap`, and `jinn run` all
share the same encrypted keystore and fleet state under `~/.jinn-operator/earning/`
by default. They are idempotent, so any of them can be re-run safely.

To keep state for different networks side by side on the same machine, set
`JINN_EARNING_DIR` to a network-specific path:

```bash
# Historical: a testnet-only earning directory. Do not run it to start an operator.
JINN_EARNING_DIR=~/.jinn-client/earning-testnet jinn run
```

#### Password resolution

Any verb that touches private keys resolves its password in this order:

1. `--password-fd N` — read from a file descriptor (scripted / CI)
2. `JINN_PASSWORD` env var — explicit operator-set
3. `~/.jinn-operator/keystore-password` — auto-generated by `jinn run`
   (falls back to `~/.jinn-client/keystore-password` on an install that
   still keeps its state there)

The password is never read from config files. `jinn keys change-password`
rotates the keystore of the earning dir it targets — `JINN_EARNING_DIR`,
else the `--config` file's `earningDir`, else the default one. The
auto-generated password file is deleted only if it contains the authenticated
old password and the default keystore is the rotated file or absent. Rotating
a second operator leaves an existing default operator's password file intact,
even if that keystore is damaged. An unchanged password is retained. After a
deletion, set `JINN_PASSWORD` yourself.

**Security note:** when `jinn run` auto-generates the password, it lives
in plaintext next to the encrypted keystore. That's convenient for tester
workflows but means anyone with shell access can decrypt your mnemonic.
Treat the wallet as hot and hold no more in it than the gas and rewards minimum.

### Try without installing

The no-install form of one preflight verb. `doctor` runs preflight checks without mutation and does not start a daemon.

```bash
npx @jinn-network/operator@latest doctor
```

### Agent integrations

If you use Claude Code, Codex, Cursor, Gemini CLI, VS Code, or another
MCP-capable tool, `jinn integrations install` wires Jinn into it:

```bash
jinn integrations install
```

This detects every supported tool on your machine and, for each one, adds the
`jinn mcp` MCP server plus a copy of the `jinn-operator` skill. Supported:
Claude Code, Claude Desktop, Cursor, VS Code, Gemini CLI, Antigravity, Codex.
Run `jinn integrations doctor --human` to see what's detected.

The `jinn-operator` skill activates on mentions of "jinn", "jinn network", and
"jinn run", and walks an agent through install, app-guided setup, bootstrap, and
daemon lifecycle for the marketplace as it ran, funding decisions included. Treat
it as reference, not as a current offer: an agent should not fund an account on
the strength of it. The prompt operators pasted to have an agent set up a testnet
node is recorded in the
[testnet runbook](https://github.com/Jinn-Network/mono/blob/next/docs/operator-testnet.md).

### Opting in to SolverNets

While the marketplace ran, a daemon started with `jinn run` took on deterministic
`prediction.v0` Tasks by default on testnet, through the Prediction SolverNet.
Other SolverNets, like one for `portfolio.v0`, which
executes trades against a Hyperliquid master account, are **off by default**
because they need credentials only you can provide. This prevents a daemon
from claiming a request it can't actually fulfill.

Inspect and toggle participation with `jinn solver-nets`:

```bash
jinn solver-nets list --human
jinn solver-nets show prediction --human
jinn solver-nets enable prediction --harness claude-code-learner
jinn solver-nets set-harness prediction prediction-v0-baseline
jinn solver-nets add-plugin prediction bundled:jinn-prediction-plugin
jinn solver-nets disable prediction
jinn solver-nets doctor prediction
```

SolverPlugins are attached to SolverNets, not Harnesses. Changing a SolverNet's
Harness changes the executor used for future Tasks, while the SolverNet's
canonical and extra plugin set follows the SolverNet. Each `enable` is an
idempotent state machine. Rerun until the envelope reports `"status": "ready"`.
When the flow needs something from you (an exchange approval, an API key), it
returns `waiting_for_external_action` with the URL and the exact command to
rerun next. Agents with the `jinn-operator` skill installed know how to walk an
operator through a SolverNet automatically.

Each Harness reads its **own** auth store (the daemon only forwards an
allowlisted set of env vars — it does not hold your provider keys). For the
per-harness auth store, the canonical rotate command/file, and why `operator/.env`
must not be used to set provider keys at runtime, see
[`docs/operator/rotating-harness-keys.md`](https://github.com/Jinn-Network/mono/blob/next/docs/operator/rotating-harness-keys.md).

**Safety net:** before spending gas on a claim, the daemon checks whether the
responsible Harness is actually ready. If a portfolio.v0 request arrives and your
api-wallet isn't approved, the daemon records the Task as FAILED locally
with a clear reason instead of wasting gas claiming it.

### Docker

How the containerized daemon was run. A container started today finds no work, so this is reference.

The daemon spawns the Anthropic `claude` CLI as a subprocess for
restorations; to keep costs low, use Claude's OAuth authentication (prompt
caching + app tiers) rather than raw API keys. On macOS the host keychain
encrypts OAuth tokens, so mounting `~/.claude` directly into Docker
doesn't work — instead, run one `claude setup-token` on the host to mint
a long-lived OAuth token, then pass it to the daemon via `.env`.

The compose deployment also starts a pinned, isolated Docker-in-Docker sidecar
for `jinn-repo.v1` mechanical verification. It does not mount the host Docker
socket. Allow roughly 8 GiB for an active verifier in addition to the daemon,
and make sure the deployment can pull the pinned verifier image. Keep the
sidecar isolated; adding a host socket mount would defeat the evaluator trust
boundary.

#### Recommended path: `claude setup-token` + `.env`

1. **Mint a long-lived OAuth token on the host** (one-time, opens browser):
   ```bash
   claude setup-token
   ```
   Copy the `sk-ant-oat01-...` string it prints.

2. **Create a `.env` file** next to the compose file:
   ```bash
   cat > .env <<EOF
   JINN_PASSWORD=your-secure-password
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
   EOF
   ```

3. **Start the daemon** (historical: there is no work for it to find today):
   ```bash
   docker compose up -d
   docker compose logs -f jinn-daemon
   ```

The compose file lives at `operator/docker-compose.yml` if you cloned the
repo. If you installed via `npm install -g @jinn-network/operator@latest`,
copy it out first:

```bash
cp "$(npm root -g)/@jinn-network/operator/docker-compose.yml" .
```

#### Fallback: interactive OAuth inside the container

If `claude setup-token` isn't available on your host (e.g., you don't
have Claude Code installed locally), run the interactive OAuth flow
inside the container instead — it saves the token to a persistent volume
so the daemon can use it on subsequent runs:

```bash
# Historical: the container fallback. Do not run it to start an operator.
docker compose run --rm -it --entrypoint claude jinn-daemon auth login
docker compose up -d
```

#### Quick test

```bash
docker run --rm ghcr.io/jinn-network/operator:next version --json
```

### Operator commands

The package still ships this CLI. The commands that start the daemon (`jinn run`), bootstrap a fleet (`jinn bootstrap`), or act on tasks, rewards, and fleet wallets (`jinn tasks submit`, `jinn claim-rewards`, `jinn fleet scale`, `jinn withdraw`) belong to the marketplace as it ran. There is no work for a daemon to take on today.

#### Lifecycle

| Command | Purpose | Idempotent |
|---|---|---|
| `jinn run` | One-shot init + funding check + bootstrap + start the daemon (foreground) | Yes |
| `jinn init` | Generate wallet + keystore + fleet state | Yes |
| `jinn doctor` | Preflight checks without mutation | Yes |
| `jinn bootstrap` | Advance toward a running fleet | Yes |
| `jinn fund-requirements` | List what needs funding | Yes |
| `jinn stop` | Signal a running daemon to stop | Yes |
| `jinn kill` | Force-terminate jinn daemon processes by cmdline enumeration (`--all` for multiple) | Yes |
| `jinn version` | Version, phase, deployment digest | Yes |
| `jinn update` | Update the operator package + refresh integrations | Yes |
| `jinn integrations install` | Wire Jinn into Claude Code / Codex / other AI tools | Yes |

#### Monitoring

| Command | Purpose |
|---|---|
| `jinn status` | Daemon liveness + fleet health roll-up |
| `jinn fleet` | Per-service detail: wallets, staking, activity |
| `jinn balance` | Flat per-wallet balance map |
| `jinn history` | Recent protocol activity |
| `jinn rewards` | Earned vs claimed per service |
| `jinn supply` | Current requestable SolverNet classes from indexed native evidence |
| `jinn logs` | Structured event stream |
| `jinn logs --follow` | Live tail of lifecycle events |

The daemon serves an API, not a human surface. For live in-flight Tasks, verdicts, earnings, fleet balances, recent activity, and next actions, use the [operator console](#operator-console-separate-app), which authenticates to the daemon with a UI token.

#### Actions

All action verbs support `--dry-run` and `--yes`.

| Command | Purpose |
|---|---|
| `jinn tasks submit` | Publish a Task |
| `jinn claim-rewards` | Pull pending rewards |
| `jinn fleet scale --to N` | Grow or shrink fleet |
| `jinn fleet retire <index>` | Retire one service |
| `jinn withdraw --to <addr>` | Sweep wallets to external address |
| `jinn keys backup --output <path>` | Export mnemonic (writes plaintext; treat the output file as seed material) |
| `jinn keys change-password` | Re-encrypt the keystore with a new password |

### Output contract

- **JSON by default** for operational verbs unless you pass `--human` (headless- and agent-friendly regardless of TTY).
- Add `--human` for readable terminal output.
- `stderr` is reserved for progress, warnings, and runtime logs.
- Non-zero exits emit a structured error envelope on stdout with `schemaVersion`, `code`, `exitCode`, `message`, `hint`, and `exampleCli`.
- Without a global install, use `npx @jinn-network/operator@latest <verb> ...`.

See the [client surface spec](https://github.com/Jinn-Network/mono/blob/next/spec/2026-04-14-client-surface.md) for the full CLI reference.

### Configuration

Config file first, env var override. Default location: `~/.jinn-operator/config.json`
(read-fallback from `~/.jinn-client` when the new directory is empty).

```bash
# Historical: pass a config file. Do not run it to start an operator.
JINN_PASSWORD=secret jinn run --config ./my-config.json
```

| Config key | Env override | Default |
|---|---|---|
| network | JINN_NETWORK | `testnet` (Base Sepolia). `mainnet` selects Base mainnet, where there is no operator flow. |
| rpcUrl | BASE_RPC_URL / JINN_RPC_URL | testnet: two-provider fallback chain `[publicnode, sepolia.base.org]`; mainnet: single `mainnet.base.org`. Accepts string OR array; env values split on commas. See "RPC fallback chain" below. |
| claudeModel | JINN_CLAUDE_MODEL | claude-haiku-4-5-20251001 |
| claudePath | JINN_CLAUDE_PATH | claude |
| pollIntervalMs | JINN_POLL_INTERVAL_MS | 5000 |
| apiPort | JINN_API_PORT | 7331 |
| apiBindHost | JINN_API_BIND_HOST | `127.0.0.1` (loopback only; set to `0.0.0.0` for LAN access — pairs with bearer-token auth on cost-mutating routes) |
| dbPath | JINN_DB_PATH | ~/.jinn-operator/jinn.db |
| earningDir | JINN_EARNING_DIR | ~/.jinn-operator/earning |
| peers | JINN_PEERS | [] |
| tasks | JINN_TASKS | [] |

`JINN_PASSWORD` is env-only (keystore encryption, never in config files). Alternatively, use `--password-fd <N>` to read from a file descriptor.

#### RPC fallback chain

Out of the box on testnet, `jinn run` uses a five-provider fallback chain, with no key required and zero config:

```text
slot 0  https://base-sepolia.publicnode.com       (no-auth, 50k-block getLogs cap)
slot 1  https://base-sepolia-rpc.publicnode.com
slot 2  https://base-sepolia.drpc.org
slot 3  https://base-sepolia.gateway.tenderly.co
slot 4  https://sepolia.base.org                  (free public Coinbase, 2k cap)
```

If the primary returns a network error or HTTP 429 / 5xx, viem
transparently falls through to the next slot. When every slot fails the
daemon throws `AllRpcsFailedError` (visible in the dashboard's NetworkSection
and in stderr).

##### Bring your own paid primary

Operators with a paid Alchemy / Tenderly / QuickNode endpoint should
**prepend** their URL — the public free chain stays as automatic backup:

```json
{
  "rpcUrl": [
    "https://my-alchemy-key.example",
    "https://base-sepolia.publicnode.com",
    "https://sepolia.base.org"
  ]
}
```

Or via env (comma-separated, same chain capped at 6 providers):

```bash
# Historical: an RPC override. Do not run it to start an operator.
JINN_RPC_URL='https://my-alchemy-key.example,https://base-sepolia.publicnode.com,https://sepolia.base.org' jinn run
```

The chain is built with viem's `fallback({ rank: false })` so operator slot
order is preserved (no latency-based reshuffling).

##### Automatic failure modes

| Failure                                     | What used to happen           | What now happens                                |
|---------------------------------------------|--------------------------------|-------------------------------------------------|
| Primary RPC returns HTTP 429 (rate limit)   | Daemon hot-loops on every call | viem falls through to slot 1; daemon continues  |
| Primary RPC unreachable                     | Daemon errors silently         | viem falls through to slot 1; daemon continues  |
| Primary's API key quota exhausted           | Daemon silently degraded       | viem falls through to slot 1; daemon continues  |
| Every slot fails (rare)                     | Daemon errors silently         | `AllRpcsFailedError` thrown with masked host list — surfaces as a state message in the operator app |

On boot the daemon emits one log line per slot followed by the canonical
summary line:

```text
[rpc] L2 base-sepolia.publicnode.com ok latency=87ms
[rpc] L2 base-sepolia-rpc.publicnode.com ok latency=95ms
[rpc] L2 base-sepolia.drpc.org ok latency=112ms
[rpc] L2 base-sepolia.gateway.tenderly.co ok latency=128ms
[rpc] L2 sepolia.base.org ok latency=141ms
[rpc] L2 transport: fallback chain (5 providers) — primary=base-sepolia.publicnode.com
```

The probe is **log-only** — secondary-slot 429s warn but never gate
startup. Only chain-id mismatch against the head URL is fail-loud
(`checkRpcNetwork`).

Note this is the JSON-RPC transport layer. It is distinct from
`discovery.fallbackToOnchain`, which is a separate flag at the read-API
layer (Ponder indexer → direct `eth_getLogs` floor). The RPC fallback chain
operates beneath both.

### Tokens

| Role | Testnet (Base Sepolia) | Mainnet (Base), design only |
|---|---|---|
| Gas (native) | ETH (CDP auto-funded on testnet) | ETH |
| Staking bond | Pooled, protocol-managed via stOLAS distributor (operators hold nothing) | OLAS (operator-held) |
| Reward | stOLAS | OLAS |

**Important:** under stOLAS standard mode (the testnet default), operators
did **not hold a bond token themselves**. The stOLAS distributor's pool
provided the bond and staked on behalf of operators; a service was created
against that shared pool. `jinn fund-requirements` surfaced only the
per-wallet ETH an operator needed. While the testnet marketplace ran, a drained
distributor pool showed up as a failed `distributor_reachable` check in
`jinn doctor`. An operator could not fix it locally: bootstrap worked again
only once the pool was refilled.

### Mainnet

There is no mainnet operator flow, and nothing here is an invitation to move an operator to mainnet, where the ETH and OLAS involved are real. [`docs/operator-mainnet.md`](https://github.com/Jinn-Network/mono/blob/next/docs/operator-mainnet.md) is a placeholder, not a runbook.

Whichever network a daemon points at, give each network its own `JINN_EARNING_DIR`
so keystore and fleet state stay isolated. Mixing them on the same directory is an easy way to
point a mainnet daemon at a testnet-derived master wallet.

### Troubleshooting

The task marketplace on Base Sepolia is parked, so this section is a record:
the failures operators hit while it ran, and what resolved them at the time.
Do not fund any account because of it. The fuller record is the
troubleshooting section of the testnet runbook:
<https://github.com/Jinn-Network/mono/blob/next/docs/operator-testnet.md#troubleshooting>

- **Bootstrap looped for a minute, then exited with `funding_required`.**
  The CDP faucet drip was small (about 0.0001 ETH per call) and the
  bootstrap floor was 0.005 ETH, so the client drained the faucet in a
  loop on each invocation. A `funding_required` after that loop meant CDP
  had rate-limited the master address. The faucet recovered after 24h, or
  the operator funded the address by hand.
- **Claude session exited in about 18 seconds with no trades.** This
  usually meant the daemon ran from source (via `tsx`) instead of the
  compiled `dist/`, so the MCP wrapper could not load `mcp-tools.js`.
  `jinn doctor` flagged it as `daemon_runtime_ready`. The fix was a
  `yarn build` before the run in a git checkout, or a reinstall of the
  npm package.
- **Bootstrap failed with `Overflow(20, 0)` at `distributor.stake()`.**
  The testnet stOLAS distributor pool was drained. Operators could not fix
  this locally; `jinn bootstrap` worked again only once the pool was
  topped up.
- **Position auto-closed within seconds of opening.** Most likely a
  competing trading bot was active on the same Hyperliquid master. A fresh
  master, used only for that test run, avoided it.
- **`jinn doctor` passed but `jinn run` failed.** The most common mismatch
  was auth-context detection: an earlier client inferred `docker-compose`
  mode from a `docker-compose.yml` in the working directory, so a daemon
  started inside the repository checkout misdetected its context on a bare
  host. Running the daemon from `$HOME`, or from any directory without a
  `docker-compose.yml` that named `jinn-daemon`, avoided it. That heuristic
  has since been removed from `detectAuthContext`.
