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
  it('decodes a payload that was encoded against the canonical operator/erc8004 tuple shape', () => {
    // Encode with the test-local copy of the tuple (sourced from
    // operator/src/erc8004/abis.ts PLUGIN_PAYLOAD_TUPLE) and decode with the
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
