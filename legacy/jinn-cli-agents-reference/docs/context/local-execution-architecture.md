---
title: Local Execution Architecture
purpose: context
scope: [worker, contracts, node]
last_verified: 2026-03-09
related_code:
  - worker/mech_worker.ts
  - worker/orchestration/jobRunner.ts
  - worker/delivery/transaction.ts
keywords: [local EVM, templates, execution, public chain, node architecture]
when_to_read: "When understanding the public vs local execution split and how templates are executed"
---

# Local Execution Architecture

> How nodes execute template work locally and settle results on the public chain.

---

## The Core Split: Public vs Local

The network operates on two execution layers:

```
PUBLIC CHAIN (Base L2)                    NODE (Local EVM)
┌──────────────────────────┐              ┌──────────────────────────┐
│                          │              │                          │
│  Template request in     │──────────────│  Full marketplace        │
│  Final delivery out      │              │  Full decomposition      │
│                          │              │  Full worker loop        │
│  Thin coordination:      │              │  Full Ponder indexing    │
│  - Request event         │              │                          │
│  - Delivery event        │              │  Same contracts          │
│  - Activity tracking     │              │  Same code               │
│                          │◄─────────────│  Same protocol           │
│                          │              │                          │
└──────────────────────────┘              └──────────────────────────┘
```

**Public chain**: Sees only template requests and final deliveries. No decomposition is visible. This is the settlement layer.

**Local EVM**: Runs the full marketplace protocol — contract interactions, sub-job decomposition, Ponder indexing, worker claim loops — entirely on the node operator's machine. This is the execution layer.

The worker code, agent code, MCP tools, and contracts are identical in both environments. The only difference is which RPC endpoint the worker points at.

---

## Why This Split

### 1. Cost

A template execution that decomposes into 20 sub-jobs currently requires 20+ on-chain transactions on the public marketplace. With local execution, it requires 1 public transaction (the final delivery). The other 19 happen on a local EVM instance with zero gas cost.

### 2. Privacy

Decomposition reveals strategy. If a venture's orchestrator template breaks work into "research competitors → draft outline → write post → optimize SEO → publish," that strategy is visible to every indexer on the public chain. Local execution keeps strategy private. The public chain sees "template requested, result delivered."

### 3. Speed

Local EVM transactions are instant. No block times, no gas auctions, no mempool. The decomposition-execution-delivery loop runs at compute speed, not consensus speed.

### 4. Simplicity

The public marketplace becomes a thin routing layer: requests in, results out. All the complexity of multi-step orchestration, dependency resolution, and sub-job coordination is a private implementation detail of the executing node.

---

## How It Works

### Request Flow

```
1. Requester posts template request to PUBLIC marketplace
   └─ Contains: template ID, input config, payment

2. Node claims the request on PUBLIC chain
   └─ Standard marketplace claim mechanism

3. Node spins up EPHEMERAL local EVM instance
   └─ Marketplace contracts pre-deployed
   └─ Ponder indexer watching local chain

4. Node dispatches template internally on LOCAL EVM
   └─ Full decomposition into sub-jobs
   └─ Local workers claim and execute sub-jobs
   └─ Agent runs with same MCP tools
   └─ Sub-deliveries posted to local chain

5. Node collects final artifact from local execution

6. Node posts delivery to PUBLIC chain
   └─ Single transaction: result + proof
   └─ Local EVM instance torn down
```

### What Changes vs Today

| Component | Today | With Local Execution |
|-----------|-------|---------------------|
| Marketplace contract | Public only | Public + local instance |
| Worker | Watches public chain | Watches public + local chain |
| Ponder | Indexes public chain | Public instance + local instance |
| Decomposition | Visible on public chain | Hidden on local EVM |
| Sub-jobs | Public marketplace transactions | Local EVM transactions |
| Final delivery | Public chain | Public chain (unchanged) |
| Activity checker | Counts public deliveries | Counts public deliveries (unchanged) |

### What Actually Needs to Change in the Worker

The claim "nothing changes" is almost true — but not quite. The dispatch path needs routing awareness:

