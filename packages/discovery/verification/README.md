# `@jinn-network/verify`

**Experimental.** Names, options, and results may change between versions.

Checks Jinn records by the rules in
[Verifying a record by hand](https://github.com/Jinn-Network/spec#verifying-a-record-by-hand),
including records that belong to no Colophon bundle. Nothing here reads a network, a file, or a
clock. A record that fails a check is an answer, not an exception.

```ts
import { checkRecord, checkRecordSet } from "@jinn-network/verify";

const report = await checkRecord(bytes, { digest: "sha256:..." });
report.kind;     // "https://spec.jinn.network/records/task/v1", or "unknown"
report.outcome;  // "failed", "unknown-kind", or "checked"
report.checks;   // [{ id: "digest", status: "passed", findings: [] }, ...]

const set = await checkRecordSet({ records: [{ bytes }], roots: ["sha256:..."] });
set.summary;     // what ran, by check and by kind
set.checks;      // references, lifecycle, anchors
```

## Results

A check result is `{ id, status, findings }`. `status` is `passed`, `failed`, or `skipped`, and each
finding is `{ code, subject?, path?, detail }`. A check that did not run says `skipped` and why. On
`passed`, findings say what the check did not cover. Every report carries every check.

`checkRecord` reports five:

| Check | What it does |
| --- | --- |
| `digest` | Compares the claimed digest with the hash of the exact bytes. Skipped when none is claimed. The report's `digest` field is always the hash. |
| `encoding` | Compares the bytes with RFC 8785 of their own raw parse. Never re-canonicalizes a record it was handed. |
| `schema` | The schema of the type the record names, with the family's structural rules. |
| `signature` | Each DSSE signature, over the pre-authentication encoding of the exact payload bytes. |
| `trust-binding` | Whether a trust record binds a verified key to the identity the record claims, through `verifyEnvelopeBinding`. |

`checkRecordSet` adds three:

| Check | What it does |
| --- | --- |
| `references` | Walks from `roots` and follows every digest a known record cites. A record that must be held and is not is `dangling`. Bytes the family lets a reader lack are `unavailable`, not a failure. |
| `lifecycle` | Folds each Attempt's observations with `foldObservations`, holds the log against the Deliveries in the set, and applies §11.3 rule 1 to `supersedes`. |
| `anchors` | Evaluates each AnchorEvidence record over the record it names. |

`outcome` is deliberately not a verdict. `checked` means the kind is known and nothing failed, and
`summary` counts what ran instead of rolling it up. A report of all `skipped` signatures and no
failures has not shown who signed anything.

## Kinds

`defaultRecordKinds` is keyed by the spec's type identifiers and wired to each family's validators.
Add a kind by spreading it into the `kinds` option.

| Family | Kinds | Encoding | Signature |
| --- | --- | --- | --- |
| Task execution | Task, Submission, Delivery | RFC 8785 | Unsigned in core. An envelope is verified and held to the sealed bytes. |
| Task execution | Lifecycle Observation | Not required: §6.1 seals only the three above | Unsigned in core |
| Execution evidence | Execution Evidence | Not required | Unsigned |
| Execution evidence | Result Evaluation, Execution Verification | Not required; any JSON spelling of the envelope | Keys from the caller, or from a `did:key` keyid |
| Execution evidence | Offer | Sealed envelope and payload | Required |
| Trust | Key binding, Revocation, Authorization, Trust policy | Sealed envelope and payload | Required. A key binding must be signed by the key it binds. |
| Trust | Anchor evidence | RFC 8785 | Sealed, not signed: the proof is the authority's signature |
| Task profiles | Evaluation specification, Profile document | RFC 8785 | Unsigned |

The Execution Evidence Profile applies conformance "to the exact bytes supplied to a validator" and
asks for no canonical form, and its golden vector is pretty-printed. So the `encoding` check says
`skipped` for that family and gives that reason, and a claim's envelope is read in any spelling.

Record discovery's entries and heads are not registered. A feed is verified as a chain, by
`@jinn-network/record-discovery-client`. They report as unknown, as do the environment and trace
records and any application's own kinds.

A record no kind claims is reported as `unknown`, with only `digest` and `encoding` checked. If it
names a type under `https://spec.jinn.network/`, it is held to RFC 8785, because application records
follow the same disciplines. If it names no type it may be an artifact, so failing the comparison
is `skipped`, not `failed`.

## What passing does not show

- **A digest shows the bytes are the ones asked for.** It does not show who wrote them.
- **A schema shows the record is interpretable.** It does not show its claims are true, or that the
  work was good. The Execution Evidence Profile says the same of its own conformance.
- **A signature shows a key signed.** Only `trust-binding` ties a key to an identity, and only as far
  as its resolver can see. A `did:key` is the key, not who holds it.
- **Distinct keys are distinct keys.** Nothing here shows they belong to distinct parties.
- **An anchor that is `present` was not evaluated.** Without trust material its time is unchecked.
  One `pending` has no attestation yet.
- **A closed reference walk covers known kinds.** Records of unknown kind are opaque to it, and
  anything `unavailable` was not looked at.
- **A lifecycle folds the log it is given.** Between implementations with no venue, nothing yet says
  who mints an attempt number, so a fold cannot show that two operators did not collide.
- **Passing these vectors here is not interoperability.** One implementation exists, and some
  expectations still live in its tests rather than in the vector corpus. See
  [What is not yet proven](https://github.com/Jinn-Network/spec#what-is-not-yet-proven).

`createStaticBindingResolver` resolves key bindings a caller holds, for checking a set offline. It
sees no anchors, so a backdated `validFrom` is believed, and no revocations, so leave a revoked
binding out of the list. `agentId`, `oidc-machine` and `github-human` bindings do not resolve, because
trust-core leaves those ceremonies to the resolver and a list of bytes cannot run them.

Trust policy chains are not walked here. `verifyPolicyChain` in `@jinn-network/trust-core` does that.

## Primitives

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
| `evaluateAnchors(input)` | Every anchor record and every subject, with subjects passed as data and refusals worded by the caller if it wants. |

## `verifyDsseSignatures`

```ts
const { validSignerKeyids } = verifyDsseSignatures(envelopeBytes, [{ keyId, publicKey }]);
```

A signature counts when its `keyid` names one of `keys` and it verifies over the DSSE
pre-authentication encoding of the exact payload bytes. By default the check is strict. A caller
that wants less must ask by name:

| Option | Default | When set |
| --- | --- | --- |
| `allowRespelledEnvelope` | `false` | Accepts any JSON spelling of the envelope, not only the exact bytes `sealDsseEnvelope` writes. |
| `allowNonEd25519Keys` | `false` | Verifies under any key type `node:crypto` can verify, not only Ed25519. |
| `keepRepeatedSigners` | `false` | Reports a key once for each signature it made, not once overall. |
| `requireSingleSignature` | `false` | Refuses an envelope carrying more than one signature. |

## Limits

`createDidKeyDsseVerifier` reads Ed25519 `did:key` identifiers only. A signature under a `did:pkh`,
a secp256k1 `did:key`, or no `keyid` at all is not reported as valid. `checkRecord` reports such a
signature as not verified, never as passed, and it verifies only Ed25519 keys, including keys the
caller supplies.

`nodeCryptoAnchorPorts` checks issuance, key usage, basic constraints, and validity at the instant
the caller names. It does not check revocation, `pathLenConstraint`, or name constraints.

## Development

Use Node 22 and Yarn 4.13.0. Build `@jinn-network/trust-core`, `@jinn-network/trust-testing`,
`@jinn-network/record-discovery-protocol`, `@jinn-network/task-execution-protocol`,
`@jinn-network/task-execution-profiles`, `@jinn-network/evidence-protocol` and
`@jinn-network/evidence-offer` first, since all are reached through portals.

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
