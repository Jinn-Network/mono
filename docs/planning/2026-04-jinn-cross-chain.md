# Jinn v0 Cross-Chain Spec — JinnClaimEmitter + IClaimMessenger + CanonicalOpStackMessenger + MockMessenger

> Status: **Locked 2026-04-28**
> Date: 2026-04-28
> Branch: land via PR from Azul-compatible cross-chain work (fork/worktrees vary; treat Git history as source of truth)
> Phase A2 of the Jinn v0 MVI implementation plan
> bd task: `jinn-mono-l6b`
> Reference: `docs/planning/2026-04-jinn-mvi-on-olas.md` (proposal, on `main`) +
> `docs/planning/2026-04-olas-staking-reward-semantics.md` (A0 v3, this branch) +
> `docs/security/2026-04-v2-checker-audit.md` (V2 audit, this branch)

## Context

The v0 architecture (proposal §9) ships JINN token + governance on
Ethereum (Sepolia for testnet) with measurement on Base (Base
Sepolia for testnet). JINN minting therefore needs a cross-chain
flow: an event on Base proves real protocol work, and a
verification on Ethereum mints JINN against it.

This spec locks the contract interfaces, event shapes, and proof
mechanics for that flow under the architectural decisions from A0
(Architecture B with ε creation gating; B-multi for per-channel
weights on the distributor; eval creations dropped; C4/C1 audit
fixes bundled into v0 testnet).

## Architectural overview (recap)

**Three counters drive JINN minting**, all monotonic, all sourced
from the V2 activity checker (extended per `pwg`) on Base:

- `checker.verifiedCreations(multisig)` — restoration creation
  credit. Incremented (per ε) only when the creator's intent gets
  a delivery that passes Hamming. Lives on the V2 checker after
  `pwg` extension.
- `checker.noveltyWeightedCounts(multisig)` — restoration delivery
  credit, novelty-weighted. Lives on the V2 checker today.
- `router.evaluationDeliveryCount(multisig)` — eval delivery
  credit, ungated (per Q1.5; deterministic evals). Lives on the
  V2 router as public state.

JinnClaimEmitter on Base reads all three (across two contracts —
checker for the first two, router for the third), emits a
ClaimTicket event with the snapshot. CanonicalOpStackMessenger on
Ethereum validates the event via canonical OP-Stack proof, recovers
the values, hands them to JinnDistributor for minting.

## Event: `ClaimTicket`

Emitted by `JinnClaimEmitter` on Base / Base Sepolia. Carries
everything the Ethereum-side distributor needs.

```solidity
event ClaimTicket(
    uint256 indexed claimId,
    uint256 indexed serviceId,
    uint256 verifiedCreations,
    uint256 noveltyWeightedRestorationDeliveries,
    uint256 evaluationDeliveryCount,
    address indexed multisig,
    address claimer
);
```

Fields:
- `claimId` — monotonically increasing snapshot id assigned by
  `JinnClaimEmitter`; used as the canonical proof identity and as
  the `MockMessenger` fixture key.
- `serviceId` — OLAS service id; indexed for log filtering.
- `verifiedCreations` — current value of
  `checker.verifiedCreations(multisig)` at emit time.
- `noveltyWeightedRestorationDeliveries` — current value of
  `checker.noveltyWeightedCounts(multisig)` at emit time.
- `evaluationDeliveryCount` — current value of
  `router.evaluationDeliveryCount(multisig)` at emit time.
- `multisig` — service multisig (Safe). Indexed; the ultimate
  recipient of the operator-share JINN mint on Ethereum.
- `claimer` — `msg.sender` at emit time. Indexed for analytics
  but doesn't gate anything — the emitter is permissionless.

The values are 256-bit unsigned. Under B-multi the distributor
applies channel weights (`wCreation`, `wRestorationDelivery`,
`wEvaluationDelivery`) to the snapshot at mint time. The event
itself is unweighted and discovery-oriented. The canonical proof
source is the stored snapshot hash written in the same transaction:
`claimSnapshotHashes[claimId] = keccak256(abi.encode(claimId,
serviceId, verifiedCreations, noveltyWeightedRestorationDeliveries,
evaluationDeliveryCount, multisig))`.

