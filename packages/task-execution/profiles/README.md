# `@jinn-network/task-execution-profiles`

Sealed task-profile documents and the EvaluationSpec format for the Jinn Task Execution Protocol
(TEP). A pure, I/O-free schema-and-sealing package: it re-implements canonicalization and sealing
locally (per-package, never a shared runtime dependency) so its sealed bytes are byte-compatible
with the TEP protocol sealer and with the Evidence Result Evaluation predicate — compatibility
held by fixtures, not imports.

Imports `@jinn-network/task-execution-protocol` only. No evidence package, no discovery, no
trust, no marketplace.

## Package contents

- `src/` — sealing primitives, EvaluationSpec schema/seal, task-profile schema/seal, the DSSE
  admission-receipt shape, and the conformance kit (`src/testing.ts`).
- `profiles/task-profiles/` — the two v1 sealed profile documents
  (`repository-work/1.0`, `evaluation-task/1.0`) with pinned digests.
- `fixtures/` — golden + adversarial fixture families per module (see `fixtures/README.md`).
- `dist/` — compiled output.

## Use

```ts
import { canonicalJsonBytes, sealDocument } from "@jinn-network/task-execution-profiles";

const { bytes, digest } = sealDocument(value);
```

## Development

Use Node 22 and Yarn 4.13.0:

```bash
yarn install
yarn typecheck
yarn test
yarn build
yarn check:documents
yarn pack:smoke
```