**Current dispatch flow:**
```
Agent calls dispatch_new_job (MCP tool)
  → dispatchToMarketplace() in dispatch-core.ts
    → proxyDispatch() to signing-proxy
      → signing-proxy.ts handleDispatch()
        → getRequiredRpcUrl() ← always returns RPC_URL (Base L2)
        → getMechChainConfig() ← always returns public chain config
        → dispatchViaSafe() ← posts to public marketplace
```

Every `dispatch_new_job` from the agent goes through the signing proxy, which resolves the RPC URL from `RPC_URL` and posts to the public marketplace. Sub-jobs dispatched by an orchestrator agent hit the same path — they all land on the public chain.

**What needs to change:**

1. **RPC routing override.** `getRequiredRpcUrl()` in `config/index.ts` (line 608) checks `JINN_LOCAL_RPC_URL` first, falls back to `RPC_URL`. When set, all downstream code — signing proxy dispatch, delivery transactions, balance checks — routes to the local Anvil. A companion `getPublicRpcUrl()` always returns the production `RPC_URL` for final public delivery. Similarly, `getPonderGraphqlUrl()` (line 703) checks `JINN_LOCAL_PONDER_URL` first.

2. **Local claim loop.** The worker needs a second poll loop watching a local Ponder instance that indexes the local EVM. Same code, different GraphQL endpoint. Simplified: no staking/credential/heartbeat filters, short poll interval (1-2s), hard timeout.

3. **Final delivery routing.** The worker wraps the local execution: agent delivers locally → worker takes that artifact → posts to the public marketplace using `getPublicRpcUrl()`.

4. **No contract deployment needed.** Anvil `--fork-url` copies all Base mainnet state — contracts are already deployed at canonical addresses. Same Safe, same MechMarketplace, same mech. No deploy scripts needed.

**What genuinely doesn't change:**

- The agent code and MCP tool implementations (they call the same proxy)
- The marketplace contracts (same Solidity, forked state)
- The Ponder schema and indexing logic (same code, different RPC)
- The activity checker (still counts public deliveries only)
- The incentive model (deliveries on public chain = proof of work)
- The blueprint/template format and validation
- Safe transaction management (same mutex, same nonce handling — forked chain preserves nonce)

### Implementation Plan

