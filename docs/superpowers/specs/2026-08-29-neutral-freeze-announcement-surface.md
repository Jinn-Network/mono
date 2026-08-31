# Neutral Freeze-Announcement Surface — Anchored Lock Registry

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-29 |
| **Shape** | `design` |
| **Status** | proposed; awaiting product-owner decision |
| **Issue** | [#2869](https://github.com/Jinn-Network/mono/issues/2869) |
| **Depends on** | [pluggable integrity providers / anchor evidence](./2026-08-17-pluggable-integrity-providers-design.md) §4, §6.1–§6.4, §7, §8, §9; [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md) §9.3; [benchmark product](./2026-08-05-benchmark-product-design.md) §7; [trust and identity layer](./2026-07-27-trust-and-identity-layer-design.md) §7.3 |
| **Ratifies** | the closing ruling on #2866 (2026-08-19): the venue post is a pointer to the lock, not a rendered announcement, and the freeze-post format is a runbook concern |
| **Outcome** | two reasoned refusals (Base anchoring of lock digests; a house-hosted freeze registry), one ratification, one optional follow-up |

## 0. Decision in plain language

Issue #2869 asks whether a confirmatory lock's public commitment should stop
borrowing its timestamp authority from a third-party web venue, and proposes
anchoring lock digests on Base behind a public freeze registry.

The answer has three parts.

**The problem the issue names is already solved, by better machinery than the one
it proposes.** As of PR #2786 (merged 2026-08-18) the product acquires and carries
proof-carrying time anchors over the lock digest from two provider families — an
RFC 3161 timestamp authority and OpenTimestamps — and the standalone verifier
already checks them and reports the anchored time. Those proofs verify offline,
from bytes inside the bundle, with no chain, no custody, no gas, and no live
network. The demo-1 packet obtained and published exactly such proofs over its
confirmatory lock the day before this issue was filed. A Base
anchor of the same digest would be a strict downgrade on the exact axes the issue
asks about, and the anchor-evidence design already classified it as such (§6.3:
lookup posture, never presentable as offline-verifiable). **We do not build it.**

**The registry surface would confer legibility, not neutrality.** A page the house
hosts, rendering locks the house announced, is exactly as house-hosted as the
archive it renders. Calling it the "neutral freeze-announcement surface" would put
a Legibility claim on a surface that cannot carry it. **We do not build it.** What
is worth having instead — a static index inside the already-served, digest-addressed
public archive — is a runbook and presentation concern, and is named as such.

**The issue's framing does, however, conceal one genuine residual, and it is not a
timestamping problem.** An anchor proves that a digest *existed* by a time. It does
not prove that the lock was *announced* by that time, and it says nothing about
whether the publisher later truncated or forked its own announcement chain. That
chain (Record Discovery announcement entries, hash-linked and DSSE-signed, behind
one mutable signed head) is self-signed and self-hosted; nothing outside the
workspace has ever witnessed it. That is a transparency-log threat model, and its
standards-shaped answer is to witness **the head**, not to anchor **each lock**.
One anchor per head advance, obtained through the provider seam that already ships,
amortizes across every lock announced under it. §8 specifies it; it is optional,
non-blocking, and filed as a follow-up rather than adopted here.

## 1. Problem, restated

The issue's context sentence is:

> A confirmatory lock's public commitment currently borrows its timestamp authority
> from whatever venue the audience lives in.

That sentence collapses three claims that need separating before any of them can be
answered. The publication interoperability profile §9.3 already refuses the same
collapse for a neighbouring purpose, and its table is the model for this one.

| Claim | What it asserts | What could prove it | Status today |
|---|---|---|---|
| **Existence-by-time** | the lock digest existed no later than `T` | a foreign time proof over the digest: RFC 3161 token, OpenTimestamps Bitcoin commitment, chain transaction | **shipped** (§2) |
| **Publication-by-time** | the lock was publicly disclosed at `T`, rather than held privately | nothing an anchor can carry; anchoring `N` locks and publishing the favourable one is undetectable under every provider class | **unsolved, and unsolvable by anchoring** (§7.1) |
| **Stream integrity** | the publisher has not truncated, reordered, or forked its own announcement chain since a reader last saw it | a third party that observed the chain head at a time the publisher cannot revise | **the genuine residual** (§7.2) |

Only the first is what "timestamp authority" ordinarily means, and it is the one
the issue's proposed mechanism addresses. It is also the one that no longer needs
addressing.

## 2. Ground truth — what already ships

Every claim in this section resolves to a path in this repository, so a reader can
check it rather than take it.

**The record and the providers.** `AnchorEvidence` is a sealed record kind carrying
foreign proof bytes exactly, naming its provider by profile URI, covering exactly
one subject digest (anchor-evidence design §5). Two profiles are *producible*:
`.../anchor-profiles/rfc3161-tsa/v1` and `.../anchor-profiles/opentimestamps/v1`
(`packages/benchmark-product/core/src/anchor/profiles.ts`,
`PRODUCIBLE_ANCHOR_PROFILES`).

**Acquisition.** `runAnchor(context, { draftId, subject, providerProfile?, endpoint? })`
(`core/src/operations/run-anchor.ts`) obtains a proof for one of two subjects,
`lock` (the sealed Run digest) or `matrix` (the terminal results digest), verifies
it before storing it, is write-once per `(subject, provider)` with a narrow
upgrade exception for OpenTimestamps, refuses a lock anchor obtained after launch,
and closes both windows at `report`. It never blocks the lock: `runLock` stays
synchronous with no network call in the critical path (anchor-evidence design §7.1).

**Carriage.** `readRunAnchorCarriage` (`core/src/anchor/carriage.ts`) reads bytes
out of the sealed store, re-verifying each digest on read, and projects the bundle's
`anchors` section through `deriveClaimAnchors` — the same function the portable
verifier rebuilds the section with, single-sourced rather than mirrored, so
claim-consistency stays an exact byte-compare.

**Verification.** The `integrity-anchors` check
(`packages/benchmark-product/verify/src/anchor/check.ts`) is shared by `bundle verify`
and workspace-side `run.verify`. It never throws; every carried anchor gets an
outcome. Its four rules are exact-bytes strict-schema parse, subject recomputation
from the snapshot's own `run.json` / `matrix.json` bytes (never a stored assertion),
verifier-side-only trust material (this package ships none, and an empty root set can
never yield `verified`), and the splice-catch that refuses an `authority-time` lock
anchor whose `genTime` postdates the run's own pre-registered `closeAt`. Absence is
an outcome, not a silence: `absent` and `declared-but-absent` both pass and both
report, so a stripped anchor cannot masquerade as never-attempted.

**Honesty copy.** The printed venue limits are conditional on byte-facts, not on
verifier configuration (`verify/src/profile/anchor-claims.ts`). An unanchored bundle
keeps `structural-and-append-order-only`; an anchored one carries
`structural-append-order-and-anchored-time`, and the anchored trust-root sentence is:

> Signatures verify against the bundle-carried public keys minted by this workspace.
> The lock digest additionally carries a third-party time anchor, checked against
> trust material supplied on the verifier's side — never against roots carried in
> this bundle.

**Exercised on a real lock.** `docs/superpowers/plans/demo-report-1/anchors/` carries a
real freetsa RFC 3161 token over the confirmatory lock's Analysis Manifest digest (signed
2026-08-18 11:11:07 GMT), the two certificates needed to check it, an `openssl ts -verify`
one-liner any stranger can run, and three pending OpenTimestamps calendar proofs. Those
proofs were obtained ahead of the implementation merge and are carried as received; that
README states the bytes are unchanged when they are later sealed as `AnchorEvidence`
records. It also records the ordering discipline that went with them: a first confirmatory
dispatch that predated the token was destroyed unread, and confirmatory dispatch restarted
only after the token was obtained and verified.