## Contract: `JinnClaimEmitter`

Deploys on Base / Base Sepolia. ~30 lines stateless.

```solidity
contract JinnClaimEmitter {
    IRestorationActivityCheckerV2 public immutable checker;
    IJinnRouterV2 public immutable router;
    IServiceRegistry public immutable serviceRegistry;
    uint256 public nextClaimId;
    mapping(uint256 => bytes32) public claimSnapshotHashes;

    event ClaimTicket(
        uint256 indexed claimId,
        uint256 indexed serviceId,
        uint256 verifiedCreations,
        uint256 noveltyWeightedRestorationDeliveries,
        uint256 evaluationDeliveryCount,
        address indexed multisig,
        address claimer
    );

    constructor(address _checker, address _router, address _registry) {
        checker = IRestorationActivityCheckerV2(_checker);
        router = IJinnRouterV2(_router);
        serviceRegistry = IServiceRegistry(_registry);
    }

    function emitClaim(uint256 serviceId) external returns (uint256 claimId) {
        address multisig = serviceRegistry.mapServices(serviceId).multisig;
        require(multisig != address(0), "JinnClaimEmitter: unknown service");
        claimId = nextClaimId + 1;
        nextClaimId = claimId;
        uint256 verifiedCreations = checker.verifiedCreations(multisig);
        uint256 novelty = checker.noveltyWeightedCounts(multisig);
        uint256 evalDelivery = router.evaluationDeliveryCount(multisig);
        claimSnapshotHashes[claimId] = keccak256(abi.encode(
            claimId, serviceId, verifiedCreations, novelty, evalDelivery, multisig
        ));
        emit ClaimTicket(
            claimId,
            serviceId,
            verifiedCreations,
            novelty,
            evalDelivery,
            multisig,
            msg.sender
        );
    }
}
```

Properties:
- **Append-only snapshot storage.** No admin or upgrade path; each
  call writes one immutable snapshot hash keyed by `claimId`.
- **Permissionless.** Anyone can call `emitClaim` for any
  serviceId. Spamming the event costs the caller gas; doesn't
  affect the on-chain values being read.
- **Snapshot atomicity.** All three counter reads happen in one
  transaction; the event captures their values at one block.
- **Three contract reads:** checker (×2), router (×1), registry
  (×1). Marginal gas cost, single tx.

## Interface: `IClaimMessenger`

Lives on Ethereum / Sepolia. The interface every messenger
implementation must satisfy. Stateless / idempotent — replay
protection is the JinnDistributor's job, not the messenger's.

```solidity
interface IClaimMessenger {
    /// @notice Validates a cross-chain proof and recovers the
    ///         ClaimTicket parameters that were emitted on the
    ///         measurement chain.
    /// @dev Implementations MUST be stateless / idempotent. No
    ///      nonce tracking, no seen-proof registry. Replay
    ///      protection lives in the JinnDistributor's per-service
    ///      monotonic accumulators.
    /// @param proof Opaque blob, format defined by implementation
    ///              (canonical OP-Stack message proof, OP Succinct
    ///              ZK proof, third-party bridge attestation, or
    ///              MockMessenger fixture pointer).
    /// @return serviceId Recovered service id from the ClaimTicket.
    /// @return verifiedCreations Recovered counter value.
    /// @return noveltyWeightedRestorationDeliveries Recovered counter.
    /// @return evaluationDeliveryCount Recovered counter.
    /// @return multisig Recovered service multisig address.
    function verifyClaim(bytes calldata proof)
        external
        view
        returns (
            uint256 serviceId,
            uint256 verifiedCreations,
            uint256 noveltyWeightedRestorationDeliveries,
            uint256 evaluationDeliveryCount,
            address multisig
        );
}
```

Future messenger implementations (β2 OP Succinct, β3 Hyperlane /
LayerZero) MUST satisfy this interface. The opaque `bytes proof`
parameter accommodates any format.

## Contract: `CanonicalOpStackMessenger` (β1, default)

