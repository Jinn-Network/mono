# Base V3 Anvil snapshot

The committed Anvil `--dump-state` fixture the **hermetic gate** loads. It lets
the per-PR gate run the full V3 loop against **real OLAS bytecode + our deployed
V3 stack** with **zero live RPC** — deterministic, so a red is always a real
code regression, never infra flake.

- **Build entrypoint:** [`contracts/scripts/build-anvil-snapshot.ts`](../../contracts/scripts/build-anvil-snapshot.ts)
- **Implementation:** [`client/scripts/build-anvil-snapshot.ts`](../../client/scripts/build-anvil-snapshot.ts)
- **Committed fixture:** `client/test/_support/fixtures/anvil-base-v3-state/state.json`
- **Committed address manifest:** `client/test/_support/fixtures/anvil-base-v3-state/addresses.json`
- **Loaded by:** `spawnAnvilFromState({ statePath })` in
  [`client/test/_support/chain/anvil.ts`](../../client/test/_support/chain/anvil.ts)
  and the Marketplace conformance harness in
  [`packages/marketplace/testing/src/anvil-state.ts`](../../packages/marketplace/testing/src/anvil-state.ts)
  (both run `anvil --load-state <path>`)
- **Spec:** [`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md`](../superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md)
  §4 (snapshot, not fork) + §5 (fidelity) + §14 (what this does not cover)

## Why a snapshot, not a fork (spec §4)

A `--fork-url` per-PR gate reintroduces exactly the flakiness the two-gate
redesign removes: it puts Base RPC back on the blocking path (cold-cache forks
issue live `eth_getCode`/`eth_getStorageAt`), breaks determinism (lazily-fetched
slots, provider timeouts, `latest` semantics vary run-to-run), needs an RPC
secret PRs from forks can't get, and rots silently as providers prune archive
state. `--load-state` is sub-second local disk I/O that passes identically in a
year.

Forking is a **build step for the fixture, not a runtime dependency**: we fork
Base once to capture the real OLAS Mech Marketplace, service registries, Safe
factory, and OLAS token, then dump the state and commit it.

## How to build / refresh

This is an **offline build step. It is NOT run in CI** — it is the one place in
the whole pipeline that needs a real Base RPC.

Post-HH3, the stable contracts path is a **compatibility wrapper**. The real
builder lives under `client/scripts/` because it imports client-owned
dependencies (`tsx`, `viem`, `@safe-global/safe-deployments`, and
`client/src/earning/bootstrap`). Keep invoking the contracts wrapper from the
**client** package so bare imports resolve through `client/node_modules`.

Install both package dependency sets before a refresh: the client owns the
builder runtime, and the builder shells out to `yarn compile` in `contracts/` to
build the V3 artifacts (the same `cwd: CONTRACTS_DIR` pattern the e2e helpers
use).

```bash
cd client
yarn install --immutable

cd ../contracts
yarn install --immutable
cd ../client
```

Before running the long fork/build, run the no-RPC smoke check. It deliberately
unsets `BASE_RPC_URL` and must fail with the script's own
`BASE_RPC_URL is required` message — not `ERR_MODULE_NOT_FOUND` / `Cannot find
package`.

```bash
# from the client/ directory
yarn smoke:build-anvil-snapshot
```

```bash
# from the client/ directory
BASE_RPC_URL=https://your-base-mainnet-rpc.example \
  yarn tsx ../contracts/scripts/build-anvil-snapshot.ts
```

The script:

1. `yarn compile`s the V3 contracts (so the artifacts exist).
2. Spawns `anvil --fork-url <Base> --fork-block-number <pin> --dump-state <out>`.
3. Seeds: funds the deployer + operator EOAs with ETH, seeds the operator EOA
   with 5000 OLAS via the ERC-20 balance-mapping slot (no whale dance).
4. Deploys the V3 stack in the **same init order** as
   `deployMinimalV3Stack(...)` in `client/test/e2e/_daemon-harness-helpers.ts`
   and `contracts/scripts/deploy-task-coordinator-router-v3.ts`:
   `ActivityChecker.initialize` → `Coordinator.initialize` →
   `Router.initialize` → `ActivityChecker.setAuthorizedRouter`, then deploys
   `MockTaskMechWithDelivery(rate, paymentType, operator, marketplace)`.
5. Sends `SIGTERM` so anvil flushes `--dump-state` to disk and exits.

### Configuration (env, all optional)

| Env var | Default | Meaning |
|---|---|---|
| `BASE_RPC_URL` | *(required)* | Base mainnet RPC to fork once |
| `JINN_SNAPSHOT_FORK_BLOCK` | `46000000` | pinned Base block (must be ≥ the IdentityRegistry deploy, ~block 44M) |
| `JINN_SNAPSHOT_OUT_DIR` | the committed fixture dir | output directory |
| `JINN_SNAPSHOT_ANVIL_PORT` | `8545` | anvil port |
| `JINN_SNAPSHOT_READY_TIMEOUT_MS` | `60000` | readiness poll timeout |

