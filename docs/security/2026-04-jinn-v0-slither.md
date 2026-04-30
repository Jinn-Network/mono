# Jinn v0 — Slither Static Analysis

> Status: **v0 pre-testnet review, Slither pass**
> Date: 2026-04-27
> Branch: `jinn-mono/jinn-mono-zwj` (forked from `jinn-mono/jinn-mono-1bo`)
> Issue: bd `jinn-mono-sz0`
> Related: [`2026-04-jinn-v0-threat-model.md`](./2026-04-jinn-v0-threat-model.md), [`2026-04-v2-checker-audit.md`](./2026-04-v2-checker-audit.md)

## Tool + version

| Tool | Version | Notes |
|------|---------|-------|
| Slither | 0.11.5 | `pip install slither-analyzer==0.11.5` |
| solc | 0.8.30+commit.73712a01 | Installed via `solc-select install 0.8.30 && solc-select use 0.8.30` |
| crytic-compile | 0.3.11 | Bundled with Slither; uses Foundry/forge build under the hood when `foundry.toml` is present |

The audit was driven on a clean `forge build` (Foundry config added in this commit) so vendored OLAS contracts compile without solc-version conflicts. `--filter-paths node_modules` strips the OZ findings that originate from upstream library code outside our control.

## Scope

| Path | Audited |
|------|---------|
| `cargo/contracts/src/jinn/token/JINN.sol` | yes |
| `cargo/contracts/src/jinn/distribution/JinnDistributor.sol` | yes |
| `cargo/contracts/src/jinn/governance/JinnGovernor.sol` | yes |
| `cargo/contracts/src/jinn/cross-chain/CanonicalOpStackMessenger.sol` | yes |
| `cargo/contracts/src/jinn/cross-chain/MockMessenger.sol` | yes |
| `cargo/contracts/src/jinn/cross-chain/JinnClaimEmitter.sol` | yes |
| `cargo/contracts/src/jinn/interfaces/IClaimMessenger.sol` | yes |
| `cargo/contracts/src/staking/RestorationActivityCheckerV2.sol` | yes |
| `cargo/contracts/src/staking/JinnRouterV2.sol` | yes |

Test/mock fixtures (`DistributionTestMocks.sol`, `CrossChainTestMocks.sol`) are out of scope. Vendored OLAS, prior-phase contracts (`ClaimRegistry`, `RestorationActivityChecker`, `JinnRouter` V1), and unmodified OZ libraries are excluded.

## How to reproduce

```bash
# One-time install
pip install slither-analyzer==0.11.5
solc-select install 0.8.30
solc-select use 0.8.30

# From cargo/contracts/
yarn install            # populates node_modules/@openzeppelin
forge build             # populates forge-out/
for f in src/jinn/token/JINN.sol \
         src/jinn/distribution/JinnDistributor.sol \
         src/jinn/governance/JinnGovernor.sol \
         src/jinn/cross-chain/CanonicalOpStackMessenger.sol \
         src/jinn/cross-chain/MockMessenger.sol \
         src/jinn/cross-chain/JinnClaimEmitter.sol \
         src/jinn/interfaces/IClaimMessenger.sol \
         src/staking/RestorationActivityCheckerV2.sol \
         src/staking/JinnRouterV2.sol; do
  slither "$f" \
    --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/" \
    --solc-args "--via-ir --optimize --optimize-runs=1000000 --evm-version cancun" \
    --filter-paths node_modules
done
```

## Severity distribution

After triage and excluding `informational` (naming-convention, too-many-digits, redundant-statements, solc-version pragma noise from OZ):

| Severity | Count | Disposition |
|----------|------:|-------------|
| High     | 0     | – |
| Medium   | 0     | – |
| Low      | 4     | 3 accepted (CEI/spec by design), 1 acknowledge as low risk |
| Informational (kept) | 2 | both accepted (proxy storage layout, ERC-6372 mixed case) |

Slither reported **zero high or medium-severity actionable findings** across the v0 surface.

## Findings — actionable

### F-1: `JinnDistributor.claim` emits `Claimed` after external `mint` calls

