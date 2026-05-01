# Phase A umbrella — corpus library, gating fix, manifest hygiene, cache, MCP rewiring

**Version:** 0.1
**Date:** 2026-04-30
**Author:** ritsukai (sitting with Opus, jinn-mono-q94h)
**Status:** Draft for Captain review
**Beads:** jinn-mono-q94h (parent: jinn-mono-vy37 Phase A epic)
**Related:**

- Discussion #59 — *Jinn as the knowledge market — implementation roadmap proposal* (substrate vision)
- Discussion #57 — *Unified GTM around the Prediction SolverNet* (paired GTM)
- `log/decisions/2026-04-30-knowledge-market-vision-framing.md` — DR-2026-04-30 (six framing choices ratified)
- `spec/2026-04-30-knowledge-market-vision-discussion.md` — discussion draft (§3.3 first app, §4 code reality, §5 Phase A.1, §6 workstreams)
- `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` — envelope schema and tier semantics this spec composes against
- `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` — operator-rooted ERC-8004 entity model
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` — Phase A.2 anchor (the canonical agent-as-buyer)

This spec covers the five Phase A.1 workstreams that together close the cross-operator end-to-end test and unblock the operational loop. The plug-in surface (Phase A.2) is a sibling spec.

---

## TL;DR

Phase A.1 turns the existing primitives — subgraph, x402 plumbing, ERC-8004 registries, signed envelopes — into an actually-traversable path from operator to corpus. Five surgical workstreams:

1. **Corpus library** at `client/src/corpus/` — bundles "subgraph query → manifest fetch → selection → x402 acquire → hash verify → cache" into one programmatic call. Two-tier API: `corpus.read(...)` for the one-line happy path, `corpus.query` and `corpus.acquire` exposed as composable primitives.
2. **Cache table** in `store.ts` — `network_artifacts` keyed by sha256, with provenance (source operator, paid amount, fetched-at).
3. **MCP rewiring** — `search_artifacts` and `acquire_artifact` move from local-store-only to corpus-library-backed, with a local-store fast path for self-produced content. Decision record drafted as separate child issue.
4. **Gating leak fix** at `client/src/restorer/engine/packaging.ts:387-460` — `uploadArtifacts` stops uploading artifact content to IPFS entirely. Bytes are stored in the operator's own SQLite and served via x402. **All artifact content takes the same data path; pricing is a per-artifact row.** IPFS holds intents and manifests only.
5. **Manifest access hygiene** — every artifact descriptor carries `access.endpoint` and `access.priceUsdc`. Operator config provides the defaults.

Forward-compatible: `routeResolver` hook in the corpus library reserves the seam for Phase D shared caches without library changes.

Optimistic-mode bootstrap from Discussion #59 §1: operators ship with `priceUsdc = '0'` defaults. A flip from `'0'` to `'0.001'` is a config edit — no plumbing change.

---

## 1. Architectural commitments

These are the load-bearing choices the rest of the spec hangs on. They are settled (per the conversation that produced this draft) and are recorded here so subsequent specs can reference them.

### 1.1 One artifact-content data path

There is exactly one path for fetching artifact content: the operator's HTTP server with x402 payment middleware. **The same path serves "open" and "paid" content.** Pricing is a per-artifact row in the operator's database, not a fork in the data model.

- `priceUsdc === '0'` → server responds 200 with content bytes directly.
- `priceUsdc > '0'` → server emits 402 with payment requirements derived from the per-artifact price; on a valid `X-PAYMENT` header the facilitator verifies + settles, and the server responds 200.

The buyer's library always wraps fetches with `wrapFetchWithPayment` — `@x402/fetch` is transparent (200 passes through unchanged, 402 triggers the payment dance), so there is **no buyer-side branch on price**.

### 1.2 IPFS holds public discovery anchors only

| Artefact | Lives on | Why |
|---|---|---|
| Intent / restoration request payload | IPFS | Anyone with a wallet must be able to read what was posted |
| Manifest envelope (`jinn.execution.v1`) | IPFS | Subgraph indexes manifest CIDs as the discovery surface |
| Manifest registered in ERC-8004 IdentityRegistry as `setMetadata(agentId, "envelope:<cid>", payload)` | n/a (on-chain pointer) | Public discovery anchor |
| **All artifact content (any price)** | Operator's local SQLite, served via x402 endpoint | Single mental model; pricing is a per-row knob |

Per-artifact `cid` field (the IPFS CID that today refers to per-artifact content blobs) is **dropped from the artifact descriptor schema** in v0. Manifests still have their own IPFS CID at the registry level; that is unchanged.

### 1.3 Operator-rooted retention

The operator's local store is the only source of truth for the bytes they have published descriptors for. If the operator goes offline or evicts content, buyers fetching that content get 404.

This is an honest commitment, not a regression: today's "operator publishes once, IPFS preserves forever" property is already fragile (autonolas.tech could turn off pinning at any time), and Phase D shared caches are explicitly anticipated as the durability answer for actively-valuable open content.

v0 retention policy: keep forever. The spec flags eviction policy (size cap, age cap, per-kind cap) as an open question for follow-up.

### 1.4 Phase D shared caches plug in via `routeResolver`

The corpus library exposes a `routeResolver` hook that intercepts before the x402 fetch. A resolver returning content for a given `(sha256, access)` short-circuits the origin fetch; returning `null` falls through to the operator. Phase A.1 default: `routeResolver` is undefined.

Phase D shared caches (IPFS pinning service, HTTP CDN, P2P relay, or something we have not invented yet) plug in here without any library API change.

### 1.5 The forward-compatible `access` shape

The artifact descriptor's `access` is a single shape, mandatory on every artifact:

```
access: {
  endpoint: string,        // operator's base URL, e.g. "https://operator.example.com"
  priceUsdc: string,       // decimal-string USDC amount; "0" is allowed
}
```

There is no `kind` discriminator. There is no `'open' | 'x402-gated'` enum. Pricing is the only knob.

If a future spec adds encrypted-at-rest content on IPFS (the deferred encryption-at-rest path discussed during Phase A.1 design), it lands as an additional `access.kind` discriminator at that time. v0 buyers will tolerate unknown `kind` values by skipping; operators do not emit them until the corresponding spec lands. **No schema change is required for v0 to be forward-compatible.**

---

## 2. Workstream 1 — Corpus library

### 2.1 Public API

The library lives at `client/src/corpus/` and exposes a single factory `createCorpus(opts: CorpusOptions): Corpus`. Two tiers of surface area:

**Tier 1 — one-line happy path:**

```typescript
const envelopes = await corpus.read({
  query: { kind: 'prediction.v0', limit: 5 },
});
// envelopes is Envelope[] with content already fetched, hash-verified, cached.
```

**Tier 2 — composable primitives:**

```typescript
const refs = await corpus.query({ kind: 'prediction.v0', limit: 50 });
// refs is EnvelopeRef[] — discovery-only, no payment, no manifest fetch.

