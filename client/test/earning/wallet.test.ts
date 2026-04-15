import { describe, expect, it } from 'vitest';
import {
  generateMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  deriveMasterAddress,
  deriveAgentAddress,
  deriveAgentSigner,
  deriveMasterSigner,
  walletPrivateKeyAtIndex,
} from '../../src/earning/wallet.js';

describe('HD wallet', () => {
  const TEST_PASSWORD = 'test-password';

  it('generates a 12-word mnemonic', () => {
    const mnemonic = generateMnemonic();
    const words = mnemonic.split(' ');
    expect(words).toHaveLength(12);
  });

  it('encrypts and decrypts a mnemonic round-trip', async () => {
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, TEST_PASSWORD);
    const decrypted = await decryptMnemonic(encrypted, TEST_PASSWORD);
    expect(decrypted).toBe(mnemonic);
  });

  it('rejects wrong password on decrypt', async () => {
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, TEST_PASSWORD);
    await expect(decryptMnemonic(encrypted, 'wrong-password')).rejects.toThrow();
  });

  it('derives deterministic master address at index 0', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const addr = deriveMasterAddress(mnemonic);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(deriveMasterAddress(mnemonic)).toBe(addr);
  });

  it('derives deterministic agent addresses at index 1+', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const agent1 = deriveAgentAddress(mnemonic, 1);
    const agent2 = deriveAgentAddress(mnemonic, 2);
    expect(agent1).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agent2).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agent1).not.toBe(agent2);
    const master = deriveMasterAddress(mnemonic);
    expect(master).not.toBe(agent1);
    expect(master).not.toBe(agent2);
  });

  it('derives a signer wallet for master', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const signer = deriveMasterSigner(mnemonic);
    expect(signer.address).toBe(deriveMasterAddress(mnemonic));
    expect(walletPrivateKeyAtIndex(mnemonic, 0)).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('derives a signer wallet for agent', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const signer = deriveAgentSigner(mnemonic, 1);
    expect(signer.address).toBe(deriveAgentAddress(mnemonic, 1));
    expect(walletPrivateKeyAtIndex(mnemonic, 1)).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
