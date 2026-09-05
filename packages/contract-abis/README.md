# @jinn-network/contract-abis

Authoritative generated ABIs from `contracts/` compile output, with named consumer slices and a deterministic drift check.

## Usage

```typescript
import { JINN_ROUTER_ABI } from "@jinn-network/contract-abis/operator";
import { JINN_ROUTER_ABI as INDEXER_ROUTER_ABI } from "@jinn-network/contract-abis/indexer";
import { JINN_ROUTER_V3_ABI } from "@jinn-network/contract-abis/binding";
```

## Regenerate

```bash
cd contracts && yarn compile
cd ../packages/contract-abis && yarn generate
```

`yarn generate` writes both halves of the generated output: the JSON under
`generated/` and the TypeScript slices under `src/generated/slices/`. Stage
both — `src/generated/slices/` is what consumers compile into `dist/`.

## Drift check

```bash
yarn check-drift
```

Compiles `contracts/`, regenerates into a temp directory, and diffs that against
both committed trees — the JSON under `generated/` and the TypeScript slices
under `src/generated/slices/`. Exit non-zero on mismatch. The check never writes
into the working tree, so it cannot heal the drift it is meant to catch.

## Design

See [`docs/superpowers/specs/2026-08-24-shared-contract-abis-design.md`](../../docs/superpowers/specs/2026-08-24-shared-contract-abis-design.md).
