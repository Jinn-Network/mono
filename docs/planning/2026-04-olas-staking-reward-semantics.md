# OLAS Staking Reward Semantics — Investigation Note

> Status: **Superseded — see Recommendation v3 (Architecture B) at the bottom**
> Date: 2026-04-27 (updated 2026-04-28)
> Branch: `jinn-mono/jinn-mono-1bo`
> Phase A0 of the Jinn v0 MVI implementation plan
> bd task: `jinn-mono-1bo`
> Reference: `docs/planning/2026-04-jinn-mvi-on-olas.md` (proposal) +
> `log/decisions/2026-04-27-jinn-mvi-on-olas-decisions.md` §10 (DR)

> **2026-04-28 evolution.** Three iterations on the design:
> 1. **v1** (deprecated) — read OLAS staking reward field directly,
>    with operational invariants. Killed the moment we surfaced
>    self-bond and standard mode racing.
> 2. **v2** (deprecated) — read JinnRouter counters directly, gate
>    minting on staking eligibility at the JinnDistributor. Cleaner,
>    but creates an overlap with the V2 activity checker (two gates
>    for "is this real work").
> 3. **v3 (locked)** — checker becomes the single gate. The V2
>    activity checker tracks per-channel cumulative verified-work
>    counters; emitter reads from checker; distributor mints
>    unconditionally against checker output. One gate for both OLAS
>    rewards and JINN. See "Recommendation v3 — Architecture B" near
>    the bottom.

## The question

The v0 `JinnClaimEmitter` on Base reads accumulated OLAS reward for a
service from the deployed staking instance at
`0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` and emits a `ClaimTicket`
event. The downstream `JinnDistributor` on Ethereum then mints JINN
proportional to that snapshot, using monotonic per-service
accumulators (`totalClaimedOperator[serviceId]`,
`totalClaimedDao[serviceId]`) to prevent double-claim.

For this to be safe, **the snapshot read by the emitter must be
monotonic across calls** — i.e., it must represent
"cumulative-OLAS-earned-since-deploy," not "currently-claimable
balance." If the snapshot can decrease, the distributor's
subtraction (`entitled - alreadyClaimed`) underflows or under-mints.

## Finding

**`mapServiceInfo[serviceId].reward` is claimable-not-cumulative.**

It accumulates as checkpoints credit rewards, then **resets to zero**
when an OLAS-side claim extracts the funds.

Evidence in vendored `cargo/contracts/src/vendor/registries/staking/StakingBase.sol`:

- **Credit on checkpoint** (lines 991, 1005, 1015):
  `mapServiceInfo[curServiceId].reward += updatedReward;`
  Each checkpoint adds to per-service `reward` for eligible services.
- **Debit + zero on `_claim`** (lines 553–561):
  ```solidity
  reward = sInfo.reward;
  if (reward == 0) { revert ZeroValue(); }
  sInfo.reward = 0;  // ← field zeroed
  ```
- **Debit + zero on `_unstake`** (line 909): same pattern, but only
  when `enforced == false`.

There is **no separate cumulative-since-deploy counter** anywhere on
the contract. The cumulative trail exists only in event logs:

- `Checkpoint(uint256 indexed epoch, uint256 availableRewards, uint256[] serviceIds, uint256[] rewards, uint256 epochLength)` — credit side, line 1073.
- `RewardClaimed(uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces, address[] receivers, uint256[] rewardAmounts)` — debit side, lines 574, 914.

To compute "cumulative OLAS earned by service X" from on-chain state
alone, an observer must aggregate either every `Checkpoint` event's
contribution to X (sum of `rewards[i]` where `serviceIds[i] == X`) or
every `RewardClaimed` event for X plus the current `reward` field.
**Neither is queryable from a contract; both require off-chain
aggregation or storage-proof Merkleization.**

## Implications for `JinnClaimEmitter`

The proposal's nominal "stateless ~30 lines" emitter that just reads
`mapServiceInfo[serviceId].reward` is **unsafe** in any environment
where someone can call OLAS `_claim` between two `emitClaim` calls
*and* new rewards have accumulated in the interim. The naive flow:

```
T0: emitClaim          → reward=100, ticket(snapshot=100)
T1: someone calls _claim → reward=0
T2: checkpoint credits 50 → reward=50
T3: someone calls _claim → reward=0  ← lost 50!
T4: emitClaim          → reward=0, ticket(snapshot=0)
```

Without a stateful tracker on the emitter side or a hook into every
OLAS-claim call, work credited and extracted between `emitClaim`
calls is invisible to JINN.

## Design options

| Option | Shape | Safety | Complexity |
|---|---|---|---|
| **A.** Stateless emitter; reads `reward` directly | ~30 lines | Safe **only if no entity calls OLAS `_claim`** during the v0 window | Trivial |
| **B.** Stateful emitter with `lastObserved` + cumulative tracker | ~80 lines | Race-safe under monotonically-increasing `reward`; race-hazardous if OLAS `_claim` interleaves with no `emitClaim` between two checkpoints | Medium |
| **C.** Stateful emitter that *itself* calls `OLAS.claim` atomically (`claimAndEmit`) | ~80 lines | Race-free; emitter is the canonical capture of every claim | Requires the emitter to hold `serviceOwner` permission on every Jinn service (works in standard mode where stOLAS owns the service; awkward in Phase 0/1a where the operator is owner) |
| **D.** Off-chain `Checkpoint` event aggregation + Merkle proof on-chain | tens of lines emitter + significant messenger work | Most rigorous | High — requires storage-/event-proof verification in `CanonicalOpStackMessenger` |

## Recommendation for v0 testnet

**Adopt Option A (stateless ~30-line emitter) as the v0 testnet
default**, conditioned on a single operational invariant:

> No entity calls `OLAS.staking._claim(serviceId)` for any Jinn
> service while v0 is the active distribution mechanism.

Rationale:

1. The OLAS reward field accumulates monotonically as long as nobody
   extracts. With no extraction, the snapshot read from
   `mapServiceInfo[serviceId].reward` *is* cumulative-since-deploy by
   construction — exactly what the distributor needs.
2. In Phase 0/1a-mode (the v0 testnet operator UX), the operator is
   `serviceOwner` and is the only entity that can call `_claim`. The
   daemon controls operator behavior and can simply **not call
   `OLAS.staking._claim`** — the OLAS rewards remain held in the
   staking contract indefinitely from Jinn's perspective.
3. The §10 disposition decision (burn / DAO treasury / multisig /
   stOLAS yield) is open. If "burn" or any extraction is later
   locked, the extraction flow must be designed alongside an upgrade
   to Option B or C. v0 testnet does not pre-empt that design — it
   simply leaves OLAS in place.
4. JINN minting is unaffected: the distributor's accumulator
   subtraction is correct for any monotonic snapshot, whether or not
   the underlying OLAS has been extracted.

**Concrete v0 emitter sketch:**

```solidity
contract JinnClaimEmitter {
    IStakingBase public immutable staking;
    IServiceRegistry public immutable serviceRegistry;

    event ClaimTicket(
        uint256 indexed serviceId,
        uint256 snapshot,
        address indexed multisig,
        address indexed claimer
    );

    constructor(address _staking, address _serviceRegistry) {
        staking = IStakingBase(_staking);
        serviceRegistry = IServiceRegistry(_serviceRegistry);
    }

    function emitClaim(uint256 serviceId) external {
        uint256 snapshot = staking.mapServiceInfo(serviceId).reward;
        address multisig = serviceRegistry.mapServices(serviceId).multisig;
        emit ClaimTicket(serviceId, snapshot, multisig, msg.sender);
    }
}
```

No state. No owner. Permissionless. The invariant lives in the
operational story ("don't call OLAS `_claim`"), not in the contract.

## Hardening path for production / mainnet

When the §10 disposition decision lands and OLAS extraction is part
of the canonical flow (any of: burn, DAO treasury, etc.), the
emitter must be upgraded — most likely to **Option C
(`claimAndEmit`)** — so the cumulative tracker is on the emitter
side and the OLAS extraction is atomic with the snapshot.

Option C requires the emitter to be `serviceOwner` on every Jinn
service. In **standard mode** (stOLAS-backed operator UX, design
target per Locked Decisions §10) this is natural: the stOLAS
distributor stakes the service and can transfer ownership to (or
delegate to) the JinnClaimEmitter. In **Phase 0/1a mode** (v0
testnet), it's awkward because operators own their services
directly; an opt-in path would be needed.

