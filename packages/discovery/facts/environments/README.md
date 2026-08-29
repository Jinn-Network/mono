# @jinn-network/record-discovery-facts-environments

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

The record-discovery facts profile for the environment record kind, plus the recompute
function a consumer runs to re-derive that card from the record's own sealed bytes.

The card carries `source.repo`, `source.commit`, `image.manifestDigest`, `image.platform`,
and `build.reproducibilityTier`, alongside the record's own digest. `image.manifestDigest`
is declared reference-bearing so discovery's `referrers` relation inverts it: "find the
environment records about image `sha256:X`" is a first-class query.

Announcements confer no validity. A card is a filter-before-fetch hint; every decision-grade
use requires the fetched, digest-checked record.

## Join edges

Facts profiles must declare their kind's complete outbound-reference set (record-discovery
design §12, amendment 2026-08-28). `environment.v2` adds the three components v1 left out:
`parser.digest`, `image.indexDigest`, and `build.recipeDigest`. "Which environments run parser
`sha256:X`" is a query the card owes an index, and v1 could not answer it. A recipe satisfied by
a uri alone pins nothing and is not carried. v1 stays frozen and registered.

Each profile's `referenceBearingFields` is pinned in `profiles.test.ts`. That pin is a
change-detector authored from the same reading of the schema as the profile itself, not an
independent completeness proof; see the design amendment's *What enforces this*.
