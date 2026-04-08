# Phase 1a: JINN Tokenomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a working JINN token → treasury → bridge → staking distribution flow on Sepolia + Base Sepolia by forking OLAS contracts with minimal modifications.

**Architecture:** Fork OLAS governance (token), tokenomics (Treasury, Dispenser, Tokenomics, Depository), and registries (StakingToken) contracts. Change token name/symbol to JINN. Deploy all contracts on Sepolia (L1) and Base Sepolia (L2) with an end-to-end deployment script. The OLAS contracts have circular constructor dependencies (Treasury↔Tokenomics↔Dispenser) — resolve with two-phase init pattern. Unused features (bonding, registries, developer rewards) are deployed but never called. Client daemon gets testnet config to claim JINN rewards.

**Tech Stack:** Solidity 0.8.25, Hardhat, ethers.js v6, TypeScript, OP Stack canonical bridge (Sepolia ↔ Base Sepolia)

**Spec:** `spec/2026-04-06-phase-1a-design.md`

**OLAS source repos:**
- Token: `github.com/valory-xyz/autonolas-governance` → `contracts/OLAS.sol`
- Tokenomics: `github.com/valory-xyz/autonolas-tokenomics` → `contracts/Tokenomics.sol`, `Treasury.sol`, `Dispenser.sol`, `Depository.sol`
- Registries/Staking: `github.com/valory-xyz/autonolas-registries` → `contracts/staking/StakingBase.sol`, `StakingToken.sol`
- Bridge: `github.com/valory-xyz/autonolas-tokenomics` → `contracts/staking/OptimismDepositProcessorL1.sol`, `OptimismTargetDispenserL2.sol`
- Gauge: `github.com/valory-xyz/autonolas-governance` → `contracts/VoteWeighting.sol`

**Live rollout addendum (repo state after factory-backed L2 + bridge scripts):** The checklist in **Task 13** below is the authoritative manual sequence for testnet. Earlier tasks in this document describe the original vendoring and script layout; several script names and steps have been extended (L2 token factory, two-network bridge deploy, governance helpers, `status-phase1a-live.ts`). If Task 13 disagrees with an older bullet elsewhere in this file, prefer Task 13.

### Live rollout status snapshot (2026-04-07)

What is deployed on testnet right now:

- **L1 tokenomics stack on Sepolia** is deployed from the earlier owner/governance wallet `0x443ad8619a9aa37d08c5ef7846B3B0Cf66efffE7`:
  - `JINN`: `0x95A0d0E40Ea5F85968dF9eF43e9E4a37D6C8b8a0`
  - `Dispenser`: `0xB9485266348C49918842BF7152dbE76d36bb9A3D`
  - `VoteWeighting`: `0x63a5603dA74AD4dFa3248D90E6BaE93668D0D5ba`
- **L2 bridge-compatible JINN representation on Base Sepolia** exists at `0xB1341d11112fE68AF2A4b41E6decA64DDb2720fA`.
- **L2 staking stack on Base Sepolia** is deployed from the current deployer wallet `0x15e78734481bD31F6e183dad05225505a45ACd07`:
  - `activityChecker`: `0x6a10Ac40F7c73B340584fAEC9A0A4D86935AF41d`
  - `stakingFactory`: `0xc69e06C2BF3d2e5B546Db5b75FE549750746bB83`
  - `stakingImplementation`: `0x50Aab4ab6A3663D5B4252e52A278a6F9d8c4d2ca`
  - `stakingToken`: `0x06a400Ea71861d44fE86de568A905e036C7A1065`
- **Bridge adapters** are deployed and linked:
  - `depositProcessorL1`: `0x5472c1f5482F5e93740E3D3F00f46121A0f5365E`
  - `targetDispenserL2`: `0x6Fb33bFC2c273DEf54a1D28Ca168faAD2d445261`

What we discovered during the live rollout:

- The deployer key `0x15e7...` was sufficient for **deploying** the L2 stack and bridge pair, but it is **not** the owner of the Sepolia `Dispenser`, `VoteWeighting`, or `Treasury`. Those are owned by `0x443a...`.
- That means the remaining activation steps are **governance actions**, not deploy actions:
  - map Base Sepolia to the new deposit processor
  - set dispenser pause state so staking incentives are allowed
  - add the staking proxy as a nominee
  - vote weight to the nominee
- The current deployer also has **no L1 JINN balance** and **no veJINN lock**, so it cannot create or cast the required vote even if ownership checks were bypassed.
- As a result, the testnet stack is **infra-deployed but not governance-activated**. `status-phase1a-live.ts` currently reports the expected blockers:
  - deposit processor mapping unset
  - staking incentives paused on L1
  - L2 target dispenser still paused
  - nominee not registered
  - relative weight zero
  - nominee bookmark zero

Do **not** summarize the current state as "Phase 1a is now fully deployed on testnet and only the bridge flow remains unknown." A more accurate summary today is:

- core L1 contracts, L2 staking contracts, and bridge adapters are deployed on Sepolia/Base Sepolia
- the **cross-chain JINN claim/distribution path has not been exercised end-to-end**
- the stack is **blocked on owner/governance actions from `0x443a...`** before claim testing can begin
- after those governance actions, the next unknown is still the real emit -> bridge -> distribute -> claim cycle over live epochs

### Live rollout status snapshot (2026-04-08)

What changed since the 2026-04-07 snapshot:

- The split-owner Sepolia/Base Sepolia rollout was replaced with a fresh coherent deployment under the operator key `0x15e78734481bD31F6e183dad05225505a45ACd07`.
- The canonical deployment artifacts now point at the new stack:
  - `contracts/deployment-phase1a-sepolia.json`
    - `JINN`: `0x8042063aBAce92B8BAF92C1E219D2D03DB59De45`
    - `Dispenser`: `0x61Fe7eF2121F1ce62d6BB4bB476465559b59A7f3`
    - `VoteWeighting`: `0xb737040B53eb413AE528EB45F45ED3Bbb886fAB8`
    - `Treasury`: `0x99BAc2Df16562986f3d197A5aae05bcf1A56f3B6`
  - `contracts/deployment-phase1a-token-baseSepolia.json`
    - `l2Token`: `0x4F177E56bd79c169742a1BF8907dB0A5e54F5524`
  - `contracts/deployment-phase1a-l2-baseSepolia.json`
    - `activityChecker`: `0xDB5e6cc6Fb4423e1899415D86e8f0B197673dd0b`
    - `stakingFactory`: `0xaFE21C6dBeF2d41A769F58CE068aa991369FB1e0`
    - `stakingToken`: `0xe9c8DaBb4062deEc921562e7E286be3cEcb826b0`
  - `contracts/deployment-phase1a-bridge-sepolia-baseSepolia.json`
    - `depositProcessorL1`: `0x89744248dCb16964Cb709429c29597A18dE11309`
    - `targetDispenserL2`: `0x98be6DC1c90B76d187bf92b13fccD70bbEd0C29B`

Operator actions completed on the new stack:

- Base Sepolia was mapped to the new deposit processor.
- The L1 dispenser was unpaused for staking incentives.
- The Base Sepolia staking proxy was added as a nominee.
- veJINN voting was configured from the operator-controlled wallet.
- `100 JINN` was bridged to Base Sepolia, and the staking proxy was seeded with `50 JINN` reward liquidity.

Bootstrap investigation and fixes completed:

- The client bootstrap was not failing because “Base Sepolia is unreliable” in the abstract. It had two concrete bugs:
  - `client/.env` `BASE_RPC_URL` was overriding explicit testnet config, so `network: "testnet"` runs were accidentally using a Base mainnet RPC in `client/src/config.ts`.
  - The persisted predicted Safe address was trusted across reruns even when the chain/RPC context changed, which broke testnet because Safe CREATE2 prediction is chain-specific.
- A third client bug made `stopAt: "service_staked"` exit one step early, immediately after service deployment and before the actual staking transaction.
- A fourth client bug undercounted token funding: the Safe needs enough JINN for both service activation and agent registration, so the bootstrap now requires `2 * bondAmount` before it claims the service can proceed.
- A fifth client bug relied on Safe SDK execution for `stake()`. On Base Sepolia that path still reverted even when the underlying staking call was valid. `stake()` now uses a direct Safe `execTransaction` path instead.
- These were fixed in:
  - `client/src/config.ts`
  - `client/src/earning/bootstrap.ts`
  - `client/src/earning/safe-adapter.ts`
  - `client/src/main.ts`
  - `client/test/config.test.ts`
  - `client/test/earning/bootstrap.test.ts`

Live Base Sepolia service state now:

- Agent EOA: `0x376cAfEC9d1744b0A826409DB593a597cD436573`
- Correct testnet Safe: `0xCE377821Ff921Cb917484C391eBFd83220470188`
- Service id: `11`
- Staking contract: `0xe9c8DaBb4062deEc921562e7E286be3cEcb826b0`
- Persisted bootstrap state: `mech_deployed` in `/tmp/jinn-phase1a/earning/earning_state.json`, meaning the service is created, activated, registered, deployed, and staked, and testnet intentionally stopped before mech deployment.

Relevant live Base Sepolia transactions:

- Corrected Safe bond top-up: `0xf2a002bf59eda452716fe687274ecac0d0705308f950fea6504ccfb592d5db3f`
- Service create: `0x56837270c5a489fefa54f6a402211b552568a60ffdcc7d53c03339ee0e5d21be`
- Service activate (successful): `0x3618f5bbc0be59c774561b157285776322b3222797370c0e0dfee4b932cf1f86`
- Agent register (successful): `0x6e0d9dba7cfdb8b2496e9e47ce011261cb8523009199a531e2ea5591c5ee461b`
- Service deploy (successful): `0xbbcd3df1b21888f01346a153771de5ad79c9671daf23e64039b6b6e1a462bcf9`
- NFT approve for staking: `0xc20b53e9b0c0aa33fb182155fa4804559fbd8d1b9ffbfbcf118aa2beaeb49c2d`
- Service stake (successful direct Safe execution): `0x5ddc3a1eb5bd543e36516d8cf1ec71ae01fab5dcd451c2db4169fcfeea82ccbf`
- Activity checker events: `0xc9abea1d2f62ac711e37d2eb37904f22a081c3dd9a0af70c7cd337e2d4a80a57`, `0xb212d50e99c813c459776dc4d47eafe12a8cab7b91be91bb3811896c9efca0d2`, `0x926fa578c1dcf4f8d7e4d195f58b637624f46d31f26ce448cc8fcbc4ee04f07d`

