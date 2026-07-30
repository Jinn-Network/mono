# Jinn positioning spine

- **Version:** 1.0
- **Date:** 2026-07-07
- **Author:** Oak (writing session)
- **Status:** Standing infrastructure for the Jinn Harness Network v0 gate ([#1307](https://github.com/Jinn-Network/mono/issues/1307), [#1315](https://github.com/Jinn-Network/mono/issues/1315))
- **Superseded for public surfaces (2026-07-30):** jinn.network now tells the platform/market story from the [2026-07-29 platform one-pager](2026-07-29-jinn-platform-one-pager.md), which is the copy source for the site. This spine's personal-agent framing ("a personal agent backed by a shared, verified memory") no longer governs the landing page. Its messaging guardrails — no "proven"/"guaranteed"/"best", plain words on money and consent, earn-not-paid, claim only what the chain shows — still apply to every surface. A versioned rewrite of the spine under the platform framing is outstanding.

## What this document is

The internal messaging spine for Jinn: thesis, capability claim, proof posture, commitments, and guardrails. It is not shipped copy. Every downstream surface — README, landing page, launch thread, deck — derives from it and is checked against it. If a surface contradicts the spine, the surface is wrong or the spine needs a versioned update.

## Naming

- **Jinn** — the agent. The product a person runs. The only thing called just "Jinn".
- **Jinn Network** — the sum of agents, operators, and ecosystem actors.
- **Jinn Protocol** — the on-chain layer.

This supersedes prior usage where "jinn-agent" was the product name and "Jinn" meant the network. Repo surfaces that still say "open coding harness" or use "jinn-agent" as the human-facing name ([jinn-agent README/JINN.md](https://github.com/Jinn-Network/jinn-agent)) are due a rename pass.

## Audience

**Beachhead: Hermes / OpenClaw users.** People already running a memory-built, generalised personal agent from Nous. They need the least convincing on premise: the memory chasm is already crossed (Hermes is built around memory) and the crypto chasm is already crossed (Nous is a crypto project). The only fight left is proof.

**Expansion: broader AI power users** (Claude Code, Cursor, heavy assistant workflows) — later, not now.

**Not a target for this spine:** OLAS / crypto-operator outreach. Downstream concern.

**Killer objection:** "Prove it." The concept is conceded by the beachhead reader; what is unproven is whether Jinn's shared corpus measurably beats their current setup. The spine answers this twice — honestly in Proof (no number yet; the v0 gate is the first public test) and practically in Check it yourself (self-verification).

## The spine

**What it is.** Jinn is a personal agent backed by a shared, verified memory of what other agents have learned.

**The bet.** Jinn is the first agent that gets better as more people use it. It's a bet that says: when users can write their data to the blockchain, where it gets verified, that forms a learning substrate that makes every user's agent better at the work they actually do.

**Capability.** Jinn agents learn by doing the work. An agent takes on a task, the result is checked, and what passed becomes a skill the network can reuse. Across many agents and many tasks, the network keeps getting better at the kinds of work people bring it. Your agent draws on that, so it improves at your tasks even between your own sessions.

- Learning carries across attempts: a verified result today makes the next run at that kind of task stronger.
- Only verified work is learned from, so the shared memory sharpens over time.
- The learning deepens where people actually work, and you steer it toward the tasks you run.
- Because the whole network is learning your kind of task, your agent improves faster than one learning only from itself.

**Proof.** There's no benchmark yet. Jinn runs on testnet, and the corpus is new. Little has been verified into it so far, so today the agent mostly suggests what it finds rather than adopting it outright. The bet gets its first real test at the v0 gate. It's early, and that's deliberate: the more verified learning the corpus holds, the more your agent gains, so the payoff grows with use. Better a claim you can check than one you have to take on trust.

**Check it yourself.** Reading the corpus needs no account, wallet, or consent. You can try it cold. Contributing is off until you turn it on. When it's on, nothing leaves your machine unscrubbed: scrubbing is mandatory and fails closed, you preview the exact payload before the first publish, you can veto any task, and a ledger shows everything that ever left, each anchored on chain. So you don't have to trust the claim. Run it, and watch what the corpus gives back on your own work.

**Commitments.** The corpus is a public good: no gatekeeping on what you read, no cut taken on what you pull. You earn OLAS for verified contributions, and you steer where the corpus deepens, toward the work you actually do. Its users point it at their own needs; no one sits in the middle.

## Messaging do-not

Guardrails for anything derived from this spine:

- Don't say "proven", "guaranteed", or "best" — it's a bet until the v0 gate says otherwise.
- Lead with the agent and what it learns, not with tokens or chains.
- Keep money and consent in plain words; drop the metaphor when safety or money is on the line.
- Don't write "paid" for protocol actions — operators earn; the protocol emits, mints, settles.
- Claim what the chain shows (distinct addresses and transactions), not who's behind them, unless you can back it.
- Call it a personal agent, not a coding tool.

## Known conflicts this spine supersedes

Recorded so the rename/reframe passes are tracked, not silent:

1. **"Open coding harness"** — jinn-agent README.md and JINN.md lead with the coding framing. The spine positions a generalised personal agent. The docs need a reframe pass.
2. **Product naming** — repo surfaces use "jinn-agent" as the human-facing product name; the spine names the product **Jinn** (see Naming above).
3. **Boilerplate framing** — earlier comms guidance mandated "an open agentic knowledge economy" as the headline framing of what Jinn *is*. Under this spine, that phrase describes the **Jinn Network**, not the product; About-blocks about the product lead with the agent.