- **Detector**: `reentrancy-events` (low)
- **Location**: `src/jinn/distribution/JinnDistributor.sol#193-258`
- **Slither summary**: `jinn.mint(...)` is called before the `Claimed` event is emitted, so a reentrant call could observe a pre-event state.
- **Triage — accepted (CEI ordering by design)**: the contract follows strict Checks-Effects-Interactions ordering. State mutation (`totalClaimedOperator[serviceId]`, `totalClaimedDao[serviceId]`) happens **before** any `jinn.mint` call (lines 233–238), and any reentrant `claim()` against the same `serviceId` short-circuits at the `if (owedOperator == 0 && owedDao == 0) return;` guard (line 226) because the accumulators have already advanced. The `Claimed` event is the after-the-fact log of a successful flow; its position after the mints is intentional so it carries the post-mint state in its read-back of `totalClaimedOperator`/`totalClaimedDao`.
- **Additional reentrancy reasoning**: the only external call inside `claim()` is `jinn.mint`. The `JINN.mint` function is the OZ ERC20Votes `_mint`, which writes voting checkpoints and the recipient balance — no callback or hook surface exists. JINN does **not** implement ERC777, ERC1363, ERC4626, or any ERC-1155 receiver hook. Reentrancy is not reachable in v0; calling out the CEI ordering is defensive, not a real attack.
- **Action**: none; document the CEI ordering in the threat model (already covered there).

### F-2: `JinnRouterV2.createRestorationJob` / `createEvaluationJob` write storage after external `request()` call

- **Detector**: `reentrancy-benign` + `reentrancy-events` (low)
- **Location**: `src/staking/JinnRouterV2.sol#152-179`, `#191-221`
- **Slither summary**: `requestTypes[requestId]`, `creators[requestId]`, and the corresponding events are written/emitted after `IMechMarketplace.request(...)` returns.
- **Triage — accepted (sequencing matches OLAS contract)**: the `requestId` returned by `IMechMarketplace.request` is the unique handle assigned by the marketplace; it is impossible to record `requestTypes[requestId]` and `creators[requestId]` *before* the external call because the key is not yet known. The marketplace contract on Base is the deployed OLAS `MechMarketplace`, owned by OLAS governance, and it does not call back into the router — `request()` is a synchronous registration. A hypothetical adversarial marketplace could call back into `claimDelivery()`, but `claimDelivery()` requires `requestTypes[requestId] != NONE` (which has not been written yet on a reentrant call) and so reverts with `RequestNotFound`. The router thereby preserves the property that no claim can be recorded for a request whose creation has not finalised. **Note the dependency on a non-malicious marketplace is the same trust assumption the surrounding OLAS-staking design already makes** — flagged for completeness, not as a v0 blocker.
- **Action**: none for v0. If we ever swap in a non-canonical marketplace adapter, this assumption needs re-checking.

### F-3: `JinnClaimEmitter.emitClaim` ignores six of seven `mapServices` return values

- **Detector**: `unused-return` (low)
- **Location**: `src/jinn/cross-chain/JinnClaimEmitter.sol#92`
- **Slither summary**: `(, address multisig, , , , , ) = serviceRegistry.mapServices(serviceId)` discards `securityDeposit`, `configHash`, `threshold`, `maxNumAgentInstances`, `numAgentInstances`, and `state`.
- **Triage — accepted (intentional read shape)**: only `multisig` is needed by the cross-chain claim flow. The other fields are unrelated to JINN minting. Tuple destructuring with skipped fields is the conventional way to express this in Solidity. Slither flags the pattern because the underlying detector is "function call return value unused"; the destructuring tuple is exactly the *opposite* of an ignored return value — every consumed slot is named, every unused slot is explicitly elided.
- **Action**: none.

### F-4: `JINN.setMinter` lacks a zero-address check on `newMinter`

- **Detector**: `missing-zero-check` (low)
- **Location**: `src/jinn/token/JINN.sol#44-47`
- **Slither summary**: setter writes `minter = newMinter` with no `newMinter != address(0)` guard.
- **Triage — accepted (zero is the explicit "disabled" sentinel)**: the contract NatSpec on `minter` reads "Address authorised to mint new JINN; **zero disables minting**." Setting `minter = address(0)` is the only way to revoke the distributor's minting rights ahead of an upgrade, so the missing zero-check is by design. The `mint` path (`if (msg.sender != minter) revert NotMinter(msg.sender);`) plus the fact that `tx.origin` from `address(0)` cannot occur means a zero minter is harmless.
- **Action**: none. Optional improvement: explicitly emit a `MinterDisabled` event when zero is set; deferred to a follow-up if the operations team wants the clearer signal.

