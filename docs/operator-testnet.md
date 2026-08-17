# Operator runbook — Jinn testnet (Base Sepolia + Hyperliquid testnet)

The honest end-to-end guide for running a Jinn operator daemon on testnet. Target audience: you just `npm install -g`'d the client and want to reach "my daemon is trading" in under 15 minutes.

If you hit a wall, jump to the [Troubleshooting](#troubleshooting) section — the specific symptoms that trip up new operators are enumerated there.

## What Jinn does

Jinn is a training protocol for agentic intents. Operators run a headless daemon that:

1. **Observes** marketplace requests (desired states posted on-chain, IPFS-backed).
2. **Claims** them via the on-chain ClaimRegistry.
3. **Executes** — spawns Claude Code as a subprocess with per-request MCP tools and delegated signing authority over a trading venue (e.g., Hyperliquid).
4. **Delivers** — packages the result + evidence and submits back to the protocol.
5. **Earns** — activity counters on-chain determine staking rewards at each checkpoint.

Testnet is where you prove the loop works against real (test-) money before mainnet goes live.

## What you're signing up for

- A long-running daemon process (bare, Docker Compose, or your own container).
- Two Ethereum-style addresses: a **master wallet** (holds ETH for gas; owns the protocol service) and a **fleet of per-service agents** (Safe multisig + EOA derived from the master mnemonic).
- For portfolio.v0: a **Hyperliquid master account** (holds USDC for trading) and an approved **API wallet / agent** (signs trades on the master's behalf without fund-withdrawal authority).
- Claude Code CLI installed. If Claude auth or runtime setup is needed,
  `jinn run` opens the operator app and guides you through it.

## Key concept — the agent / master duality

For any trading venue Jinn integrates with, there are two keys:

- **Master** — holds funds. Signs deposits, withdrawals, and authorizations. You keep this offline in production.
- **Agent** (also called "API wallet" on Hyperliquid) — a subordinate key the master has delegated trading authority to. The daemon holds the agent key at runtime. If the agent leaks, the attacker can trade but **cannot withdraw** from the master.

The daemon reads the agent key from `/tmp/jinn-engine-impl-state/claude-mcp-hyperliquid/api-wallet.json` (mode 0o600). It never sees the master key.

## One-command install → running

```bash
npm install -g @jinn-network/operator@latest
```

Then:

```bash
# Zero-to-running: opens the app, then auto-password + init → fund
# (auto via CDP) → bootstrap → run daemon. Use a testnet-dedicated earning
# directory so mainnet state stays separate.
JINN_EARNING_DIR="$HOME/.jinn-client/earning-testnet" JINN_NETWORK=testnet jinn run
```

Expected output:
- `jinn run` opens the operator app and prints: keystore created (auto-password saved to `~/.jinn-client/keystore-password`), master address, CDP drips landing, staking complete, daemon started on port 7331.
- If Claude Code authentication or runtime setup is needed, complete it in the operator app.

If it ran through, you're done. Otherwise, skip to [Troubleshooting](#troubleshooting).

### Advanced / CI: explicit password

If you want to supply your own password instead of using the auto-generated one (recommended for production or scripted environments), set `JINN_PASSWORD` before calling `jinn run`:

```bash
export JINN_PASSWORD='your-secure-password'
JINN_EARNING_DIR="$HOME/.jinn-client/earning-testnet" JINN_NETWORK=testnet jinn run
```

When `JINN_PASSWORD` is set, no password file is written to disk. Use `--password-fd N` for CI pipelines where the password comes from a secret manager.

### Agent-assisted setup (Claude Code / Codex / Cursor / Gemini)

If you'd rather have a coding agent handle the setup, wire it in:

```bash
npm install -g @jinn-network/operator@latest
jinn integrations install     # wires the jinn-operator skill + MCP into your agent
```

Then open your agent and paste:

> Set up a Jinn Network testnet operator on this machine. Run `jinn run`, fund the master address via CDP if needed, and report back when the daemon is running. Keep me in the loop if anything needs my input.

The agent will follow the same path as the manual quickstart above.

## What `jinn run` does under the hood

The state machine, one line per step:

1. **Resolve password** — from `JINN_PASSWORD` or a one-time generated file under `~/.jinn-client/keystore-password`.
2. **Init** — create or load the fleet mnemonic; persist the encrypted keystore at `$JINN_EARNING_DIR/master_keystore.json`.
3. **Bootstrap (up to 3 attempts, with internal drip loop)**:
    a. Derive master EOA address.
    b. Check master ETH balance on Base Sepolia.
    c. **Drain CDP faucet** until balance clears the `minEoaGasEth` floor (default 0.005 ETH, ~50 drips). New since Phase 2 UX fix — older versions used only 2 drips per run and required operator loops.
    d. Pre-flight: check stOLAS distributor has enough pool liquidity for staking (surfaces as a `distributor_reachable` warning in `jinn doctor` if low).
    e. Call `distributor.stake()` — creates a Safe multisig + service registry entry + attaches the service to the staking contract. Master pays gas; the distributor pool provides the bond.
    f. Fund the agent EOA from master (0.005 ETH for txs).
    g. Deploy a mech on the marketplace (the on-chain identity your daemon claims requests from).
4. **Daemon launch** — spawns the long-running loops. Every loop is conditional, so which ones start depends on the vertical mode and your config; the solve path is the work loop (claim + execute + deliver + settle) and the evaluate path is the evaluator loop. Full table: [`client/ARCHITECTURE.md`](../client/ARCHITECTURE.md) §6.

After this, `jinn status` returns healthy. `http://127.0.0.1:7331/v1/status` is the JSON API.

## Portfolio.v0 intents

Portfolio.v0 is the first non-trivial intent kind — a 24-hour "grow my HL account by X%, keep drawdown under Y%" directive. The restorer impl is `claude-mcp-hyperliquid`: spawns Claude Code every ~30 min (or on ≥2% mid-move), with HL tools as MCP servers.

### Submitting one

Place JSON at `~/.jinn-client/portfolio-v0-intent.json`:

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

Point the daemon at it: `export JINN_DESIRED_STATES="$HOME/.jinn-client/portfolio-v0-intent.json"` then restart.

Constraints:
- `window.endTs - window.startTs === 86_400_000` exactly (Zod-enforced; 24h is non-configurable in v0).
- `masterAddress` must have >0 USDC either on the HL perps side or the spot side (cross-margining handles either).
- `eligibility.minClosedTrades >= 1`, `minTradedNotionalMultiple > 0`.

### Pre-run checklist (HL-side)

Before the daemon claims the intent:

1. Generate an API wallet (agent) keypair off-line (or let the impl auto-provision).
2. In the HL testnet UI → Settings → API Wallets: approve the agent's address.
3. Write the agent's key into `/tmp/jinn-engine-impl-state/claude-mcp-hyperliquid/api-wallet.json`:
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
    Mode `0o600`. This file auto-deletes on impl startup if already persisted — regenerate if you see `api_wallet_missing` in `jinn doctor`.

## Monitoring

```bash
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

# Direct HTTP — portfolio.v0 specifics. /v1/status is operator-class as of
# spec §14.5 (issue #2404); pass the on-disk UI token.
curl -s -H "x-jinn-ui-token: $(cat ~/.jinn-client/ui-token)" \
  http://127.0.0.1:7331/v1/status | jq .portfolioV0
```

The `portfolioV0` block shows:
- `inFlight` — intents currently being processed.
- `recentVerdicts` — last 10 COMPLETE / FAILED intents with their terminal state.
- `recentSnapshots` — pre/post snapshot artifacts.
- `recentClaudeOutcomes` — per-session telemetry: durations, tool call counts, fill counts. Populated in real time as each Claude subprocess exits, so you can answer "is my Claude trading" before the window closes.

## Risk rails (what the errors mean)

The `hl_open_position` MCP tool rejects invalid requests at the tool level before hitting HL. If Claude emits a tool error, the rail caught something:

| Error code | Meaning | Typical remedy |
|---|---|---|
| `TPSL_REQUIRED` | Open without both `tp` and `sl` | Always set TP + SL; or pass `bypassRiskRails: true` for a genuine scalp (logged). |
| `TP_INVALID` | Take-profit on wrong side of mid | For long, `tp > mid`. For short, `tp < mid`. |
| `SL_INVALID` | Stop-loss on wrong side of mid | For long, `sl < mid`. For short, `sl > mid`. |
| `NOTIONAL_EXCEEDED` | Position > 25% of unified account value | Reduce size or leverage. |
| `LEVERAGE_EXCEEDED` | Leverage > 10× | Hard cap; not tunable. |
| `SLIPPAGE_EXCEEDED` | `slippageBps > 50` | Max 50 bps IOC slippage. |
| `TRIGGERS_FAILED` | Parent order filled but TP/SL trigger submit failed | Position is live and bare — `hl_close_position` immediately or retry. |
| `HL_EXCHANGE_ERROR` | Hyperliquid returned an error response | Check `message` for the underlying HL reason. |
| `RATE_LIMIT` | Too many write ops in the window | Back off; the rate limit resets per session. |
| `UNKNOWN_COIN` | Asset name not in HL universe | Check `hl_meta` for valid names. |

## Testnet-specific caveats

- **Cross-chain JINN issuance burn-in uses MockMessenger.** On Base Sepolia,
  canonical OP-Stack finality is too slow for active operator burn-in, so the
  testnet distributor should be wired to `MockMessenger` and the daemon should
  run with `JINN_MESSENGER_MODE=mock`. This is not a mainnet security claim:
  MockMessenger mirrors the canonical `claimId` snapshot identity but skips the
  OP finality wait. Canonical Base Sepolia is exercised separately as a
  verifier-only canary by building the storage proof after finality and calling
  `CanonicalOpStackMessenger.verifyClaim` via `eth_call`; do not swap the active
  distributor messenger during burn-in.
- **stOLAS distributor pool is protocol-team-managed.** On mainnet, real stakers deposit JINN/OLAS and the pool grows naturally. On testnet there are no stakers, so the team pre-seeds the pool via a one-time bridge from Sepolia L1. If bootstrap fails with `Overflow(20, 0)` at `distributor.stake()`, the pool is drained — nothing you can do locally. Post in the testnet channel and re-run bootstrap after refill.
- **Evicted services recover through the same operator wallet.** In standard mode, `distributor.stake()` records your master EOA as the service operator. If the service is evicted, rerun `jinn bootstrap` with the same `JINN_EARNING_DIR` and `JINN_PASSWORD`; the client calls `distributor.reStake()` from that master EOA. Per-operator whitelisting is not required.
- **CDP faucet rate limits by address over 24h.** If you burn through your daily quota (rare — the drip loop runs ~50 × 0.0001 ETH in 50 seconds, well under CDP's cap), `jinn bootstrap` falls back to a manual-funding poll. Wait or fund via the portal: <https://portal.cdp.coinbase.com/products/faucet>.
- **One HL master per test run.** If you reuse a master across experiments, expect position interference from leftover bots. Fresh master = clean signal.
- **Claude runtime state is machine-local.** Bare-mode operators complete Claude setup in the app opened by `jinn run`; headless containers need the OAuth token mounted into a persistent volume (see the Docker Compose section of `client/README.md`).
- **Docker Compose cwd detection is flaky.** If you run from inside the `jinn-mono/client/` git checkout, the daemon can misdetect `docker-compose` context. Either run from `$HOME`, or set `JINN_RUNTIME_MODE=bare` explicitly before `jinn run`.

## Troubleshooting

### Bootstrap loops forever (or hits `funding_required` after ~50 drips)

The CDP faucet hit its daily rate limit on your master address. Check:

```bash
jinn fund-requirements --human
```

If the reported balance is ~0.005 ETH and still says funding required, that's a bug — file an issue. Otherwise wait 24h or fund manually at <https://portal.cdp.coinbase.com/products/faucet>.

### `jinn doctor` says `daemon_runtime_ready: false`

The compiled `mcp-tools.js` artifact is missing. The daemon cannot run from source — it must run from `dist/`:

```bash
# From a git checkout:
cd client
yarn build
yarn dev  # = build + run

# From an npm install, reinstall:
npm install -g @jinn-network/operator@latest
```

### `jinn doctor` says `distributor_reachable: false` with "testnet staking pool is drained"

The stOLAS pool is empty. This is a **protocol-team action** — operators cannot fix it locally. Report in the testnet status channel and re-run `jinn bootstrap` once the pool is topped up.

### Bootstrap fails with `Overflow(20, 0)` at `distributor.stake()`

Same root cause as above — distributor pool drained.

### Bootstrap says the master EOA is not authorized to `reStake`

The service is evicted, but the current master EOA does not match the operator recorded on-chain for that service. Re-run with the same `JINN_EARNING_DIR` and `JINN_PASSWORD` used when the service was first staked. If the original keys are unavailable, ask the protocol team for owner / managing-agent recovery or start over with a fresh earning directory.

### Claude session exits in ~18 seconds with zero tool calls

Usually means the daemon ran from source instead of `dist/`, and the MCP wrapper couldn't load `mcp-tools.js`. Run `jinn doctor`; the `daemon_runtime_ready` check will confirm.

Less common: the MCP config path was wrong, or Claude auth expired. Check `/tmp/jinn-engine-working/<requestId>/sessions/<sessionId>/transcript.txt` for the actual Claude output.

### HL position auto-closed within seconds of opening

A competing trading bot is active on the same HL master. Generate a fresh master and use it exclusively for this test run.

### The app says Claude is not authenticated

Follow the app prompt. For bare mode it opens the local Claude Code auth path.
For docker-compose: `docker compose run --rm -it --entrypoint claude jinn-daemon auth login`.
For container mode: mount your host's Claude state into the container or set
`CLAUDE_CODE_OAUTH_TOKEN` explicitly.

### I need to start over from scratch

```bash
rm -rf ~/.jinn-client/earning-testnet
rm -rf /tmp/jinn-engine-working /tmp/jinn-engine-impl-state
jinn run
```

Safe — no on-chain state is lost; `jinn bootstrap` reconciles any existing services against the chain.

## Glossary

- **Master** — the top-level EOA in your fleet. Holds ETH; signs the initial staking tx.
- **Agent** — per-service EOA derived from the master mnemonic. Signs service-specific ops.
- **Safe** — Gnosis Safe multisig owned by one agent. Service identity on-chain.
- **Service** — an entry in the OLAS ServiceRegistry; what gets staked.
- **Mech** — on-chain router that converts marketplace requests into claimable jobs.
- **Intent** — an off-chain desired state published via the Jinn protocol.
- **Restorer** — the role that claims + executes an intent (you).
- **Evaluator** — the role that verifies a delivered restoration (probably also you, via a separate service).
- **stOLAS** — liquid staking of OLAS/JINN. On Phase 1b testnet, stOLAS is the bond-pool mechanism; operators never hold it directly.
- **Portfolio.v0** — first non-trivial intent kind: trade an HL account to meet return/drawdown targets over a 24h window.

## Links

- Protocol repo: <https://github.com/Jinn-Network/mono>
- Rotating harness API keys (per-harness auth stores): [`docs/operator/rotating-harness-keys.md`](operator/rotating-harness-keys.md)
- Client npm: `@jinn-network/operator` (`@jinn-network/client` remains an alias during the F1 window)
- CDP faucet (manual): <https://portal.cdp.coinbase.com/products/faucet>
- HL testnet: <https://app.hyperliquid-testnet.xyz>
- Phase 1a design spec: `spec/2026-04-06-phase-1a-design.md`
- Portfolio.v0 design spec: `spec/2026-04-17-portfolio-v0-design.md`
- Client surface spec: `spec/2026-04-14-client-surface.md`
