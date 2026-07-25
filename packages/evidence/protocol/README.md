# `@jinn-network/evidence-protocol`

Publish-ready, I/O-free reference implementation of Jinn Execution Evidence Protocol v1.

The protocol composes a constrained RO-Crate serialization for execution evidence with
in-toto Statements and DSSE envelopes for later result evaluations and execution
verifications. It validates structure and authenticated claim bindings; it does not decide
identity, signature trust, quality, retention, marketplace eligibility, or access policy.

## Package contents

- `profiles/execution-evidence/1.0/specification.md` — normative human specification.
- `profiles/execution-evidence/1.0/ro-crate-metadata.json` — Profile Crate.
- `profiles/execution-evidence/1.0/schemas/` — checked-in JSON Schema Draft 2020-12.
- `fixtures/golden-execution-evidence-v1/` — conforming private and public examples.
- `fixtures/autopilot-issue-1697/` — intentionally nonconforming source-backed candidate.
- `dist/` — reference schemas, validators, integrity checks, and DSSE utilities.

The package performs no filesystem, network, key-resolution, or store I/O. Applications supply
the exact bytes to validate and, when desired, artifact bytes or a signature callback.

## Use

```ts
import {
  validateExecutionEvidence,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";

const execution = validateExecutionEvidence(metadataBytes);
const evaluation = validateResultEvaluation(dsseEnvelopeBytes);
```

Validation reports bind the result to the exact input serialization with a `sha256:` record
digest. Unknown extension fields are preserved. Structural conformance is deliberately separate
from artifact availability, signature validity, actor identity, and trust.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn check:profile
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

The profile URI is reserved but is not hosted by this package:
`https://jinn.network/profiles/execution-evidence/1.0`.
