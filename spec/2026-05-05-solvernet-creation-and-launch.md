# SolverNet creation and launch experience

- **Date:** 2026-05-05 (v0.1 draft) → 2026-05-06 (v0.2 design-locked)
- **Author:** Ritsu with Codex (v0.1) · design-locked with Opus (v0.2)
- **Status:** Design-locked — ready for implementation plan
- **Version:** 0.2
- **Related:**
  - `spec/2026-05-05-launcher-role-and-mode.md` (superseded for the launch surface; the role/mode framing carries forward)
  - `spec/2026-05-02-task-coordinator-one-to-many.md`
  - `spec/2026-05-registry-discovery.md`
  - `spec/2026-05-schema-versioning.md`
  - `spec/2026-05-05-plug-in-and-harness-network-trust.md` (the precedent pattern for IPFS + ERC-8004 publish/discover that this spec replicates for launched-SolverNet manifests)
  - `client/src/solver-types/prediction-v1-auto.ts`
  - `packages/sdk/src/contracts.ts`
  - `client/src/erc8004/identity.ts` (`IdentityPublisher` — same `setMetadata` anchor pattern this spec uses for SolverNet manifests)
  - `client/src/network-trust/attestation.ts` (canonical-JSON + IPFS-pin pattern this spec replicates)

## 1. Purpose

Define the product and technical model for creating and launching a SolverNet from the operator app.

The first launcher implementation (`spec/2026-05-05-launcher-role-and-mode.md`) was framed around toggling a local `launching` role for a pre-existing Prediction SolverNet. That is not the intended product model.

The intended model is:

- A Launcher creates a new SolverNet.
- Operators participate in launched SolverNets.
- Prediction is the first SolverNet we can create because its contract, task generator, evaluator, and aggregation semantics have already been specified.

This spec defines the missing lifecycle, persistence, registry, manifest, and UI model needed to make that experience real.

**v0.2 status:** the eleven design decisions in §17 are locked. This document is the canonical reference for both the implementation plan (`docs/superpowers/plans/2026-05-06-solvernet-creation-and-launch-plan.md`) and for any in-flight work on the predecessor `opus/launcher-role-and-mode` branch that needs to merge cleanly into the SolverNet-creation work.

## 2. Core product principles

1. **Launchers create SolverNets.** Launcher mode is the authoring and launch surface for a concrete SolverNet, not a local daemon role toggle.
2. **Operators participate in launched SolverNets.** Operator mode shows launched manifests from the registry, not unlaunched templates.
3. **Prediction is a template/spec for the first creation flow.** Prediction does not appear as already live before a launcher creates and launches it.
4. **The generator is launcher-owned.** Operators must never run the generator merely by joining the SolverNet.
5. **A SolverNet owns its protocol contract.** The separate `solverType` concept is removed (§8). Contract identity is `{ id, version }`; instance identity is `manifestCid`.
6. **Discovery is a global registry, not a curated list.** The on-chain ERC-8004 anchor (`IdentityRegistry.setMetadata`) plus subgraph indexing produces a permissionless, self-published registry of every launched SolverNet. Operators see all launched SolverNets; trust filters layer on top later.
7. **Launchers commit to a price per delivered Solution and per delivered Verdict.** Price is a market-transaction commitment in the manifest. (Protocol-level rewards — JINN emissions via gauges — are a separate flow and are not part of the manifest.)
8. **The manifest is the launched-instance authority.** It embeds the full contract shape (no "ref to a known protocol" mode); operators verify and participate against the signed manifest body without external resolution.

## 3. Vocabulary

### SolverNet

The product object a launcher creates. A SolverNet directs operator work toward producing a specific kind of knowledge.

Example:

> Prediction: produce calibrated probability forecasts for externally resolved prediction-market events.

### SolverNet contract

The reusable protocol definition for a SolverNet. Defined in `packages/sdk/src/contracts.ts`.

It defines:

- task / solution / verdict schemas (JSON Schema)
- claim policy defaults
- credential requirements (per role)
- evaluation function (deterministic, with a binding `implementation` reference — operators in the evaluator role run the canonical implementation)
- aggregation function (deterministic, with `id` + windowing parameters)

It does **not** define:

- recommended harnesses (operator's choice for solver role; bound by the contract for evaluator role only)
- recommended runtime plugins (operator's choice)
- required runtime plugins (operator's choice — schemas + canonical implementations are sufficient to specify the protocol)

### SolverNet manifest

The concrete launched-instance document. It embeds the full SolverNet contract and binds it to:

- launcher identity (master Safe, agent EOA, agentId)
- launch parameters (`solutionPriceWei`, `verdictPriceWei`, `openRoles`)
- registry/discovery metadata
- signature (by the launcher's agent EOA — see §7)

The manifest is what operators discover, verify, and participate against.

### SolverNet template

A code-side starting point used by the launcher SPA to seed a draft. Prediction (`packages/sdk/src/contracts.ts:PREDICTION_V1_SOLVER_NET_CONTRACT`) is the first template. Templates are launcher-side ergonomics; once a draft is launched, the manifest is the authority.

### Generator

Launcher-owned task production logic. For Prediction, the generator polls Polymarket, filters candidate markets, builds valid tasks, signs task documents, and posts tasks on-chain. The generator runs only on the launcher daemon for SolverNets that daemon owns (§11).

### Registry

The discoverability surface for launched SolverNets. Implemented as `IdentityRegistry.setMetadata` events anchoring IPFS-pinned manifests, indexed by the Jinn subgraph. **Permissionless and global** — every launched SolverNet on the network is visible to every operator without curation. Trust filters (followed-launchers, attestations, blocklists) are deferred to a follow-up epic.

## 4. Current implementation gap

Today the implementation has these pieces:

- A Prediction SDK contract template in `packages/sdk/src/contracts.ts`.
- Prediction task, solution, and verdict schemas in the SDK.
- A Prediction task generator in `client/src/solver-types/prediction-v1-auto.ts`.
- Local config under `solverNets.prediction`.
- A `launching` role added to local config by the predecessor Launcher mode.
- Operator config that can opt into `solving` and `evaluating`.
- A hard-coded Prediction catalog entry surfaced through the daemon API.

What it lacks:

- No first-class "created SolverNet" object.
- No SolverNet manifest.
- No launched/unlaunched lifecycle.
- No registry-backed operator discovery.
- No launcher-owned generator boundary beyond a local role gate.
- Prediction is exposed to operators before a launcher creates it.
- `solverType` remains a separate routing key instead of being subsumed by the SolverNet contract identity.

The result is a product mismatch: the app behaves like Prediction already exists and the launcher merely enables a local generator. This spec replaces that shape.

## 5. Target lifecycle

### 5.1 Draft

A launcher starts creating a SolverNet. The draft is local-only.

Draft state contains:

- name
- description / purpose
- selected template
- contract draft (seeded from template; editable for new SolverNets when external launchers exist later)
- generator config draft
- price draft (`solutionPriceWei`, `verdictPriceWei`)
- `openRoles` selection
- validation status

Drafts are not visible to operators.

### 5.2 Ready to launch

The app has enough information to produce a valid manifest:

- contract is valid (schemas parseable; evaluation/aggregation references resolvable)
- generator config is valid
- launcher Safe is available
- `solutionPriceWei` and `verdictPriceWei` are set
- `openRoles` is non-empty
- credentials are satisfiable (informational at draft time)

### 5.3 Launched

Launch creates a signed SolverNet manifest, persists a local launched record, anchors the manifest on-chain via `IdentityRegistry.setMetadata`, pins the manifest to IPFS, and starts the launcher-owned generator.

After launch:

- operators can discover the SolverNet via the global registry
- operators can join as solver / evaluator (depending on `openRoles`)
- launcher daemon can post tasks
- tasks are attributable to the launched SolverNet via `manifestCid` in the task document (§14)

The launch action is a forward-only checkpointed state machine; see §10 and the implementation plan for crash-recovery semantics.

### 5.4 Paused

The SolverNet remains discoverable, but task generation is stopped.

Paused means:

- no new tasks are posted by the launcher generator
- existing tasks continue through normal lifecycle (claim → submit → verdict → settle)
- operators see that the SolverNet is not currently producing new work
- launchers can resume to return to launched

### 5.5 Retired

The SolverNet is no longer accepting new work. Historical tasks, solutions, verdicts, and scoreboards remain discoverable.

Retired is terminal:

- no new tasks are posted
- existing tasks drain naturally (no on-chain cancellation)
- operators continue to see the SolverNet in the catalog (with retired indicator) for historical browsing
- there is no "unretire" — relaunching means a new SolverNet with a new id

(Cancel-with-on-chain-task-closure is a future feature; deferred.)

## 6. Persistence model

### 6.1 Local draft store

Drafts persist locally so launchers can resume the flow:

```text
~/.jinn-client/solvernets/drafts/<draftId>.json
```

Format per the launched-record shape (§6.2), with `status: 'draft'` and progress markers for which creation steps have been completed.

### 6.2 Local launched store

The launcher daemon's durable state for SolverNets it owns:

```text
~/.jinn-client/solvernets/launched/<solverNetId>.json
```

Format:

```ts
interface LaunchedSolverNetRecord {
  schemaVersion: 'solvernet.launched.v1';
  solverNetId: string;
  manifestCid: string;
  manifestPath?: string;          // local cache of the manifest JSON for offline read
  manifestHash: `0x${string}`;    // sha256 of canonical manifest JSON

  launcherAgentId: string;
  launcherSafeAddress: `0x${string}`;
  launchedAt: string;

  // Cached lifecycle state. Authoritative source is the latest setMetadata
  // event for this manifestCid, resolved by the most-recent-wins resolver.
  // Local copy is for fast startup and offline reads.
  status: 'launching' | 'launched' | 'paused' | 'retired' | 'failed';
  statusUpdatedAt: string;

  // Generator runtime ownership — local-only operational toggle, never
  // published. Defaults to true on launch; the launcher can flip locally.
  generatorEnabled: boolean;
  generatorState?: { lastPollAt?: string; lastError?: { message: string; at: string } };

  // Launch state machine progress (set during 'launching' phase, cleared
  // afterward). Drives crash-recovery on daemon restart.
  launchProgress?: {
    phase: 'pinning' | 'recording' | 'broadcasting' | 'confirming' | 'spawning';
    txHash?: `0x${string}`;
    txError?: { message: string; at: string };
    attemptCount: number;
  };

  // Lifecycle transition progress (set during pause / retire / resume).
  lifecycleProgress?: {
    phase: 'broadcasting' | 'confirming';
    target: 'paused' | 'launched' | 'retired';
    txHash?: `0x${string}`;
    attemptCount: number;
  };

  // Most recent on-chain anchor write — replay/debug context.
  registry: { metadataTxHash?: `0x${string}`; metadataBlockNumber?: number };
}
```

This file format mirrors the existing `~/.jinn-client/earning/earning_state.json` precedent (the 11-step `EarningBootstrapper` state machine in `client/src/earning/bootstrap.ts`). The daemon scans this directory on startup, reconstitutes state, and resumes any in-flight launch / lifecycle transitions.

The daemon runs a generator only when it has a local launched record where it is the owner and `status === 'launched'` and `generatorEnabled === true`.

### 6.3 Registry persistence — on-chain anchor + IPFS

The registry is **`IdentityRegistry.setMetadata`-anchored manifests with IPFS-pinned bodies**. This replicates the existing `IdentityPublisher` pattern (`client/src/erc8004/identity.ts`) used today for execution manifests, and the network-trust v0 pattern for plug-in attestations (`client/src/network-trust/attestation.ts`).

Mechanics:

```
launcher_daemon.publish(manifest):
  canonical = canonicalJson(manifest)               // RFC 8785 JCS
  hash = sha256(canonical)
  cid = ipfs.pin(canonical)                         // existing uploadToIpfs in adapters/mech/ipfs.ts
  tx = IdentityRegistry.setMetadata(
    launcherAgentId,                                // msg.sender = launcher's agent EOA
    `solvernet-manifest:${cid}`,                    // <kind>:<cid> pattern
    encode({
      schemaVersion: 'solvernet.lifecycle.v1',
      status: 'launched' | 'paused' | 'retired',
      at: ISO8601,
      hash: bytes32(hash)
    })
  )
```

Operator discovery:

```
operator_daemon.refreshCatalog():
  events = subgraph.query(
    "Registered events WHERE key LIKE 'solvernet-manifest:%'"
  )
  // No agentId filter — registry is global per principle 6.
  for each (agentId, key, payload, blockNumber):
    cid = parseCid(key)
    catalog.upsert(
      manifestCid: cid,
      currentStatus: latestPayloadFor(cid).status,   // most-recent-wins resolver
      launcherAgentId: agentId,
      blockNumber
    )
```

Operator manifest fetch (lazy, on participation interest):

```
operator.viewManifest(cid):
  manifest = ipfs.fetch(cid)                        // via Autonolas gateway or native IPFS
  signer = ecrecover(manifest.signature, sha256(canonicalJson(manifest_minus_sig)))
  agentId_at_block = IdentityRegistry.getAgentByWallet(signer, atBlock: anchorBlock)
  assert(agentId_at_block === manifest.launcher.agentId)
  boundSafe = IdentityRegistry.getSafeForAgent(agentId_at_block, atBlock: anchorBlock)
  assert(boundSafe === manifest.launcher.safeAddress)
  // manifest is verified
```

The trust chain: signature recovers the agent EOA; `IdentityRegistry` (queried as-of the anchor block) maps that EOA to the agentId and the bound master Safe via `setAgentWallet`. A stolen agent EOA can publish fake manifests but cannot redirect funding away from the legitimate launcher's Safe — `manifest.launcher.safeAddress` MUST equal the chain-bound Safe at the anchor block.

Lifecycle transitions are additional `setMetadata` writes with the same `solvernet-manifest:<cid>` key but updated payload:

```
setMetadata(launcherAgentId, "solvernet-manifest:<cid>", { status: 'paused', at: ... })
```

The most-recent-wins resolver (`client/src/network-trust/most-recent-wins.ts`) picks the latest event per (agentId, cid) tuple. The manifest itself is signed once at launch and never re-signed; lifecycle authenticity flows from `msg.sender == launcher's agent wallet` (enforced on-chain by IdentityRegistry's access control on `setMetadata`).

There is no hosted index, no on-chain SolverNet registry contract, and no launcher follow-list. The subgraph is the discovery substrate; if/when its operational properties demand a different mechanism (gas optimization for many launchers, etc.), the abstraction in §13 lets us swap implementations without changing the manifest schema or operator flow.

## 7. SolverNet manifest shape

The manifest is the launched SolverNet instance, fully self-contained, signed by the launcher's agent EOA.

```ts
interface SolverNetManifestV1 {
  schemaVersion: 'solvernet.manifest.v1';
  solverNetId: string;                          // launcher-assigned, unique per launcher
  network: 'base-sepolia' | 'base';
  name: string;
  description: string;

  launcher: {
    safeAddress: `0x${string}`;                 // launcher's master Safe (= funding source)
    agentEoa: `0x${string}`;                    // launcher's agent EOA at launch time
    agentId: string;                            // launcher's ERC-8004 agentId
  };

  // Protocol shape — full embedded contract. The manifest IS the launched
  // instance of this contract. No external resolution required.
  contract: {
    id: string;                                 // e.g., 'prediction'
    version: string;                            // e.g., 'v1'
    schemas: {
      task: JsonSchema;                         // canonical JSON Schema (not Zod)
      solution: JsonSchema;
      verdict: JsonSchema;
    };
    claimPolicyDefaults: {
      mode: 'parallel' | 'serial';
      maxClaims: number;
      maxClaimsPerOperator: number;
      claimLeaseTtlSeconds: number;
    };
    credentialRequirements: Record<
      'creator' | 'solver' | 'evaluator',
      Array<{ id: string; kind: string; required: boolean; description: string }>
    >;
    evaluationFunction: {
      id: string;                               // e.g., 'prediction.brier-loss.v1'
      deterministic: boolean;
      inputs: string[];
      output: string;
      implementation: string;                   // BINDING — canonical evaluator harness reference
    };
    aggregationFunction: {
      id: string;                               // e.g., 'prediction.trailing-mean-brier-spread.v1'
      deterministic: boolean;
      inputs: string[];
      output: string;
      windowDays?: number;
    };
  };

  // Launch parameters — the launcher's commitment to operators
  solutionPriceWei: string;                     // what a solver gets per accepted Solution
  verdictPriceWei: string;                      // what an evaluator gets per accepted Verdict
  openRoles: Array<'solver' | 'evaluator'>;     // which roles the launcher is opening

  // Replay / debug context (informational)
  registry?: {
    manifestCid?: string;                       // self-cid (after pin); informational
    registryUrl?: string;                       // optional friendly URL
  };

  createdAt: string;
  launchedAt: string;
  signature: {
    alg: 'eip-191';                             // personal_sign over canonical JCS hash
    signer: `0x${string}`;                      // recovered agent EOA at signing time
    value: `0x${string}`;                       // 65-byte signature
  };
}
```

Notes:

- **No `status` field on the manifest.** Status is in the lifecycle payload of the `setMetadata` event (§6.3). The manifest commits to the *terms*; lifecycle commits to *operational state*.
- **No `previousManifestCid`.** Day-1 there are no in-place version bumps (§15 non-goal). When in-place upgrades land later, this field can be added.
- **No `fundingSafeAddress` separate from `launcher.safeAddress`.** Day-1 they are the same per `spec/2026-05-05-launcher-role-and-mode.md` §3 invariant 2 (no separate launcher wallet). When treasury-style launches need the split, it is additive.
- **No `recommendedHarnesses` or `requiredRuntimePlugins`.** Operator-side concerns; not bound by the SolverNet (§3, §8).
- **No `economics` wrapper.** Top-level scalar fields (`solutionPriceWei`, `verdictPriceWei`) are simpler day-1; nesting earns its keep when there are more pricing-related fields.

Canonicalization: RFC 8785 JCS, same module reused from `client/src/network-trust/attestation.ts` (`canonicalJson`). The signed body is the canonical JSON of the manifest with the `signature` field omitted.

## 8. SolverNet contract shape (SDK)

Cleaned `SolverNetContract` interface in `packages/sdk/src/contracts.ts`:

```ts
interface SolverNetContract {
  id: string;                                   // e.g., 'prediction'
  version: string;                              // e.g., 'v1'
  name: string;
  schemas: {
    task: JsonSchema;
    solution: JsonSchema;
    verdict: JsonSchema;
  };
  claimPolicyDefaults: SolverNetClaimPolicyDefaults;
  credentialRequirements: Record<SolverNetContractRole, CredentialRequirement[]>;
  evaluationFunction: SolverNetEvaluationFunction;   // .implementation is BINDING
  aggregationFunction: SolverNetAggregationFunction;
}
```

Removed from the v0.1 shape:

- **`solverType: SupportedSolverType`** — replaced everywhere by `{ id, version }`. A derived `solverType` alias may exist at compatibility-layer boundaries during migration but is not part of the contract surface (§14).
- **`defaultRuntimePlugins: string[]`** — runtime plugins are operator-side; not bound by the contract.

Interpretive notes:

- **`evaluationFunction.implementation`** is the canonical evaluator harness reference. Operators in the evaluator role run this implementation; they do not pick a harness for evaluation. Day-1 the implementation ships in the daemon bundle (e.g., `'client/src/harnesses/impls/prediction-v1-evaluator'`). External-launcher distribution paths for canonical implementations are a follow-up (§15).
- The contract's `schemas` are JSON Schema (canonical wire format), not Zod. The SDK provides Zod parsers derived from the JSON Schemas for daemon-side validation ergonomics; the manifest carries JSON Schema as the authoritative form.

The SDK exports `getSolverNetContract({ id, version })` (replacing `getSolverNetContract(solverType)`).

`PREDICTION_V1_SOLVER_NET_CONTRACT` is the first template the launcher SPA seeds drafts from.

## 9. Prediction as the first creation template

Prediction is a SolverNet creation template, not an already-launched SolverNet.

The template pre-fills (when a launcher chooses "Create from Prediction template"):

- name: Prediction
- purpose: calibrated probabilistic forecasts for externally resolved prediction-market events
- task / solution / verdict schemas (from `PREDICTION_V1_SOLVER_NET_CONTRACT`)
- evaluation: `prediction.brier-loss.v1` with binding `implementation: 'client/src/harnesses/impls/prediction-v1-evaluator'`
- aggregation: `prediction.trailing-mean-brier-spread.v1`, windowDays 84
- generator config defaults: cadence 6h, max-rounds-per-poll 5, max-rounds-per-day 100, max-open-rounds 250
- price defaults: TBD by launcher (no pre-filled values)
- `openRoles`: `['solver', 'evaluator']`

The launcher still performs a real creation flow (§10).

The template **does not** pre-fill harness or runtime plugin choices — those are operator-side. The launcher's local `solverNets.<solverNetId>.plugins` config can be seeded with quick-start defaults for the *launcher's own* daemon (e.g., bundled prediction plugin for Polymarket access during generation), but those are operator choices on the launcher's daemon, not bound by the manifest.

## 10. Launcher experience

### Empty state

Launcher mode empty state:

```text
No SolverNets created yet.
Create a SolverNet to direct operators toward a specific kind of knowledge work.
```

Primary CTA: `Create SolverNet`.

### Creation flow

Required screens:

1. **Define SolverNet** — name, description, purpose.
2. **Review Contract** — task / solution / verdict schemas, evaluation, aggregation, claim policy defaults, credentials. Read-only when starting from a template.
3. **Configure Generator** — source, cadence, market filters, allowlist / blocklist, max new rounds per poll / day, max open rounds, submission window.
4. **Configure Pricing** — funding Safe (defaults to launcher's master Safe), `solutionPriceWei`, `verdictPriceWei`, current Safe balance, projected number of Tasks at chosen prices.
5. **Review and Launch** — manifest summary, `openRoles` selection, `[Launch]` action.

The Launch action is a forward-only checkpointed state machine (Decision 10 in §17):

```
phase: pinning  → upload canonical manifest JSON to IPFS
phase: recording → write LaunchedSolverNetRecord to disk with cid
phase: broadcasting → submit IdentityRegistry.setMetadata tx
phase: confirming → wait for tx receipt
phase: spawning → start the launcher-owned generator
status: launched
```

On daemon crash mid-launch, the record on disk is the recovery checkpoint; the daemon resumes from the last completed phase on next start. All steps are idempotent (same content → same cid; setMetadata is event-only and re-firing is harmless if needed).

### Post-launch dashboard

After launch, Launcher mode becomes the owner dashboard:

- SolverNet status: launched / paused / retired
- generator status, last poll summary, errors
- tasks posted (cumulative + recent)
- spend / runway (from Safe balance and posted-task budgets)
- operator participation count (from on-chain claim events for tasks attributed to this manifest)
- recent outputs / verdicts
- scoreboard / aggregation
- `[Pause]` button (when launched), `[Resume]` button (when paused)
- Danger Zone: `[Retire SolverNet]` with typed-name confirmation (terminal)

Pause / Resume / Retire actions are checkpointed `setMetadata` writes (Decision 11 in §17), with the same crash-recovery semantics as launch.

## 11. Generator ownership

Only the launcher daemon for a launched SolverNet may run that SolverNet's generator.

Rules:

- Joining a SolverNet as an operator never starts the generator. Operator-mode participation config has no generator controls.
- The daemon starts a generator only when it has a local launched record where it is the owner, `status === 'launched'`, and `generatorEnabled === true`.
- Generator tasks are attributed to the launched SolverNet manifest (§14).
- Duplicate launcher daemons for the same Safe / SolverNet are discouraged; day-1 enforcement is operational (one daemon per launcher's Safe). Protocol-level coordination (manifest-bound nonces, on-chain "active generator" pointer) is a follow-up.

For Prediction, this replaces the predecessor Launcher mode's `roles.includes('launching')` gate. The new gate is "do I have a launched record where I'm the owner."

Generator-config edits hot-apply: the launcher SPA's generator-config form PATCHes both the launched record on disk *and* an in-memory mirror inside the running generator's closure. Cadence / allowlist / blocklist edits take effect within one generator tick. (This was a P0 bug in the predecessor Launcher mode — `jinn-mono-p1t4.2` — and is correctly handled by the new design from the start.)

## 12. Operator discovery and join flow

Operator mode reads launched SolverNets from the registry.

Before any SolverNet is launched:

```text
No launched SolverNets available.
```

After the Prediction SolverNet is launched:

```text
Prediction
Launcher: 0xE64bAf…B5CF · agentId 5474
Status: Launched
Open roles: Solver, Evaluator
Solution price: 0.001 ETH
Verdict price: 0.0005 ETH
```

The catalog lists all manifests indexed by the subgraph (no follow-list). Operator-side filters / blocklists / search / followed-launchers UI are deferred (§15).

Operator participation flow:

1. Choose launched SolverNet from catalog.
2. Choose roles from `openRoles`.
3. (For solver role) Choose harness, model, plugins.
4. Run readiness checks (credential requirements satisfied, harness compatible with contract, etc.).
5. Participate by watching, claiming, running, and delivering tasks.

Operator local config after participation:

```ts
joinedSolverNets: {
  '<manifestCid>': {
    name: 'Prediction',                      // cached for display
    manifestCid: '<cid>',
    contract: { id: 'prediction', version: 'v1' },
    roles: ['solver'],                       // operator's chosen roles within openRoles
    harness: 'claude-code-learner',          // operator-side, only for solver role
    plugins: [...],                          // operator-side additions; defaults are implicit
    disabledDefaultPlugins: [...],           // explicit opt-outs from default runtime plugins
    model: 'claude-haiku-4-5-20251001',      // operator-side
    // evaluator-role harness comes from manifest.contract.evaluationFunction.implementation
  };
}
```

## 13. Registry interface (SDK)

The app depends on an abstract registry client so the day-1 IdentityRegistry+subgraph backing can be replaced later (by an on-chain SolverNet registry, an alternative IPFS gateway, or any other implementation) without touching the manifest schema or operator flow.

```ts
interface SolverNetRegistryClient {
  publishManifest(args: {
    manifest: SolverNetManifestV1;
    signer: SignerWithAgentEoa;
  }): Promise<{
    manifestCid: string;
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }>;

  publishLifecycleTransition(args: {
    manifestCid: string;
    launcherAgentId: string;
    target: 'launched' | 'paused' | 'retired';
    signer: SignerWithAgentEoa;
  }): Promise<{
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }>;

  listLaunched(args: {
    network: string;
    statusFilter?: Array<'launched' | 'paused' | 'retired'>;
    sinceBlock?: number;
  }): Promise<SolverNetManifestSummary[]>;

  getManifest(args: {
    manifestCid: string;
  }): Promise<SolverNetManifestV1>;

  getLifecycleStatus(args: {
    manifestCid: string;
  }): Promise<{
    status: 'launched' | 'paused' | 'retired';
    statusUpdatedAt: string;
    sourceBlock: number;
  }>;
}
```

Day-1 implementation: `IdentityRegistryBackedSolverNetRegistryClient` wires `publishManifest` / `publishLifecycleTransition` to `IdentityRegistry.setMetadata`, `listLaunched` / `getLifecycleStatus` to subgraph queries with most-recent-wins resolution, and `getManifest` to IPFS (via `client/src/adapters/mech/ipfs.ts`).

## 14. Task attribution

Tasks posted by a launched SolverNet carry `manifestCid` to map back to the launched-instance authority.

Task document shape:

```ts
{
  // ...existing task fields...
  solverNetManifestCid: string;                 // BINDING — points to the launched SolverNet
  contractId: string;                           // e.g., 'prediction'
  contractVersion: string;                      // e.g., 'v1'
  // No solverType field. Compatibility derivation, if needed for legacy
  // tooling, is `solverType = `${contractId}.${contractVersion}``.
}
```

On-chain task digest (Decision 6, §17 — C-semantic) is manifest-bound:

```solidity
// TaskCoordinator.sol (post-rename, post-proxy-upgrade)
struct TaskRecord {
  bytes32 manifestDigest;     // = keccak256(manifestCid)  (was: solverTypeDigest)
  // ...
}
```

This makes operator eligibility per-launch, not per-protocol. An operator participating in Launcher A's Prediction is not automatically eligible to claim Launcher B's Prediction tasks (different `manifestCid`, different digest), even though both share the same SolverNet contract.

Task validation by operators:

```
operator.validateTask(taskDoc):
  manifest = registry.getManifest({ manifestCid: taskDoc.solverNetManifestCid })
  contract = manifest.contract
  validateAgainstSchema(taskDoc, contract.schemas.task)
  // dispatch via contract.id + contract.version
```

This replaces the legacy `solverType`-keyed dispatch path. During the migration window, internal harness dispatch may keep a derived `solverType` alias; new code does not introduce dependencies on it.

## 15. Non-goals for the first implementation

- Public forking flow for existing SolverNets.
- Permissionless arbitrary schema authoring without review tooling.
- Full on-chain SolverNet registry contract (the IdentityRegistry-anchored MVP is sufficient).
- ve-JINN gauges or protocol-level emissions.
- Cap fields in the manifest budget block (`maxOpenBudgetWei`, `maxDailyBudgetWei`). Day-1 ships rates only; caps are a follow-up.
- Operator-side verification that posted tasks' on-chain policy matches the launcher's manifest commitment. Day-1 trust is reputation-based; verification is a follow-up.
- Followed-launcher list / blocklist / curated launcher index UI. Day-1 the registry is global; trust filters are deferred.
- In-place version bumps without retire-and-relaunch. `previousManifestCid` chains are deferred until a launcher needs to bump a contract while keeping the same `solverNetId`.
- External-launcher distribution path for canonical evaluator implementations. Day-1 implementations ship bundled in the daemon; future packaging mechanism (signed artifacts, package registry) is out of scope.
- Cancel-on-retire (close in-flight tasks on-chain). Retire drains naturally.
- Removing the internal `solverType` alias in harness dispatch and SDK aliases. The user-facing surface (manifest, SPA, new types) is `solverType`-free; daemon-internal dispatch can keep the alias for one cycle.
- Marketplace / payment redesign beyond what TaskCoordinator already supports.

## 16. Implementation plan outline

The full plan with ordering, dependencies, and per-step verification lives at `docs/superpowers/plans/2026-05-06-solvernet-creation-and-launch-plan.md`. Sketch:

1. **SDK contract surface refactor** — rename `SolverNetContract.solverType` → `{ id, version }`; remove `defaultRuntimePlugins`; add JSON Schema serialization helpers; expose `getSolverNetContract({ id, version })`.
2. **Manifest schema + canonicalize/sign/hash module** — `client/src/solvernets/manifest.ts`, replicating `client/src/network-trust/attestation.ts`.
3. **Registry client interface + IdentityRegistry-backed implementation** — `client/src/solvernets/registry.ts`, replicating discover/feedback-reader/most-recent-wins shapes from network-trust v0.
4. **Local launched + draft store** — `client/src/solvernets/store.ts`, mirroring `EarningBootstrapper` state-machine pattern.
5. **Launch state machine** — forward-only checkpointed action with crash recovery; per Decision 10 in §17.
6. **Lifecycle transitions** — pause / resume / retire as `setMetadata` writes; per Decision 11 in §17.
7. **Generator gating** — daemon spawns generator only when local launched record says it's the owner, `status === 'launched'`, `generatorEnabled === true`. Hot-apply for generator-config edits.
8. **Solidity rename + proxy upgrade** — `TaskCoordinator.sol` and dependents (`solverTypeDigest` → `manifestDigest`, etc.); deploy via existing `upgrade-task-coordinator-router-v3.ts`.
9. **Subgraph rename + redeploy** — schema and handlers updated; re-index from current block.
10. **Task attribution** — task documents carry `solverNetManifestCid`; on-chain digest derivation shifted to manifest-bound.
11. **Operator catalog + join flow refactor** — catalog reads from registry client; join flow writes config keyed by `manifestCid`.
12. **Launcher SPA replacement** — Create flow (§10); post-launch dashboard; Pause / Retire / Resume actions. Replaces predecessor `LauncherPage` + `SetupFlow`.
13. **Operator SPA refactor** — catalog page reads from registry; participation flow uses new keying.
14. **Tests** — manifest sign/verify; registry publish/discover/lifecycle; launch state machine crash recovery; generator-ownership gate; operator catalog excludes templates; operator join never starts generator; solver vs evaluator harness dispatch; integration / e2e (real-daemon Playwright) for the launch happy path.
15. **Testnet redeploy + clean break** — after the new contracts are live, document the testnet task-data discontinuity, communicate to any external testers (currently none).
16. **Spec + skill update** — `testing-jinn-app/SKILL.md` updated with new launcher walk and registry-mock recipe.

## 17. Locked decisions (from 2026-05-06 design session)

| # | Decision | Locked |
|---|---|---|
| 1 | Branch + sequencing strategy | Worktree `opus/solvernet-creation-and-launch` off `origin/opus/launcher-role-and-mode` |
| 2 | Registry MVP backend | `IdentityRegistry.setMetadata` + IPFS-pinned manifest + subgraph-indexed discovery |
| 3 | Manifest mutability for lifecycle | Immutable manifest signed once; lifecycle transitions are `setMetadata` writes with updated payload, resolved most-recent-wins |
| 4 | Manifest signing key | Agent EOA (daemon autosigns); on-chain agent-to-Safe binding via `setAgentWallet` is the trust chain |
| 5 | Operator catalog source | Registry-only; pre-release means no legacy fallback path; default `solverNets.prediction` block dropped from config schema |
| 6 | `solverType` strategy | Full removal (C-semantic) — replaced by `{ id, version }` + `manifestCid`; on-chain `manifestDigest` replaces `solverTypeDigest`; testnet task-data clean break accepted |
| 7 | Day-1 budget model | `solutionPriceWei` + `verdictPriceWei` only; caps deferred |
| 8 | Local launched record format | JSON file per id at `~/.jinn-client/solvernets/launched/<solverNetId>.json` |
| 9 | Operator-side discovery bootstrap | None — registry is global; subgraph query is unfiltered |
| 10 | Launch atomicity / failure recovery | Forward-only checkpointed state machine; per-phase progress in launched record; crash-resume on daemon restart |
| 11 | Lifecycle action surface | Pause + Resume + Retire; in-flight tasks drain naturally; no Cancel; Retire requires typed-name confirmation |

## 18. Remaining open questions

Resolved by the locked decisions above:

- ~~MVP registry backend~~ — Decision 2.
- ~~Paused / retired as new manifests vs mutable state~~ — Decision 3 (mutable lifecycle in payload, immutable manifest).
- ~~Field embedding vs reference~~ — §7 (full embed).

Still open (non-blocking; flag for the implementation phase):

1. **Name uniqueness** — day-1 there is exactly one Prediction launched (Jinn team). Once external launchers exist, name collisions are possible. The current model: `solverNetId` is unique per launcher (combined with `launcher.agentId` for global uniqueness); display `name` may collide. Operators see `name + launcher` in the catalog. Sufficient day-1; revisit if collision becomes confusing.
2. **Future on-chain registry vs IdentityRegistry-anchored** — when does the gas cost of per-launcher `setMetadata` for many launchers warrant a dedicated contract? Decision deferred until operational data shows the pressure.
3. **Operator-side filter UI** — followed-launchers, blocklists, search, sort by reputation. Out of scope for this PR; file a follow-up epic when external launchers exist.
4. **`evaluationFunction.implementation` distribution** — day-1 it ships bundled. For external-launcher SolverNets, the implementation reference must resolve to something operators can run. Likely path: signed artifact distribution similar to network-trust v0 plug-in attestations, scoped to evaluator implementations.
5. **In-place version bumps** — when launchers want to bump their contract version without retiring the SolverNet, we need the `previousManifestCid` chain pattern. Defer until requested by a launcher.
6. **Master EOA countersignature** — Decision 4 picks agent EOA for daemon ergonomics. If a future launcher wants stronger commitment binding (e.g., institutional governance), a master-EOA countersignature in the manifest body could be added. Additive when needed.
