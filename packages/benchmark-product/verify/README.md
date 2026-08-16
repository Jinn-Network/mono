# @colophon-claims/verify

Verify a public Colophon claim bundle without the Colophon app or any execution runtime:

```sh
npx @colophon-claims/verify@2 ./bundle
```

Use `--json` for machine-readable output. The reader runs exactly six checks: manifest,
evidence closure, trust, matrix re-derivation, report verification, and claim consistency.
Exit status is `0` when all six pass, `1` for an invalid bundle, and `2` for usage or
operational failures.

Verifier 2 supports only the frozen public bundle v2 and binary-qualification
bundle v4 formats. It intentionally rejects the unrelated accounting bundle v3.
Existing claim-package/1 and public-bundle/2 bytes retain their literal
`@1.0.0`/`@1` reproduction commands; claim-package/2 and public-bundle/4 use
`@2.0.0`/`@2`.

Verification opens no network connection, reads no account or API credential, and uploads
nothing. It checks the bundle's integrity, evidence closure, calculations, report, and claim
consistency. It does not prove that the producing machine was honest or that the compared
identities are independent parties.
