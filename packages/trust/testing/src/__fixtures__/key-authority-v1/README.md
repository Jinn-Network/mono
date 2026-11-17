# key-authority-v1

Vectors for the key authority text, `https://spec.jinn.network/profiles/key-authority/v1`.

Each case is a relationship among several sealed records: who vouched which key, what came first, who revoked what and when. A single static record cannot state that, so each vector here states a *world* as data, and a harness builds the sealed records from it by the construction below. The world says what the case means. Every vector is built from the text. None is captured from a run.

## A world

| Field | Meaning |
| --- | --- |
| `name` | The vector's name, and its file name. |
| `description` | What the case shows. |
| `profile` | `anchors-required` or `anchors-optional`. Absent means the case holds under both. |
| `bindings` | Records, in no meaningful order. |
| `entries` | Stored binding entries that do not conform to the key-binding schema. Each is an object whose only field is `anchors`: one anchor reference reported at `anchor`, or, for `"unreadable"`, a value that is not a list of anchor references. `digest: "low"` files it under `sha256:` and 64 zeros; otherwise the harness chooses its digest. |
| `revocations` | Each with `target` (a binding's `id`), `by` (a key, or `account:` and an account), `at` (its anchor time, `null` for none), `stated` (its `effectiveFrom`, defaulting to `at`) and `envelope`, as for a binding: `type` in place of the revocation media type, and `target`, the `id` of the binding its payload names in its place. |
| `checks` | Each with `key`, `at` (defaulting to `06-01`) and `expect`, the outcome of section 9 of the text for record family `verdicts`. A check with `join` gives the keys and times of section 10, for record family `verdicts`, and `expect` is `joined` or `refused`. |

A binding has `id`, `key`, `voucher` and `from` (its `validFrom`), and these optional fields.

| Field | Meaning | Default |
| --- | --- | --- |
| `anchor` | Its anchor time, `null` for none. Under `anchors-optional` a binding is unanchored. | `from` |
| `until` | Its `expiresAt`. | none |
| `scope` | Its `scope`. | `["verdicts","bindings"]` |
| `rel` | Its `relationship`. | `controls` |
| `consentBy` | The key that countersigns it. | none |
| `consentSig` | `undecodable` gives a countersignature that cannot be read. | valid |
| `ceremony` | `absent` withholds its ceremony evidence, so the ceremony fails. A ceremony type names one the verifier has no leg for. | a genuine `eoa` ceremony |
| `signed` | `false` means its key did not sign its envelope. | `true` |
| `below` | The ids whose digests its own digest must sort below. | none |
| `filed` | The id of another binding whose digest the store files it under, in place of its own. | its own digest |
| `envelope` | What its envelope carries where that differs from the fields the store holds: `type`, a payload type in place of the key-binding media type, and any of `until`, `scope` and `rel`, which its payload carries in their place. `until: null` gives a payload with no `expiresAt`. | what the store holds |

A time written `MM-DD` is midnight UTC on that day of 2026, as `2026-MM-DDT00:00:00.000Z`. Any other time is literal.

## Building the records

- One Agent IRI per vector. Accounts `A`, `B` and `C` are distinct externally owned accounts on one chain, and none is a contract account. Keys `K1` to `K7` are distinct `did:key` keys.
- Each binding is a key-binding record of that key to the Agent, vouched by the named account, with the fields above. Its ceremony is a genuine EOA ceremony by that account over a message naming the Agent and the key, unless `ceremony` says otherwise. Its envelope is signed by its key unless `signed` is `false`.
- Under `anchors-required` each binding with an anchor time cites one anchor reference, and the anchor surface reports that time for it. Under `anchors-optional` bindings cite none. Every revocation with an `at` cites one anchor reference reported at that time, under both profiles.
- A revocation is a revocation record naming the target binding's digest, signed by `by`.
- A binding with `filed` is built like any other, with its own fields, ceremony and envelope. Only the digest the store files it under changes, as a store that takes digests as given may do. A revocation that targets that other binding names this one too, since both are filed under one digest.
- A binding or revocation with `envelope` is sealed from its fields with those changes made, under `type` if one is given, and signed like any other. The store holds that envelope with the fields the world gives, as a store that takes entries as given may.
- Where `below` asks for one digest to sort below another, the harness varies a namespaced extension field of the record, or another field the case does not read, until it does.
- The verifier checks `eoa` ceremonies and has no leg for any other ceremony type. Its trust policy accepts every Agent, so step 9 never fails.
- A verdict MUST be the same in every stored order of the bindings and of the revocations.

## `account-signature/`

Each file is one case of section 8's account signature, stated directly: `input.voucher` is the voucher of the binding a revocation reaches, `input.envelope` is the revocation's DSSE envelope, and `expect` is `signed`, `not-signed` or `no-effect`. The signing key in these cases is the secp256k1 key with value 1, a test value with no other use. Its address is `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`.

## Groups

| Directory | What it covers |
| --- | --- |
| `chain/` | Chains that hold. |
| `no-authority/` | Authority that does not stand. |
| `founding-account/` | The founding account's recovery, and its limits. |
| `same-instant/` | Bindings that take effect at one instant. |
| `first-and-conflict/` | What came first, and conflicts over a key. |
| `revocation/` | Who may revoke, and when a revocation counts. |
| `reading/` | Times and entries that cannot be read. |
| `reach/` | What a revocation reaches. |
| `one-digest/` | Entries a store files under one digest. |
| `envelope/` | Entries whose fields do not match their envelope. |
| `settlement-join/` | The settlement join. |
| `account-signature/` | An account's signature on a revocation. |

These vectors do not yet cover `agentId` composition.

## Rotation

A rotation replaces a binding with a later one for the same Agent. Under section 7 of the text, the old binding must still be in window when the new one takes effect, because it is the new one's authority. The windows may touch: a binding is in window at its own `expiresAt`. `incumbent-expiring-at-the-mint` in `chain/` states this. This README supersedes `resolution-v1/README.md`, whose rotation sentence speaks of a `validTo` field that a key binding does not have.