Deploys on Ethereum / Sepolia. ~120–150 lines. Implements
`IClaimMessenger` against the canonical OP-Stack message-passing
flow.

### Proof shape

The proof contains a Base-chain storage proof for
`JinnClaimEmitter.claimSnapshotHashes[claimId]` plus the canonical
output-root commitment chain to L1 and the dispute-game reference
for finality. Events are used for discovery; L1 validates the stored
snapshot hash against the finalized L2 state root.

Concrete `bytes proof` ABI:
```
(
    bytes32 disputeGameId,
    bytes outputRootProof,           // version, stateRoot, msgPasserRoot, latestBlockHash
    bytes[] accountProof,            // emitter account proof under stateRoot
    bytes[] storageProof,            // mapping-slot proof under emitter storageRoot
    uint256 claimId,
    uint256 serviceId,
    uint256 verifiedCreations,
    uint256 noveltyWeightedRestorationDeliveries,
    uint256 evaluationDeliveryCount,
    address multisig
)
```

The messenger validates each piece in order:

1. **DisputeGame is resolved + finalized.** Look up
   `DisputeGameFactory.gameAtIndex(...)` and the generic game proxy.
   Confirm factory/proxy game-type agreement,
   `wasRespectedGameTypeWhenCreated()` or current portal-respected
   type, `status() == DEFENDER_WINS`, and both portal finality delays.
2. **Output root matches.** Recompute the OP output root from
   `(version, stateRoot, messagePasserStorageRoot, latestBlockHash)`
   and compare to the game's `rootClaim()`.
3. **Emitter account is included in state.** Validate `accountProof`
   for the deployed `JinnClaimEmitter` and extract its `storageRoot`.
4. **Snapshot slot is included in storage.** Validate `storageProof`
   for `keccak256(abi.encode(claimId, uint256(1)))`, the storage slot
   of `claimSnapshotHashes[claimId]`.
5. **Snapshot hash matches.** Recompute
   `keccak256(abi.encode(claimId, serviceId, verifiedCreations,
   noveltyWeightedRestorationDeliveries, evaluationDeliveryCount,
   multisig))` and compare to the proven storage value.
6. **Return** `(serviceId, verifiedCreations,
   noveltyWeightedRestorationDeliveries, evaluationDeliveryCount,
   multisig)`.

If any step fails, the messenger reverts. No state writes; no
seen-proof registry. The same proof can be submitted multiple
times — the JinnDistributor handles replay via accumulators.

### Constants set at deploy

- L1 OptimismPortal2 address (Sepolia anchor for Base Sepolia).
- DisputeGameFactory address.
- Expected JinnClaimEmitter address on Base (so we reject logs
  emitted by some impostor contract that happens to use the same
  event signature).
- Expected `ClaimTicket` topic[0] (event signature hash; deployment
  metadata for canary tooling).

### Trust assumptions

- L1 settlement (Ethereum block production + finality).
- OP-Stack Fault Proof correctness (challenge period elapsed, no
  successful counter-claim during the window).
- No additional trust delta on top of L1.

### Latency

**Mainnet today:** current Base mainnet uses legacy gameType `0`
with the standard challenge/finality window.
**Base Sepolia / Azul preview:** current Base Sepolia uses
AggregateVerifier gameType `621`. R-1 measured the observed slow
path at ~7 days because sampled games had one proof; the Azul fast
path can be ~1 day when both TEE and ZK proofs are present.

## Contract: `MockMessenger` (testnet/dev only)

Deploys only on Sepolia for CI / dev / burn-in convenience. NEVER
on mainnet. ~20 lines.

