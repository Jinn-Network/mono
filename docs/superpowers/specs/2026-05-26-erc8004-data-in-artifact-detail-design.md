# ERC-8004 data in the artifact detail panel — design

**Version:** v0.1
**Date:** 2026-05-26
**Status:** Proposal
**Work shape:** feat
**Target branch:** `next`

## Problem

The operator dashboard's artifact detail panel currently renders 5–7 fields per artifact (`type`, `state`, `sha256`, `envelope`, `recorded`, plus `request`/`accesses` for served artifacts or `operator`/`source` for network artifacts). Underneath each artifact sits a much richer body of provenance:

- The full envelope projection (solver type, role, task, evidence tier, participant Safe + agent EOA, executor implementation + version + runtime bundle digest + plugin list, signature hash, solution cross-reference, free-form metadata).
- The ERC-8004 on-chain anchor — `IdentityRegistry.setMetadata(agentId, "<kind>:<cid>", payload)` — which gives the artifact a verifiable identity on chain. Today the tx hash and block returned by `publishContentV2()` are discarded; no local record exists.

Without these surfaced, the panel can't answer the questions an operator wants to ask: *which agent NFT owns this artifact, which tx anchored it, what was the executor, is the evidence self-signed or attested, is there a paired solution envelope?*

## Goal

Surface every locally-stored ERC-8004 datum in the artifact detail panel, and extend the publish path so the on-chain anchor (tx hash, block, agent ID, chain, registry address, payload) is captured at write time and shown alongside the envelope.

## Non-goals

- Live RPC verification on detail open (rejected scope option).
- Surfacing anchors made by *other* operators (would require indexer query — separate work).
- Inline decoding of `payload_hex` into a human-readable tuple (we ship the hex; decoder UI can come later).
- Backfilling anchors for envelopes published before this change (the table starts empty; old envelopes show "no on-chain anchor recorded").

## Data model

New table:

```sql
CREATE TABLE erc8004_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,                 -- FK-by-convention to envelope_projections.envelope_id
  envelope_cid TEXT NOT NULL,                -- denormalised for direct artifact-join by envelope_cid
  content_kind TEXT NOT NULL,                -- 'capture' | 'envelope' | 'evaluation'
  metadata_key TEXT NOT NULL,                -- the on-chain key, e.g. 'envelope:bafkrei...'
  agent_id TEXT NOT NULL,                    -- operator's ERC-8004 agent NFT ID at publish time
  chain_id INTEGER NOT NULL,
  identity_registry_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER,                      -- nullable; backfilled by receipt reconciler
  payload_hex TEXT NOT NULL,                 -- the ABI-encoded ExecutionPayloadV2 we sent
  anchored_at INTEGER NOT NULL               -- unix seconds at the moment of tx send
);
CREATE INDEX idx_erc8004_anchors_envelope_cid ON erc8004_anchors(envelope_cid);
CREATE INDEX idx_erc8004_anchors_envelope_id  ON erc8004_anchors(envelope_id);
```

**Why a separate table** (vs. columns on `envelope_projections`):
- An envelope may be anchored under multiple `content_kind` keys over its lifetime.
- Failed/retried anchors produce multiple rows.
- Projections describe envelope contents; anchors describe a chain-side commitment to those contents — distinct concerns.

Migration is additive-only. No backfill.

## Write path

1. `IdentityPublisher.publishContentV2()` in `client/src/erc8004/identity.ts` currently returns `{ txHash }`. Extend to `{ txHash, blockNumber }` by awaiting `getTransactionReceipt` after the write succeeds.
   - On receipt timeout (default 30s): return `blockNumber: null` rather than throwing. Tx is already on chain; block can be backfilled later.
