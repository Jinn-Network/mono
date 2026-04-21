# Jinn Daemon vs. "Increase my portfolio on testnet" — Mapping Pass

**Date:** 2026-04-17
**Status:** mapping only — no implementation
**Scope:** `client/` daemon as of this worktree, Base Sepolia (Phase 1b)

---

## 1. What the daemon accepts as input today

Inputs flow through `client/src/config.ts` (`JinnConfigSchema`) plus env vars. The primary user-facing input shape is a list of **desired states**:

```ts
// client/src/types/desired-state.ts
interface DesiredState {
  id: string;
  description: string;           // free-form natural language, min length 1
  context?: Record<string, unknown>;
}
```

Loaded from `~/.jinn-client/config.json` (`desiredStates`) or `JINN_DESIRED_STATES` pointing at a JSON file. Default is a single health-check state. `parseDesiredState` assigns a UUID if none provided (`client/src/types/desired-state.ts:22`).

Other inputs:
- `network`: `testnet` (default in Phase 1b, → Base Sepolia 84532) or `mainnet` (Base 8453).
- `rpcUrl`, `claudeModel`, `claudePath`, `pollIntervalMs`, `apiPort`, `peers`, `subgraphUrl`, `nodeEndpoint`.
- Testnet deployment artifact paths (bundled defaults point at `client/deployments/deployment-phase1{a,b}-*-baseSepolia-fast.json` and `deployment-stolas-l2-*`).
- `stakingMode` (`standard` stOLAS / `self-bond` OLAS), `targetServices`.
- `JINN_PASSWORD` (env-only) for keystore decryption.

**Key shape constraint:** desired states are opaque text + optional context. There is no structured schema for goals, asset references, amounts, venues, or success predicates. The daemon has no notion of "portfolio," "balance target," or "measurable outcome" beyond "did a Claude subprocess declare success?"

The HTTP API (`client/src/api/server.ts`) currently exposes artifact search/publish and `/v1/status`; it is not a control-plane for injecting new intents at runtime.

## 2. On-chain actions the daemon can already take (testnet)

Base Sepolia chain ID 84532. All writes go through the fleet's **Safe multisig** via `executeSafeTransaction` (`client/src/adapters/mech/safe.ts`); the agent EOA is a Safe owner and signs. Targets and methods actually invoked:

### Bootstrap (one-shot, `client/src/earning/bootstrap.ts`)
- `ServiceRegistry` / `ServiceRegistryTokenUtility` / `ServiceManager` — `create`, `activateRegistration`, `registerAgents`, `deploy`.
- OLAS `approve`.
- **stOLAS** `StakingManager.stake` (standard mode) or `StakingToken.stake` (self-bond).
- `MechMarketplace.create` → deploys a mech contract for the service.

### Steady-state (three loops + reward claim, `client/src/daemon/*`)
- **Creator** → `JinnRouter.createRestorationJob(requestData, mech, price, timeout, NATIVE_PAYMENT, 0x)` per configured desired state, per loop tick. Posts the state on IPFS, references CID bytes32.
- **Restorer** → `MechMarketplace.priorityMechRequestData` / watches events → `ClaimRegistry` check (`AcceptAllChecker` Phase 0) → `Mech.deliverToMarketplace(requestId, deliveryData)` via Safe after Claude subprocess returns a result.
- **DeliveryWatcher** → `JinnRouter.claimDelivery` (v1 on mainnet, v2 on testnet) then `JinnRouter.createEvaluationJob`.
- **RewardClaimLoop** → stOLAS `ExternalStakingDistributor.claim(serviceId)` on `distributorAddress` from the stOLAS artifact (master EOA pays gas) every `rewardClaimIntervalMs`.

### Key testnet addresses (from bundled deployment JSONs)
- `jinnRouter`, `mechMarketplace`, `serviceRegistry*`, `stakingToken` / `stakingManager`, `stOLAS` vault, `ExternalStakingDistributor`, `JINN` token / `Treasury`. All resolved through `getChainConfig('base-sepolia', …)` in `client/src/earning/contracts.ts`.

### What the daemon does NOT do on-chain today
- No DEX swaps (no Uniswap/Aerodrome/0x router integrations).
- No lending/borrowing (no Aave/Compound/Morpho/Moonwell calls).
- No LP deposits or yield vault deposits outside stOLAS (which is incidental to staking, not a portfolio action).
- No ERC-20 transfers from Safe to arbitrary addresses at runtime. No bridging. No NFT ops.
- No balance/price reads for portfolio accounting — only activity counters and staking state.
- No kill-switch / unstake path during normal ops (unstake lives in `client/src/withdraw/` for operator teardown, not intent execution).

