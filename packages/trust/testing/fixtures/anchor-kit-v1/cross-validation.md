# anchor-kit-v1 — cross-validation against an independent verifier

The anchor-evidence design §11 requires it, and the reason is structural: the
kit's DER encoder is built on `trust-core`'s own reader primitives, so a
kit-minted token proves nothing about whether that reader is *right* — the two
share their mistakes. The independence has to come from outside the tree.

So every kit-minted token is cross-validated once, at fixture creation, against
an independent RFC 3161 implementation, and the transcript is recorded here. The
commands below run against the committed bytes in this directory and need no
files from outside it: the authority certificate is extracted from the token that
carries it.

| | |
|---|---|
| Verifier | OpenSSL 3.6.3 (9 Jun 2026) |
| Run at | 2026-08-17T21:59Z |
| Working directory | `packages/trust/testing/fixtures/anchor-kit-v1` |
| Kit token | `kit-token-canonical.der`, sha256 `726e33332520537276ca8d0fe20d5b25ccd0eeb4b95cf3bfce06d4924673c8c0` |
| Kit subject digest | `47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c` |

`kit-token-canonical.der` is exactly what
`createAnchorKitFixtures().authority.mintTimeStampToken({ subjectSha256 })`
mints; `src/anchor-kit/real-tokens.test.ts` fails if the builders ever drift from
these bytes, which is what keeps this transcript describing a token that exists.

## 1. The kit-minted token verifies under an independent implementation

Extract the signer certificate the token carries, then verify the token against
it as the sole trust anchor — the same posture the kit's own verifier
configuration takes, and the only one that could ever yield `verified` (§4.3,
§8 step 3).

```
$ openssl pkcs7 -inform DER -in kit-token-canonical.der -print_certs -out kit-authority.pem
$ head -2 kit-authority.pem
subject=CN=Jinn anchor kit fixture authority (anchor-kit-v1)
issuer=CN=Jinn anchor kit fixture authority (anchor-kit-v1)

$ openssl ts -verify \
    -digest 47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c \
    -in kit-token-canonical.der -token_in -CAfile kit-authority.pem
Using configuration from /opt/homebrew/etc/openssl@3/openssl.cnf
Verification: OK
```

`Verification: OK` covers, independently of any Jinn code: the CMS structure, the
single SignerInfo, the signed attributes, **the ECDSA signature over the
`signedAttrs` SET OF re-encoding** (§6.1 rule 8), the ESS
`SigningCertificateV2` binding (rule 6), the `sid` consistency (rule 7), the
message-imprint equality against the supplied digest (rule 12), the `tsa` name
correspondence (rule 10), the certificate chain, and OpenSSL's own
timestamp-signing purpose check on the certificate — extended key usage present,
sole, and critical (rule 9).

## 2. The token's own facts, read by the independent parser

```
$ openssl ts -reply -in kit-token-canonical.der -token_in -text
Status info:
Status: Granted.
Status description: unspecified
Failure info: unspecified

TST info:
Version: 1
Policy OID: 2.999.1
Hash Algorithm: sha256
Message data:
    0000 - 47 fe 37 68 e1 64 b8 66-3d d4 da 74 3c 8f 41 6f   G.7h.d.f=..t<.Ao
    0010 - a0 96 58 c6 52 f2 16 17-f4 5e ea 8a 5a 8a 70 5c   ..X.R....^..Z.p\
Serial number: 0x0102030405060708090A0B0C0D0E0F10
Time stamp: Aug 17 12:00:00 2026 GMT
Accuracy: 0x01 seconds, unspecified millis, unspecified micros
Ordering: no
Nonce: unspecified
TSA: DirName:/CN=Jinn anchor kit fixture authority (anchor-kit-v1)
Extensions:
```

Every fact the kit expects a conformant verifier to extract is here, read by an
implementation that shares no code with this repository: policy `2.999.1` (the
ITU-T example arc), serial `0102030405060708090a0b0c0d0e0f10`, `genTime`
2026-08-17T12:00:00Z, SHA-256 imprint equal to the kit subject digest, and no
nonce.

```
$ openssl asn1parse -inform DER -in kit-token-canonical.der | head -12
    0:d=0  hl=4 l=1009 cons: SEQUENCE
    4:d=1  hl=2 l=   9 prim: OBJECT            :pkcs7-signedData
   15:d=1  hl=4 l= 994 cons: cont [ 0 ]
   19:d=2  hl=4 l= 990 cons: SEQUENCE
   23:d=3  hl=2 l=   1 prim: INTEGER           :03
   26:d=3  hl=2 l=  13 cons: SET
   28:d=4  hl=2 l=  11 cons: SEQUENCE
   30:d=5  hl=2 l=   9 prim: OBJECT            :sha256
   41:d=3  hl=3 l= 185 cons: SEQUENCE
   44:d=4  hl=2 l=  11 prim: OBJECT            :id-smime-ct-TSTInfo
   57:d=4  hl=3 l= 169 cons: cont [ 0 ]
   60:d=5  hl=3 l= 166 prim: OCTET STRING      [HEX DUMP]:3081A302010106038837013...
```

