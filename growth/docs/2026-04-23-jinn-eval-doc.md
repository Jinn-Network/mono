# Jinn — what it is, why now, and how to kick the tyres

**For:** technical readers who already know OLAS and have opinions about Bittensor.
**Read time:** 5 minutes.

---

## 1. The thesis

Decentralised AI networks today score **outputs**. Validators vote on whether model A's answer looked better than model B's. That works for benchmarks. It doesn't describe the real world, where the only question that matters is whether the agent can cause the thing it was asked to cause.

Jinn is a protocol for producing **verified solutions** to outcomes.

- A creator posts an **outcome** — a state of the world they want to be true.
- **Solvers** produce solutions — a plan for achieving the outcome, plus evidence from running it.
- Independent **evaluators** check the evidence.
- Solutions that repeatedly work accumulate as the network's output.

How the solution is then executed is a separate axis. In the straightforward case the creator runs it locally — Jinn doesn't need to hold keys or move money to be useful. More-delegated execution modes, where a solver or a third party runs the solution for the creator under some trust assumption, are an open design space. The protocol's job is to make the solution trustworthy; the execution mode sits downstream and can vary by service.

Evaluator ≠ solver is a structural trust rule, not a game-theoretic bond.

## 2. Why now

**Agentic work is now the dominant mode of AI consumption.** Coding agents alone are a multi-billion-dollar revenue line: Cursor crossed ~$2B ARR in February 2026 having doubled in three months, at a $50B valuation. Claude Code is at ~$2.5B ARR. Anthropic as a whole is at ~$30B ARR with roughly 80% of that coming through the API rather than the consumer chat app — i.e. into products where an agent, not a human, is the direct consumer of the tokens. Around 73% of engineering teams report using AI coding tools daily, up from 41% a year earlier. SWE-Bench Verified is past 85%, up from single digits in early 2024.

This is the market that needs a protocol for scoring whether agents produced the outcome, not whether their output looked plausible. Benchmarks don't answer "did the lending pool APY forecast actually match the realised rate." Jinn does.

**Output-scoring's centralisation critique is live.** The last fortnight's Covalent exit and Jacob Steeves multisig row on Bittensor put the "one party in the middle" problem in front of everyone. There is a real opening for a protocol whose trust assumptions don't reduce to a single safe.

## 3. Why decentralised

Fine — the agentic market is huge. Why not just build a centralised coordination layer with venture money? Three reasons. Any one of them is enough to explain the choice; all three is why it's worth doing under hard constraints.

**Economic.** We cannot out-build Anthropic, OpenAI, or Google — and we don't need to. A thin protocol that sits *under* the agentic market, coordinating fulfilment and accumulating execution memory, captures value across the whole space at low rates rather than competing for share inside any single vendor's product. The asymmetric bet: ~230 lines of bespoke Solidity, shared OLAS infrastructure, a long emissions runway. At Cursor- and Claude-Code-adjacent volumes, a fractional take on verified outcomes is a tasty return profile — and we get there at a fraction of the headcount.

**Impact.** Agentic fulfilment is civilisationally large. A protocol that decides which agents get paid for doing things in the world is not a minor piece of infrastructure — it is the rails. There is arguably no bigger thing to work on right now. If that's true, doing it in a way that can be credibly owned by the operators running it is worth the extra engineering cost versus shipping a SaaS.

**Ethos.** The centralising force in AI is already severe — three or four labs, the same handful of cloud providers, and the distribution bottleneck is narrowing further as agents become the direct consumer of tokens. Adding agentic fulfilment to the pile under the same custodians makes the concentration worse. A network whose trust assumptions don't reduce to a single safe is a counterweight. Not the only one that will exist, but one that should.

## 4. What's different

**vs Bittensor.** Bittensor's Yuma Consensus was designed in a pre-agentic, LLM-first world: validators peer-rank model *outputs* — completions, embeddings, classifications — because for most language tasks there was no ground truth to check against. Peer ranking was the only option available. Agents now act on the world with verifiable ground truth: on-chain state, oracle prices, realised APY, transaction inclusion. You can check whether the thing happened instead of voting on whether the answer looked right. Jinn is built for that regime. Output vs outcome is the whole differentiator.

**vs OLAS.** Jinn sits downstream of OLAS and uses it for distribution and coordination — the Mech Marketplace for request/delivery, the staking and activity-checker pattern for emissions. What Jinn adds on top is the loop (post → solve → evaluate), the evaluator-≠-solver constraint, and a separate DAO and token that govern which solutions the network pays for. The DAO is not married to OLAS: if a better substrate emerges, the Governor can direct emissions somewhere else. OLAS is the bootstrap, not the lock-in.

**vs "just fine-tune a model."** Every evaluated solve attempt — successful or not — produces an artifact: what was tried, what happened, what the evaluator said. Those artifacts accumulate as the network's memory of what solutions actually work for which outcomes. You can fork the code. You can't fork the execution memory.

## 5. How it works

### The loop

One loop, four roles:

- **Creators** post outcomes and fund their realisation.
- **Solvers** produce solutions — a plan for achieving the outcome, plus evidence that running the plan realised it.
- **Evaluators** check, independently of the solver, whether the evidence supports the claim.
- **Knowledge** accumulates as verified (solution, outcome) pairs — discoverable via ERC-8004, access-gated via x402.

A delivered solution is then executed. The simple case is the creator running it locally against their own systems; more-delegated execution modes are an open design space and can be adopted by specific services without changing the protocol.

### Services

