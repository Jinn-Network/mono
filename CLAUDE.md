# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jinn Network monorepo. Phase 0 is complete (Base mainnet). Phase 1a (JINN token + DAO + distribution on testnet) is deployed and proven on Sepolia/Base Sepolia. Phase 1b (protocol hardening on testnet) is in progress — see `spec/2026-04-06-phase-1a-design.md` and `docs/superpowers/plans/2026-04-06-phase-1a-tokenomics.md`.

Jinn is a training protocol for agentic intents. It defines a loop (Creation → Execution → Evaluation → Knowledge) where intents are published with fees, participants attempt fulfillment, evaluators verify results, and knowledge accumulates to improve future attempts.

## Canonical Docs

Canonical docs are the repo's stable sources of truth. They change only via approved PRs (see `spec/2026-04-28-canonical-docs.md`). Always prefer canonical docs over restated information found elsewhere in the repo, and never redefine canonical content locally — link instead.

- `SPEC.md` — read before reasoning about the protocol loop, roles, contracts, or phase boundaries
- `THESIS.md` — read before writing positioning, pitch, strategic copy, or any "why Jinn" framing
- `BRAND.md` — read before producing any user-facing artifact (UI, slides, docs, marketing copy)
- `GROWTH.md` — read before planning distribution, campaigns, channel strategy, or growth experiments
- `GLOSSARY.md` — read whenever a Jinn-specific term appears; never redefine terms locally

## Repository Structure

```
jinn-cli-agents/ Git subtree — historical Jinn agent repo (IMPORTANT: see below)

client/          TypeScript daemon — the main runnable component
  src/
    main.ts              Production entry point (yarn start)
    config.ts            Config loader (file > env > defaults)
    index.ts             Library exports
    adapters/
      adapter.ts         ExecutionAdapter interface
      local/adapter.ts   In-memory adapter for testing
      mech/              OLAS Mech Marketplace + JinnRouter adapter
        adapter.ts       MechAdapter (production adapter)
        contracts.ts     Contract call helpers (submitRestorationJob, claimDelivery, etc.)
        types.ts         ABIs, config types, JINN_ROUTER_ABI
        claim-policy.ts  Request claim strategies
        ipfs.ts          IPFS upload/download via Autonolas gateway
        safe.ts          Safe wallet creation + viem clients
    daemon/
      daemon.ts          Orchestrates creator, engine-watcher, delivery-watcher loops
      creator.ts         Posts desired states via adapter
      delivery-watcher.ts  Claims deliveries, creates evaluation jobs
    runner/
      runner.ts          Runner interface
      claude.ts          Spawns Claude CLI via MCP for restoration/evaluation
      simple.ts          Callback-based runner for testing
    earning/
      bootstrap.ts       11-step state machine (wallet → Safe → staking → mech)
      contracts.ts       Chain config, ABIs, Base addresses
      safe-adapter.ts    Safe deployment + batch tx execution
      store.ts           Earning state persistence (~/.jinn-client/earning/)
      types.ts           EarningState Zod schema
    store/store.ts       SQLite persistence (activity, artifacts, recovery)
    api/
      server.ts          Hono HTTP API for artifact search/publish
      peers.ts           Background peer sync
    auth/erc8128.ts      ERC-8128 HTTP message signatures
    discovery/
      registry.ts        ERC-8004 on-chain artifact registration
      subgraph.ts        The Graph subgraph queries
    mcp/server.ts        MCP tools exposed to Claude subprocess
    x402/                Payment-gated artifact access
    types/               DesiredState, errors, core types
  scripts/
    e2e-validate.ts      Self-contained e2e test on Anvil fork
    staking-validate.ts  Earning bootstrap validation
    mock-agent.ts        Mock agent for testing (replaces Claude)
  fixtures/
    config.example.json  Example config file
    local-config.json    Local adapter test config
  test/                  Vitest tests (see docs/runbooks/testing.md)

contracts/       Solidity smart contracts (Hardhat)
  src/
    claiming/
      ClaimRegistry.sol        On-chain claim coordination
      AcceptAllChecker.sol     Phase 0 eligibility (accept all)
      IEligibilityChecker.sol  Checker interface
    staking/
      RestorationActivityChecker.sol  OLAS activity checker
  test/                        Hardhat tests
  scripts/                     Deployment scripts

spec/            Dated specification proposals
docs/            Design specs and implementation plans
```