2. `live-publisher.ts` (the only caller of `publishContentV2`) calls a new `store.saveErc8004Anchor({...})` immediately after a successful publish, in the same block where it already calls `setServedArtifactEnvelopeCid`. The row captures `envelopeId`, `envelopeCid`, `contentKind`, `metadataKey`, `agentId`, `chainId`, `identityRegistryAddress`, `txHash`, `blockNumber`, `payloadHex`, `anchoredAt: Date.now() / 1000`.
3. New background tick `reconcileAnchorReceipts` (added to the daemon's loop set in `daemon.ts`):
   - Every 60s, select up to 50 anchors with `block_number IS NULL`.
   - Call `getTransactionReceipt(txHash)` per row. On success, update `block_number`. On revert or "not found after N tries" (track a small attempt counter in-memory), give up silently — the row remains usable; only `block_number` stays null.
   - Cheap; bounded; resilient to RPC failure.

## API change

`GET /v1/operator/artifacts` and `GET /v1/operator/execution-data` in `client/src/api/operator-artifacts-endpoint.ts`. Each artifact gains:

```ts
projection?: {
  envelopeId: string;
  signatureHash: string | null;
  solverType: string | null;
  role: 'capture' | 'solution' | 'evaluation' | null;
  taskCid: string | null;
  taskId: string | null;
  requestId: string | null;
  generatedAt: number | null;
  evidenceTier: 'self-signed' | 'committed' | 'attested' | null;
  participantSafeAddress: string | null;
  participantAgentEoa: string | null;
  executor: {
    implName: string | null;
    implVersion: string | null;
    runtimeBundleDigest: string | null;
    plugins: string[] | null;
  };
  solutionRef?: {
    envelopeCid: string;
    envelopeSha256: string;
    ref: string | null;
  };
  metadata: Record<string, string | number | boolean> | null;
};

anchors: Array<{
  contentKind: 'capture' | 'envelope' | 'evaluation';
  metadataKey: string;
  agentId: string;
  chainId: number;
  identityRegistryAddress: string;
  txHash: string;
  blockNumber: number | null;
  payloadHex: string;
  anchoredAt: number;
}>;
```

Joined by `envelope_cid` (the artifact-side `envelope_cid` matches `envelope_projections.envelope_cid` and `erc8004_anchors.envelope_cid`). `projection` is optional (some artifacts pre-date the projection table); `anchors` is always present, possibly empty (peer-fetched artifacts and pre-feature envelopes).

`schemaVersion` bumps from its current value to mark the addition.

## UI change

Refactor `ExecutionArtifactDetail` in `client/src/dashboard/spa/src/captures/CapturesTab.tsx` into labelled sections rather than a single flat `<dl>`. Each section is conditionally rendered based on data presence.

**Sections, in order:**

1. **Identity** — `state`, `sha256`. (The redundant `type` row is dropped; the `<h1>` already shows it.)
2. **Envelope** — `envelope` CID, `signatureHash`, `generatedAt`, `role`, `solverType`, `evidenceTier`.
3. **Participant** — `participantSafeAddress`, `participantAgentEoa`, `executor.implName` + `implVersion`, `executor.runtimeBundleDigest`, `executor.plugins` (rendered as chips).
4. **Task** — `taskCid`, `taskId`, `requestId`, `solutionRef` (link to the paired solution artifact when present).
5. **On-chain anchors** — one card per anchor row. Shows `contentKind`, `agentId`, `txHash` (with explorer link derived from `chainId`: `8453` Base mainnet → `https://basescan.org/tx/<hash>`, `84532` Base Sepolia → `https://sepolia.basescan.org/tx/<hash>`, `11155111` Sepolia → `https://sepolia.etherscan.io/tx/<hash>`, any other chain → render `txHash` as plain text), `blockNumber` (or "pending" when null), `anchoredAt`, `identityRegistryAddress`, `metadataKey`. `payloadHex` lives behind a `<details>` disclosure.
6. **Access** (served artifacts only) — existing `request`, `accesses`, plus the access-stats split (`accessCount`, `failedPaymentCount`).
7. **Source** (network artifacts only) — existing `operator`, `sourceEndpoint`.

**Empty states:** Missing projection collapses sections 2–4 to a single muted note ("no envelope projection recorded"). Missing anchors collapses section 5 to "no on-chain anchor recorded yet". Both are independent.

**Existing bug fixed in passing:** the dual-header rendering (the `<h1>` and the first `<dl>` row both showed `artifact.artifactType`) is removed by dropping the `type` row from the list.

## Testing

- **Store unit (Vitest)** — `saveErc8004Anchor`, `listAnchorsByEnvelopeCid`, `listAnchorsAwaitingReceipt`, `updateAnchorBlockNumber`. Insert / query / update round trips.
- **Endpoint unit (Vitest)** — `listExecutionData` join: fixture rows in `served_artifacts` + `envelope_projections` + `erc8004_anchors` → assert response includes the projection block and one anchor with the expected shape.
- **SPA unit (RTL)** — `ExecutionArtifactDetail` renders all sections when full data is present; collapses sections when projection missing; collapses anchors section when empty; renders multiple anchor cards when more than one anchor exists; renders correct explorer URL per `chainId`.
- **Integration (existing `e2e:daemon-harness`)** — after the e2e harness produces an envelope, assert at least one `erc8004_anchors` row exists for that envelope's CID and that the API returns `anchors.length >= 1` and a populated `projection` for that artifact's sha256.

## Rollout

Single PR to `next`. Migration runs on daemon startup; new table starts empty. Existing envelopes continue to render with `anchors: []`. New envelopes produced after the rollout get full anchor records. No flag — the change is additive and backwards-compatible.

## Open questions

None blocking. Future work that this design unblocks but does not include:
- A decoder UI for `payload_hex` → human-readable `ExecutionPayloadV2` tuple.
- Surfacing anchors observed for *other* operators' envelopes (would require pulling from a Ponder indexer or RPC log scan).
- A bulk "all my anchors" view (currently anchors are scoped to a single artifact detail).