const manifests = await Promise.all(refs.map(r => corpus.fetchManifest(r)));
// manifests is ManifestPreview[] — IPFS-fetched, parsed, no gated content yet.

const chosen = manifests.filter(myCustomScoringFn).slice(0, 3);
const envelopes = await Promise.all(chosen.map(m => corpus.acquire(m)));
// envelopes is Envelope[] — content acquired, hash-verified, cached.
```

`corpus.read({ query, select })` is `query → fetchManifest → select (default identity) → acquire`. Callers who need finer control compose the primitives directly.

### 2.2 Types

```typescript
export interface CorpusOptions {
  subgraphUrl: string;          // GraphQL endpoint of canonical Jinn indexer
  ipfsGatewayUrl: string;       // for manifest fetches (e.g. autonolas)
  store: Store;                 // local SQLite (cache + self-served fast path)
  signer: { privateKey: string }; // for x402 payments (the operator EOA's pk)
  selfSafeAddress: string;      // for local-store fast path (self-produced content)
  routeResolver?: RouteResolver; // optional Phase D extension point
}

export interface Corpus {
  read(args: ReadArgs): Promise<Envelope[]>;
  query(q: CorpusQuery): Promise<EnvelopeRef[]>;
  fetchManifest(ref: EnvelopeRef): Promise<ManifestPreview>;
  acquire(manifest: ManifestPreview): Promise<Envelope>;

  // Granular primitive used by MCP `acquire_artifact` (§4.2): caller already
  // knows the sha256 and access pointer (e.g. picked up from a prior search
  // result) and does not have a full manifest in hand. Same resolution chain
  // as acquire (cache → self-store → resolver → origin → hash-verify) but
  // skips manifest parsing.
  acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint?: { artifactType?: string; envelopeCid?: string },
  ): Promise<ArtifactContent>;
}

export interface ReadArgs {
  query: CorpusQuery;
  select?: (manifests: ManifestPreview[]) => ManifestPreview[];
}

export interface CorpusQuery {
  kind?: string;                // intent kind (e.g. 'prediction.v0')
  intentCid?: string;           // single-intent lookup
  participant?: { safeAddress?: string };
  evidenceTier?: 'self-signed' | 'committed' | 'attested';
  generatedAfter?: number;      // unix seconds
  generatedBefore?: number;
  limit?: number;               // default 50, hard cap 500
}

export interface EnvelopeRef {
  manifestCid: string;          // IPFS CID of the manifest envelope
  manifestHash: string;         // keccak256(canonical bytes)
  operator: { agentId: string; safeAddress: string };
  evidenceTier: 'self-signed' | 'committed' | 'attested' | 'unknown';
  publishedAt: number;          // unix seconds, from on-chain block
}

