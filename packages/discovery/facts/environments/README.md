# @jinn-network/record-discovery-facts-environments

The record-discovery facts profile for the environment record kind, plus the recompute
function a consumer runs to re-derive that card from the record's own sealed bytes.

The card carries `source.repo`, `source.commit`, `image.manifestDigest`, `image.platform`,
and `build.reproducibilityTier`, alongside the record's own digest. `image.manifestDigest`
is declared reference-bearing so discovery's `referrers` relation inverts it: "find the
environment records about image `sha256:X`" is a first-class query.

Announcements confer no validity. A card is a filter-before-fetch hint; every decision-grade
use requires the fetched, digest-checked record.
