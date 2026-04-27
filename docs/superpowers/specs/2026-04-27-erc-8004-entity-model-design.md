# ERC-8004 entity model — operator-rooted with per-execution metadata commitments

**Version:** 1.0 (decision)
**Date:** 2026-04-27
**Status:** Decided. Binds PR #37 cleanup and shapes Phase 1b challenge mechanism + reputation surface.
**Beads:** see §10 — `jinn-mono-2k6`, `jinn-mono-j07`, `jinn-mono-3zk`, `jinn-mono-9jg`, `jinn-mono-2ff`, `jinn-mono-fud`, `jinn-mono-al7`, `jinn-mono-3q8`, `jinn-mono-g7h`.
**Related:**

- `spec/2026-04-21-agentic-data-substrate.md` — substrate thesis; ERC-8004 metadata for license/discovery
- `docs/research/2026-04-23-verifiability-traceability.md` — operator-declared stack, evidence tiers, x402 + 8004 composition
- `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` — envelope/trajectory/TEE scope this entity model fits inside
- `docs/reviews/2026-04-22-architecture-audit-j75.md` — Public-artifacts row (entity model corrected here)
- `spec/2026-04-17-portfolio-v0-design.md` — `portfolio.v0` manifest registration with parent-manifest back-pointers
- ERC-8004 reference contracts: pinned at `erc-8004/erc-8004-contracts@0463311492b3a7fc5fdb6990231cce721ff6cf97` (staged copy at `/tmp/erc8004-ref/`)
- PR #37: `plans/envelope-v1`; Codex review at https://github.com/Jinn-Network/mono/pull/37#issuecomment-4327108176

## 1. Summary

Adopt **operator-rooted ERC-8004 with per-execution metadata commitments**:

- One agent NFT per operator Safe. Minted once at bootstrap.
- Per-execution artifacts (envelopes, evaluations) are anchored on chain as `setMetadata(agentId, "<kind>:<cid>", payload)` calls on the operator's NFT — not as separate NFTs per CID.
- Reputation lives on the operator agent NFT via `ReputationRegistry.giveFeedback`, with feedback bodies naming the specific manifest CID.
- Challenges live on `ValidationRegistry` keyed by `(validator, agentId, requestHash)` where `requestHash = manifest.evidenceHash`.
- A Jinn-owned subgraph synthesizes a queryable `Execution` entity from the events emitted across these surfaces. No on-chain "execution NFT" exists; the entity is a subgraph view.
- The deployed `0x8004…` registries are consumed as-is. No new contracts are deployed.

## 2. Background — what PR #37 got wrong

PR #37 (`plans/envelope-v1`) wired up an "ERC-8004 three-registry client" against guessed ABIs. Codex review surfaced contradictions; deeper review against the canonical reference (`erc-8004/erc-8004-contracts`) found a structural mismatch:

| PR #37 assumed | Real ERC-8004 |
|---|---|
| Each artifact CID is a first-class on-chain entity — `intent:<cid>`, `envelope:<cid>`, `source:<cid>`, `artifact:<id>` | Agents are the only first-class entities. `agentId` is a `uint256` ERC-721 token. |
| Validation challenges target envelope CIDs | Validation is `(validatorAddress, agentId, requestHash)`-keyed via `validationRequest` |
| Reputation attaches to artifact entities | Reputation is feedback-on-`agentId`; bodies are arbitrary |
| Metadata is embedded in agentURI strings | Metadata is `(agentId, metadataKey) → bytes` storage with indexed `MetadataSet` events |

The PR #37 entity model has no place to land in the real spec. Its `discovery/registry.ts` and `validation/registry.ts` are dead code against a non-existent contract shape.

## 3. What the prior docs already commit to

Internal documents commit to ERC-8004 carrying **content commitments + reputation**, not just operator identity:

