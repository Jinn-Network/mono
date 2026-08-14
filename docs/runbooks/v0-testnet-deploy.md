# v0 Testnet Deploy Runbook

> Status: ready
> Date: 2026-04-29
> Branch: `jinn-mono/jinn-mono-1bo`
> Coordinator: human operator (you) executes commands; agent verifies at each step.

This is the step-by-step deploy guide for the Jinn v0 MVI testnet rollout. It covers:

1. **Phase 1 — `pwg` ops** — fresh V2.1 router + checker on Base Sepolia (with C4/C1 hardening + ε creation gating).
2. **Phase 2 — `r5z` Phase A** — v0 L1 stack on Sepolia (JINN + Distributor + Governor + Timelock + MockMessenger + CanonicalOpStackMessenger).
3. **Phase 3 — `r5z` Phase B** — JinnClaimEmitter on Base Sepolia.
4. **Phase 4 — wiring** — sync artifacts, transfer MockMessenger ownership, daemon config.
5. **Phase 5 — burn-in start** — daemon online, first claim cycle.

Each phase has a *verify gate* before the next. Don't skip them.

---

## Pre-flight

### Balances (live as of 2026-04-29)

| Wallet | Network | Balance | Floor |
|---|---|---|---|
| Deployer `0x15e78734481bD31F6e183dad05225505a45ACd07` | Sepolia | ~0.52 ETH | 0.05 |
| Deployer | Base Sepolia | ~0.002 ETH | 0.001 (typical gas effectively zero) |
| Daemon agent `0xAab1084B3Fdf1AEB81c85CCE099a307A5a27FC7e` | Sepolia | 0.05 ETH | 0.05 |
| Daemon agent | Base Sepolia | ~0.005 ETH | 0.001 |

If any drop below floor mid-run, top up via faucet (Sepolia: Alchemy / portal.cdp.coinbase.com switched to Ethereum Sepolia; Base Sepolia: CDP via the bootstrap drip loop).

### Env vars (set once for the whole run)

```bash
export DEPLOYER_PRIVATE_KEY=<from cargo/contracts/.env>
export SEPOLIA_RPC_URL=https://ethereum-sepolia.publicnode.com
export BASE_SEPOLIA_RPC_URL="<Tenderly URL from cargo/client/.env>"
export JINN_MVI_TIMING_PROFILE=fast-test       # all governance delays compressed to minutes
export JINN_MVI_MOCK_MESSENGER_OWNER=0xAab1084B3Fdf1AEB81c85CCE099a307A5a27FC7e   # daemon agent
```

`JINN_PASSWORD` for the daemon (`envelope-v1-2026-04-26`) lives in `~/.jinn-client/.env.testnet` and is sourced when running the daemon — NOT needed for the deploy scripts.

### Sanity-check current branch

```bash
cd cargo
git status                       # should be on jinn-mono/jinn-mono-1bo, clean
git log --oneline -5             # latest commit a8c1d9bb or similar (Azul + audit-fix work landed)
cd contracts
yarn install --immutable
yarn compile                     # clean
yarn test                        # 438 passing
```

If anything fails → STOP. Don't proceed until the working tree is green against the locked-in audit-fix surface.

---

## Phase 1 — `pwg` ops (Base Sepolia)

Fresh V2.1 deploy. The `JinnRouterProxy` is non-upgradeable, so this deploys a NEW proxy + new V2.1 implementation. Existing service 33's staking on the OLD proxy is untouched but irrelevant going forward.

### Step 1.1 — capture the existing V2 storage layout (drift baseline)

```bash
cd cargo/contracts
forge inspect src/staking/JinnRouterV2.sol:JinnRouterV2 storage-layout --json | tee /tmp/jinnrouterv2-storage-pre-pwg.json
forge inspect src/staking/RestorationActivityCheckerV2.sol:RestorationActivityCheckerV2 storage-layout --json | tee /tmp/checkerv2-storage-pre-pwg.json
```

Verify: `JinnRouterV2.creators` is at slot 12 (per `storage-layout.test.ts`).

```bash
yarn test -- --grep "storage-layout drift guard"
# all pins pass
```

### Step 1.2 — deploy V2.1 router + checker on Base Sepolia

```bash
cd cargo/contracts
PHASE1A_TIMING_PROFILE=fast-test \
MECH_DEPLOYMENT_PATH=$(pwd)/deployment-phase1b-mech-baseSepolia-fast.json \
L2_DEPLOYMENT_PATH=$(pwd)/deployment-phase1a-l2-baseSepolia-fast.json \
npx hardhat run scripts/deploy-phase1b-router-checker.ts --network baseSepolia
```

