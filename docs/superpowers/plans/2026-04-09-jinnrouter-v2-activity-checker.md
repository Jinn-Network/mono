# JinnRouter V2 + Activity Checker Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate JinnRouter with RestorationActivityCheckerV2 so the client makes one call per marketplace action and anti-farming evidence is automatically forwarded for restoration deliveries.

**Architecture:** JinnRouter V2 adds an `activityChecker` reference and an optional `evidenceHash` parameter to `claimDelivery`. On restoration delivery claims, the router forwards the evidence hash to the V2 checker's new `recordRestorationEvidence` function. The V2 checker's `getMultisigNonces` combines the router's raw activity counts (creation, eval creation, eval delivery) with its own novelty-weighted restoration delivery count. Both contracts sit behind UUPS proxies. The staking contract points at the checker proxy.

**Tech Stack:** Solidity 0.8.25, Hardhat, ethers.js v6, TypeScript, viem

**Spec:** `docs/superpowers/specs/2026-04-09-jinnrouter-v2-activity-checker-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `contracts/src/staking/JinnRouterV2.sol` | Updated router with evidence forwarding to checker |
| `contracts/src/staking/ActivityCheckerProxy.sol` | UUPS proxy for the activity checker |
| `contracts/src/staking/JinnRouterProxy.sol` | UUPS proxy for the router |
| `contracts/test/phase1/JinnRouterV2Integration.test.ts` | Integration tests for router + checker |
| `contracts/scripts/deploy-phase1b-router-checker.ts` | Deploy router V2 + checker behind proxies |

### Modified files

| File | Change |
|------|--------|
| `contracts/src/staking/RestorationActivityCheckerV2.sol` | Add `jinnRouter`, `authorizedRouter`, `recordRestorationEvidence()`, update `getMultisigNonces` to read router counters |
| `client/src/adapters/mech/types.ts` | Update `JINN_ROUTER_ABI` — `claimDelivery` gets `evidenceHash` param |
| `client/src/adapters/mech/contracts.ts` | Update `claimDelivery()` to accept and pass `evidenceHash` |
| `client/src/adapters/mech/adapter.ts` | Compute SimHash after restoration delivery, pass to `claimDelivery` |

---

## Task 1: Update RestorationActivityCheckerV2

Add `jinnRouter` and `authorizedRouter` state, a `recordRestorationEvidence` function callable only by the router, and update `getMultisigNonces` to combine router counters with novelty-weighted restoration delivery counts.

**Files:**
- Modify: `contracts/src/staking/RestorationActivityCheckerV2.sol`

- [ ] **Step 1: Add new state variables and error**

Add after the existing `comparisonWindow` state variable:

```solidity
/// @dev JinnRouter address (to read raw activity counters)
address public jinnRouter;

/// @dev Only this address can call recordRestorationEvidence
address public authorizedRouter;

