# `@jinn-network/evidence-retrieval`

A host-neutral, in-process application library that turns known references or
provider-owned candidate queries into exact, digest-verified,
Protocol-conforming Evidence results, with explicit provenance, artifact
state, bounded failures, and replay metadata.

## Ownership boundary

Retrieval is a thin orchestration layer over the existing Evidence Protocol,
Repository, and Discovery contracts. Candidate providers keep their own
query types, stores, indexes, ranking, cursors, checkpoints, and combination
logic; Retrieval preserves their ordering and provenance while owning
canonical deduplication, bounded location fallback, exact-byte verification,
family validation, optional artifact hydration, and typed outcomes. Retrieval
does not run a search engine, a vector database, or a rank-fusion algorithm,
and it never writes Protocol records, Repository objects, Catalog
projections, indexes, or caches. See
[`specification.md`](./specification.md) for the full normative boundary.

## Documentation

See [`specification.md`](./specification.md) for the package's approved
operations, invariants, typed failure classes, and explicit non-goals.