## jinn-cli-agents Reference

**Always check `jinn-cli-agents/` when working on OLAS integration, staking, tokenomics, or Phase 1 contracts.** This subtree (from github.com/oaksprout/jinn-gemini) contains a wealth of relevant context:

- `contracts/staking/` — JinnRouter.sol (the deployed router), DeliveryActivityChecker, WhitelistedRequesterActivityChecker, deployment JSONs with all on-chain addresses
- `docs/context/olas-protocol.md` — Full OLAS architecture: governance (veOLAS, Governor, Timelock), registries, tokenomics (Treasury, Dispenser, Depository, Tokenomics epochs)
- `docs/context/olas-integration.md` — Wallet/key storage, service lifecycle, operating modes
- `docs/reference/jinn-staking.md` — All deployed staking contracts (V1-V3), parameters, reward economics, veOLAS lock strategy, nominee mechanics
- `docs/reference/olas-contracts.md` — Base mainnet contract addresses, MechMarketplace ABI
- `docs/reference/blood-written-rules.md` — Hard-won operational lessons (RPC limits, IPFS, polling, etc.)
- `docs/runbooks/` — Setup, deployment, recovery, troubleshooting guides
- `CLAUDE.md` — System architecture overview for the agent orchestration layer

## Running the Client

### Prerequisites

- Node.js 22 (`corepack enable` once so Yarn matches each package’s `packageManager` field)
- Foundry (`anvil` for local fork, `cast` for funding)
- Claude Code CLI (`claude` in PATH — the daemon spawns it as a subprocess)

### Quick validation (Anvil fork, no real funds)

```bash
cd client
yarn install
yarn typecheck   # should be zero errors
yarn test        # vitest suite, all pass
yarn e2e         # full loop on Anvil fork of Base
```

The e2e script spawns Anvil, bootstraps from scratch, runs create → restore → evaluate, and verifies staking rewards. Needs internet (Base RPC + IPFS).

### Production run

```bash
cd client
JINN_PASSWORD=your-keystore-password yarn start
```

Or with a config file:

```bash
JINN_PASSWORD=secret yarn start -- --config ./my-config.json
```

The daemon will:
1. Run the earning bootstrap (wallet → Safe → service → staking → mech)
2. Pause at `awaiting_funding` if the wallet needs ETH/OLAS — fund and re-run
3. Start the daemon with 3 loops (creator, restorer, delivery-watcher)

### Running against Anvil fork (local dev)

```bash
# Terminal 1: start Anvil
anvil --fork-url https://mainnet.base.org --port 8545

# Terminal 2: create config and run
mkdir -p ~/.jinn-client
cat > ~/.jinn-client/config.json << 'EOF'
{
  "rpcUrl": "http://127.0.0.1:8545",
  "claudeModel": "claude-haiku-4-5-20251001",
  "desiredStates": [
    { "id": "test-1", "description": "The service is healthy and responding." }
  ]
}
EOF

JINN_PASSWORD=test yarn start
# Will pause at awaiting_funding — fund via cast, then re-run
```

Funding on Anvil (use pre-funded account):
```bash
# Fund EOA with ETH
cast send <EOA_ADDRESS> --value 0.01ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545

# Fund Safe with OLAS (impersonate a whale)
cast rpc anvil_impersonateAccount <OLAS_WHALE> --rpc-url http://127.0.0.1:8545
cast send 0x54330d28ca3357F294334BDC454a032e7f353416 \
  "transfer(address,uint256)" <SAFE_ADDRESS> 5000000000000000000000 \
  --from <OLAS_WHALE> --rpc-url http://127.0.0.1:8545 --unlocked
```

## Config

Config file first, env var override. File at `~/.jinn-client/config.json` or `--config <path>`.

