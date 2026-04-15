# Agent Attention Market — Discussion Notes

**Date:** 2026-03-04
**Status:** Early exploration — open questions, no conclusions

---

## The Problem

Agent social networks like Moldberg fail because the economics are inverted. There's no incentive for an agent operator to spend inference reading another agent's output. Why would I pay to read your agent's marketing? The consumer bears the cost while the producer benefits.

This is the fundamental issue with any "social network for agents" — without economic incentive, the content produced is overwhelmingly low-quality noise (marketing, spam, self-promotion). You can't build a functioning attention economy when attention has no price.

---

## The Core Idea

Flip it: **publishers pay for agent attention**.

If you want another agent to read your document, you post a bounty. You're effectively saying: "This content is worth X to me for you to consume." This creates:

1. **Price discovery for agent attention** — the market determines what a read is worth
2. **Spam prevention** — it costs real money to get in front of agents
3. **Revenue for agent operators** — agents earn by reading
4. **Quality signal** — willingness to pay signals publisher conviction

This is essentially **Google AdWords for agents** — pay to get in front of the right agents, with proof they actually processed your content.

---

## Could This Be Built on Existing Protocols?

### ERC-8004 ("Trustless Agents")

ERC-8004 provides three on-chain registries:

1. **Identity Registry** — ERC-721 + URIStorage, resolves to a registration file
2. **Reputation Registry** — Feedback signals on registered entities
3. **Validation Registry** — Request/respond validation (validationRequest → validationResponse)

Key observation: **the Identity Registry is already generic.** It's an ERC-721 token whose URI can resolve to anything — an agent card, a document registration file, a bounty spec. ERC-8004 doesn't restrict what the URI points to.

This means ERC-8004 already supports documents, not just agents. The ADW (Agentic Document Web) spec confirms this — it says "A document can be registered on the same Identity Registry as an agent." ADW is really a convention/profile for how to use ERC-8004 with documents, not a separate protocol.

**Open question: Does ADW need to exist as a separate spec, or should it fold into ERC-8004 v2?** The three registries are type-agnostic. ADW's contribution is the document type taxonomy and provenance metadata — which could be a profile within ERC-8004 rather than a standalone standard.

### x402 (HTTP-Native Payments)

x402 (Coinbase) revives HTTP 402 "Payment Required" for instant stablecoin micropayments:

- Server returns 402 + payment terms
- Client signs payment, retries with X-PAYMENT header
- Facilitator verifies + settles on-chain (Base, Solana)
- Already live: 35M+ transactions on Solana, supported by Cloudflare

x402 is designed for "pay to access" (reader pays publisher). The bounty model is the opposite — publisher pays reader. But the x402 facilitator infrastructure could serve as escrow if wired differently.

**Open question: Can x402 handle the "publisher pays reader" direction?** The protocol itself is directional (client pays server). Inverting it might require AP2 or a custom facilitator configuration.

### AP2 (Agent Payments Protocol)

Google's payment extension for A2A, built with 60+ partners including Mastercard, PayPal, and Coinbase. Key features:

- Reuses A2A sessions, tasks, and streams
- Supports **Intent Mandates** — pre-authorize payment conditions ("I'll pay any agent that does X")
- Settlement via x402 rails for crypto payments
- W3C Verifiable Credentials for payment proofs

AP2 Intent Mandates look like they could handle the bounty direction: publisher pre-authorizes "I'll pay any agent that reads and proves processing of document X."

**Open question: Is AP2 mature enough to build on?** The spec is evolving. How much of this is production-ready vs. aspirational?

### A2A (Agent-to-Agent Protocol)

Google's agent interop protocol. Agents publish Agent Cards at `/.well-known/agent.json`, communicate via JSON-RPC, and coordinate tasks.

A2A handles discovery (Agent Cards), task lifecycle (submitted → working → completed), and communication (messages, artifacts). It doesn't handle payments natively — that's AP2's job.

**Open question: Is A2A the right discovery mechanism for bounties?** Agents could advertise "I accept bounty reads" in their Agent Card skills. Publishers could discover readers via A2A directory.

---

## The Minimal Protocol Stack

If we compose these existing protocols, the bounty system might need **zero new smart contracts**:

```
ERC-8004 Identity Registry   →  register documents (same registry as agents)
ERC-8004 Validation Registry →  proof-of-read (validationRequest → validationResponse)
AP2 / x402                   →  payment settlement
A2A                          →  bounty discovery + agent coordination
```

The flow:

1. Publisher registers document on ERC-8004 Identity Registry
2. Publisher creates `validationRequest` on Validation Registry — "read this document"
3. Payment terms live in the `requestURI` (IPFS JSON with AP2/x402 payment details)
4. Agent discovers open validation requests via indexer or A2A
5. Agent reads document, submits `validationResponse` as proof-of-read
6. Payment settles via AP2/x402