**Base is already classified and already refused.** Anchor-evidence design §6.3
classifies `.../anchor-locators/base-sepolia-calldata-v1` as a *lookup* anchor with
`chain-time` basis and `lookup-only` posture: "any surface that presents this anchor
to a bundle reader must present it as ordering evidence requiring live chain access
to check — never as offline-verifiable." The refusal is not merely documentary.
`isProducibleAnchorProfile` returns `false` for it (`anchor/profiles.test.ts`),
`anchoringConfigure` refuses it and stores nothing (`operations/anchoring-configure.test.ts`),
and `runAnchor` refuses it as `venue-unavailable` (`operations/run-anchor.test.ts`).
Three tests pin it.

## 3. Criterion 1 — anchoring lock digests on Base

> *Anchoring lock digests on Base through existing recorder-style infrastructure,
> with per-lock cost, custody, and failure modes considered.*

### 3.1 What "existing recorder-style infrastructure" would actually mean

Two candidates exist, and neither is a drop-in.

**The calldata anchor writer.** `packages/trust/authoring/src/anchor.ts` sends the
32-byte digest as the entire transaction input to a target address
(`submitAnchor`), reads the mined block's timestamp, and then polls
`waitForFinalizedAnchor` until the anchor reads back below the finalized head. It
is pinned to **Base Sepolia** (`NATIVE_ANCHOR_CHAIN_ID = 84532`) and exists to give
the native identity ceremony a `validFrom` for key bindings. Its own comment records
that on live Base Sepolia the finalized tag trails head by roughly 10–20 minutes.

