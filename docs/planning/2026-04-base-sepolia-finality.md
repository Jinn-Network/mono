# Base Sepolia → Sepolia L2→L1 Finality Measurement (R-1)

- **Date:** 2026-04-27
- **Branch:** `r-1-finality-research` (off `jinn-mono/jinn-mono-1bo`)
- **Related:** [`2026-04-jinn-cross-chain.md`](./2026-04-jinn-cross-chain.md) §"Open research items" → R-1
- **Author:** automation (read-only research, no transactions submitted)

## TL;DR

Base Sepolia's L2→L1 canonical finality window is **~7 days from
dispute-game creation** (plus a few minutes of L2-inclusion → L1
game-creation lag). Sepolia's `OptimismPortal2` airgap
(`proofMaturityDelaySeconds`) is **0** on testnet, so the entire
delay is in the dispute game itself.

This is *too long* for tight CI iteration. **Recommendation: use
`MockMessenger` as the active messenger for `r5z` burn-in**, and run
exactly one canonical-mode validation transaction end-to-end as a
proof-of-life. A 7-day round-trip is acceptable for staged QA but
not for any iterative loop where you need to land repeated test
intents.

## Methodology

Base Sepolia underwent a dispute-game-type migration on
**~2026-04-13/14** (factory game-index ~15110 → ~15140) from the
standard OP-Stack `FaultDisputeGame` (CANNON, gameType=0) to a new
**`AggregateVerifier`** (gameType=621) using a TEE+ZK multiproof
system from `op-enclave` ("Pessimism" / Base's enclave-and-ZK
aggregate verifier). All Base Sepolia games created from
~2026-04-14 onward use this game type, and `respectedGameType` on
Sepolia OptimismPortal2 = 621.

I sampled:

- **5 resolved AggregateVerifier games** (factory indices 15140,
  15145, 15155, 15165, 15175, 15250) — all `DEFENDER_WINS`,
  proofCount=1 (TEE only, no ZK challenge).
- **2 unresolved-but-pending AggregateVerifier games** (factory
  indices 15500, 15850) — both `IN_PROGRESS`, on the 7-day timer.
- **1 resolved legacy CANNON game** (factory index 15100, last
  era of gameType=0) for historical comparison.
- **OptimismPortal2 view methods** for airgap parameters.

Method: read on-chain state via Blockscout (Sepolia chain_id
`11155111`, Base Sepolia chain_id `84532`) — no transactions
submitted.

### Sepolia bridge contracts for Base Sepolia (verified)

| Contract | Address |
|---|---|
| `OptimismPortal2` (proxy) | `0x49f53e41452C74589E85cA1677426Ba426459e85` |
| `DisputeGameFactory` (proxy) | `0xd6E6dBf4F7EA0ac412fD8b65ED297e64BB7a06E1` |
| `AggregateVerifier` impl (gameType 621) | `0xF3f0fA3124b7b0feB048A00404Fe4D5D49E60796` |
| Anchor State Registry | `0x2fF5cC82dBf333Ea30D8ee462178ab1707315355` |
| TEE verifier | `0x92F6dD3501E51B8b20C77b959becaaebeB210e17` |
| ZK verifier | `0xF9780104117C0FaD3A9b1386FbF40a9F5857988A` |

### OptimismPortal2 settings (Sepolia, current)

| Param | Value |
|---|---|
| `proofMaturityDelaySeconds()` | **0** (testnet — no airgap after game resolution) |
| `disputeGameFinalityDelaySeconds()` | **0** |
| `respectedGameType()` | **621** (AggregateVerifier) |

### AggregateVerifier (gameType 621) constants

From the verified source at `0xF3f0fA3124b7b0feB048A00404Fe4D5D49E60796`:

| Param | Value | Meaning |
|---|---|---|
| `SLOW_FINALIZATION_DELAY` | **7 days** | timer when only 1 proof submitted |
| `FAST_FINALIZATION_DELAY` | **1 day** | timer when both TEE + ZK proofs submitted |
| `BLOCK_INTERVAL` | 600 | L2 blocks per proposal (~20 min @ 2s) |
| `INTERMEDIATE_BLOCK_INTERVAL` | 30 | sub-proposal granularity |
| `proofThreshold` | 1 | min proofs to resolve |
| `l2ChainId` | 84532 | Base Sepolia |