/// @dev Unauthorized caller.
/// @param sender Sender address.
/// @param authorizedRouter Required authorized router address.
error UnauthorizedRouter(address sender, address authorizedRouter);
```

- [ ] **Step 2: Add `setRouterAddresses` admin function**

Add after the existing `setAntifarmingParameters` function:

```solidity
/// @notice Set JinnRouter and authorized router addresses.
function setRouterAddresses(address _jinnRouter, address _authorizedRouter) external {
    if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
    if (_jinnRouter == address(0)) revert ZeroAddress();
    if (_authorizedRouter == address(0)) revert ZeroAddress();
    jinnRouter = _jinnRouter;
    authorizedRouter = _authorizedRouter;
}
```

- [ ] **Step 3: Add `recordRestorationEvidence` function**

Add after `recordActivity`:

```solidity
/// @notice Called by the JinnRouter when a restoration delivery is claimed with evidence.
///         Only the authorized router can call this.
/// @param multisig The service multisig (Safe) address
/// @param evidenceHash SimHash of the restoration evidence
function recordRestorationEvidence(address multisig, bytes32 evidenceHash) external {
    if (msg.sender != authorizedRouter) revert UnauthorizedRouter(msg.sender, authorizedRouter);
    require(multisig != address(0), "RestorationActivityCheckerV2: zero multisig");

    uint256 weight = _computeNoveltyWeight(multisig, evidenceHash);
    evidenceHashes[multisig].push(evidenceHash);
    noveltyWeightedCounts[multisig] += weight;

    emit ActivityRecordedWithEvidence(multisig, uint8(ActivityType.DELIVER), evidenceHash, weight);
}
```

- [ ] **Step 4: Add an interface for reading JinnRouter counters**

Add at the top of the file, after the `IMultisig` interface:

```solidity
/// @dev JinnRouter interface for reading activity counters
interface IJinnRouter {
    function creationCount(address multisig) external view returns (uint256);
    function restorationDeliveryCount(address multisig) external view returns (uint256);
    function evaluationCreationCount(address multisig) external view returns (uint256);
    function evaluationDeliveryCount(address multisig) external view returns (uint256);
}
```

- [ ] **Step 5: Update `getMultisigNonces` to combine router + checker counts**

Replace the existing `getMultisigNonces` function:

```solidity
/// @dev Gets service multisig nonces. Combines JinnRouter raw activity counts
///      with novelty-weighted restoration delivery count from this checker.
///      If no jinnRouter is set, falls back to standalone mode (noveltyWeightedCounts only).
/// @param multisig Service multisig address.
/// @return nonces [Safe nonce, total weighted activity (1e18 scale)]
function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces) {
    nonces = new uint256[](2);
    nonces[0] = IMultisig(multisig).nonce();

    if (jinnRouter != address(0)) {
        // Read raw counts from router (full weight = 1e18 each)
        uint256 routerActivity =
            (IJinnRouter(jinnRouter).creationCount(multisig) +
             IJinnRouter(jinnRouter).evaluationCreationCount(multisig) +
             IJinnRouter(jinnRouter).evaluationDeliveryCount(multisig)) * 1e18;
        // Add novelty-weighted restoration delivery count from this checker
        nonces[1] = routerActivity + noveltyWeightedCounts[multisig];
    } else {
        // Standalone mode (backward compat)
        nonces[1] = noveltyWeightedCounts[multisig];
    }
}
```

- [ ] **Step 6: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add contracts/src/staking/RestorationActivityCheckerV2.sol
git commit -m "feat: add router integration to RestorationActivityCheckerV2"
```

---

## Task 2: Write JinnRouter V2

New router contract that extends V1 with evidence forwarding. Uses the same proxy-aware storage layout.

**Files:**
- Create: `contracts/src/staking/JinnRouterV2.sol`

- [ ] **Step 1: Create JinnRouterV2**

Copy `contracts/src/staking/JinnRouter.sol` to `JinnRouterV2.sol`. Make these changes:

1. Rename the contract to `JinnRouterV2`
2. Add an `activityChecker` address in storage after `initialized` (slot 5):

```solidity
// Slot 5
address public activityChecker;
```

3. Update `initialize` to accept the checker address:

```solidity
function initialize(address _mechMarketplace, uint256 _livenessRatio, address _activityChecker) external {
    if (initialized) revert AlreadyInitialized();
    if (_mechMarketplace == address(0)) revert ZeroAddress();
    if (_livenessRatio == 0) revert ZeroValue();
    if (_activityChecker == address(0)) revert ZeroAddress();

    mechMarketplace = _mechMarketplace;
    livenessRatio = _livenessRatio;
    activityChecker = _activityChecker;
    initialized = true;

    emit Initialized(_mechMarketplace, _livenessRatio);
}
```

4. Update `claimDelivery` to accept an evidence hash and forward it:

```solidity
function claimDelivery(bytes32 requestId, bytes32 evidenceHash) external {
    if (!initialized) revert NotInitialized();

    JobType jobType = requestTypes[requestId];
    if (jobType == JobType.NONE) revert RequestNotFound(requestId);
    if (claimed[requestId]) revert AlreadyClaimed(requestId);

    IMechMarketplace.RequestStatus status = IMechMarketplace(mechMarketplace).getRequestStatus(requestId);
    if (status != IMechMarketplace.RequestStatus.Delivered) revert NotDelivered(requestId);

    claimed[requestId] = true;

    if (jobType == JobType.RESTORATION) {
        restorationDeliveryCount[msg.sender]++;
        restorationDeliveryClaimed[requestId] = true;

        // Forward evidence to activity checker for anti-farming
        if (evidenceHash != bytes32(0) && activityChecker != address(0)) {
            IActivityCheckerV2(activityChecker).recordRestorationEvidence(msg.sender, evidenceHash);
        }
    } else {
        evaluationDeliveryCount[msg.sender]++;
    }

    emit DeliveryClaimed(msg.sender, requestId, uint8(jobType));
}
```