**The recorder contracts.** `TaskCoordinatorV4` and `JinnRouterV3`/`V4` are
task-lifecycle-shaped: `onlyRouter`-gated, `taskId`-keyed, with no arbitrary-digest
entry point. Anchoring a lock through them would mean new contract surface, a
deployment, and an audit-shaped change to a live economic contract — not reuse.

So the honest reading of "existing recorder-style infrastructure" is the calldata
writer, retargeted from Base Sepolia to Base mainnet, plus a new producible provider
profile, plus a lookup-shaped verifier path the product deliberately does not have.

### 3.2 Per-lock cost

Gas is the cheap part and the least interesting. A 32-byte-calldata value-zero
transaction on Base is a base-fee transaction plus a small L1 data component; at
2026 Base fee levels this is a sub-cent to low-single-digit-cent operation per lock.
Nothing about the decision turns on it.

The costs that do bind are not denominated in gas:

- **Latency in the freeze path.** An RFC 3161 token is complete at issuance and
  returns in one request/response round trip. A chain anchor is usable as ordering evidence only
  once it is final, which the writer's own timeout discipline puts at 10–20 minutes.
  The lock is an approval-gated, irreversible transition; adding a quarter-hour of
  chain-finality waiting to the freeze moment is a real operational cost paid every
  run, in exchange for a weaker proof.
- **A second trust root for the reader.** Every reader of an anchored bundle must
  now hold, or fetch, a position on which Base history is canonical.

### 3.3 Custody

