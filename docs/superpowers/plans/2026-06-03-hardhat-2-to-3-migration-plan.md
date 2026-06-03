# Hardhat 2→3 Migration + Contracts CI Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `contracts/` from Hardhat 2.22 to Hardhat 3.x (ESM/nodenext + `network.connect()` runtime API) and add a `contracts/**` CI gate, without touching the independent Foundry stack.

**Architecture:** Strangler-fig — five ordered slices, each an independently-verifiable commit. Slice 0 lands the CI workflow against the *current* HH2 tree (a landable deliverable even if later slices stall). Slice 1 swaps deps + config + tsconfig + package type and proves contracts compile under HH3 *before any test is touched* (isolates the viaIR/multi-compiler/size-override risk). Slice 2 rewrites tests tranche-by-tranche behind per-tranche green gates. Slice 3 rewrites deploy scripts. Slice 4 finalizes CI end-to-end. The CI workflow calls stable script *names* (`yarn compile` / `yarn test`) so it survives the HH2→HH3 script-body change in Slice 1.

**Tech Stack:** Hardhat 3.x, `@nomicfoundation/hardhat-toolbox-mocha-ethers`, ethers v6, chai 4, mocha, TypeScript 5.4 (nodenext ESM), Yarn 4 (node-modules linker), GitHub Actions.

**Pinned worktree:** `/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034` (branch `claude/practical-rubin-60e034`, based on origin/next). All work in `contracts/` except Slice 0's workflow file at repo root.