The dispute timer is set on initialization to `expectedResolution
= type(uint64).max`, then reduced when a proof is verified. With
one proof present, `expectedResolution = createdAt + 7 days`. With
two proofs, it drops to `createdAt + 1 day`.

## Findings — sampled games

All times in Unix seconds; all status=2 means `DEFENDER_WINS`. All
sampled AggregateVerifier games have `proofCount = 1` (only the
TEE proof was provided — no ZK proof has been observed in any
sample, suggesting the fast path is not being exercised in
practice).

| Game # | Proxy | createdAt | resolvedAt | resolved-created | days | status | proofCount |
|---|---|---|---|---|---|---|---|
| 15140 | 0x1C0b37B8…7a0f0 | 1776416280 | 1777021092 | 604812 | 7.0001 | 2 | 1 |
| 15145 | 0xDF227D53…dfdad | 1776422268 | 1777027092 | 604824 | 7.0003 | 2 | 1 |
| 15155 | 0xe680398a…3969b | 1776434256 | 1777039080 | 604824 | 7.0003 | 2 | 1 |
| 15165 | 0x32740a19…60330 | 1776446244 | 1777051080 | 604836 | 7.0004 | 2 | 1 |
| 15175 | 0x00e33Ab8…EED03 | 1776458280 | 1777063092 | 604812 | 7.0001 | 2 | 1 |
| 15250 | 0x38EC20E3…7D1A | 1776548496 | 1777153416 | 604920 | 7.0014 | 2 | 1 |
| 15500 | 0x09c34685…dB788 | 1776848364 | (pending) | (proj. 7.0d) | — | 0 | 1 |
| 15850 | 0x568770c1…86EeE | 1777268436 | (pending) | (proj. 7.0d) | — | 0 | 1 |

Legacy CANNON (gameType=0) for comparison:

| Game # | Proxy | createdAt | resolvedAt | days | maxClockDuration |
|---|---|---|---|---|---|
| 15100 | 0x9A140526…BCee8 | 1776350292 | 1776652764 | 3.5005 | 302400 (3.5d) |

L2-inclusion → L1-game-creation lag (sample game 15140):

- L2 block claimed: 40323863, L2 timestamp 2026-04-17 08:53:34 UTC
- L1 game created: 2026-04-17 08:58:00 UTC (factory tx
  `0xc536abce…1fab9` at L1 block 10676848)
- Lag: **~4.5 minutes**

This is consistent with Base Sepolia's normal proposer cadence
(games posted every ~20 minutes per `BLOCK_INTERVAL=600`).

## Distribution

- **Median** game-creation → game-resolved: **~7.0003 days** (n=6
  resolved games).
- **Min:** 7.0001 days.
- **Max:** 7.0014 days.
- **Variance:** trivial (<2 minutes across samples). The
  `resolvedAt` jitter is just the lag between
  `block.timestamp >= expectedResolution` and someone calling
  `resolve()` permissionlessly — typically seconds to a couple of
  minutes.

Sub-components per sample:

- **L2 inclusion → L1 game creation:** ~4-15 minutes (proposer
  cadence + L1 inclusion).
- **L1 game creation → resolution:** **7 days exactly** in the
  observed slow-path (single TEE proof) regime.
- **Resolution → finalized for withdrawal:** **0 seconds** —
  Sepolia's `proofMaturityDelaySeconds` is zero; once `resolvedAt`
  is set with `DEFENDER_WINS`, OptimismPortal2 considers the
  output proven and finalized immediately for proof-maturity
  purposes.

**Total Base-Sepolia → Sepolia canonical finality:** ~**7 days +
~5 minutes** from L2 block inclusion to L1-finalized state, in the
current operating regime.

The 1-day fast path (when both a TEE *and* a ZK proof are
provided) is **not currently being exercised** on Base Sepolia —
none of the sampled games have proofCount > 1. So in practice the
canonical finality is locked at the slow-path 7-day floor.

