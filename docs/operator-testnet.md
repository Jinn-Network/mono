# Record: the Jinn testnet operator runbook (Base Sepolia and Hyperliquid testnet)

**Status: parked.** The task marketplace on Base Sepolia is parked and is not running tasks. Its last settled work was on 13 August 2026, when task 1236 received the network's last attempt and last verdict. Every settled task and verdict is on the [Jinn network explorer](https://jinn-indexer-production.up.railway.app/). A node started today finds no work and earns nothing.

This page is the operator runbook as it stood when the marketplace was parked, kept as the record of how operators ran. It is not a setup guide. Every command block below is historical: do not run it, and do not fund any account because of it.

## What an operator node did

The daemon ran headless and:

1. **Observed** marketplace requests (desired states posted on-chain, IPFS-backed).
2. **Claimed** them via the on-chain ClaimRegistry.
3. **Executed** them by spawning Claude Code as a subprocess, with per-request MCP tools and delegated signing authority over a trading venue (for example, Hyperliquid).
4. **Delivered** the result and its evidence back to the protocol.
5. **Earned** staking rewards: on-chain activity counters determined them at each checkpoint.

## What an operator needed

- A long-running daemon process (bare, Docker Compose, or the operator's own container).
- Two kinds of Ethereum-style address: a **master wallet** (held ETH for gas and owned the protocol service) and a **fleet of per-service agents** (a Safe multisig plus an EOA derived from the master mnemonic).
- For portfolio.v0: a **Hyperliquid master account** (held USDC for trading) and an approved **API wallet / agent** (signed trades on the master's behalf without authority to withdraw funds).
- The Claude Code CLI. When Claude auth or runtime setup was needed, `jinn run` opened the operator app and guided the operator through it.

## Key concept: the agent / master duality

For any trading venue Jinn integrated with, there were two keys:

- **Master**: held funds and signed deposits, withdrawals, and authorizations. The runbook advised keeping it offline in production.
- **Agent** (called an "API wallet" on Hyperliquid): a subordinate key the master had delegated trading authority to. The daemon held the agent key at runtime. A leaked agent key let an attacker trade but **not withdraw** from the master.

The daemon read the agent key from `/tmp/jinn-engine-impl-state/claude-mcp-hyperliquid/api-wallet.json` (mode 0o600). It never saw the master key.

## Install and first run

The runbook's install was one package and one command:

```bash
# Historical: the runbook's install command. Do not run it.
npm install -g @jinn-network/operator@latest
```

Then:

```bash
# Historical: the runbook's first-run command. Do not run it.
# Zero-to-running: opened the app, then auto-password + init, funding
# (automatic via CDP), bootstrap, and the daemon. A testnet-dedicated earning
# directory kept mainnet state separate.
JINN_EARNING_DIR="$HOME/.jinn-client/earning-testnet" JINN_NETWORK=testnet jinn run
```

What the runbook said to expect:
- `jinn run` opened the operator app and printed: keystore created (auto-password saved to `~/.jinn-client/keystore-password`), master address, CDP drips landing, staking complete, daemon started on port 7331.
- Any Claude Code authentication or runtime setup was completed in the operator app.

The failures operators hit are recorded under [Troubleshooting](#troubleshooting).

### Advanced / CI: explicit password

Operators who wanted to supply their own password instead of the auto-generated one (the runbook recommended this for production or scripted environments) set `JINN_PASSWORD` before calling `jinn run`:

```bash
# Historical: the runbook's explicit-password variant. Do not run it.
export JINN_PASSWORD='your-secure-password'
JINN_EARNING_DIR="$HOME/.jinn-client/earning-testnet" JINN_NETWORK=testnet jinn run
```

When `JINN_PASSWORD` was set, no password file was written to disk. `--password-fd N` served CI pipelines where the password came from a secret manager.

### Agent-assisted setup (Claude Code / Codex / Cursor / Gemini)

Operators could hand the setup to a coding agent instead:

```bash
# Historical: the runbook's agent-assisted setup. Do not run it.
npm install -g @jinn-network/operator@latest
jinn integrations install     # wired the jinn-operator skill + MCP into the agent
```

The runbook then had the operator paste a prompt into the agent, asking it to set up a testnet operator, run `jinn run`, fund the master address through CDP if needed, and report back once the daemon was running. The agent followed the same path as the manual install above.

## What `jinn run` did under the hood

The state machine, one line per step:

1. **Resolve password**: from `JINN_PASSWORD` or a one-time generated file under `~/.jinn-client/keystore-password`.
2. **Init**: create or load the fleet mnemonic, and persist the encrypted keystore at `$JINN_EARNING_DIR/master_keystore.json`.
3. **Bootstrap (up to 3 attempts, with an internal drip loop)**:
    a. Derive the master EOA address.
    b. Check the master ETH balance on Base Sepolia.
    c. **Drain the CDP faucet** until the balance cleared the `minEoaGasEth` floor (default 0.005 ETH, about 50 drips). This came with the Phase 2 UX fix; older versions used only 2 drips per run and left operators to loop.
    d. Pre-flight: check that the stOLAS distributor had enough pool liquidity for staking (a low pool surfaced as a `distributor_reachable` warning in `jinn doctor`).
    e. Call `distributor.stake()`, which created a Safe multisig and a service registry entry and attached the service to the staking contract. The master EOA covered the gas; the distributor pool provided the bond.
    f. Fund the agent EOA from the master (0.005 ETH for transactions).
    g. Deploy a mech on the marketplace (the on-chain identity the daemon claimed requests from).
4. **Daemon launch**: spawn the long-running loops. Every loop was conditional, so which ones started depended on the vertical mode and the config; the solve path was the work loop (claim, execute, deliver, settle) and the evaluate path was the evaluator loop. Full table: [`operator/ARCHITECTURE.md`](../operator/ARCHITECTURE.md) §6.

After this, `jinn status` reported healthy, and `http://127.0.0.1:7331/v1/status` served the JSON API.

## Portfolio.v0 intents

Portfolio.v0 was the first non-trivial intent kind: a 24-hour "grow my HL account by X%, keep drawdown under Y%" directive. The restorer impl was `claude-mcp-hyperliquid`. It spawned Claude Code about every 30 minutes (or on a mid-price move of 2% or more), with HL tools as MCP servers.

### How an intent was submitted

The runbook had the operator place JSON at `~/.jinn-client/portfolio-v0-intent.json`. The historical example, with `<NOW_MS>` as a placeholder:

```json
[
  {
    "id": "portfolio-v0-first-run",
    "description": "Grow HL portfolio 5% in 24h with 10% max drawdown.",
    "window": { "startTs": <NOW_MS>, "endTs": <NOW_MS + 86400000> },
    "spec": {
      "kind": "portfolio.v0",
      "account": {
        "venue": "hyperliquid-testnet",
        "masterAddress": "0x..."
      },
      "target":     { "metric": "equity_return_pct", "minReturnPct": 5.0 },
      "constraint": { "maxDrawdownPct": 10.0 }
    },
    "eligibility": { "minClosedTrades": 20, "minTradedNotionalMultiple": 5.0 }
  }
]
```

The daemon was pointed at it with `JINN_DESIRED_STATES="$HOME/.jinn-client/portfolio-v0-intent.json"` and restarted.

Constraints:
- `window.endTs - window.startTs` had to equal `86_400_000` exactly (Zod-enforced; 24h was not configurable in v0).
- `masterAddress` had to hold more than 0 USDC on either the HL perps side or the spot side (cross-margining handled either).
- `eligibility.minClosedTrades >= 1`, `minTradedNotionalMultiple > 0`.

### Pre-run checklist (HL side)

Before the daemon claimed the intent, the runbook listed three steps:

1. An API wallet (agent) keypair was generated offline, or the impl auto-provisioned one.
2. The agent's address was approved in the HL testnet UI, under Settings, API Wallets.
3. The agent's key was written to `/tmp/jinn-engine-impl-state/claude-mcp-hyperliquid/api-wallet.json`. The historical file shape:
    ```json
    {
      "privateKey": "0x...",
      "address": "0x...",
      "approved": true,
      "createdAt": 1700000000000,
      "approvedAt": 1700000000000,
      "masterAddress": "0x..."
    }
    ```
    Mode `0o600`. The file auto-deleted on impl startup if already persisted; `api_wallet_missing` in `jinn doctor` meant it had to be regenerated.

## Monitoring

```bash
# Historical: the runbook's monitoring commands. Do not run them.

# Liveness + fleet roll-up.
jinn status

# Detail per service.
jinn fleet

# Balance map across master + all agents + all Safes.
jinn balance

# Structured event log (one JSON object per line).
jinn logs

# Live tail of daemon lifecycle transitions.
jinn logs --follow

# Dashboard UI
open http://127.0.0.1:7331/

# Direct HTTP: portfolio.v0 specifics. /v1/status became operator-class with
# spec §14.5 (issue #2404); the on-disk UI token was passed.
curl -s -H "x-jinn-ui-token: $(cat ~/.jinn-client/ui-token)" \
  http://127.0.0.1:7331/v1/status | jq .portfolioV0
```

The `portfolioV0` block showed:
- `inFlight`: intents being processed.
- `recentVerdicts`: the last 10 COMPLETE / FAILED intents with their terminal state.
- `recentSnapshots`: pre/post snapshot artifacts.
- `recentClaudeOutcomes`: per-session telemetry (durations, tool call counts, fill counts). It was populated in real time as each Claude subprocess exited, so an operator could tell whether Claude was trading before the window closed.

## Risk rails (what the errors meant)

The `hl_open_position` MCP tool rejected invalid requests at the tool level before they reached HL. A tool error from Claude meant a rail had caught something:

| Error code | Meaning | What resolved it |
|---|---|---|
| `TPSL_REQUIRED` | An open without both `tp` and `sl` | Setting both TP and SL, or passing `bypassRiskRails: true` for a genuine scalp (logged). |
| `TP_INVALID` | Take-profit on the wrong side of mid | For a long, `tp > mid`. For a short, `tp < mid`. |
| `SL_INVALID` | Stop-loss on the wrong side of mid | For a long, `sl < mid`. For a short, `sl > mid`. |
| `NOTIONAL_EXCEEDED` | Position above 25% of unified account value | Reducing size or leverage. |
| `LEVERAGE_EXCEEDED` | Leverage above 10× | Nothing; it was a hard cap, not tunable. |
| `SLIPPAGE_EXCEEDED` | `slippageBps > 50` | Staying within the 50 bps IOC slippage maximum. |
| `TRIGGERS_FAILED` | Parent order filled but the TP/SL trigger submit failed | The position was live and bare, so `hl_close_position` at once, or a retry. |
| `HL_EXCHANGE_ERROR` | Hyperliquid returned an error response | `message` carried the underlying HL reason. |
| `RATE_LIMIT` | Too many write ops in the window | Backing off; the limit reset per session. |
| `UNKNOWN_COIN` | Asset name not in the HL universe | `hl_meta` listed the valid names. |

## Testnet caveats

- **Earning was OLAS-native.** There was no JINN token and no L2→L1 claim-relayer.
  Completed-loop activity incremented the Jinn activity checker, and the daemon's
  `reward-claim` loop pulled pending rewards from the stOLAS
  `ExternalStakingDistributor`. See [`SPEC.md`](../SPEC.md) §Economics for the design.
- **The testnet stOLAS distributor pool was pre-seeded.** In the mainnet design, real stakers deposit OLAS and the pool grows on its own. On testnet there were no stakers, so the pool was seeded for operators. When bootstrap failed with `Overflow(20, 0)` at `distributor.stake()`, the pool was drained and nothing could be done locally; bootstrap worked again only after the pool was refilled.
- **Evicted services recovered through the same operator wallet.** In standard mode, `distributor.stake()` recorded the operator's master EOA as the service operator. After an eviction, rerunning `jinn bootstrap` with the same `JINN_EARNING_DIR` and `JINN_PASSWORD` made the client call `distributor.reStake()` from that master EOA. Per-operator whitelisting was not required.
- **The CDP faucet rate-limited by address over 24h.** Exhausting the daily quota was rare, since the drip loop ran about 50 × 0.0001 ETH in 50 seconds, well under CDP's cap. When it happened, `jinn bootstrap` fell back to a manual-funding poll.
- **One HL master per test run.** Reusing a master across experiments caused position interference from leftover bots; a fresh master gave a clean signal.
- **Claude runtime state was machine-local.** Bare-mode operators completed Claude setup in the app opened by `jinn run`; headless containers needed the OAuth token mounted into a persistent volume (see the Docker section of [`operator/README.md`](../operator/README.md#docker)).
- **Docker Compose cwd detection was flaky.** Running from inside the repository's `operator/` checkout could make the daemon misdetect a `docker-compose` context. Running from `$HOME`, or setting `JINN_RUNTIME_MODE=bare` explicitly before `jinn run`, avoided it.

## Troubleshooting

The failures operators hit while the marketplace ran, and what resolved them at the time.

### Bootstrap looped forever (or hit `funding_required` after ~50 drips)

The CDP faucet had hit its daily rate limit on the master address. The check was:

```bash
# Historical: the runbook's funding check. Do not run it.
jinn fund-requirements --human
```

A reported balance of about 0.005 ETH that still said funding was required was a bug. Otherwise the faucet recovered after 24h, or the operator funded the address by hand.

### `jinn doctor` said `daemon_runtime_ready: false`

The compiled `mcp-tools.js` artifact was missing. The daemon could not run from source; it had to run from `dist/`:

```bash
# Historical: the runbook's fix. Do not run it.
# From a git checkout:
cd operator
yarn build
yarn dev  # = build + run

# From an npm install, reinstall:
npm install -g @jinn-network/operator@latest
```

### `jinn doctor` said `distributor_reachable: false` with "testnet staking pool is drained"

The stOLAS pool was empty. Operators could not fix it locally; `jinn bootstrap` worked again once the pool was topped up.

### Bootstrap failed with `Overflow(20, 0)` at `distributor.stake()`

The same root cause as above: the distributor pool was drained.

### Bootstrap said the master EOA was not authorized to `reStake`

The service was evicted, but the current master EOA did not match the operator recorded on-chain for that service. The fix was to re-run with the same `JINN_EARNING_DIR` and `JINN_PASSWORD` used when the service was first staked. Recovery needed those original keys; there was no other route open to an operator. Without them, the only option was to start over with a fresh earning directory.

### Claude session exited in ~18 seconds with zero tool calls

This usually meant the daemon ran from source instead of `dist/`, and the MCP wrapper could not load `mcp-tools.js`. The `daemon_runtime_ready` check in `jinn doctor` confirmed it.

Less often, the MCP config path was wrong or Claude auth had expired. `/tmp/jinn-engine-working/<requestId>/sessions/<sessionId>/transcript.txt` held the actual Claude output.

### HL position auto-closed within seconds of opening

A competing trading bot was active on the same HL master. A fresh master, used only for that test run, avoided it.

### The app said Claude was not authenticated

The app prompt handled it. In bare mode it opened the local Claude Code auth path.
Under docker-compose the command was `docker compose run --rm -it --entrypoint claude jinn-daemon auth login`.
In container mode, the host's Claude state was mounted into the container, or
`CLAUDE_CODE_OAUTH_TOKEN` was set explicitly.

### Starting over from scratch

```bash
# Historical: the runbook's reset. Do not run it.
rm -rf ~/.jinn-client/earning-testnet
rm -rf /tmp/jinn-engine-working /tmp/jinn-engine-impl-state
jinn run
```

The runbook called this safe: no on-chain state was lost, and `jinn bootstrap` reconciled any existing services against the chain.

## Glossary

- **Master**: the top-level EOA in an operator's fleet. It held ETH and signed the initial staking tx.
- **Agent**: a per-service EOA derived from the master mnemonic. It signed service-specific ops.
- **Safe**: a Gnosis Safe multisig owned by one agent; the service's identity on-chain.
- **Service**: an entry in the OLAS ServiceRegistry; what got staked.
- **Mech**: the on-chain router that converted marketplace requests into claimable jobs.
- **Intent**: an off-chain desired state published via the Jinn protocol.
- **Restorer**: the role that claimed and executed an intent (the operator).
- **Evaluator**: the role that verified a delivered restoration (possibly the same operator, through a separate service).
- **stOLAS**: liquid staking of OLAS. On testnet, stOLAS was the bond-pool mechanism; operators never held it directly.
- **Portfolio.v0**: the first non-trivial intent kind, which traded an HL account to meet return/drawdown targets over a 24h window.

## Links

- Protocol repo: <https://github.com/Jinn-Network/mono>
- Rotating harness API keys (per-harness auth stores): [`docs/operator/rotating-harness-keys.md`](operator/rotating-harness-keys.md)
- Operator npm: `@jinn-network/operator`
- Phase 1a design spec: `spec/2026-04-06-phase-1a-design.md`
- Portfolio.v0 design spec: `spec/2026-04-17-portfolio-v0-design.md`
- Client surface spec: `spec/2026-04-14-client-surface.md`