Expected output (last lines):
```
=== Deployment Summary ===
  activityChecker          0x...
  jinnRouterV2Impl         0x...
  jinnRouterProxy          0x...
  mechMarketplace          0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7
Deployment artifact written to: contracts/deployment-phase1b-router-checker-baseSepolia-fast.json
```

The script will also create a **new staking proxy** via the existing StakingFactory (step 5 in its log).

### Step 1.3 — verify post-deploy state

```bash
# read the new artifact
cat deployment-phase1b-router-checker-baseSepolia-fast.json | jq '.contracts'

# confirm the new V2.1 proxy points at the new V2.1 impl
cast call --rpc-url $BASE_SEPOLIA_RPC_URL <jinnRouterProxy> "getImplementation()(address)"
# returns <jinnRouterV2Impl>

# confirm slot 12 is creators on the new V2.1 proxy
cast storage --rpc-url $BASE_SEPOLIA_RPC_URL <jinnRouterProxy> 12
# (should be empty mapping at this point, but the slot exists)
```

Note the three new addresses — they feed Phase 3.

### Step 1.4 — re-bootstrap the daemon onto the new staking proxy

This re-registers a **fresh service** under your existing master/agent/safe keys (per the runbook decision: keep keys, fresh service id).

Edit `~/.jinn-client/.env.testnet`:

```diff
- JINN_EARNING_DIR=/Users/adrianobradley/.jinn-client/earning-envelope-v1-2026-04-26
+ JINN_EARNING_DIR=/Users/adrianobradley/.jinn-client/earning-v0-2026-04-29
```

Then bootstrap:

```bash
set -a; source ~/.jinn-client/.env.testnet; set +a
cd cargo/client
yarn jinn run --bootstrap-only
# Walks the 11-step state machine. Steps 1-4 are no-ops because master+safe already exist.
# Steps 5-10 register the fresh service id, deploy a fresh mech, stake on the new V2.1 proxy.
```

Capture the new `serviceId`, `mech` from `~/.jinn-client/earning-v0-2026-04-29/earning_state.json`.

