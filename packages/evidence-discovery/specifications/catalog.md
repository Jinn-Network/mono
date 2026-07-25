<!-- SPDX-License-Identifier: MIT -->
# Evidence Catalog Contract 1.0

The Catalog is disposable derived state. It stores immutable, record-scoped
projections of conforming Evidence Protocol records and current observations of
where those exact records were available. The Evidence Repository remains the
authority for exact bytes.

Each projection is attributable to one `EvidenceRecordReference`. Reusing that
reference with an unequal projection is a conflict. Equal replay is idempotent.
Entity identifiers are lookup keys only: records that mention the same
Execution or Agent remain independently inspectable and are never merged.

Readers expose exact lookup and bounded cursor-paginated queries. Typed
collection queries include only records with an active location by default;
`availability: "any"` also includes known-unavailable records. Exact
`getRecord` may return a known projection without an active location.
`startedAfter`, `evaluatedAfter`, and `verifiedAfter` are exclusive lower
bounds; the corresponding `Before` values are exclusive upper bounds.

Writers atomically publish complete validated projections. Location
observations are scoped to `(sourceId, announcementId)`. Withdrawals deactivate
only a prior available event from the same source, and a location remains
active while any observation supports it.

## DCAT 3 alignment

| Discovery concept | DCAT-aligned role |
| --- | --- |
| Exact evidence record | Cataloged resource |
| Exact bytes at a binding locator | Distribution |
| Repository endpoint or binding | Data service |
| Projection and active observations | Catalog registration metadata |

This alignment does not add RDF storage or serialization.

The contract excludes authoritative bytes, persistence bindings, trust,
ranking, corpus membership, full-text or vector search, policy, globally
canonical entities, retention, and repository credentials or private paths.
