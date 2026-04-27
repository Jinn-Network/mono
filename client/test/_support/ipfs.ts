import { createHash } from 'node:crypto';

export interface FakeIPFS {
  gatewayUrl: string;
  put(payload: Uint8Array): Promise<{ cid: string }>;
  get(cid: string): Uint8Array | undefined;
}

/**
 * In-memory IPFS substitute for integration tests. CIDs are deterministic
 * (SHA-256 of payload, prefixed with `bafy`) so tests that re-put the same
 * bytes get the same CID. `gatewayUrl` is a marker string, not a real URL.
 */
export function createFakeIPFS(): FakeIPFS {
  const store = new Map<string, Uint8Array>();
  return {
    gatewayUrl: 'fake-ipfs://',
    async put(payload) {
      const hex = createHash('sha256').update(payload).digest('hex');
      const cid = `bafy${hex.slice(0, 52)}`;
      store.set(cid, payload);
      return { cid };
    },
    get(cid) {
      return store.get(cid);
    },
  };
}