- `agentic-data-substrate.md` Tier 3 §9: *"Rights licensing in ERC-8004 metadata — per-trajectory license tag."*
- `verifiability-traceability.md`: *"ERC-8004-style knowledge discovery and reputation for published artifacts"* composed with x402; the envelope binds to 8004 knowledge flows.
- `architecture-audit-j75.md` row "Public artifacts": *"ERC-8004 Identity Registry (address + metadata back-pointing to manifest CID)."*
- `portfolio-v0-design.md` §"Discovery": artifacts *"registered with the ERC-8004 registry with parent-manifest back-pointers."*

The prior docs' **intent** is correct and stays. PR #37's **implementation** — minting an NFT per CID — was the bug. The real `IdentityRegistry` already provides the substrate the docs describe (back-pointers via `setMetadata`), without spec abuse.

## 4. The decision (eight points)

### 4.1 One agent NFT per operator Safe

Each operator mints exactly one `agentId` at bootstrap, owned by the agent EOA, with the Safe wallet bound via `setAgentWallet`. The agentId is a stable identity that survives Safe rotation, persists across executions, and is portable to other chains via fresh registration.

### 4.2 Per-execution content commitments via `setMetadata`

For each published artifact (envelope, evaluation, intent claim), the operator calls:

```solidity
IdentityRegistry.setMetadata(myAgentId, "<kind>:<cid>", payload)
```

where `<kind>` is one of a small enumerated set (`envelope`, `evaluation`, `intent`, …) and `payload` is a small typed bytes blob carrying the trust-relevant fields:

```
payload = abi.encode(
    tier:                uint8,    // 0=self-signed, 1=committed, 2=consensus, 3=attested, 4=proved
    manifestHash:        bytes32,  // keccak256 of canonical manifest bytes (== JinnRouter evidenceHash)
    attestationQuoteCid: bytes,    // IPFS CID of TEE quote (empty if tier < attested)
    sourceMeasurement:   bytes32   // expected enclave measurement (zero if tier < attested)
)
```

This emits an indexed `MetadataSet(agentId, indexedMetadataKey, metadataKey, metadataValue)` event. Storage cost is one cold SSTORE (~$0.01 on Base) per published artifact. The full manifest, attestation quote, and source bundle live on IPFS, addressed by the CIDs in the metadata key/payload.

**The exact byte layout of `payload` is deferred to a follow-up Phase 1b spec** (see Beads §10, item 9), coordinated with the TEE envelope spec at `2026-04-23-jinn-execution-envelope-tee-scope.md`.

### 4.3 Reputation via `ReputationRegistry.giveFeedback`

At evaluator delivery settlement, the evaluator calls:

```solidity
ReputationRegistry.giveFeedback(restorerAgentId, fileuri, filehash, tag1, tag2, …)
```

with the feedback body naming the specific `manifestHash` (or manifest CID) the verdict pertains to. Reputation accrues to the operator's agentId; the body anchors which execution the feedback is about. Subgraph extracts the reference and surfaces `Feedback` rows joined back to `Execution`.

The contract enforces that the feedback caller is not the agent owner / approved / operator (no self-feedback). This is fine for our use: evaluators are independent agents from restorers by protocol design.

### 4.4 Challenges via `ValidationRegistry.validationRequest`

A challenger calls:

```solidity
ValidationRegistry.validationRequest(validator, operatorAgentId, evidenceHash)
```

where `evidenceHash` is the manifest hash JinnRouter already commits in `claimDelivery`. The validator answers with `validationResponse(requestHash, …)`. This becomes the on-chain shape of Phase 1b's challenge mechanism: per-execution disputes targeting the specific manifest, anchored to the operator's identity.

**Validator selection** (open vs whitelisted vs staked challenger pool) is **deferred** to Phase 1b spec (see §11). The deployed contract allows any address as `validator`; whether Jinn imposes additional gating is a separate decision.

### 4.5 Trust signals layered, not inherited

Two distinct trust layers, kept separate by design:

