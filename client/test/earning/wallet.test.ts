import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
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

  it('produces the BIP39 known-vector seed for abandon…about (empty passphrase)', () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    // BIP39 test vector — empty passphrase; identical under @scure/bip39 v1.6.0 and v2.2.0
    const expected =
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';
    const seed = mnemonicToSeedSync(mnemonic);
    expect(Buffer.from(seed).toString('hex')).toBe(expected);
  });

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
