# Serving the Colophon announcement source

Colophon announces every evidence record it publishes onto a signed Record
Discovery source chain held in the workspace. This runbook takes that chain from
local emission to a public HTTP surface any discovery client can cold-sync, and
ends where operator work begins: provisioning the host and domain.

## What is being served

Under `<workspace>/publication/public/` the product maintains the standard
Record Discovery serving layout:

| Path | What it is | Mutability |
|------|------------|------------|
| `/.well-known/jinn-record-discovery` | names this workspace's source, its head path, and its newest archive page | rewritten after every announcement |
| `/sources/<name>/head` | the signed source head — current sequence, entry digest, `refreshBy` | rewritten after every announcement |
| `/sources/<name>/entries/<page>` | a signed archive page, one entry per page, linked to its predecessor via `prevArchive` | immutable once written |
| `/records/<sha256>` | the exact announced record bytes | immutable |
| `/publication-artifacts/sha256/<sha256>` | exact publication artifact bytes | immutable |

Everything a consumer trusts is signed or digest-addressed, so serving is a
read-only static problem. There is no write route, no session, and no
credential: the archive subtree is public by construction.

The well-known document is the one derived object. It exists so a first-time
consumer can find the newest archive page without being told its name —
`coldSync` starts there and walks `prevArchive` back to genesis. It is rewritten
from the writer's committed position after every append, and rebuilt at serve
time for any workspace whose announcements predate this serving path.

## Before you announce: the public URL must already serve

```bash
colophon publication configure \
  --workspace <dir> --principal <id> --draft <draftId> \
  --public-base-url https://records.example.org/publication
```

This is a **locator, not identity**. Source identity is the workspace key's
`did:key` plus the source name, both frozen once any append receipt is durable;
the base URL is deliberately mutable and can be re-pointed later with another
`publication configure`. Nothing in the announcement entries names it —
Colophon announces records by digest and never writes a `locations` array — so
moving the archive to a new domain does not invalidate a single published
record.

What it must be is *reachable at announce time*. `publication register`,
`publication accounting`, `publication report`, and `launch` each probe this
base URL for the exact bytes they are about to announce and refuse the stage if the probe does not return
them. So the ordering is: serve (or mirror) first, configure second, announce
third — not because the URL is permanent, but because the announce path checks
it.

## Option A — run the server

```bash
colophon publication serve --workspace <dir> --principal <id> \
  [--source <name>] [--host <address>] [--port <n>]
```

It binds `127.0.0.1:8787` by default, refreshes the well-known document, serves
until SIGINT/SIGTERM, and prints the bound URL. `--port 0` binds an ephemeral
port. `--workspace` must name an existing Colophon workspace: a directory that
is not one is refused, so a stale path is a message rather than a bound socket
over an empty archive.

`--source` is optional. Omitted, the name is read from this workspace's runs:
the single configured `publication.source.name` if they agree, the default
`colophon-benchmarks` if no run configures one, and a refusal naming the
candidates if they disagree — pass `--source` to settle it.

The refresh takes the source lock, so it prints a line before it starts and
another naming lock contention if it has to wait for another product process
mid-announce. That wait is bounded and clears on its own; the bind follows it
either way.

This process terminates plain HTTP only. Put it behind a reverse proxy that
terminates TLS and forwards the archive mount path unchanged; the served paths
are exactly the table above, so the proxy needs no rewriting beyond stripping
its own prefix if you mount below the origin root. Bind to a non-loopback
address only when the proxy is on another host and the network between them is
one you control.

Give the archive its own origin, not a path on a domain that serves anything
else. Publication artifacts carry the media type the producing venue declared
for them, and the server returns it verbatim; a participant who supplies HTML
bytes and declares `text/html` gets script execution on whatever origin the
archive is mounted on. On a dedicated origin that is inert -- there is no
cookie, no session, and no write route to reach -- which is exactly why it must
not share an origin with something that has any of the three.

## Option B — publish the tree statically