The calldata writer needs a funded EOA with a signing key, on mainnet, held by the
publisher, funded ahead of every lock. That is a standing custody obligation with a
standing failure mode (an unfunded or compromised key silently degrades or forges
the publisher's freeze evidence), acquired to obtain a property the publisher can
already obtain with **no key and no funds at all** from a public RFC 3161 endpoint
or an OpenTimestamps calendar.

This is the decisive asymmetry. The two shipped providers were chosen partly because
they place no custody obligation on the publisher; the anchor-evidence design's
§10 producer policy is "opt-in by configuration, automatic once configured, per-draft
disable, failure never blocks." A chain anchor cannot honour "failure never blocks"
cheaply, because its failure modes include *not having enough money*.

### 3.4 Failure modes

| Mode | Effect | Present in RFC 3161 / OTS? |
|---|---|---|
| Unfunded or exhausted signing EOA | anchor silently unobtainable at lock time | no — no account exists |
| Key compromise | attacker can mint anchors attributed to the publisher | no — the publisher signs nothing |
| RPC unavailability or rate limiting | acquisition fails; retry logic and endpoint config become product surface | partially — a TSA endpoint can also fail, but retry is stateless |
| Reorg above the anchor | the anchor's block time changes or vanishes; the finalized-tag wait exists precisely to bound this, at the cost of §3.2's latency | no |
| L2 header canonicality | a stranger cannot self-containedly decide which Base header chain is canonical; anchor-evidence §3 records this as "unsolved in practice for L2s" | no for OTS given validated Bitcoin headers; not applicable to RFC 3161 |
| Sequencer censorship or outage | the freeze cannot complete until the sequencer does | no |
| Chain deprecation over archive horizons | the lookup surface may not outlive the bundle | no — proof bytes travel inside the bundle |

### 3.5 What it would force on the verifier

The `integrity-anchors` check is built on proof-carrying semantics: bytes in the
bundle, evaluated offline against verifier-supplied trust material. A `chain-time`
lookup anchor has no proof bytes to carry. Admitting it would mean either giving the
standalone verifier a network dependency and an RPC configuration surface — which
would end its current property that a stranger can check a bundle with nothing but
the bundle and `openssl` — or carrying an inclusion proof whose header canonicality
the verifier still could not settle. §6.3's classification exists to prevent exactly
this, and it should stand.

### 3.6 Refusal

**Do not anchor lock digests on Base.** For the claim it would serve
(existence-by-time), the two shipped proof-carrying providers dominate it on custody,
latency, offline verifiability, failure surface, and archive horizon. The one axis on
which chain time is genuinely stronger — `chain-time` anchors are comparable in chain
order across unrelated parties, where two `authority-time` anchors are comparable only
within one authority's clock (interoperability profile §9.3, anchor-evidence §9.3) —
is not the axis this issue is about, and it is already available to marketplace runs
through the venue's own transaction order without any of the above being built.

If a future need for cross-party ordering comparability arises, it is a new design
with a different problem statement, and §6.4's reserved classes are where it belongs.

## 4. Criterion 2 — the public freeze-registry surface

> *A public freeze-registry surface rendering announced locks: digest, anchor
> transaction, artifact links.*

### 4.1 What already answers most of it

The workspace already publishes a digest-addressed, append-only public archive and
can serve it over HTTP (`core/src/run/publication-serve.ts`, mounted in the web app
at `web/src/app/publication/[...path]/route.ts`). The layout is plain immutable
files, so an operator may equally publish it from any static host or object store;
`docs/runbooks/colophon-announcement-source-serving.md` covers both. Prospective
publication registration publishes the sealed registration closure through the
neutral publication executor, announces it on the discovery layer, and exact-probes
the published bytes (`core/src/operations/publication-register.ts`, `probeExact`).

Everything the criterion asks a registry to render — the lock digest, the anchor,
the artifact links — is therefore already fetchable, already digest-addressed, and
already announced. What is missing is a human-readable index over it.

### 4.2 Why a rendered registry is not a *neutral* surface

The issue's own framing is that the archive and discovery layer are "operator- or
house-hosted", and that this is the weakness. A registry the house hosts inherits
that weakness exactly. It adds a rendering; it adds no party who could contradict
the publisher. Shipping it under the name "neutral freeze-announcement surface"
would attach a Legibility claim to a surface that cannot carry it. `PRINCIPLES.md`
requires every public claim to be independently verifiable; "the house says so" is not
that, however well it is rendered.

There is a second, subtler cost. A registry becomes the place people look. If the
house's index is where locks are read, the house's availability and honesty become
load-bearing for a claim whose whole point was to not depend on them — and the
product would have replaced a venue dependency with a house dependency while
describing it as removing one.

### 4.3 Refusal, and the small honest alternative

**Do not build a house-hosted freeze registry.** What is worth having is smaller
and belongs where the bytes already are: a static, generated index page inside the
already-served public archive, listing the locks that workspace has announced, each
row linking to the exact archive paths for the sealed Run record, the AnchorEvidence
records, and the bundle. It renders one publisher's own announcements, is served
from the same append-only tree it indexes, and is honest about being the publisher's
own surface.

That is presentation over shipped data with no new trust claim, so it is a runbook
and web-surface concern rather than a design one. It is named in §10 as a follow-up
and is explicitly optional.

## 5. Criterion 3 — how the standalone verifier consumes the anchor

> *How the standalone verifier consumes the anchor (the bundle carries the anchor
> reference; the verifier checks the digest match and reports the anchor timestamp).*

This is shipped, and the shipped shape is stronger than the criterion asks for: the
bundle carries the anchor's **proof bytes**, not a reference to be dereferenced.

1. The bundle carries each `AnchorEvidence` record at `anchors/<sha256>.bin`, exactly
   as received from the provider.
2. `deriveClaimAnchors` projects them into the claim package's `anchors` section, in
   record-digest order, reading records only through `parseExactAnchorEvidence` and
   proof content only through `decodeAnchorProofContent`. Producer and verifier call
   the same function over the same bytes, so claim-consistency stays an exact
   byte-compare rather than a comparison of two implementations.
3. `evaluateIntegrityAnchors` recomputes the subject digest from the authenticated
   snapshot's own `run.json` / `matrix.json` bytes. Selectors are digest-keyed;
   `subject.kind` is then checked for equality and a mismatch is `invalid` — a stored
   assertion is never the comparison source.
4. Each anchor resolves to `verified`, `present`, `pending`, or `invalid`, and each
   subject to `anchored`, `absent`, or `declared-but-absent`. Trust material is
   verifier-side and this package ships none, so the default no-roots configuration
   yields `present`, never a false `verified` and never a false accusation.
5. The anchor time is reported from byte-embedded facts: `genTime` for RFC 3161, the
   attested Bitcoin block height (or `pending`) for OpenTimestamps. The splice-catch
   reads `facts.genTime` — which both `verified` and `present` carry — and refuses a
   lock anchor whose `genTime` postdates the run's own `closeAt`.
6. The printed sentence names what the anchor does and does not establish, per
   provider class, and explicitly says the anchor does not show that results were
   produced after the design.

A stranger with the bundle and `openssl ts -verify` can check the RFC 3161 leg with
no Jinn code, as the demo-1 anchors README demonstrates. **Nothing to build.**

## 6. Criterion 4 — the venue post becomes a pointer

> *The relationship to the social announcement: the venue post becomes a pointer to
> the anchor rather than the anchor itself.*

This is already the ruling, and this design ratifies it. #2866 was closed on
2026-08-19 with: "the operator's intent for the venue post is a pointer to the lock
rather than a rendered announcement, so no renderer is needed. The freeze-post format
becomes a runbook concern."

The consequence worth writing down explicitly, because it is what makes the venue
post safe to treat as disposable: **once the lock carries a proof-carrying anchor,
the venue post carries no evidentiary weight at all.** It is a distribution act. Its
timestamp is not load-bearing, its edit history is not load-bearing, and the venue
deleting it destroys no evidence. A reader who distrusts the venue entirely loses
nothing except the pointer, which the archive and the bundle both reproduce.

The freeze post should therefore contain, and only contain: the lock digest, the
provider and time of each anchor over it, the archive URL for the sealed Run record
and the anchor records, and the standing immutability clause. Format belongs in
`docs/runbooks/colophon-announcement-source-serving.md` or a sibling runbook, not in
product code — which is the same conclusion #2866 reached, restated here so that
closing #2869 does not reopen it.

## 7. The residual this design does identify

### 7.1 What no anchor can fix

An anchor dates bytes. It cannot distinguish a publisher who locked one design and
published it from a publisher who locked twenty and published the one that worked.
Every anchor in the twenty-lock case is genuine, complete, and verifies. This is the
file-drawer problem, and it is a property of the multiple-comparisons pitfall rather
than of timestamping; the honest statement is that neither the shipped anchors nor
the proposed Base anchor touches it, and this design does not claim otherwise.

Two things bound it, both already in the tree: per-cell accounting makes the
comparison's shape legible, and the announcement chain makes a publisher's own
stream enumerable — if the stream can be trusted to be complete. Which is §7.2.

### 7.2 Announcement-chain equivocation

The Record Discovery announcement chain is genuinely log-shaped:
`AnnouncementEntry` carries a `previous` digest, a gap-free increment-by-one
`sequence` from a pinned genesis, and per-entry announcement identifiers
(`packages/discovery/protocol/src/entry.ts`); `SourceHead` is the one mutable
DSSE-signed document per source, naming `{origin, sequence, entry, issuedAt,
refreshBy}` (`head.ts`).

It has every transparency-log property except the one that makes a transparency log
work: **no witness**. The publisher holds the signing key and hosts the archive, so
it can rewrite the chain from any point, re-sign a shorter or different head, and no
reader who had not previously fetched the old head could tell. The interoperability
profile §9.3 already requires a self-run publisher to disclose that its publication
source is owner-controlled, which is exactly this fact stated as a disclosure rather
than fixed as a mechanism.

This is the residual that survives every other finding in this document, and it is
the one thing the issue's instinct — "put something outside the publisher's control
into this picture" — was correctly reaching for. Its target was simply the wrong
object: the lock is already externally witnessed; the *stream* is not.

## 8. The one thing worth building — head anchoring

Optional, non-blocking, and small enough that it is a follow-up rather than a
program.

**Add a third `runAnchor` subject: the publication source head.** Anchor the digest
of the sealed head document (or of the entry it names) through the same provider seam
that already ships. One anchor per head advance, not per lock — the head commits to
its entry, the entry commits to `previous`, so a single anchored head transitively
dates every announcement beneath it.

What it buys, stated precisely and no further: a reader who holds an anchored head at
sequence `N` can refuse any later chain the publisher offers that does not contain
it. A publisher who truncates below `N` is caught by anyone holding that anchor. It
does **not** prevent a publisher from never anchoring an inconvenient head, and it
does **not** make the stream provably complete. It converts silent revision into
revision that is detectable by anyone who looked earlier, which is what a witnessed
log gives and is the honest ceiling here.

Why it is cheap: `AnchorEvidence` covers "any sealed record's digest" already
(anchor-evidence §2: "the benchmark lock is its first subject, not its definition").
The work is a subject resolver, the write-once and window rules for a subject whose
natural cadence is *repeated* rather than once-per-run, carriage, and one reported
line. No new record kind, no new provider, no new verifier posture, no custody.

Two open questions a future design must settle rather than assume, and the reason
this section is a recommendation and not a specification:

1. **Cadence and window.** Every existing subject anchors at most once and closes at
   `report`. A head anchors repeatedly and has no natural close, so the write-once
   invariant in `RunState.anchors` does not transfer unchanged.
2. **Where it is carried.** A head anchor is a fact about the publisher's source, not
   about one run. Carrying it in every bundle would put an unbounded, run-independent
   series into a per-run closure. It more likely belongs beside the served head in the
   public archive, with the bundle citing it — which is a different carriage question
   from the one §7.4 answers.

The properly general answer to §7.2 remains the reserved transparency-log provider
class of anchor-evidence §6.4 (C2SP checkpoint plus witness cosignatures). Head
anchoring is the cheap approximation available today with zero new trust machinery;
it should be presented as that and never as a witnessed log.

## 9. Non-goals

- **No lock-digest anchoring on Base**, and no promotion of the
  `base-sepolia-calldata-v1` locator to a producible profile. §6.3's lookup-only
  classification stands, along with the three tests that pin the refusal.
- **No new contract surface**, no recorder function for arbitrary digests, no
  deployment, no funded publisher EOA.
- **No house-hosted registry**, and no surface described as neutral that the house
  hosts.
- **No network dependency in the standalone verifier.** A bundle stays checkable with
  the bundle and off-the-shelf tools.
- **No freeze-announcement renderer.** Ratified from #2866; format is a runbook.
- **No claim that any anchor establishes publication-by-time or stream completeness.**
- **No change to the lock discipline, the `runLock` critical path, or any sealed
  record family.**

## 10. Follow-ups (file only on approval)

1. **Public archive lock index** (`feat`, small, optional) — a generated static index
   inside the served public archive listing this workspace's announced locks with
   their archive paths and carried anchors. Presentation over shipped data; no new
   trust claim; §4.3.
2. **Freeze-post pointer format** (`docs`) — the venue-post contents of §6 written
   into the announcement-source runbook, so the format stops being re-derived per run.
3. **Publication head anchoring** (`design` first, then `feat`) — §8, including the
   two open questions. Explicitly optional and not blocking anything.
4. **Disclosure wording for stream integrity** (`docs` or small `feat`) — the
   interoperability profile §9.3 already requires a self-run publisher to disclose an
   owner-controlled publication source; check that the product's printed disclosure
   says it in the words of §7.2 rather than only in the profile.

## 11. What this design does not prove

- It does not establish that any lock was published rather than merely created
  (§7.1).
- It does not make a self-hosted announcement stream provably complete (§7.2); the
  recommended head anchoring makes truncation detectable to prior observers and
  nothing more.
- It does not change what an anchor proves. A verified anchor moves a
  pre-registration claim from tool-enforced discipline toward *committed*; nothing an
  anchor can carry ever reaches *attested*.
- It has not been validated against a second publisher. Every claim about what is
  adequate rests on one house's runs, and a publisher without this house's ordering
  discipline would have weaker evidence with identical machinery.

## 12. Provenance

- Origin: operator question during the 2026-08-19 validation walkthrough, refiled
  from #2866's closing ruling as #2869.
- Deferred by its own filing until the judge-report program (#2833) completes; this
  session executes the design, and adopting any follow-up remains gated there.
- Related: #2861 (sealed-design iteration lineage) shares §7's concern from the
  design-amendment side rather than the announcement side; the two should be read
  together if either is built.
- Ground truth for §2 was re-derived from the tree on 2026-08-29, after PR #2786
  merged. The issue's context paragraph predates that merge landing in the author's
  view of the product, which is why §1 restates the problem before answering it.