| Config key       | Env override             | Default                           |
|------------------|--------------------------|-----------------------------------|
| rpcUrl           | BASE_RPC_URL/JINN_RPC_URL| https://mainnet.base.org          |
| claudeModel      | JINN_CLAUDE_MODEL        | claude-haiku-4-5-20251001         |
| claudePath       | JINN_CLAUDE_PATH         | claude                            |
| pollIntervalMs   | JINN_POLL_INTERVAL_MS    | 5000                              |
| apiPort          | JINN_API_PORT            | 7331                              |
| dbPath           | JINN_DB_PATH             | ~/.jinn-client/jinn.db            |
| earningDir       | JINN_EARNING_DIR         | ~/.jinn-client/earning            |
| peers            | JINN_PEERS               | []                                |
| subgraphUrl      | JINN_SUBGRAPH_URL        | (none)                            |
| desiredStates    | JINN_DESIRED_STATES      | [health-check]                    |
| ipfsRegistryUrl  | JINN_IPFS_REGISTRY_URL   | https://registry.autonolas.tech   |
| ipfsGatewayUrl   | JINN_IPFS_GATEWAY_URL    | https://gateway.autonolas.tech    |
| engine.workingDirRoot | JINN_ENGINE_WORKING_DIR_ROOT | ~/.jinn-client/engine/work   |
| engine.implStateDirRoot | JINN_ENGINE_IMPL_STATE_DIR_ROOT | ~/.jinn-client/engine/impl-state |

`JINN_PASSWORD` is env-only — never in config files.

## On-Chain Addresses (Base)

| Component              | Address                                      |
|------------------------|----------------------------------------------|
| JinnRouter             | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` |
| Activity checker proxy | `0x477C41Cccc8bd08027e40CEF80c25918C595a24d` |
| Mech marketplace       | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| Staking contract       | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` |
| OLAS token             | `0x54330d28ca3357F294334BDC454a032e7f353416` |

## Architecture

Three layers, top to bottom:

1. **DAO Layer (Ethereum Mainnet)** — JINN ERC-20 token, treasury with epoch emissions, ve-JINN gauge for directing emissions to distribution contracts (Phase 1+)
2. **Distribution Contracts (per-chain)** — Four incentive channels (creation, restoration, outcome, evaluation rewards), distribute JINN to qualifying participants (Phase 1+)
3. **Execution Layer (Base)** — OLAS Mech Marketplace (request/delivery), JinnRouter (loop enforcement + activity tracking), ERC-8004 (knowledge discovery), x402 (payment-gated knowledge access)

### How the daemon works

The daemon runs three concurrent loops:

1. **CreatorLoop** — posts each desired state once via `JinnRouter.createRestorationJob()`
2. **Engine watcher + `RestorationEngine`** — consumes `adapter.watchForRequests()`, drives the restorer state machine (claim → run via registered `RestorerImpl` → package → `mech.deliverToMarketplace()` + `JinnRouter.claimDelivery()`)
3. **DeliveryWatcherLoop** — watches for deliveries, calls `JinnRouter.claimDelivery()`, then creates evaluation jobs via `JinnRouter.createEvaluationJob()`

Each JinnRouter call increments activity counters for the Safe multisig. The OLAS staking contract reads these counters at checkpoints to determine reward eligibility.

### Earning bootstrap

The `EarningBootstrapper` walks through 11 idempotent steps:
1. wallet — create agent EOA + encrypted keystore
2. safe_predicted — predict Safe address
3. awaiting_funding — gate until EOA has ETH + Safe has OLAS
4. safe_deployed — deploy Safe via factory
5. service_created — register service on-chain
6. service_activated — approve OLAS bond + activate
7. agents_registered — register agent in service
8. service_deployed — deploy service
9. service_staked — stake service in staking contract
10. mech_deployed — deploy mech via marketplace
11. complete

State persists to `~/.jinn-client/earning/earning_state.json`. Safe to interrupt and re-run.

## Key Roles

- **Creator** — defines desired states and funds restoration
- **Restorer** — attempts to make desired states true
- **Evaluator** — independently verifies restoration success

## Phased Rollout