export interface ManifestPreview {
  ref: EnvelopeRef;
  envelope: SignedEnvelope;     // from client/src/types/envelope.ts (without gated content bytes)
  // The envelope's artifact descriptors are present; their content is not yet fetched.
}

export interface Envelope extends ManifestPreview {
  artifactContents: Map<string, ArtifactContent>; // keyed by sha256
}

export interface ArtifactContent {
  sha256: string;
  bytes: Buffer;
  artifactType: string;
  source: 'cache' | 'self-store' | 'origin' | 'route-resolver';
  paidAmountUsdc: string;       // '0' for cache hits, self-store, free origin, or resolver
  fetchedAt: string;            // ISO timestamp; mirror of cache row
  sourceOperator?: string;      // safe address we paid (origin) or null
}

export interface RouteResolver {
  resolve(req: {
    sha256: string;
    access: { endpoint: string; priceUsdc: string };
    requesterSafe: string;
  }): Promise<{ bytes: Buffer; sourceOperator?: string; pricePaidUsdc: string } | null>;
}
```

### 2.3 Internal flow

Inside `corpus.read({ query, select })`:

1. **Query.** `query.ts` translates `CorpusQuery` into a GraphQL request against the subgraph. The subgraph's `Execution` entity (already deployed — `subgraph/schema.graphql:73`) carries `manifestCid`, `manifestHash`, `tier`, `operator`, `publishedAt`. Returns `EnvelopeRef[]`.

2. **Manifest fetch.** `fetch.ts` retrieves each manifest from IPFS via `ipfsGatewayUrl` (using the existing `fetchFromIpfs` helper in `client/src/adapters/mech/ipfs.ts`). Parses with `SignedEnvelopeSchema` from `client/src/types/envelope.ts`. Returns `ManifestPreview[]`.

3. **Selection.** If `select` is provided, invoke it on `ManifestPreview[]` and use the return value. Otherwise pass-through.

4. **Acquire.** For each surviving preview, iterate the envelope's `artifacts` array and resolve content for each:
   - **Cache hit:** `store.getNetworkArtifact(sha256)` returns bytes. `source = 'cache'`. No payment, no network call.
   - **Self-store fast path:** if the envelope's `participant.safeAddress` matches `opts.selfSafeAddress`, serve from `store.getServedArtifact(sha256)`. `source = 'self-store'`. No payment, no network call. Subsequently cache it (so a peer asking us this becomes free locally).
   - **Route resolver:** if `routeResolver` is set, invoke it. If non-null, accept its bytes; verify `sha256(bytes) === artifact.sha256`; persist into cache; `source = 'route-resolver'`.
   - **Origin fetch:** `acquire.ts` builds `<endpoint>/v1/artifacts/<sha256>/content`, wraps `globalThis.fetch` with `wrapFetchWithPayment` (existing helper in `client/src/x402/acquire.ts`), GETs. On 402 the wrapper signs payment and retries (no-op for `priceUsdc = '0'`). On 200 the response body is bytes; verify `sha256(bytes) === artifact.sha256`; persist into cache with provenance; `source = 'origin'`.

5. **Hash verify, always.** Every byte stream that enters the cache is hash-verified before storage. Mismatch = error, no cache write, no return.

6. **Return.** `Envelope[]` with `artifactContents` populated.

### 2.4 Module layout

```
client/src/corpus/
  index.ts          createCorpus factory + public Corpus interface
  types.ts          all type definitions in §2.2
  query.ts          subgraph GraphQL query construction + parsing
  fetch.ts          manifest IPFS fetch + envelope schema parsing
  acquire.ts        per-artifact resolution (cache → self-store → resolver → origin)
  cache.ts          thin wrapper over Store.getNetworkArtifact / saveNetworkArtifact
  route-resolver.ts RouteResolver interface (no default impl in v0)
