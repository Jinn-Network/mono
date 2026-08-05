# Jinn positioning spine — v2 (DRAFT)

- **Version:** 2.0-draft
- **Date:** 2026-08-04
- **Status:** **DRAFT — not ratified.** Pending a GitHub Discussion and CODEOWNERS review.
  Nothing in this document governs any surface until it is. The standing spine is
  [v1 (2026-07-07)](2026-07-07-jinn-positioning-spine.md); where the two disagree, v1 plus
  its own 2026-07-30 supersession note governs.
- **Chartered by:** the DevX surface design
  ([`../superpowers/specs/2026-08-03-devx-surface-design.md`](../superpowers/specs/2026-08-03-devx-surface-design.md) §10)
- **Derives from:** the ratified platform architecture
  ([`../superpowers/specs/2026-07-30-jinn-platform-architecture.md`](../superpowers/specs/2026-07-30-jinn-platform-architecture.md),
  DR-2026-07-30 — the boundary, the four verbs, the §11 newcomer paragraph) and the
  [platform one-pager](2026-07-29-jinn-platform-one-pager.md)

## Why a versioned update

v1 is a spine for a product: *Jinn is a personal agent backed by a shared, verified memory
of what other agents have learned.* Its beachhead is Hermes / OpenClaw users, its killer
objection is "prove it", and its single call to action is the Telegram group.

DR-2026-07-30 ratified a different identity. Jinn is a platform with a machine-enforced
boundary: tiers 1–3 are the platform, tier 4 is products. The personal agent is one of
those products. v1 already carries a note saying its personal-agent framing no longer
governs the landing page; this document is the versioned rewrite that note says is
outstanding.

What v1 got right and this version does not touch: the proof posture, the verb discipline,
and the messaging guardrails. Those were never about the personal-agent framing. They are
carried over verbatim in §5.

## 1. Naming

- **Jinn** — the platform. The only thing called just "Jinn".
- **Jinn Network** — the canonical deployment on Base, operated by Jinn contributors.
- **Products carry product names.** An agent, an operator app, a benchmark, a skill
  factory built on Jinn is named for itself, not called "Jinn".

This supersedes v1's "Jinn — the agent". The personal-agent story is **re-homed, not
killed**: it becomes the flagship product built on Jinn, with its own spine when it needs
one, and it stops being what "Jinn" means unqualified.

## 2. The spine

**What it is.** Jinn is an open platform for work and the evidence work creates.

It defines sealed records for requesting work, delivering it, and publishing what happened
— designed so third parties can produce and verify them without running Jinn's code — and
reusable capabilities for executing work and retrieving evidence. Jinn contributors
operate a canonical network on Base where work is escrowed, delivered, and evaluated, and
operators earn OLAS. Everything above that — operators, benchmarks, skill factories,
agents — is a product anyone can build, swap, or compete with.

*(The paragraph above is DR-2026-07-30 §11 verbatim. It is the ratified source; downstream
copy derives from it and is checked against it.)*

**The bet.** Every execution produces two outputs: an outcome for whoever asked, and
structured evidence anyone can reuse. Most work systems deliver the outcome and discard,
privatize, or silo everything learned along the way. The wager is that open projects can
compete with closed systems by pooling the evidence of their work instead of each
rebuilding capability inside its own silo.

**Why it is a platform claim and not a product claim.** The differentiator is not
distributed work. It is that the supply of work is also the supply of evidence, which
creates two demand loops that feed each other: demand for outcomes generates evidence, and
demand for evidence generates work. A product can ride either loop. Only the substrate
under both can be called the platform.

**Proof.** The boundary is ratified and machine-enforced. What is not yet true, stated
plainly and carried on every surface that makes the claim:

- The schemas and kits are not yet published, so third-party verification is a designed
  property no third party has yet exercised.
- The network runs on Base Sepolia today. Mainnet operation is the Phase-2 target.
- Per-task settlement economics and evaluator economics are still open design work.

**Check it yourself.** The read side needs no account, wallet, or consent. Every task,
attempt, and verdict on the canonical network is on chain, and the explorer renders it.
Claim what the chain shows — distinct addresses and distinct transactions — and name the
step where distinctness stops being independence.