- **Phase 0** (complete): Prove on OLAS ecosystem, single chain (Base), OLAS Mech Marketplace + JinnRouter, optimistic evidence, no JINN token
- **Phase 1a** (complete): Fork OLAS contracts with minimal changes, deploy JINN token + Treasury + distribution on Sepolia/Base Sepolia, multisig governance, testnet iteration
- **Phase 1b** (in progress): Protocol hardening on testnet — anti-farming decay, challenge mechanism, ve-JINN gauge voting, evidence schema, full client integration, extended testnet operation
- **Phase 2**: Mainnet launch — fair-launch JINN, multi-chain (Base, Arbitrum), ZK-requiring distribution contracts
- **Phase 3**: Autonomous — full ve-JINN governance, USDC revenue exceeds JINN emissions

## Testing

See [`docs/runbooks/testing.md`](docs/runbooks/testing.md) for the test SOP: pyramid,
where tests go, the mock policy, shared helpers. Design rationale lives in
[`docs/superpowers/specs/2026-04-24-test-architecture-design.md`](docs/superpowers/specs/2026-04-24-test-architecture-design.md).

## Development Commands

```bash
# Client
cd client
yarn install         # install deps (CI: yarn install --immutable)
yarn build           # tsc compile
yarn test            # vitest run
yarn e2e             # end-to-end on Anvil fork
yarn staking         # earning bootstrap validation on Anvil
yarn start           # production daemon (requires JINN_PASSWORD)

# Contracts
cd contracts
yarn install
yarn test            # Hardhat tests
```

## Adding intent kinds

To add a new **in-repo** `spec.kind` (typed spec, `jinn submit-intent --spec-file`, optional auto-generators, and restorer/evaluator pairing), follow [`docs/runbooks/add-intent-kind.md`](docs/runbooks/add-intent-kind.md). Kind parsing dispatches through `client/src/intents/kinds/index.ts` (`SPEC_KINDS`); testnet auto-posting is wired via `getTestnetAutoConfig` + `collectTestnetAutoIntentGenerators` in the same module. Restorer selection is separate — see `client/src/cli/intent-registry-access.ts` and `client/src/restorer/impls/index.ts` (`buildRestorerImpls`).

## Spec Conventions

Spec files are named `YYYY-MM-DD-<topic>.md` and placed in `spec/`. Each has a version, date, and author in the header.

## Design System

Voice and posture are canonical in [`BRAND.md`](BRAND.md) — read it before any user-facing artifact. The visual sidecar (tokens, spec) is below; folding it into `BRAND.md` is a separate spec.

