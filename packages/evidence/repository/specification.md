# Jinn Evidence Repository Contract 0.1

## Scope

An Evidence Repository preserves and retrieves exact record and artifact bytes by
canonical SHA-256 identity. Records are partitioned into the three Evidence
Protocol record families. Artifacts are stored independently.

The contract standardizes persistence capabilities, not a storage layout or wire
protocol. Implementations can be local or remote.

## Repository capabilities

The repository is not a Proxy. It exposes `capabilities` as a stable own data
property for its lifetime; an inherited or accessor-backed slot is invalid. The
slot descriptor may be writable or configurable to accommodate ordinary class
fields, but repeated observations must retain the same capability object value.

The capability snapshot is not a Proxy. It has exactly `Object.prototype` or
`null` as its prototype, is non-extensible, and exposes only own data
descriptors that are non-writable and non-configurable. Accessor-backed fields
are invalid. Consumers of version 0.1 semantically ignore unknown own keys, but
those keys remain subject to the same representation and immutability rules.

The optional `maxObjectBytes` field, when present as an own data descriptor, is
a positive safe integer declaring the inclusive maximum accepted byte length
for either a record or an artifact. A present value of `undefined` is invalid.
Only an absent own descriptor means that the repository declares no finite
application-level limit; absence does not guarantee that arbitrarily large
objects will succeed. An inherited `maxObjectBytes` is invalid and is never
evaluated. A repository must reject a larger object before external effects with
`EvidenceRepositoryError("CONTENT_TOO_LARGE")`.

The reusable contract kit validates these representations and rejects invalid
behavior before invoking repository methods, capability accessors, or inherited
behavior.

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
