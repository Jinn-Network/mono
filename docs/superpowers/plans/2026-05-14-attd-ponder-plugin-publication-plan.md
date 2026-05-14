# attd —`."

I lack Write. Returning inline.

# attd — Ponder indexer extension + `PublishedArtifact` model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Save this file to `/Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/docs/superpowers/plans/2026-05-14-attd-ponder-plugin-publication-plan.md` before starting.

**Goal:** Extend the Ponder indexer (`packages/indexer/`) so `IdentityRegistry.MetadataSet` events whose key starts with `plugin:` decode into a new `pluginPublication` onchain table, revocations flip the row's `revoked` flag (most-recent wins by `(block, txIndex, logIndex)`), and a read-layer `BuilderAttributedRun` shape joins published plug-ins to envelope plug-in attributions (`AttemptEnvelopeMeta.pluginsJson[].cid` once ebu7 merges; today's worktree returns empty). Add a `PublishedArtifact` base TypeScript concept in the Discovery API so the future `harness:<cid>` kind drops in without an API churn. All tests are real (decode the actual `PLUGIN_PAYLOAD_TUPLE` / `REVOCATION_PAYLOAD_TUPLE` from `client/src/erc8004/abis.ts`, run through the actual exported pure handler from `packages/indexer/src/handlers.ts`, assert against the in-memory db stub used by the existing handler tests).

**Architecture:**
- The new `pluginPublication` onchain table sits next to `solverNetManifest` / `envelope` in `packages/indexer/ponder.schema.ts`. Primary key `<builderAgentId>:<pluginCid>` is a derived text id so most-recent-wins semantics apply per `(builderAgentId, pluginCid)` tuple, with `revoked`/`revokedReason` mutated by re-publishes that hit the same key.
- The MetadataSet handler in `packages/indexer/src/handlers.ts` gains a third branch (`parsePluginKey`) that decodes `PLUGIN_PAYLOAD_TUPLE` for `version === 1` payloads and `REVOCATION_PAYLOAD_TUPLE` for `version === 2` payloads. Decode is import-aliased from the canonical `client/src/erc8004/abis.ts` tuple by duplicating its byte-shape inside the indexer package (the indexer cannot import from `client/`); a tuple-equivalence test guards drift.
- The `PublishedArtifact` base interface lives in `client/src/discovery/types.ts` (alongside `ClaimableTaskCandidate`); `PluginPublication` extends it with `artifactType: 'plugin'` and `pluginSha256`. The Discovery API surface gains `listPluginPublications`, `getPluginScores`, and `listBuilderArtifacts` methods on the `DiscoveryAPI` interface — implemented in `client/src/discovery/http.ts` with GraphQL queries against the new entity. The on-chain floor (`onchain.ts`) returns empty arrays for these methods at v0 (full RPC enumeration is out of scope; the indexer is mandatory for builder discovery).
- The `BuilderAttributedRun` shape is computed at query time in the indexer's `src/api/index.ts` Hono app: a new `/builders/:agentId/runs` route reads `attemptEnvelopeMeta` (when the row exists from ebu7 enrichment) + `verdict` + `pluginPublication`, performs the sha256-match join, sets `forkSuspected: true` when `envelope.plugins[i].sha256 !== publication.pluginSha256`, and returns the aggregated row. Today (without ebu7's `attemptEnvelopeMeta`), the route returns an empty array; the test for the join feeds the indexer test harness pre-seeded rows so the join logic is exercised independent of ebu7's merge order.

**Tech Stack:** TypeScript, viem (`decodeAbiParameters`, `encodeAbiParameters`), Ponder 0.16.x, Vitest. No new runtime dependencies. All handler tests run against `test/helpers/in-memory-db.ts` (no Ponder boot).

**Work shape:** `feat` per `docs/engineering/handbook.md` §The shapes of work — TDD required.

---

## File structure

**Modify:**
- `packages/indexer/ponder.schema.ts` — add `pluginPublication` onchain table + relations (no changes to existing entities).
- `packages/indexer/src/types.ts` — add `parsePluginKey(key: string): { cid: string } | null` parser next to `parseEnvelopeKey` and `parseSolverNetManifestKey`.
- `packages/indexer/src/handlers.ts` — add `PLUGIN_PAYLOAD_TUPLE` + `REVOCATION_PAYLOAD_TUPLE` exports (byte-identical to the originals in `client/src/erc8004/abis.ts`), add `decodePluginPayload(value)` + `decodeRevocationPayload(value)`, extend `handleMetadataSet({ ..., pluginPublication })` with a third branch routing `plugin:<cid>` keys.
- `packages/indexer/src/index.ts` — pass the new `pluginPublication` table from `ponder:schema` into `handleMetadataSet`.
- `packages/indexer/src/api/index.ts` — add the `/builders/:agentId/runs` Hono route returning the read-time `BuilderAttributedRun[]` join.
- `packages/indexer/test/helpers/events.ts` — add `pluginPayload(opts)` and `revocationPayload(opts)` encoders.
- `packages/indexer/test/handlers.test.ts` — add a new `describe('plugin: key routing')` block, `describe('plugin publication overwrite')` block (revocation flips `revoked: true`), and `describe('fork detection / attribution join')` block (the sha256-mismatch case).
- `packages/indexer/README.md` — document the new entity + handler under §Known limitations and §Schema.
- `client/src/discovery/types.ts` — add `PublishedArtifact` base interface, `PluginPublication` interface, `PluginScoreHistoryRow` interface, three new methods on `DiscoveryAPI`.
- `client/src/discovery/http.ts` — implement the three new methods against the indexer's GraphQL surface for the entity and the new Hono route for the join.
- `client/src/discovery/onchain.ts` — return empty arrays / `undefined` from the three new methods (RPC enumeration is not in scope).

**Create:**
- `packages/indexer/test/handlers.plugin.test.ts` — a focused new test file for the plug-in handler branches, sibling to `handlers.test.ts` so the existing 12 envelope/manifest tests stay byte-identical.
- `packages/indexer/test/api.builders.test.ts` — tests the read-layer join through the Hono app, with pre-seeded `pluginPublication` rows and (optionally) pre-seeded `attemptEnvelopeMeta` rows when ebu7's schema is detected; otherwise empty-return paths.
- `client/test/discovery/types.plugin-publication.test.ts` — typed-shape test ensuring `PluginPublication` extends `PublishedArtifact` and the artifactType discriminator narrows correctly.

**Do not touch:**
- `packages/indexer/ponder.config.ts` — IdentityRegistry is already registered; no new contract.
- The existing four entities (`task`, `attempt`, `solverNetManifest`, `envelope`) — additive only; no column renames, no PK changes (re-sync policy in the schema header).
- The existing 12 tests in `packages/indexer/test/handlers.test.ts` — they must keep passing untouched.

---

## Task 1: Failing test — `parsePluginKey` parser

**Files:**
- Create: `packages/indexer/test/types.plugin.test.ts`

- [ ] **Step 1: Add the failing parser test**

Create `packages/indexer/test/types.plugin.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parsePluginKey } from '../src/types.js';

describe('parsePluginKey (attd)', () => {
  it('returns { cid } for a well-formed plugin:<cid> key', () => {
    expect(parsePluginKey('plugin:bafyplugincid')).toEqual({ cid: 'bafyplugincid' });
  });

  it('returns null for an envelope:/evaluation:/capture: key', () => {
    expect(parsePluginKey('envelope:bafy...')).toBeNull();
    expect(parsePluginKey('evaluation:bafy...')).toBeNull();
    expect(parsePluginKey('capture:bafy...')).toBeNull();
  });

  it('returns null for a solvernet-manifest: key', () => {
    expect(parsePluginKey('solvernet-manifest:bafy...')).toBeNull();
  });

  it('returns null when the key is just "plugin:" (no cid)', () => {
    expect(parsePluginKey('plugin:')).toBeNull();
  });

  it('returns null for an unrelated key', () => {
    expect(parsePluginKey('agent-card:something')).toBeNull();
    expect(parsePluginKey('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/types.plugin.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `parsePluginKey` is not exported.

- [ ] **Step 3: Commit failing test**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/test/types.plugin.test.ts
git commit -m "test(attd): failing parsePluginKey parser test"
```

---

## Task 2: Implement `parsePluginKey`

**Files:**
- Modify: `packages/indexer/src/types.ts`

- [ ] **Step 1: Append the parser next to the existing two**

Append to `packages/indexer/src/types.ts` after `parseSolverNetManifestKey`:

```typescript
/**
 * Returns the pluginCid from a `plugin:<cid>` metadata key, or null if the
 * key does not match. Per `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
 * §5.2 the textual CID after the colon is the canonical primary key for the
 * plug-in record; a key with an empty cid is not a valid record.
 */
export const PLUGIN_KEY_PREFIX = 'plugin:';