```

Each file is purpose-narrow and unit-testable in isolation.

### 2.5 Error model

Operations that hit the network return `Promise<Envelope[]>` etc., and propagate errors. Concrete error classes (in `types.ts`):

- `CorpusQueryError` — subgraph unreachable or returned malformed data.
- `ManifestFetchError` — IPFS gateway 404, timeout, or schema parse failure.
- `AcquireError` — origin 5xx, payment failure, or hash mismatch (with `cause` distinguishing).
- `HashMismatchError` — content hash did not match descriptor sha256. **This is the only error that taints the cache** — it is always logged at error level with `(sha256, source, sourceOperator)` for downstream reputation hooks.

The library does **not** swallow per-artifact errors silently inside a multi-envelope `read()`. If any artifact in the requested set fails, the whole `read()` rejects. Callers who want partial-success semantics can compose primitives directly (loop over `acquire` with try/catch).

---

## 3. Workstream 2 — Cache table

### 3.1 Schema

Add to `client/src/store/store.ts` SCHEMA:

```sql
CREATE TABLE IF NOT EXISTS network_artifacts (
  sha256 TEXT PRIMARY KEY,                 -- 64-char hex (no '0x' prefix)
  artifact_type TEXT NOT NULL,             -- e.g. 'trajectory', 'system_snapshot', 'output.prediction.v0'
  envelope_cid TEXT,                       -- manifest CID this came from (provenance, not unique)
  content BLOB NOT NULL,
  content_size INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('origin', 'route-resolver', 'self-store-mirror')),
  source_operator TEXT,                    -- Safe address we paid (or null for resolver/self)
  source_endpoint TEXT,                    -- the URL we used (debug + reputation)
  paid_amount_usdc TEXT NOT NULL,          -- '0' if free
  fetched_at TEXT NOT NULL,                -- ISO timestamp
  last_used_at TEXT NOT NULL               -- ISO timestamp; updated on each cache hit
);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_envelope ON network_artifacts (envelope_cid);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_artifact_type ON network_artifacts (artifact_type);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_last_used ON network_artifacts (last_used_at DESC);
```

### 3.2 Store API additions

```typescript
class Store {
  saveNetworkArtifact(row: {
    sha256: string;
    artifactType: string;
    envelopeCid?: string;
    content: Buffer;
    source: 'origin' | 'route-resolver' | 'self-store-mirror';
    sourceOperator?: string;
    sourceEndpoint?: string;
    paidAmountUsdc: string;
    fetchedAt: string;
  }): void;

  getNetworkArtifact(sha256: string): {
    sha256: string;
    artifactType: string;
    envelopeCid: string | null;
    content: Buffer;
    source: string;
    sourceOperator: string | null;
    sourceEndpoint: string | null;
    paidAmountUsdc: string;
    fetchedAt: string;
    lastUsedAt: string;
  } | null;

