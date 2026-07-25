# `@jinn-network/attestation-issuer`

Producer-neutral issuance of Jinn Result Evaluation and Execution Verification attestations.

The caller evaluates Results or verifies an Execution and supplies the verdict, actor IRI,
timestamp, exact digest-addressed subjects, optional support references, and a DSSE signer. This
package only constructs the typed Statement, asks the signer to sign the exact DSSE
pre-authentication bytes, validates the resulting envelope, and optionally commits those exact
bytes through an injected `EvidenceRepository`.

It does not perform evaluation or verification, retrieve or store referenced subjects or support,
own keys, infer identity or trust, apply admission or policy, register a catalog entry, or publish
to a public service.

## Lifecycle

```ts
import {
  commitPreparedAttestation,
  prepareResultEvaluation,
} from "@jinn-network/attestation-issuer";

const prepared = await prepareResultEvaluation({
  task: { name: "task.md", digest: taskDigest },
  results: [{ name: "result.patch", digest: resultDigest }],
  evaluator: { id: "https://example.test/agents/evaluator" },
  evaluatedAt: "2026-07-24T12:00:00Z",
  verdict: "pass",
}, async ({ preAuthEncoding, signal }) => {
  const signature = await signerService.sign(preAuthEncoding, { signal });
  return [{ keyid: "opaque-key-reference", signature }];
});

const receipt = await commitPreparedAttestation(prepared, repository);
```

Preparation and commitment are deliberately separate. If the repository write fails, retain and
retry the same `prepared` value. Do not sign again: the exact envelope bytes are the retry unit
and determine `recordDigest`.

Verification uses the same lifecycle:

```ts
const prepared = await prepareExecutionVerification({
  executionEvidenceDigest,
  executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  verifier: { id: "https://example.test/agents/verifier" },
  verifiedAt: "2026-07-24T12:01:00Z",
  verdict: "verified",
}, signer);
```

Subject and support references are content identities. Their bytes may be private, unavailable,
or stored elsewhere; issuance never fetches them.

## Integration contract and fixtures

Adapter packages can run `describeAttestationIssuerIntegrationContract` from
`@jinn-network/attestation-issuer/testing`. Deterministic, non-cryptographic serialization vectors
are exported under `@jinn-network/attestation-issuer/fixtures/issuer-contract-v1/*`.

## Development

Node 22 and Yarn 4.13.0 are required.

```sh
corepack yarn install --immutable
corepack yarn typecheck
corepack yarn test
corepack yarn build
corepack yarn pack:smoke
```