**Verify:** the daemon can read non-zero counters from the new V2.1 router (initially zero — that's expected for a fresh service). The bootstrap should show `state: complete` at the end.

---

## Phase 2 — `r5z` Phase A (Sepolia L1 deploy)

### Step 2.1 — deploy the v0 L1 stack

```bash
cd cargo/contracts
JINN_MVI_TIMING_PROFILE=fast-test \
JINN_MVI_MOCK_MESSENGER_OWNER=0xAab1084B3Fdf1AEB81c85CCE099a307A5a27FC7e \
npx hardhat run scripts/deploy-jinn-mvi-l1.ts --network sepolia
```

Expected output (last lines):
```
[verifyDeploy] All post-deploy invariants verified.
=== Deployment Summary ===
  JINN               0x...
  TimelockController 0x...
  JinnGovernor       0x...
  Messenger          0x... (mode=mock)
  JinnDistributor    0x...
Deployment written to: contracts/deployment-jinn-mvi-l1-sepolia-fast.json
```

The MockMessenger ownership is automatically transferred to `0xAab1...` (daemon agent) in the same script.

### Step 2.2 — verify

The script's `verifyDeploy` block already asserts:
- `jinn.minter() == distributor`
- `distributor.messenger() == mockMessenger`
- `distributor.daoTreasury() == timelock`
- `jinn.pendingOwner() == timelock`
- `distributor.pendingOwner() == timelock`
- `timelock.hasRole(PROPOSER_ROLE, governor) == true`
- `timelock.hasRole(EXECUTOR_ROLE, governor) == true`
- `timelock.hasRole(CANCELLER_ROLE, governor) == true`

Spot-check one externally:

```bash
ARTIFACT=deployment-jinn-mvi-l1-sepolia-fast.json
cast call --rpc-url $SEPOLIA_RPC_URL \
  $(jq -r '.contracts.MockMessenger' $ARTIFACT) "owner()(address)"
# returns 0xAab1084B3Fdf1AEB81c85CCE099a307A5a27FC7e (daemon agent)
```

If anything fails → STOP. Read the script log for the failed invariant.

---

## Phase 3 — `r5z` Phase B (Base Sepolia L2 emitter)

### Step 3.1 — deploy the JinnClaimEmitter

Use the **new** V2.1 checker + router from Phase 1.

```bash
cd cargo/contracts
JINN_MVI_L2_ARTIFACT_PATH=$(pwd)/deployment-phase1b-router-checker-baseSepolia-fast.json \
JINN_MVI_L2_REGISTRY=0x31D3202d8744B16A120117A053459DDFAE93c855 \
npx hardhat run scripts/deploy-jinn-mvi-l2.ts --network baseSepolia
```

Expected output (last lines):
```
=== Deployment Summary ===
  JinnClaimEmitter   0x...
  tx                 0x...
Deployment written to: contracts/deployment-jinn-mvi-l2-baseSepolia.json
```

The constructor's storage-layout invariant fires here: `claimSnapshotHashes.slot == 1` is asserted at deploy time.

### Step 3.2 — verify

```bash
ARTIFACT=deployment-jinn-mvi-l2-baseSepolia.json
EMITTER=$(jq -r '.contracts.JinnClaimEmitter' $ARTIFACT)

cast call --rpc-url $BASE_SEPOLIA_RPC_URL $EMITTER "checker()(address)"          # = V2.1 checker
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $EMITTER "router()(address)"           # = V2.1 router proxy
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $EMITTER "serviceRegistry()(address)"  # = 0x31D3...
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $EMITTER "nextClaimId()(uint256)"      # = 0
```

---

## Phase 4 — wiring + daemon config

### Step 4.1 — sync deploy artifacts into the client package

```bash
cd cargo/client
./scripts/sync-deployments.sh   # copies the new artifacts into the bundled deployments
```

Verify: `client/deployments/` now contains `deployment-jinn-mvi-l1-sepolia.json` and `deployment-jinn-mvi-l2-baseSepolia.json`.

### Step 4.2 — update daemon config

Edit `~/.jinn-client/.env.testnet`:

```diff
+ JINN_ETHEREUM_RPC_URL=https://ethereum-sepolia.publicnode.com
+ JINN_L1_NETWORK=sepolia
+ JINN_DISTRIBUTOR_ADDRESS=<from L1 artifact .contracts.JinnDistributor>
+ JINN_CLAIM_EMITTER_ADDRESS=<from L2 artifact .contracts.JinnClaimEmitter>
+ JINN_MESSENGER_ADDRESS=<from L1 artifact .contracts.MockMessenger>
+ JINN_MESSENGER_MODE=mock
+ JINN_CLAIM_LOOP_INTERVAL_MS=600000           # 10 min during burn-in (default 1h)
```

The daemon's L1 wallet automatically uses the same key as L2 (agent EOA `0xAab1...`).

### Step 4.3 — (optional) execute first Governor proposal: `acceptOwnership`

The deploy left JINN + JinnDistributor with `pendingOwner == TimelockController`. The Timelock must call `acceptOwnership()` on each, via a Governor proposal. Until then, governance setters (`setMessenger`, `setRatios`, `setWeights`, etc.) are unreachable.

This is OPTIONAL for kicking off burn-in (the daemon can claim against MockMessenger without governance), but you'll want it before the burn-in's "Governor proposal exercise" criterion.

Outline (full proposal flow lives in `cargo/docs/runbooks/jinn-governor-handover.md` if it exists; otherwise script via `cast send` + `governor.propose() / vote / queue / execute`):

1. Build proposal calldata: `[JINN.acceptOwnership(), JinnDistributor.acceptOwnership()]`
2. `governor.propose(targets, values, calldatas, "Accept ownership of JINN + JinnDistributor")`
3. Wait `votingDelay` (60s on fast-test).
4. `governor.castVote(proposalId, 1)` from the deployer (sole voter — deployer has all the JINN minted).
5. Wait `votingPeriod` (600s on fast-test).
6. `governor.queue(targets, values, calldatas, descriptionHash)`
7. Wait `timelockMinDelay` (60s on fast-test).
8. `governor.execute(targets, values, calldatas, descriptionHash)`

Verify: `JINN.owner() == timelock` and `JinnDistributor.owner() == timelock` (no longer `pendingOwner`).

This proposal also satisfies the burn-in's "Governor proposal exercise" gate.

---

## Phase 5 — burn-in start

### Step 5.1 — start the daemon

```bash
set -a; source ~/.jinn-client/.env.testnet; set +a
cd cargo/client
yarn jinn run
```

> **Superseded.** Steps 2–3 below, and Step 5.2's claim cycle, describe the v0 JINN-token
> stack as it stood on 2026-04-29. DR-2026-06-30 (tokenless, OLAS-native) dropped the JINN
> token and deleted `JinnClaimLoop`; Wave-4 D1 deleted the TaskEngine behind the
> creator/solver/delivery-watcher shape. On a current client the loop set is conditional on
> vertical mode and config — see [`client/ARCHITECTURE.md`](../../client/ARCHITECTURE.md) §6 —
> and rewards settle through the stOLAS reward-claim loop. Kept as the record of that deploy.

The daemon should:
1. Read existing earning state (`earning-v0-2026-04-29/earning_state.json`) — bootstrap is already complete.
2. Start the three loops: creator, solver, delivery-watcher (Phase 0 mech work).
3. Start the `JinnClaimLoop` (new in v0): periodic `emitClaim` on Base Sepolia → fixture+claim on Sepolia.

### Step 5.2 — confirm the first claim cycle (within ~10 min)

Watch the daemon log for:
```
[jinn-claim-loop] emit: serviceId=N, claimId=1, txHash=0x...
[jinn-claim-loop] mock fixture planted on Sepolia
[jinn-claim-loop] claim submitted: txHash=0x...
[jinn-claim-loop] mint observed: <amount> JINN to operator multisig
```

Verify on-chain:

```bash
DIST=$(jq -r '.contracts.JinnDistributor' deployment-jinn-mvi-l1-sepolia-fast.json)
SAFE=0x00f650DE6bF482De0f4744104D2061075a0e9494   # operator multisig (existing safe)

# Should be a positive number after the first cycle (or 0 if counters are still zero)
cast call --rpc-url $SEPOLIA_RPC_URL \
  $(jq -r '.contracts.JINN' deployment-jinn-mvi-l1-sepolia-fast.json) \
  "balanceOf(address)(uint256)" $SAFE
```

If the first cycle no-ops because counters are still zero (fresh service, no activity yet), the daemon's normal Phase 0 mech loops will start generating activity (creations / deliveries / evaluations). Subsequent claim cycles should start minting JINN once the V2.1 router's counters move.

### Step 5.3 — burn-in success criteria (track over 24-48h)

Per the agreed criteria:
- ✅ ≥10 successful claim cycles
- ✅ ≥1 successful Governor proposal (Step 4.3 counts if performed)
- ✅ 0 unexpected reverts in claim path
- 🟡 Canonical canary verification (run `scripts/verify-canonical-canary.ts` against an existing emit tx; succeeds at the 7-day OP finality mark; can be deferred until after burn-in completes)

Track via:
```bash
# Tail the daemon log + grep claim outcomes
tail -f /Users/adrianobradley/.jinn-client/jinn.log | grep "jinn-claim"

# Periodic check of cumulative JINN minted to the operator safe
watch -n 300 "cast call --rpc-url \$SEPOLIA_RPC_URL <JINN> 'balanceOf(address)(uint256)' $SAFE"
```

---

## Rollback / abort

If anything goes wrong mid-run:

- **During Phase 1**: just abort. Existing service 33 is untouched on the old V2 proxy. Nothing to undo.
- **During Phase 2**: abort, fix, re-deploy. The Sepolia deploy is the only state. No ownership has been handed off yet (Timelock has `pendingOwner` only).
- **During Phase 3**: abort. The L2 emitter is standalone; not yet referenced by anything on L1.
- **During Phase 4-5**: stop the daemon. Existing on-chain state is fine — it just sits idle. Re-config + re-start.

Hard-stop kill switch (post-handover): a Governor proposal of `setRatios(0, 0)` + `setWeights(0, 0, 0)` halts all future mints (~30 min on fast-test profile, ~3 days on canonical). Recovery via subsequent proposal restoring sane values.

---

## Appendix — addresses captured during the run

(Fill in as you go.)

| Phase | Contract | Address |
|---|---|---|
| 1 | RestorationActivityCheckerV2 (V2.1) | |
| 1 | JinnRouterV2 implementation (V2.1) | |
| 1 | JinnRouterProxy (V2.1) | |
| 1 | New mech (for fresh service) | |
| 1 | New service id | |
| 2 | JINN | |
| 2 | TimelockController | |
| 2 | JinnGovernor | |
| 2 | MockMessenger | |
| 2 | CanonicalOpStackMessenger | |
| 2 | JinnDistributor | |
| 3 | JinnClaimEmitter | |
