# Jinn Record Discovery Protocol v1

**Date:** 2026-07-27

**Status:** design approved section-by-section in session; adversarial review findings
resolved; architecture review findings resolved; written review pending

**Shape:** `design`

**Scope:** the backend-neutral distribution layer for the stack's sealed records — how records
are announced by their producers, found and subscribed to by consumers who do not already hold
references, and served by carriers that never need to be trusted

**Out of scope:** implementation plan and sequencing details beyond design granularity,
migration steps for the existing Discovery API and indexer (declared impact only), transparency
log deployment, search relevance and ranking, reputation, settlement, and any hosted-service
operational design

Companion designs in this stack:

- `docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md` (Evidence
  Protocol — the three retrospective record families)
- `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (TEP — Task,
  Submission, Attempt, observations, Delivery; backend contract; bindings)
- `docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md` (profiles —
  discovery-visible facts, operator task filters, SolverNet dissolution)
- `docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md` (trust — agent IRIs,
  key-binding statements, trust-policy documents, freshness semantics)
- `docs/superpowers/specs/2026-07-24-jinn-evidence-discovery-layer-design.md` (evidence
  discovery layer — the in-process announcement/indexer/catalog contracts this protocol
  generalizes; in flight on the #2150–#2154 PR train)

## 1. Problem statement

The stack now defines every record worth finding — sealed Tasks, Submissions, and Deliveries
(TEP), the three Evidence families, key-binding statements and trust-policy documents (trust
layer) — plus CloudEvents lifecycle observations with source-pinned ordering. It deliberately
says nothing about *finding* any of them:

- TEP's explicit non-goals exclude "discovery or search" and "marketplace advertisement," and
  every backend-contract verb (`observe`, `watch`, `deliveries`, `fetchDelivery`) requires a
  reference the caller already holds.
- The find step is today welded to one trusted, privately operated indexer with a bespoke
  GraphQL surface (`spec/2026-05-11-discovery-api-and-shared-indexer.md`,
  `client/src/discovery/`). The client compensates for that indexer's untrustedness piecemeal:
  it re-gates every claim on-chain (`canClaimTask`), hash-verifies manifests and artifacts
  after fetching, and deliberately returns empty results for anything it cannot verify —
  verdict tallies, instance-success counts, code-digest rewards, plugin scores are all
  fail-closed empties because the underlying indexer projections are permissionless and
  unverifiable (#2044, #2045).
- The profiles design dissolved SolverNets into "operator-side task filters over
  discovery-visible facts: task profile URI, requester IRI, terms" — a contract that currently
  has no portable carrier.
- The evidence discovery layer in flight defines announcement contracts that stop at the
  process boundary: no signing, no network serving surface, no subscriptions, and evidence
  records only. It is retrospective ("this record exists"); the find-work problem is
  prospective ("this work is open").

The missing piece is the **distribution layer**:

> These records exist (or this work is open), announced by an accountable source, findable and
> subscribable by strangers, servable by carriers nobody has to trust.

This specification defines that layer — the **Record Discovery Protocol**. It is not a new
record family. It distributes records the other protocols define, and its position in the
stack is strictly below applications and strictly above (as a consumer of) the record-defining
protocols:

```text
Applications          daemon find-work · evaluators · Autopilot · explorer · benchmarks
     │  consume discovery; produce and consume records
Record Discovery      announce / query / subscribe — distributes records by reference
     │  references records defined by ↓ (one-way dependency)
TEP + Evidence        define the records (Tasks, Submissions, Deliveries, crates, …)
     │
