import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';

describe('Store.erc8004_anchors', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('persists an anchor and lists it by envelope CID', () => {
    store.saveErc8004Anchor({
      envelopeId: 'env-1',
      envelopeCid: 'bafy-env',
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-env',
      agentId: '42',
      chainId: 8453,
      identityRegistryAddress: '0xreg',
      txHash: '0xtx',
      blockNumber: 100,
      payloadHex: '0xdead',
      anchoredAt: 1000,
      gasUsed: '73124',
      feeWei: '1828100000000',
    });
    const anchors = store.listErc8004AnchorsByEnvelopeCids(['bafy-env']);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      envelopeCid: 'bafy-env',
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-env',
      agentId: '42',
      chainId: 8453,
      identityRegistryAddress: '0xreg',
      txHash: '0xtx',
      blockNumber: 100,
      payloadHex: '0xdead',
      anchoredAt: 1000,
      gasUsed: '73124',
      feeWei: '1828100000000',
    });
  });

  it('returns multiple anchors for the same envelope_cid', () => {
    const base = {
      envelopeId: 'env-2',
      envelopeCid: 'bafy-multi',
      agentId: '42',
      chainId: 84532,
      identityRegistryAddress: '0xreg',
      payloadHex: '0xab',
      anchoredAt: 2000,
    };
    store.saveErc8004Anchor({
      ...base,
      contentKind: 'capture',
      metadataKey: 'capture:bafy-multi',
      txHash: '0xtx1',
      blockNumber: 201,
    });
    store.saveErc8004Anchor({
      ...base,
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-multi',
      txHash: '0xtx2',
      blockNumber: 202,
    });
    const anchors = store.listErc8004AnchorsByEnvelopeCids(['bafy-multi']);
    expect(anchors).toHaveLength(2);
    expect(anchors.map((a) => a.contentKind).sort()).toEqual(['capture', 'envelope']);
  });

  it('accepts a null block number (pending receipt)', () => {
    store.saveErc8004Anchor({
      envelopeId: 'env-3',
      envelopeCid: 'bafy-pending',
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-pending',
      agentId: '42',
      chainId: 11155111,
      identityRegistryAddress: '0xreg',
      txHash: '0xtx',
      blockNumber: null,
      payloadHex: '0x',
      anchoredAt: 3000,
    });
    const [anchor] = store.listErc8004AnchorsByEnvelopeCids(['bafy-pending']);
    expect(anchor.blockNumber).toBeNull();
    expect(anchor.gasUsed).toBeNull();
    expect(anchor.feeWei).toBeNull();
  });

  it('returns an empty array when there is no anchor', () => {
    expect(store.listErc8004AnchorsByEnvelopeCids(['nonexistent'])).toEqual([]);
    expect(store.listErc8004AnchorsByEnvelopeCids([])).toEqual([]);
  });

  it('suppresses an exact duplicate anchor finalization', () => {
    const anchor = {
      envelopeId: 'manifest-1',
      envelopeCid: 'bafy-manifest',
      contentKind: 'manifest',
      metadataKey: 'manifest:bafy-manifest',
      agentId: '42',
      chainId: 84532,
      identityRegistryAddress: '0xreg',
      txHash: '0xtx-manifest',
      blockNumber: 300,
      payloadHex: '0xbeef',
      anchoredAt: 4000,
      gasUsed: '70000',
      feeWei: '140000',
    };

    store.saveErc8004Anchor(anchor);
    store.saveErc8004Anchor(anchor);

    expect(store.listErc8004AnchorsByEnvelopeCids(['bafy-manifest'])).toHaveLength(1);
  });
});