```solidity
contract MockMessenger is IClaimMessenger {
    address public owner;

    struct Fixture {
        uint256 serviceId;
        uint256 verifiedCreations;
        uint256 noveltyWeightedRestorationDeliveries;
        uint256 evaluationDeliveryCount;
        address multisig;
    }
    mapping(uint256 => Fixture) public fixtures;

    constructor(address _owner) {
        owner = _owner;
    }

    function setFixture(uint256 claimId, Fixture calldata f) external {
        require(msg.sender == owner, "MockMessenger: not owner");
        fixtures[claimId] = f;
    }

    function verifyClaim(bytes calldata proof)
        external view returns (
            uint256 serviceId,
            uint256 verifiedCreations,
            uint256 noveltyWeightedRestorationDeliveries,
            uint256 evaluationDeliveryCount,
            address multisig
        )
    {
        uint256 claimId = abi.decode(proof, (uint256));
        Fixture memory f = fixtures[claimId];
        require(f.multisig != address(0), "MockMessenger: no fixture");
        return (
            f.serviceId,
            f.verifiedCreations,
            f.noveltyWeightedRestorationDeliveries,
            f.evaluationDeliveryCount,
            f.multisig
        );
    }
}
```

Properties:
- **Insecure by design.** Owner can set any fixture and mint
  arbitrary JINN through the distributor. **NEVER deploy on
  mainnet.**
- **Permissioned setFixture.** Only the deployer (or a
  test-fixture address) writes fixtures. `verifyClaim` is read-only
  for anyone.
- **Fast mirror of canonical snapshot identity.** Fixtures are keyed
  by `claimId`, not `serviceId`, so burn-in can exercise multiple
  snapshots per service while skipping only the canonical wait.
- **Testnet burn-in role.** R-1 found canonical Base Sepolia
  finality is too slow for iteration, so MockMessenger is the
  active Sepolia burn-in messenger. Canonical Base Sepolia is still
  required as a verifier-only canary before Phase D completes.

## Operator UX (two-tx flow)

Operators interact with the cross-chain flow via the daemon.
End-to-end:

1. **Operator does protocol work.** Posts intents
   (`createRestorationJob`), claims deliveries (`claimDelivery`)
   for restorations + evaluations. Each call increments router
   counters or, via the V2 checker, the verified-work counters.

2. **Daemon emits ClaimTicket on Base.** Periodically (e.g., once
   per hour or once per day, configurable) the daemon calls
   `JinnClaimEmitter.emitClaim(serviceId)` on Base / Base Sepolia.
   Snapshot is recorded in the event.

3. **Daemon waits for L2→L1 finality in canonical mode.** The
   dispute game must resolve and the portal finality windows must
   elapse. Current Base Sepolia/Azul observations are ~7 days on
   the slow path and potentially ~1 day when both proof types are
   available. Mock mode skips this wait but uses the same `claimId`
   snapshot identity.

4. **Daemon constructs proof.** Once the snapshot's stored hash is
   covered by a finalized output root, the daemon builds the
   account/storage proof for `claimSnapshotHashes[claimId]`.

5. **Daemon submits proof on Sepolia.** Calls
   `JinnDistributor.claim(proof)`. Distributor calls
   `messenger.verifyClaim(proof)`, recovers the snapshot, applies
   weights + ratios, mints to operator multisig + DAO Timelock.

Per Q-X4: the daemon submits both transactions by default. The
redeem step is permissionless — a relayer can submit the proof on
the operator's behalf if needed. `serviceId` and the multisig are
captured in the event, so JINN flows to the right destination
regardless of who submits the redeem tx.

## Replay protection

Lives entirely in the JinnDistributor's per-service accumulators.
Same proof submitted twice:

1. First submission: messenger validates, returns
   `(serviceId=42, vCreations=10, vRestoration=20, evalDelivery=5, multisig=0xMS)`.
   Distributor computes weighted snapshot, applies ratios, computes
   `owedOperator = entitledOperator - totalClaimedOperator[42]` =
   some positive value. Mints. Updates accumulators.
2. Second submission of same proof: messenger validates the same
   proof and returns the same tuple. Distributor recomputes — but
   `totalClaimedOperator[42]` is now equal to entitled, so
   `owedOperator = 0`. No mint. Accumulator unchanged.

The accumulator math handles arbitrary submission orders. Every
proof commits to a specific snapshot; the distributor mints up to
the highest-snapshot-claimed-against. No special replay logic
needed in the messenger.

## Future messenger swaps (β2, β3)

The pluggable-messenger pattern means Governor can swap in a
faster proof system later via a single proposal:

