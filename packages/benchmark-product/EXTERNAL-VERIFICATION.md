# External verification of public bundles

How any external verifier — a person with standard tools, or a third-party
verification project — checks a benchmark-product public bundle without
installing or running any Jinn code. The record formats are frozen; everything
below is checkable from the bundle's own bytes. [`PUBLIC-BUNDLE.md`](PUBLIC-BUNDLE.md)
is the format reference; this document is the verification path.

## What verification proves, and what it does not

Read this table first. It is the whole point of the document.

| Claim | Provable with your own tools | Provable only with the reference verifier | Provable by no tool |
| --- | --- | --- | --- |
| Every file matches the manifest's byte length and SHA-256 | yes | | |
| Every content-addressed record's bytes hash to its own name | yes | | |
| `report.json` is byte-identical to the signed DSSE payload | yes | | |
| The report signature verifies (Ed25519, DSSE v1) against the bundle-carried key | yes | | |
| The signed report pins the matrix by digest, and every matrix cell's verdict references resolve to cataloged records naming that cell | yes | | |
| The full evidence graph closes (submissions, deliveries, evaluation tasks, roles) | | yes | |
| Every verdict is a DSSE-signed in-toto statement verifying against its named evaluator key | yes | | |
| `did:key` and evaluator key ids derive from the carried public keys | yes | | |
| The claim package's stored headline mirrors the signed report's results (headline-shaped claims; a comparison-shaped claim has no headline to mirror and the check reports `skipped`) | yes | | |
| The matrix is the correct aggregation of the evidence graph (re-derivation, byte-exact) | | yes | |
| The report's statistics are the correct output of its named method (recompute) | | yes | |
| The claim package is the exact projection of the verified records | | yes | |
| The presentation files (report page, badge, card) are exact projections of the records | | yes | |
| The producing venue was honest | | | correct — no tool |
| Distinct signing keys belong to independent real-world parties | | | correct — no tool |
| The isolation policy was actually strong | | | correct — no tool |
| Cost figures were independently settled | | | correct — no tool |

External verifiability never upgrades a claim: a verified signature on a
self-run bundle is still a self-run bundle. Every bundle states this about
itself; the sentences below are carried verbatim in `claim-package.json`
`limitations` and `venueHonesty`:

- This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.
- Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.
- Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.
- Cost figures, where present, are self-reported by this venue and were never independently settled.
- Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties.

The trust root is equally blunt, from `claim-package.json` `verification.trustRoot`:
"Signatures verify against the bundle-carried public keys minted by this
workspace; there is no third-party trust anchor on the self-run venue."

## The record family

A `benchmark-product-public-bundle/2` bundle is one directory:

| File | Format literal | Schema (in this package, `schemas/`) |
| --- | --- | --- |
| `bundle.json` | `benchmark-product-public-bundle/2` | `bundle-manifest.schema.json` |
| `benchmark.json`, `run.json`, `matrix.json`, `report.json` | sealed benchmarking records | platform schemas (see Identifier note) |
| `report-envelope.json` | DSSE v1 envelope | `dsse-envelope.schema.json` |
| `claim-package.json` | `benchmark-product.claim-package/1` (or `/2`) | `claim-package.schema.json` |
| `evidence.json` | `benchmark-product-evidence-catalog/2` | `evidence-catalog.schema.json` |
| `verdicts.json` | `benchmark-product-verdict-catalog/2` | `verdict-catalog.schema.json` |
| `trust/public-keys.json` | `benchmark-product-public-trust/2` | `public-trust.schema.json` |
| `verification/assembly.jsonl` | `benchmark-product-assembly/2`, one JSON row per line | `assembly-row.schema.json` |
| `records/<sha256>.bin` | content-addressed sealed records and DSSE envelopes | by role |
| `static-bundle.json`, `index.html`, `README.md`, `badge.svg`, `social-card.svg`, `share.txt` | derived presentation | reference-verifier territory |

Digest rules:

- Digests are SHA-256 over exact bytes. Record bodies write them as
  `sha256:<64 lowercase hex>`; file names and catalogs use the bare hex.
