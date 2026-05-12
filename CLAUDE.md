# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jinn Network monorepo. Phase 0 is complete (Base mainnet). Phase 1a (JINN token + DAO + distribution on testnet) is deployed and proven on Sepolia/Base Sepolia. Forward roadmap is the **Phase A umbrella** under the knowledge-market substrate framing — see `spec/2026-04-30-phase-a-umbrella.md`, `docs/superpowers/plans/2026-04-30-phase-a-umbrella-plan.md`, `log/decisions/2026-04-30-knowledge-market-vision-framing.md` (DR-2026-04-30), and GitHub Discussions [#59](https://github.com/Jinn-Network/mono/discussions/59) (substrate vision) + [#57](https://github.com/Jinn-Network/mono/discussions/57) (paired GTM). The original Phase 1b roadmap (`spec/2026-04-06-phase-1a-design.md` §9, `docs/superpowers/plans/2026-04-06-phase-1a-tokenomics.md`) is subsumed: anti-farming decay and ve-JINN are shipped, evidence-schema work executes through Phase A.1, the residual challenge mechanism is re-homed to Phase B.2.

Jinn is a training protocol for agentic intents. It defines a loop (Creation → Execution → Evaluation → Knowledge) where intents are published with fees, participants attempt fulfillment, evaluators verify results, and knowledge accumulates to improve future attempts.

## Canonical Docs

Canonical docs are the repo's stable sources of truth. They change only via approved PRs (see `spec/2026-04-28-canonical-docs.md`). Always prefer canonical docs over restated information found elsewhere in the repo, and never redefine canonical content locally — link instead.

- `SPEC.md` — read before reasoning about the protocol loop, roles, contracts, or phase boundaries
- `THESIS.md` — read before writing positioning, pitch, strategic copy, or any "why Jinn" framing
- `BRAND.md` — read before producing any user-facing artifact (UI, slides, docs, marketing copy)
- `GROWTH.md` — read before planning distribution, campaigns, channel strategy, or growth experiments
- `GLOSSARY.md` — read whenever a Jinn-specific term appears; never redefine terms locally

## Engineering handbook

How this team ships — cadence, dist-tags, work-shape taxonomy, AI workflow rules. Full text at [`docs/engineering/handbook.md`](docs/engineering/handbook.md). Always read the handbook before doing non-trivial work; it ratifies the SOPs that apply to every shape.

### Work shape (declare it before executing)

Seven shapes plus one emergency sub-flow, keyed to Conventional Commits prefixes. Declare the shape in the bd issue's `Run-mode` field; replicate it as the PR title prefix.

- **`fix`** — bug fix. Regression test first. Skill chain: `systematic-debugging` → `executing-plans` → `verification-before-completion` → `receiving-code-review`.
- **`feat`** — feature. TDD. Skill chain: (`brainstorming` if ambiguous) → `writing-plans` → `test-driven-development` → `executing-plans` / `dispatching-parallel-agents` → `verification-before-completion` → `receiving-code-review`.
- **`refactor`** — architecture / migration. TDD + integration tests; required design upfront; stacked PRs required (strangler-fig).
- **`spike`** — research / exploration. Output is a finding, not code. Spike code does not merge.
- **`chore`** — deps, CI, dev tooling. Integration tests if touches a dep.
- **`docs`** — documentation. Canonical-doc changes need Discussion + CODEOWNERS approval.
- **`test`** — test-only. Meta test discipline.
- **`fix(incident)`** — hotfix sub-flow. Relaxed review; post-hoc regression test required as a follow-up bead before closing the incident.

If a bd issue does not fit one of these shapes, it is mis-scoped — split or reshape it. Per-shape SOPs (v0 flows) live in the handbook §The shapes of work; they evolve via iterative refinement (file a bd under `jinn-mono-2cl` when friction surfaces).

### Eight ratified AI workflow rules

1. **Worktree-for-multi-agent.** Multi-agent or speculative subagent work uses `git worktree add cargo/.tasks/<id>`.
2. **Beads frame problems, not solutions.** bd body = context + impact + acceptance criteria. Solutions go in design sessions.
3. **bd-as-SoR, not `MEMORY.md`.** Use `bd remember` / `bd memories`.
4. **Agent PR review parity.** Codex / Opus / Sonnet / Claude PRs reviewed like human PRs. No agent self-merge. Exception: `fix(incident)` with reviewer justification.
5. _(Deferred — supervised-diff for the self-modifying learner. Mechanism open; see `jinn-mono-8qbc`.)_
6. **Integration tests > mocks for migration / contract surfaces.**
7. **TDD for new features, regression test for fixes.**
8. **Auto-canary on main merge; Monday-only named minor.** Cadence policy.
9. **`canary` for rolling patches, `latest` for Monday named.** Dist-tag policy.

