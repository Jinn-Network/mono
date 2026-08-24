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

## Drift check

```bash
yarn check-drift
```

Compiles `contracts/`, regenerates into a temp directory, and diffs against committed `generated/`. Exit non-zero on mismatch.

## Design

See [`docs/superpowers/specs/2026-08-24-shared-contract-abis-design.md`](../../docs/superpowers/specs/2026-08-24-shared-contract-abis-design.md).