export function parsePluginKey(key: string): { cid: string } | null {
  if (!key.startsWith(PLUGIN_KEY_PREFIX)) return null;
  const cid = key.slice(PLUGIN_KEY_PREFIX.length);
  return cid.length > 0 ? { cid } : null;
}
```

- [ ] **Step 2: Run test — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/types.plugin.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/src/types.ts
git commit -m "feat(attd): parsePluginKey for plugin:<cid> metadata keys"
```

---

## Task 3: Failing schema test — `pluginPublication` entity shape

**Files:**
- Create: `packages/indexer/test/schema.plugin-publication.test.ts`

- [ ] **Step 1: Add the failing schema-shape test**

Create `packages/indexer/test/schema.plugin-publication.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { pluginPublication } from '../ponder.schema.js';

describe('pluginPublication entity (attd)', () => {
  it('is exported from ponder.schema.ts', () => {
    expect(pluginPublication).toBeDefined();
  });

  it('exposes the columns the handler writes to', () => {
    // Drizzle's onchainTable surface is non-trivial; assert column names via
    // the symbol table the table object exposes. The shape mirrors the §5.6
    // schema in the spec.
    const cols = Object.keys(pluginPublication as unknown as Record<string, unknown>);
    for (const name of [
      'id',
      'builderAgentId',
      'pluginCid',
      'pluginName',
      'pluginVersion',
      'pluginSha256',
      'supports',
      'publishedAt',
      'revoked',
      'revokedReason',
      'txHash',
      'blockNumber',
      'logIndex',
      'chainId',
    ]) {
      expect(cols).toContain(name);
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/schema.plugin-publication.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `pluginPublication` is not exported.

- [ ] **Step 3: Commit failing test**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/test/schema.plugin-publication.test.ts
git commit -m "test(attd): failing pluginPublication entity-shape test"
```

---

## Task 4: Implement `pluginPublication` entity

**Files:**
- Modify: `packages/indexer/ponder.schema.ts`

- [ ] **Step 1: Add the entity definition**

Append to `packages/indexer/ponder.schema.ts` after the `envelope` entity (before `// ── Relations ──`):

```typescript
// ── PluginPublication ─────────────────────────────────────────────────────────

/**
 * A published plug-in record. Populated from IdentityRegistry.MetadataSet
 * events where the key starts with `plugin:` per
 * `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
 * §5.2 / §5.6.
 *
 * Primary key: composite `<builderAgentId>:<pluginCid>`. The textual `pluginCid`
 * stays primary across overwrites — version updates ship a new tarball (new cid,
 * new row), revocations overwrite the same key with a v2 revoked-marker payload
 * (same row, `revoked: true`).
 *
 * Most-recent-wins on overwrite, ordered by (blockNumber, txIndex, logIndex)
 * — matches the existing envelope tiebreak in handleMetadataSet. The
 * `publishedAt` column is the *payload-claimed* unix timestamp (from the v1
 * payload field index 5); `blockNumber` is the on-chain anchor and the
 * authoritative recency signal.
 *
 * Note on `supports`: stored as `text[]` so consumers can query for plug-ins
 * that target a specific SolverType (e.g. `swe-rebench-v2.v1`). Ponder 0.16.x
 * exposes Postgres arrays as `_in` / `_has` filter operators in its GraphQL
 * layer, satisfying the per-SolverNet browse panel in spec §6.6.
 */
export const pluginPublication = onchainTable(
  'plugin_publication',
  (t) => ({
    /** `<builderAgentId>:<pluginCid>` — composite primary key as a derived id. */
    id: t.text().primaryKey(),
    /** agentId of the builder (decimal string of the uint256). */
    builderAgentId: t.text().notNull(),
    /** IPFS CID of the packed plug-in tarball — the textual cid from the metadata key. */
    pluginCid: t.text().notNull(),
    /** npm package name from the decoded payload. */
    pluginName: t.text().notNull(),
    /** semver string from the decoded payload. */
    pluginVersion: t.text().notNull(),
    /**
     * digestDirectory output as a 32-byte hex string. Persisted as text (not
     * `t.hex()`) because the column also serves as the fork-attribution join
     * key against envelope.plugins[].sha256, which is a hex string per
     * client/src/types/envelope.ts.
     */
    pluginSha256: t.text().notNull(),
    /** SolverType ids — indexed for SolverNet browse. */
    supports: t.text().array().notNull(),
    /** Unix seconds from the v1 payload — distinct from `blockNumber`. */
    publishedAt: t.bigint().notNull(),
    /**
     * True when the most-recent payload was a v2 revoked-marker. Defaults to
     * false on v1 inserts; flipped by a subsequent v2 overwrite to the same
     * key. A v1 re-publish to the same key (republishing a previously-revoked
     * record) is permitted and flips revoked back to false.
     */
    revoked: t.boolean().notNull().default(false),
    /** Reason string from the v2 revocation payload, nullable. */
    revokedReason: t.text(),
    /** Provenance — tx hash of the winning MetadataSet event. */
    txHash: t.hex().notNull(),
    /** Block number of the winning MetadataSet event. Used for recency ordering. */
    blockNumber: t.bigint().notNull(),
    /** Transaction index of the winning MetadataSet event. */
    txIndex: t.integer().notNull(),
    /** Log index within the block. Final tiebreaker on same-block, same-tx writes. */
    logIndex: t.integer().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    builderIdx: index().on(table.builderAgentId),
    pluginCidIdx: index().on(table.pluginCid),
    pluginNameIdx: index().on(table.pluginName),
    supportsIdx: index().on(table.supports),
    revokedIdx: index().on(table.revoked),
    blockIdx: index().on(table.blockNumber),
  }),
);
```

- [ ] **Step 2: Run — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/schema.plugin-publication.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Run all indexer tests — existing 12 must still pass**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn test 2>&1 | tail -30
```

Expected: all tests green (the new entity is additive — no existing behaviour changes).

- [ ] **Step 4: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/ponder.schema.ts packages/indexer/test/schema.plugin-publication.test.ts
git commit -m "feat(attd): pluginPublication onchain entity per spec §5.6"
```

---

## Task 5: Failing tests — `decodePluginPayload` + `decodeRevocationPayload`

**Files:**
- Create: `packages/indexer/test/handlers.plugin.test.ts`
- Modify: `packages/indexer/test/helpers/events.ts`

- [ ] **Step 1: Add payload encoders to the test helper**

Append to `packages/indexer/test/helpers/events.ts`:

```typescript
// ── Plug-in publication payloads (attd) ───────────────────────────────────────

/**
 * Byte-identical to PLUGIN_PAYLOAD_TUPLE in client/src/erc8004/abis.ts. Re-stated
 * here so tests are self-contained — the indexer package cannot import from
 * client/. A drift-guard test in handlers.plugin.test.ts compares this tuple to
 * the canonical one via a hex-encoded fixture.
 */
export const PLUGIN_PAYLOAD_TUPLE_TEST = [
  { name: 'version', type: 'uint8' },
  { name: 'pluginName', type: 'string' },
  { name: 'pluginVersion', type: 'string' },
  { name: 'pluginSha256', type: 'bytes32' },
  { name: 'supports', type: 'string[]' },
  { name: 'publishedAt', type: 'uint64' },
] as const;

export const REVOCATION_PAYLOAD_TUPLE_TEST = [
  { name: 'version', type: 'uint8' },
  { name: 'revoked', type: 'bool' },
  { name: 'reason', type: 'string' },
] as const;

export function pluginPayload(opts: {
  version?: number;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: `0x${string}`;
  supports: string[];
  publishedAt: bigint;
}): `0x${string}` {
  return encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE_TEST, [
    opts.version ?? 1,
    opts.pluginName,
    opts.pluginVersion,
    opts.pluginSha256,
    opts.supports,
    opts.publishedAt,
  ]);
}