**Non-negotiable invariants (carry through every slice):**
- **Foundry is untouched.** Never edit `contracts/foundry.toml`, `contracts/remappings.txt`, `contracts/lib/`, or any `contracts/test/jinn/invariants/*.t.sol`. If a Foundry CI job seems warranted, defer to a follow-up issue (Slice 4).
- **Preserve solc config verbatim:** multi-compiler `0.8.25` / `0.8.28` / `0.8.30`, `viaIR: true` everywhere, `runs: 1000000` default, `0.8.30` `evmVersion: "cancun"`, and the two per-file `runs: 200` overrides for `src/vendor/tokenomics/Tokenomics.sol` (0.8.30) and `src/vendor/tokenomics/Dispenser.sol` (0.8.25).
- **Keep `ethers@^6` and `chai@^4`** (HH3's ethers plugin is v6; chai-matchers peer is chai 4).
- **Each slice = exactly one commit** (clean `git bisect`).

---

## File Structure

Files created or modified across the migration:

- **Create:** `.github/workflows/contracts-ci.yml` — the CI gate (Slice 0). Repo root, not under `contracts/`.
- **Modify:** `contracts/package.json` — deps swap, `"type": "module"`, `compile`/`test` script bodies (Slice 1).
- **Modify:** `contracts/hardhat.config.ts` — `defineConfig` + `plugins: []` + typed networks + `verify` block (Slice 1).
- **Modify:** `contracts/tsconfig.json` — `module`/`moduleResolution: nodenext` (Slice 1).
- **Modify:** 33 test files under `contracts/test/**` — ethers/network rewrite + ESM-ify the 9 CJS files + `.js` extensions (Slice 2). Inventory:
  - `test/*.test.ts` (10): `ExternalStakingDistributor`, `JinnRouterV3`, `JinnTestnetFaucet`, `JinnUpgradeableProxy`, `MockV3Aggregator`, `RestorationActivityChecker`, `TaskActivityCheckerV3`, `TaskCoordinator`, `TaskCoordinatorRouterV3.integration`, plus `storage-layout.test.ts` at top level.
  - `test/jinn/**` (12, incl. shared `_op-stack-fixture.ts`).
  - `test/phase1/**` (9).
  - `test/staking/**` (2).
- **Modify:** 38 script files under `contracts/scripts/**` (35 top-level `scripts/*.ts` + 3 `scripts/lib/*`) — `network.connect()` inside functions + `.js` sweep (Slice 3).

The 9 CJS `require('hardhat')` files (confirmed): `test/ExternalStakingDistributor.test.ts`, `test/JinnTestnetFaucet.test.ts`, `test/RestorationActivityChecker.test.ts`, `test/jinn/cross-chain/_op-stack-fixture.ts`, `test/jinn/cross-chain/TaskClaimEmitter.test.ts`, `test/jinn/cross-chain/MockMessenger.test.ts`, `test/jinn/cross-chain/JinnClaimEmitter.test.ts`, `test/jinn/cross-chain/CanonicalOpStackMessenger.test.ts`, `test/phase1/JINN.test.ts`.

---

## Slice 0: Add contracts CI workflow (against current HH2 tree)

**Goal:** A landable CI gate that triggers on `contracts/**`, proven green locally against the *current Hardhat 2* tree first. Uses stable script *names* (`yarn compile` / `yarn test`) so it survives Slice 1's script-body change.

**Files:**
- Create: `.github/workflows/contracts-ci.yml`

- [ ] **Step 1: Verify the current HH2 tree is green locally under the exact CI commands**

This is a blocker gate, not a formality. If HH2 is already red, STOP and surface it — do not paper over it.

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
corepack enable
yarn install --immutable
yarn compile
yarn test
```
Expected: `yarn compile` succeeds (artifacts written); `yarn test` exits 0, all suites pass.
- **Red path:** if `yarn install --immutable` fails on a lockfile mismatch, run `yarn install` once, inspect the `yarn.lock` diff, and surface it — the immutable install must pass in CI. If `yarn test` has pre-existing failures, capture the failing suite names and STOP; report to the coordinator before proceeding. The migration cannot distinguish "I broke it" from "it was already broken" without this baseline.

- [ ] **Step 2: Write the CI workflow**

Create `.github/workflows/contracts-ci.yml` (repo root). No Foundry step in the Hardhat job. `concurrency` cancels superseded runs.

```yaml
name: Contracts CI

on:
  pull_request:
    paths: ['contracts/**']
  push:
    branches: [next, main]
    paths: ['contracts/**']

concurrency:
  group: contracts-ci-${{ github.ref }}
  cancel-in-progress: true

defaults:
  run:
    working-directory: contracts

jobs:
  compile-and-test:
    name: Compile & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: corepack enable
      - run: yarn install --immutable
      # Hardhat-only job: NO Foundry step here. The `.t.sol` invariant suite
      # (contracts/test/jinn/invariants/*) and foundry.toml are independent and
      # belong to a separate (deferred) Foundry job — see the migration plan.
      # `compile`/`test` are stable script NAMES; their bodies change HH2→HH3.
      - run: yarn compile
      - run: yarn test
```

- [ ] **Step 3: Lint the workflow YAML**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034"
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/contracts-ci.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 4: Commit Slice 0**

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034"
git add .github/workflows/contracts-ci.yml
git commit -m "ci(contracts): add Hardhat compile+test gate on contracts/**

Triggers on contracts/** PRs and pushes to next/main. Node 22, immutable
install, yarn compile + yarn test. No Foundry step (independent stack).
Stable script names survive the HH2->HH3 body change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Slice 0 verification gate (GREEN to proceed):** `yarn compile` and `yarn test` both exited 0 in Step 1; workflow YAML parses; commit exists. **RED (stop):** any pre-existing HH2 test failure — report it as a blocker.

---

## Slice 1: Deps swap + config rewrite + tsconfig/package ESM flip

**Goal:** Contracts compile under Hardhat 3 (`hardhat build`) before any test is touched. This isolates the viaIR / multi-compiler / per-file-size-override risk (**T1**) and the peer-dep / lockfile-churn risk (**T6**).

**Files:**
- Modify: `contracts/package.json`
- Modify: `contracts/hardhat.config.ts`
- Modify: `contracts/tsconfig.json`

- [ ] **Step 1: Pin a concrete `hardhat@3.x.y` version — FIRST ACTION**

Do NOT proceed on a floating `^3`. Resolve the latest 3.x and record the exact version; the rest of this plan's CLI subcommands (`build` vs `compile`, `test mocha`, `network.connect()` vs `network.create()`) are version-specific and you must follow THAT version's docs.

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
npm view hardhat dist-tags --json
npm view hardhat@latest version
```
Then pin the resolved exact version (example below uses `3.0.0` — replace with the real resolved patch):
```bash
HH3=$(npm view hardhat@latest version)
echo "Pinning hardhat@$HH3"
```
- [ ] Read that version's migration guide and confirm three facts before continuing, recording each in the commit message:
  1. Compile subcommand name: is it `hardhat build` (expected) or `hardhat compile`?
  2. Test subcommand: `hardhat test mocha` (expected) vs `hardhat test`?
  3. Runtime connect API: `network.connect()` (expected) vs `network.create()`? Which returns `{ ethers, networkHelpers }`?

  **If any differs from the expectations baked into Slices 1–3, update the affected step bodies in THIS plan file before writing code.** (A4/T4 — version-specific unknowns.)

- [ ] **Step 2: Swap dependencies in `package.json`**

Remove the HH2 stack and add the HH3 single-front-door toolbox. Pin `hardhat` to the exact version from Step 1.

Remove from `devDependencies`:
- `@nomicfoundation/hardhat-chai-matchers`
- `@nomicfoundation/hardhat-ethers`
- `@nomicfoundation/hardhat-ignition`
- `@nomicfoundation/hardhat-ignition-ethers`
- `@nomicfoundation/hardhat-network-helpers`
- `@nomicfoundation/hardhat-toolbox`
- `@nomicfoundation/hardhat-verify`
- `@nomicfoundation/ignition-core`
- `@typechain/ethers-v6`
- `@typechain/hardhat`
- `typechain`
- `hardhat-gas-reporter` (HH3 built-in; current config configures none; CI runs none → zero loss)
- `solidity-coverage` (HH3 built-in; same reasoning)
- `ts-node` (HH3 runs TS natively via its own loader)

Add to `devDependencies` (pin `hardhat` exactly, toolbox at `^3`):
```json
"hardhat": "<EXACT 3.x.y FROM STEP 1>",
"@nomicfoundation/hardhat-toolbox-mocha-ethers": "^3.0.0"
```

Keep unchanged: `chai@^4.5.0`, `ethers@^6.16.0`, `@types/chai@^4`, `@types/mocha@^10`, `typescript@5.4`, all `dependencies` (`@openzeppelin/contracts`, `@prb/math`, `dotenv`, etc.), and the `resolutions` block.

Add the package `type` and update script bodies (the script *names* stay `compile`/`test` so Slice 0's CI keeps working). Use the subcommands confirmed in Step 1:
```json
"type": "module",
"scripts": {
  "compile": "hardhat build",
  "test": "hardhat test mocha",
  "deploy:l2-token": "hardhat run scripts/create-phase1a-l2-token.ts --network baseSepolia",
  "validate:phase1a": "hardhat run scripts/validate-phase1a.ts",
  "checkpoint": "hardhat run scripts/checkpoint-and-verify.ts --network sepolia"
}
```
- **Note on `hardhat run` survival (T4):** the three script-invoking npm scripts above rely on `hardhat run` still existing in HH3. Confirm against the pinned version's docs in Step 1. If `hardhat run` is removed/renamed, record the replacement invocation and update these three script bodies here *and* the Slice 3 dry-run command. Do not delete these scripts.

- [ ] **Step 3: Install and resolve peer deps (T6)**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn install
```
Expected: install completes. **If `yarn install` reports unmet peer dependencies** for bundled `@nomicfoundation/*@3.x` packages (chai-matchers, network-helpers, verify, ignition, typechain), add back only the specific reported packages at their `@3.x` versions and re-run. Do not pre-add them speculatively — the toolbox bundles them as peers and only the unmet ones need listing.
- Confirm the node-modules linker is in effect (the repo convention for the hosted operator; HH3 + native TS loader expects it):
```bash
cat .yarnrc.yml 2>/dev/null | grep -i nodeLinker || echo "no explicit nodeLinker"
```
If there is no `nodeLinker: node-modules` and install fails to expose the toolbox at runtime, add `nodeLinker: node-modules` to `contracts/.yarnrc.yml` (create it if absent) and re-run `yarn install`. Record this in the commit message.

- [ ] **Step 4: Rewrite `hardhat.config.ts` to HH3 `defineConfig`**

Preserve the solc block VERBATIM (T1). Convert networks to typed HH3 shapes; move etherscan→`verify`; list plugins explicitly. Keep both `dotenv.config()` calls and `process.env` reads (configVariable migration is deferred polish — do not expand scope).

```typescript
import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const optimizerSettings = {
  optimizer: {
    enabled: true,
    runs: 1000000,
  },
  viaIR: true,
};

// Tokenomics and Dispenser exceed the 24KB contract size limit with high
// optimizer runs. Use fewer runs to reduce bytecode size.
const largeContractSettings = {
  optimizer: {
    enabled: true,
    runs: 200,
  },
  viaIR: true,
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    compilers: [
      { version: "0.8.25", settings: optimizerSettings },
      { version: "0.8.28", settings: optimizerSettings },
      { version: "0.8.30", settings: { ...optimizerSettings, evmVersion: "cancun" } },
    ],
    overrides: {
      "src/vendor/tokenomics/Tokenomics.sol": {
        version: "0.8.30",
        settings: largeContractSettings,
      },
      "src/vendor/tokenomics/Dispenser.sol": {
        version: "0.8.25",
        settings: largeContractSettings,
      },
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 8453,
    },
    localhost: {
      type: "http",
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      chainId: process.env.LOCAL_CHAIN_ID ? Number(process.env.LOCAL_CHAIN_ID) : 31337,
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    baseSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    base: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.BASESCAN_API_KEY || "",
    },
  },
});
```
- **`chainType` fallback:** if `"op"` on the `hardhat` edr-simulated network causes friction at compile/connect time (e.g. the OP predeploys clash with the local fixtures), fall back to `chainType: "generic"` on `hardhat` and re-test. Record the fallback in the commit message. Leave the http OP networks (`baseSepolia`, `base`) as `"op"` regardless.

- [ ] **Step 5: Flip `tsconfig.json` to nodenext ESM**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "rootDir": "."
  },
  "include": ["./**/*.ts"]
}
```

- [ ] **Step 6: Gate — contracts compile under HH3**

This is the T1 isolation gate. No test file has been touched yet.

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn compile
```
Expected: `hardhat build` compiles all three solc versions, applies the two per-file overrides, exits 0.
- **Verify the size-edge contracts still fit (T1):** confirm `Tokenomics` and `Dispenser` did not blow the 24KB EIP-170 limit under HH3's solc. Inspect artifact bytecode length:
```bash
node -e "for (const f of ['src/vendor/tokenomics/Tokenomics.sol/Tokenomics.json','src/vendor/tokenomics/Dispenser.sol/Dispenser.json']) { const p='artifacts/'+f; try { const a=require('./'+p); const len=(a.deployedBytecode||a.bytecode||'').replace(/^0x/,'').length/2; console.log(f, len, 'bytes', len>24576?'OVER LIMIT':'ok'); } catch(e){ console.log(f,'artifact path differs under HH3 — locate it:', e.message); } }"
```
Expected: both `ok` (≤ 24576 bytes). If the artifact path differs under HH3, locate the JSON under `artifacts/` and re-check. **If either is OVER LIMIT**, that is a T1 materialization — STOP and report; do not lower other contracts' runs to compensate without sign-off.
- **Red path:** if `yarn compile` fails on a `viaIR` / multi-compiler / override error, this is the isolated T1 failure — capture the exact solc error and resolve config-only (do not touch `.sol` sources) before any test work.

- [ ] **Step 7: Commit Slice 1**

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
git add package.json hardhat.config.ts tsconfig.json yarn.lock .yarnrc.yml 2>/dev/null
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" commit -m "chore(contracts): migrate config+deps to Hardhat 3 (compile-only)

Pin hardhat@<EXACT>; swap to hardhat-toolbox-mocha-ethers; drop HH2
gas-reporter/coverage/ts-node. defineConfig + plugins[] + typed networks
+ verify block; preserve solc verbatim (viaIR, multi-compiler, Tokenomics/
Dispenser runs:200 overrides). tsconfig nodenext + package type:module.
Contracts compile under \`hardhat build\`; Tokenomics/Dispenser within 24KB.
Tests not yet migrated (red until Slice 2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Slice 1 verification gate (GREEN to proceed):** `yarn compile` exits 0 under HH3; Tokenomics/Dispenser bytecode ≤ 24576 bytes; commit exists. Tests are expected RED at this point — that is by design; they migrate in Slice 2.

---

## Slice 2: Rewrite tests tranche-by-tranche

**Goal:** Migrate all 33 test files to the HH3 `network.connect()` runtime + ESM, behind a green gate after each tranche. Tranches run in dependency order: top-level → `jinn` → `phase1` → `staking`.

**The five mechanical transforms (apply to every test file):**

1. **ethers source:** `import { ethers } from "hardhat";` → `import { network } from "hardhat";`, then in a `before` hook (one connection per top-level `describe`, NOT per `it`):
   ```typescript
   import { network } from "hardhat";
   let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
   let networkHelpers: Awaited<ReturnType<typeof network.connect>>["networkHelpers"];
   before(async () => {
     ({ ethers, networkHelpers } = await network.connect());
   });
   ```
   (Use the connect/create call confirmed in Slice 1 Step 1.)
2. **network-helpers `time`:** `import { time } from "@nomicfoundation/hardhat-network-helpers";` is deleted; every `time.X(...)` → `networkHelpers.time.X(...)`.
3. **`loadFixture`:** `import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";` is deleted; every `loadFixture(fn)` → `networkHelpers.loadFixture(fn)`. `loadFixture` is connection-scoped — only call it inside `it`/`beforeEach` after the `before` hook has run.
4. **CJS → ESM:** the 9 `require('hardhat')` / `require('chai')` files convert to `import` form (`const { ethers } = require('hardhat')` is dropped in favor of the `network.connect()` pattern; `const { expect } = require('chai')` → `import { expect } from "chai";`).
5. **`.js` extensions (T3):** every relative import gets an explicit `.js` extension under nodenext (e.g. `from './_op-stack-fixture'` → `from './_op-stack-fixture.js'`).

**Fixtures that close over `ethers` (T2):** module-scope helpers and shared fixtures cannot read a top-level `ethers` binding anymore. The shared `test/jinn/cross-chain/_op-stack-fixture.ts` builds ABI-encoded proof data with `ethers.id`, `ethers.keccak256`, `ethers.encodeRlp`, `ethers.AbiCoder`, `ethers.concat`, `ethers.toBeHex` at module scope. Thread the connection's `ethers` in as a parameter (or accept an `ethers`-typed arg on each exported fn). Do NOT naively drop these into a `before` hook.

**Chai matcher first-arg (T5):** `changeEtherBalances` / `changeTokenBalance` matchers take the connection's `ethers`/provider as their new first arg under HH3. The only confirmed site is `test/JinnRouterV3.test.ts:233` (`.to.changeEtherBalances([router, creator], [...])`). Follow the pinned version's chai-matchers docs for the exact new signature when migrating that file; grep each tranche for `changeEtherBalance`/`changeTokenBalance` before declaring it done.

---

### Tranche 2a: top-level `test/*.test.ts` (10 files)

**Files (modify):** `test/ExternalStakingDistributor.test.ts`, `test/JinnRouterV3.test.ts`, `test/JinnTestnetFaucet.test.ts`, `test/JinnUpgradeableProxy.test.ts`, `test/MockV3Aggregator.test.ts`, `test/RestorationActivityChecker.test.ts`, `test/TaskActivityCheckerV3.test.ts`, `test/TaskCoordinator.test.ts`, `test/TaskCoordinatorRouterV3.integration.test.ts`, `test/storage-layout.test.ts`.

CJS files in this tranche: `ExternalStakingDistributor`, `JinnTestnetFaucet`, `RestorationActivityChecker`.
`changeEtherBalances` site: `JinnRouterV3` (line 233).

- [ ] **Step 1: Apply the five transforms to all 10 files.** For each: convert the `before`-hook connection, rewrite `time.*`/`loadFixture`, ESM-ify the 3 CJS files, add `.js` to relative imports, and fix the `JinnRouterV3` matcher first-arg.

- [ ] **Step 2: Gate — run this tranche.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn test test/storage-layout.test.ts test/ExternalStakingDistributor.test.ts test/JinnRouterV3.test.ts test/JinnTestnetFaucet.test.ts test/JinnUpgradeableProxy.test.ts test/MockV3Aggregator.test.ts test/RestorationActivityChecker.test.ts test/TaskActivityCheckerV3.test.ts test/TaskCoordinator.test.ts test/TaskCoordinatorRouterV3.integration.test.ts
```
Expected: all 10 suites pass, exit 0. (If the pinned HH3 `hardhat test mocha` does not accept per-file path args, fall back to running the whole suite `yarn test` and confirm these suites are green in the output.)

- [ ] **Step 3: Commit tranche 2a.**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" add contracts/test
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" commit -m "test(contracts): migrate top-level tests to HH3 network.connect (tranche 2a)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Gate 2a (GREEN to proceed):** 10/10 top-level suites pass.

---

### Tranche 2b: `test/jinn/**` (12 files incl. shared fixture)

**Files (modify):** `test/jinn/JINN.test.ts`, `test/jinn/distribution/JinnDistributor.test.ts`, `test/jinn/governance/JinnGovernor.test.ts`, `test/jinn/governance/JinnDistributorDeployFlow.test.ts`, `test/jinn/upgrade/AbiInvariance.test.ts`, `test/jinn/cross-chain/_op-stack-fixture.ts` (shared helper), `test/jinn/cross-chain/CanonicalOpStackMessenger.test.ts`, `test/jinn/cross-chain/JinnClaimEmitter.test.ts`, `test/jinn/cross-chain/JinnMviL2Deploy.test.ts`, `test/jinn/cross-chain/JinnMviMockMessengerRotation.test.ts`, `test/jinn/cross-chain/MockMessenger.test.ts`, `test/jinn/cross-chain/TaskClaimEmitter.test.ts`.

CJS in this tranche: `_op-stack-fixture.ts`, `TaskClaimEmitter`, `MockMessenger`, `JinnClaimEmitter`, `CanonicalOpStackMessenger`.

- [ ] **Step 1: Migrate the shared fixture FIRST (T2).** Convert `test/jinn/cross-chain/_op-stack-fixture.ts` from `const { ethers } = require('hardhat')` (module scope) to an ESM module whose exported functions accept the connection's `ethers` as a parameter. Concretely: the module currently calls `ethers.id`/`ethers.keccak256`/`ethers.encodeRlp`/`ethers.AbiCoder`/`ethers.concat`/`ethers.toBeHex` at module scope (line 8 `CLAIM_TICKET_TOPIC = ethers.id(...)`) and inside `buildSingleLeafTrie`, `snapshotHash`, `claimSnapshotStorageSlot`, `rlpEncodeStorageValue`, `buildOutputRootArtifactsWithStoredHash`, `buildOutputRootArtifacts`, `encodeProof`. Add an `ethers` parameter (typed via the connection's ethers) to each exported function, and convert the module-scope `CLAIM_TICKET_TOPIC` constant into a small factory (e.g. `export const claimTicketTopic = (ethers) => ethers.id('ClaimTicket(...)')`) called from inside the consuming test after connect — do not keep it as a module-load-time constant.

- [ ] **Step 2: Update `CanonicalOpStackMessenger.test.ts`** (the only consumer, imports from `./_op-stack-fixture`) to import with `.js` extension and pass its connection `ethers` into the now-parameterized fixture helpers.

- [ ] **Step 3: Apply the five transforms to the remaining 10 files** in this tranche.

- [ ] **Step 4: Gate — run this tranche.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn test "test/jinn/**/*.test.ts"
```
Expected: all `test/jinn` suites pass, exit 0. (Quote the glob so the shell does not expand it; if the pinned HH3 runner needs a directory arg instead, use `yarn test test/jinn`.)

- [ ] **Step 5: Commit tranche 2b.**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" add contracts/test/jinn
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" commit -m "test(contracts): migrate test/jinn to HH3, parameterize op-stack fixture (tranche 2b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Gate 2b (GREEN to proceed):** all `test/jinn` suites pass; shared fixture threads `ethers` as a param (no module-scope `ethers`).

---

### Tranche 2c: `test/phase1/**` (9 files)

**Files (modify):** `test/phase1/Antifarming.test.ts`, `test/phase1/Bridge.test.ts`, `test/phase1/DeployL1Stack.test.ts`, `test/phase1/EpochEmission.test.ts`, `test/phase1/JINN.test.ts`, `test/phase1/JinnRouterV2Integration.test.ts`, `test/phase1/MechMarketplace.test.ts`, `test/phase1/Phase1aRollout.test.ts`, `test/phase1/StakingDistribution.test.ts`.

CJS in this tranche: `JINN.test.ts` (`const { expect } = require('chai'); const { ethers } = require('hardhat');`).
`EpochEmission.test.ts` imports network-helpers directly — fold into `networkHelpers`.

- [ ] **Step 1: Apply the five transforms to all 9 files** (ESM-ify `phase1/JINN.test.ts`; rewrite `EpochEmission`'s direct network-helpers import).

- [ ] **Step 2: Gate — run this tranche.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn test "test/phase1/**/*.test.ts"
```
Expected: all `test/phase1` suites pass, exit 0.

- [ ] **Step 3: Commit tranche 2c.**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" add contracts/test/phase1
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" commit -m "test(contracts): migrate test/phase1 to HH3 network.connect (tranche 2c)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Gate 2c (GREEN to proceed):** all `test/phase1` suites pass.

---

### Tranche 2d: `test/staking/**` (2 files) + full-suite gate

**Files (modify):** `test/staking/RestorationActivityCheckerV2_Phase_B_prime.test.ts`, `test/staking/RestorationActivityCheckerV2_proxy.test.ts`.

- [ ] **Step 1: Apply the five transforms to both files.**

- [ ] **Step 2: Gate — run the staking tranche, then the FULL suite.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn test "test/staking/**/*.test.ts"
yarn test
```
Expected: staking suites pass; then the full `yarn test` exits 0 with every suite green (this is the Slice 2 exit gate — all 33 files migrated, no stragglers).

- [ ] **Step 3: Confirm no `require('hardhat')` / bare-extension relative imports remain in test/.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
grep -rn "require('hardhat')\|require(\"hardhat\")\|from \"@nomicfoundation/hardhat-network-helpers\"\|from '@nomicfoundation/hardhat-network-helpers'" test && echo "STRAGGLERS FOUND" || echo "no stragglers"
```
Expected: `no stragglers`.

- [ ] **Step 4: Commit tranche 2d.**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" add contracts/test/staking
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" commit -m "test(contracts): migrate test/staking to HH3; full suite green (tranche 2d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Slice 2 verification gate (GREEN to proceed):** full `yarn test` exits 0; zero `require('hardhat')` or direct `network-helpers` imports remain in `test/`.

---

## Slice 3: Rewrite deploy scripts

**Goal:** Migrate the 38 `scripts/**` files (35 top-level + 3 `scripts/lib/*`) to HH3: `network.connect()` inside `main()`/exported functions (never at import scope), `.js`-extension sweep on relative imports. Scripts have no automated suite, so the gate is typecheck-clean compile + one representative dry-run against the in-process network.

**Files (modify):** all 38 under `contracts/scripts/**`. The 3 lib files (`scripts/lib/deploy-helpers.ts`, `scripts/lib/jinn-mvi-helpers.ts`, `scripts/lib/phase1a-rollout-helpers.ts`) are imported by the deploy scripts — migrate them so they accept the connection's `ethers` as a parameter (same T2 discipline as the test fixture), not a module-scope import.

**Transforms:**
1. **Connect at runtime, not import scope:** `import { ethers } from "hardhat";` (and the one `import { ethers, network } from "hardhat";` in `scripts/deploy-phase1a-bridge.ts`) → `import { network } from "hardhat";`, then `const { ethers } = await network.connect();` as the FIRST line inside `main()` (or the exported entry fn). Never call `network.connect()` at module top level — scripts are imported by `hardhat run` and a top-level connect breaks that.
2. **Thread `ethers` into lib helpers:** `scripts/lib/*` exported functions take `ethers` (and provider) as params; the calling script passes its connected `ethers`.
3. **`.js` extension sweep (T3):** every relative import (`./lib/deploy-helpers` → `./lib/deploy-helpers.js`, etc.) across all 38 files.

- [ ] **Step 1: Migrate the 3 `scripts/lib/*` helpers first** (parameterize on `ethers`; `.js` extensions on their own relative imports).

- [ ] **Step 2: Migrate the 35 top-level `scripts/*.ts`** — connect inside `main()`, pass `ethers` into lib helpers, `.js` sweep. Note `scripts/deploy-phase1a-bridge.ts` is the one file importing `{ ethers, network }` — it keeps `network`, drops the `ethers` named import, and connects inside `main()`.

- [ ] **Step 3: Gate part A — typecheck-clean compile.**

`hardhat build` typechecks the TS project (scripts included via `tsconfig` `include: ["./**/*.ts"]`). Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn compile
```
Expected: exits 0 with no TS errors from `scripts/`. If HH3's `build` does not typecheck scripts, additionally run `yarn tsc --noEmit -p tsconfig.json` and expect 0 errors.

- [ ] **Step 4: Confirm no import-scope connect / bare relative imports remain in scripts/.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
grep -rn "^import { ethers } from \"hardhat\"\|^import { ethers, network } from \"hardhat\"" scripts && echo "STRAGGLER IMPORTS" || echo "no straggler imports"
```
Expected: `no straggler imports`.

- [ ] **Step 5: Gate part B — one representative deploy script dry-runs against the in-process network.**

`scripts/deploy-phase1a.ts` deploys the full L1 stack and supports `--network hardhat` (per its header), which is fully in-process (no funds, no live RPC). Run it against the pinned HH3 `hardhat run` (or its confirmed replacement from Slice 1 Step 1):
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn hardhat run scripts/deploy-phase1a.ts --network hardhat
```
Expected: the script connects, deploys the stack against the in-process EDR network, prints addresses, and exits 0 (it writes `deployment-phase1a-hardhat.json`). **If `hardhat run` was removed in the pinned version**, use the replacement invocation recorded in Slice 1 Step 1. Clean up the generated artifact afterward so it does not get committed:
```bash
rm -f deployment-phase1a-hardhat.json
```

- [ ] **Step 6: Commit Slice 3.**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" add contracts/scripts
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" commit -m "refactor(contracts): migrate deploy scripts to HH3 network.connect()

connect() inside main()/exported fns (never import scope); lib helpers take
ethers as a param; .js extension sweep under nodenext. deploy-phase1a dry-runs
green against the in-process EDR network.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Slice 3 verification gate (GREEN to proceed):** `yarn compile` typecheck-clean (scripts included); zero import-scope `ethers`-from-hardhat in `scripts/`; `deploy-phase1a.ts --network hardhat` exits 0.

---

## Slice 4: Finalize CI + acceptance

**Goal:** Confirm the Slice 0 workflow is green end-to-end under HH3, and decide on a Foundry job (add only if it does not expand scope; otherwise file a follow-up).

**Files:** none required to change (Slice 0's workflow already calls stable `yarn compile`/`yarn test`). Optional: a second job in `.github/workflows/contracts-ci.yml` if Foundry is added.

- [ ] **Step 1: Final acceptance gate — full local run under HH3.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034/contracts"
yarn install --immutable
yarn compile
yarn test
```
Expected: immutable install passes (lockfile committed in Slice 1 is consistent); `yarn compile` and `yarn test` both exit 0 under HH3.

- [ ] **Step 2: Confirm the CI workflow diff and Foundry-untouched invariant.**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034"
git diff --stat origin/next -- .github/workflows/contracts-ci.yml
git status --porcelain contracts/foundry.toml contracts/remappings.txt contracts/lib contracts/test/jinn/invariants
```
Expected: the first command shows `contracts-ci.yml` added; the second prints NOTHING (Foundry config, `lib/`, and `.t.sol` invariants are all unmodified).

- [ ] **Step 3: Decide on the Foundry job.**

The Hardhat job intentionally excludes Foundry. The `.t.sol` invariant suite (`test/jinn/invariants/*.t.sol`, solc 0.8.30/cancun) needs `forge`. Two acceptable outcomes:
- **(a) In-scope, cheap:** add a SECOND independent job to `contracts-ci.yml` that runs `foundry-rs/foundry-toolchain@v1` then `forge test` — only if it is a clean addition that does not modify `foundry.toml`/`remappings.txt`/`lib/`. If added, commit it and note it in the PR.
- **(b) Expands scope:** if `forge test` needs config changes, dependency fetches, or debugging, do NOT touch it here — file a follow-up GitHub Issue ("Add Foundry job to contracts CI") and leave the Hardhat-only gate as the deliverable.

Record the decision in the PR description either way.

- [ ] **Step 4: (If Foundry job added in 3a) commit it.**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" add .github/workflows/contracts-ci.yml
git -C "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/practical-rubin-60e034" commit -m "ci(contracts): add independent Foundry (forge test) job

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Final acceptance gate (DONE):** `cd contracts && yarn compile && yarn test` both green under HH3; `git diff` shows `contracts-ci.yml` added; `git status` confirms `foundry.toml`/`remappings.txt`/`lib/`/`*.t.sol` untouched.

---

## Risks / where it breaks (mapped to design T1–T6)

- [ ] **T1 — solc config under HH3 (viaIR + multi-compiler + per-file size overrides).** Materializes in **Slice 1 Step 6**. The two 24KB-edge contracts (`Tokenomics`, `Dispenser`) are the canaries — the bytecode-size check is explicit there. *Mitigation:* config-only resolution; never edit `.sol` sources or lower other contracts' runs to compensate without sign-off. *Isolation:* Slice 1 gates on compile BEFORE any test work, so a solc failure can't be confused with a test-rewrite failure.

- [ ] **T2 — 64-site ethers rewrite at scale; module-scope consts + shared fixtures are not naive before-hook drop-ins.** Materializes in **Slice 2b** (`_op-stack-fixture.ts` — module-scope `CLAIM_TICKET_TOPIC = ethers.id(...)` and 7 exported builders) and **Slice 3** (`scripts/lib/*`). *Mitigation:* thread the connection's `ethers` in as a function parameter; convert module-load-time constants to factories called post-connect. Migrate the shared fixture/lib FIRST in each slice.

- [ ] **T3 — `.js` extension sweep under nodenext.** Materializes everywhere relative imports exist (~58 sites across test+scripts). *Mitigation:* explicit per-tranche grep before each commit; the straggler greps in Slice 2 Step 3 (2d) and Slice 3 Step 4 catch misses. A missing `.js` fails at runtime, not typecheck — the per-tranche `yarn test` / dry-run gates surface them.

- [ ] **T4 — connect-vs-create + `hardhat run` survival (version-specific).** Materializes at **Slice 1 Step 1** (the FIRST action: pin the exact version and read ITS docs). *Mitigation:* pin before any code; confirm `build` vs `compile`, `test mocha` vs `test`, `connect()` vs `create()`, and whether `hardhat run` survives — and update Slices 1–3 step bodies in this plan file if any differ. The three `hardhat run` npm scripts and the Slice 3 dry-run all depend on this.

- [ ] **T5 — chai matcher first-arg.** Materializes in **Slice 2a** (`test/JinnRouterV3.test.ts:233`, the only confirmed `changeEtherBalances` site). *Mitigation:* follow the pinned chai-matchers docs for the new signature; grep each tranche for `changeEtherBalance`/`changeTokenBalance` before declaring it done.

- [ ] **T6 — yarn peer-dep resolution (node-modules linker) + large lockfile churn.** Materializes in **Slice 1 Step 3**. *Mitigation:* install the toolbox alone first; add back only the *specific* unmet `@nomicfoundation/*@3.x` peers yarn reports; confirm `nodeLinker: node-modules`; commit the resulting `yarn.lock` in Slice 1 so the Slice 4 `yarn install --immutable` acceptance check stays consistent.

- [ ] **Blocker risk — pre-existing HH2 red.** Materializes in **Slice 0 Step 1**. If the current HH2 tree is already failing `yarn test`, STOP and report — the migration needs a green baseline to attribute failures correctly. Do not paper over it.

- [ ] **Foundry-untouched invariant.** Checked in **Slice 4 Step 2** (`git status --porcelain` on `foundry.toml`/`remappings.txt`/`lib/`/`*.t.sol` must be empty). Any accidental edit there is a scope violation — revert it.

---

## Self-Review notes

- **Spec coverage:** Slice 0 = CI gate + HH2 baseline; Slice 1 = deps/config/tsconfig/package (compile gate, T1 isolation); Slice 2 = 33 test files in 4 tranches (T2/T3/T5); Slice 3 = 38 scripts (T2/T3); Slice 4 = CI end-to-end + Foundry decision + acceptance. Every hard requirement (pin-first, slice ordering, per-slice gates, one-commit-per-slice, Foundry untouched, final `compile && test` gate) is encoded.
- **Version-specific commands** (`build`/`test mocha`/`connect()`/`hardhat run`) are deliberately gated behind the Slice 1 Step 1 pin-and-confirm, with explicit instructions to update this plan's step bodies if the pinned version differs.
- **Naming consistency:** `network.connect()` returning `{ ethers, networkHelpers }`, `networkHelpers.time.*`, `networkHelpers.loadFixture` used identically across Slices 2 and 3.
