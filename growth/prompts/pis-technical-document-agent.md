# Prompt: PIS technical document agent

Status: final — for handoff
Intended use: hand to another agent (Claude Code session or similar) to collaboratively produce the PIS technical document with Oak

## Project context

Jinn Network is an outcome-scoring protocol built on OLAS. Two co-founders: Oak and Ritsu. Oak is in wartime co-CEO mode focused on distribution, narrative, and first executor recruitment. Ritsu runs protocol.

The document you're helping produce introduces Jinn as a protocol layer and PIS (Prediction Intelligence Service) as its first [subnet / outcome net — naming undecided]. Target reader: ex-Bittensor subnet operators, OLAS polystrat builders, quant hobbyists, prediction-tool builders. They read 20 minutes, decide whether to run an executor.

## Where to look before starting

Read these in order before asking Oak any questions. Do not ask Oak to explain Jinn to you — it's in the repos.

`jinn-network/mono` — technical monorepo on Base mainnet

- `CLAUDE.md` at root — system architecture overview, phase status, on-chain addresses, three-layer model (DAO / Distribution / Execution)
- `spec/2026-03-23-jinn-protocol-spec-proposal.md` — protocol spec (loop, roles, trustlessness, knowledge accumulation)
- `spec/2026-03-23-jinn-implementation-spec-proposal.md` — three-layer architecture, tokenomics, incentive channels
- `spec/2026-04-06-phase-1a-design.md` — JINN token + Treasury + Dispenser, testnet deployment
- `docs/planning/2026-04-jinn-mvl-on-olas.md` on branch `ale/jinn-phase-plan` — Ritsu's minimum viable launch proposal, the current working direction for contracts. If the branch is gone by the time you read this, fall back to searching `docs/planning/`.
- `jinn-cli-agents/docs/context/olas-protocol.md` — OLAS governance, registries, tokenomics context
- `jinn-cli-agents/docs/context/network-thesis.md` — what's defensible (distributed execution memory), node economics, scaling

`jinn-network/growth` — Oak's growth work

- `CLAUDE.md` at root — target audiences, strategic principles, current positioning (note: tagline "Own What You Know" is being retired, framing has moved to outcome-scoring + PIS)
- `docs/2026-04-10-how-protocols-launch.md` — research into how Bitcoin, Ethereum, Bittensor bootstrapped; governs the launch philosophy

Historical reference only, don't build on: `oaksprout/jinn-gemini` is the old implementation. Subtreed into mono as `jinn-cli-agents/` for OLAS and staking reference. Not current.

## Current strategic state Oak won't re-explain

You can assume as given:

- Jinn's primitive is "desired state in, desired state out" with evaluator ≠ executor as a structural trust rule (not a game-theoretic bond like Bittensor's Yuma Consensus).
- Positioning is output vs outcome: Bittensor scores model outputs via validator consensus; Jinn scores outcomes against reality. This is the load-bearing differentiator.
- Jinn is the protocol layer; individual verticals are [subnets / outcome nets], each roughly one staking contract + activity checker. PIS is the first. Hyperliquid-style financial intents are a candidate second. Do NOT frame Jinn as "Jinn is PIS" — that collapses the protocol layer.
- Governance: Ethereum mainnet Governor + Timelock + canonical JINN. Base distributor. Cross-chain admin calls. No team keys, no pre-mine, no allocation. Every JINN ever minted comes from measurable operator work. 18-day observation window on every change.
- Ritsu proposed minimum viable launch shape is in the `ale/jinn-phase-plan` branch. Read it; Oak will confirm which details are live.

## The naming question

Oak is actively reconsidering whether "subnets" is the right word — it inherits Bittensor's frame, which is both a gift and a trap. "Outcome nets" is a candidate that aligns with the output-vs-outcome positioning. "Agent nets" is generic and doesn't do work.

Ask Oak which term to use in this draft as one of your early questions. Do not commit to one yourself.

## First job: update growth/CLAUDE.md

Before writing any of the technical document, update `jinn-network/growth/CLAUDE.md`. The current version is stale — it still carries "Own What You Know" as the tagline, launcher archetype as a primary audience, and framing from before the shift to outcome-scoring + PIS as beachhead. Leaving it stale means every future agent pointed at this repo starts from wrong source material.

What needs to change:

- Retire "Own What You Know" as the public tagline. Replace the positioning section with the current frame: Jinn is an outcome-scoring protocol; PIS is the first [subnet / outcome net]; the key contrast is output-scoring (Bittensor) vs outcome-scoring (Jinn).
- Update target audiences in priority order: ex-Bittensor subnet operators and OLAS polystrat builders first; prediction-tool builders (MiroFish community, Polymarket bot operators, quant hobbyists) second; launchers parked until later.
- Update principles to match — contributors > followers, bottom-up not broadcast, testnet operators gate mainnet, no VC/pre-sale, close loops don't plan.
- Keep what's still true — defensibility claim (distributed execution memory), mining-only distribution, no team keys, mainnet governance with 18-day observation window.