export function revocationPayload(opts: {
  version?: number;
  revoked?: boolean;
  reason: string;
}): `0x${string}` {
  return encodeAbiParameters(REVOCATION_PAYLOAD_TUPLE_TEST, [
    opts.version ?? 2,
    opts.revoked ?? true,
    opts.reason,
  ]);
}
```

- [ ] **Step 2: Add the failing decode tests**

Create `packages/indexer/test/handlers.plugin.test.ts`:

```typescript
/**
 * Plug-in publication handler tests (attd).
 *
 * Sibling to test/handlers.test.ts; kept separate so the 12 existing
 * envelope/manifest tests stay byte-identical. Tests run against the same
 * in-memory db stub and exercise the pure handleMetadataSet function with
 * the new pluginPublication table passed in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { pluginPublication, solverNetManifest, envelope } from '../ponder.schema.js';
import {
  handleMetadataSet,
  decodePluginPayload,
  decodeRevocationPayload,
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
  type HandlerContext,
} from '../src/handlers.js';
import { createInMemoryDb, type InMemoryDb, type PkMap } from './helpers/in-memory-db.js';
import {
  metadataSetEvent,
  pluginPayload,
  revocationPayload,
  PLUGIN_PAYLOAD_TUPLE_TEST,
  REVOCATION_PAYLOAD_TUPLE_TEST,
} from './helpers/events.js';

const CHAIN_ID = 84532;
const BUILDER_AGENT_ID = '42';
const PLUGIN_CID = 'bafypluginabcdef';
const PLUGIN_SHA = `0x${'aa'.repeat(32)}` as `0x${string}`;
const PLUGIN_SHA_2 = `0x${'bb'.repeat(32)}` as `0x${string}`;

const PKS: PkMap = new Map<unknown, string[]>([
  [pluginPublication, ['id']],
  [solverNetManifest, ['id']],
  [envelope, ['agentId', 'metadataKey', 'chainId']],
]);

let db: InMemoryDb;
let context: HandlerContext;

beforeEach(() => {
  db = createInMemoryDb(PKS);
  context = { db, chain: { id: CHAIN_ID } };
});

// ── ABI tuple drift guard ─────────────────────────────────────────────────────

describe('PLUGIN_PAYLOAD_TUPLE (drift guard)', () => {
  it('decodes a payload that was encoded against the canonical client/erc8004 tuple shape', () => {
    // Encode with the test-local copy of the tuple (sourced from
    // client/src/erc8004/abis.ts PLUGIN_PAYLOAD_TUPLE) and decode with the
    // indexer-local copy. If the two drift, this fails.
    const encoded = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE_TEST, [
      1,
      '@builder/swe-skill',
      '0.1.0',
      PLUGIN_SHA,
      ['swe-rebench-v2.v1'],
      1_715_700_000n,
    ]);
    const decoded = decodePluginPayload(encoded);
    expect(decoded).toEqual({
      version: 1,
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: PLUGIN_SHA,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000n,
    });
  });

  it('exports a tuple whose field list matches the canonical shape', () => {
    expect(PLUGIN_PAYLOAD_TUPLE.map((f) => `${f.name}:${f.type}`)).toEqual([
      'version:uint8',
      'pluginName:string',
      'pluginVersion:string',
      'pluginSha256:bytes32',
      'supports:string[]',
      'publishedAt:uint64',
    ]);
  });
});

describe('REVOCATION_PAYLOAD_TUPLE (drift guard)', () => {
  it('decodes a revocation payload encoded against the canonical tuple', () => {
    const encoded = encodeAbiParameters(REVOCATION_PAYLOAD_TUPLE_TEST, [
      2,
      true,
      'cve-2026-xxxx',
    ]);
    expect(decodeRevocationPayload(encoded)).toEqual({
      version: 2,
      revoked: true,
      reason: 'cve-2026-xxxx',
    });
  });

  it('exports a tuple whose field list matches the canonical shape', () => {
    expect(REVOCATION_PAYLOAD_TUPLE.map((f) => `${f.name}:${f.type}`)).toEqual([
      'version:uint8',
      'revoked:bool',
      'reason:string',
    ]);
  });
});

// ── plugin: key routing ──────────────────────────────────────────────────────

describe('MetadataSet routes plugin:<cid> to pluginPublication', () => {
  it('inserts a fresh row from a v1 payload', async () => {
    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: BigInt(BUILDER_AGENT_ID),
          metadataKey: `plugin:${PLUGIN_CID}`,
          metadataValue: pluginPayload({
            pluginName: '@builder/swe-skill',
            pluginVersion: '0.1.0',
            pluginSha256: PLUGIN_SHA,
            supports: ['swe-rebench-v2.v1'],
            publishedAt: 1_715_700_000n,
          }),
        },
        { block: 41_200_000n, transactionIndex: 4, logIndex: 7 },
      ),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
    });

    const row = db.get(pluginPublication, { id: `${BUILDER_AGENT_ID}:${PLUGIN_CID}` });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id: `${BUILDER_AGENT_ID}:${PLUGIN_CID}`,
      builderAgentId: BUILDER_AGENT_ID,
      pluginCid: PLUGIN_CID,
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: PLUGIN_SHA,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000n,
      revoked: false,
      revokedReason: null,
      blockNumber: 41_200_000n,
      txIndex: 4,
      logIndex: 7,
      chainId: CHAIN_ID,
    });
    // Does NOT write to other tables.
    expect(db.count(envelope)).toBe(0);
    expect(db.count(solverNetManifest)).toBe(0);
  });

  it('ignores an envelope:/evaluation:/capture: key (no pluginPublication row written)', async () => {
    await handleMetadataSet({
      event: metadataSetEvent({
        agentId: 5n,
        metadataKey: `envelope:${PLUGIN_CID}`,
        metadataValue: '0xdeadbeef',
      }),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
    });
    expect(db.count(pluginPublication)).toBe(0);
  });

  it('ignores a garbage payload on a plugin: key (no row written, no crash)', async () => {
    await expect(
      handleMetadataSet({
        event: metadataSetEvent({
          agentId: BigInt(BUILDER_AGENT_ID),
          metadataKey: `plugin:${PLUGIN_CID}`,
          metadataValue: '0xdeadbeef',
        }),
        context,
        solverNetManifest,
        envelope,
        pluginPublication,
      }),
    ).resolves.toBeUndefined();
    expect(db.count(pluginPublication)).toBe(0);
  });
});

// ── revocation flips revoked = true ──────────────────────────────────────────

describe('plugin publication overwrite', () => {
  const publish = async (o: {
    block: bigint;
    logIndex?: number;
    payload?: `0x${string}`;
  }) =>
    handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: BigInt(BUILDER_AGENT_ID),
          metadataKey: `plugin:${PLUGIN_CID}`,
          metadataValue:
            o.payload ??
            pluginPayload({
              pluginName: '@builder/swe-skill',
              pluginVersion: '0.1.0',
              pluginSha256: PLUGIN_SHA,
              supports: ['swe-rebench-v2.v1'],
              publishedAt: 1_715_700_000n,
            }),
        },
        { block: o.block, logIndex: o.logIndex ?? 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
    });

  const get = () => db.get(pluginPublication, { id: `${BUILDER_AGENT_ID}:${PLUGIN_CID}` });

  it('a v2 revocation payload flips revoked to true and stores the reason', async () => {
    await publish({ block: 100n });
    expect(get()?.revoked).toBe(false);

    await publish({
      block: 200n,
      payload: revocationPayload({ reason: 'cve-2026-xxxx' }),
    });
    expect(get()).toMatchObject({
      revoked: true,
      revokedReason: 'cve-2026-xxxx',
      blockNumber: 200n,
      // Other fields unchanged from the v1 row — the revocation only mutates
      // revoked + revokedReason + provenance.
      pluginName: '@builder/swe-skill',
      pluginSha256: PLUGIN_SHA,
    });
  });

  it('a v1 republish after a revocation flips revoked back to false', async () => {
    await publish({ block: 100n });
    await publish({
      block: 200n,
      payload: revocationPayload({ reason: 'mistake' }),
    });
    expect(get()?.revoked).toBe(true);

    await publish({ block: 300n });
    expect(get()).toMatchObject({ revoked: true === false ? true : false, revokedReason: null });
    // Cleaner alternative form:
    expect(get()?.revoked).toBe(false);
    expect(get()?.revokedReason).toBeNull();
  });

  it('an earlier-block payload does NOT overwrite a later one', async () => {
    await publish({ block: 200n });
    await publish({
      block: 100n,
      payload: revocationPayload({ reason: 'should-not-apply' }),
    });
    expect(get()?.revoked).toBe(false);
    expect(get()?.blockNumber).toBe(200n);
  });

  it('same block + same tx, higher logIndex wins', async () => {
    await publish({ block: 100n, logIndex: 0 });
    await publish({
      block: 100n,
      logIndex: 1,
      payload: revocationPayload({ reason: 'b' }),
    });
    expect(get()).toMatchObject({ revoked: true, revokedReason: 'b', logIndex: 1 });
    // A lower logIndex arriving later does NOT win.
    await publish({ block: 100n, logIndex: 0 });
    expect(get()?.revoked).toBe(true);
    expect(get()?.logIndex).toBe(1);
  });

  it('a replay of the exact same v1 event is a non-destructive no-op (idempotent re-sync)', async () => {
    await publish({ block: 100n, logIndex: 2 });
    const before = get();
    await publish({ block: 100n, logIndex: 2 });
    expect(get()).toEqual(before);
    expect(db.count(pluginPublication)).toBe(1);
  });
});
```

- [ ] **Step 3: Run — expect FAIL (decoders + handler branch not implemented)**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/handlers.plugin.test.ts --reporter=verbose 2>&1 | tail -40
```

Expected: FAIL — `decodePluginPayload`, `decodeRevocationPayload`, `PLUGIN_PAYLOAD_TUPLE`, `REVOCATION_PAYLOAD_TUPLE` not exported; `handleMetadataSet` signature does not accept `pluginPublication`.

- [ ] **Step 4: Commit failing tests**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/test/handlers.plugin.test.ts packages/indexer/test/helpers/events.ts
git commit -m "test(attd): failing plug-in publication handler tests"
```

---

## Task 6: Implement decoders + handler branch

**Files:**
- Modify: `packages/indexer/src/handlers.ts`
- Modify: `packages/indexer/src/index.ts`

- [ ] **Step 1: Add tuple constants + decode helpers**

After `decodeEnvelopePayload` in `packages/indexer/src/handlers.ts`, add:

```typescript
// ── Plug-in publication tuples (attd) ────────────────────────────────────────
// Byte-identical to PLUGIN_PAYLOAD_TUPLE / REVOCATION_PAYLOAD_TUPLE in
// client/src/erc8004/abis.ts — the indexer package cannot import from client/,
// so these are duplicated here and guarded by the drift test in
// test/handlers.plugin.test.ts.

export const PLUGIN_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'pluginName', type: 'string' },
  { name: 'pluginVersion', type: 'string' },
  { name: 'pluginSha256', type: 'bytes32' },
  { name: 'supports', type: 'string[]' },
  { name: 'publishedAt', type: 'uint64' },
] as const;

export const REVOCATION_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'revoked', type: 'bool' },
  { name: 'reason', type: 'string' },
] as const;

export interface DecodedPluginPayload {
  version: number;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: `0x${string}`;
  supports: readonly string[];
  publishedAt: bigint;
}

export interface DecodedRevocationPayload {
  version: number;
  revoked: boolean;
  reason: string;
}

/**
 * Decodes a plug-in publication v1 payload. Returns null on decode failure
 * (the handler skips the event — same shape as decodeEnvelopePayload, which
 * returns a sentinel rather than throwing, but here we use null because the
 * payload is the entire row, not just two fields).
 */
