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

Checking opens no network connection, reads no account or API credential, and uploads
nothing. It checks the bundle's integrity, evidence closure, calculations, report, and claim
consistency. It does not prove that the producing machine was honest or that the compared
identities are independent parties.

Bundles are also verifiable without this package: `../EXTERNAL-VERIFICATION.md` specifies
the external path (openssl plus a dependency-free script, shipped here as
`scripts/external-verify.py`), the JSON Schemas under `schemas/`, and the conformance kit
under `fixtures/public-bundle-conformance-v1/` for testing an independent verifier.

## What this does not yet prove

The `https://…`-shaped protocol identifiers that appear inside record files and in `--json`
are internal names, not addresses this tool reads. `spec.jinn.network` is one of them, and it
is not hosted. Checking uses the exact `@jinn-network/*` bytes installed from npm and fetches
nothing from the web, so a name that resolves to nothing changes no result here. A third party
who treats one of those names as a live URL will not retrieve a document.
