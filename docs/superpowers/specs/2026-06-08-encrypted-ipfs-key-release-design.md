# Suggested Spec: Encrypted IPFS Key Release for Paid Artifacts

Status: suggested follow-on design
Date: 2026-06-08
Scope: capture and corpus artifact access

## Summary

Paid Jinn artifacts should use encrypted IPFS storage plus x402-gated key
release. The public network should receive signed metadata, hashes, prices,
and encrypted content addresses. It should not receive paid plaintext bytes.

The current daemon-served x402 path remains valid as a compatibility access
mode. New paid capture artifacts should prefer encrypted IPFS:

- Free/public artifacts can be plaintext IPFS artifacts.
- Paid artifacts are encrypted with one fresh data key per artifact.
- The encrypted artifact is pinned to IPFS.
- The signed envelope records the plaintext hash, ciphertext CID, encryption
  metadata, key-release endpoint, and price.
- Consumers fetch ciphertext from IPFS, pay the x402 key-release endpoint, get
  the artifact data key wrapped to their public key, decrypt locally, and verify
  the plaintext hash from the signed envelope.

This makes IPFS useful for durable distribution without turning paid access into
an honor-system wrapper around public bytes.

## Motivation: a current paid-access bypass

This is not hypothetical. The capture publish path already uploads every
artifact's plaintext to public IPFS as a `jinn.artifact.donation.v1` blob and
records a price on the same artifact (`publishArtifact` in
`client/src/captures/live-publisher.ts`). The published artifact therefore
carries both `access: { endpoint, priceUsdc }` and a plaintext
`sources: [{ kind: 'ipfs', cid }]` (`client/src/captures/publish.ts`). The
consumer acquire chain tries the public IPFS donation source (step 2) *before*
the paid route-resolver and returns the bytes at `paidAmountUsdc: '0'`
(`client/src/corpus/acquire.ts`).

Today `DEFAULT_PRICE_USDC` is `'0'`, so the bypass is latent. The moment an
operator sets a non-zero per-artifact-type price, the artifact is priced yet
freely fetchable from any IPFS gateway, and the standard consumer path takes the
free door — x402 is bypassed end to end. Encrypted key release closes this, and
the priced-artifact invariant in "Invariants" below makes the bypass
unrepresentable rather than merely discouraged.

## Goals

- Preserve content-addressed discovery and verification for paid artifacts.
- Avoid publishing paid plaintext bytes to public IPFS.
- Keep x402 as the payment mechanism.
- Keep capture envelopes public and indexable.
- Use one encryption key per artifact to limit blast radius and support
  independent pricing.
- Let operators publish paid trajectories and harness bundles without serving
  large artifact bytes from the daemon. This removes the byte-serving and
  bandwidth burden; it does not remove the daemon-liveness requirement, since key
  release still needs the operator (or a delegated key server) online at purchase
  time.
- Keep the design additive to the current artifact access path.

## Non-Goals

- Do not attempt DRM. After a buyer receives a key and decrypts an artifact,
  they can redistribute the plaintext or key.
- Do not put key release on-chain in this version.
- Do not require trusted execution or threshold cryptography.
- Do not replace x402 content-serving immediately.
- Do not make the operator signing wallet the artifact encryption key.

## Access Modes

Artifact access becomes an explicit mode union.

### `public-ipfs.v1`

Plaintext artifact bytes are public and free.

Use for:

- free trajectory artifacts
- public donation artifacts
- non-sensitive public harness bundles
- backward-compatible donated corpus data

### `x402-content.v1`

The current daemon-served model. The artifact plaintext is held in the operator
daemon store and served from `/v1/artifacts/:sha256/content` after x402 payment.

Use for:

- backward compatibility
- local/testnet development
- operators that cannot pin encrypted IPFS blobs yet

### `x402-key-release.v1`

The preferred paid-artifact mode. The ciphertext is public on IPFS. The
decryption key is released after x402 payment.

Use for:

