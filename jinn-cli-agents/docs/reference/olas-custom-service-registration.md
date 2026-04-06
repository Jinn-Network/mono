# Registering jinn-node as a Proper OLAS Service

> Reference doc for replacing the Pearl memeooorr placeholder with a native jinn-node OLAS service.
> Status: **Research complete, not yet implemented.**

---

## Problem

Operator setup (`yarn setup`) deploys a **Pearl Agents.Fun placeholder service** (memeooorr, Agent ID 43) to satisfy OLAS staking. The actual Jinn work runs as a separate jinn-node worker alongside it. This means:

- Two processes running (placeholder agent + real worker)
- The on-chain service identity says "memeooorr" not "jinn"
- The placeholder consumes resources doing nothing
- Operators must manage two lifecycles

**Goal:** Single deployment where the on-chain registered OLAS service IS the jinn-node worker.

---

## On-Chain Research (Verified Feb 2026)

### Staking contract state

Both staking contracts were queried on Base mainnet:

| Parameter | Jinn Staking (`0x0dfaFbf...`) | AgentsFun1 (`0x2585e63...`) |
|-----------|-------------------------------|----------------------------|
| `agentIds` | `[43]` | `[43]` |
| `configHash` | `0x000...000` (zero) | `0x000...000` (zero) |
| `threshold` | `0` | `0` |
| `minStakingDeposit` | 5,000 OLAS | 50 OLAS |
| `minStakingDuration` | 259,200s (3 days) | 259,200s (3 days) |
| `maxNumServices` | 10 | 20 |
| `serviceRegistry` | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |  same |
| `activityChecker` | `0x1dF0be58...` | `0x87C9922A...` |

### What `stake()` validates (from StakingBase.sol)

```solidity
// configHash check — SKIPPED when staking contract's configHash is zero
if (configHash != 0 && configHash != service.configHash) {
    revert WrongServiceConfiguration(serviceId);
}

// agentIds check — ALWAYS enforced, no zero-skip
for (uint256 i = 0; i < numAgents; ++i) {
    if (agentIds[i] != service.agentIds[i]) revert WrongAgentId(agentIds[i]);
}

// threshold check — SKIPPED when staking contract's threshold is zero
if (threshold > 0 && threshold != service.threshold) {
    revert WrongThreshold(...);
}
```

### Key findings

1. **configHash = 0x0** → Any service package hash accepted. No verification of what IPFS package the service was created from.
2. **agentIds = [43]** → Service MUST use agent_id 43. Always enforced, no bypass.
3. **threshold = 0** → Any threshold accepted.
4. **agentIds are immutable** — No setter function exists. Cannot be changed after staking contract deployment.

### Implication

To use a custom agent_id (not 43), we need a **new staking contract** initialized with our agent_id. The existing contracts are permanently locked to agent_id 43.

---

## Two Paths

### Path A: Quick — Reuse Agent ID 43 (no new contracts)

Keep agent_id 43 on-chain. Replace only the IPFS service package. The staking contract doesn't verify package contents.

**Pros:** No on-chain changes, no new contracts, no governance
**Cons:** On-chain identity still says "memeooorr" (agent_id 43)

### Path B: Proper — Register Jinn Agent + New Staking Contract

Register jinn-node as a new OLAS agent. Deploy a new staking contract initialized with the jinn agent_id. Full on-chain identity.

**Pros:** Clean on-chain identity, proper OLAS ecosystem integration
**Cons:** Requires on-chain agent registration, new staking contract deployment, OLAS token deposit for rewards pool

**Recommendation:** Start with Path A (working immediately), migrate to Path B when ready.

---

## Path A: Quick Implementation (Reuse Agent ID 43)

### Step 1: Create AEA service package

OLAS services must be valid AEA (Autonomous Economic Agent) packages uploaded to IPFS. The middleware's `ServiceBuilder` downloads and parses the package.

**Minimum `service.yaml`:**

```yaml
name: jinn_node
author: jinn
version: 0.1.0
description: "Jinn Network node service — AI agent worker for the Jinn marketplace"
aea_version: '>=1.0.0, <2.0.0'
license: Apache-2.0
fingerprint:
  README.md: bafybei...
fingerprint_ignore_patterns: []
agent: jinn/jinn_node:0.1.0:bafybei...
number_of_agents: 1
deployment:
  agent:
    ports:
      0:
        8080: 8080
---
public_id: valory/ledger:0.19.0
type: connection
config:
  ledger_apis:
    base:
      address: ${BASE_LEDGER_RPC}
      chain_id: 8453
```

