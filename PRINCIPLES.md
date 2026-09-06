# PRINCIPLES

**What this doc is / is not.** This is the canonical statement of the principles that govern every design and operational decision in Jinn. It is not a values manifesto, a marketing artifact, or a list of preferences — each principle is load-bearing on legitimacy and constrains real choices. It is upstream of `SPEC.md` (which encodes how the protocol implements these principles), `THESIS.md` (which says why the protocol exists), and every downstream doc. Changes go through CODEOWNERS review with a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions); see [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).

> Provenance: GitHub Discussion [#222](https://github.com/Jinn-Network/mono/discussions/222) (launch gating + principles re-establishment).

## Meta-principle — Legitimacy

The over-arching principle is that Jinn aims to become the most legitimate decentralised agentic AI network. This is legitimate as originally defined by Vitalik Buterin. In this sense, legitimacy essentially means that all participants of the network, even at the very edges, believes that Jinn is and will continue to be the right decentralised agentic AI network to coordinate around.

The following principles spring from that.

## Neutral

- we should be able to signal our qualities cheaply in a way that would be expensive to fake
- the network does not structurally benefit any individual or entity above any other
- also associated with fairness / minimal viable extraction

## Learning Maximised

- Jinn must be more performant than comparable networks
- we believe this derives from alignment with the Bitter Lesson — i.e. the observation that systems that prioritise search and learning outperform systems that rely on strategies transposed from other contexts
- in other words discovery beats encoded cleverness

## Governance Minimal

- bloated governance reduces neutrality by increasing capture surface, and reduces learning by encoding human taste into the production process
- Jinn makes decisions about itself via the most minimal mechanism, in a public and rule-bound way
- we seek to minimise governance surface area and push decisions to mechanism where possible

## Permissionless

- the path from outsider to participant has no privileged shortcuts
- the network's output is composable — anyone can build on Jinn's primitives without permission

## Prestige

- Jinn participants seek freely conferred deference from others based on demonstrated competence and value, not deference based on coercive power (referred to in the literature as Prestige over Dominance)
- this leads to a network where participation is earned, rather than forced, and which ultimately leads to stronger network continuity

## Legible

- every claim we make about ourselves must be independently and robustly verifiable — on-chain where possible
- where a claim cannot be anchored on-chain, it is Legible only if a third party can check it with their own tools from the artifact's own bytes, without running ours
- an artifact that carries a claim must also state what it does not prove; an unstated limit is an unverifiable claim (see [`packages/benchmark-product/EXTERNAL-VERIFICATION.md`](packages/benchmark-product/EXTERNAL-VERIFICATION.md), which tabulates what its bundles prove, what only the reference verifier proves, and what no tool proves)
- verification of claims takes the above principles from the realm of private belief into common knowledge; without common knowledge of Jinn's state, we cannot become the most legitimate network
