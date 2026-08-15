import { describe, it, expect } from 'vitest';
import { createFakeIPFS } from '@test/ipfs.js';

describe('FakeIPFS', () => {
  it('round-trips content via put/get', async () => {
    const ipfs = createFakeIPFS();
    const payload = new TextEncoder().encode('hello');
    const { cid } = await ipfs.put(payload);
    expect(cid).toMatch(/^bafy/);
    const got = ipfs.get(cid);
    expect(got && new TextDecoder().decode(got)).toBe('hello');
  });

  it('returns undefined for unknown CIDs', () => {
    const ipfs = createFakeIPFS();
    expect(ipfs.get('bafy-nope')).toBeUndefined();
  });

  it('is deterministic: same payload → same CID', async () => {
    const ipfs = createFakeIPFS();
    const a = await ipfs.put(new TextEncoder().encode('x'));
    const b = await ipfs.put(new TextEncoder().encode('x'));
    expect(a.cid).toBe(b.cid);
  });
});