**Build the package:**
```bash
# Install Open Autonomy CLI
pip install open-autonomy

# Create package structure
mkdir -p packages/jinn/services/jinn_node
# Write service.yaml + README.md

# Hash and publish to IPFS
autonomy push-all --remote
# Returns: bafybei<new-hash>
```

**Output:** New IPFS CID (e.g., `bafybeiXXX...`) — this replaces `DEFAULT_SERVICE_HASH` in ServiceConfig.ts.

### Step 2: Add jinn-node to middleware AGENTS_SUPPORTED

**File:** `olas-operate-middleware/operate/services/agent_runner.py`

```python
AGENTS_SUPPORTED = {
    "valory/trader": AgentRelease(owner="valory-xyz", repo="trader", release="v0.27.2-rc.1"),
    "valory/optimus": AgentRelease(owner="valory-xyz", repo="optimus", release="v0.0.1051"),
    "dvilela/memeooorr": AgentRelease(owner="valory-xyz", repo="meme-ooorr", release="v0.0.101"),
    # NEW:
    "jinn/jinn_node": AgentRelease(owner="Jinn-Network", repo="jinn-node", release="v1.0.0"),
}
```

**Problem:** The `AgentRunnerManager` assumes AEA Python agents. It downloads GitHub release binaries and runs them via `aea run`. jinn-node is a Node.js worker. Options:

1. **Modify `AgentRunnerManager.update_agent_runner()`** — Add a branch for Node.js agents that pulls the Docker image or npm package instead of a Python release
2. **Create a GitHub release** with a wrapper shell script that runs `node dist/worker/worker_launcher.js`
3. **Skip the agent runner entirely** — Modify `HostDeploymentGenerator` to support Docker-based agents directly

### Step 3: Update ServiceConfig.ts

**File:** `jinn-node/src/worker/config/ServiceConfig.ts`

```typescript
// Replace:
export const DEFAULT_SERVICE_HASH = "bafybeiawqqwkoeovm453mscwkxvmtnvaanhatlqh52cf5sdqavz6ldybae";
// With:
export const DEFAULT_SERVICE_HASH = "bafybeiXXX..."; // New jinn-node package hash from Step 1

// Agent ID stays the same (staking contract requires 43)
export const DEFAULT_AGENT_ID = 43;
```

### Step 4: Test the flow

1. Run `yarn setup` with the new constants
2. Verify the middleware downloads the jinn-node package from IPFS
3. Verify the service is created on-chain with agent_id 43 + new configHash
4. Verify `stake()` succeeds (configHash check is skipped because staking contract has 0x0)
5. Verify the worker starts and processes jobs

---

## Path B: Proper Implementation (New Agent + New Staking Contract)

### Step 1: Register jinn-node as an OLAS agent

**Contract:** `AgentRegistry` (part of autonolas-registries)
- Base: Accessible through the `ComponentRegistry` / `AgentRegistry` at the address listed in OLAS docs

**Registration call:**
```solidity
// On AgentRegistry contract
function create(
    address owner,          // Jinn multisig or deployer
    bytes32 agentHash,      // IPFS hash of the agent package
    uint32[] dependencies   // Component IDs this agent depends on (can be empty)
) returns (uint256 unitId)  // New agent_id
```

**Steps:**
1. Create the agent package (AEA format) and upload to IPFS
2. Call `AgentRegistry.create()` with the IPFS hash
3. Record the returned `unitId` — this is the new agent_id (e.g., 50)

