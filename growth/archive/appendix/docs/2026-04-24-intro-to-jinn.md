# Intro to Jinn Network

## What Jinn is

**Decentralised mining of outcome solutions.**

An outcome is an expression of a desired state — *"lending pool X averages Y–Z APY between blocks A and B"*, *"this contract compiles and its tests pass"*. Today these get solved locally and the record of what worked gets discarded. Jinn pools requests from any marketplace, dispatches them to a solver network, verifies results via independent evaluators, pays the producers, and keeps what worked. Polystrat proved the demand; Jinn adds the compounding memory layer beneath it.

## How it works

Three mechanisms.

**Flywheel.** Creators post outcomes (funded). Solvers deliver solutions — a plan plus evidence. Independent evaluators check the evidence against ground truth; evaluator ≠ solver is a structural trust rule. Every loop emits a verified **(outcome, trajectory, score)** triplet as an ERC-8004 artifact. You can fork the code. You can't fork the execution memory.

**Training via DAO incentives.** JINN holders direct emissions. Point JINN at a SolverNet and you raise the reward rate for solvers on that outcome type. Holders train the outcomes they care about.

**Marketplace-agnostic ingress.** Requests can reach Jinn from anywhere — ERC-8183, OLAS Mech, MPP, whatever comes next. No single front door.

## First vertical: Prediction SolverNet

A SolverNet is one contract plus one activity checker, specialised to a domain. First outcome: *"The APY of lending pool X on Base averages between Y and Z between block A and block B."* Resolved on-chain.

Run it a thousand times across a thousand pools and windows and the network has a map of which solvers produce calibrated predictions for which pool types at which horizons. Creators query the knowledge base instead of trusting a reputation score. Good solvers get discovered. Bluffers get priced out. A new SolverNet is one contract plus an activity checker — not a fork.

## Why now

Agentic work is the dominant mode of AI consumption. Anthropic ~$30B ARR with ~80% through the API — agents, not humans, consume the tokens. Cursor ~$2B ARR, doubled in three months. This market needs a protocol for scoring whether agents produced the outcome, not whether their output looked plausible. Benchmarks don't answer that. Jinn does.

The centralisation critique is also live — the Covalent exit and the Jacob Steeves multisig row on Bittensor put the "one party in the middle" problem in front of everyone.

## Why decentralised

**Economic.** We can't out-build Anthropic, OpenAI, or Google — and we don't need to. A thin protocol under the agentic market captures value across the whole space at low rates, rather than competing inside any vendor's product.

**Impact.** A protocol deciding which agents get paid for doing things in the world is rails, not minor infrastructure. Worth doing in a way that can be credibly owned by the operators running it.

**Ethos.** AI's concentration is already severe and narrowing — three or four labs, a handful of clouds, agents becoming the direct consumer of tokens. A network whose trust doesn't reduce to a single safe is a counterweight.

## On-chain surface

~230 lines of bespoke Solidity across four contracts; the rest is OpenZeppelin and OLAS.

- **JINN** — ERC-20 with Permit and Votes. 1B over 10 years, then 2%/yr perpetual. Canonical on Ethereum mainnet.
- **JinnDistributor** — `claim(serviceId)` on Base. Mints JINN at 3:1 operator:DAO from OLAS staking rewards.
- **JinnGovernor + TimelockController** — OZ Governor on mainnet. 18 days of public observation on every change.
- **Cross-chain admin** — governance on mainnet, distributor on Base, bridge between.

Live on Sepolia + Base Sepolia today. Addresses in `contracts/deployment-phase1a-*.json` and `deployment-phase1b-*.json`.

## Fair launch

The distribution shape is the whole point.

- **No pre-mine, no allocation, no team keys, no VC round.** Every JINN comes from operator work, measured by the same activity checker every operator runs against.
- **Everyone equal.** Same token access for early stewards, the next ten operators, the next thousand. No multiplier, no discount, no vesting cliff.
- **Governance on Ethereum mainnet from day one of mainnet.** No migration later.
- **Mainnet gated on ~10 operators** running the client on testnet.

## Where we are

Functioning testnet on Sepolia + Base Sepolia. Loop — create → solve → evaluate → claim — runs end-to-end against the Prediction SolverNet. Client is TypeScript, spawns Claude Code for solve and evaluate. `github.com/jinn-network/mono`.

Bottleneck isn't code. It's the operator set.

## The ask

Any one is enough.

1. **Run the client on testnet.** You're the kind of operator the mainnet launch is gated on. https://github.com/Jinn-Network/mono#i-want-to-run-a-daemon-on-testnet
2. **Read the specs. Tell us where the argument breaks.**
3. **Tell us who else should be in the first ten.** Independent, identifiable, technically credible.

---

Decentralised agentic AI has felt close for a while. The base layers — agent runtimes that can do things, on-chain ground truth to check them against, a viable staking substrate — are good enough to build the coordination layer in the open, from the start.

— Oak & Ritsu
