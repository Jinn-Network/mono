# Recoverable binding anchor: a directly third-party recomputable successor preimage

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-09-09 |
| **Author** | Autopilot implementation session for [#4172](https://github.com/Jinn-Network/mono/issues/4172) (seam citations read against `next` @ `1c9f6ec8f`) |
| **Shape** | `design` — the session dispatched as `fix` found the work is documentary. This note is the artifact; no code moves with it |
| **Status** | Proposed — drafted under a headless decision mandate and parked for the operator's ruling on the PR that carries it |
| **Answers** | issue [#4172](https://github.com/Jinn-Network/mono/issues/4172) |
| **Design scope** | The successor binding-anchor preimage, the trigger at which an existing deployment owes the re-anchor, and the re-author's reuse-vs-fresh ruling |
| **Depends on** | [DR-2026-09-06](../log/decisions/2026-09-06-native-anchor-target-and-digest.md) decisions 3 and 9, and its §Deliberately left open; [native identity ceremony spec](2026-08-07-native-identity-ceremony.md) §3.2, §3.2a, §3.2b, §6, §10 (e)–(f); [DR-2026-09-03](../log/decisions/2026-09-03-protocol-spec-repository.md) (the clean-repository rule); [the re-author runbook](../docs/runbooks/native-trust-reauthor.md) |
| **Does not do** | Author the anchor-locator profile document, which lives in `Jinn-Network/spec`. Change `ceremony-anchor/v1`, `revocation-anchor/v1`, `base-sepolia-calldata-v1`, any schema, any check, or any code. Fix the re-author procedure's defects |

## 0. The decision in plain language

The successor to `ceremony-anchor/v1` is a new preimage under a new name,
`https://spec.jinn.network/trust/binding-anchor/v1`, committing to
`{protocol, bindings: [{agent, keyId, scope[]}]}` — every term of which a third party reads
straight off a catalog, with no `role` label and no Safe. The re-anchor it implies becomes
owed at the earliest of three inspectable events, the primary one being the first release in
which the catalog opener refuses an anchor on preimage recomputation for any anchor class:
work Jinn has already authorized, not an event it waits on. The re-author mints a fresh
anchor, always; under the successor that stops being a judgment and becomes a mechanism,
because a scope widening changes the digest and the reuse path correctly falls through.

This document is a **source** for the anchor-locator profile document's normative text under
[DR-2026-09-03](../log/decisions/2026-09-03-protocol-spec-repository.md). It is not that text,
and it is not in that document's repository. Its job is to leave the profile document's author
with nothing left to decide — only prose to write.

Nothing here is settled. The status above is Proposed and every citation of this document
elsewhere in the repository says so.

## 1. What this document is and is not

### 1.1 Why the profile document cannot be written here

DR-2026-09-03 decision 0: this repository "consumes a pinned release of the spec and authors
none of its documents"
([`log/decisions/2026-09-03-protocol-spec-repository.md`](../log/decisions/2026-09-03-protocol-spec-repository.md),
decision 0). The anchor-locator profile document — `base-sepolia-calldata-v1`, which the
catalog schema already pins as a `z.literal`
(`operator/src/daemon/native-trust-catalog.ts:63`) — is a `spec.jinn.network` identifier and
is therefore protocol. It exists in no repository yet. The byte-identical import
(`Jinn-Network/spec` issue 1) has not landed: `architecture/platform-packages.v1.json` carries
no pin block and no `pinned` marker, which DR-2026-09-03 §Consequences makes the observable
signal that the import work is still ahead.

So issue #4172's first acceptance criterion — that the anchor-locator profile under
DR-2026-09-03 specifies a third-party-recomputable successor preimage and the re-anchor
trigger — **cannot be satisfied literally by any change to this repository**, and neither can
its second, which asks for the reuse-vs-fresh ruling to be recorded in that same document.
Both are stated again in §11 rather than buried.

### 1.2 What the clean-repository rule permits

The same record's clean-repository rule says: "The five families' design documents are sources
for the writing and stay here. Normative text is written fresh, never copied."

That sentence is the answer. A mono-side document that specifies the successor preimage byte
for byte, states the trigger, and rules the re-author question is a source for the profile
document's normative text, not that text. Writing it here is what the rule contemplates; the
violation would be writing it here and then copying it across.

Precedent for carrying requirements forward this way exists on this exact surface:
DR-2026-09-06 decision 9 ("Carried forward as requirements on the anchor-locator profile
document") carries the `contractAddress` → `to` rename and the successor-preimage question in
exactly this shape.

### 1.3 Why no decision record

`/log/decisions/` is a CODEOWNERS path (`.github/CODEOWNERS:35` assigns it to the three human
owners), so a decision record would gate the PR carrying this document on a human code owner.
A reviewer may reasonably ask for one anyway.

The call taken is that no such record is needed, because DR-2026-09-06 already ratified this
entire frame: decision 3 names the corrective and its cost, decision 9 carries it to the
profile document as a question, and §Deliberately left open assigns both questions to #4172 by
number. The delegation is explicit — DR-2026-09-06 did not reserve these questions for a
successor record, it named an issue as their owner. Answering them in the document that owner
produces is the shape the delegation asks for. A second record would restate DR-2026-09-06's
Context and half its Alternatives in order to say two new things, and this repository's rule is
that canonical content is linked, never redefined locally
([`CLAUDE.md`](../CLAUDE.md) §Canonical Docs).

## 2. What is actually recoverable from a catalog

Everything below turns on this inventory, so it is established first, from the schema rather
than from prose.

A catalog entry for a binding is `{digest, envelope, ceremony}`, and all three are required —
the sealed-binding shape is `.strict()` with no optional members
(`operator/src/daemon/native-trust-catalog.ts:54-58`). So **every** binding in a catalog
carries its EIP-191 ceremony evidence, not only settlement ones.

| Term | Recoverable? | From |
|---|---|---|
| `agent` | Yes | `KeyBinding.agent` (`packages/trust/core/src/key-binding.ts:57`) |
| `keyId` (`did:key:`) | Yes | `KeyBinding.key.didKey` (`key-binding.ts:62`) |
| `scope[]` | Yes | `KeyBinding.scope` (`key-binding.ts:66`), a required non-empty array |
| ceremony signer address | Yes | ceremony evidence `message.address` (`native-trust-catalog.ts:39`) |
| `settlementSafe` | **Only from a settlement-scoped binding** | third ceremony resource, written under the `isSettlementRole` guard alone (`operator/src/cli/commands/ceremony.ts:744`, `packages/trust/authoring/src/roles.ts:128-130`), read at `native-trust-catalog.ts:553-566` |
| `role` label | **No** | `KeyBindingSchema` has no `role` member (`key-binding.ts:55-74`); ceremony evidence carries `resources = [agent, didKey]` plus the optional Safe and nothing else (`packages/trust/authoring/src/ceremony.ts:73-76`) |

Two facts from that table drive the design.

**The Safe cannot be leaned on.** `--role-sets requester` mints only `requester-submission` and
`requester-discovery` (`operator/src/cli/commands/native-requester.ts:47`); neither is a
settlement role (`roles.ts:92`, `:94`, and `isSettlementRole` at `:128-130`), so no ceremony in
that provisioning carries a Safe resource, and the catalog stores it nowhere else. A preimage
containing `settlementSafe` is unconstructible for that shape. This is already the ceremony
spec §3.2b finding; it is re-verified here rather than inherited.

**The `role` label cannot be recovered, and the two repairs the issue offers are worse than the
defect.** Issue #4172's scope item 1 names two: carry `role` on `KeyBinding`, or make the
role→scope map invertible. Both are rejected in §9.

One further fact, because a candidate design depends on it: **the admission agent *is*
recoverable today**, because `admission` is the only role whose scope is the admission-receipt
scope (`roles.ts:93`), so the admission binding is identifiable and its `agent` is the
admission IRI (`operator/src/cli/commands/ceremony.ts:719-721`). That recovery is real, but it
is an inversion of the role→scope map at exactly one point, which makes it the same class of
fragility as the defect being corrected. §9 rejects relying on it.

## 3. The `binding-anchor/v1` preimage

### 3.1 The name

**`https://spec.jinn.network/trust/binding-anchor/v1`**, not `ceremony-anchor/v2`.

The successor commits to binding *content*, not to a ceremony session tuple. Calling it
`ceremony-anchor/v2` would name it for the act that produces it rather than the thing it
anchors — the same misnomer class as `contractAddress`, which DR-2026-09-06 decision 9 declines
to carry into the profile document on the grounds that the document is "the cheapest place to
spell it right the first time". The chosen name is also symmetric with the sibling ratified in
the same record: `revocation-anchor/v1` anchors revocations, `binding-anchor/v1` anchors
bindings.

The practical consequence is that `ceremony-anchor/v1`'s identifier is untouched (§11), and
domain separation between the two is automatic: the literal is the first byte range of the
preimage, so a `binding-anchor/v1` digest can never equal a `ceremony-anchor/v1` digest over
the same act.

### 3.2 The bytes

The preimage is a JSON object. Keys are emitted in the order below; there is no whitespace
anywhere; strings are delimited by `"` and contain no escape sequences, because every value is
restricted to printable ASCII excluding `"` and `\` (§3.3). The byte production is therefore a
pure concatenation and needs no JSON serializer to reproduce.

| # | Key | Value |
|---|---|---|
| 1 | `protocol` | the literal `https://spec.jinn.network/trust/binding-anchor/v1` |
| 2 | `bindings` | an array of objects, ordered per §3.2.2, each carrying the three keys below in this order |

Each element of `bindings`:

| # | Key | Value | Source on the record |
|---|---|---|---|
| 1 | `agent` | the binding's Agent IRI, verbatim | `KeyBinding.agent` (`packages/trust/core/src/key-binding.ts:57`) |
| 2 | `keyId` | the binding's `did:key:`, verbatim | `KeyBinding.key.didKey` (`key-binding.ts:62`) |
| 3 | `scope` | the binding's scope values, deduplicated, **sorted ascending** by UTF-16 code-unit order; at least one | `KeyBinding.scope` (`key-binding.ts:66`) |

**The literal template.** Written out, with `<…>` marking the values above and no whitespace
anywhere, the bytes are:

```text
{"protocol":"https://spec.jinn.network/trust/binding-anchor/v1","bindings":[{"agent":"<agent-1>","keyId":"<keyId-1>","scope":["<scope-1a>","<scope-1b>"]},{"agent":"<agent-2>","keyId":"<keyId-2>","scope":["<scope-2a>"]}]}
```

`{`, `}`, `[`, `]`, `"`, `:` and `,` are the only punctuation, each where RFC 8259 puts it and
nowhere else: no newline, no space after a colon or a comma, no trailing comma. A one-element
`bindings` array drops the `},{` between elements and changes nothing else. A scope array has at
least one member, so `[]` never appears.

**A worked two-element example.** Take an operator provisioned with `--role-sets requester`
(§2). Both of its bindings carry the same Agent IRI and distinct keys, and the records hold, in
the requirements-table order `authorRoleBinding` writes:

| Role — *not* a preimage term | `agent` | `keyId` | `scope` **on the record** |
|---|---|---|---|
| `requester-submission` | `urn:uuid:1f0c9d64-7a2e-4b31-8d55-0c9ae1b3f207` | `did:key:z6MktEnCUcVfWKsPWU4kGqNVRfsPvyAeoFmuLg1YjXQdN9pB` | `["authorizations"]` |
| `requester-discovery` | `urn:uuid:1f0c9d64-7a2e-4b31-8d55-0c9ae1b3f207` | `did:key:z6MkgYb7cRVaHqzsBWXAV8sAJ3XnPRGuC9dV1u7Wq2ePmTzL` | `["observations","jinn:discovery-announcements"]` |

The preimage is then, on one line:

```text
{"protocol":"https://spec.jinn.network/trust/binding-anchor/v1","bindings":[{"agent":"urn:uuid:1f0c9d64-7a2e-4b31-8d55-0c9ae1b3f207","keyId":"did:key:z6MkgYb7cRVaHqzsBWXAV8sAJ3XnPRGuC9dV1u7Wq2ePmTzL","scope":["jinn:discovery-announcements","observations"]},{"agent":"urn:uuid:1f0c9d64-7a2e-4b31-8d55-0c9ae1b3f207","keyId":"did:key:z6MktEnCUcVfWKsPWU4kGqNVRfsPvyAeoFmuLg1YjXQdN9pB","scope":["authorizations"]}]}
```

Two things are visible in those bytes that the prose alone does not make obvious. The discovery
element's `scope` array is **reordered** relative to the record — `jinn:discovery-announcements`
before `observations`, per §3.2.1 — and the elements are ordered by `keyId`, which puts discovery
first here (`…z6Mkg…` before `…z6Mkt…`), not by role and not by the order the ceremony authored
them. No digest is given for the example: hashing is `recordDigest`'s job (§3.2.3), and a hex
literal here would be a value to copy rather than a rule to follow.

**3.2.1 The scope sort is deliberate and differs from the record.** The scope array carries no
ordering constraint (`key-binding.ts:66`), and `authorRoleBinding` copies the requirements
table's order (`scopeForRole`, `packages/trust/authoring/src/binding.ts:108`, over
`packages/trust/authoring/src/roles.ts:91-101`). A semantically irrelevant permutation of a
record's `scope` array must not change the digest, so the preimage sorts and the record does
not. An implementer must not assume the two orders agree: for `requester-discovery` they do
not, because the requirements table writes `["observations", …]` (`roles.ts:94`) while
`jinn:discovery-announcements` (`roles.ts:37`) sorts first.

**3.2.2 Element order.** Ascending by `keyId`, ties broken by `agent`, both under UTF-16
code-unit order — the same comparison the current `ceremonyAnchorDigest` already uses for its
`role` sort (`operator/src/cli/commands/ceremony.ts:425`). The `(keyId, agent)` pair MUST be
unique within the array; a duplicate is a refusal, not a dedupe. The tie-break on `agent` and
the uniqueness rule are belt and braces: each role gets its own freshly generated Ed25519
keypair (`packages/trust/authoring/src/identity-store.ts:121-122`), and stores refuse a
duplicate role (`identity-store.ts:154`), so a collision is not reachable through the CLI — but
the preimage must be total over hand-authored catalogs too.

**3.2.3 Encoding and spelling.** The concatenated bytes are UTF-8 (which, being ASCII, is the
literal octets), hashed with sha256, and spelled `sha256:<64 lowercase hex>` — the same
`recordDigest` the whole tree uses (`packages/trust/core/src/hashing.ts:10-12`), and the same
lowercase-hex form `digestHex` already enforces before an anchor is submitted
(`packages/trust/authoring/src/anchor.ts:77-83`).

ECMA-262 `JSON.stringify` with no replacer and no `space`, over an object literal with those
keys inserted in that order, produces exactly these bytes. That is a fact about a convenient
implementation, not the definition. The definition is the concatenation above. This is a
deliberate departure from `ceremony-anchor/v1`, whose pinning in the ceremony spec §3.2b *is*
"ECMA-262 `JSON.stringify`" plus a set of side rules — key insertion order, omit-when-absent
rather than `null`, ASCII-lowercasing, ASCII-only — that a non-JavaScript implementer needs
supplied separately. The successor is written for the outside implementer from the start, which
is the point of putting it in the protocol document.

### 3.3 The ASCII restriction becomes verifier-enforced

`ceremony-anchor/v1` carries an ASCII rule as **authoring convention** (ceremony spec §3.2b;
DR-2026-09-06 §Consequences lists the authoring-time guard as work it authorizes, and notes
nothing checks it yet).

Under `binding-anchor/v1` that rule can no longer be authoring convention, because the
*verifier* must reproduce the author's bytes. And the schema genuinely admits values that would
break it: `AgentIriSchema` refines on `isAbsoluteIri`
(`packages/trust/core/src/spellings.ts:158-160`), and IRIs permit non-ASCII by definition;
`ScopeSchema` admits any absolute URI or reverse-DNS name (`spellings.ts:230-235`). Only
`DidKeySchema` is structurally ASCII (`spellings.ts:87-92`, base58btc).

The two **delimiter** characters are admitted today as well, which is why the rule excludes them
explicitly rather than leaning on the ASCII bound alone: `ScopeSchema`'s extension limbs screen
values with `EXTENSION_FORBIDDEN_CHARACTER_PATTERN` (`spellings.ts:194`), which forbids only
U+0000–U+0020 and U+007F, so `"` and `\` pass. Excluding them is what makes §3.2's concatenation
escape-free, and therefore what makes the byte production reproducible without a JSON serializer.

**Rule.** Every `agent` and `scope` value in a `binding-anchor/v1` preimage MUST consist solely
of characters in U+0020–U+007E, excluding `"` (U+0022) and `\` (U+005C). A record violating
this is out of profile: refused at authoring, and — under the **successor-required** posture of
§8 — refused at catalog-open by any verifier performing recomputation. Under mixed mode the same
verifier classifies and reports it instead, exactly as §4 step 5 does for a digest mismatch: the
rule takes the posture as a parameter rather than stating a second, flatter rule. Refusing is
chosen over specifying the escaping because the
alternative is publishing a lone-surrogate rule that will be implemented three times and agreed
on twice.

## 4. Recomputation, and what it ranges over

**Range rule.** An anchor commits to **exactly** the set of binding records that declare it.
The anchor and its act's bindings are mutually determining.

The rule is well-defined on a conforming catalog because anchor digests are already unique
within one: the opener runs `uniqueBy(catalog.anchors, ({ digest }) => digest, 'anchor digest')`
(`operator/src/daemon/native-trust-catalog.ts:309`), so "the declaration for digest `d`" names
at most one entry and the referencing set is a function of the digest alone.

**The procedure below is the successor-required procedure** (§8). It is written for the posture
in which every anchor must recompute; under mixed mode step 5 substitutes classify-and-report for
the refusal and nothing else changes. That is one rule with a posture parameter, not two rules,
and the profile document must publish it as one (§11 item 5).

The verifier's procedure, sited in `openNativeTrustCatalog` alongside the referential-integrity
loop it already runs (`native-trust-catalog.ts:325-343`) and before the anchor-observation loop
(`:344-364`):

1. For each declaration `a` in `anchors[]`, let `R(a)` be every entry of `bindings[]` whose
   `binding.anchors[]` contains `a.digest`, and `V(a)` every entry of `revocations[]` likewise.
   The opener already walks both arrays and already refuses an undeclared reference (`:329-331`,
   `:338-340`).
2. If `R(a)` and `V(a)` are both non-empty, refuse: one anchor cannot be both a binding anchor
   and a revocation anchor. Domain separation makes this unreachable for honestly authored
   catalogs and detectable in one line for the rest.
3. If `V(a)` is non-empty, the anchor is a revocation anchor; check it against
   `revocation-anchor/v1` per DR-2026-09-06 decision 4. Out of this document's scope.
4. If `R(a)` is non-empty, build the `binding-anchor/v1` preimage from `R(a)`, hash it, and
   compare with `a.digest`.
5. Under successor-required, a mismatch **refuses the catalog**, naming both the anchor digest
   and the digests of the records in `R(a)`. Not a warning, not a degraded mode; the existing
   anchor-observation failure at `:361` is the register to match. Naming the records is not
   cosmetic: F5 is a poisoning attack whose entire cost is borne in diagnosis, and a message
   carrying only the anchor digest leaves an operator bisecting the catalog to find the record
   that was added. Under mixed mode the same comparison runs and a mismatch is classified and
   reported rather than refused (§8), carrying the same identifiers.

An anchor declared in `anchors[]` but referenced by no record is already excluded from
consideration, because the required set is built from references rather than declarations
(`:325-343`).

**What agent recovery looks like in practice.** For a full nine-role act with admission
provisioned, `R(a)` spans two Agent IRIs: the operator's for eight bindings and the admission
agent's for one (`operator/src/cli/commands/ceremony.ts:719-721`). The preimage does not care
which is which — both are `agent` values on their own elements. That is why §9 rejects a
separate admission-agent term.

## 5. The re-anchor trigger

### 5.1 What the trigger is about

The ceremony spec §10 (f) is explicit that this is not only a legibility question: recomputation
is what *converts* the borrowed-anchor residual, and the §7.4a genesis exemption is reachable
only through an anchor time earlier than the victim's — which recomputation makes expensive
rather than free. §10 (f) writes that reachability condition as "a borrowed anchor time"; the
wider phrasing here is deliberate and is this document's, not §10 (f)'s, for the reason the
second paragraph below gives. That chain is verified rather than accepted: the consent chain
exits at `if (resolved.isGenesis) return { ok: true }`
(`packages/trust/core/src/verify.ts:201`), genesis is decided by earliest effective start among
the agent's bindings (`isGenesisAmong`,
`packages/trust/resolve/src/binding-resolver.ts:217-223`, applied at `:298`), and the effective
start is `max(validFrom, earliest anchor time)` (`:127-135`). An earlier anchor time therefore
buys genesis, and genesis is the exemption.

**Converts, not eliminates — the first of §10 (f)'s two bounds, carried here rather than
dropped.** The ceremony spec §10 (f) states the bound in these words: recomputation "**converts**
the residual rather than eliminating it — the preimage carries no timestamp, so an adversary who
genuinely submitted an anchor over a tuple at time T can still present that early time later, at
the cost of real gas and foresight of both the victim IRI and their own keys". That is as true of
`binding-anchor/v1` as of the enumerating check: §3.2's preimage commits to
`{protocol, bindings}` and to no time at all. Concretely, and against the same seams as above: an
adversary who knows a victim's Agent IRI in advance mints their own keypair, computes the
successor digest over `{victim agent, attacker keyId, scopes}`, and submits a **genuine** anchor
transaction, which recomputes correctly under successor-required. Presented later, its earlier
effective start makes it genesis, exits the consent chain at `verify.ts:201`, and leaves the
victim's own binding non-genesis with neither an incumbent voucher nor a consent
countersignature, so the victim's binding fails outright (`verify.ts:245-249`). No borrowing
occurs anywhere in that chain. What recomputation removes is the *free* version — reaching for an
anchor somebody else already mined. What it leaves, priced at gas plus foresight, is the
version above, and a profile document must publish the bound rather than the stronger claim.

**The second bound is the procedural one**, and §10 (f) states it too: recomputation does
nothing for a catalog whose records an attacker cannot get in front of a verifier. That is what
the ceremony spec §3.2b names as the residual's real bound — catalog write authority. Whoever
holds the catalog file serializes joins. It is a real bound and it is not cryptographic, and it
holds only while the deployment's shape keeps it holding. So the trigger should fire when the
deployment's shape stops keeping it.

**The standing exposure, stated as such.** Until a trigger fires, every deployment stays on
`ceremony-anchor/v1` and carries the borrowed-anchor residual with one procedural bound. That
is an exposure carried deliberately, in exchange for not costing every deployment a re-anchor
before anything checks the commitment. It is not a neutral hold.

### 5.2 The trigger

**The re-anchor is owed at the earliest of the following three events.** Each is decidable by
inspection; none requires a judgment about whether someone "would" check something.

**T1 — the recomputation check ships.** The first release in which `openNativeTrustCatalog`
refuses an anchor whose digest does not equal the recomputed preimage, *for any anchor class*.
Inspected by anyone, in the tree: the code exists in
`operator/src/daemon/native-trust-catalog.ts` and a test pins the refusal.

T1 is the primary limb, and it is what makes this trigger a commitment rather than a wait. The
revocation-side check is already authorized work — DR-2026-09-06 §Consequences lists a
revocation act-binding check in `openNativeTrustCatalog` that recomputes `revocation-anchor/v1`
from the referencing revocations and refuses a mismatch. The moment that lands, the catalog
opener *contains* a preimage recomputation engine, and the binding half becomes the one anchor
class it structurally cannot check. At that point the marginal cost of the successor is the
re-anchor plus one preimage builder — the siting and the refusal are written, and the binding
preimage is the only new code, because what the revocation check recomputes is a *different*
preimage, `revocation-anchor/v1` over `{protocol, targets[], revokedBy}` per DR-2026-09-06
decision 4 — and the asymmetry is a documented blind spot
inside a single function, which is precisely what the ceremony spec §3.2b enforcement table
exists to stop tolerating. The trigger is therefore under Jinn's own control, not the world's.

**T2 — the catalog gains a writer the deployment does not run.** The first act that admits into
an operator-held catalog a binding authored by a party outside the deployment's operator set.
Inspected by the catalog holder, against their own ceremony receipts and key material; the
determination MUST be recorded alongside the deployment's anchor record. A third party cannot
decide T2 from the catalog alone — the voucher `did` set is inspectable but who controls each
account is not — and that asymmetry is stated rather than papered over: T2 is decidable by the
party who has to act on it, which is the party that matters.

**T3 — the catalog stops being hand-delivered.** The first deployment that obtains a catalog
over a channel it does not control end to end — the ceremony spec §10 (b)'s archive-served
catalog, or any successor to file-copy distribution. Inspected in the tree: the catalog-loading
path takes a locator rather than a filesystem path. Today it does not.

### 5.3 The hard precondition: the migration cannot execute today

Stated before the migration itself, because it is a blocker and not a caveat. The migration
runs the re-author procedure, and that procedure does not execute today. Its own runbook says
so at the top: `jinn ceremony init` refuses while the catalog exists
(`operator/src/cli/commands/ceremony.ts:949-965`) and there is no `--force`; moving the catalog
aside makes `authorCatalog` seal a version-1 genesis
(`packages/trust/authoring/src/catalog.ts:200-213`), moving `policyGenesisDigest` and failing
every other operator's pin (`operator/src/daemon/native-trust-catalog.ts:305-307`); the
re-author writes only its own operator's bindings, so a shared catalog returns single-operator;
`authorCatalog` writes an empty revocation list (`catalog.ts:216`), un-revoking everything; and
a joined operator has no path at all.

**The successor's trigger cannot fire into a working procedure until that is fixed.** This
document does not fix it and does not own it; it names it as the dependency that gates T1's
consequence, and the profile document must carry the same statement so the trigger is not
published as though it were executable.

### 5.4 What an existing deployment does when the trigger fires

Once the procedure works:

1. Recompute the `binding-anchor/v1` digest over the act's bindings.
2. Submit a **fresh** anchor transaction. `reusableAnchor` will not match, because the receipt
   carries the `ceremony-anchor/v1` digest and the new one is domain-separated from it — so this
   happens by mechanism, not by moving the receipt aside.
3. Wait for finality (ceremony spec §6 law 4; roughly 10–20 minutes on Base Sepolia).
4. Re-sign every binding with the new anchor's block time as `validFrom` and `issuedAt`,
   verbatim (§6 law 2, enforced at `packages/trust/authoring/src/binding.ts:86-91`).
5. Rewrite the catalog, redistribute, restart every daemon (§6 law 5).
6. On a shared catalog, every operator repeats steps 1–5 before the deployment may declare
   itself successor-required, because the posture is deployment-wide (§8).

The cost is one anchor transaction and one finality wait per operator, plus the coverage gap §6
quantifies. The gap is the substantive cost, not the gas.

### 5.5 Rejected: a scheduled re-anchor window

Rejected. A date is maximally decidable and buys nothing: it forces the cost on a deployment
whose exposure has not changed, and it invites the failure where the window arrives, nobody has
shipped the check, and the re-anchor is performed to satisfy a calendar. The usual argument for
a backstop — that an event-based trigger can wait forever on someone else — does not apply
here, because T1 is Jinn's own already-owed work.

### 5.6 Rejected: "the first verifier that checks the commitment cross-operator"

Issue #4172 offers this phrasing, and it is rejected as undecidable in the direction that
matters. It is unobservable to the deployment being asked to re-anchor: a deployment cannot
inspect who is verifying its catalog. It is also close to circular — no third party will
implement a check against a preimage that cannot be directly recomputed, so "a verifier checks"
cannot precede the successor it is meant to trigger. T1 is the same intent made observable: we
ship the check, and shipping it is the event.

## 6. The reuse-vs-fresh ruling

### 6.1 The ruling

**Mint fresh. Always. The choice is removed rather than ruled per case.**

Under `binding-anchor/v1` this is not a rule anyone has to follow: a widening changes the
`scope` term, which changes the digest, so `reusableAnchor` returns `undefined` and `init`
reaches `reusedAnchor ?? await session.submit(anchorDigest)`
(`operator/src/cli/commands/ceremony.ts:985`) and sends a fresh transaction. The function
already treats a digest mismatch as the correct fall-through (`:327-328`). The ruling converts
an authoring convention into a mechanism, which is the strongest form available on a surface
whose enforcement table has too many rows reading "authoring convention".

Until the successor lands, the same ruling holds as convention on `ceremony-anchor/v1`, where
it costs a deliberate act — the operator must move the run receipt aside alongside the catalog,
because otherwise `reusableAnchor` matches the identical recomputed digest and the run resumes
onto the already-mined anchor. The re-author runbook carries the mechanics.

### 6.2 What a fresh anchor actually does, verified

The natural phrasing — "a coverage gap between the old anchor time and the new one" —
understates it, and both the re-author runbook and ceremony spec §10 (e) carried it until the
change this document lands with. Two facts make the gap **wholesale**, not confined to the
widened scope.

First, the re-author is wholesale: `authorCatalog` rewrites the catalog rather than appending,
which is the runbook's own "Why wholesale, not `appendOperator`" section. Second, ceremony spec
§6 law 2 requires `validFrom` to be the anchor's block time verbatim, and `authorRoleBinding`
refuses any drift (`packages/trust/authoring/src/binding.ts:86-91`). So **every** binding in the
act carries the new, later `validFrom` — including the roles whose scope did not change at all.

The consequence, read off the resolver: for any evaluation time in
`[old anchor time, new anchor time)`, the in-window test returns false for every re-authored
binding (`packages/trust/resolve/src/binding-resolver.ts:150-153`, `if (atTime < effectiveStart)
return false`), the candidate set is empty, and binding resolution returns `null` (`:250-255`).
The old bindings are gone from the rewritten catalog. So evidence signed inside that window
de-attributes **for every role**, not for the widened scope.

Two things the gap does *not* break, checked rather than assumed. Genesis survives:
`isGenesisAmong` operates over the catalog's current binding list for the agent
(`binding-resolver.ts:217-223`, over `listBindingsForAgent` at
`operator/src/daemon/native-trust-catalog.ts:367`), so after a wholesale rewrite the earliest
re-authored binding is genesis again and the consent chain exits at
`packages/trust/core/src/verify.ts:201` as before. And live operation is unaffected: the new
bindings are effective from the new anchor time, and the deployment restarts anyway (§6 law 5).

### 6.3 Why fresh, given that cost

**1. Reuse is retroactive expansion of authority, and the layer's own law runs the other way.**
The trust-layer design's §7.4b forbids retroactive *revocation*; the ceremony spec §2.3d
refuses rules whose answer can flip for an already-mined anchor; §6 law 2 forbids `validFrom`
from being a chosen value rather than the anchor's block time. The symmetric principle —
authority is never retroactively expanded — is written nowhere, which is why this ruling should
write it. Reuse moves an authority record under a verifier's feet: the same evidence a verifier
refused yesterday verifies today, with nothing on the record marking the change.

**The asymmetry in that argument, named rather than glossed.** This ruling forbids retroactive
*expansion* of authority and mandates retroactive *contraction* of it: §6.2's window is authority
removed after the fact, achieved by rewriting rather than by revoking. The §7.4b rule cited above
is about the second direction, not the first — as the implementation plan records it, a
revocation is "**never retroactive** (effect starts at its own anchor time)", so evidence that
attributed at time T keeps attributing
([`docs/superpowers/plans/2026-07-28-trust-layer.md:338`](../docs/superpowers/plans/2026-07-28-trust-layer.md),
and test case (d) at `:402`). So the ruling reaches for a principle it enforces in one direction
while its own mechanism runs the other way in the other, and before this ruling reuse was
available and produced no gap at all. Argument 3 below assigns the gap's *cause* to the
wholesale-rewrite procedure, correctly; that does not make the gap smaller, and it is the
fresh-anchor choice that makes the procedural defect fire on every re-author, by rule.

**The call taken, so a reviewer can overturn it knowingly.** Adoption of this ruling is **not**
made conditional on §13.2's `expiresAt` / supersede shape, which would remove the gap outright.
Three reasons. That shape is unbuilt implementation work — `authorRoleBinding` accepting
`expiresAt`, an append-with-supersede path, `authorCatalog` no longer rewriting — and none of it
is owned, so gating a documentary ruling on it would leave the ceremony spec §10 (e)'s question
unanswered for as long as that work stays unowned, which is where it is today. The ruling's
mechanical enforcement under the successor (§6.1) does not depend on the supersede shape either:
the digest changes and `reusableAnchor` falls through regardless of how the outgoing bindings are
retired. And the alternative on offer is not "no gap" but "reuse", which is the retroactive
expansion argument 3 shows costs most where its benefit is a fiction. The tension is therefore
**recorded** — here and in §11 item 9 — rather than used as a gate. A reviewer who judges the gap
too high a price before the supersede shape exists should overturn this paragraph; the preimage
question (§3) is independent of it.

**2. "It was corrective" is a judgment no artifact carries.** Both observed widenings were
corrective, and this is verified in the tree rather than assumed: for the discovery scope, "the
keys simply now DECLARE the announcement authority they were already being used to exercise"
(`packages/trust/authoring/src/roles.ts:67-68`); for admission, "the key now DECLARES the
receipt-issuing authority it was already being used to exercise" (`roles.ts:85-86`). Both true.
But a verifier sees only the widened binding at the old block time; nothing distinguishes a
corrective widening from an opportunistic one, and under `ceremony-anchor/v1` the anchor cannot
distinguish them either, because scope is not in the preimage. A rule that is safe only while
the operator's characterization is honest, with no artifact expressing that characterization,
is the weakest class of authoring convention.

**3. The gap costs most exactly where reuse's benefit is a fiction.** This is the argument that
decides it. Take a corrective widening: role R's binding lacked scope S, so evidence under S was
refused at the time. After a fresh anchor, that evidence is still refused — nothing is lost that
was not already lost. After a reuse, it verifies, which is precisely the retroactive claim. So
on the widened scope, fresh costs nothing and reuse is the whole harm.

The honest residual is the *other* scopes. Because the re-author is wholesale, evidence that
verified fine under `solver-delivery` — a role whose scope never changed (`roles.ts:95`) — also
de-attributes across the window. That cost is real and it is the one genuine price of this
ruling. Its *cause* is the **wholesale-rewrite procedure** rather than the fresh-anchor choice —
but the fresh-anchor choice is what makes that procedural defect fire, on every re-author, by
rule, so "not my defect" is an account of the cause and not a discharge of the cost. The
procedure defect is already on the runbook's own defect list and is unowned there; §13.2 names
the shape that would remove it, and §6.3's opening records why adoption is not gated on it.

**4. The preimage choice makes the ruling free to enforce.** Under `binding-anchor/v1` the
ruling is mechanical (§6.1). Ruling reuse instead would require the successor to *avoid*
committing to scope in order to keep reuse available, which is the rejected family A of §9 — so
the preimage question and this one are one answer, taken twice.

### 6.4 What the operator must record

The ceremony spec §3.2b's current MUST ("record the reason") would be replaced if this ruling
is adopted, because the reason becomes fixed by rule. In its place, the re-author's record MUST
carry:

- the fresh anchor's transaction hash and block time;
- the outgoing anchor's transaction hash and block time;
- the scope change, and the code change that caused it;
- the resulting window `[old anchor time, new anchor time)`, stated explicitly as a window in
  which evidence de-attributes **for every role**, not only the widened one.

The last item is the one that matters, and the one the runbook did not ask for before this
change.

### 6.5 One implementation requirement the ruling carries

Making the receipt move compulsory promotes the runbook's most dangerous footgun onto the
on-path procedure. Identity resolution prefers the native config, falls back to the receipt, and
otherwise mints a fresh `urn:uuid:` (`operator/src/cli/commands/ceremony.ts:376-389`) — so a
re-author with the config keys absent and the receipt moved aside silently becomes a re-mint:
new operator identity, every peer's configuration invalidated. The dangerous state is the one
`refuseConfigWriteBackPending` flags (`ceremony.ts:953-957`), where the receipt is the only
record of the Agent IRI.

**Therefore:** the re-author path MUST refuse when neither the native config nor an accessible
receipt carries `agentIri` (and the admission agent, where admission is provisioned), instead of
minting. Making the dangerous step mandatory without making the silent-remint failure loud
would be a net worsening. This is named in §12 as a blocker on the ruling's *execution*, not on
its adoption.

## 7. New failure modes the check introduces

Stated because a check that only ever refuses bad catalogs would be a check nobody had to think
about, and this is not one. Each is a constraint the successor introduces, not a clarification
of an existing one.

- **F1 — a catalog carrying a proper subset of an act's bindings is refused.** Nothing in the
  tree produces one today: `authorCatalog` and `appendOperator` write an operator's bindings
  whole, and `authorRoleBinding` writes a single-element `anchors` array per binding
  (`packages/trust/authoring/src/binding.ts:112`). But the range rule forecloses any future
  partial-publication pattern — an operator publishing only their discovery binding to a peer,
  for instance. The escape is to author a smaller *act*, with its own anchor over its own
  binding set, not to weaken the check.
- **F2 — one anchor may no longer back two acts.** Ceremony spec §6 law 1 currently permits
  "one shared anchor digest [to] back multiple bindings", and the resolver handles anchors
  per-reference (`packages/trust/resolve/src/binding-resolver.ts:127-135`). Under the range rule
  that stays true within one act and becomes false across acts: two acts sharing a digest present
  a union that recomputes to neither. This narrows a permission nothing exercises — every
  Jinn-authored session writes one digest across its own bindings — and it strengthens law 1's
  existing rebind-always-fresh rule rather than replacing it. Law 1 still needs that rule,
  because two acts binding an *identical* set would still recompute the shared digest.
- **F3 — the ASCII restriction becomes load-bearing at verification** (§3.3). A record the
  schema accepts today can be unrecomputable tomorrow. This is a genuine narrowing of what a
  conforming catalog may contain, and it is the successor's doing.
- **F4 — a scope widening now breaks two things instead of one.** Today a widening breaks
  `RoleIdentitySet.open` at boot. Under the successor it also breaks anchor recomputation at
  catalog-open. The recovery is the same re-author either way, and the second refusal is what
  makes §6's ruling structural — but a deployment sees two refusals rather than one, and the
  second one's error message must say so plainly or an operator will chase it as a separate
  defect.
- **F5 — one hostile record can deny the whole catalog.** The schema lets any binding reference
  any *declared* anchor digest, and the opener checks only that the referenced digest is declared
  (`operator/src/daemon/native-trust-catalog.ts:329-331`). So under successor-required, any party
  holding catalog append or write authority — a joining operator on a shared catalog, through the
  `appendOperator` path — can add a single record whose `anchors[]` names an incumbent's anchor
  digest. That record joins `R(a)`, the recomputation over `R(a)` no longer equals `a.digest`, and
  step 5 refuses the **entire catalog** for every daemon that loads it; `openNativeTrustCatalog`
  failing is a boot refusal, so the blast radius is the deployment rather than the record. This is
  the same primitive that today buys a borrowed anchor time, so the successor converts an
  integrity attack into an availability one. That trade is the right direction — fail-closed — and
  the actor needs exactly the catalog write authority §3.2b already names as the residual's real
  bound. It is listed because it is a capability the successor creates and F1 does not cover: F1
  is an honest author publishing a subset, this is a hostile writer poisoning `R(a)`. It is also
  why §4 step 5 names the records in `R(a)` and not the anchor digest alone — without that, the
  operator bisects the catalog to find the record that was added.

## 8. Coexistence and the deployment-wide posture

**Structurally, `ceremony-anchor/v1` and `binding-anchor/v1` anchors coexist in one catalog, and
necessarily.** `anchors[]` is a flat array of `{digest, locator}`
(`operator/src/daemon/native-trust-catalog.ts:60-70`); nothing types an entry by preimage class,
and a partially migrated shared catalog will carry both. A verifier classifies **per anchor, by
trial recomputation**: recompute `binding-anchor/v1` over the referencing bindings; a match
means the anchor is a successor anchor and is checked.

**A non-match is not evidence of a `ceremony-anchor/v1` anchor.** It is evidence of "legacy, or
forged, and this verifier cannot tell which". That is the whole substance of the coexistence
question, and the profile document must state it in those terms.

**Consequence: the posture is one deployment-wide flag, not a per-anchor judgment.**

- **Mixed mode** — accept non-recomputing anchors and report them — buys **no security**. An
  adversary presents an anchor that does not recompute, is classified as legacy, and gets the
  old blindness. Mixed mode is a migration convenience and nothing else.
- **Successor-required** — every anchor in the catalog must recompute — is where the security
  benefit arrives, and it is all-or-nothing by construction: a deployment that lets one anchor
  off the check has defeated the check for every anchor an attacker controls.

"Every anchor" means both classes, so **arming the flag has two preconditions, not one**: the
re-author procedure must execute (§5.3), *and* the recomputation check must exist for **both**
anchor classes — `binding-anchor/v1` per §4 step 4, and `revocation-anchor/v1` per §4 step 3 and
DR-2026-09-06 decision 4. T1 fires on either class landing, and that is deliberate (§5.2: the
first class landing is what makes the second one cheap), but the trigger and the posture are
different objects and this is where they come apart. A deployment that armed successor-required
with only the binding class checked would assert coverage it does not have over the class the
ceremony spec §3.2b calls the sharper one — "The residual runs in the revocation direction too,
and there it is sharper", where a back-dated revocation anchor takes effect before the evidence
it revokes and lets an operator de-attribute their own past evidence. A posture flag whose name
asserts full coverage while either class goes unchecked is a downgrade surface dressed as a
guarantee.

So partial migration is a transient a deployment passes through with the flag off, and the flag
flips once, after the last operator has re-anchored. Publishing this as a per-anchor decision
would publish a downgrade attack as a feature.

## 9. Rejected alternatives

**Family A — widening-stable, `{protocol, agent, admissionAgent?, keys: [keyId…]}`.** The shape
DR-2026-09-06 decision 3's defect analysis implies, and the one the ceremony spec §10 (f)
describes ("drop `role`, and commit to terms every catalog carries"). Its virtue is that a scope
widening recomputes the
same digest, so the reuse property the ceremony spec §3.2b calls "load-bearing operationally"
survives intact for the re-author too. Rejected on three grounds.

1. **It keeps a role→scope-map inversion.** Recovering the admission agent as a distinct term
   requires identifying the admission binding, which works only because `admission` is the sole
   role mapping to the admission-receipt scope
   (`packages/trust/authoring/src/roles.ts:93`, `:48`). That is one accidental uniqueness in a
   map whose non-invertibility *is* the defect being corrected. If a second role ever declares
   that scope, or `admission` ever gains one, the preimage becomes ambiguous — silently, because
   nothing pins the property. The ceremony spec §3.2a is a monument to exactly this failure mode.
2. **It commits to existence, not authority.** "This key, for this agent, at this block time" is
   materially weaker evidence than "this key, for this agent, with this authority, at this block
   time". The anchor's whole job is to make the transaction say something true and checkable
   (`operator/src/cli/commands/ceremony.ts:400-411`); a commitment silent about what the key may
   do says less than it could, for no saving.
3. **It leaves the reuse question a live policy question forever.** Under A, reuse-on-widening
   stays available and stays a judgment call an authoring convention must police. Under the
   adopted shape it stops being available (§6).

A repaired variant, **A′** — `{protocol, bindings: [{agent, keyId}]}`, dropping the
operator/admission distinction — dissolves ground 1 and is a real candidate. It is rejected on
grounds 2 and 3 alone, which is a narrower case and worth saying: A′ and the adopted preimage
differ by exactly one field, and the argument for that field is §6's.

**What the adopted shape does not cost, contrary to a natural reading: the crash-resume path is
unaffected.** `reusableAnchor` (`operator/src/cli/commands/ceremony.ts:333-349`) needs the digest
to be recomputable before the anchor mines and stable across a re-run of the same session. Scopes
come from the requirements table (`packages/trust/authoring/src/roles.ts:91-101`), a compile-time
constant, and agents from `agentForRole` (`ceremony.ts:719-721`); both are available at the
existing call sites (`ceremony.ts:970-975` for `init`, `:1210-1215` for `join`) and neither
depends on the anchor. A re-run of the same role set with the same stores recomputes the same
digest and resumes onto the already-mined anchor, exactly as today. The function's own doc
comment already names a widening as a case that "correctly falls through to a fresh submit"
(`:327-328`); the successor simply adds a scope widening to that list.

**Carry `role` on `KeyBinding`** (issue #4172 scope item 1, first option). Rejected. `KeyBinding`
is a trust-core record shared by every deployment of the trust layer, not a native-fleet record;
`NativeRoleIdentityRole` is a Jinn deployment vocabulary
(`packages/trust/authoring/src/roles.ts:12-22`). Putting it on the record puts a deployment
concept into a protocol format to make one deployment's commitment openable, and every non-native
consumer inherits a field it must ignore. It also does not help: a verifier would then have to
trust the self-asserted `role` label to recompute, which makes the label author-chosen and the
commitment circular.

**Make the role→scope map invertible** (issue #4172 scope item 1, second option). Rejected, and
more sharply. Inverting it means minting distinct scopes per role — three discovery scopes where
one announce-plane scope is checked, two settlement scopes where one is — so that a verifier
could read `role` back. That changes **what verifiers check** in order to make a commitment
openable, and every one of those new scopes would have to be added to the checking side too
(`RoleIdentitySet.open` runs one authority gate per required scope, ceremony spec §3.2a) or be
dead weight. It is a larger, riskier change than replacing the preimage, aimed at preserving a
term the preimage should not contain.

**RFC 8785 (JCS) as the canonicalization.** It is a published standard and would remove the
insertion-order rule in favor of a key sort. Rejected because the preimage contains no numbers,
which is JCS's substantial content; because adopting it for one of three sibling preimages while
`ceremony-anchor/v1` and `revocation-anchor/v1` stay on the pinned `JSON.stringify` discipline
creates exactly one canonicalization divergence inside one `anchors[]` array; and because the
fully specified concatenation of §3.2 already removes the JavaScript dependency that was JCS's
only real draw here.

**A scheduled re-anchor window** — §5.5. **"The first verifier that checks the commitment
cross-operator"** — §5.6.

## 10. What this does not change

Issue #4172's third acceptance criterion is "No change to `ceremony-anchor/v1` itself; existing
anchors stay valid." That criterion is met, and the argument is given in full because it is the
one criterion this document can meet outright.

- **`ceremony-anchor/v1` is untouched.** Its identifier, its five terms, its canonicalization,
  and its ceremony spec §3.2b enforcement-table row are unchanged. The successor takes a **new**
  identifier (§3.1), so the two are domain-separated and no existing digest changes value or
  meaning.
- **No existing artifact is invalidated, because nothing here adds a check that runs by
  default.** The deliverable is documents. The recomputation check is authorized future work
  gated behind a deployment-wide posture flag that defaults off (§8), and it applies only to
  anchors that recompute — a `ceremony-anchor/v1` anchor in a mixed-mode catalog is classified as
  unchecked, exactly as today.
- **Every enforced check still passes for every existing anchor.** The opener's checks are chain
  id, transaction and receipt existence and success, hash match, target match, block agreement
  and finality, canonical block re-read, and exact digest bytes at the declared offset
  (`operator/src/daemon/native-base-sepolia-infrastructure.ts:1448` onward, per the ceremony spec
  §3.2b table), plus referential integrity and finality in
  `operator/src/daemon/native-trust-catalog.ts:325-364`. None of them reads the preimage. Nothing
  proposed here touches any of them.
- **Bindings, catalogs, and the schema are unchanged.** No field is added to `KeyBinding` (§9
  rejects that explicitly), no schema literal moves, and `base-sepolia-calldata-v1` — the
  `z.literal`-pinned locator profile at `native-trust-catalog.ts:63` — is not renamed or
  re-versioned. The `contractAddress` → `to` rename stays where DR-2026-09-06 decision 9 put it:
  carried to the profile document, not applied to the wire key.
- **The live DR-2026-08-05 gate catalog** is not in this repository and cannot be inspected from
  here. The claim made is therefore the only one that can honestly be made: nothing proposed here
  adds a check that runs against it by default, so its boot behavior is unchanged byte for byte.
  That is the same claim DR-2026-09-06 §Consequences makes for the same catalog, on the same
  grounds.
- **One narrowing is proposed and is stated as such.** §3.3's ASCII restriction and §7's F1 and
  F2 narrow what a *conforming* catalog may contain, under `binding-anchor/v1` only. They
  constrain nothing that exists and refuse nothing that is authored today, but they are
  constraints, and the profile document must publish them as constraints rather than as
  clarifications.

## 11. Carried forward to the anchor-locator profile document

One cumulative list, so the profile document's author has one list rather than two. The first
two items are DR-2026-09-06 decision 9's, restated here in its own terms rather than replaced.

1. **The field is named `to`, not `contractAddress`.** No contract need exist at the target, and
   the field holds a plain recipient. The wire key nonetheless stays frozen at `contractAddress`
   for `base-sepolia-calldata-v1`, a `z.literal`-pinned profile with a live operator-held catalog
   behind it (`operator/src/daemon/native-trust-catalog.ts:60-70`).
2. **The successor binding-anchor question travels with it** — carried by DR-2026-09-06 as a
   question, and answered here as a proposal.
3. **The successor preimage** — name, byte production, ordering rules, uniqueness refusal,
   encoding, and digest spelling: §3, to be written fresh as normative text.
4. **The verifier-enforced ASCII restriction** and the refusal it implies: §3.3 — under the same
   posture parameter as item 5, so a violating record is refused under successor-required and
   classified-and-reported under mixed mode.
5. **The range rule and the recomputation procedure**, including the both-classes refusal at step
   2 and the mismatch behavior at step 5: §4. The procedure is the **successor-required**
   procedure; under mixed mode step 5 substitutes classify-and-report for the refusal and nothing
   else changes. Publish that as **one** rule with a posture parameter — not as an unconditional
   refusal here and a reporting mode in item 11, which would hand the reader two contradictory
   normative rules about one behavior. Step 5's refusal names the records in `R(a)` as well as the
   anchor digest, for the reason item 10 gives.
6. **The re-anchor trigger** as a three-limb disjunction, with what each limb inspects and by
   whom, and T2's stated asymmetry: §5.2. Both rejected trigger shapes, with reasons: §5.5,
   §5.6.
7. **The standing exposure, in these words:** until a trigger fires, deployments keep
   `ceremony-anchor/v1`, and that is the borrowed-anchor residual with catalog write authority as
   its only bound and the genesis exemption reachable through it — not a neutral hold. **And both
   of the ceremony spec §10 (f)'s bounds on the successor's claim, not one.** First: recomputation
   **converts** the residual rather than eliminating it — the preimage carries no timestamp, so an
   adversary who genuinely submitted an anchor over a tuple at time T can still present that early
   time later, at the cost of real gas and foresight of both the victim IRI and their own keys.
   Second: it does nothing for a catalog whose records an attacker cannot get in front of a
   verifier, which is the procedural bound. A profile document that published only the second
   would publish, as normative text, a bound the mono-side ratified record already knows is too
   strong (§5.1).
8. **The hard precondition:** the re-author procedure does not execute today (§5.3), so the
   trigger must not be published as though it were executable.
9. **The mint-fresh ruling**, its four arguments, the wholesale coverage gap named as wholesale,
   and the record contents an operator must write: §6. **With the ruling's own tension carried,
   not dropped:** it forbids retroactive expansion of authority while mandating retroactive
   contraction of it, and the §7.4b rule its first argument cites is about the second direction
   only. §6.3 records why adoption is nonetheless not gated on §13.2's `expiresAt` / supersede
   shape. Publish both halves.
10. **The new failure modes** F1–F5 as constraints: §7 — including F5, the catalog-wide denial a
    single hostile record buys under the range rule, and the refusal-message requirement it
    implies: name the records in `R(a)`, not the anchor digest alone (§4 step 5).
11. **The coexistence rule and the deployment-wide posture**, including that a non-match is not
    evidence of a legacy anchor and that mixed mode buys no security: §8. **Arming
    successor-required has two preconditions:** the re-author procedure must execute (item 8),
    *and* the recomputation check must exist for **both** anchor classes. Otherwise the posture's
    name asserts coverage the deployment does not have over the class the ceremony spec §3.2b
    calls the sharper one. Mixed mode is the same procedure with step 5 reporting rather than
    refusing (item 5), not a second rule.
12. **The rejected alternatives with their reasons**, not only their verdicts: §9.

**Two criteria this repository cannot close.** Issue #4172's first acceptance criterion asks that
the anchor-locator profile document specify the successor preimage and the trigger, and its
second asks that the reuse-vs-fresh ruling be recorded in that same document. Neither can be met
here, for the reason in §1.1: the profile document lives in `Jinn-Network/spec`, whose import has
not landed. This document makes both mechanical — nothing left to decide, only prose to write —
but it does not satisfy them. Closing #4172 on this work is a judgment the operator should make
knowingly, and the honest alternative is to keep it open against a `Jinn-Network/spec` follow-up,
alongside the issues named in DR-2026-09-03 §Consequences, that carries this document's content
into normative text.

## 12. Follow-ups

Named here rather than filed, so this document is the single place they are recorded. Each has
no owner.

- **Implement `binding-anchor/v1`** in `ceremonyAnchorDigest`
  (`operator/src/cli/commands/ceremony.ts:412-428`) and the recomputation check in
  `openNativeTrustCatalog`. This is the work T1's firing obliges (§5.2).
- **Fix the re-author procedure's defects** (§5.3). Without this the trigger fires into a
  procedure that stops at a guard.
- **The Agent-IRI refusal the ruling requires** (§6.5). A blocker on the ruling's *execution*,
  not on its adoption: a small guard, and the ruling arguably should not ship without it.
- **The `expiresAt` / supersede shape** (§13.2). This would remove the coverage gap entirely and
  is the most valuable of the five.
- **`KeyBinding.supersedes` is declared and read by nothing.** No consumer reads it: as a field
  it appears only in the schema (`packages/trust/core/src/key-binding.ts:71`) and in the test
  fixture builder (`packages/trust/testing/src/fixtures.ts:158`, `:208`). A declared field no
  consumer reads should be wired up or deleted.

## 13. Notes on the record

### 13.1 Where issue #4172's premises do not hold

Stated plainly, because the corrections are load-bearing rather than pedantic.

**"The commitment can only ever be opened by its author" is too strong.** The issue says the
anchor "can only ever be opened by its author" and is therefore "evidentially inert".
DR-2026-09-06 decision 3 and the ceremony spec §3.2b correct this: for a catalog carrying a
settlement-scoped binding the commitment **is** openable today, by enumerating the twelve role
assignments the scope map cannot distinguish, hashing each, and comparing. That check needs no
re-anchor and works against every anchor already mined. Inertness applies only to the
settlement-free shape (`--role-sets requester`,
`operator/src/cli/commands/native-requester.ts:46-51`), where the missing Safe is a 160-bit
address rather than a twelve-way choice. This matters for the trigger: the successor buys
*direct* recomputation and closes the settlement-free hole; it is not the difference between
inert and openable. §5 is written against the corrected framing.

**The section reference is misattributed.** The issue attributes the defect record to "the DR's
own §10 (f)". DR-2026-09-06 has no §10 — its sections are Context, Decision (ten numbered
clauses), Alternatives considered and rejected, Consequences, Ratification. §10 (e) and (f) are
sections of the ceremony spec. The DR records the defect at decision 3 and delegates the two
questions at §Deliberately left open.

**Both repairs offered in scope item 1 are the wrong shape.** "Either carry `role` on
`KeyBinding`, or replace the role→scope map with an invertible one" — both are rejected in §9,
and for the same underlying reason: they preserve the `role` term and change something larger to
make it recoverable. The correct move is the one DR-2026-09-06 decision 3 already names: stop
committing to `role` at all. The scope item is satisfiable, just not by either option it lists.

**The first-offered trigger is undecidable** — §5.6. **The first two acceptance criteria cannot
be met in this repository** — §1.1, §11. **The re-anchor the corrective implies cannot execute
today** — §5.3.

### 13.2 A shape that removes the ruling's cost, recorded but not proposed here

The coverage gap of §6.2 is caused by *replacing* the outgoing bindings. It would not exist if a
re-author **closed** the outgoing bindings' windows and appended the new ones. The resolver
already permits this, and the reason is worth recording, because the re-author runbook states
the opposite as a flat fact.

The runbook says appending "would remain alongside the new wide-scope one for the same
`(key, agent)` pair — which is precisely a binding conflict". That is true today, but the cause
is narrower than the statement: the resolver filters candidates to those **in window at the
evaluation time** before it counts a conflict
(`packages/trust/resolve/src/binding-resolver.ts:250-255`, with the conflict reported only when
more than one candidate survives, `:269`). Two bindings for one `(key, agent)` with **disjoint**
windows never co-occur in that set and never conflict. They conflict today only because
`authorRoleBinding` sets no `expiresAt` at all
(`packages/trust/authoring/src/binding.ts:93-113`, against the optional field at
`packages/trust/core/src/key-binding.ts:68`), so every binding's window is open-ended.

So a re-author that authored `expiresAt = new anchor time` on the outgoing bindings and appended
the new ones would have no retroactivity and no coverage gap. It requires `authorRoleBinding` to
accept `expiresAt`, an append-with-supersede path, and `authorCatalog` to stop rewriting — none
of which exist.

This is recorded as a follow-up direction (§12), not proposed here. It is a refinement of the
fresh-anchor ruling — the new bindings still take a fresh anchor — so it does not reopen §6; and
it is implementation work well outside a documentary issue's scope.