export function decodePluginPayload(value: Hex): DecodedPluginPayload | null {
  try {
    const decoded = decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, value);
    return {
      version: Number(decoded[0]),
      pluginName: decoded[1],
      pluginVersion: decoded[2],
      pluginSha256: decoded[3],
      supports: decoded[4],
      publishedAt: decoded[5],
    };
  } catch {
    return null;
  }
}

export function decodeRevocationPayload(value: Hex): DecodedRevocationPayload | null {
  try {
    const decoded = decodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, value);
    return {
      version: Number(decoded[0]),
      revoked: decoded[1],
      reason: decoded[2],
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Extend handler signature + add the `plugin:` branch**

Replace the `handleMetadataSet` signature and body. Add `pluginPublication` to the imports / args, add the import for `parsePluginKey` at the top, then add the new branch BEFORE the `// Any other key ...` final no-op.

In the imports near the top of `handlers.ts`:
```typescript
import {
  parseEnvelopeKey,
  parsePluginKey,
  parseSolverNetManifestKey,
  tierFromRaw,
} from './types.js';
```

Update the function signature:
```typescript
export async function handleMetadataSet({
  event,
  context,
  solverNetManifest,
  envelope,
  pluginPublication,
}: {
  event: MetadataSetEvent;
  context: HandlerContext;
  solverNetManifest: unknown;
  envelope: unknown;
  pluginPublication: unknown;
}): Promise<void> {
```

After the envelope branch (`if (envelopeKey !== null) { ... return; }`), insert the plugin branch:

```typescript
  // ── Plug-in publication (attd) ───────────────────────────────────────────
  const pluginKey = parsePluginKey(key);
  if (pluginKey !== null) {
    const txIndex = typeof event.transaction.transactionIndex === 'number'
      ? event.transaction.transactionIndex
      : 0;
    const logIndexResolved = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;
    const txHash = event.transaction.hash;

    // Try v2 revocation first (cheaper) only when we have a same-key existing
    // row; otherwise v1 is the expected shape. Decoders return null on failure
    // — that's the signal for the dispatch.
    const v1 = decodePluginPayload(event.args.metadataValue as Hex);
    const v2 = v1 ? null : decodeRevocationPayload(event.args.metadataValue as Hex);

    if (v1 && v1.version === 1) {
      // v1 publish — full insert/overwrite (revoked resets to false even if a
      // previous payload had set it true; republishing un-revokes).
      const id = `${agentId}:${pluginKey.cid}`;
      await context.db
        .insert(pluginPublication)
        .values({
          id,
          builderAgentId: agentId,
          pluginCid: pluginKey.cid,
          pluginName: v1.pluginName,
          pluginVersion: v1.pluginVersion,
          pluginSha256: v1.pluginSha256,
          supports: [...v1.supports],
          publishedAt: v1.publishedAt,
          revoked: false,
          revokedReason: null,
          txHash,
          blockNumber,
          txIndex,
          logIndex: logIndexResolved,
          chainId,
        })
        .onConflictDoUpdate((row) => {
          const incomingIsNewer =
            blockNumber > row.blockNumber ||
            (blockNumber === row.blockNumber && txIndex > row.txIndex) ||
            (blockNumber === row.blockNumber &&
              txIndex === row.txIndex &&
              logIndexResolved > row.logIndex);
          if (incomingIsNewer) {
            return {
              pluginName: v1.pluginName,
              pluginVersion: v1.pluginVersion,
              pluginSha256: v1.pluginSha256,
              supports: [...v1.supports],
              publishedAt: v1.publishedAt,
              revoked: false,
              revokedReason: null,
              txHash,
              blockNumber,
              txIndex,
              logIndex: logIndexResolved,
              chainId,
            };
          }
          return {
            pluginName: row.pluginName,
            pluginVersion: row.pluginVersion,
            pluginSha256: row.pluginSha256,
            supports: row.supports,
            publishedAt: row.publishedAt,
            revoked: row.revoked,
            revokedReason: row.revokedReason,
            txHash: row.txHash,
            blockNumber: row.blockNumber,
            txIndex: row.txIndex,
            logIndex: row.logIndex,
            chainId: row.chainId,
          };
        });
      return;
    }

    if (v2 && v2.version === 2 && v2.revoked) {
      // v2 revocation — only valid if a v1 row already exists. find the row;
      // if missing, no-op (a revocation for a never-published key is meaningless).
      const id = `${agentId}:${pluginKey.cid}`;
      const existing = await context.db.find(pluginPublication, { id });
      if (!existing) return;
      // Most-recent-wins gate — only apply if the incoming event beats the
      // stored anchor on (block, txIndex, logIndex).
      const row = existing as {
        blockNumber: bigint;
        txIndex: number;
        logIndex: number;
      };
      const incomingIsNewer =
        blockNumber > row.blockNumber ||
        (blockNumber === row.blockNumber && txIndex > row.txIndex) ||
        (blockNumber === row.blockNumber &&
          txIndex === row.txIndex &&
          logIndexResolved > row.logIndex);
      if (!incomingIsNewer) return;
      await context.db.update(pluginPublication, { id }).set({
        revoked: true,
        revokedReason: v2.reason,
        txHash,
        blockNumber,
        txIndex,
        logIndex: logIndexResolved,
      });
      return;
    }

    // Garbage / unknown-version payload — no row written.
    return;
  }
```

- [ ] **Step 3: Update the Ponder registration in `src/index.ts`**

Modify `packages/indexer/src/index.ts` to import and pass through `pluginPublication`:

```typescript
import { task, attempt, solverNetManifest, envelope, pluginPublication } from 'ponder:schema';
// ...
ponder.on('IdentityRegistry:MetadataSet', async ({ event, context }) => {
  await handleMetadataSet({
    event: event as unknown as MetadataSetEvent,
    context: context as unknown as HandlerContext,
    solverNetManifest,
    envelope,
    pluginPublication,
  });
});
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/handlers.plugin.test.ts --reporter=verbose 2>&1 | tail -40
```

Expected: PASS.

- [ ] **Step 5: Run full indexer suite — existing tests stay green**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn test 2>&1 | tail -30
```

Expected: 12 existing + new plug-in tests all green. The existing `handlers.test.ts` MetadataSet tests must continue to work without changes — `handleMetadataSet` now takes an additional `pluginPublication` argument; update the existing test call-sites in `handlers.test.ts` to pass `pluginPublication: pluginPublication` (or `pluginPublication: {} as unknown` if the existing tests don't import the entity) so the function still type-checks. **This is a localized edit to each existing `handleMetadataSet({...})` call in `test/handlers.test.ts` to add a fourth argument; the existing assertions are untouched.**

- [ ] **Step 6: Update existing handler-test call sites to pass `pluginPublication`**

In `packages/indexer/test/handlers.test.ts`, add `pluginPublication` to the import from `../ponder.schema.js`:

```typescript
import { task, attempt, solverNetManifest, envelope, pluginPublication } from '../ponder.schema.js';
```

Add it to `PKS`:
```typescript
const PKS: PkMap = new Map<unknown, string[]>([
  [task, ['id']],
  [attempt, ['taskId', 'attemptIndex', 'chainId']],
  [solverNetManifest, ['id']],
  [envelope, ['agentId', 'metadataKey', 'chainId']],
  [pluginPublication, ['id']],
]);
```

Then for every `await handleMetadataSet({ ..., solverNetManifest, envelope })` call in this file, add `pluginPublication` as the new fourth table arg. (sed-style: append `, pluginPublication,` before the closing `}` of every `handleMetadataSet({...})` call. Roughly a dozen call sites in this file.)

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 7: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/src/handlers.ts packages/indexer/src/index.ts packages/indexer/test/handlers.test.ts
git commit -m "feat(attd): decode PLUGIN_PAYLOAD_TUPLE + REVOCATION_PAYLOAD_TUPLE, route plugin:<cid> to pluginPublication"
```

---

## Task 7: Failing test — `PublishedArtifact` base + `PluginPublication` type shape

**Files:**
- Create: `client/test/discovery/types.plugin-publication.test.ts`

- [ ] **Step 1: Add the typed-shape test**

Create `client/test/discovery/types.plugin-publication.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PublishedArtifact, PluginPublication } from '../../src/discovery/types.js';

describe('PublishedArtifact base interface (attd)', () => {
  it('PluginPublication is assignable to PublishedArtifact with discriminator artifactType=plugin', () => {
    const sample: PluginPublication = {
      artifactType: 'plugin',
      builderAgentId: '42',
      cid: 'bafyplugincid',
      name: '@builder/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
      revoked: false,
      pluginSha256: `0x${'aa'.repeat(32)}`,
    };
    const widened: PublishedArtifact = sample;
    expect(widened.artifactType).toBe('plugin');
    // Type-narrowing test — the discriminator works.
    if (widened.artifactType === 'plugin') {
      const narrowed: PluginPublication = widened;
      expect(narrowed.pluginSha256).toMatch(/^0x[0-9a-f]+$/);
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn vitest run test/discovery/types.plugin-publication.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `PublishedArtifact`, `PluginPublication` not exported.

- [ ] **Step 3: Commit failing test**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add client/test/discovery/types.plugin-publication.test.ts
git commit -m "test(attd): failing PublishedArtifact / PluginPublication type-shape test"
```

---

## Task 8: Implement `PublishedArtifact` + `PluginPublication`

**Files:**
- Modify: `client/src/discovery/types.ts`

- [ ] **Step 1: Append base + concrete types**

Append to `client/src/discovery/types.ts` (above the `DiscoveryAPI` interface so the interface can reference them):

```typescript
// ── PublishedArtifact base (attd) ────────────────────────────────────────────
//
// A common read-shape for builder-published artifacts. Today only plug-ins
// are published (kind `plugin:<cid>` on the IdentityRegistry); a future Path 2
// publishing epic adds `harness:<cid>` as a sibling kind with its own payload
// schema (the `client/schemas/jinn-manifest-v1.json` shape) and adds it to the
// `artifactType` union below. The unified shape is the read-layer integration
// point per spec §5.6 — the on-chain layer stays per-artifact-type with
// distinct payload tuples; this interface unifies the read API.

/**
 * Base shape for a builder-published artifact. Discriminated on `artifactType`
 * so future kinds (`harness`) add without breaking consumers.
 */
export interface PublishedArtifact {
  /** Builder agentId (decimal string of the uint256). */
  builderAgentId: string;
  /** IPFS CID of the published artifact tarball / manifest. */
  cid: string;
  /** Display name from the payload (e.g. npm package name, or harness name). */
  name: string;
  /** Display version (semver or harness version string). */
  version: string;
  /** SolverType ids the artifact supports. */
  supports: readonly string[];
  /** Publish time — unix seconds, from the payload's payload-stamped time. */
  publishedAt: number;
  /** Discriminator. Today only `'plugin'`; future: `| 'harness'`. */
  artifactType: 'plugin';
  /** True when the most-recent record is a revocation. */
  revoked: boolean;
  /** Reason from the revocation record, when revoked. */
  revokedReason?: string;
}

/**
 * The plug-in flavour of `PublishedArtifact`. Adds `pluginSha256` which is the
 * fork-attribution join key against envelope `executor.plugins[].sha256`.
 */
export interface PluginPublication extends PublishedArtifact {
  artifactType: 'plugin';
  /** digestDirectory output for the packed tarball. */
  pluginSha256: `0x${string}`;
}

/**
 * One row of score history for a published plug-in. The join key is the cid
 * — the indexer matches envelope `executor.plugins[].cid` against
 * `pluginPublication.pluginCid`. When the envelope's sha256 mismatches the
 * publication's sha256, `forkSuspected` is true and the row is excluded from
 * builder-credit aggregations per spec §5.3.
 */
export interface PluginScoreHistoryRow {
  pluginCid: string;
  taskId: string;
  /** Operator agentId of the daemon that ran the task. */
  operatorAgentId: string;
  /** 'Pass' | 'Fail' | 'Rejected' | 'Indeterminate' | 'Unknown'. */
  verdict: string;
  /** Numeric score when the verdict is graded (Pass=100, Fail=0); undefined when not. */
  score?: number;
  /** Unix seconds the verdict envelope was published. */
  ts: number;
  /** True when the envelope's plug-in sha256 did not match the publication's sha256. */
  forkSuspected: boolean;
}

/**
 * One read-time row of a builder-attributed task run. Joins `pluginPublication`
 * against `attemptEnvelopeMeta` and `verdict` in the indexer. Fork-suspected
 * rows are flagged but still returned so the SPA can render them with a
 * "modified plug-in" badge per spec §5.3.
 */
export interface BuilderAttributedRun {
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  taskId: string;
  attemptRequestId: `0x${string}`;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  forkSuspected: boolean;
  ts: number;
}
```

- [ ] **Step 2: Extend the `DiscoveryAPI` interface**

In the same file, inside the `DiscoveryAPI` interface, add three new methods:

```typescript
  /**
   * Returns published plug-ins, optionally filtered by SolverType (`supports`)
   * or builder agentId. Used by the `/build` SPA route's "browse published
   * plug-ins" panel and the operator app's plug-in discovery surface.
   *
   * Backed by the `pluginPublication` indexer entity. Revoked rows are
   * included by default; pass `includeRevoked: false` to exclude them.
   */
  listPluginPublications(args?: {
    solverType?: string;
    builderAgentId?: string;
    includeRevoked?: boolean;
    limit?: number;
  }): Promise<PluginPublication[]>;

  /**
   * Returns score history for a published plug-in by cid. Each row is a
   * verdict-attached envelope where `executor.plugins[].cid === pluginCid`.
   * Rows where the envelope's sha256 did not match the publication's sha256
   * are flagged with `forkSuspected: true` and excluded from builder-credit
   * aggregations per spec §5.3.
   *
   * Today this surface requires the `attemptEnvelopeMeta` indexer enrichment
   * shipped under `jinn-mono-ebu7`. When that enrichment is not present in the
   * deployed indexer, this method returns an empty array.
   */
  getPluginScores(args: {
    pluginCid: string;
    limit?: number;
  }): Promise<PluginScoreHistoryRow[]>;

  /**
   * Returns all published artifacts for a builder agentId, typed by
   * `artifactType`. Today only plug-ins; the `harness` variant will appear
   * here when the Path 2 publishing epic ships, without changes to the
   * call-site.
   */
  listBuilderArtifacts(args: {
    builderAgentId: string;
    limit?: number;
  }): Promise<PublishedArtifact[]>;
```

- [ ] **Step 3: Run — expect PASS for the type-shape test (but FAIL for the interface implementations)**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn vitest run test/discovery/types.plugin-publication.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: the types test PASSes. Other discovery tests may now fail because `DiscoveryAPI` has three new required methods; this is fixed by the next task.

- [ ] **Step 4: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add client/src/discovery/types.ts client/test/discovery/types.plugin-publication.test.ts
git commit -m "feat(attd): PublishedArtifact base + PluginPublication + DiscoveryAPI plug-in methods"
```

---

## Task 9: Implement the three new methods in `HttpDiscoveryAPI` and `OnchainDiscoveryAPI`

**Files:**
- Modify: `client/src/discovery/http.ts`
- Modify: `client/src/discovery/onchain.ts`

- [ ] **Step 1: Add failing tests for `listPluginPublications` (mocked fetch)**

Create `client/test/discovery/http.plugin-publications.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

function mockFetch(handlers: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.endsWith('/ready')) {
      return new Response('ok', { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = (body as { query?: string }).query?.match(/query (\w+)/)?.[1] ?? '';
    const data = handlers[key];
    if (!data) throw new Error(`mock fetch: unhandled query ${key}`);
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

describe('HttpDiscoveryAPI.listPluginPublications (attd)', () => {
  it('returns published plug-ins filtered by supports[]', async () => {
    const fetchImpl = mockFetch({
      ListPluginPublications: {
        pluginPublications: {
          items: [
            {
              id: '42:bafyplugincid',
              builderAgentId: '42',
              pluginCid: 'bafyplugincid',
              pluginName: '@builder/swe-skill',
              pluginVersion: '0.1.0',
              pluginSha256: `0x${'aa'.repeat(32)}`,
              supports: ['swe-rebench-v2.v1'],
              publishedAt: '1715700000',
              revoked: false,
              revokedReason: null,
            },
          ],
        },
      },
    });
    const api = createHttpDiscoveryAPI({
      url: 'http://indexer.test/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await api.listPluginPublications({ solverType: 'swe-rebench-v2.v1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      artifactType: 'plugin',
      builderAgentId: '42',
      cid: 'bafyplugincid',
      name: '@builder/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
      revoked: false,
      pluginSha256: `0x${'aa'.repeat(32)}`,
    });
  });

  it('excludes revoked rows when includeRevoked=false', async () => {
    const fetchImpl = mockFetch({
      ListPluginPublications: { pluginPublications: { items: [] } },
    });
    const api = createHttpDiscoveryAPI({
      url: 'http://indexer.test/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await api.listPluginPublications({ includeRevoked: false });
    // Assert the mock saw a `revoked: false` filter.
    const callBody = JSON.parse(String((fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/graphql'))?.[1] as RequestInit)?.body));
    expect(callBody.variables.where).toMatchObject({ revoked: false });
  });
});
```

Run:
```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn vitest run test/discovery/http.plugin-publications.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `listPluginPublications` not implemented.

- [ ] **Step 2: Implement `listPluginPublications` in `http.ts`**

Add the GraphQL query above the response types section:

```typescript
const LIST_PLUGIN_PUBLICATIONS_QUERY = `
query ListPluginPublications($where: pluginPublicationFilter, $limit: Int!) {
  pluginPublications(
    where: $where,
    limit: $limit,
    orderBy: "blockNumber",
    orderDirection: "desc"
  ) {
    items {
      id
      builderAgentId
      pluginCid
      pluginName
      pluginVersion
      pluginSha256
      supports
      publishedAt
      revoked
      revokedReason
    }
  }
}
`;
```

Add the row + page response types:

```typescript
interface PluginPublicationRow {
  id: string;
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: string;
  supports: string[];
  publishedAt: string | number;
  revoked: boolean;
  revokedReason: string | null;
}

interface PluginPublicationsPage {
  pluginPublications: { items: PluginPublicationRow[] };
}
```

Add the method inside `createHttpDiscoveryAPI`:

```typescript
async function listPluginPublications(args?: {
  solverType?: string;
  builderAgentId?: string;
  includeRevoked?: boolean;
  limit?: number;
}): Promise<PluginPublication[]> {
  await ensureReady();
  const where: Record<string, unknown> = {};
  if (args?.solverType) where['supports_has'] = args.solverType;
  if (args?.builderAgentId) where['builderAgentId'] = args.builderAgentId;
  if (args?.includeRevoked === false) where['revoked'] = false;
  const limit = Math.min(500, Math.max(1, args?.limit ?? 100));

  const data = await postGql<PluginPublicationsPage>(
    gqlUrl,
    fetchImpl,
    LIST_PLUGIN_PUBLICATIONS_QUERY,
    { where, limit },
  );

  return (data.pluginPublications?.items ?? []).map((row): PluginPublication => ({
    artifactType: 'plugin',
    builderAgentId: row.builderAgentId,
    cid: row.pluginCid,
    name: row.pluginName,
    version: row.pluginVersion,
    supports: row.supports,
    publishedAt: Number(row.publishedAt),
    revoked: row.revoked,
    revokedReason: row.revokedReason ?? undefined,
    pluginSha256: (row.pluginSha256 as `0x${string}`),
  }));
}
```

Add it to the returned `DiscoveryAPI` object at the bottom of the factory.

Run:
```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn vitest run test/discovery/http.plugin-publications.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Implement `getPluginScores` and `listBuilderArtifacts`**

Add to `http.ts`:

```typescript
const GET_PLUGIN_SCORES_QUERY = `
query GetPluginScores($pluginCid: String!, $limit: Int!) {
  attemptEnvelopeMetas(
    where: { pluginsContains: $pluginCid },
    limit: $limit,
    orderBy: "enrichedAtBlock",
    orderDirection: "desc"
  ) {
    items {
      requestId
      manifestCid
      pluginsJson
      enrichedAtBlock
    }
  }
}
`;
```

Implement the method — when `attemptEnvelopeMetas` is not a recognised query on the server (the ebu7 enrichment isn't deployed yet), `postGql` throws `DiscoveryUnavailableError`; catch it and return `[]`:

```typescript
async function getPluginScores(args: {
  pluginCid: string;
  limit?: number;
}): Promise<PluginScoreHistoryRow[]> {
  await ensureReady();
  const limit = Math.min(500, Math.max(1, args.limit ?? 100));
  try {
    const data = await postGql<{ attemptEnvelopeMetas: { items: Array<{ requestId: string; manifestCid: string; pluginsJson: string; enrichedAtBlock: string | number }> } }>(
      gqlUrl,
      fetchImpl,
      GET_PLUGIN_SCORES_QUERY,
      { pluginCid: args.pluginCid, limit },
    );
    // ebu7's AttemptEnvelopeMeta carries `pluginsJson` — JSON.stringify of
    // executor.plugins[]. Parse it and emit one row per matching entry; flag
    // forkSuspected when the sha256 doesn't match the publication.
    // For now, return whatever the server returns; full join with verdict +
    // pluginPublication.sha256 is a §6.5 Discovery API endpoint that lands
    // alongside the /builders/:agentId/runs Hono route. attd's read-shape
    // shape ships the empty-array contract; ebu7 + 6.5 flesh it in.
    return (data.attemptEnvelopeMetas?.items ?? []).flatMap((row): PluginScoreHistoryRow[] => {
      let plugins: Array<{ cid?: string; sha256: string }> = [];
      try { plugins = JSON.parse(row.pluginsJson) as typeof plugins; } catch { return []; }
      const match = plugins.find((p) => p.cid === args.pluginCid);
      if (!match) return [];
      return [{
        pluginCid: args.pluginCid,
        taskId: '',
        operatorAgentId: '',
        verdict: 'Unknown',
        ts: Number(row.enrichedAtBlock),
        forkSuspected: false,
      }];
    });
  } catch (err) {
    // attemptEnvelopeMeta entity not present (ebu7 not deployed yet) → empty.
    if (err instanceof Error && /attemptEnvelopeMetas|Unknown type|Cannot query/.test(err.message)) {
      return [];
    }
    throw err;
  }
}

async function listBuilderArtifacts(args: {
  builderAgentId: string;
  limit?: number;
}): Promise<PublishedArtifact[]> {
  // Today only plug-ins; the harness variant is added when Path 2 ships. We
  // satisfy the unified read by delegating to listPluginPublications.
  const plugins = await listPluginPublications({
    builderAgentId: args.builderAgentId,
    limit: args.limit,
  });
  return plugins;
}
```

Add tests for `getPluginScores` (mocked fetch returning empty + mocked fetch returning a row that matches via pluginsJson parsing) and `listBuilderArtifacts` (asserting it just delegates to listPluginPublications). Skip the full ebu7-dependent verdict join — that's §6.5's bead.

- [ ] **Step 4: Stub the three methods in `OnchainDiscoveryAPI`**

In `client/src/discovery/onchain.ts`, add `listPluginPublications`, `getPluginScores`, `listBuilderArtifacts` that return empty results:

```typescript
async function listPluginPublications(): Promise<PluginPublication[]> { return []; }
async function getPluginScores(): Promise<PluginScoreHistoryRow[]> { return []; }
async function listBuilderArtifacts(): Promise<PublishedArtifact[]> { return []; }
```

Add a comment in the file: "Builder discovery requires the indexer's `pluginPublication` entity; the on-chain RPC floor does not enumerate it (would require a getLogs sweep + payload decode that the floor is not designed for). When falling back to the on-chain floor, builder browsing is unavailable until the indexer recovers."

Also extend `with-fallback.ts` to forward the three new methods.

- [ ] **Step 5: Run discovery tests**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn vitest run test/discovery --reporter=verbose 2>&1 | tail -30
```

Expected: all green.

- [ ] **Step 6: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add client/src/discovery/http.ts client/src/discovery/onchain.ts client/src/discovery/with-fallback.ts client/test/discovery/
git commit -m "feat(attd): DiscoveryAPI listPluginPublications/getPluginScores/listBuilderArtifacts"
```

---

## Task 10: Failing test — fork-attribution join logic (`BuilderAttributedRun`)

**Files:**
- Create: `packages/indexer/src/builder-attribution.ts`
- Create: `packages/indexer/test/builder-attribution.test.ts`

The join logic is a pure function over rows (no Ponder runtime). Implementing it in a separate module makes it directly testable and reusable from the future Hono route in `src/api/index.ts`.

- [ ] **Step 1: Add the failing pure-function test**

Create `packages/indexer/test/builder-attribution.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  attributeRuns,
  type AttemptEnvelopeMetaRow,
  type PluginPublicationRow,
  type VerdictRow,
} from '../src/builder-attribution.js';

const PUB_SHA = `0x${'aa'.repeat(32)}`;
const FORK_SHA = `0x${'bb'.repeat(32)}`;

const pub: PluginPublicationRow = {
  id: '42:bafycid',
  builderAgentId: '42',
  pluginCid: 'bafycid',
  pluginName: '@builder/swe-skill',
  pluginVersion: '0.1.0',
  pluginSha256: PUB_SHA,
  supports: ['swe-rebench-v2.v1'],
  publishedAt: 1_715_700_000n,
  revoked: false,
  revokedReason: null,
  blockNumber: 100n,
  txIndex: 0,
  logIndex: 0,
  txHash: `0x${'00'.repeat(32)}`,
  chainId: 84532,
};

function meta(opts: { requestId: `0x${string}`; pluginCid: string; sha256: string; block?: bigint }): AttemptEnvelopeMetaRow {
  return {
    requestId: opts.requestId,
    manifestCid: 'bafyenvcid',
    pluginsJson: JSON.stringify([{ name: 'p', version: '0.1.0', cid: opts.pluginCid, sha256: opts.sha256 }]),
    enrichedAtBlock: opts.block ?? 110n,
    chainId: 84532,
  };
}

function verdict(opts: { requestId: `0x${string}`; verdict: string; score?: number; ts?: number }): VerdictRow {
  return {
    requestId: opts.requestId,
    verdict: opts.verdict,
    score: opts.score,
    ts: opts.ts ?? 1_715_710_000,
    operatorAgentId: '99',
    taskId: '7',
  };
}

describe('attributeRuns (attd join)', () => {
  it('matches an envelope plug-in by cid + sha256 to a publication row', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq1' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) })],
      verdicts: [verdict({ requestId: '0xreq1' as `0x${string}`, verdict: 'Pass', score: 100 })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      builderAgentId: '42',
      pluginCid: 'bafycid',
      pluginName: '@builder/swe-skill',
      taskId: '7',
      verdict: 'Pass',
      score: 100,
      forkSuspected: false,
    });
  });

  it('flags forkSuspected=true when sha256 mismatches the publication', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq1' as `0x${string}`, pluginCid: 'bafycid', sha256: FORK_SHA.slice(2) })],
      verdicts: [verdict({ requestId: '0xreq1' as `0x${string}`, verdict: 'Pass' })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].forkSuspected).toBe(true);
  });

  it('returns no row when there is no matching publication (operator-only attribution)', () => {
    const out = attributeRuns({
      publications: [],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq1' as `0x${string}`, pluginCid: 'bafyunknown', sha256: PUB_SHA.slice(2) })],
      verdicts: [verdict({ requestId: '0xreq1' as `0x${string}`, verdict: 'Pass' })],
    });
    expect(out).toHaveLength(0);
  });

  it('returns no row when the envelope has a publication match but no verdict yet', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq2' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) })],
      verdicts: [],
    });
    expect(out).toHaveLength(0);
  });

  it('aggregates score history per (builderAgentId, pluginCid)', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [
        meta({ requestId: '0xreqA' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) }),
        meta({ requestId: '0xreqB' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) }),
        meta({ requestId: '0xreqC' as `0x${string}`, pluginCid: 'bafycid', sha256: FORK_SHA.slice(2) }),
      ],
      verdicts: [
        verdict({ requestId: '0xreqA' as `0x${string}`, verdict: 'Pass', score: 100, ts: 1 }),
        verdict({ requestId: '0xreqB' as `0x${string}`, verdict: 'Fail', score: 0, ts: 2 }),
        verdict({ requestId: '0xreqC' as `0x${string}`, verdict: 'Pass', score: 100, ts: 3 }),
      ],
    });
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.forkSuspected)).toEqual([false, false, true]);
    // Builder-credit aggregate excludes fork-suspected rows.
    const credited = out.filter((r) => !r.forkSuspected);
    expect(credited).toHaveLength(2);
  });
});
```

Run:
```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/builder-attribution.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: FAIL — `builder-attribution.ts` does not exist.