Definite-length throughout, `SignedData` version 3 (the value RFC 5652 requires
when `eContentType` is not `id-data`), one digest algorithm, and the
encapsulated `id-ct-TSTInfo`.

## 3. The captured real tokens parse under the same independent parser

```
$ openssl ts -reply -in token-digicert.der -token_in -text
TST info:
Version: 1
Policy OID: 2.16.840.1.114412.7.1
Hash Algorithm: sha256
Message data:
    0000 - 47 fe 37 68 e1 64 b8 66-3d d4 da 74 3c 8f 41 6f   G.7h.d.f=..t<.Ao
    0010 - a0 96 58 c6 52 f2 16 17-f4 5e ea 8a 5a 8a 70 5c   ..X.R....^..Z.p\
Serial number: 0xCE28E208030DB02FF8CA617585729ED5
Time stamp: Aug 17 20:37:55 2026 GMT
Accuracy: unspecified
Ordering: no
Nonce: unspecified
TSA: unspecified

$ openssl ts -reply -in token-sslcom.der -token_in -text
TST info:
Version: 1
Policy OID: 1.3.6.1.4.1.38064.1.3.6.1
Hash Algorithm: sha256
Message data:
    0000 - 47 fe 37 68 e1 64 b8 66-3d d4 da 74 3c 8f 41 6f   G.7h.d.f=..t<.Ao
    0010 - a0 96 58 c6 52 f2 16 17-f4 5e ea 8a 5a 8a 70 5c   ..X.R....^..Z.p\
Serial number: 0x5628FA1ED557B610
Time stamp: Aug 17 20:37:56 2026 GMT
Accuracy: 0x01 seconds, unspecified millis, unspecified micros
Ordering: no
Nonce: unspecified
TSA: unspecified
```

Both imprints are the kit subject digest. Neither carries a `tsa` field, which is
why §6.1 rule 10 is conditional on the field being present — a rule that demanded
it would refuse production output from two independent authorities.

The SignerInfo signature algorithms, which the kit asserts structurally:

```
$ openssl asn1parse -inform DER -in token-digicert.der | tail -4
 5456:d=5  hl=2 l=  13 cons: SEQUENCE
 5458:d=6  hl=2 l=   9 prim: OBJECT            :rsaEncryption
 5469:d=6  hl=2 l=   0 prim: NULL
 5471:d=5  hl=4 l= 512 prim: OCTET STRING      [HEX DUMP]:11A0D8A07F4C0B86...

$ openssl asn1parse -inform DER -in token-sslcom.der | tail -3
 3757:d=5  hl=2 l=  10 cons: SEQUENCE
 3759:d=6  hl=2 l=   8 prim: OBJECT            :ecdsa-with-SHA256
 3769:d=5  hl=2 l=  71 prim: OCTET STRING      [HEX DUMP]:3045022001CD6C8C...
```

Bare `rsaEncryption` with NULL parameters, and `ecdsa-with-SHA256`. The RSA
capture names no hash at all — the SignerInfo `digestAlgorithm` supplies it —
which is the production fact the P1 allowlist and the `digestAlgorithmOid` port
field exist to handle.

Neither token is verified here: their authorities' roots are not committed and
never will be, so the independent verifier has nothing to chain them to, exactly
as the kit's own suite reports them `present` rather than `verified`.

## 4. The negative fixtures, checked against the same implementation

Each of the twenty-nine RFC 3161 negatives was minted and run through
`openssl ts -verify -digest <subject> -token_in -CAfile kit-authority.pem`
(the wrong-subject case supplies the unrelated digest its own case declares).
Twenty-three are independently refused, with the reason OpenSSL gives:

| Kit negative | OpenSSL |
|---|---|
| a valid token against another subject digest | `ts_check_imprints: message imprint mismatch` |
| a truncated token | `asn1_d2i_read_bio: not enough data` |
| outer contentType is not id-signedData | `asn1_check_tlen: wrong tag` |
| eContentType is not id-ct-TSTInfo | `PKCS7_to_TS_TST_INFO: bad pkcs7 type` |
| TSTInfo version is not 1 | `int_ts_RESP_verify_token: unsupported version` |
| two SignerInfos | `TS_RESP_verify_signature: there must be one signer` |
| signedAttrs absent | `OSSL_ESS_check_signing_certs: missing signing certificate` |
| messageDigest attribute is not the eContent digest | `PKCS7_signatureVerify: digest failure` |
| eContent tampered against a valid messageDigest | `PKCS7_signatureVerify: digest failure` |
| SHA-1 message imprint | `ts_check_imprints: message imprint mismatch` |
| SHA-1 SignerInfo digest algorithm | `EVP_PKEY_verify: provider signature failure` |
| SHA-1 signature algorithm | `EVP_PKEY_verify: provider signature failure` |
| SigningCertificateV2 names an unembedded certificate | `ess_lib: ess cert id not found` |
| no embedded signer certificate | `PKCS7_get0_signers: signer certificate not found` |
| sid inconsistent with the identified certificate | `PKCS7_get0_signers: signer certificate not found` |
| signature over eContent instead of signedAttrs | `EVP_PKEY_verify: provider signature failure` |
| signature made by a different key | `EVP_PKEY_verify: provider signature failure` |
| extended key usage with an additional usage | `ts_verify_cert: certificate verify error` |
| no extended key usage extension | `ts_verify_cert: certificate verify error` |
| tsa name not among the certificate's subject names | `int_ts_RESP_verify_token: tsa name mismatch` |
| genTime without the Zulu designator | `asn1_ex_c2i: generalizedtime is too short` |
| genTime without seconds | `asn1_ex_c2i: generalizedtime is too short` |
| messageImprint is not the subject digest | `ts_check_imprints: message imprint mismatch` |