## Practical conclusion

Per the threshold table in the task:

- median < 1h → canonical mode is fine for `r5z`. ❌
- median 1-12h → canonical works for slow-iteration burn-in. ❌
- **median > 12h → MockMessenger should be the active messenger
  during burn-in; canonical gets one validation tx as
  proof-of-life and we move on. ✅**

A 7-day round-trip is incompatible with iterative testnet
operation. Even a single end-to-end debug cycle (build → submit
on Base → wait for game creation → wait 7d → finalize on
Sepolia) is a full week, which is fine as a one-shot smoke test
but unworkable as a feedback loop.

## Recommendation for `r5z`

1. **Default `jinnMessengerMode` to `mock` for `r5z` burn-in.**
   Operators run `MockMessenger` on Sepolia, daemon submits proofs
   without waiting for canonical finality. This unblocks the
   creation/restoration/eval/knowledge loop end-to-end on testnet
   in minutes, not weeks.
2. **Wire one canonical validation transaction** as part of `r5z`
   acceptance — daemon submits a real claim on Base Sepolia,
   waits the ~7 days, then proves it on Sepolia via
   `CanonicalOpStackMessenger`. This is run *once per release* (or
   once per significant messenger-code change), not per burn-in
   iteration.
3. **Track the AggregateVerifier (gameType 621) compatibility
   carefully.** This is *not* the standard OP-Stack
   `FaultDisputeGame` — it's a TEE+ZK multiproof system from
   `op-enclave` that Base deployed on Sepolia in mid-April 2026.
   `viem`'s `op-stack` extension may not have native support for
   it; `CanonicalOpStackMessenger.verifyClaim` should treat the
   game opaquely (read `gameType`, `wasRespectedGameTypeWhenCreated`,
   `status`, `resolvedAt`, `l2SequenceNumber`, `rootClaim`) and
   not assume CANNON-style proof shapes. See R-2.
4. **Fast-path optimism**: if Base eventually starts producing
   2-proof games on Sepolia, finality drops to **~1 day**. Worth
   monitoring `proofCount` on a sample of recent games before each
   `r5z` cut — if 2-proof games become the norm, canonical mode
   becomes plausible for slow-iteration burn-in (1 day per loop
   is tolerable for staged QA).

## Unexpected findings

- **AggregateVerifier (gameType=621) is the active dispute game on
  Base Sepolia.** This is a *new* arrangement (live since mid-April
  2026) — not the CANNON `FaultDisputeGame` the cross-chain spec's
  pseudocode assumes. `CanonicalOpStackMessenger` must therefore
  read game state via the `IDisputeGame` interface only and avoid
  any CANNON-specific selectors (e.g. `maxClockDuration`,
  `l2BlockNumber` revert on these proxies — use
  `l2SequenceNumber()` instead).
- **Both airgaps are zero on testnet.** `proofMaturityDelaySeconds`
  and `disputeGameFinalityDelaySeconds` on Sepolia
  `OptimismPortal2` are both `0`. The full canonical finality
  delay lives entirely in the dispute game timer. This is good
  for us — it means the messenger only has to verify the game
  itself and doesn't need to enforce a separate post-resolution
  wait.
- **Slow path is the de-facto path.** No sampled game has both
  TEE and ZK proofs. `proofThreshold=1` allows a single proof to
  resolve the game, but the timer is `SLOW_FINALIZATION_DELAY`
  (7d) until a second proof is added. Operationally this means
  Base Sepolia's effective finality is 7 days, not the 1-day fast
  path the design admits.
- **Dispute-game type changed mid-April 2026.** Any historical
  finality measurements taken before ~2026-04-13 reflect the
  legacy 3.5-day CANNON regime, not today's 7-day AggregateVerifier
  regime. Watch for the type to change again — mainnet Base will
  eventually adopt this pattern, and the spec text should treat
  `respectedGameType` as a runtime read, not a constant.

## Captain-relevant for next phase

