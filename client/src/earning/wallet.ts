/**
 * HD wallet derivation for fleet management.
 *
 * Mnemonic -> derive master (index 0) and agent (index 1+) wallets.
 * Master is the funder, agents are service instances.
 *
 * Derivation path: m/44'/60'/0'/0/{index}
 *   Index 0: master wallet (funder)
 *   Index 1+: agent wallets (one per service)
 */

import { Wallet } from '@ethereumjs/wallet';
import { generateMnemonic as scureGenerateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { Buffer } from 'node:buffer';
import { getAddress, toHex, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const DERIVATION_PREFIX = "m/44'/60'/0'/0";

function derivePrivateKeyBytes(mnemonic: string, index: number): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(`${DERIVATION_PREFIX}/${index}`);
  if (!child.privateKey) {
    throw new Error(`Could not derive private key at ${DERIVATION_PREFIX}/${index}`);
  }
  return child.privateKey;
}

export function walletPrivateKeyAtIndex(mnemonic: string, index: number): Hex {
  return toHex(derivePrivateKeyBytes(mnemonic, index));
}

export function generateMnemonic(): string {
  return scureGenerateMnemonic(wordlist, 128);
}

export async function encryptMnemonic(mnemonic: string, password: string): Promise<string> {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Internal error: generated mnemonic failed validation');
  }
  const pk = derivePrivateKeyBytes(mnemonic, 0);
  const w = new Wallet(pk);
  const keystore = await w.toV3(password);
  const keystoreJson = JSON.stringify(keystore);

  const pkHex = toHex(pk);
  const account0 = privateKeyToAccount(pkHex) as PrivateKeyAccount;
  const mnemonicBytes = Buffer.from(mnemonic, 'utf-8');
  const keyBytes = Buffer.from(pkHex.slice(2), 'hex');
  const obfuscated = Buffer.alloc(mnemonicBytes.length);
  for (let i = 0; i < mnemonicBytes.length; i++) {
    obfuscated[i] = mnemonicBytes[i]! ^ keyBytes[i % keyBytes.length]!;
  }

  return JSON.stringify({
    version: 1,
    type: 'hd-mnemonic',
    master_address: getAddress(account0.address),
    keystore: JSON.parse(keystoreJson),
    mnemonic_obfuscated: obfuscated.toString('hex'),
    mnemonic_length: mnemonicBytes.length,
  });
}

export async function decryptMnemonic(encrypted: string, password: string): Promise<string> {
  const data = JSON.parse(encrypted) as {
    type?: string;
    keystore?: Record<string, unknown>;
    mnemonic_obfuscated?: string;
    mnemonic_length?: number;
    master_address?: string;
  };
  if (data.type !== 'hd-mnemonic') {
    throw new Error(`Unknown keystore type: ${data.type}. Expected 'hd-mnemonic'.`);
  }
  if (!data.keystore) {
    throw new Error('Missing keystore in encrypted payload');
  }

  const w = await Wallet.fromV3(data.keystore as unknown as Parameters<typeof Wallet.fromV3>[0], password);
  const pkHex = w.getPrivateKeyString() as Hex;
  const keyBytes = Buffer.from(pkHex.slice(2), 'hex');
  const obfuscated = Buffer.from(data.mnemonic_obfuscated ?? '', 'hex');
  const mnemonicBytes = Buffer.alloc(data.mnemonic_length ?? 0);
  for (let i = 0; i < mnemonicBytes.length; i++) {
    mnemonicBytes[i] = obfuscated[i]! ^ keyBytes[i % keyBytes.length]!;
  }
  const mnemonic = mnemonicBytes.toString('utf-8');

  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Mnemonic decryption produced an invalid phrase (wrong password?)');
  }

  const masterAddress = deriveMasterAddress(mnemonic);
  if (getAddress(masterAddress) !== getAddress(data.master_address ?? '')) {
    throw new Error(
      `Mnemonic decryption verification failed: derived ${masterAddress} but expected ${data.master_address}`,
    );
  }

  return mnemonic;
}

export function deriveMasterAddress(mnemonic: string): string {
  return getAddress(privateKeyToAccount(walletPrivateKeyAtIndex(mnemonic, 0)).address);
}

export function deriveAgentAddress(mnemonic: string, index: number): string {
  if (index < 1) {
    throw new Error(`Agent index must be >= 1, got ${index}`);
  }
  return getAddress(privateKeyToAccount(walletPrivateKeyAtIndex(mnemonic, index)).address);
}

export function deriveMasterSigner(mnemonic: string): PrivateKeyAccount {
  return privateKeyToAccount(walletPrivateKeyAtIndex(mnemonic, 0)) as PrivateKeyAccount;
}

export function deriveAgentSigner(mnemonic: string, index: number): PrivateKeyAccount {
  if (index < 1) {
    throw new Error(`Agent index must be >= 1, got ${index}`);
  }
  return privateKeyToAccount(walletPrivateKeyAtIndex(mnemonic, index)) as PrivateKeyAccount;
}