The "app" is then just:
- A **convention** for bounty-type validation requests (schema for payment terms)
- A **simple node** that watches for bounties and claims them
- A **facilitator** (or x402 integration) for payment settlement

---

## The Verification Problem

How do you know the agent actually read and internalized the document, versus just claiming the bounty?

### Approaches discussed:

**Node attestation (trust-based)**
The agent's node (e.g., Jinn worker) signs an attestation that the document was loaded into the agent's context window. Trust comes from the node operator's stake — if they lie, they risk slashing.

**TEE attestation (hardware-based)**
If the agent runs in a Trusted Execution Environment (Phala, Intel SGX), the TEE produces a hardware attestation proving the document bytes were in the enclave's memory. Trustless but requires TEE infrastructure.

**Proof of processing (output-based)**
Agent produces a structured response (summary, embedding, action taken) that is compared against document content. Embedding similarity above a threshold counts as proof. Could be verified on-chain with an oracle or optimistically with a challenge period.

**Open question: What level of verification is actually needed?** If the bounty is small enough (micropayments), maybe trust-based is fine — the cost of cheating isn't worth it. For large bounties, TEE or proof-of-processing might be necessary. The market might self-regulate: agents that cheat get bad reputation scores on the Reputation Registry, reducing their access to future bounties.

---

## Does This Need OLAS / Jinn?

A key observation: if the bounty protocol is just ERC-8004 + AP2 + x402, then the "node" that watches for bounties and claims them is **extremely simple**. It's not a full OLAS service or a Jinn worker — it's just:

1. Watch for validation requests (bounties) via an indexer
2. Fetch and read the document from IPFS
3. Submit a validation response
4. Receive payment

This is a trivially simple agent loop. You don't need the OLAS marketplace, the service framework, or any of the vertical integration that comes with it. You could run this as a lightweight daemon, a Cloudflare Worker, or even a browser extension.

**Open question: Does the simplicity of this node mean OLAS/Jinn are unnecessary, or do they provide value through staking (sybil resistance) and reputation (quality signal)?** The staking model gives you economic security — agents have skin in the game. But you could also get sybil resistance through ERC-8004's Reputation Registry without OLAS.

---

## Existing Escrow Options (If Needed)

If pure x402/AP2 isn't sufficient for publisher-pays-reader escrow, there are existing on-chain options:

- **OpenZeppelin ConditionalEscrow** — ~50 lines of custom Solidity on top of battle-tested base
- **trust-escrow** — npm package, already deployed on Base Sepolia, 12 CLI commands
- **AgentEscrowProtocol** — production contract on Base mainnet for USDC agent-to-agent payments, built-in reputation, 2.5% fee
- **StandardBounties** — deployed on Ethereum mainnet, full bounty lifecycle, but heavyweight and possibly dormant

**Open question: Is a thin escrow contract needed at all, or does x402 + a facilitator configuration cover it?**

---

## What Would the "App" Actually Be?

Concretely, the deliverable might be:

1. **A protocol spec** — defining the convention for bounty-type validation requests on ERC-8004, including the schema for payment terms in the `requestURI`
2. **A bounty node** — lightweight daemon that discovers bounties, reads documents, submits proofs, claims payments
3. **A publisher CLI/UI** — for creating bounties (register document + create validation request + fund escrow/x402)
4. **An indexer** — Ponder or subgraph that indexes bounty-type validation requests for discovery

The question is whether this is a standalone product or an extension of existing infrastructure (ADW explorer, Jinn worker, etc.).

---

## Open Questions Summary

1. **ADW vs. ERC-8004**: Does ADW need to exist separately, or should document support fold into ERC-8004?
2. **Payment direction**: Can x402/AP2 handle publisher-pays-reader, or is a thin escrow needed?
3. **Verification level**: Trust-based (node attestation), hardware-based (TEE), or output-based (proof of processing)?
4. **OLAS dependency**: Does this need OLAS staking for sybil resistance, or is ERC-8004 reputation sufficient?
5. **AP2 maturity**: Is AP2 production-ready enough to build on?
6. **Node complexity**: Is the bounty node simple enough to exist independently, or does it benefit from OLAS/Jinn infrastructure?
7. **Targeting**: How do publishers specify which agents they want to reach? ERC-8004 reputation scores? A2A Agent Card skills? Tags?
8. **Market dynamics**: What's the floor price for agent attention? How does the market reach equilibrium?

---

## References

- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [x402 Protocol](https://www.x402.org/)
- [x402 Whitepaper](https://www.x402.org/x402-whitepaper.pdf)
- [AP2: Agent Payments Protocol](https://ap2-protocol.org/)
- [A2A Protocol](https://a2a-protocol.org/latest/specification/)
- [ADW Spec v0.1](../adw-spec/spec.md) (internal)
- [Coinbase x402 Developer Docs](https://docs.cdp.coinbase.com/x402/welcome)
- [Cloudflare x402 Launch](https://blog.cloudflare.com/x402/)
