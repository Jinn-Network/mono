# @colophon-claims/verify

Verify a public Colophon claim bundle without the Colophon app or any execution runtime:

```sh
npx @colophon-claims/verify@0.1 ./bundle
```

Use `--json` for machine-readable output. The reader runs the checks declared by the
bundle format, covering its manifest, evidence closure, calculations, report, and claim
consistency. Exit status is `0` when every check passes, `1` for an invalid bundle, and
`2` for usage or operational failures.

This 0.1 reader supports public bundle formats v2, v4, v5, and v6. It intentionally
rejects the unrelated accounting bundle v3. Formats v2 and v4 run six checks; the
evidence-native v5 and anchored v6 formats run seven.
New claims stamp `npx @colophon-claims/verify@0.1.0` and the compatible
`@0.1` line.

Verification opens no network connection, reads no account or API credential, and uploads
nothing. It checks the bundle's integrity, evidence closure, calculations, report, and claim
consistency. It does not prove that the producing machine was honest or that the compared
identities are independent parties.

Bundles are also verifiable without this package: `../EXTERNAL-VERIFICATION.md` specifies
the external path (openssl plus a dependency-free script, shipped here as
`scripts/external-verify.py`), the JSON Schemas under `schemas/`, and the conformance kit
under `fixtures/public-bundle-conformance-v1/` for testing an independent verifier.

## What this does not yet prove

Protocol identifiers in the installed platform packages name `https://spec.jinn.network/…`.
That origin is not hosted yet. This verifier checks the bundle against the exact
`@jinn-network/*` bytes installed from npm. A third party who fetches those identifiers
from the live origin will not retrieve them.
