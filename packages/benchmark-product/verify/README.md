# @colophon-claims/verify

Verify a public Colophon claim bundle without the Colophon app or any execution runtime:

```sh
npx @colophon-claims/verify@0.2 ./bundle
```

Use `--json` for machine-readable output. The reader runs the checks the bundle's declared
format closes over, and its verdict names each one — different formats close over different
checks, so the list is the bundle's, not this README's. Exit status is `0` when the bundle
is valid for the format and profile it declares, `1` for an invalid bundle, and `2` for
usage or operational failures. A check a profile defers is reported as deferred, never as
passed, and never as a failure.

This 0.2 reader supports public bundle formats v2, v4, v5, v6, v7, and v8. It
intentionally rejects the unrelated accounting bundle v3. Formats v2 and v4 run six
checks; the evidence-native v5 and the two anchored formats, v6 and v7, run seven; the
disclosed v8 runs eight. The v7 format is the anchored binary-qualification closure —
v4's members plus v6's anchors — and v8 is v7 plus a sealed six-variable
disclosure-specification record and the `disclosure-specification` check. Both exist
only from this 0.2.1 release, so their bundles pin `@0.2.1` rather than the `@0.1` line
every earlier closure stamps.
The evidence-native v5 has two declared profiles, full-evidence and metadata-first;
this reader supports both. A metadata-first bundle carries the artifact digests without
the artifact bodies, so `artifact-integrity` reports `not fetched` rather than passing,
and the verdict line counts it out of the passed total. Every other check is complete.
Existing claim bundles retain their recorded verifier pins. Use this 0.2 reader
for prompted-screening v2 support and the compatible `@0.2` line for this
release.
For this release, `@jinn-network/*` is pinned to the exact
`0.1.0-canary.sha.0533a224cf99f06d7facf0c23455f2781a5b9e62` receipt.
It is not a floating `@canary` dependency and is not a stable stack release.

Verification opens no network connection, reads no account or API credential, and uploads
nothing. It recomputes the checks the bundle's declared format closes over, against the bytes
the bundle carries and nothing else. It does not prove that the producing machine was honest
or that the compared identities are independent parties.

## Freeze-artifact repositories

A qualification bundle (v4, v7, or v8) can be projected into a public repository of its freeze
artifacts — item bank, sources, admission decisions, labels, judge instruments, and the
screening material. That repository is a **derived artifact, never the claim of record**:
the sealed records stay the source of truth, and the tree is a pure function of the bundle,
so anyone can regenerate it and diff it. To check a published one against its bundle:

```sh
npx @colophon-claims/verify@0.2 ./bundle --freeze-repo ./published-repo
```

Exit status is `1` when the tree does not match, and every missing, unexpected, or changed
member is named. The check is byte-for-byte and also reports the git-visible drift that
leaves bytes untouched — a member replaced by a symlink, and an executable bit wherever the
filesystem holding the tree carries one — because those move the commit oid a freeze
announcement pins. `executableBitChecked` reports whether that second dimension was read,
and where it was not the report names which of the two reasons applied. Rendering a
repository from a bundle is `colophon freeze-repo export` in the product CLI; the layout
and the licence scaffolding are specified in `../PUBLIC-BUNDLE.md`.

The rendered tree's format is `colophon-freeze-repo/2`. The `/1` renderer stated a source
`downloadLocation` and a `supplier` its record did not support, and refused an ordinary
dual licence such as `Apache-2.0 OR MIT` outright; correcting those changes the rendered
bytes, so it is a format bump rather than silent drift, and a tree published under `/1`
reports drift against this version. Regenerate and republish it.

Three API notes for anyone embedding this package rather than running its binary. `runVerifierCli`'s
`deps.verify` test seam now returns `VerifiedPublicBundleSnapshot` (the verification **and** the
snapshot) rather than the verification alone, so `--freeze-repo` renders from the same
authenticated snapshot the reported verdict came from instead of verifying the bundle a second
time without the caller's trust material. A supplied `verify` stub must be updated. Alongside it,
`verifyFreezeRepoSnapshot(snapshot, repoDir)` is exported for callers that already hold a verified
snapshot; `verifyFreezeRepo(bundleDir, repoDir, deps)` is unchanged. For the same reason,
`deps.freezeRepo` takes `(snapshot, repoDir)` rather than `(bundleDir, repoDir)`: the seam stands in
for the snapshot-rendering path the CLI actually runs, so a seam typed against the directory would
document a call the CLI no longer makes.

Bundles are also verifiable without this package: `../EXTERNAL-VERIFICATION.md` specifies
the external path (openssl plus a dependency-free script, shipped here as
`scripts/external-verify.py`), the JSON Schemas under `schemas/`, and the conformance kit
under `fixtures/public-bundle-conformance-v1/` for testing an independent verifier.

## What this does not yet prove

Protocol identifiers in the installed platform packages name `https://spec.jinn.network/…`.
That origin is not hosted yet. This verifier checks the bundle against the exact
`@jinn-network/*` bytes installed from npm. A third party who fetches those identifiers
from the live origin will not retrieve them.
