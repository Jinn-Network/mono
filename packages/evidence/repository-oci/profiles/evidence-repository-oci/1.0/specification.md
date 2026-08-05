# Jinn Evidence Repository OCI Profile 1.0

Profile URI:
`https://spec.jinn.network/profiles/evidence-repository-oci/v1`

Profile version: `1.0.0`

## Scope

This profile maps one exact Jinn Evidence Repository record or artifact object
to an OCI Image Manifest and defines deterministic lookup tags. It composes the
Jinn Evidence Repository contract with OCI Image and Distribution 1.1.1. It is
not a catalog, discovery protocol, trust system, or semantic evidence format.

The Evidence Repository SHA-256 digest remains the canonical content identity.
The OCI manifest digest is a transport identity. A tag is only an untrusted
lookup alias.

## Manifest serialization

Conforming manifests MUST be serialized as RFC 8785 canonical JSON and MUST
contain exactly:

- `schemaVersion` equal to `2`;
- `mediaType` equal to
  `application/vnd.oci.image.manifest.v1+json`;
- the required versioned Jinn `artifactType`;
- the OCI empty JSON config descriptor for the two bytes `{}`, without inline
  `data`;
- exactly one layer containing the exact record or artifact bytes;
- exactly one annotation,
  `network.jinn.evidence.profile`, equal to this profile URI.

The manifest, config descriptor, layer descriptor, and annotations object MUST
NOT contain additional fields. In particular, a conforming generated manifest
has no timestamp, platform, `subject`, referrer, or mutable presentation
metadata.

The empty config descriptor is:

```json
{
  "mediaType": "application/vnd.oci.empty.v1+json",
  "digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  "size": 2
}
```

The content layer descriptor MUST use the Evidence Repository content digest,
the exact byte length, and the same media type as `artifactType`.

## Artifact types

| Repository object | OCI artifact type |
| --- | --- |
| Execution Evidence record | `application/vnd.jinn.execution-evidence.v1+json` |
| Result Evaluation record | `application/vnd.jinn.result-evaluation.v1+json` |
| Execution Verification record | `application/vnd.jinn.execution-verification.v1+json` |
| Generic artifact bytes | `application/vnd.jinn.evidence-artifact.v1` |

## Lookup tags

Tags are lowercase and deterministic:

```text
<record-family>-sha256-<64 lowercase hex characters>
artifact-sha256-<64 lowercase hex characters>
```

A consumer MUST validate the resolved manifest, layer digest, layer size, and
downloaded content bytes against the requested Evidence Repository reference.
It MUST NOT trust the tag target as identity.

## Distribution behavior

A publisher uploads the `{}` config blob and exact content blob before
publishing the canonical manifest under its deterministic tag. It MUST refuse
to replace a tag that already resolves to different content and MUST verify the
tag again after publication.

Authentication, authorization, credential storage, registry availability, and
retention are implementation concerns outside this profile.

## Standards

- [OCI Image Manifest 1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md)
- [OCI Distribution Specification 1.1.1](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md)
- [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
