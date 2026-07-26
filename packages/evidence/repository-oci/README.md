# `@jinn-network/evidence-repository-oci`

Deterministic OCI distribution binding for the Jinn Evidence Repository
contract.

The package maps one exact repository record or artifact to an OCI Image
Manifest 1.1.1. The manifest has a standard empty JSON config, exactly one
content layer, a versioned Jinn artifact type, and no mutable timestamp,
platform, subject, or referrer metadata. RFC 8785 canonicalization makes its
manifest bytes and transport digest reproducible across implementations.

```ts
import {
  buildEvidenceOciManifest,
  canonicalizeEvidenceOciManifest,
  recordLookupTag,
} from "@jinn-network/evidence-repository-oci";

const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);
const manifestBytes = canonicalizeEvidenceOciManifest(manifest);
const tag = recordLookupTag(reference);
```

Tags are digest-derived lookup aliases, not identity. Retrieval validates the
manifest artifact type, exact layer digest and size, and downloaded bytes
against the Evidence Repository reference.

The normative profile, JSON Schema, and golden manifest vectors ship under
`profiles/` and `fixtures/`.

## ORAS adapter

The working registry adapter requires ORAS `>=1.3.0 <2` and is tested with
1.3.2:

```ts
import {
  createOrasCliEvidenceRepository,
} from "@jinn-network/evidence-repository-oci";

const repository = await createOrasCliEvidenceRepository({
  repository: "registry.example.com/jinn/evidence",
  registryConfigPath: "/private/path/to/registry-config.json",
});
```

The adapter invokes `oras blob push/fetch` and `oras manifest push/fetch`
without a shell. It constructs and verifies manifest bytes in this package.
Authentication remains entirely owned by ORAS through its registry config;
passwords and tokens are intentionally not JavaScript options or command-line
arguments.

The OCI binding exposes the shared frozen empty Repository capability object.
It does not infer a per-object maximum from mutable registry quota or local
free-space observations.

## Development

Use Node 22, Yarn 4.13.0, and ORAS 1.3.2 for registry integration:

```sh
yarn install --immutable
yarn check:profile
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