A future spec session under bd `1bo` should design the production
emitter alongside the disposition decision. v0 testnet simply
ships Option A and documents the operational invariant.

## Other findings worth noting

- **`mapServiceInfo` is `public`** (line 329), so the getter
  signature `mapServiceInfo(uint256) returns (ServiceInfo)` is
  available. Reading from another contract is straightforward.
- **Service `multisig` is in `ServiceInfo`** as well (line 196 region;
  field used in `_claim` line 565), so the emitter could read
  multisig from the staking contract directly without touching the
  ServiceRegistry. Cleaner: read both `reward` and `multisig` from
  one `mapServiceInfo` call.
- **`epochCounter` is monotonically increasing**, included in the
  `RewardClaimed` event. Not directly useful for v0 but informative
  for any future event-aggregation path.
- **`tsCheckpoint`** records the timestamp of the last checkpoint
  — could be used for staleness checks if needed.

## Decisions made by this note (superseded — kept for context)

| # | Decision | Original status | Now |
|---|---|---|---|
| 1 | `mapServiceInfo[serviceId].reward` is claimable-not-cumulative — confirmed | Locked finding | Still true; just no longer the input we read |
| 2 | v0 `JinnClaimEmitter` ships as Option A (stateless, ~30 lines reading OLAS reward) | Locked for v0 testnet | **Superseded by v2 below** |
| 3 | Operational invariant: daemon does not call `OLAS.staking._claim` for Jinn services in v0 | Locked for v0 testnet | **No longer needed** under v2 |
| 4 | `JinnClaimEmitter` reads `multisig` from `mapServiceInfo` directly | Locked | Still applies under v2 (multisig from ServiceRegistry) |
| 5 | Production emitter design deferred to bd `1bo` follow-up | Open | Mostly resolved by v2; the §10 disposition decision becomes an OLAS-substrate concern, not a Jinn-flow concern |

---

# Recommendation v2 — JinnRouter counters (2026-04-28)

## The shift in framing

The whole investigation above asks: "how do we extract a monotonic
snapshot from the OLAS staking contract's reward field, given that
the field can be zeroed by `_claim`?" Working through standard
mode (stOLAS-backed, JinnClaimEmitter integrates with a
Jinn-controlled ActivityModule) and self-bond mode (operator owns
the service, controls claim) revealed that each mode has a
different integration story and different invariants.

But there's a simpler observation: **OLAS rewards are themselves a
function of activity counters.** The OLAS staking contract's
checkpoint reads service nonces (provided by an `ActivityChecker`),
applies the `isRatioPass` test, and credits rewards proportional
to time × eligible activity. The actual signal the protocol
measures is the activity counter. The OLAS reward is just a
calibrated derivative of it.

If we read the activity counters directly, we skip the entire
OLAS-reward-zeroing problem.

## What's available today

JinnRouter on Base mainnet (`0xfFa7118A3D820cd4E820010837D65FAfF463181B`)
already exposes per-multisig monotonic counters, sourced from
`legacy/jinn-cli-agents-reference/contracts/staking/JinnRouter.sol`
line 254–260:

```solidity
function getMultisigNonces(address multisig)
    external view returns (uint256[] memory nonces)
{
    nonces = new uint256[](5);
    nonces[0] = IMultisig(multisig).nonce();              // Safe nonce
    nonces[1] = creationCount[multisig];                  // intents created
    nonces[2] = restorationDeliveryCount[multisig];       // restoration deliveries
    nonces[3] = evaluationCreationCount[multisig];        // evaluation jobs created
    nonces[4] = evaluationDeliveryCount[multisig];        // evaluation deliveries
}
```

Counters [1]–[4] are protocol-work counters (the four channels of
the Jinn loop: creation → execution → evaluation). They only ever
increment. There's no `_claim`-style mechanic that resets them.
Counter [0] (Safe nonce) counts every Safe transaction including
admin operations and is unsuitable as a work signal.

## Reframed JinnClaimEmitter

