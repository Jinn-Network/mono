# Jinn Evidence Repository IPFS Registration Profile v1

**Profile:** `jinn.evidence-repository.ipfs-registration`

**Version:** `1`

This profile preserves the namespaces of
`@jinn-network/evidence-repository` when exact objects are stored as CIDv1
raw SHA2-256 blocks.

## Content blocks

An evidence record or artifact is stored as one raw block. Its CID is:

```text
CIDv1(0x01) || raw(0x55) || sha2-256(0x12) || 32(0x20) || digest
```

The canonical emitted text is lowercase base16:

```text
f01551220<64 lowercase hexadecimal digest characters>
```

The repository object is at most 2,097,152 bytes. This limit is inclusive.
The profile does not use UnixFS, DAG-PB wrapping, chunking, mutable indexes,
or `allow-big-block`.

## Registration blocks

A record is registered by the following exact UTF-8 JSON Lines value:

```json
{"digest":"sha256:<hex>","family":"execution-evidence","kind":"record","profile":"jinn.evidence-repository.ipfs-registration","version":1}
```

`family` is exactly one of:

- `execution-evidence`
- `result-evaluation`
- `execution-verification`

An artifact is registered by:

```json
{"digest":"sha256:<hex>","kind":"artifact","profile":"jinn.evidence-repository.ipfs-registration","version":1}
```

Each serialized value:

- uses the key order shown;
- contains no BOM or insignificant whitespace;
- ends with exactly one LF byte;
- uses a canonical lowercase `sha256:<64 hex>` digest; and
- has no additional fields.

The registration is stored as another CIDv1 raw SHA2-256 block. Its CID is
computed over the exact JSON Lines bytes. Both the registration CID and
content CID are therefore derivable from the repository reference alone.

Registration blocks express repository namespace membership only. They are
not Evidence Protocol records, announcements, collection manifests, or
retention commitments.

## Reads

A read first derives and retrieves the registration block. An absent
registration means that reference is absent, even if the raw content block
exists. Present noncanonical registration bytes are corrupt. A present
registration with absent or digest-mismatched content is corrupt.

This preserves all three record-family namespaces and the artifact namespace
without a lookup index.