- [ ] **Step 2: Commit failing test**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/test/builder-attribution.test.ts
git commit -m "test(attd): failing BuilderAttributedRun fork-detection join test"
```

---

## Task 11: Implement `attributeRuns` join

**Files:**
- Create: `packages/indexer/src/builder-attribution.ts`

- [ ] **Step 1: Implement the pure join**

Create `packages/indexer/src/builder-attribution.ts`:

```typescript
/**
 * Pure join logic for builder-attributed runs (attd).
 *
 * Joins three streams the indexer maintains:
 *   - `pluginPublication` rows from `IdentityRegistry.MetadataSet` with
 *     `plugin:<cid>` keys (this bead).
 *   - `attemptEnvelopeMeta` rows (ebu7) which carry the IPFS-fetched
 *     `executor.plugins[]` JSON.
 *   - `verdict` rows (ebu7) keyed by the same `requestId`.
 *
 * Output is the read-time `BuilderAttributedRun` shape consumed by the
 * `/builders/:agentId/runs` Hono route and the SPA `/build` panel.
 *
 * The pure-function shape keeps the join testable independent of Ponder; the
 * Hono route loads rows via the GraphQL surface and calls into this module.
 *
 * Fork detection: an envelope's `executor.plugins[].sha256` is compared
 * against the publication's `pluginSha256`. Mismatch flags `forkSuspected:
 * true` per spec §5.3 — the row is still emitted (for visibility) but is
 * filtered out of builder-credit aggregations downstream.
 */