Two things this establishes. First, the mutations are real: an independent
implementation, given the same bytes, reaches the same refusal for its own
reasons. Second, the fixtures are not merely *different* from the valid token —
they are broken in the specific way each is named for.

### Where this profile is deliberately stricter

The remaining six negatives are accepted by OpenSSL (`Verification: OK`) and
refused by §6.1. Each is a rule the design added on purpose, and each is a
reason the profile could not have been left as "whatever an off-the-shelf
verifier accepts":

| Kit negative | §6.1 rule | Why the profile refuses what OpenSSL accepts |
|---|---|---|
| unknown **critical** TSTInfo extension | rule 2 | An extension marked critical says "refuse if you do not understand me". v1 understands none, so any critical extension is a refusal — the alternative is silently ignoring a field the authority marked as mandatory. |
| `contentType` signed attribute names `id-data` | rule 4 | The attribute must equal `id-ct-TSTInfo`. OpenSSL verifies the signature over the attributes without cross-checking this one against the encapsulated type, which leaves a signed statement about the wrong content type unremarked. |
| v1 `SigningCertificate` attribute (ESSCertID) | rule 6 | ESSCertID's `certHash` is SHA-1 **by definition**. OpenSSL still accepts the v1 attribute; the SHA-256 floor applies at every layer a digest can appear, so v1 is refused and `SigningCertificateV2` is required. |
| `genTime` outside the certificate validity window | rule 11 | OpenSSL validates the chain at the wall clock, not at `genTime`. A token whose asserted instant lies outside the window its own signer was valid for asserts a time that certificate had no authority to assert. |
| `genTime` with trailing fractional zeros | rule 11 | `20260817120000.500Z` is legal BER and illegal DER. Where one instant has two encodings, a byte-compared fact has two spellings. |
| indefinite-length outer encoding | parsing discipline | CMS in DER is definite-length. Accepting BER widens the attack surface for no interoperability gain — no authority emits it, and every re-encoding question it opens is a question about which bytes were signed. |

One refusal in the table above agrees by accident and is worth naming: OpenSSL
refuses the **SHA-1 message imprint** with `message imprint mismatch`, because
the 20-byte imprint does not equal the 32-byte digest it was handed. §6.1 rule 5
refuses it on the algorithm floor, before any comparison — which is the refusal
that still holds against an attacker who supplies a matching SHA-1 preimage.
Same outcome here, different reason, and only one of the two reasons survives
contact with a collision.

## 5. OpenTimestamps serialization, corroborated against a real calendar response

The `.ots` builders are checked against the format's published constants in
`src/anchor-kit/ots-builder.test.ts`. They were additionally checked, at
authoring time, against one of the real calendar responses captured in the
program's P0 gate (not committed — see `capture-provenance.md`). Its trailing
bytes:

```
...  08  f1 04 6a 83 71 73  f0 08 8a d2 09 08 44 84 f9 94  00
     83 df e3 0d 2e f9 0c 8e  2e  2d
     68 74 74 70 73 3a 2f 2f 61 6c 69 63 65 2e 62 74 63 ...
```

which decodes as: `sha256` (`08`) · `prepend`(4 bytes) · `append`(8 bytes) ·
`0x00` (attestation marker) · the pending-attestation tag
`83dfe30d2ef90c8e` · varbytes(0x2e = 46) wrapping varbytes(0x2d = 45) wrapping
the calendar URI. Note that the last operation before the attestation is the
`append`, not a hash: the calendar's promise covers the message as it stands at
that point in the path. That is byte-for-byte the shape
`serializeDetachedOtsProof` produces, including the doubly length-prefixed URI
payload.

The same capture is what pinned the **ordering** rules the builders follow.
Attestations sort by class tag, then by URI *string* for a calendar promise and
by *numeric* height for a Bitcoin attestation; operations sort by tag, then by
argument bytes. Sorting the serialized bytes instead agrees on the cross-class
order and disagrees within a class, because both payloads are length-prefixed —
for the alice and bob calendars it emits bob first where the reference emits
alice. A proof the reference tooling reserializes differently is a proof whose
carried bytes are not the bytes anyone else computes, which is the one property
§5 rule 2 depends on.
