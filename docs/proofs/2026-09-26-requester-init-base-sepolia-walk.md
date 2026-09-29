# Live Base Sepolia walk — `jinn requester init` (issue #2446 criterion 6)

**Date:** 2026-09-26
**Network:** Base Sepolia (84532)
**Scratch `HOME`:** empty directory (no pre-existing `~/.jinn-operator` or `~/.jinn-client`)

This is the walk PR #4122 deferred and follow-up #4741 described: beats 2–4 of
[`2026-08-05-user-journeys-design.md`](../superpowers/specs/2026-08-05-user-journeys-design.md)
§4.2 from a genuine first-touch home, against live faucet and live gas, not a
fork.

## First-touch (after the funding-visibility fix)

One invocation, one process, from empty `$HOME`:

```text
JINN_PASSWORD=<passphrase> jinn requester init --json
```

| Check | Result |
|---|---|
| Wall clock | **50.76 s** (budget 4:30) |
| Exit | 0 |
| Master | `0xa46007647d82FF788cF3DDb0D20E8D69f2c22442` |
| Creator Safe | `0x211501Ea89F4A4164af642cd3e3ce4AE48E56812` |
| Safe bytecode | 171 bytes at that address on Base Sepolia |
| Deploy tx | [`0xbef2964a8d5d66bc5013683e76ef069a6a4c0fab8ee57b8ceff06058d6888627`](https://sepolia.basescan.org/tx/0xbef2964a8d5d66bc5013683e76ef069a6a4c0fab8ee57b8ceff06058d6888627) |
| `requester_stage` | `safe_deployed` |
| `fleet_stage` | `none` |
| `services` | `[]` (no OLAS service, no stake, no mech) |
| Faucet | CDP drip loop started from 0 ETH toward `requesterMinMasterEth()` (0.0015 ETH) and exited on target before the 50-drip / 300 s cap |
| `jinn fund-requirements --requester` | `persona: requester`, `satisfied: true`, empty requirements |
| Second `jinn requester init` | same Safe, 2.7 s, no faucet, no re-deploy |

The first-touch command did not print `jinn run` or the operator 0.02 ETH
bootstrap target. Next-step in the success payload is `jinn tasks submit`.

## Defect the walk found (and the fix this change lands)

A prior scratch-home run on the unfixed tree failed in **42 s** after the
faucet and the master → agent transfer: the Safe factory call reverted with
`gas required exceeds allowance (0)` on the agent EOA
(`0xC425F682dfD279c85cA50e0BAcfaF53c3280cfdf`) even though the funding
transaction receipt had already returned. Seconds later the same agent held
the full `REQUESTER_SAFE_DEPLOY_ETH` (0.001 ETH) on `eth_getBalance`. A retry
then deployed
[`0xf813E8C21B5c9803AE6aC9239A0B1F865916da4D`](https://sepolia.basescan.org/address/0xf813E8C21B5c9803AE6aC9239A0B1F865916da4D)
in 10.8 s.

That is the fallback-RPC race `waitForContractCode` already covered after
deploy: a receipt on one slot is not a balance on the slot that
`eth_fillTransaction` uses next. `stepFleetSafeDeploy` now waits for
`getBalance >= agentFundingWei` before the factory call. The first-touch row
above is that path on a new wallet.

## What this does not prove

- Exact CDP drip count (the loop does not emit a final drip tally; elapsed
  time and the 50-drip cap bound it).
- Beats 5+ (spec interview, post, consume). Those are other B0 items.
- Mainnet.
- That every public Base Sepolia RPC slot is consistent; the wait is the
  fence, not a guarantee that a later send cannot still race a worse split.