See [JINN-450](https://linear.app/jinn-lads/issue/JINN-450) for the full implementation plan. Summary:

**Phase 1 — Local dev stack (JINN-451):** Script to start Anvil fork + local Ponder + point existing worker at them. No code changes. Validates the approach.

**Phase 2 — RPC routing + lifecycle managers (JINN-450, PR 1):**
- `JINN_LOCAL_RPC_URL` / `JINN_LOCAL_PONDER_URL` override in `config/index.ts`
- `AnvilManager` — spawn Anvil fork, fund Safe, kill
- `LocalPonderManager` — spawn Ponder against Anvil, wait for readiness, kill
- `AGENT_ENV_ALLOWLIST` updated to pass local env vars to agent subprocess

**Phase 3 — Orchestrator integration (JINN-450, PR 2):**
- `LocalExecutionEnvironment` orchestrator — ties Anvil + Ponder + local claim loop together
- Integration with `jobRunner.ts` — local execution branch for template jobs (opt-in via `localExecution: true` in template, or `JINN_LOCAL_EXECUTION=true` on worker)
- Execution trace artifact uploaded to IPFS alongside final delivery
- Structured execution log persisted to Supabase

### Key Files

| File | Role |
|------|------|
| `jinn-node/src/config/index.ts` | `getRequiredRpcUrl()` (line 608), `getPonderGraphqlUrl()` (line 703) |
| `jinn-node/src/agent/signing-proxy.ts` | `handleDispatch()` line 152 — calls `getRequiredRpcUrl()` |
| `jinn-node/src/agent/agent.ts` | `AGENT_ENV_ALLOWLIST` (line 28) — env vars passed to agent |
| `jinn-node/src/worker/delivery/transaction.ts` | `deliverViaSafeTransaction()` — calls `getRequiredRpcUrl()` |
| `jinn-node/src/worker/mech_worker.ts` | `fetchRecentRequests()` — calls `getPonderGraphqlUrl()` |
| `jinn-node/src/worker/orchestration/jobRunner.ts` | `processOnce()` — integration point for local execution branch |
| `ponder/ponder.config.ts` | `getRpcUrl()`, factory start block, test mode detection |

---

## Templates as the Unit of Work

On the public chain, the only meaningful actions are:

1. **Post a template request** — "I want this template executed with this config"
2. **Deliver a template result** — "Here is the output"

This makes templates the natural unit of incentivized work. The activity checker doesn't need to understand decomposition, sub-jobs, or orchestration strategies. It just counts: did this node accept requests and post deliveries?

Templates currently live in Supabase. They don't need to move on-chain for this architecture to work. The public chain references templates by ID; the actual template definition is fetched from Supabase (or IPFS, or wherever templates are stored). The on-chain contract only needs to know "this request is for template X" — it doesn't need the template content.

---

## Incentivisation

The activity checker's job becomes straightforward:

- **What it checks**: Deliveries on the public chain from staked nodes
- **What counts as activity**: A node claimed a request and posted a delivery
- **What it doesn't need to know**: How the node internally executed the work

This means fixing the current activity checker to correctly count deliveries is sufficient. No new incentive model is needed. By construction, if the public chain only sees template request/delivery pairs, then counting deliveries IS counting template executions.

### Why This Works

The local execution model makes gaming harder, not easier:

- You can't fake a delivery without actually producing a valid artifact
- The artifact is posted to IPFS and its hash is on-chain
- Requesters can verify the output matches their template's output spec
- Staked capital is at risk if deliveries are invalid (optimistic verification)

---

## Verification

See [Network Thesis — Verification Roadmap](network-thesis.md) for the full progression.

### Phase 1: Optimistic (Current Target)

Node posts result + stake. If challenged, a committee re-runs the template and votes. Economic cost of cheating exceeds the benefit.

The local EVM execution model is transparent to verification: the verifier doesn't re-run the decomposition. They re-run the *template* — same input config, same template definition — and check if the output is equivalent. How the original node decomposed internally is irrelevant.

### Future Phases

- **TEE attestation**: Node proves execution happened inside a secure enclave
- **ZK for sub-operations**: Provable correctness of deterministic steps (embeddings, similarity search, hash verification)
- **Hybrid**: ZK where provable, TEE where not, optimistic for the rest

The verification backend is swappable without changing the node operator experience. A node posts result + proof. "Proof" upgrades over time from signature → TEE attestation → ZK proof.

---

## Ephemeral vs Persistent Local EVM

For the initial implementation, the local EVM is **ephemeral**:

- Spun up when a template request is claimed
- Torn down after the final delivery is posted to the public chain
- No state persists between template executions

This is simpler because:
- No state management or disk persistence
- No cross-execution contamination
- Clean failure mode (if it crashes, restart fresh)
- Each execution is fully independent

A persistent local EVM could enable cross-request learning and local memory, but adds complexity. This is a future consideration once ephemeral execution is proven.

---

## Relationship to Existing Architecture

### Ventures and Dispatch Schedules

Ventures post template requests to the public marketplace on their dispatch schedule (e.g., daily for a blog orchestrator). From the venture's perspective, nothing changes — they dispatch to the public chain, a node picks it up.

The executing node's decision to run locally is invisible to the venture. The venture sees: request posted → delivery received. Whether the node decomposed into 50 sub-jobs locally or executed monolithically is an implementation detail.

### The Orchestrator Template

The orchestrator template (e.g., blog-growth) works exactly as it does today, but the orchestration happens locally:

```
PUBLIC: Venture dispatches orchestrator template
  └─ Node claims
LOCAL: Node runs orchestrator
  └─ Orchestrator decomposes: research → draft → edit → publish
  └─ Each sub-job runs as a local marketplace request
  └─ Local workers execute each sub-job
  └─ Results flow back through local orchestrator
PUBLIC: Node posts final delivery (published blog post)
```

### Why This Matters Now

The immediate motivation: running orchestrator templates is blocked by on-chain deployment issues. Local execution removes this dependency entirely. A node operator can run their orchestrator template against a local EVM right now, without waiting for public chain deployments to be resolved.

This also means template development and iteration becomes fast — no gas costs, no deployment delays, instant feedback loops.
