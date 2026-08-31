# Profile-manifest signing keys

Public keys for the DSSE signature sidecar (`manifest.dsse.json`) that same-run
verification writes beside a profile root's `manifest.json`. Only public keys
live here; private keys exist solely as repository secrets
(`JINN_PROFILE_MANIFEST_SIGNING_KEY`, `JINN_PROFILE_MANIFEST_KEY_ID`) and are
generated outside this repository.

## Why a published key at all

`manifest.json` is the digest authority for the hosted copy of a profile root:
it binds every served path to a SHA-256 and a media type. A signature over
those bytes is what lets any party distinguish a manifest this repository's CI
produced from one a host, an account, or a mistaken upload substituted. The
static host is therefore not a trusted component — it serves bytes, and the
signature plus the pinned key decide whether those bytes count.

## Current key

| Field | Value |
| --- | --- |
| Key id | `jinn-profile-manifest-2026-08` |
| File | `jinn-profile-manifest-2026-08.pub` |
| Algorithm | Ed25519 |
| Canonical SPKI PEM SHA-256 | `72d2da98af867b65acb9c7c155741160cbf9f09431ea675dec4db24a50e4a90a` |

The digest is taken over the key re-exported as SPKI PEM, not over this file's
bytes, so line endings and trailing whitespace cannot change the pinned value.
`canonicalPublicKeySha256` in `.github/scripts/verify-live-profile-host.mjs` is
the sole definition.

## How the gate consumes it

`stable-live-host-verification` reads two repository variables:

- `JINN_PROFILE_MANIFEST_PUBLIC_KEY_URL` — a commit-pinned raw URL for the key
  file, so the served bytes cannot change under a fixed reference.
- `JINN_PROFILE_MANIFEST_PUBLIC_KEY_SHA256` — the canonical digest above.

The gate fetches the URL, refuses any key whose canonical digest is not the
pinned one, and only then verifies the signature sidecar retrieved from the
live host. Pinning the digest in a variable is what keeps the check meaningful
even when key and manifest are served by the same origin.

## Rotation

Add the new public key as a new file with a new dated key id; never overwrite a
published key, since historical signatures stay verifiable only while the key
that made them remains fetchable. Then update both secrets and both variables
in one change, and re-run the gate. A key is retired by ceasing to sign with
it, not by deletion.
