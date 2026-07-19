# Implementation plan — `manifest:` anchor record type + consumer enumeration + gas measurement (#1829)

Version: 1.0 · Date: 2026-07-17 · Shape: feat (Medium) · Author: PLANNING subagent (#1829)

Turns the ratified design note (`docs/superpowers/notes/1829-manifest-anchor-design.md`) into an
ordered, test-first (TDD) implementation plan. Every step is small and independently verifiable.
Verification command throughout: `cd client && yarn test` (run the touched file(s) with
`yarn test <path>` while iterating; full `yarn test` + `yarn typecheck` before completion).

## Design-claim verification (done before planning)

All four surface claims in the design note were read and confirmed accurate against the worktree:

- ✅ `client/packages/harness-layer/src/publish.ts` — `publish()` **couples upload + anchor**: it
  uploads each artifact via `deps.publishArtifact`, uploads the wrapper via `deps.publishEnvelope`,
  then anchors via `deps.anchorEnvelope({ metadataKey: \`capture:${envelopeRef}\`, … })` (lines
  245–253). Factoring an anchor-free `publishMemberEnvelope()` out of this is straightforward.
- ✅ `client/src/erc8004/identity.ts` — `IdentityPublisher._writeMetadata` (lines 537–590) owns the
  EOA `setMetadata` broadcast lock / nonce ledger via `viemSendTransactionWithRetry` (the #525
  stall fix), and **already fetches the receipt** with `waitForTransactionReceipt` (line 582), from
  which it reads `blockNumber`. Surfacing `gasUsed` + `effectiveGasPrice` is a pure extension of the
  same receipt — no new RPC round-trip. `PublishContentResult` is the shared return type (lines
  142–145).
- ✅ `client/src/erc8004/plugin-registry.ts` — a self-contained plain-value namespace registry
  module (key prefix `plugin:`, ABI tuple in `abis.ts`, key builder, encode/decode, validator,
  `PluginPayloadValidationError`). Valid template for `manifest-registry.ts`. Note: its **publisher**
  routes through a **Safe** (`executeSafeTransaction`); the manifest anchor deliberately does NOT
  reuse that publisher — it reuses `IdentityPublisher` (EOA) per the design's nonce-discipline
  trade-off. `manifest-registry.ts` copies only the key/encode/decode/validate half.
- ✅ `client/src/store/store.ts` — `saveErc8004Anchor` (line 2925) INSERTs into `erc8004_anchors`;
  `content_kind` is a plain `TEXT` column (line 529) with **no CHECK/enum constraint**, so
  `contentKind: 'manifest'` already inserts with zero schema change. The `gasUsed`/`feeWei` columns
  are new and need an additive migration — the codebase's established pattern is
  `PRAGMA table_info(<table>)` + `ALTER TABLE … ADD COLUMN` in an `ensure*Columns()` helper called
  from the constructor (see `ensureNetworkArtifactsPeerCatalogId`, lines 669–678).

Two corrections/clarifications to fold into implementation (design not wrong, just under-specified):

1. **Store gas columns need a migration, not just an insert change.** Add
   `ensureErc8004AnchorGasColumns()` (mirrors `ensureNetworkArtifactsPeerCatalogId`) so existing
   on-disk operator DBs get the nullable `gas_used` / `fee_wei` columns additively. New DBs also get
   them via the `CREATE TABLE` DDL update. Both paths in the same step.
2. **`abis.ts` is where payload tuples live** (`PLUGIN_PAYLOAD_TUPLE`, `PAYLOAD_TUPLE`, etc., lines
   75–102). Put `MANIFEST_PAYLOAD_TUPLE` there for consistency, and re-export it from
   `manifest-registry.ts` (the way `identity.ts` re-exports `PAYLOAD_TUPLE`).

## Pinned merkle construction rules (implementer AND tests MUST agree on these)

These are fixed by the design and are the single source of truth for `merkle.ts` and every test:

- **Leaf** = `keccak256(utf8Bytes(member.cid))` — the leaf is the keccak of the UTF-8 bytes of the
  textual CID string, NOT the CID's own multihash bytes and NOT the member body. Use viem
  `keccak256(toBytes(cid))` (viem `toBytes` on a string yields its UTF-8 bytes).
- **Order-preserving** — leaves are in `members[]` insertion order. Do NOT sort. The proof carries a
  leaf index and must be re-derivable directly from `members[]`.
- **Odd level → duplicate the last node** — when a level has an odd node count, the last node is
  paired with itself (`parent = keccak256(concat(last, last))`). Deterministic, documented.
- **Parent** = `keccak256(concat(left, right))` where `left`/`right` are the raw 32-byte hashes
  (viem `concat([left, right])` then `keccak256`), left = lower index.
- **Root** of a single-leaf tree = that leaf (no hashing pass). Root of an empty leaf set is an
  error (a batch must have ≥1 member).
- **Proof** = `{ index: number, siblings: Hex[] }` — siblings bottom-up; at each level the sibling is
  the node paired with the current node (its duplicate when it was the odd last node).
- **Verify** folds the leaf up by index parity: at each level, if the running index is even the
  sibling is the right operand, else the left; halve the index (`floor(index/2)`) each level; compare
  the final hash to the supplied root.

## Testability legend

- **[pure]** — no IPFS, no chain; unit-testable with literal inputs.
- **[mock-ipfs]** — needs an injected `ipfsGet`/`publishArtifact` stub (in-memory).
- **[mock-chain]** — needs a mocked viem `publicClient`/`walletClient` or a stub `anchorManifest`
  dep returning a fake receipt.

---

## Step 1 — `merkle.ts` (pure leaf module) · [pure]

**Build:** `client/src/erc8004/merkle.ts` with:
- `hashLeaf(cid: string): Hex` = `keccak256(toBytes(cid))`.
- `merkleRoot(leaves: Hex[]): Hex` — build the tree per the pinned rules; throw on empty.
- `merkleProof(leaves: Hex[], index: number): { index: number; siblings: Hex[] }` — throw on
  out-of-range index.
- `verifyMerkleProof(leafCid: string, proof: { index; siblings }, root: Hex): boolean` — recompute
  leaf via `hashLeaf`, fold, compare (case-insensitive hex compare).
- viem-only imports (`keccak256`, `toBytes`, `concat`, `type Hex`). NO new dependency.

**Test (write first):** `client/src/erc8004/merkle.test.ts` asserts:
1. Single leaf: `merkleRoot(['a-cid'])` === `hashLeaf('a-cid')`.
2. Two leaves: root === `keccak256(concat(hashLeaf(a), hashLeaf(b)))` (hand-computed via viem in the
   test, so the test independently derives the expected value).
3. Odd count (3 leaves): the last leaf is duplicated at level 0 → verify a fixed expected root shape
   (derive it in-test from the rule, don't hardcode a magic hex).
4. `merkleProof` + `verifyMerkleProof` round-trip for **every** index of a 1-, 2-, 3-, and 5-leaf
   tree (5 exercises two odd-count levels).
5. Tamper: `verifyMerkleProof(wrongCid, proof, root)` === `false`; a proof with a mutated sibling ===
   `false`.
6. Empty leaves → `merkleRoot([])` throws.

**AC satisfied:** foundation for "a member is verifiable against the anchored root".

---

## Step 2 — `abis.ts` + `manifest-registry.ts` (namespace module) · [pure]

**Build:**
- Add to `client/src/erc8004/abis.ts`:
  `MANIFEST_PAYLOAD_TUPLE = [{version:'uint16'},{merkleRoot:'bytes32'},{memberCount:'uint32'},{createdAt:'uint64'}]`.
- New `client/src/erc8004/manifest-registry.ts` (template: `plugin-registry.ts`, **key/encode/decode
  half only — no publisher class**):
  - `MANIFEST_METADATA_KEY_PREFIX = 'manifest:'`.
  - `buildManifestMetadataKey(manifestCid: string): string` → `manifest:<cid>` (throw on empty cid).
  - `parseManifestMetadataKey(key: string): { manifestCid: string } | null` (mirror
    `parseMetadataKey` shape; returns null when the prefix doesn't match).
  - `interface ManifestPayload { version: 0; merkleRoot: Hex; memberCount: number; createdAt: number }`
    (version pinned to the on-chain schema; `jinn.manifest.v0` body carries its own `schemaVersion`
    string — keep these distinct, the on-chain `version` is the uint16 tuple version).
  - `validateManifestPayload(p): ManifestPayload` — merkleRoot is 32-byte hex; memberCount is a
    positive integer ≤ uint32 max; createdAt is a non-negative integer ≤ uint64 max; throw
    `ManifestPayloadValidationError` (own error class, mirrors `PluginPayloadValidationError`).
  - `encodeManifestPayload(p): Hex` (validate then `encodeAbiParameters(MANIFEST_PAYLOAD_TUPLE, …)`).
  - `decodeManifestPayload(hex: Hex): ManifestPayload` (`decodeAbiParameters` → back to plain values;
    validate on the way out).

**Test (write first):** `client/src/erc8004/manifest-registry.test.ts` asserts:
1. `buildManifestMetadataKey('bafy…')` === `'manifest:bafy…'`; empty cid throws.
2. `parseManifestMetadataKey('manifest:bafy…')` → `{ manifestCid: 'bafy…' }`; a `capture:…` key →
   `null`.
3. `encode` → `decode` round-trips every field exactly (pick a real 0x-root, memberCount=7,
   createdAt).
4. Validation: bad root length throws; memberCount=0 throws; memberCount > uint32 throws; negative
   createdAt throws.

**AC satisfied:** "`manifest:` record type implemented" (the key + payload half; the write is Step 5).

---

## Step 3 — `types/manifest.ts` (Zod body schema) · [pure]

**Build:** `client/src/types/manifest.ts`:
- `ManifestMemberSchema` = `{ cid: string (non-empty), sha256: string (hex), polarity?: 'pass'|'fail',
  instanceId?: string }`.
- `ManifestV0Schema` = `{ schemaVersion: z.literal('jinn.manifest.v0'), batchKind: string,
  createdAt: number (int ≥ 0), merkleRoot: hex-32-byte string, members: ManifestMemberSchema[] (≥1) }`.
- Export `type ManifestV0 = z.infer<…>` and `MANIFEST_SCHEMA_VERSION = 'jinn.manifest.v0'`.
- `parseManifestV0(u: unknown): ManifestV0` = `ManifestV0Schema.parse(u)`.

**Test (write first):** `client/src/types/manifest.test.ts` (co-located, small) asserts:
1. A valid body parses and echoes its fields.
2. Wrong `schemaVersion` literal rejects.
3. Empty `members` rejects.
4. A member missing `cid` rejects; optional `polarity`/`instanceId` may be omitted.

**AC satisfied:** body contract for enumeration + verification (Steps 4/6 build on it).

---

## Step 4 — `IdentityPublisher.publishManifest` + gas on the receipt · [mock-chain]

**Build:** `client/src/erc8004/identity.ts`:
- Extend `PublishContentResult` with `gasUsed: bigint | null` and `feeWei: bigint | null` (nullable
  when the receipt fetch fails — same fail-soft posture as `blockNumber`).
- In `_writeMetadata`, after `waitForTransactionReceipt`, also read
  `gasUsed = receipt.gasUsed` and `feeWei = receipt.gasUsed * receipt.effectiveGasPrice` (guard
  `effectiveGasPrice` — some receipts omit it; if absent, `feeWei = null`, keep `gasUsed`). Return
  them on every result (existing `publishContent`/`publishContentV2` callers get the new fields for
  free; they ignore them).
- Add `interface ManifestPublishArgs { manifestCid: string; payload: ManifestPayload }` and
  `async publishManifest(args): Promise<PublishContentResult>` — builds
  `buildManifestMetadataKey(args.manifestCid)`, encodes via `encodeManifestPayload`, calls the
  private `_writeMetadata`. This shares the exact same nonce/broadcast lock the bridge EOA uses.
- Import `buildManifestMetadataKey`, `encodeManifestPayload`, `type ManifestPayload` from
  `./manifest-registry.js`.

**Test (write first):** `client/src/erc8004/identity.manifest.test.ts` (new file so it doesn't fight
existing identity tests) asserts, with a **stubbed** `walletClient`/`publicClient` (mock
`viemSendTransactionWithRetry` seam is internal — instead inject a fake `publicClient` whose
`waitForTransactionReceipt` returns `{ blockNumber, gasUsed, effectiveGasPrice }` and a fake
`walletClient` with `account`+`chain`; the existing identity tests show the mock shape to copy):
1. `publishManifest` calls `setMetadata` with the `manifest:<cid>` key and the ABI-encoded payload
   (assert the calldata / captured args).
2. The returned result carries `gasUsed` and `feeWei = gasUsed * effectiveGasPrice`.
3. Receipt fetch failure → `gasUsed`/`feeWei`/`blockNumber` all `null`, `txHash` still returned.

Note: if mocking `viemSendTransactionWithRetry` is awkward, follow whatever seam the existing
`identity.test.ts` uses to fake the tx send; match it rather than inventing a new one.

**AC satisfied:** "`manifest:` record type implemented" (the write) + the CODE half of "gas measured".

---

## Step 5 — `erc8004/index.ts` barrel exports · [pure]

**Build:** `client/src/erc8004/index.ts` — export the new surface:
- from `./merkle.js`: `hashLeaf`, `merkleRoot`, `merkleProof`, `verifyMerkleProof`.
- from `./manifest-registry.js`: `MANIFEST_METADATA_KEY_PREFIX`, `buildManifestMetadataKey`,
  `parseManifestMetadataKey`, `encodeManifestPayload`, `decodeManifestPayload`,
  `validateManifestPayload`, `ManifestPayloadValidationError`, `type ManifestPayload`.
- from `./abis.js`: `MANIFEST_PAYLOAD_TUPLE`.
- from `./identity.js`: `type ManifestPublishArgs` (add to the existing identity export block).
- `./manifest-consumer.js` exports are added in Step 6 (defer to keep the barrel compiling
  incrementally; or add both here and land the consumer file in Step 6 — either order compiles as
  long as the file exists before the export).

**Test:** covered by `yarn typecheck` (the barrel is type-only surface) + any downstream test that
imports from `../erc8004/index.js`. No dedicated test file.

**AC satisfied:** makes the namespace surface consumable (supports every AC).

---

## Step 6 — `manifest-consumer.ts` (read side) · [pure] + [mock-chain for the cross-check]

**Build:** `client/src/erc8004/manifest-consumer.ts`:
- `readManifestAnchor(manifestCid, deps): Promise<{ merkleRoot: Hex; memberCount: number } | null>` —
  reads the on-chain anchor value via an injected `getMetadata` dep (a
  `(agentId, metadataKey) => Promise<Hex | null>` port; production wires `IdentityRegistry.getMetadata`
  or a discovery read, tests stub it), decodes with `decodeManifestPayload`. Null when not found.
- `fetchManifest(manifestCid, deps): Promise<ManifestV0>` — `deps.ipfsGet(manifestCid)` → JSON →
  `parseManifestV0` → **re-derive** the root from `members[].cid` via `merkleRoot(members.map(hashLeaf))`
  → fetch the anchored root via `readManifestAnchor` → **assert body root === re-derived root ===
  anchored root**; throw a `ManifestRootMismatchError` on any mismatch (tamper-evident). Deps =
  `{ ipfsGet, getMetadata, agentId }`.
- `enumerateMembers(manifest: ManifestV0): ManifestMember[]` — returns `manifest.members` (pure).
- `proveMember(manifest, memberCid): { proof; root: Hex }` — find the member index (throw if not
  present), build leaves from `members`, `merkleProof(leaves, index)`, root = body `merkleRoot`.
- `verifyMember(memberCid, proof, anchoredRoot): boolean` — delegates to
  `verifyMerkleProof(memberCid, proof, anchoredRoot)`.

**Test (write first):** `client/src/erc8004/manifest-consumer.test.ts` — pure + stubbed `ipfsGet`
(returns a canned `jinn.manifest.v0` body) and stubbed `getMetadata` (returns
`encodeManifestPayload({ root, memberCount, … })`):
1. `fetchManifest` returns the parsed body when body root === anchored root.
2. `enumerateMembers` returns all N members in order.
3. `proveMember` + `verifyMember` against the anchored root === `true` for **every** member.
4. `verifyMember(otherCid, …)` === `false`.
5. **Root-mismatch throw**: `getMetadata` returns a payload with a different root → `fetchManifest`
   throws `ManifestRootMismatchError`. Also: a tampered body (member CID swapped so body root no
   longer matches the anchored root) → throws.
6. `readManifestAnchor` → `null` path when `getMetadata` returns null.

**AC satisfied:** "consumer enumeration implemented" + "a member is verifiable against the anchored
root" (verified against the **on-chain** root, cross-checked in `fetchManifest`).

---

## Step 7 — `publish.ts`: factor `publishMemberEnvelope` + add `publishManifestBatch` · [mock-ipfs] + [mock-chain]

**Build:** `client/packages/harness-layer/src/publish.ts`:
- Factor the upload+build half of `publish()` into
  `publishMemberEnvelope(pending, deps, opts): Promise<{ envelopeRef: string; sha256: string;
  envelope: SignedEnvelope }>` — runs consent conversion, artifact upload, wrapper signing,
  `publishEnvelope`, but does **NOT** call `anchorEnvelope` and does **NOT** append a ledger row.
  Refactor `publish()` to call `publishMemberEnvelope` then do the anchor + ledger append, so
  existing behavior is byte-identical (this is the surgical refactor — keep `publish()`'s public
  contract unchanged).
- Add `publishManifestBatch(members: PendingEnvelope[], deps: HarnessPublishDeps & ManifestBatchDeps):
  Promise<ManifestBatchResult>`:
  1. For each member → `publishMemberEnvelope` (no anchor), collect `{ envelopeRef, sha256 }`.
  2. Build leaves `members.map(m => hashLeaf(m.envelopeRef))`, `root = merkleRoot(leaves)`.
  3. Build the `jinn.manifest.v0` body (`buildManifestV0Body(...)` — a small local helper:
     schemaVersion, batchKind, createdAt, merkleRoot=root, members=[{cid, sha256, polarity?,
     instanceId?}]), upload via `deps.publishManifestBody` (a new dep that uploads a raw JSON blob and
     returns its CID — production wires it to `uploadToIpfs`; tests stub it) → `manifestCid`.
  4. `deps.anchorManifest({ manifestCid, payload: { version: 0, merkleRoot: root,
     memberCount: members.length, createdAt } })` → `{ txHash, gasUsed, feeWei, blockNumber }` (a new
     dep backed by `IdentityPublisher.publishManifest` in the live wiring; tests stub it).
  5. Record: one `saveErc8004Anchor`-shaped call with `contentKind: 'manifest'`,
     `metadataKey: manifest:<cid>`, `gasUsed`, `feeWei`; and append one ledger row per member
     (`envelopeRef` = member CID, `anchorTx` = the shared manifest tx). Store recording is via an
     injected `recordAnchor` dep so `publish.ts` stays store-free (matches its current no-store
     design — the store call is wired at the daemon/live edge).
  6. Log one line: `[manifest] batch anchored cid=<…> members=<N> gasUsed=<…> feeWei=<…>`.
  - Return `ManifestBatchResult { manifestCid; anchorTx; memberRefs: string[]; root; gasUsed; feeWei }`.

**Test (write first):** `client/packages/harness-layer/test/publish-manifest-batch.test.ts` with
in-memory stubs for `publishArtifact`/`publishEnvelope`/`publishManifestBody`/`anchorManifest`/
`ledger`/`recordAnchor`:
1. N=3 members → `anchorManifest` called **exactly once**; `publishEnvelope` called 3×;
   `anchorEnvelope` (the per-record path) called **0×**.
2. The manifest body uploaded parses as `jinn.manifest.v0` with 3 members in insertion order and its
   `merkleRoot` equals `merkleRoot([hashLeaf(cid0), hashLeaf(cid1), hashLeaf(cid2)])`.
3. Every member proves: for each member CID, `verifyMember(cid, proveMember(body, cid).proof, root)`
   === `true`.
4. One ledger row appended per member, all with the same `anchorTx`.
5. `recordAnchor` called once with `contentKind:'manifest'`, `gasUsed`, `feeWei` from the stubbed
   receipt.
6. `publishMemberEnvelope` alone does NOT anchor and does NOT append a ledger row (guards the
   refactor).

**AC satisfied:** "consumer enumeration" (the body it emits) + "a member is verifiable" + the CODE
half of "gas measured and recorded".

---

## Step 8 — `bridge.ts`: `anchorMode` option · [mock-ipfs] + [mock-chain]

**Build:** `client/packages/harness-layer/src/bridge.ts`:
- Add `anchorMode?: 'per-record' | 'manifest'` to `BridgeDeps` (default `'per-record'`).
- Add `publishManifestBatch?: (tasks: Array<{ task: CapturedTask; ref: AttemptRef }>) =>
  Promise<ManifestBatchResult>` to `BridgeDeps` (used only in `'manifest'` mode; production wires it
  to `buildBridgeManifestPublisher`, below).
- In `bridgeAttempts`, when `anchorMode === 'manifest'`: run exclusion/dedup/fetch as today, but
  instead of per-attempt `publishEvidence`, collect the surviving `{ task, ref }` list and call
  `deps.publishManifestBatch` **once** after the loop. Map the returned `memberRefs` back to
  `result.bridged` (same order), setting every entry's `anchorTx` to the shared manifest tx.
- Extend `BridgeResult` with optional `manifestCid?: string`, `anchorTx?: string | null` (shared),
  `gasUsed?: bigint | null`, `feeWei?: bigint | null` — populated only in `'manifest'` mode.
- Add `buildBridgeManifestPublisher(deps)` (sibling of `buildBridgeEvidencePublisher`) that, for a
  batch of `{task, ref}`, runs each `task` through `capture()` with the layer-2 pipeline to a
  `PendingEnvelope`, then calls the `publish.ts` `publishManifestBatch` over all pendings, passing
  per-member `{ polarity, instanceId }` hints from each `ref` into the body.

**Test (write first):** `client/packages/harness-layer/test/bridge-manifest.test.ts` with the
existing bridge-test stub style (fake `fetchEvidence`, in-memory publish stubs):
1. `anchorMode:'manifest'` with N surviving attempts → `publishManifestBatch` called once;
   `result.manifestCid` set; every `result.bridged[i].anchorTx` equals the shared tx.
2. Every bridged member proves against `result` (fetch the emitted body via the stub, prove each).
3. `result.gasUsed`/`result.feeWei` populated from the stubbed receipt.
4. Default (`anchorMode` unset) → per-record path unchanged: `publishEvidence` called per attempt,
   `publishManifestBatch` never called (guards the opt-in default).
5. Exclusion + dedup still applied before the batch (held-out/slate instances never reach the
   manifest).

**AC satisfied:** wires the batch anchor into the real bulk producer; supports all ACs end-to-end.

---

## Step 9 — `publish-live.ts`: expose the EOA manifest anchor dep · [mock-chain-ish / wiring]

**Build:** `client/packages/harness-layer/src/publish-live.ts`:
- In `createLivePublishDeps`, the `IdentityPublisher` is already constructed (line 63). Add to the
  returned deps an `anchorManifest: async ({ manifestCid, payload }) => { const { txHash, blockNumber,
  gasUsed, feeWei } = await identityPublisher.publishManifest({ manifestCid, payload }); return {
  txHash, blockNumber, gasUsed, feeWei }; }` and a `publishManifestBody: async (body) => uploadToIpfs(
  ipfsRegistryUrl, { schemaVersion: 'jinn.manifest.v0', ...body })` (or upload the canonical-JSON
  blob the same way `publishArtifact` does — match the `DONATION_ARTIFACT_ENCODING` envelope shape so
  the CID is resolvable by the corpus/consumer read path). This makes the batch path anchor through
  the **same EOA publisher** (shared nonce lock), satisfying the design's core trade-off.
- No test change beyond typecheck; this is thin wiring over already-tested units. Optionally add a
  smoke test that `createLivePublishDeps(...).anchorManifest` is a function (guards the wiring
  exists).

**AC satisfied:** production wiring for the write path (single-EOA nonce discipline).

---

## Step 10 — `store.ts`: `contentKind:'manifest'` + nullable gas columns · [pure / unit]

**Build:** `client/src/store/store.ts`:
- `content_kind` already accepts `'manifest'` (free TEXT) — no change needed there; add a doc comment
  noting `'manifest'` is a valid kind so it isn't "cleaned up".
- Add `gas_used TEXT` and `fee_wei TEXT` (store bigints as decimal strings; SQLite has no bigint —
  match how other on-chain numeric values are persisted) to the `erc8004_anchors` `CREATE TABLE` DDL
  (line 525) AND add `ensureErc8004AnchorGasColumns()` (mirror `ensureNetworkArtifactsPeerCatalogId`,
  called from the constructor's migration block) so existing DBs get them additively.
- Extend `Erc8004AnchorInput` with `gasUsed?: string | null` and `feeWei?: string | null`; update
  `saveErc8004Anchor` INSERT + params to write them (default `null`); extend `Erc8004AnchorRow` +
  `listErc8004AnchorsByEnvelopeCids` SELECT/map to read them back.

**Test (write first):** in the existing store test suite (`client/test/store*.test.ts` — find the
one covering `saveErc8004Anchor`; add a case, or a new `client/test/store-manifest-anchor.test.ts`):
1. `saveErc8004Anchor({ contentKind:'manifest', gasUsed:'123456', feeWei:'789', … })` round-trips via
   `listErc8004AnchorsByEnvelopeCids` including the gas fields.
2. An anchor saved without gas fields reads back `gasUsed: null, feeWei: null` (back-compat).
3. Migration: open a DB pre-seeded with the old `erc8004_anchors` schema (no gas columns) → construct
   the store → the columns exist and old rows read `null` (proves the additive `ALTER TABLE` runs).

**AC satisfied:** "gas … recorded" (persistence) — the measured numbers survive the run.

---

## Step 11 — `cli.ts`: `--anchor-mode manifest` + print the gas line · [wiring / snapshot]

**Build:** `client/packages/harness-layer/src/cli.ts`:
- Add `--anchor-mode <per-record|manifest>` to the `distill run` / `distill` arg parser
  (`parseArgs` options block, ~line 1030). Default `per-record`.
- When `manifest`, pass `anchorMode:'manifest'` + the `publishManifestBatch` wiring
  (`buildBridgeManifestPublisher(createLivePublishDeps(...))`) into the bridge deps.
- On completion, if the bridge ran in manifest mode and `result.manifestCid` is set, print the
  measured line: `manifest anchored <cid> — <N> members, gasUsed=<…>, feeWei=<…>` (feeds the "first
  batch = the measurement" operator surface). Keep the existing per-record summary otherwise.

**Test (write first):** extend the existing CLI test file that covers `distill run` (find via
`grep -rn "distill run" client/packages/harness-layer/test`) with an injected `distillRunDeps` /
bridge stub:
1. `--anchor-mode manifest` threads `anchorMode:'manifest'` into the bridge deps (assert on the
   injected stub's received option).
2. When the (stubbed) result carries `manifestCid`+`gasUsed`, the CLI writer output contains the
   `manifest anchored … gasUsed=` line.
3. Default invocation (no flag) does not print the manifest line and uses per-record.

**AC satisfied:** operator surface for running the first real batch (which produces the gas number).

---

## Step 12 — Full verification pass · [gate]

- `cd client && yarn typecheck` → zero errors.
- `cd client && yarn test` → all pass (touches: `erc8004/*`, `types/manifest`, `store*`,
  `packages/harness-layer/*`).
- Confirm no regression in the per-record path: the untouched `publish()` public contract and the
  default-mode bridge tests still pass.

**AC satisfied:** verification clause "`cd client && yarn test`".

---

## Gas-measurement clause — EXPLICIT scope boundary (do NOT fabricate a number)

The AC "gas measured and recorded (first real batch doubles as the measurement)" splits into two
distinct deliverables. **This PR ships only the first.**

1. **CODE capability (ships in this PR, fully test-covered with a MOCKED receipt):**
   - `IdentityPublisher._writeMetadata` surfaces `gasUsed`/`feeWei` from the existing receipt (Step 4).
   - `publishManifestBatch` / `bridgeAttempts(manifest)` log + return them (Steps 7–8).
   - `store.saveErc8004Anchor` persists them (Step 10).
   - The CLI prints them (Step 11).
   - Tests assert the plumbing with a **stubbed receipt** — they assert the number *flows through and
     is recorded*, NOT any specific gas value.

2. **The actual live testnet gas NUMBER (follow-up, NOT this PR's code):**
   - Produced by the **first real bridge batch** run by an operator on Base Sepolia
     (`jinn-layer distill run --anchor-mode manifest`), which anchors one real `manifest:` record and
     — from the same run — one per-record `capture:` anchor for the per-anchor-vs-per-manifest
     comparison the corpus-supply spec §9 asks for.
   - The measured numbers are then recorded as a **follow-up doc edit** into
     `docs/superpowers/specs/2026-07-17-corpus-supply-design.md` §9 and/or issue #1829.
   - **NO gas constant is asserted anywhere in code, docs, or tests before that run produces it.**
     Any hardcoded gas figure would be a fabrication and violates Legibility (PRINCIPLES.md) — the
     number must come from a real tx hash on a real chain.

The issue's "Verification: testnet batch anchor + inclusion-proof check" is thus an
operator-run acceptance step layered on top of the merged code, not a CI gate — it is what closes the
measurement half of the AC after merge.

## Ordering rationale

Leaf-first so each step compiles and tests green against already-landed dependencies:
`merkle.ts` (Step 1, no deps) → `manifest-registry.ts` + `abis` tuple (Step 2, no deps) →
`types/manifest.ts` (Step 3, no deps) → `identity.publishManifest` + gas (Step 4, depends on Step 2)
→ barrel exports (Step 5) → `manifest-consumer.ts` (Step 6, depends on 1/2/3) →
`publish.ts` batch path (Step 7, depends on 1/2/3/4) → `bridge.ts` mode (Step 8, depends on 7) →
`publish-live.ts` wiring (Step 9, depends on 4/7) → `store.ts` (Step 10, independent, can move
earlier) → `cli.ts` (Step 11, depends on 8/9) → verification (Step 12).

`store.ts` (Step 10) has no dependency on the merkle/manifest units and could be done any time after
Step 4 defines the `gasUsed`/`feeWei` shape; it is placed late only so the recording contract is
settled first.
