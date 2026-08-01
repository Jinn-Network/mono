# Hosting the jinn.network profile root

**Scope:** serving every reserved `https://jinn.network/…` identifier a profile or schema
document self-declares (`profiles/…` for JSON Schemas, `records/…/facts/…` for
record-discovery facts profiles, `task-profiles/…` for task profiles) so that external
conformance claims become possible. Design:
`docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`
§8.1 (digest-bound identifiers) and §8.4 (the URI resolution gate). Issue #2293 rider 1.

## What CI produces

Every run of `.github/workflows/stack-npm-publish.yml` uploads a `jinn-profile-root`
artifact containing:

- every profile or schema document that self-declares a `https://jinn.network/…` identifier
  (`$id` for a JSON Schema, `profile` for a record-discovery facts document), served at the
  exact path that identifier names — `.github/scripts/build-profile-root.mjs` remaps by
  declared identifier rather than by source directory, and
  `.github/scripts/build-profile-root.test.mjs` guards the match against the real repository.
  A document with no such declared identifier (specification prose, JSON-LD vocabularies,
  fixtures) is served at its source-directory path instead, since it makes no URI claim to
  violate. `.sha256` sidecars are the one exception: they are deliberately not served at all
  (`.github/scripts/build-profile-root.mjs` skips every `*.sha256` file outright) because a
  sidecar computed against the source-tree bytes would silently disagree with
  `manifest.json`'s own digest of the served copy once identifier-based remapping moves a
  document off its source path. `manifest.json` is the sole digest surface for the profile
  root; the sidecars remain available inside the npm package for consumers that want them;
- `manifest.json` — a SHA-256 digest of every served document, with its media type and
  source package;
- `manifest.dsse.json` — a DSSE envelope over `manifest.json`'s exact bytes, present only
  when a signing key is provisioned.

`manifest.json`'s bytes never depend on whether a key exists; the signature is a sidecar.

## Why the digests matter

The profile URI is the name; the digests are the binding. A conformance claim cites document
digests, not bare URIs, so a hosting compromise or a quiet redeploy is detectable. Serving
the documents without the manifest reintroduces trust-the-host into a stack whose every
other link is a hash.

## Deviation from the plan's source-directory list (D10)

The implementation plan's Task 17 specifies `PROFILE_SOURCE_DIRECTORIES = ['profiles',
'profile', 'schemas']`. `.github/scripts/build-profile-root.mjs` ships `['profiles',
'profile']` — the bare top-level `schemas` entry is deliberately dropped, not a missed
implementation step. No document under either package's bare top-level `schemas/`
(`task-execution-protocol`, `benchmarking-records`) declares a `$id`, and no
`https://jinn.network/schemas/...` identifier exists anywhere under `packages/`, so walking
that directory would only ever produce source-path fallback entries with no
`jinn.network` identity to protect. A `schemas/` nested under `profiles/` or `profile/`
(as `evidence-protocol` and `evidence-repository-oci` do) is still walked, because that
recursion happens through the `profiles`/`profile` entries above it, not through a bare
top-level `schemas` entry. This is a ratified deviation, not an open item — do not "restore"
the third entry without first re-deriving that a bare top-level `schemas/` document has
grown a declared identifier.

## Human checklist: hosting and key provisioning

None of this can be automated from this repository. An operator with control of the
`jinn.network` domain and the org's GitHub settings must:

- [ ] Generate an ed25519 signing key for the profile manifest, offline, and keep the
      private key out of this repository.
- [ ] Add the private key as the GitHub Actions secret `JINN_PROFILE_MANIFEST_SIGNING_KEY`
      (PKCS#8 PEM) on `Jinn-Network/mono`.
- [ ] Add the key identifier as the GitHub Actions variable `JINN_PROFILE_MANIFEST_KEY_ID`.
- [ ] Publish the corresponding **public** key at a stable URL and record that URL here, so a
      verifier can check `manifest.dsse.json` without asking anyone.
- [ ] Point `jinn.network` at a static host.
- [ ] Configure the host to serve the `jinn-profile-root` artifact's contents at the domain
      root, preserving paths exactly.
- [ ] Serve each document with the `mediaType` its own `manifest.json` entry declares, not a
      static per-extension rule — a record-discovery facts profile and a task profile are
      served at an extension-less path (their declared identifier has none) and still need
      `Content-Type: application/json`.
- [ ] Verify a resolution end to end:
      `curl -sSf https://jinn.network/profiles/execution-evidence/1.0/schemas/dsse-envelope.schema.json | sha256sum`
      and confirm the digest matches `manifest.json`.
- [ ] Record the date, the operator's handle, and the public-key URL in this file when
      complete.

Until every box is ticked, no external party can make a conformance claim (design §8.4
item 1), and that limitation is stated, not hidden.
