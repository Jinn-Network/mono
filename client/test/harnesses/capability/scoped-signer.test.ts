import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createScopedSigner } from '../../../src/harnesses/capability/scoped-signer.js';

const MASTER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ALLOWED_TO = '0x1111111111111111111111111111111111111111' as const;
const ALLOWED_SELECTOR = '0xdeadbeef' as const;
const FORBIDDEN_SELECTOR = '0xcafef00d' as const;

describe('createScopedSigner', () => {
  const account = privateKeyToAccount(MASTER_PK);
  const allowList = [
    { chainId: 8453, to: ALLOWED_TO, selector: ALLOWED_SELECTOR },
  ] as const;
  // Default permissive typed-data allow-list for the legacy
  // sendAllowedCall tests — Finding 3 tests below pin the new
  // signTypedData semantics.
  const TYPED_OPEN = [{ chainId: 8453 }] as const;

  it('exposes the master EOA address', () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: TYPED_OPEN,
      chainId: 8453,
    });
    expect(signer.address).toBe(account.address);
  });

  it('rejects sendAllowedCall with a non-allow-listed selector', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: TYPED_OPEN,
      chainId: 8453,
    });
    await expect(
      signer.sendAllowedCall({
        to: ALLOWED_TO,
        data: `${FORBIDDEN_SELECTOR}00000000` as `0x${string}`,
      }),
    ).rejects.toThrow(/selector .* not in allow-list/i);
  });

  it('rejects sendAllowedCall with a non-allow-listed contract', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: TYPED_OPEN,
      chainId: 8453,
    });
    await expect(
      signer.sendAllowedCall({
        to: '0x9999999999999999999999999999999999999999' as `0x${string}`,
        data: `${ALLOWED_SELECTOR}00000000` as `0x${string}`,
      }),
    ).rejects.toThrow(/to .* not in allow-list/i);
  });

  it('throws Phase 1 placeholder when the call is fully allow-listed', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: TYPED_OPEN,
      chainId: 8453,
    });
    await expect(
      signer.sendAllowedCall({
        to: ALLOWED_TO,
        data: `${ALLOWED_SELECTOR}00000000` as `0x${string}`,
      }),
    ).rejects.toThrow(/wired in the daemon plan/i);
  });

  it('signs EIP-712 typed data via the underlying account', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: TYPED_OPEN,
      chainId: 8453,
    });
    const sig = await signer.signTypedData({
      domain: { name: 'Test', version: '1', chainId: 8453 },
      types: { Mail: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Mail',
      message: { contents: 'hello' },
    });
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — signTypedData domain allow-list (default-deny)
// ---------------------------------------------------------------------------

describe('createScopedSigner — signTypedData domain allow-list', () => {
  const account = privateKeyToAccount(MASTER_PK);
  const allowList = [
    { chainId: 8453, to: ALLOWED_TO, selector: ALLOWED_SELECTOR },
  ] as const;

  it('throws when typedDataAllowList is empty (default-deny)', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: [],
      chainId: 8453,
    });
    await expect(
      signer.signTypedData({
        domain: { chainId: 8453 },
        types: { X: [{ name: 'v', type: 'string' }] },
        primaryType: 'X',
        message: { v: 'hi' },
      }),
    ).rejects.toThrow(/not in allow-list/i);
  });

  it('signs when chainId matches the only entry', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: [{ chainId: 84532 }],
      chainId: 84532,
    });
    const sig = await signer.signTypedData({
      domain: { name: 'Test', version: '1', chainId: 84532 },
      types: { Mail: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Mail',
      message: { contents: 'hello' },
    });
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it('refuses chain 1 when the entry pins chain 84532', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: [{ chainId: 84532 }],
      chainId: 84532,
    });
    await expect(
      signer.signTypedData({
        domain: { name: 'Test', version: '1', chainId: 1 },
        types: { Mail: [{ name: 'contents', type: 'string' }] },
        primaryType: 'Mail',
        message: { contents: 'hello' },
      }),
    ).rejects.toThrow(/not in allow-list/i);
  });

  it('refuses mismatched verifyingContract when the entry pins one', async () => {
    const PINNED =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const OTHER =
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: [{ chainId: 1, verifyingContract: PINNED }],
      chainId: 1,
    });
    await expect(
      signer.signTypedData({
        domain: { chainId: 1, verifyingContract: OTHER },
        types: { Mail: [{ name: 'contents', type: 'string' }] },
        primaryType: 'Mail',
        message: { contents: 'hello' },
      }),
    ).rejects.toThrow(/not in allow-list/i);
  });

  it('signs when verifyingContract matches the entry (case-insensitive)', async () => {
    const PINNED =
      '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as `0x${string}`;
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: [{ chainId: 1, verifyingContract: PINNED }],
      chainId: 1,
    });
    const sig = await signer.signTypedData({
      domain: {
        chainId: 1,
        verifyingContract:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`,
      },
      types: { Mail: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Mail',
      message: { contents: 'hello' },
    });
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it('refuses mismatched name/version when the entry pins them', async () => {
    const signer = createScopedSigner({
      account,
      allowList,
      typedDataAllowList: [{ chainId: 1, name: 'Foo', version: '2' }],
      chainId: 1,
    });
    await expect(
      signer.signTypedData({
        domain: { chainId: 1, name: 'Foo', version: '1' },
        types: { Mail: [{ name: 'contents', type: 'string' }] },
        primaryType: 'Mail',
        message: { contents: 'hello' },
      }),
    ).rejects.toThrow(/not in allow-list/i);
  });
});