## 3. Audience

- **Beachhead: agent-equipped builders.** People whose application or agent becomes the
  requester. They already delegate work to an agent; the ask is that some of that work go
  through a platform that keeps the evidence. This door works end to end on testnet today,
  and builders generate the demand operators need — which is why it is polished first.
- **Second: operators.** People who run a machine that performs and evaluates funded work.
  Their "earn" promise is partly aspirational until mainnet, and their door says so.
- **Third: evidence consumers.** Benchmarks, reputation systems, dataset builders, harness
  optimizers. Served through applications, not through the platform's own surface.

**The agent-first assumption, stated explicitly.** Every Jinn journey is executed by an
agent; the human's job is to decide, point, and approve. Someone who does not work through
an agent is not the target audience. Jinn is unusually entitled to that assumption,
because its own participants are agents doing work.

**Not a growth target:** OLAS / crypto-operator outreach. Operators arrive downstream of
builder demand.

**Killer objection.** It is no longer "prove the agent gets better" — that was v1's fight,
and it belongs to the product. The platform's objection is *"why would I build on
someone's protocol?"*, and the answer is the boundary: the records are producible and
verifiable without running Jinn's code, and every layer above them is replaceable. That
answer is only credible once the schemas and kits are published, which is why publication
is the first thing sequenced.

## 4. Commitments

- **The evidence is a public good.** No gatekeeping on what you read; no cut on what you
  pull.
- **The boundary is replaceable by design.** A conformant implementation that never runs
  Jinn's code is the point, not a tolerated edge case.
- **Operators earn OLAS for verified completed-loop work.** OLAS is the unit of both stake
  and reward; there is no Jinn token.
- **No one sits in the middle.** Jinn does not decide what a piece of evidence means.
  Applications remain responsible for what they trust and how they use it.

## 5. Messaging guardrails — carried over from v1, unchanged

- Don't say "proven", "guaranteed", or "best".
- Keep money and consent in plain words; drop the metaphor when safety or money is on the
  line.
- Don't write "paid" for protocol actions — operators *earn*; the protocol *escrows*,
  *settles*, *emits*, *mints*.
- Claim what the chain shows (distinct addresses and transactions), not who is behind
  them, unless you can back it.
- Every milestone surface carries its own "what this does not yet prove" section. Naming
  the gap is more Legible than papering over it.
- There is no "team", no "co-founder", no "executive". Attribution is role-only by
  default.

One guardrail is **retired**: v1's "call it a personal agent, not a coding tool" governed
the product's naming and does not apply to the platform. It moves with the personal-agent
story to that product's own spine.

## 6. Relationship to the canonical docs

`BRAND.md` and `GROWTH.md` are canonical and are **not** amended by this document.

- **BRAND.md** — no conflict identified. The voice, the headless posture, and the content
  non-negotiables apply unchanged. BRAND's canonical introduction ("The decentralised
  economy where agents learn to solve") is a compressed product-flavored line; whether it
  should be re-derived under the platform framing is a separate canonical-doc PR, not this
  one.
- **GROWTH.md** — one conflict, and it is deliberate. §3 binds every outward surface to a
  single call to action (the Telegram group) until the v0 gate produces a result. This
  spine's audience section implies two doors that would each want an ask. The site
  therefore ships the doors as **navigation** and keeps one CTA. The graduation is proposed
  separately in
  [`../proposals/2026-08-04-growth-cta-amendment-DRAFT.md`](../proposals/2026-08-04-growth-cta-amendment-DRAFT.md)
  and goes through the canonical-doc process, not through this document.

## 7. What this supersedes, and what still needs a pass

1. **v1's identity and naming** (v1 §Naming, §The spine). Superseded here.
2. **v1's beachhead** (Hermes / OpenClaw users). Superseded by agent-equipped builders.
   Growth attempts logged against the v1 beachhead do not transfer; single-audience
   evidence does not generalize (GROWTH §7).
3. **Outstanding rename passes.** Repository surfaces that still use "SolverNet" and
   "launcher" predate the role-model correction (requester / operator / evaluator). The
   shipped CLI still carries `--solver-net`; the quickstart documents it with a dated
   interim note rather than documenting a flag that does not exist.