**Requirements:**
- Need ETH on the chain for gas
- Need to be registered as a unit owner on the OLAS registry (may require governance approval or may be permissionless — verify on [registry.olas.network](https://registry.olas.network))
- The agent package must follow the AEA component format

### Step 2: Deploy new staking contract

The OLAS staking contracts use a factory pattern. Deploy through `StakingFactory` or directly.

**StakingParams struct:**
```solidity
struct StakingParams {
    bytes32 metadataHash;           // IPFS hash of staking program metadata
    uint256 maxNumServices;         // Max services that can stake (e.g., 100)
    uint256 rewardsPerSecond;       // OLAS rewards emission rate
    uint256 minStakingDeposit;      // Min OLAS to stake (e.g., 50e18)
    uint256 minNumStakingPeriods;   // Min periods before unstake (e.g., 3)
    uint256 maxNumInactivityPeriods; // Max inactivity before eviction (e.g., 3)
    uint256 livenessPeriod;         // Period length in seconds (e.g., 86400 = 1 day)
    uint256 timeForEmissions;       // Total emissions duration (e.g., 25920000 = 300 days)
    uint256 numAgentInstances;      // Agents per service (1 for local deployment)
    uint256[] agentIds;             // [NEW_AGENT_ID] — our jinn agent_id from Step 1
    uint256 threshold;              // Multisig threshold (0 = any, 1 = standard)
    bytes32 configHash;             // 0x0 = accept any package, or specific hash
    bytes32 proxyHash;              // Safe proxy bytecode hash (or 0x0 for any)
    address serviceRegistry;        // 0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE (Base)
    address activityChecker;        // Custom activity checker contract address
}
```

**Key decisions:**
- `agentIds: [NEW_AGENT_ID]` — Use our new agent_id from Step 1
- `configHash: 0x0` — Accept any service package (flexibility for upgrades)
- `rewardsPerSecond` — Determines OLAS emission rate to stakers
- `activityChecker` — Can reuse existing checker or deploy custom one

**Funding the staking contract:**
- The contract needs an OLAS deposit to fund rewards (`emissionsAmount`)
- Transfer OLAS to the staking contract after deployment
- Rewards are distributed to active services based on the activity checker

### Step 3: Deploy custom activity checker (optional)

The activity checker determines whether a service is "active" and deserves rewards. The current checkers verify:
- Safe nonce increased (transactions happened)
- Marketplace request count increased (jobs were processed)
- Rate: `requestCount / timePeriod >= livenessRatio`

**Options:**
1. **Reuse existing checker** (`0x1dF0be58...` or `0x87C9922A...`) — Works if jinn-node uses the same marketplace
2. **Deploy custom checker** — Could verify jinn-specific activity metrics

### Step 4: Create AEA service package (same as Path A Step 1)

Create the service.yaml referencing the new agent_id instead of 43.

### Step 5: Update middleware AGENTS_SUPPORTED (same as Path A Step 2)

### Step 6: Update ServiceConfig.ts

```typescript
export const DEFAULT_SERVICE_HASH = "bafybeiXXX...";  // New package hash
export const DEFAULT_AGENT_ID = NEW_ID;                 // New agent_id from Step 1
export const DEFAULT_STAKING_CONTRACT = "0xNEW...";     // New staking contract from Step 2
```

### Step 7: Update .env.example

```bash
STAKING_CONTRACT=0xNEW...  # New Jinn staking contract address
```

### Step 8: Migrate existing operators

Existing operators on the old staking contract (agent_id 43) need to:
1. Unstake (72-hour cooldown)
2. Terminate service
3. Re-run `yarn setup` (creates new service with new agent_id + package)
4. Fund and re-stake on the new staking contract

This can be automated via `yarn wallet:recover` → `yarn setup`.

---

## Middleware Changes (Both Paths)

### The core problem: agent_runner.py assumes Python AEA agents

The `AgentRunnerManager` class:
1. Downloads agent binaries from GitHub releases (`.tar.gz`)
2. Extracts them as Python packages
3. Runs via `aea run` (Python AEA framework)
4. Monitors via AEA's built-in process management

jinn-node is a Node.js application. Two approaches:

#### Approach 1: Docker-based agent runner (recommended)

Add a new runner type that pulls and runs a Docker image:

```python
class DockerAgentRunner:
    """Runs an agent as a Docker container instead of AEA process."""

    def __init__(self, image: str, env: dict):
        self.image = image
        self.env = env

    def start(self):
        # docker run --rm -d --env-file ... image
        pass

    def stop(self):
        # docker stop container
        pass

    def is_running(self) -> bool:
        # docker inspect
        pass
```

**Changes needed:**
- `agent_runner.py` — Add `DockerAgentRelease` type alongside `AgentRelease`
- `service.py` — Modify `_build_docker()` to support pre-built images (not just AEA builds)
- `manage.py` — Route to Docker runner when service type is "docker"

#### Approach 2: Wrapper script in GitHub releases

Create a GitHub release for jinn-node that includes a shell script:

```bash
#!/bin/bash
# jinn-node AEA wrapper — downloaded by AgentRunnerManager
cd /path/to/jinn-node
node dist/worker/worker_launcher.js "$@"
```

Package as a `.tar.gz` release asset. The existing `AgentRunnerManager.update_agent_runner()` downloads it, and the AEA runner executes the shell script.

**Pros:** Minimal middleware changes
**Cons:** Hacky, fragile, doesn't leverage Docker

---

## IPFS Publishing Reference

### Upload a service package

```bash
# Install autonomy CLI
pip install open-autonomy

# Option 1: Via autonomy CLI
autonomy packages lock
autonomy push-all --remote

# Option 2: Via IPFS directly
# Build the package directory
mkdir jinn-service-package
cp service.yaml README.md jinn-service-package/

# Upload with wrap-with-directory
curl -X POST "https://api.pinata.cloud/pinning/pinFileToIPFS" \
  -H "Authorization: Bearer $PINATA_JWT" \
  -F "file=@jinn-service-package" \
  --form 'pinataOptions={"wrapWithDirectory":true}'

# Returns CID: bafybeiXXX...
```

### Verify upload

```bash
# Check service.yaml is accessible
curl https://gateway.autonolas.tech/ipfs/bafybeiXXX.../service.yaml
```

### IPFS hash format

The middleware expects CIDv1 format: `bafybei...` (base32-encoded).
The on-chain `configHash` is a bytes32 SHA256 digest, not the full CID.

---

## Contract Addresses (Base Mainnet)

| Contract | Address | Purpose |
|----------|---------|---------|
| ServiceRegistry | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` | Service NFT + state machine |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` | Staking/bonding token |
| Jinn Staking | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` | agentIds=[43], 5000 OLAS min |
| AgentsFun1 Staking | `0x2585e63df7BD9De8e058884D496658a030b5c6ce` | agentIds=[43], 50 OLAS min |
| Activity Checker (Jinn) | `0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B` | Nonce + request count |
| Activity Checker (AF1) | `0x87C9922A099467E5A80367553e7003349FE50106` | Different checker |

---

## Sequence of Operations

```
┌─────────────────────────────────────────────────────────────┐
│ Path A (Quick)                                              │
│                                                             │
│ 1. Create AEA service package → IPFS hash                   │
│ 2. Add jinn-node to AGENTS_SUPPORTED in middleware          │
│ 3. Update DEFAULT_SERVICE_HASH in ServiceConfig.ts          │
│ 4. Operator runs yarn setup → deploys with agent_id 43      │
│ 5. Staking accepts it (configHash=0x0, agentId=43 matches) │
│ 6. Worker runs as jinn-node (not memeooorr)                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Path B (Proper) — after Path A is working                   │
│                                                             │
│ 1. Register jinn agent on AgentRegistry → get agent_id      │
│ 2. Deploy new staking contract with agentIds=[new_id]       │
│ 3. Fund staking contract with OLAS rewards pool             │
│ 4. Deploy activity checker (or reuse existing)              │
│ 5. Update ServiceConfig.ts with new agent_id + contract     │
│ 6. Existing operators: unstake → terminate → re-setup       │
│ 7. New operators: yarn setup uses new contract directly     │
└─────────────────────────────────────────────────────────────┘
```

---

## Open Questions

1. **Is OLAS agent registration permissionless?** Can anyone call `AgentRegistry.create()`, or does it require governance approval? Check [registry.olas.network](https://registry.olas.network).

2. **StakingFactory deployment** — Is there a factory contract for deploying new staking programs, or must we deploy the contract directly? The `autonolas-staking-programmes` repo may have deployment scripts.

3. **Activity checker compatibility** — Will the existing Jinn activity checker (`0x1dF0be58...`) work with jinn-node's marketplace interactions? It checks `MechMarketplace.mapRequestCounts(multisig)` which jinn-node already satisfies.

4. **AEA package minimum viability** — Can `service.yaml` reference a Docker image instead of a Python agent? Or must we create a thin Python AEA wrapper that delegates to the Docker worker?

5. **OLAS rewards economics** — For Path B, what's the appropriate `rewardsPerSecond` and `emissionsAmount` for the new staking contract? How much OLAS needs to be deposited to fund the rewards pool?
