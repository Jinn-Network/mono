# Distribution signal view (network explorer)

- **Version:** 0.1
- **Date:** 2026-07-02
- **Author:** Jinn contributor
- **Issue:** #1314 (plan Task 7, `spec/2026-07-02-jinn-harness-network.md` §7)
- **Design artifact:** `docs/design/artifacts/2026-07-02-1314-distribution-signal/` (PR #1328)

## Home surface — re-homed to the explorer

Issue #1314's domain-model delta originally targeted `client/OPERATOR-APP-SPEC.md`. The design
artifact moved the view into the **network explorer** (`packages/indexer/explorer`, Network view,
below the Activity strip) on the grounds that the signal answers a protocol-wide question — where
usage concentrates, hence where incentives should flow — which is the explorer's job (neutral,
legible, public), and that the view composes entirely from primitives the explorer already ships.
**Confirmed by Oak, 2026-07-02.** `OPERATOR-APP-SPEC.md` is unchanged; this spec is the view's
domain model per CLAUDE.md §Frontends.

## Domain model — component: Distribution signal

- **State**
  - Signal rows `{ cluster, envelopeCount, contributorCount, topTags }`, sorted by volume
    (descending; alphabetical tiebreak). Read-only, derived from the indexer's
    `capture_envelope_meta` table (IPFS-enriched `capture:<cid>` anchors).
  - Headline totals: counted envelopes, cluster count, distinct contributors (separately
    computed — per-cluster contributor counts overlap and do not sum).
  - Seed filter state: `envelope-only` (default) | `include seeded`. In the default state,
    `provenance: 'imported'` entries appear in **no** count; the excluded total is stated
    plainly next to the control.
- **State messages**
  - Empty corpus: `"No contributions yet — signal appears as the corpus grows."` Informational,
    no action.
  - Fetch failure: inline error with a `Retry` action (the Network view's own error affordance).
- **Collections**
  - Clusters as above. Rows with `envelopeCount ≤ 2` fold into the table's built-in low-volume
    section. No pagination in v0.
- **Actions**
  - Seed-filter toggle (`envelope-only` → `include seeded`): refetches with `?include=seeded` and
    folds seeded entries back into every number live — the demonstrate-it-live proof that seeds
    are not counted by default. No other actions; the view is read-only.

## Data path

`capture:<manifestCid>` MetadataSet anchors → in-handler two-hop IPFS enrichment (wrapper
envelope → `jinn.trace-envelope.v0` artifact) → `capture_envelope_meta` (tags, provenance,
contributor, summary, tier) → `GET /distribution-signal[?include=seeded]` (v0 tag-rollup
clustering: an envelope's first distribution tag is its cluster) → explorer section.

Clustering is deliberately crude (spec §8: crude counts are enough) and upstream-replaceable:
the endpoint owns the clustering; the view renders whatever it returns.

## Non-goals (v0)

- No verifiability-tier display (this is corpus volume, not scored results).
- No per-cluster deep links (flagged open question in the design notes).
- No operator-app surface (a summary card there is a possible follow-up, not in scope).