Trust layer           identities, keys, signing, freshness — used by every layer above
```

TEP and the Evidence Protocol never import discovery and work completely without it: Task
bytes can be handed over directly, a backend returns Deliveries through its own verbs, an
evidence crate is fetchable from a repository the consumer already knows. Discovery exists
only for the situation those protocols deliberately do not cover — parties who do not already
know each other or hold references.

## 2. Decision and rationale

Jinn adopts **approach B: compose established standards with a thin Jinn profile** — the same
decision as every other component in this stack — authoring exactly two bespoke objects (the
Announcement Entry and the Source Head, §5) because the standards audit (§3) found no single
standard owning the whole distribution problem, while every plane of it has a mature,
deployed pattern to re-express in the stack's own grammar (sealed I-JSON records, sha256
exact-bytes identity, DSSE signing, trust-layer key resolution).

The single load-bearing observation, common to IPNI, AT Protocol sync v1.1, and Rekor v2
tiles: **untrusted-carrier serving falls out of two properties the stack already has —
content-addressed sealed records and producer signatures — plus one thing this protocol adds:
a signed, hash-chained announcement structure per source**, so that "what exists" is itself a
verifiable artifact rather than a carrier's claim.

The rejected alternatives:

- **Adopt one existing discovery system wholesale.** IPNI is IPLD/dag-cbor/libp2p-coupled and
  solves only content routing; AT Protocol's MST/CAR/DID machinery exists to diff *mutable*
  repos, which our immutable records do not need; xRegistry and the CloudEvents Subscriptions
  API are server-authoritative mutable-REST designs with integrity explicitly out of scope;
  OCI distribution assumes a central registry per namespace. Each contributes a shape; none
  can be the protocol.
- **Keep the bespoke trusted indexer as the interface.** This is the status quo: a single
  trust point, fail-closed empties for everything unverifiable, no third-party backend story,
  and the SolverNet-replacement filter contract with no portable carrier.
- **Build a transparency log now.** A tlog buys completeness proofs and guaranteed
  non-equivocation — at the cost of an online sequencer, checkpoint distribution, monitors,
  and a witness quorum (the least mature layer of that ecosystem). v1 provides verifiable
  *items* and **provable** equivocation — a fork is self-authenticating misbehavior evidence
  whenever two branches are compared — but not *guaranteed detection* of a source that
  partitions its consumers (the split-view residual, named honestly in §14.1 and mitigated by
  the normative head-exchange of §10.2). Proofs of completeness and guaranteed split-view
  detection are exactly what the deferred tlog adds; the head is kept
  checkpoint-projectable (§5.2) so that upgrade is a policy bit, not a protocol version.

## 3. Standards composed

| Standard | Status | What is taken | What is left |
| --- | --- | --- | --- |
| IPNI (InterPlanetary Network Indexing) | production at Filecoin/IPFS scale since ~2022 | signed hash-chained advertisements per provider; announce-hint vs authenticated-sync split; single signed head; incremental sync by walking back to last-seen | IPLD/dag-cbor encoding, libp2p peer identity, multihash entry chunking (wrong cardinality) |
| C2SP tlog-checkpoint / signed notes | production (Go module transparency, Sigstore) | the head's field set — origin, size, hash — plus "ignore unknown signatures" additivity for later witness cosigning | the text-note carrier as the signature mechanism (the stack signs with DSSE only; a note projection is defined for future interop, §5.2) |
| RFC 5005 (Feed Paging and Archiving) | Proposed Standard, 2007 | mutable subscription head + immutable archive pages linked `prev-archive`; cold sync as page-walking; expressible as static files | Atom XML syntax |
| OCI Distribution + Referrers API | v1.1, universally deployed | pull-by-digest path grammar; the referrers reverse-lookup shape (`subject` → descriptor list, `artifactType` filter); listing pagination (`n`/`last` + RFC 8288 `Link`); the degraded static-path fallback pattern | repository-name namespacing, tag mutability, push/auth model |
| CloudEvents + Subscriptions API | CE 1.0 stable; Subscriptions 0.1-wip | events-on-the-wire for both stream families; the filter dialects (`exact`/`prefix`/`suffix`/`all`/`any`/`not`) over context attributes; the `sink`+`protocol` push shape | the trusted-subscription-manager topology as a trust boundary; the wip status is why only the filter dialects and object shape are normative here |
| AT Protocol event-stream / sync v1.1 | production at ~30M accounts | the five-case cursor contract; relay-local cursor scoping declared as such; bounded non-archival replay windows; cold sync out-of-band from the relay | MST/CAR repo machinery, DID resolution |
| WebSub | W3C REC 2018 | the challenge-echo intent-verification handshake for push callbacks; `Link` relation discovery | the trusted-hub delivery model |
| RFC 8288 (Web Linking) | Proposed Standard | registered link relations for pagination and archive navigation | — |
| TUF freshness semantics (via the trust layer) | production (via trust-layer adoption) | `refreshBy` on the head: expiry is a withholding signal, not silence; anti-rollback via consumer high-water marks | — (already adopted by the trust layer; reused, not re-specified) |
| RFC 9162 / Rekor v2 / tlog-tiles | 9162 experimental; Rekor v2 GA 2025 | design reference for the upgrade path only: tiles-as-static-files, inclusion-proof-at-write-time, witness cosigning | all runtime machinery (deferred; §21) |

Everything is re-expressed in the stack's grammar: I-JSON documents, RFC 8785 JCS confined to
sealing, sha256-over-exact-bytes identity in the OCI `sha256:<hex>` form, in-toto
ResourceDescriptor references, DSSE as the one signing mechanism, trust-layer key-binding
resolution, CloudEvents structured JSON.

## 4. Design tenets

1. **Three separable planes.** *Announce* is the only trust-bearing plane: producer-signed,
   append-only, hash-chained statements of existence. *Query* (point-in-time lookup) and
   *subscribe* (change tails) are convenience planes any untrusted party can operate, because
   everything they hand out is re-verifiable against the announce plane. Conflating the planes
   is how middlemen accumulate trust; the protocols that age well keep them apart.
2. **Carriers are untrusted.** Any mirror, CDN, or hostile party can serve every artifact of
   this protocol — including the mutable head, whose signature and freshness bound make a
   lying mirror detectable rather than trustable. Hosting a source costs a static file host.
3. **Items are verifiable; sets are claims.** Every individual item a consumer receives is
   end-to-end verifiable (digest, signature, provenance to a signed announcement — with the
   verification steps that make this true stated as obligations in §10.4, not assumptions).
   The *completeness* of any listing is only the answering service's claim, and responses must
   say so honestly (§8). Upgrading sets from claims to proofs is exactly the transparency-log
   follow-up, deliberately deferred; the residuals this leaves are named in §14.1.
4. **Announcements confer no validity.** An announcement is a distribution act. Record
   validity, evaluation, trust, and authorization all live in the record-defining protocols
   and the trust layer. Symmetrically, a *withdrawal* is a distribution act: it delists, it
   never invalidates, suppresses, or erases (§5.1).
5. **Edges, not counters.** Append-only chains carry state *transitions* (became available,
   withdrawn); fast-changing values (attempt counts) are query-plane liveness data. The
   authoritative gate at the moment of action (e.g. the marketplace's on-chain claim gate)
   always remains with the substrate.
6. **Generalize, don't duplicate.** The evidence discovery layer's frozen contracts are a
   conforming instance of this protocol (§11). One announcement model covers all record
   kinds; per-kind specifics enter only through the facts-profile contract (§12).
7. **Every claimed property is a MUST with a fixture, or a named residual.** Where a security
   property depends on a consumer-side check, that check appears in a named verification
   procedure (§10) and the conformance kit (§18); where v1 genuinely does not provide a
   property, §14.1 says so.

## 5. The announcement record model

Everything in this section follows the stack's sealing discipline: I-JSON documents,
JCS-canonicalized once at sealing, identity = sha256 over the exact sealed bytes, referenced
by digest thereafter, never re-serialized.

### 5.1 Announcement Entry

The append-only unit. A sealed document:

```jsonc
{
  "protocol": "<record-discovery version URI>",
  "source": { "agent": "<Agent IRI>", "name": "<source name>" },
  "sequence": "0000000000000042",           // fixed-width 16-digit decimal; see sequence rule
  "previous": "sha256:<hex>",               // digest of the predecessor entry; null only at genesis
  "timestamp": "2026-07-27T12:00:00Z",      // producer clock, informational, never load-bearing
  "announcements": [
    {
      "announcementId": "<unique within source>",
      "action": "available",                // or "withdrawn"
      "record": {
        "kind": "<record-kind URI>",        // §12
        "digest": "sha256:<hex>",
        "mediaType": "<media type>"         // optional
      },
      "locations": [                        // optional, portable, binding-owned
        { "profile": "<location-profile URI>", "locator": "<string>" }
      ],
      "facts": { /* kind-specific facts card, §5.4 */ }
    },
    {
      "announcementId": "…",
      "action": "withdrawn",
      "retracts": "<announcementId of an earlier available from this source>",
      "reason": "delisted"                  // delisted | superseded | reorged | error
    }
  ]
}
```

Semantics:

- **Source identity is the tuple `(agent IRI, source name)`.** A party may run several
  sources (a marketplace projection, a corpus feed); chain, sequence numbering, and head are
  all per-source. The agent IRI and its working keys resolve through the trust layer's
  key-binding statements. **Source names** match `[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?` —
  lowercase alphanumeric plus interior hyphens, at most 64 characters — so they compose into
  the head's `origin` string unambiguously (§5.2).
- **`sequence` is per-source, fixed-width 16-digit decimal, and increments by exactly one per
  entry.** The genesis entry has `sequence: "0000000000000001"` and `previous: null`; no
  other entry may carry either property. **Gaps are forbidden.** Sequence therefore equals
  the count of entries — which is what makes the checkpoint projection's size mapping sound
  (§5.2) and makes *any* second child of an entry unambiguous equivocation (§5.3), with no
  benign explanation available.
- **`previous` is the hash chain.** Each entry commits to the exact bytes of its predecessor.
- **`announcements[]` is non-empty.** Size ceilings mirror TEP's layering: advisory in core
  — entry ≤ 1 MiB sealed, ≤ 512 items per entry, facts card ≤ 4 KiB per item, archive pages
  (§7) ≤ 4 MiB — and **hard in the published-source profile**, where an oversized entry is
  rejected and yields `broken-chain` from that entry onward. Producers needing more emit more
  entries.
- **`announcementId` is unique within the source, across all entries.** A duplicate is
  `invalid-document`: consumers MUST reject the entry containing the duplicate (and treat the
  chain as `broken-chain` from that point).
- **`withdrawn` un-advertises; it never deletes and never invalidates.** Records are
  immutable; withdrawal is a distribution act. Rules:
  - `retracts` targets an earlier `available` announcement from the *same* source, only.
    Withdrawing a withdrawal is not defined and is `invalid-document`. Re-announcing a
    previously withdrawn record later, under a new `announcementId`, is legal.
  - `reason` is mandatory: `delisted` (availability ended in the ordinary course — a
    Submission closed, exhausted, or expired), `superseded` (a later announcement replaces
    this one — e.g. better locations), `reorged` (projection correction: the substrate fact
    behind the announcement no longer holds after reorganization, §6.3), or `error` (the
    source's own mistaken announcement).
  - **Consumer obligations.** Withdrawal MUST NOT cause a consumer to discard fetched record
    bytes, verified facts, or decisions already derived from them — with one exception:
    `reorged`, on which decision-grade consumers MUST recompute anything derived from the
    retracted item (the substrate fact it depended on is gone). For **retrospective record
    kinds** (Deliveries, evaluations, evidence), withdrawal with any reason other than
    `reorged` has no evaluative meaning whatsoever, and consumers MUST NOT prune
    previously-verified retrospective items from decision stores on the basis of a
    withdrawal. This closes the evidence-suppression channel: a source cannot un-happen its
    own bad Delivery by delisting it.
- **`timestamp` is informational.** No consumer decision may depend on it; ordering is
  `sequence` and chain position, freshness is the head's `refreshBy` and `issuedAt`.
- **Observations do not ride the chain.** The chain carries sealed durable records. TEP
  lifecycle observations keep their own already-defined identity and ordering and flow
  through the subscribe plane (§9); archiving observation logs as an announceable record kind
  is a named follow-up (§22), not v1.

### 5.2 Source Head

The one mutable document per source. A sealed I-JSON document, DSSE-signed like everything
else in the stack:

```jsonc
{
  "protocol": "<record-discovery version URI>",
  "origin": "<agent IRI>/<source name>",    // grammar below
  "sequence": "0000000000000042",           // sequence of the latest entry = entry count
  "entry": "sha256:<hex>",                  // digest of the latest entry
  "issuedAt": "2026-07-27T12:00:00Z",       // strictly increases on every re-signing
  "refreshBy": "2026-07-28T12:00:00Z"       // trust-layer freshness semantics
}
```

- **`origin` grammar is pinned:** the agent IRI, a single `/`, the source name. Source names
  contain no `/` (§5.1 grammar), so the *last* `/` always separates unambiguously —
  regardless of whether the agent IRI itself contains slashes (trust-layer agent IRIs may be
  `urn:uuid:` or public dereferenceable IRIs, which routinely do). Two independent
  implementations MUST produce byte-identical origins for the same source — the property
  witness and tlog interop depend on.
- **Checkpoint compatibility is at the field level, not the carrier level.** With gap-free
  sequences (§5.1), `sequence` is a true entry count, so the field set
  `{origin, sequence, entry}` maps soundly onto the C2SP checkpoint triple (origin, tree
  size, root hash). Field-level compatibility is normative; the projection to the C2SP
  signed-note text form is a named follow-up (§22) — nothing in v1 consumes it. The
  *carrier* is DSSE — the stack has one signing mechanism, and this document is no exception. DSSE
  envelopes accept multiple signatures; consumers ignore signatures from keys they cannot
  resolve — the additive-cosigning property the note format was chosen for, preserved.
- **`issuedAt` makes head recency comparable.** It MUST strictly increase on every
  re-signing. Given two valid heads for one source, consumers MUST prefer the higher
  `(sequence, issuedAt)`. Unlike entry timestamps, `issuedAt` is load-bearing for exactly
  one comparison — newer-of-two-valid-heads — and nothing else.
- **`refreshBy` reuses the trust layer's freshness semantics.** An expired head is a
  *withholding signal*, not silence: a live source re-signs its head before expiry even when
  nothing was announced. Consumers treat a stale head as "this source can no longer be
  considered live," surfaced loudly (§13.4). **The published-source profile bounds
  `refreshBy`** (design default: at most 24 hours ahead of `issuedAt`; the marketplace
  profile pins its own tighter bound) — because, as §14.1 states plainly, the `refreshBy`
  window *is* the rollback-exposure window for consumers without a high-water mark.
- **Anti-rollback is the consumer's high-water mark, plus mirror-set comparison for cold
  starts.** Consumers persist, per source, the highest verified `(sequence, entry digest)`.
  A consumer with no high-water mark for a source (first adoption, fresh device) MUST fetch
  the head from **every** reachable endpoint in its policy's mirror set for that source and
  proceed from the highest `(sequence, issuedAt)` among the valid ones (§13.3). A head that
  goes backward, or two signed heads claiming the same sequence with different entry digests,
  is **provable equivocation** — both artifacts are signed (§5.3).

### 5.3 Chain rules

1. Entries are append-only and immutable; `previous` linkage MUST verify on sync.
2. **Any second signed child of an entry is a fork, and any two signed heads at one sequence
   with different entry digests are a fork.** With gaps forbidden (§5.1) there is no benign
   reading. A fork is equivocation: consumers that detect one MUST stop treating the source
   as live and MUST retain both branches — signed forks are self-authenticating misbehavior
   evidence. Items already consumed from a now-forked source keep whatever verification they
   individually passed; the fork poisons the source's *liveness*, not the validity of
   independently verified records.
3. Cold sync is IPNI-shaped: fetch the head, walk `previous` toward genesis, verifying
   linkage and signatures as you go. Bulk cold-start uses archive pages (§7) — O(pages), not
   O(entries).
4. A source position cursor is the tuple `(sequence, entry digest)` — the generalization of
   the evidence journal's `{revision, entryDigest}` cursor.
5. **Linkage depth is not discretionary.** A returning consumer MUST verify linkage from the
   head back to its high-water mark, always. A consumer adopting a source for the first time
   MUST verify linkage to genesis once before any decision-grade use of items attributed to
   that source (with gap-free sequences the walk is bounded and its length is exactly
   `sequence`; archive pages make it O(pages); inclusion proofs — the tlog follow-up —
   remove it later). A consumer MAY operate in **shallow mode** — walking only recent pages —
   for liveness and filtering, but shallow mode is explicitly non-decision-grade.
   **Decision-grade use** — the canonical definition, referenced everywhere this spec uses
   the term — is any use whose output feeds attribution, reputation, reward, corpus
   admission, or settlement; deployment profiles may extend this list, never shrink it.
6. Sources MAY correct themselves only by appending (explicit withdrawals plus corrected
   announcements). Rewriting history is structurally impossible without forking, and forking
   is equivocation.

### 5.4 Facts cards

The `facts` object is the **filter-before-fetch mechanism**: a kind-specific, denormalized
card of the record's discovery-visible facts, so consumers can filter announcements without
fetching every record. Its rules are strict:

1. The card's schema is defined per record kind by a **facts profile** (§12), identified by
   URI and digest-pinned like every profile document in the stack.
2. Facts come in **two declared classes**, and the facts profile labels every field with
   one. **Record facts** MUST be recomputable from the referenced record's bytes (plus,
   where the profile says so, bytes the record references — e.g. a Submission card includes
   facts drawn from its Task) and are verified by `facts-consistency`. **Substrate facts** —
   permitted only in projection-source announcements; author sources MUST NOT carry them —
   state facts that live on the substrate rather than in any sealed bytes (escrow terms,
   claim windows); each MUST be covered by the item's derivation annotation and is verified
   by `derivation-consistency` (§6.2). Facts profiles for access-classified records MUST
   derive every record fact from public bytes only — a card may never carry, nor require for
   verification, content behind a capability gate.
3. Consumers MUST re-verify the card after fetching — record facts through the named
   `facts-consistency` check (§10.4), substrate facts through `derivation-consistency`.
   `facts-consistency` outcomes are typed: `consistent`, `inconsistent`, or
   **`indeterminate`** (some contributing referenced bytes are unavailable or
   capability-gated to this consumer). Decision-grade use MUST fail closed on anything but
   `consistent` for record facts, and on any unverified substrate fact — an unverifiable
   fact is never acted on as if verified. Facts are for *filtering*; every decision-grade
   use requires the fetched, digest-verified record.
4. A source that publishes a card inconsistent with the record bytes has published a signed
   false statement — retained as misbehavior evidence, with the policy response of §10.2.

For the Submission kind, the card carries exactly the discovery-visible facts the profiles
design named when it dissolved SolverNets: the Task digest and task profile URI (record
facts drawn from the referenced Task), requester IRI and deadline (record facts from the
Submission bytes), and terms (substrate facts under the marketplace projection, §6.3). That
card is the portable carrier the operator-filter contract was missing.

### 5.5 Signing posture

The chain *structure* — sealing, linkage, sequence discipline — is core. **DSSE signing of
entries and head is required by the `published-source` profile**: any source served across a
trust boundary. This keeps the evidence layer's in-process journal conformant as-is (an
*unpublished source*), while everything network-visible is signed — the same core-vs-profile
layering as TEP signing.

Entries are signed once at append time (per-item accountability: a query-plane item can cite
its entry without shipping the whole chain). The head is re-signed continuously. Because each
entry commits to its predecessor, **a signed head transitively commits to the entire chain**
— which is what makes key rotation survivable (§10.1), under the head-signer freshness rule
of §10.3.

Discovery signatures use **one namespaced trust-layer signing scope covering both entries
and heads** (working name: `discovery-announcements`, registered through the trust layer's
scope-extension mechanism). A key without that scope in its binding is an
`unauthorized-signer` for this protocol regardless of its other scopes.

## 6. Source classes

### 6.1 Author sources

A party announces records it authored: a requester its Tasks and Submissions, an operator its
Deliveries and published evidence, a builder its plugin and checkpoint artifacts, a
trust-document issuer its key bindings and policies. The source agent IRI is the record
author's, or an authorized delegate under a trust-layer authorization statement. An author
announcement is a first-hand statement — "I published this" — and its facts card is
authoritative by authorship, though still mechanically re-verifiable like any other.

Author sources are the whole find-work story for backends without a public substrate: a
third-party backend (or a requester using one) runs an author source for its open
Submissions, operators add it to policy, and the same filters work unchanged. No chain, no
indexer, no Jinn infrastructure required.

### 6.2 Projection sources

A party announces records and facts it *observed* on a substrate it does not author. Three
rules distinguish them:

1. **Every projected item carries a derivation annotation** — the substrate fact backing it.
   For an EVM substrate: `{chainId, contract, event, blockNumber, txHash, logIndex}`. The
   projection claim is "this event occurred, implying this record with these facts," and
   anyone can check any item against the substrate — the named `derivation-consistency`
   verification check (§10.4). **For decision-grade use of a projected item — reputation,
   reward, corpus admission, settlement — `derivation-consistency` is mandatory**, mirroring
   §5.4's rule for facts: the projector's signature makes it accountable, only the substrate
   makes it *true*. For filtering, display, and liveness it remains an optional spot-check.
2. **A projection source never claims authorship, only observation.** Which projectors to
   follow is a trust-policy choice (§10.2); author records verify individually regardless of
   which projector surfaced them.
3. **Competing projectors are cheap and comparable.** Divergence between two projectors over
   one substrate is detectable, and the substrate — ground truth — resolves it. Following
   several and taking the union of verified items is always safe.

### 6.3 The marketplace projection source

The canonical projection source, run first by Jinn and by anyone thereafter. The
event-to-announcement mapping:

| Chain event | Announcement emitted |
| --- | --- |
| Task/Submission posted (`TaskCreated`) | `available` for **two records**: the Task record (bytes on IPFS) and the **Submission record** — the marketplace profile requires signed sealed Submissions, so the binding publishes their bytes alongside the Task's. The Submission announcement is the find-work feed item; per §5.4 its card carries record facts (Task digest, task profile URI from the referenced Task; requester IRI, deadline from the Submission bytes) and substrate facts (escrow terms, claim window) |
| Claimability edge (exhausted / expired / finalized / refunded) | `withdrawn`, reason `delisted`, for that availability |
| Solution delivered | `available`: the Delivery record, facts = Task digest, deterministic Attempt URI (the projector computes the TEP §9.2 UUIDv5 itself), outcome. The evaluator find-deliveries feed — #2044's lifecycle join made portable |
| Verdict delivered | `available`: the evaluation Delivery record — whose output payload is the evaluator-signed Result Evaluation Statement, per the profiles design §9 |
| Artifact publications (`MetadataSet`: envelopes, plugins, checkpoints) | `available` for the corresponding record kind |

On identity: the marketplace's task-upload path uses raw-codec sha256 CIDs, so the on-chain
CID digest coincides with the task-bytes sha256 — and this is now a **load-bearing
requirement on the upload path**, stated as such. The projector SHOULD verify by
fetch-and-rehash before announcing rather than trusting the CID structurally; a consumer's
digest re-hash catches any violation regardless.

Two disciplines keep the projection honest:

- **Edges, not counters** (§4.5). Current attempt counts and other fast-changing values never
  enter the chain; they are query-plane liveness data, and the on-chain claim gate remains
  the authoritative check at the moment of claim — exactly as the client behaves today.
- **Reorgs produce corrections, never rewrites.** The projector declares a confirmation depth
  in its source metadata (part of the well-known document's source description, §7); a deeper
  reorg obliges explicit appended withdrawals with reason `reorged` — which trigger the
  §5.1 recompute obligation in decision-grade consumers — plus corrected announcements. The
  chain records what the projector believed and when it corrected itself. A projector
  declaring confirmation depth 0 is conformant but self-describing as reorg-prone; policy
  chooses whether to follow it.

### 6.4 Bootstrap and multiplicity

No global source registry in v1 (§21). A consumer's trust-policy document lists the sources
it follows — identity, head endpoint, mirror set (§10.2) — and "joining the network" becomes
exactly what the profiles design promised: config entries (sources + filters), no join
lifecycle. The serving plane's well-known document (§7) makes any host's sources
self-describing.

Today's Ponder indexer feed becomes projector #1 — now signed and accountable, with anyone
able to stand up a competitor. The existing on-chain floor (`OnchainDiscoveryAPI`) is revealed
as what it always was: the consumer-side derivation procedure — "run the projection yourself"
— which is why it remains the always-live fallback with no trust decision attached (§13.4).

## 7. Serving plane

A **serving root** — an HTTPS base URL in the normative v1 profile; IPFS and filesystem
layouts are additional profiles over the same layout grammar (§22) — exposes:

1. **Records by digest.** Exact sealed bytes at a digest-derived path. Immutable, infinitely
   cacheable, mirror-safe by construction: the consumer re-hashes everything it fetches.
   Announcement entries live in the same store — they are sealed records too. The path
   grammar is fixed at implementation; its properties are normative: derivable from the
   digest alone, one digest one path, no query parameters required.
2. **Archive pages.** RFC 5005-shaped immutable pages of announcement entries in sequence
   order, each linking to its predecessor page (`prev-archive` relation), ≤ 4 MiB each. Cold
   sync: head → newest page → walk back to the required depth (§5.3 rule 5). Every page is a
   static file.
3. **Source heads.** The only mutable objects. One per source at a conventional path under a
   **well-known discovery document** listing the sources a host serves — for each: source
   identity, head path, archive root, and source metadata (declared confirmation depth for
   projections, declared substrate). The well-known document's schema is part of the
   protocol, not implementation-discretionary; it *introduces* sources, but acceptance is
   always policy plus `source-chain-verification` — introduction is never trust.
4. **Announcement pings** — optional, unauthenticated hints ("head moved") over any transport
   (HTTP ping, webhook, gossip). IPNI's split, kept exactly: pings trigger a pull; all trust
   lives in the pulled, verified chain. Consumers MUST debounce pings and rate-limit
   pull-on-ping per source — a ping flood may cost the consumer at most its own configured
   pull rate, never a pull per ping. A consumer that never receives pings loses only latency.

Location fetches (`locations[].locator`) are attacker-influenced URLs by construction:
consumers MUST apply size ceilings, content-type checks, and private-address/SSRF guards to
location fetches, and MUST treat the digest re-hash as the only accepted outcome — a locator
is a hint about *where*, never about *what*. v1 defines two location profiles — an HTTPS URL
profile and an IPFS CID profile, locator grammars pinned at implementation; deployment
profiles may define more.

The consequence, stated as a design goal: **hosting a source costs a static file host.** The
trust story never depends on who serves the bytes.

## 8. Query plane

Anyone can run a query service; it is a pure cache/aggregator over announce chains it
follows. Working interface (TypeScript-first, same convention as the TEP backend contract —
names frozen at this granularity, signatures refined at implementation):

```ts
interface DiscoveryQueryService {
  capabilities(): Promise<QueryCapabilities>;      // kinds served, sources followed, freshness
  getRecord(digest: Sha256Digest): Promise<Uint8Array>;          // exact bytes
  referrers(subject: Sha256Digest, filter?: { kind?: RecordKindUri },
            page?: PageRequest): Promise<Page<AnnouncedItem>>;
  search(kind: RecordKindUri, facts: FactsFilter,
         page?: PageRequest): Promise<Page<AnnouncedItem>>;
}

interface AnnouncedItem {
  record: RecordRef;                                // kind + digest (+ mediaType)
  facts?: unknown;                                  // the announced facts card
  locations?: PublishedLocation[];
  provenance: {                                     // mandatory — §8 rule 1
    source: SourceIdentity;
    entry: Sha256Digest;                            // the announcement entry containing it
    announcementId: string;
    derivation?: unknown;                           // projection sources
  };
}

interface Page<T> {
  items: T[];
  nextCursor?: string;                              // opaque; deterministic digest tie-break
  complete: boolean;                                // §8 rule 2
  freshness: Array<{ source: SourceIdentity; position: SourceCursor }>;
}
```

Two operations, three normative rules:

- **Reverse lookup** (`referrers`), shaped like OCI referrers: everything that references
  digest D, optionally filtered by kind — Deliveries for a Task, evaluations for a Delivery,
  verifications for a crate. The reference relation is defined over *announced facts*: a
  kind's facts profile MUST name its reference-bearing fields (the Delivery card's Task
  digest, the evaluation's subject digests); a service MAY additionally derive references by
  parsing record bytes, declared as a capability in `capabilities()`.
- **Open-work search** (`search`), the profiles design's operator task filters as a query:
  Submissions filtered on facts-card fields (profile URI, requester IRI, terms, deadline).
  This is `findClaimableTasks` generalized.

1. **Items verifiable, sets are claims.** Every returned item MUST carry provenance — source
   and entry — so it traces to a signed announcement and thence to verifiable record bytes.
   A query service MUST NOT serve items lacking chain provenance: it aggregates the announce
   plane; it never originates. The consumer-side half of this rule is §10.4 step 3: cited
   provenance is *verified*, not believed — a malicious query service fabricating provenance
   is caught by the entry check, not by this sentence.
2. **Empty is not truncated.** Responses MUST distinguish complete results from degraded ones
   (the #2175 lesson made protocol) and MUST carry per-source freshness — the source cursor
   each answer reflects: the honest version of the indexer's `behindHead`.
3. **No ranking.** Relevance, search quality, and recommendation are application concerns
   above the protocol (#1058 remains an application design).

Pagination follows the evidence catalog reader's rule: limit + opaque cursor, deterministic
order with record-digest tie-break. Operation errors reuse the TEP error taxonomy
(`invalid-reference`, `content-corruption`, `backend-unavailable`, `deadline-exceeded`, …);
discovery adds no parallel operational taxonomy — cursor conditions (§9.3) are detail codes
under `invalid-reference` (`cursor-unknown`, `cursor-too-old`), not new categories.

**Privacy note.** Server-side filtering necessarily reveals the consumer's interests —
which profiles, requesters, and terms an operator pursues — to the query service or relay.
The privacy-preserving alternative is always available and is the default posture for
sensitive filters: sync the chain (or archive pages) and filter locally. The IPNI
reader-privacy techniques are the named follow-up for making server-side lookup private
(§22).

**What this closes.** The four fail-closed empties in today's client — verdict tallies,
instance-success counts, code-digest rewards, plugin scores — are reverse-lookup aggregations
that cannot currently be trusted. Under this plane the same queries return per-item provenance
over signed, digest-verified records, and a decision-grade consumer verifies each
contributing item per §10.4 — entry provenance against a synced chain, plus mandatory
`derivation-consistency` for projected items — or recomputes the aggregate from the substrate
itself. That is what makes the aggregation *verifiable* rather than merely *attributed*:
#2044/#2045, structurally answered. Until inclusion proofs land (§22), decision-grade use of
query results costs a source sync; what the query plane sells is latency and reach, never
trust.

## 9. Subscribe plane

### 9.1 Two stream families, one wire format

Both are CloudEvents (structured JSON) on the wire:

- **Announcement streams** — new announcement items from sources the relay follows, each
  event carrying the item plus its provenance. CloudEvents mapping: `subject` = record
  digest; extension attributes for record kind, source identity, entry digest, and the
  facts-card filter fields named by the kind's facts profile. The consumer's dedupe key for
  at-least-once delivery is `(source identity, entry digest, announcementId)`.
- **Observation streams** — TEP lifecycle observations relayed as-is. They already carry
  their own identity, source pinning, and fixed-width sequence (dedupe per TEP's own rules);
  a relay adds nothing and MUST NOT alter them.

### 9.2 Filters

CloudEvents Subscriptions filter dialects — `exact`, `prefix`, `suffix`, `all`, `any`, `not`
— over context attributes, including the existing `taskdigest` extension and the discovery
extensions above. An operator's task filters compile directly to these; the SolverNet-join
replacement is literally a subscription filter.

### 9.3 The cursor contract

Made normative from AT Protocol's event-stream semantics:

| Situation | Required behavior |
| --- | --- |
| No cursor | Live tail from now |
| Unknown or future cursor | Typed error, close — never guess |
| Cursor within replay window | Replay from position, then continue live |
| Cursor older than window | Explicit `cursor-too-old` signal naming the cold-sync path (archive pages / source chains) — never silent gap-skipping |
| Oldest requested | Start of window |

Two disciplines:

- **Relay cursors are relay-local** and MUST be declared as such. Data-level ordering always
  comes from source-chain sequence and observation sequence, never from a relay's numbering.
- **Relays are non-archival by design.** The replay window is bounded and advertised; cold
  history lives in archive pages. This is what makes a relay nearly free to operate (the AT
  Protocol sync v1.1 lesson).

### 9.4 Delivery modes

Pull-tail (long-poll / WebSocket / SSE — one normative HTTP profile fixed at implementation)
and optional push shaped like the CloudEvents Subscriptions API (`sink` + `protocol`), with a
WebSub-style challenge-echo handshake before any callback is honored. Push is at-least-once
convenience with no completeness promise; anything missed is recoverable by cursor replay or
cold sync. Consumers apply backpressure or drop to cold sync; producers may coalesce —
aligned with TEP's `watch` semantics.

**Addendum 2026-07-30 — the pull-tail's one normative HTTP profile is fixed.** This
section left the pull-tail transport open ("long-poll / WebSocket / SSE — one normative
HTTP profile fixed at implementation"). The operator-daemon composition design
([`2026-07-30-operator-daemon-composition-design.md`](./2026-07-30-operator-daemon-composition-design.md))
§7.3 ruling 3 closes it: the pull-tail is **Server-Sent Events with `Last-Event-ID`
carrying the relay cursor** — the boring standard for a server-to-client append-only
feed (auto-reconnect, plain HTTP, stateless horizontal scale); WebSocket is justified
only by mid-stream client-to-server messages, and this protocol's filters are set at
subscribe time. The §9.3 five-case cursor contract maps onto SSE as typed terminal
events (`unknown-cursor` and `cursor-too-old`, the latter naming the cold-sync path)
followed by stream close, and each source advertises its bounded replay window in the
well-known discovery document (§7 item 3). The same ruling fixes the rest of the
archive wire profile — `ETag`/`If-None-Match` conditional GET on the head,
`Cache-Control: immutable` on digest paths and archive pages, declared
`Accept-Ranges: bytes` on blobs — and explicitly rejects TUF's role machinery and OCI's
registry API for this layer. Implemented by
`packages/discovery/transport-http/` per
[`../plans/2026-07-30-discovery-transport-http.md`](../plans/2026-07-30-discovery-transport-http.md).
Nothing else in this design changes; §9.4's optional push mode and its WebSub-style
challenge-echo handshake are untouched.

### 9.5 Trust posture and the relay cross-check

A subscription is an availability optimization, nothing more. A malicious relay can delay,
drop, or reorder — it cannot forge (everything is signed upstream). Two normative consumer
obligations make withholding *detectable* rather than merely theoretically detectable:

1. **Head-vs-delivered comparison.** A consumer MUST periodically fetch each followed
   source's head independently of its relay (any mirror suffices) and compare the head's
   `sequence` against the highest entry sequence its relay has delivered. Divergence beyond
   the consumer's staleness tolerance downgrades the relay to degraded and triggers the
   §13.4 ladder.
2. **Entry-granular spot-checks.** Because one entry can carry many items, a relay could
   deliver an entry's other items while dropping the one it wants to censor — invisible to
   sequence accounting. Consumers MUST therefore periodically fetch full entries they
   received events for and re-apply their filters locally, diffing against what was
   streamed. The conformance kit includes a per-item-drop relay fixture (§18).

Recovery never needs the relay: walk the source chain directly.

Query services will typically co-host relay endpoints. The daemon's engine-watcher becomes a
filtered subscriber instead of a poller — but polling (`search` + `observe`) remains fully
supported; subscribe is an optional capability everywhere, exactly like TEP's `watch`.

## 10. Trust integration

### 10.1 Source identity and keys

A source signs with working keys bound to its agent IRI through trust-layer key-binding
statements — nothing new is invented here. The structural property doing the heavy lifting:
because each entry commits to its predecessor, a valid head signature transitively commits to
the entire chain. Entries carry their own append-time signatures for per-item accountability;
the continuously re-signed head provides the living attestation — which is what makes **key
rotation survivable**: after rotation, the new working key re-signs the head, and the chain
it commits to stays accepted. A source's history does not orphan when its keys change — the
#1401 wedge class, kept closed here too.

### 10.2 Trust-policy integration

Trust-policy documents gain a namespaced purpose: **discovery source selection**. A policy
names the projection sources a consumer follows — source identity, head endpoint, mirror set,
expected freshness, per-source scope (record kinds, substrate) — and the required response to
equivocation (stop treating as live; retain evidence). The purpose entry's schema is defined
by *this* protocol and rides the policy document's namespaced-purpose extension mechanism as
structured configuration: the policy document carries it; this spec defines it. Author
sources need no enrollment:
their records verify individually. Restricting *which requesters an operator works for* is an
operator filter (the profiles design's community boundary), not a protocol gate.

**Head exchange (split-view mitigation).** Consumers SHOULD exchange observed head tuples
`(origin, sequence, entry digest, issuedAt)` — with peers, with independent mirrors, or with
a dumb head-archive endpoint — and sources under the marketplace profile SHOULD publish their
heads to at least two independently operated mirrors. Two observed heads for one origin that
violate the §5.3 fork rule are equivocation evidence regardless of who collected them. This
is the zero-infrastructure half-step toward the witness follow-up (§22); §14.1 names what it
does not guarantee.

### 10.3 Named verification: `source-chain-verification`

Accepting a synced source means, in order:

1. resolve the source's working keys via the trust layer, under the discovery signing scope
   (§5.5);
2. verify the head's DSSE signature **against a key that is currently valid at verification
   time** — a head signed by a rotated-out, expired, or revoked key MUST be rejected
   regardless of any timestamp embedded anywhere. Entries, by contrast, are accepted through
   the current head's chain commitment (their append-time signatures are corroborating
   accountability, not the acceptance path) — this asymmetry is exactly what makes rotation
   survivable (§10.1) while denying a compromised *old* key the power to vouch a competing
   head or resurrect history;
3. verify the head's `refreshBy` freshness and `issuedAt` monotonicity against any
   previously seen head;
4. verify chain linkage from the head's entry digest back to the consumer's high-water mark —
   or, on first adoption of the source, to genesis (§5.3 rule 5);
5. verify entry signatures (published-source profile) as *corroboration*: an entry
   signature verifies against a key that held the discovery scope for the source's agent
   **at any time** — rotation never orphans history, per §10.1. A missing entry signature
   under the published profile is `broken-chain`; a signature by a key *never* bound to the
   agent is `unauthorized-signer`;
6. check sequence contiguity (increment-by-one, §5.1) and fork-absence;
7. advance the high-water mark.

Failures are typed, not boolean: `stale` (refreshBy expired), `forked` (equivocation —
evidence-bearing), `broken-chain` (linkage, contiguity, or duplicate-`announcementId`
failure), `unauthorized-signer` (including the old-key head case).

### 10.4 Named verification: item verification

A consumer holding one item from query or subscribe:

1. fetch the record bytes by digest and re-hash (`content-corruption` on mismatch);
2. `facts-consistency` — recompute the facts card from the bytes per the kind's facts
   profile; outcomes `consistent` / `inconsistent` / `indeterminate` per §5.4, decision-grade
   use failing closed on anything but `consistent`; a mismatch is a signed false statement by
   the source;
3. **verify the cited provenance** — REQUIRED before any decision-grade or attribution use:
   fetch the cited entry by digest, verify its signature and that its `announcements[]`
   contains this `announcementId` for this record, and confirm the entry lies on the cited
   source's verified chain (reachable under a head that passed §10.3, at or below the
   consumer's high-water mark). Without this step, "provenance" is only a query service's
   claim — a malicious service citing a trusted source it never synced is caught here and
   nowhere else;
4. for projected items, `derivation-consistency` — check the derivation annotation against
   the substrate; REQUIRED for decision-grade use per §6.2, optional spot-check otherwise;
5. hand off to the record's own protocol for content verification (DSSE on the record,
   evidence checks, profile checks — not discovery's business).

Discovery verifies *distribution*; the record protocols verify *content*.

## 11. Evidence-layer crosswalk

The in-flight evidence discovery contracts (PR train #2151–#2154 and the journal sibling) map
field-for-field into this protocol. Nothing in those frozen contracts changes.

| Evidence layer (frozen) | Record Discovery Protocol |
| --- | --- |
| `available` announcement `{sourceId, announcementId, reference{family, digest}, publishedLocation}` | Announcement item, `action: available`; `family` → record-kind URI (§12); `reference` → `record`; `publishedLocation` → `locations[]` |
| `withdrawn {retractsAnnouncementId}` | `action: withdrawn, retracts` — same same-source-only rule; the `reason` code is additive at publication time |
| `repositoryId` (which local repository instance) | Stays local, never published — the three-identity separation (what-bytes / which-repo / published-location) carries over intact |
| Journal entry `{revision, predecessorDigest, announcement}` | A single-item **unpublished** entry; `revision` → `sequence`, `predecessorDigest` → `previous` |
| Journal cursor `{sourceId, revision, entryDigest}` | The source position cursor `(sequence, entry digest)` |
| `EvidenceRecordAnnouncementSource.read({after})` | The chain-walk sync interface |
| Indexer → catalog | A query-plane implementation scoped to evidence record kinds |
| Checkpoint store | Consumer high-water-mark persistence |
| No signing; no subscriptions | Exactly what "unpublished source" leaves room for: the published-source profile (§5.5) and subscribe plane (§9) are additive |

Stated normatively: **the frozen contracts are conforming under a defined, mechanical
projection** — the table above is that projection's field map, and the wrapper that publishes
a journal *transforms* entries into the discovery entry shape; it does not sign journal bytes
as-is. The projection is pinned:

- journal `revision` maps affinely onto the fixed-width `sequence` such that the first
  projected entry is `0000000000000001` and increments by one (the wrapper records its
  offset once, at wrap time);
- the single `announcement` becomes a one-item `announcements[]`; `predecessorDigest` →
  `previous` over the re-sealed projected chain;
- evidence-layer withdrawals project with reason `delisted` — the layer has no substrate and
  never emits `reorged`;
- a catalog qualifies as a query-plane instance when it retains and serves the §8 provenance
  triple (source, entry digest, announcementId): the frozen `(sourceId, announcementId)`
  observation key supplies two of the three; the wrapper era adds the entry digest.

Zero changes to the frozen contracts: the journal remains the system of record, and the
published wrapper is a deterministic projection maintaining its own chain, head, and
signatures.

## 12. Record kinds and facts profiles

A **record-kind URI** names a sealed record family defined elsewhere in the stack. v1 kinds
(exact URI strings settle at implementation, same as package names):

| Kind | Defined by | Facts profile defined by (housed in `discovery/facts/*` leaves, per below) |
| --- | --- | --- |
| Task | TEP §7 | task-execution profiles package |
| Submission | TEP §8 | task-execution profiles package (the operator-filter card: Task digest, profile URI, requester IRI, deadline, terms) |
| Delivery | TEP §11 | task-execution profiles package (Task digest, Attempt URI, outcome) |
| Execution Evidence / Result Evaluation / Execution Verification | Evidence Protocol §6–§8 | evidence packages (projection fields already frozen in the catalog contracts) |
| Key-binding statement / authorization / trust policy | Trust layer §7–§9 | trust packages |
| Profile documents, evaluation specifications, plugin and checkpoint artifacts | profiles design | their defining packages |

The **facts-profile contract** is owned by the discovery protocol package; per-kind facts
profiles are small **leaf packages** (working names: `discovery/facts/*`, one per record-kind
tree) that depend on both `discovery/protocol` and the kind's defining tree. The leaf carries
both edges, which keeps every frozen dependency declaration true in both directions:
discovery never imports a record-defining package, and no record protocol's core package
imports discovery — §1's one-way arrow and the profiles design's §14 package rules survive
unamended. Facts profiles are sealed, digest-pinned documents like every profile in the
stack. Each labels every field record-fact or substrate-fact (§5.4), MUST name its
reference-bearing fields (the relation `referrers` inverts, §8), and, for each field liftable
into CloudEvents extension attributes (§9.1), declares the attribute name (conforming to
CloudEvents attribute-naming rules) and a permitted scalar type.

Unknown kinds are not errors: a consumer skips announcements for kinds it has no profile
for. This is what lets new record kinds deploy without touching the protocol.

## 13. Data flows

### 13.1 Operator find-work, end to end

Trust policy names the marketplace projector; operator filters (profile URI, requester IRIs,
terms) compile to subscription filters. An `available` **Submission** item arrives (§6.3) →
filter on the facts card → fetch the Submission and Task bytes by digest, re-hash →
`facts-consistency` over the record facts → profile checks (supported profile, acceptable
run pinning) → claim through the marketplace binding, where the on-chain claim gate still
stands — which is also what makes the card's substrate facts (terms, window) safe to use as
filter-only signals → engage. Structurally the same steps the daemon
performs today — pre-filter, hydrate, verify, re-gate on-chain — with one substitution: the
pre-filter runs over signed portable records instead of a bespoke trusted GraphQL surface.
(Find-work filtering is not decision-grade in the §5.3 sense — the claim gate is the
decision — so shallow mode suffices for this flow; attribution-bearing flows do not get that
discount.)

### 13.2 Evaluator find-deliveries

Subscribe to the projector's Delivery announcements filtered on the profiles and tasks the
evaluator serves. Item arrives with facts = Task digest, deterministic Attempt URI, outcome,
plus derivation annotations → fetch and verify the Delivery → verify entry provenance and
`derivation-consistency` (the evaluator's verdict is decision-grade downstream) → pull
evidence records per the sealed evaluation specification → run the evaluation-task flow from
the profiles design. #2044's task–attempt–verdict join, portable and per-item verifiable.

### 13.3 Cold start

A fresh consumer: policy names the source → well-known document → fetch the head from
**every reachable mirror in the policy's mirror set**, take the highest valid
`(sequence, issuedAt)` → `source-chain-verification`, including the first-adoption
to-genesis walk before any decision-grade use (§5.3 rule 5; shallow mode available
immediately for liveness and filtering) → build the local view → subscribe from there. No
trusted snapshot, no blessed endpoint — any mirror serves the pages, and the mirror-set
comparison is what a brand-new consumer has in place of a high-water mark (§5.2).

### 13.4 Outage

If a relay or query service dies, the consumer steps down a ladder that never ends in a
trust decision: another mirror of the same static pages → walking the source chain directly →
for the marketplace, running the derivation itself over RPC (today's on-chain floor,
understood as self-projection). The outage-*visibility* lesson survives intact: the source's
own liveness signal is its `refreshBy`-bounded head — a stale source is surfaced loudly, and
whether to fall back to self-derivation stays an explicit policy choice, never a silent
fall-through (the 2026-05-23 rule, generalized).

### 13.5 Third-party backend appears

A new backend publishes an author source for its open Submissions (§6.1): well-known
document, head, chain, archive pages — static files plus a signing key bound via the trust
layer. An operator adds one policy entry and its existing filters apply unchanged. No Jinn
infrastructure, chain, or indexer is involved. This is the multi-backend goal exercised with
zero new protocol.

### 13.6 Misbehaving source

A false facts card fails `facts-consistency` after fetch — and the source has published a
signed false statement, retained as misbehavior evidence. A fork yields the typed `forked`
outcome — stop treating as live, keep both branches (both signed; the equivocation is
provable). A withholding projector is caught by substrate spot-checks or a second projector —
unions of verified items are always safe.

## 14. Security considerations

| Threat | Answer |
| --- | --- |
| Forged record content | Impossible past fetch: digest re-hash on every fetch |
| Forged announcements | DSSE over sealed entries; keys resolved via trust-layer bindings |
| Forged provenance (query service cites a source it never synced) | §10.4 step 3: entry fetched, signature-verified, chain-membership-confirmed before decision-grade use |
| Rollback (mirror serves an old head) | High-water mark for returning consumers; mirror-set comparison + `issuedAt` preference for cold consumers; residual window = `refreshBy`, bounded by the published-source profile (§14.1) |
| Equivocation (forked chain, duplicate heads) | Provable from signed artifacts whenever branches meet; gap-free sequences leave no benign fork reading; head exchange (§10.2) creates meeting points; guaranteed detection is the tlog follow-up (§14.1) |
| Old-key attack (compromised rotated-out key signs a head) | §10.3 step 2: head signer must be currently valid; old keys cannot vouch heads, and entries never need re-vouching |
| Evidence suppression via withdrawal | §5.1: withdrawal never invalidates; retrospective kinds immune to pruning except `reorged`; reason codes make correction distinguishable from delisting |
| Source withholding | Visible staleness (`refreshBy`); projector completeness spot-checkable against the substrate; N projectors |
| Relay withholding | Normative head-vs-delivered comparison + entry-granular spot-checks (§9.5); direct chain walk always open |
| False facts cards | `facts-consistency` with typed `indeterminate`; decision-grade fails closed; failure = signed misbehavior evidence |
| Fabricated projections (event never happened) | `derivation-consistency` mandatory for decision-grade use (§6.2); the substrate, not the projector, is truth |
| Spam and fetch amplification | Announcements confer no validity; projection sources are policy-selected; per-source fetch budgets and ping debouncing are normative consumer obligations (§7); entry/page ceilings (§5.1); per-source signed accountability |
| Malicious locations (SSRF, oversized blobs) | §7: size ceilings, content-type checks, private-address guards; digest re-hash is the only accepted outcome |
| Secrets leakage | The evidence layer's rule generalized: no secrets, paths, tokens, or credentials in announcements or locations; access-classified records announce existence only, with facts derived from public bytes exclusively (§5.4) |
| Consumer interest leakage | Server-side filters reveal operator interests; local filtering over synced chains is the privacy-preserving default for sensitive filters (§8); reader-privacy techniques are the follow-up |
| Cross-source replay | Items cite their entry and source; §10.4 step 3 verifies the citation; a source cannot re-present another's items as its own |
| Chain reorg (projection sources) | Declared confirmation depth in source metadata; explicit append-only `reorged` corrections; consumer recompute obligation |
| Malicious well-known / ping injection | Pings are unauthenticated hints that only trigger rate-limited pulls; the well-known document introduces sources, but acceptance is policy + `source-chain-verification`, never introduction |

### 14.1 Residual limitations (named honestly)

- **Split-view equivocation is not guaranteed-detected in v1.** A source serving disjoint
  forks to disjoint consumer populations is caught only when two observations of its heads
  meet — which the §10.2 head exchange makes likely, not certain. For marketplace projection
  sources the substrate bounds the harm (omissions and fabrications are checkable against
  the chain); for author sources it does not. Guaranteed detection is precisely the
  transparency-log + witness follow-up (§22).
- **Cold-start rollback exposure equals the `refreshBy` window.** A consumer with no
  high-water mark can be held on an old-but-fresh head for at most `refreshBy`; the
  published-source profile bounds that window, and the mirror-set comparison shrinks it in
  practice, but only a witness/gossip anchor eliminates it.
- **Listing completeness is a claim everywhere.** No query or subscribe response proves
  nothing was omitted; only the substrate (for projections), multi-source comparison, and
  ultimately the tlog upgrade give completeness. Decision-grade consumers are therefore
  required to verify *items* (§10.4) and forbidden from treating *sets* as facts.
- **First-adoption genesis walks are O(chain length).** Bounded, page-batched, one-time per
  source — and eliminated only by inclusion proofs (§22).

## 15. Serialization and versioning

Identical discipline to the rest of the stack: I-JSON documents; JCS canonicalization exactly
once at sealing, exact bytes forever after; sha256-over-exact-bytes identity in the
`sha256:<hex>` grammar; DSSE for every signature; CloudEvents structured JSON on the wire for
streams; media types in the `vnd.jinn.record-discovery.*` vendor tree (registration is a
stack-wide follow-up). The `protocol` field carries a version URI with an unversioned family
root, per the profiles design's convention. Additive evolution: unknown fields in heads and
entries are ignored by consumers (enabling later inclusion proofs and witness data); unknown
record kinds and unknown facts-profile fields are skipped, never errors.

## 16. Frozen interfaces

Frozen at this design's granularity (signatures refined at implementation):

1. The three-plane separation and the announce plane's monopoly on trust (§4.1).
2. The Announcement Entry field set and semantics (§5.1) — source tuple with pinned name
   grammar, gap-free increment-by-one sequence with pinned genesis, `previous` linkage,
   `announcements[]` items with `available`/`withdrawn`, mandatory withdrawal reason codes,
   same-source retraction of `available` only, source-wide `announcementId` uniqueness.
3. The Source Head field set (§5.2) — `{origin, sequence, entry, issuedAt, refreshBy}`,
   pinned origin grammar, DSSE carrier, checkpoint-note field compatibility (the note-text
   projection itself is a §22 follow-up), profile-bounded `refreshBy`.
4. Chain rules (§5.3) — fork definition with no benign reading, linkage-depth obligations
   (high-water mark / genesis-once / shallow-mode demotion), the source cursor tuple
   `(sequence, entry digest)`.
5. The facts-card rules (§5.4): profile-defined, two fact classes (record facts
   recomputable, substrate facts projection-only and derivation-covered), public-bytes-only
   for access-classified kinds, `facts-consistency` with typed `indeterminate` and
   decision-grade fail-closed.
6. The published-source profile boundary (§5.5): unpublished chains unsigned-conformant,
   published chains DSSE-signed.
7. Source classes (§6): derivation annotations on projections; `derivation-consistency`
   mandatory for decision-grade use of projected items.
8. Serving-plane object set (§7): records-by-digest, archive pages, heads, well-known
   document with in-protocol schema, unauthenticated debounced pings, location-fetch guards.
9. Query-plane rules (§8): mandatory per-item provenance, `complete` + per-source freshness,
   no origination, no ranking.
10. The subscribe cursor contract, relay-local cursor declaration, the announcement dedupe
    key, and the two relay cross-check obligations (§9.3, §9.5).
11. The named verification procedures and their typed outcomes (§10.3, §10.4) — including
    the head-signer current-validity rule and mandatory entry-provenance verification for
    decision-grade use.
12. The evidence-layer crosswalk commitments (§11): frozen contracts unchanged; unpublished
    journal conformant.

## 17. Packages

Discovery is cross-protocol — it distributes TEP, Evidence, and trust records alike — so it
lives beside the other protocol trees, not under any of them (scope names are working titles,
settled at implementation planning like the rest of the stack's):

```text
packages/discovery/
  protocol/    sealed shapes (entry, head, item), chain rules, named verifications,
               facts-profile contract, record-kind grammar, CloudEvents envelope
               mappings for the subscribe plane
               depends on: trust core ONLY — sealing is re-implemented per the
               trust-layer precedent, with cross-package sealing-equivalence fixtures
               (a shared sealing package is a possible later stack-wide refactor);
               kind-agnostic, never imports a record-defining package
  facts/*      per-kind facts-profile leaf packages (§12) — each depends on
               protocol + exactly one record-kind tree; the only place both edges meet
  serve/       published-source toolkit: layout writer, head maintenance, archive pager
  client/      chain-walk sync, high-water-mark store, query/subscribe clients,
               verification driver
  testing/     conformance kit (§18) — built before any real implementation
``` The **marketplace projector is an application of
the protocol**, living in the marketplace tree beside the binding — the same reasoning as the
binding itself. The evidence journal/catalog stay exactly where they are, as the conforming
unpublished instance. Extraction-ready discipline applies as everywhere in the stack: no
imports from application trees, no chain or IPFS dependencies in `protocol`.

## 18. Conformance

The kit precedes all real implementations (the CSI discipline, again):

- **Golden vectors:** valid chains; forked chains (including fork-at-shared-`previous`);
  broken linkage; sequence gaps and duplicates (must reject); duplicate `announcementId`
  (must reject); stale heads; rolled-back heads; `issuedAt` regressions; a competing head
  signed by a rotated-out key (must reject); entries with bad facts cards; facts requiring
  unavailable referenced bytes (must yield `indeterminate` and fail closed at decision
  grade); genesis edge cases (pinned first sequence, `previous: null` uniqueness);
  withdrawal of foreign announcements, withdrawal-of-withdrawal, and missing reason codes
  (all must reject); re-announcement after withdrawal (must accept); unknown kinds and
  unknown fields (must skip, not error); oversized entries and pages (must reject under the
  published-source profile, `broken-chain` onward); an envelope signed under the wrong
  trust-layer scope (must fail `unauthorized-signer`); substrate facts in an author-source
  announcement (must reject).
- **Source conformance:** published (signed) and unpublished profiles; correction-by-append
  with `reorged` reasons; head freshness and `issuedAt` monotonicity maintenance;
  `refreshBy` within profile bounds.
- **Query-plane conformance:** provenance on every item; fabricated-provenance detection via
  §10.4 step 3; `complete` honesty (empty-vs-truncated); cursor determinism with digest
  tie-break; no origination.
- **Subscribe conformance:** the five cursor cases; declared replay window; relay-local
  cursor declaration; announcement dedupe key; observation pass-through without alteration;
  the per-item-drop censoring relay (must be caught by the entry-granular spot-check).
- **Consumer conformance:** ping-flood debounce (pull rate stays at the consumer's
  configured ceiling); hostile-locator guards (oversize, wrong content type,
  private-address); head-vs-delivered relay divergence (must downgrade the relay);
  cold-start mirror disagreement (must take the highest valid `(sequence, issuedAt)`);
  withdrawal of a retrospective-kind item (must not prune the decision store); `reorged`
  withdrawal (must trigger recompute).
- **Named checks in isolation:** `source-chain-verification` outcomes (`stale`, `forked`,
  `broken-chain`, `unauthorized-signer`), `facts-consistency` (all three outcomes),
  `derivation-consistency` (present, fabricated, reorged-away).

## 19. Declared impact

Impact only; migration mechanics are a separate spec.

- **The Ponder indexer** becomes projector #1 plus a query-plane implementation. Its bespoke
  GraphQL surface is eventually superseded; the explorer becomes a query-plane consumer.
- **The client's `DiscoveryAPI`** (15 methods) maps onto `search` + `referrers` + subscribe
  via `discovery/client`; the on-chain floor is re-homed as self-projection; the four
  fail-closed empties (verdict tallies, instance-success counts, code-digest rewards, plugin
  scores) become verifiable aggregations under the §10.4 obligations.
- **Operator configuration:** `joinedSolverNets` gives way to sources + filters — the same
  operator-app rewrite the profiles design already declared (its AC 4).
- **The in-flight evidence PR train** is untouched; publishing evidence across trust
  boundaries later adds the published-source wrapper.
- **Backlog issues** #2044, #2045, #2120, #2116, #2175 are structurally addressed and can
  retarget their implementations to this layer.

## 20. Sequence

Design-level ordering; each stage independently testable; nothing gates on the evidence PR
train:

1. `discovery/protocol` + conformance kit;
2. `discovery/client` sync and verification;
3. the marketplace projector (in parallel: the evidence published-source wrapper);
4. query plane over the projector;
5. subscribe plane;
6. daemon consumption swap.

## 21. Explicit non-goals

The Record Discovery Protocol does not define: search relevance, ranking, or recommendation
(#1058 stays an application design); reputation; transparency logs, inclusion proofs, or
witness networks (the upgrade path is reserved via head field-compatibility, not built);
settlement or payment; any canonical hosted service; a global source registry; observation
archival (follow-up); record validity or evaluation semantics (the record protocols' job);
access control to record content (capability grants and access classes live in TEP and the
profiles design); and it never replaces the backend contract's `observe`/`watch` — engaged
parties keep their direct verbs.

## 22. Non-blocking follow-ups

- **Transparency-log + witness profile:** a tlog-tiles log over head digests, inclusion
  proofs as additive head/descriptor annotations, C2SP witness cosigning; enabled per
  consumer by a trust-policy bit. Closes the §14.1 split-view and cold-start residuals and
  eliminates first-adoption genesis walks. The §10.2 head exchange is the zero-cost interim.
  Includes pinning the head → C2SP signed-note text projection (§5.2 freezes field
  compatibility; the note serialization lands here, with the witness work that consumes it).
- **Reader privacy for server-side lookup** (IPNI-style double-hashed queries), and
  examination of rotating discovery identities for requesters whose IRI linkage across
  announcements is itself sensitive.
- **Observation-archive record kind:** sealed archives of attempt observation logs,
  announceable like any record.
- **Source registry / federation conventions:** discovering sources themselves at scale;
  today's answer is trust policy + well-known.
- **IPFS and filesystem serving profiles** over the same layout grammar.
- **Facts-profile registry governance:** who may define facts profiles for shared kinds.
- **Push-subscription hardening:** rate limits, sink authentication postures beyond the
  challenge-echo handshake.
- **Media-type registration** with IANA (stack-wide follow-up shared with TEP).

## Appendix: sources

External standards: IPNI spec (ipni/specs) and reader-privacy addendum; C2SP tlog-checkpoint,
tlog-cosignature, tlog-witness, tlog-mirror; RFC 9162 (CT v2); Sigstore Rekor v2 (tlog-tiles,
Tessera); RFC 5005 (Feed Paging and Archiving); RFC 8288 (Web Linking); OCI Distribution spec
v1.1 + Referrers API; CNCF CloudEvents 1.0 + Subscriptions API (0.1-wip) + xRegistry; W3C
WebSub; AT Protocol sync and event-stream specs (sync v1.1 relay model, Jetstream, Tap); TUF
specification (freshness/anti-rollback semantics, via the trust layer's adoption).

Internal: the four companion designs listed in the header;
`spec/2026-05-11-discovery-api-and-shared-indexer.md`; `client/src/discovery/` (types, http,
onchain, with-fallback, factory) and its consumers (`client/src/adapters/mech/adapter.ts`,
`client/src/solvernets/registry-client-erc8004.ts`, `client/src/api/discovery-endpoint.ts`,
`client/src/solver-types/swe-rebench-v2.ts`, `client/src/learner/verification-gate.ts`);
`packages/indexer/` (ponder.config.ts, ponder.schema.ts, handlers, explorer API); the
evidence discovery PR train #2150–#2154 and the announcement-journal sibling (#2159); issues
#2044, #2045, #2120, #2116, #2175, #1058; decision records DR-2026-06-30 (tokenless,
OLAS-native) and DR-2026-04-30 (knowledge-market framing).
