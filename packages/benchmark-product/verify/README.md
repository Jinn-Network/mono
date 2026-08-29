# @colophon-claims/verify

Verify a public Colophon claim bundle without the Colophon app or any execution runtime:

```sh
npx @colophon-claims/verify@0.2 ./bundle
```

Use `--json` for machine-readable output. The reader runs the checks declared by the
bundle format, covering its manifest, evidence closure, calculations, report, and claim
consistency. Exit status is `0` when the bundle is valid for the format and profile it
declares, `1` for an invalid bundle, and `2` for usage or operational failures. A check a
profile defers is reported as deferred, never as passed, and never as a failure.

This 0.2 reader supports public bundle formats v2, v4, v5, v6, and v7. It intentionally
rejects the unrelated accounting bundle v3. Formats v2 and v4 run six checks; the
evidence-native v5 and the two anchored formats, v6 and v7, run seven. The v7 format is
the anchored binary-qualification closure — v4's members plus v6's anchors — and it
exists only from this 0.2.1 release, so its bundles pin `@0.2.1` rather than the `@0.1`
line every earlier closure stamps.
The evidence-native v5 has two declared profiles, full-evidence and metadata-first;
this reader supports both. A metadata-first bundle carries the artifact digests without
the artifact bodies, so `artifact-integrity` reports `not fetched` rather than passing,
and the verdict line counts it out of the passed total. Every other check is complete.
Existing claim bundles retain their recorded verifier pins. Use this 0.2 reader
for prompted-screening v2 support and the compatible `@0.2` line for this
release.
For this one-time prompted-screening v2 release, `@jinn-network/*` is pinned to
the exact `0.1.0-canary.sha.e00b2fc47fc5635b007eb349fb1e41aa81bb3c50` receipt.
It is not a floating `@canary` dependency and is not a stable stack release.

Verification opens no network connection, reads no account or API credential, and uploads
nothing. It checks the bundle's integrity, evidence closure, calculations, report, and claim
consistency. It does not prove that the producing machine was honest or that the compared
identities are independent parties.

## Freeze-artifact repositories

A qualification bundle (v4 or v7) can be projected into a public repository of its freeze
artifacts — item bank, sources, admission decisions, labels, judge instruments, and the
screening material. That repository is a **derived artifact, never the claim of record**:
the sealed records stay the source of truth, and the tree is a pure function of the bundle,
so anyone can regenerate it and diff it. To check a published one against its bundle:

```sh
npx @colophon-claims/verify@0.2 ./bundle --freeze-repo ./published-repo
```

Exit status is `1` when the tree does not match, and every missing, unexpected, or changed
member is named. The check is byte-for-byte and also reports the git-visible drift that
leaves bytes untouched — an executable bit, or a member replaced by a symlink — because
those move the commit oid a freeze announcement pins. Rendering a repository from a bundle
is `colophon freeze-repo export` in the product CLI; the layout and the licence scaffolding
are specified in `../PUBLIC-BUNDLE.md`.

Bundles are also verifiable without this package: `../EXTERNAL-VERIFICATION.md` specifies
the external path (openssl plus a dependency-free script, shipped here as
`scripts/external-verify.py`), the JSON Schemas under `schemas/`, and the conformance kit
under `fixtures/public-bundle-conformance-v1/` for testing an independent verifier.

## What this does not yet prove

Protocol identifiers in the installed platform packages name `https://spec.jinn.network/…`.
That origin is not hosted yet. This verifier checks the bundle against the exact
`@jinn-network/*` bytes installed from npm. A third party who fetches those identifiers
from the live origin will not retrieve them.
