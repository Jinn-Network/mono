# Proposal: graduate the two doors to calls to action (DRAFT)

- **Date:** 2026-08-04
- **Status:** **DRAFT — not ratified.** Pending a GitHub Discussion and CODEOWNERS
  approval, per [`../../spec/2026-04-28-canonical-docs.md`](../../spec/2026-04-28-canonical-docs.md).
  `GROWTH.md` is unchanged until then, and the site ships under the current rule.
- **Amends:** [`GROWTH.md`](../../GROWTH.md) §3 — the funnel and the current call to action
- **Occasioned by:** the jinn.network site rebuild (DevX surface design
  [§4](../superpowers/specs/2026-08-03-devx-surface-design.md), umbrella issue #2396)

## 1. The rule today

GROWTH.md §3 binds every outward surface to one ask:

> the Telegram group is the single call to action on every outward surface for now. One
> CTA, everywhere, until the loop says otherwise.

and gives the reason:

> before the capability bet has public evidence, the honest ask is "watch us test it", not
> "switch your daily driver". When the v0 gate produces a result, the primary CTA
> graduates from *join* to *run*.

The rule is correct and this proposal does not weaken it. It was written against a
specific claim — *Jinn is the first agent that gets better as more people use it* — and
against the v0 gate as that claim's first public test.

## 2. What changed

DR-2026-07-30 ratified a platform identity. The site now has two doors: **Build on Jinn**
(your application or agent becomes the requester) and **Run an operator**.

The builder door's ask is not the capability bet. It is: *post a task on testnet, receive
the outcome, retrieve the evidence.* That is a claim about whether the platform works, and
it is verifiable in fifteen minutes by anyone who tries it. It does not depend on the v0
gate, because it does not assert that anything gets better.

The operator door's ask **is** partly aspirational: "earn OLAS" is true on the canonical
network, and that network runs on Base Sepolia. Mainnet economics are the Phase-2 target.

So the single rule now covers two asks with different evidence positions, and enforcing
one rule over both means either overclaiming the operator door or underclaiming the
builder door. The site as shipped chooses to underclaim: **both doors are navigation, and
Telegram is the only button on the page.** That is the conservative reading and it is what
GROWTH.md says today.

## 3. Proposed amendment

Add to GROWTH.md §3, after the Telegram-first paragraph:

> **Per-door graduation.** A door's ask may graduate from *join* to its own verb when the
> claim behind that door is independently checkable by the person being asked. Graduation
> is per door and per claim, not global. The builder door's claim ("post work, get an
> outcome and its evidence") is checkable without the v0 gate; the operator door's claim
> ("earn") is not checkable until mainnet economics exist, and stays behind the
> Telegram-first rule until then. A door that has graduated still carries the community
> link; graduation adds an ask, it does not remove one.

## 4. Trigger conditions for the builder door

All four must hold. Each is a fact someone can check, not a judgement call.

1. **The quickstart is executable and tested.** The commands the page instructs a reader
   to run are executed literally in CI against the Anvil-fork e2e harness, so CLI drift
   breaks the page red rather than silently (DevX surface design §7.2, deterministic
   tier).
2. **A cold agent completes the journey.** An agent given only the builder prompt, with no
   prior context, reaches post → deliver → retrieve on testnet in fifteen minutes or less,
   with no terminal touch by the human, spending nothing beyond faucet funds (DevX §11
   criterion 1).
3. **The blocker the ask depends on is cleared.** Schemas and kits resolve at their
   published origin without cloning the repository (DevX §11 criterion 2). Until they do,
   "build on Jinn" asks someone to depend on something they cannot fetch.
4. **Someone owns the inbound.** A named contributor is accountable for answering what the
   new ask produces. An ask with no one behind it converts worse than no ask.

The operator door's conditions are deliberately not enumerated here. They are downstream
of Phase 2 and belong to whoever writes that proposal.

## 5. How to run it

Not as a switch. As one attempt in the growth engine (GROWTH §4–§8), through the
`growth-experiment` skill:

- **One knob.** The CTA is the single change. Do not re-cut the copy, the layout, or the
  channel mix in the same attempt — a multi-knob change produces evidence about nothing.
- **Written prediction first.** Name the rung movement expected on the Mayfield curve and
  the number that would falsify it, before the change ships.
- **Log builder and operator doors separately.** Single-audience evidence does not
  generalize (GROWTH §7); a builder-door result says nothing about the operator door.
- **Revert is a real outcome.** If the graduated CTA does not move the rung it predicted,
  the loadout reverts to Telegram-first and the finding is logged. That is the engine
  working, not a failure.

## 6. What happens if this is rejected

Nothing breaks. The site already ships under the current rule: two doors as navigation,
one Telegram button, no install CTA anywhere. The builder door keeps routing to `/docs/build`
and the reader who wants to act can still act — they just do it after reading rather than
after being asked. Rejecting this proposal costs conversion on a funnel that is not yet
instrumented, which is a cheap thing to be wrong about and the reason it is worth
proposing rather than assuming.