**Where weights live: on the JinnDistributor (Ethereum), not the
emitter.** The emitter on Base passes the four raw counter values
in the ClaimTicket event; the distributor on Ethereum applies
Governor-mutable weights at mint time. Same Governor-control
mechanism as `operatorRatio` / `daoRatio` — `setWeights(...)` is
a Timelock-gated call. No emitter redeploy or proxy upgrade
required to change weights.

```solidity
contract JinnClaimEmitter {
    IJinnRouter public immutable router;
    IServiceRegistry public immutable serviceRegistry;

    event ClaimTicket(
        uint256 indexed serviceId,
        uint256 creationCount,
        uint256 restorationDeliveryCount,
        uint256 evaluationCreationCount,
        uint256 evaluationDeliveryCount,
        address indexed multisig,
        address indexed claimer
    );

    function emitClaim(uint256 serviceId) external {
        address multisig = serviceRegistry.mapServices(serviceId).multisig;
        emit ClaimTicket(
            serviceId,
            router.creationCount(multisig),
            router.restorationDeliveryCount(multisig),
            router.evaluationCreationCount(multisig),
            router.evaluationDeliveryCount(multisig),
            multisig,
            msg.sender
        );
    }
}
```

Stateless. ~30 lines. No operational invariants. Works identically
in standard mode and self-bond mode. Counters are monotonic by
construction; the JinnDistributor's accumulator math is
unconditionally safe under any weight choice.

### Note on JinnRouter V1 vs V2

The Base Sepolia JinnRouter is V2 (proxy
`0x7c502a4288C4f4279edbb363d692f530200e22dC`, impl
`0x3f1F4420E040C6667CDae0F7b77B71692f698938`). V2 removed the
bundled `getMultisigNonces` function (now lives in the activity
checker — see `JinnRouterV2.sol` line 62), but the four counter
mappings (`creationCount`, `restorationDeliveryCount`,
`evaluationCreationCount`, `evaluationDeliveryCount`) remain
public state in V2. Read each via the auto-generated getter —
four reads instead of one bundled call, negligible gas cost.

## JinnDistributor weight handling (Ethereum side)

The distributor stores the per-channel weights as Governor-mutable
state and computes the snapshot at `claim()` time:

```solidity
contract JinnDistributor {
    // Already-locked Governor-mutable parameters
    uint256 public operatorRatio;
    uint256 public daoRatio;
    // New: per-channel weights (initial value = 1 each per captain decision 2026-04-28)
    uint256 public wCreation;
    uint256 public wRestorationDelivery;
    uint256 public wEvaluationCreation;
    uint256 public wEvaluationDelivery;

    // Per-service monotonic accumulators
    mapping(uint256 => uint256) public totalClaimedOperator;
    mapping(uint256 => uint256) public totalClaimedDao;

    function claim(bytes calldata proof) external {
        (uint256 serviceId,
         uint256 creation,
         uint256 restorationDelivery,
         uint256 evaluationCreation,
         uint256 evaluationDelivery,
         address multisig) = messenger.verifyClaim(proof);

        uint256 weighted =
              wCreation             * creation
            + wRestorationDelivery  * restorationDelivery
            + wEvaluationCreation   * evaluationCreation
            + wEvaluationDelivery   * evaluationDelivery;

        uint256 entitledOperator = (weighted * operatorRatio) / 1e18;
        uint256 entitledDao      = (weighted * daoRatio)      / 1e18;
        // ... rest unchanged: clamp owed at zero if accumulator > entitled, mint, update accumulators.
    }

    function setWeights(uint256 wC, uint256 wR, uint256 wEC, uint256 wED) external {
        // Timelock-gated, Governor-controlled.
    }
}
```

Weight changes via Governor proposal: `Timelock → JinnDistributor.setWeights(...)`.
Effect on previously-claimed services: if a weight decreases, a
service's "entitled" total can drop below its already-claimed
total. The accumulator math clamps `owed` at zero — no new mint
until counters catch up. Same shape as `operatorRatio` /
`daoRatio` decreases under §1. Defensible behavior, documented.

### Locked initial values

Per captain decision 2026-04-28:

| Param | Initial | Rationale |
|---|---|---|
| `wCreation` | 1 | Equal weight across channels — simplest start |
| `wRestorationDelivery` | 1 | Equal weight |
| `wEvaluationCreation` | 1 | Equal weight |
| `wEvaluationDelivery` | 1 | Equal weight |
| Counter [0] (Safe nonce) | excluded | Not protocol work; admin operations only |

