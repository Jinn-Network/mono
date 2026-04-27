# ERC-8004 DisputeProxy — adversarial third-party challenges on `ValidationRegistry`

**Version:** 1.0 (design proposal)
**Date:** 2026-04-27
**Status:** Proposed. Phase 1b ship/defer recommendation made (§6); ratification deferred to user.
**Beads:** `jinn-mono-b18` (this spec); related `jinn-mono-9jg`, `jinn-mono-fud`, `jinn-mono-al7`.
**Related:**

- `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` §4.4 — operator-initiated semantics of `ValidationRegistry.validationRequest` and the third-party-challenge gap this spec fills.
- `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md` — `manifestHash` is reused as the `requestHash` argument; no new hash domain.
- `docs/research/2026-04-23-verifiability-traceability.md` — challenge-mechanism context inside the broader evidence-tier story.
- `spec/2026-04-21-agentic-data-substrate.md` §6 — challenge mechanism as active-learning flywheel; this spec shapes its on-chain surface.
- `client/src/validation/registry.ts` (`jinn-mono-9jg`) — operator-side ValidationRegistry client; the proxy reuses the same registry from the public side.
- ERC-8004 reference contracts pinned at `erc-8004/erc-8004-contracts@0463311…` (staged at `/tmp/erc8004-ref/`).

## 1. Purpose

Enable **adversarial third-party challenges** on top of the deployed ERC-8004 `ValidationRegistry`. The registry's `validationRequest(...)` is gated to the agent owner, the `getApproved(agentId)` address, or anyone flagged via `setApprovalForAll(operator, true)` on the IdentityRegistry NFT (see DR §4.4). An arbitrary challenger cannot route a dispute through the registry directly.

A `DisputeProxy` is a thin contract — pre-approved by the operator — that exposes a **public** `requestValidation(...)` entry point and forwards each call to `ValidationRegistry.validationRequest(...)` on the operator's behalf. Approving the proxy is what makes an operator publicly challengeable through this path.

## 2. Trust model

**Opt-in by operators, by design.** Operators authorise the proxy via `IdentityRegistry.setApprovalForAll(proxyAddress, true)` (covers all agentIds they own) or `approve(proxyAddress, agentId)` (one tokenId). After approval, `ValidationRegistry`'s permission check passes when `msg.sender == proxyAddress`, so the proxy can forward arbitrary `validationRequest` calls bound to that agentId. Revocation is unilateral and immediate via `setApprovalForAll(false)` / `approve(address(0), agentId)`.

The proxy is intentionally narrow: it only forwards `validationRequest`. NFT-level approval is broader (it would also let the proxy call `setMetadata`), so the proxy must be immutable and minimal — see §3.

**Operators who don't opt in are not challengeable through this mechanism. This is a feature.** Adversarial challenges presuppose operator consent to the dispute jurisdiction. The protocol question is therefore *"how do we make installation socially load-bearing?"* — not how to force everyone in. Plausible levers, mentioned without prescribing:

- **Reputation discount.** Subgraph- or client-computed summary trust scores apply a haircut to operators who haven't opted in.
- **JINN-staking discount.** Reward or fee-rebate haircut for non-installed operators (Phase 2+; coordinates with tokenomics).
- **Buyer-facing UI signal.** Explorer surfaces a `challengeable: yes/no` facet on operator profiles.
- **Default-on in the reference client.** Bootstrap installs and approves the canonical proxy by default; operators must explicitly opt out.

The design choice is to keep the protocol-level commitment minimal (proxy is opt-in) and let the application layer create the gravity that makes opting in the cheapest path.

## 3. Contract design

### 3.1 One shared instance per chain, immutable, ownerless

The alternative is per-operator instances (operator deploys their own proxy and approves it), which gives tighter blast-radius isolation: a compromised shared proxy affects every approver simultaneously, while a per-operator proxy affects only its deployer. We pick the **shared, immutable** shape because:

- Immutability — no admin role, no upgrade hatch — closes the compromise vector. There is no path for a takeover to coerce malicious behaviour into approved operators.
- A single well-known address simplifies subgraph indexing, buyer UX, and bootstrap defaults; the per-operator path requires a sidecar `operator → proxyAddress` mapping.
- The IdentityRegistry approval is granular enough to revoke per-operator without per-operator deployment.

A small bond ledger (§3.3) is the only state. CREATE2 same-address deploys across chains are a follow-up (§7).

### 3.2 Public entry

```solidity
function requestValidation(
    uint256 agentId,
    address validator,
    string calldata requestURI,
    bytes32 requestHash
) external payable;
```

The proxy:

1. (Optional) collects a refundable bond from `msg.sender`.
2. Calls `ValidationRegistry.validationRequest(validator, agentId, requestURI, requestHash)`.
3. Records `(requestHash → challenger, bond)`.
4. Emits `ChallengeOpened(agentId, validator, requestHash, challenger, bond)`.

`requestHash` reuses the `manifest.evidenceHash` domain — no new hash schema.