- **Spec update needed in `2026-04-jinn-cross-chain.md`:** the
  pseudocode for `CanonicalOpStackMessenger.verifyClaim` (lines
  ~175-220 of the spec) currently references CANNON-style game
  fields. Update to use the IDisputeGame-only interface
  (`gameType`, `wasRespectedGameTypeWhenCreated`, `status`,
  `resolvedAt`, `l2SequenceNumber`, `rootClaim`) and confirm via
  `respectedGameType` on the portal.
- **Lock R-1 status** in the spec's "Open research items" → R-1
  → resolved (this doc).
- **R-2 (viem op-stack coverage) becomes higher priority** —
  viem's `getProof` / `buildProveWithdrawal` likely don't know
  about gameType=621 / AggregateVerifier yet, since this is a
  Base-specific deployment. The proof-of-life canonical
  validation tx should explicitly verify what `viem` returns for
  these games before declaring the canonical path ready.
- **Operator UX message:** for `r5z` quickstart docs, document
  that "canonical proofs take ~7 days on testnet" — set
  expectations early so users don't think the daemon is hung.

## Appendix — reproduction

Sepolia chain_id = `11155111`, Base Sepolia chain_id = `84532`.

```bash
# Total games registered for Base Sepolia
cast call 0xd6E6dBf4F7EA0ac412fD8b65ED297e64BB7a06E1 'gameCount()(uint256)' \
  --rpc-url https://sepolia.drpc.org

# Active game type
cast call 0x49f53e41452C74589E85cA1677426Ba426459e85 \
  'respectedGameType()(uint32)' --rpc-url https://sepolia.drpc.org

# Airgap parameters
cast call 0x49f53e41452C74589E85cA1677426Ba426459e85 \
  'proofMaturityDelaySeconds()(uint256)' --rpc-url https://sepolia.drpc.org
cast call 0x49f53e41452C74589E85cA1677426Ba426459e85 \
  'disputeGameFinalityDelaySeconds()(uint256)' --rpc-url https://sepolia.drpc.org

# Sample a game
cast call 0xd6E6dBf4F7EA0ac412fD8b65ED297e64BB7a06E1 \
  'gameAtIndex(uint256)(uint32,uint64,address)' 15140 \
  --rpc-url https://sepolia.drpc.org

# Read game state (substitute proxy address from above)
cast call <proxy> 'createdAt()(uint64)' --rpc-url https://sepolia.drpc.org
cast call <proxy> 'resolvedAt()(uint64)' --rpc-url https://sepolia.drpc.org
cast call <proxy> 'status()(uint8)' --rpc-url https://sepolia.drpc.org
cast call <proxy> 'proofCount()(uint8)' --rpc-url https://sepolia.drpc.org
cast call <proxy> 'l2SequenceNumber()(uint256)' --rpc-url https://sepolia.drpc.org
cast call <proxy> 'wasRespectedGameTypeWhenCreated()(bool)' --rpc-url https://sepolia.drpc.org
cast call <proxy> 'expectedResolution()(uint64)' --rpc-url https://sepolia.drpc.org
```

Public Sepolia RPC alternatives: `https://sepolia.drpc.org`,
`https://ethereum-sepolia-rpc.publicnode.com`,
`https://eth-sepolia.public.blastapi.io`. Base Sepolia public RPC:
`https://sepolia.base.org`. All reads in this doc were performed
via Blockscout's Sepolia and Base Sepolia instances.

Source contracts:
- AggregateVerifier (verified): https://eth-sepolia.blockscout.com/address/0xF3f0fA3124b7b0feB048A00404Fe4D5D49E60796?tab=contract
- DisputeGameFactory: https://eth-sepolia.blockscout.com/address/0xd6E6dBf4F7EA0ac412fD8b65ED297e64BB7a06E1
- OptimismPortal2: https://eth-sepolia.blockscout.com/address/0x49f53e41452C74589E85cA1677426Ba426459e85
- Reference (Base bridge addresses): https://docs.base.org/base-chain/network-information/base-contracts
- AggregateVerifier source upstream: https://github.com/base/op-enclave (lib/contracts/src/multiproof/AggregateVerifier.sol)
