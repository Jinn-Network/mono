#!/usr/bin/env tsx
/**
 * Sweep all known OLAS/ETH funds from the current middleware state to a recovery address.
 *
 * This script performs three stages:
 *   1. Drain the Master Safe (OLAS + ETH) using the Master EOA as the signer.
 *   2. Drain the Service Safe (any ETH) using the Agent EOA as the signer.
 *   3. Sweep remaining ETH from the Master and Agent EOAs themselves.
 *
 * Usage:
 *   RECOVERY_DEST=0xYourAddress yarn tsx scripts/recover-all-funds-to-address.ts
 *
 * Required environment variables:
 *   - RECOVERY_DEST: The address that should receive all recovered funds.
 *   - OPERATE_PASSWORD: Password to decrypt the master wallet keystore.
 *   - RPC_URL (optional): Custom RPC endpoint (defaults to mainnet Base).
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { ethers } from 'ethers';

// Lightweight scrypt implementation adapted from the MIT-licensed `scryptsy` project.
const MAX_VALUE = 0x7fffffff;

function scryptsySync(
  key: Buffer,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  dkLen: number
): Buffer {
  const { XY, V, B32, x, _X, B } = scryptCheckAndInit(key, salt, N, r, p, dkLen);
  for (let i = 0; i < p; i++) {
    sMixSync(B, i * 128 * r, r, N, V, XY, _X, B32, x);
  }
  return pbkdf2Sync(key, B, 1, dkLen, 'sha256');
}

function scryptCheckAndInit(
  key: Buffer,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  dkLen: number
) {
  if (N === 0 || (N & (N - 1)) !== 0) throw new Error('scrypt: N must be > 0 and a power of 2');
  if (N > MAX_VALUE / 128 / r) throw new Error('scrypt: N parameter is too large');
  if (r > MAX_VALUE / 128 / p) throw new Error('scrypt: r parameter is too large');

  const XY = Buffer.alloc(256 * r);
  const V = Buffer.alloc(128 * r * N);
  const B32 = new Int32Array(16);
  const x = new Int32Array(16);
  const _X = Buffer.alloc(64);
  const B = pbkdf2Sync(key, salt, 1, p * 128 * r, 'sha256');

  return { XY, V, B32, x, _X, B };
}

function sMixSync(
  B: Buffer,
  Bi: number,
  r: number,
  N: number,
  V: Buffer,
  XY: Buffer,
  _X: Buffer,
  B32: Int32Array,
  x: Int32Array
) {
  const Xi = 0;
  const Yi = 128 * r;

  B.copy(XY, Xi, Bi, Bi + Yi);

  for (let i = 0; i < N; i++) {
    XY.copy(V, i * Yi, Xi, Xi + Yi);
    blockMixSalsa8(XY, Xi, Yi, r, _X, B32, x);
  }

  for (let i = 0; i < N; i++) {
    const offset = Xi + (2 * r - 1) * 64;
    const j = XY.readUInt32LE(offset) & (N - 1);
    blockXor(V, j * Yi, XY, Xi, Yi);
    blockMixSalsa8(XY, Xi, Yi, r, _X, B32, x);
  }

  XY.copy(B, Bi, Xi, Xi + Yi);
}

function blockMixSalsa8(
  BY: Buffer,
  Bi: number,
  Yi: number,
  r: number,
  _X: Buffer,
  B32: Int32Array,
  x: Int32Array
) {
  arrayCopy(BY, Bi + (2 * r - 1) * 64, _X, 0, 64);

  for (let i = 0; i < 2 * r; i++) {
    blockXor(BY, i * 64, _X, 0, 64);
    salsa208(_X, B32, x);
    arrayCopy(_X, 0, BY, Yi + i * 64, 64);
  }

  for (let i = 0; i < r; i++) {
    arrayCopy(BY, Yi + i * 2 * 64, BY, Bi + i * 64, 64);
  }
  for (let i = 0; i < r; i++) {
    arrayCopy(BY, Yi + (i * 2 + 1) * 64, BY, Bi + (i + r) * 64, 64);
  }
}

function blockXor(S: Buffer, Si: number, D: Buffer, Di: number, len: number) {
  for (let i = 0; i < len; i++) {
    D[Di + i] ^= S[Si + i];
  }
}

function arrayCopy(src: Buffer, srcPos: number, dest: Buffer, destPos: number, length: number) {
  src.copy(dest, destPos, srcPos, srcPos + length);
}

function R(a: number, b: number) {
  return (a << b) | (a >>> (32 - b));
}

function salsa208(B: Buffer, B32: Int32Array, x: Int32Array) {
  for (let i = 0; i < 16; i++) {
    const bi = i * 4;
    B32[i] =
      (B[bi + 0] & 0xff) |
      ((B[bi + 1] & 0xff) << 8) |
      ((B[bi + 2] & 0xff) << 16) |
      ((B[bi + 3] & 0xff) << 24);
  }

  arrayCopyInt32(B32, x, 16);

  for (let i = 8; i > 0; i -= 2) {
    x[4] ^= R(x[0] + x[12], 7);
    x[8] ^= R(x[4] + x[0], 9);
    x[12] ^= R(x[8] + x[4], 13);
    x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7);
    x[13] ^= R(x[9] + x[5], 9);
    x[1] ^= R(x[13] + x[9], 13);
    x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7);
    x[2] ^= R(x[14] + x[10], 9);
    x[6] ^= R(x[2] + x[14], 13);
    x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7);
    x[7] ^= R(x[3] + x[15], 9);
    x[11] ^= R(x[7] + x[3], 13);
    x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7);
    x[2] ^= R(x[1] + x[0], 9);
    x[3] ^= R(x[2] + x[1], 13);
    x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7);
    x[7] ^= R(x[6] + x[5], 9);
    x[4] ^= R(x[7] + x[6], 13);
    x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7);
    x[8] ^= R(x[11] + x[10], 9);
    x[9] ^= R(x[8] + x[11], 13);
    x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7);
    x[13] ^= R(x[12] + x[15], 9);
    x[14] ^= R(x[13] + x[12], 13);
    x[15] ^= R(x[14] + x[13], 18);
  }

  for (let i = 0; i < 16; i++) {
    B32[i] = (B32[i] + x[i]) | 0;
  }

  for (let i = 0; i < 16; i++) {
    const bi = i * 4;
    const value = B32[i];
    B[bi + 0] = value & 0xff;
    B[bi + 1] = (value >>> 8) & 0xff;
    B[bi + 2] = (value >>> 16) & 0xff;
    B[bi + 3] = (value >>> 24) & 0xff;
  }
}

function arrayCopyInt32(src: Int32Array, dest: Int32Array, length: number) {
  for (let i = 0; i < length; i++) {
    dest[i] = src[i];
  }
}
import Safe from '@safe-global/protocol-kit';

const RECOVERY_DEST = process.env.RECOVERY_DEST || process.argv[2];
if (!RECOVERY_DEST) {
  console.error('❌ Missing recovery address. Set RECOVERY_DEST env or pass as CLI arg.');
  process.exit(1);
}
if (!ethers.isAddress(RECOVERY_DEST)) {
  console.error(`❌ Invalid recovery address: ${RECOVERY_DEST}`);
  process.exit(1);
}

const OPERATE_PASSWORD = process.env.OPERATE_PASSWORD;
if (!OPERATE_PASSWORD) {
  console.error('❌ OPERATE_PASSWORD is required to decrypt the master wallet keystore.');
  process.exit(1);
}
// TypeScript: OPERATE_PASSWORD is guaranteed to be string after the check above
const OPERATE_PASSWORD_STR: string = OPERATE_PASSWORD;

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Constants derived from the current middleware state
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const MASTER_SAFE_ADDRESS = '0x8064F56D409f1FfAa9D766e1b462CD5773BE0250';
const SERVICE_SAFE_ADDRESS = '0x608d976Da1Dd9BC53aeA87Abe74e1306Ab96280c';
const AGENT_KEY_ADDRESS = '0xCC97C9c46451c13c0294871BA1c4bbEC94bb0C5a';

const OPERATE_DIR = path.resolve('olas-operate-middleware', '.operate');
const MASTER_KEYSTORE_PATH = path.join(OPERATE_DIR, 'wallets', 'ethereum.txt');
const AGENT_KEY_PATH = path.join(OPERATE_DIR, 'keys', `${AGENT_KEY_ADDRESS}`);

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
const TOKEN_INTERFACE = new ethers.Interface(ERC20_ABI);

async function loadMasterOwner(): Promise<ethers.Wallet> {
  const encryptedJson = await readFile(MASTER_KEYSTORE_PATH, 'utf8');
  const wallet = await decryptKeystoreWallet(encryptedJson, OPERATE_PASSWORD_STR);
  return wallet.connect(provider);
}

async function loadAgentOwner(): Promise<ethers.Wallet> {
  const keyJson = await readFile(AGENT_KEY_PATH, 'utf8');
  const { private_key: privateKey } = JSON.parse(keyJson);
  if (!privateKey || !privateKey.startsWith('0x')) {
    throw new Error(`Malformed agent key file at ${AGENT_KEY_PATH}`);
  }
  return new ethers.Wallet(privateKey, provider);
}

async function decryptKeystoreWallet(encryptedJson: string, password: string): Promise<ethers.Wallet> {
  const data = JSON.parse(encryptedJson);
  const cryptoSection = data.crypto ?? data.Crypto;
  if (!cryptoSection) {
    throw new Error('Invalid keystore file: missing crypto section');
  }
  if ((cryptoSection.kdf || '').toLowerCase() !== 'scrypt') {
    throw new Error(`Unsupported keystore kdf ${cryptoSection.kdf}`);
  }
  const kdfparams = cryptoSection.kdfparams;
  const N: number = kdfparams.n ?? kdfparams.N;
  const r: number = kdfparams.r;
  const p: number = kdfparams.p;
  const salt = Buffer.from(kdfparams.salt.replace(/^0x/, ''), 'hex');
  const key = scryptsySync(Buffer.from(password), salt, N, r, p, 32);

  const ciphertext = Buffer.from(cryptoSection.ciphertext, 'hex');
  const macCheck = ethers.keccak256(new Uint8Array([...key.slice(16, 32), ...ciphertext]));
  if (macCheck.slice(2) !== cryptoSection.mac.toLowerCase()) {
    throw new Error('Failed to decrypt keystore (MAC mismatch). Check password.');
  }

  const iv = Buffer.from(cryptoSection.cipherparams.iv, 'hex');
  const decipher = createDecipheriv('aes-128-ctr', key.slice(0, 16), iv);
  const privateKeyBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return new ethers.Wallet('0x' + privateKeyBytes.toString('hex'));
}

async function sweepSafe(
  safeAddress: string,
  owner: ethers.Wallet,
  opts: { transferTokens?: boolean; label: string }
): Promise<void> {
  console.log(`\n=== ${opts.label}: ${safeAddress} ===`);

  const safeSdk = await Safe.init({
    provider: RPC_URL,
    signer: owner.privateKey,
    safeAddress,
  });

  const signerAddress = await owner.getAddress();
  console.log(`Signer: ${signerAddress}`);

  const metaTxs: Array<{ to: string; value: string; data: string; operation: number }> = [];

  if (opts.transferTokens) {
    const olas = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
    const balance = await olas.balanceOf(safeAddress);
    if (balance > 0n) {
      const formatted = ethers.formatUnits(balance, await olas.decimals());
      console.log(`→ Preparing OLAS transfer of ${formatted} tokens`);
      metaTxs.push({
        to: OLAS_TOKEN,
        value: '0',
        data: TOKEN_INTERFACE.encodeFunctionData('transfer', [RECOVERY_DEST, balance]),
        operation: 0,
      });
    } else {
      console.log('→ No OLAS held in this Safe.');
    }
  }

  const ethBalance = await provider.getBalance(safeAddress);
  if (ethBalance > 0n) {
    const formatted = ethers.formatEther(ethBalance);
    console.log(`→ Preparing ETH transfer of ${formatted} ETH`);
    metaTxs.push({
      to: RECOVERY_DEST,
      value: ethBalance.toString(),
      data: '0x',
      operation: 0,
    });
  } else {
    console.log('→ No ETH held in this Safe.');
  }

  if (metaTxs.length === 0) {
    console.log('✅ Nothing to transfer from this Safe.');
    return;
  }

  const safeTransaction = await safeSdk.createTransaction({ transactions: metaTxs });
  const signedTx = await safeSdk.signTransaction(safeTransaction);
  const executeTxResponse = await safeSdk.executeTransaction(signedTx);
  const transactionResponse = executeTxResponse.transactionResponse;
  if (!transactionResponse) {
    throw new Error('Safe transaction response is missing');
  }
  // Type assertion: Safe SDK transactionResponse is compatible with ethers TransactionResponse
  const receipt = await (transactionResponse as ethers.ContractTransactionResponse).wait();

  if (receipt?.status === 1) {
    console.log(`✅ Safe transfer complete. Tx hash: ${receipt.hash}`);
  } else {
    throw new Error('Safe transaction failed or was not mined.');
  }
}

async function sweepEoa(wallet: ethers.Wallet, label: string): Promise<void> {
  const address = await wallet.getAddress();
  const balance = await provider.getBalance(address);
  if (balance === 0n) {
    console.log(`\n${label} (${address}) has no ETH to sweep.`);
    return;
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPrice) {
    throw new Error('Unable to determine gas price from RPC.');
  }
  const gasLimit = 21_000n;
  // Add 50% buffer to gas price to account for fluctuations + small safety margin
  const bufferedGasPrice = (gasPrice * 150n) / 100n;
  const fee = bufferedGasPrice * gasLimit;
  // Add extra 0.00001 ETH safety margin
  const safetyMargin = ethers.parseEther('0.00001');
  const totalReserve = fee + safetyMargin;

  if (balance <= totalReserve) {
    console.log(`\n${label} (${address}) balance (${ethers.formatEther(balance)} ETH) is not enough to cover gas + safety margin (${ethers.formatEther(totalReserve)} ETH). Skipping.`);
    return;
  }

  const sendValue = balance - totalReserve;
  console.log(`\n${label}: sending ${ethers.formatEther(sendValue)} ETH (keeping ${ethers.formatEther(totalReserve)} ETH for gas)`);

  const tx = await wallet.sendTransaction({
    to: RECOVERY_DEST,
    value: sendValue,
    gasLimit,
    gasPrice: bufferedGasPrice,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} transfer failed: ${tx.hash}`);
  }
  console.log(`✅ ${label} transfer complete. Tx hash: ${tx.hash}`);
}

async function main() {
  console.log('🌐 RPC:', RPC_URL);
  console.log('🎯 Recovery destination:', RECOVERY_DEST);
  console.log('');

  // Load wallets
  const masterOwner = await loadMasterOwner();
  const agentOwner = await loadAgentOwner();

  const errors: string[] = [];

  // Sweep Safes first (so EOAs still have ETH for gas)
  try {
    await sweepSafe(MASTER_SAFE_ADDRESS, masterOwner, {
      transferTokens: true,
      label: 'Master Safe',
    });
  } catch (error) {
    const msg = `Master Safe sweep failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`\n⚠️  ${msg}`);
    errors.push(msg);
  }

  try {
    await sweepSafe(SERVICE_SAFE_ADDRESS, agentOwner, {
      transferTokens: false,
      label: 'Service Safe',
    });
  } catch (error) {
    const msg = `Service Safe sweep failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`\n⚠️  ${msg}`);
    errors.push(msg);
  }

  // Sweep residual EOA ETH
  try {
    await sweepEoa(masterOwner, 'Master EOA');
  } catch (error) {
    const msg = `Master EOA sweep failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`\n⚠️  ${msg}`);
    errors.push(msg);
  }

  try {
    await sweepEoa(agentOwner, 'Agent EOA');
  } catch (error) {
    const msg = `Agent EOA sweep failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`\n⚠️  ${msg}`);
    errors.push(msg);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  if (errors.length === 0) {
    console.log('✅ All funds recovered successfully!');
  } else {
    console.log(`⚠️  Recovery completed with ${errors.length} error(s):`);
    errors.forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
  }
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('\n❌ Recovery script failed:', error);
  process.exit(1);
});