### 3.3 Optional: bonding

Challenger posts `msg.value >= minBond` (or a JINN `transferFrom`). Validator's `validationResponse` settles the bond: scores below threshold (operator was correctly challenged) refund the challenger; scores at or above threshold (operator was correctly defending) forfeit the bond — split between operator, treasury, or burn. A timeout returns the bond if the validator never responds.

The shape is sketched here; **`minBond`, threshold, split, timeout, and currency are deferred** to a follow-up economics spec. The contract leaves these as constructor immutables or governance-set values, never hardcoded magic numbers.

### 3.4 Optional: signed-request (meta-tx)

A `requestValidationWithSig(req, sig)` entry that accepts an EIP-712-signed `(challenger, agentId, validator, requestURI, requestHash, bond, expiry, nonce)` payload, verifies, and forwards. Useful for browser/no-gas challengers; strictly optional for v1.

## 4. Operator UX

Two integration points in the existing client:

1. **Bootstrap.** Append idempotent step `dispute_proxy_approved` to `EarningBootstrapper`, between `agent_registered` and `complete`. Calls `setApprovalForAll(disputeProxyAddress, true)` from the agent EOA, persists the approval, skipped if `isApprovedForAll(owner, proxyAddress)` is already true. Default-on; opt out via `config.disputeProxy.optOut: true`.
2. **CLI.** `jinn dispute-proxy install` and `jinn dispute-proxy uninstall` for post-bootstrap operators. After `uninstall` returns, the operator is no longer challengeable through the proxy.

Address book entry `DISPUTE_PROXY_ADDRESSES: Record<chainId, Address>` lives next to the existing `VALIDATION_REGISTRY_ADDRESSES` map in `client/src/validation/registry.ts`.

## 5. Subgraph integration

Forwarded calls show up as **normal `ValidationRegistry.ValidationRequest` events** — the existing subgraph (`jinn-mono-fud`) already indexes these. **No subgraph schema changes are required for the basic flow.**

To distinguish proxied (third-party) from non-proxied (operator-self) requests, two derivations:

1. **Index the proxy's own `ChallengeOpened` events**, joined to `ValidationRequest` rows by `requestHash` (which is unique across the registry — it's the storage key). Yields a clean `Validation { isProxiedChallenge: bool, challenger?: address, bond?: BigInt }` derivation.
2. **Heuristic from registry events alone.** Read the transaction's `from` field on each `ValidationRequest` and compare to `proxyAddress`. Works without proxy-side events but depends on `tx.from` access in The Graph runtime, which is supported but less robust.

**Recommendation: option 1.** One new event handler, one new field on the `Validation` row (or a sibling `Challenge` row).

## 6. Phase 1b decision

**Recommendation: defer DisputeProxy to Phase 2; do NOT block Phase 1b on it.** This is a recommendation, flagged for user decision.

**Ship now (Phase 1b):** `jinn-mono-al7` can exercise the full four-phase loop — including adversarial third-party disputes — instead of only operator-self-validation. Operators graduate from Phase 1b having already opted in, normalising the social pressure §2 describes. Solidity surface is small; the unbonded forwarder is shippable on its own.

**Defer (Phase 2):** Bond economics, slashing split, and challenger eligibility (§7) are unsettled. Shipping unbonded now and bolting on bonding later means two deploys and a known-griefable surface during Phase 1b. The operator-self-validation path (DR §4.4) carries the Phase 1b validation story on its own; al7's coverage gap is real but bounded — the test can stub the third-party path or be split. Phase 2 mainnet launch is the natural moment to commit to slashing/treasury wiring; DisputeProxy slots in cleanly there.

**Recommended path:** ship operator-initiated validation in Phase 1b; design and ratify DisputeProxy economics during Phase 1b; deploy DisputeProxy in Phase 2 alongside JINN slashing/treasury wiring. al7 covers operator-self-validation in Phase 1b; a follow-up E2E covers adversarial challenges in Phase 2.

## 7. Open questions (deferred)

- **Bond economics.** `minBond`, currency (ETH vs JINN), slashing split (operator / treasury / burn), timeout. Coordinates with Phase 2 tokenomics + slashing.
- **Challenger eligibility.** Open / whitelisted / token-gated / staked. Open-with-bond is the simplest deterrent and aligns with the substrate-thesis active-learning framing; griefing economics need modelling before ratification.
- **Slashing path for meritless disputes.** Tied to bond economics; must integrate with JinnRouter activity counters so a meritless challenger isn't also rewarded as a "participant."
- **Cross-chain proxies.** CREATE2 same-address deploys across Base / Base Sepolia / Ethereum / Sepolia / Arbitrum / Optimism, matching the `0x8004…` pattern. Phase 2.
- **Validator selection (orthogonal).** Same open question DR §4.4 defers for the operator-self-validation case; the proxy does not change this either way.
- **Per-operator bond override.** Sidecar `bondPolicy(agentId)` registry, e.g. operator says challenges against their agentId require a 10× bond. Deferred.