Effective at v0 testnet: `snapshot = creation + restorationDelivery + evaluationCreation + evaluationDelivery`. Governor adjusts later if specific channels deserve different rates.

## What this collapses

| Concern | Old (OLAS reward) | New (JinnRouter counters) |
|---|---|---|
| Read-semantics question | Load-bearing | **Irrelevant** — counters are monotonic |
| §10 OLAS disposition | Open decision; affects emitter design | **Decoupled** — OLAS rewards become an OLAS-substrate detail, not a Jinn flow |
| Self-bond vs standard mode | Different code paths, different invariants | **Identical** — both read the same counters |
| ActivityModule integration | Required for standard-mode atomic capture | **Not needed** — JINN doesn't depend on OLAS-claim path |
| Calibration | "1 JINN per 1 OLAS earned" — depends on OLAS rate | "1 JINN per 1 weighted activity unit" — Governor sets directly |
| Cross-chain shape | Same | Same |
| Replay protection | Same (per-service distributor accumulators) | Same |

The §10 family of questions (disposition, tracking, stOLAS
integration, self-bond compatibility) **just goes away** because
Jinn doesn't depend on OLAS rewards at all. OLAS still provides
the substrate (service registration, staking eligibility, V2
anti-farming). OLAS reward accounting is irrelevant to JINN.

## What this introduces

