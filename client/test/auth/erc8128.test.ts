import { describe, it, expect } from 'vitest';
import {
  createPrivateKeyHttpSigner,
  signRequestWithErc8128,
  verifyRequestWithErc8128,
  InMemoryNonceStore,
} from '../../src/auth/erc8128.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const CHAIN_ID = 8453;

describe('ERC-8128 Auth', () => {
  const signer = createPrivateKeyHttpSigner(TEST_KEY, CHAIN_ID);

  it('should create signer with correct address', () => {
    expect(signer.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(signer.chainId).toBe(CHAIN_ID);
  });

  it('should sign and verify a GET request', async () => {
    const nonceStore = new InMemoryNonceStore();

    const signed = await signRequestWithErc8128({
      signer,
      input: 'http://localhost:3000/api/test',
    });

    expect(signed.headers.has('signature')).toBe(true);
    expect(signed.headers.has('signature-input')).toBe(true);

    const result = await verifyRequestWithErc8128({
      request: signed,
      nonceStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.toLowerCase()).toBe(signer.address.toLowerCase());
      expect(result.chainId).toBe(CHAIN_ID);
    }
  });

  it('should sign and verify a POST request with body', async () => {
    const nonceStore = new InMemoryNonceStore();
    const body = JSON.stringify({ action: 'claimRequest', requestId: '0x1234' });

    const signed = await signRequestWithErc8128({
      signer,
      input: 'http://localhost:3000/api/claims',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    });

    expect(signed.headers.has('content-digest')).toBe(true);

    const result = await verifyRequestWithErc8128({
      request: signed,
      nonceStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.toLowerCase()).toBe(signer.address.toLowerCase());
    }
  });

  it('should reject tampered request (modified body)', async () => {
    const nonceStore = new InMemoryNonceStore();

    const signed = await signRequestWithErc8128({
      signer,
      input: 'http://localhost:3000/api/test',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original: true }),
      },
    });

    // Tamper with the body
    const tampered = new Request(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: JSON.stringify({ original: false, tampered: true }),
    });

    const result = await verifyRequestWithErc8128({
      request: tampered,
      nonceStore,
    });

    expect(result.ok).toBe(false);
  });

  it('should reject replayed request (same nonce)', async () => {
    const nonceStore = new InMemoryNonceStore();

    const signed = await signRequestWithErc8128({
      signer,
      input: 'http://localhost:3000/api/test',
    });

    // First verification should pass
    const result1 = await verifyRequestWithErc8128({
      request: signed.clone(),
      nonceStore,
    });
    expect(result1.ok).toBe(true);

    // Second verification with same nonce should fail (replay)
    const result2 = await verifyRequestWithErc8128({
      request: signed.clone(),
      nonceStore,
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.reason).toBe('replay');
    }
  });
});