- paid capture trajectories
- paid harness bundles
- paid final-state archives
- large artifacts where IPFS distribution is better than daemon byte serving

## Artifact Identity

The artifact's canonical identity remains the plaintext SHA-256 hash.

For encrypted artifacts, the signed envelope records both plaintext and
ciphertext identity:

```ts
type EncryptedArtifactAccess = {
  mode: 'x402-key-release.v1';
  endpoint: string;
  priceUsdc: string;
  encrypted: {
    cid: string;
    plaintextSha256: string;
    ciphertextSha256: string;
    algorithm: 'aes-256-gcm';
    nonce: string;
    keyId: string;
    keyVersion: number;
  };
};
```

The top-level artifact `sha256` remains equal to `encrypted.plaintextSha256`.
Consumers must verify:

1. The fetched IPFS bytes hash to `ciphertextSha256`.
2. The decrypted plaintext hashes to `plaintextSha256`.
3. The plaintext hash matches the artifact `sha256` in the signed envelope.
4. The envelope's `encrypted.algorithm` — and the `wrapAlgorithm` returned in the
   key-release response — are recognized values. Unknown algorithms MUST hard-fail
   rather than silently fall back to any default.

Existing public IPFS donation sources must not be reused for encrypted paid
artifacts unless the schema distinguishes them from plaintext donation sources.
Encrypted artifacts need a distinct access mode so old clients do not treat an
encrypted CID as a free plaintext artifact. See "Invariants" — a priced artifact
must never carry a plaintext donation source, enforced at both publish and
acquire time.

## Invariants

These hold for every artifact and are enforced in code, not left to operator
discipline:

1. **A priced artifact never carries plaintext bytes.** If `access.priceUsdc` is
   non-zero, the artifact MUST NOT carry a plaintext `sources[].kind === 'ipfs'`
   donation source (or any other public plaintext source). A paid artifact's only
   public bytes are ciphertext under `access.encrypted.cid`.

   - **Publish guard:** the publisher refuses to attach a plaintext IPFS donation
     source when the price is non-zero; priced artifacts take the
     `x402-key-release.v1` path and pin ciphertext only.
   - **Acquire guard:** the consumer does not take the free public-IPFS donation
     fast-path for an artifact whose access mode is paid. The donation fast-path
     applies only to `public-ipfs.v1` artifacts.

   This makes the bypass in "Motivation" unrepresentable rather than merely
   discouraged.

2. **The plaintext SHA-256 is the artifact identity in every mode.** Ciphertext
   identity is recorded alongside it but never replaces it.

## Cryptography

Each artifact gets a fresh random data encryption key:

- `DEK`: 32 random bytes, generated per artifact.
- Content encryption: AES-256-GCM with a fresh nonce.
- Additional authenticated data binds the ciphertext to Jinn artifact metadata.
  The AAD MUST be deterministically reconstructable by any decryptor from the
  signed envelope alone, so it contains only fields that are stable at encryption
  time and present in the envelope:

```text
jinn.artifact.encrypted.v1
artifactType=<artifactType>
plaintextSha256=<plaintextSha256>
operatorSafe=<operatorSafe>
keyId=<keyId>
keyVersion=<keyVersion>
```

`captureCid` is deliberately excluded from AAD: it is not known until the
envelope is signed and pinned, so including it would make the AAD
non-reproducible at decrypt time. Binding the encrypted metadata to the capture
is the job of the envelope signature, not the AEAD AAD.

The operator has a local key-encryption key:

- `KEK`: operator-local secret used only to wrap artifact DEKs at rest.
- The KEK must not be the operator wallet private key.
- The KEK should be stored in the OS keychain when available, or in a daemon
  secret file with restrictive permissions as a fallback.
- Rotating the KEK rewraps stored DEKs. It does not require re-encrypting IPFS
  ciphertext.