Important operational note:

- The earlier stale predicted Safe `0x36cE9a1420c81A887CABFFE5086F958DF7403C40` was deployed on Base Sepolia and its stranded `40 JINN` was swept back to the active Safe. Recovery txs:
  - stale Safe deploy: `0x11ab5742a07e88ab6cc2faa22393180790959630614cc51ea0b731e69dd61fed`
  - stale Safe sweep: `0x5f36f76d567192a1efc96c7a4678288b577aebc282c0216de67c5ea4bb21b448`
- The Base Sepolia bridge top-up to the active Safe was also submitted on Sepolia as `0xb044c3ec687c091bed760eee623bb629d612dd1f77b6f44e8b6a17831f1a0da4`; the stale-Safe recovery unblocked progress before that relay was needed.

Current blockers as of 2026-04-08:

- The weekly `VoteWeighting` boundary has not passed yet, so the staking nominee still has zero active relative weight even though the vote has been cast.
- The original canonical L1 deploy path also left `Tokenomics.mapEpochStakingPoints[*]` unset for future epochs. This was repaired in place on Sepolia by the operator with:
  - `changeIncentiveFractions(0,0,0,0,0,100)`: `0x239f86bf5663d6786ac388f6a05b908b8a2e45f4b1e533fb9b592aacd02b9674`
  - `changeStakingParams(100 JINN, 1%)`: `0x306ba6acde17fa4cdc232b351f78b14e826db07d2fae71acfff62026c8d2a8dd`
- As a result, canonical epoch `2` is now seeded with:
  - `stakingFraction = 100`
  - `maxStakingIncentive = 100 JINN`
  - `minStakingWeight = 1%`
- The real L1 `claimStakingIncentives` path therefore remains blocked until the next weekly activation point (`2026-04-09T00:00:00Z`).
- Service `11` is already staked and has qualifying activity recorded; the remaining live work after the boundary is:
  - wait for positive relative weight / a claimable post-vote epoch
  - run the Sepolia `claimStakingIncentives` call
  - verify bridge delivery into Base Sepolia
  - run the owner-side L2 claim path from the Safe-owned service

Accurate summary after the bootstrap fixes:

- Phase 1a is no longer blocked on “someone else’s key” or on a broken staking bootstrap.
- The stack now has a fresh one-key deployment, funded L2 reward liquidity, and a real Base Sepolia service staked through the supported client bootstrap path.
- The remaining unknown is the real emit -> bridge -> distribute -> claim loop across live epochs after weekly vote activation.

### Operator rerun checklist (validated on 2026-04-08)

This is the shortest reliable sequence to reproduce the current operator-ready state from scratch under one key.

1. Deploy / refresh artifacts
   - Run `contracts/scripts/deploy-phase1a.ts` on Sepolia.
   - Run `contracts/scripts/create-phase1a-l2-token.ts` on Base Sepolia.
   - Run `contracts/scripts/deploy-phase1a-l2.ts` on Base Sepolia.
   - Run `contracts/scripts/deploy-phase1a-bridge.ts` for the Sepolia + Base Sepolia pair.

2. Execute L1 governance wiring
   - Run `contracts/scripts/phase1a-unpause-dispenser.ts`.
   - Run `contracts/scripts/phase1a-set-deposit-processor.ts`.
   - Run `contracts/scripts/phase1a-add-staking-nominee.ts`.
   - Run `contracts/scripts/phase1a-mint-jinn-for-vote.ts` if the operator wallet needs voting balance first.
   - Run `contracts/scripts/phase1a-vote-staking-weight.ts`.

3. Seed L2 liquidity
   - Bridge JINN from Sepolia with `contracts/scripts/phase1a-bridge-jinn-to-l2.ts`.
   - Seed the staking proxy with `contracts/scripts/phase1a-deposit-staking-rewards.ts`.

4. Bootstrap the service
   - Use the testnet client bootstrap (`client/src/main.ts`) with `network: "testnet"`.
   - The testnet bootstrap intentionally stops at `service_staked`.
   - The Safe must hold enough JINN for both activation and registration: `2 * bondAmount`.
   - The Safe also needs native gas on Base Sepolia for payable service-manager calls.

5. Prefer public Base Sepolia RPCs for write transactions
   - Reads can work on Tenderly, but writes on Base Sepolia were materially more reliable via `https://sepolia.base.org`.
   - This especially mattered for Safe staking execution and for consecutive activity-recording txs.

6. Verify and record activity
   - Run `contracts/scripts/status-phase1a-live.ts` as the read-only gate.
   - Record qualifying activity with `contracts/scripts/phase1a-record-activity.ts`.

7. After the weekly vote boundary
   - Wait for non-zero relative weight.
   - Run `contracts/scripts/phase1a-claim-staking-incentives.ts`.
   - Verify bridge delivery on Base Sepolia.
   - Then claim on L2 with `contracts/scripts/phase1a-claim-l2-rewards.ts`.
   - Safe-owned services are the expected case. Point `PHASE1A_EARNING_DIR` at the bootstrap earning dir and provide `JINN_PASSWORD` so the script can decrypt `agent_keystore.json` and sign the Safe transaction as the agent EOA.
   - For the current testnet service `11`, the practical command shape is:

     ```bash
     cd contracts
     PHASE1A_SERVICE_ID=11 \
     PHASE1A_EARNING_DIR=/tmp/jinn-phase1a/earning \
     JINN_PASSWORD=phase1a-test \
     BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
     npx hardhat run scripts/phase1a-claim-l2-rewards.ts --network baseSepolia
     ```

Current caveat:

- `contracts/scripts/phase1a-claim-l2-rewards.ts` now supports both ownership shapes, but the operational expectation is still a 1-of-N Safe with threshold `1`.
- If the service owner Safe threshold is raised above `1`, the helper will stop and require a manual multi-signature flow.

### Fast-test timing profile (parallel stack, added 2026-04-08)

The canonical Sepolia/Base Sepolia rollout above remains the source of truth for the real Phase 1a proof. In parallel, the repo now supports a separate `fast-test` timing profile for rapid operator iteration without overwriting the canonical artifacts.

The profile switch is:

```bash
PHASE1A_TIMING_PROFILE=canonical|fast-test
```

`canonical` remains the default. `fast-test` changes timing semantics intentionally:

- L1 tokenomics epoch: `900s`
- L1 vote activation bucket: `900s`
- L1 vote cooldown: `900s`
- L2 liveness period: `300s`
- L2 minimum staking periods: `2`
- L2 max inactivity periods: `1`
- L2 emissions window: `21600s`
- default vote-lock duration in the vote helper: `7 days`

What the fast profile is for:

- proving the full mechanical operator loop quickly:
  - deploy
  - governance activate
  - stake
  - record activity
  - L1 claim
  - bridge delivery
  - Safe-owned L2 claim

What it is not for:

- proving canonical weekly `VoteWeighting` behavior
- proving canonical 24h / 72h L2 staking cadence
- replacing the real Sepolia/Base Sepolia proof stack

Fast artifacts are written to separate files and must not overwrite the canonical files:

- `contracts/deployment-phase1a-sepolia-fast.json`
- `contracts/deployment-phase1a-token-baseSepolia-fast.json`
- `contracts/deployment-phase1a-l2-baseSepolia-fast.json`
- `contracts/deployment-phase1a-bridge-sepolia-baseSepolia-fast.json`

Fast client runs should also use a separate earning dir, for example:

```bash
JINN_EARNING_DIR=/tmp/jinn-phase1a-fast/earning
```

The client can now read testnet Base Sepolia token/staking addresses from explicit artifact paths instead of only from compiled constants. The new config/env inputs are:

- config keys:
  - `testnetL2DeploymentPath`
  - `testnetL2TokenDeploymentPath`
- env vars:
  - `JINN_TESTNET_L2_DEPLOYMENT`
  - `JINN_TESTNET_TOKEN_DEPLOYMENT`

Recommended fast-stack sequence:

1. Deploy the fast L1 stack

   ```bash
   cd contracts
   PHASE1A_TIMING_PROFILE=fast-test \
   npx hardhat run scripts/deploy-phase1a.ts --network sepolia
   ```

2. Create the fast Base Sepolia bridge-compatible token

   ```bash
   cd contracts
   PHASE1A_TIMING_PROFILE=fast-test \
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
   npx hardhat run scripts/create-phase1a-l2-token.ts --network baseSepolia
   ```

3. Deploy the fast Base Sepolia staking stack

   ```bash
   cd contracts
   PHASE1A_TIMING_PROFILE=fast-test \
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
   npx hardhat run scripts/deploy-phase1a-l2.ts --network baseSepolia
   ```

4. Deploy the fast bridge pair

   ```bash
   cd contracts
   PHASE1A_TIMING_PROFILE=fast-test \
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
   npx hardhat run scripts/deploy-phase1a-bridge.ts --network sepolia
   ```

5. Run the same operator helpers against the fast artifacts
   - `phase1a-unpause-dispenser.ts`
   - `phase1a-set-deposit-processor.ts`
   - `phase1a-add-staking-nominee.ts`
   - `phase1a-mint-jinn-for-vote.ts`
   - `phase1a-vote-staking-weight.ts`
   - `phase1a-bridge-jinn-to-l2.ts`
   - `phase1a-deposit-staking-rewards.ts`
   - `phase1a-record-activity.ts`
   - `phase1a-claim-staking-incentives.ts`
   - `phase1a-claim-l2-rewards.ts`

6. Point the client at the fast artifacts and separate earning dir

   ```bash
   cd client
   JINN_NETWORK=testnet \
   JINN_EARNING_DIR=/tmp/jinn-phase1a-fast/earning \
   JINN_TESTNET_L2_DEPLOYMENT=/Users/adrianobradley/jinn-mono/contracts/deployment-phase1a-l2-baseSepolia-fast.json \
   JINN_TESTNET_TOKEN_DEPLOYMENT=/Users/adrianobradley/jinn-mono/contracts/deployment-phase1a-token-baseSepolia-fast.json \
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
   JINN_PASSWORD=<keystore-password> \
   npm start
   ```

Operational note:

- The status and vote helpers now derive the activation period and vote cooldown from the deployed `VoteWeighting` contract instead of assuming a hardcoded week, so they work for both canonical and fast profiles.

