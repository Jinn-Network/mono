/**
 * HD wallet derivation for fleet management.
 *
 * Mnemonic -> derive master (index 0) and agent (index 1+) wallets.
 * Master is the funder, agents are service instances.
 *
 * Derivation base path: m/44'/60'/0'/0
 *   Index 0: master wallet (funder)
 *   Index 1+: agent wallets (one per service)
 */

import { HDNodeWallet, Mnemonic, Wallet, getAddress } from 'ethers';
import { Buffer } from 'node:buffer';

const DERIVATION_BASE_PATH = "m/44'/60'/0'/0";

function deriveAtIndex(mnemonic: string, index: number): HDNodeWallet {
  const m = Mnemonic.fromPhrase(mnemonic);
  const root = HDNodeWallet.fromMnemonic(m, DERIVATION_BASE_PATH);
  return root.deriveChild(index);
}

export function generateMnemonic(): string {
  const m = Mnemonic.fromEntropy(
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
  );
  return m.phrase;
}

export async function encryptMnemonic(mnemonic: string, password: string): Promise<string> {
  // Encrypt the master private key (index 0) in standard keystore format.
  // Store the mnemonic phrase alongside it — obfuscated by XOR with the
  // master private key so it's not readable from the JSON alone.
  const wallet = deriveAtIndex(mnemonic, 0);
  const keystoreJson = await wallet.encrypt(password, () => {});
  const keystore = JSON.parse(keystoreJson);

  const mnemonicBytes = Buffer.from(mnemonic, 'utf-8');
  const keyBytes = Buffer.from(wallet.privateKey.slice(2), 'hex');
  const obfuscated = Buffer.alloc(mnemonicBytes.length);
  for (let i = 0; i < mnemonicBytes.length; i++) {
    obfuscated[i] = mnemonicBytes[i] ^ keyBytes[i % keyBytes.length];
  }

  return JSON.stringify({
    version: 1,
    type: 'hd-mnemonic',
    master_address: getAddress(wallet.address),
    keystore,
    mnemonic_obfuscated: obfuscated.toString('hex'),
    mnemonic_length: mnemonicBytes.length,
  });
}

export async function decryptMnemonic(encrypted: string, password: string): Promise<string> {
  const data = JSON.parse(encrypted);
  if (data.type !== 'hd-mnemonic') {
    throw new Error(`Unknown keystore type: ${data.type}. Expected 'hd-mnemonic'.`);
  }

  const wallet = await Wallet.fromEncryptedJson(JSON.stringify(data.keystore), password);

  const keyBytes = Buffer.from(wallet.privateKey.slice(2), 'hex');
  const obfuscated = Buffer.from(data.mnemonic_obfuscated, 'hex');
  const mnemonicBytes = Buffer.alloc(data.mnemonic_length);
  for (let i = 0; i < data.mnemonic_length; i++) {
    mnemonicBytes[i] = obfuscated[i] ^ keyBytes[i % keyBytes.length];
  }
  const mnemonic = mnemonicBytes.toString('utf-8');

  const masterAddress = deriveMasterAddress(mnemonic);
  if (getAddress(masterAddress) !== getAddress(data.master_address)) {
    throw new Error(
      `Mnemonic decryption verification failed: derived ${masterAddress} but expected ${data.master_address}`,
    );
  }

  return mnemonic;
}

export function deriveMasterAddress(mnemonic: string): string {
  return getAddress(deriveAtIndex(mnemonic, 0).address);
}

export function deriveAgentAddress(mnemonic: string, index: number): string {
  if (index < 1) {
    throw new Error(`Agent index must be >= 1, got ${index}`);
  }
  return getAddress(deriveAtIndex(mnemonic, index).address);
}

export function deriveMasterSigner(mnemonic: string): HDNodeWallet {
  return deriveAtIndex(mnemonic, 0);
}

export function deriveAgentSigner(mnemonic: string, index: number): HDNodeWallet {
  if (index < 1) {
    throw new Error(`Agent index must be >= 1, got ${index}`);
  }
  return deriveAtIndex(mnemonic, index);
}
