# Azul Storage Proof Tooling Spike

Date: 2026-04-28  
Status: R-2 resolved

## Summary

The current client stack can support the Azul-compatible canonical
canary, but not by using a single off-the-shelf viem action.

`viem/op-stack` exposes Base Sepolia dispute games through
`getGames`, and core viem exposes `eth_getProof` through
`getProof`. Those primitives are enough to build the proof shape
required by `CanonicalOpStackMessenger`, with a small custom builder
in the daemon.

## Live Test

Run:

```bash
cd client
JINN_LIVE_RPC_TESTS=1 yarn test test/live/azul-storage-proof.live.test.ts
```

Optional environment:

```bash
JINN_L1_RPC_URL=<sepolia-rpc>          # or SEPOLIA_RPC_URL
JINN_L2_PROOF_RPC_URL=<base-sepolia-proof-rpc>
JINN_L2_RPC_URL=<base-sepolia-rpc>     # fallback, or BASE_SEPOLIA_RPC_URL
```

The live test is skipped by default and checks:

- RPC/tooling readiness only. It is not the production canonical
  proof builder and does not submit claims.
- OptimismPortal2 configuration on Sepolia.
- Latest Base Sepolia dispute game from viem.
- Direct factory/proxy agreement through `gameAtIndex(index)`.
- Generic dispute-game selectors used by `CanonicalOpStackMessenger`.
- Account/storage proof construction at the sampled dispute game's
  historical L2 block.

Observed on 2026-04-28:

- `respectedGameType = 621`.
- `proofMaturityDelaySeconds = 0`.
- `disputeGameFinalityDelaySeconds = 0`.
- Latest game proxy exposed `gameType()`, `status()`,
  `resolvedAt()`, `rootClaim()`,
  `wasRespectedGameTypeWhenCreated()`, `l2SequenceNumber()`, and
  `proofCount()`.
- The proxy `rootClaim` matched viem's returned `rootClaim`.
- `eth_getProof` worked at latest Base Sepolia head.
- `eth_getProof` against the older game block failed on the public
  Base Sepolia RPC with "no backend is currently healthy to serve
  traffic".
- Retest with the main worktree Tenderly Base Sepolia RPC from
  `cargo/client/.env` showed the inverse behavior: latest-head
  `eth_getProof` failed routing, but the game-block historical
  `eth_getProof` succeeded. The game-block proof is the relevant
  canary dependency.
- A later retest on the same endpoint succeeded for the older sampled
  game block but failed for the newest sampled game block. Treat this
  endpoint as useful for development, not as a guaranteed production
  proof RPC.

## Tooling Decision

Use viem for primitives, but implement our own canonical builder:

1. Read `ClaimTicket` on Base Sepolia and capture `claimId`,
   `serviceId`, counters, `multisig`, transaction block, and emitter
   address.
2. Use `getGames(l1, { targetChain: baseSepolia })` to find the
   first output game whose `l2BlockNumber` is greater than or equal to
   the claim transaction block.
3. Read `DisputeGameFactory.gameAtIndex(game.index)` because
   `getGames` does not return the game proxy address.
4. Poll the game until the same readiness checks enforced on-chain can
   pass: factory/proxy game type agreement,
   `wasRespectedGameTypeWhenCreated()`, `status() == DEFENDER_WINS`,
   and portal maturity/finality delays.
5. Build `OutputRootProof` from the L2 block at
   `game.l2BlockNumber`:
   - `version = bytes32(0)`.
   - `stateRoot = block.stateRoot`.
   - `latestBlockhash = block.hash`.
   - `messagePasserStorageRoot = getProof(L2ToL1MessagePasser,
     [], blockNumber).storageHash`.
6. Build the emitter storage proof at the same L2 block:
   - storage slot =
     `keccak256(abi.encode(claimId, CLAIM_SNAPSHOT_HASHES_SLOT))`.
   - account proof = `getProof(emitter, [slot], blockNumber).accountProof`.
   - storage proof = `getProof(...).storageProof[0].proof`.
7. ABI-encode the canonical proof tuple expected by
   `CanonicalOpStackMessenger.verifyClaim`.
8. Submit only as a verifier-only `eth_call` during burn-in; do not
   swap `JinnDistributor.messenger` away from MockMessenger.

The claim snapshot is still valid at a later output block because
`claimSnapshotHashes[claimId]` is append-only. The proof block does
not need to be the exact transaction block; it needs to be an output
game block after the snapshot was stored.

## Gaps

- Historical `eth_getProof` requires an archive-capable or otherwise
  reliable Base Sepolia RPC. The public Base Sepolia endpoint was not
  reliable enough for the game-block proof probe; the main worktree
  Tenderly Base Sepolia RPC served one sampled game-block proof but
  failed another. The canary needs explicit proof-RPC monitoring or a
  stronger archive provider before it becomes a release gate.
- viem's built-in OP withdrawal actions are not a drop-in fit because
  they build proofs around withdrawal hashes, not arbitrary emitter
  storage slots.
- The durable daemon package still needs persistence and retry logic:
  event discovery, game selection, readiness polling, proof build,
  local proof caching, and `eth_call` canary submission.

## Impact

R-2 no longer blocks the Azul-compatible spec/contracts baseline.
It becomes implementation guidance for the next canonical daemon
package. MockMessenger remains the active fast burn-in path, while the
canonical builder is developed as a verifier-only canary.

## Operator script — verifier-only canonical canary

After dispute-game finality, operators can prove end-to-end messenger compatibility without swapping `JinnDistributor.messenger`:

```bash
cd client
export JINN_L2_TX_HASH=0x…           # tx that emitted ClaimTicket on Base Sepolia
export JINN_CLAIM_EMITTER=0x…        # JinnClaimEmitter (L2)
export JINN_CANONICAL_MESSENGER=0x…   # CanonicalOpStackMessenger (Sepolia)
# Strongly recommended for historical eth_getProof at the dispute-game block:
export JINN_L2_PROOF_RPC_URL=https://…
tsx scripts/verify-canonical-canary.ts
```

On success, stdout is JSON including `messengerVerifyClaim` tuple fields. Errors redact RPC URLs; failures often mean archive routing — retry `JINN_L2_PROOF_RPC_URL` (see gaps above).

Automated daemon ticks **skip** `messengerMode=canonical` (multi-day OP finality); use `jinnMessengerMode=mock` for scheduled burn-in per cross-chain spec / R-1.