- **β2 OP Succinct:** ZK validity proof of L2 state.
  - Latency: ~tens of minutes.
  - Trust delta: Succinct prover correctness (in addition to L1).
  - Implementation: `SuccinctMessenger` validates SP1 proofs.
- **β3 Hyperlane / LayerZero / Across:** third-party bridge
  attestation.
  - Latency: minutes.
  - Trust delta: bridge validator set.
  - Implementation: `HyperlaneMessenger` (or similar) reads
    bridge attestations.

The `IClaimMessenger` interface is sufficient for any of these.
Each implementation defines its own `bytes proof` format. Governor
proposal to swap: `JinnDistributor.setMessenger(newMessengerAddress)`
under standard 18-day flow.

The JinnDistributor's accumulators don't change across messenger
swaps. A snapshot proven via β1 (canonical) and a snapshot proven
via β2 (Succinct) for the same service are interchangeable —
they're both authoritative readings of the same on-chain state.

## Replay across messengers (corner case worth flagging)

If both β1 and β3 messengers are valid for the same period (e.g.,
Governor has authorized swapping but old β1 proofs are still
valid), the same logical work could be proven via two different
messengers. The accumulator math handles this fine:

- Proof via β1 first: claims up to snapshot S1.
- Proof via β3 second: same or higher snapshot S2 >= S1. If
  S2 > S1, mints the delta; if S2 = S1, no mint (no-op).

Different proof bytes, same recovered tuple. Idempotent.

## Open research items

### R-1 — Measure Base Sepolia L2→L1 finality — Resolved

Result: [`2026-04-base-sepolia-finality.md`](./2026-04-base-sepolia-finality.md).
Base Sepolia currently uses AggregateVerifier gameType `621`
(Azul preview). Observed canonical finality is ~7 days on the
single-proof slow path, with a possible ~1 day fast path when both
TEE and ZK proofs are present. Therefore MockMessenger is the
active `r5z` burn-in messenger, and canonical Base Sepolia is a
verifier-only canary.

### R-2 — Verify viem op-stack/storage-proof action coverage for Azul — Resolved

Result:
[`2026-04-azul-storage-proof-tooling.md`](./2026-04-azul-storage-proof-tooling.md).

The current client stack has the primitives needed for the
Azul-compatible canary:

- `viem/op-stack#getGames` finds Base Sepolia dispute games.
- `DisputeGameFactory.gameAtIndex(index)` must be read directly to
  recover the game proxy because viem does not return it.
- Generic AggregateVerifier-compatible selectors are available on the
  proxy: `gameType`, `status`, `resolvedAt`, `rootClaim`,
  `wasRespectedGameTypeWhenCreated`, `l2SequenceNumber`, and
  `proofCount`.
- Core viem `getProof` can request account/storage proofs for
  `JinnClaimEmitter.claimSnapshotHashes[claimId]`.

The gap is not contract compatibility; it is daemon durability.
Viem's stock OP withdrawal actions are withdrawal-hash oriented, so
the daemon still needs a custom builder for arbitrary emitter storage
proofs. The builder must use a reliable proof/archive Base Sepolia
RPC for historical `eth_getProof`; the public Base Sepolia RPC
failed the game-block proof probe on 2026-04-28, while the main
worktree Tenderly endpoint served one sampled game-block proof but
failed another. Treat proof RPC reliability as part of the canonical
canary gate.

### R-3 — Confirm Phase 0 / Phase 1a JinnRouter on Base Sepolia exposes evaluationDeliveryCount as public state — Resolved

Result:
`cd client && JINN_LIVE_RPC_TESTS=1 yarn test test/live/r3-router-surface.live.test.ts`.

The deployed Base Sepolia router surface matches the emitter
assumption:

- Implementation:
  `0x3f1F4420E040C6667CDae0F7b77B71692f698938`.
- Proxy: `0x7c502a4288C4f4279edbb363d692f530200e22dC`.
- The proxy implementation slot resolves to the expected
  implementation address.
- Both implementation and proxy expose
  `evaluationDeliveryCount(address) view returns (uint256)`.

