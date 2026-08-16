/**
 * Tests for api-wallet.ts — keypair derivation + persistence.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  provisionApiWallet,
  loadApiWalletState,
  saveApiWalletState,
  markApiWalletApproved,
  walletStatePath,
} from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/api-wallet.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'jinn-api-wallet-test-'));
}

describe('provisionApiWallet', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new wallet state when none exists', () => {
    tmpDir = makeTmpDir();
    const state = provisionApiWallet(tmpDir);

    expect(state.privateKey).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(state.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(state.approved).toBe(false);
    expect(state.createdAt).toBeTypeOf('number');
    expect(state.approvedAt).toBeUndefined();
  });

  it('persists the wallet state to disk', () => {
    tmpDir = makeTmpDir();
    provisionApiWallet(tmpDir);

    const filePath = walletStatePath(tmpDir);
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.privateKey).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('returns the same state on subsequent calls (idempotent)', () => {
    tmpDir = makeTmpDir();
    const first = provisionApiWallet(tmpDir);
    const second = provisionApiWallet(tmpDir);

    expect(second.privateKey).toBe(first.privateKey);
    expect(second.address).toBe(first.address);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('address is derived from private key (non-zero)', () => {
    tmpDir = makeTmpDir();
    const state = provisionApiWallet(tmpDir);
    expect(state.address).not.toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('loadApiWalletState', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no file exists', () => {
    tmpDir = makeTmpDir();
    expect(loadApiWalletState(tmpDir)).toBeNull();
  });

  it('returns state when file exists', () => {
    tmpDir = makeTmpDir();
    const state = provisionApiWallet(tmpDir);
    const loaded = loadApiWalletState(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.privateKey).toBe(state.privateKey);
  });
});

describe('markApiWalletApproved', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks the wallet as approved', () => {
    tmpDir = makeTmpDir();
    provisionApiWallet(tmpDir);

    const updated = markApiWalletApproved(tmpDir);
    expect(updated.approved).toBe(true);
    expect(updated.approvedAt).toBeTypeOf('number');
  });

  it('persists approved state to disk', () => {
    tmpDir = makeTmpDir();
    provisionApiWallet(tmpDir);
    markApiWalletApproved(tmpDir);

    const loaded = loadApiWalletState(tmpDir);
    expect(loaded?.approved).toBe(true);
  });

  it('throws if no wallet exists', () => {
    tmpDir = makeTmpDir();
    expect(() => markApiWalletApproved(tmpDir)).toThrow();
  });
});

describe('saveApiWalletState', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a wallet state', () => {
    tmpDir = makeTmpDir();
    const state = {
      privateKey: '0x' + 'a'.repeat(64),
      address: '0xdeadbeef' + '0'.repeat(32),
      approved: false,
      createdAt: 1_000_000,
    };
    saveApiWalletState(tmpDir, state);
    const loaded = loadApiWalletState(tmpDir);
    expect(loaded).toEqual(state);
  });
});
