# Hosting the spec.jinn.network profile root

**Scope:** serving the public schemas and profiles declared by the catalog for the exact
`platform-v1` release set. The current package declarations and self-identifying URI claims are in
the [generated public-surface view](../../architecture/generated/platform-topology.md#public-surfaces-and-identity-claims).

## What same-run verification produces

`.github/workflows/platform-verification.yml` builds the profile root from catalog-declared
`publicSurface.schemas`, `publicSurface.profiles`, and `publicSurface.fixtures`. The publication
surface guard first proves that declarations exist and agree with package `files` and `exports`;
the profile builder then maps a JSON Schema `$id` or facts-profile `profile` claim under
`https://spec.jinn.network/` to that exact served path and rejects duplicate claims. That origin
is the protocol's own, separate from the product site at the apex, and it is the only one a
hosted identity may name (DR-2026-08-04). A document still naming the apex is rejected by name.

The core surface includes the cataloged trace schemas. It excludes environment records,
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

## Hard stable hold

Stable package publication remains mechanically disabled. Building or attesting an artifact is
not proof that the public host serves it, and the proof of the second half is
`stable-live-host-verification`: a fail-closed gate that requires
`https://spec.jinn.network/` to serve the exact same-run manifest and document bytes. It has no
"host unreachable, skip" branch. `stable-publish-gate` is the single node any future stable
publisher depends on; it requires exact success from same-run verification, the live-host gate,
and the live-host receipt attestation, so a skipped upstream job is a refusal rather than an
absence.

The gate existing is not the hold lifting. There is still no stable publisher job, the catalog's
`publishPolicy` is unchanged, and the gate has not yet been observed green against a real host —
because no host is deployed. Do not enable a stable publisher or claim external conformance
before this gate has run green against the live domain.

## Hosting and key-provisioning checklist

An operator with control of `spec.jinn.network` and the organization settings must:

The rows below marked *(gate)* are discharged automatically by
`stable-live-host-verification`; they are not performed by hand. The unmarked rows are the
operator's own provisioning work, which the gate can only check after it is done.

- [ ] Generate an Ed25519 signing key offline and keep the private key out of this repository.
- [ ] Add the PKCS#8 PEM private key as `JINN_PROFILE_MANIFEST_SIGNING_KEY`.
- [ ] Add its identifier as `JINN_PROFILE_MANIFEST_KEY_ID`.
- [ ] Publish the corresponding public key at a stable URL and record that URL in the deployment
      record.
- [ ] Configure a static host for `spec.jinn.network` that preserves manifest paths exactly. The
      apex stays purely the product site and serves no protocol bytes.
- [ ] Serve each document with the media type declared by `manifest.json`, including extensionless
      task and facts profiles.
- [ ] Deploy one exact attested profile-root artifact; never rebuild it at the host. Turn the
      attested root into a deploy directory with
      `node .github/scripts/build-profile-host-bundle.mjs --root <profile-root> --out <deploy-dir>`,
      which byte-copies the attested bytes and generates the host configuration next to them.
- [ ] *(gate)* `stable-live-host-verification` fetches `manifest.json` from the live domain,
      verifies its signature against the digest-pinned published key, and byte-compares every
      hosted document, media type and digest with the same-run attested artifact.
- [ ] *(gate)* It re-derives every served document's self-declared URI to the path it is served
      at, dereferences the registered identifiers, and probes for host fallback behavior.
- [ ] Record the source SHA, catalog digest, artifact/receipt identities, operator, public-key URL,
      and completion date.

The gate is written and tested; what it has never had is a host to run against. Only after it
has run green against the live domain may the platform stable hold be reconsidered.

## Local host conformance

`.github/scripts/serve-profile-host.mjs` serves a deploy bundle over real HTTP, and
`.github/scripts/verify-local-profile-host.test.mjs` runs the gate's own CLI against it on an
ephemeral loopback port. Both run in CI on every pull request, hermetically: no egress, no
credentials, no host CLI.

What that proves: the bundle is servable over real HTTP; the gate passes over a socket against
the whole real profile root, with the listener's own request log showing every declared document
fetched and answered; every hazardous served-path shape — extensionless profiles, `@`-prefixed
fixture directories, dot-version segments, deep fixture paths, and files whose extension a host
would type differently from the manifest — is served byte-for-byte with its declared media type;
and each modelled host defect (trailing-slash redirect, single-page-application catch-all,
mistyped extensionless profile, mistyped `.schema.json`, one drifted document, an unserved or
unverifiable signature sidecar, a public key whose digest is not the pinned one) is a non-zero
exit. A host appending `charset=utf-8` still passes, as the gate documents. The server's strict
404 — no directory index, no trailing-slash redirect, no extension guessing, no case folding, no
percent-decoding, no path normalization — is the reference behavior a real host must match.

What it does not prove: that Vercel interprets the generated `vercel.json` this way. The
conformance test reads that configuration against the reference server's behavior, which
validates this repository's reading of Vercel's documented `headers` / `cleanUrls` /
`trailingSlash` semantics, not Vercel's implementation of them. Nothing local can close that gap.
Two gate steps are also out of local reach: registered-identifier dereference and each document's
self-declared-URI re-derivation both resolve identifiers against the verification origin, and the
public surface's identifiers name `spec.jinn.network`, so neither step can run under a loopback
origin. They stay covered by the offline suite's fake host.

The first real deploy is therefore still the remaining verification, and the stable hold is
unchanged. The gate is what closes it, and it fails closed.