- Documents were canonicalized (RFC 8785 JCS) once, at sealing. **Those bytes
  are the document forever.** To check a digest, hash the exact bytes you
  received. Never parse and re-serialize a document to check it: a re-emission
  is a different document, and the conformance kit's
  `recanonicalized-report-bytes` fixture exists to fail any verifier that gets
  this wrong.
- `bundle.json` lists every file except itself. The bundle identity is the
  SHA-256 of `bundle.json`'s own bytes.

## DSSE envelopes and keys

Signed material uses [DSSE v1](https://github.com/secure-systems-lab/dsse)
envelopes: `{"payload": base64, "payloadType": string, "signatures":
[{"keyid", "sig"}]}`. The signed message is the pre-authentication encoding:

```
"DSSEv1 " + len(payloadType) + " " + payloadType + " " + len(payload) + " " + payload
```

with lengths as ASCII decimals and `payload` as the raw decoded bytes.
Signatures are Ed25519. Two payload types appear:

- `application/vnd.jinn.benchmarking.report.v1+json` — `report-envelope.json`;
  the decoded payload is byte-identical to `report.json`.
- `application/vnd.in-toto+json` — every verdict record, an
  [in-toto Statement v1](https://github.com/in-toto/attestation) whose subjects
  bind the task and outputs by digest.

Key discovery is entirely bundle-carried — `trust/public-keys.json`:

- `report.spkiDerBase64` — the Ed25519 report key, DER SPKI, base64. Its
  `keyId` and `didKey` both equal `did:key:z<base58btc(0xed01 || raw key)>`
  derived from that SPKI.
- `evaluators[].spkiDerBase64` — one key per evaluator identity; `keyId` is
  `benchmark-product-verdict-` plus the first 16 hex of SHA-256(SPKI DER).
- `selfRun` states the trust boundary in the data itself: `custody:
  workspace-minted`, `partyIndependence: not-established`. There is no
  third-party anchor to fetch and no network involved.

## The walkthrough

From a bundle directory to verified, with `python3` and `openssl` (OpenSSL 3+
for Ed25519 raw verification). Total time well under thirty minutes.

Spot-check by hand — the manifest and one digest:

```bash
python3 -c "import json,hashlib; m=json.load(open('bundle.json')); print(all(hashlib.sha256(open(f['path'],'rb').read()).hexdigest()==f['sha256'] for f in m['files']), len(m['files']))"
```

Expected output for the conformance kit's golden bundle: `True 71` (your file
count differs per bundle; `True` is the part that matters).

The report signature with openssl alone:

```bash
python3 -c "
import base64, json
e = json.load(open('report-envelope.json')); t = json.load(open('trust/public-keys.json'))
key_id = t['report']['keyId']
# Select the signature by keyid, never by position: a graft attack prepends a
# signature, and signatures[0] would verify the wrong one.
sig = next(s for s in e['signatures'] if s.get('keyid') == key_id)
# validate=True plus the re-encode round trip is the strict-base64 rule: a
# lenient decoder silently drops inserted whitespace and accepts a malleated
# envelope whose bytes hash differently.
def strict(field):
    raw = base64.b64decode(field, validate=True)
    assert base64.b64encode(raw).decode() == field, 'non-canonical base64'
    return raw
p = strict(e['payload']); pt = e['payloadType'].encode()
open('/tmp/pae','wb').write(b'DSSEv1 %d %s %d %s' % (len(pt), pt, len(p), p))
open('/tmp/key.der','wb').write(strict(t['report']['spkiDerBase64']))
open('/tmp/sig','wb').write(strict(sig['sig']))"
openssl pkeyutl -verify -pubin -keyform DER -inkey /tmp/key.der -rawin -in /tmp/pae -sigfile /tmp/sig
```

Expected output: `Signature Verified Successfully`.

Then the whole externally verifiable subset in one command, using the
dependency-free reference script this package ships
(`scripts/external-verify.py`, also inside the npm tarball):

```bash
python3 external-verify.py <bundle-dir>
```

Expected output: nine `CHECK <name>: ok` lines (`manifest-files`,
`cas-records`, `sealed-bytes`, `report-signature`, `report-pins-matrix`,
`verdict-signatures`, `matrix-verdict-closure`, `claim-mirror`,
`key-derivations`) and exit code 0. Exit 1 means a check failed; exit 2 means
usage or environment failure. The script is ~150 lines of Python stdlib plus
openssl subprocess calls — read it, or reimplement it; it holds no secrets.

The reference verifier covers the remaining rows of the table:

```bash
npx @colophon-claims/verify@1 <bundle-dir>
```

Exit 0 with `Checked: 6 of 6 checks passed` (`manifest`, `evidence-closure`,
`trust`, `matrix-rederivation`, `report-verification`, `claim-consistency`);
exit 1 invalid; exit 2 usage. It opens no network connection and uploads
nothing. Every bundle names its own compatible command in
`claim-package.json` `verification.compatibleCommand`.

## The conformance kit

The kit is the self-test corpus for external implementations. It lives in the
source repository at `packages/benchmark-product/verify/fixtures/public-bundle-conformance-v1/`;
it is deliberately not in the npm tarball, because it is roughly 10 MB of bundle
bytes that a reader verifying one bundle does not need.

- `golden/` — a complete bundle that must verify;
- `tampered/<case>/` — fourteen full bundles that must each fail, covering
  truncation, manifest length and digest seams, record digest mismatch and
  substitution, payload edits, signature grafts, key swaps, base64 malleation,
  re-canonicalized sealed bytes, claim tampering, and two fully re-signed
  adversarial repairs;
- `manifest.json` — machine-readable expectations per case: a stable
  failure-message pattern (the behavioral pin), the reference check family
  (advisory), and an `externallyDetectable` flag;
- `keys/` — the test-only signing keys behind the golden, so the re-signed
  cases are reproducible and you can mint variants of your own.

`expectedMessagePattern` describes the reference verifier's own message, and two
of the patterns name a specific field path. It is there so the kit can tell its
cases apart; reproducing our exact message text is not a conformance
requirement, and your verifier is free to report failures however it likes. The
conformance criterion is the one stated below, in terms of `externallyDetectable`.

Deriving `tampered/` from the shipped `golden/` is byte-reproducible: run
`scripts/generate-tamper-variants.mjs` and you get the published bytes, which
`test/kit-reproducibility.test.mjs` enforces. Minting a *new* golden is
deliberately not reproducible, since that mints fresh venue keys and stamps a
new signing time.

An implementation of the external subset conforms when it accepts `golden` and
rejects every case with `externallyDetectable: true`. Two cases are the
documented boundary and must PASS an external-subset verifier:
`claim-text-tampered` and `results-miscomputed-resigned` are internally
consistent and genuinely signed, and only the reference verifier's
recomputation (claim rebuild, method recompute) catches them. A verifier that
does not recompute the method must not claim it validated the statistics.

Two rules the kit will fail you for skipping, both of which a naive
implementation gets wrong:

- **Decode base64 strictly.** Accept exactly one canonical spelling: decode with
  validation and require that re-encoding reproduces the input byte for byte.
  Permissive decoders (including Python's default `base64.b64decode`) silently
  discard inserted whitespace, so a malleated envelope whose bytes hash
  differently still verifies. `envelope-payload-malleated` covers this.
- **Contain every path the bundle names.** Manifest paths and record digests are
  attacker-controlled strings. Reject absolute paths, empty and `.` and `..`
  segments, and backslashes; constrain record names to 64 lowercase hex; refuse
  symlinks; and confirm the resolved path stays inside the bundle. Without this
  a hostile bundle turns a verifier into a file-existence and digest oracle over
  the host filesystem.

## Identifier note

The platform's sealed benchmarking record schemas declare canonical `$id`s
under `https://spec.jinn.network/protocols/benchmarking/v1/schemas/`. Those
identifiers are names first: the `spec.jinn.network` origin is not hosted yet,
and fetching them will not retrieve documents until it ships. Until then the
schema bytes are retrievable from the source repository and from the published
`@jinn-network/benchmarking-records` npm package (`schemas/`). The
product-level schemas in this package (`schemas/`) deliberately carry no URL
identity: they are non-normative for the platform, describe Colophon's tier-4
bundle formats, and are identified by the format literals inside the documents
they describe plus the digests of the schema files themselves.