`keyId` / `keyVersion` identify the **KEK** used to wrap the artifact's DEK — not
the per-artifact DEK, which is random and never identified on its own. A KEK
rotation mints a new `keyVersion`; rewrapping a stored DEK updates the artifact's
`key_version` and `wrap_algorithm` and leaves the IPFS ciphertext untouched.

The key-release response should not return a raw DEK over the wire. The consumer
sends an ephemeral public key, and the daemon returns the DEK encrypted to that
public key. HPKE is the preferred envelope for this. A local test path may use
TLS-only raw key release behind a feature flag, but that should not be the
production design.

## Data Model

Add an artifact key table to the daemon store:

```sql
CREATE TABLE artifact_keys (
  artifact_sha256 TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  wrapped_dek BLOB NOT NULL,
  wrap_algorithm TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT
);
```

Add a key-release event table:

```sql
CREATE TABLE artifact_key_release_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  payer TEXT NOT NULL,
  settlement_tx TEXT,
  buyer_pubkey_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_reason TEXT,
  created_at TEXT NOT NULL
);
```

Add an entitlement table:

```sql
CREATE TABLE artifact_entitlements (
  artifact_sha256 TEXT NOT NULL,
  payer TEXT NOT NULL,
  settlement_tx TEXT,
  price_usdc TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (artifact_sha256, payer)
);
```

The entitlement table lets a buyer re-request the same artifact key without
paying again, as long as they authenticate as the same payer. Re-request proves
payer control by signing a daemon-issued challenge nonce with the payer wallet —
not by re-submitting a settled payment payload, which invites replay and
cross-daemon confusion. The entitlement binds to the **payer wallet**, not to any
ephemeral buyer key: on re-request the daemon re-wraps the DEK to whatever fresh
buyer public key the authenticated payer presents.

## Publish Flow

1. Collector produces scrubbed artifact plaintext.
2. Publisher computes `plaintextSha256`.
3. Publisher generates a fresh artifact DEK.
4. Publisher encrypts plaintext with AES-256-GCM.
5. Publisher computes `ciphertextSha256`.
6. Publisher pins ciphertext bytes to IPFS.
7. Publisher wraps the DEK under the local operator KEK.
8. Publisher stores the wrapped DEK in `artifact_keys`.
9. Publisher writes an artifact descriptor with `access.mode =
   'x402-key-release.v1'`.
10. Publisher signs and pins the envelope.
11. Publisher anchors the capture as before.

If `priceUsdc` is `0`, the default should remain public plaintext IPFS unless
the operator explicitly chooses encrypted-free access. Encrypted-free access is
useful for testing and for private allowlist flows, but it should not be the
normal free-data path.

## Acquire Flow

1. Consumer reads a signed envelope from IPFS or the indexer.
2. Consumer sees `access.mode = 'x402-key-release.v1'`.
3. Consumer fetches `access.encrypted.cid` from IPFS.
4. Consumer verifies `ciphertextSha256`.
5. Consumer submits a key-release request with:
   - artifact SHA-256
   - buyer ephemeral public key
   - a payer-wallet signature over the canonical request body
   - x402 payment header, or payer-authenticated entitlement proof
6. Daemon verifies artifact status and payment or entitlement.
7. Daemon unwraps the DEK locally.
8. Daemon encrypts the DEK to the buyer public key.
9. Daemon records the key-release event.
10. Consumer decrypts the DEK.
11. Consumer decrypts the artifact.
12. Consumer verifies `plaintextSha256`.
13. Consumer caches the plaintext and records paid amount.

If payment settles but the key response fails, the entitlement record allows the
consumer to retry key release without paying again.

## Key Release API

```http
POST /v1/artifacts/:sha256/key
Content-Type: application/json
PAYMENT-SIGNATURE: <x402 payment payload>

{
  "schemaVersion": "jinn.artifact.key-request.v1",
  "buyerPublicKey": "...",
  "buyerPublicKeyAlgorithm": "hpke-x25519-sha256",
  "payer": "0x..."
}
```

