# Technical Direction

### Ventures

Ventures are the primary unit of the ecosystem. Customers come to Jinn in order to launch agentic ventures. Agent ventures are able to achieve a particular objective which is defined by the launcher. A venture is made up of a fleet of agents, each contributing their capabilities. Ventures receive a flow of capital incentives via the underlying agentic protocol. Holders of the underlying agentic protocol token are able to direct incentives to the ventures they most want to support. Venture launchers are optionally able to mint a venture-specific token, to accelerate the venture's pursuit of its objective through alignment and further capital formation.

#### Subcomponents

##### Launching

When they launch a venture, launchers create an on-chain mechanism that includes defining the venture's objective, incentivization and capital formation to spin up and sustain a fleet of agents to make continuous progress towards the venture's objective. Agents should be incentivised to participate in the on-chain marketplace – to fulfil a certain number of jobs per day. This creates an ongoing supply of agentic task execution. It should also be optionally possible to launch a venture-specific token with suitable dynamics for capital formation around that token and integration with the underlying incentives protocol to accelerate progress towards the venture's objective.

##### Supporting

It will be possible to launch many ventures via Jinn. It is therefore important that there is a mechanism baked into the underlying protocol that enables participants to prioritise certain ventures over others (i.e., they should be able to say that one venture is more important than another). Certain ventures should therefore receive more incentives to power and pay for urgent work to be done on them. This should be expressed on-chain.


#### Architecture
- Venture Registry (staking contract + Supabase): venture id, launcher, Jinn network tag, bound agent blueprint (AgentRegistry id), objective spec hash
- OLAS VoteWeighting/Gauge: veOLAS gauge weights direct emissions to the venture's staking contract
- Venture Token Fields: `token_address`, `token_symbol`, `token_name`, `staking_contract_address`, `token_launch_platform`, `token_metadata` (JSONB), `governance_address`, `pool_address`
- Optional Venture Token: venture-specific token minting via Doppler SDK on Base; multicurve auctions with OLAS as numeraire; automatic Uniswap V4 pool migration

#### Implementation

The Venture Registry is implemented directly as an Olas staking contract that doubles as the canonical registry entry for a venture. At deployment, the an Jinn network identifier is included with the staking contract – likely via the agent blueprint – and binds that single blueprint on the Olas AgentRegistry. That blueprint packages the core Jinn implementation and includes an objective specification hash that captures the venture’s overarching objective. The launch flow is straightforward: the launcher deploys the staking contract, records the blueprint id and objective hash, and the system emits a VentureCreated event. The orchestrator picks up that event and decides whether or not to participate.

Incentives are sourced from veOLAS gauge voting. veOLAS holders assign weights to the venture’s staking contract via the OLAS VoteWeighting system; emissions then follow those weights on an epoch basis. Settlement and claims follow the standard OLAS Tokenomics to Dispenser flow, preserving compatibility with OLAS accounting and cross‑chain distribution mechanics.

An optional venture token can be launched via the Doppler SDK (`@whetstone-research/doppler-sdk`) on Base. The launch flow creates a multicurve auction with OLAS as the numeraire token, allocating 90% of supply to price discovery and 10% to a Gnosis Safe treasury via vesting. Upon auction completion, liquidity migrates to a Uniswap V4 TOKEN/OLAS pool. Doppler auto-creates a governance contract holding the venture's tokens.

**Token earning model:**
1. **OLAS rewards**: Workers stake 5,000 OLAS into the shared Jinn staking contract (`0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139`), earning ~57.5 OLAS/epoch via veOLAS emissions
2. **Venture token rewards**: A parallel distribution script queries completed deliveries per workstream, calculates proportional allocation, and transfers venture tokens from the treasury to worker addresses

The shared staking contract (`AgentsFun1`) supports all ventures via a single staking instance. Sub-ventures are differentiated by `WORKSTREAM_FILTER` at the worker level, directing agents to process jobs for their selected venture.

## Actors

![Ventures Network and OLAS Integration](./documentation/assets/Ventures-network-olas.png)

Launchers originate ventures. They define the venture's objective, deploy the staking contract, and, where appropriate, introduce a venture‑specific token to accelerate alignment and capital formation. Their on‑chain actions produce the canonical surface—objective, blueprint binding, and staking configuration—that the rest of the system coordinates around.

Operators run orchestrators in production. They provision and maintain the agent's service (a Safe), stake into the venture, watch the marketplace, claim eligible work, relay tasks to the executor, and submit completions from the service address to satisfy PoAA. Deterministic transaction execution, allowlist hygiene, and uptime are core responsibilities.

Traders supply liquidity and price discovery for OLAS and any venture tokens. By moving capital and setting prices, they influence runway and incentive gradients, which in turn shape where operators allocate attention and compute.

Voters are veOLAS holders who direct emissions via gauge weights. By allocating weight to specific staking contracts, they determine how incentives are routed across ventures over time, rewarding those that demonstrate verifiable on‑chain progress.
                
## Integrations
Olas Protocol is the system’s coordination substrate. The integration covers the marketplace (job requests, claims, and completions verified against the agent’s service address), the ServiceRegistry (agent identity), and PoAA liveness for accountability. Emissions are routed by veOLAS gauge voting to the venture’s staking contract, tying long‑term incentives to observed execution.

Transaction Rails provide deterministic, replay‑safe submission from the orchestrator using the agent’s service address. Mission‑critical interactions run through a Gnosis Safe, while narrowly scoped fast paths may use an EOA where explicitly allowlisted. All interactions are constrained by chain‑aware function allowlists and pre‑flighted via simulation (e.g., Tenderly Virtual Testnets) for gas, revert, and policy checks before broadcast.

The Task Executor is an open‑source ReAct agent (via the Gemini CLI) that plans and acts through tools rather than raw network access. It produces structured job outputs and unsigned transaction intents; the orchestrator validates and submits those intents on‑chain, preserving a clean separation between reasoning and authority.

Model Context Protocol (MCP) provides the context and tool interface. A local server exposes a minimal, audited tool surface per job, binding capabilities to explicit schemas and allowlists. Sessions are short‑lived, scoped to a single job, and instrumented for observability without expanding the agent’s authority.

Capital formation integrates Doppler to bootstrap and scale venture‑specific tokens. The Doppler SDK enables programmatic multicurve auctions on Base, with OLAS as the numeraire token for direct protocol alignment. Liquidity migrates to Uniswap V4 pools upon auction completion. This complements veOLAS‑driven emissions, enabling sophisticated alignment and runway for ventures that demonstrate sustained, verifiable progress.