describe('Store.manifest_batch_journal', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('round-trips and atomically replaces one batch state', () => {
    expect(store.loadManifestBatchJournal('batch-1')).toBeNull();

    store.saveManifestBatchJournal('batch-1', '{"stage":"members"}');
    expect(store.loadManifestBatchJournal('batch-1')).toBe('{"stage":"members"}');

    store.saveManifestBatchJournal('batch-1', '{"stage":"partitions"}');
    expect(store.loadManifestBatchJournal('batch-1')).toBe('{"stage":"partitions"}');
  });

  it('compare-and-swaps one batch without overwriting a concurrent winner', () => {
    const members = '{"stage":"members"}';
    const partitions = '{"stage":"partitions"}';
    const staleWriter = '{"stage":"stale-writer"}';

    expect(
      store.compareAndSwapManifestBatchJournal('batch-1', null, members),
    ).toBe(true);
    expect(
      store.compareAndSwapManifestBatchJournal('batch-1', null, staleWriter),
    ).toBe(false);
    expect(
      store.compareAndSwapManifestBatchJournal('batch-1', members, partitions),
    ).toBe(true);
    expect(
      store.compareAndSwapManifestBatchJournal('batch-1', members, staleWriter),
    ).toBe(false);
    expect(store.loadManifestBatchJournal('batch-1')).toBe(partitions);
  });

  it('rejects a stale compare-and-swap from another database connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-manifest-journal-cas-'));
    const dbPath = join(dir, 'jinn.db');
    const first = new Store(dbPath);
    const second = new Store(dbPath);
    try {
      const initial = '{"stage":"members"}';
      expect(
        first.compareAndSwapManifestBatchJournal('batch-1', null, initial),
      ).toBe(true);
      expect(first.loadManifestBatchJournal('batch-1')).toBe(initial);
      expect(second.loadManifestBatchJournal('batch-1')).toBe(initial);

      expect(
        first.compareAndSwapManifestBatchJournal(
          'batch-1',
          initial,
          '{"stage":"first"}',
        ),
      ).toBe(true);
      expect(
        second.compareAndSwapManifestBatchJournal(
          'batch-1',
          initial,
          '{"stage":"second"}',
        ),
      ).toBe(false);
      expect(second.loadManifestBatchJournal('batch-1')).toBe('{"stage":"first"}');
    } finally {
      second.close();
      first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Store.erc8004_anchors migration', () => {
  it('adds nullable gas columns to databases created by the prior schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-erc8004-anchor-migration-'));
    const dbPath = join(dir, 'jinn.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE erc8004_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope_id TEXT NOT NULL,
        envelope_cid TEXT NOT NULL,
        content_kind TEXT NOT NULL,
        metadata_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        identity_registry_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block_number INTEGER,
        payload_hex TEXT NOT NULL,
        anchored_at INTEGER NOT NULL
      );
      INSERT INTO erc8004_anchors (
        envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
        chain_id, identity_registry_address, tx_hash, block_number,
        payload_hex, anchored_at
      ) VALUES (
        'env-legacy', 'bafy-legacy', 'manifest', 'manifest:bafy-legacy', '42',
        84532, '0xreg', '0xtx', 99, '0xdead', 1000
      );
    `);
    legacyDb.close();

    const migratedStore = new Store(dbPath);
    try {
      const [anchor] = migratedStore.listErc8004AnchorsByEnvelopeCids(['bafy-legacy']);
      expect(anchor).toMatchObject({
        contentKind: 'manifest',
        gasUsed: null,
        feeWei: null,
      });
    } finally {
      migratedStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates legacy anchor finalizations before adding the unique key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-erc8004-anchor-dedup-migration-'));
    const dbPath = join(dir, 'jinn.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE erc8004_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope_id TEXT NOT NULL,
        envelope_cid TEXT NOT NULL,
        content_kind TEXT NOT NULL,
        metadata_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        identity_registry_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block_number INTEGER,
        payload_hex TEXT NOT NULL,
        anchored_at INTEGER NOT NULL
      );
      INSERT INTO erc8004_anchors (
        envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
        chain_id, identity_registry_address, tx_hash, block_number,
        payload_hex, anchored_at
      ) VALUES
        ('env-1', 'bafy-dup', 'manifest', 'manifest:bafy-dup', '42',
         84532, '0xreg', '0xtx', 99, '0xdead', 1000),
        ('env-1', 'bafy-dup', 'manifest', 'manifest:bafy-dup', '42',
         84532, '0xreg', '0xtx', 99, '0xdead', 1000);
    `);
    legacyDb.close();

    const migratedStore = new Store(dbPath);
    try {
      expect(migratedStore.listErc8004AnchorsByEnvelopeCids(['bafy-dup'])).toHaveLength(1);
      expect(migratedStore.loadManifestBatchJournal('missing')).toBeNull();
    } finally {
      migratedStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
