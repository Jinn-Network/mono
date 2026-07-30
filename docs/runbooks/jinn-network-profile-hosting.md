# Hosting the jinn.network profile root

**Scope:** serving the reserved `https://jinn.network/profiles/…` and
`https://jinn.network/schemas/…` identifiers so that external conformance claims become
possible. Design: `docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`
§8.1 (digest-bound identifiers) and §8.4 (the URI resolution gate). Issue #2293 rider 1.

## What CI produces

Every run of `.github/workflows/stack-npm-publish.yml` uploads a `jinn-profile-root`
artifact containing:

- the profile and schema documents at the exact paths their URIs name;
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
- [ ] Serve `application/schema+json` for `*.schema.json` and `text/markdown` for `*.md`, as
      `manifest.json` declares.
- [ ] Verify a resolution end to end:
      `curl -sSf https://jinn.network/profiles/task-execution/1.0/... | sha256sum` and confirm
      the digest matches `manifest.json`.
- [ ] Record the date, the operator's handle, and the public-key URL in this file when
      complete.

Until every box is ticked, no external party can make a conformance claim (design §8.4
item 1), and that limitation is stated, not hidden.
