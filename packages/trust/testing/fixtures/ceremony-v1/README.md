# ceremony-v1

The ceremony goldens (EOA SIWE, Safe 1271 + signed witness, agentId
composition, OIDC machine, GitHub human -- §7.2) are executable fixtures
in `src/conformance.ts`'s "ceremony goldens" battery, built by
`src/fixtures.ts` and `src/crypto.ts` rather than static JSON.

Why executable, not static: the EOA leg needs a genuine, independently
re-verifiable secp256k1/EIP-191 signature (`verify.ts`'s `verifyEoaCeremony`
recomputes it) -- a hand-maintained static signature would drift from the
digest/content it signs the moment either side changed. `src/crypto.ts`'s
`createEoaTestSigner` produces real, deterministic signatures instead.
The remaining ceremony types (Safe/agentId/OIDC-machine/GitHub-human) are
resolver-trusted per §7.2's design (`verify.ts`'s `verifyCeremonyLeg`
accepts a non-null `ResolvedBinding` for them without re-verification --
that verification is `trust-resolve`'s job, already covered by its own
`witness.test.ts`/`binding-resolver.test.ts`, T12/T13), so their kit
fixtures need no cryptographic evidence at all.