**Effective capability surface:** post/claim/deliver/evaluate Jinn protocol jobs + auto-claim stOLAS distributor rewards. Everything else is off-menu.

## 3. Gap: from current surface to "increase my portfolio"

To accept "increase my portfolio on testnet" as a **measurable intent** and execute **one real testnet action** toward it, the daemon needs four categories of addition:

### A. Intent schema
Today's `DesiredState` is a sentence. A portfolio intent needs structure:
- baseline accounting (which address(es), which assets, which chain, valuation numéraire — ETH? USDC?)
- target (delta, ratio, or absolute; time horizon; tolerances)
- constraints (max slippage, max gas, venue allowlist, asset allowlist, per-action cap)
- success predicate that can be evaluated on-chain after the fact

Suggest extending `DesiredState.context` with a typed `portfolio` variant, OR a new top-level `Intent` schema that coexists with `DesiredState`. Zod-validated. Versioned.

### B. Portfolio read layer
Nothing in `client/src/` today reads asset balances or prices. Need:
- Safe address → ERC-20 balanceOf loop for a configured asset list.
- Price oracle (Chainlink on Base Sepolia is thin; likely need a testnet-safe fallback — hardcoded numéraire, mock feed, or a DEX-derived spot price from a pool read).
- Snapshot persistence alongside the existing SQLite store for before/after comparison.

### C. Action layer + policy
`ExecutionAdapter` is shaped entirely around the request/deliver/evaluate protocol. Portfolio actions don't fit this interface. Options:
1. New adapter kind (e.g. `PortfolioAdapter`) with `proposeAction → simulate → execute → verify`, composed alongside `MechAdapter` in `Daemon`.
2. Model each portfolio action as an internal "desired state" whose restorer is a Safe tx builder rather than a Claude subprocess. Reuses existing loops; abuses the abstraction.

Either way, requires: a venue registry (router addresses on Base Sepolia), calldata builders, Safe batching (already exists in `safe-adapter.ts`), and a preflight check (balance, allowance, slippage sim) before signing.

### D. Measurement + proof
The "measurable" bit needs a verifiable on-chain record: tx hash, block, pre/post balances, and a reproducible valuation. Plug into the existing evidence path — emit as an artifact via the api server (`/v1/artifacts`) so it's discoverable like Phase 1b evaluation outputs. Optionally publish to ERC-8004 registry (already wired).

### Smallest vertical slice that closes the gap
1. Add `intent.portfolio.v0` context variant with `{ baseline: {...}, target: {deltaWei, asset}, constraint: {maxSlippageBps, venue} }`.
2. Read Safe USDC + WETH balances on Base Sepolia at boot; persist snapshot.
3. One hardcoded action path: swap X wei of Safe-held testnet ETH → USDC via a single Base Sepolia DEX router, bounded by `maxSlippageBps`.
4. Post-tx: re-read balances, emit an artifact proving net USDC increase. That is the "measurable" closure.

## 4. Candidate first actions (one-line tradeoffs)

Assume Safe on Base Sepolia holds a small amount of testnet ETH + faucet-issued stables. Target: one real tx that measurably grows a chosen portfolio measure.

- **Swap small ETH → USDC on a Base Sepolia DEX (Uniswap v3 or Aerodrome testnet pool).** Simplest, fully atomic, measurable in one block; risk is thin testnet liquidity → high slippage and flaky pools.
- **Supply USDC to a lending market (Aave v3 Base Sepolia, if deployed; else Moonwell).** Produces yield-bearing aToken → clean "portfolio increase" narrative; risk is testnet market may be paused / rewards zero, and success measure becomes "position exists" rather than "value grew."
- **Deposit into a vault (e.g., a Base Sepolia ERC-4626 test vault).** Clear before/after share accounting; risk is finding a live testnet vault we trust and that doesn't require allowlisting.
- **Stake more OLAS via the existing stOLAS path (increase service count / bond).** Reuses code already in the daemon; risk is it's indistinguishable from normal bootstrap — doesn't exercise a *new* action surface, so weakest demonstration of "portfolio intent" generalization.
- **Bridge a tiny amount from Sepolia L1 → Base Sepolia to rebalance.** Demonstrates cross-domain intent; risk is bridge UX on testnet is slow + flaky, hard to make measurable in one daemon tick.

Recommended first wedge: **ETH → USDC swap on a known-liquid Base Sepolia pool**. Cheapest to wire, strongest "measurable in one tx" story, and the DEX adapter it forces is reusable for every subsequent action.

---

REVIEW_TARGET: /Users/adrianobradley/jinn-mono/.worktrees/jinn-mono-end-to-end-daemon-accept-measurable-in-6f7ccc20/docs/planning/2026-04-jinn-e2e-portfolio-map.md