5. Add the interface at the top:

```solidity
interface IActivityCheckerV2 {
    function recordRestorationEvidence(address multisig, bytes32 evidenceHash) external;
}
```

6. **Remove** `getMultisigNonces` and `isRatioPass` — the staking contract now points at the checker, not the router. Keep the activity counter mappings public (the checker reads them).

- [ ] **Step 2: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

- [ ] **Step 3: Commit**

```bash
git add contracts/src/staking/JinnRouterV2.sol
git commit -m "feat: add JinnRouterV2 with evidence forwarding to activity checker"
```

---

## Task 3: Write proxy contracts

Simple UUPS proxies for the router and checker, following the existing KarmaProxy pattern.

**Files:**
- Create: `contracts/src/staking/ActivityCheckerProxy.sol`
- Create: `contracts/src/staking/JinnRouterProxy.sol`

- [ ] **Step 1: Create ActivityCheckerProxy**

Follow the `KarmaProxy` pattern exactly (`contracts/src/vendor/mech/proxies/KarmaProxy.sol`). Change the storage slot to `keccak256("ACTIVITY_CHECKER_PROXY")`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

error ZeroImplementationAddress();
error ZeroData();
error InitializationFailed();

/// @title ActivityCheckerProxy - UUPS proxy for the activity checker
contract ActivityCheckerProxy {
    // keccak256("ACTIVITY_CHECKER_PROXY")
    bytes32 public constant ACTIVITY_CHECKER_PROXY = 0x6b19506f33181dcd8bf12ba9eb8091ae9adf0d818d65c32001c0c109646101b8;

    constructor(address implementation, bytes memory initData) {
        if (implementation == address(0)) revert ZeroImplementationAddress();
        if (initData.length == 0) revert ZeroData();

        assembly {
            sstore(ACTIVITY_CHECKER_PROXY, implementation)
        }
        (bool success, ) = implementation.delegatecall(initData);
        if (!success) revert InitializationFailed();
    }

    fallback() external payable {
        assembly {
            let implementation := sload(ACTIVITY_CHECKER_PROXY)
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if eq(success, 0) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    function getImplementation() external view returns (address implementation) {
        assembly {
            implementation := sload(ACTIVITY_CHECKER_PROXY)
        }
    }
}
```

- [ ] **Step 2: Create JinnRouterProxy**

Same pattern, slot = `keccak256("JINN_ROUTER_PROXY")`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

error ZeroImplementationAddress();
error ZeroData();
error InitializationFailed();

/// @title JinnRouterProxy - UUPS proxy for the JinnRouter
contract JinnRouterProxy {
    // keccak256("JINN_ROUTER_PROXY")
    bytes32 public constant JINN_ROUTER_PROXY = 0x7ff8b2d5fad2fe8fb4c75b11d9b640a3b52819959b6fe5f04434cf6cdafd7222;

    constructor(address implementation, bytes memory initData) {
        if (implementation == address(0)) revert ZeroImplementationAddress();
        if (initData.length == 0) revert ZeroData();

        assembly {
            sstore(JINN_ROUTER_PROXY, implementation)
        }
        (bool success, ) = implementation.delegatecall(initData);
        if (!success) revert InitializationFailed();
    }

    fallback() external payable {
        assembly {
            let implementation := sload(JINN_ROUTER_PROXY)
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if eq(success, 0) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    function getImplementation() external view returns (address implementation) {
        assembly {
            implementation := sload(JINN_ROUTER_PROXY)
        }
    }
}
```

- [ ] **Step 3: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

- [ ] **Step 4: Commit**

```bash
git add contracts/src/staking/ActivityCheckerProxy.sol contracts/src/staking/JinnRouterProxy.sol
git commit -m "feat: add UUPS proxy contracts for activity checker and JinnRouter"
```

---

## Task 4: Write integration tests

Test the full flow: deploy stack, create job, deliver, claim with evidence, verify novelty weighting feeds into `getMultisigNonces` and `isRatioPass`.

**Files:**
- Create: `contracts/test/phase1/JinnRouterV2Integration.test.ts`

- [ ] **Step 1: Write integration tests**

Tests to cover:

1. **Deployment** — deploy checker V2 implementation, ActivityCheckerProxy, JinnRouterV2 implementation, JinnRouterProxy. Wire them together (checker.setRouterAddresses, router.initialize with checker proxy).

2. **Restoration job with evidence forwarding:**
   - Create a mech + restoration job via router
   - Deliver via mech
   - Claim delivery with evidence hash → verify checker's `noveltyWeightedCounts` incremented
   - Claim delivery with zero evidence hash → verify checker NOT called (no evidence stored)

3. **Anti-farming through router:**
   - Claim delivery with novel evidence → full weight
   - Claim delivery with duplicate evidence → zero weight
   - Verify `getMultisigNonces` reflects the novelty weighting

4. **getMultisigNonces combines router + checker:**
   - Create restoration job (creation count goes up)
   - Claim restoration delivery with evidence (novelty-weighted count goes up)
   - Create evaluation job (eval creation count goes up)
   - Verify `getMultisigNonces` returns: safeNonce + (creation * 1e18 + eval_creation * 1e18 + novelty_weighted_delivery)

5. **isRatioPass with combined counts:**
   - Novel work → passes
   - Farmed work (duplicate evidence) → fails
   - Mixed (some novel, some duplicate) → depends on ratio

6. **Evaluation delivery claims don't submit evidence:**
   - Claim evaluation delivery with evidence hash → evidence NOT forwarded to checker

7. **Unauthorized router rejected:**
   - Call `recordRestorationEvidence` from non-router address → reverts

8. **Proxy upgradeability:**
   - Verify `getImplementation()` returns correct addresses

Use the same test setup pattern as `contracts/test/phase1/MechMarketplace.test.ts` — deploy the full mech marketplace stack, create a mock service, etc. Use `MockSafeWithNonce` for `getMultisigNonces` end-to-end testing.

- [ ] **Step 2: Run tests**

```bash
cd contracts
npx hardhat test test/phase1/JinnRouterV2Integration.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run all tests**

```bash
cd contracts
npx hardhat test
```

Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/phase1/JinnRouterV2Integration.test.ts
git commit -m "test: add JinnRouterV2 + activity checker integration tests"
```

---

## Task 5: Write deployment script

Deploy the router V2 + checker V2 behind proxies, wire them together, create a new staking proxy.

**Files:**
- Create: `contracts/scripts/deploy-phase1b-router-checker.ts`

- [ ] **Step 1: Write the deployment script**

Deployment sequence:

1. Deploy RestorationActivityCheckerV2 implementation (constructor: livenessRatio, deployer, similarityThreshold=64, similarDecayMultiplier=0, comparisonWindow=20)
2. Deploy ActivityCheckerProxy (implementation, initData=empty — V2 uses constructor, not initialize)

Actually — the V2 checker uses a constructor with immutables, not an initialize pattern. This won't work behind a proxy because constructor args set immutables in the implementation's bytecode, not in the proxy's storage.

**Correction needed:** The V2 checker needs to be adapted to use an `initialize` pattern instead of constructor for the mutable state (owner, similarityThreshold, etc.) while keeping `livenessRatio` as an immutable. Or simpler: deploy V2 without a proxy for now, since the staking contract's `activityChecker` reference is set at init time. To upgrade, deploy a new staking proxy pointing at the new checker.

Revised sequence:

1. Deploy RestorationActivityCheckerV2 (constructor args directly)
2. Deploy JinnRouterV2 implementation
3. Deploy JinnRouterProxy (implementation, initData = `initialize(marketplace, livenessRatio, checkerAddress)`)
4. Call `checker.setRouterAddresses(routerProxy, routerProxy)`
5. Create new StakingToken proxy via existing StakingFactory with `activityChecker = checkerAddress`

Environment variables:
- `DEPLOYER_PRIVATE_KEY`
- `BASE_SEPOLIA_RPC_URL`
- `PHASE1A_TIMING_PROFILE`
- `MECH_DEPLOYMENT_PATH` — path to Phase 1b mech deployment artifact (for marketplace address)
- `L2_DEPLOYMENT_PATH` — path to Phase 1a L2 deployment artifact (for StakingFactory, JINN token)
- `SERVICE_REGISTRY_ADDRESS` — default: `0x31D3202d8744B16A120117A053459DDFAE93c855`

Output artifact: `deployment-phase1b-router-checker-baseSepolia.json` (or `-fast`)

- [ ] **Step 2: Verify local deployment**

```bash
cd contracts
npx hardhat run scripts/deploy-phase1b-router-checker.ts
```

- [ ] **Step 3: Commit**

```bash
git add contracts/scripts/deploy-phase1b-router-checker.ts
git commit -m "feat: add deployment script for JinnRouterV2 + activity checker"
```

---

## Task 6: Update client ABI and claimDelivery

Update the client to pass evidence hashes on restoration delivery claims.

**Files:**
- Modify: `client/src/adapters/mech/types.ts`
- Modify: `client/src/adapters/mech/contracts.ts`
- Modify: `client/src/adapters/mech/adapter.ts`

- [ ] **Step 1: Update JINN_ROUTER_ABI in types.ts**

Change the `claimDelivery` entry to include the `evidenceHash` parameter:

```typescript
{
  name: 'claimDelivery',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'requestId', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
  outputs: [],
},
```

- [ ] **Step 2: Update claimDelivery in contracts.ts**

Add `evidenceHash` parameter to the `claimDelivery` function:

```typescript
export async function claimDelivery(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  requestId: Hex,
  evidenceHash: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000',
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'claimDelivery',
    args: [requestId, evidenceHash],
  });
  // ... rest unchanged
```

- [ ] **Step 3: Update adapter.ts to compute and pass evidence hash**

In `adapter.ts`, the delivery watcher loop calls `claimDelivery`. For restoration deliveries, compute the SimHash from the delivered data and pass it.

Find the restoration delivery claim call (~line 285) and update:

```typescript
import { computeEvidenceSimHash, type EvidenceCheckpointV1 } from '../../earning/evidence-simhash.js';

// In the delivery watcher, after determining this is a restoration delivery:
let evidenceHash: `0x${string}` = '0x0000000000000000000000000000000000000000000000000000000000000000';

if (this.pendingEvaluations.has(requestId)) {
  // This is a restoration delivery — compute evidence SimHash from the delivered data
  try {
    const checkpoint: EvidenceCheckpointV1 = {
      version: 1,
      desiredStateHash: requestId, // Use requestId as proxy for desired state identity
      toolCalls: [], // Will be populated from delivery data when available
      externalInteractions: [],
      outcome: 'success',
    };
    evidenceHash = computeEvidenceSimHash(checkpoint);
  } catch (err) {
    console.error(`[mech] Failed to compute evidence SimHash for ${requestId}:`, err);
    // Proceed without evidence — backward compatible
  }
}

await claimDelivery(
  this.publicClient,
  this.walletClient,
  this.config.safeAddress,
  this.config.routerAddress,
  requestId as `0x${string}`,
  evidenceHash,
);
```

Note: The evidence checkpoint is minimal for now — the full structured evidence will come when the runner captures detailed execution data. The important thing is that different deliveries produce different SimHashes.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd client
npx tsc --noEmit
```

- [ ] **Step 5: Run client tests**

```bash
cd client
npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add client/src/adapters/mech/types.ts client/src/adapters/mech/contracts.ts client/src/adapters/mech/adapter.ts
git commit -m "feat: pass evidence hash on restoration delivery claims"
```

---

## Task 7: Deploy to Base Sepolia and verify

Deploy the router V2 + checker, create staking proxy, fund it, and verify the full loop.

**Files:**
- Create: `contracts/deployment-phase1b-router-checker-baseSepolia-fast.json` (output)

- [ ] **Step 1: Deploy**

```bash
cd contracts
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
MECH_DEPLOYMENT_PATH=./deployment-phase1b-mech-baseSepolia-fast.json \
L2_DEPLOYMENT_PATH=./deployment-phase1a-l2-baseSepolia-fast.json \
npx hardhat run scripts/deploy-phase1b-router-checker.ts --network baseSepolia
```

- [ ] **Step 2: Commit artifact**

```bash
git add contracts/deployment-phase1b-router-checker-baseSepolia-fast.json
git commit -m "feat: deploy JinnRouterV2 + activity checker on Base Sepolia"
```

---

## Dependency Graph

```
Task 1 (update V2 checker) → Task 2 (write router V2)
                                ↓
Task 3 (proxy contracts) → Task 4 (integration tests)
                                ↓
                           Task 5 (deploy script) → Task 6 (client updates)
                                                         ↓
                                                    Task 7 (live deploy)
```

Tasks 1 and 2 are sequential (router depends on checker interface). Task 3 is independent. Task 4 needs 1-3. Tasks 5-7 are sequential.
