import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  });

  it('returns an empty array when there is no anchor', () => {
    expect(store.listErc8004AnchorsByEnvelopeCids(['nonexistent'])).toEqual([]);
    expect(store.listErc8004AnchorsByEnvelopeCids([])).toEqual([]);
  });
});
