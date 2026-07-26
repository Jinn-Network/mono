# Jinn Evidence Repository Contract 0.1

## Scope

An Evidence Repository preserves and retrieves exact record and artifact bytes by
canonical SHA-256 identity. Records are partitioned into the three Evidence
Protocol record families. Artifacts are stored independently.

The contract standardizes persistence capabilities, not a storage layout or wire
protocol. Implementations can be local or remote.

## Repository capabilities

Every repository exposes one stable, immutable `capabilities` object for its
lifetime. The optional `maxObjectBytes` field, when present, is a positive safe
integer declaring the inclusive maximum accepted byte length for either a record
or an artifact. A repository must reject a larger object before external effects
with `EvidenceRepositoryError("CONTENT_TOO_LARGE")`.

An absent `maxObjectBytes` means that the repository declares no finite
application-level limit; it does not guarantee that arbitrarily large objects
will succeed. Consumers of version 0.1 must ignore unknown capability fields.
Implementations must nevertheless keep the entire capability snapshot,
including unknown fields, immutable.

## Identity and integrity

- A digest is the lowercase string `sha256:` followed by exactly 64 hexadecimal
  characters.
- `putRecord` and `putArtifact` compute identity from the exact input bytes.
- Repeating an identical write is successful and reports `existing`.
- Reads verify that returned bytes match the requested digest.
- An implementation must not return bytes known to be corrupt.
- Record family is registration metadata. It is not part of the content digest.

Repositories do not validate Evidence Protocol conformance as an admission rule.
Record validation remains a consumer responsibility.

## Results and failures

Missing content returns `null`. Other failures throw `EvidenceRepositoryError`
using one of these stable codes:

- `INVALID_REFERENCE`
- `CONTENT_CORRUPT`
- `REFERENCE_CONFLICT`
- `DEPENDENCY_UNAVAILABLE`
- `ACCESS_DENIED`
- `CONTENT_TOO_LARGE`
- `OPERATION_ABORTED`
- `IO_FAILURE`

An already-aborted signal must prevent the operation. Implementations should
propagate cancellation to underlying I/O when possible.

## Exclusions

Version 0.1 has no delete, retention, encryption, list, query, catalog, referrer,
evaluation-discovery, ranking, federation, conformance-policy, identity, or trust
API. The Evidence Protocol remains the only owner of semantic relationships
between stored records and artifacts.