OLAS / mech-marketplace addresses are read from `CHAIN_CONFIG`
(`getChainConfig('base')` in `client/src/earning/contracts.ts`) — never inlined
in the script — so a chain-config change flows through automatically.

After building, **commit the regenerated `state.json` and `addresses.json`** in
the same PR as the contract change that motivated the refresh. Confirm the
manifest's `router` value changed when the refresh is for a router/ABI update;
for the post-HH3 trimmed-contract refresh it must no longer be
`0xbB126c57DEfBD673FB5d94BB50ffD21A931Ba72D`.

For the post-HH3 trimmed-contract refresh, the builder advances the local-only
deployer nonce before deploying the fixture V3 stack. CREATE addresses depend on
the deployer nonce, not bytecode, so this prevents a genuine rebuild from
reusing the stale pre-trim router sentinel address.

The Foundry/Anvil version pins in
[`hermetic-gate.yml`](../../.github/workflows/hermetic-gate.yml) and
[`marketplace-ci.yml`](../../.github/workflows/marketplace-ci.yml) move in
lockstep with this fixture: if you rebuild with a new Anvil version, update the
workflow pin in the same PR and verify `anvil --load-state` still accepts the
committed `state.json`.

## When to refresh

Refresh the snapshot **deliberately, whenever our V3 contracts change** —
`JinnRouterV3`, `TaskCoordinator`, `TaskActivityCheckerV3`, or the
`TaskCoordinatorTestMocks` (`MockTaskMarketplace` / `MockTaskMechWithDelivery`).
A stale snapshot would run the gate against old bytecode and silently miss a
contract regression.

You do **not** need to refresh for OLAS upgrades: OLAS on-chain contracts are
effectively fixed, so bootstrap-from-snapshot stays faithful. Snapshot staleness
relative to the live chain is a **feature** for a deterministic gate (spec §14)
— live-chain drift (e.g. an OLAS Mech ABI upgrade) is caught by the
**environment suite** at its ≥-weekly cadence, not by this per-PR gate.

## Size / LFS guidance

A Base `--dump-state` snapshot is **large** (the committed state includes the
forked OLAS + registry + Safe-factory bytecode and storage). It is generated by
a human/heavy offline step and must be committed as a real file — never
hand-edited or fabricated.

- If the fixture stays in the low-MB range, commit it directly.
- If it grows past ~10 MB or starts bloating clone times, move it to **Git LFS**:
  add `client/test/_support/fixtures/anvil-base-v3-state/state.json filter=lfs diff=lfs merge=lfs -text`
  to a `.gitattributes`, `git lfs track` it, and re-commit. CI that loads the
  fixture must then `git lfs pull` (or use `lfs: true` on the checkout action).

The hermetic gate must **fail loud** with a clear "run the contracts wrapper
from `client/` and commit the fixture" message if the snapshot is absent —
never silently fall back to a live fork.

## Rollout order (read before landing the two-gate pipeline)

The two-gate PR (#923) deliberately lands the gate *workflows* and the
publish-guard rewrite **before** this fixture exists, because building it needs a
real Base RPC (an offline human step). Follow this order so the cut never bricks:

1. **Set both transitional waivers** as repo variables *before/at* merge:
   `JINN_HERMETIC_GATE_WAIVED=true` and `JINN_ENVIRONMENT_SUITE_WAIVED=true`
   (repo → Settings → Variables). The publish guard
   (`.github/workflows/npm-publish.yml`) treats each gate as required unless its
   waiver is `true`, and warns loudly when a gate is waived. With both set, a
   stable cut can still publish during the transition.
2. **Merge the PR to `next`.** `hermetic-gate.yml` runs on every PR/push and will
   **fail loud** (red, advisory — it is not a required check yet) until the
   fixture is committed. This is expected; it is the "commit the fixture" signal,
   not a regression.
3. **Build + commit the fixture** (the offline step above), on `next`.
4. **Observe `hermetic-gate` go green** on a `next` SHA, then **unset
   `JINN_HERMETIC_GATE_WAIVED`** — hermetic-gate is deterministic and should be
   re-armed the moment the fixture lands. Optionally run
   `.github/scripts/enable-hermetic-gate-required.sh` to make it a required check
   on `next`.
5. **Provision the `testnet-gate` Environment + warm operator** (spec §9/§11),
   let `environment-suite.yml` run green on a candidate SHA, then **unset
   `JINN_ENVIRONMENT_SUITE_WAIVED`** to re-arm the full two-gate guard.

Until step 4, the asymmetry is safe: hermetic-gate is waived (fixture pending)
yet the workflow still posts its verdict advisorily, so the guard query is
exercised end-to-end before it is load-bearing.