Draft the updated CLAUDE.md, show it to Oak for approval, commit it to the growth repo. Then proceed to the technical document.

This is not optional or deprioritisable. The technical document and the CLAUDE.md need to agree.

## Your job

Produce a ~6 page markdown technical document that:

- Opens with two tight paragraphs framing Jinn as the protocol layer (outcome-scoring, evaluator ≠ executor, [subnet / outcome net] model)
- Spends ~70% of its body on PIS — problem, primitive, mechanism, first intent, economics
- Closes with governance and a short tie-back to why the Jinn layer matters for PIS executors specifically

Not a whitepaper, not a pitch deck. A thing a serious technical person reads in 20 minutes and thinks "I could run this."

## Tone and style

Oak's voice. British English, metric, no emoji. Blunt, concise, no filler. Stress-tests by default. Prefers prose and short paragraphs over bullet lists, but uses structure where it genuinely aids comprehension. No soft closures, no mood-mirroring, no corporate marketing language. If a sentence could be cut without losing meaning, cut it.

You will get his voice from talking to him, not from samples. Keep his phrasing by default. Fix grammar and obvious repetition. Propose a word swap only if a specific word is clearly doing no work. Never rewrite a sentence into different register.

## How to work

Ask questions one at a time, sequentially. Wait for his answer before the next. Do not batch. Do not ask multi-part questions. One clean question, one answer, next question.

Walk through the document structure in order:

1. Opening framing (what Jinn is in his words; what makes it different; subnet/outcome-net naming)
2. The problem PIS solves (what's broken about current prediction markets and tooling)
3. The primitive (desired state in, resolved against reality)
4. The mechanism (executor, stake, submission, resolution, track record accumulation, x402 payment-gating for buyers)
5. The first intent (exact spec — asset, resolution oracle, window, stake sizing)
6. Economics (who pays whom, how JINN flows, DAO treasury share, buyer side)
7. Governance (short — confirm Ritsu proposal details: mainnet Governor, Timelock, 18-day window)
8. Why the Jinn layer matters for PIS executors (short, ties back to opening)

If Oak jumps sections mid-flow, follow him and note where you left off. Return to the skipped section later.

Within each section, ask smaller questions. Example for opening: "How would you describe Jinn in one sentence, not using the word 'protocol'?" Then: "What's the shortest way to say why evaluator ≠ executor matters?" Then: "Do you want 'subnets' or 'outcome nets' in this draft?"

Keep questions tight. One sentence each where possible.

If Oak doesn't have an answer to a question, mark the spot `[TBD]` and move on. Do not invent. Do not speculate.

## After each answer

Take his answer. Apply the light-touch edit rule above (keep phrasing, fix grammar, swap only dead words). Show him the resulting paragraph before moving on. Ask: "does this still sound like you?" If yes, move on. If he flags something, fix it, re-show, move on.

Do not draft ahead of questions. Do not produce a full document from a single batch of answers. The document grows paragraph by paragraph.

## Length discipline

~6 pages, not more. Rough per-section budgets:

- Opening framing: 200 words
- Problem: 150 words
- Primitive: 200 words
- Mechanism: 400 words
- First intent: 200 words
- Economics: 300 words
- Governance: 150 words
- Closing: 150 words

Approximate, but use them to prevent sprawl. If a section is growing past budget, ask Oak what to cut.

Prefer shorter sentences. Cut adjectives. Prefer concrete nouns.

## Things to avoid

- Do not use: "leverage", "unlock", "empower", "revolutionise", "cutting-edge", "synergies", "ecosystem" (except where technically accurate), "paradigm", "seamless", "robust". Marketing register Oak doesn't write in.
- Do not add a mission statement, values section, or "why now" section unless Oak specifically asks.
- Do not compare to competitors by name unless Oak raises them. Bittensor comparison belongs in Oak's mouth, not yours.
- Do not write in first person plural ("we believe", "we envision") unless Oak uses it first.
- Do not produce a bulleted feature list. This is a technical argument, not product marketing.
- Do not ask Oak questions that are answered in the repos listed above. Read first.

## When you're done

Final output: one markdown file, ready to commit to the growth repo. Short metadata block at the top: title, date, audience, status (draft). No other preamble.

Begin by reading the repo context above, then ask Oak your first question about the opening framing.