### Cadence

- Every merge to main → npm `canary` (`<v>-canary.<sha>`).
- Every Monday 09:00 UTC → GitHub Release draft (Hermes-style); Captain publishes; publish triggers npm `latest` + CHANGELOG auto-mirror.
- Pre-v1: weekly minor (`v0.N.0 → v0.N+1.0`). `v1.0.0` = the Monday cut that ships `jinn-mono-uy6v`. Post-v1 epic close = major bump.

### Daily entry point

`eng-day` skill (in `cargo/.claude/skills/eng-day/`) is the canonical daily brief. Fallback when the GitHub Project board doesn't exist yet: `bd ready` + `gh pr list --search 'is:open draft:false'`.

## Repository Structure

```
jinn-cli-agents/ Git subtree — historical Jinn agent repo (IMPORTANT: see below)

client/          TypeScript daemon — the main runnable component
  src/
    main.ts              Production entry point (`jinn run` from the published package)
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
    discovery/           Read-side data access (spec/2026-05-11-discovery-api-and-shared-indexer.md)
      types.ts           DiscoveryAPI interface + result shapes
      http.ts            HttpDiscoveryAPI — GraphQL against the Ponder indexer (default)
      onchain.ts         OnchainDiscoveryAPI — RPC getLogs/multicall floor (always live)
      with-fallback.ts   Health-tracking wrapper: primary → floor on failure
      factory.ts         Builds the configured DiscoveryAPI from config
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

### How the daemon is meant to be launched

`jinn-client` is published as `@jinn-network/client`. The intended operator
flow is:

1. `npm install -g @jinn-network/client@latest` (or `yarn global add …`).
2. `jinn run` — the binary in the published package executes the compiled
   `dist/` tree, which ships the operator dashboard SPA next to the daemon.

The CLI auto-generates a keystore password on first run and reads it from
`~/.jinn-client/keystore-password` thereafter; set `JINN_PASSWORD` only if
you need to manage the password yourself (CI, secrets manager).

```bash
jinn run                                   # default config at ~/.jinn-client/config.json
jinn run --config ./my-config.json         # alternate config file
JINN_PASSWORD=your-secret jinn run         # supply password via env (no on-disk file)
```

The daemon will:
1. Run the earning bootstrap (wallet → Safe → service → staking → mech)
2. Pause at `awaiting_funding` if the wallet needs ETH/OLAS — fund and re-run
3. Start the daemon with 3 loops (creator, restorer, delivery-watcher)

### Repo contributors only

When iterating inside this repo, run the *built* binary so you get the same
dashboard the published package serves:

```bash
cd client
yarn build           # compiles tsc + bundles SPA into dist/dashboard
node dist/bin/jinn.js run
```

`yarn jinn run` (tsx + src) works for daemon-side iteration but only renders
the SPA after at least one `yarn build:spa` — the dev path resolves the
dashboard from `src/dashboard/spa/dist/` once that directory exists. If you
have no SPA bundle on disk the daemon serves a clear "dashboard bundle
missing" page instead of silently falling back to anything stale.

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
  "tasks": [
    {
      "id": "test-1",
      "description": "The service is healthy and responding.",
      "solverType": "prediction.v0",
      "role": "restoration",
      "spec": {}
    }
  ]
}
EOF

JINN_PASSWORD=test jinn run
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
| tasks            | JINN_TASKS               | []                                |
| discovery.mode   | JINN_DISCOVERY_MODE      | mainnet: unset → `onchain` RPC floor; testnet: `http` |
| discovery.url    | JINN_DISCOVERY_URL       | testnet only: `DEFAULT_TESTNET_DISCOVERY_URL` (Ponder indexer); mainnet: unset |
| discovery.fallbackToOnchain | JINN_DISCOVERY_FALLBACK | true (only relevant when mode is `http`/`embedded`) |
| ipfsRegistryUrl  | JINN_IPFS_REGISTRY_URL   | https://registry.autonolas.tech   |
| ipfsGatewayUrl   | JINN_IPFS_GATEWAY_URL    | https://gateway.autonolas.tech    |
| engine.workingDirRoot | JINN_ENGINE_WORKING_DIR_ROOT | ~/.jinn-client/engine/work   |
| engine.implStateDirRoot | JINN_ENGINE_IMPL_STATE_DIR_ROOT | ~/.jinn-client/engine/impl-state |

`JINN_PASSWORD` is env-only — never in config files.

Discovery defaults differ by network: mainnet ships with no `discovery` block and runs against the always-live on-chain RPC floor (`mode: 'onchain'`); testnet defaults to `mode: 'http'` against the privately-operated Ponder indexer at `DEFAULT_TESTNET_DISCOVERY_URL` (see `client/src/config.ts`) with `fallbackToOnchain: true`. Set `discovery.mode: 'onchain'` (or `JINN_DISCOVERY_MODE=onchain`) to pin the RPC-only floor anywhere.

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

See [`client/ARCHITECTURE.md`](client/ARCHITECTURE.md) for the integrating narrative — operator app, CLI, daemon loops, task lifecycle, and extension points. The current daemon shape is eight long-running loops (creator, engine-watcher, engine-tick, delivery-watcher, reward-claim, balance-topup, jinn-claim L1↔L2, peer-sync) plus one-shot in-flight recovery on startup. Each loop's tx calls increment on-chain activity counters that the OLAS staking contract reads at checkpoints to determine reward eligibility.

Generators are **launched-record-driven**, not config-flag-driven (per `spec/2026-05-05-solvernet-creation-and-launch.md` §11). On startup the daemon walks `~/.jinn-client/solvernets/launched/` for records this operator owns; for each record where `status === 'launched'` and `generatorEnabled === true`, it spawns the matching SolverType-specific generator. The legacy `taskGenerator.enabled` config flag and the predecessor Launcher mode's `roles.includes('launching')` gate are gone — gating is "do I have a launched record where I'm the owner." Joining a SolverNet as an operator (writing a `joinedSolverNets[<manifestCid>]` config entry, see §12) never starts a generator; that's launcher-only.

Operator participation is keyed by `manifestCid`, not by SolverNet name. The operator's local config has the shape `joinedSolverNets[<manifestCid>] = { name, manifestCid, roles, harness, plugins, model }` — one entry per launched SolverNet the operator has joined. Edits to this shape are restart-required; the daemon does not hot-reload SolverNet config. Claim eligibility filters on these entries: a daemon with no joined SolverNets does not claim *any* tasks, and tasks whose `solverNetManifestCid` is not in `joinedSolverNets` are ignored regardless of contract type.

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
- **Phase A** (in progress): Knowledge-market substrate framing per DR-2026-04-30. A.1 operational loop (corpus library + gating leak fix + manifest hygiene + cache + MCP rewiring) shipped; A.2 plug-in surface and A.3 campaign infra shipped; A.4 campaign-launch / SolverNet creation + launch experience shipped on testnet (`spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 — Launcher SPA, manifest-anchored registry, operator join flow, manifest-cid claim eligibility). See `spec/2026-04-30-phase-a-umbrella.md`. Subsumes the original Phase 1b roadmap; anti-farming decay + ve-JINN already shipped, residual challenge mechanism re-homed to Phase B.2.
- **Phase B** (parallel after A.1): Trust infrastructure — B.1 verifiability tier activation, B.2 evaluator economics + signal-design (includes challenge mechanism)
- **Phase C** (gated by community formation): Flagship marketplace API — the canonical app the team ships in-house
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
yarn build           # tsc compile + bundle SPA into dist/dashboard
yarn test            # vitest run
yarn e2e             # end-to-end on Anvil fork
yarn staking         # earning bootstrap validation on Anvil
node dist/bin/jinn.js run    # contributor daemon launch (after `yarn build`)

# Contracts
cd contracts
yarn install
yarn test            # Hardhat tests
```

## Adding SolverTypes

To add a new **in-repo** SolverType (typed `spec`, `jinn tasks submit --spec-file`, optional auto-generators, and Harness/evaluator pairing), follow [`docs/runbooks/add-solver-type.md`](docs/runbooks/add-solver-type.md). SolverType definitions live under `client/src/solver-types/`; Task documents live under `client/src/tasks/`; Harness selection is owned by SolverNet config and `client/src/harnesses/impls/index.ts` (`buildHarnesses`).

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