### Fast-test live proof snapshot (2026-04-08 evening)

The parallel fast stack was fully exercised end to end on Sepolia + Base Sepolia on 2026-04-08.

Fast artifact addresses:

- `contracts/deployment-phase1a-sepolia-fast.json`
  - `JINN`: `0xc3ae831f146Eabbb8095E1EDf90a187AA4E5F408`
  - `Tokenomics`: `0x302cd1f188fCFcA64EA038aFa738D90951360739`
  - `Dispenser`: `0xaFE21C6dBeF2d41A769F58CE068aa991369FB1e0`
  - `VoteWeighting`: `0x8eF25EEC3baC74DfA12987905D1eB2cEDf40B685`
- `contracts/deployment-phase1a-token-baseSepolia-fast.json`
  - `l2Token`: `0xAB9a01cd4A379e36006ec6df2960CF39EF79df63`
- `contracts/deployment-phase1a-l2-baseSepolia-fast.json`
  - `activityChecker`: `0xdaa1529de84B429945A33744539Af6D7140BF9B6`
  - `stakingFactory`: `0x4FaF53A13Df420D70FE337F5b77B35B6E7309C48`
  - `stakingToken`: `0x2c286651590b4DdC6d58d1270069B43183a851D1`
- `contracts/deployment-phase1a-bridge-sepolia-baseSepolia-fast.json`
  - `depositProcessorL1`: `0xc03Aba7f4d4a093454452C13a9c74a7907B2e111`
  - `targetDispenserL2`: `0x36d4f30E150Ce891279dA78fcCd32e6864Ab5630`

Fast live service state:

- agent EOA: `0x2d9D81AeDb5Bb3Defa2cFdbC582d3511875D5dd9`
- service Safe: `0xfc8236EEa165913f797a5c39468141526086273C`
- service id: `12`

What failed in the first fast rollout and how it was fixed:

- The fast L1 deploy path initially left `Tokenomics.mapEpochStakingPoints[*].stakingFraction == 0`, so Sepolia `claimStakingIncentives` stayed at zero even after vote activation and epoch checkpoints.
- Root cause: the deploy flow wired the contracts but did not call `Tokenomics.changeIncentiveFractions(...)` or `Tokenomics.changeStakingParams(...)`.
- Live fix txs on the fast tokenomics contract:
  - `changeIncentiveFractions(0,0,0,0,0,100)`: `0x78f380ff5c01e8afca3471cbd9929751751dfd277c8aea25911bf0618a2f9e72`
  - `changeStakingParams(100 JINN, 1%)`: `0x6ea58db0594c3e23414c17014e7903dfa249a87d88e7d43290b3020168b37242`
- Those settings took effect in future epochs as designed, and the first non-zero Sepolia staking incentive became claimable after the subsequent fast checkpoints.

Fast end-to-end proof txs:

- service create: `0xb74acfa9433cdc43ebfedd009827a53ff086436b14331e01b8e292c6cd002334`
- service activate: `0xf8b34eef99260c5a50a817f479fb26d563a9a6b67dea8add81ff69c4bd53b9e7`
- agent register: `0xb53204063fe660cab072df0c827d0bd106edc05ea331503745eb73c52cc2aef1`
- service deploy: `0x4fe86c6aede08501267a5ae59536078ec57bfbb6fbbd11c7865d7123b2388cfb`
- service stake: `0x3b2e2e2b570ec7822c52f36c748605a5b60edf8fed18115a851ef480394289df`
- initial activity proof: `0x0fff152c957a930db132a24c08d604f6a0fecc5c33601aa08e048c48145a414a`, `0x80ad7420510c89168a98f52e817cc17351616d43815589093d38dc4dafb51f15`, `0x00ddf17a6d74e5bed9d291fd7b22a422322f6e930816752e9aacc54cd6fb2ba0`
- Sepolia fast checkpoints that advanced the claim window: `0x8e867d112763bac00880cb0a53cfde66eda7534e3b6b3411266ce4aebc57d22b`, `0xe4f0304731a0179c55f6d15ed5631c8ace5893fa76903cfa6142999125d1415b`, `0x81f93b490bf0086537c58d485556fa43b24609f3d1da07de0266e7f11fd2df87`, `0x59a911172f926ed7233d0801869f50664d9d029f607cffc5421bc1d2bb4db2a5`, `0x18c2b2cc61e649847310b01425c9682bfe700a2f4337e298442edff999719f58`
- Sepolia staking claim: `0x1ed981315479824febac0a3b6fb2fe39f2a32e743bec903323753c50c620fd9f`
  - claimable JINN bridged: `0.0192636986301342`
  - return to inflation: `94.943607094011376068`
  - bridge batch hash: `0xbd19ae745a3157e04fa1d9f06a4ea51ecbda1d2a539589c544b022d328a675d8`
- refreshed activity before final L2 claim: `0x294d2ef3119b6fcd36716f15b3e3d0d32466b65b9896afb3aa26ebdeb5aea310`, `0x96eb0dccc3bc579c94d055abc81360becb8acf44d6cde2489620eabe241fd45e`, `0xf527281a798e66be30dcf2baf17d54835d69eadc064d650b8cc3b5c3a9a2dacd`
- Base Sepolia Safe `checkpointAndClaim`: `0x945d768cdcb09999c0d41b718ba58de31b4502e322830546fcd7046f54005880`

Observed final proof points:

- Before the Sepolia claim, the fast Base staking proxy held exactly `50.0 JINN`.
- After the bridge relay, the fast Base staking proxy held `50.0192636986301342 JINN`, matching the Sepolia claim amount exactly.
- After refreshed activity and the Safe-owned `checkpointAndClaim`, the service Safe held `10.4536 JINN` and the staking proxy balance dropped to `49.5656636986301342 JINN`.

This proves the full fast-test mechanical loop on-chain:

- `deploy -> governance activate -> stake -> record activity -> L1 claim -> bridge delivery -> L2 Safe claim`

### Handoff status (2026-04-08 end of day)

This is the current state another operator can pick up without replaying the full investigation.

What is already done:

- Fresh one-key Phase 1a deployment is live and the canonical artifacts are updated:
  - `contracts/deployment-phase1a-sepolia.json`
  - `contracts/deployment-phase1a-token-baseSepolia.json`
  - `contracts/deployment-phase1a-l2-baseSepolia.json`
  - `contracts/deployment-phase1a-bridge-sepolia-baseSepolia.json`
- L1 governance wiring is complete on Sepolia:
  - Base Sepolia deposit processor mapping set
  - dispenser unpaused for staking incentives
  - staking nominee added
  - veJINN vote cast
- L2 is seeded and operational on Base Sepolia:
  - `100 JINN` bridged to Base Sepolia
  - staking proxy funded with `50 JINN`
  - real service `11` created, activated, registered, deployed, staked
  - qualifying activity recorded for service `11`
- Bootstrap and operator tooling gaps found during rollout were fixed:
  - testnet RPC override bug
  - stale predicted Safe reuse bug
  - stop-at-`service_staked` off-by-one bug
  - Safe funding undercount bug
  - Safe staking execution bug
  - final Safe-owned L2 claim helper gap

Current live addresses and identities:

- Deployer / operator EOA: `0x15e78734481bD31F6e183dad05225505a45ACd07`
- Service agent EOA: `0x376cAfEC9d1744b0A826409DB593a597cD436573`
- Active service Safe: `0xCE377821Ff921Cb917484C391eBFd83220470188`
- Service id: `11`
- Sepolia JINN: `0x8042063aBAce92B8BAF92C1E219D2D03DB59De45`
- Sepolia Dispenser: `0x61Fe7eF2121F1ce62d6BB4bB476465559b59A7f3`
- Sepolia VoteWeighting: `0xb737040B53eb413AE528EB45F45ED3Bbb886fAB8`
- Base Sepolia JINN L2: `0x4F177E56bd79c169742a1BF8907dB0A5e54F5524`
- Base Sepolia staking proxy: `0xe9c8DaBb4062deEc921562e7E286be3cEcb826b0`
- Sepolia deposit processor: `0x89744248dCb16964Cb709429c29597A18dE11309`
- Base Sepolia target dispenser: `0x98be6DC1c90B76d187bf92b13fccD70bbEd0C29B`

What remains to do:

1. Wait for the weekly `VoteWeighting` boundary to pass so the vote becomes active.
   - Expected boundary from the live status script: `2026-04-09T00:00:00Z`
   - Important: do not checkpoint the canonical tokenomics contract before that boundary. Because the canonical epoch length is `7200s`, checkpointing early would cause the first newly-configured staking epoch to close before vote activation and would delay the first non-zero Sepolia claim by another full epoch.
2. Re-run the status gate:
   - `cd contracts && BASE_SEPOLIA_RPC_URL=https://sepolia.base.org npx hardhat run scripts/status-phase1a-live.ts --network sepolia`
3. Once relative weight is non-zero and the static incentive probe stops reverting, execute the L1 claim:
   - `cd contracts && PHASE1A_NUM_CLAIMED_EPOCHS=1 BASE_SEPOLIA_RPC_URL=https://sepolia.base.org npx hardhat run scripts/phase1a-claim-staking-incentives.ts --network sepolia`
4. Wait for bridge delivery to Base Sepolia and verify state again with `status-phase1a-live.ts`.
5. Execute the final L2 claim from the Safe-owned service:

   ```bash
   cd contracts
   PHASE1A_SERVICE_ID=11 \
   PHASE1A_EARNING_DIR=/tmp/jinn-phase1a/earning \
   JINN_PASSWORD=<service-keystore-password> \
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
   npx hardhat run scripts/phase1a-claim-l2-rewards.ts --network baseSepolia
   ```

6. Record the final tx hashes back into this document once the loop is proven end to end.

Read-only checks that should already pass:

- Service `11` is actually staked (`getServiceIds()` includes `11`, staking state `1`)
- service `11` passes the activity checker threshold
- staking proxy has reward liquidity
- the only expected remaining blocker before the weekly boundary is zero active relative weight

Operator files and secrets needed for takeover:

- Deployer key source for Sepolia/Base Sepolia scripts:
  - file: `contracts/.env`
  - variable name: `DEPLOYER_PRIVATE_KEY`
  - current deployer address derived from that key: `0x15e78734481bD31F6e183dad05225505a45ACd07`
