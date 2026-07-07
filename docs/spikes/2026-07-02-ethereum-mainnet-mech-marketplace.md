# Spike: Ethereum-mainnet Mech Marketplace availability

- **Date:** 2026-07-02
- **Issue:** [#1317](https://github.com/Jinn-Network/mono/issues/1317)
- **Shape:** `spike` — finding note, no code
- **Gates:** only the v1b OLAS-native keeper dogfood experiment (`spec/2026-07-02-jinn-harness-network.md` §6.2 v1b, §12)

## Question

Is the OLAS Mech Marketplace live on Ethereum mainnet? Ours runs on Base
(MechMarketplaceProxy [`0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020`](https://basescan.org/address/0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020)).
If yes: sketch the recurring epoch-execution job (the v1b keeper). If no: the
Chainlink Automation backstop stands per spec §6.2 v1b.

## Verdict

**YES — deployed and live, but unused.** The full Mech Marketplace v1.1.0 stack
exists on Ethereum mainnet (chain id 1), deployed 2026-02-10 by the Autonolas
deployer, source-verified on Etherscan. However it has **zero registered mechs
and zero requests** — the deployment is infrastructure without supply. The v1b
gate ("verify the Mech Marketplace exists on Ethereum mainnet") **passes**; the
dogfood experiment can proceed. The zero-supply nuance shapes the
recommendation below — it does not change any spec decision.

## Verified addresses (Ethereum mainnet, chain id 1)

Source of truth: [`docs/configuration.json` in valory-xyz/autonolas-marketplace](https://github.com/valory-xyz/autonolas-marketplace/blob/c33a67ce43d21901160d97576bf1c23a6f5edd56/docs/configuration.json)
(pinned to commit `c33a67c`; the repo is the successor to `ai-registry-mech` —
the old URL redirects). Every address below was independently confirmed to have
deployed bytecode via read-only `eth_getCode` against
`https://ethereum-rpc.publicnode.com` on 2026-07-02.

| Contract | Address | Bytecode present |
|---|---|---|
| MechMarketplaceProxy | [`0x3d6494CE09a9f40c0B5a92BdBD7c7A9b0e3912b1`](https://etherscan.io/address/0x3d6494CE09a9f40c0B5a92BdBD7c7A9b0e3912b1) | yes (proxy, ~0.3 KB) |
| MechMarketplace (impl) | [`0x6B149a00E40cC6C148992C6AADd232d958C35Fa3`](https://etherscan.io/address/0x6B149a00E40cC6C148992C6AADd232d958C35Fa3) | yes (~17.9 KB) |
| KarmaProxy | [`0xf0B1Fc3A3D412Ea73136925B831D6203De310650`](https://etherscan.io/address/0xf0B1Fc3A3D412Ea73136925B831D6203De310650) | yes |
| Karma (impl) | [`0xB01B4154047e51F01b22017079367341ea73d744`](https://etherscan.io/address/0xB01B4154047e51F01b22017079367341ea73d744) | yes |
| MechFactoryFixedPriceNative | [`0x3515a36AF270070635Fa3E957e006aaF6078e658`](https://etherscan.io/address/0x3515a36AF270070635Fa3E957e006aaF6078e658) | yes |
| BalanceTrackerFixedPriceNative | [`0x528befb0F8c6a988C9F42345DA6d053d66b3B9B6`](https://etherscan.io/address/0x528befb0F8c6a988C9F42345DA6d053d66b3B9B6) | yes |

The config also lists USDC/OLAS fixed-price token factories and balance
trackers on mainnet (see the pinned `configuration.json`).

## Liveness evidence (read-only view calls, 2026-07-02)

Against the MechMarketplaceProxy `0x3d64…12b1` via
`https://ethereum-rpc.publicnode.com`:

| Call | Ethereum mainnet | Base (`0xf24e…5020`), same day |
|---|---|---|
| `VERSION()` | `"1.1.0"` | `"1.1.0"` |
| `fee()` | `1500` | `1500` |
| `numMechs()` | **`0`** | — |
| `numTotalRequests()` | **`0`** | `24763` |

Reproduce with e.g.
`cast call 0x3d6494CE09a9f40c0B5a92BdBD7c7A9b0e3912b1 "numMechs()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com`.

Deployment provenance (Etherscan, proxy page): created 2026-02-10 16:12:47 UTC
by Autonolas: Deployer
([`0xeb2a…914e`](https://etherscan.io/address/0xeb2a22b27c7ad5eee424fd90b376c745e60f914e)),
creation tx
[`0x8cff2fc8e1a6cfc3d462117d022f3af912d5e76f501b6beb8421114b23c7400c`](https://etherscan.io/tx/0x8cff2fc8e1a6cfc3d462117d022f3af912d5e76f501b6beb8421114b23c7400c).
The proxy has processed only 3 transactions since deployment (setup + a
`changeOwner` on 2026-05-21) — consistent with zero mechs / zero requests.
Current owner: `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` (readable via
`owner()`).

## Consequent v1b keeper recommendation

The gate passes, so the OLAS-native mech job is buildable. Sketch of the
recurring epoch-execution job:

1. **Register a mainnet mech.** One Jinn-operated service on the L1 OLAS
   registries, with a mech created through the marketplace via
   `MechFactoryFixedPriceNative` (native-ETH pricing keeps it simplest — no L1
   OLAS handling in the hot path).
2. **One request per epoch.** At epoch close on Base, our Base-side scheduler
   (or anyone — the request is permissionless) posts a marketplace request on
   L1: payload = "execute epoch N", with a small native fee escrowed in
   `BalanceTrackerFixedPriceNative`.
3. **Deliver = execute.** The mech agent watches for the request, calls the
   proof-carrying permissionless L1 epoch function (spec §6.2 v1b — anyone can
   submit the proven result), and delivers the tx hash as evidence.
   First-delivery-wins means any additional mech that ever registers adds free
   redundancy; Karma tracks delivery reliability.
4. **Cadence and cost.** One L1 tx per epoch — liveness engineering, not gas
   engineering, exactly as the spec frames it.

**Caveat that shapes sequencing, not the decision:** with `numMechs() == 0`,
there is no third-party mech supply on mainnet today. Until other mechs
register, the mech job is our own executor wearing a marketplace harness — it
adds an incentive rail and public accounting, but no independent liveness. So:

- **Chainlink Automation backstop stands** as v1b insurance, per spec §6.2 v1b.
  The spec already frames the mech job as a dogfood experiment that "may
  replace the Chainlink backstop if it proves out" — this finding confirms the
  experiment is possible and changes nothing in the spec.
- Run the mech job as the dogfood experiment alongside (primary = own executor,
  backstop = Chainlink, experiment = mech job). Promote the mech job to
  backstop only after it demonstrates deliveries from at least one mech we do
  not operate, or after sustained solo reliability.

## What this does not prove

- That any third party will register a mainnet mech (zero have in ~5 months).
- L1 gas economics of the mech request/deliver flow versus a bare Chainlink
  upkeep — measure during the dogfood experiment.
- That the mainnet deployment will be maintained by Valory long-term; its
  proxy-upgradeable ownership sits with `0x3C1f…95fE`, not with us.