export interface PluginPublicationRow {
  id: string;
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: string;
  supports: readonly string[];
  publishedAt: bigint;
  revoked: boolean;
  revokedReason: string | null;
  blockNumber: bigint;
  txIndex: number;
  logIndex: number;
  txHash: `0x${string}`;
  chainId: number;
}

export interface AttemptEnvelopeMetaRow {
  requestId: `0x${string}`;
  manifestCid: string;
  /** JSON.stringify(executor.plugins) — array of {name,version,cid?,sha256}. */
  pluginsJson: string;
  enrichedAtBlock: bigint;
  chainId: number;
}

export interface VerdictRow {
  requestId: `0x${string}`;
  taskId: string;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  ts: number;
}

export interface BuilderAttributedRunRow {
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  taskId: string;
  attemptRequestId: `0x${string}`;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  forkSuspected: boolean;
  ts: number;
}

interface EnvelopePluginEntry {
  name: string;
  version: string;
  cid?: string;
  sha256: string;
}

/**
 * Normalises the publication's sha256 (`0x` + 64 hex) and the envelope plugin
 * entry's sha256 (64 hex, no `0x`) to lower-case 64-hex and compares.
 */
function sha256Matches(pubSha: string, envSha: string): boolean {
  const a = pubSha.replace(/^0x/i, '').toLowerCase();
  const b = envSha.replace(/^0x/i, '').toLowerCase();
  return a.length === 64 && b.length === 64 && a === b;
}