- **Operator-level** (slow-moving, accumulates): cumulative `ReputationRegistry` feedback, cumulative challenge record, JinnRouter-counted activity.
- **Per-execution** (fresh per run, intrinsic to the execution): `tier`, `attestationQuoteCid`, `sourceMeasurement` in the on-chain commitment payload + the TEE quote in IPFS + per-execution validation status from `ValidationRegistry`.

Per-execution trust is **not inherited** from the operator. A TEE-attested execution from a brand-new operator with zero reputation is exactly as trustworthy as the attestation says — the hardware vouches for the execution directly. The operator's NFT is where the per-execution anchor is filed; it does not confer trust to its folders.

This matches the substrate thesis (`agentic-data-substrate.md`) and the verifiability research (`verifiability-traceability.md`): operator diversity is a feature, the protocol enforces honesty per-execution, and buyers consume per-execution trust directly.

### 4.6 JinnRouter + OLAS staking remain the enforcement layer

ERC-8004 is the **signal layer** — who is who, who said what about whom, what is challenged. Slashing economics, activity counters, and reward eligibility all stay on JinnRouter + OLAS staking. ERC-8004 does not replace any existing on-chain enforcement. It adds a portable identity + per-execution-anchor surface on top.

### 4.7 Subgraph synthesizes the `Execution` entity

Even though no on-chain primitive is "an execution," the Jinn-owned subgraph stitches:

- `IdentityRegistry.MetadataSet` (envelope/evaluation publishes, decoded payloads)
- `JinnRouter` request/delivery events
- `ValidationRegistry.ValidationRequest` / `.ValidationResponse`
- `ReputationRegistry.NewFeedback` / `.FeedbackRevoked` / `.ResponseAppended`

into a queryable `Execution` row with `tier`, `manifestHash`, `attestationQuoteCid`, `sourceMeasurement`, `validations[]`, `feedback[]`, joined to `Operator { agentId, safe, … }`. This is the surface buyers and the client query against.

**Prior planning assumed consuming the canonical ERC-8004 subgraph; that was wrong.** The Jinn-specific entity model — envelope/evaluation/validation joined to operator and tier — is not a generic-8004 concern. We build our own.

### 4.8 Consume the deployed `0x8004…` registries

Identity, Validation, and Reputation are already deployed at vanity `0x8004…` addresses on Ethereum, Sepolia, Base, Base Sepolia, Arbitrum, and Optimism. We consume them as-is. No `contracts/src/erc8004/` deployment work.

## 5. Why this option (not the original A/B/C)

The design call started from three options:

- **(A)** Operator-NFT, all CIDs as agent metadata via `setMetadata`. Spec-faithful but described as a "big rebuild."
- **(B)** NFT-per-CID. Preserves PR #37's shape. **Category error against the spec.**
- **(C)** Identity Registry for operator identity only — drop content-on-chain ambition entirely. Smallest blast radius.

The chosen design is closest to **(A)**, but sharpened by three points the original framing didn't make:

1. **Per-execution payload, not just per-operator agentURI.** Tier + attestation pointers belong inside the per-execution `setMetadata` call's payload bytes, not in the operator's static agentURI. This is what makes per-execution trust queryable cheaply.
2. **Validation Registry is first-class for Phase 1b.** Its `(validator, agentId, requestHash)` shape is exactly what Jinn's challenge mechanism needs, once you accept that `requestHash = manifest.evidenceHash`. PR #37 had a guessed ABI here; the real one is a near-perfect fit.
3. **Subgraph ownership.** We build our own. The synthesized `Execution` entity is what consumers expect; the on-chain primitives are what the spec allows. The subgraph bridges them.

**(B) is dismissed** as a structural mismatch with the deployed contracts.

