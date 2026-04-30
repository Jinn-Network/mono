# V2 Activity Checker Audit + Architecture B Compatibility

> Status: **Draft (Phase B' audit, pre-deploy)**
> Date: 2026-04-27
> Branch: `worktree-agent-a2cc8cf1d576a48ef` (fork of `jinn-mono/jinn-mono-zwj`)
> Related:
> - `.tasks/jinn-mono-zwj/docs/planning/2026-04-olas-staking-reward-semantics.md` (Architecture B / v3 lock)
> - `cargo/contracts/src/staking/RestorationActivityCheckerV2.sol`
> - `cargo/contracts/src/staking/JinnRouterV2.sol`
> - `cargo/contracts/deployment-phase1b-router-checker-baseSepolia-fast.json`

## Summary

- **V2 already exposes a single combined "weighted activity" signal via `getMultisigNonces` (line 214) that mirrors what Architecture B's JINN snapshot needs.** No new state or getters are strictly required to ship B-single.
- **The four channel signals are not all on the same contract.** Three (creation, eval-creation, eval-delivery) live on `JinnRouterV2`; only restoration-delivery flows through the checker's anti-farming gate. Reading them as four independent values (B-multi) requires the emitter to call both the router and the checker.
- **Anti-farming today only gates the restoration-delivery channel.** Creation and evaluation channels are full-weight, ungated. This is consistent with the v3 plan ("creation channels open question for `l6b`"), but is worth flagging: a sophisticated farmer could spam the three ungated channels on Base Sepolia and have those counters mint JINN at full weight.
- **Recommendation: ship B-multi for v0.** It moves channel weights into Governor-mutable distributor state (no proxy upgrade to retune), exposes each channel for analytics, and matches the locked v3 weight table verbatim. V2 needs **no contract changes** to support it — the four mappings and the checker's `noveltyWeightedCounts` are already public.
- **Two anti-farming concerns surfaced** (medium severity): (1) unbounded `evidenceHashes[multisig]` array growth keeps gas cost of `recordRestorationEvidence` constant per call (because of the `comparisonWindow` slice), but storage cost grows monotonically and is never trimmed; (2) the checker's eviction signaling via `isRatioPass` does not retroactively claw back already-credited `noveltyWeightedCounts` from a service that later fails liveness — meaning verified work credited via "novel" hashes survives even if the operator is later evicted. Neither is fatal for v0, but both should be documented.

## What V2 already provides

All line numbers refer to `cargo/contracts/src/staking/RestorationActivityCheckerV2.sol` and `cargo/contracts/src/staking/JinnRouterV2.sol` as of HEAD on this worktree.

### Counters (checker-side)

- **`activityCounts[multisig]`** (checker line 64) — raw monotonically increasing per-multisig count of all `recordActivity*` calls. Off-chain inspection only.
- **`activityCountsByType[multisig][activityType]`** (checker line 67) — same, broken down by `CREATE / DELIVER / EVALUATE` enum (line 51). Off-chain inspection only.
- **`noveltyWeightedCounts[multisig]`** (checker line 72) — the load-bearing counter. 1e18 scale. Incremented by:
  - `recordActivityWithEvidence` (line 152): novelty-weighted increment based on `_computeNoveltyWeight` against stored hashes.
  - `recordRestorationEvidence` (line 180): same novelty path; **only** the authorized router can call. This is the path JinnRouterV2's `claimDelivery` uses for restoration deliveries (router line 248).
  - `recordActivity` (line 195): full-weight (`+= 1e18`) increment — backward-compat path with no anti-farming.

### Counters (router-side, JinnRouterV2)

- **`creationCount[multisig]`** (router line 98) — incremented in `createRestorationJob` (line 152). Raw count, no anti-farming.
- **`restorationDeliveryCount[multisig]`** (router line 99) — incremented in `claimDelivery` for `JobType.RESTORATION` (line 243). The router increments its own raw count **and** calls `IActivityCheckerV2.recordRestorationEvidence` (line 248) which produces the novelty-weighted increment on the checker side.
- **`evaluationCreationCount[multisig]`** (router line 100) — incremented in `createEvaluationJob` (line 194). Raw count, no anti-farming.
- **`evaluationDeliveryCount[multisig]`** (router line 101) — incremented in `claimDelivery` for `JobType.EVALUATION` (line 252). **Raw count, no anti-farming, no checker hand-off.**

### Bridged getter: `getMultisigNonces`

`getMultisigNonces(multisig)` (checker line 214) returns `[Safe nonce, weightedActivity]` where:

```
weightedActivity =
    (router.creationCount(multisig)
   + router.evaluationCreationCount(multisig)
   + router.evaluationDeliveryCount(multisig)) * 1e18
  + checker.noveltyWeightedCounts(multisig)
```

Important nuances:

1. **`restorationDeliveryCount` is intentionally excluded** from the router-side sum (see comment lines 220–221). It is captured via the `noveltyWeightedCounts` bucket which `recordRestorationEvidence` populates.
2. The router's three other counters are added at full weight (1e18 each). Their raw counts increment regardless of any anti-farming verdict.
3. If `jinnRouter == address(0)` (standalone mode), the function returns just `noveltyWeightedCounts[multisig]` (line 230). The deployed Base Sepolia configuration is **not** in standalone mode (router is wired via `setRouterAddresses`).

### `isRatioPass`

`isRatioPass(curNonces, lastNonces, ts)` (line 240) computes `(curNonces[1] - lastNonces[1]) / ts >= livenessRatio`. The OLAS staking contract calls this at checkpoint to decide eviction. **Side note:** even if `isRatioPass` returns `false` and the staking contract evicts, the underlying `noveltyWeightedCounts` and router counters keep their accumulated values — eviction does not reset history.

### Admin surface

- `setAntifarmingParameters` (line 329) — owner-mutable: similarity threshold, decay multiplier, comparison window. Owner-only via custom error `OwnerOnly`.
- `setRouterAddresses` (line 347) — owner-mutable: `jinnRouter` (read source) + `authorizedRouter` (the only address allowed to call `recordRestorationEvidence`). These two are typically the same on Base Sepolia (both point at the JinnRouter proxy), but the contract permits them to differ.
- `transferOwnership` (line 356) — standard owner transfer.

There is **no upgrade proxy on the checker.** Only `JinnRouterV2` is proxied (router's slots 0–1 reserved per `JinnRouterProxy`). Checker is a plain contract; replacing it requires redeploying and rewiring `setRouterAddresses` on the new instance plus pointing the staking contract at the new checker.

## Anti-farming logic review

### The novelty function — `_computeNoveltyWeight` (line 270)

For each recorded delivery hash `newHash`:

1. If `evidenceHashes[multisig].length == 0` → return `1e18` (first activity always novel).
2. Compute `start = max(0, len - comparisonWindow)`. Iterate over the slice `[start, len)` of stored hashes for this multisig.
3. Track `minDistance = min over slice of _hammingDistance(newHash, hashes[i])`.
4. Early-exit on `minDistance == 0`.
5. If `minDistance >= similarityThreshold` → return `1e18` (novel).
6. Else → return `similarDecayMultiplier` (which is **0** on the deployed Base Sepolia config — binary novel/spam decision).

### `_hammingDistance` and `_popcount256` (lines 305–324)

`_hammingDistance(a, b) = popcount(a XOR b)`. Popcount uses the standard Wegner / parallel-bit-counting trick. Returns 0–256.

This is correct for SimHash similarity. **The 0x55... / 0x33... / 0x0F... constants are 32 bytes wide (correct for `uint256`).** Unchecked block is safe because each step's max value fits in `uint256`.

### Parameter audit (deployed Base Sepolia values)

From `deployment-phase1b-router-checker-baseSepolia-fast.json`:

| Param | Value | Effect |
|---|---|---|
| `livenessRatio` | `1e15` (`0.001 * 1e18`) | At 1e18-weighted increments, one novel delivery in ≤ 1000 seconds passes liveness |
| `similarityThreshold` | `64` | Quarter of 256 bits — Hamming distance ≥ 64 to be considered novel |
| `similarDecayMultiplier` | `0` | Binary: similar evidence → zero weight |
| `comparisonWindow` | `20` | Compare each new hash against the most recent 20 |

These are reasonable v0 testnet values. Worth noting on the per-channel weights story: the deployed config's `similarDecayMultiplier = 0` means farmers get *zero* increment for similar work — strong gate for the restoration-delivery channel only.

### Concerns surfaced

#### C1 (medium): Unbounded `evidenceHashes` array growth

`evidenceHashes[multisig]` (line 76) grows monotonically — every `recordActivityWithEvidence` and `recordRestorationEvidence` call pushes onto it (line 164, line 185). It is never trimmed.

- **Gas cost per call: bounded.** `_computeNoveltyWeight` only iterates over `comparisonWindow` (20) entries via the `start = len - comparisonWindow` slicing.
- **Storage cost: unbounded.** Each push costs 20k gas (cold SSTORE on a fresh slot), and the array length slot updates. For a long-running operator, this is hundreds of MB of storage over years. **Not an issue for v0 testnet,** but worth a TODO for production: after `comparisonWindow * 2` entries, the older ones are read-dead and should be evictable. A lightweight fix is a circular buffer of size `comparisonWindow`.

#### C2 (medium): Eviction does not claw back `noveltyWeightedCounts`

`isRatioPass` is a pure read used by the OLAS staking contract for liveness. If a service fails liveness and gets evicted by the staking contract, its `noveltyWeightedCounts[multisig]` (and router counters) keep their accumulated values.

Under Architecture B, the JinnClaimEmitter reads these accumulated counters and emits a `ClaimTicket`. **An evicted service can still mint JINN against work it earned before eviction** — which is arguably correct behavior (work is work; eviction only stops *future* OLAS rewards). But the planning doc's framing of "checker is the single gate for is-this-real-work" reads more strictly than this. Worth documenting: eviction is a *forward-only* gate, not retroactive. Already-counted work cannot be challenged after the fact through the existing eviction mechanism.

#### C3 (low): Three of four channels have no anti-farming gate

This is the load-bearing observation for B-single vs B-multi. As of today:

- `creationCount` — incremented unconditionally on every `createRestorationJob` call (router line 152).
- `evaluationCreationCount` — incremented unconditionally on every `createEvaluationJob` call (router line 194).
- `evaluationDeliveryCount` — incremented unconditionally on every `claimDelivery` for evaluation jobs (router line 252). **Note:** the loop-enforcement check on `createEvaluationJob` (line 190) requires that a *prior* restoration delivery was claimed, which provides a soft gate — you can't farm pure evaluation jobs without first farming a restoration delivery (which the checker does gate). But once you have one verified restoration delivery, you can spawn many evaluation jobs and deliveries against derivative restorations.

A concrete attack on Base Sepolia: a single passing restoration delivery unlocks unbounded evaluation creates + delivers, all at full weight. Architecturally this is a Phase B' open question (the v3 doc lists "creation gating" as `l6b`-open). Operationally, the per-channel weight = 1 in `noveltyWeightedCounts`-units (1e18) means each ungated activity earns the same as one *novel* restoration delivery. This is the largest practical attack surface in Architecture B today.

#### C4 (low): `recordActivity` (no-evidence) full-weight path

`recordActivity(multisig, type)` (line 195) is callable by **any address** (no auth check — only the multisig zero-check and type bound). It increments `activityCounts`, `activityCountsByType`, and `noveltyWeightedCounts += 1e18` for the supplied multisig.

Permissionless full-weight increments to `noveltyWeightedCounts` for *any* multisig are problematic if `noveltyWeightedCounts` is the JINN snapshot under B-single. **Mitigation today:** the comment says "backward compatible with V1." On Base Sepolia, if V1 is no longer used and no live caller invokes this, nobody hits it. But there's no on-chain access control. Anyone can call `recordActivity(victimMultisig, 0)` and increment victim's count; under B-single this directly inflates the JINN snapshot for that multisig.

This is the **single most concerning finding** of the audit, *if* B-single is chosen. Under B-multi, the emitter would still read `noveltyWeightedCounts` for the restoration-delivery channel, so this path can also taint that channel — but the inflation is bounded to the restoration channel weight only, and the multisig is identified, so the distributor can clamp or quarantine.

Recommended fix path: gate `recordActivity` on either `authorizedRouter`-only or owner-only. Alternatively, deprecate `recordActivity` and rely solely on `recordRestorationEvidence` and `recordActivityWithEvidence` (the latter is also permissionless — same caveat).

Same caveat applies to `recordActivityWithEvidence` (line 152): permissionless. A spam call with a sufficiently distant evidence hash earns 1e18 weight on victim's behalf.

#### C5 (low): SimHash construction is off-chain and unverified

The contract takes `bytes32 evidenceHash` as input and trusts it to be a SimHash of the off-chain checkpoint data. There is no on-chain proof linking the hash to the actual delivery payload. A cooperating delivering party can submit any `bytes32` they want — including one specifically chosen to maximize Hamming distance from the previous 20 entries.

**Mitigation:** the `bytes32` is committed to the `ActivityRecordedWithEvidence` event, so off-chain auditors can compute the actual SimHash from delivery payloads (which are anchored on IPFS via the marketplace) and challenge if they don't match. This is a social/observability gate, not on-chain.

For v0 testnet this is acceptable. For production, either (a) on-chain SimHash computation from a payload commitment, or (b) ZK proof of correct hash, or (c) optimistic challenge mechanism over the off-chain hash. None of these is in scope for B'.

#### C6 (informational): Comparison window is local-recent, not global-distinct

A patient farmer can stage `comparisonWindow + 1` distinct hashes upfront, then cycle through them — each "looks novel" relative to its 20 most-recent neighbors. With `comparisonWindow = 20`, 21 distinct hashes suffice to evade the gate forever.

**Mitigation in the deployed config:** the actual delivery cadence is bounded by the marketplace's request → delivery loop, which involves a real Mech contract and (in production) real off-chain compute. So the "21 distinct hashes" attack assumes the operator can produce 21 plausible-looking deliveries, which is a higher bar than just calling the contract. But the on-chain gate alone does not prevent the cycling attack.

A global Bloom filter or larger window (e.g. 256) would raise the cost. Out of scope for B'.

## B-single vs B-multi

### B-single

**Shape.** Emitter calls `checker.getMultisigNonces(multisig)` and emits `nonces[1]` (the combined weighted activity). Distributor multiplies by `operatorRatio` / `daoRatio` and mints. Channel weights are baked into `getMultisigNonces`'s 1e18-multiplier per channel.

**Pros.**
- Simplest emitter (one read).
- Smallest cross-chain proof payload (one `uint256` snapshot rather than four).
- Distributor is dead-simple: snapshot in, weighted by two ratios, out.

**Cons.**
- **Channel weights are immutable without redeploying / upgrading the checker.** The checker is not behind a proxy. To retune (e.g. say "creations should weight 0.5x"), we would need to deploy a new checker, point the staking contract at it, point the router at it, and migrate `noveltyWeightedCounts` (or live with discontinuity). This is a meaningful operational burden compared to a Governor `setWeights` proposal on the distributor.
- **C4 directly inflates the JINN snapshot.** `recordActivity` is permissionless and full-weight. Under B-single, anybody can pump any multisig's JINN snapshot.
- **No per-channel observability.** Off-chain consumers wanting to see per-channel breakdowns on the Ethereum side would have to either trust a separate event or read Base directly.

### B-multi

**Shape.** Emitter reads four values and emits all four:

```
emit ClaimTicket(
    serviceId,
    router.creationCount(multisig),
    checker.noveltyWeightedCounts(multisig),     // restoration-delivery, 1e18-scaled
    router.evaluationCreationCount(multisig),
    router.evaluationDeliveryCount(multisig),
    multisig,
    msg.sender
);
```

Distributor stores Governor-mutable weights (`wCreation`, `wRestorationDelivery`, `wEvaluationCreation`, `wEvaluationDelivery`, all initial = 1) and computes:

```
weighted = wCreation * vCreations
         + wRestorationDelivery * (vRestorationNovelty / 1e18)   // re-scale
         + wEvaluationCreation * vEvalCreations
         + wEvaluationDelivery * vEvalDeliveries;
```

(Note the rescale on the restoration channel: `noveltyWeightedCounts` is 1e18-scaled where the router counters are not. Either the distributor divides, or the emitter does, or the weights compensate. Cleanest: emitter divides `noveltyWeightedCounts` by 1e18 before emitting, so all four values share `unit = "verified activity count"`.)

**Pros.**
- **Channel weights live in Governor-mutable distributor state.** Retuning is a Timelock-gated proposal, no checker redeploy.
- **Per-channel events on Ethereum.** Distributor emits with full breakdown; trivial analytics, no parallel pipeline.
- **C4 attack surface bounded.** A pump on `recordActivity` only inflates the restoration-delivery channel under B-multi. The distributor can quarantine that channel via `setWeight(wRestorationDelivery = 0)` without affecting the others.
- Matches the v3 plan's locked weight table exactly (`wCreation = wRestorationDelivery = wEvaluationCreation = wEvaluationDelivery = 1`).

**Cons.**
- Slightly larger event payload (4 uint256 + addresses).
- Slightly larger cross-chain proof.
- Distributor has 4 weight params instead of 0 (vs. B-single's "weights baked in checker").

### Recommendation

**Ship B-multi for v0.** Reasons in priority order:

1. **C4 (permissionless `recordActivity`) is the largest concrete risk in this audit.** B-multi limits the blast radius to one channel; B-single makes it a full-snapshot pump.
2. **Channel-weight retuning is a real near-term operational need.** The v3 plan explicitly notes weights might change once we see operator behavior (per-channel attacks may surface). Keeping weights in distributor state rather than checker code makes retuning a single Governor proposal instead of an OLAS-coupled redeploy + checker swap.
3. **Per-channel observability on Ethereum is essentially free under B-multi** and considerably more expensive otherwise (a separate cross-chain reporter or operator-side aggregator).
4. **B-multi is what the v3 plan literally describes.** The Recommendation v3 sketch (planning doc lines 525–568) emits four values and has `wCreation` etc. on the distributor. B-single is technically also "Architecture B" but is a divergence from the locked sketch.

The v0 emitter under B-multi is still ~30 lines stateless. The complexity delta vs. B-single is one extra view call on Base and three extra `uint256` storage slots on Ethereum.

## Required changes

### To the V2 checker

**For B-multi: none.** All required state is already public. The four signals are accessible as:

- `IJinnRouter(router).creationCount(multisig)`
- `IRestorationActivityCheckerV2(checker).noveltyWeightedCounts(multisig)`
- `IJinnRouter(router).evaluationCreationCount(multisig)`
- `IJinnRouter(router).evaluationDeliveryCount(multisig)`

**Optional hardening (recommend deferring to a separate task, not blocking B'):**

1. **Restrict `recordActivity` and `recordActivityWithEvidence` to `authorizedRouter` (or owner).** Closes C4. Backwards-incompatible with any V1-style external caller. We believe nothing external still calls these on Base Sepolia, but worth confirming via event log scan before tightening. *Suggested as a follow-up task; not part of B'.*
2. **Bound `evidenceHashes` array growth** (C1) via circular buffer of size `comparisonWindow`. Reduces storage growth from `O(deliveries)` to `O(window)`. *Defer to production hardening.*

### To `JinnRouterV2`

**None.** All four counter mappings are already public. The router's role under Architecture B is unchanged: it tags requests, increments raw counters, and forwards restoration evidence to the checker.

### To the JinnClaimEmitter (new contract on Base Sepolia)

**Read four values from two contracts.** ~30 lines stateless. ABI on the two existing contracts is enough.

```solidity
contract JinnClaimEmitter {
    IJinnRouter public immutable router;
    IRestorationActivityCheckerV2 public immutable checker;
    IServiceRegistry public immutable serviceRegistry;

    event ClaimTicket(
        uint256 indexed serviceId,
        uint256 creations,
        uint256 verifiedRestorationDeliveries,  // already divided by 1e18 if so chosen
        uint256 evaluationCreations,
        uint256 evaluationDeliveries,
        address indexed multisig,
        address indexed claimer
    );

    function emitClaim(uint256 serviceId) external {
        address multisig = serviceRegistry.mapServices(serviceId).multisig;
        uint256 verifiedRestoration = checker.noveltyWeightedCounts(multisig) / 1e18;
        emit ClaimTicket(
            serviceId,
            router.creationCount(multisig),
            verifiedRestoration,
            router.evaluationCreationCount(multisig),
            router.evaluationDeliveryCount(multisig),
            multisig,
            msg.sender
        );
    }
}
```

Key emitter design decision: **divide `noveltyWeightedCounts` by 1e18 in the emitter** so that all four `ClaimTicket` fields share the same unit ("verified activity count"). This keeps the distributor weight math symmetric and avoids the wart of one-channel-is-1e18-scaled.

Caveat: the divide-by-1e18 truncates fractional similarity weight if `similarDecayMultiplier > 0` and similar deliveries land. On the deployed config, `similarDecayMultiplier = 0` so this never matters. If a future config sets `similarDecayMultiplier > 0`, the emitter should preserve the 1e18 scaling and the distributor should divide instead. *Action: pick one and document it in the cross-chain spec.*

### To the JinnDistributor (Ethereum, new contract under `olx`)

Per v3 plan §"v3 decisions table" entry 5: four Governor-mutable per-channel weights, all initial = 1. Plus `operatorRatio` / `daoRatio` already locked. No eligibility gate. ~80 lines.

## Open questions for `l6b`

These all directly affect the cross-chain spec and must be resolved before deploying the emitter or distributor.

1. **`noveltyWeightedCounts` rescaling.** Where does the divide-by-1e18 happen — emitter or distributor? Picking emitter is cleaner *if* `similarDecayMultiplier` stays at 0; picking distributor preserves precision under non-binary decay. **Recommend:** pick distributor and pass the four fields with their native scales (`creationCount` scale 1, `noveltyWeightedCounts` scale 1e18, `evaluationCreationCount` scale 1, `evaluationDeliveryCount` scale 1) in the ClaimTicket; distributor explicitly divides the restoration channel by 1e18 before applying weights. Documents the asymmetry.

2. **`recordActivity` permissionlessness (C4).** Do we accept the risk, restrict it, or deprecate? Before deploying the emitter, scan Base Sepolia event logs for `ActivityRecorded` from non-router callers; if zero, cheap to restrict. If non-zero, document and fix in next checker version.

3. **Eviction semantics (C2).** Does the cross-chain spec acknowledge that an evicted service can still mint against pre-eviction work? If yes, the distributor needs no extra logic. If we want eviction to retroactively zero pending JINN, the distributor needs an eviction-aware path (and the checker needs to expose evict status, which today it does not).

4. **Replay window between `emitClaim` calls.** Distributor accumulators handle this for monotonic counters, but `emitClaim` is currently permissionless. Should it be rate-limited per service? Rate-limiting on Base costs gas and adds state; trusting the distributor's accumulator makes spam emits free for the spammer (just gas) but harmless to JINN economics.

5. **Per-channel weight initial values.** The plan locks 1/1/1/1. Given C3 (three channels are fully ungated), should the initial restoration-delivery weight be higher than the others (e.g. 4/1/1/1) so farming the ungated channels yields proportionally less? **Recommend:** ship 1/1/1/1 per the lock; quarantine via Governor proposal if farming surfaces.

6. **Multisig source.** The emitter sketch reads multisig from `IServiceRegistry.mapServices(serviceId).multisig`. The deployed staking contract's `mapServiceInfo` also stores multisig. Either works; pick one for the spec.

## Test recommendations

These are the test additions the contracts repo should ship before deploying the emitter (i.e., before mainnet, but ideally also before redeploying anything on Base Sepolia for B-multi).

### V2 checker hardening tests (new in `cargo/contracts/test/phase1/Antifarming.test.ts`)

1. **`recordActivity` permissionless inflation.** A non-router, non-owner address calls `recordActivity(victimMultisig, 0)` and increases `noveltyWeightedCounts[victimMultisig]` by 1e18. **Failing test that documents C4** until C4 is mitigated; passing test (revert) once C4 is fixed.
2. **`recordActivityWithEvidence` permissionless novelty pump.** Same shape as above with a fresh hash; weight = 1e18.
3. **Eviction does not roll back counters.** Stage two checkpoints with low activity in between → `isRatioPass` returns false → `noveltyWeightedCounts` remains at its accumulated value.
4. **Cycling-evasion attack.** Stage 21 distinct hashes (one beyond `comparisonWindow`); cycle through them; verify `_computeNoveltyWeight` returns 1e18 every time (documents C6).
5. **`getMultisigNonces` math under live router.** Set up an integration fixture with a router emitting `creationCount = 3`, `evaluationCreationCount = 2`, `evaluationDeliveryCount = 4`, and `noveltyWeightedCounts = 5e18`; assert `nonces[1] == 9 * 1e18 + 5e18 == 14e18`.
6. **`getMultisigNonces` standalone fallback.** With `jinnRouter == address(0)` (separately-deployed standalone checker), assert `nonces[1] == noveltyWeightedCounts`.
7. **Bound check on `_hammingDistance`.** All-zero vs all-one bytes32 → 256. Random pairs → matches an off-chain reference popcount.

### JinnRouterV2 + checker integration (extend `JinnRouterV2Integration.test.ts`)

8. **Evaluation delivery ungated.** Submit 100 evaluation deliveries with no novelty constraint; verify all increment `evaluationDeliveryCount` at full rate (documents C3 for the test plan).
9. **Loop enforcement.** `createEvaluationJob` reverts if the referenced restoration was not delivered + claimed; passes after a successful restoration claim.
10. **Restoration delivery without evidence hash.** Pass `bytes32(0)` to `claimDelivery`; assert `restorationDeliveryCount` increments but `noveltyWeightedCounts` does not. Confirms the conditional at router line 247.

### Emitter tests (new file once B' lands implementation)

11. **Snapshot equals four-channel read.** Mock router + checker, set known values, call `emitClaim(serviceId)`, parse event, assert each field matches.
12. **Multiple `emitClaim` calls are safe** (monotonicity of underlying counters).
13. **`emitClaim` is permissionless** — anyone can call.
14. **Restoration channel rescale.** With `similarDecayMultiplier > 0` and a similar-evidence delivery, the restoration field on the event should reflect the chosen scale (per `l6b` resolution Q1).

### Distributor tests (in `olx` scope, not B')

These are mentioned for completeness; out of scope here. Per-channel weighted-sum math, weight setter Timelock-gating, accumulator clamp on weight decrease.

## Appendix: trace through Architecture B with example values

To make the recommendation concrete, suppose service `S` has multisig `M`, and over a week:

- Operator creates 3 restoration jobs → `creationCount[M] = 3`.
- Operator delivers 3 restoration jobs with novel evidence (Hamming distance > 64 from each other) → `restorationDeliveryCount[M] = 3` (router) and `noveltyWeightedCounts[M] = 3 * 1e18 = 3e18` (checker).
- Operator creates 3 evaluation jobs → `evaluationCreationCount[M] = 3`.
- Operator delivers 3 evaluation jobs → `evaluationDeliveryCount[M] = 3`.

Under **B-multi** (recommended):

```
ClaimTicket(serviceId=S,
    creations=3, verifiedRestorationDeliveries=3,
    evaluationCreations=3, evaluationDeliveries=3,
    multisig=M, claimer=op)
```

Distributor with weights all = 1:
```
weighted = 3 + 3 + 3 + 3 = 12 (verified activity units)
entitledOperator = 12 * operatorRatio / 1e18
entitledDao      = 12 * daoRatio / 1e18
```

If a Governor proposal later sets `wRestorationDelivery = 4`, the same data would yield `weighted = 3 + 4*3 + 3 + 3 = 21`. The accumulator clamp ensures monotonicity even across weight changes.

Under **B-single**, the same operator's snapshot would be `nonces[1] = (3 + 3 + 3) * 1e18 + 3e18 = 12e18`, divided down to `12` by the distributor — same outcome at 1/1/1/1, but no path to retune.

---

End of audit.