**Root-level quick reference** (for `impeccable` and other skill consumers):
- [`BRAND.md`](BRAND.md) — voice, headless-brand posture, protocol-vs-narrative split, content non-negotiables. Canonical.
- [`DESIGN.md`](DESIGN.md) — visual spec in [Google Stitch format](https://stitch.withgoogle.com/docs/design-md/format/): YAML frontmatter with colours, typography, radii, spacing, and component tokens; six-section prose body (Overview, Colors, Typography, Elevation, Components, Do's and Don'ts).
- [`DESIGN.json`](DESIGN.json) — sidecar extending the frontmatter with tonal ramps, canonical OKLCH, shadow/motion/breakpoint tokens, and drop-in component HTML/CSS.

These three files are the root-level precipitate of `docs/design/jinn-design-system/`. If you're writing marketing copy, docs, slides, or product UI, start with `BRAND.md` (voice + posture) and `DESIGN.md` (visual). If you're extending the brand itself (new sigil, new palette variant, new surface treatment), continue to the long-form source below.

---

Jinn's design system lives at [`docs/design/jinn-design-system/`](docs/design/jinn-design-system/). **Read it before building any UI, slide, mock, docs page, marketing surface, or other user-facing artifact** — it's the source of truth for colors, type, voice, iconography, and surface rules.

Entry points, in order:
- [`BRAND.md`](BRAND.md) — voice and headless-brand posture (grounded in Other Internet's [*Headless Brands*](https://otherinter.net/research/headless-brands/)); which parts are protocol vs. narrative. Canonical.
- [`docs/design/jinn-design-system/project/README.md`](docs/design/jinn-design-system/project/README.md) — brand posture, voice/lexicon, visual foundations (colors, type, spacing, borders, shadows, radii, motion, layout), iconography
- [`docs/design/jinn-design-system/project/SKILL.md`](docs/design/jinn-design-system/project/SKILL.md) — short operational manifest and non-negotiables
- [`docs/design/jinn-design-system/project/colors_and_type.css`](docs/design/jinn-design-system/project/colors_and_type.css) + [`foundations.css`](docs/design/jinn-design-system/project/foundations.css) — copy these into any new HTML artifact; treat the CSS variables as the canonical tokens
- [`docs/design/jinn-design-system/project/assets/`](docs/design/jinn-design-system/project/assets/) — sigils and wordmark SVGs; reuse, don't redraw
- [`docs/design/jinn-design-system/project/preview/`](docs/design/jinn-design-system/project/preview/) — reference cards for every token (colors, type, buttons, chips, cards, shadows, textures, sigils, voice)
- [`docs/design/jinn-design-system/project/ui_kits/explorer/`](docs/design/jinn-design-system/project/ui_kits/explorer/) and [`slides/`](docs/design/jinn-design-system/project/slides/) — reference implementations; match visual output, not internal structure
- [`docs/design/jinn-design-system/chats/chat1.md`](docs/design/jinn-design-system/chats/chat1.md) — design chat transcript where decisions (blue+gold palette, softened-brutalism radii, rederived semantic colors) were made

**Non-negotiables** (from `SKILL.md`, with one correction):
- Never use emoji in product, marketing, or docs.
- Never use gradients as decoration (protection gradients over imagery are the only exception).
- Never invent new vow-language (`summon / bind / vow / vessel / wish / smoke / seer / wane`) without marking it as a proposal.
- Drop the metaphor and speak plainly whenever money, safety, or legal consent is on the line.
- **Corners are softened-brutalist, not square.** `SKILL.md` still says "never rounded"; the README supersedes it — use `--radius-1` (4px chips/inputs), `--radius-2` (6px default for buttons, small cards), `--radius-3` (10px panels/large cards), `--radius-pill` for status chips only.

### Brand posture — "headless" in the Other Internet sense

Jinn's brand is **headless** in the specific sense defined by Other Internet's [*Headless Brands*](https://otherinter.net/research/headless-brands/) (read it before doing brand work). That means:

1. **No central brand authority.** No one owns Jinn's narrative. The design system is a Schelling point for coordination, not a corporate style guide. Participants — creators, vessels, seers, BD, node operators — are expected to fork, remix, and re-skin.
2. **Immutable protocol foundations.** The parts that *don't* move are the protocol-level commitments: the loop (Creation → Execution → Evaluation → Knowledge), the lexicon (*summon, bind, vow, vessel, wish, smoke, seer, wane*), the content non-negotiables (no emoji, plain speech on money/safety/legal). These are the "21M supply + proof-of-work" of the brand — fixed so narratives can layer on top.
3. **Narratives layer on top.** Palette, typography, sigils, surface treatment — all of it is narrative, and narrative is allowed (expected) to fork per surface, operator, product, or community. Multiple visual dialects of Jinn can coexist on the same protocol.
4. **Brand lives in participants' minds.** Consistency emerges from convergent narratives on shared protocol primitives, not from enforcement. A node operator's dashboard and a creator's pitch deck can look nothing alike and both still be Jinn — as long as they share the words and the loop.
5. **User-stakeholders are brand workers.** Anyone with a stake in the network (tokens, reputation, deployed vessels) has standing to propose brand direction. Contribution to the brand is a first-class form of participation, not marketing overhead.

**Operational rule, restated:** **keep the words, loosen the visuals.** The lexicon and non-negotiables are the protocol; everything else is narrative. If you're about to invent new vow-language, that's a protocol change — mark it as a proposal. If you're about to change a color or swap a sigil, that's a narrative move — just document what you changed.

The received design bundle (palette, sigils, type pairing) is one narrative — a well-reasoned starting point, not the canonical Jinn. Treat it as such.
