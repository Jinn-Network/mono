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

- the repository object itself is not a Proxy;
- `capabilities` is an own data property on the repository, never inherited or accessor-backed;
- the contract kit rejects repository Proxies before any other repository reflection and reads the
  capability value from its own descriptor without invoking a getter;
- the repository's capability-slot descriptor value is stable for its lifetime; the slot is not
  required to be runtime non-writable or non-configurable;
- every repository exposes a non-null, non-array object;
- the object is an inert immutable snapshot with either `Object.prototype` or `null` as its
  prototype;
- the snapshot is non-extensible and every own field is a non-writable, non-configurable data
  property;
- the only v1 field is `maxObjectBytes`;
- absent `maxObjectBytes` is accepted;
- a present `maxObjectBytes` is an own data property; accessor-backed and inherited limits fail the
  contract kit without invoking the getter or setter;
- a present value must be a positive safe integer;
- zero, negative, fractional, `NaN`, infinity, unsafe integers, and strings fail the contract kit;
- unknown future own data fields are ignored semantically by v1 consumers but obey the same
  immutable snapshot representation;
- the object reference, prototype, extensibility, keys, descriptors, and values are stable for the
  repository lifetime;
- validation is side-effect-free and never mutates, restores, or invokes behavior on the snapshot;
- repository and capability-snapshot proxies fail before any other reflection; trap-counting tests
  prove no proxy trap or capability getter is invoked;
- descriptor-value stability uses `Object.is`, so an ignored immutable future field containing
  `NaN` remains stable; and
- `CONTENT_TOO_LARGE` is a valid stable error code.

Export:

```ts
export const NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES:
  EvidenceRepositoryCapabilities;
```

The shared empty constant is deeply frozen. Do not add a mutable capability negotiation API or a
closed parser that rejects future field names. The representation validator rejects behavior or
mutability, not unknown keys.

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
- [ ] A conforming repository is non-proxy and exposes `capabilities` as a stable own data slot
      that the contract kit inspects without invoking behavior.
- [ ] Every capability object is a side-effect-free plain-or-null, non-extensible snapshot of own
      non-writable, non-configurable data fields; accessors and inherited limits are rejected.
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