**(C) is rejected** for two reasons: it walks back four prior docs that explicitly commit to content + reputation in 8004, and it offers no Phase 1b challenge primitive in return. Phase 1b's challenge mechanism is named in the roadmap and lines up exactly with `ValidationRegistry`; declining to use it forces a parallel custom design.

## 6. Concrete operations table

| Operation | Plain English | Contract call |
|---|---|---|
| Operator bootstrap | "Get my cabinet" | `IdentityRegistry.register(agentURI)` once, in `EarningBootstrapper` |
| Bind Safe wallet to agentId | "Tell my cabinet which Safe owns me" | `IdentityRegistry.setAgentWallet(agentId, safeAddress, deadline, sig)` |
| Publish an envelope | "File this folder under my cabinet, payload carries tier + attestation" | `IdentityRegistry.setMetadata(myAgentId, "envelope:<cid>", encodedPayload)` |
| Publish an evaluation | Same shape, different kind prefix | `IdentityRegistry.setMetadata(myAgentId, "evaluation:<cid>", encodedPayload)` |
| Evaluator settles a verdict | "Pin a review on the operator's cabinet, body names the manifest" | `ReputationRegistry.giveFeedback(restorerAgentId, ..., body=manifestHash)` |
| Challenger disputes a manifest | "Ask validator V to re-check operator O's manifest M" | `ValidationRegistry.validationRequest(validator, operatorAgentId, manifest.evidenceHash)` |
| Validator responds | "Here is my finding on that dispute" | `ValidationRegistry.validationResponse(requestHash, ...)` |
| Buyer queries | "All attested envelopes from the last 30 days, validation status not challenged" | Jinn subgraph query (synthesizes from events) |

## 7. Files affected by this decision

### Create

- `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` — this document.
- `subgraph/` — new top-level directory for the Jinn-specific subgraph.
- `client/src/reputation/registry.ts` — Reputation Registry client (currently absent).

### Rewrite

- `client/src/discovery/registry.ts` — replace per-CID-entity logic with `(a) registerAgent(agentUri)` (idempotent, called from bootstrap) and `(b) publishContent(kind, cid, payload)` → `setMetadata(agentId, "<kind>:<cid>", payload)`. Use the real ABI from `/tmp/erc8004-ref/IdentityRegistry.json`.
- `client/src/validation/registry.ts` — replace guessed ABI with the real `ValidationRegistry` ABI. Implement `requestValidation(validator, agentId, evidenceHash)` and the response read paths.
- `subgraph/abis/IdentityRegistry.json`, `subgraph/abis/ValidationRegistry.json`, `subgraph/abis/ReputationRegistry.json` — real ABIs.
- `subgraph/src/handlers/*` — restructure handlers from "entity-per-CID" to `Operator + Execution + Validation + Feedback` entities synthesized from events.
- `client/src/earning/bootstrap.ts` — append a new step (`agent_registered`, idempotent, before `complete`). Calls `IdentityRegistry.register(agentURI)` from the agent EOA, persists `agentId` to `EarningState`.

### Drop

- `contracts/src/erc8004/` — confirm we deploy nothing.
- All `intent:<cid>`, `source:<cid>`, `artifact:<id>` entity-per-CID modeling in subgraph and client. (`envelope:<cid>` and `evaluation:<cid>` survive as **metadata key prefixes**, not as separate entities.)

### Update

- `docs/research/2026-04-23-verifiability-traceability.md` — append a one-paragraph note that the entity model is operator-NFT + per-execution metadata events. No contradictions with existing claims; just sharpening.
- `docs/reviews/2026-04-22-architecture-audit-j75.md` — update the "Public artifacts" row to reflect the corrected entity model.
- `spec/2026-04-21-agentic-data-substrate.md` — leave as-is; Tier 3 §9 ("Rights licensing in ERC-8004 metadata") works under this model.

## 8. PR #37 disposition

PR #37 has two distinct concerns:

1. **Envelope-v1 schema work** — independent of ERC-8004 entity model. This stays.
2. **ERC-8004 client wiring** (`discovery/registry.ts`, `validation/registry.ts`, subgraph handlers) — built against a non-existent contract shape. This is dead code.

**Path:** strip the ERC-8004 wiring from PR #37 (Beads task §10.1) and let the envelope-v1 schema land. The ERC-8004 client + subgraph are rebuilt from scratch in a separate PR (Beads tasks §10.2–§10.6) against the real ABIs and the entity model in this document.

## 9. What this design supports without committing to it now

- **TEE-attested executions** (Phase 1b/V2): `tier=attested` + `attestationQuoteCid` + `sourceMeasurement` already have slots in the payload schema. The actual TEE flow, build pipeline, and attestation verification are V2 work per `verifiability-traceability.md`.
- **Validator selection / staked challenger pool**: open today; can be tightened in Phase 1b.
- **License tags per trajectory** (`agentic-data-substrate.md` Tier 3 §9): published as `setMetadata(agentId, "license:<cid>", licenseBytes)` under the same pattern.
- **Cross-chain operator identity**: same agentId pattern works on every chain that has 8004 deployed; whether to require/encourage the same `agentId` across chains is a Phase 2 question.

## 10. Follow-up Beads tasks

Filed 2026-04-27:

| Bead | Title | Type | P | Depends on |
|---|---|---|---|---|
| `jinn-mono-2k6` | PR #37 surgical cleanup: strip ERC-8004 dead code, land envelope-v1 schema work | bug | 1 | — |
| `jinn-mono-j07` | Identity Registry client: operator agent NFT mint at bootstrap | feature | 1 | `2k6` |
| `jinn-mono-3zk` | Identity Registry client: per-execution `setMetadata` for envelope/evaluation publishing | feature | 1 | `j07`, `g7h` |
| `jinn-mono-9jg` | Validation Registry client: real ABI + `validationRequest`/`validationResponse` | feature | 2 | `j07` |
| `jinn-mono-2ff` | Reputation Registry client: `giveFeedback` on evaluator delivery | feature | 2 | `j07` |
| `jinn-mono-fud` | Build Jinn-specific subgraph (initial): index Identity/Validation/Reputation events, synthesize `Operator` + `Execution` entities | feature | 1 | — |
| `jinn-mono-al7` | E2E test: Phase 1b challenge flow on Base Sepolia | feature | 2 | `3zk`, `9jg`, `fud` |
| `jinn-mono-3q8` | Decision Record + spec updates: 8004 entity model | task | 1 | — |
| `jinn-mono-g7h` | Specify the on-chain commitment payload schema (`tier`, `manifestHash`, `quoteCid`, `sourceMeasurement`) | task | 2 | — |

## 11. Deferred questions

These are explicitly **out of scope** for this DR. Each becomes its own Phase 1b spec:

- **Validator selection model.** Open today; Phase 1b spec to decide whether to whitelist, stake-gate, or randomize.
- **Exact payload byte layout.** Beads §10.9. Coordinates with the TEE envelope spec.
- **License tag schema** for the substrate-thesis Tier 3 §9 work. Same `setMetadata` pattern, separate spec for the body format.
- **Cross-chain agentId coordination.** Phase 2 question.
- **Reputation summary algorithm.** ERC-8004 provides primitives; how Jinn computes summary scores from feedback + challenge record is a separate Phase 1b/2 design.

## 12. Non-goals

- This DR does not deploy any new contracts. The deployed `0x8004…` registries are the substrate.
- This DR does not specify or commit to a TEE flow being live in Phase 1b. The model supports `tier=attested`; the actual TEE work follows the envelope/TEE scope spec.
- This DR does not re-litigate the data-substrate thesis. That is in `agentic-data-substrate.md`.
- This DR does not redefine `evidenceHash`. JinnRouter's existing `evidenceHash` commitment is reused as the `requestHash` argument to `ValidationRegistry`.