Therefore `JinnClaimEmitter` can safely read
`router.evaluationDeliveryCount(multisig)` on current Base Sepolia.

## Test strategy

### Unit tests (Hardhat, in `cargo/contracts/test/jinn/cross-chain/`)

- **JinnClaimEmitter.test.ts** — emit `claimId`, store the correct
  snapshot hash, increment monotonically, revert on unknown
  serviceId.
- **MockMessenger.test.ts** — setFixture/verifyClaim by `claimId`;
  multiple claims per service; access control; missing fixture.
- **CanonicalOpStackMessenger.test.ts** — storage proof validation
  against mock OptimismPortal2 + DisputeGameFactory; accept gameType
  `0` and `621`; reject unresolved/immature/unrespected games and
  bad account/storage proofs.
- **Distributor + Messenger integration.test.ts** — full mint flow
  with MockMessenger; weight changes apply correctly; replay
  protection works; messenger swap preserves accumulator state.

### Foundry invariants (Phase C, in
`cargo/contracts/test/jinn/invariants/`)

- `CanonicalOpStackMessenger.invariant.t.sol` — verifyClaim is
  deterministic + stateless; rejects malformed proofs by reverting;
  no storage writes during verifyClaim.
- `MockMessenger.invariant.t.sol` — only owner sets fixtures;
  verifyClaim returns set fixtures faithfully.

### Burn-in (Phase D, in `cargo/docs/runbooks/`)

- MockMessenger end-to-end is required for active Sepolia burn-in.
- Automated daemon ticks use **`jinnMessengerMode=mock`** only; scheduled
  `runOnce` skips **`canonical`** so operators do not spam `emitClaim`
  while waiting days for OP dispute-game finality.
- One Base Sepolia canonical verifier-only canary is required before
  Phase D completes: after finality, run
  `tsx scripts/verify-canonical-canary.ts` from `client/` or call
  `CanonicalOpStackMessenger.verifyClaim` via `eth_call` manually.
  Do not swap the active distributor messenger during burn-in.

## Effects on the implementation plan

- **`6lq`** cross-chain contract impls: scope locked. Three
  contracts (`JinnClaimEmitter` ~30 lines, `CanonicalOpStackMessenger`
  ~120-150 lines, `MockMessenger` ~20 lines) plus the
  `IClaimMessenger` interface. Tests as listed above.
- **`olx`** JinnDistributor: ClaimTicket ABI with three counter
  values + multisig + serviceId. Per-channel weights as
  Governor-mutable storage. Math unchanged.
- **`pwg`** V2 + router hardening: includes the `verifiedCreations`
  counter + `creators` mapping needed for ε. Unchanged from the
  bd description; this spec just confirms the surface area.
- **`7x5`** daemon claim-loop + L1 proof construction: implements
  the storage-proof canonical path against OP-Stack tooling (viem)
  + the MockMessenger fast path. Driven by `jinnMessengerMode`
  config flag.
- **`r5z`** testnet deploy + burn-in: active burn-in uses
  MockMessenger; canonical Base Sepolia runs as a verifier-only
  canary after finality.

## Decisions table

| # | Decision | Status |
|---|---|---|
| 1 | ClaimTicket event shape (claimId + 3 counters + multisig + claimer + serviceId) | Locked |
| 2 | JinnClaimEmitter stores snapshot hashes keyed by claimId, permissionless | Locked |
| 3 | IClaimMessenger interface signature (returns 5-tuple, stateless) | Locked |
| 4 | CanonicalOpStackMessenger validates storage proofs against OptimismPortal2 + respected dispute games | Locked |
| 5 | MockMessenger is active testnet burn-in path, keyed by claimId | Locked |
| 6 | Daemon submits both txs by default; redeem permissionless | Locked |
| 7 | Replay protection lives in JinnDistributor accumulators only | Locked |
| 8 | Future β2/β3 messenger swaps via Governor proposal; same interface | Locked |
| R-1 | Measure Base Sepolia L2→L1 finality | Resolved |
| R-2 | Verify viem op-stack/storage-proof coverage for Azul | Resolved |
| R-3 | Confirm V2 router public state on Base Sepolia | Resolved |
