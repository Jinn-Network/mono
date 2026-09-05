# Publication Head Anchoring for the Announcement Chain

| | |
|---|---|
| **Version** | 0.2 |
| **Date** | 2026-09-01 (v0.1); 2026-09-05 (v0.2 applies the operator ruling) |
| **Shape** | `design` |
| **Status** | adopted — operator ruling 2026-09-05; §10's four decisions D1–D4 are closed as recommended ([PR #3476 comment 5554840223](https://github.com/Jinn-Network/mono/pull/3476#issuecomment-5554840223)) |
| **Issue** | [#3400](https://github.com/Jinn-Network/mono/issues/3400) |
| **Executes** | [neutral freeze-announcement surface](./2026-08-29-neutral-freeze-announcement-surface.md) §8 and §10 item 3, including its two open questions |
| **Depends on** | [pluggable integrity providers / anchor evidence](./2026-08-17-pluggable-integrity-providers-design.md) §5, §6.1–§6.4, §7.1–§7.4; [record discovery](../plans/2026-07-28-record-discovery.md) §5.1–§5.3, §5.5, §7; [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md) §9.3 |
| **Outcome** | both open questions settled, one mechanism specified, four decisions ruled by the product owner, and an explicit statement of the ceiling this buys |
| **v0.2 changes** | Ruling erratum only. §10 flips from four open decisions to four operator rulings; the D3 skew allowance becomes configurable in §4.4 and §7; §5.3 records that the bundle does not cite `(origin, sequence)` in v1; §11 is released for filing at low priority. **The design itself (§0–§9) is otherwise unchanged**, and no analysis is rewritten. |

## 0. Decision in plain language

The neutral-freeze design closed #2869 with two refusals and one residual. The
residual is that the publisher's announcement chain — hash-linked, sequenced,
DSSE-signed, and hosted entirely by the publisher — has every transparency-log
property except a witness. Nothing outside the workspace has ever observed it, so
the publisher can truncate or fork it and no reader who had not previously fetched
the old head can tell.

§8 proposed the cheap standards-shaped answer: witness the head rather than each
lock, so one anchor amortizes across every announcement beneath it. It left two
questions open, and this design answers both.

**The anchored subject is the announcement entry, not the head document.** The head
is deliberately mutable and the protocol obligates a live source to re-sign it on an
idle timer (`refreshHead`, and the published-source `refreshBy` window that makes an
expired head a withholding signal). Anchoring the head document would therefore mint
an anchor every refresh period that commits to no new chain content, while anchoring
the entry the head cites moves exactly when the chain moves. §4 settles this against
the tree.

**The anchor is announced on the chain, not carried in the bundle.** An anchor over
entry `N` is sealed as an ordinary `AnchorEvidence` record and announced in entry
`N+1`, with a stopping rule so the regress terminates. This needs no new serving
surface, no new mutable signed document, and no index: the chain already serves
records by digest and already describes what it announced. Nothing enters the
per-run bundle closure, so `RunState.anchors`, `deriveClaimAnchors`, the claim
`anchors` section, and the `integrity-anchors` check are untouched, and the
standalone verifier keeps its offline property. §5 settles this.

**What it buys, stated at its ceiling.** A reader who holds an anchored entry digest
at sequence `N` can refuse any later chain the publisher offers that does not contain
it. That is all. It does not prove publication-by-time, does not make the stream
provably complete, and does not make the source witnessed. It converts silent
revision into revision that is detectable by anyone who looked earlier. §6 states the
ceiling and §9 states when to stop approximating and build the reserved
transparency-log class instead.

**It stays optional and non-blocking**, exactly as §8 filed it. Acquisition failure
never blocks an append; a missing anchor is a visible gap in an otherwise anchored
prefix, not a silent one.

## 1. What §8 asked

> **Add a third `runAnchor` subject: the publication source head.** Anchor the digest
> of the sealed head document (or of the entry it names) through the same provider
> seam that already ships. One anchor per head advance, not per lock […]
>
> Two open questions a future design must settle rather than assume […]
>
> 1. **Cadence and window.** Every existing subject anchors at most once and closes at
>    `report`. A head anchors repeatedly and has no natural close, so the write-once
>    invariant in `RunState.anchors` does not transfer unchanged.
> 2. **Where it is carried.** A head anchor is a fact about the publisher's source, not
>    about one run. Carrying it in every bundle would put an unbounded, run-independent
>    series into a per-run closure. It more likely belongs beside the served head in the
>    public archive, with the bundle citing it — which is a different carriage question
>    from the one §7.4 answers.

Question 1 turns out to have a prior question inside it — *what exactly is the
subject* — and answering that one first dissolves most of the cadence difficulty.
§4 takes them in that order.

## 2. Ground truth

Every claim here resolves to a path in this repository.

**The chain.** `AnnouncementEntry` (`packages/discovery/protocol/src/entry.ts`)
carries `{protocol, source, sequence, previous, timestamp, announcements[]}`. The
`sequence` is a fixed-width 16-digit decimal, gap-free and increment-by-one from
`GENESIS_SEQUENCE`; `previous` is the predecessor entry's `sha256:` digest and is
`null` exactly at genesis, a coupling `parseAnnouncementEntry` enforces in both
directions. So an entry commits transitively to its whole prefix.

**Entry identity.** An entry's digest is `recordDigest(sealJson(entry).bytes)` —
canonical I-JSON sealed once, hashed once (`source-writer.ts:740`,
`protocol/src/hashing.ts`). It is the same value the head cites and the same value
`previous` cites, so there is exactly one digest per entry and no second spelling.

**Entries are individually signed.** Archive pages pair each entry with its own
append-time DSSE envelope (`packages/discovery/serve/src/archive.ts`, `SignedEntry`);
under the published-source profile the signature is present. Accountability for an
entry therefore already exists in the entry's own bytes — an anchor over an entry adds
*time*, not authorship, which is the cleanest possible division of labour between the
two mechanisms.

**The head is mutable by design.** `SourceHead` (`protocol/src/head.ts`) is
`{protocol, origin, sequence, entry, issuedAt, refreshBy}`, DSSE-signed, one per
source, served at `/sources/<name>/head`. `refreshHead`
(`packages/discovery/serve/src/head.ts:60`) produces the next head **for the same
source position** — `sequence` and `entry` unchanged, `issuedAt` strictly increased,
`refreshBy` re-based and clamped to `MAX_REFRESH_BY_AHEAD_MS`. `maintainHead` re-signs
and writes it "even when nothing new was announced […] the live-source obligation that
makes an expired `refreshBy` a meaningful withholding signal."

**Today the Colophon source only advances on append.** Every in-tree `maintainHead`
call site (`marketplace/projector/src/announce.ts`, `finality.ts`,
`discovery/sources/evidence-journal/src/publish.ts`) runs after appending entries, and
the Colophon publication source
(`packages/benchmark-product/core/src/run/publication-source.ts`) writes its head
through `createDurableSourceWriter`'s append path. #2549 records this precisely and
calls the idle re-stamp hazard **dormant** — "Nothing in the tree re-stamps an idle
head. The hazard materializes the moment someone adds a serve-side idle-freshness
timer — which the `head.ts` primitives explicitly exist to support."

That dormancy is a scheduling accident, not a property. #3468 (open) describes the
same re-sign as the expected steady state of a live source and shows both consumers
currently refusing it; #3467 (open) shows the `refreshBy` ceiling unenforced on the
read side. The head-freshness family is unfinished work, and a design that binds its
subject to the head document would be binding to the least settled object in the
system. §4.1 does not.

**The anchor machinery.** `AnchorEvidence` (`packages/trust/core/src/anchor-evidence.ts`)
is sealed-not-signed, strict-schema, and carries exactly one subject — `{kind, digest}`
where `kind` is an absolute URI that verification requires to equal the resolved
record's actual kind, and `digest` is bare 64-hex `sha256`. Proof content is inline
base64, capped at 64 KiB decoded. Two profiles are producible
(`core/src/anchor/profiles.ts`): `rfc3161-tsa/v1` and `opentimestamps/v1`, the latter
alone upgradeable. `runAnchor` (`core/src/operations/run-anchor.ts`) resolves
configuration, resolves a subject, verifies before storing, enforces write-once per
`(subject, provider)` with the single OTS upgrade exception, and re-reads every fence
after its network round trip.

**Neither producible provider needs a key or funds.** That is the property §3.3 of the
neutral-freeze design called decisive, and it is why this design creates no custody
obligation at all.

## 3. The threat this addresses, and the one it does not

| Claim | Addressed here? |
|---|---|
| Existence-by-time of a lock digest | already shipped; untouched |
| Publication-by-time | no, and not by any anchor (neutral-freeze §7.1) |
| **Stream integrity — the publisher has not truncated, reordered, or forked its own chain** | **yes, partially: detectable to prior observers** |
| Stream completeness — the publisher announced everything it should have | no |
| Freshness / withholding detection | no; that is `refreshBy` and #3467 |

The residual is asymmetric in a way worth stating plainly, because it is what makes a
cheap mechanism worth having. A publisher who forks its chain must produce a fork that
is *internally* valid — correct linkage, correct sequence, correct signatures — which
it can always do, since it holds the key. What it cannot do is produce a fork that
contains an entry digest a third party dated, when that entry is not on the fork. So
the anchor does not defend the chain; it defends the *reader who looked*. Every reader
who fetched and recorded an anchored entry holds an independent tripwire, and the
publisher cannot know which readers hold which.

That is the whole of the property. It is strictly weaker than a witnessed log, where
the witnesses are known, cosign on a schedule, and protect readers who never looked. §9
says when the weaker thing stops being enough.

## 4. Open question 1 — subject, cadence, and window

### 4.1 The subject is the entry, not the head document

§8 offered the choice parenthetically ("the sealed head document (or of the entry it
names)"). It is not a coin flip; the two behave differently under the protocol's own
obligations.

**Anchor the announcement entry the head cites.**

- **The head changes without the chain changing.** `refreshHead` re-issues at the same
  `sequence` and the same `entry` with a new `issuedAt` and `refreshBy`. Under the
  published-source profile a live source is obliged to do this on a timer. So a head
  anchor's natural cadence is the *refresh* period, not the *advance* period, and each
  such anchor would commit to chain content already committed to by the previous one.
  §8's own phrase — "one anchor per head advance" — is unimplementable against the head
  document, because the head document advances for two different reasons and only one of
  them is an advance.
- **The entry is immutable and already digest-addressed.** It is the object `previous`
  links, the object the head cites, and the object whose digest the writer computes once
  (`source-writer.ts:740`). There is exactly one digest per entry, so "anchor the entry"
  has one meaning.
- **The entry commits to the prefix; the head commits to nothing extra.** `head.entry`
  *is* the entry digest. An anchor over the head document therefore proves the same
  chain content as an anchor over the entry, plus two fields (`issuedAt`, `refreshBy`)
  the publisher wrote about itself and which no reader should be treating as evidence
  anyway. The extra surface buys nothing and costs the mutability above.
- **The entry carries its own signature; the head's signature is not needed for this.**
  An anchored entry, fetched from an archive page, is self-authenticating
  (`SignedEntry.signature`) and third-party-dated (the anchor). A reader can check both
  without ever trusting the current head — which is the point, since the current head is
  precisely the object under suspicion.
- **It is stable across the open head-freshness work.** #2549, #3467, and #3468 are all
  live questions about what a head means to a consumer. Nothing in them can change what
  an entry digest means.

**Ruling.** `subject: "announcement-entry"`, digest `head.entry` with the `sha256:`
prefix stripped, resolved at the moment of anchoring from the source's own committed
position rather than from a re-read of the served head.

**Rejected alternative — anchor the head document.** Rejected for the mutability and
cadence reasons above. It has one genuine advantage worth recording: a head anchor
would date the publisher's *assertion* that entry `N` was its tip, where an entry anchor
dates only the entry's existence. A publisher could therefore hold an entry privately,
anchor it, and only later announce it as the tip. That gap is real — and it is the
publication-by-time claim, which §3 already states no anchor can close. Paying the
mutability cost to half-close a claim we do not make is not a trade worth taking.

### 4.2 `subject.kind`

`AnchorSubjectSchema` requires an absolute URI, and the anchor-evidence design's §8 step
2 makes it normative: verification requires it to equal the resolved record's actual
kind. An announcement entry has no record-kind URI today — it carries
`protocol: "https://spec.jinn.network/record-discovery/v1"` and travels under the media
type `application/vnd.jinn.record-discovery.entry.v1+json`.

**Ruling.** Mint one record-kind URI,
`https://spec.jinn.network/records/announcement-entry/v1`, in the discovery protocol's
`RECORD_KINDS`. It conforms to the pinned grammar (`assertRecordKindUri`: records root,
source-name-shaped segment, major-only version), it is purely additive, and it makes
`subject.kind` normative rather than ambiguous.

**Rejected alternative — reuse `RECORD_DISCOVERY_VERSION` as the kind.** It parses, and
it needs no new identifier. It is rejected because the head document and the entry carry
the *same* `protocol` literal, so the kind field would no longer distinguish which of
the two objects a digest describes — which is the exact failure `kind` is normative to
prevent.

### 4.3 Cadence: every substantive append

The chain's own append cadence is the only cadence a reader can audit, because it is the
only one derivable from the chain. Any sampling rule ("daily", "every tenth entry",
"on publication") leaves an unanchored window whose size the reader has to be told out of
band and cannot check.

**Ruling.** Anchor **every entry that announces something other than an anchor**. For the
Colophon source that is roughly one anchor per publication registration — an entirely
negligible rate, one bounded HTTP round trip each, no key, no funds.

Two consequences follow and are load-bearing:

- **The stopping rule.** The anchor over entry `N` is itself announced (see §5), which
  creates entry `N+1`. Requiring `N+1` to be anchored too would not terminate. So an
  entry whose announcements are *all* anchor announcements is not itself anchored. It
  announces no substantive content, so a truncation that drops only such an entry drops
  nothing a reader loses.
- **Gaps are permitted and visible.** Acquisition failure never blocks an append —
  the same never-blocks rule `anchorAfterLockIfConfigured` already implements for the
  lock path. A gap therefore appears as a sequence with no anchor announcement anywhere
  later in the chain. Because sequences are gap-free and increment-by-one, a reader can
  enumerate the gap exactly rather than infer it. The property in §3 is per anchored
  entry, so a gap weakens coverage and never breaks a held tripwire.

**Rejected alternative — anchor only the entry that announces a run's publication.**
It halves the anchor count and ties the mechanism to the artifact the operator cares
about. Rejected because it re-couples a source-level fact to one run — the precise
mistake §8 filed this follow-up to avoid — and because it makes the unanchored windows
run-shaped, so a reader cannot tell an idle period from a suppressed one.

### 4.4 Window and write-once: a source-scoped ledger, not `RunState`

§8 was right that the invariant does not transfer. It does not transfer because the
*container* is wrong, not because the rule is.

`RunState.anchors` is keyed to one draft, closes at `report`, and its durable
`superRefine` invariant enforces write-once per `(subject, provider)` with the single
OTS upgrade exception (`core/src/run/state.ts`). A source is not a run: it has no
`report`, no close, and no bound on the number of subjects.

**Ruling.**

- **Container.** A source-scoped, append-only anchor ledger, keyed by
  `(entryDigest, provider)`, living beside the publication source's other durable state
  (`publicationStatePath(workspaceDir, opaqueId(sourceId), …)` is the existing home for
  exactly this class of document). `RunState` is not extended, and `RunState.anchors`
  keeps its current two subjects and its current invariant unchanged.
- **Write-once, unchanged in substance.** At most one anchor per
  `(entryDigest, provider)`, with the same single exception for an OpenTimestamps
  upgrade: the completed proof is appended as a new record naming the pending one, which
  stays. The predecessor-consumption rule that forbids a fork of upgrade edges
  (`state.ts`'s `alreadyUpgraded` set) transfers verbatim; it is the same hazard.
- **No window at all.** There is no `report` to close against, and none is invented. The
  entry is immutable and its digest is meaningful forever, so an anchor obtained a year
  late is a *weaker* anchor, not an invalid one — and unlike the run path, a late anchor
  cannot brick anything, because nothing seals a projection of it. The `assertNotReported`
  and `assertNotLaunched` fences have no analogue here and must not be transplanted.
- **The lock splice-catch does not apply, and its mirror image does.** There is no
  pre-registered `closeAt` for an entry, so `assertWithinSpliceCatch`'s rule is out of
  scope. The producer-side sanity rule that *is* in scope runs the other way: refuse an
  `authority-time` proof whose `genTime` precedes the entry's own `timestamp` by more
  than a stated skew allowance, because a publisher whose entry post-dates its own anchor
  has written a self-contradiction that would later read as stronger evidence than it is.
  Default allowance: 5 minutes. This is producer-side only; it introduces **no** verifier
  rule and no new verifier posture. Ruled kept (D3, §10), with one amendment: the
  allowance is a configured value with that default, not a constant, so an operator whose
  provider or clock discipline warrants a different figure sets it without a code change.

## 5. Open question 2 — carriage

### 5.1 Not in the bundle closure. At all.

§8's instinct is correct and this design takes it further than "more likely". The series
is unbounded and run-independent; a per-run closure that carried it would grow without
bound, would differ between two bundles published from the same run at different times,
and would make the claim-consistency byte-compare depend on facts that postdate the run.

**Ruling.** Head anchoring adds nothing to the public bundle, the claim package, or the
sealed store's per-run projection. Specifically unchanged: `RunState.anchors`,
`readRunAnchorCarriage`, `deriveClaimAnchors`, the claim `anchors` section, the
`integrity-anchors` check, the `bundleChecks` name list, and every printed venue-limits
sentence. A bundle produced before and after this ships is byte-identical.

This is the single most important boundary in the design. It is what preserves the
standalone verifier's property that a stranger checks a bundle with the bundle and
`openssl`, and it is why no verifier posture, network dependency, or trust-material
surface is introduced anywhere.

### 5.2 On the chain, announced by the next entry

**Ruling.** After appending entry `N`, the publisher obtains an anchor over `N`'s digest,
seals it as an ordinary `AnchorEvidence` record, and announces that record in the next
entry as an ordinary `available` announcement with a `record.kind` of the anchor-evidence
kind and an `https` location.

Why this shape and not a sidecar:

- **No new serving surface.** Records are already served by digest
  (`recordPath(digest)` → `/records/<digest>`); archive pages, the head, and the
  well-known document are already the entire surface. Nothing is added.
- **No new mutable document.** The head is the source's one mutable signed document and
  the design keeps it that way. A sidecar index of anchors would either be mutable —
  a second object needing its own signing, freshness, and rollback story — or immutable
  and therefore unable to accept an OpenTimestamps upgrade.
- **Nothing undiscoverable.** Putting anchor bytes at a digest-addressed path without
  announcing them makes them reachable only by someone who already knows the digest,
  which is nobody.
- **The chain describes its own anchoring.** A reader walking the archive sees, in
  sequence order, which entries were anchored and by which provider, using the same walk
  it already performs. Coverage becomes an auditable property of the chain rather than an
  operator claim about it.
- **The upgrade edge has a home.** `AnchorEvidence` stores nothing derivable and has no
  field for "upgrades", and correctly so. The announcement's `facts` field (`facts?:
  unknown`, governed by a facts profile — `protocol/src/facts-profile.ts`) is where a
  small anchor-announcement facts profile carries `{subject: {kind, digest}, provider,
  upgrades?}`. Facts are advisory metadata about an announced record, which is exactly
  what this is; the record's own bytes stay authoritative.

The cost is that the newest entry is never yet anchored, and that each substantive append
is followed by a small anchor-announcing append. Both are acceptable: the property in §3
is about the prefix, and the second append is cheap and self-terminating under §4.3's
stopping rule.

**Rejected alternative — a `/sources/<name>/anchors/…` sidecar.** Either a mutable index
(a second mutable signed surface, with its own rollback question — the very question this
design exists to answer) or per-sequence immutable blobs (which cannot accept an OTS
upgrade without being rewritten, and which are undiscoverable without an index anyway).
Rejected on both horns.

### 5.3 What the bundle may cite

A bundle may carry a **pointer**, never proof bytes and never a snapshot: the publication
source `origin` and the `sequence` at which this run's publication was announced. Both are
run-scoped facts fixed at publication time, both are single short strings, and together
they let a reader go and check the chain themselves.

Whether the bundle should carry that pointer *at all* was Decision D4 in §10, because it
touches the sealed publication closure and this design's default is to touch nothing there.
**Ruled: no, for v1.** `publication-register` already announces on the chain, and a reader
who has the archive base URL can find the run's announcement without a new bundle field.
The implementing `feat` adds no bundle field, and the sealed publication closure is left
exactly as it is. Revisit only if a consumer actually needs the pointer.

### 5.4 The reader's procedure

The property is only real if somebody performs it, and the procedure is small enough to
state completely:

1. Fetch the head; note `(origin, sequence, entry)`.
2. Walk archive pages back to the entry it cites; verify the entry's own DSSE signature
   and that `recordDigest(sealJson(entry).bytes)` equals the cited digest.
3. Find the anchor announcement for that entry in a later entry; fetch the
   `AnchorEvidence` record by digest; verify the proof against the entry digest, with the
   reader's own trust material.
4. Record the tuple `(origin, sequence, entryDigest, anchorRecordDigest, anchoredTime)`.
5. On any later visit, refuse a chain that does not contain `entryDigest` at `sequence`.

Steps 1–3 are ordinary consumer operations with existing code. Step 5 is a new consumer
rule and is **out of scope here**: the in-repo consumer path (`corpus.sources`) is not
reachable from any entry point today, and the head-freshness family (#2549, #3467, #3468,
#3469) is mid-flight on what a consumer should do with heads generally. Specifying a
consumer rule into that would collide. §11 files it as a follow-up against #3469's
named-verification-procedures work, where it belongs.

## 6. What this buys and what it does not

**Buys.** A reader who has performed §5.4 holds a tripwire the publisher cannot see and
cannot remove. Truncation below a held sequence, and forks that drop a held entry, become
detectable by that reader. Because entries commit transitively through `previous`, one
held anchor covers the whole prefix beneath it.

**Does not buy.**

- **Publication-by-time.** Anchoring dates bytes, not disclosure (neutral-freeze §7.1).
- **Completeness.** A publisher may decline to anchor an inconvenient entry, or decline to
  append it at all. The gap is visible; the missing announcement is not.
- **Protection for readers who never looked.** This is the defining difference from a
  witnessed log and must never be blurred in copy.
- **Freshness or withholding detection.** That is `refreshBy`, and it is currently
  unenforced on the read side (#3467). A head anchor is not a substitute and must not be
  presented as one.
- **Any change to what a lock anchor proves.** Unchanged.

**Copy discipline.** Every surface that mentions this must say "anchored, so truncation
below an anchored point is detectable to a reader who recorded it" and must never say
"witnessed", "transparency log", "append-only proven", or "tamper-proof". The honest
ceiling is in §3 and the printed wording is a follow-up in §11.

**Privacy.** Unlike the reserved transparency-log class, whose log entries are public by
construction and therefore conflict with items-private-until-published
(anchor-evidence §6.4), this mechanism publishes only a hash of an entry that is already
public. There is no privacy conflict to reconcile, which is exactly why the cheap
approximation is available today and the general answer is not.

## 7. Mechanism sketch

The smallest thing that satisfies §4 and §5. Named so the implementing `feat` has a
shape, not so it is pre-decided.

1. **Identifier** (`packages/discovery/protocol`) — add
   `announcementEntry: "https://spec.jinn.network/records/announcement-entry/v1"` to
   `RECORD_KINDS`. Additive; pinned by the existing identifier tests.
2. **Facts profile** (`packages/discovery/protocol`) — one anchor-announcement facts
   profile carrying `{subject: {kind, digest}, provider, upgrades?}`, alongside the
   existing profiles.
3. **Ledger** (`packages/benchmark-product/core/src/run/`) — a source-scoped append-only
   anchor ledger keyed by `(entryDigest, provider)` beside the existing publication state
   documents, carrying the write-once and single-upgrade-edge invariants of §4.4, written
   under the existing publication lock.
4. **Operation** — `anchorSourceEntry(context, {entryDigest, providerProfile?, endpoint?})`,
   reusing `resolveAnchorConfiguration`, `buildSource`, `verifyAcquiredProof`,
   `requireVerifiable`, `sealAnchorEvidence`, and `putSealedBytes` verbatim. It resolves the
   subject from the source's committed position, refuses on the §4.4 sanity rule — whose
   skew allowance is configured, defaulting to 5 minutes, per ruling D3 — re-reads the
   ledger after the network round trip exactly as `runAnchor` re-reads `RunState`, and
   stores.
5. **Announcement** — the next substantive append (or a dedicated append when none is
   pending) announces the record with an `https` location into the served archive.
6. **Never-blocks hook** — the append path calls the operation after the append has
   committed, in the shape of `anchorAfterLockIfConfigured`: typed outcome, never throws,
   nothing attempted and nothing printed when unconfigured.
7. **Operator surface** — one line reporting the anchored sequence, provider, and time;
   and a coverage read (anchored sequences vs. the chain) for the runbook.

Everything else — the provider seam, the proof verifiers, the record family, the sealed
store, the serving stack — is used unchanged. No new provider, no new record kind beyond
the subject identifier, no custody, no funds, no verifier change.

## 8. Non-goals

- **No change to the bundle, the claim package, or the standalone verifier.** §5.1.
- **No new verifier posture and no network dependency in verification.** The §4.4 sanity
  rule is producer-side only.
- **No consumer refusal rule in this design.** §5.4 step 5 is deferred to #3469's family.
- **No head-document anchoring**, now or as a parameter. §4.1.
- **No chain anchor, no funded EOA, no contract surface.** The neutral-freeze §9 non-goals
  stand unchanged.
- **No claim of a witnessed log**, and no wording that implies one. §6.
- **No fix for `refreshBy` enforcement (#3467), the idle re-stamp refusal (#3468, #2549),
  or the named-procedure gap (#3469).** This design is deliberately invariant to all four
  outcomes; it neither depends on them nor prejudges them.

## 9. When to stop approximating

The properly general answer remains the reserved transparency-log provider class
(anchor-evidence §6.4: C2SP checkpoint, inclusion proof, witness cosignatures). Head
anchoring is a cheap approximation of it, and the honest triggers for abandoning the
approximation are:

- **A second publisher.** The moment the network has publishers whose chains readers
  cross-compare, "detectable by whoever looked" stops being adequate, because no reader
  looked at the new publisher first.
- **A reader who cannot be asked to look.** Any surface that consumes chains
  automatically and unattended needs cosignatures, not tripwires.
- **The privacy conflict resolving.** §6.4 blocks the tlog class on
  items-private-until-published. If that reconciles, the general answer becomes available
  and the approximation should be retired rather than layered.

Until then, this is the strongest thing obtainable with zero new trust machinery, and it
should be presented as exactly that.

## 10. Operator rulings

v0.1 put four calls to the product owner rather than the author. They are **ruled**, all
four as recommended. Source: the operator comment on
[PR #3476](https://github.com/Jinn-Network/mono/pull/3476#issuecomment-5554840223)
(comment 5554840223), 2026-09-05. The implementing work proceeds from these rulings; none
of the four remains a question, and none of them blocks anything already shipped.

Each block restates the v0.1 question so the mapping is unambiguous, then records the
ruling. The ruling is the operator's meaning; the v0.1 recommendation is historical
context and is not restated as if it were still a pick.

**D1 — Build it at all?**
§8 of the neutral-freeze design filed head anchoring as explicitly optional and
non-blocking, and nothing has changed that. The case for building was that it is cheap,
additive, and invariant to the open head-freshness work; the case for waiting was that no
second publisher exists yet, so nobody is cross-comparing chains and the tripwire has few
holders.
**Ruling: build, at low priority.** It was filed optional and stays optional; the design is
now written and the cost is known. §11's follow-ups are released for filing at low
priority; they are not filed by this document.

**D2 — Announce-on-chain (§5.2) versus a sidecar?**
This is the one call that changes the chain's own content, so it wanted an explicit yes
rather than an inherited default.
**Ruling: announce on chain**, as an ordinary `AnchorEvidence` entry. §5.2 stands as
written, including its stopping rule, and the rejected sidecar alternative stays rejected.

**D3 — Keep the producer-side post-dating sanity rule (§4.4) and its 5-minute skew
allowance?**
It is small and one-directional; the argument against was that it is a rule no verifier
mirrors, and the neutral-freeze design's own §7.1-rule-4 discussion shows producer-side
rules that no verifier shares are a maintenance liability.
**Ruling: keep it, and make the allowance configurable rather than a constant.** 5 minutes
remains the default. §4.4 and §7 item 4 carry the amendment. It stays producer-side: no
verifier rule and no new verifier posture.

**D4 — Does the bundle cite `(origin, sequence)` (§5.3)?**
It touches the sealed publication closure, which this design otherwise leaves alone.
**Ruling: no, for v1.** The bundle gains no field, `RunState`, `deriveClaimAnchors`, the
claim `anchors` section, the `integrity-anchors` check, and the standalone verifier's
offline property are all untouched, and a bundle produced before and after this ships is
byte-identical. Revisit only if a consumer actually needs the pointer.

## 11. Follow-ups (approved for filing, low priority)

Ruling D1 releases these for filing. They carry the priority that ruling names — low — and
item 1 implements §7 under rulings D2, D3, and D4.

1. **`feat(benchmark-product|discovery)` — implement §7.** The identifier, facts profile,
   ledger, operation, announcement, never-blocks hook, and operator line. One PR is
   plausible; the identifier and facts profile can lead if the discovery package prefers
   a separate landing.
2. **`docs` — the printed and runbook wording** for the ceiling in §6, in the
   announcement-source runbook, using §6's copy discipline. Coordinate with #3401, which
   already covers stream-integrity disclosure wording — this may fold into it rather than
   be filed separately.
3. **`design`/`feat` — the consumer refusal rule** of §5.4 step 5, filed against #3469's
   named-verification-procedures work and sequenced after #3467 and #3468 settle what a
   head means to a consumer.
4. **`docs` — coverage read in the runbook**: how an operator (or a stranger) enumerates
   anchored versus unanchored sequences from the archive alone.

## 12. What this design does not prove

- It does not establish that any announcement was published rather than merely created.
- It does not make the announcement stream provably complete; it makes truncation below an
  anchored point detectable to a reader who recorded it, and nothing more.
- It does not protect a reader who has never fetched the chain.
- It has not been validated against a second publisher, or against any consumer that
  actually performs §5.4 — no such consumer is reachable in-tree today.
- Its cadence claim (§4.3) is calibrated to the Colophon source's current append rate. A
  source appending orders of magnitude more often would need the sampling question
  reopened, and this design does not answer it for that case.

## 13. Provenance

- Origin: follow-up 3 of `docs/superpowers/specs/2026-08-29-neutral-freeze-announcement-surface.md`
  §8 and §10, filed as #3400 on operator ratification of PR #3344.
- Adoption: operator ruling on
  [PR #3476](https://github.com/Jinn-Network/mono/pull/3476#issuecomment-5554840223),
  2026-09-05, recorded in §10. v0.2 applies it; §0–§9 are otherwise unchanged from v0.1.
- Ground truth re-derived from the tree on 2026-09-01: `packages/discovery/protocol`,
  `packages/discovery/serve`, `packages/benchmark-product/core/src/anchor`,
  `core/src/operations/run-anchor.ts`, `core/src/run/state.ts`, and
  `core/src/run/publication-source.ts`.
- The head-mutability evidence in §2 and §4.1 comes from the live head-freshness family:
  #2549 (idle re-stamp reads as rollback; dormant), #3467 (`refreshBy` ceiling unenforced
  by consumers), #3468 (a re-signed idle head is refused as broken-chain), #3469 (record
  source-head revalidation among the named procedures).
- Sibling follow-ups from the same parent: #3398 (archive lock index), #3399 (freeze-post
  pointer format), #3401 (stream-integrity disclosure wording).
