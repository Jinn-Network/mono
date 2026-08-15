# Acceptance tier (`test/acceptance/`)

This directory contains slow, real-integration tests that exercise the full
plug-in builder loop against real external binaries. They run in their own
vitest config (`client/vitest.acceptance.config.ts`) and are **not** included
in the default `yarn test` run.

## When to run

```bash
# From client/
yarn e2e:cold-start-builder
```

Expected runtime: ~60–90 s for the combined cold-start + dual-role describe
blocks.

## Prerequisites

- **Foundry's `anvil`** must be in PATH. Install via:
  ```bash
  curl -L https://foundry.paradigm.xyz | bash && foundryup
  ```
- Node 22+
- `yarn install` (already done if you're developing normally)

## What this tier covers

### `cold-start-builder.test.ts`

Walks spec §6.7's nine-step builder loop end-to-end:

1. `jinn create plugin` — scaffold a new plug-in
2. `jinn solver-plugins pack` — pack it
3. `jinn solver-plugins publish` — publish (lazily completes Stage 1 against
   a stub `IdentityRegistry` deployed locally on Anvil)
4. Stub indexer picks up `MetadataSet` events → `PluginPublication` row
5. Discovery API (`/v1/discovery/plugin-publications`) surfaces the new plug-in
6. Operator installs by appending the plug-in source onto `executionWiring[].plugins`
7. stub-Hermes simulates a SWE-rebench v2 task run with the plug-in loaded
8. Envelope carries `executor.plugins[]` attribution
9. `/build` SPA panels render the new plug-in (skipped if `hfmf` not merged)

A second describe block ("dual-role") exercises the `ensureStage1And2 → publish`
lazy short-circuit: same identity is reused, `IdentityRegistry.register()` is
called exactly once.

## Fixture set

| Fixture | File | Description |
|---|---|---|
| Anvil | `_fixtures/anvil.ts` | Spawns `anvil --port <ephemeral>` |
| IdentityRegistry deploy | `_fixtures/identity-registry-deploy.ts` | Deploys a minimal IdentityRegistry on Anvil |
| Stub IPFS | `_fixtures/stub-ipfs.ts` | In-process Hono server mimicking the Autonolas IPFS registry |
| Stub indexer | `_fixtures/stub-indexer.ts` | In-process Hono server + viem event watcher |
| Stub-Hermes script | `client/scripts/stub-hermes.mjs` | Node script simulating the Hermes harness run |
| Hermes-config shim | `_fixtures/hermes-config-shim.ts` | Local mirror of `hermesConfigFromSolverPlugins` |
| SPA harness | `_fixtures/spa-harness.tsx` | Renders `Build.tsx` with mocked fetch |

## Why a separate tier?

The default `yarn test` run targets < 15 s. Anvil cold start alone is ~3 s;
the full builder loop exceeds 30 s. Keeping this tier behind an explicit
`yarn e2e:cold-start-builder` preserves fast feedback for all other tests.

## Spec reference

- `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §6.7 — acceptance criteria
- `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §4 acceptance #10 — cold-start gate
