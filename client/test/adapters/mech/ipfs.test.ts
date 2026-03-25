import { describe, it, expect } from 'vitest';
import { buildDesiredStatePayload, parseDesiredStateFromPayload, cidToDigestHex, digestHexToGatewayUrl } from '../../../src/adapters/mech/ipfs.js';

describe('IPFS utilities', () => {
  it('serializes a desired state to IPFS payload', () => {
    const payload = buildDesiredStatePayload({
      id: 'ds-1',
      description: 'Test state',
      context: { key: 'value' },
    });
    expect(payload.description).toBe('Test state');
    expect(payload.desiredStateId).toBe('ds-1');
    expect(payload.context).toEqual({ key: 'value' });
  });

  it('deserializes an IPFS payload back to a desired state', () => {
    const payload = { desiredStateId: 'ds-1', description: 'Test', context: { key: 'value' } };
    const state = parseDesiredStateFromPayload(payload);
    expect(state.id).toBe('ds-1');
    expect(state.description).toBe('Test');
  });

  it('extracts a 32-byte SHA256 digest from a CIDv0', () => {
    // CIDv0: QmYwAPJzv5CZsnN625s3Xf2nemtYgPpHdWEz79ojWnPbdG
    // This is a well-known IPFS CID (empty directory)
    const cid = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
    const digest = cidToDigestHex(cid);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest.length).toBe(66); // 0x + 64 hex chars = 32 bytes
  });

  it('constructs a gateway URL from a digest hex', () => {
    const digest = '0x' + 'ab'.repeat(32);
    const url = digestHexToGatewayUrl(digest);
    expect(url).toBe('https://gateway.autonolas.tech/ipfs/f01551220' + 'ab'.repeat(32));
  });

  it('constructs a gateway URL without 0x prefix', () => {
    const digest = 'cd'.repeat(32);
    const url = digestHexToGatewayUrl(digest);
    expect(url).toBe('https://gateway.autonolas.tech/ipfs/f01551220' + 'cd'.repeat(32));
  });
});