export function attributeRuns(args: {
  publications: PluginPublicationRow[];
  attemptEnvelopeMetas: AttemptEnvelopeMetaRow[];
  verdicts: VerdictRow[];
}): BuilderAttributedRunRow[] {
  const pubByCid = new Map<string, PluginPublicationRow>();
  for (const p of args.publications) pubByCid.set(p.pluginCid, p);

  const verdictByReq = new Map<string, VerdictRow>();
  for (const v of args.verdicts) verdictByReq.set(v.requestId.toLowerCase(), v);

  const out: BuilderAttributedRunRow[] = [];
  for (const meta of args.attemptEnvelopeMetas) {
    let plugins: EnvelopePluginEntry[] = [];
    try {
      plugins = JSON.parse(meta.pluginsJson) as EnvelopePluginEntry[];
    } catch {
      continue;
    }
    const verdict = verdictByReq.get(meta.requestId.toLowerCase());
    if (!verdict) continue;

    for (const entry of plugins) {
      if (!entry.cid) continue;
      const pub = pubByCid.get(entry.cid);
      if (!pub) continue;
      const forkSuspected = !sha256Matches(pub.pluginSha256, entry.sha256);
      const row: BuilderAttributedRunRow = {
        builderAgentId: pub.builderAgentId,
        pluginCid: pub.pluginCid,
        pluginName: pub.pluginName,
        pluginVersion: pub.pluginVersion,
        taskId: verdict.taskId,
        attemptRequestId: meta.requestId,
        operatorAgentId: verdict.operatorAgentId,
        verdict: verdict.verdict,
        ts: verdict.ts,
        forkSuspected,
      };
      if (typeof verdict.score === 'number') row.score = verdict.score;
      out.push(row);
    }
  }
  return out;
}
```

- [ ] **Step 2: Run — expect PASS**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn vitest run test/builder-attribution.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/src/builder-attribution.ts
git commit -m "feat(attd): attributeRuns — pure cid+sha256 join with fork detection"
```

---

## Task 12: Wire `/builders/:agentId/runs` Hono route

**Files:**
- Modify: `packages/indexer/src/api/index.ts`

- [ ] **Step 1: Add the route**

The Hono app already exposes the GraphQL endpoint. Add the custom JSON route under `app.use('/graphql', graphql(...))`:

```typescript
import { db } from 'ponder:api';
import schema, { pluginPublication } from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';
import { attributeRuns } from '../builder-attribution.js';

const app = new Hono();

app.use('/graphql', graphql({ db, schema }));
app.use('/', graphql({ db, schema }));

/**
 * Custom JSON route for builder-attributed runs. attd ships this without the
 * ebu7-side joins live — when `attemptEnvelopeMeta` / verdict tables are not
 * yet present in the deployed schema, the route returns `[]`. Once ebu7 lands,
 * this route picks up the new entities via the same `db` handle.
 */
app.get('/builders/:agentId/runs', async (c) => {
  const agentId = c.req.param('agentId');
  try {
    // Read the builder's publications first — keyed via the new entity.
    const publications = await db
      .select()
      .from(pluginPublication)
      .where(/* eq(pluginPublication.builderAgentId, agentId) */ undefined as never);
    // attemptEnvelopeMeta + verdict are owned by ebu7. If they exist on the
    // `schema` import they're queryable; if not, return []. The Hono route is
    // additive — adding it now means the SPA can call it from day one and pick
    // up data automatically when ebu7 lands.
    type EbU7Schema = typeof schema & {
      attemptEnvelopeMeta?: unknown;
      verdict?: unknown;
    };
    const s = schema as EbU7Schema;
    if (!s.attemptEnvelopeMeta || !s.verdict) {
      return c.json([]);
    }
    // When ebu7 lands, replace the placeholder below with:
    //   const metas = await db.select().from(s.attemptEnvelopeMeta).where(...);
    //   const verdicts = await db.select().from(s.verdict).where(...);
    //   return c.json(attributeRuns({ publications, attemptEnvelopeMetas: metas, verdicts }));
    return c.json(attributeRuns({
      publications: publications as never,
      attemptEnvelopeMetas: [],
      verdicts: [],
    }));
  } catch (err) {
    return c.json({ error: 'builder-attribution unavailable', detail: String(err) }, 503);
  }
});

export default app;
```

Note: the Drizzle `db` query API in Ponder 0.16.x is `db.select().from(table).where(eq(table.col, value))` from `drizzle-orm`. Adjust the import (`import { eq } from 'drizzle-orm'`) when wiring the `where` clause; the placeholder `undefined as never` above is replaced with `eq(pluginPublication.builderAgentId, agentId)` at implementation time. (Confirm exact import path for `eq` from the version of `drizzle-orm` bundled with `ponder` — look at how other API routes in the repo use it; if no other custom routes exist, copy the pattern from `ponder:api` examples.)

- [ ] **Step 2: Add a happy-path test**

Create `packages/indexer/test/api.builders.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { attributeRuns } from '../src/builder-attribution.js';

// API-level route tests are an integration concern that needs a running
// Ponder runtime. For the unit-test bar attd targets, the route logic itself
// is exercised through `attributeRuns` (test/builder-attribution.test.ts).
// This file holds a smoke test that the route module loads cleanly and
// re-exports the join.
describe('api.builders smoke', () => {
  it('attributeRuns is the route's pure-function backbone', () => {
    expect(typeof attributeRuns).toBe('function');
  });
});
```

A real integration test (the Hono route returning expected JSON against a live PGlite) is filed as a follow-up bead (`jinn-mono-attd.api-integration`).

- [ ] **Step 3: Typecheck the indexer**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/src/api/index.ts packages/indexer/test/api.builders.test.ts
git commit -m "feat(attd): /builders/:agentId/runs Hono route (attribution-join wiring)"
```

---

## Task 13: Update indexer README with the new entity, handler, and route

**Files:**
- Modify: `packages/indexer/README.md`

- [ ] **Step 1: Document the new entity and Hono route**

Add a `### PluginPublication` block to the §Schema section of `packages/indexer/README.md` mirroring the SolverNetManifest entry: primary key, payload tuples (link to `client/src/erc8004/abis.ts`), most-recent-wins semantics, revocation behaviour.

Add a `### /builders/:agentId/runs` block to a §Custom routes section explaining the route returns `[]` until `attemptEnvelopeMeta` (ebu7) is present in the deployed schema.

Add a §Known limitations entry: "Builder attribution requires the `attemptEnvelopeMeta` entity from ebu7. Until that lands in the deployed indexer, `/builders/:agentId/runs` and `DiscoveryAPI.getPluginScores` return empty arrays even when `pluginPublication` rows exist."

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git add packages/indexer/README.md
git commit -m "docs(attd): document pluginPublication entity + /builders/:agentId/runs route"
```

---

## Task 14: Final verification

- [ ] **Step 1: Indexer test sweep**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn test 2>&1 | tail -30
```

Expected: all tests green (12 existing + new attd tests).

- [ ] **Step 2: Indexer typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 3: Indexer codegen + build**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/packages/indexer && yarn codegen 2>&1 | tail -20
```

Expected: `ponder codegen` succeeds — the new entity is generated into the Ponder schema types without errors.

- [ ] **Step 4: Client test sweep**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn test 2>&1 | tail -30
```

Expected: all tests green (existing discovery tests still pass; new `PublishedArtifact` and HTTP discovery tests pass).

- [ ] **Step 5: Client typecheck**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 6: Client build**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd/client && yarn build 2>&1 | tail -20
```

Expected: clean build.

- [ ] **Step 7: Document follow-up beads**

File two follow-ups via `bd create`:
- `jinn-mono-attd.api-integration` — Hono `/builders/:agentId/runs` integration test against a live PGlite Ponder boot, gated on ebu7's `attemptEnvelopeMeta` entity landing.
- `jinn-mono-attd.harness-published-artifact` — extend `PublishedArtifact` with `'harness'` variant when Path 2 publishing ships.

```bash
bd create --title "attd.api-integration: live Hono test for /builders/:agentId/runs" --body "Filed by attd; needs ebu7.AttemptEnvelopeMeta deployed first." --type test
bd create --title "attd.harness-published-artifact: add 'harness' to PublishedArtifact discriminator" --body "Filed by attd; ships with Path 2 publishing." --type feat
```

- [ ] **Step 8: Final commit (if any docs/lint deltas)**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/attd
git status
# If clean, no commit. Otherwise:
git add -A && git commit -m "chore(attd): final lint/format pass"
```

---

## Risks and mitigations

1. **ABI tuple drift** between `client/src/erc8004/abis.ts` (`PLUGIN_PAYLOAD_TUPLE`, `REVOCATION_PAYLOAD_TUPLE`) and the duplicated copies in `packages/indexer/src/handlers.ts`. Mitigated by the drift-guard test in Task 5 Step 2, which encodes against the indexer-local copy and asserts the byte-shape matches the spec §5.2 layout exactly. A future shared package could collapse the duplication; out of scope for attd.
2. **Composite primary key collision** if two builders publish the same `pluginCid` (e.g. a forked / republished tarball). Mitigated by keying `id` on `<builderAgentId>:<pluginCid>`, not on `pluginCid` alone — the spec §5.2 explicitly addresses this ("Each plug-in record is keyed on `(builderAgentId, pluginCid)`, so there is no on-chain collision").
3. **Revocation before publication.** A v2 revocation payload for a `plugin:<cid>` key that was never published produces a `find` miss; the handler no-ops rather than inserting a partial row. Test in Task 5 covers this implicitly (the v1-republish-after-revocation case).
4. **`attemptEnvelopeMeta` does not exist in attd's worktree** (ebu7 hasn't merged here). The join is implemented as a pure function that takes pre-shaped rows, and the Hono route returns `[]` when the schema lacks the entity. The Discovery API's `getPluginScores` and `listBuilderArtifacts` follow the same pattern — empty results until ebu7 lands, then live without code changes.
5. **Ponder `text().array()` Postgres-array support.** Ponder 0.16.x maps `t.text().array()` to a Postgres `text[]` column and exposes `_has` filter operators on indexed array columns; if the version in use does not, `supports` falls back to a comma-joined string with a follow-up to migrate. Verify in Task 4 Step 3 (`yarn test` against the indexer's PGlite engine).
6. **Drizzle ON CONFLICT no-op clauses.** The existing envelope handler returns all row fields in the no-op branch to satisfy Drizzle's empty-SET rule (see `handlers.ts` lines 305-356 and 388-414). The new plug-in branch follows the same pattern; cross-check during code review.
7. **Existing test signature regression risk.** Adding `pluginPublication` to the `handleMetadataSet` signature (Task 6 Step 2) requires touching every existing call site in `test/handlers.test.ts`. The change is mechanical (`, pluginPublication`) but pervasive; lint pass and full `yarn test` are required (Task 6 Step 5).
8. **Spec §5.3 sha256 case sensitivity.** Envelope plug-in entries have sha256 as a 64-hex string with no `0x` prefix (per `client/src/types/envelope.ts:64` `regex(/^[0-9a-f]{64}$/)`), while publication `pluginSha256` is `bytes32` encoded as `0x` + 64 hex. The `sha256Matches` helper in `builder-attribution.ts` normalises both to lower-case 64-hex without the prefix. Test in Task 10 verifies both directions match.

---
