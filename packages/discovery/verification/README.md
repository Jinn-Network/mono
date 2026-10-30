# `@jinn-network/verify`

**Experimental.** Names, options, and results may change between versions.

Checks Jinn records by the rules in
[Verifying a record by hand](https://github.com/Jinn-Network/spec#verifying-a-record-by-hand),
including records that belong to no Colophon bundle.

## The command

```sh
npx @jinn-network/verify <path> [--keys <file>] [--json]
```

`<path>` is one record file or a directory of records. A directory is not walked into its
subdirectories, and the report says how many entries it did not read. It reads what it is pointed
at and the documents below from its own install, and opens no network.

| Flag | What it does |
| --- | --- |
| `--keys <file>` | Verifies signatures against the keys in the file. |
| `--json` | Prints the structured report instead, with `formatVersion` and a top-level `failed`. |
| `--help` | Prints usage and exits 0. |

| Exit code | Meaning |
| --- | --- |
| `0` | Nothing failed. |
| `1` | A record failed a check, a set check failed, or a file was over the size limit. |
| `2` | The command was misused, or could not read what it was pointed at. Nothing was checked. |

A file named by its digest, as `<64 hex>` or `<64 hex>.<extension>`, claims that digest, and the
`digest` check compares it. Any other name claims nothing, and `digest` is skipped.

The command reads at most 2,097,152 bytes of any one file. A record's worst case is quadratic in its
size, because each signature hashes the whole payload: about 3 s for a hostile file at this limit,
and 12 s at twice it. The largest record in the public claim below is 436,248 bytes, and this is also
the one limit the specification states for a stored object, in the IPFS repository profile. A larger
file is not read. It is named in the report and fails the run, and anything citing it dangles. A
keys file over the limit is exit code 2. The limit is per file, so a directory of many such files
still takes as long as it takes.

File names, `keyid` values and details printed from a record have control and formatting characters
escaped, so a record cannot add a line to the report or move the cursor.

Every record in a directory is a root of the reference walk. A reference to a document the
specification publishes resolves against the documents below even when the directory does not hold
it. One file is not a set, so references, lifecycle and anchors say they were not checked.

The report prints `passed` only for what ran. This is the output on the public claim
[Judging the LoCoMo judges](https://colophon.claims/reports/locomo-judge-report/), from its
`records/` directory with `--keys ./bundle/trust/public-keys.json`:

```text
Read 41,678 files from ./bundle/records.

Kinds          26,401 known, 4,814 unknown naming a type, 10,463 naming no type
Digest         41,678 passed, compared with each file's own name
Encoding       31,882 passed, 9,796 skipped (5,476 not records, 4,320 not required by family)
Schema         26,401 passed, 15,277 skipped (kind unknown)
Signatures     4,322 verified against keys you supplied, none unverified
Trust binding  skipped: no key was tied to an identity
References     passed for known kinds: 92,162 resolved, 9,600 of them by published documents
Lifecycle      skipped: no observations here
Anchors        not checked: no anchor records here
Completeness   not checked: nothing here says which files should exist

Nothing failed. Skipped and unknown are not passes.
```

"Nothing failed" is the whole of what that last line says. Read it with
[what passing does not show](#what-passing-does-not-show).

### Keys

A keys file is JSON. Every object in it, at any depth, with a string `keyId` and a string
`spkiDerBase64` supplies one key, so a plain list works and so does a larger file that holds such
objects, like a Colophon bundle's `trust/public-keys.json`:

```json
[{ "keyId": "evaluator-key-1", "spkiDerBase64": "MCowBQYDK2VwAyEA..." }]
```

`keyId` is compared exactly with each signature's `keyid`, and `spkiDerBase64` is the public key as
base64 SPKI DER. A signature under a `did:key` needs no file, because the identifier carries the key.

A key you supply says which bytes to check a signature against, and nothing about who holds them.
The report calls such a signature verified against keys you supplied, and `Trust binding` stays
skipped. The command resolves no key bindings, so it never ties a key to an identity.

### Published documents

Records cite task profiles and parser semantics by digest. The specification publishes those
documents, and a reader should not need a network to find them. `loadPublishedDocuments()` returns
20 of them, pinned by digest in `src/published-documents.ts`.

The package carries no copy. The bytes are the files `@jinn-network/task-execution-profiles` ships
under `profiles/`, a runtime dependency, so this adds only the list of pins. Each pin equals the
document's entry in the signed `sealed-platform-v1` manifest of specification release v0.1.0.
Those documents are sealed, so a change is a new document and a new pin. A test fails if a file
drifts from its pin or the owner ships a document with no pin, and a file that does not hash to its
pin is not loaded, so it resolves nothing.

## The library

The checks read no network, file or clock, and a record that fails one is an answer, not an
exception. `loadPublishedDocuments` reads files from the installed dependency, and the command reads
its target.

```ts
import { checkRecord, checkRecordSet, loadPublishedDocuments } from "@jinn-network/verify";

const report = await checkRecord(bytes, { digest: "sha256:..." });
report.kind;     // "https://spec.jinn.network/records/task/v1", or "unknown"
report.outcome;  // "failed", "unknown-kind", or "checked"
report.checks;   // [{ id: "digest", status: "passed", findings: [] }, ...]

const set = await checkRecordSet({
  records: [{ bytes }],
  roots: ["sha256:..."],
  published: loadPublishedDocuments(),
});
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
| `encoding` | Asks whether the bytes are the RFC 8785 encoding of their own raw parse. The answer is a comparison: a digest is always of the bytes received, never of a canonical form. |
| `schema` | The schema of the type the record names, with the family's structural rules. |
| `signature` | Each DSSE signature, over the pre-authentication encoding of the exact payload bytes. |
| `trust-binding` | Whether a trust record binds a verified key to the identity the record claims, through `verifyEnvelopeBinding`, at the time the record states about itself unless `atTime` is passed. That time is the signer's claim. |

`checkRecordSet` adds three:

| Check | What it does |
| --- | --- |
| `references` | Walks from `roots` and follows every digest a known record cites. A record that must be held and is not is `dangling`. Bytes the family lets a reader lack are `unavailable`, not a failure. If every record reached was opaque it says `skipped`. |
| `lifecycle` | Folds each Attempt's observations with `foldObservations`, holds the log against the Deliveries in the set, and applies §11.3 rule 1 to `supersedes`. An Attempt with no `attempt-engaged` has no authoritative source, so it is reported, and a set of only those says `skipped`. It reads no clock, so the provisional `expired` of §10.4 rule 5 is not derived. |
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
| Task execution | Lifecycle Observation | I-JSON (§21.1), not RFC 8785: §6.1 seals only the three above | Unsigned in core |
| Execution evidence | Execution Evidence | Not required | Unsigned |
| Execution evidence | Result Evaluation, Execution Verification | Not required; any JSON spelling of the envelope | Keys from the caller, or from a `did:key` keyid |
| Execution evidence | Offer | Sealed envelope and payload | Required |
| Trust | Key binding, Revocation, Authorization, Trust policy | Sealed envelope and payload | Required. A key binding must be signed by the key it binds. |
| Trust | Anchor evidence | RFC 8785 | Sealed, not signed: the proof is the authority's signature |
| Task profiles | Evaluation specification, Profile document | RFC 8785 | Unsigned. An envelope states the kind's media type. A profile's payload schema must be safe to load (§6.4). |
| Record discovery | Facts profile | Not required: a published document, pinned by the release manifest | Unsigned |

The Execution Evidence Profile applies conformance "to the exact bytes supplied to a validator" and
asks for no canonical form, and its golden vector is pretty-printed. So the `encoding` check says
`skipped` for that family and gives that reason, and a claim's envelope is read in any spelling.

A facts profile is a document the specification publishes, not a sealed record. Its `kind` member
names the record kind it describes, not what it is.

Record discovery's entries and heads are not registered. A feed is verified as a chain, by
`@jinn-network/record-discovery-client`. They report as unknown, as do the environment and trace
records and any application's own kinds.

`task-profiles/prediction-forecast/1.0`, which the specification publishes, fails `schema` here: its
`consensusProbabilityYes` pattern does not pass the `safe-regex` check that
`@jinn-network/task-execution-profiles` applies under §6.4. That check is a static star-height test,
so the pattern may be harmless, but it is the check that package uses, and it refuses the document too.

A record no kind claims is reported as `unknown`, with `digest` and `encoding` checked, and any DSSE
signature whose key is known verified, so a signed record cannot fall out of its kind to escape. If it
names a type under `https://spec.jinn.network/`, it is held to RFC 8785, because application records
follow the same disciplines. If it names no type it may be an artifact, so failing the comparison
is `skipped`, not `failed`. The exception is bytes with DSSE's three members and no readable envelope:
they claim to be signed, so they fail.

## What passing does not show

- **A digest shows the bytes are the ones asked for.** It does not show who wrote them. The command
  compares a file with its own name, which sits beside it: whoever changes the bytes can change the
  name, so `digest` shows a file was not damaged, not that it is the file that was published.
- **The command does not know which files should exist.** Every file is its own root, so a record
  added, or a record nothing known cites, removed or replaced, changes a count and fails nothing.
  To tie a directory to a published claim, compare the claim's own digest by another route.
- **A schema shows the record is interpretable.** It does not show its claims are true, or that the
  work was good. The Execution Evidence Profile says the same of its own conformance.
- **A signature shows a key signed.** Only `trust-binding` ties a key to an identity, and only as far
  as its resolver can see. A `did:key` is the key, not who holds it, and a key you supplied is only
  the key you supplied. A keys file that came with the records shows nothing against whoever handed
  you both.
- **Distinct keys are distinct keys.** Nothing here shows they belong to distinct parties.
- **An anchor that is `present` was not evaluated.** Without trust material its time is unchecked.
  One `pending` has no attestation yet.
- **A closed reference walk covers known kinds.** Records of unknown kind are opaque to it, and
  anything `unavailable` was not looked at, which includes what a signed evaluation cites and the
  evaluation a Delivery lists as an output. A digest in a profile's `payload` is not followed. A
  reference met by a published document shows the bytes exist, not that the record used them correctly.
- **A signed manifest shows which key signed it.** The pins here match the signed `v0.1.0` manifest,
  and no published record yet says whose key that is.
- **A lifecycle folds the log it is given.** Between implementations with no venue, nothing yet says
  who mints an attempt number, so a fold cannot show that two operators did not collide.
- **Passing these vectors here is not interoperability.** One implementation exists, and some
  expectations still live in its tests rather than in the vector corpus. See
  [What is not yet proven](https://github.com/Jinn-Network/spec#what-is-not-yet-proven).

`createStaticBindingResolver` resolves key bindings a caller holds, for checking a set offline. It
sees no anchors, so a backdated `validFrom` is believed, and the earliest binding of an Agent is its
genesis, so a backdated binding becomes the genesis: pass only bindings you have reason to accept. It
sees no revocations, so leave a revoked binding out of the list. `agentId`, `oidc-machine` and
`github-human` bindings do not resolve, because trust-core leaves those ceremonies to the resolver and
a list of bytes cannot run them. They still count as earlier bindings of their Agent.

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
| `parseKeysFile(text)` | The verification keys in a keys file. Throws `KeysFileError` on a file it cannot use. |
| `loadPublishedDocuments()` | The published documents above, for the `published` option of `checkRecordSet`. |

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
