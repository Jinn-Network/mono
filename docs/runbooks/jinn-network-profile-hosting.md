# Hosting the spec.jinn.network profile root

**Scope:** serving the public schemas and profiles declared by the catalog for the stack-published
release groups `sealed-platform-v1` and `implementations-v1`. The current package declarations and
self-identifying URI claims are in the
[generated public-surface view](../../architecture/generated/platform-topology.md#public-surfaces-and-identity-claims).

## What same-run verification produces

`.github/workflows/platform-verification.yml` builds one profile root per stack-published group
from catalog-declared `publicSurface.schemas`, `publicSurface.profiles`, and
`publicSurface.fixtures`. The publication surface guard first proves that declarations exist and
agree with package `files` and `exports`; the profile builder then maps a JSON Schema `$id` or
facts-profile `profile` claim under `https://spec.jinn.network/` to that exact served path and
rejects duplicate claims. That origin is the protocol's own, separate from the product site at
the apex, and it is the only one a hosted identity may name (DR-2026-08-04). A document still
naming the apex is rejected by name.

The sealed surface includes protocol identities and the cataloged environment-record and
chain-environment-record public surfaces. The implementations surface includes the remaining
declared schemas, profiles, and fixtures from `implementations-v1`. Directory location alone can
neither include nor exclude a document. Experimental-policy packages are not hosted.

The same run emits, per group:

- the served documents with their declared media types;
- `manifest.json`, binding every served path to SHA-256, media type, and source package;
- an optional `manifest.dsse.json` signature sidecar when the signing key is provisioned;
  in the attested profile root both sit at its root, and in the deploy bundle both move
  under the group that authored them (`sealed-platform-v1/manifest.json`), because one
  origin holds every group and a root manifest would be one group's inventory answering
  for all of them;
- the platform public-surface manifest;
- the exact tarball manifest and SHA-512 integrity records; and
- an immutable verification receipt binding source SHA, catalog digest, release group, lane,
  package order, tarballs, surfaces, profile manifest, and required job conclusions.

The profile manifest bytes do not depend on whether a signing key exists. Source-tree `.sha256`
sidecars are not served; each group's `manifest.json` is the digest authority for the hosted copy.
Documents keep their identifier paths at the origin root, unnamespaced, because a document's
address is its identifier; only the per-group root files are namespaced.

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

## Automatic host refresh

`stack-npm-publish.yml` job `canary-host-refresh` runs on a push to `next`, after that
run's own `canary-verification` succeeds. It runs on no other branch — the workflow also
fires on `integration/evidence-v1`, which must never deploy the public host — and on no
part of the stable path.

It rebuilds the deploy bundle from the same run's attested profile roots with
`build-profile-host-bundle.mjs` — the same generator the break-glass recipe below names —
and mirrors that bundle to the host repository's `main`. It copies and never authors: no
document is regenerated, the signature sidecars ride in the artifact, and the manifest
signing key is not available to the job. Before publishing, it re-reads
`generatedFrom.commit` out of the bytes it is about to push and refuses to continue
unless it equals the commit this run is publishing, so "the host serves this commit's
attested artifact" is a property of the copied bytes rather than trust in the download.

The mirror is idempotent: it stages the result and commits only when something changed,
so re-running a workflow for the same commit pushes nothing. Note that a *new* commit is
always a change even when no served document moved, because each group's `manifest.json`
records `generatedFrom.commit` and the catalog digest — so a push to `next` normally does
produce one host commit. Each commit message names the source SHA, the lane, and the
release groups, and `.jinn-profile-host-source` at the host root records the same.

**The host repository's `main` is entirely generated. Never hand-edit it** — the next
refresh deletes every top-level entry except `.git` and `.jinn-profile-host-source`
before copying the bundle in. That replacement, rather than an overlay, is what makes a
document withdrawn from the catalog stop being served. The source of truth is the catalog
in `Jinn-Network/mono`.

A failed refresh is a real alarm, not noise: the host is now behind `next`, which is the
drift this job exists to remove. Every step runs under `set -euo pipefail`, the job
carries no `continue-on-error`, and the push is a plain fast-forward that fails rather
than overwrites.

The refresh is deliberately **not** a `needs:` of `stable-live-host-verification`. Adding
a write-credential job to that gate's dependency chain would let a skipped refresh skip
the gate, and a skipped upstream job being a refusal is the whole point of
`stable-publish-gate`. The ordering is instead made legible: when the live-host gate
fails it annotates its own failure with the causes to check first.

The profile manifest embeds `lane` and `generatedFrom.commit`, and the automatic refresh
runs on the canary lane. A host refreshed from a push to `next` therefore serves
`"lane": "canary"` manifest bytes, while `stable-live-host-verification` byte-compares a
`lane: "stable"` manifest — so a canary-refreshed host cannot make the stable gate green.
Nothing is broken by this today: there is no stable publisher, the hard stable hold is in
force, and the stable gate fires only on a `stack-v*` release or a manual dispatch. But
it is a real gap and it is the stable path's, not the refresh's: closing it is part of
lifting the hold, and takes either a stable-lane refresh on the release path or a
manifest whose bytes do not depend on the lane. Adding a write-credential job to the
stable gate's dependency chain is not the way to close it — that would let a skipped
refresh skip the gate. Until it is closed, a red `stable-live-host-verification` should
be read against `.jinn-profile-host-source` at the host root, which names the SHA and
lane the host was last refreshed from.

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
- [ ] Create the static host repository and record its `owner/name` as the repository
      **variable** `JINN_PROFILE_HOST_REPOSITORY`. Its default branch must be `main`. Until this
      variable is set, `canary-host-refresh` skips and the host is refreshed only by hand.
- [ ] Add a fine-grained token with `contents: write` on **that repository only** as the secret
      `JINN_PROFILE_HOST_PUSH_TOKEN`. This credential grants write to the host content and
      nothing else: it must not carry write on `Jinn-Network/mono`, and it is not the manifest
      signing key. Setting the variable without the secret makes the job fail loudly rather
      than skip.
- [ ] Configure a static host for `spec.jinn.network` that preserves manifest paths exactly. The
      apex stays purely the product site and serves no protocol bytes.
- [ ] Serve each document with the media type declared by `manifest.json`, including extensionless
      task and facts profiles.
- [ ] Deploy one exact attested profile-root artifact per group; never rebuild them at the host.
      The normal path is the automatic `canary-host-refresh` above; the recipe below is the
      **break-glass** path, for when that refresh is unavailable — unconfigured, mid
      credential rotation, or restoring the host repository. Run by hand, it must honor the
      same mirror contract: replace the host content, do not overlay it, or a document
      withdrawn from the catalog stays served.
      Turn the attested roots into one deploy directory with
      `node .github/scripts/build-profile-host-bundle.mjs --root <sealed-platform-v1-root> --root <implementations-v1-root> --out <deploy-dir>`,
      which byte-copies the attested bytes of every group and generates one merged host
      configuration next to them. `--root` repeats because the origin is one deploy, not one
      per group; a document path claimed by two groups is refused before anything is written.
      `/manifest.json` and `/manifest.dsse.json` are deliberately not served, and the gate
      probes both as must-404s.
- [ ] *(gate)* `stable-live-host-verification` fetches `<release-group>/manifest.json` from the
      live domain, verifies its signature against the digest-pinned published key, and
      byte-compares every hosted document, media type and digest with the same-run attested
      artifact. It runs once per stack-published group against the one origin.
- [ ] *(gate)* It re-derives every served document's self-declared URI to the path it is served
      at, dereferences the registered identifiers, and probes for host fallback behavior.
- [ ] Record the source SHA, catalog digest, artifact/receipt identities, operator, public-key URL,
      and completion date.

Route budget: the merged deploy declares one `headers` entry per served path — today 760
documents (498 in `sealed-platform-v1`, 262 in `implementations-v1`) plus 4 per-group root
files, so 764 of the 1024-route configuration limit. The bundle generator warns at 900.

The gate is written and tested; what it has never had is a host to run against. Only after it
has run green against the live domain may the platform stable hold be reconsidered.

## Local host conformance

`.github/scripts/serve-profile-host.mjs` serves a deploy bundle over real HTTP, and
`.github/scripts/verify-local-profile-host.test.mjs` runs the gate's own CLI against it on an
ephemeral loopback port. Both run in CI on every pull request, hermetically: no egress, no
credentials, no host CLI.

What that proves: both stack-published groups merge into one deploy bundle that the gate
passes against once per group on the same origin, each verifying its own inventory; the
bundle is servable over real HTTP; the gate passes over a socket against
the whole real profile root, with the listener's own request log showing every declared document
fetched and answered and every anti-fallback probe refused; every hazardous served-path shape —
extensionless profiles, `@`-prefixed fixture directories, dot-version segments, deep fixture
paths, and files whose extension a host would type differently from the manifest — is served
byte-for-byte with its declared media type; every registered identifier the release set owns
dereferences, with each prefix registration refused at its bare identifier; and each modelled
host defect (trailing-slash redirect, single-page-application catch-all, mistyped extensionless
profile, mistyped `.schema.json`, one drifted document, an unserved or unverifiable signature
sidecar, a public key whose digest is not the pinned one) is a non-zero exit. A host appending
`charset=utf-8` still passes, as the gate documents. The server's strict 404 — no directory
index, no trailing-slash redirect, no extension guessing, no case folding, no percent-decoding,
no path normalization — is the reference behavior a real host must match.

Identifier resolution is what makes a loopback run meaningful rather than a shell. A document's
claimed identity is a property of its bytes, not of where those bytes are served: the same
attested artifact deployed to a preview URL still claims `spec.jinn.network`. So the gate
resolves every identifier — a document's own `$id` / `profile` and the catalog's registered
`resolvableIdentifiers` alike — against the canonical origin, then fetches the served path that
yields at the origin under verification. That split is also what lets the canary lane verify a
preview deployment before it is promoted. At the stable lane the two origins coincide, so the
split is a no-op there, and the suite asserts that over the real surface rather than arguing it.

What it does not prove: that Vercel interprets the generated `vercel.json` this way. The
conformance test reads that configuration against the reference server's behavior, which
validates this repository's reading of Vercel's documented `headers` / `cleanUrls` /
`trailingSlash` semantics, not Vercel's implementation of them. Nothing local can close that gap.

The first real deploy is therefore still the remaining verification, and the stable hold is
unchanged. The gate is what closes it, and it fails closed.
