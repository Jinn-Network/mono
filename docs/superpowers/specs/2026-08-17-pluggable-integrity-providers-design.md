# Pluggable Integrity Providers — Anchor Evidence Design

| | |
|---|---|
| **Version** | 0.3 |
| **Date** | 2026-08-17 (v0.2 approved and committed 2026-08-17; §19 implementation addendum 2026-08-18) |
| **Shape** | `design` |
| **Status** | approved by the product owner (2026-08-17); implemented on `integration/anchor-evidence` with per-packet independent reviews; §19 records the ratified implementation findings |
| **Issue** | [#2756](https://github.com/Jinn-Network/mono/issues/2756) (first provider implementation) |
| **Depends on** | [stack design principles](./2026-07-30-stack-design-principles.md), [trust and identity layer](./2026-07-27-trust-and-identity-layer-design.md) §7.3/§17/§20, [TEP](./2026-07-27-task-execution-protocol-and-stack-design.md) §4/§6, [benchmarking application](./2026-07-28-benchmarking-application-design.md) §7.2/§8.4, [benchmark product](./2026-08-05-benchmark-product-design.md) §7, [evidence-first amendment](./2026-08-16-evidence-first-benchmarking-design-amendment.md) §7, [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md) §9.3, [TEE scope](./2026-04-23-jinn-execution-envelope-tee-scope.md) |
| **Amends** | the trust design's §7.3 anchor-surface taxonomy, by carried amendment (§4.1): proof-carrying `authority-time` surfaces are a new anchor class that is **not** a conforming binding-anchor surface |
| **Folds in** | an unmerged same-day draft, *Lock Anchor — External Timestamping of the Benchmark Lock Digest* (2026-08-17, worktree-local, never committed), absorbed here per owner ruling as the RFC 3161 provider profile, conformed to this design's seam (§15.1) |

## 0. Decision in plain language

Every record in this stack is a signed claim: a signature proves who said something
and that it has not changed since. What no signature can prove is **when** — a key
signs whenever its holder wants, and on a self-run venue every key was minted by
the workspace itself. That is why every self-run Colophon bundle honestly prints:

> Pre-registration here is a discipline enforced by this tool, not a proof against
> the run's own owner — nothing prevents the owner from having altered the record
> before publishing it.

An **anchor** is the complementary object: evidence that a digest existed no later
than some time, vouched by machinery the operator does not control — a timestamp
authority signing `(digest, time)` under RFC 3161, a Bitcoin block committing to
it through OpenTimestamps, a chain transaction carrying it. An anchor has no claim
content and proves nothing about meaning or correctness; it only dates bytes. The
trust layer already states the composition rule this design builds on: anchoring
proves *when* a record existed; the signature is what makes its *content*
attributable; neither substitutes for the other.

This design defines the seam through which anchors from pluggable providers attach
to already-sealed records:

1. **Tier 1** — the trust layer's anchor taxonomy gains a second class:
   **proof-carrying anchors**, whose evidence travels as bytes inside a bundle and
   verifies offline, beside the existing **lookup anchors** (the Base Sepolia
   calldata surface). Each class carries its own property set (§4.1); binding
   at-time resolution keeps its existing, stricter requirements. This executes
   the trust design's reserved follow-up, "anchor-surface unification — a
   dedicated minimal anchor could later serve all record families uniformly."
2. **Tier 2** — one new sealed record kind, **AnchorEvidence**, carries the
   foreign proof bytes exactly, names its provider by profile URI, and covers
   exactly one subject digest. It is producible and verifiable without running
   Jinn code.
3. **Tier 3/4** — the benchmarking application and Colophon consume it: the lock
   flow obtains anchors opt-in and non-blocking, the bundle carries them,
   `bundle verify` reports them through one new named check, and the printed
   venue-honesty limitations become conditional on what the anchors actually
   establish.

The first provider is an RFC 3161 timestamp authority over the benchmark lock
digest (issue #2756). The second is OpenTimestamps. The chain surface is
classified honestly as a lookup provider. Transparency logs and TEEs are named
later classes with reserved slots, not new scope.

No anchor of any kind ever proves correctness. A verified anchor moves a
pre-registration claim from tool-enforced discipline toward *committed*; nothing
an anchor can carry ever reaches *attested*.

## 1. Problem

The lock flow fixes the comparison design — arms, cells, replicates, method,
close instant — by sealing a Run record whose digest becomes the pre-registration
(benchmarking design §7.2). The named check `preregistration-precedes-dispatch`
has three legs: **(a) structural** — every dispatched cell's Submission embeds the
Run digest, so cells provably committed to their exact pre-registration; **(b)
anchored ordering** — third-party time, today available only on the marketplace
venue through chain transaction order; **(c) chain corroboration** — append-order
only, which the design itself concedes "proves append-order, not
registration-before-execution."

On the self-run venue only legs (a) and (c) hold. The lock digest is already
recomputable by any stranger from the bundle's exact `run.json` bytes, and every
Submission is cryptographically bound to it through its cell idempotency key. The
single missing fact is *when the lock existed*: `lockedAt` lives only in
product-local run state and appears nowhere in the bundle. Hence the two printed
sentences this design makes conditional:

> Pre-registration here is a discipline enforced by this tool, not a proof against
> the run's own owner — nothing prevents the owner from having altered the record
> before publishing it.

> Signatures verify against the bundle-carried public keys minted by this
> workspace; there is no third-party trust anchor on the self-run venue.

The stack underneath already has most of the machinery: injected resolver/anchor
interfaces in `trust-core` (verification core defines interfaces, `trust-resolve`
implements them with I/O), a working chain anchor writer/reader behind the
`base-sepolia-calldata-v1` locator profile, DSSE-only signing, and a graded
honesty model (per-axis evidence classes; venue-honesty disclosures). What is
missing, precisely:

- no **portable anchor proof** exists anywhere — the `AnchorResolver` interface is
  lookup-shaped (`lookupAnchor(digest) → { digest, anchorTime } | null`), carries
  no proof bytes and no authority identity, and presumes a queryable surface;
- no **anchor record kind** exists among the stack's ~70 sealed record kinds;
- the bundle's verification model has no way to report a check that can *pass
  while disclosing* (its six named checks are all-or-throw);
- one bespoke precedent exists and is generalized away here: Demo-1's
  preregistration adapter anchors a commitment on chain and gates launch on the
  anchor time — a one-off this seam replaces with a uniform mechanism.

## 2. Position in the stack

| Tier | This design adds | Explicitly not touched |
|---|---|---|
| **1 — protocol / trust concept** | the proof-carrying anchor class, its per-class properties, and the provider verification contract (§4) | TEP, Evidence Protocol, discovery semantics; the existing `AnchorResolver` interface and its consumers; binding at-time resolution semantics; every frozen record kind |
| **2 — protocol-extending records** | the AnchorEvidence record kind (§5) and the v1 provider profiles (§6) | Benchmark/Run/Matrix/Report v1–v2, BenchmarkAccounting, all evidence families; `EVIDENCE_RECORD_FAMILIES` stays a closed three-member enum — anchor records are not evidence-family records and do not widen it |
| **3 — reusable applications** | none in v1. The check and acquisition implementations live in the product family (tier 4) beside the verifier they extend; a reusable tier-3 anchor package is a later extraction, justified only by a second independent consumer (the promotion-trigger discipline) | run orchestration, aggregation methods, discovery |
| **4 — products** | anchor acquisition (`runAnchor`), the `integrity-anchors` check implementation, Colophon lock-flow integration, workspace configuration, bundle carriage, honesty copy (§7–§10) | operator console, marketplace product surfaces |

Dependency direction is unchanged: applications → discovery → TEP + Evidence →
trust. The protocol layer never learns what a timestamp authority is (TEP §4.1's
forbidden-knowledge discipline); acquisition endpoints, HTTP bindings, and
retry policy are application-tier concerns behind injected ports.

Nothing in tiers 1–2 names Colophon. The AnchorEvidence record can cover any
sealed record's digest; the benchmark lock is its first subject, not its
definition.

## 3. Standards composition

Per principles §3, each candidate was audited against adopt / compose / bespoke.
Bespoke was never reached.

| Standard | Disposition | Grounds |
|---|---|---|
| **RFC 3161 / RFC 5816 timestamp tokens** | **adopt wholesale**, thin profile (§6.1) | one DER blob, complete at issuance, offline-verifiable with the signer certificate embedded (`certReq`); free public endpoints exist as a class; transport (HTTP binding), storage (unspecified), and semantics (TSTInfo) already separate |
| **OpenTimestamps** | **adopt wholesale**, second provider (§6.2) | no trusted party once complete **and given a validated header chain** (§6.2); pending → complete lifecycle requires an upgrade stage; complete-proof evaluation needs Bitcoin block headers the verifier supplies as its own trust material |
| **in-toto ResourceDescriptor / DSSE** | already ours | descriptor shape reused for subjects and proofs. The in-toto predicate registry contains **no** timestamp predicate; ecosystem practice (the Sigstore bundle's `timestamp_verification_data`) carries RFC 3161 tokens as verification material *beside* the envelope, never as signed statement payload — adopted as the shape rationale for §5's unsigned record |
| **C2SP checkpoint / tlog-cosignature (Rekor-class logs)** | **reserved later class** | auditable-party time (log + witness cosignatures) is the property RFC 3161 lacks; but log entries are public by construction, conflicting with items-private-until-published, and the discovery design already reserves this upgrade path ("inclusion proofs as additive head/descriptor annotations… enabled per consumer by a trust-policy bit"). A transparency-log provider profile lands there when needed, not here |
| **Chain anchoring (existing Base calldata surface)** | **classified, not extended** | real ordering evidence, wrong verification posture for strangers: inclusion replay is offline but header *canonicality* is not self-contained — unsolved in practice for L2s. Classified as a lookup-posture provider (§6.3), never presented as offline-verifiable |
| **RFC 9162 (CT v2) SCTs** | reject | structures are X.509-bound (signature covers a certificate entry); no provision for arbitrary data. The promise→proof→monitor *pattern* informs the pending semantics |
| **COSE countersignatures (RFC 9338) / SCITT** | reject for v1 | RFC 9338 explicitly defers any timestamp header "to a future document"; SCITT is early-stage. A CBOR stack we do not otherwise use |
| **ERS (RFC 4998/6283)** | **named later class** | the only audited standard with worked multi-decade renewal semantics (timestamp renewal + hash-tree renewal); niche toolchain; relevant when bundles must outlive their first algorithms, not at v1 |

Two audit facts are load-bearing for the trust analysis and are restated in the
honesty mapping (§9): an RFC 3161 token's security model **trusts the timestamp
authority** — a misbehaving authority can backdate undetectably, which is a
property of the standard, not an implementation gap; a completed OpenTimestamps
proof trusts **no party** — forging it requires rewriting Bitcoin proof-of-work —
*provided the verifier evaluates it against a validated header chain*; a single
unvalidated header is attacker-choosable, so the header source is verifier-side
trust material like any other (§4.3). A *pending* OpenTimestamps proof is only a
calendar server's promise. The three viable provider families therefore carry
genuinely different trust models — trusted party (RFC 3161), no party
(OpenTimestamps complete), auditable party (transparency logs) — which is the
graded-assurance architecture applied to time, and the strongest justification
for a provider seam rather than a one-off.

## 4. Tier 1 — the anchor taxonomy, extended

### 4.1 Two anchor classes, per-class properties

The trust design §7.3 defines an anchor surface's required properties:
append-only writes, tamper-evidence, and a consistent observable order for all
consumers. Those three properties are exactly what makes chain anchors safe for
**key-binding at-time resolution** — they are what kill back-dated attribution.

This design extends the taxonomy with a second class and states, as a carried
amendment to the trust design, which class may serve which purpose:

- **Lookup anchors** (existing, unchanged) — queried by digest, answered by
  observation; the surface itself provides §7.3's three properties. The
  `AnchorResolver` interface, the `base-sepolia-calldata-v1` locator profile,
  and every binding-resolution consumer are untouched.
- **Proof-carrying anchors** (new) — the anchor's evidence is a byte artifact
  issued by the surface (a timestamp token, a proof file) that travels with the
  record set and verifies without querying anything.

**Proof-carrying `authority-time` anchors are not §7.3-conforming binding-anchor
surfaces.** A timestamp authority is a private signing oracle: it offers no
append-only write surface and no consistent observable order, and a misbehaving
authority can backdate undetectably (§3). Such anchors therefore **never feed
key-binding at-time resolution**; they are evidence for claims whose consumers
apply their own authority-acceptance policy (§4.2, §10). Proof-carrying
`chain-time` anchors (a completed OpenTimestamps proof) do carry §7.3's
properties — the underlying chain provides them — but wiring any proof-carrying
class into binding resolution is out of scope here and would need its own
trust-design amendment. Binding resolution continues to require lookup
surfaces exactly as the trust design specifies.

Every provider profile (§6) declares its class, plus two orthogonal facts that
verification reports and honesty copy renders — never blurred into one badge:

- **verification posture**: `offline-from-artifact` (self-contained given
  verifier-side trust material) · `offline-with-external-data` (needs standard
  public data the verifier supplies, e.g. Bitcoin block headers) ·
  `lookup-only` (requires querying live infrastructure);
- **time basis**: `authority-time` (a party's signed assertion — trust reduces
  to that party) · `chain-time` (a consensus commitment — no single party can
  backdate, given a validated chain view).

### 4.2 Inherited rules

Three trust-layer rules apply to anchor-evidence claims unchanged:

- **Effective time.** An anchor contributes `max(recordValidFrom, anchorTime)`
  semantics wherever at-time reasoning applies to the claims it supports;
  anchoring today gains nothing about yesterday. (Binding at-time resolution is
  not such a claim for `authority-time` anchors — §4.1.)
- **Earliest verified anchor governs.** Re-anchoring is a new record; a later
  anchor never improves a time claim. Contradictory anchors over the same
  subject are surfaced to policy, never merged.
- **Authority acceptability is consumer policy.** Which authorities' time a
  reader accepts is the reader's trust decision (the trust design's
  witness-verifier rule); verification *identifies* the authority, it never
  *endorses* it.

### 4.3 The provider contract

Following the established §17 split — core defines interface types and
verification rules with no I/O; implementations are injected — the contract has
two halves that never mix:

```
AnchorProofVerifier                     // pure; no I/O; per provider profile
  profile: string                       // the anchor-profile URI implemented
  verifyProof({
    subjectSha256,                      // recomputed by the caller from exact bytes
    proofBytes,                         // exact foreign bytes from the record
    trust                               // verifier-side material; never bundle-supplied
  }) -> AnchorProofResult

AnchorProofSource                       // I/O; application tier; per provider profile
  profile: string
  obtainProof({ subjectSha256, endpoint, signal }) -> Uint8Array
```

`AnchorProofResult` is one of:

| Status | Meaning |
|---|---|
| `verified` | binding + internal cryptography hold, and the proof's time basis was evaluated against verifier-supplied trust material (authority roots; a validated header chain) |
| `present` | binding + internal cryptography hold and the proof is structurally complete for its class, but the material needed to evaluate its time basis was not supplied — no authority roots for an `authority-time` proof, no header chain for a `chain-time` one |
| `pending` | the proof is not yet independently checkable even in principle (e.g. an OpenTimestamps calendar promise without a chain attestation) |
| `invalid` | any rule failure: bad structure, broken signature, digest, kind, or algorithm mismatch |

(`absent` and `declared-but-absent` are verification-*context* outcomes — no
record carried for a subject — reported by the consuming check, §8, never by a
proof verifier; a proof source can also simply fail, which is an
application-tier refusal, never a stored artifact.)

`present` rather than `verified` for the no-trust-material case is deliberate
vocabulary: calling an internally-consistent proof "verified" invites the
reading that the *time basis* was verified, which it was not. Verification
never consults trust material the bundle supplied, and never asserts the
authority is who it names.

Acquisition never runs at verification time: a verifier must not "upgrade" a
pending proof by contacting a network mid-verification — the bundle proves what
it carries. Upgrading is an explicit producer-side operation that appends a new
record (§6.2).

## 5. Tier 2 — the AnchorEvidence record

```text
kind:        https://spec.jinn.network/records/anchor-evidence/v1
media type:  application/vnd.jinn.anchor-evidence.v1+json
```

Sealed once with RFC 8785 JCS under I-JSON constraints; identity is the SHA-256
of the exact sealed bytes; the exact bytes are the record forever. The semantic
shape (exact JSON Schema frozen with the conformance kit):

```json
{
  "kind": "https://spec.jinn.network/records/anchor-evidence/v1",
  "subject": {
    "kind": "https://spec.jinn.network/records/benchmark-run/v1",
    "digest": { "sha256": "<64 lowercase hex>" }
  },
  "provider": "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
  "proof": {
    "mediaType": "application/vnd.etsi.timestamp-token",
    "content": "<base64 of the exact foreign proof bytes>"
  }
}
```

Normative rules:

1. **Exactly one subject, and it is a sealed-record digest.** Composite,
   truncated, or derived subjects are forbidden. An anchor can never be
   ambiguous about what it covers; one anchor legitimately covering two bundles
   requires both to carry the byte-identical subject record. Digests travel as
   `(algorithm, value)` pairs in the in-toto DigestSet shape; `sha256` is the v1
   floor and the only admitted algorithm. `subject.kind` is normative, not
   advisory: verification requires it to equal the resolved record's actual
   kind (§8 step 2).
2. **The proof bytes are carried exactly** — base64 of the foreign artifact,
   never parsed-and-re-emitted, so the authority's own cryptographic material
   survives byte-for-byte and any off-the-shelf verifier for that standard can
   check it with no Jinn code. v1 admits inline `content` only, capped at
   64 KiB — every v1 provider class produces proofs far below it. A
   descriptor-referenced overflow form is deliberately **not** part of v1; if a
   future provider class needs one, it arrives with that class's profile
   version.
3. **Nothing derivable is copied into the record.** The anchored time, the
   authority identity, the policy identifiers — all live inside the proof and
   are extracted by verification. The wrapper and the proof cannot disagree
   because the wrapper repeats nothing the proof owns.
4. **Sealed, not signed.** The record carries no DSSE envelope and no producer
   signature. The proof inside *is* the authority's signature; an operator
   counter-signature would add no trust (the operator's keys are the parties we
   are escaping) and would conflate the record's producer with the anchoring
   authority — the identity conflation §6 of the principles forbids. This
   matches ecosystem practice: time evidence rides as verification material
   about a digest, not as somebody's statement. Producer attribution, where a
   product wants it, lives in its own journals — never in the record.
5. **No stored status.** Whether a proof is pending or complete is readable from
   the proof bytes; whether it is valid is derived by verifiers at verification
   time. The record never asserts anything about itself — derived status, never
   stored assertion (principles §7).
6. **Append-only.** Anchoring again — a second provider, an upgraded proof, a
   re-anchor — is a new record. Nothing rewrites an existing one. The earliest
   verified anchor over a subject governs its time claim (§4.2).

The record kind is owned by the trust layer's tier-2 record family. It is not an
evidence-family record: `EVIDENCE_RECORD_FAMILIES` stays closed, and network
publication of anchor records rides the kind-neutral record-publication
coordinator from the interoperability profile, not the evidence repository.

## 6. Provider profiles

### 6.1 `https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1` — first provider

Class: proof-carrying · posture `offline-from-artifact` · basis `authority-time`.
The carried bytes are one DER `TimeStampToken` (the CMS ContentInfo — not the
full `TimeStampResp`), labeled with its registered standalone-token media type,
`application/vnd.etsi.timestamp-token`. (`application/timestamp-reply` denotes
the full TimeStampResp and would mislabel a bare token to exactly the
off-the-shelf tooling rule 2 of §5 promises interop with.)

**Acquisition profile.** SHA-256 message imprint; `certReq` set, so the signer
certificate travels in the token and the proof is self-contained. The response's
`PKIStatus` must be `granted` or `grantedWithMods` before the token is
extracted; anything else is an acquisition refusal. The request carries no
nonce — deliberately: nonce protects a live requester against response replay,
and imprint equality already gives the stored artifact everything replay could
threaten. The HTTP binding (`application/timestamp-query` POST) is adopted
unchanged and lives entirely in the application-tier proof source.

**Verification rule set.** `verifyProof` refuses (`invalid`) unless all of the
following hold — no partial success, no downgrade path:

1. `ContentInfo.contentType` is `id-signedData`; the encapsulated `eContentType`
   is `id-ct-TSTInfo` (1.2.840.113549.1.9.16.1.4).
2. The `eContent` parses as a `TSTInfo` with `version` 1, and every TSTInfo
   extension marked critical is known to this profile (v1 knows none, so any
   critical extension refuses).
3. Exactly one `SignerInfo` is present (RFC 3161 permits only one signer).
4. `signedAttrs` is present, with a `contentType` attribute equal to
   `id-ct-TSTInfo` and a `messageDigest` attribute equal to the digest of
   `eContent` under the SignerInfo digest algorithm.
5. **Algorithm floor, all layers.** The `messageImprint.hashAlgorithm`, the
   SignerInfo digest algorithm, and the signature algorithm's digest component
   are all drawn from a pinned allowlist with a SHA-256 family floor; SHA-1 and
   weaker are refused everywhere they can appear, not only in the imprint. (A
   producer-side adversary with a SHA-1 anywhere in the CMS layer can mount
   practical collision substitutions; refusing costs nothing.)
6. A `SigningCertificateV2` attribute (RFC 5035/5816) with a SHA-256-family
   `certHash` identifies a certificate embedded in the token's `certificates`
   set. The v1 `SigningCertificate` attribute (ESSCertID is SHA-1 by
   definition) is refused. An absent embedded certificate is a refusal.
7. `SignerInfo.sid` (issuerAndSerialNumber or subjectKeyIdentifier) is
   consistent with the certificate identified in rule 6.
8. The signature verifies over the DER re-encoding of `signedAttrs` with an
   explicit SET OF tag — not over `eContent` directly — using the embedded
   signer certificate's public key, via the injected crypto port.
9. The signer certificate's extended key usage is exactly `id-kp-timeStamping`
   (1.3.6.1.5.5.7.3.8); any additional usage is a refusal. RFC 3161 requires
   this EKU to be both sole and critical; the sole-usage half is checked, and
   **extension criticality is not**, because the certificate port does not
   surface criticality flags. The gap is recorded (§16) rather than papered
   over.
10. When the TSTInfo `tsa` field is present, it corresponds to one of the
    subject names in the signer certificate (RFC 3161 §2.4.2).
11. `genTime` is well-formed GeneralizedTime in Zulu form with seconds (DER
    constraints: no trailing fractional zeros), and falls inside the signer
    certificate's validity window.
12. `messageImprint.hashedMessage` equals the caller-recomputed subject digest,
    under the algorithm the token declares (which rule 5 already constrains).

Rules 1–12 passing yields `present`, with extracted facts —
`{ genTime, accuracy?, policyOid, serialNumber, signerCertificateSha256,
signatureAlgorithmOid }` — all extracted, never asserted. If the caller
additionally supplied trust material (root certificates it chose to trust) and
the embedded chain verifies against it, the result is `verified`.
`signerCertificateSha256` is the disclosure that makes the trust decision
actionable: a reader compares it against the authority's published certificate
themselves. The issuer distinguished name is **not** among the byte-compared
facts — DN-to-string rendering is not canonical across implementations — and is
rendered display-side from the carried certificate by whoever presents it.

**Time semantics.** The token's assertion is bounded by `genTime` plus its
declared `accuracy` (RFC 3161 defines the true-time interval as
`genTime ± accuracy`). The claim this profile supports is "existed no later
than `genTime`, within the token's declared accuracy"; the accuracy interval is
part of the verifier's report, not of sealed copy, and is typically ≤ 1 s.
Where a fact derived from `genTime` enters byte-compared content (§7.4, §9.2),
it is rendered by one pinned pure transform: the DER GeneralizedTime string
converted positionally to RFC 3339 UTC, preserving the token's exact precision,
with no normalization (`YYYYMMDDHHMMSS[.f…]Z → YYYY-MM-DDTHH:MM:SS[.f…]Z`).

**Parsing discipline.** The DER reader is minimal and definite-length only;
indefinite-length BER is refused, not tolerated — CMS in DER is definite-length
and accepting BER widens the attack surface for no interoperability gain.

**Placement.** Token structure, the DER reader, and rules 1–12 live in
`trust-core` (I/O-free, dependency-free beyond its existing floor), following
the established pattern in which trust-core produces the exact bytes a signature
must cover while consumers perform platform crypto through two injected ports:

```
verifySignature({ algorithmOid, parameters, spkiDer, message, signature }) -> boolean
readCertificate(certDer) -> { subjectPublicKeyInfoDer, notBefore, notAfter,
                              extendedKeyUsageOids, subjectNames, sid }
```

Both ports are implemented once with `node:crypto` in the standalone verifier
package and reused by the product core (`@colophon-claims/core` already depends
on `@colophon-claims/verify`; both depend on `trust-core` — the split matches
the real dependency direction). Hand-writing an X.509 parser to make a security
decision is the invention §3 exists to prevent; the *rules* stay in one
auditable, dependency-free place, and only the two platform primitives cross the
boundary. No new package is created for the first provider; a dedicated provider
package is a later extraction if a second consumer appears.

### 6.2 `https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1` — second provider

Class: proof-carrying · posture `offline-with-external-data` · basis
`chain-time` when complete, `authority-time` (a calendar's promise) while
pending. Proof media type `application/vnd.opentimestamps.ots`; the carried
bytes are one detached `.ots` proof.

- Verification replays the commitment-operation sequence (pure hashing) to the
  terminal attestation. A structurally complete proof (one carrying a
  `BitcoinBlockHeaderAttestation`) **without** verifier-supplied headers is
  `present` — replay self-consistency is *not* chain evaluation, and a
  fabricated attestation (invented height, self-consistent path) is exactly
  what header evaluation exists to catch. With the header chain supplied and
  validated, a proof whose commitment matches the header for the attested
  height is `verified`; the extracted byte-fact is the **block height** (the
  proof does not contain a time — block time lives in the header and is
  verifier-report content only). A proof whose only attestations are pending
  calendar promises is `pending`. Replay failure or digest mismatch is
  `invalid`; with headers supplied, a commitment/header mismatch is `invalid`.
- **Upgrade is a producer-side operation** that fetches the completed proof from
  the calendar and appends a **new** AnchorEvidence record carrying the upgraded
  bytes; the pending record is never rewritten (§5 rule 6). Both may travel in a
  bundle; verification reports each on its own bytes, and the complete one
  governs. The canonical `.ots` in-place mutation is deliberately not mirrored —
  append-only record identity wins over the reference tooling's file lifecycle.
- The honest availability caveat is stated wherever this profile is described: a
  calendar that disappears before upgrade strands a pending proof permanently;
  stamping through multiple calendars is the standard mitigation and is
  endpoint configuration like everything else.
- The `time ≤ closeAt` splice-catch (§8 step 4) does not apply to this profile:
  the proof carries no time, and height-vs-closeAt comparison requires headers.
  A header-supplied verifier reports the block time and its relation to
  `closeAt` in its own report.

### 6.3 `https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1` — classified

The existing chain surface, unchanged (the frozen literal is not renamed).
Class: lookup · posture `lookup-only` · basis `chain-time`. It remains what the
trust layer uses for key-binding effective time and what Demo-1's
preregistration gate consumed. Classification is the only change: any surface
that presents this anchor to a bundle reader must present it as ordering
evidence requiring live chain access to check — never as offline-verifiable.
"A future chain is a new profile, not a parameter" continues to hold.

### 6.4 Reserved classes

- **Transparency log** (C2SP checkpoint + inclusion proof + witness
  cosignatures): auditable-party time. Lands with the discovery design's
  reserved tlog upgrade; its privacy conflict (log entries are public by
  construction) must be reconciled with items-private-until-published first.
- **TEE attestation**: an instance of the existing `attested` tier in the TEE
  scope document (RATS EAT profile, digest bound into `REPORTDATA`, off-chain
  verification, no Jinn-operated infrastructure). A TEE provider profile slots
  in under that scope; this design leaves it a slot and opens no new scope.
  A TEE quote is evidence about *execution*, not time; it will never be a time
  anchor, and no time anchor will ever claim what a TEE quote claims.
- **ERS renewal** (RFC 4998): archive-grade re-timestamping when bundles must
  outlive their first algorithms. Named so its absence is a decision.

## 7. Colophon integration

### 7.1 `runAnchor`, a separate operation

`runLock` is unchanged: synchronous, and no network call enters the critical
path of an irreversible approval-gated transition. A new async operation
`runAnchor(context, { draftId, subject, providerProfile?, endpoint? })`, where
`subject` selects the anchored record:

- `subject: "lock"` — anchors the sealed Run digest. Requires
  `RunState.lockedAt` and `RunState.runSha256` both set, and refuses
  `illegal-transition` if `RunState.launchedAt` is set: a lock anchor obtained
  after dispatch began does not support the claim this feature makes, and
  refusing beats storing a weaker fact silently. Because acquisition does
  network I/O, `launchedAt` is re-checked immediately before the store step; a
  launch that interleaved with acquisition turns the store into the same
  refusal. (A cancelled run is already past launch and refuses by the same
  rule.)
- `subject: "matrix"` — anchors the sealed terminal Matrix digest. Requires the
  run closed and `RunState.matrixSha256` set; launch state is irrelevant. A
  lock anchor plus a matrix anchor bracket the published record set in
  third-party time; the bracket is presentation-grade context, not a new claim
  (§9's residuals still hold).

Common rules, per subject:

1. Refuse `conflict` if an anchor for the same `(subject, provider)` pair
   already exists — write-once per provider per subject, with one exception:
   appending the upgraded form of a pending proof (§6.2).
2. Refuse `venue-unavailable` if no endpoint resolves.
3. Obtain the proof through the injected `AnchorProofSource`, bounded timeout.
4. **Verify before storing** — run the same `verifyProof` rules the bundle path
   uses; refuse `venue-unverifiable` on anything below `present`. A stored
   anchor is always at least a `present` anchor.
5. Seal the AnchorEvidence record and store its exact bytes in the workspace
   sealed store, recording the record digest in `RunState`.

`anchor` is audited like every operation but is **not** approval-gated: it moves
no funds, changes no lifecycle state, and is reversible by never having
happened. Configuring an endpoint is the operator's consent to the disclosure in
§13 item 7.

### 7.2 CLI and lifecycle

- `colophon lock` calls `runLock`, then — when anchoring resolves as enabled —
  calls `runAnchor` with `subject: "lock"`. **Any anchor failure is swallowed
  into a note plus its own audit entry**; the lock result and exit code are
  unaffected. The operation returns typed refusals; the verb decides they are
  non-fatal. The lock transition itself completes before any anchor attempt
  begins, so the lock is never blocked or delayed; the *verb* then spends up to
  the bounded acquisition timeout before returning, which is the deliberate
  reading of the issue's never-blocks criterion (§18).
- `colophon anchor --draft X --subject lock|matrix [--provider P]
  [--endpoint U]` runs it standalone, so a failed lock-time attempt can be
  retried before launch, a matrix anchor can be obtained after close, and an
  OpenTimestamps proof can be upgraded before publish.
- The parity matrix gains the operation↔verb rows; no GUI-only or CLI-only
  capability is introduced.

### 7.3 Configuration and declared intent

Workspace configuration gains an optional anchoring block: an ordered list of
`{ providerProfile, endpoint }` entries. Resolution order: per-invocation flag,
then per-draft setting, then workspace default. **Once configured at the
workspace level, every subsequent lock attempts anchoring automatically**; a
draft can explicitly disable it. Absent any configuration, nothing is attempted,
no warning prints, and the unconditional limitation stands. No endpoint ships as
a default and no vendor name appears in source — the endpoint is configuration
(the issue's standards-only constraint), which also makes opt-in structural.

A draft may additionally **declare anchoring intent**, sealed into the Run
record under a namespaced extension key
(`https://spec.jinn.network/extensions/anchor-intent/v1`, listing intended
provider profiles — never endpoints). The declaration changes absence
semantics: a bundle whose Run declares intent but carries no matching anchor
reports *declared-but-absent* — visibly different from clean absence, so a
stripped anchor cannot masquerade as never-attempted. Declared intent with a
failed provider is honest: the bundle reports the declaration and the absence,
and the unconditional limitation stands. (The declaration is intent, not
proof — the anchor itself necessarily postdates sealing, since it covers the
sealed bytes.)

### 7.4 Bundle carriage

Anchored bundles use new closure versions in the established allocation
pattern: **`benchmark-product.claim-package/4`** and
**`benchmark-product-public-bundle/6`** (successors of the classic-path
claim-package/2 and public-bundle/4; the evidence-native claim-package/3 and
public-bundle/5 adopt the same anchor surface in their own later allocation).
Within the bundle:

- a new allowlisted `anchors/` directory holds each AnchorEvidence record's
  exact sealed bytes, named by record digest, manifest-listed like every other
  member;
- the claim package gains an `anchors` section: for each carried record, the
  subject reference, provider profile, record digest, and the profile's
  **byte-embedded facts only** — for `rfc3161-tsa/v1`: `genTime` (via the §6.1
  pinned transform), `policyOid`, `serialNumber`, `signerCertificateSha256`;
  for `opentimestamps/v1`: the attested block height, or `pending`. Facts that
  require external data (block time) or lack a canonical rendering (issuer
  distinguished names, accuracy intervals) never enter this section — they are
  verifier-report and presentation content. Producer and verifier derive the
  section from the same bundle bytes by the same pure function, so
  claim-consistency remains an exact byte-compare;
- `venueHonesty` gains the conditional content of §9.

Verifier v2 gains additive support for the new versions; every already-published
bundle verifies byte-identically under the existing rules (§12).

## 8. Verification semantics — the `integrity-anchors` check

One new named check, **always present** in the check list of the new closure
versions, reported by both `bundle verify` and the workspace-side `run.verify`
through the same shared implementation (the existing shared-skeptic-path
discipline).

**Subject selectors are digest-keyed, by definition:** the *lock anchor* is any
carried anchor whose `subject.digest` equals the digest of the bundle's exact
`run.json` bytes; the *matrix anchor* is any whose `subject.digest` equals the
digest of the exact `matrix.json` bytes. Nothing selects by `subject.kind` —
a kind label can never route an anchor onto a claim its digest does not back.

For each anchor record carried:

1. Parse the record under its strict schema (unknown keys fail closed — the
   public-bundle closure discipline, deliberately stricter than the protocol
   layer's unknown-field tolerance).
2. **Recompute the subject.** Hash the exact sealed bytes of the referenced
   record *from the authenticated bundle snapshot* and require (a) digest
   equality with the record's subject digest and with the digest inside the
   proof, and (b) that `subject.kind` equals the resolved record's actual
   kind. A stored assertion is never the comparison source. A valid proof over
   a digest no bundle record has, or a kind label that misdescribes the
   resolved record, is `invalid` — affirmative evidence of substitution,
   reported louder than absence.
3. Verify the proof through the provider profile's `AnchorProofVerifier` with
   whatever trust material the verifier's operator supplied. **Trust roots are
   strictly verifier-side configuration**: the verifier ships with none (a
   shipped root set would hard-wire authorities into a standards-only design),
   and bundle-carried certificate chains are archival convenience, labeled as
   such — validating solely against bundle-supplied roots would re-import the
   self-run problem with extra ceremony.
4. For an `authority-time` lock anchor, additionally require
   `genTime ≤ run.closeAt`; violation is `invalid`. This catches an anchor
   spliced in after the run's own pre-registered close instant, and nothing
   more — it is not ordering evidence and is never described as such. (Bare
   `genTime` is compared; the declared accuracy is immaterial at this grain.
   The rule does not apply to `chain-time` anchors, whose proofs carry no
   time — §6.2.)

Per-anchor proof outcomes are §4.3's four (`verified · present · pending ·
invalid`); the check adds the two per-subject context outcomes `absent` and
`declared-but-absent` (§7.3). `invalid` fails the whole verification loudly
(`record-integrity`), like any other check. Everything else is a disclosed
status: the check passes, the statuses print, and nothing is silently inferred
from silence — which is the issue's "absence reported, never silently passed"
criterion made structural.

**The honesty text keys on byte-facts.** The conditional copy in §9 is a
deterministic function of what the bundle carries — anchor present,
structurally complete for its class, digest- and kind-matching — not of the
verifier's trust evaluation, which varies with the verifier's configured
material. What makes this sound differs honestly by class, and the copy is
worded accordingly (§9.2): for `authority-time` proofs the cryptography is
fully checkable from the artifact, so the copy may assert the authority's
statement (the verifier re-verifies unconditionally and fails loud on
`invalid`, so text claiming an anchor the cryptography rejects cannot survive);
for `chain-time` proofs structural completeness is *not* chain evaluation, so
the sealed copy is **attributive** — it says what the proof asserts and what
checking it requires — and the assertive form appears only in the report of a
verifier that evaluated headers. What the verifier's own report always adds is
its evaluation: whose trust material validated the time basis, or that none
was supplied.

**What cannot be checked offline, stated in the check's own vocabulary:** that
the anchor preceded the first dispatch. The assembly graph carries no dispatch
timestamps, so "anchored before execution started" is not derivable from bundle
bytes; the replacement copy is limited accordingly, and the follow-up that would
change this is §16's dispatch-timestamp item, a different claim and its own
issue.

## 9. The honesty mapping

### 9.1 What a verified anchor proves, and the ladder

A verified complete anchor over the lock digest proves exactly one fact: **the
locked design's digest existed no later than the anchored time, per the named
surface.** From that time forward the design is frozen — any altered lock is a
different digest whose anchors are younger or missing, and earliest-verified-
wins makes tamper-then-re-anchor pointless.

On the evidence ladder this is the *committed* move, generalized: "committed"
has meant a digest bound to the chain; this design generalizes it to **a digest
bound to a surface outside the producer's control**, with two honesty
qualifiers always attached. First, the time basis (`authority-time` vs
`chain-time`) is reported alongside, never blurred. Second, for
`authority-time` anchors, "outside the producer's control" is itself a consumer
trust judgment about the named authority — the token cannot prove the authority
is not the producer's own (§3), which is why the authority identity is
disclosed and the copy carries its caveat. Independent anchors from unrelated
surfaces multiply independence at near-zero format cost (n records, one
subject).

**The overclaim guard, stated normatively: no anchor of any kind reaches
*attested*.** Anchors date bytes; they never validate execution, evaluation, or
meaning. Anchor state is its own disclosure — it joins the per-axis honesty
model as its own fact and never upgrades the evaluation, trust, or any other
axis, and it is never folded into a single "verified" badge (the
no-launderable-summaries discipline).

**Named residuals that survive a verified anchor**, printed wherever the
upgraded claim is:

- *run-before-lock*: nothing can prove the results were produced after the
  anchored time — execution timing on a self-run venue stays owner-asserted;
- *rehearsal*: the disclosed preview mechanism already names this; an anchor
  does not touch it;
- *selective publication*: an owner can discard an anchored lock and start
  over; anchors date what is published, not what was abandoned.

### 9.2 Exact text changes

All conditional on a carried, structurally complete, digest- and kind-matching
lock anchor (§8's byte-facts; a `pending`-only proof is not structurally
complete and gates nothing). Absent, pending, or invalid anchors change
nothing — the unconditional sentences stand.

**Limitation sentence 2** — replaced (per the issue's acceptance criteria):

> Pre-registration here is a discipline enforced by this tool, not a proof
> against the run's own owner — nothing prevents the owner from having altered
> the record before publishing it.

becomes, for an `authority-time` anchor (RFC 3161):

> Pre-registration here is anchored: an external timestamp authority asserts
> this run's sealed design digest existed no later than `<genTime>`. That
> assertion proves the design's existence by that time and nothing else about
> the run — in particular, not that results were produced after it — and it is
> only as good as the authority behind the signing key named in the token.

and, for a `chain-time` anchor (OpenTimestamps with a chain attestation):

> Pre-registration here carries an anchor: an OpenTimestamps proof asserting a
> Bitcoin commitment at block height `<height>` covers this run's sealed design
> digest. Checking that commitment requires Bitcoin block headers on the
> verifier's side; if it holds, it shows the design existed no later than that
> block — and nothing else about the run.

The authority-time form may assert (its cryptography is fully carried); the
chain-time form is attributive (its chain evaluation is not) — the assertive
chain-time statement lives only in the report of a verifier that evaluated
headers. The trailing authority caveat in the first form is not hedging; it is
RFC 3161's own security model stated plainly (§3). The authority's certificate
fingerprint stays out of the prose and appears in the claim's `anchors` section
and the verifier's report, where a reader can act on it.

**Multi-anchor composition, pinned:** when several lock anchors are carried,
the replacement sentence is rendered once, from the governing anchor (§4.2's
earliest — by anchored time where byte-embedded, with record-digest order as
the deterministic tiebreak and for time-less chain anchors), and each
additional lock anchor adds one neutral line ("The lock digest additionally
carries a `<class>` anchor of `<genTime|height>`."), ordered by record digest.

[Superseded — the ratified neutral line is recorded in §19.6.]

**The trust-root sentence** — replaced:

> Signatures verify against the bundle-carried public keys minted by this
> workspace; there is no third-party trust anchor on the self-run venue.

becomes:

> Signatures verify against the bundle-carried public keys minted by this
> workspace. The lock digest additionally carries a third-party time anchor,
> checked against trust material supplied on the verifier's side — never
> against roots carried in this bundle.

**`venueHonesty.preRegistration`** widens from the single literal
`"structural-and-append-order-only"` to also permit
`"structural-append-order-and-anchored-time"`. Additive: existing bundles keep
the existing value.

Sentences 1, 3, 4, and 5 of the venue limits (operator control, pinning
axes, self-reported cost, agent-distinctness) are untouched — anchors have
nothing to say about them. When a matrix anchor is also carried, one additional
neutral line reports it ("The terminal results digest carries a third-party
time anchor of `<genTime|height>`."); it upgrades no claim.

### 9.3 Relation to publication ordering

The interoperability profile's `publicRegistration` ordering (§9.3 there) needs
a *comparable ordering authority* between the Run boundary and the first
dispatch boundary. Anchor evidence supplies boundary references of the
substrate kind: two `authority-time` anchors are comparable only within one
authority's clock, per that profile's own comparability rule; `chain-time`
anchors are comparable in chain order. A lock anchor alone never upgrades
`publicRegistration` — that judgment stays owned by the publication profile;
this design only supplies evidence it may consume.

## 10. Policy

- **Producer side** is workspace configuration (§7.3): opt-in by configuration,
  automatic once configured, per-draft disable, failure never blocks, declared
  intent optional. All of it is application/product policy; no record schema
  carries a requirement.
- **Consumer side**: "this reader/venue requires providers X, Y" is an
  acceptance rule evaluated where acceptance happens — a reader's trust policy,
  a venue's admission of *claims* (never of locks). It refuses to accept an
  unanchored claim; it never prevents producing one. This mirrors the
  trust-policy-bit pattern the discovery design already uses for its reserved
  log upgrade.
- **Self-run default**: off until configured, per the issue. Colophon may make
  configuring a provider prominent; that is presentation.

## 11. Conformance kit

Kits precede implementations (§9 of the principles): the kit lands first, and
the first provider implementation must go green against it. Fixtures are
byte-exact and network-free. Proofs are minted by a **kit-only fixture
authority** — a test-only DER encoder sharing the reader's primitives, signing
with a throwaway key whose root only the kit's own verifier configuration
trusts, so the repo never embeds or endorses a real authority. Because the
encoder shares the reader's primitives, every kit-minted token is
cross-validated once, at fixture creation, against an independent RFC 3161
verifier, and the cross-validation is recorded in the kit. **Two captured real
tokens** from independent public authorities (one RSA-signed, one ECDSA-signed,
with their real signer certificates) additionally prove the parser handles
production output; their `genTime` values are historical, so validity
assertions run against each fixture's own window, never the wall clock.

Fixture families, per provider class:

1. **valid complete anchor** over the right digest → `verified` with kit trust
   material, `present` without (this pair also proves trust material is really
   verifier-side); replacement text present;
2. **tampered proof** (signature broken; also: tampered `eContent` against a
   valid `messageDigest` attribute) → `invalid`, loud;
3. **dangling anchor** — valid proof, digest matching no bundle record →
   `invalid`, loud;
4. **kind mismatch** — valid proof, digest matching a bundle record whose kind
   differs from `subject.kind` → `invalid`, loud;
5. **absent anchor** → `absent` disclosed; unconditional text; verification
   passes; and **declared-but-absent** — Run seals anchor intent, bundle
   carries no matching anchor → the distinct disclosure;
6. **pending proof** (OpenTimestamps calendar-only) → `pending` disclosed;
   unconditional text; plus the claim-consistency negative: a pending-only
   bundle whose stored claim carries the anchored text fails;
7. **algorithm floor** — SHA-1 message imprint; SHA-1 SignerInfo digest;
   ESSCertID (v1) signing-certificate attribute → each `invalid`;
8. **splice-catch** — authority-time lock anchor with `genTime ≤ closeAt`
   passes; one with `genTime > closeAt` → `invalid`;
9. **upgraded pair** — pending and complete OpenTimestamps records both
   carried → each reported on its own bytes; the complete one governs; the
   write-once exception admits exactly this pair;
10. **fabricated chain attestation** — structurally complete OpenTimestamps
    proof with an invented commitment → `present` without headers (attributive
    text stands, assertive text never printed), `invalid` with headers;
11. **conflicting anchors** — two anchors, different times → earliest verified
    governs; contradiction surfaced, never merged; multi-anchor copy
    composition rendered per §9.2;
12. **matrix anchor** — carried matrix anchor renders its neutral line and
    upgrades nothing;
13. **text conditionality** — an anchored bundle whose stored claim omits the
    anchored limitation fails claim-consistency, and an unanchored bundle whose
    stored claim asserts one fails it too.

RFC 3161-specific negative fixtures (from the §6.1 rule set): missing or
additional extended key usage; `genTime` outside the certificate validity
window; malformed `genTime` (fractional zeros, missing Zulu); two
`SignerInfo`s; missing `signedAttrs`; signing-certificate attribute naming a
certificate not embedded; `sid` inconsistent with the identified certificate;
unknown critical TSTInfo extension; `tsa` name not among the certificate's
subject names; indefinite-length encoding. Plus the regression fixture: an
existing pre-anchor golden bundle verifies byte-identically under the new
verifier.

## 12. Compatibility

- **Already-published bundles verify unchanged.** All existing closure
  versions — `benchmark-product.claim-package/1`, `/2`, and the
  evidence-native `/3`; `benchmark-product-public-bundle/2`, `/3`
  (accounting-only projection), `/4`, and the evidence-native `/5` — keep
  their check lists, byte shapes, and values; the new check and claim sections
  exist only in claim-package/4 and public-bundle/6.
- **No frozen record kind changes.** Benchmark v1, Run v1, Matrix v1/v2, Report
  payloads and signed kinds, BenchmarkAccounting — all byte-stable.
  AnchorEvidence is additive; anchors attach to already-sealed exact bytes and
  nothing re-canonicalizes a sealed document.
- **No `EvidenceRepository` widening**; no new dependency in trust-core; the
  DER reader and rules respect its existing dependency floor.
- **Workspace storage version unchanged**; the anchoring configuration block is
  optional.
- **Demo-1's bespoke preregistration gate** remains as shipped for its own
  flow; it is named here as the precedent this seam generalizes, and its future
  migration onto the anchor record is an implementation decision, not a
  requirement of this design.
- **Documentation**: the public-bundle contract document gains the new closure
  version, the `anchors/` member, and the check; the product security note
  gains the timing-disclosure item (§13.7). Both stay covered by the
  docs-consistency tests.

## 13. Adversarial dispositions

Consolidated from this session's adversarial lane, the folded draft's review,
and the two fresh reviews (§17); each attack and where it dies:

1. **Owner-controlled compliant authority (backdating).** Undetectable by
   construction under RFC 3161 — so authority identity is *output*
   (`signerCertificateSha256`), time basis is classified (`authority-time` vs
   `chain-time`), acceptability is consumer policy, authority-time anchors are
   barred from binding at-time resolution (§4.1), and the replacement copy
   names the trust reduction. Chain-time anchors do not have this failure
   mode, which is a scoring criterion between classes, not a footnote.
2. **Tamper-then-re-anchor.** The verifier compares the proof's imprint against
   the digest recomputed from authenticated bundle bytes; every dispatched
   cell structurally embeds the original Run digest; earliest-verified-wins
   makes a younger anchor worthless.
3. **Anchor stripped (absence-hiding).** Absence is a reported outcome;
   declared intent sealed into the Run makes stripping visible as
   `declared-but-absent`.
4. **Dangling or mislabeled anchor.** Valid proof over an unreachable digest,
   or a `subject.kind` that misdescribes the resolved record, is `invalid` —
   louder than absence (§8 step 2). Selectors are digest-keyed, so a kind
   label can never route an anchor onto a claim its digest does not back.
5. **Pending presented as complete.** Distinct `pending` status; never flips
   text; never upgraded by a verifier network call; fixture-pinned in both
   directions (families 6 and 10).
6. **Fabricated chain attestation.** Structural replay self-consistency is not
   chain evaluation: without headers the outcome is `present` and the sealed
   chain-time copy is attributive, so nothing assertive prints; with headers
   it is `invalid`, loud (§6.2, §8, family 10).
7. **Timing disclosure to the provider.** Requesting an anchor tells the
   authority a run exists at time T before the operator published anything.
   The digest reveals nothing about content beyond the digest itself (the
   stack's low-entropy caveat applies in principle; Run records are
   high-entropy in practice); configuring an endpoint is the consent; the
   disclosure is documented in the security note rather than left unmentioned.
8. **Bundle-carried trust roots.** Never used for validation; archival only;
   the self-run problem is not re-imported (§8 step 3).
9. **Key rotation/expiry/compromise of the authority.** Verification against
   an expired or archived chain is reported as what it is (certificate facts
   are disclosed with validity windows); a leaked authority key can backdate —
   which is attack 1's trust reduction again, and the reason chain-time and
   multi-authority anchoring exist. ERS renewal is the named long-horizon
   answer.
10. **Algorithm agility confusion.** Digests travel as `(algorithm, value)`
    pairs; SHA-256 floor at every layer of the CMS structure, not only the
    imprint (§6.1 rules 5–6); the token's declared algorithms are checked and
    the digest recomputed under them; mismatch of any is `invalid`.
11. **Replay onto another bundle.** Subjects are whole sealed-record digests
    only (§5 rule 1); a Run digest fixes owner, arms, policy, and `closeAt`,
    so a token is reusable only for the byte-identical Run — the same run.
12. **Result-vocabulary overclaim.** `present` vs `verified` split (§4.3),
    defined class-generically; no single boolean; no summary launders an axis
    upward.
13. **Acquisition/launch race.** The post-launch refusal is re-checked
    immediately before the store step (§7.1), so a launch interleaving with
    the network call cannot slip a weaker fact into storage.

## 14. Non-goals

Binding, per principles §11:

- **No third-party claim schema is adopted.** The claim-semantics layer —
  locked comparative design, per-cell accounting — stays ours; providers
  attest to bytes and time, never to meaning.
- **No named vendor integrations and no default endpoints.** Standards only;
  endpoints and trust roots are configuration; no vendor name appears in
  source.
- **No new signature scheme.** DSSE-only stands for everything Jinn signs; the
  foreign proof formats are carried, not adopted as Jinn signing schemes.
- **Not computation correctness.** No anchor reaches *attested*; TEEs remain a
  later provider class inside the existing TEE scope, and this design only
  leaves them a slot.
- **No re-opening of sealed record families.** Anchors are additive records
  about digests; nothing re-canonicalizes, amends, or wraps an existing sealed
  document.
- **No change to dispatch admission.** The lock discipline itself is out of
  scope; this design makes its ordering evidence portable, nothing more.
- **No change to key-binding at-time resolution.** Authority-time anchors never
  feed it (§4.1); wiring chain-time proof-carrying anchors into it would be a
  separate trust-design amendment.
- **No trust store shipped, no certificate chain authority, no revocation
  service.** The verifier identifies authorities and defers acceptability to
  the consumer.
- **No claim that an anchor proves the design preceded execution**, that an
  authority is independent of the operator, or that anchored bundles are
  "verified" in any collapsed sense.
- **No anchor aggregation or hosted anchoring service.**
- **No anchoring of derived, truncated, or composite subjects.**

## 15. Relation to existing designs

### 15.1 The folded lock-anchor draft

An unmerged same-day draft designed #2756 as a self-contained product feature:
RFC 3161 only, a product-scoped bundle member (`benchmark-product.lock-anchor/1`
wrapping the raw token), a closed `"rfc3161"` string as the extension point, and
an always-present `anchor` result block instead of a named check, avoiding a
closure version bump. Per owner ruling (2026-08-17) it is folded here rather
than landing separately. What survives verbatim or near-verbatim: the standards
audit detail, the anchored subject (`runSha256`, nothing new minted), the core
verification rule set (§6.1, extended by review findings), the `runAnchor`
operation design and its refusal rules, verify-before-store, the never-blocking
CLI composition, the `present`-not-`verified` vocabulary caution, the fixture
inventory including captured real tokens and the regression bundle, the
compatibility posture, and the timing-disclosure finding. What this design
changes, per the session's approved rulings: the extension point is a provider
profile URI behind the tier-1 contract, not a closed literal; the carrier is
the tier-2 AnchorEvidence record, not a product-scoped member; reporting is the
`integrity-anchors` named check under new closure versions, not a side block
(the draft's seventh-check-breaks-published-bundles concern is real and is
answered by the version bump — old closures keep their six checks byte-stable).

### 15.2 Everything else

- **Trust design §20** ("anchor-surface unification") — executed by §4–§5, with
  the §4.1 carried amendment scoping which anchor class serves which purpose.
- **Benchmarking design §7.2** — this design supplies leg (b)-grade third-party
  time on the self-run venue without the marketplace; the marketplace venue's
  chain-based leg (b) is unchanged, and how a marketplace run additionally
  carries proof-carrying anchors is future composition (§16).
- **Evidence-first amendment §7** — anchor state joins as its own disclosure
  fact per §9.1; no existing axis is redefined.
- **Publication interoperability profile §9.3** — anchor evidence can back
  substrate-kind boundary references; comparability rules stay owned there
  (§9.3 here).
- **TEE scope** — untouched; §6.4 places the future class inside it.
- **Demo-1 preregistration** — the generalized-away precedent (§12).

## 16. Follow-ups (implementation issues to file on approval)

Problem-framed, typed, filed only after this design is approved:

1. **AnchorEvidence record kind + conformance kit** (`feat`) — schema, sealing
   fixtures, the kit of §11; precedes everything below.
2. **RFC 3161 provider** (`feat`, closes #2756) — trust-core timestamp module,
   injected ports, `runAnchor`, CLI, bundle carriage, check, copy. Green
   against the kit.
3. **OpenTimestamps provider** (`feat`) — pending/upgrade lifecycle,
   header-supplied evaluation.
4. **Certificate-port criticality** (`fix`-grade follow-up) — widen the
   certificate port to surface extension criticality, closing §6.1 rule 9's
   recorded gap.
5. **Dispatch timestamps in the assembly header** (`design` first) — would make
   "anchored before first dispatch" offline-checkable; a different claim and a
   schema change, deliberately not smuggled in here.
6. **Marketplace composition** (`design` later) — one honesty statement when a
   run carries both chain-based ordering and proof-carrying anchors.

## 17. Review disposition

Two fresh independent reviews ran before this document was presented for
approval, per principles §12: an architecture review (which also verified every
repository-fact claim against source — all confirmed) and a
standards/adversarial review (which verified the RFC 3161 rule set against
RFC 3161/5652/5035/5816 and the IANA registry). Both returned BLOCK with
contained dispositions; all blocking findings are resolved in this version:

| # | Finding (blocking) | Disposition |
|---|---|---|
| A1 | Calling authority-time TSAs "§7.3-conforming" silently licensed them into binding at-time resolution, re-opening back-dated attribution | §4.1 rewritten: per-class properties; authority-time proof-carrying anchors are **not** binding-anchor surfaces; recorded as a carried trust-design amendment (header, §14) |
| A2 | The Matrix anchor was unreachable — `runAnchor` had no subject selector and refused post-launch | §7.1 rewritten with `subject: "lock" \| "matrix"` and per-subject transition rules |
| A3 | OpenTimestamps block *time* is not a byte-fact, breaking claim-consistency determinism | chain-time claim facts are the block **height**; block time is verifier-report content (§6.2, §7.4) |
| S1 | `application/timestamp-reply` denotes a TimeStampResp; the record carries a bare token | media type corrected to `application/vnd.etsi.timestamp-token` (§5, §6.1) |
| S2 | No algorithm floor on the CMS layer — SHA-1 SignerInfo digests and ESSCertID admissible | §6.1 rules 5–6: SHA-256-family allowlist at every layer; SigningCertificateV2 required; fixtures added (family 7) |
| S3 | "Lock-subject anchor" undefined; `subject.kind` never checked; `closeAt` violation outcome unspecified | §8: digest-keyed selectors defined; kind-equality rule added (`invalid` on mismatch); `closeAt` violation is `invalid`; fixtures added (families 4, 8) |
| S4 | Byte-facts text keying unsound for chain-time: fabricated attestations are structurally complete; chain-time copy demanded a fact the bundle cannot carry | chain-time sealed copy is attributive (assertive form is verifier-report-only); `present` redefined class-generically to cover complete-without-headers; fixture added (family 10) (§4.3, §6.2, §8, §9.2) |
| S5 | Extracted-facts serialization unpinned (`issuerDn` non-canonical; `genTime`/`accuracy` rendering) | `issuerDn` and `accuracy` dropped from byte-compared facts; `genTime` rendering pinned to one pure positional transform (§6.1, §7.4) |

Non-blocking recommendations adopted: rule-set completeness additions (PKIStatus
gate, nonce omission stated, `sid` consistency, `tsa` name correspondence,
unknown-critical-extension refusal, `genTime` syntax, accuracy semantics —
§6.1); the §9.1 authority-control qualifier; the §3 OpenTimestamps
header-chain qualifier; the acquisition/launch TOCTOU re-check (§7.1); kit
cross-validation against an independent verifier and the added fixture
families (§11); tier-labeling of the check implementation corrected to product
tier with a promotion trigger (§2); family-qualified compatibility lists
(§12); the v1 inline-only proof rule replacing the unfixtured overflow form
(§5); multi-anchor copy composition pinned (§9.2); outcome vocabulary split
into proof outcomes vs context outcomes (§4.3, §8); the low-entropy digest
hedge (§13.7); and the issue-criterion deviations named explicitly (§18).

## 18. Provenance

Designed in a dedicated `design`-shape session (worktree
`pluggable-integrity-providers-c59aea`, 2026-08-17) under the stack design
principles §12 pattern: four read-only research lanes (trust/evidence seams;
bundle current behavior; standards audit; constraints and adversarial review),
coordinator-owned reconciliation, six material questions approved one at a time
by the product owner, the fold-in ruling of §15.1, and two fresh independent
reviews with all blocking findings resolved before presentation (§17).

The session was chartered by issue #2756's deliberately problem-framed
acceptance criteria, which this design satisfies: opt-in with configurable
endpoints; offline verification as a distinct named check; absence reported and
never silently passed; anchor failure never blocking a lock; replacement
limitation text stating what the anchor proves and what it does not; and no
vendor dependency anywhere. Two readings of those criteria are deliberate and
named rather than silent: the replacement text keys on byte-facts rather than
on the criterion's word "verified," because a verifier's trust material varies
by environment while cryptographic validity is still enforced loudly
(`invalid` fails the bundle — §8); and "never blocks or delays a lock" is read
as governing the lock transition, which always completes before any anchor
attempt begins — the CLI verb may then spend a bounded timeout acquiring the
anchor (§7.2).

## 19. Implementation addendum — 2026-08-18

The design was implemented as nine packets on `integration/anchor-evidence`
(issues #2758, #2759, #2760), each with an independent review before merge;
every review round produced findings, and every finding was resolved before
its packet merged. This section records the ratified dispositions — each is a
small clarification of, or precision on, the sections named, made under the
designs-are-law rule with the deviation surfaced at the time. Where a rule
below tightens the body text, this addendum governs.

### 19.1 The record (§5)

- **Base64 is canonical, padded, standard-alphabet only** — the encoding is
  part of record identity, so one proof has exactly one spelling; URL-safe,
  unpadded, and non-canonical trailing bits are refused. Empty
  `proof.content` is refused. The 64 KiB cap is inclusive.
- **Exactness is `parseExactAnchorEvidence`'s job**: schema validation of
  decoded JSON accepts spellings (BOM, pretty-print, duplicate keys) that are
  not the record; any consumer selecting or identifying an anchor uses the
  exact parser, and proof content is decoded only by the exported canonical
  decoder.

### 19.2 The provider contract (§4.3, §6.1 ports)

- The signature port carries `digestAlgorithmOid`, set from the SignerInfo
  digest algorithm; the port derives its hash from it and never from a
  platform default (bare `rsaEncryption` names no digest; the SHA-256-family
  floor binds through this field). The signature-algorithm allowlist admits
  bare `rsaEncryption` and `ecdsa-with-SHA512` — both observed in production
  tokens.
- The certificate port's `sid` is plural: every identifier form the
  certificate supports, matched any-of by rule 7 (a singular field is not
  implementable).
- A third injected port, the chain verifier, is required for `verified`
  (chain-to-caller-roots exceeds the two sketched ports without parsing
  X.509 in core). Issuers must be CA-marked; a leaf byte-identical to a
  supplied root is an RFC 5280 zero-length path, validity-checked.
  Revocation, path-length, and name constraints are disclosed as unchecked
  (issue #2761's family). Verifiers additionally declare their class,
  posture, and time basis; `present` results carry facts but never `time`.

### 19.3 RFC 3161 profile (§6.1)

- Rule 5's floor binds through the SignerInfo digest algorithm when the
  signature algorithm names no digest; for RSASSA-PSS the parameters'
  hash is extracted, floored, and must equal the SignerInfo digest
  algorithm (RFC 4056 §3), with salt and trailer carried to the port.
- Rule 6, precisely: `SigningCertificateV2` is required and binding; a v1
  `SigningCertificate` attribute *alongside* it is ignored (production
  tokens carry both); v1 *instead of* v2 refuses. An absent
  `ESSCertIDv2.hashAlgorithm` is SHA-256 by ASN.1 DEFAULT; the explicit
  SHA-256-family spelling is accepted; an explicit non-family algorithm
  refuses.
- Rule 12 requires a SHA-256 imprint outright: §5 admits only sha256
  subjects, so any other imprint is incomparable and refuses.
- Extracted `serialNumber` is the lowercase hex of the DER INTEGER content
  octets (sign octet preserved) — the only rendering that survives
  byte-comparison across implementations.
- A chain that does not reach the caller's roots — including a supplied but
  non-matching root set, or a throwing chain port — yields `present`, never
  `invalid`: authority acceptability is consumer policy; cryptographic
  failure of the token itself remains `invalid`.

### 19.4 OpenTimestamps profile (§6.2)

- Replay walks the full forked tree; a complete branch governs over pending
  siblings. Attestation classes this profile does not know are walked and
  contribute nothing (a proof with only unknown classes is `pending` with a
  reason); hash operations outside the floor (SHA-1, RIPEMD-160) refuse the
  proof, while foreign-chain commitment operations (Keccak-256) are walked
  as scope, not refused as weakness.
- Among several Bitcoin attestations the earliest *evaluated* height
  governs; a proof carrying any fabricated commitment beside a matching one
  is `invalid` — a poisoned artifact, not a partially good one.
- Headers are supplied per height; a supplied set lacking the attested
  height, and malformed supplied material, both read as
  material-not-supplied → `present`. On `verified`, `time` is the supplied
  header's timestamp (block precision). The extracted byte-fact is
  `blockHeight`. Non-minimal varuints are accepted (reference-compatible),
  bounded at nine septets.

### 19.5 Producer operations (§7)

- The acquisition floor is per profile: `rfc3161-tsa/v1` stores `present` or
  better; `opentimestamps/v1` additionally stores `pending` (the upgrade
  lifecycle requires it). `invalid` is never stored. Acquisition transport
  failures and rejections are `venue-unavailable`.
- Write-once per `(subject, provider)` is enforced durably in the state
  schema — a second entry requires `upgradesRecordSha256` naming an earlier
  entry of the same pair (only upgrade-capable profiles admit one) — and
  re-checked at the pre-store boundary beside the launch fence, closing the
  acquisition-window race.
- **The anchoring window closes at `report`**, for both subjects: the claim
  is sealed then, and a later anchor could never be projected. The sealed
  Report's `limitations` stay unconditional; the anchored copy lives in
  `venueHonesty` and the trust-root statement, so a post-close upgrade
  cannot drift a sealed record.
- The calendar upgrade endpoint is derived from the pending node's
  commitment; upgrade responses are fetched only from the configured
  calendar list (a URI inside proof bytes is never dereferenced
  unvalidated), under one per-operation time bound. Multi-calendar
  endpoints are a comma-separated list. Per-draft disable governs the
  automatic path only; a per-invocation `--no-anchor` skips one lock's
  attempt. Configured endpoints are https-only; the per-invocation override
  admits http as a documented deferral.
- The anchor-intent extension admits only URIs under
  `https://spec.jinn.network/trust/anchor-profiles/` — an endpoint cannot
  be smuggled structurally. `anchoring.configure` is approval-gated
  (configuring an endpoint is the §13 consent); `anchor` itself is not.
  §7.2's chaining applies to every lock surface, GUI included.

### 19.6 Bundle and verification (§7.4, §8, §9.2)

- The anchored closure is selected by **anchors carried OR intent
  declared** — a declared-but-absent bundle must ride `/6` or the
  disclosure could never run. `claim-package/4` requires the `anchors`
  section to be present (possibly empty); `/1` and `/2` forbid it.
- `upgradesRecordSha256` in the claim section is derived from the carried
  set (emitted only where a subject-provider group holds exactly one
  pending and one completed proof), never stored in a record — §5 rule 3's
  nothing-derivable discipline.
- Multi-anchor ordering: timed anchors sort by their byte-embedded time and
  precede time-less chain anchors, which sort by record digest; `<class>`
  renders as the time basis. The neutral line reads: "The lock digest
  carries an additional `<class>` anchor of `<genTime|height>`." (§9.2's
  original template mis-declined the article; `/4` was unpublished, so the
  string is corrected here rather than versioned around.)
- The default (human) reader output prints each carried anchor's status,
  time basis, byte-embedded time, and whether trust material evaluated it,
  plus each subject's context outcome — absence and declared-but-absent are
  named on the surface the claim pins, not only in JSON. The reader CLI
  accepts verifier-side trust material (`--tsa-root`, `--ots-headers`);
  none ships.
- Malformed anchor-intent extension values refuse as `record-integrity`
  (typed), never as an environment error.

### 19.7 Open edges (deliberate refusals, future allocations)

- An anchored run with binary qualification refuses at materialize: no
  closure version expresses both; a later allocation may.
- Retro-anchoring a reported run refuses (§19.5); anchoring evidence for
  already-published historical bundles is future work.
- The evidence-native closures (`claim-package/3`, `public-bundle/5`) adopt
  the anchor surface in their own later allocation, per §7.4.

Provenance: packet PRs #2764, #2765, #2767, #2772, #2773, #2780, #2781,
#2783; conformance fixtures include two captured production tokens and a
Bitcoin-attested real proof (block 962949) whose verification was
independently re-derived during review. Follow-ups filed: #2761 (criticality
port), #2762, #2763 (design stubs), #2766 and #2782 (pre-existing CI flakes
surfaced by the program).
