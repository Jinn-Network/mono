/**
 * Ethereum Keystore V3 Decryption
 *
 * Decrypts Ethereum keystores using scrypt KDF and AES-128-CTR.
 * Extracted from scripts/recover-all-funds-to-address.ts for reuse.
 *
 * Supports both uppercase (N) and lowercase (n) scrypt parameters,
 * which is important for compatibility with different middleware versions.
 */

import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { keccak256 } from 'ethers';

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

/**
 * Decrypt an Ethereum Keystore V3 JSON and return the private key.
 *
 * @param keystoreJson - The encrypted keystore JSON string (V3 format with scrypt KDF)
 * @param password - The password used to encrypt the keystore
 * @returns The decrypted private key as a 0x-prefixed 64-character hex string
 * @throws Error if the keystore is invalid, uses unsupported KDF, or password is wrong
 */
export function decryptKeystoreV3(keystoreJson: string, password: string): string {
  const data = JSON.parse(keystoreJson);
  const cryptoSection = data.crypto ?? data.Crypto;

  if (!cryptoSection) {
    throw new Error('Invalid keystore: missing crypto section');
  }

  if ((cryptoSection.kdf || '').toLowerCase() !== 'scrypt') {
    throw new Error(`Unsupported keystore KDF: ${cryptoSection.kdf}. Only scrypt is supported.`);
  }

  const kdfparams = cryptoSection.kdfparams;
  if (!kdfparams) {
    throw new Error('Invalid keystore: missing kdfparams');
  }

  // Handle both uppercase N (standard) and lowercase n (some middleware versions)
  const N: number = kdfparams.n ?? kdfparams.N;
  const r: number = kdfparams.r;
  const p: number = kdfparams.p;

  if (!N || !r || !p) {
    throw new Error('Invalid keystore: missing scrypt parameters (n/N, r, p)');
  }

  const salt = Buffer.from(kdfparams.salt.replace(/^0x/, ''), 'hex');
  const key = scryptsySync(Buffer.from(password), salt, N, r, p, 32);

  // Verify MAC before attempting decryption
  const ciphertext = Buffer.from(cryptoSection.ciphertext, 'hex');
  const macCheck = keccak256(new Uint8Array([...key.slice(16, 32), ...ciphertext]));

  if (macCheck.slice(2) !== cryptoSection.mac.toLowerCase()) {
    throw new Error('Failed to decrypt keystore (MAC mismatch). Check password.');
  }

  // Decrypt using AES-128-CTR
  // Some Python AEA keystores produce IVs shorter than 16 bytes; left-pad with zeros.
  const ivHex = cryptoSection.cipherparams.iv.replace(/^0x/, '').padStart(32, '0');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv('aes-128-ctr', key.slice(0, 16), iv);
  const privateKeyBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return '0x' + privateKeyBytes.toString('hex');
}
