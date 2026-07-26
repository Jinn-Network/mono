# Evidence Repository Capabilities Implementation Plan

> **Implementation foundation:** Read
> `../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` first. This is PR 2 in
> that stack and the only prerequisite contract change for Derivation, IPFS, and Publication.

**Base:** the exact docs-foundation PR head

**Scope:** refine `@jinn-network/evidence-repository` and its existing bindings; add no package

## Goal

Make finite repository object limits discoverable before effects:

```ts
export interface EvidenceRepositoryCapabilities {
  readonly maxObjectBytes?: number;
}

export interface EvidenceRepository {
  readonly capabilities: EvidenceRepositoryCapabilities;
  // existing put/get methods unchanged
}
```

Add `CONTENT_TOO_LARGE` to `EvidenceRepositoryErrorCode`.

The filesystem, OCI, and in-memory repositories expose a frozen empty capability object because
they declare no smaller finite application-level limit. The later IPFS binding declares 2 MiB.

`undefined` means “no finite limit declared by this binding,” not “infinite storage is guaranteed.”

## Files

At the consolidation head, modify:

```text
packages/evidence/repository/src/types.ts
packages/evidence/repository/src/errors.ts
packages/evidence/repository/src/index.ts
packages/evidence/repository/src/testing.ts
packages/evidence/repository/src/contracts.test.ts
packages/evidence/repository/src/fs/index.ts
packages/evidence/repository/src/fs/*.test.ts          # as required by red tests
packages/evidence/repository/README.md
packages/evidence/repository/scripts/pack-smoke.mjs

packages/evidence/repository-oci/src/oras.ts
packages/evidence/repository-oci/src/*.test.ts          # as required by red tests
packages/evidence/repository-oci/README.md
packages/evidence/repository-oci/scripts/pack-smoke.mjs
```

Also update every repository test double or typed wrapper found by:

```text
rg -l 'implements EvidenceRepository|: EvidenceRepository|satisfies EvidenceRepository' \
  packages/evidence --glob '*.ts'
```

Do not edit semantics, layouts, OCI manifests, fixture digests, record identities, repository
methods, or existing error meanings.

## Task 1: Freeze capability validation

Write failing root contract tests first:

- every repository exposes a non-null, non-array object;
- the object is frozen or defensively immutable;
- the only v1 field is `maxObjectBytes`;
- absent `maxObjectBytes` is accepted;
- a present value must be a positive safe integer;
- zero, negative, fractional, `NaN`, infinity, unsafe integers, and strings fail the contract kit;
- unknown future capability fields are ignored by v1 consumers;
- capability reads are stable for the repository lifetime; and
- `CONTENT_TOO_LARGE` is a valid stable error code.

Export:

```ts
export const NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES:
  EvidenceRepositoryCapabilities;
```

The shared empty constant is deeply frozen. Do not add a mutable capability negotiation API or a
closed parser that would reject future capability fields.

## Task 2: Update the contract kit and in-memory repository

Add:

```ts
readonly capabilities = NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES;
```

to `InMemoryEvidenceRepository`.

Extend `EvidenceRepositoryContractContext` only if a binding needs a custom boundary fixture:

```ts
readonly createObjectAtDeclaredLimit?: () => Uint8Array;
```

Contract behavior:

- always validate the capability object;
- when no limit is declared, retain all existing tests unchanged;
- when a finite limit is declared, require a fixture at exactly the limit and prove record and
  artifact puts accept it;
- synthesize or obtain a limit-plus-one fixture and prove both puts fail before storage with
  `EvidenceRepositoryError("CONTENT_TOO_LARGE")`; and
- prove rejection creates no readable object.

Keep normal contract fixtures small so the future IPFS kit does not allocate several large objects
for every scenario.

## Task 3: Update filesystem and OCI bindings

Add the shared empty capability constant to:

- `FilesystemEvidenceRepository`; and
- `OrasCliEvidenceRepository`.

Run their existing shared contract suites without weakening any assertion. Add focused tests that
the property:

- is present immediately after construction;
- is referentially stable;
- cannot be mutated; and
- survives packed TypeScript consumption.

Do not invent filesystem free-space checks, OCI registry quota discovery, or an arbitrary local
maximum. Those are not stable per-object contract capabilities.

## Task 4: Update typed consumers and test doubles

Run typecheck in dependency order and make the mechanical addition to every class or object that
claims to implement `EvidenceRepository`.

Use the shared empty constant for ordinary test doubles. A test double that intentionally models a
bounded store declares its exact finite limit and must reject oversize puts with
`CONTENT_TOO_LARGE`.

Do not make `capabilities` optional to reduce edits. The point of this prerequisite is that callers
can inspect the property without feature detection.

## Task 5: Packed and architecture verification

Update package smoke tests to compile:

```ts
const repository: EvidenceRepository = ...;
const limit: number | undefined = repository.capabilities.maxObjectBytes;
```

Verify the new error literal is exported from the packed Repository package and consumed by the
packed OCI package without undeclared dependencies.

Run:

```text
packages/evidence/repository:
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke

packages/evidence/repository-oci:
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke

repository-wide:
  node --test .github/scripts/evidence-package-inventory.test.mjs
  node --test .github/scripts/evidence-source-boundaries.test.mjs
  node --test .github/scripts/evidence-packed-types.test.mjs
  git diff --check
```

Run the complete existing Evidence CI DAG because the required property affects compile-time test
doubles in Recorder, Issuer, Discovery, and Local Runtime.

## Acceptance

- [ ] `EvidenceRepository.capabilities` is required and read-only.
- [ ] `maxObjectBytes` has strict positive-safe-integer semantics.
- [ ] `CONTENT_TOO_LARGE` is stable and exported.
- [ ] Memory, filesystem, and OCI expose the frozen empty capability object.
- [ ] The contract kit tests bounded implementations without penalizing bindings that declare no
      finite limit.
- [ ] Every existing typed repository consumer compiles.
- [ ] No repository method, identity, bytes, layout, OCI manifest, or protocol fixture changed.
- [ ] All existing and packed tests pass.

Commit with DCO sign-off:

```text
feat(evidence-repository): declare repository object capabilities
test(evidence-repository): enforce bounded repository contracts
```

Open one draft PR against the docs-foundation branch. Derivation, IPFS, and Publication branch only
from this PR's exact reviewed head.