The request MUST be signed by the `payer` wallet over the canonical request body
(including `buyerPublicKey`), so the released key is attributable to a paying
identity and the daemon binds `buyerPublicKey` to `payer`. Without this binding a
paid buyer can act as a decryption oracle, returning DEKs wrapped to arbitrary
third-party keys; see Security Considerations.

Unpaid paid artifact response:

```http
402 Payment Required
PAYMENT-REQUIRED: <x402 payment requirements>
```

Successful response:

```json
{
  "schemaVersion": "jinn.artifact.key-release.v1",
  "artifactSha256": "...",
  "keyId": "...",
  "keyVersion": 1,
  "wrappedDekForBuyer": "...",
  "wrapAlgorithm": "hpke-x25519-sha256",
  "payer": "0x...",
  "settlementTx": "0x..."
}
```

The daemon must return the same 402 semantics as the existing content endpoint:

- missing artifact: 404
- revoked artifact: 410
- unpaid paid artifact: 402
- malformed payment: 402 with payment requirements
- settlement failure: 402 with error metadata
- successful free or entitled key release: 200

The `410` (revoked) status is new behavior: the existing content endpoint has no
revoked path today and gains one in the same change.

## Operator UX

Capture review should expose artifact access as a clear publishing decision:

- Public/free IPFS
- Paid encrypted IPFS
- Daemon-served paid bytes
- Do not publish artifact

The default policy should be:

- trajectory: public/free during bootstrap, configurable per repo
- harness bundle: encrypted paid when price is non-zero
- final state archive: encrypted paid when enabled
- final patch: public/free for OSS repos, encrypted paid or disabled otherwise

Trusted repo settings should include default access mode and default prices per
artifact type. The review UI should display:

- artifact type
- plaintext size
- encryption mode
- IPFS ciphertext CID when encrypted
- price
- key-server health
- release count and paid revenue after publication

Revoking a paid encrypted artifact must disable future key release. It cannot
revoke keys already released.

## Indexer and Consumer Behavior

The indexer should treat encrypted artifact metadata as public envelope data:

- index artifact type
- index plaintext SHA-256
- index encrypted CID
- index access mode
- index price
- index operator
- index capture CID

The indexer should not need to decrypt paid artifacts. It can fetch encrypted
ciphertext for availability checks, but plaintext enrichment requires a normal
paid acquire path.

The `session-derived.v1` generator should acquire encrypted artifacts through
the same corpus acquire API as every other consumer. It should record paid
amounts and preserve `Task.sourceCaptureCid`.

## Availability

Encrypted IPFS improves byte availability, but key availability still depends on
a key-release server. The first version should use the operator daemon as the
primary key server.

Future delegated key servers can improve availability:

- The operator wraps artifact DEKs to a delegated key server public key.
- The signed envelope lists multiple key-release endpoints.
- Any delegated server can verify x402 payment and release the DEK.

Delegated key servers are trusted with the ability to release keys. They are an
availability feature, not a cryptographic confidentiality improvement.

## Security Considerations

- Per-artifact DEKs limit blast radius.
- Operator KEK compromise exposes every locally wrapped DEK the attacker can
  read, so KEK storage must be hardened.
- Artifact revocation only affects future key release.
- Buyer key wrapping protects the DEK in transit and avoids returning raw keys.
- Plaintext SHA-256 is public. For trajectories this is acceptable because the
  content is high entropy. But the *priced* artifact types — harness bundles,
  final-state archives, and final patches for OSS repos — are exactly the
  guessable or reconstructable cases: an attacker can confirm content by hashing a
  candidate plaintext and matching the public `plaintextSha256`, with no payment.
  For these types, either ship a blinded commitment in v0 or document explicitly
  that their plaintext hash is not confidentiality-bearing. Keep plaintext-hash
  verification for consumers who have legitimately acquired the bytes.
- Buyer public key is not bound to payer unless the key request is payer-signed
  (see Key Release API). Without that signature a single paying buyer can relay
  DEKs wrapped to arbitrary third-party keys, defeating the receipt and
  attribution property. This is inherent to a no-DRM design; the payer signature
  is the minimum that keeps released keys attributable.
