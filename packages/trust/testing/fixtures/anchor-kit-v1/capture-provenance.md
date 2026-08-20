# anchor-kit-v1 — capture provenance

Where the two captured real tokens in this directory came from, and what they
are evidence of. Derived from the anchor-evidence program's P0 capture record
(2026-08-17); the full capture set — nine further tokens from other public
authorities, and three OpenTimestamps calendar responses — stays outside the
repository. Only what the kit asserts against is committed.

The anchor-evidence design (§11) requires **two captured real tokens from
independent public authorities, one RSA-signed and one ECDSA-signed, with their
real signer certificates**, to prove the parser handles production output.
Everything else in the kit is minted by the deterministic fixture authority in
`src/anchor-kit/fixture-authority.ts`, so the repository never embeds or
endorses a real authority's trust material.

## The kit payload

| | |
|---|---|
| Payload bytes | `Jinn anchor-evidence conformance kit: captured-proof payload v1\n` (64 bytes) |
| SHA-256 | `47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c` |
| Captured at | 2026-08-17T20:39:16Z |

This digest is the kit's single subject: the captured tokens' message imprints
and the minted tokens' imprints are all this value, so a verifier's
subject-comparison path is exercised by production bytes and kit bytes alike
(`KIT_SUBJECT_SHA256` in `src/anchor-kit/conformance.ts`).

## Request profile

RFC 3161 `TimeStampReq` over HTTP (`application/timestamp-query` POST), with:

- **SHA-256 message imprint** — the §6.1 algorithm floor;
- **`certReq` TRUE** — so the signer certificate travels inside the token and
  the proof is self-contained (§6.1, "Acquisition profile");
- **no nonce, deliberately** — a nonce protects a live requester against
  response replay, and imprint equality already gives a *stored* artifact
  everything replay could threaten. Omitting it also makes the request
  deterministic, which is what lets these captures be fixtures at all.

Both responses returned `PKIStatus: granted`; the committed `.der` files are the
bare `TimeStampToken` (the CMS `ContentInfo`), extracted from the response —
never the full `TimeStampResp`, which is why the record labels them
`application/vnd.etsi.timestamp-token` and not `application/timestamp-reply`
(§6.1, review finding S1).

## Committed tokens

| File | Authority endpoint | Signature algorithm (SignerInfo) | genTime | Bytes | SHA-256 |
|---|---|---|---|---|---|
| `token-digicert.der` | `http://timestamp.digicert.com` | `rsaEncryption` (1.2.840.113549.1.1.1), hash from the SignerInfo `digestAlgorithm` | 2026-08-17T20:37:55Z | 5987 | `eeafaa030a0ae9ab7ec10f1f68e0f6632e696da8b7883a99c00d28b041e2531a` |
| `token-sslcom.der` | `http://ts.ssl.com` | `ecdsa-with-SHA256` (1.2.840.10045.4.3.2) | 2026-08-17T20:37:56Z | 3842 | `fb4c2962fb88c12c1315afd99af8440eba134e2dde3f721e80ecfbdb22b571dc` |

Endpoints are recorded here as capture provenance only. They are never defaults
in source and never appear in any shipped configuration: the design's
standards-only constraint puts endpoints and trust roots on the operator's side
of the line (§7.3, §14).

**The bare `rsaEncryption` capture is load-bearing.** Real authorities emit it as
the SignerInfo `signatureAlgorithm`, leaving the hash to the SignerInfo
`digestAlgorithm` — which is why `ALLOWED_SIGNATURE_ALGORITHM_OIDS` admits the
OID and why `AnchorSignatureVerificationInput` carries `digestAlgorithmOid` as
the authoritative hash source rather than letting a platform default decide. A
kit without this capture would have let a verifier pass while defaulting to
SHA-256 for every `rsaEncryption` token.

## What these fixtures are not

- **Not trust material.** Neither authority's root is committed, so the
  conformance suite runs the captured tokens only on the no-trust-material path,
  where the honest outcome is `present` (§4.3): internally consistent, time
  basis not evaluated.
- **Not a wall-clock assertion.** Both `genTime` values are historical and both
  certificates will eventually expire. Validity is asserted against each
  fixture's own window, never against the clock the test happens to run under
  (§11).
- **Not an endorsement.** Verification *identifies* an authority; it never
  endorses one. Which authorities' time a reader accepts stays that reader's
  trust decision (§4.2).

## Not committed

- The other nine captured tokens (further RSA variants, and one
  `ecdsa-with-SHA512` capture). They informed the P1 signature-algorithm
  allowlist; committing them would grow the append-only fixture surface with no
  additional rule coverage.
- The three OpenTimestamps calendar responses. The kit's OpenTimestamps proofs
  are built deterministically (`src/anchor-kit/ots-builder.ts`); a real
  chain-complete `.ots` proof arrives with the OpenTimestamps provider packet,
  when there is a verifier to check it.