  // touchNetworkArtifactUsage updates last_used_at. Called by acquire.ts on cache hits.
  touchNetworkArtifactUsage(sha256: string, ts: string): void;
}
```

### 3.3 Eviction policy

**v0: none.** The cache grows unbounded. Operators with disk pressure restart with a deleted DB or run a manual `DELETE FROM network_artifacts WHERE last_used_at < ...` query.

**Open question** (flagged for Phase B): replace with size-or-age policy (e.g. evict LRU when total > 5 GB; evict by-row if older than 90 days unless pinned). The schema's `last_used_at` column is laid down now so a future eviction layer can read it without migration.

### 3.4 Provenance and reputation

Every cache row records who served the bytes (`source_operator`, `source_endpoint`) and what was paid (`paid_amount_usdc`). This is a precondition for **operator-level reputation signals** in Phase B (e.g. "% of fetches from this operator that hash-verified successfully"). The corpus library does not itself emit reputation events — it just ensures the data for them survives.

---

## 4. Workstream 3 — MCP rewiring

### 4.1 Current behaviour

`client/src/mcp/server.ts:189-211` (`search_artifacts`) and `:214-260` (`acquire_artifact`) operate against the local `artifacts` table only. `search_artifacts` runs `store.searchArtifacts(...)` over rows the operator either produced (`remote = 0`) or learned about via peer sync (`remote = 1`). `acquire_artifact` fetches content from a peer's `/artifacts/:id/content` endpoint without payment.

This worked for the local-store-only world but skips the corpus entirely.

### 4.2 New behaviour

**`search_artifacts` becomes a thin wrapper over `corpus.query`** plus an explicit local-store fast path:

```typescript
server.tool('search_artifacts', /* description */, schema, async ({ kind, intentCid, evidenceTier, generatedAfter, limit }) => {
  // 1. Local fast path: any artifacts this operator has produced or has cached
  //    that match the filter. Free, instant.
  const localHits = store.searchOwnAndCached({ kind, intentCid, evidenceTier, generatedAfter, limit });

  // 2. Corpus query: discovery-only, no payment, no manifest fetches.
  const refs = await corpus.query({ kind, intentCid, evidenceTier, generatedAfter, limit });

  return jsonText({ local: localHits, network: refs });
});
```

The MCP-callable agent (the restorer's Claude subprocess) can decide whether to spend a token on `acquire_artifact`. Discovery is always free.

**`acquire_artifact` becomes a thin wrapper over `corpus.acquire`** with a self-store fast path:

```typescript
server.tool('acquire_artifact', /* description */, { sha256: z.string() }, async ({ sha256 }) => {
  // 1. Self-store fast path: if we produced this content ourselves, return it.
  const own = store.getServedArtifact(sha256);
  if (own) return jsonText({ sha256, bytes: own.content.toString('base64'), source: 'self-store', paidAmountUsdc: '0' });

  // 2. Cache fast path.
  const cached = store.getNetworkArtifact(sha256);
  if (cached) {
    store.touchNetworkArtifactUsage(sha256, new Date().toISOString());
    return jsonText({ sha256, bytes: cached.content.toString('base64'), source: 'cache', paidAmountUsdc: '0' });
  }

  // 3. Corpus origin fetch via the access pointer the agent provides.
  //    The MCP tool input includes 'access' (endpoint + priceUsdc) which the
  //    agent picked up from a prior search_artifacts result.
  const env = await corpus.acquireBySha256(sha256, access);
  return jsonText({ sha256, bytes: env.bytes.toString('base64'), source: env.source, paidAmountUsdc: env.paidAmountUsdc });
});
```

The MCP tool input schema for `acquire_artifact` adds `access: { endpoint: string; priceUsdc: string }` so the agent can pass through what it learned in `search_artifacts`. (Alternative: have the MCP server look up access from the manifest CID; trades a network round trip for a smaller schema. v0 picks the explicit-pass-through to keep the server stateless and the agent in control.)

### 4.3 Local-store fast-path semantics

Three tables can supply content without network/payment:

- `artifacts` — existing self-produced + remote-known table; pre-existing peer-sync content. Read by `searchOwnAndCached`.
- `served_artifacts` (new — see §5.3) — content this operator publishes for x402-served gated/free fetches. Read by `getServedArtifact`.
- `network_artifacts` (new — §3.1) — content this operator has fetched from the corpus. Read by `getNetworkArtifact`.

The MCP fast path queries `served_artifacts` first (operator's own published content), then `network_artifacts` (corpus cache). The pre-existing `artifacts` table stays untouched; peer-sync continues to populate it; the MCP rewiring does **not** retire it.

### 4.4 Decision record

A separate child issue (`bd create --title "DR: MCP rewiring approach" ...` — to be filed by the Captain) ratifies the decision to:

- Pass `access` through MCP tool inputs rather than have the server derive it from manifest CIDs.
- Keep the legacy local-store-only `search_artifacts` peer-sync semantics behind the corpus-library hits (additive, not replacing).
- Use `sha256` as the canonical artifact identifier in MCP tool inputs (not the legacy UUID-shaped `id`).

---

## 5. Workstream 4 — Gating leak fix

### 5.1 Current behaviour (the leak)

`client/src/restorer/engine/packaging.ts:391-462` (`uploadArtifacts`) reads each artifact's local file, computes sha256, wraps the bytes as base64 inside a JSON envelope `{ artifactType, sha256, data: <base64> }`, and uploads to IPFS via `uploadToIpfs(deps.ipfsRegistryUrl, envelope)`. **It does this for every artifact, regardless of `art.access?.kind`.** The returned IPFS CID is then used as the artifact descriptor's `cid` in the manifest.

The result: every artifact's content is publicly fetchable from the IPFS gateway by anyone who can read the manifest. The `access: { kind: 'x402-gated', endpoint, priceUsdc }` plumbing is present in the schema but defeated in the upload path.

### 5.2 Required behaviour

`uploadArtifacts` is rewritten to remove the IPFS upload entirely. The new flow:

1. Read each artifact's local file.
2. Compute sha256.
3. Insert into operator's `served_artifacts` table (see §5.3) with content bytes, artifactType, request_id, and `priceUsdc` from operator config (with per-artifact override from `art.access?.priceUsdc` if provided).
4. Construct the artifact descriptor with `{ sha256, artifactType, metadata?, access: { endpoint, priceUsdc } }` — no `cid` field.
5. Emit the `jinn.artifact.emit` trajectory span as before, attaching the sha256 (not a CID) as `jinn.artifact.sha256`. Drop the `jinn.artifact.cid` attribute (it referred to per-artifact IPFS CIDs that no longer exist).

The manifest envelope itself is **still uploaded to IPFS** at the end of the engine flow — that is unchanged. The change is bounded to per-artifact content bytes.

### 5.3 New `served_artifacts` table

Add to `client/src/store/store.ts` SCHEMA:

```sql
CREATE TABLE IF NOT EXISTS served_artifacts (
  sha256 TEXT PRIMARY KEY,                 -- 64-char hex
  artifact_type TEXT NOT NULL,
  request_id TEXT,                         -- the restoration / evaluation request that produced this
  envelope_cid TEXT,                       -- the manifest envelope it was published in (set after publish)
  content BLOB NOT NULL,
  content_size INTEGER NOT NULL,
  price_usdc TEXT NOT NULL,                -- '0' allowed
  created_at TEXT NOT NULL                 -- ISO timestamp
);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_request ON served_artifacts (request_id);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_envelope ON served_artifacts (envelope_cid);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_artifact_type ON served_artifacts (artifact_type);
```

Why a new table (not an extension of the existing `artifacts` table):

- `artifacts` mixes "self-produced (id-keyed)" + "remote known" rows. Its primary key is a UUID, not a content hash. Adding x402-served-content semantics to it would either change the primary key (breaking change for peer sync) or duplicate the content under both an id key and a sha256 key.
- `served_artifacts` is purely the operator's "stuff I will serve to buyers via x402" table. Independent of peer sync. Independent of the peer-shared `artifacts.id` namespace.
- Migration path is additive — existing `artifacts` rows do not move or change.

### 5.4 x402 server route

Replace `client/src/x402/handler.ts` route registration with:

```
GET <base>/v1/artifacts/:sha256/content
```

(The legacy `/x402/artifacts/:id/content` route is **removed**, not deprecated — same single-cutover discipline as the envelope-tee-scope spec's migration.)

Handler logic:

```typescript
app.get('/v1/artifacts/:sha256/content', async (c) => {
  const sha256 = c.req.param('sha256');
  const row = store.getServedArtifact(sha256);
  if (!row) return c.json({ error: 'not found' }, 404);

  if (row.priceUsdc === '0') {
    // Free path: serve immediately, no payment dance.
    return c.body(row.content);
  }

  // Paid path: invoke x402 verification with this row's price.
  const { ok, response } = await verifyAndSettle(c.req.raw, {
    scheme: 'exact',
    payTo: config.recipientAddress,
    price: dollarStringFromUsdc(row.priceUsdc),
    network: config.network,
  }, facilitatorClient);
  if (!ok) return response;
  return c.body(row.content);
});
```

(`verifyAndSettle` is a small extraction of the in-process payment-verify helper from `@x402/hono`'s middleware — invoked per-request with dynamic price rather than configured at mount time. Implementation detail; see `docs/superpowers/plans/...` follow-up plan.)

### 5.5 Code paths affected

The fix touches:

- `client/src/restorer/engine/packaging.ts:391-462` — `uploadArtifacts` rewrite.
- `client/src/types/envelope.ts:83-106` — `Artifact` zod schema: drop `cid` field, make `access` mandatory, drop `kind` from `access`. Old: `cid: required, access: optional with kind discriminator`. New: `access: required { endpoint, priceUsdc }, cid: removed`.
- `client/src/store/store.ts` — add `served_artifacts` table + accessors.
- `client/src/x402/handler.ts` — new route pattern, dynamic per-artifact price.
- `client/src/x402/acquire.ts` — change URL builder from `/x402/artifacts/{id}/content` to `/v1/artifacts/{sha256}/content`. Caller passes `sha256` instead of `id`.
- `client/src/api/server.ts:79` — `addX402Routes` call signature changes to remove the static `pricePerArtifact` config (price now lives per-row).
- `client/src/api/peers.ts` (peer sync) — unchanged: it operates on the legacy `artifacts` table, which is unaffected. The corpus library is the new path.
- `subgraph/schema.graphql` — unchanged: the `Execution.manifestCid` indexing logic stays. Per-artifact content addressing is a manifest-internal concern that the subgraph does not surface.

### 5.6 No back-compat shims

This is a one-shot cutover, consistent with the envelope-tee-scope migration discipline (§3.4 of that spec). Old `artifacts.access.kind` values are removed from the Zod schema. Manifests published before the cutover are not retroactively re-served — testnet pre-cutover content is disposable.

---

## 6. Workstream 5 — Manifest access hygiene

### 6.1 Required-fields validation

Every artifact descriptor in a manifest envelope now requires `access.endpoint` and `access.priceUsdc`. The Zod schema enforces this at parse time:

```typescript
const ArtifactSchema = z.object({
  artifactType: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  metadata: z.object({
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    producedBy: z.object({ spanId: z.string(), trajectoryCid: z.string() }).optional(),
  }).optional(),
  access: z.object({
    endpoint: z.string().url(),
    priceUsdc: z.string().regex(/^\d+(\.\d+)?$/), // decimal-string; '0' allowed
  }),
});
```

(Note: `cid` is removed; `access` is now mandatory and has no `kind` field. Compare to the existing schema at `client/src/types/envelope.ts:83-106`.)

### 6.2 Operator-config defaults

Add to `Config` schema (`client/src/config.ts`):

```typescript
operator: z.object({
  publicEndpoint: z.string().url(),         // operator's externally-reachable base URL
  defaultPriceUsdc: z.string().default('0'),// per-artifact default price; '0' = optimistic mode
  perArtifactTypePrice: z.record(           // optional per-type override
    z.string(),                             // artifact type, e.g. 'trajectory'
    z.string().regex(/^\d+(\.\d+)?$/),
  ).default({}),
}).optional(),
```

Env overrides:

| Config key | Env var |
|---|---|
| `operator.publicEndpoint` | `JINN_OPERATOR_PUBLIC_ENDPOINT` |
| `operator.defaultPriceUsdc` | `JINN_OPERATOR_DEFAULT_PRICE_USDC` |

`operator.perArtifactTypePrice` is config-file only (deeply structured).

The packaging path resolves an artifact's price as:

```
priceUsdc = artifact.access?.priceUsdc           // OUTPUTS.json explicit override
         ?? operator.perArtifactTypePrice[type]  // operator per-type default
         ?? operator.defaultPriceUsdc            // operator global default
         ?? '0';                                 // protocol-level default