- Service-owner signer for the final Safe claim:
  - keystore file: `/tmp/jinn-phase1a/earning/agent_keystore.json`
  - state file: `/tmp/jinn-phase1a/earning/earning_state.json`
  - the password is not written into this repo and must be handed over out of band

Important security note:

- Do not copy the live private key or the service keystore password into git-tracked files.
- If this rollout is going to continue beyond the immediate proof window, move `DEPLOYER_PRIVATE_KEY` out of `contracts/.env` into the team’s actual secret store and rotate it after handoff if there is any doubt about exposure.

### Official Autonolas registry constants (for live-safe L2 staking env)

These are published in `valory-xyz/autonolas-registries` (not generated by this monorepo). Use them as **candidates** for `deploy-phase1a-l2.ts` on Base Sepolia; verify on-chain (contract code on BaseScan Sepolia) before treating as production truth.

**Base Sepolia (chainId 84532)** — `scripts/deployment/l2/globals_base_sepolia.json`  
Raw: [globals_base_sepolia.json](https://raw.githubusercontent.com/valory-xyz/autonolas-registries/main/scripts/deployment/l2/globals_base_sepolia.json)

| Field (upstream JSON key) | Address | Env var for our L2 deploy |
|-------------------------|---------|---------------------------|
| `serviceRegistryAddress` | `0x31D3202d8744B16A120117A053459DDFAE93c855` | `SERVICE_REGISTRY_ADDRESS` |
| `serviceRegistryTokenUtilityAddress` | `0xeB49bE5DF00F74bd240DE4535DDe6Bc89CEfb994` | `SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS` |
| `multisigProxyHash130` | `0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000` | `SAFE_PROXY_HASH` |

Notes:

- `olasAddress` is empty in that Base Sepolia file — canonical “OLAS on Base Sepolia” is not defined there; **JINN** is a separate token and must still be created or supplied for L2.
- `bridgeMediatorAddress` in that file is the **OLAS registry L1↔L2 mediator**, not the JINN tokenomics `OptimismDepositProcessorL1` / `OptimismTargetDispenserL2` pair.
- **Ethereum Sepolia L1** official globals live in `scripts/deployment/globals_sepolia.json` in the same repo (different `serviceRegistryAddress` / `serviceRegistryTokenUtilityAddress` than the stub `ServiceRegistry (stub)` row inside `deployment-phase1a-sepolia.json`). Align with those addresses only if you intend full OLAS-compatible service lifecycle on L1 Sepolia; Phase 1a tokenomics can still run with stubs if staking and bridge targets are configured consistently.

---

## File Structure

### New directories and files

```
contracts/
  vendor/                          # Forked OLAS contracts (git-tracked, minimal changes)
    governance/                    # From autonolas-governance
      OLAS.sol → JINN.sol          # Renamed, name/symbol changed
      veOLAS.sol                   # Unchanged (Phase 1b, but deployed now as dep)
      VoteWeighting.sol            # Unchanged (required by Dispenser)
    tokenomics/                    # From autonolas-tokenomics
      Tokenomics.sol               # Unchanged or minimal registry stubs
      TokenomicsConstants.sol      # Unchanged
      Treasury.sol                 # Unchanged
      Dispenser.sol                # Unchanged
      Depository.sol               # Unchanged
      GenericBondCalculator.sol    # Unchanged (required by Depository)
      interfaces/                  # All OLAS interfaces needed by above
    registries/                    # From autonolas-registries
      staking/
        StakingBase.sol            # Unchanged
        StakingToken.sol           # Unchanged
        StakingFactory.sol         # Unchanged
        StakingProxy.sol           # Unchanged
    bridge/                        # From autonolas-tokenomics
      OptimismDepositProcessorL1.sol   # Unchanged
      DefaultDepositProcessorL1.sol    # Base class
      OptimismTargetDispenserL2.sol    # Unchanged
      DefaultTargetDispenserL2.sol     # Base class
  src/
    phase1/                        # Jinn-specific Phase 1 contracts
      JinnActivityChecker.sol      # Fresh activity checker for testnet (reuses JinnRouter pattern)
  scripts/
    deploy-phase1a.ts              # Full-stack deployment script
    lib/
      deploy-helpers.ts            # Shared deployment utilities
  test/
    phase1/
      JINN.test.ts                 # Token tests
      Treasury.test.ts             # Epoch emission tests
      StakingDistribution.test.ts  # End-to-end staking + distribution test
      DeployPhase1a.test.ts        # Full stack deployment integration test

client/
  src/
    config.ts                      # Add testnet network support
    earning/
      contracts.ts                 # Add testnet chain config + JINN addresses
      jinn-rewards.ts              # NEW: JINN reward claiming
```

---

## Task 1: Vendor OLAS Governance Contracts

**Files:**
- Create: `contracts/vendor/governance/JINN.sol`
- Create: `contracts/vendor/governance/veOLAS.sol`
- Create: `contracts/vendor/governance/VoteWeighting.sol`
- Create: `contracts/vendor/governance/interfaces/` (as needed)

- [ ] **Step 1: Clone autonolas-governance and identify required files**

```bash
cd /tmp
git clone --depth 1 https://github.com/valory-xyz/autonolas-governance.git
ls autonolas-governance/contracts/
```

Identify the exact files and their import chains. We need:
- `OLAS.sol` (token)
- `veOLAS.sol` (vote-escrow, Phase 1b but Dispenser may reference it)
- `VoteWeighting.sol` (required by Dispenser constructor)
- All interfaces these import

- [ ] **Step 2: Copy OLAS.sol and rename to JINN.sol**

Copy `OLAS.sol` to `contracts/vendor/governance/JINN.sol`. Make these minimal changes:
1. Rename the contract from `OLAS` to `JINN`
2. Change the token name string from `"Autonolas"` to `"Jinn"`
3. Change the symbol string from `"OLAS"` to `"JINN"`
4. Update any internal references from `OLAS` to `JINN`

Do NOT change any logic, access control, or minting behavior.

- [ ] **Step 3: Copy veOLAS.sol unchanged**

Copy `veOLAS.sol` and its dependencies to `contracts/vendor/governance/`. Preserve all import paths — update only the relative paths to match the new directory structure.

- [ ] **Step 4: Copy VoteWeighting.sol unchanged**

Copy `VoteWeighting.sol` and its dependencies. Same approach — preserve logic, update import paths only.

- [ ] **Step 5: Copy all required interfaces**

Copy every interface file imported by the above contracts into `contracts/vendor/governance/interfaces/`. Fix import paths.

- [ ] **Step 6: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: Compiles with zero errors. If import path issues, fix them. If Solidity version mismatches with existing contracts, add a separate compiler version in hardhat.config.ts.

- [ ] **Step 7: Commit**

```bash
git add contracts/vendor/governance/
git commit -m "chore: vendor OLAS governance contracts (JINN token, veOLAS, VoteWeighting)"
```

---

## Task 2: Vendor OLAS Tokenomics Contracts

**Files:**
- Create: `contracts/vendor/tokenomics/Tokenomics.sol`
- Create: `contracts/vendor/tokenomics/TokenomicsConstants.sol`
- Create: `contracts/vendor/tokenomics/Treasury.sol`
- Create: `contracts/vendor/tokenomics/Dispenser.sol`
- Create: `contracts/vendor/tokenomics/Depository.sol`
- Create: `contracts/vendor/tokenomics/GenericBondCalculator.sol`
- Create: `contracts/vendor/tokenomics/interfaces/`

- [ ] **Step 1: Clone autonolas-tokenomics and identify required files**

```bash
cd /tmp
git clone --depth 1 https://github.com/valory-xyz/autonolas-tokenomics.git
ls autonolas-tokenomics/contracts/
```

Map the full import graph for: Tokenomics.sol, Treasury.sol, Dispenser.sol, Depository.sol. Include TokenomicsConstants.sol (inherited by Tokenomics) and GenericBondCalculator.sol (required by Depository).

- [ ] **Step 2: Copy core tokenomics contracts**

Copy these files to `contracts/vendor/tokenomics/`:
- `Tokenomics.sol`
- `TokenomicsConstants.sol`
- `Treasury.sol`
- `Dispenser.sol`
- `Depository.sol`
- `GenericBondCalculator.sol`

Do NOT modify any logic. Only update import paths to match the vendor directory structure.

- [ ] **Step 3: Copy all required interfaces**

These contracts import many interfaces (IToken, ITreasury, ITokenomics, IDispenser, IServiceRegistry, IVotingEscrow, etc.). Copy every interface into `contracts/vendor/tokenomics/interfaces/`. Fix import paths.

- [ ] **Step 4: Resolve cross-package imports**

The tokenomics contracts import from governance (e.g., IOLAS, IVotingEscrow). Ensure these imports resolve correctly — either copy the interfaces into the tokenomics interfaces directory, or use relative imports to `../governance/interfaces/`.

- [ ] **Step 5: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: Compiles with zero errors. The tokenomics contracts are large — expect many warnings about contract size. That's fine for testnet.

- [ ] **Step 6: Commit**

```bash
git add contracts/vendor/tokenomics/
git commit -m "chore: vendor OLAS tokenomics contracts (Treasury, Dispenser, Tokenomics, Depository)"
```

---

## Task 3: Vendor OLAS Staking and Bridge Contracts

**Files:**
- Create: `contracts/vendor/registries/staking/StakingBase.sol`
- Create: `contracts/vendor/registries/staking/StakingToken.sol`
- Create: `contracts/vendor/registries/staking/StakingFactory.sol`
- Create: `contracts/vendor/registries/staking/StakingProxy.sol`
- Create: `contracts/vendor/bridge/OptimismDepositProcessorL1.sol`
- Create: `contracts/vendor/bridge/DefaultDepositProcessorL1.sol`
- Create: `contracts/vendor/bridge/OptimismTargetDispenserL2.sol`
- Create: `contracts/vendor/bridge/DefaultTargetDispenserL2.sol`

- [ ] **Step 1: Clone autonolas-registries and identify staking files**

```bash
cd /tmp
git clone --depth 1 https://github.com/valory-xyz/autonolas-registries.git
ls autonolas-registries/contracts/staking/
```

We need: StakingBase.sol, StakingToken.sol, StakingFactory.sol, StakingProxy.sol, and their interfaces.

- [ ] **Step 2: Copy staking contracts**

Copy the staking contracts to `contracts/vendor/registries/staking/`. Preserve logic, update import paths.

Key fact: `StakingToken.initialize()` takes `_stakingToken` as a parameter — the token address is NOT hardcoded. This means we can pass JINN token address at deploy time with zero code changes.

- [ ] **Step 3: Copy bridge contracts from autonolas-tokenomics**

The bridge contracts live in `autonolas-tokenomics/contracts/staking/`:
- `OptimismDepositProcessorL1.sol`
- `DefaultDepositProcessorL1.sol`
- `OptimismTargetDispenserL2.sol`
- `DefaultTargetDispenserL2.sol`

Copy to `contracts/vendor/bridge/`. Update import paths.

- [ ] **Step 4: Copy all required interfaces for staking and bridge**

These reference IService, IActivityChecker, IStakingFactory, etc. Copy all interfaces and fix paths.

- [ ] **Step 5: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: Compiles with zero errors.

- [ ] **Step 6: Commit**

```bash
git add contracts/vendor/registries/ contracts/vendor/bridge/
git commit -m "chore: vendor OLAS staking and bridge contracts"
```

---

## Task 4: Update Hardhat Configuration

**Files:**
- Modify: `contracts/hardhat.config.ts`
- Modify: `contracts/package.json`
- Create: `contracts/.env.example`

- [ ] **Step 1: Add Sepolia and Base Sepolia networks to hardhat.config.ts**

Add to the networks section:

```typescript
sepolia: {
  url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 11155111,
},
baseSepolia: {
  url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 84532,
},
```

- [ ] **Step 2: Add multiple Solidity compiler versions if needed**

The OLAS contracts may use a different pragma than 0.8.25. Check the vendored files and add any required compiler versions to the `solidity` config. Use the `overrides` field if different contracts need different versions.

- [ ] **Step 3: Add vendor paths to Hardhat sources**

Ensure Hardhat compiles the `vendor/` directory. The default `sources: "./src"` won't include vendor. Update to:

```typescript
paths: {
  sources: "./src",
  tests: "./test",
  cache: "./cache",
  artifacts: "./artifacts",
},
```

If Hardhat doesn't support multiple source directories, either:
- Move vendor imports to use `src/vendor/` path, or
- Add a `paths.sources` override, or
- Use Hardhat's `dependencyCompiler` plugin

The simplest approach: move vendor into `src/vendor/` so the existing source path covers it.

- [ ] **Step 4: Create .env.example**

```
# Deployer
DEPLOYER_PRIVATE_KEY=

# L1 (Sepolia)
SEPOLIA_RPC_URL=https://rpc.sepolia.org

# L2 (Base Sepolia)
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Etherscan verification
ETHERSCAN_API_KEY=
BASESCAN_API_KEY=
```

- [ ] **Step 5: Verify full compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: All contracts compile — both existing Jinn contracts and vendored OLAS contracts.

- [ ] **Step 6: Commit**

```bash
git add contracts/hardhat.config.ts contracts/package.json contracts/.env.example
git commit -m "chore: add Sepolia/Base Sepolia networks and vendor compilation support"
```

---

## Task 5: Write JINN Token Tests

**Files:**
- Create: `contracts/test/phase1/JINN.test.ts`

- [ ] **Step 1: Write the JINN token test**

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("JINN Token", function () {
  async function deployJinnFixture() {
    const [owner, minter, user] = await ethers.getSigners();
    const JINN = await ethers.getContractFactory("JINN");
    const jinn = await JINN.deploy();
    return { jinn, owner, minter, user };
  }

  describe("Deployment", function () {
    it("should have correct name and symbol", async function () {
      const { jinn } = await loadFixture(deployJinnFixture);
      expect(await jinn.name()).to.equal("Jinn");
      expect(await jinn.symbol()).to.equal("JINN");
    });

    it("should set deployer as owner", async function () {
      const { jinn, owner } = await loadFixture(deployJinnFixture);
      expect(await jinn.owner()).to.equal(owner.address);
    });

    it("should have 18 decimals", async function () {
      const { jinn } = await loadFixture(deployJinnFixture);
      expect(await jinn.decimals()).to.equal(18);
    });
  });

  describe("Minting", function () {
    it("should allow minter to mint tokens", async function () {
      const { jinn, owner, minter, user } = await loadFixture(deployJinnFixture);
      // Owner changes minter
      await jinn.connect(owner).changeMinter(minter.address);
      // Minter mints
      const amount = ethers.parseEther("1000");
      await jinn.connect(minter).mint(user.address, amount);
      expect(await jinn.balanceOf(user.address)).to.equal(amount);
    });

    it("should reject mint from non-minter", async function () {
      const { jinn, user } = await loadFixture(deployJinnFixture);
      const amount = ethers.parseEther("1000");
      await expect(
        jinn.connect(user).mint(user.address, amount)
      ).to.be.reverted;
    });
  });

  describe("Ownership", function () {
    it("should allow owner to change minter", async function () {
      const { jinn, owner, minter } = await loadFixture(deployJinnFixture);
      await jinn.connect(owner).changeMinter(minter.address);
      expect(await jinn.minter()).to.equal(minter.address);
    });

    it("should allow owner to transfer ownership", async function () {
      const { jinn, owner, user } = await loadFixture(deployJinnFixture);
      await jinn.connect(owner).changeOwner(user.address);
      expect(await jinn.owner()).to.equal(user.address);
    });
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd contracts
npx hardhat test test/phase1/JINN.test.ts
```

Expected: All 5 tests pass. If the OLAS contract's function names differ (e.g., `changeMinter` vs `setMinter`), adjust the test to match the actual ABI. Read the vendored JINN.sol to confirm function names.

- [ ] **Step 3: Commit**

```bash
git add contracts/test/phase1/
git commit -m "test: add JINN token tests"
```

---

## Task 6: Analyze OLAS Contract Dependencies and Write Deployment Helpers

This is the critical research + code task. The OLAS contracts have circular constructor dependencies. This task determines the deployment order.

**Files:**
- Create: `contracts/scripts/lib/deploy-helpers.ts`

- [ ] **Step 1: Map the dependency graph by reading vendored contracts**

Read every constructor and `initialize` function in the vendored contracts. Document:

1. **JINN token**: No constructor params. Deploy first.
2. **Tokenomics**: Empty constructor, initialized via `initializeTokenomics(olas, treasury, depository, dispenser, ve, epochLen, componentRegistry, agentRegistry, serviceRegistry, donatorBlacklist)`. Two-phase.
3. **Treasury**: Constructor `(olas, tokenomics, depository, dispenser)`. All must be non-zero.
4. **Dispenser**: Constructor `(olas, tokenomics, treasury, voteWeighting, retainer, maxNumClaimingEpochs, maxNumStakingTargets, defaultMinStakingWeight, defaultMaxStakingIncentive)`.
5. **Depository**: Constructor `(olas, tokenomics, treasury, bondCalculator)`.
6. **VoteWeighting**: Check constructor params (likely `veOLAS` address).
7. **veOLAS**: Constructor `(token, name, symbol)`.
8. **GenericBondCalculator**: Check constructor params.

The circular dependency: Treasury needs Tokenomics address, but Tokenomics.initializeTokenomics needs Treasury address. OLAS resolves this because Tokenomics uses two-phase init — deploy Tokenomics first (empty constructor), then deploy Treasury with Tokenomics address, then call `initializeTokenomics` with Treasury address.

Investigate whether Treasury/Dispenser/Depository also support two-phase init or if they require all addresses at construction time. If they require addresses at construction, we need to determine the exact deployment order that satisfies all dependencies.

Likely deployment order:
1. JINN token
2. veOLAS (needs JINN address)
3. VoteWeighting (needs veOLAS address)
4. Tokenomics (empty constructor)
5. GenericBondCalculator (check deps)
6. Treasury (needs JINN, Tokenomics — Depository and Dispenser addresses TBD)
7. Depository (needs JINN, Tokenomics, Treasury)
8. Dispenser (needs JINN, Tokenomics, Treasury, VoteWeighting)
9. Call `Tokenomics.initializeTokenomics(...)` with all addresses
10. Call `Treasury.changeManagers(...)` or similar to update Depository/Dispenser if they were zero at construction

**Read the actual contract code to determine the exact order.** The OLAS contracts may have `changeManagers()` or `changeDispenser()` admin functions that allow setting addresses post-deployment.

- [ ] **Step 2: Write deploy-helpers.ts with the deployment sequence**

```typescript
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

export interface Phase1aDeployment {
  jinn: Contract;
  veJINN: Contract;
  voteWeighting: Contract;
  tokenomics: Contract;
  treasury: Contract;
  dispenser: Contract;
  depository: Contract;
  bondCalculator: Contract;
  // L2 contracts (Base Sepolia)
  stakingFactory?: Contract;
  stakingToken?: Contract;
  activityChecker?: Contract;
  // Bridge
  depositProcessor?: Contract;
  targetDispenser?: Contract;
}

export interface DeployConfig {
  deployer: Signer;
  epochLength: number;       // seconds (e.g., 604800 for 1 week)
  // Registry addresses — zero-address for Phase 1a
  componentRegistry: string;
  agentRegistry: string;
  serviceRegistry: string;
  donatorBlacklist: string;
  // Dispenser config
  maxNumClaimingEpochs: number;
  maxNumStakingTargets: number;
  defaultMinStakingWeight: bigint;
  defaultMaxStakingIncentive: bigint;
}

/**
 * Deploy the full Phase 1a L1 (Sepolia) contract stack.
 * 
 * Deployment order resolves circular dependencies:
 * 1. JINN token (no deps)
 * 2. veJINN (needs JINN)
 * 3. VoteWeighting (needs veJINN)
 * 4. Tokenomics (empty constructor, two-phase init)
 * 5. GenericBondCalculator (check deps)
 * 6. Treasury (needs JINN, Tokenomics — may need post-deploy manager update)
 * 7. Depository (needs JINN, Tokenomics, Treasury)
 * 8. Dispenser (needs JINN, Tokenomics, Treasury, VoteWeighting)
 * 9. Tokenomics.initializeTokenomics(...) with all addresses
 * 10. Any post-deploy manager updates on Treasury
 * 11. Set Treasury as JINN minter
 * 
 * IMPORTANT: Steps 5-10 must be verified against actual OLAS contract code.
 * The constructor signatures and post-deploy configuration calls must match
 * the vendored contracts exactly. Read the contracts before implementing.
 */
export async function deployL1Stack(config: DeployConfig): Promise<Phase1aDeployment> {
  const deployer = config.deployer;

  // 1. Deploy JINN token
  const JINNFactory = await ethers.getContractFactory("JINN");
  const jinn = await JINNFactory.connect(deployer).deploy();
  await jinn.waitForDeployment();
  console.log(`JINN token deployed at: ${await jinn.getAddress()}`);

  // 2. Deploy veJINN
  const veJINNFactory = await ethers.getContractFactory("veOLAS");
  const veJINN = await veJINNFactory.connect(deployer).deploy(
    await jinn.getAddress(),
    "Voting Escrow JINN",
    "veJINN"
  );
  await veJINN.waitForDeployment();
  console.log(`veJINN deployed at: ${await veJINN.getAddress()}`);

  // 3. Deploy VoteWeighting
  const VoteWeightingFactory = await ethers.getContractFactory("VoteWeighting");
  // CHECK: VoteWeighting constructor params — likely (veOLAS address)
  const voteWeighting = await VoteWeightingFactory.connect(deployer).deploy(
    await veJINN.getAddress()
  );
  await voteWeighting.waitForDeployment();
  console.log(`VoteWeighting deployed at: ${await voteWeighting.getAddress()}`);

  // 4. Deploy Tokenomics (empty constructor, two-phase init)
  const TokenomicsFactory = await ethers.getContractFactory("Tokenomics");
  const tokenomics = await TokenomicsFactory.connect(deployer).deploy();
  await tokenomics.waitForDeployment();
  console.log(`Tokenomics deployed at: ${await tokenomics.getAddress()}`);

  // 5. Deploy GenericBondCalculator
  // CHECK: constructor params
  const BondCalcFactory = await ethers.getContractFactory("GenericBondCalculator");
  const bondCalculator = await BondCalcFactory.connect(deployer).deploy(
    await jinn.getAddress(),
    await tokenomics.getAddress()
  );
  await bondCalculator.waitForDeployment();

  // 6-8: Deploy Treasury, Depository, Dispenser
  // CRITICAL: Read the actual vendored contracts to determine exact constructor
  // signatures and whether Treasury supports post-deploy manager updates.
  // The code below is the EXPECTED pattern — verify against source.
  
  // If Treasury requires all addresses at construction:
  // Deploy a temporary placeholder, or use the two-phase pattern if available.
  // 
  // If Treasury has changeManagers() or similar:
  // Deploy with zero-address for Depository/Dispenser, then update after.

  // --- PLACEHOLDER: Replace with actual deployment after reading contracts ---
  // const treasury = await TreasuryFactory.deploy(jinnAddr, tokenomicsAddr, depositoryAddr, dispenserAddr);
  // const depository = await DepositoryFactory.deploy(jinnAddr, tokenomicsAddr, treasuryAddr, bondCalcAddr);
  // const dispenser = await DispenserFactory.deploy(jinnAddr, tokenomicsAddr, treasuryAddr, voteWeightingAddr, ...);
  // --- END PLACEHOLDER ---

  // 9. Initialize Tokenomics with all addresses
  // await tokenomics.initializeTokenomics(
  //   jinnAddr, treasuryAddr, depositoryAddr, dispenserAddr, veJINNAddr,
  //   config.epochLength,
  //   config.componentRegistry, config.agentRegistry, config.serviceRegistry,
  //   config.donatorBlacklist
  // );

  // 10. Set Treasury as JINN minter
  // await jinn.changeMinter(treasuryAddr);

  // Return deployment - fill in actual contracts after implementation
  return {
    jinn,
    veJINN,
    voteWeighting,
    tokenomics,
    treasury: null as any, // PLACEHOLDER
    dispenser: null as any, // PLACEHOLDER
    depository: null as any, // PLACEHOLDER
    bondCalculator,
  };
}
```

**CRITICAL NOTE:** The placeholder sections (steps 6-10) MUST be filled in after reading the actual vendored contract constructors. The OLAS contracts have specific initialization patterns that vary by contract. Do not guess — read the code.

- [ ] **Step 3: Commit**

```bash
git add contracts/scripts/lib/
git commit -m "feat: add Phase 1a deployment helpers (L1 stack)"
```

---

## Task 7: Write Full Deployment Script

**Files:**
- Create: `contracts/scripts/deploy-phase1a.ts`

- [ ] **Step 1: Write the deployment script**

This script deploys the complete Phase 1a stack across both chains. It uses the helpers from Task 6.

```typescript
import { ethers, network } from "hardhat";
import { deployL1Stack, DeployConfig } from "./lib/deploy-helpers";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network: ${network.name} (chainId: ${network.config.chainId})`);

  if (network.name !== "sepolia" && network.name !== "hardhat") {
    throw new Error("Phase 1a deployment targets Sepolia. Use --network sepolia or hardhat for local testing.");
  }

  const config: DeployConfig = {
    deployer,
    epochLength: 604800, // 1 week
    // Zero-address for unused registries
    componentRegistry: ethers.ZeroAddress,
    agentRegistry: ethers.ZeroAddress,
    serviceRegistry: ethers.ZeroAddress,
    donatorBlacklist: ethers.ZeroAddress,
    // Dispenser config
    maxNumClaimingEpochs: 10,
    maxNumStakingTargets: 100,
    defaultMinStakingWeight: 100n,
    defaultMaxStakingIncentive: ethers.parseEther("1000000"),
  };

  console.log("\n=== Deploying Phase 1a L1 Stack (Sepolia) ===\n");
  const deployment = await deployL1Stack(config);

  // Output deployment summary
  const summary = {
    network: network.name,
    chainId: network.config.chainId,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      jinn: await deployment.jinn.getAddress(),
      veJINN: await deployment.veJINN.getAddress(),
      voteWeighting: await deployment.voteWeighting.getAddress(),
      tokenomics: await deployment.tokenomics.getAddress(),
      treasury: await deployment.treasury.getAddress(),
      dispenser: await deployment.dispenser.getAddress(),
      depository: await deployment.depository.getAddress(),
      bondCalculator: await deployment.bondCalculator.getAddress(),
    },
    config: {
      epochLength: config.epochLength,
      maxNumClaimingEpochs: config.maxNumClaimingEpochs,
      maxNumStakingTargets: config.maxNumStakingTargets,
    },
  };

  console.log("\n=== Deployment Summary ===");
  console.log(JSON.stringify(summary, null, 2));

  // Write deployment file
  const fs = await import("fs");
  fs.writeFileSync(
    `deployment-phase1a-${network.name}.json`,
    JSON.stringify(summary, null, 2)
  );
  console.log(`\nDeployment saved to deployment-phase1a-${network.name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Test deployment locally**

```bash
cd contracts
npx hardhat run scripts/deploy-phase1a.ts --network hardhat
```

Expected: Full L1 stack deploys on local Hardhat network. Deployment JSON written to disk.

- [ ] **Step 3: Commit**

```bash
git add contracts/scripts/deploy-phase1a.ts
git commit -m "feat: add Phase 1a full-stack deployment script"
```

---

## Task 8: Write Integration Test — Epoch Emission Flow

**Files:**
- Create: `contracts/test/phase1/EpochEmission.test.ts`

- [ ] **Step 1: Write the end-to-end epoch emission test**

This test deploys the full L1 stack and verifies that an epoch produces JINN emissions.

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployL1Stack, DeployConfig } from "../scripts/lib/deploy-helpers";

describe("Phase 1a: Epoch Emission Flow", function () {
  async function deployFullStackFixture() {
    const [deployer, operator] = await ethers.getSigners();

    const config: DeployConfig = {
      deployer,
      epochLength: 86400, // 1 day for fast testing
      componentRegistry: ethers.ZeroAddress,
      agentRegistry: ethers.ZeroAddress,
      serviceRegistry: ethers.ZeroAddress,
      donatorBlacklist: ethers.ZeroAddress,
      maxNumClaimingEpochs: 10,
      maxNumStakingTargets: 100,
      defaultMinStakingWeight: 100n,
      defaultMaxStakingIncentive: ethers.parseEther("1000000"),
    };

    const deployment = await deployL1Stack(config);
    return { deployment, deployer, operator, config };
  }

  it("should deploy all contracts with correct addresses", async function () {
    const { deployment } = await loadFixture(deployFullStackFixture);

    expect(await deployment.jinn.getAddress()).to.not.equal(ethers.ZeroAddress);
    expect(await deployment.treasury.getAddress()).to.not.equal(ethers.ZeroAddress);
    expect(await deployment.tokenomics.getAddress()).to.not.equal(ethers.ZeroAddress);
    expect(await deployment.dispenser.getAddress()).to.not.equal(ethers.ZeroAddress);
  });

  it("should have Treasury as JINN minter", async function () {
    const { deployment } = await loadFixture(deployFullStackFixture);
    const treasuryAddr = await deployment.treasury.getAddress();
    expect(await deployment.jinn.minter()).to.equal(treasuryAddr);
  });

  it("should advance epoch after epoch length passes", async function () {
    const { deployment, config } = await loadFixture(deployFullStackFixture);

    // Read initial epoch
    const initialEpoch = await deployment.tokenomics.epochCounter();

    // Advance time past epoch length
    await time.increase(config.epochLength + 1);

    // Trigger checkpoint
    // NOTE: This may revert if registries are needed. If so, this test
    // documents that we need stub contracts. Adjust accordingly.
    await deployment.tokenomics.checkpoint();

    // Verify epoch advanced
    const newEpoch = await deployment.tokenomics.epochCounter();
    expect(newEpoch).to.equal(initialEpoch + 1n);
  });

  it("should mint JINN during epoch checkpoint", async function () {
    const { deployment, config } = await loadFixture(deployFullStackFixture);

    const treasuryAddr = await deployment.treasury.getAddress();
    const balanceBefore = await deployment.jinn.balanceOf(treasuryAddr);

    // Advance time and checkpoint
    await time.increase(config.epochLength + 1);
    await deployment.tokenomics.checkpoint();

    const balanceAfter = await deployment.jinn.balanceOf(treasuryAddr);
    // Treasury should have received minted JINN
    expect(balanceAfter).to.be.gt(balanceBefore);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd contracts
npx hardhat test test/phase1/EpochEmission.test.ts
```

Expected outcomes:
- **Best case:** All tests pass — OLAS contracts work with zero-address registries.
- **Likely case:** `checkpoint()` reverts due to registry calls. This is the moment we learn exactly what stubs are needed. Read the revert reason, find the failing call in the Tokenomics code, and determine whether a no-op stub or a code change is required.
- **Action on failure:** Document which interfaces need stubs, create minimal stub contracts in `contracts/src/phase1/stubs/`, redeploy, and re-run.

- [ ] **Step 3: Fix any failures and iterate**

If `checkpoint()` fails:
1. Read the revert message
2. Find the line in `Tokenomics.sol` that reverts
3. If it's a registry call, deploy a no-op stub implementing that interface
4. If it's a fundamental requirement, make a targeted change to the vendored contract (document exactly what changed and why)
5. Re-run tests

- [ ] **Step 4: Commit**

```bash
git add contracts/test/phase1/ contracts/src/phase1/
git commit -m "test: add Phase 1a epoch emission integration test"
```

---

## Task 9: Deploy and Test Staking on Base Sepolia (L2)

**Files:**
- Create: `contracts/scripts/deploy-phase1a-l2.ts`
- Create: `contracts/test/phase1/StakingDistribution.test.ts`

- [ ] **Step 1: Write L2 staking deployment script**

This deploys the staking infrastructure on Base Sepolia. The staking contract accepts JINN (bridged) instead of OLAS.

```typescript
import { ethers, network } from "hardhat";

interface L2DeployConfig {
  jinnTokenL2: string;     // Bridged JINN address on Base Sepolia
  serviceRegistry: string; // OLAS service registry on Base Sepolia (if exists) or stub
  activityCheckerAddress?: string; // Existing or deploy new
}

async function main() {
  const [deployer] = await ethers.getSigners();

  if (network.name !== "baseSepolia" && network.name !== "hardhat") {
    throw new Error("L2 deployment targets Base Sepolia");
  }

  // Deploy activity checker (JinnRouter pattern)
  // Reuse existing RestorationActivityChecker or deploy JinnRouter
  const ActivityCheckerFactory = await ethers.getContractFactory("RestorationActivityChecker");
  const livenessRatio = 230481481481481n; // Same as JinnRouter V3
  const activityChecker = await ActivityCheckerFactory.connect(deployer).deploy(livenessRatio);
  await activityChecker.waitForDeployment();
  console.log(`Activity Checker: ${await activityChecker.getAddress()}`);

  // Deploy StakingToken via StakingFactory
  // OR deploy StakingToken directly for testnet simplicity
  //
  // StakingToken.initialize() params:
  // - StakingParams struct (see OLAS StakingBase)
  // - serviceRegistryTokenUtility address
  // - stakingToken address (JINN on L2)
  //
  // For testnet: deploy directly, not via factory
  // READ the vendored StakingToken.sol to confirm initialize() signature

  console.log("\n=== L2 Deployment Complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Write local staking distribution test**

Test that staking with JINN works on a local Hardhat fork:

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Phase 1a: L2 Staking Distribution", function () {
  async function deployStakingFixture() {
    const [deployer, operator] = await ethers.getSigners();

    // Deploy JINN token locally (simulating bridged JINN on L2)
    const JINNFactory = await ethers.getContractFactory("JINN");
    const jinn = await JINNFactory.deploy();

    // Deploy activity checker
    const ActivityCheckerFactory = await ethers.getContractFactory("RestorationActivityChecker");
    const activityChecker = await ActivityCheckerFactory.deploy(230481481481481n);

    // Deploy staking contract with JINN as staking token
    // FILL IN: actual StakingToken deployment after reading vendored contract
    // const stakingToken = await StakingTokenFactory.deploy();
    // await stakingToken.initialize(stakingParams, serviceRegistryTokenUtility, jinnAddr);

    return { jinn, activityChecker, deployer, operator };
  }

  it("should deploy activity checker with correct liveness ratio", async function () {
    const { activityChecker } = await loadFixture(deployStakingFixture);
    expect(await activityChecker.livenessRatio()).to.equal(230481481481481n);
  });

  it("should record activity and pass liveness check", async function () {
    const { activityChecker, operator } = await loadFixture(deployStakingFixture);

    // Record some activity
    await activityChecker.recordActivity(operator.address, 0); // CREATE
    await activityChecker.recordActivity(operator.address, 1); // DELIVER

    // Verify activity count
    expect(await activityChecker.activityCounts(operator.address)).to.equal(2n);
  });

  // Additional tests for staking + claiming flow to be added
  // after StakingToken deployment is implemented
});
```

- [ ] **Step 3: Run tests**

```bash
cd contracts
npx hardhat test test/phase1/StakingDistribution.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add contracts/scripts/deploy-phase1a-l2.ts contracts/test/phase1/StakingDistribution.test.ts
git commit -m "feat: add Phase 1a L2 staking deployment and tests"
```

---

## Task 10: Write Bridge Deployment (L1 ↔ L2)

**Files:**
- Modify: `contracts/scripts/deploy-phase1a.ts` (add bridge deployment)
- Create: `contracts/test/phase1/Bridge.test.ts`

- [ ] **Step 1: Research OP Stack bridge addresses on Sepolia**

Find the Sepolia addresses for:
- `L1StandardBridgeProxy` (Sepolia)
- `L1CrossDomainMessengerProxy` (Sepolia)
- `L2CrossDomainMessengerProxy` (Base Sepolia)

These are infrastructure contracts deployed by the OP Stack. They're the same for all tokens bridging between Sepolia and Base Sepolia.

Search: `https://docs.base.org/docs/base-contracts` or `https://docs.optimism.io/chain/addresses`

- [ ] **Step 2: Add bridge deployment to deploy-phase1a.ts**

After the L1 stack is deployed, deploy the bridge contracts:

```typescript
// Deploy OptimismDepositProcessorL1 on Sepolia
// Constructor: (olas, l1Dispenser, l1TokenRelayer, l1MessageRelayer, l2TargetChainId, olasL2)
const DepositProcessorFactory = await ethers.getContractFactory("OptimismDepositProcessorL1");
const depositProcessor = await DepositProcessorFactory.deploy(
  jinnAddress,           // JINN token on L1
  dispenserAddress,       // Dispenser on L1
  L1_STANDARD_BRIDGE,    // OP Stack L1StandardBridgeProxy on Sepolia
  L1_CROSS_DOMAIN_MSG,   // OP Stack L1CrossDomainMessengerProxy on Sepolia
  84532,                  // Base Sepolia chain ID
  jinnL2Address           // JINN (bridged) on Base Sepolia
);
```

The L2 side (OptimismTargetDispenserL2) is deployed on Base Sepolia:

```typescript
// Deploy on Base Sepolia
// Constructor: (olas, stakingFactory, l2MessageRelayer, l1DepositProcessor, l1SourceChainId)
const TargetDispenserFactory = await ethers.getContractFactory("OptimismTargetDispenserL2");
const targetDispenser = await TargetDispenserFactory.deploy(
  jinnL2Address,          // Bridged JINN on Base Sepolia
  stakingFactoryAddress,  // StakingFactory on Base Sepolia
  L2_CROSS_DOMAIN_MSG,    // OP Stack L2CrossDomainMessengerProxy on Base Sepolia
  depositProcessorAddress, // L1 DepositProcessor on Sepolia
  11155111                 // Sepolia chain ID
);
```

- [ ] **Step 3: Write bridge integration test (local mock)**

For local testing, mock the cross-domain messenger behavior:

```typescript
describe("Phase 1a: Bridge Configuration", function () {
  it("should deploy DepositProcessor with correct JINN and chain config", async function () {
    // Deploy and verify constructor params are stored correctly
    // Check: olas() returns JINN address
    // Check: l2TargetChainId matches Base Sepolia
  });

  it("should deploy TargetDispenser with correct L1 source config", async function () {
    // Check: l1SourceChainId matches Sepolia
    // Check: l1DepositProcessor matches L1 deployment
  });
});
```

Note: Full bridge testing requires actual cross-chain message passing. This is tested on live Sepolia ↔ Base Sepolia, not locally. Local tests verify configuration only.

**Governance note:** The spec calls for an OpenZeppelin TimelockController with a Safe multisig. On testnet, the deployer wallet acts as governance directly (no Timelock needed for iteration). Add TimelockController deployment when moving toward mainnet — it's standard OpenZeppelin infrastructure and doesn't affect the tokenomics flow.

- [ ] **Step 4: Commit**

```bash
git add contracts/scripts/ contracts/test/phase1/
git commit -m "feat: add OP Stack bridge deployment for Sepolia <-> Base Sepolia"
```

---

## Task 11: Client Testnet Configuration

**Files:**
- Modify: `client/src/earning/contracts.ts`
- Create: `client/src/earning/jinn-rewards.ts`
- Modify: `client/src/config.ts`

- [ ] **Step 1: Add testnet chain config to contracts.ts**

Read `client/src/earning/contracts.ts` to understand the existing `getChainConfig()` pattern. Add a testnet variant:

```typescript
// Add alongside existing 'base' config
export function getChainConfig(network: 'base' | 'base-sepolia') {
  if (network === 'base-sepolia') {
    return {
      // Addresses filled in after deployment
      serviceRegistry: '0x...', // Base Sepolia service registry (if exists)
      stakingContract: '0x...', // Phase 1a staking contract
      olasToken: '0x...',       // Bridged JINN on Base Sepolia
      mechMarketplace: '0x...', // Base Sepolia mech marketplace (if exists)
      // ... other addresses from deployment-phase1a-baseSepolia.json
    };
  }
  // existing base config...
}
```

Note: Actual addresses are filled in after deployment. Use placeholder addresses during development and replace from deployment JSON.

- [ ] **Step 2: Add network config option**

Read `client/src/config.ts`. Add a `network` config key:

```typescript
// In the config schema
network: z.enum(['mainnet', 'testnet']).default('mainnet'),
```

When `network: 'testnet'`, the client uses Base Sepolia RPC and testnet contract addresses.

- [ ] **Step 3: Create jinn-rewards.ts**

```typescript
import { type PublicClient, type WalletClient } from 'viem';

/**
 * Claim JINN rewards from the Phase 1a staking contract on Base Sepolia.
 * Mirrors the OLAS staking claim pattern in earning/bootstrap.ts.
 */
export async function claimJinnRewards(
  publicClient: PublicClient,
  walletClient: WalletClient,
  stakingContractAddress: `0x${string}`,
  serviceId: number
): Promise<{ claimed: boolean; amount: bigint }> {
  // Read available rewards
  // Call staking contract's claim function
  // Return claimed amount
  //
  // IMPLEMENTATION: Follow the same pattern as the existing OLAS
  // staking claim in earning/bootstrap.ts. Read that file first
  // to match the viem client usage patterns.
  throw new Error('TODO: implement after contracts are deployed');
}
```

- [ ] **Step 4: Run existing client tests to verify no regressions**

```bash
cd client
npx vitest run
```

Expected: All 33 existing tests pass. The new config option should have a default that preserves existing behavior.

- [ ] **Step 5: Commit**

```bash
git add client/src/earning/contracts.ts client/src/earning/jinn-rewards.ts client/src/config.ts
git commit -m "feat(client): add testnet config and JINN reward claiming scaffold"
```

---

## Task 12: End-to-End Deployment Validation Script

**Files:**
- Create: `contracts/scripts/validate-phase1a.ts`

- [ ] **Step 1: Write the validation script**

This is the "redeploy and test the whole thing" script — the equivalent of `client/scripts/e2e-validate.ts` but for Phase 1a tokenomics.

```typescript
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployL1Stack, DeployConfig } from "./lib/deploy-helpers";

/**
 * Phase 1a End-to-End Validation
 * 
 * Deploys the complete L1 tokenomics stack on local Hardhat,
 * simulates epoch advancement, and verifies JINN distribution.
 * 
 * Run: npx hardhat run scripts/validate-phase1a.ts
 */
async function main() {
  const [deployer, operator] = await ethers.getSigners();
  console.log("=== Phase 1a E2E Validation ===\n");

  // 1. Deploy full L1 stack
  console.log("Step 1: Deploying L1 stack...");
  const config: DeployConfig = {
    deployer,
    epochLength: 86400, // 1 day for fast validation
    componentRegistry: ethers.ZeroAddress,
    agentRegistry: ethers.ZeroAddress,
    serviceRegistry: ethers.ZeroAddress,
    donatorBlacklist: ethers.ZeroAddress,
    maxNumClaimingEpochs: 10,
    maxNumStakingTargets: 100,
    defaultMinStakingWeight: 100n,
    defaultMaxStakingIncentive: ethers.parseEther("1000000"),
  };
  const deployment = await deployL1Stack(config);
  console.log("  ✓ L1 stack deployed\n");

  // 2. Verify JINN token
  console.log("Step 2: Verifying JINN token...");
  const name = await deployment.jinn.name();
  const symbol = await deployment.jinn.symbol();
  console.log(`  Token: ${name} (${symbol})`);
  console.assert(name === "Jinn", "Token name mismatch");
  console.assert(symbol === "JINN", "Token symbol mismatch");
  console.log("  ✓ Token verified\n");

  // 3. Verify Treasury is minter
  console.log("Step 3: Verifying Treasury is JINN minter...");
  const treasuryAddr = await deployment.treasury.getAddress();
  const minter = await deployment.jinn.minter();
  console.assert(minter === treasuryAddr, "Treasury is not minter");
  console.log("  ✓ Treasury is minter\n");

  // 4. Advance time and trigger epoch
  console.log("Step 4: Advancing epoch...");
  const epochBefore = await deployment.tokenomics.epochCounter();
  console.log(`  Current epoch: ${epochBefore}`);
  
  await time.increase(config.epochLength + 1);
  await deployment.tokenomics.checkpoint();
  
  const epochAfter = await deployment.tokenomics.epochCounter();
  console.log(`  New epoch: ${epochAfter}`);
  console.assert(epochAfter > epochBefore, "Epoch did not advance");
  console.log("  ✓ Epoch advanced\n");

  // 5. Check JINN minted
  console.log("Step 5: Checking JINN emissions...");
  const treasuryBalance = await deployment.jinn.balanceOf(treasuryAddr);
  console.log(`  Treasury JINN balance: ${ethers.formatEther(treasuryBalance)}`);
  console.assert(treasuryBalance > 0n, "No JINN minted");
  console.log("  ✓ JINN emitted\n");

  console.log("=== Phase 1a E2E Validation PASSED ===");
}

main().catch((error) => {
  console.error("=== VALIDATION FAILED ===");
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

In `contracts/package.json`, add:

```json
"scripts": {
  "validate:phase1a": "hardhat run scripts/validate-phase1a.ts"
}
```

- [ ] **Step 3: Run validation**

```bash
cd contracts
npm run validate:phase1a
```

Expected: All steps pass. If any step fails, debug and fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add contracts/scripts/validate-phase1a.ts contracts/package.json
git commit -m "feat: add Phase 1a end-to-end validation script"
```

---

## Task 13: Deploy to Sepolia + Base Sepolia

This task is executed manually (not in local tests) once all local validation passes.

**Generated artifacts (typical names):**
- `contracts/deployment-phase1a-sepolia.json` — L1 tokenomics stack
- `contracts/deployment-phase1a-token-baseSepolia.json` — L2 **bridge-compatible** JINN representation (Optimism mintable ERC-20)
- `contracts/deployment-phase1a-l2-baseSepolia.json` — L2 staking factory + proxy + activity checker
- `contracts/deployment-phase1a-bridge-sepolia-baseSepolia.json` — L1 deposit processor + L2 target dispenser

**Scripts (operational order):**
- `scripts/create-phase1a-l2-token.ts` — create L2 JINN via Base Sepolia `OptimismMintableERC20Factory` (`0x4200000000000000000000000000000000000012`); npm: `npm run deploy:l2-token`
- `scripts/deploy-phase1a-l2.ts` — factory-backed `StakingProxy` (requires external `JINN_TOKEN_ADDRESS` + registry env on live networks)
- `scripts/deploy-phase1a-bridge.ts` — two-signer / two-network bridge wiring from artifacts
- `scripts/phase1a-unpause-dispenser.ts`, `phase1a-set-deposit-processor.ts`, `phase1a-add-staking-nominee.ts`, `phase1a-vote-staking-weight.ts` — governance sequence on L1
- `scripts/status-phase1a-live.ts` — read-only preflight across artifacts + chain state
- `scripts/validate-phase1a.ts` — local / scripted validation where applicable

- [ ] **Step 1: Get testnet ETH**

Fund the deployer wallet with Sepolia ETH and Base Sepolia ETH:
- Sepolia faucet: https://sepoliafaucet.com or https://faucets.chain.link
- Base Sepolia: bridge from Sepolia or use Base Sepolia faucet

- [ ] **Step 2: Deploy L1 stack to Sepolia**

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=<key> npx hardhat run scripts/deploy-phase1a.ts --network sepolia
```

Record all deployed addresses from the output JSON.

- [ ] **Step 3: Create the bridge-compatible L2 JINN token on Base Sepolia**

The L2 token used by OLAS-pattern bridge and staking must be an **Optimism mintable** ERC-20 tied to the Sepolia JINN address — not a standalone `TestERC20`.

```bash
cd contracts
# Uses deployment-phase1a-sepolia.json for L1 JINN by default; override with JINN_TOKEN_L1 if needed.
DEPLOYER_PRIVATE_KEY=<base-sepolia-key> npm run deploy:l2-token
```

This writes `deployment-phase1a-token-baseSepolia.json` with the new `l2Token` address. **Then** bridge JINN from Sepolia to that L2 address via the OP Stack StandardBridge (`depositERC20` / `depositERC20To`) so the target dispenser and staking contract have liquidity when you test claims.

- [ ] **Step 4: Deploy L2 staking stack on Base Sepolia**

Live networks require explicit inputs (see **Official Autonolas registry constants** above):

```bash
cd contracts
export JINN_TOKEN_ADDRESS=<l2Token from deployment-phase1a-token-baseSepolia.json>
export SERVICE_REGISTRY_ADDRESS=0x31D3202d8744B16A120117A053459DDFAE93c855
export SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS=0xeB49bE5DF00F74bd240DE4535DDe6Bc89CEfb994
export SAFE_PROXY_HASH=0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000
DEPLOYER_PRIVATE_KEY=<key> npx hardhat run scripts/deploy-phase1a-l2.ts --network baseSepolia
```

- [ ] **Step 5: Deploy bridge adapters (Sepolia + Base Sepolia)**

Run `scripts/deploy-phase1a-bridge.ts` with the configured L1/L2 RPCs and signers so both `OptimismDepositProcessorL1` and `OptimismTargetDispenserL2` are recorded in `deployment-phase1a-bridge-sepolia-baseSepolia.json`. Then execute the L1 governance scripts to map the deposit processor, adjust dispenser pause state as needed, add the staking nominee, and vote weights (see script headers for ordering).

- [ ] **Step 6: Preflight**

```bash
cd contracts
npx hardhat run scripts/status-phase1a-live.ts
```

- [ ] **Step 7: Update client config with deployed addresses**

Fill in the actual addresses in `client/src/earning/contracts.ts` from the deployment JSONs.

- [ ] **Step 8: Commit deployment records**

```bash
git add contracts/deployment-phase1a-*.json client/src/earning/contracts.ts
git commit -m "chore: record Phase 1a testnet deployment addresses"
```

---

## Summary

| Task | Description | Dependencies |
|------|-------------|--------------|
| 1 | Vendor OLAS governance contracts (JINN token, veOLAS, VoteWeighting) | None |
| 2 | Vendor OLAS tokenomics contracts (Treasury, Dispenser, Tokenomics, Depository) | None |
| 3 | Vendor OLAS staking and bridge contracts | None |
| 4 | Update Hardhat config (networks, compilation) | Tasks 1-3 |
| 5 | Write JINN token tests | Tasks 1, 4 |
| 6 | Analyze dependencies and write deployment helpers | Tasks 1-4 |
| 7 | Write full deployment script | Task 6 |
| 8 | Write epoch emission integration test | Tasks 6-7 |
| 9 | Deploy and test staking on L2 | Tasks 4, 8 |
| 10 | Write bridge deployment | Tasks 7, 9 |
| 11 | Client testnet configuration | Task 9 |
| 12 | End-to-end validation script | Tasks 7-10 |
| 13 | Deploy to live testnets (L1 stack → L2 mintable JINN → L2 factory staking → bridge → governance → preflight) | Task 12 |

Tasks 1-3 can be parallelized. Tasks 5-8 are sequential (each builds on the last). Task 13 is the final manual deployment.
