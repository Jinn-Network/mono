# Changelog

## Unreleased

- Operator-app first-run polish (jinn-mono-mc24): a brand-new operator can run `jinn run` with no env var, no setup, no input.
  - `jinn run` now auto-generates a keystore password if `JINN_PASSWORD` isn't set and `~/.jinn-client/keystore-password` doesn't already exist (mode 0600). Replaces the previous fatal-exit on missing env var.
  - Daemon API server now starts BEFORE init/bootstrap; the operator panel auto-opens immediately and shows progress while init/bootstrap runs.
  - New top-level loading screen in the SPA renders during init / `mode: 'uninitialized'`, with spinner + latest event status line + collapsible event log; transitions to the four-region App once `/v1/bootstrap` is ready.
  - `ClaudeAuthCard` is now a "Sign in with Claude" button (in `bare` runtime mode); the daemon spawns `claude /login` server-side via the existing `buildLoginCommand` helper. Docker / container modes still surface the appropriate CLI command since the daemon can't reach the operator's host browser.
  - Keystore password change is now a `SettingsCard` in the panel (`POST /v1/setup/change-password`). The existing `jinn keys change-password` CLI continues to work for scripted use.
  - Removed the unreachable `KeystoreCreateCard` and `POST /v1/setup/keystore` endpoint (daemon now owns keystore creation; the panel observes).
- Removed the `jinn quickstart` verb; `jinn run` now subsumes its zero-to-running flow (resolve/generate password, init wallet, bootstrap fleet, then start the daemon in the foreground). The corresponding MCP tool was renamed `jinn_run`. Existing scripts using `jinn quickstart` should switch to `jinn run`. (jinn-mono-zqm2)

## 0.1.3

- Added the v0 testnet cross-chain JINN claim loop, including bundled Sepolia/Base Sepolia MVI deployment artifacts, MockMessenger burn-in support, and canonical OP-Stack verifier canary tooling.
- Added Safe v1.3 inner-revert decoding so permanent claim and delivery races stop retrying with generic `GS013` errors.
- Updated bundled Phase 1b deployment defaults for the proxy-deployable V2 activity checker and JINN MVI testnet stack.
- Added release-gate coverage for contract tests, storage-layout drift checks, and Foundry invariant harness compilation.
- Hardened the local operator release gate for the current adapter API, ERC-8004 stubbed subgraph surface, and forked-chain `setAgentWallet` deadlines.
- Switched the docker testnet acceptance gate from legacy health-check intents to the auto-generated `prediction.v0` loop. The gate now requires both restoration and evaluation success per cycle, gates on cycles produced after `runStartAt`, and uses tighter cycle-shaping params (`JINN_PREDICTION_V0_WINDOW_MS=120000`, `JINN_PREDICTION_V0_RESOLVE_GAP_MS=60000`) so a full restoration→delivery→evaluation→claim round-trip lands inside the 20-minute timeout.

## 0.1.2

- Replaced the `mech-client-ts` IPFS upload dependency with the client’s own Autonolas registry upload path, reducing the packed install footprint and removing the deprecated js-IPFS transitive chain from the release artifact.
- Updated the optional Coinbase CDP SDK used for testnet faucet support.
- Added `jinn intents enable --impl <name>` plus `jinn intents reset <kind>` so operators can switch intent implementations without hand-editing config.
- Removed the default legacy health-check desired state; testnet now relies on the deterministic auto-generated `prediction.v0` intent path by default.
- Added graceful legacy Claude skip behavior (`claude_unavailable`) when auth/quota blocks health-check restoration attempts.
- Fixed no-install invocation so `npx @jinn-network/client@<version> <verb>` works directly via a `client` bin alias.
- Added canonical `jinn mcp` command and kept `jinn-mcp` as a deprecation shim.
- Extended package smoke tests to validate both direct `npx` and legacy `npx -p ... jinn ...` execution paths.
- Includes prior validated canary fixes now rolled into stable:
  - PR #21 default Base Sepolia ClaimRegistry
  - PR #22 idempotent replayed `claimDelivery`
  - PR #23 prediction evaluator support for signed engine manifests