The layout is immutable files; nothing in it requires a running product. For a
durable public source this is the better shape — copy or sync
`<workspace>/publication/public/` to any static host or object store:

```bash
rsync -a --exclude '*.content-type' \
  <workspace>/publication/public/ <static-root>/publication/
```

Three things the static host must get right:

1. **Content types.** The product stores each object's declared type in a
   `<path>.content-type` sidecar, which the HTTP handler reads and the archive
   path grammar never serves. A static host does neither: exclude the sidecars
   from what you publish (as above) and configure the media types yourself:
   `application/vnd.jinn.record-discovery.head.v1+json` for the head,
   `application/vnd.jinn.record-discovery.well-known.v1+json` for the
   well-known document, `application/json` for archive pages, and each record's
   own announced media type for its digest path. Cold sync and returning sync
   do not check the declared type, but consumers that stream the live tail do —
   and a mirror that serves everything as `text/plain` is a mirror nobody can
   build a typed reader against.
2. **Re-sync after every announcement.** Archive pages and record bytes only
   ever appear; the head and the well-known document are rewritten in place. A
   stale head against fresh pages is a chain a consumer reads as behind, not
   broken — but a stale well-known document points at an archive page that is no
   longer the newest, and a cold-syncing consumer silently misses everything
   after it.
3. **Do not serve anything else from the mount.** Publish the archive subtree at
   its own path or origin. The product's handler enforces a closed path grammar;
   a static host enforces whatever directory you point it at.

Neither option is required to be the only one: serving locally while mirroring
statically is fine, because both read the same bytes.

## Verify it from another machine

The acceptance test is a cold sync performed by a consumer that has never seen
this source, on a machine that is not the producer:

1. `GET <base>/.well-known/jinn-record-discovery` — it must name your source's agent
   `did:key`, its name, its head path, and an archive root.
2. `GET <base>/sources/<name>/head` — a DSSE envelope over the source head. Its
   `origin` must match the well-known entry, and `refreshBy` must be in the
   future.
3. Walk the archive from the well-known `archiveRoot` back through each page's
   `prevArchive` to genesis, then run `source-chain-verification` over the head
   plus the entries oldest-first. `coldSync` in
   `@jinn-network/record-discovery-client` performs exactly this walk.
4. For each announcement, `GET` `<base>/records/<sha256>` — the digest path is
   this producer's location — and confirm the returned bytes hash to the
   announced digest. Signed Report payloads and other publication artifacts live
   at `<base>/publication-artifacts/sha256/<sha256>`.

Steps 1–4 are what `publication-serve.test.ts` performs against a real socket in
CI, so a failure here is an environment or hosting fault rather than a product
one. If step 4 fails while steps 1–3 pass, the locations were configured after
the fact — see "fix the public URL first" above.

## What the served chain proves — and what it does not

A cold sync that passes proves a specific, bounded set of things: each entry
links to its predecessor, the sequence is gap-free, every entry and the head
carry a signature that verifies under this source's `did:key`, and every record
fetched at its digest path hashes to the digest that was announced. That is
worth having and it is all of it.

It does not prove the chain is the whole chain. The source is hash-linked,
sequenced, and signed — but it is hosted entirely by the publisher, and nothing
outside the workspace has ever observed it. A publisher who truncated the chain
below some sequence, or replaced a suffix with a differently signed one, would
produce something internally valid in exactly the way the walk above checks,
because the publisher holds the key. A reader seeing it for the first time
cannot tell.

**So do not describe this surface as "witnessed", a "transparency log",
"append-only proven", or "tamper-proof."** None of those is true here, and the
distinction is load-bearing rather than pedantic: each of those words promises a
property that protects a reader who never looked, and this chain has no such
property. Say what it is — a signed, hash-linked chain the publisher hosts —
and say what a reader has to do to get anything stronger.

