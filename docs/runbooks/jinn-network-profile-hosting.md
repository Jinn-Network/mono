# Hosting the jinn.network profile root

**Scope:** serving the public schemas and profiles declared by the catalog for the exact
`platform-v1` release set. The current package declarations and self-identifying URI claims are in
the [generated public-surface view](../../architecture/generated/platform-topology.md#public-surfaces-and-identity-claims).

## What same-run verification produces

`.github/workflows/platform-verification.yml` builds the profile root from catalog-declared
`publicSurface.schemas`, `publicSurface.profiles`, and `publicSurface.fixtures`. The publication
surface guard first proves that declarations exist and agree with package `files` and `exports`;
the profile builder then maps a JSON Schema `$id` or facts-profile `profile` claim under
`https://jinn.network/` to that exact served path and rejects duplicate claims.

The core surface includes the cataloged trajectory schemas. It excludes environment records,
environment-verification assets, and environment facts profiles because those packages belong to
the disabled experimental release group, not `platform-v1`. Directory location alone can neither
include nor exclude a document.

The same run emits:

- the served documents with their declared media types;
- `manifest.json`, binding every served path to SHA-256, media type, and source package;
- an optional `manifest.dsse.json` signature sidecar when the signing key is provisioned;
- the platform public-surface manifest;
- the exact tarball manifest and SHA-512 integrity records; and
- an immutable verification receipt binding source SHA, catalog digest, release group, lane,
  package order, tarballs, surfaces, profile manifest, and required job conclusions.

The profile manifest bytes do not depend on whether a signing key exists. Source-tree `.sha256`
sidecars are not served; `manifest.json` is the digest authority for the hosted copy.

## Hard stable blocker

Stable package publication remains mechanically disabled until the live host exists and an
end-to-end verification gate proves that `https://jinn.network/` serves the exact same-run
manifest and document bytes. Building or attesting an artifact is not proof that the public host
serves it. Do not remove `stable-hosting-blocker`, enable a stable publisher, or claim external
conformance before the live-host gate is implemented and passes.

## Hosting and key-provisioning checklist

An operator with control of `jinn.network` and the organization settings must:

- [ ] Generate an Ed25519 signing key offline and keep the private key out of this repository.
- [ ] Add the PKCS#8 PEM private key as `JINN_PROFILE_MANIFEST_SIGNING_KEY`.
- [ ] Add its identifier as `JINN_PROFILE_MANIFEST_KEY_ID`.
- [ ] Publish the corresponding public key at a stable URL and record that URL in the deployment
      record.
- [ ] Configure a static host for `jinn.network` that preserves manifest paths exactly.
- [ ] Serve each document with the media type declared by `manifest.json`, including extensionless
      task and facts profiles.
- [ ] Deploy one exact attested profile-root artifact; never rebuild it at the host.
- [ ] Fetch `manifest.json` from the live domain, verify its attestation/signature, and byte-compare
      every hosted document and digest with the same-run immutable artifact.
- [ ] Verify at least one trajectory schema and one facts/task profile by its self-declared URI.
- [ ] Record the source SHA, catalog digest, artifact/receipt identities, operator, public-key URL,
      and completion date.

Only after this checklist is represented by a fail-closed automated live-host verification gate
may the platform stable hold be reconsidered.