- Revocation interacts with IPFS immutability. Ciphertext on IPFS is permanent
  and a released DEK is permanent, so revocation only stops *new* key releases.
  One malicious buyer who leaks a DEK permanently unlocks the public ciphertext
  for everyone they share it with. Operators must price and gate paid artifacts
  with this in mind.
- Paid access is not copy protection. It creates legitimate access control,
  receipts, and attribution.
- Payment and key release must be idempotent enough to recover from crashes
  after settlement.

## Migration Plan

1. Add schema support for explicit artifact access modes. This extends `access`
   from `{ endpoint, priceUsdc }` to a tagged union across the envelope Zod
   schemas (`UnsignedEnvelopeSchema` / `SignedEnvelopeSchema`), the corpus
   envelope projection (`client/src/corpus/envelope-projection.ts`), and the
   indexer projection.
2. Enforce the priced-artifact invariant (see Invariants): the publisher refuses
   to attach a plaintext IPFS donation source when price is non-zero, and the
   consumer acquire chain does not take the public-IPFS donation fast-path for
   paid artifacts. Land this guard first — it closes the current bypass
   independent of the rest of the design.
3. Keep existing `x402-content.v1` content-serving behavior.
4. Add `x402-key-release.v1` publisher support for new paid artifacts.
5. Add acquire support for encrypted IPFS and key release.
6. Update capture review UI to choose access modes and prices.
7. Update docs that currently say paid artifacts are "IPFS-pinned, x402-priced"
   so they distinguish public envelopes from paid plaintext, and reconcile the
   stale `client/src/x402/handler.ts` comment ("artifacts no longer have IPFS
   CIDs") with the live donation-source publish path.
8. Move default paid capture publishing to encrypted IPFS.
9. Keep daemon-served content as compatibility fallback for at least one release
   train.

## Testing Plan

Unit tests:

- per-artifact DEK generation
- AES-GCM encrypt/decrypt round trip
- plaintext and ciphertext hash verification
- artifact key wrapping and KEK rotation
- revoked key status blocks release
- entitlement reuse without double payment
- malformed payment returns 402
- buyer public key wrapping

API tests:

- unpaid key release returns x402 requirements
- paid key release records settlement and event
- retry after entitlement returns key without charging again
- missing artifact returns 404
- revoked artifact returns 410
- unsupported access mode returns a clear error

Corpus tests:

- acquire public plaintext IPFS artifact
- acquire daemon-served x402 artifact
- acquire encrypted IPFS artifact
- reject ciphertext hash mismatch
- reject plaintext hash mismatch
- cache decrypted plaintext with paid amount

Integration tests:

- capture review publishes a paid encrypted trajectory
- ciphertext is pinned to IPFS
- envelope contains encrypted access metadata
- consumer pays x402 key endpoint
- consumer decrypts and verifies the trajectory
- `session-derived.v1` can acquire the artifact through the shared corpus path

End-to-end acceptance:

- captured local agent session
- approved as paid encrypted IPFS artifact
- signed capture envelope pinned and anchored
- indexer shows encrypted artifact metadata
- remote consumer fetches ciphertext from IPFS
- remote consumer pays x402 key endpoint
- remote consumer decrypts and verifies plaintext
- generator can derive a Task with `sourceCaptureCid`

## Open Decisions

1. Whether `x402-key-release.v1` should become the default for every non-zero
   priced artifact immediately, or only for capture artifacts first.
2. Whether the first implementation should use HPKE from a dependency or a
   simpler TLS-only development path behind a non-production flag.
3. (Resolved — see Data Model and Key Release API.) Entitlement reuse is proven
   by signing a daemon-issued challenge with the payer wallet, not by
   re-submitting a settled payment payload.
4. Whether delegated key servers are v0.5 scope or a later availability upgrade.