## Findings — non-actionable, kept for the record

### F-5: `RestorationActivityCheckerV2.evidenceHashes` "uninitialized state"

- **Detector**: `uninitialized-state` (informational; Slither classifies as "important" but it is a false positive here)
- **Location**: `src/staking/RestorationActivityCheckerV2.sol#88`
- **Slither summary**: a `mapping(address => bytes32[])` is declared but never written in the constructor.
- **Triage — false positive**: this is a `mapping` of dynamic arrays. Default state is "every key returns an empty array". The contract reads these arrays through `_writeEvidenceHash` (which `push`es) and `_computeNoveltyWeight` (which iterates with bounds), both of which handle the `len == 0` case correctly. There is no path where the contract reads an uninitialised value as if it were already-set data.
- **Action**: none.

### F-6: `JinnRouterV2._proxyReserved0` / `_proxyReserved1` "unused state, should be constant"

- **Detector**: `unused-state`, `constable-states` (informational)
- **Location**: `src/staking/JinnRouterV2.sol#87, #89`
- **Slither summary**: two private storage variables are declared but never read or written from within the contract.
- **Triage — accepted (proxy slot reservation is intentional)**: the contract is deployed behind an upgradeable proxy and slots 0–1 carry the proxy's `implementation` and `owner` addresses. The reserved variables are placeholders to keep the storage layout aligned. Marking them `constant` would unbind them from a storage slot, which would shift every other variable down two slots — exactly the storage-layout corruption we're guarding against. The detector cannot see the proxy contract whose layout this is paired with.
- **Action**: none. Comment block above the slots already explains the constraint; the threat model also flags the slot-13 caveat for `creators`.

### F-7: `JINN.CLOCK_MODE()` not in mixedCase

- **Detector**: `naming-convention` (informational)
- **Location**: `src/jinn/token/JINN.sol#83-85`
- **Slither summary**: function name uses ALL_CAPS.
- **Triage — accepted (ERC-5805 / ERC-6372 conformance)**: the function name is mandated by ERC-6372. Renaming would make the contract non-conformant. The same naming-convention findings appear (and are accepted) in OZ's `Votes.CLOCK_MODE`, `IERC6372.CLOCK_MODE`, `IERC20Permit.DOMAIN_SEPARATOR`, etc.
- **Action**: none.

### F-8: Legacy `CanonicalOpStackMessenger` redundant statement finding

- **Detector**: `redundant-statements` (informational)
- **Location**: superseded by the storage-proof rewrite.
- **Slither summary**: the previous receipt-proof placeholder contained a bare `logIndex;` no-op.
- **Triage — closed by design change**: the canonical messenger no longer verifies receipt/log inclusion. It verifies the stored `claimSnapshotHashes[claimId]` slot, so the unused `logIndex` placeholder and receipt-MPT path were removed.
- **Action**: none.

### Filtered out as `informational`

The `--filter-paths node_modules` filter removed a large volume of OZ-internal findings (solc-version pragma ranges, naming-convention on inherited functions, too-many-digits in `Bytes.sol` and `Math.log2`). Findings on parameter naming with leading-underscore (`_wCreation`, `_jinnRouter`, etc.) are accepted as repository convention — these mirror constructor-shadowing avoidance and are consistent with the rest of the OLAS-derived contracts in this repo.

## Summary

The v0 audit surface contains **no high- or medium-severity Slither findings**. All low-severity findings are accepted as documented design (CEI ordering for distributor, post-call sequencing where the request id is the marketplace's return value, intentional zero-address sentinel for disabled minter, intentional informational-only function-naming for ERC-6372 / proxy slot reservation).

The next-phase invariant work (under follow-up to bd `jinn-mono-sz0`) should focus on dynamic properties Slither cannot see — accumulator monotonicity, mint-equals-delta, statelessness of `verifyClaim`, and post-rewrite dispute-game finality/storage-proof behavior. The Foundry stubs added in this commit are wired and ready for that authoring pass.
