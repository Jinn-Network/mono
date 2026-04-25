# Changelog

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
