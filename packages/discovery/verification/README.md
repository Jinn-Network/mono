# `@jinn-network/verify`

**Experimental.** Names, options, and results may change between versions.

General checks for Jinn records, written from the rules in
[Verifying a record by hand](https://github.com/Jinn-Network/spec#verifying-a-record-by-hand).
Nothing here reads a network, a file, or a clock. An envelope, signature, or `did:key` that fails a
check is an answer, not an exception.

| Export | What it does |
| --- | --- |
| `recordDigest(bytes)` | `sha256:<hex>` over the exact bytes. Never canonicalizes. |
| `didKeyFromEd25519PublicKey(key)` | The `did:key` of an Ed25519 public key. Throws on any other key type. |
| `ed25519PublicKeyBytesFromDidKey(id)` | The 32 raw key bytes a `did:key` carries, or `undefined`. |
| `ed25519PublicKeyFromDidKey(id)` | The same key as a `node:crypto` `KeyObject`, or `undefined`. |
| `verifyEd25519Signature(key, message, signature)` | One Ed25519 signature, for a caller that already holds the signed bytes. |
| `verifyDsseSignatures(envelope, keys, options)` | Which of `keys` signed a sealed DSSE envelope. |
| `createDidKeyDsseVerifier()` | The DSSE verifier port `@jinn-network/trust-core` leaves open, for `did:key` signers. |
| `nodeCryptoAnchorPorts` | The `node:crypto` ports `createRfc3161AnchorProofVerifier` injects. |

## `verifyDsseSignatures`

```ts
const { validSignerKeyids } = verifyDsseSignatures(envelopeBytes, [{ keyId, publicKey }]);
```

A signature counts when its `keyid` names one of `keys` and it verifies over the DSSE
pre-authentication encoding of the exact payload bytes. By default the check is strict. A caller
that wants less must ask by name:

| Option | Default | When set |
| --- | --- | --- |
| `allowRespelledEnvelope` | `false` | Accepts anything `parseDsseEnvelope` reads, not only the exact bytes `sealDsseEnvelope` writes: other whitespace, member order and string escapes, unknown and repeated members, a byte order mark, and URL-safe, unpadded, or non-canonical base64 in `payload` and `sig`. |
| `allowNonEd25519Keys` | `false` | Verifies under any key type `node:crypto` can verify, not only Ed25519. |
| `keepRepeatedSigners` | `false` | Reports a key once for each signature it made, not once overall. |
| `requireSingleSignature` | `false` | Refuses an envelope carrying more than one signature. |

A threshold counts distinct `keyid`s, not distinct keys. A caller that lists one public key under two
ids gets two. `createDidKeyDsseVerifier` cannot produce that for a key anyone holds; only a key nobody
holds, such as the small-order keys below, has a second spelling.

## Limits

`verifyDsseSignatures` and `createDidKeyDsseVerifier` report what `node:crypto` reports. A small-order
public key verifies any message, so a passing signature means something only with a trust record
that binds a real key.

Each signature check hashes the whole payload, so cost is signatures times payload bytes, and
signatures times listed keys that share a `keyId`. Bound the size of an envelope before passing it in.

`createDidKeyDsseVerifier` reads Ed25519 `did:key` identifiers only. A signature under a `did:pkh`,
a secp256k1 `did:key`, or no `keyid` at all is not reported as valid.

`nodeCryptoAnchorPorts` checks issuance, key usage, basic constraints, and validity at the instant
the caller names. It does not check revocation, `pathLenConstraint`, or name constraints.

## Development

Use Node 22 and Yarn 4.13.0. Build `@jinn-network/trust-core` and `@jinn-network/trust-testing`
first, since both are reached through portals.

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
