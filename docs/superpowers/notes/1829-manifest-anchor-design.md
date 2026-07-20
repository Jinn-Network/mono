# Design note — `manifest:` anchor record type + consumer enumeration + gas measurement (#1829)

Version: 0.1 · Date: 2026-07-17 · Shape: feat (Medium) · Author: DESIGN subagent (#1829)

## Context / ratified position

Per `docs/superpowers/specs/2026-07-17-corpus-supply-design.md` §9 and DR-2026-07-17 Decision 5,
bulk substrate batches (bridge output; reference-record batches) get **one manifest record per
raw-block-sized partition** instead of one anchor per member. Per-record anchors stay for retrieval-tier + genuinely
contributed evidence. No new contract — still `IdentityRegistry.setMetadata`, one tx per partition, in
its own `manifest:` namespace (out of `capture:`). Members stay content-addressed on IPFS and
fetch-by-CID as today; discovery sees the manifest; consumers enumerate members from its body; any
single member is provable against a merkle root anchored in the record. First bridge batch doubles
as the gas measurement — no gas number is asserted until measured.

## How the existing surfaces work (verified)

- **Per-record anchor path.** `client/packages/harness-layer/src/publish.ts` `publish()` uploads
  each member envelope to IPFS (getting `envelopeRef` = CID) **and** anchors it individually via
  `deps.anchorEnvelope({ metadataKey: `capture:${cid}`, … })`. The bridge
  (`bridge.ts` `bridgeAttempts` → `buildBridgeEvidencePublisher` → `publish()`) does one upload + one
  anchor per attempt. This is exactly the per-member anchor the manifest replaces for bulk batches.
- **The anchor write.** `deps.anchorEnvelope` (wired in `publish-live.ts` `createLivePublishDeps`)
  builds an `ExecutionPayloadV2` and calls `IdentityPublisher.publishContentV2` →
  `IdentityRegistry.setMetadata(agentId, "capture:<cid>", encoded)` from the agent EOA
  (`client/src/erc8004/identity.ts`).
- **Namespace precedent.** `ContentKind` (`envelope|evaluation|capture|skill`) carries the
  execution-payload tuple, but the repo already has **plain-value** namespaces that are NOT
  ContentKinds and do NOT encode an execution payload: `plugin:` (`erc8004/plugin-registry.ts`, its
  own ABI tuple + key builder + Safe-routed publisher), `solvernet-manifest:`, `harness.checkpoint:`.
  `manifest:` follows `plugin-registry.ts` as its template — a self-contained registry module, not a
  new `ContentKind`.
- **Indexer (read-only).** `packages/indexer/src/types.ts` `parseEnvelopeKey` only admits
  `envelope|evaluation|capture|skill`; other namespaces get their own `parse*Key` (e.g.
  `parseSolverNetManifestKey`, `parsePluginKey`). A `manifest:` record is visible to the indexer as a
  raw `MetadataSet` event today; consumer enumeration in this issue is **client-side** (reads the
  manifest body from IPFS by the anchored CID), so no indexer change is required to satisfy the ACs.
  A follow-up indexer `parseManifestKey` + member fan-out is out of scope here (issue says indexer
  read-only) and is left to B4.
- **Merkle libs.** No merkle util exists in-repo (`grep merkle` → only an unrelated `corpusSnapshotCid`).
  `viem` (already a dep, `^2`) supplies `keccak256`, `toBytes`, `concat`, `bytesToHex` — enough to
  build a minimal binary merkle tree with zero new dependencies. Do NOT add `@openzeppelin/merkle-tree`
  or `merkletreejs` (Rule 2 — reuse existing deps).

## Chosen approach

**Manifest body (uploaded to IPFS, the CID is what gets anchored).** A new
`jinn.manifest.v0` JSON artifact:

```
{
  schemaVersion: "jinn.manifest.v0",
  batchKind: "bridge",                 // "bridge" | "reference-record" (free string; discovery hint)
  createdAt: <unix-seconds>,
  merkleRoot: "0x…32 bytes",           // root over member leaves (below)
  members: [
    { cid: "<member envelope CID>", sha256: "<hex>", polarity?: "pass"|"fail", instanceId?: "…" }
    // one entry per batch member, in insertion order (= leaf order)
  ]
}
```

`members[].sha256` mirrors what the per-record path already records; the extra fields are optional
discovery hints. The body is uploaded via the existing `publishArtifact`/`uploadToIpfs` path (same
`canonicalJson` + sha256 convention), yielding `manifestCid`.

**Merkle construction (minimal, in-repo).** New `client/src/erc8004/merkle.ts`:
- **Leaf** = `keccak256(utf8Bytes(member.cid))`. Leaf-over-CID (not over full body) is what §9 calls
  for ("merkle root over member CIDs") and is what an inclusion proof needs — the CID is the
  content-address, so proving a CID is in the batch is the whole guarantee (the CID itself binds the
  bytes).
- **Tree** = standard binary merkle: sort leaves? **No** — preserve `members[]` order so the proof
  can carry a leaf index and be re-derivable from the body; duplicate the last leaf when a level has
  an odd count (documented, deterministic). Parent = `keccak256(concat(left, right))`.
- **Root** = `merkleRoot(leaves)` → the `0x…` written into the manifest body AND used as the on-chain
  commitment value.
- **Proof** = `merkleProof(leaves, index)` → `{ index, siblings: Hex[] }`.
- **Verify** = `verifyMerkleProof(leafCid, proof, root)` → recomputes leaf, folds siblings by
  index-parity, compares to root. Pure function, no chain read.

**On-chain anchor (one setMetadata per raw-block-sized partition).** New `client/src/erc8004/manifest-registry.ts`
(template: `plugin-registry.ts`):
- `MANIFEST_METADATA_KEY_PREFIX = 'manifest:'`; `buildManifestMetadataKey(manifestCid)` → `manifest:<cid>`.
- Payload ABI tuple `MANIFEST_PAYLOAD_TUPLE = (uint16 version, bytes32 merkleRoot, uint32 memberCount, uint64 createdAt)`;
  `encodeManifestPayload` / `decodeManifestPayload`. Anchoring the root on-chain (not just in the IPFS
  body) is the Legibility commitment — an inclusion proof verifies against the *on-chain* root, so the
  IPFS body cannot be swapped after the fact.
- Publisher: reuse `IdentityPublisher._writeMetadata` shape. Cleanest is to add a
  `publishManifest({ manifestCid, payload })` method to the existing `IdentityPublisher` (it already
  owns the EOA `setMetadata` broadcast lock / nonce ledger the bridge shares) rather than a second
  publisher class — keeps the single-EOA nonce discipline. `manifest-registry.ts` owns the key +
  encode/decode + validation; `IdentityPublisher` owns the write. (The plugin path uses a Safe; the
  bridge anchors from the agent EOA, so reusing `IdentityPublisher` is the right seam.)

**Batch publish flow (bridge side).** Add a batch mode to the harness-layer publish path:
1. For each member: upload the envelope to IPFS **without** anchoring (the existing `publish()`
   couples upload+anchor; factor the upload+build into a reusable `publishMemberEnvelope()` that
   returns `{ envelopeRef, sha256, envelope }` and skips `anchorEnvelope`).
2. Collect member CIDs → build leaves → `merkleRoot`.
3. Build + upload the `jinn.manifest.v0` body with IPFS raw leaves → `manifestCid` (the CID
   multihash therefore commits directly to the canonical body bytes).
4. `identityPublisher.publishManifest({ manifestCid, payload: { version, merkleRoot, memberCount, createdAt } })`
   → **one** `setMetadata` tx.
5. Record the anchor (reuse `store.saveErc8004Anchor` with `contentKind: 'manifest'`, `metadataKey:
   manifest:<cid>`, `payloadHex`) and append one ledger row per member (`anchorTx` = the shared
   manifest tx for all members in the batch; `envelopeRef` = member CID).

Wire this as a `bridgeAttempts` option (`deps.anchorMode: 'per-record' | 'manifest'`, default
`'per-record'` to preserve current behavior) so the bridge can opt bulk output into batch anchoring
without changing the contributed-record path.

**Consumer enumeration + inclusion proof (read side).** New `client/src/erc8004/manifest-consumer.ts`
(pure, client-side; no indexer dependency):
- `fetchManifest(manifestCid, ipfsGet)` → parse + validate `jinn.manifest.v0` (Zod schema in a new
  `client/src/types/manifest.ts`), verify the canonical body digest against the manifest CID, then
  **re-derive the merkle root from `members[]` and assert it equals the anchored root** (fetched via
  `readManifestAnchor(manifestCid)` — a `getMetadata`/indexer read) before trusting the body. CID or
  root mismatch → throw (tamper-evident).
- `enumerateMembers(manifest)` → the member list (CIDs are then fetch-by-CID as today).
- `proveMember(manifest, memberCid)` → `{ proof, root }`; `verifyMember(memberCid, proof, anchoredRoot)`
  → boolean (delegates to `merkle.ts` `verifyMerkleProof`). This is the "a member is verifiable
  against the anchored root" AC.

**Gas measurement (first batch = the measurement).** No new util needed; `measurement.ts` is a
statistical (McNemar) analyzer and does not fit. `IdentityPublisher._writeMetadata` already fetches
the receipt (`blockNumber`); extend the return to surface `gasUsed`/`effectiveGasPrice` from the same
receipt, and have the batch publish flow log + record them:
- Log one line per anchor: `[manifest] batch anchored cid=<…> members=<N> gasUsed=<…> feeWei=<…>`.
- Persist to the anchor row (add nullable `gasUsed` / `feeWei` columns to the `erc8004_anchors` store
  insert, or record in the ledger row) so the first real bridge batch's per-manifest cost is captured
  and, alongside a single per-record anchor from the same run, gives the per-anchor-vs-per-manifest
  comparison §9 asks for. The extra control is explicit
  (`--measure-per-record-control`) and reuses the first already-uploaded signed member; ordinary
  manifest runs remain exactly N uploads → one anchor transaction per raw-block-sized partition. **Assert no gas figure in docs
  until this run produces it** — record the measured numbers back into §9 / the issue as the
  measurement deliverable (a follow-up doc edit, not a fabricated constant).

## Key trade-offs

- **Reuse `IdentityPublisher` vs. a new publisher class.** Reuse — the bridge anchors from the agent
  EOA and must share the existing nonce ledger / broadcast lock (the #525 stall lesson in
  `identity.ts`). A parallel publisher would re-race the nonce. `plugin-registry.ts` uses a *Safe*
  publisher because plug-ins bind to the Safe owner; the manifest anchor has no such requirement.
- **Leaf = keccak256(CID) vs. keccak256(body).** CID — §9 says "root over member CIDs", and the CID is
  already the content-address (it binds the bytes), so a CID-inclusion proof + fetch-by-CID gives the
  full member-provability guarantee with the smallest leaf.
- **Order-preserving vs. sorted leaves.** Order-preserving with last-leaf duplication for odd levels —
  lets the proof carry a leaf index and be re-derived directly from `members[]`; avoids a sorted-pair
  convention consumers would also have to encode. Documented as the tree's fixed rule.
- **Root anchored on-chain AND in body.** Both — the on-chain root is the trust anchor; the body root
  is a convenience for offline re-derivation. `fetchManifest` cross-checks them, so a swapped IPFS body
  is caught.
- **Indexer left read-only.** Client-side enumeration satisfies every AC without touching the indexer.
  A `parseManifestKey` + member fan-out in the indexer is deferred to B4 (the consuming issue), keeping
  this change surgical.
- **Default `per-record`.** The batch mode is opt-in on the bridge so contributed/retrieval records are
  untouched; only bulk bridge/reference batches flip to `manifest`.

## Files to create / modify

Create:
- `client/src/erc8004/merkle.ts` — `merkleRoot(leaves)`, `merkleProof(leaves, index)`,
  `verifyMerkleProof(leafCid, proof, root)`, leaf = `keccak256(utf8(cid))`; viem-only.
- `client/src/erc8004/manifest-registry.ts` — `MANIFEST_METADATA_KEY_PREFIX`,
  `buildManifestMetadataKey`, `parseManifestMetadataKey`, `MANIFEST_PAYLOAD_TUPLE`,
  `encodeManifestPayload` / `decodeManifestPayload`, `validateManifestPayload`,
  `ManifestPayloadValidationError` (template: `plugin-registry.ts`).
- `client/src/erc8004/manifest-consumer.ts` — `fetchManifest` (with anchored-root cross-check),
  `enumerateMembers`, `proveMember`, `verifyMember`, `readManifestAnchor`.
- `client/src/types/manifest.ts` — Zod `ManifestV0Schema` (`jinn.manifest.v0` body).
- Tests: `client/src/erc8004/merkle.test.ts` (root/proof/verify incl. odd-count + tamper),
  `client/src/erc8004/manifest-registry.test.ts` (key + payload round-trip + validation),
  `client/src/erc8004/manifest-consumer.test.ts` (enumerate + verify against root + root-mismatch throw),
  and a harness-layer `client/packages/harness-layer/test/bridge-manifest.test.ts` (batch anchor mode:
  N members → 1 anchor tx, every member proves).

Modify:
- `client/src/erc8004/identity.ts` — add `publishManifest({ manifestCid, payload })` to
  `IdentityPublisher` (uses `_writeMetadata`); surface `gasUsed`/`feeWei` on `PublishContentResult`
  from the existing receipt.
- `client/src/erc8004/index.ts` — export the new merkle / manifest-registry / manifest-consumer surface.
- `client/packages/harness-layer/src/publish.ts` — factor member upload+build out of `publish()` into
  `publishMemberEnvelope()` (upload, no anchor); add `publishManifestBatch(members, deps)` that uploads
  members, builds root, uploads manifest body, anchors once, records store + ledger.
- `client/packages/harness-layer/src/bridge.ts` — add `anchorMode` to `BridgeDeps`
  (default `'per-record'`); in `'manifest'` mode collect member CIDs and call `publishManifestBatch`
  once after the loop instead of per-attempt `publishEvidence`; extend `BridgeResult` with
  `manifestCid` + `anchorTx` (shared) + measured `gasUsed`/`feeWei`.
- `client/packages/harness-layer/src/publish-live.ts` — expose the shared `IdentityPublisher` (or an
  `anchorManifest` dep) so the batch path can anchor through the same EOA publisher.
- `client/packages/harness-layer/src/cli.ts` — surface the batch mode / print the measured gas line on
  the `bridge`/`distill` command; `--anchor-mode manifest`.
- `client/src/store/store.ts` — accept `contentKind: 'manifest'` and (nullable) `gasUsed`/`feeWei` on
  the `erc8004_anchors` insert.

## Acceptance-criterion mapping

- **`manifest:` record type implemented** → `manifest-registry.ts` (`manifest:` key + payload tuple) +
  `IdentityPublisher.publishManifest` → one `setMetadata` per batch, no new contract.
- **Consumer enumeration implemented** → `manifest-consumer.ts` `fetchManifest` + `enumerateMembers`
  (reads members from the anchored manifest body; members fetch-by-CID as today).
- **A member is verifiable against the anchored root** → `merkle.ts` `verifyMerkleProof` +
  `manifest-consumer.ts` `proveMember`/`verifyMember`, verified against the **on-chain** root
  (`fetchManifest` cross-checks body root == anchored root).
- **Gas measured and recorded (first batch = the measurement)** → `IdentityPublisher` surfaces
  `gasUsed`/`feeWei` from confirmed successful receipts; batch flow logs + persists per-manifest and
  the explicit first-member per-record control in separate rows; numbers recorded back into §9 / the
  issue after the first real bridge batch — none asserted before measurement.
