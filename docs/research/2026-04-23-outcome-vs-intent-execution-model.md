# Outcome vs. Intent: What Jinn Actually Executes

**Date:** 2026-04-23
**Author:** Discussion note (for the record, to share with Ritzy)
**Status:** Research / design discussion — not a spec or commitment

## Framing

This note captures a design discussion about a question that keeps recurring when explaining Jinn: *does the protocol actually execute outcomes on the requester's behalf, or does it only produce recommendations that something else executes?* The answer affects how we talk about the protocol, where trust lives, what the evaluator has to verify, and whether "intent" is even the right word.

## The question

A requester posts a desired state. The corpus of prior knowledge is used to produce a plan. Who executes the plan?

The word "intent" carries a CowSwap-style connotation: the requester expresses a desired change in their wallet balance, signs a message granting a solver contract permission to move funds, a solver competition runs, and the contract atomically executes the winning solution on the requester's behalf. The requester never personally broadcasts the transactions — delegation + bounded permission + on-chain atomicity do the work.

That model is appealing but probably unrealistic as the general case for Jinn. Most interesting desired states aren't bounded token swaps — they're things like "my repo is green", "my garden is flourishing", "this external service is healthy". There is no ERC-20 approval analogue for those; no narrow on-chain permission grant can cover the capability space required to effect the change. So either (a) the requester delegates something much broader than anyone would be comfortable with, (b) execution happens in someone else's trusted environment, or (c) execution happens back in the requester's own trusted environment using the plan as input.

## Three models

1. **CowSwap-style (delegated execution).** Requester signs, grants bounded permission to a shared contract, solvers compete, contract executes atomically. Works only when the intent is narrow enough to bound permissions on-chain (e.g. token swaps).
2. **Jinn-style (restorer-side execution).** The restorer executes in *their own* environment, using whatever capabilities they have (their keys, their compute, their API tokens, their agent). The protocol coordinates request → claim → deliver → evaluate and accumulates knowledge. The protocol is *not* the execution substrate. This is already what the current loop does.
3. **Plan-only (requester-side execution).** The protocol produces a recommendation; the requester's own trusted environment executes it. No delegation at all.

## Recommendation

(2) should be the default framing, and (3) falls out for free: if a plan requires requester-side capability (touching the requester's wallet, their private infra), then "restoration" just means "produce a plan / PR / tx-bundle" and the requester's environment executes it. (1) fits only as an *optional add-on* for narrow intent classes where bounded delegation makes sense — e.g. a hypothetical JINN-native swap outcome — and should not be the general model.

## The tradeoff to be honest about

Moving the trust boundary off-chain has a real cost. (1) buys atomicity: the chain either executes or it doesn't. (2) and (3) can't offer that. Instead, "did execution actually happen" becomes a matter of *evidence + evaluation* rather than on-chain state transition. That's fine — for open-ended desired states it's arguably the only honest model — but it means the evaluator is doing heavy lifting that a solver contract does in CowSwap.

## Two verification questions that need to be kept separate

The evaluator's job splits cleanly into two questions, and they're often conflated:

1. **Did the outcome actually occur?** A state check. Sometimes readable on-chain (wallet balance), usually off-chain and evidence-based (repo green, service healthy).
2. **Was it caused by the claimed solution?** An attribution question. Almost always off-chain and evidence-based — requires something like a trace, log, PR link, or tx hash tying the restorer's actions to the observed state change.

For a wallet-balance desired state, both are trivial: read the chain for (1), inspect the tx trace for (2). For anything qualitative, both are hard, and they're hard in different ways. A solution that worked but can't be attributed is indistinguishable from a lucky coincidence; an outcome that isn't observable can't be verified at all.

The current codebase has the outcome-check scaffolding in place (`DesiredState`, the evaluator loop) but the *attribution* piece — the evidence schema that links solution to outcome — is not yet defined. Phase 1b is the right place for it.

## Missing components

Things that follow from the above but aren't built yet:

- **Evidence schema.** Structured evidence linking a submitted solution to the observed outcome. On Phase 1b's roadmap.
- **Attribution mechanism.** How does the evaluator verify that the restorer's actions (not some third party's, not coincidence) produced the observed state change?
- **Plan-only path.** A "restoration" that produces a plan for the requester to execute, rather than executing directly. Evaluation in that path measures plan quality, not outcome realization — or defers outcome verification to after the requester applies it.

## Terminology

"Intent" leaks the CowSwap "sign-and-delegate" connotation we're trying to avoid, and semantically it points at the requester's internal wish rather than the world state being targeted. **Outcome** is a better external-facing word. It describes the target world state, which is what Jinn is actually about.

The codebase already uses `DesiredState`, which is an outcome framing. Proposal:

- **Internal code:** keep `DesiredState` — it's entrenched and accurate.
- **External docs and public-facing language:** standardize on **outcome** (or "desired outcome") rather than "intent".
- Reserve "intent" for the narrow CowSwap-style delegation pattern, if and when we ever implement that as an add-on.

Over time it may be worth renaming `DesiredState` → `Outcome` in code too, since they're synonymous, but that's a larger change and not worth doing just for vocabulary consistency right now.

## Summary for Ritzy

- Jinn is not CowSwap-shaped and shouldn't pretend to be.
- The protocol coordinates and accumulates knowledge; *execution happens in whichever trusted environment has the capability* — usually the restorer's, sometimes the requester's.
- That design decision shifts the verification burden from on-chain atomicity to off-chain evidence and evaluation. Owning that tradeoff explicitly is important.
- Evaluation has two distinct questions (did the outcome occur, was it caused by the solution). Both need to be in the evidence schema.
- Move external vocabulary from "intent" to "outcome". Keep `DesiredState` internally for now.