What a reader can do today is hold their own tripwire. Record `(origin,
sequence, entry)` from the head on every visit. On a later visit, a chain that
does not still contain that entry digest at that sequence has been rewritten,
and the reader who kept the record is the one who can see it. That protection
rests entirely on the reader's own note; it carries no third-party evidence, and
the publisher cannot know which readers hold which notes.

Head anchoring would raise that ceiling by one step, and only one.
[The 2026-09-01 head-anchoring design](../superpowers/specs/2026-09-01-publication-head-anchoring-design.md)
specifies obtaining third-party time evidence over an announcement entry's
digest and announcing that evidence on the chain, so a reader who recorded an
anchored entry could refuse a later chain that does not contain it — truncation
below an anchored point becomes detectable to a reader who recorded it, and
nothing more. It would still not prove publication-by-time, would still not make
the stream provably complete, and would still do nothing for a reader who never
looked. **It is designed, not implemented** (tracked as #4127), so nothing this
runbook serves is anchored today. Until it ships, the ceiling to state is the
one above. §3 and §6 of that design are the authority for both.

## Coverage: which sequences are anchored

> **Designed, not implemented** (tracked as #4127). Nothing this runbook serves
> carries an anchor announcement today, so the walk below currently reports every
> substantive sequence as unanchored, with the newest reported as pending. It is
> recorded here because the mechanism is ruled and its shape is fixed
> ([`docs/superpowers/specs/2026-09-01-publication-head-anchoring-design.md`](../superpowers/specs/2026-09-01-publication-head-anchoring-design.md)),
> and because the walk itself does not change when the mechanism lands. Landing
> #4127 must clear this marker.

Once head anchoring is live, each substantive entry's digest is anchored through a
third-party provider, and the resulting `AnchorEvidence` record is announced by a
later entry on this same chain. That makes coverage a property of the archive
rather than an operator claim about it: anybody holding the archive — the operator,
or a stranger who cold-synced it — enumerates exactly which sequences are anchored
and which are not, from the archive alone. That last phrase is the whole value of
the walk, and it is only earned if each step reads the records themselves rather
than the publisher's description of them, which is why step 3 is written the way it
is.

### The walk

Start from the archive walk in "Verify it from another machine" step 3, which
already yields every entry oldest-first. Then:

1. **Fix the denominator.** Sequences are fixed-width, gap-free, and increment by
   one, so the walked entries are the complete list — a missing sequence is a broken
   chain, not a coverage question. Compute each entry's digest the way the head cites
   it: `sealJson(entry).digest` (`@jinn-network/record-discovery-protocol`), where
   `entry` is the inner entry payload rather than the `{entry, signature}` element the
   page carries around it.
2. **Classify each entry.** An entry is *provisionally anchor-announcing* when every
   one of its `available` announcements names `record.kind`
   `https://spec.jinn.network/records/anchor-evidence/v1`; every other entry is
   *substantive*. Scope the predicate to `available`: a `withdrawn` announcement
   carries no `record` at all, and a withdrawal is substantive content either way. The
   classification is provisional because it has so far read a record *reference*
   rather than a record — step 3 confirms it. Anchor-announcing entries are not
   themselves anchored and are not part of the denominator: anchoring them would not
   terminate, and truncating one drops nothing a reader loses.
3. **Collect the anchored set — from the records, not from `facts`.** Each anchor
   announcement carries `facts` of the shape
   `{subject: {kind, digest}, provider, upgrades?}`. Do not read the set out of that
   field: `facts` is advisory metadata about an announced record while the record's own
   bytes stay authoritative (design §5.2), it is schema-optional on the announcement,
   and nothing in the walk this section builds on ever compares it to the record it
   describes. Treat it as an index into which records to fetch. For each such
   announcement, fetch the `AnchorEvidence` record from `<base>/records/<sha256>` —
   the announcement's `record.digest` with the `sha256:` prefix stripped — and read
   `subject` from the fetched bytes. An announcement with no facts card is a record to
   fetch, not an absent anchor. Keep only subjects whose `subject.kind` is
   `https://spec.jinn.network/records/announcement-entry/v1`: §4.2 minted that URI to
   make `subject.kind` normative, and a record covering anything else anchors no
   sequence on this chain — an entry announcing only such records is substantive after
   all and rejoins the denominator. Deduplicate by `subject.digest`, because several
   announcements can cover one subject two ways: an OpenTimestamps upgrade is announced
   as a second *announcement* naming the pending record through `upgrades` in its
   facts, and the anchor ledger is keyed `(entryDigest, provider)` (§4.4), so two
   different providers may each anchor the same entry with no upgrade relationship
   between them. Count subjects rather than announcements.
4. **Read off coverage.** A substantive entry is anchored when its digest is in that
   set. Normalize the two spellings before comparing: `sealJson` returns
   `sha256:<hex>`, while the record's `subject.digest` is a digest set carrying the
   bare hex (`{"sha256": "<hex>"}`, `Sha256DigestSetSchema`). §4.1 rules the subject
   digest to be the entry digest with the `sha256:` prefix stripped, so the two are the
   same value in two spellings — comparing them unnormalized yields zero matches, which
   reads exactly like total coverage failure.
5. **Separate the gap from the tail.** The unanchored substantive sequences are the
   gap — with one caveat at the tip. An entry's anchor is announced by a *later* entry,
   so a substantive append whose anchor-announcing append has not landed yet reads as
   unanchored until it does. If the newest entry on the chain is substantive rather
   than anchor-announcing, treat its sequence as pending rather than as a gap. Pending
   is a reading, not a verdict: at the tip an anchor that has not landed yet and one
   that never will are byte-identical, the same way a mid-chain outage and a declined
   anchor are. Nor is *unanchored* settled anywhere on the chain — §4.4 anchors any
   past entry on demand and rules an anchor obtained late a weaker anchor rather than
   an invalid one, so a sequence that is a gap today can be anchored tomorrow.
6. **Name what is left exactly.** Because the denominator is exact, report the
   remaining unanchored sequences by sequence rather than as a count or a proportion.

### Reading the result honestly

- **A gap is not misconduct.** Anchor acquisition never blocks an append, by design:
  a provider outage at append time leaves a visible hole rather than a stalled
  chain. Nothing in the archive distinguishes an outage from a declined anchor, and
  this enumeration does not claim to.
- **Presence is not validity.** Step 3 binds each anchor to the subject its own record
  bytes name, so the set is not a publisher assertion. It is still only presence: the
  walk reports which entries have an anchor, not whether that anchor's proof checks.
  Verifying one means checking the record's `proof` against the entry digest with your
  own trust material, which needs the provider's evidence and not just this archive.
- **Coverage is not completeness.** An anchored sequence means truncation below that
  point is detectable to a reader who recorded it, and nothing more. It does not
  date publication, says nothing about entries the publisher never appended, and
  does not make this source witnessed. The prohibited words above apply unchanged.
- **The tripwire is the reader's, not the publisher's.** Coverage read today tells
  you which sequences you *could* record. It protects you only from the moment you
  record `(origin, sequence, entry)` and check a later chain against it.

## Disclosure: why this producer has no disclosure gate

Colophon routes around `packages/evidence/contribution` — the disclosure
authorization surface — entirely. That is correct *for this producer*: every
record Colophon announces is part of a bundle built to be public, and there is
no private-by-default corpus behind it to leak.

**Do not copy this path for a producer whose records are private by default.**
Serving a source chain publishes the announcement entries, the record bytes at
their digest paths, and the locations naming where more can be fetched. A
producer that holds records some parties may not see must run its announcements
through a disclosure gate before the durable writer, not after — once an entry
is signed into the chain it is append-only, and withdrawal announces the
withdrawal rather than unpublishing the bytes.

## What remains an operator step

This runbook ends at a served archive. Choosing the domain, obtaining the
certificate, provisioning the host or bucket, and setting the DNS record are
operator acts the product does not perform and holds no credentials for. Do
them before `publication configure`, so the base URL you announce is the one
that will still be true a year from now.