A **service** is one contract plus one activity checker, specialised to a domain. Jinn is the protocol layer; services are verticals. The first service is **PIS** (Prediction Intelligence Service). Its first concrete outcome: predicting the APY of a specific lending pool over a specific window, resolved against on-chain data. A Hyperliquid-style financial-outcomes service is a candidate second. Do not collapse the protocol into any single service.

### On-chain architecture

The on-chain surface is intentionally thin. ~230 lines of bespoke Solidity across four contracts, the rest is OpenZeppelin and OLAS.

- **JINN** — ERC-20 with Permit and Votes, 1B-token cap over 10 years plus 2%/yr perpetual inflation thereafter. Canonical on Ethereum mainnet.
- **JinnDistributor** — a `claim(serviceId)` contract on the execution chain (Base) that reads OLAS staking rewards and mints JINN at a fixed 3:1 operator:DAO ratio. Every JINN in existence comes from measurable operator work.
- **JinnGovernor + TimelockController** — OpenZeppelin Governor on Ethereum mainnet: 2-day voting delay, 14-day voting period, 4% quorum, 2-day timelock. 18-day observation window from proposal to execution on every change.
- **Cross-chain admin** — canonical governance on mainnet; distributor on Base; changes propagate via a bridge (Hyperlane / LayerZero / CCIP — selection pending).

The design decisions that fall out of this:

1. **Governance lives on Ethereum mainnet from day one.** No testnet DAO that graduates to mainnet later; the Governor, Timelock, and canonical JINN all sit on mainnet from the start.
2. **ve-JINN gauge voting is deferred.** Phase 1a Governor can direct emissions directly; ve-JINN is a Phase 1b consideration, not a Phase 1a must.
3. **OLAS is not a lock-in.** The Governor can redirect emissions to a different distributor if a better substrate appears.
4. **Open parameters live in the DAO.** Anti-farming decay, challenge mechanism, distribution weightings, emission schedule beyond the initial curve — not hard-baked into contracts, the Governor sets them.
5. **Uncapped perpetual inflation (Option B).** 1B over 10 years plus 2%/yr in perpetuity. The network can outlive the initial emission schedule.

## 6. Where we are

**Phase 0 — complete.** Client daemon and on-chain contracts deployed on Base mainnet. End-to-end loop validated against an Anvil fork of Base; 33 passing client tests. No live mainnet executions yet — Phase 0 proved the contracts work and the client runs. Live traffic waits on Phase 1a testnet hardening plus enough external operators to make a mainnet launch legitimate. No external operators yet — that's the current bottleneck and part of why this document exists.

- JinnRouter: `0xfFa7118A3D820cd4E820010837D65FAfF463181B`
- Staking contract: `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54`
- Activity checker proxy: `0x477C41Cccc8bd08027e40CEF80c25918C595a24d`
- Client: TypeScript daemon, spawns Claude Code as a subprocess for solve and evaluate passes.

**Phase 1a — in design.** JINN token + distributor + Governor + Timelock + cross-chain bridge. Target: Sepolia + Base Sepolia for testing; Ethereum mainnet + Base mainnet for live launch. The contract set is the one described in Section 5; the MVL proposal is in `docs/planning/2026-04-jinn-mvl-on-olas.md`.

## 7. Legitimacy — a truly fair launch

The shape of the distribution is the whole point. We are not trying to build a second Bittensor that happens to score outcomes. We are trying to build a protocol whose trust assumptions do not reduce to a single safe, a team allocation, or a foundation's discretion.

- **No team keys. No pre-mine. No allocation. No VC round.** Every JINN ever minted — including whatever the co-founders end up with — comes from operator work, measured by the same activity checker every other operator runs against.
- **Everyone equal from the start.** Co-founders have the same access to the token as the next ten operators, who have the same access as the next thousand. There is no early-insider multiplier, no discount, no vesting cliff.
- **Mainnet launch is gated on a legitimate operator network.** We will not deploy the distributor to Base mainnet with two operators on it — that would put the whole "legitimately decentralised" narrative on the same footing as the thing we're critiquing. The launch gate is enough independent, identifiable, technically credible operators running the client on testnet. Target: ~10 before mainnet.
- **Governance on mainnet from day one.** The Governor, the Timelock, and the canonical JINN sit on Ethereum mainnet from the first proposal. 18 days of public observation on every change. No "we'll migrate governance to mainnet once we're bigger."

This is why we're talking to you before Phase 1a is deployed, not after. You being on the network at mainnet launch is part of what *makes* the launch legitimate. Ten operators at go-live are worth a thousand at month six.

## 8. The ask

You are one of perhaps ten people we think should be stewarding this early. That means:

1. **Read the specs below.** Tell us where the argument breaks.
2. **Run the client on testnet** when Phase 1a is up. You are the kind of operator the launch is gated on.
3. **Open a PR or an issue.** Any surface — protocol, client, docs.

Not an operator contract. Same token access as us, from the same mechanism: operator work. We've been two people for too long. The next ten matter more than the next thousand.

## Reading list

Monorepo: `github.com/jinn-network/mono`

| Document | Path | Covers |
|---|---|---|
| Architecture | `CLAUDE.md` | Phase status, on-chain addresses, three-layer model |
| Protocol spec | `spec/2026-03-23-jinn-protocol-spec-proposal.md` | The loop, roles, trust structure (uses older "restoration" terminology — catching up) |
| Implementation spec | `spec/2026-03-23-jinn-implementation-spec-proposal.md` | Tokenomics, incentive channels |
| Phase 1a design | `spec/2026-04-06-phase-1a-design.md` | Testnet JINN + Treasury + Dispenser |
| Activity checker | `spec/2026-03-25-activity-checker.md` | JinnRouter + OLAS integration |
| Client README | `client/README.md` | What the client does, how to run it |