1. **Counter weighting + base rate.** Three sub-decisions:
   - **Single counter or weighted sum?** Reading
     `restorationDeliveryCount` alone is simplest. Weighting all
     four channels delivers multi-channel emission directly (the
     proposal's v1+ point promoted to v0).
   - **Base rate.** "1 JINN per 1 weighted unit" is the simplest
     anchor. Governor-mutable post-deploy.
   - **Exclude `IMultisig.nonce()` (counter [0])?** Yes — it
     counts admin operations, not protocol work.

2. **JinnRouter on Base Sepolia.** The Base mainnet JinnRouter
   exists; a Base Sepolia equivalent must be deployed for v0
   testnet (Phase 1a may already have done this — needs
   confirmation in cross-chain spec `l6b`).

3. **Coupling Jinn to JinnRouter shape.** Same kind of coupling
   we'd have to OLAS staking semantics, just to a different
   contract. JinnRouter v2/v3 is upgradable behind a proxy; if it
   changes counter shape, the JinnDistributor ships a v1 emitter
   via Governor swap.

4. **Anti-farming still required.** Counters can be inflated by
   spam (fake intents that the system "creates" and trivially
   "delivers"). The V2 anti-farming checker (`pwg`) catches this
   class of attack — its job becomes guarding the JinnRouter
   counter signal rather than the OLAS reward signal. Still in
   the v0 critical path.

## v2 decisions (these supersede v1's locks above)

| # | Decision | Status |
|---|---|---|
| 1 | v0 `JinnClaimEmitter` reads JinnRouter counters, not OLAS reward | Recommended |
| 2 | OLAS reward field semantics still documented above (claimable-not-cumulative) but no longer load-bearing for Jinn flow | Recorded |
| 3 | Stateless ~25-line emitter, weighted sum of counters [1]–[4] | Recommended for v0 |
| 4 | Counter weights + base rate set at deploy; Governor-mutable | Recommended |
| 5 | §10 OLAS disposition is now an OLAS-substrate-level concern (not a Jinn protocol concern); bd `1bo` scope shrinks accordingly | Recommended |
| 6 | V2 anti-farming (`pwg`) stays in critical path — guards counter signal | Unchanged |

## Effect on the implementation plan (v2 — superseded by v3)

- **A0 (this doc):** done. v2 recommendation locked, v1 archived.
- **`l6b` cross-chain spec:** scope unchanged shape; emitter reads
  JinnRouter not OLAS staking. Spec the counter weighting +
  baseline rate.
- **`6lq` cross-chain impls:** JinnClaimEmitter is now ~25 lines
  stateless. CanonicalOpStackMessenger unchanged. MockMessenger
  unchanged.
- **`olx` JinnDistributor:** **unchanged.** It treats `snapshot`
  as opaque "cumulative activity"; the math doesn't care whether
  the source is OLAS reward or JinnRouter counters.
- **`1bo` OLAS reward tracking + disposition:** scope shrinks
  significantly. The disposition decision becomes "what does the
  OLAS staking contract do with its rewards" — answerable
  separately from JINN flow, and possibly answerable as "leave
  them in the staking contract; they're not part of the Jinn
  protocol."
- **Proposal doc §1 ratio:** not "1 JINN per 1 OLAS earned"
  anymore. Likely "1 JINN per 1 weighted activity unit" with the
  weighting per channel explicit.

---

# Recommendation v3 — Architecture B (locked 2026-04-28)

## What changed in framing

v2 (read JinnRouter counters; gate minting on staking eligibility
at the distributor) creates an overlap between the V2 activity
checker (which gates OLAS rewards via anti-farming analysis) and
the JinnDistributor (which gates JINN rewards via a separate
eligibility check). Two gates doing similar work for different
reward streams.

v3 collapses the overlap: **the activity checker is the single
gate, used by both OLAS rewards and JINN minting.** The checker's
job — verify real work, reject farmed work — is exactly what the
JINN flow needs as its source of truth. By extending the checker
to track per-service cumulative verified-work counters, JINN
mints directly against the checker's output, with no parallel
eligibility logic in the distributor.

## Architecture

**V2 activity checker (extended):**

```solidity
contract RestorationActivityCheckerV2 {
    // Existing V2 anti-farming logic (Hamming distance, evidence
    // analysis, eviction signaling via isRatioPass) unchanged.

    // New: per-multisig per-channel cumulative verified-work
    // counters. Increments when the checker's analysis confirms
    // a delivery (or directly on creation, depending on channel).
    mapping(address => uint256) public verifiedCreations;
    mapping(address => uint256) public verifiedRestorationDeliveries;
    mapping(address => uint256) public verifiedEvaluationCreations;
    mapping(address => uint256) public verifiedEvaluationDeliveries;

    function recordRestorationEvidence(address multisig, bytes32 evidenceHash) external {
        // ... existing V2 anti-farming evaluation ...
        if (passesAntiFarming(...)) {
            verifiedRestorationDeliveries[multisig]++;
        }
    }

    // Similar entry points for the other channels, called by JinnRouter.

    // Public getters auto-generated for the four counters.
}
```

**JinnRouter (existing):** unchanged. Continues to count raw
events; forwards evidence to checker. Its raw counters become
analytics/observability signals, no longer the JINN signal.

**JinnClaimEmitter (Base, ~30 lines stateless):**

```solidity
contract JinnClaimEmitter {
    IActivityCheckerV2 public immutable checker;
    IServiceRegistry public immutable serviceRegistry;

    event ClaimTicket(
        uint256 indexed serviceId,
        uint256 verifiedCreations,
        uint256 verifiedRestorationDeliveries,
        uint256 verifiedEvaluationCreations,
        uint256 verifiedEvaluationDeliveries,
        address indexed multisig,
        address indexed claimer
    );

    function emitClaim(uint256 serviceId) external {
        address multisig = serviceRegistry.mapServices(serviceId).multisig;
        emit ClaimTicket(
            serviceId,
            checker.verifiedCreations(multisig),
            checker.verifiedRestorationDeliveries(multisig),
            checker.verifiedEvaluationCreations(multisig),
            checker.verifiedEvaluationDeliveries(multisig),
            multisig,
            msg.sender
        );
    }
}
```

**JinnDistributor (Ethereum):** mints unconditionally against the
weighted snapshot. **No eligibility check.** The fact that the
counters only increment when the checker says so IS the gate.

```solidity
function claim(bytes calldata proof) external {
    (uint256 serviceId,
     uint256 vCreations,
     uint256 vRestorationDeliveries,
     uint256 vEvaluationCreations,
     uint256 vEvaluationDeliveries,
     address multisig) = messenger.verifyClaim(proof);

    uint256 weighted =
          wCreation             * vCreations
        + wRestorationDelivery  * vRestorationDeliveries
        + wEvaluationCreation   * vEvaluationCreations
        + wEvaluationDelivery   * vEvaluationDeliveries;
    // ... rest unchanged: ratios + accumulators + clamp + mint.
}
```

## Why v3 is better than v2

| Concern | v2 (counters + eligibility gate) | v3 (checker-as-oracle) |
|---|---|---|
| "Is this real work?" decision | Two places: checker + distributor | One place: checker |
| Anti-farming for JINN | Indirect (checker → eviction → eligibility) | Direct (checker increments only on verified work) |
| Distributor scope | Math + eligibility logic | Math only |
| Single source of truth | No | Yes |
| OLAS / Jinn coordination | Two parallel mechanisms | One mechanism, two consumers |
| Future reusability | Eligibility logic is Jinn-specific | Verified-work counters reusable for other systems |
| 7-day window security role | Critical (gives anti-farming time before mint) | Helpful but not load-bearing — counter only ticks for verified work |
| Risk surface | Distributor + checker both need to be correct | Checker is the single critical path |

## Per-channel weights (locked 2026-04-28)

Same as v2: weights = 1 each across the four protocol-work
channels, Governor-mutable on the JinnDistributor side. Counter
[0] (Safe nonce) excluded — admin operations only, not protocol
work.

`snapshot = verifiedCreations + verifiedRestorationDeliveries + verifiedEvaluationCreations + verifiedEvaluationDeliveries`

## What the checker actually verifies, per channel

Open question for `l6b` to resolve, but the natural shape:

- **Creations** (restoration + evaluation creation): incremented
  on the checker when the router calls into it from
  `createRestorationJob` / `createEvaluationJob`. No anti-farming
  gate on creations — they're just "I posted an intent" and don't
  have evidence to compare. Caveat: spam creations could be a
  vector; we may want a rate-limit on the checker side.
- **Deliveries** (restoration + evaluation): incremented only if
  the V2 anti-farming analysis (Hamming distance, similarity
  threshold) passes. This is the existing V2 logic with a new
  side effect (counter increment) on pass.

Sub-decisions for `l6b`:
- Are creations also gated (rate-limited)?
- Does the checker's evaluation happen synchronously on the call
  from the router, or deferred to a separate analysis pass?
- What's the interface between router and checker for the
  creation / evaluation-creation channels (today only delivery
  evidence is forwarded)?

## Effects on the implementation plan (v3)

- **A0 (this doc):** done. v3 locked, v2 archived.
- **`pwg` V2 activity checker upgrade:** **scope expands.** Adds
  per-channel cumulative verified-work counters + getters to V2,
  plus router→checker entry points for creation channels (today
  only delivery evidence is forwarded). Estimate +2–3 days on top
  of existing V2 audit + deploy.
- **`l6b` cross-chain spec:** spec the checker getter shape,
  ClaimTicket event, proof format, plus the open sub-decisions
  above (creation gating, sync vs deferred verification, router-
  checker entry points for creation channels).
- **`6lq` cross-chain impls:** emitter reads from V2 checker
  (extended) instead of from JinnRouter. ~30 lines stateless.
  CanonicalOpStackMessenger + MockMessenger unchanged in shape.
- **`olx` JinnDistributor:** simpler than v2 — no eligibility
  check needed. Pure math: weighted sum, ratios, accumulators,
  clamp, mint. Per-channel weights as Governor-mutable storage.
- **`1bo` OLAS reward tracking + disposition:** scope unchanged
  from v2 (still shrunk; OLAS rewards still decoupled from JINN).
- **Proposal doc §1 ratio:** "1 JINN per 1 verified-work unit"
  with weights = 1 each across the four channels.

## v3 decisions table

| # | Decision | Status |
|---|---|---|
| 1 | V2 activity checker is the single gate for "is this real work" — used by both OLAS and JINN | Locked |
| 2 | V2 extended with per-channel cumulative verified-work counters + getters | Locked; expands `pwg` scope |
| 3 | Emitter reads from checker, not from JinnRouter | Locked |
| 4 | Distributor has no eligibility check; trusts checker output | Locked |
| 5 | Weights = 1 each across four channels, Governor-mutable on distributor | Locked from v2 |
| 6 | Creation-channel gating (rate-limit?) and verification timing (sync vs deferred) | Open — `l6b` resolves |
| 7 | Router→checker integration for creation channels | Open — `l6b` resolves |
