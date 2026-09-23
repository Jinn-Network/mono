# DR-2026-09-07 — Retrieval-visibility is a publisher recommendation, not a permission

- **Date:** 2026-09-07.
- **Status:** Accepted — operator ruling on [PR #4149](https://github.com/Jinn-Network/mono/pull/4149)
  (Ritsu, 2026-09-07): all five rulings ratified as written, and this record's discriminator
  (§The discriminator) adopted as the going-forward rule for what belongs on a record. That
  ruling discharges design issue #1994's "discussion-first — blocked on human" condition.
  Enactment is carried by the follow-ups named in §Consequences; this record edits no
  ratified spec and changes no behavior.
- **Owning docs:** [`docs/superpowers/specs/2026-07-17-corpus-supply-design.md`](../../docs/superpowers/specs/2026-07-17-corpus-supply-design.md) §5
  (the two-tier serving rule, W2 made precise).
- **Amends, through the follow-ups in §Consequences:** corpus-supply-design §5 (the mark's
  contract, and the standing of the engine-autoload carve-out); the semantics note on #1824.
- **Relates to:** #1994 (this record); #1824 (introduced the mark); #1967 / [`2026-07-22-scrub-redesign-design.md`](../../docs/superpowers/specs/2026-07-22-scrub-redesign-design.md)
  (the consent and distribution thread); [DR-2026-07-17](./2026-07-17-stage2-charter.md)
  Decision 4 (the policy-admission amendment to W2) and Decision 1 (the parked
  single-consent contract).

## Context

A unit of knowledge carries its retrieval-visibility decision inside the core evidence
record, at every layer: the frozen `jinn.trace-envelope.v0` carries the
`retrieval:visible.v1` mark in `task.distributionTags`; `EpisodeV1` promotes it to a
first-class `retrievalVisible` boolean; pickup keys its fail-closed allowlist on it.

Issue #1994 asks whether that is the right layer. The core record's job is to describe what
happened. Whether a record is *retrievable by a given consumer* looks like policy layered on
top — and the model already has an overlay precedent in `EligibilityVerdict`. Against that
stands the design's stated rationale: contributor consent must travel with the signed record
so that a reader cannot strip it, and must be uniform across consumers or it means nothing.

The issue names the likely resolution — split consent from relevance — and asks whether the
two are actually separable. This record answers that they are, establishes the test that
separates them, and finds that the more urgent half of the split is the one nobody has
noticed is missing.

## What the code actually does today

Verified in-tree at `73a879e8e`. This section is evidence, not restatement; every ruling
below rests on it.

| Fact | Location |
|---|---|
| `distributionTags` is freeform, `.min(1)`, "no fixed taxonomy; clustering is inferred server-side". The mark is a reserved string squatting in a freeform array of a frozen schema. | `packages/core/src/envelope.ts:121-125` |
| `EpisodeV1.retrievalVisible` is a first-class boolean, `default(false)`, in both write and read schemas. | `packages/plugin/src/schemas/episode.ts:302,488` |
| At publish the boolean is *derived from* the tag: `retrievalVisible: hasRetrievalMark(trace.task.distributionTags)`. Two representations, one truth. | `packages/layer/src/publish.ts:439` |
| `retention: { policy: 'contribution-eligible' }` is **hardcoded** at publish. The one consent-shaped field on the published record is a constant and carries no information. | `packages/layer/src/publish.ts:478` |
| The corpus adapter recomputes the value rather than trusting it: `hit.retrievalVisible ?? hasRetrievalMark(tags)`. | `packages/layer/src/adapters/corpus-adapter.ts:62` |
| The local-episode adapter sets a blanket `retrievalVisible: true` on every record it serves. | `packages/layer/src/adapters/local-episode-corpus-adapter.ts:75,126,145` |
| Fetch-path integrity is a **sha256 content-address match** against the manifest, refusing to serve on mismatch. No contributor signature is verified on any read path. | `packages/layer/src/adapters/corpus-adapter.ts:136-143` |
| Pickup's own comment: "content is the truth, the search-hit's `retrievalVisible` was only a hint used to clear ranking." Hint at ranking, verified against content post-fetch. | `packages/plugin/src/plugin.ts:690-694` |
| Engine autoload is explicitly **not governed by the mark** — a second retrieval surface with a different precision-risk profile. | corpus-supply-design §5, final bullet |
| Overlay precedent: `deriveEligibility` is pure over record facts, and the cached verdict is explicitly "cheap" with "authoritative validation sidecar-side". | `packages/plugin/src/eligibility.ts`; `packages/plugin/src/schemas/eligibility-verdict.ts` |

Three consumers already disagree about visibility for the same record: pickup enforces the
mark, the local-episode adapter overrides it to `true`, and autoload does not consult it.
The consumer-evaluated overlay #1994 proposes is not a proposal. It shipped, three times,
unnamed.

## The two claims under test

### Claim A — "consent must travel with the signed record so a reader cannot strip it"

As stated, it does not hold, for three independent reasons.

**A1 — the bit is not consent.** §5's marking criteria are a curation bar: repo-targeted
vocabulary, authored synthesis and tags, scrub-clean, evidence-backed. Its worked example is
retiring the 84 skills.sh seeds because a measured null result showed them to be
false-positive magnets under lexical retrieval. That is relevance and precision. The word
consent does not appear in §5. Consent lives on the *publication* gate — the scrub, and the
parked single-consent contract of DR-2026-07-17 Decision 1 — which decides whether a record
becomes public at all.

**A2 — stripping is the safe direction.** Under an allowlist, removing the mark makes a
record invisible. A signature therefore protects nothing against a stripping adversary; the
allowlist posture already does. The direction a signature would repel is *forgery* — adding
the mark to a record whose contributor did not mark it — and no consumption path verifies a
signature. Integrity at fetch is a content-address match, which makes everything in the
record equally tamper-evident and so is an argument for content-addressing, not for this
field's placement.

**A3 — uniformity is voluntary.** §5 puts enforcement entirely consumer-side. On a public,
content-addressed corpus a non-cooperating consumer ignores the field at no cost. "Uniform
across all apps or it is meaningless" is already false in the shipped system, as the three
disagreeing consumers above show.

Two adjacent properties do survive, and any resolution must keep them:

- **A′ — a default that travels.** A cooperating consumer that knows nothing about Jinn's policy
  gets the safe answer with zero configuration, because the answer arrived with the data.
  This makes the safe behavior the zero-effort behavior. It is the strongest reason the
  field belongs in the content.
- **A″ — attributable, tamper-evident intent.** Content-addressing makes the publisher's claim
  unforgeable once fetched. On a curated lane where curator judgment *is* the quality
  signal, recording whose judgment it was has value independent of enforcement.

### Claim B — "a policy bit does not belong in a neutral evidence record"

Mostly right, but "policy versus fact" is too blunt a knife to cut with.
`outcome.verificationStrength` is also a judgment, and nobody objects to it living on the
record. A sharper test is needed, and it is the substantive contribution of this record.

## The discriminator

> A fact belongs on the record if and only if it is (a) about what happened, (b)
> determinable at publish time, and (c) invariant to who is asking and when. A judgment
> whose truth depends on the consumer, or decays with time, belongs in an overlay.

`verificationStrength` passes all three: the tests passed or they did not, that never
changes, and it does not vary by reader.

`retrievalVisible` fails (b) and (c) together. It is a prediction about relevance to an
unspecified consumer's future task distribution. §5's own demotion mechanism is the proof:
to change your mind about a record's relevance you must **publish a superseding record**.
Minting immutable content to express "this is less relevant now" is exactly the cost of
putting a decaying, audience-dependent judgment in an immutable, audience-neutral place.

Consent passes all three. A contributor's grant is about what they permitted, is fixed at
publish, and does not vary by who is reading. The two concerns are separable, and the test
above is why.

## Decision

**1. Reclassify the mark; do not relocate it.** `retrievalVisible`, and its
`retrieval:visible.v1` tag form, stay in the content. The contract changes from *permission*
to **publisher recommendation**: a publish-time, tamper-evident assertion by the curator that
this record met the curation bar. It is one input to a consumer's decision, never the
decision. No schema change, no envelope unfreeze, no re-publish, no migration — the meaning
moves, the bytes do not. This keeps the travelling default (A′) and the attributable intent
(A″) while removing the coupling #1994 objects to, because a recommendation a consumer is
free to weigh is not a policy bit imposed on every consumer.

**2. Name the overlay that already ships.** Each consumer evaluates retrieval eligibility for
its own context, and declares which overlay it runs:

- pickup: "the recommendation must be present and true" — the strictest overlay, correct for
  interactive sessions where a bad hit is expensive;
- the local-episode adapter: "records this operator owns are visible to their owner";
- engine autoload: "solver-type keyed; the recommendation is not consulted", its precision
  risk bounded by keying and its failure mode cheap.

These stop being ad-hoc divergence and become instances of one sanctioned pattern. §5's
autoload bullet is reclassified from carve-out to worked example. A new consumer that
declares no overlay inherits pickup's.

**3. Fail-closed is a consumer default, not a record property.** The guarantee is preserved
by every consumer defaulting to "absent recommendation excludes" — which is exactly what
ships, at ranking (`pickup.ts:383`) and again post-fetch (`plugin.ts:694`). This states
honestly where the guarantee always lived. It is not weakened by this record; it is
relocated in the documentation to the layer that was already enforcing it.

**4. Put the consent half on the record, because today it is not there.** This is the finding
with teeth. The non-strippable contributor grant that Claim A defends **does not currently
exist on the published record**: `retention.policy` is hardcoded at publish and carries no
information, and `environment.distributionClass` describes the *environment's* license, not
the contributor's grant. Ruling: define an explicit distribution-permission field carrying
the contributor grant and its scrub-policy provenance, and make that the signed,
non-strippable, uniform-across-consumers bit. Its enforcement point is the **publication
gate**, not any consumer — because on public data the only enforcement that works is never
publishing. This is the concern that satisfies the discriminator, and it is the one the
current design believed it had.

**5. Sequencing.** Rulings 1-3 document shipped behavior and can land immediately as
documentation. Ruling 4 is new work and is coupled to the scrub redesign — #1967 §6 puts
policy-hash provenance in the redaction manifest, and a permission field minted ahead of it
would need re-minting. Ruling 4 lands with that lane, not before it.

## What does not change

Pickup behavior; the allowlist posture; the fail-closed defaults at ranking and post-fetch;
the retirement of the 84 skills.sh seeds; the frozen envelope; the policy-admission hook of
DR-2026-07-17 Decision 4; every shipped test. This record is a change of contract and
documentation, not of behavior. Ruling 4 alone adds behavior, and it adds it at the
publication gate, where nothing reads today.

## Consequences on ratification

Ratification makes these due. This record enacts none of them — it is the decision, not its
execution — so an item still listed below means the follow-through is outstanding, never
that the ruling is unsettled.

- Amend corpus-supply-design §5: the mark is a publisher recommendation; the overlay pattern
  is named and consumers declare theirs; the autoload bullet becomes a worked example rather
  than an exception.
- Amend the #1824 semantics note to match, without touching its shipped acceptance criteria.
- File the distribution-permission field against the scrub-redesign lane, sequenced per
  ruling 5.
- Update the doc comments that currently assert the stronger contract:
  `packages/plugin/src/visibility.ts` (header), `packages/plugin/src/schemas/episode.ts:300-302`
  ("W2 allowlist decision"), `packages/plugin/src/schemas/knowledge-hit.ts:28-31`.
- Optional hygiene, not required by any ruling: `publish.ts:478`'s hardcoded
  `retention.policy` should either carry the real local retention decision or be dropped from
  the published projection. A constant field that reads as a permission is a trap for the
  next reader, and it is the reason this gap went unnoticed.

## The product question, and its answer

Ruling 4 needs one product and legal call this record should not make: is the contributor
grant a single bit ("published means retrievable by anyone"), or a small vocabulary over
consumer classes (retrieval / training / redistribution)? That decides whether the field is a
boolean or an enumeration, and it is the only part of the design that turns on a commitment
to contributors rather than on the code.

**Recommendation:** a single grant now, a vocabulary when a second consumer class actually
exists and can be described precisely. A grant vocabulary invented ahead of its consumers
would be guessing at the classes, and the guess would be baked into signed records that
cannot be revised without re-minting — the precise failure this record diagnoses for
`retrievalVisible`. Adding a class to a vocabulary later is a schema-additive change;
retracting a class contributors relied on is not.

**Answer.** The operator ratified this record as proposed, which adopts the recommendation:
a single grant. No separate ruling was given on the boolean-versus-enumeration shape, so the
recommendation stands as the working answer rather than as an independently reasoned one —
enough to write the field against, and revisable while it is unwritten. The shape is fixed
when ruling 4 lands with the scrub-redesign lane (#1967 §6), which is also the last moment
it can change cheaply: after that the grant is minted into signed records.