```

The endpoint is resolved as:

```
endpoint = operator.publicEndpoint              // mandatory if any artifact is published
```

If `operator.publicEndpoint` is unset and the operator attempts to publish artifacts, packaging fails with a config error. (No silent fallback to `localhost`; that just produces unfetchable manifests.)

### 6.3 Validation hook

A new helper `validateManifestForPublish(envelope: SignedEnvelope): void` runs **before** the engine uploads the manifest to IPFS. It fails loudly if any artifact lacks `access.endpoint` or `access.priceUsdc`. This is belt-and-suspenders against future code paths that bypass the OUTPUTS.json/config flow.

### 6.4 Why default `'0'` and not a non-zero number

Per Discussion #59 §1 (optimistic-mode bootstrap): the protocol ships with `priceUsdc = '0'` as the default. Pricing is opt-in, asynchronous, operator-flipped. A non-zero default would force every operator to opt out of pricing instead of opting in, which inverts the bootstrap.

Operators flip to non-zero pricing by editing one config field. No plumbing change is required.

---

## 7. Build sequence

The five workstreams have a dependency order. A correct build sequence (which a follow-up implementation plan will expand into Beads issues) is:

1. **Schema migrations land first.** `served_artifacts` and `network_artifacts` tables added to `Store.SCHEMA`. Accessor methods added. **No callers yet.**
2. **Gating leak fix lands second.** `uploadArtifacts` rewritten to write into `served_artifacts` instead of IPFS. Artifact descriptor schema updated (drop `cid`, make `access` mandatory). x402 handler swapped to the new `:sha256` route + dynamic price. The existing single-operator restorer e2e test (`scripts/e2e-validate.ts`) still passes — it does not exercise corpus reads.
3. **Manifest hygiene lands third.** Operator config additions, packaging price resolution, validation hook. Existing e2e test still passes.
4. **Corpus library lands fourth.** New module under `client/src/corpus/`. Standalone unit tests; integration test against an Anvil fork with two operators (operator B reads what operator A produced).
5. **MCP rewiring lands fifth.** `search_artifacts` and `acquire_artifact` tool implementations updated. Local-store fast path validated. The default-learning-restorer (Phase A.2 anchor) gains the ability to read corpus content from inside its phases.

Each step lands as its own PR. Steps 1–3 do **not** require steps 4–5 to be in flight; they bring the leak fix to ground without the consuming side. Step 4 is the longest single piece of work and will likely decompose into 3–5 sub-issues during plan-writing.

---

## 8. Acceptance — Phase A.1 cross-operator e2e

The Phase A.1 gate from Discussion #59 §5: *"Cross-operator end-to-end test passes on testnet: operator B's restorer queries the corpus for analogous trajectories, pays operator A via x402, fetches, verifies content hash, applies. The path works."*

The concrete test (`client/scripts/corpus-e2e-validate.ts`, to be created):

1. Spin up two daemons against an Anvil fork of Base. Each has its own EOA, Safe, mech, and config. Operator A's `defaultPriceUsdc = '0.001'`. Operator B's price is irrelevant for this test (it does not publish; it reads).
2. Operator A receives a synthetic intent and runs a restoration. Manifest publishes to IPFS. Trajectory + at least one output artifact land in operator A's `served_artifacts`.
3. Operator B (separate process, separate DB) calls `corpus.read({ query: { intentCid: <A's intent>, limit: 1 } })`.
4. The library queries the local-fork subgraph, fetches the manifest from IPFS, finds `access: { endpoint: <operator A's URL>, priceUsdc: '0.001' }`, hits operator A's `/v1/artifacts/<sha256>/content` with `wrapFetchWithPayment`, signs an EIP-3009 payment via operator B's EOA, the facilitator settles on the Anvil fork, operator B receives bytes.
5. Library hash-verifies; persists to operator B's `network_artifacts` with `paid_amount_usdc = '0.001'`, `source_operator = <A's safe>`.
6. Test asserts: bytes are non-empty; `network_artifacts` row exists; second invocation of `corpus.read` does **not** make a network call (cache hit).
7. Test asserts: operator A's USDC balance increased by `0.001` and operator B's decreased by the same.

If this test passes on the Anvil fork in CI, the Phase A.1 gate from Discussion #59 §5 is empirically met. The same test runs on Base Sepolia testnet for the actual gate trip.

---

## 9. Out of scope

The following are deferred to other specs or off-roadmap. Each is named so reviewers know we considered it and chose not to pull it in.

- **Per-layer plug-in mechanism for the default harness.** Phase A.2 sibling spec (`spec/2026-04-30-plug-in-surface-design.md`, jinn-mono-a9w9 child issue).
- **Royalty splits, component-level pricing, derived-work residuals.** Off-roadmap entirely. Single-creator / single-payment per DR-2026-04-30 §3.
- **Multi-evaluator consensus, attested-tier production paths.** Phase B.1 / B.2.
- **Encrypted-at-rest content on IPFS.** Discussed during this spec's design conversation; deferred. v0 schema is forward-compatible (a future `access.kind` discriminator can introduce `'x402-encrypted-ipfs'` without changing the descriptor shape for existing content).
- **CID-as-secret gating** (publishing to IPFS without disclosing the CID). Rejected on security-by-obscurity grounds during this spec's design conversation.
- **DRM / re-distribution control.** Off-roadmap. Once a buyer has bytes, they own them; reputation is the long-term creator asset.
- **Cache eviction policy.** v0 cache is unbounded. Eviction is a Phase B follow-up; the schema records `last_used_at` so a future eviction layer needs no migration.
- **Polymarket-derived intent posting, Brier-vs-Polymarket dashboard, default-learner network integration plan.** Phase A children of jinn-mono-vy37; sibling specs/plans.
- **Trajectory content indexing** (querying over OTel span content). Out per envelope-tee-scope §3.3.
- **UI surfaces.** The first app is a programmatic library, not a UI. UIs are downstream apps (Phase C+).
- **Default-gated envelope policy decision record.** A separate child issue under jinn-mono-vy37 captures the choice that v0 ships with `priceUsdc = '0'` defaults; the policy lives there.

---

## 10. Open questions

These do not block scope handoff, but the follow-up implementation plan should resolve them before code is written.

1. **MCP `acquire_artifact` access pass-through vs. server-derived.** The spec proposes the agent passes `access` from `search_artifacts` through to `acquire_artifact`. Alternative: the MCP server resolves the manifest CID itself and reads `access` from the envelope. Trade-off: schema simplicity (server resolves) vs. server statelessness (pass-through). The decision record in §4.4 calls this out.
2. **`fetchManifest` IPFS gateway fallback policy.** The existing `fetchFromIpfs` helper retries primary gateway then `ipfs.io` fallback. Does the corpus library expose retry / timeout knobs to callers, or use a fixed policy?
3. **`select` callback timeout.** A buggy or slow `select` callback can stall the whole `read()` pipeline. Should the library impose a timeout (e.g. 5s) and abort with `SelectTimeoutError`? v0 default: no timeout. Open for revision.
4. **Eviction policy** (already flagged in §3.3).
5. **`wrapFetchWithPayment` price-cap.** Should the corpus library let callers set a `maxPriceUsdc` per-call so a misconfigured manifest can not bankrupt the buyer? Strong yes for production, but adds API surface. v0: rely on operator-side budget controls (separate concern). Spec flags this for Phase B revisit.
6. **Subgraph kind filtering granularity.** `Execution.kind` in the subgraph (`subgraph/schema.graphql:67-71`) is `ENVELOPE | EVALUATION | OTHER` (router-level), not per-intent-kind. The corpus library currently fetches manifests and filters by `kind` client-side. If kind-filtering on the subgraph itself becomes a hot path, surface a per-intent-kind field. Out for v0.
7. **`served_artifacts` retention.** v0 keeps forever. Operators with disk pressure will need an eviction story. Spec flags but does not commit. Operator-config sketch: `operator.served.evictAfterDays` — Phase B.
8. **Hash-mismatch reputation hooks.** §2.5 says hash mismatch logs at error level but does not emit anywhere; Phase B reputation work is the natural consumer. The integration point (event channel? table row?) is intentionally undecided here.

---

## 11. References

- Discussion #59 — *Jinn as the knowledge market — implementation roadmap proposal* (substrate vision)
- Discussion #57 — *Unified GTM around the Prediction SolverNet* (paired GTM, sibling)
- Discussion #41 — *Sharpening Jinn's value proposition* (lineage)
- `log/decisions/2026-04-30-knowledge-market-vision-framing.md` — DR-2026-04-30
- `spec/2026-04-30-knowledge-market-vision-discussion.md` — discussion draft
- `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` — envelope schema, evidence tiers
- `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` — ERC-8004 operator-rooted entity model
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` — Phase A.2 anchor (canonical agent-as-buyer)
- `client/src/restorer/engine/packaging.ts:387-460` — the leak
- `client/src/store/store.ts` — current store + new tables
- `client/src/x402/{handler,acquire,facilitator}.ts` — payment plumbing
- `client/src/mcp/server.ts:160-260` — local-store-only MCP tools to be rewired
- `client/src/types/envelope.ts` — envelope and artifact zod schemas
- `client/src/api/server.ts` — Hono app + x402 mounting
- `subgraph/schema.graphql` — canonical indexer (infrastructure)

---

*End of spec. Ratification path: Captain reviews; if approved, follow-up implementation plan ratifies build sequence + decomposes corpus library into sub-issues (`docs/superpowers/plans/2026-04-30-phase-a-umbrella-plan.md`).*
